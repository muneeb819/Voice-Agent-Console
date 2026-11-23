import crypto from 'crypto';
import dgram from 'dgram';
import net from 'net';
import WebSocket, { WebSocketServer } from 'ws';
import { AsteriskAmiClient } from './ami-client';
import { isBridgePeerIpAllowed, isLoopbackIp } from './auth-guard';
import { StereoCallRecorder8k } from './call-recorder';
import { chooseOpeningLine, getConsoleState, saveBridgeCallLog } from './db';
import { GreetingRecord } from './greetings';
import { createOpeningGate, OpeningGate, openingGateOptionsFor, openingOptionsFor, prepareDelayedOpening } from './opening';
import { getSecret, interpolateProviderPlaceholders } from './env-store';
import { executeCustomFunctionWebhook } from './webhook-executor';
import {
  buildRtpPacket,
  downsample16kTo8kLinear16,
  linear16ToUlaw,
  parseRfc4733Dtmf,
  parseRtpPacket,
  ulawToLinear16,
} from './g711';
import { allowedCampaignDispositionCodes, buildDeepgramSettings, getCampaignCallReadinessBlockers } from './settings-builder';
import { createConversationMemory } from './persona';
import { campaignExtension, campaignSlot, primaryCampaignAgent } from './campaign-assignment';
import { BargeInGate, normalizeBargeInPct } from './barge-in';
import { CALL_LIMIT_CLOSING_LINE, TRANSFER_INTENT_AUTOCOMPLETE_MS, TRANSFER_INTENT_GRACE_MS, announcesTransfer, callerDeclined, callLimitMsForCampaign, callLimitSchedule, callLimitWrapUpPrompt, transferBlockedPrompt } from './call-limit';
export { CALL_LIMIT_CLOSING_LINE, callLimitMsForCampaign, callLimitSchedule, callLimitWrapUpPrompt } from './call-limit';
import { Agent, Campaign, ConsoleState } from './types';
import { SipRegistrationClient } from './vici-sip-registration';
import {
  HydratedViciLead,
  ParsedViciCallerCode,
  parseVicidialCallerCode,
  VicidialApiClient,
} from './vici-client';

export function resolveSdpAdvertisedHost(peerAddress: string, configuredHost: string, bindHost: string): string {
  if (isLoopbackIp(peerAddress)) return peerAddress;
  const configured = configuredHost.trim();
  const bind = bindHost.trim();
  const usable = (host: string) => Boolean(host && !isLoopbackIp(host) && !['0.0.0.0', '::', '[::]'].includes(host));
  return usable(configured) ? configured : usable(bind) ? bind : '127.0.0.1';
}

export interface PreCallRegistrationInput {
  uniqueid?: string;
  vici_cid?: string;
  caller_code?: string;
  phone?: string;
  exten?: string;
  channel?: string;
  agent_user?: string;
}

interface PreCallRecord {
  uuid: string;
  createdAt: number;
  exten: string;
  channel: string;
  uniqueid: string;
  parsedCaller: ParsedViciCallerCode;
  campaign: Campaign;
  agent: Agent;
  remoteAgentUser: string;
  viciClient: VicidialApiClient;
  leadPromise: Promise<HydratedViciLead>;
}

export interface ActiveBridgeCallSummary {
  callId: string;
  campaignId: string;
  transport: 'audiosocket' | 'sip_rtp';
  exten: string;
  callerCode: string;
  leadId: string | null;
  phone: string;
  campaignName: string;
  viciCampaign: string;
  agentId: string;
  agentName: string;
  remoteAgentUser: string;
  state: string;
  startedAt: string;
  turns: number;
  disposition: string | null;
  transferredTo: string | null;
}

export function uuidBytesToCanonical(buf: Buffer): string {
  if (buf.length === 16) {
    const hex = buf.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  }
  return buf.toString('utf8').trim();
}

export function canonicalUuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '').trim();
  if (/^[0-9a-fA-F]{32}$/.test(hex)) {
    return Buffer.from(hex, 'hex');
  }
  const fallback = Buffer.alloc(16, 0);
  Buffer.from(uuid.slice(0, 16), 'utf8').copy(fallback);
  return fallback;
}

/** Optional fixed RTP port range so a cloud firewall can allow exactly it. */
export function rtpPortRange(env: NodeJS.ProcessEnv = process.env): { min: number; max: number } | null {
  const min = Number(env.BRIDGE_RTP_PORT_MIN || 0);
  const max = Number(env.BRIDGE_RTP_PORT_MAX || 0);
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1024 || max > 65535 || max < min) return null;
  return { min, max };
}

/** Seconds without inbound RTP before a SIP call is torn down (0 disables). */
export function rtpInactivityTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.BRIDGE_RTP_TIMEOUT_SEC;
  const sec = raw === undefined || raw === '' ? 60 : Number(raw);
  return Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) : 0;
}

export function resolveCampaignAndAgent(
  state: ConsoleState,
  dialedExten: string
): { campaign?: Campaign; agent?: Agent; remoteAgentUser: string; campaignIndex: number; error?: string } {
  const cleanExten = String(dialedExten || '').trim();
  const prefix = String(state.vici.aiExten || '8800').trim();
  const baseRa = Number(state.vici.remoteAgentUser || 9001);
  // Match the campaign's stored slot, never its array position: deleting or
  // reordering a campaign must not re-route another campaign's live calls.
  const idx = state.campaigns.findIndex((campaign, i) => cleanExten === campaignExtension(prefix, campaign, i));
  const slot = idx >= 0 ? campaignSlot(state.campaigns[idx], idx) : 1;
  const remoteAgentUser = String(Number.isFinite(baseRa) ? baseRa + slot - 1 : state.vici.remoteAgentUser || '9001');

  if (idx < 0) {
    return {
      remoteAgentUser,
      campaignIndex: -1,
      error: cleanExten
        ? `Dialed extension “${cleanExten}” does not map to an explicitly configured campaign. Refusing to fall back to another campaign.`
        : 'No dialed campaign extension was provided. Assign this call to a campaign before connecting.',
    };
  }

  const campaign = state.campaigns[idx];
  const agent = primaryCampaignAgent(state, campaign);
  if (!agent) {
    return {
      campaign,
      remoteAgentUser,
      campaignIndex: idx,
      error: `Campaign “${campaign.name}” is not assigned to an existing bot agent.`,
    };
  }

  const blockers = getCampaignCallReadinessBlockers(state, campaign);
  if (blockers.length) {
    return {
      campaign,
      agent,
      remoteAgentUser,
      campaignIndex: idx,
      error: `Campaign “${campaign.name}” is not ready: ${blockers.join('; ')}.`,
    };
  }

  return { campaign, agent, remoteAgentUser, campaignIndex: idx };
}

function hydrateRealLeadIntoSettings(settings: any, agent: Agent, campaign: Campaign | undefined, lead: HydratedViciLead) {
  if (!agent.acceptViciCalls) return;

  const vars: Record<string, string> = {
    lead_id: lead.lead_id || 'unknown',
    first_name: lead.first_name || 'there',
    last_name: lead.last_name || '',
    phone_number: lead.phone_number || '',
    state: lead.state || '',
    city: lead.city || '',
    postal_code: lead.postal_code || '',
    age: lead.age || '',
    campaign_id: campaign?.viciCampaign || lead.campaign_id || '',
  };

  const replaceVars = (txt: string) =>
    txt.replace(
      /\{\{\s*(lead_id|first_name|last_name|phone_number|state|city|postal_code|age|campaign_id)\s*\}\}/gi,
      (_m, key) => vars[String(key).toLowerCase()] ?? ''
    );

  settings.agent.greeting = replaceVars(settings.agent.greeting || '');
  const basePrompt = replaceVars(settings.agent.think.prompt || '');

  const customLines = Object.entries(lead.custom || {})
    .slice(0, 10)
    .map(([k, v]) => `- custom_${k}: ${v}`)
    .join('\n');

  const leadBlock = [
    '',
    '[Live VICIdial Call Context — Hydrated via non_agent_api.php]',
    `- lead_id: ${lead.lead_id || 'unknown'}`,
    lead.first_name ? `- caller_name: ${[lead.first_name, lead.last_name].filter(Boolean).join(' ')}` : '',
    lead.phone_number ? `- phone_number: ${lead.phone_number}` : '',
    lead.state ? `- state: ${lead.state}` : '',
    lead.city ? `- city: ${lead.city}` : '',
    lead.age ? `- listed_age: ${lead.age}` : '',
    lead.comments ? `- prior_lead_notes: ${lead.comments}` : '',
    campaign?.viciCampaign ? `- vici_campaign: ${campaign.viciCampaign}` : '',
    campaign?.xferTarget ? `- closer_transfer_target: ${campaign.xferType}:${campaign.xferTarget}` : '',
    customLines,
  ]
    .filter(Boolean)
    .join('\n');

  settings.agent.think.prompt = basePrompt + '\n' + leadBlock;
}

interface TransportHooks {
  enqueueBotPcm8k: (pcm8kLe: Buffer) => void;
  pendingPlaybackMs: () => number;
  bargeInFlush: () => void;
  hangupTransport: () => void;
  /** Called with each 20 ms bot frame at the moment it is actually sent to the caller (live listening). */
  onFramePlayed?: ((frame: Buffer) => void) | null;
}

/** Live listening limits: listen-only supervisors per call and in total. */
const MAX_LISTENERS_PER_CALL = 3;
const MAX_LISTENERS_TOTAL = 20;
/** Frames are dropped for a listener whose connection falls this far behind. */
const LISTENER_MAX_BUFFERED_BYTES = 256 * 1024;

export interface ViciBridgeOptions {
  audioSocketPort?: number;
  sipPort?: number;
  host?: string;
  viciApiBaseOverride?: string;
}

export class VicidialBridgeService {
  private host: string;
  private audioSocketPort: number;
  private sipPort: number;
  private viciApiBaseOverride?: string;

  private tcpServer: net.Server | null = null;
  private sipSocket: dgram.Socket | null = null;
  private monitorWss: WebSocketServer | null = null;
  private sipRegistrationClient: SipRegistrationClient | null = null;

  private readonly preCallRegistry = new Map<string, PreCallRecord>();
  private preCallSweepTimer: NodeJS.Timeout | null = null;
  private readonly activeCalls = new Map<string, ActiveBridgeCallSummary>();
  private readonly activeSessionClosers = new Map<string, (reason: string) => void | Promise<void>>();
  private readonly activeSessionTransferrers = new Map<string, (reason: string) => Promise<void>>();

