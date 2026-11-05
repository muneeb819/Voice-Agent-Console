import crypto from 'crypto';
import dgram from 'dgram';
import http from 'http';
import net from 'net';
import WebSocket, { WebSocketServer } from 'ws';
import { AsteriskAmiClient } from './ami-client';
import { isBridgePeerIpAllowed, isLoopbackIp } from './auth-guard';
import { StereoCallRecorder8k } from './call-recorder';
import { getConsoleState, saveBridgeCallLog, trySelectGreeting } from './db';
import { GreetingRecord } from './greetings';
import { getSecret, MANAGED_SECRET_KEYS } from './env-store';
import { executeCustomFunctionWebhook } from './webhook-executor';
import {
  buildRtpPacket,
  downsample16kTo8kLinear16,
  linear16ToUlaw,
  parseRfc4733Dtmf,
  parseRtpPacket,
  ulawToLinear16,
} from './g711';
import { buildDeepgramSettings } from './settings-builder';
import { Agent, Campaign, ConsoleState } from './types';
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
  campaign: Campaign | undefined;
  agent: Agent;
  remoteAgentUser: string;
  viciClient: VicidialApiClient;
  leadPromise: Promise<HydratedViciLead>;
}

export interface ActiveBridgeCallSummary {
  callId: string;
  transport: 'audiosocket' | 'sip_rtp';
  exten: string;
  callerCode: string;
  leadId: string | null;
  phone: string;
  campaignName: string;
  viciCampaign: string;
  agentName: string;
  remoteAgentUser: string;
  state: string;
  startedAt: string;
  turns: number;
  disposition: string | null;
  transferredTo: string | null;
}

function interpolateEnvPlaceholders(obj: any): any {
  if (typeof obj === 'string') {
    return obj.replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g, (_match, varName) => {
      if ((MANAGED_SECRET_KEYS as readonly string[]).includes(varName)) {
        return getSecret(varName as any) || process.env[varName] || '';
      }
      if (varName === 'ELEVEN_KEY' || varName === 'ELEVEN_LABS_API_KEY') return getSecret('ELEVENLABS_API_KEY');
      if (varName === 'GROQ_KEY') return getSecret('GROQ_API_KEY');
      if (varName === 'CARTESIA_KEY') return getSecret('CARTESIA_API_KEY');
      return process.env[varName] || '';
    });
  }
  if (Array.isArray(obj)) return obj.map(interpolateEnvPlaceholders);
  if (obj && typeof obj === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = interpolateEnvPlaceholders(v);
    }
    return out;
  }
  return obj;
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

