import http from 'http';
import crypto from 'crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { getConsoleState, saveSimulatorCallLog, SimulatorCallLogRecord } from './db';
import { normalizeState } from './defaults';
import { getSecret, MANAGED_SECRET_KEYS } from './env-store';
import { buildDeepgramSettings } from './settings-builder';
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
  upstreamMode?: 'deepgram' | 'sandbox';
  agentId: string;
  campaignId?: string;
  bandwidth?: 'wideband' | 'telephony';
  lead?: SimulatedLeadContext;
  draftState?: unknown;
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

function hydrateLeadIntoPromptAndGreeting(
  settings: any,
  agent: Agent,
  campaign: Campaign | undefined,
  lead: SimulatedLeadContext
): { hydrated: boolean; leadSummary: Record<string, string> } {
  const cleanLead: Record<string, string> = {
    lead_id: String(lead?.lead_id || '104892').trim(),
    first_name: String(lead?.first_name || 'Robert').trim(),
    phone_number: String(lead?.phone_number || '+13055550192').trim(),
    state: String(lead?.state || 'FL').trim(),
    age: String(lead?.age || '64').trim(),
    campaign_id: String(campaign?.viciCampaign || 'FETEST').trim(),
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
    `\n\n[Active VICIdial Call Lead Record — Hydrated by Bridge on Connect]\n` +
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

function synthesizeSandboxTonePcm16(sampleRate: number, durationMs = 420, freqHz = 440): Buffer {
  const numSamples = Math.floor((sampleRate * durationMs) / 1000);
  const buf = Buffer.alloc(numSamples * 2);
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const env = Math.sin((Math.PI * i) / numSamples) * 0.18;
    const sample = Math.sin(2 * Math.PI * freqHz * t) * env + Math.sin(2 * Math.PI * (freqHz * 1.5) * t) * (env * 0.4);
    const s16 = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
    buf.writeInt16LE(s16, i * 2);
  }
  return buf;
}

export function attachLiveSimulator(server?: http.Server, noServer = false): WebSocketServer {
  const wss = noServer
    ? new WebSocketServer({ noServer: true })
    : new WebSocketServer({ server, path: '/ws/simulator' });

  wss.on('connection', (clientWs: WebSocket) => {
    const callId = `sim_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
    const startedAtIso = new Date().toISOString();
    const startedAtMs = Date.now();

    let started = false;
    let closed = false;
    let settingsApplied = false;
    let upstreamMode: 'deepgram' | 'sandbox' = 'deepgram';
    let dgWs: WebSocket | null = null;
    let keepAliveTimer: NodeJS.Timeout | null = null;
    let comfortSilenceTimer: NodeJS.Timeout | null = null;
    let pendingEndTimer: NodeJS.Timeout | null = null;

    let activeState: ConsoleState | null = null;
    let activeAgent: Agent | null = null;
    let activeCampaign: Campaign | undefined;
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
    let fatalErrorMessage: string | null = null;
    let suppressStaleAgentAudio = false;

    const cancelledFnIds = new Set<string>();
    const pendingPreSettingsAudio: Buffer[] = [];
    const pendingInjectedMessages: string[] = [];

    const transcript: SimulatorCallLogRecord['transcript'] = [];
    const functionCalls: SimulatorCallLogRecord['functionCalls'] = [];

    let sandboxSpeechFrames = 0;
    let sandboxSpeaking = false;

    const sendClientJson = (payload: Record<string, any>) => {
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
      transcript.push({ ts, role, content });
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

      let resultPayload: Record<string, any> = { ok: true, simulated: true };

      if (fnReq.name === 'set_disposition') {
        const code = String(parsedArgs.code || 'CALLBK').trim().toUpperCase();
        const allowed = (activeCampaign?.dispos || '')
          .split(',')
          .map((d) => d.trim().toUpperCase())
          .filter(Boolean);
        const validCode = allowed.length === 0 || allowed.includes(code);
        detectedDisposition = code;
        resultPayload = {
          ok: true,
          vici_api: '/vicidial/non_agent_api.php',
          disposition_code: code,
          valid_for_campaign: validCode,
          notes: parsedArgs.notes || '',
        };
      } else if (fnReq.name === 'transfer_to_live_agent') {
        const target = activeCampaign
          ? `${activeCampaign.xferType}:${activeCampaign.xferTarget}`
          : 'ingroup:FE_CLOSERS';
        transferredTo = target;
        if (!detectedDisposition) detectedDisposition = 'XFER';
        resultPayload = {
          ok: true,
          vici_api: '/agc/api.php?function=ra_call_control&stage=INGROUPTRANSFER',
          transferred_to: target,
          screen_pop_lead_preserved: true,
          reason: parsedArgs.reason || 'Qualified & interested lead',
          metadata_passed: {
            prospect_name: parsedArgs.prospect_name || null,
            confirmed_age: parsedArgs.confirmed_age || null,
            medicare_status: parsedArgs.medicare_status || null,
            hook_type: parsedArgs.hook_type || null,
          },
        };
      } else if (fnReq.name === 'end_call') {
        awaitingHangupAudioDone = true;
        resultPayload = {
          ok: true,
          action: 'hangup_scheduled_after_speech',
        };
        if (pendingEndTimer) clearTimeout(pendingEndTimer);
        pendingEndTimer = setTimeout(() => {
          finalizeCall('bot_end_call');
        }, 1800);
      } else {
        const fnConfig = activeState?.functions.find((f) => f.name === fnReq.name);
        const whRes = await executeCustomFunctionWebhook(fnConfig, parsedArgs, {
          callId,
          leadId: '104892',
          phone: '3055550192',
          campaignId: activeCampaign?.id || null,
          viciCampaign: activeCampaign?.viciCampaign || null,
        });
        resultPayload = whRes.executedWebhook
          ? {
              ok: whRes.ok,
              executed_by: 'node_webhook_executor',
              http_status: whRes.httpStatus,
              latency_ms: whRes.latencyMs,
              result: whRes.data ?? null,
              ...(whRes.error ? { error: whRes.error } : {}),
            }
          : {
              ok: true,
              executed_by: 'simulator_client_handler',
              received_args: parsedArgs,
            };
      }

      const entry = {
        ts: new Date().toISOString(),
        id: fnReq.id,
        name: fnReq.name,
        args: parsedArgs,
        status: 'completed' as const,
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

    let sandboxMedicareConfirmed = false;

    const handleSandboxUtterance = (userText: string) => {
      const clean = userText.trim();
      if (!clean || closed) return;

      turns += 1;
      lastUserTurnTs = Date.now();
      awaitingFirstAudioForTurn = true;
      sendClientJson({ type: 'agent_state', state: 'user_speaking' });
      recordTranscript('user', clean);

      setTimeout(() => {
        if (closed) return;
        lastThinkingTs = Date.now();
        sendClientJson({ type: 'agent_state', state: 'thinking' });

        setTimeout(() => {
          if (closed) return;
          const lower = clean.toLowerCase();
          const isMedicareBot =
            activeAgent?.id === 'a_medicare' || /medicare/i.test(activeAgent?.name || '');
          const enabledFnNames = (activeAgent?.fnIds || [])
            .map((id) => activeState?.functions.find((f) => f.id === id)?.name)
            .filter(Boolean);

          // Medicare-specific Sandbox Dialogue Tree (mirrors exact 4-phase Training Blueprint)
          if (isMedicareBot) {
            // Scenario A: Language Barrier (Spanish / Non-English)
            if (/(hablo espa|español|espanol|no hablo ingl|no speak english|spanish only)/i.test(lower)) {
              if (enabledFnNames.includes('set_disposition')) {
                executeClientFunction({
                  id: `fc_sbx_${Date.now()}_lang`,
                  name: 'set_disposition',
                  arguments: JSON.stringify({
                    code: 'LANG',
                    notes: `Language Barrier - Non-English speaker ("${clean}")`,
                  }),
                  client_side: true,
                });
              }
              const langReply = 'Apologies, have a great day.';
              sendClientJson({ type: 'agent_state', state: 'speaking' });
              recordTranscript('assistant', langReply);
              sendClientAudio(synthesizeSandboxTonePcm16(sampleRateOut, 280, 392));
              if (enabledFnNames.includes('end_call')) {
                executeClientFunction({
                  id: `fc_sbx_${Date.now()}_end`,
                  name: 'end_call',
                  arguments: '{}',
                  client_side: true,
                });
              }
              sendClientJson({ type: 'agent_state', state: 'listening' });
              return;
            }

            // Scenario B: Hostility / Do-Not-Call Resistance
            if (/(take me off|do not call|dnc|stop calling|don't call)/i.test(lower)) {
              if (enabledFnNames.includes('set_disposition')) {
                executeClientFunction({
                  id: `fc_sbx_${Date.now()}_dnc`,
                  name: 'set_disposition',
                  arguments: JSON.stringify({ code: 'DNC', notes: `Caller requested DNC: "${clean}"` }),
                  client_side: true,
                });
              }
              const dncReply =
                'I completely understand, and I apologize for the intrusion. I will remove your number from our active outreach list immediately. Have a great day.';
              sendClientJson({ type: 'agent_state', state: 'speaking' });
              recordTranscript('assistant', dncReply);
              sendClientAudio(synthesizeSandboxTonePcm16(sampleRateOut, 360, 392));
              if (enabledFnNames.includes('end_call')) {
                executeClientFunction({
                  id: `fc_sbx_${Date.now()}_end`,
                  name: 'end_call',
                  arguments: '{}',
                  client_side: true,
                });
              }
              sendClientJson({ type: 'agent_state', state: 'listening' });
              return;
            }

            // Scenario C: Skepticism / "Is this a scam?"
            if (/(scam|sales pitch|bill|who are you|legit|real)/i.test(lower)) {
              const scamReply =
                "I understand your caution! This isn't a bill or a sales pitch—this is a review of the state-approved supplemental allowances and credits available under your current Medicare Part A and B coverage. It takes less than a minute to verify if your zip code is approved. Do you currently have Medicare Part A and B?";
              sendClientJson({ type: 'agent_state', state: 'speaking' });
              recordTranscript('assistant', scamReply);
              sendClientAudio(synthesizeSandboxTonePcm16(sampleRateOut, 440, 493.88));
              setTimeout(() => {
                if (!closed) sendClientJson({ type: 'agent_state', state: 'listening' });
              }, 300);
              return;
            }

            // Explicit No Medicare
            if (/\b(no medicare|don't have medicare|do not have medicare|medicaid only)\b/i.test(lower)) {
              if (enabledFnNames.includes('set_disposition')) {
                executeClientFunction({
                  id: `fc_sbx_${Date.now()}_dq`,
                  name: 'set_disposition',
                  arguments: JSON.stringify({ code: 'DQ', notes: 'Disqualified: No Medicare Part A or B' }),
                  client_side: true,
                });
              }
              const dqReply =
                'Thank you for letting me know! Right now this state allowance release requires active Medicare Part A or B, so we cannot release the card today. Have a wonderful rest of your day!';
              sendClientJson({ type: 'agent_state', state: 'speaking' });
              recordTranscript('assistant', dqReply);
              sendClientAudio(synthesizeSandboxTonePcm16(sampleRateOut, 360, 392));
              if (enabledFnNames.includes('end_call')) {
                executeClientFunction({
                  id: `fc_sbx_${Date.now()}_end`,
                  name: 'end_call',
                  arguments: '{}',
                  client_side: true,
                });
              }
              sendClientJson({ type: 'agent_state', state: 'listening' });
              return;
            }

            if (/(yes|yeah|i think so|part a|part b|both|i have medicare)/i.test(lower)) {
              sandboxMedicareConfirmed = true;
            }

            const ageMatch = /\b(\d{2,3})\b/.exec(lower);
            if (ageMatch) {
              const ageNum = Number(ageMatch[1]);
              if (ageNum < 65 || ageNum > 85) {
                if (enabledFnNames.includes('set_disposition')) {
                  executeClientFunction({
                    id: `fc_sbx_${Date.now()}_dq_age`,
                    name: 'set_disposition',
                    arguments: JSON.stringify({
                      code: 'DQ',
                      notes: `Disqualified: Age ${ageNum} outside strict 65-85 gate`,
                    }),
                    client_side: true,
                  });
                }
                const ageDqReply =
                  'Thank you for confirming! Right now this state allowance update is strictly for beneficiaries between ages 65 and 85, so we cannot activate the card today. Have a wonderful day!';
                sendClientJson({ type: 'agent_state', state: 'speaking' });
                recordTranscript('assistant', ageDqReply);
                sendClientAudio(synthesizeSandboxTonePcm16(sampleRateOut, 360, 392));
                if (enabledFnNames.includes('end_call')) {
                  executeClientFunction({
                    id: `fc_sbx_${Date.now()}_end`,
                    name: 'end_call',
                    arguments: '{}',
                    client_side: true,
                  });
                }
                sendClientJson({ type: 'agent_state', state: 'listening' });
                return;
              }

              // Age is strictly 65-85!
              sandboxMedicareConfirmed = true;
              if (enabledFnNames.includes('set_disposition')) {
                executeClientFunction({
                  id: `fc_sbx_${Date.now()}_xfer_d`,
                  name: 'set_disposition',
                  arguments: JSON.stringify({
                    code: 'XFER',
                    notes: `Qualified Medicare Part A & B, Age ${ageNum}, Hook: Food & OTC Card`,
                  }),
                  client_side: true,
                });
              }
              if (enabledFnNames.includes('transfer_to_live_agent')) {
                executeClientFunction({
                  id: `fc_sbx_${Date.now()}_xfer`,
                  name: 'transfer_to_live_agent',
                  arguments: JSON.stringify({
                    reason: 'Qualified Medicare beneficiary ready for Food & OTC benefit review',
                    prospect_name: 'Robert',
                    confirmed_age: String(ageNum),
                    medicare_status: 'Medicare Part A & B',
                    hook_type: 'Food & OTC Card',
                  }),
                  client_side: true,
                });
              }
              const xferReply =
                'All right, everything looks good on my end. Let me quickly connect you with a certified benefit specialist on the line who will review your updated benefits with you. Just hold for one moment, here you go!';
              sendClientJson({ type: 'agent_state', state: 'speaking' });
              recordTranscript('assistant', xferReply);
              sendClientAudio(synthesizeSandboxTonePcm16(sampleRateOut, 440, 523.25));
              setTimeout(() => {
                if (!closed) sendClientJson({ type: 'agent_state', state: 'listening' });
              }, 300);
              return;
            }

            const phase2Reply = sandboxMedicareConfirmed
              ? 'Wonderful. Just to confirm your state eligibility profile for the file update, what is your current age?'
              : 'To release your Food and OTC card immediately, could you confirm if you currently have Medicare Part A or Part B?';
            sendClientJson({ type: 'agent_state', state: 'speaking' });
            recordTranscript('assistant', phase2Reply);
            sendClientAudio(synthesizeSandboxTonePcm16(sampleRateOut, 420, 466.16));
            setTimeout(() => {
              if (!closed) sendClientJson({ type: 'agent_state', state: 'listening' });
            }, 300);
            return;
          }

          let reply =
            "That's great to hear! Just to confirm before I bring on our licensed specialist, are you between 50 and 85 and looking for coverage options today?";

          if (/(introduce yourself|who are you|what is your name|what's your name|what can you do)/i.test(lower)) {
            reply =
              activeAgent?.behavior?.selfIntro ||
              `Hi there! I'm ${activeAgent?.name || 'Nova'}, your expressive, ultra-fast AI voice assistant. I can chat naturally with instant barge-in and answer any general or specialist questions you have!`;
            sendClientJson({ type: 'agent_state', state: 'speaking' });
            recordTranscript('assistant', reply);
            sendClientAudio(synthesizeSandboxTonePcm16(sampleRateOut, 360, 523.25));
            setTimeout(() => {
              if (!closed) sendClientJson({ type: 'agent_state', state: 'listening' });
            }, 260);
            return;
          }

          if (/(capital of|speed of light|sky blue|times|plus|weather|joke|how far|moon)/i.test(lower)) {
            reply = /capital of japan/i.test(lower)
              ? 'Oh, great question! The capital of Japan is Tokyo — a vibrant metropolis of nearly 14 million people.'
              : /sky blue/i.test(lower)
              ? 'Oh, I love that question! Sunlight scatters off tiny nitrogen and oxygen molecules in our atmosphere, and blue wavelengths scatter the most — painting the sky bright blue!'
              : "Great question! In live Deepgram mode I answer any general knowledge, science, or math question in under half a second — add your DEEPGRAM_API_KEY in API Keys to hear full live neural answers!";
            sendClientJson({ type: 'agent_state', state: 'speaking' });
            recordTranscript('assistant', reply);
            sendClientAudio(synthesizeSandboxTonePcm16(sampleRateOut, 340, 493.88));
            setTimeout(() => {
              if (!closed) sendClientJson({ type: 'agent_state', state: 'listening' });
            }, 260);
            return;
          }

          if (/(take me off|do not call|dnc|stop calling|not interested)/i.test(lower)) {
            if (enabledFnNames.includes('set_disposition')) {
              const code = /not interested/i.test(lower) ? 'NI' : 'DNC';
              executeClientFunction({
                id: `fc_sbx_${Date.now()}_1`,
                name: 'set_disposition',
                arguments: JSON.stringify({ code, notes: `Caller stated: "${clean}"` }),
                client_side: true,
              });
            }
            reply = "I completely understand — I've updated our records so you won't be called again. Have a wonderful day, goodbye.";
            sendClientJson({ type: 'agent_state', state: 'speaking' });
            recordTranscript('assistant', reply);
            sendClientAudio(synthesizeSandboxTonePcm16(sampleRateOut, 360, 392));
            if (enabledFnNames.includes('end_call')) {
              executeClientFunction({
                id: `fc_sbx_${Date.now()}_2`,
                name: 'end_call',
                arguments: '{}',
                client_side: true,
              });
            }
            sendClientJson({ type: 'agent_state', state: 'listening' });
            return;
          }

          if (/(how much|price|cost|dollar|quote amount)/i.test(lower)) {
            reply =
              'Exact monthly rates depend on your age and health profile, so our licensed specialist handles all pricing directly. Are you between ages 50 and 85 so I can connect you right now?';
          } else if (/(yes|interested|64|55|60|70|connect me|sure|quote|no coverage)/i.test(lower)) {
            if (enabledFnNames.includes('set_disposition')) {
              executeClientFunction({
                id: `fc_sbx_${Date.now()}_1`,
                name: 'set_disposition',
                arguments: JSON.stringify({ code: 'XFER', notes: 'Lead confirmed age & interest' }),
                client_side: true,
              });
            }
            if (enabledFnNames.includes('transfer_to_live_agent')) {
              executeClientFunction({
                id: `fc_sbx_${Date.now()}_2`,
                name: 'transfer_to_live_agent',
                arguments: JSON.stringify({
                  reason: `Lead interested and qualified ("${clean}")`,
                }),
                client_side: true,
              });
            }
            reply =
              'Wonderful, you qualify! Please stay on the line for just a moment while I connect you with our licensed specialist now.';
          }

          sendClientJson({ type: 'agent_state', state: 'speaking' });
          recordTranscript('assistant', reply);
          sendClientAudio(synthesizeSandboxTonePcm16(sampleRateOut, 440, 523.25));
          setTimeout(() => {
            if (!closed) sendClientJson({ type: 'agent_state', state: 'listening' });
          }, 300);
        }, 95);
      }, 45);
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

      if (started && activeAgent) {
        try {
          saveSimulatorCallLog({
            id: callId,
            agentId: activeAgent.id,
            agentName: activeAgent.name,
            campaignId: activeCampaign?.id || null,
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
            transcript,
            functionCalls,
          });
        } catch {}
      }

      sendClientJson({
        type: 'call_ended',
        callId,
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

      if (isBinary) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        txAudioBytes += buf.length;
        lastBrowserAudioAt = Date.now();

        if (upstreamMode === 'sandbox') {
          if (buf.length >= 4) {
            let sumSq = 0;
            const samples = Math.floor(buf.length / 2);
            for (let i = 0; i < samples; i++) {
              const s = buf.readInt16LE(i * 2) / 32768;
              sumSq += s * s;
            }
            const rms = Math.sqrt(sumSq / samples);
            if (rms > 0.045) {
              sandboxSpeechFrames += 1;
              if (sandboxSpeechFrames === 3 && !sandboxSpeaking) {
                sandboxSpeaking = true;
                sendClientJson({ type: 'barge_in' });
                sendClientJson({ type: 'agent_state', state: 'user_speaking' });
              }
            } else if (sandboxSpeaking && rms < 0.015) {
              sandboxSpeechFrames = 0;
              sandboxSpeaking = false;
              handleSandboxUtterance('[Voice Mic Utterance — Yes, I am 64 and interested in a quote]');
            }
          }
          return;
        }

        if (!settingsApplied) {
          if (pendingPreSettingsAudio.length < 25) {
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
      } catch {
        sendFatalError('BAD_CLIENT_JSON', 'Invalid JSON message sent to /ws/simulator');
        return;
      }

      if (msg.type === 'stop') {
        finalizeCall('user_hangup');
        return;
      }

      if (msg.type === 'client_barge_in') {
        if (activeAgent?.behavior?.bargeIn !== 'off') {
          suppressStaleAgentAudio = true;
          sendClientJson({ type: 'barge_in', source: 'client_vad' });
          sendClientJson({ type: 'agent_state', state: 'user_speaking' });
        }
        return;
      }

      if (msg.type === 'inject_agent_message') {
        const content = String(msg.content || '').trim();
        if (!content) return;
        suppressStaleAgentAudio = false;
        if (upstreamMode === 'sandbox') {
          sendClientJson({ type: 'agent_state', state: 'speaking' });
          recordTranscript('assistant', content);
          sendClientAudio(synthesizeSandboxTonePcm16(sampleRateOut, 320, 523.25));
          setTimeout(() => {
            if (!closed) sendClientJson({ type: 'agent_state', state: 'listening' });
          }, 260);
          return;
        }
        if (dgWs && dgWs.readyState === WebSocket.OPEN && settingsApplied) {
          dgWs.send(JSON.stringify({ type: 'InjectAgentMessage', content }));
        }
        return;
      }

      if (msg.type === 'inject_user_message') {
        const content = String(msg.content || '').trim();
        if (!content) return;
        suppressStaleAgentAudio = false;

        if (upstreamMode === 'sandbox') {
          handleSandboxUtterance(content);
          return;
        }

        const injectPayload = JSON.stringify({ type: 'InjectUserMessage', content });
        if (!settingsApplied) {
          pendingInjectedMessages.push(injectPayload);
        } else if (dgWs && dgWs.readyState === WebSocket.OPEN) {
          lastUserTurnTs = Date.now();
          awaitingFirstAudioForTurn = true;
          dgWs.send(injectPayload);
        }
        return;
      }

      if (msg.type === 'start' && !started) {
        started = true;
        const startMsg = msg as SimulatorStartMessage;
        activeState = startMsg.draftState ? normalizeState(startMsg.draftState) : getConsoleState();
        activeAgent =
          activeState.agents.find((a) => a.id === startMsg.agentId) || activeState.agents[0];
        activeCampaign = startMsg.campaignId
          ? activeState.campaigns.find((c) => c.id === startMsg.campaignId)
          : activeState.campaigns.find((c) => c.agentId === activeAgent!.id);

        const bandwidth = startMsg.bandwidth === 'telephony' ? 'telephony' : 'wideband';
        sampleRateIn = bandwidth === 'telephony' ? 8000 : 16000;
        sampleRateOut = bandwidth === 'telephony' ? 8000 : 24000;

        const displaySettings = buildDeepgramSettings(activeState, activeAgent, activeCampaign);
        const rawSettings = buildDeepgramSettings(activeState, activeAgent, activeCampaign, {
          forceClientSideWebhooks: true,
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

        const wireSettings = interpolateEnvPlaceholders(rawSettings);

        const requestedMode = startMsg.upstreamMode || 'deepgram';
        const customAgentUrl = (process.env.DEEPGRAM_AGENT_URL || '').trim();
        const dgApiKey = getSecret('DEEPGRAM_API_KEY');

        if (requestedMode === 'sandbox') {
          upstreamMode = 'sandbox';
          settingsApplied = true;
          sendClientJson({
            type: 'session_started',
            callId,
            upstreamMode: 'sandbox',
            sampleRateIn,
            sampleRateOut,
            hydratedLead: hydration.hydrated ? hydration.leadSummary : null,
            settings: displaySettings,
          });
          if (hydration.hydrated) {
            recordTranscript(
              'system',
              `Bridge hydrated VICIdial lead #${hydration.leadSummary.lead_id} (${hydration.leadSummary.first_name}, ${hydration.leadSummary.state}, age ${hydration.leadSummary.age})`
            );
          }
          sendClientJson({ type: 'agent_state', state: 'speaking' });
          if (displaySettings.agent.greeting) {
            recordTranscript('assistant', displaySettings.agent.greeting);
            sendClientAudio(synthesizeSandboxTonePcm16(sampleRateOut, 420, 440));
          }
          setTimeout(() => {
            if (!closed) sendClientJson({ type: 'agent_state', state: 'listening' });
          }, 250);
          return;
        }

        upstreamMode = 'deepgram';
        if (!dgApiKey && !customAgentUrl) {
          sendFatalError(
            'MISSING_DEEPGRAM_KEY',
            'DEEPGRAM_API_KEY is not configured on the server. Click "🔑 API Keys" in the top bar and save your Deepgram API key, or select "Sandbox Dry-Run Responder".'
          );
          finalizeCall('missing_api_key');
          return;
        }

        const targetUrl = customAgentUrl || 'wss://agent.deepgram.com/v1/agent/converse';
        const wsHeaders: Record<string, string> = {};
        if (dgApiKey) {
          wsHeaders.Authorization = `Token ${dgApiKey}`;
        }

        sendClientJson({
          type: 'session_connecting',
          callId,
          targetUrl,
          sampleRateIn,
          sampleRateOut,
          hydratedLead: hydration.hydrated ? hydration.leadSummary : null,
          settings: displaySettings,
        });

        dgWs = new WebSocket(targetUrl, { headers: wsHeaders, family: 4 });

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
            sendClientAudio(audioBuf);
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
              settingsApplied = true;
              lastBrowserAudioAt = Date.now();
              sendClientJson({
                type: 'session_started',
                callId,
                upstreamMode: 'deepgram',
                sampleRateIn,
                sampleRateOut,
                hydratedLead: hydration.hydrated ? hydration.leadSummary : null,
                settings: displaySettings,
              });
              if (hydration.hydrated) {
                recordTranscript(
                  'system',
                  `Bridge hydrated VICIdial lead #${hydration.leadSummary.lead_id} (${hydration.leadSummary.first_name}, ${hydration.leadSummary.state}, age ${hydration.leadSummary.age})`
                );
              }
              sendClientJson({ type: 'agent_state', state: 'listening' });

              while (pendingPreSettingsAudio.length > 0) {
                const chunk = pendingPreSettingsAudio.shift()!;
                if (dgWs?.readyState === WebSocket.OPEN) dgWs.send(chunk, { binary: true });
              }
              while (pendingInjectedMessages.length > 0) {
                const injected = pendingInjectedMessages.shift()!;
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
                turns += 1;
                lastUserTurnTs = Date.now();
                awaitingFirstAudioForTurn = true;
                suppressStaleAgentAudio = false;
              } else {
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
              sendClientJson({ type: 'agent_state', state: 'listening' });
              if (awaitingHangupAudioDone) {
                finalizeCall('bot_end_call');
              }
              break;
            }

            case 'FunctionCallCancelled': {
              const cancelledId = evt.id || evt.function_call_id;
              if (cancelledId) {
                cancelledFnIds.add(String(cancelledId));
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
              for (const fnItem of list) {
                executeClientFunction(fnItem);
              }
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
