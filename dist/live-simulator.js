"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.attachLiveSimulator = attachLiveSimulator;
const auth_guard_1 = require("./auth-guard");
const crypto_1 = __importDefault(require("crypto"));
const ws_1 = __importStar(require("ws"));
const db_1 = require("./db");
const opening_1 = require("./opening");
const defaults_1 = require("./defaults");
const env_store_1 = require("./env-store");
const settings_builder_1 = require("./settings-builder");
const campaign_assignment_1 = require("./campaign-assignment");
const webhook_executor_1 = require("./webhook-executor");
function interpolateEnvPlaceholders(obj) {
    if (typeof obj === 'string') {
        return obj.replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g, (_match, varName) => {
            if (env_store_1.MANAGED_SECRET_KEYS.includes(varName)) {
                return (0, env_store_1.getSecret)(varName) || process.env[varName] || '';
            }
            if (varName === 'ELEVEN_KEY' || varName === 'ELEVEN_LABS_API_KEY')
                return (0, env_store_1.getSecret)('ELEVENLABS_API_KEY');
            if (varName === 'GROQ_KEY')
                return (0, env_store_1.getSecret)('GROQ_API_KEY');
            if (varName === 'CARTESIA_KEY')
                return (0, env_store_1.getSecret)('CARTESIA_API_KEY');
            return ''; // unknown environment variables are not provider secrets
        });
    }
    if (Array.isArray(obj))
        return obj.map(interpolateEnvPlaceholders);
    if (obj && typeof obj === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(obj)) {
            out[k] = interpolateEnvPlaceholders(v);
        }
        return out;
    }
    return obj;
}
function hydrateLeadIntoPromptAndGreeting(settings, agent, campaign, lead) {
    const cleanLead = {
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
    const replaceVars = (txt) => txt.replace(/\{\{\s*(lead_id|first_name|phone_number|state|age|campaign_id)\s*\}\}/gi, (_m, key) => {
        const k = String(key).toLowerCase();
        return cleanLead[k] ?? '';
    });
    settings.agent.greeting = replaceVars(settings.agent.greeting || '');
    const basePrompt = replaceVars(settings.agent.think.prompt || '');
    const contextFooter = `\n\n[Browser Test Lead Context — supplied for this test, not a live VICIdial call]\n` +
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
function attachLiveSimulator(server, noServer = false) {
    const wss = noServer
        ? new ws_1.WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024, perMessageDeflate: false })
        : new ws_1.WebSocketServer({ server, path: '/ws/simulator', maxPayload: 4 * 1024 * 1024, perMessageDeflate: false });
    wss.on('connection', (clientWs, req) => {
        if ((0, auth_guard_1.getAuthenticatedUser)(req)?.role === 'viewer') {
            clientWs.close(1008, 'Read-only account');
            return;
        }
        if (wss.clients.size > 64) {
            clientWs.close(1013, 'Simulator capacity reached');
            return;
        }
        const callId = `sim_${Date.now().toString(36)}_${crypto_1.default.randomBytes(3).toString('hex')}`;
        const startedAtIso = new Date().toISOString();
        const startedAtMs = Date.now();
        let started = false;
        let closed = false;
        let settingsApplied = false;
        let upstreamMode = 'deepgram';
        let dgWs = null;
        let keepAliveTimer = null;
        let comfortSilenceTimer = null;
        let pendingEndTimer = null;
        let connectTimer = null;
        let openingGate = null;
        let heartbeatTimer = null;
        let startTimer = null;
        let alive = true;
        let messageWindow = Date.now();
        let messageCount = 0;
        let preSettingsBytes = 0;
        clientWs.on('pong', () => { alive = true; });
        startTimer = setTimeout(() => { if (!started && !closed) {
            sendFatalError('START_TIMEOUT', 'No call start message was received.');
            finalizeCall('start_timeout');
        } }, 15000);
        heartbeatTimer = setInterval(() => {
            if (!(0, auth_guard_1.isRequestAuthorized)(req)) {
                finalizeCall('session_revoked');
                return;
            }
            if (!alive) {
                clientWs.terminate();
                return;
            }
            alive = false;
            if (clientWs.readyState === ws_1.default.OPEN)
                clientWs.ping();
        }, 30000);
        let activeState = null;
        let persistedFunctions = [];
        let activeAgent = null;
        let activeCampaign;
        let selectedGreeting = null;
        let testLead = {};
        let allowWebhooks = false;
        let recordingRequested = false;
        let sampleRateIn = 16000;
        let sampleRateOut = 24000;
        let turns = 0;
        let txAudioBytes = 0;
        let rxAudioBytes = 0;
        let lastBrowserAudioAt = 0;
        let lastUserTurnTs = null;
        let lastThinkingTs = null;
        let awaitingFirstAudioForTurn = false;
        const ttfbSamples = [];
        let detectedDisposition = null;
        let transferredTo = null;
        let awaitingHangupAudioDone = false;
        let pendingEndFunctionId = null;
        let fatalErrorMessage = null;
        let suppressStaleAgentAudio = false;
        const cancelledFnIds = new Set();
        const activeFunctionAborts = new Map();
        const pendingPreSettingsAudio = [];
        const pendingInjectedMessages = [];
        const transcript = [];
        const functionCalls = [];
        const sendClientJson = (payload) => {
            if (clientWs.bufferedAmount > 8 * 1024 * 1024) {
                clientWs.close(1013, 'Client is not consuming events');
                return;
            }
            if (clientWs.readyState === ws_1.default.OPEN) {
                clientWs.send(JSON.stringify(payload));
            }
        };
        const sendFatalError = (code, error) => {
            fatalErrorMessage = `${code}: ${error}`;
            sendClientJson({
                type: 'error',
                code,
                error,
            });
        };
        const sendClientAudio = (pcmChunk) => {
            if (clientWs.bufferedAmount > 8 * 1024 * 1024) {
                clientWs.close(1013, 'Client is not consuming audio');
                return;
            }
            if (clientWs.readyState === ws_1.default.OPEN) {
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
        const recordTranscript = (role, content, extra = {}) => {
            const ts = new Date().toISOString();
            if (transcript.length >= 2000)
                transcript.shift();
            transcript.push({ ts, role, content: content.slice(0, 16000) });
            sendClientJson({
                type: 'transcript',
                ts,
                role,
                content,
                ...extra,
            });
        };
        const executeClientFunction = async (fnReq) => {
            if (cancelledFnIds.has(fnReq.id)) {
                return;
            }
            let parsedArgs = {};
            try {
                parsedArgs = fnReq.arguments ? JSON.parse(fnReq.arguments) : {};
            }
            catch {
                parsedArgs = { _raw: fnReq.arguments || '' };
            }
            if (fnReq.client_side === false) {
                const entry = {
                    ts: new Date().toISOString(),
                    id: fnReq.id,
                    name: fnReq.name,
                    args: parsedArgs,
                    status: 'server_side',
                };
                functionCalls.push(entry);
                sendClientJson({ type: 'function_call', ...entry });
                return;
            }
            // Drafts may change prompts, but executable webhook destinations/headers
            // must come from persisted configuration reviewed by an administrator.
            const fnConfig = persistedFunctions.find((f) => f.name === fnReq.name);
            const enabled = Boolean(fnConfig && activeAgent?.fnIds.includes(fnConfig.id));
            let resultPayload;
            if (!enabled) {
                resultPayload = { ok: false, error: 'Function is not enabled for this agent.' };
            }
            else if (fnReq.name === 'set_disposition') {
                const requestedCode = String(parsedArgs.code || '').trim().toUpperCase();
                const allowedCodes = (0, settings_builder_1.allowedCampaignDispositionCodes)(activeCampaign);
                resultPayload = !allowedCodes.includes(requestedCode)
                    ? { ok: false, error: `Disposition ${requestedCode || '(empty)'} is not allowed by the selected campaign.` }
                    : {
                        ok: false,
                        simulated: true,
                        requested_code: requestedCode,
                        error: 'Browser tests are not VICIdial calls. No disposition or do-not-call record was changed.',
                    };
            }
            else if (fnReq.name === 'transfer_to_live_agent') {
                const allowedCodes = (0, settings_builder_1.allowedCampaignDispositionCodes)(activeCampaign);
                resultPayload = !allowedCodes.includes('XFER')
                    ? { ok: false, error: 'XFER is not allowed by the explicitly selected campaign. No transfer was simulated.' }
                    : {
                        ok: false,
                        simulated: true,
                        requested_target: activeCampaign ? `${activeCampaign.xferType}:${activeCampaign.xferTarget}` : null,
                        error: 'Browser tests cannot transfer a real call. No VICIdial or PBX transfer was made.',
                    };
            }
            else if (fnReq.name === 'end_call') {
                awaitingHangupAudioDone = true;
                pendingEndFunctionId = fnReq.id;
                resultPayload = { ok: true, action: 'end_browser_test_after_speech' };
                if (pendingEndTimer)
                    clearTimeout(pendingEndTimer);
                pendingEndTimer = setTimeout(() => finalizeCall('bot_end_call'), 9000);
            }
            else if (!fnConfig?.url?.trim()) {
                resultPayload = { ok: false, error: 'No webhook URL is configured for this function.' };
            }
            else if (!allowWebhooks) {
                resultPayload = { ok: false, error: 'Real webhooks are disabled for this browser test.' };
            }
            else {
                const controller = new AbortController();
                activeFunctionAborts.set(fnReq.id, controller);
                const whRes = await (0, webhook_executor_1.executeCustomFunctionWebhook)(fnConfig, parsedArgs, {
                    callId,
                    leadId: testLead.lead_id || null,
                    phone: testLead.phone_number || '',
                    campaignId: activeCampaign?.id || null,
                    viciCampaign: activeCampaign?.viciCampaign || null,
                    lead: testLead,
                }, 6000, controller.signal);
                activeFunctionAborts.delete(fnReq.id);
                // A cancelled/closed session must not send a late success to the model.
                if (cancelledFnIds.has(fnReq.id) || closed)
                    return;
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
                status: resultPayload.simulated ? 'simulated' : resultPayload.ok ? 'completed' : 'failed',
                response: resultPayload,
            };
            functionCalls.push(entry);
            sendClientJson({
                type: 'function_call',
                ...entry,
                disposition: detectedDisposition,
                transferredTo,
            });
            if (dgWs && dgWs.readyState === ws_1.default.OPEN) {
                const fnResp = {
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
            if (finalized)
                return;
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
            if (connectTimer) {
                clearTimeout(connectTimer);
                connectTimer = null;
            }
            if (heartbeatTimer) {
                clearInterval(heartbeatTimer);
                heartbeatTimer = null;
            }
            if (startTimer) {
                clearTimeout(startTimer);
                startTimer = null;
            }
            openingGate?.cancel();
            openingGate = null;
            for (const controller of activeFunctionAborts.values())
                controller.abort();
            activeFunctionAborts.clear();
            if (dgWs && (dgWs.readyState === ws_1.default.OPEN || dgWs.readyState === ws_1.default.CONNECTING)) {
                try {
                    dgWs.close(1000, 'Call ended');
                }
                catch { }
            }
            const endedAtIso = new Date().toISOString();
            const durationMs = Math.max(1, Date.now() - startedAtMs);
            const avgTtfbMs = ttfbSamples.length
                ? Math.round(ttfbSamples.reduce((a, b) => a + b, 0) / ttfbSamples.length)
                : null;
            // Only provider-confirmed sessions count as test calls. A call-ended
            // event must not imply persistence when the database write failed.
            let logSaved = null;
            if (settingsApplied && activeAgent) {
                try {
                    (0, db_1.saveSimulatorCallLog)({
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
                }
                catch {
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
            if (clientWs.readyState === ws_1.default.OPEN) {
                try {
                    clientWs.close(1000, reason);
                }
                catch { }
            }
        };
        clientWs.on('message', (data, isBinary) => {
            if (closed)
                return;
            const nowMs = Date.now();
            if (nowMs - messageWindow >= 1000) {
                messageWindow = nowMs;
                messageCount = 0;
            }
            if (++messageCount > 200) {
                sendFatalError('MESSAGE_RATE_LIMIT', 'Too many simulator messages.');
                finalizeCall('message_rate_limit');
                return;
            }
            if (isBinary) {
                const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
                txAudioBytes += buf.length;
                lastBrowserAudioAt = Date.now();
                if (!settingsApplied) {
                    if (pendingPreSettingsAudio.length < 25 && preSettingsBytes + buf.length <= 1024 * 1024) {
                        preSettingsBytes += buf.length;
                        pendingPreSettingsAudio.push(buf);
                    }
                    return;
                }
                if (dgWs && dgWs.readyState === ws_1.default.OPEN) {
                    dgWs.send(buf, { binary: true });
                }
                return;
            }
            let msg;
            try {
                msg = JSON.parse(data.toString());
                if (!msg || typeof msg !== 'object' || Array.isArray(msg))
                    throw new Error('Expected object');
            }
            catch {
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
                if (!content)
                    return;
                suppressStaleAgentAudio = false;
                if (dgWs && dgWs.readyState === ws_1.default.OPEN && settingsApplied) {
                    dgWs.send(JSON.stringify({ type: 'InjectAgentMessage', message: content }));
                }
                return;
            }
            if (msg.type === 'inject_user_message') {
                const content = String(msg.content || '').trim().slice(0, 8000);
                if (!content)
                    return;
                suppressStaleAgentAudio = false;
                const injectPayload = JSON.stringify({ type: 'InjectUserMessage', content });
                if (!settingsApplied) {
                    if (pendingInjectedMessages.length < 32)
                        pendingInjectedMessages.push(injectPayload);
                }
                else if (dgWs && dgWs.readyState === ws_1.default.OPEN) {
                    openingGate?.userTurn();
                    lastUserTurnTs = Date.now();
                    awaitingFirstAudioForTurn = true;
                    dgWs.send(injectPayload);
                }
                return;
            }
            if (msg.type === 'start' && !started) {
                started = true;
                if (startTimer) {
                    clearTimeout(startTimer);
                    startTimer = null;
                }
                const startMsg = msg;
                allowWebhooks = startMsg.allowWebhooks === true;
                recordingRequested = startMsg.recordAudio === true;
                const persistedState = (0, db_1.getConsoleState)();
                persistedFunctions = persistedState.functions;
                activeState = startMsg.draftState ? (0, defaults_1.normalizeState)(startMsg.draftState) : persistedState;
                // Live calls always use saved global provider/model pairs and provider connection settings,
                // never unsaved draft overrides. Agent prompt/behavior drafts remain testable in the simulator.
                activeState.services = persistedState.services;
                for (const kind of ['stt', 'llm', 'tts']) {
                    const selection = persistedState.services[kind];
                    const savedProvider = persistedState.providers.find((p) => p.kind === kind && p.id === selection.providerId);
                    if (!savedProvider)
                        continue;
                    const providerIndex = activeState.providers.findIndex((p) => p.id === savedProvider.id);
                    if (providerIndex >= 0)
                        activeState.providers[providerIndex] = savedProvider;
                    else
                        activeState.providers.push(savedProvider);
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
                if (!requestedCampaign || !(0, campaign_assignment_1.campaignHasAgent)(requestedCampaign, requestedAgent.id)) {
                    sendFatalError('CAMPAIGN_ASSIGNMENT_MISMATCH', 'The selected campaign is not assigned to this bot. Assign it in Campaigns and retry.');
                    finalizeCall('campaign_assignment_mismatch');
                    return;
                }
                const campaignBlockers = (0, settings_builder_1.getCampaignCallReadinessBlockers)(activeState, requestedCampaign, requestedAgent);
                if (campaignBlockers.length) {
                    sendFatalError('CAMPAIGN_NOT_READY', `Campaign “${requestedCampaign.name}” is not ready: ${campaignBlockers.join('; ')}.`);
                    finalizeCall('campaign_not_ready');
                    return;
                }
                activeCampaign = requestedCampaign;
                const sessionState = activeState;
                const missingGlobalServices = ['stt', 'llm', 'tts'].filter((kind) => {
                    const selected = sessionState?.services?.[kind];
                    return !sessionState?.providers.some((p) => p.kind === kind && p.id === selected?.providerId) || !String(selected?.model || '').trim();
                });
                if (missingGlobalServices.length > 0) {
                    sendFatalError('GLOBAL_SERVICES_UNCONFIGURED', `Select and save one global provider/model for ${missingGlobalServices.join(', ')} on the Plug-Ins page before starting a session.`);
                    clientWs.close(1008, 'Global service selections are required');
                    return;
                }
                const bandwidth = startMsg.bandwidth === 'telephony' ? 'telephony' : 'wideband';
                sampleRateIn = bandwidth === 'telephony' ? 8000 : 16000;
                sampleRateOut = bandwidth === 'telephony' ? 8000 : 24000;
                const activeSttProv = activeState.providers.find((p) => p.kind === 'stt' && p.id === activeState.services?.stt?.providerId);
                const activeTtsProv = activeState.providers.find((p) => p.kind === 'tts' && p.id === activeState.services?.tts?.providerId);
                const usesLocalSpeechService = activeSttProv?.type === 'speech_service' || activeTtsProv?.type === 'speech_service';
                const requestedMode = startMsg.upstreamMode || (usesLocalSpeechService ? 'speech_service' : 'deepgram');
                const customAgentUrl = (process.env.DEEPGRAM_AGENT_URL || '').trim();
                const dgApiKey = (0, env_store_1.getSecret)('DEEPGRAM_API_KEY');
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
                    sendFatalError('MISSING_DEEPGRAM_KEY', 'DEEPGRAM_API_KEY is not configured on the server. Click "🔑 API Keys" in the top bar and save your Deepgram API key.');
                    finalizeCall('missing_api_key');
                    return;
                }
                selectedGreeting = (0, db_1.trySelectGreeting)(activeAgent.id, activeAgent.randomGreetingEnabled !== false, activeAgent.greeting);
                if (activeAgent.randomGreetingEnabled !== false && !selectedGreeting) {
                    sendClientJson({ type: 'warning', code: 'GREETING_LIBRARY_UNAVAILABLE',
                        message: 'The greeting library is unavailable; this test will use the configured opening.' });
                }
                const displaySettings = (0, settings_builder_1.buildDeepgramSettings)(activeState, activeAgent, activeCampaign, { greetingText: selectedGreeting?.greeting_text });
                const rawSettings = (0, settings_builder_1.buildDeepgramSettings)(activeState, activeAgent, activeCampaign, {
                    forceClientSideWebhooks: true,
                    greetingText: selectedGreeting?.greeting_text,
                });
                rawSettings.audio = {
                    input: { encoding: 'linear16', sample_rate: sampleRateIn },
                    output: { encoding: 'linear16', sample_rate: sampleRateOut, container: 'none' },
                };
                displaySettings.audio = JSON.parse(JSON.stringify(rawSettings.audio));
                const hydration = hydrateLeadIntoPromptAndGreeting(rawSettings, activeAgent, activeCampaign, startMsg.lead || {});
                hydrateLeadIntoPromptAndGreeting(displaySettings, activeAgent, activeCampaign, startMsg.lead || {});
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
                for (const fn of rawSettings.agent.think.functions || [])
                    fn.defer_until_eot = true;
                let wireSettings;
                let openingText = '';
                try {
                    const prepared = (0, opening_1.prepareDelayedOpening)(interpolateEnvPlaceholders(rawSettings));
                    openingText = prepared.greeting;
                    wireSettings = prepared.settings;
                }
                catch (err) {
                    sendFatalError('PROMPT_TOO_LONG', err.message || 'Could not prepare the opening.');
                    finalizeCall('prompt_too_long');
                    return;
                }
                openingGate = (0, opening_1.createOpeningGate)({
                    greeting: openingText,
                    sendOpening: (message) => {
                        if (!closed && dgWs?.readyState === ws_1.default.OPEN) {
                            dgWs.send(JSON.stringify({ type: 'InjectAgentMessage', message }));
                        }
                    },
                    playAudio: sendClientAudio,
                    onSendError: () => {
                        if (!closed)
                            sendClientJson({ type: 'warning', message: 'The configured opening could not be sent to Deepgram. Check the provider connection.' });
                    },
                    onOverflow: () => sendClientJson({ type: 'warning', message: 'Early provider audio exceeded the opening buffer and was dropped.' }),
                });
                const targetUrl = customAgentUrl || 'wss://agent.deepgram.com/v1/agent/converse';
                const wsHeaders = {};
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
                    dgWs = new ws_1.default(targetUrl, { headers: wsHeaders, family: 4, maxPayload: 4 * 1024 * 1024, handshakeTimeout: 15000 });
                }
                catch (err) {
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
                        sendFatalError(`DEEPGRAM_HTTP_${res.statusCode || 400}`, `Deepgram rejected WebSocket upgrade with HTTP ${res.statusCode}${dgErr}${detail}. Check your DEEPGRAM_API_KEY and Deepgram project balance/permissions.`);
                        finalizeCall(`http_${res.statusCode}`);
                    });
                });
                dgWs.on('open', () => {
                    keepAliveTimer = setInterval(() => {
                        if (dgWs && dgWs.readyState === ws_1.default.OPEN && settingsApplied) {
                            dgWs.send(JSON.stringify({ type: 'KeepAlive' }));
                        }
                    }, 6000);
                });
                dgWs.on('message', (dgRaw, dgBinary) => {
                    if (closed)
                        return;
                    if (dgBinary) {
                        if (suppressStaleAgentAudio) {
                            return;
                        }
                        const audioBuf = Buffer.isBuffer(dgRaw) ? dgRaw : Buffer.from(dgRaw);
                        openingGate?.audio(audioBuf);
                        return;
                    }
                    let evt;
                    try {
                        evt = JSON.parse(dgRaw.toString());
                    }
                    catch {
                        return;
                    }
                    switch (evt.type) {
                        case 'Welcome': {
                            sendClientJson({ type: 'dg_welcome', requestId: evt.request_id || null });
                            dgWs?.send(JSON.stringify(wireSettings));
                            break;
                        }
                        case 'SettingsApplied': {
                            if (settingsApplied)
                                break;
                            settingsApplied = true;
                            openingGate?.start();
                            if (connectTimer) {
                                clearTimeout(connectTimer);
                                connectTimer = null;
                            }
                            if (heartbeatTimer) {
                                clearInterval(heartbeatTimer);
                                heartbeatTimer = null;
                            }
                            if (startTimer) {
                                clearTimeout(startTimer);
                                startTimer = null;
                            }
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
                                recordTranscript('system', `Browser test lead context: #${hydration.leadSummary.lead_id} (${hydration.leadSummary.first_name}, ${hydration.leadSummary.state}, age ${hydration.leadSummary.age}). This is not a live VICIdial call.`);
                            }
                            sendClientJson({ type: 'agent_state', state: 'listening' });
                            while (pendingPreSettingsAudio.length > 0) {
                                const chunk = pendingPreSettingsAudio.shift();
                                preSettingsBytes -= chunk.length;
                                if (dgWs?.readyState === ws_1.default.OPEN)
                                    dgWs.send(chunk, { binary: true });
                            }
                            while (pendingInjectedMessages.length > 0) {
                                const injected = pendingInjectedMessages.shift();
                                openingGate?.userTurn();
                                lastUserTurnTs = Date.now();
                                awaitingFirstAudioForTurn = true;
                                if (dgWs?.readyState === ws_1.default.OPEN)
                                    dgWs.send(injected);
                            }
                            // Comfort-silence PCM16 streamer: keeps Deepgram Flux/Nova ASR alive when browser mic is muted,
                            // blocked by an iframe, or running in Speaker + Text mode!
                            const silenceChunk = Buffer.alloc(Math.floor(sampleRateIn * 0.05) * 2, 0);
                            comfortSilenceTimer = setInterval(() => {
                                if (!closed &&
                                    settingsApplied &&
                                    dgWs &&
                                    dgWs.readyState === ws_1.default.OPEN &&
                                    Date.now() - lastBrowserAudioAt > 250) {
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
                            }
                            else {
                                suppressStaleAgentAudio = false;
                            }
                            recordTranscript(role, String(evt.content || ''), {
                                languages: evt.languages,
                            });
                            break;
                        }
                        case 'AgentThinking': {
                            lastThinkingTs = Date.now();
                            suppressStaleAgentAudio = false;
                            sendClientJson({ type: 'agent_state', state: 'thinking' });
                            break;
                        }
                        case 'AgentStartedSpeaking': {
                            suppressStaleAgentAudio = false;
                            sendClientJson({ type: 'agent_state', state: 'speaking' });
                            break;
                        }
                        case 'AgentAudioDone': {
                            openingGate?.afterRelease(() => {
                                if (closed)
                                    return;
                                sendClientJson({ type: 'agent_state', state: 'listening' });
                                if (awaitingHangupAudioDone)
                                    finalizeCall('bot_end_call');
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
                                    if (pendingEndTimer)
                                        clearTimeout(pendingEndTimer);
                                    pendingEndTimer = null;
                                }
                            }
                            const entry = {
                                ts: new Date().toISOString(),
                                id: String(cancelledId || 'cancelled'),
                                name: String(evt.name || 'speculative_call'),
                                args: {},
                                status: 'cancelled',
                            };
                            functionCalls.push(entry);
                            sendClientJson({ type: 'function_call', ...entry });
                            break;
                        }
                        case 'FunctionCallRequest': {
                            const list = Array.isArray(evt.functions) ? evt.functions : [];
                            for (const fnItem of list.slice(0, 32)) {
                                if (!fnItem || typeof fnItem.id !== 'string' || typeof fnItem.name !== 'string')
                                    continue;
                                void executeClientFunction(fnItem).catch(() => { if (!closed) {
                                    sendFatalError('FUNCTION_ERROR', 'A function could not be executed.');
                                    finalizeCall('function_error');
                                } });
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
                            sendFatalError(evt.code || 'DEEPGRAM_AGENT_ERROR', evt.description || evt.message || JSON.stringify(evt));
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
                        if (!fatalErrorMessage)
                            sendFatalError('UPSTREAM_CLOSED', `Deepgram connection closed: ${reasonStr}`);
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