  private stats = {
    startedAt: new Date().toISOString(),
    totalCalls: 0,
    completedTransfers: 0,
    dncCount: 0,
    rejectedUntrustedIpCount: 0,
    rejectedOverCapacityCount: 0,
    audioSocketListening: false,
    sipRtpListening: false,
    lastError: null as string | null,
  };

  constructor(opts: ViciBridgeOptions = {}) {
    const st = getConsoleState();
    this.host = opts.host || process.env.BRIDGE_BIND_HOST || '127.0.0.1';
    this.audioSocketPort =
      opts.audioSocketPort !== undefined
        ? opts.audioSocketPort
        : Number(process.env.AUDIOSOCKET_PORT || st.vici.bridgePort || 9092);
    this.sipPort =
      opts.sipPort !== undefined
        ? opts.sipPort
        : Number(process.env.BRIDGE_SIP_PORT || st.vici.sipPort || 5062);
    // New installations default to 5062; an explicitly saved port must not be
    // silently rewritten, or generated carrier configuration will disagree.
    this.viciApiBaseOverride = opts.viciApiBaseOverride;
  }

  private readonly listeners = new Map<string, Set<WebSocket>>();
  private readonly listenNotes = new Map<string, (line: string) => void>();
  private readonly listenerLabels = new WeakMap<WebSocket, string>();
  private listenWss: WebSocketServer | null = null;

  /** Listen-only audio for supervisors: frames are [kind][PCM16LE 8 kHz], kind 1 = caller, 2 = bot. */
  public createListenWebSocketServer(): WebSocketServer {
    this.listenWss = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
    return this.listenWss;
  }

  /** Attaches a listener to a live call. Returns an error message, or '' when listening started. */
  public attachListener(callId: string, ws: WebSocket, who: string): string {
    if (!this.activeCalls.has(callId)) return 'This call is not live any more.';
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    const set = this.listeners.get(callId) || new Set<WebSocket>();
    if (set.size >= MAX_LISTENERS_PER_CALL) return `Already ${MAX_LISTENERS_PER_CALL} people are listening to this call.`;
    if (total >= MAX_LISTENERS_TOTAL) return 'Too many live listeners on the server right now.';
    set.add(ws);
    this.listeners.set(callId, set);
    const label = (who || 'Supervisor').slice(0, 120);
    this.listenerLabels.set(ws, label);
    this.listenNotes.get(callId)?.(`${label} started listening (listen only)`);
    ws.send(JSON.stringify({ type: 'listening', callId, sampleRate: 8000 }));
    const detach = () => {
      const cur = this.listeners.get(callId);
      if (!cur || !cur.delete(ws)) return;
      if (!cur.size) this.listeners.delete(callId);
      this.listenNotes.get(callId)?.(`${label} stopped listening`);
    };
    ws.on('close', detach);
    ws.on('error', detach);
    // Listeners never send audio; any message is ignored.
    ws.on('message', () => {});
    return '';
  }

  public listenerCount(callId?: string): number {
    if (callId) return this.listeners.get(callId)?.size || 0;
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }

