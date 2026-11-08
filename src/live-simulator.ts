import http from 'http';
import { getAuthenticatedUser, isRequestAuthorized } from './auth-guard';
import crypto from 'crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { getConsoleState, saveSimulatorCallLog, SimulatorCallLogRecord, trySelectGreeting } from './db';
import { GreetingRecord } from './greetings';
import { createOpeningGate, OpeningGate, prepareDelayedOpening } from './opening';
import { normalizeState } from './defaults';
import { getSecret, MANAGED_SECRET_KEYS } from './env-store';
import { allowedCampaignDispositionCodes, buildDeepgramSettings, getCampaignCallReadinessBlockers } from './settings-builder';
import { Agent, Campaign, ConsoleState } from './types';
import { executeCustomFunctionWebhook } from './webhook-executor';

export interface SimulatedLeadContext {
  lead_id?: string;
  first_name?: string;
  phone_number?: string;
  state?: string;
  age?: string;
}

export interface SimulatorStartMessage {
  type: 'start';
  upstreamMode?: 'deepgram' | 'sandbox' | 'speech_service';
  agentId: string;
  campaignId: string;
  bandwidth?: 'wideband' | 'telephony';
  lead?: SimulatedLeadContext;
  draftState?: unknown;
  // Both are off by default and apply only to this browser test.
  allowWebhooks?: boolean;
  recordAudio?: boolean;
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
      return ''; // unknown environment variables are not provider secrets
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

function hydrateLeadIntoPromptAndGreeting(
  settings: any,
  agent: Agent,
  campaign: Campaign | undefined,
  lead: SimulatedLeadContext
): { hydrated: boolean; leadSummary: Record<string, string> } {
  const cleanLead: Record<string, string> = {
    lead_id: String(lead?.lead_id || '').trim(),
    first_name: String(lead?.first_name || '').trim(),
    phone_number: String(lead?.phone_number || '').trim(),
    state: String(lead?.state || '').trim(),
    age: String(lead?.age || '').trim(),
    campaign_id: String(campaign?.viciCampaign || '').trim(),
  };

  if (!agent.acceptViciCalls) {
    return { hydrated: false, leadSummary: cleanLead };
  }

  const replaceVars = (txt: string) =>
    txt.replace(/\{\{\s*(lead_id|first_name|phone_number|state|age|campaign_id)\s*\}\}/gi, (_m, key) => {
      const k = String(key).toLowerCase();
      return cleanLead[k] ?? '';
    });

  settings.agent.greeting = replaceVars(settings.agent.greeting || '');
  const basePrompt = replaceVars(settings.agent.think.prompt || '');
  const contextFooter =
    `\n\n[Browser Test Lead Context — supplied for this test, not a live VICIdial call]\n` +
    `- lead_id: ${cleanLead.lead_id}\n` +
    `- caller_first_name: ${cleanLead.first_name}\n` +
    `- phone_number: ${cleanLead.phone_number}\n` +
    `- state: ${cleanLead.state}\n` +
    `- listed_age: ${cleanLead.age}\n` +
    `- vici_campaign: ${cleanLead.campaign_id}` +
    (campaign?.xferTarget ? `\n- live_closer_target: ${campaign.xferType} "${campaign.xferTarget}"` : '');

  settings.agent.think.prompt = basePrompt + contextFooter;
  return { hydrated: true, leadSummary: cleanLead };
}

export function attachLiveSimulator(server?: http.Server, noServer = false): WebSocketServer {
  const wss = noServer
    ? new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024, perMessageDeflate: false })
    : new WebSocketServer({ server, path: '/ws/simulator', maxPayload: 4 * 1024 * 1024, perMessageDeflate: false });

  wss.on('connection', (clientWs: WebSocket, req: http.IncomingMessage) => {
    if (getAuthenticatedUser(req)?.role === 'viewer') { clientWs.close(1008, 'Read-only account'); return; }
    if (wss.clients.size > 64) { clientWs.close(1013, 'Simulator capacity reached'); return; }
    const callId = `sim_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
    const startedAtIso = new Date().toISOString();
    const startedAtMs = Date.now();

    let started = false;
    let closed = false;
    let settingsApplied = false;
    let upstreamMode: 'deepgram' | 'sandbox' | 'speech_service' = 'deepgram';
    let dgWs: WebSocket | null = null;
    let keepAliveTimer: NodeJS.Timeout | null = null;
    let comfortSilenceTimer: NodeJS.Timeout | null = null;
    let pendingEndTimer: NodeJS.Timeout | null = null;
    let connectTimer: NodeJS.Timeout | null = null;
    let openingGate: OpeningGate | null = null;
    let heartbeatTimer: NodeJS.Timeout | null = null;
    let startTimer: NodeJS.Timeout | null = null;
    let alive = true;
    let messageWindow = Date.now();
    let messageCount = 0;
    let preSettingsBytes = 0;
    clientWs.on('pong', () => { alive = true; });
    startTimer = setTimeout(() => { if (!started && !closed) { sendFatalError('START_TIMEOUT', 'No call start message was received.'); finalizeCall('start_timeout'); } }, 15000);
    heartbeatTimer = setInterval(() => {
      if (!isRequestAuthorized(req)) {
        finalizeCall('session_revoked'); return;
      }
      if (!alive) { clientWs.terminate(); return; }
      alive = false;
      if (clientWs.readyState === WebSocket.OPEN) clientWs.ping();
    }, 30000);

    let activeState: ConsoleState | null = null;
    let persistedFunctions: ConsoleState['functions'] = [];
    let activeAgent: Agent | null = null;
    let activeCampaign: Campaign | undefined;
    let selectedGreeting: GreetingRecord | null = null;
    let testLead: Record<string, string> = {};
    let allowWebhooks = false;
    let recordingRequested = false;
    let sampleRateIn = 16000;
    let sampleRateOut = 24000;

    let turns = 0;
    let txAudioBytes = 0;
    let rxAudioBytes = 0;
    let lastBrowserAudioAt = 0;
    let lastUserTurnTs: number | null = null;
    let lastThinkingTs: number | null = null;
    let awaitingFirstAudioForTurn = false;
    const ttfbSamples: number[] = [];

    let detectedDisposition: string | null = null;
    let transferredTo: string | null = null;
    let awaitingHangupAudioDone = false;
    let pendingEndFunctionId: string | null = null;
    let fatalErrorMessage: string | null = null;
    let suppressStaleAgentAudio = false;

    const cancelledFnIds = new Set<string>();
    const activeFunctionAborts = new Map<string, AbortController>();
    const pendingPreSettingsAudio: Buffer[] = [];
    const pendingInjectedMessages: string[] = [];

    const transcript: SimulatorCallLogRecord['transcript'] = [];
    const functionCalls: SimulatorCallLogRecord['functionCalls'] = [];

    const sendClientJson = (payload: Record<string, any>) => {
      if (clientWs.bufferedAmount > 8 * 1024 * 1024) { clientWs.close(1013, 'Client is not consuming events'); return; }
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify(payload));
      }
    };

    const sendFatalError = (code: string, error: string) => {
      fatalErrorMessage = `${code}: ${error}`;
      sendClientJson({
        type: 'error',
        code,
        error,
      });
    };

    const sendClientAudio = (pcmChunk: Buffer) => {
      if (clientWs.bufferedAmount > 8 * 1024 * 1024) { clientWs.close(1013, 'Client is not consuming audio'); return; }
      if (clientWs.readyState === WebSocket.OPEN) {
        rxAudioBytes += pcmChunk.length;
        if (awaitingFirstAudioForTurn && lastUserTurnTs !== null) {
          const ttfbMs = Math.max(1, Date.now() - lastUserTurnTs);
          const llmMs = lastThinkingTs !== null ? Math.max(1, lastThinkingTs - lastUserTurnTs) : null;
          ttfbSamples.push(ttfbMs);
          awaitingFirstAudioForTurn = false;
          const avgTtfbMs = Math.round(ttfbSamples.reduce((a, b) => a + b, 0) / ttfbSamples.length);
          sendClientJson({
            type: 'latency',
            turn: turns,
            ttfbMs,
            llmMs,
            avgTtfbMs,
          });
        }
        clientWs.send(pcmChunk, { binary: true });
      }
    };

    const recordTranscript = (role: 'user' | 'assistant' | 'system', content: string, extra: Record<string, any> = {}) => {
      const ts = new Date().toISOString();
      if (transcript.length >= 2000) transcript.shift();
      transcript.push({ ts, role, content: content.slice(0, 16000) });
      sendClientJson({
        type: 'transcript',
        ts,
        role,
        content,
        ...extra,
      });
    };

    const executeClientFunction = async (fnReq: {
      id: string;
      name: string;
      arguments?: string;
      client_side?: boolean;
      thought_signature?: string;
    }) => {
      if (cancelledFnIds.has(fnReq.id)) {
        return;
      }

      let parsedArgs: Record<string, any> = {};
      try {
        parsedArgs = fnReq.arguments ? JSON.parse(fnReq.arguments) : {};
      } catch {
        parsedArgs = { _raw: fnReq.arguments || '' };
      }

      if (fnReq.client_side === false) {
        const entry = {
          ts: new Date().toISOString(),
          id: fnReq.id,
          name: fnReq.name,
          args: parsedArgs,
          status: 'server_side' as const,
        };
        functionCalls.push(entry);
        sendClientJson({ type: 'function_call', ...entry });
        return;
      }

      // Drafts may change prompts, but executable webhook destinations/headers
      // must come from persisted configuration reviewed by an administrator.
      const fnConfig = persistedFunctions.find((f) => f.name === fnReq.name);
      const enabled = Boolean(fnConfig && activeAgent?.fnIds.includes(fnConfig.id));
      let resultPayload: Record<string, any>;

      if (!enabled) {
        resultPayload = { ok: false, error: 'Function is not enabled for this agent.' };
      } else if (fnReq.name === 'set_disposition') {
        const requestedCode = String(parsedArgs.code || '').trim().toUpperCase();
        const allowedCodes = allowedCampaignDispositionCodes(activeCampaign);
        resultPayload = !allowedCodes.includes(requestedCode)
          ? { ok: false, error: `Disposition ${requestedCode || '(empty)'} is not allowed by the selected campaign.` }
          : {
              ok: false,
              simulated: true,
              requested_code: requestedCode,
              error: 'Browser tests are not VICIdial calls. No disposition or do-not-call record was changed.',
            };
      } else if (fnReq.name === 'transfer_to_live_agent') {
        const allowedCodes = allowedCampaignDispositionCodes(activeCampaign);
        resultPayload = !allowedCodes.includes('XFER')
          ? { ok: false, error: 'XFER is not allowed by the explicitly selected campaign. No transfer was simulated.' }
          : {
              ok: false,
              simulated: true,
              requested_target: activeCampaign ? `${activeCampaign.xferType}:${activeCampaign.xferTarget}` : null,
              error: 'Browser tests cannot transfer a real call. No VICIdial or PBX transfer was made.',
            };
      } else if (fnReq.name === 'end_call') {
        awaitingHangupAudioDone = true;
        pendingEndFunctionId = fnReq.id;
        resultPayload = { ok: true, action: 'end_browser_test_after_speech' };
        if (pendingEndTimer) clearTimeout(pendingEndTimer);
        pendingEndTimer = setTimeout(() => finalizeCall('bot_end_call'), 9000);
      } else if (!fnConfig?.url?.trim()) {
        resultPayload = { ok: false, error: 'No webhook URL is configured for this function.' };
      } else if (!allowWebhooks) {
        resultPayload = { ok: false, error: 'Real webhooks are disabled for this browser test.' };
      } else {
        const controller = new AbortController();
        activeFunctionAborts.set(fnReq.id, controller);
        const whRes = await executeCustomFunctionWebhook(fnConfig, parsedArgs, {
          callId,
          leadId: testLead.lead_id || null,
          phone: testLead.phone_number || '',
          campaignId: activeCampaign?.id || null,
          viciCampaign: activeCampaign?.viciCampaign || null,
          lead: testLead,
        }, 6000, controller.signal);
        activeFunctionAborts.delete(fnReq.id);
        // A cancelled/closed session must not send a late success to the model.
        if (cancelledFnIds.has(fnReq.id) || closed) return;
        const responseRejected = whRes.data && typeof whRes.data === 'object' && whRes.data.ok === false;
        resultPayload = {
          ok: whRes.ok && !responseRejected,
          executed_by: 'node_webhook_executor',
          http_status: whRes.httpStatus,
          latency_ms: whRes.latencyMs,
          result: whRes.data ?? null,
          ...(whRes.error ? { error: whRes.error } : {}),
        };
      }

      const entry = {
        ts: new Date().toISOString(),
        id: fnReq.id,
        name: fnReq.name,
        args: parsedArgs,
        status: resultPayload.simulated ? 'simulated' as const : resultPayload.ok ? 'completed' as const : 'failed' as const,
        response: resultPayload,
      };
      functionCalls.push(entry);

      sendClientJson({
        type: 'function_call',
        ...entry,
        disposition: detectedDisposition,
        transferredTo,
      });

      if (dgWs && dgWs.readyState === WebSocket.OPEN) {
        const fnResp: Record<string, any> = {
          type: 'FunctionCallResponse',
          id: fnReq.id,
          name: fnReq.name,
          content: JSON.stringify(resultPayload),
        };
        if (fnReq.thought_signature) {
          fnResp.thought_signature = fnReq.thought_signature;
        }
        dgWs.send(JSON.stringify(fnResp));
      }
    };

    let finalized = false;
    const finalizeCall = (reason = 'client_hangup') => {
      if (finalized) return;
      finalized = true;
      closed = true;

      if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
      }
      if (comfortSilenceTimer) {
        clearInterval(comfortSilenceTimer);
        comfortSilenceTimer = null;
      }
      if (pendingEndTimer) {
        clearTimeout(pendingEndTimer);
        pendingEndTimer = null;
      }
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      if (startTimer) { clearTimeout(startTimer); startTimer = null; }
      openingGate?.cancel();
      openingGate = null;
      for (const controller of activeFunctionAborts.values()) controller.abort();
      activeFunctionAborts.clear();

      if (dgWs && (dgWs.readyState === WebSocket.OPEN || dgWs.readyState === WebSocket.CONNECTING)) {
        try {
          dgWs.close(1000, 'Call ended');
        } catch {}
      }
      const endedAtIso = new Date().toISOString();
      const durationMs = Math.max(1, Date.now() - startedAtMs);
      const avgTtfbMs = ttfbSamples.length
        ? Math.round(ttfbSamples.reduce((a, b) => a + b, 0) / ttfbSamples.length)
        : null;

      // Only provider-confirmed sessions count as test calls. A call-ended
      // event must not imply persistence when the database write failed.
      let logSaved: boolean | null = null;
      if (settingsApplied && activeAgent) {
        try {
          saveSimulatorCallLog({
            id: callId,
            agentId: activeAgent.id,
            agentName: activeAgent.name,
            campaignId: activeCampaign?.id || null,
            greetingId: selectedGreeting?.greeting_id || null,
            upstreamMode,
            sampleRateIn,
            sampleRateOut,
            startedAt: startedAtIso,
            endedAt: endedAtIso,
            durationMs,
            turns,
            avgTtfbMs,
            disposition: detectedDisposition,
            transferredTo,
            recordingRequested,
            recordingStatus: recordingRequested ? 'pending' : 'not_requested',
            transcript,
            functionCalls,
          });
          logSaved = true;
        } catch {
          logSaved = false;
          sendClientJson({ type: 'warning', message: 'The browser test ended, but its transcript could not be saved to test history.' });
        }
      }

      sendClientJson({
        type: 'call_ended',
        greetingId: selectedGreeting?.greeting_id || null,
        callId,
        logSaved,
        reason,
        fatalError: fatalErrorMessage,
        durationMs,
        turns,
        avgTtfbMs,
        txAudioBytes,
        rxAudioBytes,
        disposition: detectedDisposition,
        transferredTo,
      });

      if (clientWs.readyState === WebSocket.OPEN) {
        try {
          clientWs.close(1000, reason);
        } catch {}
      }
    };

    clientWs.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (closed) return;
      const nowMs = Date.now();
      if (nowMs - messageWindow >= 1000) { messageWindow = nowMs; messageCount = 0; }
      if (++messageCount > 200) { sendFatalError('MESSAGE_RATE_LIMIT', 'Too many simulator messages.'); finalizeCall('message_rate_limit'); return; }

      if (isBinary) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        txAudioBytes += buf.length;
        lastBrowserAudioAt = Date.now();

        if (!settingsApplied) {
          if (pendingPreSettingsAudio.length < 25 && preSettingsBytes + buf.length <= 1024 * 1024) {
            preSettingsBytes += buf.length;
            pendingPreSettingsAudio.push(buf);
          }
          return;
        }
        if (dgWs && dgWs.readyState === WebSocket.OPEN) {
          dgWs.send(buf, { binary: true });
        }
        return;
      }

      let msg: any;
      try {
        msg = JSON.parse(data.toString());
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) throw new Error('Expected object');
      } catch {
        sendFatalError('BAD_CLIENT_JSON', 'Invalid JSON message sent to /ws/simulator');
        return;
      }

      if (msg.type === 'stop') {
        finalizeCall('user_hangup');
        return;
      }

      if (msg.type === 'client_barge_in') {
        openingGate?.userStarted();
        if (activeAgent?.behavior?.bargeIn !== 'off') {
          suppressStaleAgentAudio = true;
          sendClientJson({ type: 'barge_in', source: 'client_vad' });
          sendClientJson({ type: 'agent_state', state: 'user_speaking' });
        }
        return;
      }

      if (msg.type === 'inject_agent_message') {
        const content = String(msg.content || '').trim().slice(0, 8000);
        if (!content) return;
        suppressStaleAgentAudio = false;
        if (dgWs && dgWs.readyState === WebSocket.OPEN && settingsApplied) {
          openingGate?.agentTurn();
          dgWs.send(JSON.stringify({ type: 'InjectAgentMessage', message: content }));
        }
        return;
      }

      if (msg.type === 'inject_user_message') {
        const content = String(msg.content || '').trim().slice(0, 8000);
        if (!content) return;
        suppressStaleAgentAudio = false;

        const injectPayload = JSON.stringify({ type: 'InjectUserMessage', content });
        if (!settingsApplied) {
          if (pendingInjectedMessages.length < 32) pendingInjectedMessages.push(injectPayload);
        } else if (dgWs && dgWs.readyState === WebSocket.OPEN) {
          openingGate?.userTurn();
          lastUserTurnTs = Date.now();
          awaitingFirstAudioForTurn = true;
          dgWs.send(injectPayload);
        }
        return;
      }

      if (msg.type === 'start' && !started) {
        started = true;
        if (startTimer) { clearTimeout(startTimer); startTimer = null; }
        const startMsg = msg as SimulatorStartMessage;
        allowWebhooks = startMsg.allowWebhooks === true;
        recordingRequested = startMsg.recordAudio === true;
        const persistedState = getConsoleState();
        persistedFunctions = persistedState.functions;
        activeState = startMsg.draftState ? normalizeState(startMsg.draftState) : persistedState;
        // Live calls always use saved global provider/model pairs and provider connection settings,
        // never unsaved draft overrides. Agent prompt/behavior drafts remain testable in the simulator.
        activeState.services = persistedState.services;
        for (const kind of ['stt', 'llm', 'tts'] as const) {
          const selection = persistedState.services[kind];
          const savedProvider = persistedState.providers.find((p) => p.kind === kind && p.id === selection.providerId);
          if (!savedProvider) continue;
          const providerIndex = activeState.providers.findIndex((p) => p.id === savedProvider.id);
          if (providerIndex >= 0) activeState.providers[providerIndex] = savedProvider;
          else activeState.providers.push(savedProvider);
        }
        const requestedAgent = activeState.agents.find((a) => a.id === startMsg.agentId);
        if (!requestedAgent) {
          sendFatalError('INVALID_AGENT', 'The selected bot agent no longer exists. Refresh the console and select a valid agent.');
          finalizeCall('invalid_agent');
          return;
        }
        activeAgent = requestedAgent;
        if (!startMsg.campaignId) {
          sendFatalError('CAMPAIGN_REQUIRED', 'Choose a campaign explicitly before starting a browser call.');
          finalizeCall('campaign_required');
          return;
        }
        const requestedCampaign = activeState.campaigns.find((c) => c.id === startMsg.campaignId);
        if (!requestedCampaign || requestedCampaign.agentId !== requestedAgent.id) {
          sendFatalError('CAMPAIGN_ASSIGNMENT_MISMATCH', 'The selected campaign is not assigned to this bot. Assign it in Campaigns and retry.');
          finalizeCall('campaign_assignment_mismatch');
          return;
        }
        const campaignBlockers = getCampaignCallReadinessBlockers(activeState, requestedCampaign);
        if (campaignBlockers.length) {
          sendFatalError('CAMPAIGN_NOT_READY', `Campaign “${requestedCampaign.name}” is not ready: ${campaignBlockers.join('; ')}.`);
          finalizeCall('campaign_not_ready');
          return;
        }
        activeCampaign = requestedCampaign;

        const sessionState = activeState;
        const missingGlobalServices = (['stt', 'llm', 'tts'] as const).filter((kind) => {
          const selected = sessionState?.services?.[kind];
          return !sessionState?.providers.some((p) => p.kind === kind && p.id === selected?.providerId) || !String(selected?.model || '').trim();
        });
        if (missingGlobalServices.length > 0) {
          sendFatalError(
            'GLOBAL_SERVICES_UNCONFIGURED',
            `Select and save one global provider/model for ${missingGlobalServices.join(', ')} on the Plug-Ins page before starting a session.`
          );
          clientWs.close(1008, 'Global service selections are required');
          return;
        }

        const bandwidth = startMsg.bandwidth === 'telephony' ? 'telephony' : 'wideband';
        sampleRateIn = bandwidth === 'telephony' ? 8000 : 16000;
        sampleRateOut = bandwidth === 'telephony' ? 8000 : 24000;

        const activeSttProv = activeState.providers.find(
          (p) => p.kind === 'stt' && p.id === activeState!.services?.stt?.providerId
        );
        const activeTtsProv = activeState.providers.find(
          (p) => p.kind === 'tts' && p.id === activeState!.services?.tts?.providerId
        );
        const usesLocalSpeechService =
          activeSttProv?.type === 'speech_service' || activeTtsProv?.type === 'speech_service';

        const requestedMode =
          startMsg.upstreamMode || (usesLocalSpeechService ? 'speech_service' : 'deepgram');
        const customAgentUrl = (process.env.DEEPGRAM_AGENT_URL || '').trim();
        const dgApiKey = getSecret('DEEPGRAM_API_KEY');

        if (requestedMode === 'sandbox') {
          sendFatalError('SANDBOX_UNAVAILABLE', 'Scripted sandbox replies and tone audio have been removed. Configure Deepgram for a real browser test.');
          finalizeCall('unsupported_mode');
          return;
        }
        if (requestedMode === 'speech_service' || usesLocalSpeechService) {
          sendFatalError('LOCAL_SPEECH_AGENT_UNAVAILABLE', 'Local STT/TTS is not connected to an LLM in Live Bot. Select supported Deepgram Voice Agent providers for a real conversation.');
          finalizeCall('unsupported_mode');
          return;
        }
        if (requestedMode !== 'deepgram') {
          sendFatalError('UNSUPPORTED_MODE', 'Only Deepgram Voice Agent is supported for Live Bot.');
          finalizeCall('unsupported_mode');
          return;
        }
        upstreamMode = 'deepgram';
        if (!dgApiKey && !customAgentUrl) {
          sendFatalError(
            'MISSING_DEEPGRAM_KEY',
            'DEEPGRAM_API_KEY is not configured on the server. Click "🔑 API Keys" in the top bar and save your Deepgram API key.'
          );
          finalizeCall('missing_api_key');
          return;
        }

        selectedGreeting = trySelectGreeting(activeAgent.id, activeAgent.randomGreetingEnabled !== false, activeAgent.greeting);
        if (activeAgent.randomGreetingEnabled !== false && !selectedGreeting) {
          sendClientJson({ type: 'warning', code: 'GREETING_LIBRARY_UNAVAILABLE',
            message: 'The greeting library is unavailable; this test will use the configured opening.' });
        }

        const displaySettings = buildDeepgramSettings(activeState, activeAgent, activeCampaign, { greetingText: selectedGreeting?.greeting_text });
        const rawSettings = buildDeepgramSettings(activeState, activeAgent, activeCampaign, {
          forceClientSideWebhooks: true,
          greetingText: selectedGreeting?.greeting_text,
        });
        rawSettings.audio = {
          input: { encoding: 'linear16', sample_rate: sampleRateIn },
          output: { encoding: 'linear16', sample_rate: sampleRateOut, container: 'none' },
        };
        displaySettings.audio = JSON.parse(JSON.stringify(rawSettings.audio));

        const hydration = hydrateLeadIntoPromptAndGreeting(
          rawSettings,
          activeAgent,
          activeCampaign,
          startMsg.lead || {}
        );
        hydrateLeadIntoPromptAndGreeting(
          displaySettings,
          activeAgent,
          activeCampaign,
          startMsg.lead || {}
        );

        testLead = hydration.leadSummary;
        const testConstraints = '\n\n[Browser test constraints] This is not a live VICIdial call. A transfer, disposition or do-not-call update cannot be completed here. Never claim one succeeded when the tool reports it was not executed. Be truthful about being an AI assistant if asked.';
        if (rawSettings.agent.think.prompt.length + testConstraints.length > 25000) {
          sendFatalError('PROMPT_TOO_LONG', 'The agent prompt is too long to add browser-test safety context. Shorten it before starting a test.');
          finalizeCall('prompt_too_long');
          return;
        }
        rawSettings.agent.think.prompt += testConstraints;
        displaySettings.agent.think.prompt += testConstraints;
        // Browser tests never hand a webhook endpoint to Deepgram. If the operator
        // opts in, the authenticated backend executes it only after turn confirmation.
        for (const fn of rawSettings.agent.think.functions || []) fn.defer_until_eot = true;
        let wireSettings: any;
        try {
          const prepared = prepareDelayedOpening(interpolateEnvPlaceholders(rawSettings));
          wireSettings = prepared.settings;
        } catch (err: any) {
          sendFatalError('PROMPT_TOO_LONG', err.message || 'Could not prepare the opening.');
          finalizeCall('prompt_too_long');
          return;
        }
        openingGate = createOpeningGate({
          presenceCheck: activeCampaign?.presenceCheckText || 'Hello? Are you there? Can you hear me?',
          responseTimeoutMs: Math.max(1, Number(activeCampaign?.deadAirTimeoutSec || 8)) * 1000,
          sendPresenceCheck: (message) => {
            if (!closed && dgWs?.readyState === WebSocket.OPEN) {
              dgWs.send(JSON.stringify({ type: 'InjectAgentMessage', message }));
            }
          },
          playAudio: sendClientAudio,
          onDeadAir: () => {
            if (closed) return;
            detectedDisposition = activeCampaign?.deadAirDisposition || null;
            recordTranscript('system', `No caller response to campaign presence check. Simulated dead-air status ${detectedDisposition || '(unset)'}; no VICIdial update was made.`);
            finalizeCall('dead_air');
          },
          onOverflow: () => sendClientJson({ type: 'warning', message: 'Early provider audio exceeded the opening buffer and was dropped.' }),
        });

        const targetUrl = customAgentUrl || 'wss://agent.deepgram.com/v1/agent/converse';
        const wsHeaders: Record<string, string> = {};
        if (dgApiKey) {
          wsHeaders.Authorization = `Token ${dgApiKey}`;
        }

        sendClientJson({
          type: 'session_connecting',
          greeting: selectedGreeting,
          callId,
          targetUrl,
          sampleRateIn,
          sampleRateOut,
          hydratedLead: hydration.hydrated ? hydration.leadSummary : null,
          settings: displaySettings,
        });

        try {
          dgWs = new WebSocket(targetUrl, { headers: wsHeaders, family: 4, maxPayload: 4 * 1024 * 1024, handshakeTimeout: 15000 });
        } catch (err: any) {
          sendFatalError('UPSTREAM_WS_ERROR', `Could not open the Deepgram connection: ${err.message}`);
          finalizeCall('upstream_error');
          return;
        }
        connectTimer = setTimeout(() => {
          if (!settingsApplied && !closed) {
            sendFatalError('UPSTREAM_TIMEOUT', 'Deepgram did not confirm the session settings in time.');
            finalizeCall('upstream_timeout');
          }
        }, 15000);

        dgWs.on('unexpected-response', (_req, res) => {
          let body = '';
          res.on('data', (chunk) => {
            body += chunk.toString();
          });
          res.on('end', () => {
            const dgErr = res.headers['dg-error'] ? ` (${res.headers['dg-error']})` : '';
            const detail = body.trim() ? ` — ${body.trim().slice(0, 220)}` : '';
            sendFatalError(
              `DEEPGRAM_HTTP_${res.statusCode || 400}`,
              `Deepgram rejected WebSocket upgrade with HTTP ${res.statusCode}${dgErr}${detail}. Check your DEEPGRAM_API_KEY and Deepgram project balance/permissions.`
            );
            finalizeCall(`http_${res.statusCode}`);
          });
        });

        dgWs.on('open', () => {
          keepAliveTimer = setInterval(() => {
            if (dgWs && dgWs.readyState === WebSocket.OPEN && settingsApplied) {
              dgWs.send(JSON.stringify({ type: 'KeepAlive' }));
            }
          }, 6000);
        });

        dgWs.on('message', (dgRaw: WebSocket.RawData, dgBinary: boolean) => {
          if (closed) return;

          if (dgBinary) {
            if (suppressStaleAgentAudio) {
              return;
            }
            const audioBuf = Buffer.isBuffer(dgRaw) ? dgRaw : Buffer.from(dgRaw as ArrayBuffer);
            openingGate?.audio(audioBuf);
            return;
          }

          let evt: any;
          try {
            evt = JSON.parse(dgRaw.toString());
          } catch {
            return;
          }

          switch (evt.type) {
            case 'Welcome': {
              sendClientJson({ type: 'dg_welcome', requestId: evt.request_id || null });
              dgWs?.send(JSON.stringify(wireSettings));
              break;
            }

            case 'SettingsApplied': {
              if (settingsApplied) break;
              settingsApplied = true;
              openingGate?.start();
              if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      if (startTimer) { clearTimeout(startTimer); startTimer = null; }
              lastBrowserAudioAt = Date.now();
              sendClientJson({
                type: 'session_started',
                greeting: selectedGreeting,
                callId,
                upstreamMode: 'deepgram',
                sampleRateIn,
                sampleRateOut,
                recordingRequested,
                hydratedLead: hydration.hydrated ? hydration.leadSummary : null,
                settings: displaySettings,
              });
              if (hydration.hydrated) {
                recordTranscript(
                  'system',
                  `Browser test lead context: #${hydration.leadSummary.lead_id} (${hydration.leadSummary.first_name}, ${hydration.leadSummary.state}, age ${hydration.leadSummary.age}). This is not a live VICIdial call.`
                );
              }
              sendClientJson({ type: 'agent_state', state: 'listening' });

              while (pendingPreSettingsAudio.length > 0) {
                const chunk = pendingPreSettingsAudio.shift()!;
                preSettingsBytes -= chunk.length;
                if (dgWs?.readyState === WebSocket.OPEN) dgWs.send(chunk, { binary: true });
              }
              while (pendingInjectedMessages.length > 0) {
                const injected = pendingInjectedMessages.shift()!;
                openingGate?.userTurn();
                lastUserTurnTs = Date.now();
                awaitingFirstAudioForTurn = true;
                if (dgWs?.readyState === WebSocket.OPEN) dgWs.send(injected);
              }

              // Comfort-silence PCM16 streamer: keeps Deepgram Flux/Nova ASR alive when browser mic is muted,
              // blocked by an iframe, or running in Speaker + Text mode!
              const silenceChunk = Buffer.alloc(Math.floor(sampleRateIn * 0.05) * 2, 0);
              comfortSilenceTimer = setInterval(() => {
                if (
                  !closed &&
                  settingsApplied &&
                  dgWs &&
                  dgWs.readyState === WebSocket.OPEN &&
                  Date.now() - lastBrowserAudioAt > 250
                ) {
                  dgWs.send(silenceChunk, { binary: true });
                }
              }, 50);
              break;
            }

            case 'UserStartedSpeaking': {
              openingGate?.userStarted();
              if (activeAgent?.behavior?.bargeIn !== 'off') {
                suppressStaleAgentAudio = true;
                sendClientJson({ type: 'barge_in', source: 'deepgram_server' });
                sendClientJson({ type: 'agent_state', state: 'user_speaking' });
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
                suppressStaleAgentAudio = false;
              } else {
                openingGate?.agentTurn();
                suppressStaleAgentAudio = false;
              }
              recordTranscript(role, String(evt.content || ''), {
                languages: evt.languages,
              });
              break;
            }

            case 'AgentThinking': {
              openingGate?.agentTurn();
              lastThinkingTs = Date.now();
              suppressStaleAgentAudio = false;
              sendClientJson({ type: 'agent_state', state: 'thinking' });
              break;
            }

            case 'AgentStartedSpeaking': {
              openingGate?.agentTurn();
              suppressStaleAgentAudio = false;
              sendClientJson({ type: 'agent_state', state: 'speaking' });
              break;
            }

            case 'AgentAudioDone': {
              openingGate?.agentAudioDone();
              openingGate?.afterRelease(() => {
                if (closed) return;
                sendClientJson({ type: 'agent_state', state: 'listening' });
                if (awaitingHangupAudioDone) finalizeCall('bot_end_call');
              });
              break;
            }

            case 'FunctionCallCancelled': {
              const cancelledId = evt.id || evt.function_call_id;
              if (cancelledId) {
                cancelledFnIds.add(String(cancelledId));
                activeFunctionAborts.get(String(cancelledId))?.abort();
                if (pendingEndFunctionId === String(cancelledId)) {
                  awaitingHangupAudioDone = false;
                  pendingEndFunctionId = null;
                  if (pendingEndTimer) clearTimeout(pendingEndTimer);
                  pendingEndTimer = null;
                }
              }
              const entry = {
                ts: new Date().toISOString(),
                id: String(cancelledId || 'cancelled'),
                name: String(evt.name || 'speculative_call'),
                args: {},
                status: 'cancelled' as const,
              };
              functionCalls.push(entry);
              sendClientJson({ type: 'function_call', ...entry });
              break;
            }

            case 'FunctionCallRequest': {
              const list = Array.isArray(evt.functions) ? evt.functions : [];
              for (const fnItem of list.slice(0, 32)) {
                if (!fnItem || typeof fnItem.id !== 'string' || typeof fnItem.name !== 'string') continue;
                void executeClientFunction(fnItem).catch(() => { if (!closed) { sendFatalError('FUNCTION_ERROR', 'A function could not be executed.'); finalizeCall('function_error'); } });
              }
              break;
            }

            case 'InjectionRefused': {
              sendClientJson({ type: 'warning', code: 'INJECTION_REFUSED', message: evt.description || evt.message || 'Deepgram rejected the injected message.' });
              break;
            }

            case 'Warning': {
              sendClientJson({
                type: 'dg_warning',
                code: evt.code || 'WARNING',
                message: evt.description || evt.message || JSON.stringify(evt),
              });
              break;
            }

            case 'Error': {
              sendFatalError(
                evt.code || 'DEEPGRAM_AGENT_ERROR',
                evt.description || evt.message || JSON.stringify(evt)
              );
              finalizeCall('deepgram_error');
              break;
            }

            default:
              break;
          }
        });

        dgWs.on('error', (err) => {
          if (!fatalErrorMessage) {
            sendFatalError('UPSTREAM_WS_ERROR', `Deepgram WebSocket error: ${err.message}`);
          }
          finalizeCall('upstream_error');
        });

        dgWs.on('close', (code, reasonBuf) => {
          if (!closed) {
            const reasonStr = reasonBuf?.toString() || `Upstream closed (${code})`;
            if (!fatalErrorMessage) sendFatalError('UPSTREAM_CLOSED', `Deepgram connection closed: ${reasonStr}`);
            finalizeCall(reasonStr);
          }
        });
      }
    });

    clientWs.on('close', () => {
      finalizeCall('browser_disconnected');
    });

    clientWs.on('error', () => {
      finalizeCall('browser_ws_error');
    });
  });

  return wss;
}