export function resolveCampaignAndAgent(
  state: ConsoleState,
  dialedExten: string
): { campaign: Campaign | undefined; agent: Agent; remoteAgentUser: string; campaignIndex: number } {
  const cleanExten = String(dialedExten || '').trim();
  const prefix = String(state.vici.aiExten || '8800').trim();
  const baseRa = Number(state.vici.remoteAgentUser || 9001);

  let idx = 0;
  if (cleanExten && state.campaigns.length > 0) {
    const exactIdx = state.campaigns.findIndex((_c, i) => cleanExten === `${prefix}${i + 1}`);
    if (exactIdx >= 0) {
      idx = exactIdx;
    } else {
      const tailMatch = /(\d)$/.exec(cleanExten);
      if (tailMatch) {
        const candidate = Number(tailMatch[1]) - 1;
        if (candidate >= 0 && candidate < state.campaigns.length) {
          idx = candidate;
        }
      }
    }
  }

  const campaign = state.campaigns[idx] || state.campaigns[0];
  const agent =
    (campaign ? state.agents.find((a) => a.id === campaign.agentId) : undefined) || state.agents[0];
  const remoteAgentUser = String(Number.isFinite(baseRa) ? baseRa + idx : state.vici.remoteAgentUser || '9001');

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
  bargeInFlush: () => void;
  hangupTransport: () => void;
}

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

  private readonly preCallRegistry = new Map<string, PreCallRecord>();
  private readonly activeCalls = new Map<string, ActiveBridgeCallSummary>();
  private readonly activeSessionClosers = new Map<string, (reason: string) => void>();
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

  public createMonitorWebSocketServer(): WebSocketServer {
    this.monitorWss = new WebSocketServer({ noServer: true });
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
      if (c.viciCampaign === campaign.viciCampaign && c.campaignName === campaign.name) {
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

    const exten = String(input.exten || `${state.vici.aiExten}1`).trim();
    const { campaign, agent, remoteAgentUser } = resolveCampaignAndAgent(state, exten);
    const parsedCaller = parseVicidialCallerCode(input.vici_cid || input.caller_code, input.phone);
    const raUser = String(input.agent_user || remoteAgentUser);

    const viciClient = new VicidialApiClient(effectiveVici);
    const leadPromise = viciClient.fetchLeadInfo({
      leadId: parsedCaller.leadId,
      phone: parsedCaller.phone,
      campaignId: campaign?.viciCampaign,
    });

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
    await this.startAudioSocketServer();
    await this.startSipRtpServer();
  }

  public async stop(): Promise<void> {
    for (const closer of this.activeSessionClosers.values()) {
      try {
        closer('bridge_shutdown');
      } catch {}
    }
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
      }, 20);

      const hooks: TransportHooks = {
        enqueueBotPcm8k: (pcm8kLe: Buffer) => {
          if (socketClosed || pcm8kLe.length === 0) return;
          txPcmQueue = txPcmQueue.length > 0 ? Buffer.concat([txPcmQueue, pcm8kLe]) : Buffer.from(pcm8kLe);
        },
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
      const tryListen = (candidatePort: number, candidateHost: string, retriesLeft: number) => {
        const onErr = (err: NodeJS.ErrnoException) => {
          this.tcpServer!.removeListener('error', onErr);
          if (err.code === 'EADDRINUSE' && retriesLeft > 0 && candidatePort !== 0) {
            const nextPort = candidatePort + 1;
            console.warn(
              `[ViciBridge] AudioSocket TCP port ${candidatePort} occupied (EADDRINUSE) — trying ${nextPort}...`
            );
            tryListen(nextPort, candidateHost, retriesLeft - 1);
            return;
          }
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
      tryListen(this.audioSocketPort, this.host, 100);
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
      const raw = msgBuf.toString('utf8');
      const { startLine, headers, body } = parseSipMessage(raw);
      if (!startLine || startLine.startsWith('SIP/2.0')) return;

      const [methodRaw, requestUri] = startLine.split(/\s+/);
      const method = (methodRaw || '').toUpperCase();
      const callId = firstHeader(headers, 'call-id', 'i');
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

        // Parse dialed extension from Request-URI: sip:88001@115.186.137.240:5062
        const uriMatch = /sip:([^@;>\s]+)/i.exec(requestUri || '');
        const exten = firstHeader(headers, 'x-vici-exten') || (uriMatch ? uriMatch[1] : '');

        // Campaign maxCalls concurrency guard
        const curStateForCap = getConsoleState();
        const resolvedForCap = resolveCampaignAndAgent(curStateForCap, exten);
        if (this.isCampaignOverCapacity(resolvedForCap.campaign)) {
          this.stats.rejectedOverCapacityCount += 1;
          this.stats.lastError = `Campaign "${resolvedForCap.campaign?.name}" at maxCalls capacity (${resolvedForCap.campaign?.maxCalls})`;
          sendSipResponse('486 Busy Here', headers, toRaw, [], '', rinfo);
          return;
        }

        // Parse From header: "V1027153012000104892" <sip:3055550192@115.186.137.240>;tag=as123
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
        const remoteRtpIp = cMatch ? cMatch[1].trim() : rinfo.address;
        const remoteRtpPort = mMatch ? Number(mMatch[1]) : 0;

        if (!remoteRtpPort) {
          sendSipResponse('488 Not Acceptable Here', headers, toRaw, [], '', rinfo);
          return;
        }

        // Bind dedicated UDP RTP socket for this call
        const rtpSocket = dgram.createSocket('udp4');
        await new Promise<void>((r) => rtpSocket.bind(0, this.host, () => r()));
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

        // Pre-register call metadata & start RTP <-> Deepgram session
        const preReg = this.registerPreCall({
          uniqueid: xUniqueId || callId,
          vici_cid: callerName,
          phone: callerNum,
          exten,
          channel: xChannel,
        });
        const preRecord = this.preCallRegistry.get(preReg.uuid);
        if (preRecord) this.preCallRegistry.delete(preReg.uuid);

        let rtpClosed = false;
        let txPcmQueue = Buffer.alloc(0);
        let rtpSeq = crypto.randomInt(1, 30000);
        let rtpTimestamp = crypto.randomInt(1000, 100000);
        const rtpSsrc = crypto.randomBytes(4).readUInt32BE(0);
        let nextTalkspurtMarker = true;

        const rtpPacer = setInterval(() => {
          if (rtpClosed) return;
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

        rtpSocket.on('message', (pktBuf) => {
          if (rtpClosed) return;
          const parsed = parseRtpPacket(pktBuf);
          if (!parsed) return;
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
    });

    await new Promise<void>((resolve, reject) => {
      const tryBind = (candidatePort: number, candidateHost: string, retriesLeft: number) => {
        const onErr = (err: NodeJS.ErrnoException) => {
          sock.removeListener('error', onErr);
          if (err.code === 'EADDRINUSE' && retriesLeft > 0 && candidatePort !== 0) {
            const nextPort = candidatePort + 1;
            console.warn(`[ViciBridge] SIP UDP port ${candidatePort} occupied (EADDRINUSE) — trying ${nextPort}...`);
            tryBind(nextPort, candidateHost, retriesLeft - 1);
            return;
          }
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
      tryBind(this.sipPort, this.host, 100);
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

    const exten = opts.preCall?.exten || `${state.vici.aiExten}1`;
    const resolved = resolveCampaignAndAgent(state, exten);
    const campaign = opts.preCall?.campaign || resolved.campaign;
    const agent = opts.preCall?.agent || resolved.agent;
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

    let lastCallerAudioAt = Date.now();
    let turns = 0;
    let lastUserTurnTs: number | null = null;
    let awaitingFirstAudioForTurn = false;
    const ttfbSamples: number[] = [];

    let disposition: string | null = null;
    let transferredTo: string | null = null;
    let dncAdded = false;
    let transferExecuted = false;
    let pendingTransferArgs: {
      reason: string;
      prospect_name?: string;
      confirmed_age?: string;
      medicare_status?: string;
      hook_type?: string;
    } | null = null;
    let awaitingHangupAfterSpeech = false;

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
      transport: opts.transport,
      exten,
      callerCode: parsedCaller.callerCode,
      leadId: parsedCaller.leadId,
      phone: parsedCaller.phone,
      campaignName: campaign?.name || 'Default',
      viciCampaign: campaign?.viciCampaign || '',
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
        const fallbackCodeMatch = /dispo\s+([A-Z0-9_]{2,6})/i.exec(campaign?.fallback || '');
        const fbCode = fallbackCodeMatch ? fallbackCodeMatch[1].toUpperCase() : 'CALLBK';
        disposition = fbCode;
        await viciClient.updateLeadDisposition({
          leadId: summary.leadId,
          phone: summary.phone,
          status: fbCode,
          notes: `Transfer fallback (${detail}) — AI qualified: ${args.reason}`,
        });
        addTranscript('system', `Transfer failed (${detail}); applied fallback disposition ${fbCode}`);
      }

      updateState('transferred');
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

      if (dgWs && (dgWs.readyState === WebSocket.OPEN || dgWs.readyState === WebSocket.CONNECTING)) {
        try {
          dgWs.close(1000, reason);
        } catch {}
      }

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

      opts.hooks.hangupTransport();

      this.activeCalls.delete(callId);
      this.activeSessionClosers.delete(callId);
      this.activeSessionTransferrers.delete(callId);

      const savedRec = recorder.finalizeAndSave(callId);

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
      } catch {}

      this.broadcastMonitor({
        type: 'call_ended',
        callId,
        reason,
        cdr,
        status: this.getStatus(),
      });
    };

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

      selectedGreeting = trySelectGreeting(agent.id, agent.randomGreetingEnabled !== false);
      if (selectedGreeting) {
        addTranscript('system', `Selected greeting #${selectedGreeting.greeting_id} (${selectedGreeting.persona}; ${selectedGreeting.context}; ${selectedGreeting.tone}).`);
      } else if (agent.randomGreetingEnabled !== false) {
        addTranscript('system', 'Greeting library unavailable; using the configured opening.');
      }

      const rawSettings = buildDeepgramSettings(state, agent, campaign, {
        forceClientSideWebhooks: true,
        greetingText: selectedGreeting?.greeting_text,
      });
      // Telephony is strictly 8000 Hz linear16 mono in & out
      rawSettings.audio = {
        input: { encoding: 'linear16', sample_rate: 8000 },
        output: { encoding: 'linear16', sample_rate: 8000, container: 'none' },
      };
      hydrateRealLeadIntoSettings(rawSettings, agent, campaign, hydratedLead);
      const wireSettings = interpolateEnvPlaceholders(rawSettings);

      updateState('connecting_deepgram');
      dgWs = new WebSocket(targetUrl, {
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

      dgWs.on('message', async (raw, isBinary) => {
        if (closed) return;

        if (isBinary) {
          if (suppressStaleBotAudio) {
            return;
          }
          const pcm8k = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
          if (awaitingFirstAudioForTurn && lastUserTurnTs !== null) {
            ttfbSamples.push(Math.max(1, Date.now() - lastUserTurnTs));
            awaitingFirstAudioForTurn = false;
          }
          recorder.recordBotPcm8k(pcm8k);
          opts.hooks.enqueueBotPcm8k(pcm8k);
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
            settingsApplied = true;
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
            if (agent.behavior?.bargeIn !== 'off') {
              // Instant <20ms barge-in flush on Asterisk AudioSocket / RTP queue + gate trailing TTS chunks!
              suppressStaleBotAudio = true;
              recorder.onBargeIn();
              opts.hooks.bargeInFlush();
              updateState('caller_speaking');
            }
            break;
          }

          case 'ConversationText': {
            const role = evt.role === 'user' ? 'user' : 'assistant';
            if (role === 'user') {
              turns += 1;
              lastUserTurnTs = Date.now();
              awaitingFirstAudioForTurn = true;
            }
            suppressStaleBotAudio = false;
            addTranscript(role, String(evt.content || ''));
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
            updateState('listening');
            if (pendingTransferArgs) {
              const args = pendingTransferArgs;
              pendingTransferArgs = null;
              await executeTransferAction(args);
            } else if (awaitingHangupAfterSpeech) {
              await finalizeSession('bot_end_call');
            }
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

              let resultPayload: Record<string, any> = { ok: true };

              if (fnItem.name === 'set_disposition') {
                const code = String(args.code || 'CALLBK').trim().toUpperCase();
                disposition = code;

                const upd = await viciClient.updateLeadDisposition({
                  leadId: summary.leadId,
                  phone: summary.phone,
                  status: code,
                  notes: args.notes || '',
                });

                let dncInfo: any = null;
                if ((code === 'DNC' || code === 'DNCL') && campaign?.dnc !== false && summary.phone) {
                  dncInfo = await viciClient.addDncPhone({
                    phone: summary.phone,
                    campaignId: campaign?.viciCampaign,
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
              } else if (fnItem.name === 'transfer_to_live_agent') {
                if (!disposition) disposition = 'XFER';
                const reason = String(args.reason || 'Qualified & interested lead');
                const metaParts = [
                  args.prospect_name ? `Name:${args.prospect_name}` : hydratedLead.first_name ? `Name:${hydratedLead.first_name}` : '',
                  args.confirmed_age ? `Age:${args.confirmed_age}` : '',
                  args.medicare_status ? `Medicare:${args.medicare_status}` : '',
                  args.hook_type ? `Hook:${args.hook_type}` : '',
                ].filter(Boolean);
                const noteSummary = `[AI Qualified${metaParts.length ? ' | ' + metaParts.join(' | ') : ''}] ${reason}`;

                // Push structured metadata into vicidial_list BEFORE transfer so closer screen-pop shows Name, Age, Medicare Status & Hook Type!
                await viciClient.updateLeadDisposition({
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

                resultPayload = {
                  ok: true,
                  transfer_scheduled: `${campaign?.xferType || 'ingroup'}:${campaign?.xferTarget || 'DEFAULTINGROUP'}`,
                  closer_screen_pop_notes_saved: true,
                  metadata_passed: {
                    prospect_name: args.prospect_name || hydratedLead.first_name || null,
                    confirmed_age: args.confirmed_age || null,
                    medicare_status: args.medicare_status || null,
                    hook_type: args.hook_type || null,
                  },
                };
              } else if (fnItem.name === 'end_call') {
                awaitingHangupAfterSpeech = true;
                if (deferredActionTimer) clearTimeout(deferredActionTimer);
                deferredActionTimer = setTimeout(() => {
                  finalizeSession('bot_end_call').catch(() => {});
                }, 9000);
                resultPayload = { ok: true, action: 'hangup_after_speech' };
              } else {
                const fnConfig = state.functions.find((f) => f.name === fnItem.name);
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

              functionCalls.push({
                ts: new Date().toISOString(),
                id: fnItem.id,
                name: fnItem.name,
                args,
                status: 'completed',
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
    })();

    return {
      onCallerPcm8k: (pcm8k: Buffer) => {
        if (closed || pcm8k.length === 0) return;
        lastCallerAudioAt = Date.now();
        recorder.recordCallerPcm8k(pcm8k);
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