  private emitListen(callId: string, kind: 1 | 2, pcm: Buffer): void {
    const set = this.listeners.get(callId);
    if (!set || !set.size || !pcm.length) return;
    const frame = Buffer.allocUnsafe(pcm.length + 1);
    frame[0] = kind;
    pcm.copy(frame, 1);
    for (const ws of set) {
      if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < LISTENER_MAX_BUFFERED_BYTES) ws.send(frame, { binary: true });
    }
  }

  /** Ends listening for a call; called before the call record is saved so each stop is in the transcript. */
  private closeListeners(callId: string, reason: string): void {
    const set = this.listeners.get(callId);
    const note = this.listenNotes.get(callId);
    this.listeners.delete(callId);
    this.listenNotes.delete(callId);
    if (!set) return;
    for (const ws of set) {
      note?.(`${this.listenerLabels.get(ws) || 'Supervisor'} stopped listening (call ended)`);
      try { ws.send(JSON.stringify({ type: 'ended', callId, reason })); } catch {}
      try { ws.close(1000, 'call ended'); } catch {}
    }
  }

  public createMonitorWebSocketServer(): WebSocketServer {
    this.monitorWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
    this.monitorWss.on('connection', (ws) => {
      ws.send(
        JSON.stringify({
          type: 'bridge_snapshot',
          status: this.getStatus(),
        })
      );
    });
    return this.monitorWss;
  }

  private broadcastMonitor(event: Record<string, any>) {
    if (!this.monitorWss) return;
    const msg = JSON.stringify(event);
    for (const client of this.monitorWss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  }

  public getStatus() {
    return {
      ...this.stats,
      bindHost: this.host,
      audioSocketPort: this.audioSocketPort,
      sipPort: this.sipPort,
      activeCallsCount: this.activeCalls.size,
      activeCalls: Array.from(this.activeCalls.values()),
      sipRegistration: this.sipRegistrationClient?.snapshot() || { status: 'stopped', registrar: '', expiresAt: null, lastError: null },
    };
  }

  public forceHangupCall(callId: string): boolean {
    const closer = this.activeSessionClosers.get(callId);
    if (!closer) return false;
    closer('supervisor_force_hangup');
    return true;
  }

  public async forceTransferCall(callId: string, reason = 'Supervisor forced live transfer'): Promise<boolean> {
    const xfer = this.activeSessionTransferrers.get(callId);
    if (!xfer) return false;
    await xfer(reason);
    return true;
  }

  private isCampaignOverCapacity(campaign?: Campaign): boolean {
    if (!campaign || !Number.isFinite(campaign.maxCalls) || campaign.maxCalls <= 0) {
      return false;
    }
    let activeOnCampaign = 0;
    for (const c of this.activeCalls.values()) {
      if (c.campaignId === campaign.id) {
        activeOnCampaign += 1;
      }
    }
    return activeOnCampaign >= campaign.maxCalls;
  }

  public setViciApiBaseOverride(url?: string) {
    this.viciApiBaseOverride = url;
  }

  /**
   * Registers pre-call metadata from Asterisk dialplan CURL() right before AudioSocket()
   * and returns a canonical 36-char RFC 4122 UUID string.
   */
  public registerPreCall(input: PreCallRegistrationInput): {
    uuid: string;
    callerCode: string;
    leadId: string | null;
    exten: string;
    agentName: string;
    viciCampaign: string;
  } {
    // Prune stale unclaimed pre-call entries older than 45s
    const now = Date.now();
    for (const [k, rec] of this.preCallRegistry.entries()) {
      if (now - rec.createdAt > 45000) this.preCallRegistry.delete(k);
    }

    const state = getConsoleState();
    const effectiveVici = this.viciApiBaseOverride
      ? { ...state.vici, viciBaseUrl: this.viciApiBaseOverride }
      : state.vici;

    const exten = String(input.exten || '').trim();
    const resolved = resolveCampaignAndAgent(state, exten);
    if (resolved.error || !resolved.campaign || !resolved.agent) {
      throw new Error(resolved.error || 'Campaign assignment is required before call registration.');
    }
    const { campaign, agent, remoteAgentUser } = resolved;
    const parsedCaller = parseVicidialCallerCode(input.vici_cid || input.caller_code, input.phone);
    const raUser = String(input.agent_user || remoteAgentUser);

    const viciClient = new VicidialApiClient(effectiveVici);
    const leadPromise = viciClient.fetchLeadInfo({
      leadId: parsedCaller.leadId,
      phone: parsedCaller.phone,
      campaignId: campaign?.viciCampaign,
    });

    if (this.preCallRegistry.size >= 512) throw new Error('Too many unclaimed pre-call registrations.');
    const uuid = crypto.randomUUID();
    this.preCallRegistry.set(uuid, {
      uuid,
      createdAt: now,
      exten,
      channel: String(input.channel || ''),
      uniqueid: String(input.uniqueid || ''),
      parsedCaller,
      campaign,
      agent,
      remoteAgentUser: raUser,
      viciClient,
      leadPromise,
    });

    return {
      uuid,
      callerCode: parsedCaller.callerCode,
      leadId: parsedCaller.leadId,
      exten,
      agentName: agent.name,
      viciCampaign: campaign?.viciCampaign || '',
    };
  }

  public async start(): Promise<void> {
    this.preCallSweepTimer = setInterval(() => {
      const cutoff = Date.now() - 45000;
      for (const [key, rec] of this.preCallRegistry) if (rec.createdAt <= cutoff) this.preCallRegistry.delete(key);
    }, 15000);
    this.preCallSweepTimer.unref();
    await this.startAudioSocketServer();
    try {
      await this.startSipRtpServer();
      // BRIDGE_SIP_PORT may override the saved console port; register the port
      // this process actually listens on, not the stale saved value.
      const sipCfg = { ...getConsoleState().vici, sipPort: this.sipPort };
      if (sipCfg.sipConnectionMode === 'registration' || sipCfg.sipConnectionMode === 'hybrid') {
        this.sipRegistrationClient = new SipRegistrationClient(sipCfg);
        await this.sipRegistrationClient.start();
      }
    } catch (err) {
      await this.stop();
      throw err;
    }
  }

  public async stop(): Promise<void> {
    if (this.preCallSweepTimer) { clearInterval(this.preCallSweepTimer); this.preCallSweepTimer = null; }
    this.preCallRegistry.clear();
    if (this.sipRegistrationClient) {
      await this.sipRegistrationClient.stop();
      this.sipRegistrationClient = null;
    }
    if (this.monitorWss) {
      for (const client of this.monitorWss.clients) client.terminate();
      this.monitorWss.close();
      this.monitorWss = null;
    }
    const closing = Array.from(this.activeSessionClosers.values()).map(async (closer) => {
      try { await closer('bridge_shutdown'); } catch {}
    });
    await Promise.allSettled(closing);
    this.activeSessionClosers.clear();
    this.activeCalls.clear();

    if (this.tcpServer) {
      await new Promise<void>((r) => this.tcpServer!.close(() => r()));
      this.tcpServer = null;
      this.stats.audioSocketListening = false;
    }
    if (this.sipSocket) {
      await new Promise<void>((r) => {
        try {
          this.sipSocket!.close(() => r());
        } catch {
          r();
        }
      });
      this.sipSocket = null;
      this.stats.sipRtpListening = false;
    }
  }

  // ==================== TRANSPORT 1: ASTERISK 18+ AUDIOSOCKET TCP ====================

  private async startAudioSocketServer(): Promise<void> {
    this.tcpServer = net.createServer((socket) => {
      if (!isBridgePeerIpAllowed(socket.remoteAddress)) {
        this.stats.rejectedUntrustedIpCount += 1;
        this.stats.lastError = `Rejected untrusted AudioSocket peer IP: ${socket.remoteAddress}`;
        socket.destroy();
        return;
      }
      socket.setNoDelay(true);
      let rxBuffer = Buffer.alloc(0);
      let sessionStarted = false;
      let httpForwarded = false;
      let sessionCallbacks: {
        onCallerPcm8k: (pcm: Buffer) => void;
        onCallerDtmf: (d: string) => void;
        onTransportClosed: (reason: string) => void;
      } | null = null;

      let txPcmQueue = Buffer.alloc(0);
      let pacerTimer: NodeJS.Timeout | null = null;
      let socketClosed = false;

      const stopPacer = () => {
        if (pacerTimer) {
          clearInterval(pacerTimer);
          pacerTimer = null;
        }
      };

      const writeAudioSocketFrame = (kind: number, payload: Buffer) => {
        if (socketClosed || !socket.writable) return;
        const header = Buffer.allocUnsafe(3);
        header[0] = kind & 0xff;
        header.writeUInt16BE(payload.length, 1);
        socket.write(Buffer.concat([header, payload]));
      };

      // 20ms (320-byte @ 8kHz linear16) frame pacer for Asterisk app_audiosocket
      pacerTimer = setInterval(() => {
        if (socketClosed || txPcmQueue.length === 0) return;
        let frame: Buffer;
        if (txPcmQueue.length >= 320) {
          frame = txPcmQueue.subarray(0, 320);
          txPcmQueue = txPcmQueue.subarray(320);
        } else {
          frame = Buffer.alloc(320, 0);
          txPcmQueue.copy(frame, 0);
          txPcmQueue = Buffer.alloc(0);
        }
        writeAudioSocketFrame(0x10, frame);
        hooks.onFramePlayed?.(frame);
      }, 20);

      const hooks: TransportHooks = {
        enqueueBotPcm8k: (pcm8kLe: Buffer) => {
          if (socketClosed || pcm8kLe.length === 0) return;
          txPcmQueue = txPcmQueue.length > 0 ? Buffer.concat([txPcmQueue, pcm8kLe]) : Buffer.from(pcm8kLe);
        },
        pendingPlaybackMs: () => Math.ceil(txPcmQueue.length / 320) * 20,
        bargeInFlush: () => {
          txPcmQueue = Buffer.alloc(0);
        },
        hangupTransport: () => {
          if (socketClosed) return;
          writeAudioSocketFrame(0x00, Buffer.alloc(0));
          socketClosed = true;
          stopPacer();
          socket.end();
        },
      };

      socket.on('data', (chunk) => {
        if (httpForwarded) return;
        if (rxBuffer.length === 0 && !sessionStarted && chunk.length > 0 && chunk[0] >= 0x41 && chunk[0] <= 0x5a) {
          // Forwarding makes the console see a loopback peer. Never let an
          // allowed remote PBX use this shortcut to gain loopback privileges.
          if (!isLoopbackIp(socket.remoteAddress)) {
            stopPacer();
            socket.destroy();
            return;
          }
          httpForwarded = true;
          stopPacer();
          const targetPort = Number(process.env.PORT || 533);
          const upstream = net.connect(targetPort, 'localhost');
          upstream.setNoDelay(true);
          upstream.on('error', () => socket.destroy());
          socket.on('error', () => upstream.destroy());
          upstream.write(chunk);
          socket.pipe(upstream);
          upstream.pipe(socket);
          return;
        }

        if (!isBridgePeerIpAllowed(socket.remoteAddress)) {
          this.stats.rejectedUntrustedIpCount += 1;
          this.stats.lastError = `Rejected untrusted AudioSocket peer IP: ${socket.remoteAddress}`;
          stopPacer();
          socket.destroy();
          return;
        }

        rxBuffer = rxBuffer.length > 0 ? Buffer.concat([rxBuffer, chunk]) : chunk;

        while (rxBuffer.length >= 3) {
          const kind = rxBuffer[0];
          const len = rxBuffer.readUInt16BE(1);
          if (rxBuffer.length < 3 + len) break;

          const payload = rxBuffer.subarray(3, 3 + len);
          rxBuffer = rxBuffer.subarray(3 + len);

          if (kind === 0x01 && !sessionStarted) {
            sessionStarted = true;
            const uuid = uuidBytesToCanonical(payload);
            const pre = this.preCallRegistry.get(uuid);
            if (pre) this.preCallRegistry.delete(uuid);

            sessionCallbacks = this.launchCallSession({
              transport: 'audiosocket',
              sessionUuid: uuid,
              preCall: pre,
              hooks,
            });
          } else if (kind === 0x10 && sessionCallbacks) {
            sessionCallbacks.onCallerPcm8k(payload);
          } else if (kind === 0x12 && sessionCallbacks) {
            sessionCallbacks.onCallerPcm8k(downsample16kTo8kLinear16(payload));
          } else if (kind === 0x03 && sessionCallbacks && payload.length >= 1) {
            sessionCallbacks.onCallerDtmf(payload.toString('ascii', 0, 1));
          } else if (kind === 0x00 || kind === 0xff) {
            socketClosed = true;
            stopPacer();
            sessionCallbacks?.onTransportClosed(kind === 0x00 ? 'asterisk_audiosocket_hangup' : 'audiosocket_error');
            socket.destroy();
            return;
          }
        }
      });

      socket.on('close', () => {
        socketClosed = true;
        stopPacer();
        sessionCallbacks?.onTransportClosed('audiosocket_tcp_closed');
      });

      socket.on('error', () => {
        socketClosed = true;
        stopPacer();
        sessionCallbacks?.onTransportClosed('audiosocket_tcp_error');
      });
    });

    await new Promise<void>((resolve, reject) => {
      const tryListen = (candidatePort: number, candidateHost: string) => {
        const onErr = (err: NodeJS.ErrnoException) => {
          this.tcpServer!.removeListener('error', onErr);
          reject(err);
        };
        this.tcpServer!.once('error', onErr);
        this.tcpServer!.listen(candidatePort, candidateHost, () => {
          this.tcpServer!.removeListener('error', onErr);
          const addr = this.tcpServer!.address();
          if (addr && typeof addr === 'object') {
            this.audioSocketPort = addr.port;
          }
          this.stats.audioSocketListening = true;
          resolve();
        });
      };
      tryListen(this.audioSocketPort, this.host);
    });
  }

  // ==================== TRANSPORT 2: ASTERISK 13/16/18+ SIP + RTP (G.711 ULAW) ====================

  private async startSipRtpServer(): Promise<void> {
    const sock = dgram.createSocket('udp4');
    this.sipSocket = sock;

    interface SipDialog {
      callId: string;
      localTag: string;
      remoteFromHeader: string;
      localToHeaderWithTag: string;
      remoteContactUri: string;
      remoteSignalingIp: string;
      remoteSignalingPort: number;
      rtpSocket: dgram.Socket;
      onSipClosed: (reason: string) => void;
    }

    const dialogs = new Map<string, SipDialog>();

    const parseSipMessage = (raw: string) => {
      const sep = raw.indexOf('\r\n\r\n');
      const headBlock = sep >= 0 ? raw.slice(0, sep) : raw;
      const body = sep >= 0 ? raw.slice(sep + 4) : '';
      const lines = headBlock.split(/\r?\n/);
      const startLine = lines[0] || '';
      const headers: Record<string, string[]> = {};
      for (let i = 1; i < lines.length; i++) {
        const idx = lines[i].indexOf(':');
        if (idx > 0) {
          const name = lines[i].slice(0, idx).trim().toLowerCase();
          const val = lines[i].slice(idx + 1).trim();
          if (!headers[name]) headers[name] = [];
          headers[name].push(val);
        }
      }
      return { startLine, headers, body };
    };

    const firstHeader = (h: Record<string, string[]>, full: string, compact?: string) =>
      h[full]?.[0] || (compact ? h[compact]?.[0] : '') || '';

    const sendSipResponse = (
      statusLine: string,
      reqHeaders: Record<string, string[]>,
      toHeader: string,
      extraHeaders: string[],
      sdpBody: string,
      rinfo: dgram.RemoteInfo
    ) => {
      const vias = reqHeaders['via'] || reqHeaders['v'] || [];
      const fromH = firstHeader(reqHeaders, 'from', 'f');
      const callIdH = firstHeader(reqHeaders, 'call-id', 'i');
      const cseqH = firstHeader(reqHeaders, 'cseq');
      const bodyBuf = Buffer.from(sdpBody, 'utf8');

      const respLines = [
        `SIP/2.0 ${statusLine}`,
        ...vias.map((v) => `Via: ${v}`),
        `From: ${fromH}`,
        `To: ${toHeader}`,
        `Call-ID: ${callIdH}`,
        `CSeq: ${cseqH}`,
        'User-Agent: VoiceAgentBridge/3.0',
        ...extraHeaders,
        ...(bodyBuf.length > 0 ? ['Content-Type: application/sdp'] : []),
        `Content-Length: ${bodyBuf.length}`,
        '',
        sdpBody,
      ];
      const msgBuf = Buffer.from(respLines.join('\r\n'), 'utf8');
      sock.send(msgBuf, rinfo.port, rinfo.address);
    };

    sock.on('message', async (msgBuf, rinfo) => {
      try {
      const raw = msgBuf.toString('utf8');
      const { startLine, headers, body } = parseSipMessage(raw);
      if (!startLine || startLine.startsWith('SIP/2.0')) return;

      const [methodRaw, requestUri] = startLine.split(/\s+/);
      const method = (methodRaw || '').toUpperCase();
      const callId = firstHeader(headers, 'call-id', 'i').slice(0, 256);
      if (!callId || /[\r\n\x00]/.test(callId)) return;
      const toRaw = firstHeader(headers, 'to', 't');
      const fromRaw = firstHeader(headers, 'from', 'f');

      if (!isBridgePeerIpAllowed(rinfo.address)) {
        this.stats.rejectedUntrustedIpCount += 1;
        this.stats.lastError = `Rejected untrusted SIP peer IP: ${rinfo.address}`;
        if (method === 'INVITE' || method === 'OPTIONS') {
          sendSipResponse('403 Forbidden', headers, toRaw, [], '', rinfo);
        }
        return;
      }

      if (method === 'OPTIONS') {
        const tag = crypto.randomBytes(4).toString('hex');
        const toWithTag = /;tag=/i.test(toRaw) ? toRaw : `${toRaw};tag=${tag}`;
        sendSipResponse(
          '200 OK',
          headers,
          toWithTag,
          ['Allow: INVITE, ACK, CANCEL, OPTIONS, BYE'],
          '',
          rinfo
        );
        return;
      }

      if (method === 'ACK') {
        return;
      }

      if (method === 'BYE' || method === 'CANCEL') {
        const dlg = dialogs.get(callId);
        const toWithTag = dlg?.localToHeaderWithTag || toRaw;
        sendSipResponse('200 OK', headers, toWithTag, [], '', rinfo);
        if (dlg) {
          dialogs.delete(callId);
          dlg.onSipClosed(method === 'BYE' ? 'asterisk_sip_bye' : 'asterisk_sip_cancel');
        }
        return;
      }

      if (method === 'INVITE') {
        // Re-INVITE or retransmission check
        if (dialogs.has(callId)) {
          sendSipResponse('100 Trying', headers, toRaw, [], '', rinfo);
          return;
        }

        sendSipResponse('100 Trying', headers, toRaw, [], '', rinfo);

        // Parse dialed extension from Request-URI: sip:88001@<bridge-host>:5062
        const uriMatch = /sip:([^@;>\s]+)/i.exec(requestUri || '');
        const exten = firstHeader(headers, 'x-vici-exten') || (uriMatch ? uriMatch[1] : '');

        // Campaign maxCalls concurrency guard
        const curStateForCap = getConsoleState();
        const resolvedForCap = resolveCampaignAndAgent(curStateForCap, exten);
        if (resolvedForCap.error) {
          this.stats.lastError = resolvedForCap.error;
          sendSipResponse('503 Service Unavailable', headers, toRaw, ['Warning: 399 ViciBridge "Campaign not ready"'], '', rinfo);
          return;
        }
        if (this.isCampaignOverCapacity(resolvedForCap.campaign)) {
          this.stats.rejectedOverCapacityCount += 1;
          this.stats.lastError = `Campaign "${resolvedForCap.campaign?.name}" at maxCalls capacity (${resolvedForCap.campaign?.maxCalls})`;
          sendSipResponse('486 Busy Here', headers, toRaw, [], '', rinfo);
          return;
        }

        // Parse From header: "V1027153012000104892" <sip:3055550192@<bridge-host>>;tag=as123
        const dispMatch = /^\s*"?([^"<]+?)"?\s*<sip:([^@;>]+)/i.exec(fromRaw);
        const sipUriPhoneMatch = /<sip:([^@;>]+)/i.exec(fromRaw);
        const viciCidHeader = firstHeader(headers, 'x-vici-callname');
        const callerName = viciCidHeader || (dispMatch ? dispMatch[1].trim() : '');
        const callerNum = dispMatch ? dispMatch[2].trim() : sipUriPhoneMatch ? sipUriPhoneMatch[1].trim() : '';
        const xChannel = firstHeader(headers, 'x-vici-channel');
        const xUniqueId = firstHeader(headers, 'x-vici-uniqueid');

        // Parse remote RTP endpoint from SDP
        const cMatch = /^c=IN IP4\s+([^\r\n\s]+)/m.exec(body);
        const mMatch = /^m=audio\s+(\d+)\s+RTP\/AVP/m.exec(body);
        const rawRemoteRtpIp = cMatch ? cMatch[1].trim() : rinfo.address;
        let remoteRtpIp = rawRemoteRtpIp.toLowerCase() === 'localhost' ? '127.0.0.1' : rawRemoteRtpIp;
        if (net.isIP(remoteRtpIp) === 0) {
          sendSipResponse('488 Not Acceptable Here', headers, toRaw, [], '', rinfo);
          return;
        }
        let remoteRtpPort = mMatch ? Number(mMatch[1]) : 0;
        // NAT: a PBX behind NAT often advertises its private address in SDP.
        // The signaling source is already allowlisted, so send media there and
        // latch onto the real RTP source below (symmetric RTP / comedia).
        if (!isBridgePeerIpAllowed(remoteRtpIp) && isBridgePeerIpAllowed(rinfo.address)) {
          remoteRtpIp = rinfo.address;
        }

        if (!Number.isInteger(remoteRtpPort) || remoteRtpPort < 1024 || remoteRtpPort > 65535 || !isBridgePeerIpAllowed(remoteRtpIp)) {
          this.stats.lastError = 'SIP SDP media endpoint is missing or outside the trusted PBX allowlist.';
          sendSipResponse('488 Not Acceptable Here', headers, toRaw, [], '', rinfo);
          return;
        }

        // Bind dedicated UDP RTP socket for this call
        const rtpSocket = dgram.createSocket('udp4');
        try {
          await new Promise<void>((resolve, reject) => {
            const onError = (err: Error) => reject(err);
            rtpSocket.once('error', onError);
            const range = rtpPortRange();
            if (!range) {
              rtpSocket.bind(0, this.host, () => { rtpSocket.removeListener('error', onError); resolve(); });
              return;
            }
            // Try the configured range starting at a random offset so
            // concurrent calls do not all contend for the same first port.
            const span = range.max - range.min + 1;
            const start = crypto.randomInt(0, span);
            let attempt = 0;
            const tryPort = () => {
              if (attempt >= span) { onError(new Error('No free RTP port in BRIDGE_RTP_PORT_MIN..MAX')); return; }
              const port = range.min + ((start + attempt) % span);
              attempt += 1;
              const retry = (err: NodeJS.ErrnoException) => {
                if (err.code === 'EADDRINUSE') tryPort(); else onError(err);
              };
              rtpSocket.removeListener('error', onError);
              rtpSocket.once('error', retry);
              rtpSocket.bind(port, this.host, () => {
                rtpSocket.removeListener('error', retry);
                resolve();
              });
            };
            tryPort();
          });
        } catch {
          try { rtpSocket.close(); } catch {}
          sendSipResponse('503 Service Unavailable', headers, toRaw, [], '', rinfo);
          return;
        }
        // Registered only after binding: during a port-range scan an
        // EADDRINUSE must retry the next port, not close the socket.
        rtpSocket.on('error', () => { try { rtpSocket.close(); } catch {} });
        // An earlier concurrent INVITE may have won while this socket was binding.
        if (dialogs.has(callId)) { try { rtpSocket.close(); } catch {} return; }
        const localRtpPort = (rtpSocket.address() as net.AddressInfo).port;

        const localIpForSdp = resolveSdpAdvertisedHost(rinfo.address, getConsoleState().vici.bridgeHost || '', this.host);
        const localTag = `vab${crypto.randomBytes(4).toString('hex')}`;
        const localToWithTag = /;tag=/i.test(toRaw) ? toRaw : `${toRaw};tag=${localTag}`;

        const contactHeaderRaw = firstHeader(headers, 'contact', 'm');
        const contactUriMatch = /<(sip:[^>]+)>/i.exec(contactHeaderRaw);
        const remoteContactUri = contactUriMatch
          ? contactUriMatch[1]
          : `sip:${callerNum || 'asterisk'}@${rinfo.address}:${rinfo.port}`;

        const sdpAnswer = [
          'v=0',
          `o=VoiceAgentBridge ${Date.now() & 0x7fffffff} 1 IN IP4 ${localIpForSdp}`,
          's=DeepgramViciBridge',
          `c=IN IP4 ${localIpForSdp}`,
          't=0 0',
          `m=audio ${localRtpPort} RTP/AVP 0 101`,
          'a=rtpmap:0 PCMU/8000',
          'a=rtpmap:101 telephone-event/8000',
          'a=fmtp:101 0-15',
          'a=ptime:20',
          'a=sendrecv',
          '',
        ].join('\r\n');

        // Validate and register the exact campaign before accepting the SIP call.
        const preReg = (() => {
          try {
            return this.registerPreCall({
              uniqueid: xUniqueId || callId,
              vici_cid: callerName,
              phone: callerNum,
              exten,
              channel: xChannel,
            });
          } catch (err: any) {
            this.stats.lastError = err?.message || 'Campaign pre-call registration failed.';
            return null;
          }
        })();
        if (!preReg) {
          try { rtpSocket.close(); } catch {}
          sendSipResponse('503 Service Unavailable', headers, toRaw, ['Warning: 399 ViciBridge "Campaign registration failed"'], '', rinfo);
          return;
        }
        const preRecord = this.preCallRegistry.get(preReg.uuid);
        if (preRecord) this.preCallRegistry.delete(preReg.uuid);

        sendSipResponse(
          '200 OK',
          headers,
          localToWithTag,
          [
            `Contact: <sip:${exten || 'bridge'}@${localIpForSdp}:${this.sipPort}>`,
            'Allow: INVITE, ACK, CANCEL, OPTIONS, BYE',
          ],
          sdpAnswer,
          rinfo
        );

        let rtpClosed = false;
        let txPcmQueue = Buffer.alloc(0);
        let rtpSeq = crypto.randomInt(1, 30000);
        let rtpTimestamp = crypto.randomInt(1000, 100000);
        const rtpSsrc = crypto.randomBytes(4).readUInt32BE(0);
        let nextTalkspurtMarker = true;
        // A lost BYE must not leave a call (and its paid Deepgram session and
        // maxCalls slot) open forever: end the call when inbound RTP stops.
        const rtpTimeoutMs = rtpInactivityTimeoutMs();
        let lastInboundRtpAt = Date.now();
        let rtpLatched = false;
        const signalingIp = rinfo.address;

        const rtpPacer = setInterval(() => {
          if (rtpClosed) return;
          if (rtpTimeoutMs && Date.now() - lastInboundRtpAt > rtpTimeoutMs) {
            this.stats.lastError = `SIP call ${callId} ended: no inbound RTP for ${Math.round(rtpTimeoutMs / 1000)}s`;
            const dlg = dialogs.get(callId);
            cleanupRtpAndBye(true);
            if (dlg) sessionCallbacks.onTransportClosed('rtp_timeout');
            return;
          }
          if (txPcmQueue.length === 0) {
            nextTalkspurtMarker = true;
            return;
          }
          let pcmFrame: Buffer;
          if (txPcmQueue.length >= 320) {
            pcmFrame = txPcmQueue.subarray(0, 320);
            txPcmQueue = txPcmQueue.subarray(320);
          } else {
            pcmFrame = Buffer.alloc(320, 0);
            txPcmQueue.copy(pcmFrame, 0);
            txPcmQueue = Buffer.alloc(0);
          }
          const ulawPayload = linear16ToUlaw(pcmFrame); // 160 bytes PCMU
          const rtpPkt = buildRtpPacket({
            payloadType: 0,
            sequenceNumber: rtpSeq++,
            timestamp: rtpTimestamp,
            ssrc: rtpSsrc,
            marker: nextTalkspurtMarker,
            payload: ulawPayload,
          });
          rtpTimestamp = (rtpTimestamp + 160) >>> 0;
          nextTalkspurtMarker = false;
          rtpSocket.send(rtpPkt, remoteRtpPort, remoteRtpIp);
          hooks.onFramePlayed?.(pcmFrame);
        }, 20);

        const cleanupRtpAndBye = (sendByeToAsterisk: boolean) => {
          if (rtpClosed) return;
          rtpClosed = true;
          clearInterval(rtpPacer);
          dialogs.delete(callId);
          try {
            rtpSocket.close();
          } catch {}

          if (sendByeToAsterisk && this.sipSocket) {
            const branch = `z9hG4bK${crypto.randomBytes(5).toString('hex')}`;
            const byeMsg = [
              `BYE ${remoteContactUri} SIP/2.0`,
              `Via: SIP/2.0/UDP ${localIpForSdp}:${this.sipPort};branch=${branch};rport`,
              `From: ${localToWithTag}`,
              `To: ${fromRaw}`,
              `Call-ID: ${callId}`,
              'CSeq: 1 BYE',
              'Content-Length: 0',
              '',
              '',
            ].join('\r\n');
            try {
              this.sipSocket.send(Buffer.from(byeMsg, 'utf8'), rinfo.port, rinfo.address);
            } catch {}
          }
        };

        const hooks: TransportHooks = {
          enqueueBotPcm8k: (pcm8kLe: Buffer) => {
            if (rtpClosed || pcm8kLe.length === 0) return;
            txPcmQueue = txPcmQueue.length > 0 ? Buffer.concat([txPcmQueue, pcm8kLe]) : Buffer.from(pcm8kLe);
          },
          pendingPlaybackMs: () => Math.ceil(txPcmQueue.length / 320) * 20,
          bargeInFlush: () => {
            txPcmQueue = Buffer.alloc(0);
            nextTalkspurtMarker = true;
          },
          hangupTransport: () => {
            cleanupRtpAndBye(true);
          },
        };

        const sessionCallbacks = this.launchCallSession({
          transport: 'sip_rtp',
          sessionUuid: preReg.uuid,
          preCall: preRecord,
          hooks,
        });

        rtpSocket.on('message', (pktBuf, peer) => {
          if (rtpClosed) return;
          const fromExpected = peer.address === remoteRtpIp && peer.port === remoteRtpPort;
          // Symmetric RTP: behind NAT the media source port (and sometimes
          // address) differs from the SDP. Latch once onto a trusted source.
          const trustedSource = (peer.address === remoteRtpIp || peer.address === signalingIp) && isBridgePeerIpAllowed(peer.address);
          if (!fromExpected && (rtpLatched || !trustedSource)) return;
          const parsed = parseRtpPacket(pktBuf);
          if (!parsed) return;
          if (!fromExpected) {
            remoteRtpIp = peer.address;
            remoteRtpPort = peer.port;
          }
          rtpLatched = true;
          lastInboundRtpAt = Date.now();
          if (parsed.payloadType === 0 && parsed.payload.length > 0) {
            sessionCallbacks.onCallerPcm8k(ulawToLinear16(parsed.payload));
          } else if (parsed.payloadType === 101) {
            const dtmf = parseRfc4733Dtmf(parsed.payload);
            if (dtmf && dtmf.endOfEvent) {
              sessionCallbacks.onCallerDtmf(dtmf.digit);
            }
          }
        });

        dialogs.set(callId, {
          callId,
          localTag,
          remoteFromHeader: fromRaw,
          localToHeaderWithTag: localToWithTag,
          remoteContactUri,
          remoteSignalingIp: rinfo.address,
          remoteSignalingPort: rinfo.port,
          rtpSocket,
          onSipClosed: (reason) => {
            cleanupRtpAndBye(false);
            sessionCallbacks.onTransportClosed(reason);
          },
        });
      }
      } catch (err: any) {
        this.stats.lastError = `SIP request failed: ${err?.message || 'unknown error'}`;
      }
    });

    await new Promise<void>((resolve, reject) => {
      const tryBind = (candidatePort: number, candidateHost: string) => {
        const onErr = (err: NodeJS.ErrnoException) => {
          sock.removeListener('error', onErr);
          reject(err);
        };
        sock.once('error', onErr);
        sock.bind(candidatePort, candidateHost, () => {
          sock.removeListener('error', onErr);
          const addr = sock.address();
          if (addr && typeof addr === 'object') {
            this.sipPort = addr.port;
          }
          this.stats.sipRtpListening = true;
          resolve();
        });
      };
      tryBind(this.sipPort, this.host);
    });
  }

  // ==================== UNIFIED CALL LIFECYCLE ORCHESTRATOR ====================

  private launchCallSession(opts: {
    transport: 'audiosocket' | 'sip_rtp';
    sessionUuid: string;
    preCall?: PreCallRecord;
    hooks: TransportHooks;
  }) {
    const state = getConsoleState();
    const effectiveVici = this.viciApiBaseOverride
      ? { ...state.vici, viciBaseUrl: this.viciApiBaseOverride }
      : state.vici;

    const exten = String(opts.preCall?.exten || '').trim();
    const resolved = resolveCampaignAndAgent(state, exten);
    if (resolved.error || !resolved.campaign || !resolved.agent) {
      this.stats.lastError = resolved.error || 'Campaign assignment is required before the bridge can start a call.';
      opts.hooks.hangupTransport();
      return { onCallerPcm8k: () => {}, onCallerDtmf: () => {}, onTransportClosed: () => {} };
    }
    if (opts.preCall && (opts.preCall.campaign.id !== resolved.campaign.id || opts.preCall.agent.id !== resolved.agent.id)) {
      this.stats.lastError = 'Campaign assignment changed between pre-call registration and media connection; refusing to use stale campaign rules.';
      opts.hooks.hangupTransport();
      return { onCallerPcm8k: () => {}, onCallerDtmf: () => {}, onTransportClosed: () => {} };
    }
    const campaign = resolved.campaign;
    const agent = resolved.agent;
    const remoteAgentUser = opts.preCall?.remoteAgentUser || resolved.remoteAgentUser;
    const parsedCaller = opts.preCall?.parsedCaller || parseVicidialCallerCode('', '');
    const channel = opts.preCall?.channel || '';
    const viciClient = opts.preCall?.viciClient || new VicidialApiClient(effectiveVici);
    const amiClient = new AsteriskAmiClient(effectiveVici);

    const callId = `vici_${Date.now().toString(36)}_${opts.sessionUuid.slice(0, 8)}`;
    const startedAtIso = new Date().toISOString();
    const startedAtMs = Date.now();
    const recorder = new StereoCallRecorder8k(startedAtMs);

    const missingGlobalServices = (['stt', 'llm', 'tts'] as const).filter((kind) => {
      const selected = state.services?.[kind];
      const provider = state.providers.find((p) => p.kind === kind && p.id === selected?.providerId);
      return !provider || !String(selected?.model || '').trim();
    });
    if (missingGlobalServices.length > 0) {
      this.stats.lastError = `Global services not configured: ${missingGlobalServices.join(', ')}`;
      opts.hooks.hangupTransport();
      return {
        onCallerPcm8k: () => {},
        onCallerDtmf: () => {},
        onTransportClosed: () => {},
      };
    }

    if (this.isCampaignOverCapacity(campaign)) {
      this.stats.rejectedOverCapacityCount += 1;
      this.stats.lastError = `Campaign "${campaign?.name}" at maxCalls capacity (${campaign?.maxCalls})`;
      opts.hooks.hangupTransport();
      return {
        onCallerPcm8k: () => {},
        onCallerDtmf: () => {},
        onTransportClosed: () => {},
      };
    }

    this.stats.totalCalls += 1;

    let closed = false;
    let settingsApplied = false;
    let selectedGreeting: GreetingRecord | null = null;
    let dgWs: WebSocket | null = null;
    let keepAliveTimer: NodeJS.Timeout | null = null;
    let comfortSilenceTimer: NodeJS.Timeout | null = null;
    let deferredActionTimer: NodeJS.Timeout | null = null;
    // The bot announced "I'm connecting you" (see announcesTransfer). Protects the
    // call from the length limit; the bridge completes the transfer if the bot
    // does not call transfer_to_live_agent itself.
    let transferIntentAt = 0;
    let transferIntentTimer: NodeJS.Timeout | null = null;
    let autoTransfer: ((reason: string) => Promise<{ ok: boolean; error: string; blockers: string[] }>) | null = null;
    const transferIntentActive = () => transferIntentAt > 0 && Date.now() - transferIntentAt < TRANSFER_INTENT_GRACE_MS;
    let speechDrainTimer: NodeJS.Timeout | null = null;
    let openingGate: OpeningGate | null = null;

    let lastCallerAudioAt = Date.now();
    // Assigned once the provider session exists (it owns the stale-audio gate).
    let performBargeInFlush: () => void = () => {};
    const bargeInGate = new BargeInGate(
      normalizeBargeInPct(agent.behavior?.bargeInSensitivityPct, agent.behavior?.bargeInSensitivity),
      () => { if (!closed && agent.behavior?.bargeIn !== 'off') performBargeInFlush(); },
    );
    let turns = 0;
    let lastUserTurnTs: number | null = null;
    let awaitingFirstAudioForTurn = false;
    const ttfbSamples: number[] = [];

    let disposition: string | null = null;
    let transferredTo: string | null = null;
    let dncAdded = false;
    let transferExecuted = false;
    let transferCompletion: Promise<void> | null = null;
    let resolveTransferCompletion: (() => void) | null = null;
    let pendingTransferArgs: {
      reason: string;
      prospect_name?: string;
      confirmed_age?: string;
      medicare_status?: string;
      hook_type?: string;
    } | null = null;
    let awaitingHangupAfterSpeech = false;
    // Set as soon as a valid transfer is requested, before any awaited VICIdial
    // call, so the call-time limit never hangs up a transfer in flight.
    let transferRequested = false;
    const callLimitTimers: NodeJS.Timeout[] = [];

    const conversationMemory = createConversationMemory();
    const cancelledFnIds = new Set<string>();
    const preSettingsAudioQueue: Buffer[] = [];
    const transcript: Array<{ ts: string; role: 'user' | 'assistant' | 'system'; content: string }> = [];
    const functionCalls: Array<{
      ts: string;
      id: string;
      name: string;
      args: Record<string, any>;
      status: string;
      response?: Record<string, any>;
    }> = [];

    const summary: ActiveBridgeCallSummary = {
      callId,
      campaignId: campaign.id,
      transport: opts.transport,
      exten,
      callerCode: parsedCaller.callerCode,
      leadId: parsedCaller.leadId,
      phone: parsedCaller.phone,
      campaignName: campaign?.name || 'Default',
      viciCampaign: campaign?.viciCampaign || '',
      agentId: agent.id,
      agentName: agent.name,
      remoteAgentUser,
      state: 'hydrating_lead',
      startedAt: startedAtIso,
      turns: 0,
      disposition: null,
      transferredTo: null,
    };

    this.activeCalls.set(callId, summary);
    this.broadcastMonitor({ type: 'call_started', call: summary, status: this.getStatus() });

    const addTranscript = (role: 'user' | 'assistant' | 'system', content: string) => {
      const entry = { ts: new Date().toISOString(), role, content };
      transcript.push(entry);
      this.broadcastMonitor({ type: 'call_transcript', callId, ...entry });
    };

    // Live listening: bot frames as they are sent, caller audio as it arrives.
    opts.hooks.onFramePlayed = (frame) => this.emitListen(callId, 2, frame);
    this.listenNotes.set(callId, (line) => addTranscript('system', line));

    const updateState = (nextState: string) => {
      summary.state = nextState;
      summary.turns = turns;
      summary.disposition = disposition;
      summary.transferredTo = transferredTo;
      this.broadcastMonitor({ type: 'call_state', call: summary });
    };

    const executeTransferAction = async (args: { reason: string; confirmed_age?: string }) => {
      if (transferExecuted || closed) return;
      transferExecuted = true;
      transferCompletion = new Promise<void>((resolve) => { resolveTransferCompletion = resolve; });

      const xferType = campaign?.xferType || 'ingroup';
      const xferTarget = campaign?.xferTarget || 'DEFAULTINGROUP';

      let xferOk = false;
      let detail = '';

      if (parsedCaller.isVicidialCallId && parsedCaller.callerCode) {
        const raRes = await viciClient.transferRemoteAgentCall({
          callerCode: parsedCaller.callerCode,
          remoteAgentUser,
          xferType,
          xferTarget,
          status: disposition || 'XFER',
        });
        xferOk = raRes.ok;
        detail = raRes.responseText;
      }

      // Fallback to Asterisk AMI Redirect when channel is known and call wasn't a Remote Agent leg
      if (!xferOk && channel) {
        const amiRes = await amiClient.redirectChannel({
          channel,
          exten: xferTarget,
        });
        viciClient.auditLog.push({
          ts: new Date().toISOString(),
          api: 'ami',
          fn: 'Redirect',
          urlOrAction: `AMI Redirect ${channel} -> ${xferTarget}`,
          ok: amiRes.ok,
          responseText: `${amiRes.response}: ${amiRes.message}`,
        });
        xferOk = amiRes.ok;
        detail = amiRes.message;
      }

      if (xferOk) {
        transferredTo = `${xferType}:${xferTarget}`;
        this.stats.completedTransfers += 1;
        addTranscript('system', `Transferred caller to ${transferredTo} (${detail})`);
      } else {
        // Apply campaign fallback (e.g. "Dispo CALLBK") so no qualified lead is dropped silently
        const fallbackCodeMatch = /dispo\s+([A-Z0-9_]{2,6})/i.exec(campaign.fallback || '');
        const fbCode = fallbackCodeMatch ? fallbackCodeMatch[1].toUpperCase() : 'CALLBK';
        if (!allowedCampaignDispositionCodes(campaign).includes(fbCode)) {
          addTranscript('system', `Transfer failed (${detail}); campaign fallback disposition ${fbCode} is not in the selected campaign’s allowed status list, so no fallback status was applied.`);
        } else {
          disposition = fbCode;
          const fallbackUpdate = await viciClient.updateLeadDisposition({
            leadId: summary.leadId,
            phone: summary.phone,
            status: fbCode,
            notes: `Transfer fallback (${detail}) — AI qualified: ${args.reason}`,
          });
          if (fallbackUpdate.ok) disposition = fbCode;
          addTranscript('system', `Transfer failed (${detail}); fallback disposition ${fbCode} ${fallbackUpdate.ok ? 'was accepted' : 'was NOT accepted'} by VICIdial.`);
        }
      }

      updateState('transferred');
      resolveTransferCompletion?.();
      resolveTransferCompletion = null;
      finalizeSession('transferred_to_closer');
    };

    const finalizeSession = async (reason: string) => {
      if (closed) return;
      closed = true;

      if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
      }
      if (comfortSilenceTimer) {
        clearInterval(comfortSilenceTimer);
        comfortSilenceTimer = null;
      }
      if (deferredActionTimer) {
        clearTimeout(deferredActionTimer);
        deferredActionTimer = null;
      }
      if (speechDrainTimer) { clearTimeout(speechDrainTimer); speechDrainTimer = null; }
      for (const t of callLimitTimers) clearTimeout(t);
      if (transferIntentTimer) { clearTimeout(transferIntentTimer); transferIntentTimer = null; }
      callLimitTimers.length = 0;
      openingGate?.cancel();
      openingGate = null;

      if (dgWs && (dgWs.readyState === WebSocket.OPEN || dgWs.readyState === WebSocket.CONNECTING)) {
        try {
          dgWs.close(1000, reason);
        } catch {}
      }

      // Do not race a HANGUP ahead of an in-flight EXTENSIONTRANSFER when the
      // mock/transport closes immediately after requesting the transfer.
      if (transferCompletion && reason !== 'transferred_to_closer') {
        await Promise.race([transferCompletion, new Promise((resolve) => setTimeout(resolve, 12000))]);
      }
      opts.hooks.hangupTransport();

      // Release Remote Agent call slot via ra_call_control HANGUP if call was NOT transferred
      if (!transferredTo && parsedCaller.isVicidialCallId && parsedCaller.callerCode) {
        await viciClient
          .hangupRemoteAgentCall({
            callerCode: parsedCaller.callerCode,
            remoteAgentUser,
            status: disposition || 'NA',
          })
          .catch(() => {});
      }

      // Listening ends with the call, and each stop is recorded before the call record is saved.
      this.closeListeners(callId, reason);
      opts.hooks.onFramePlayed = null;

      let savedRec: ReturnType<StereoCallRecorder8k['finalizeAndSave']> = null;
      try { savedRec = recorder.finalizeAndSave(callId); } catch (err: any) {
        this.stats.lastError = `Call recording could not be saved: ${err?.message || 'storage error'}`;
      }

      const endedAtIso = new Date().toISOString();
      const durationMs = Math.max(1, Date.now() - startedAtMs);
      const avgTtfbMs = ttfbSamples.length
        ? Math.round(ttfbSamples.reduce((a, b) => a + b, 0) / ttfbSamples.length)
        : null;

      const cdr = {
        id: callId,
        transport: opts.transport,
        exten,
        callerCode: parsedCaller.callerCode || '(direct)',
        leadId: summary.leadId,
        phone: summary.phone || '',
        campaignId: campaign?.id || null,
        viciCampaign: campaign?.viciCampaign || null,
        agentId: agent.id,
        agentName: agent.name,
        greetingId: selectedGreeting?.greeting_id || null,
        remoteAgentUser,
        startedAt: startedAtIso,
        endedAt: endedAtIso,
        durationMs,
        turns,
        avgTtfbMs,
        disposition,
        transferredTo,
        dncAdded,
        recordingFile: savedRec ? savedRec.fileName : null,
        recordingBytes: savedRec ? savedRec.byteSize : 0,
        transcript,
        functionCalls,
        viciApiAudit: viciClient.auditLog,
      };

      try {
        saveBridgeCallLog(cdr);
      } catch (err: any) {
        this.stats.lastError = `Call history could not be saved: ${err?.message || 'database error'}`;
      }

      this.activeCalls.delete(callId);
      this.activeSessionClosers.delete(callId);
      this.activeSessionTransferrers.delete(callId);
      this.broadcastMonitor({
        type: 'call_ended',
        callId,
        reason,
        cdr,
        status: this.getStatus(),
      });
    };

    // Hard per-call time limit (campaign.maxCallSec, default 70 s) so callers who
    // stall or play with the bot cannot hold a line and VoIP minutes:
    //   limit-20s: instruct the bot to transfer now if qualified, otherwise close
    //   limit-6s : speak a closing line and hang up after it
    //   limit    : hang up
    // A transfer that is already underway is never cut off.
    const callLimitMs = callLimitMsForCampaign(campaign);
    if (callLimitMs > 0) {
      const transferUnderway = () => Boolean(transferRequested || pendingTransferArgs || transferCompletion || transferExecuted || transferredTo || transferIntentActive());
      const plan = callLimitSchedule(callLimitMs);
      const elapsed = () => Date.now() - startedAtMs;
      const at = (ms: number, fn: () => void) => callLimitTimers.push(setTimeout(fn, Math.max(0, ms - elapsed())));
      at(plan.wrapUpAtMs, () => {
        if (closed || transferUnderway()) return;
        addTranscript('system', `Call time limit: ${Math.round((callLimitMs - plan.wrapUpAtMs) / 1000)}s left, wrap-up instruction sent to the bot`);
        if (dgWs && dgWs.readyState === WebSocket.OPEN) {
          dgWs.send(JSON.stringify({ type: 'UpdatePrompt', prompt: callLimitWrapUpPrompt(Math.round((callLimitMs - plan.wrapUpAtMs) / 1000)) }));
        }
      });
      at(plan.closingAtMs, () => {
        if (closed || transferUnderway() || awaitingHangupAfterSpeech) return;
        awaitingHangupAfterSpeech = true;
        addTranscript('system', 'Call time limit: closing line spoken, hanging up after it');
        if (dgWs && dgWs.readyState === WebSocket.OPEN) {
          dgWs.send(JSON.stringify({ type: 'InjectAgentMessage', message: CALL_LIMIT_CLOSING_LINE }));
        }
      });
      at(callLimitMs, () => {
        if (closed || transferUnderway()) return;
        addTranscript('system', `Call time limit of ${Math.round(callLimitMs / 1000)}s reached, call ended`);
        finalizeSession('max_call_duration').catch(() => {});
      });
      // Absolute backstop even while a transfer is in flight.
      at(callLimitMs + 25000, () => {
        if (closed || transferredTo) return;
        finalizeSession('max_call_duration').catch(() => {});
      });
    }

    this.activeSessionClosers.set(callId, finalizeSession);
    this.activeSessionTransferrers.set(callId, async (reason: string) => {
      if (!disposition) disposition = 'XFER';
      await executeTransferAction({ reason });
    });

    // Boot async lead hydration -> Deepgram Voice Agent 8kHz session
    (async () => {
      let hydratedLead: HydratedViciLead;
      try {
        hydratedLead = opts.preCall
          ? await opts.preCall.leadPromise
          : await viciClient.fetchLeadInfo({
              leadId: parsedCaller.leadId,
              phone: parsedCaller.phone,
              campaignId: campaign?.viciCampaign,
            });
      } catch {
        hydratedLead = {
          lead_id: parsedCaller.leadId || '',
          first_name: '',
          last_name: '',
          phone_number: parsedCaller.phone || '',
          state: '',
          city: '',
          postal_code: '',
          age: '',
          date_of_birth: '',
          email: '',
          vendor_lead_code: '',
          list_id: '',
          status: '',
          comments: '',
          campaign_id: campaign?.viciCampaign || '',
          custom: {},
          sourceApi: 'fallback',
        };
      }
      // One transfer path for both the bot's transfer_to_live_agent call and the
      // bridge completing a transfer the bot announced but did not call.
      const scheduleTransfer = async (rawArgs: Record<string, any>, onSanitized?: (a: Record<string, any>) => void): Promise<Record<string, any>> => {
        let args: Record<string, any> = rawArgs;
                  const allowedCodes = allowedCampaignDispositionCodes(campaign);
                  const transferDisposition = disposition || 'XFER';
                  const sanitized = conversationMemory.sanitizeTransferArgs(args);
                  const qualificationBlockers = conversationMemory.qualificationBlockers(campaign);
                  if (qualificationBlockers.length) {
                    return { ok: false, error: `Transfer blocked: ${qualificationBlockers.join(' ')} No transfer was scheduled.`, ...(sanitized.omitted.length ? { omitted_unverified_fields: sanitized.omitted } : {}), ...(sanitized.corrected.length ? { corrected_fields: sanitized.corrected } : {}) };
                  } else if (transferDisposition !== 'XFER' || !allowedCodes.includes('XFER')) {
                    return { ok: false, error: `Transfer requires the allowed XFER disposition for selected campaign ${campaign.viciCampaign}; current disposition is ${transferDisposition}. No transfer was scheduled.` };
                  } else {
                    transferRequested = true;
                    if (!disposition) disposition = 'XFER';
                    args = sanitized.args;
                    onSanitized?.(args);
                    const reason = String(args.reason || 'Qualified & interested lead');
                  const metaParts = [
                    args.prospect_name ? `Name:${args.prospect_name}` : hydratedLead.first_name ? `Name:${hydratedLead.first_name}` : '',
                    args.confirmed_age ? `Age:${args.confirmed_age}` : '',
                    args.medicare_status ? `Medicare:${args.medicare_status}` : '',
                    args.hook_type ? `Hook:${args.hook_type}` : '',
                  ].filter(Boolean);
                  const noteSummary = `[AI Qualified${metaParts.length ? ' | ' + metaParts.join(' | ') : ''}] ${reason}`;

                  // Push structured metadata into vicidial_list BEFORE transfer so closer screen-pop shows Name, Age, Medicare Status & Hook Type!
                  const notesUpdate = await viciClient.updateLeadDisposition({
                    leadId: summary.leadId,
                    phone: summary.phone,
                    status: disposition,
                    notes: noteSummary,
                  });

                  pendingTransferArgs = {
                    reason,
                    prospect_name: args.prospect_name || hydratedLead.first_name || undefined,
                    confirmed_age: args.confirmed_age,
                    medicare_status: args.medicare_status,
                    hook_type: args.hook_type,
                  };
                  if (deferredActionTimer) clearTimeout(deferredActionTimer);
                  deferredActionTimer = setTimeout(() => {
                    if (pendingTransferArgs) {
                      const p = pendingTransferArgs;
                      pendingTransferArgs = null;
                      executeTransferAction(p).catch(() => {});
                    }
                  }, 9000);

                  return {
                    ok: true,
                    ...(sanitized.omitted.length ? { omitted_unverified_fields: sanitized.omitted } : {}),
                    ...(sanitized.corrected.length ? { corrected_fields: sanitized.corrected } : {}),
                    transfer_scheduled: `${campaign?.xferType || 'ingroup'}:${campaign?.xferTarget || 'DEFAULTINGROUP'}`,
                    closer_screen_pop_notes_saved: notesUpdate.ok,
                    metadata_passed: {
                      prospect_name: args.prospect_name || hydratedLead.first_name || null,
                      confirmed_age: args.confirmed_age || null,
                      medicare_status: args.medicare_status || null,
                      hook_type: args.hook_type || null,
                    },
                  };
                  }
      };
      autoTransfer = async (reason: string) => {
        if (callerDeclined(conversationMemory.lastUserText())) {
          return { ok: false, error: 'caller declined', blockers: ['The caller did not agree to be connected. Do not transfer; respect their answer and close politely or ask once if they would like to speak with the specialist.'] };
        }
        const payload = await scheduleTransfer({ reason });
        return { ok: Boolean(payload.ok), error: String(payload.error || ''), blockers: conversationMemory.qualificationBlockers(campaign) };
      };

      if (closed) return;

      if (hydratedLead.lead_id) summary.leadId = hydratedLead.lead_id;
      if (hydratedLead.phone_number) summary.phone = hydratedLead.phone_number;

      addTranscript(
        'system',
        `Connected ${opts.transport.toUpperCase()} call (CID: ${parsedCaller.callerCode || 'direct'}, Lead #${summary.leadId || 'n/a'} ${hydratedLead.first_name || ''} ${hydratedLead.state || ''} via ${hydratedLead.sourceApi})`
      );

      const dgKey = getSecret('DEEPGRAM_API_KEY');
      const customAgentUrl = (process.env.DEEPGRAM_AGENT_URL || '').trim();
      const targetUrl = customAgentUrl || 'wss://agent.deepgram.com/v1/agent/converse';

      if (!dgKey && !customAgentUrl) {
        this.stats.lastError = 'Missing DEEPGRAM_API_KEY for live VICIdial call';
        addTranscript('system', '✗ Missing DEEPGRAM_API_KEY — ending call');
        await finalizeSession('missing_deepgram_key');
        return;
      }

      const picked = chooseOpeningLine(agent);
      selectedGreeting = picked ? (picked.row || { greeting_id: 'bot-list', persona: 'Bot greeting list', context: '', greeting_text: picked.line, tone: '' }) : null;
      if (picked?.line) {
        addTranscript('system', `Greeting picked from the bot's list: "${picked.line}"`);
      } else if (selectedGreeting) {
        addTranscript('system', `Selected greeting #${selectedGreeting.greeting_id} (${selectedGreeting.persona}; ${selectedGreeting.context}; ${selectedGreeting.tone}).`);
      } else if (agent.randomGreetingEnabled !== false) {
        addTranscript('system', 'Greeting library unavailable; using the configured opening.');
      }

      const rawSettings = buildDeepgramSettings(state, agent, campaign, {
        forceClientSideWebhooks: true,
        openingLine: picked?.line || '',
        greetingText: picked?.row?.greeting_text,
      });
      // Telephony is strictly 8000 Hz linear16 mono in & out
      rawSettings.audio = {
        input: { encoding: 'linear16', sample_rate: 8000 },
        output: { encoding: 'linear16', sample_rate: 8000, container: 'none' },
      };
      hydrateRealLeadIntoSettings(rawSettings, agent, campaign, hydratedLead);
      let wireSettings: any;
      let openingText = '';
      try {
        const prepared = prepareDelayedOpening(interpolateProviderPlaceholders(rawSettings), openingOptionsFor(agent));
        openingText = prepared.greeting;
        wireSettings = prepared.settings;
      } catch (err: any) {
        this.stats.lastError = err.message || 'Could not prepare the opening.';
        addTranscript('system', `✗ ${this.stats.lastError}`);
        await finalizeSession('opening_settings_error');
        return;
      }
      openingGate = createOpeningGate({
        greeting: openingText,
        ...openingGateOptionsFor(agent),
        sendOpening: (message) => {
          if (!closed && dgWs?.readyState === WebSocket.OPEN) {
            dgWs.send(JSON.stringify({ type: 'InjectAgentMessage', message }));
          }
        },
        playAudio: (pcm8k) => {
          if (closed) return;
          if (awaitingFirstAudioForTurn && lastUserTurnTs !== null) {
            ttfbSamples.push(Math.max(1, Date.now() - lastUserTurnTs));
            awaitingFirstAudioForTurn = false;
          }
          recorder.recordBotPcm8k(pcm8k);
          opts.hooks.enqueueBotPcm8k(pcm8k);
        },
        onSendError: () => {
          if (!closed) addTranscript('system', 'The configured opening could not be sent to Deepgram. Check the provider connection.');
        },
        onOverflow: () => addTranscript('system', 'Early provider audio exceeded the opening buffer and was dropped.'),
      });

      updateState('connecting_deepgram');
      dgWs = new WebSocket(targetUrl, {
        maxPayload: 4 * 1024 * 1024,
        handshakeTimeout: 15000,
        headers: dgKey ? { Authorization: `Token ${dgKey}` } : {},
        family: 4,
      });

      dgWs.on('unexpected-response', (_req, res) => {
        let body = '';
        res.on('data', (c) => (body += c.toString()));
        res.on('end', () => {
          this.stats.lastError = `Deepgram HTTP ${res.statusCode}: ${body.slice(0, 180)}`;
          addTranscript('system', `✗ ${this.stats.lastError}`);
          finalizeSession(`deepgram_http_${res.statusCode}`);
        });
      });

      dgWs.on('open', () => {
        keepAliveTimer = setInterval(() => {
          if (dgWs && dgWs.readyState === WebSocket.OPEN && settingsApplied) {
            dgWs.send(JSON.stringify({ type: 'KeepAlive' }));
          }
        }, 6000);
      });

      let suppressStaleBotAudio = false;
      performBargeInFlush = () => {
        // Instant barge-in flush on the AudioSocket / RTP queue + gate trailing TTS chunks.
        suppressStaleBotAudio = true;
        recorder.onBargeIn();
        opts.hooks.bargeInFlush();
        updateState('caller_speaking');
      };

      dgWs.on('message', async (raw, isBinary) => {
        if (closed) return;

        if (isBinary) {
          if (suppressStaleBotAudio) {
            return;
          }
          const pcm8k = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
          openingGate?.audio(pcm8k);
          return;
        }

        let evt: any;
        try {
          evt = JSON.parse(raw.toString());
        } catch {
          return;
        }

        switch (evt.type) {
          case 'Welcome': {
            dgWs?.send(JSON.stringify(wireSettings));
            break;
          }

          case 'SettingsApplied': {
            if (settingsApplied) break;
            settingsApplied = true;
            openingGate?.start();
            lastCallerAudioAt = Date.now();
            updateState('listening');

            while (preSettingsAudioQueue.length > 0) {
              const c = preSettingsAudioQueue.shift()!;
              if (dgWs?.readyState === WebSocket.OPEN) dgWs.send(c, { binary: true });
            }

            // 50ms @ 8kHz linear16 comfort-silence (800 bytes) if line goes quiet >250ms
            const silence8k = Buffer.alloc(800, 0);
            comfortSilenceTimer = setInterval(() => {
              if (
                !closed &&
                settingsApplied &&
                dgWs &&
                dgWs.readyState === WebSocket.OPEN &&
                Date.now() - lastCallerAudioAt > 250
              ) {
                dgWs.send(silence8k, { binary: true });
              }
            }, 50);
            break;
          }

          case 'UserStartedSpeaking': {
            openingGate?.userStarted();
            if (agent.behavior?.bargeIn !== 'off') {
              // Flush only when the caller's own audio is loud and long enough
              // for this bot's barge-in sensitivity (%); a cough or TV blip
              // no longer cuts the bot off.
              bargeInGate.onUserStartedSpeaking();
            }
            break;
          }

          case 'ConversationText': {
            const role = evt.role === 'user' ? 'user' : 'assistant';
            if (role === 'user') {
              openingGate?.userTurn();
              turns += 1;
              lastUserTurnTs = Date.now();
              awaitingFirstAudioForTurn = true;
            }
            suppressStaleBotAudio = false;
            const content = String(evt.content || '');
            if (role === 'user') conversationMemory.addUserText(content);
            else conversationMemory.addAssistantText(content);
            addTranscript(role, content);
            if (role === 'assistant' && !transferRequested && !transferIntentAt && announcesTransfer(content)) {
              transferIntentAt = Date.now();
              addTranscript('system', 'Bot announced a transfer: call protected from the time limit until it completes');
            }
            break;
          }

          case 'AgentThinking': {
            suppressStaleBotAudio = false;
            updateState('thinking');
            break;
          }

          case 'AgentStartedSpeaking': {
            suppressStaleBotAudio = false;
            updateState('bot_speaking');
            break;
          }

          case 'AgentAudioDone': {
            openingGate?.afterRelease(() => {
              if (closed) return;
              updateState('listening');
              // Announced a transfer but did not call the function: complete it.
              if (transferIntentAt && !transferRequested && !transferIntentTimer && autoTransfer) {
                transferIntentTimer = setTimeout(async () => {
                  transferIntentTimer = null;
                  if (closed || transferRequested || !autoTransfer) return;
                  const outcome = await autoTransfer('Bot told the caller it was connecting them');
                  if (outcome.ok) {
                    addTranscript('system', 'Transfer started by the bridge after the bot announced it');
                  } else {
                    transferIntentAt = 0; // not protected any more; the bot must fix the gap first
                    addTranscript('system', `Announced transfer not started: ${outcome.error}`);
                    if (dgWs && dgWs.readyState === WebSocket.OPEN && outcome.blockers.length) {
                      dgWs.send(JSON.stringify({ type: 'UpdatePrompt', prompt: transferBlockedPrompt(outcome.blockers) }));
                    }
                  }
                }, Math.min(opts.hooks.pendingPlaybackMs() + TRANSFER_INTENT_AUTOCOMPLETE_MS, 12000));
              }
              if (!pendingTransferArgs && !awaitingHangupAfterSpeech) return;
              // AgentAudioDone means the provider finished generating audio,
              // not that our paced SIP/AudioSocket queue has reached the caller.
              if (speechDrainTimer) clearTimeout(speechDrainTimer);
              speechDrainTimer = setTimeout(() => {
                speechDrainTimer = null;
                if (closed) return;
                if (pendingTransferArgs) {
                  const args = pendingTransferArgs;
                  pendingTransferArgs = null;
                  executeTransferAction(args).catch(() => {});
                } else if (awaitingHangupAfterSpeech && !(transferRequested && !transferExecuted)) {
                  // A transfer requested but not yet scheduled (VICIdial notes
                  // update in flight) owns the call; its own timer runs it.
                  finalizeSession('bot_end_call').catch(() => {});
                }
              }, Math.min(opts.hooks.pendingPlaybackMs() + 40, 9000));
            });
            break;
          }

          case 'FunctionCallCancelled': {
            const cid = evt.id || evt.function_call_id;
            if (cid) cancelledFnIds.add(String(cid));
            break;
          }

          case 'FunctionCallRequest': {
            const fns = Array.isArray(evt.functions) ? evt.functions : [];
            for (const fnItem of fns) {
              if (cancelledFnIds.has(fnItem.id)) continue;
              if (fnItem.client_side === false) continue;

              let args: Record<string, any> = {};
              try {
                args = fnItem.arguments ? JSON.parse(fnItem.arguments) : {};
              } catch {
                args = { _raw: fnItem.arguments || '' };
              }

              if (closed || cancelledFnIds.has(fnItem.id)) continue;
              let resultPayload: Record<string, any> = { ok: true };

              if (fnItem.name === 'set_disposition') {
                const code = String(args.code || '').trim().toUpperCase();
                const allowedCodes = allowedCampaignDispositionCodes(campaign);
                const qualificationBlockers = code === 'XFER' ? conversationMemory.qualificationBlockers(campaign) : [];
                if (!allowedCodes.includes(code)) {
                  resultPayload = { ok: false, error: `Disposition ${code || '(empty)'} is not allowed by selected campaign ${campaign.viciCampaign}. No VICIdial status was changed.` };
                } else if (qualificationBlockers.length) {
                  resultPayload = { ok: false, error: `XFER blocked: ${qualificationBlockers.join(' ')} No VICIdial status was changed.` };
                } else {
                  disposition = code;
                  const upd = await viciClient.updateLeadDisposition({
                    leadId: summary.leadId,
                    phone: summary.phone,
                    status: code,
                    notes: args.notes || '',
                  });

                  let dncInfo: any = null;
                  if ((code === 'DNC' || code === 'DNCL') && campaign.dnc !== false && summary.phone) {
                    dncInfo = await viciClient.addDncPhone({
                      phone: summary.phone,
                      campaignId: campaign.viciCampaign,
                    });
                    if (dncInfo.ok) {
                      dncAdded = true;
                      this.stats.dncCount += 1;
                    }
                  }

                  resultPayload = {
                    ok: upd.ok,
                    disposition_code: code,
                    lead_updated: upd.responseText,
                    ...(dncInfo ? { dnc_added: dncInfo } : {}),
                  };
                }
              } else if (fnItem.name === 'transfer_to_live_agent') {
                resultPayload = await scheduleTransfer(args, (a) => { args = a; });
              } else if (fnItem.name === 'end_call') {
                awaitingHangupAfterSpeech = true;
                if (deferredActionTimer) clearTimeout(deferredActionTimer);
                deferredActionTimer = setTimeout(() => {
                  if (transferRequested && !transferExecuted) return;
                  finalizeSession('bot_end_call').catch(() => {});
                }, 9000);
                resultPayload = { ok: true, action: 'hangup_after_speech' };
              } else {
                const fnConfig = state.functions.find((f) => f.name === fnItem.name && agent.fnIds.includes(f.id));
                const whRes = await executeCustomFunctionWebhook(fnConfig, args, {
                  callId,
                  callerCode: parsedCaller.callerCode,
                  leadId: summary.leadId,
                  phone: summary.phone,
                  campaignId: campaign?.id || null,
                  viciCampaign: campaign?.viciCampaign || null,
                  lead: hydratedLead,
                });
                resultPayload = whRes.executedWebhook
                  ? {
                      ok: whRes.ok,
                      http_status: whRes.httpStatus,
                      latency_ms: whRes.latencyMs,
                      result: whRes.data ?? null,
                      ...(whRes.error ? { error: whRes.error } : {}),
                    }
                  : whRes.data;
              }

              if (closed || cancelledFnIds.has(fnItem.id)) continue;
              functionCalls.push({
                ts: new Date().toISOString(),
                id: fnItem.id,
                name: fnItem.name,
                args,
                status: resultPayload.ok === false ? 'failed' : 'completed',
                response: resultPayload,
              });

              this.broadcastMonitor({
                type: 'call_function',
                callId,
                name: fnItem.name,
                args,
                response: resultPayload,
              });

              if (dgWs && dgWs.readyState === WebSocket.OPEN) {
                const respMsg: Record<string, any> = {
                  type: 'FunctionCallResponse',
                  id: fnItem.id,
                  name: fnItem.name,
                  content: JSON.stringify(resultPayload),
                };
                if (fnItem.thought_signature) {
                  respMsg.thought_signature = fnItem.thought_signature;
                }
                dgWs.send(JSON.stringify(respMsg));
              }
            }
            break;
          }

          case 'InjectionRefused': {
            addTranscript('system', 'Deepgram declined an injected message while a turn was active; playback was not confirmed.');
            break;
          }

          case 'Warning': {
            addTranscript('system', `Deepgram warning ${evt.code || 'WARNING'}: ${evt.description || evt.message || 'No details provided.'}`);
            break;
          }

          case 'Error': {
            this.stats.lastError = `${evt.code || 'DG_ERROR'}: ${evt.description || JSON.stringify(evt)}`;
            addTranscript('system', `✗ Deepgram Error: ${this.stats.lastError}`);
            await finalizeSession('deepgram_error');
            break;
          }

          default:
            break;
        }
      });

      dgWs.on('close', () => {
        if (!closed) finalizeSession('deepgram_closed').catch(() => {});
      });

      dgWs.on('error', (err) => {
        this.stats.lastError = err.message;
        if (!closed) finalizeSession('deepgram_ws_error').catch(() => {});
      });
    })().catch((err: any) => {
      this.stats.lastError = `Bridge session failed: ${err?.message || 'unknown error'}`;
      void finalizeSession('bridge_session_error').catch(() => {});
    });

    return {
      onCallerPcm8k: (pcm8k: Buffer) => {
        if (closed || pcm8k.length === 0) return;
        lastCallerAudioAt = Date.now();
        recorder.recordCallerPcm8k(pcm8k);
        this.emitListen(callId, 1, pcm8k);
        bargeInGate.onCallerAudio(pcm8k);
        if (!settingsApplied) {
          if (preSettingsAudioQueue.length < 40) {
            preSettingsAudioQueue.push(Buffer.from(pcm8k));
          }
          return;
        }
        if (dgWs && dgWs.readyState === WebSocket.OPEN) {
          dgWs.send(pcm8k, { binary: true });
        }
      },
      onCallerDtmf: (digit: string) => {
        if (closed) return;
        addTranscript('system', `Caller pressed keypad DTMF '${digit}'`);
        if (settingsApplied && dgWs && dgWs.readyState === WebSocket.OPEN) {
          openingGate?.userTurn();
          dgWs.send(
            JSON.stringify({
              type: 'InjectUserMessage',
              content: `[Caller pressed keypad digit ${digit}]`,
            })
          );
        }
      },
      onTransportClosed: (reason: string) => {
        finalizeSession(reason).catch(() => {});
      },
    };
  }
}
