"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isPlainObject = isPlainObject;
exports.parseJsonObject = parseJsonObject;
exports.parseJsonSchema = parseJsonSchema;
exports.isValidFluxSpeed = isValidFluxSpeed;
exports.buildDeepgramSettings = buildDeepgramSettings;
exports.validateAgent = validateAgent;
exports.validateCampaign = validateCampaign;
exports.validateState = validateState;
exports.diffStates = diffStates;
exports.generateViciConfig = generateViciConfig;
function isPlainObject(val) {
    return typeof val === 'object' && val !== null && !Array.isArray(val);
}
function parseJsonObject(raw) {
    const trimmed = (raw ?? '').trim();
    if (!trimmed) {
        return { ok: true, value: {} };
    }
    try {
        const parsed = JSON.parse(trimmed);
        if (!isPlainObject(parsed)) {
            return { ok: false, error: 'Must be a JSON object {...}, not an array or primitive' };
        }
        return { ok: true, value: parsed };
    }
    catch (err) {
        return { ok: false, error: err?.message || 'Invalid JSON syntax' };
    }
}
function parseJsonSchema(raw) {
    const trimmed = (raw ?? '').trim();
    if (!trimmed) {
        return { ok: true, value: { type: 'object', properties: {} } };
    }
    const res = parseJsonObject(trimmed);
    if (!res.ok)
        return res;
    if (res.value.type !== 'object' || (res.value.properties !== undefined && !isPlainObject(res.value.properties))) {
        return {
            ok: false,
            error: 'Function parameters schema must have {"type":"object","properties":{...}}',
        };
    }
    const reqList = Array.isArray(res.value.required) ? res.value.required.filter(Boolean) : [];
    return {
        ok: true,
        value: {
            type: 'object',
            properties: res.value.properties || {},
            ...(reqList.length > 0 ? { required: reqList } : {}),
        },
    };
}
function isValidFluxSpeed(speed) {
    if (!Number.isFinite(speed) || speed < 0.5 || speed > 1.5)
        return false;
    const scaled = Math.round(speed * 20);
    return Math.abs(speed * 20 - scaled) < 1e-6;
}
function buildDeepgramSettings(state, agent, explicitCampaign, options) {
    const sp = state.providers.find((p) => p.id === agent.stt.p) || {};
    const lp = state.providers.find((p) => p.id === agent.llm.p) || {};
    const tp = state.providers.find((p) => p.id === agent.tts.p) || {};
    const linkedCampaign = explicitCampaign || state.campaigns.find((c) => c.agentId === agent.id);
    // 1. Listen (STT)
    const listenProvider = {
        type: sp.type || 'deepgram',
        model: agent.stt.model,
    };
    if (listenProvider.type === 'deepgram') {
        const isFluxStt = agent.stt.model.startsWith('flux');
        if (isFluxStt) {
            listenProvider.version = 'v2';
            listenProvider.eot_threshold = Number(agent.stt.eot);
            listenProvider.eager_eot_threshold = Number(agent.stt.eager);
            listenProvider.eot_timeout_ms = Math.round(Number(agent.stt.eotms));
            if (agent.stt.model === 'flux-general-multi' && agent.language) {
                listenProvider.language_hints = agent.language
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean);
            }
        }
        else {
            listenProvider.version = 'v1';
            if (agent.language)
                listenProvider.language = agent.language;
            if (agent.stt.smartFormat)
                listenProvider.smart_format = true;
        }
        const keyterms = (agent.stt.keyterms || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        if (keyterms.length > 0) {
            listenProvider.keyterms = keyterms;
        }
    }
    const spExtra = parseJsonObject(sp.extra || '{}');
    if (spExtra.ok)
        Object.assign(listenProvider, spExtra.value);
    // 2. Think (LLM)
    const isGoogleByo = lp.type === 'google' && Boolean(lp.endpoint?.trim());
    const thinkProvider = {
        type: lp.type || 'open_ai',
    };
    // Deepgram BYO Google rule: omit `model` when custom endpoint URL is set
    if (!isGoogleByo) {
        thinkProvider.model = agent.llm.model;
    }
    if (lp.type === 'open_ai' && /^gpt-5/.test(agent.llm.model)) {
        thinkProvider.reasoning_mode = agent.llm.reasoning;
    }
    else {
        thinkProvider.temperature = Number(agent.llm.temp);
    }
    const lpExtra = parseJsonObject(lp.extra || '{}');
    if (lpExtra.ok)
        Object.assign(thinkProvider, lpExtra.value);
    const campaignDispos = (linkedCampaign?.dispos || '')
        .split(',')
        .map((d) => d.trim())
        .filter(Boolean);
    const fns = agent.fnIds
        .map((id) => state.functions.find((f) => f.id === id))
        .filter((f) => Boolean(f))
        .map((f) => {
        const schemaRes = parseJsonSchema(f.params);
        const parameters = schemaRes.ok
            ? JSON.parse(JSON.stringify(schemaRes.value))
            : { type: 'object', properties: {} };
        // Wire campaign dispositions directly into set_disposition enum
        if (f.name === 'set_disposition' && campaignDispos.length > 0 && parameters.properties?.code) {
            parameters.properties.code = {
                ...parameters.properties.code,
                enum: campaignDispos,
            };
        }
        const fnDef = {
            name: f.name,
            description: f.description,
            parameters,
        };
        if (f.defer)
            fnDef.defer_until_eot = true;
        if (f.url && f.url.trim() && !options?.forceClientSideWebhooks) {
            const hdrs = parseJsonObject(f.headers);
            fnDef.endpoint = {
                url: f.url.trim(),
                method: f.method,
                headers: hdrs.ok ? hdrs.value : {},
            };
        }
        return fnDef;
    });
    const think = {
        provider: thinkProvider,
        prompt: agent.prompt,
        functions: fns,
    };
    if (lp.endpoint && lp.endpoint.trim()) {
        const hdrs = parseJsonObject(lp.headers || '{}');
        think.endpoint = {
            url: lp.endpoint.trim(),
            headers: hdrs.ok ? hdrs.value : {},
        };
        if (agent.llm.ctx && String(agent.llm.ctx).trim()) {
            const rawCtx = String(agent.llm.ctx).trim();
            think.context_length = rawCtx === 'max' || Number.isNaN(Number(rawCtx)) ? rawCtx : Number(rawCtx);
        }
    }
    // 3. Speak (TTS)
    const speakProvider = {
        type: tp.type || 'deepgram',
    };
    const modelKey = tp.type === 'deepgram' || tp.type === 'open_ai' ? 'model' : tp.mk || 'model_id';
    if (tp.type !== 'aws_polly') {
        speakProvider[modelKey] = agent.tts.model;
    }
    if (tp.type === 'deepgram') {
        const isFluxTts = agent.tts.model.startsWith('flux');
        speakProvider.version = isFluxTts ? 'v2' : 'v1';
        speakProvider.speed = Number(agent.tts.speed);
        if (isFluxTts && Number(agent.tts.expr) !== 0) {
            speakProvider.expressivity = Math.round(Number(agent.tts.expr));
        }
    }
    else if (tp.type === 'cartesia') {
        speakProvider.speed = Number(agent.tts.speed);
    }
    const tpExtra = parseJsonObject(tp.extra || '{}');
    if (tpExtra.ok) {
        const extraCopy = { ...tpExtra.value };
        // Deepgram TTS rejects `language` with UNPARSABLE_CLIENT_MESSAGE
        if (tp.type === 'deepgram') {
            delete extraCopy.language;
        }
        Object.assign(speakProvider, extraCopy);
    }
    const speak = { provider: speakProvider };
    if (tp.endpoint && tp.endpoint.trim()) {
        const hdrs = parseJsonObject(tp.headers || '{}');
        speak.endpoint = {
            url: tp.endpoint.trim(),
            headers: hdrs.ok ? hdrs.value : {},
        };
    }
    // Greeting + optional Campaign Recording Disclosure injection
    let finalGreeting = agent.greeting.trim();
    if (agent.injectCampaignDisclosure &&
        linkedCampaign?.disclosure?.trim() &&
        !finalGreeting.toLowerCase().includes(linkedCampaign.disclosure.trim().toLowerCase())) {
        finalGreeting = `${linkedCampaign.disclosure.trim()} ${finalGreeting}`.trim();
    }
    return {
        type: 'Settings',
        tags: ['voice-console', agent.mode, ...(linkedCampaign?.viciCampaign ? [linkedCampaign.viciCampaign] : [])],
        audio: {
            input: {
                encoding: agent.audio.inEnc,
                sample_rate: Number(agent.audio.inRate),
            },
            output: {
                encoding: agent.audio.outEnc,
                sample_rate: Number(agent.audio.outRate),
                container: 'none',
            },
        },
        agent: {
            listen: { provider: listenProvider },
            think,
            speak,
            greeting: finalGreeting,
        },
    };
}
function validateAgent(state, agent) {
    const items = [];
    const push = (ok, message, warnOnly = false) => {
        items.push({
            level: ok ? 'ok' : warnOnly ? 'wn' : 'er',
            icon: ok ? '✓' : warnOnly ? '!' : '✗',
            scope: `Agent "${agent.name}"`,
            message,
        });
    };
    const sp = state.providers.find((p) => p.id === agent.stt.p);
    const lp = state.providers.find((p) => p.id === agent.llm.p);
    const tp = state.providers.find((p) => p.id === agent.tts.p);
    push(Boolean(sp && lp && tp), 'STT, LLM and TTS plug-ins exist and are linked');
    if (!sp || !lp || !tp)
        return items;
    // STT validations
    push(sp.type === 'deepgram', 'STT provider type is "deepgram" (only Deepgram is supported by Voice Agent API)');
    push(agent.greeting.trim().length > 10, 'Greeting is set (> 10 chars)');
    const maxPromptOk = lp.endpoint.trim()
        ? agent.prompt.trim().length > 0
        : agent.prompt.trim().length > 0 && agent.prompt.length <= 25000;
    push(maxPromptOk, 'System prompt is non-empty and within Deepgram 25,000-char managed limit');
    if (agent.stt.model.startsWith('flux')) {
        const eot = Number(agent.stt.eot);
        const eager = Number(agent.stt.eager);
        const eotms = Number(agent.stt.eotms);
        push(eot >= 0.5 && eot <= 1.0, `Flux STT eot_threshold (${eot}) is within 0.5–1.0`);
        push(eager >= 0.3 && eager <= 0.9, `Flux STT eager_eot_threshold (${eager}) is within 0.3–0.9`);
        push(eager <= eot, `eager_eot_threshold (${eager}) ≤ eot_threshold (${eot})`);
        push(Number.isInteger(eotms) && eotms >= 500, `eot_timeout_ms (${eotms} ms) is a valid integer ≥ 500`);
        push(!agent.stt.smartFormat, 'smart_format is disabled (not supported with Flux v2 STT)');
    }
    // LLM validations (Google is managed by Deepgram; only groq and aws_bedrock require BYO endpoint)
    const llmNeedsEndpoint = ['groq', 'aws_bedrock'].includes(lp.type);
    push(!llmNeedsEndpoint || Boolean(lp.endpoint.trim()), `LLM endpoint configured where required (${lp.type})`);
    push(!agent.llm.ctx.trim() || Boolean(lp.endpoint.trim()), 'Custom context_length only set when BYO LLM endpoint is configured', true);
    // TTS validations
    const ttsNeedsEndpoint = !['deepgram', 'cartesia'].includes(tp.type);
    push(!ttsNeedsEndpoint || Boolean(tp.endpoint.trim()), `TTS endpoint configured where required (${tp.type})`);
    if (tp.type === 'deepgram') {
        const isFluxTts = agent.tts.model.startsWith('flux');
        const spd = Number(agent.tts.speed);
        const expr = Number(agent.tts.expr);
        if (isFluxTts) {
            push(isValidFluxSpeed(spd), `Flux TTS speed (${spd}) is in 0.5–1.5 with 0.05 increments`);
            push(Number.isInteger(expr) && expr >= -2 && expr <= 2, `Flux TTS expressivity (${expr}) is a whole integer between -2 and 2`);
        }
        else {
            push(spd >= 0.7 && spd <= 1.5, `Aura TTS speed (${spd}) is within 0.7–1.5`);
        }
    }
    const hasPlaceholderVoice = tp.endpoint.includes('{voice_id}') || tp.extra.includes('"VOICE_ID"');
    push(!hasPlaceholderVoice, 'TTS endpoint/extra has no unreplaced {voice_id} or VOICE_ID placeholder', true);
    // JSON syntax & object schema checks
    const providersValidJson = [sp, lp, tp].every((p) => parseJsonObject(p.headers).ok && parseJsonObject(p.extra).ok);
    const fnsForAgent = agent.fnIds
        .map((id) => state.functions.find((f) => f.id === id))
        .filter((f) => Boolean(f));
    const fnsValidJson = fnsForAgent.every((f) => parseJsonSchema(f.params).ok && parseJsonObject(f.headers).ok);
    push(providersValidJson && fnsValidJson, 'All linked plug-in JSON objects and function JSON schemas are valid');
    // Call lifecycle & compliance checks
    const fnNames = fnsForAgent.map((f) => f.name);
    push(agent.acceptViciCalls, 'Bridge VICIdial call-connect & lead hydration enabled', agent.mode === 'outbound');
    push(fnNames.includes('transfer_to_live_agent'), 'transfer_to_live_agent function enabled');
    push(!fnNames.includes('transfer_to_live_agent') || /transfer_to_live_agent/i.test(agent.prompt), 'System prompt specifies when to call transfer_to_live_agent');
    push(/(dnc|do not call|take me off|stop)/i.test(agent.prompt), 'System prompt handles Do-Not-Call requests');
    push(fnNames.includes('end_call'), 'end_call function enabled');
    push(Number(agent.audio.inRate) === 8000, '8000 Hz input sample rate matches Asterisk/VICIdial telephony', true);
    push(state.campaigns.some((c) => c.agentId === agent.id), 'Assigned to at least one campaign', true);
    return items;
}
function validateCampaign(state, campaign) {
    const items = [];
    const push = (ok, message, warnOnly = false) => {
        items.push({
            level: ok ? 'ok' : warnOnly ? 'wn' : 'er',
            icon: ok ? '✓' : warnOnly ? '!' : '✗',
            scope: `Campaign "${campaign.name}"`,
            message,
        });
    };
    push(Boolean(campaign.viciCampaign.trim()), 'VICIdial campaign ID is set');
    push(Boolean(campaign.xferTarget.trim()), 'Live-agent transfer target (ingroup/extension/number) is set');
    push(Boolean(campaign.dnc), 'DNC scrub is enabled');
    push(Boolean(campaign.disclosure.trim()), 'Call recording disclosure line is present', true);
    push(campaign.start < campaign.end, `Calling window valid (${campaign.start} – ${campaign.end})`);
    push(state.agents.some((a) => a.id === campaign.agentId), 'Assigned bot agent exists');
    return items;
}
function validateState(state) {
    const results = [];
    for (const agent of state.agents) {
        results.push(...validateAgent(state, agent));
    }
    for (const campaign of state.campaigns) {
        results.push(...validateCampaign(state, campaign));
    }
    return results;
}
function diffStates(prev, next) {
    const changes = [];
    const sections = [
        { key: 'agents', label: 'agent' },
        { key: 'campaigns', label: 'campaign' },
        { key: 'providers', label: 'plug-in' },
        { key: 'functions', label: 'function' },
    ];
    for (const { key, label } of sections) {
        const oldMap = new Map(prev[key].map((x) => [x.id, x]));
        const newMap = new Map(next[key].map((x) => [x.id, x]));
        for (const item of next[key]) {
            if (!oldMap.has(item.id)) {
                changes.push(`+ Added ${label}: ${item.name}`);
            }
            else if (JSON.stringify(oldMap.get(item.id)) !== JSON.stringify(item)) {
                const oldItem = oldMap.get(item.id);
                const renameNote = oldItem.name !== item.name ? ` (renamed from "${oldItem.name}")` : '';
                changes.push(`✎ Updated ${label}: ${item.name}${renameNote}`);
            }
        }
        for (const item of prev[key]) {
            if (!newMap.has(item.id)) {
                changes.push(`- Removed ${label}: ${item.name}`);
            }
        }
    }
    if (JSON.stringify(prev.vici) !== JSON.stringify(next.vici)) {
        changes.push('✎ Updated VICIdial / dialer bridge configuration');
    }
    if (JSON.stringify(prev.tests) !== JSON.stringify(next.tests)) {
        changes.push('✎ Updated scenario test cases');
    }
    return changes;
}
function generateViciConfig(state) {
    const v = state.vici;
    const nonAgentUrl = `${v.viciBaseUrl}${v.nonAgentApiPath}`;
    const agentApiUrl = `${v.viciBaseUrl}${v.agentApiPath}`;
    const campaignLines = state.campaigns
        .map((c, idx) => {
        const ag = state.agents.find((a) => a.id === c.agentId);
        const ext = `${v.aiExten}${idx + 1}`;
        const xferNote = c.xferType === 'ingroup'
            ? `Agent API ra_call_control (stage=INGROUPTRANSFER, ingroup_choices=${c.xferTarget}) -> preserves Vici lead screen-pop`
            : `Agent API ra_call_control (stage=EXTENSIONTRANSFER, consultative=NO, exten=${c.xferTarget})`;
        return [
            `; [Campaign ${idx + 1}: ${c.name}]`,
            `;   VICIdial Campaign ID : ${c.viciCampaign || '(unset)'} | Lists: ${c.lists || '(none)'} | Max Concurrent: ${c.maxCalls}`,
            `;   Bot Persona          : ${ag ? ag.name : '(missing)'} (${ag?.mode || 'outbound'})`,
            `;   Remote Agent Exten   : ${ext} (Remote Agent User: ${Number(v.remoteAgentUser || 9001) + idx})`,
            `;   Live Closer Transfer : ${xferNote}`,
            `;   Allowed Dispositions : ${c.dispos}`,
        ].join('\n');
    })
        .join('\n;\n');
    const sipCarrierBlock = [
        `; === OPTION A (Universal — Asterisk 13 / 16 / 18+ on ViciBox 8/9/10/11/12): SIP + RTP Mode ===`,
        `; 1) VICIdial Admin -> Admin -> Carriers -> Add New Carrier:`,
        `;    Carrier ID: AIBRIDGE | Registration String: (blank) | Server IP: ALL`,
        `;    Account Entry:`,
        `[ai-bridge]`,
        `disallow=all`,
        `allow=ulaw`,
        `type=friend`,
        `host=${v.bridgeHost}`,
        `port=${v.sipPort}`,
        `dtmfmode=rfc2833`,
        `context=trunkinbound`,
        `qualify=yes`,
        `insecure=port,invite`,
        ``,
        `;    Dialplan Entry (under the same Carrier):`,
        `exten => _${v.aiExten}X.,1,NoOp(VICIdial AI Bot SIP -> Ext \${EXTEN} | ViciCID: \${CALLERID(name)} | Phone: \${CALLERID(num)})`,
        ` same => n,SIPAddHeader(X-Vici-CallName: \${CALLERID(name)})`,
        ` same => n,SIPAddHeader(X-Vici-UniqueID: \${CHANNEL(uniqueid)})`,
        ` same => n,SIPAddHeader(X-Vici-Channel: \${CHANNEL})`,
        ` same => n,SIPAddHeader(X-Vici-Exten: \${EXTEN})`,
        ` same => n,Dial(SIP/\${EXTEN}@ai-bridge,60,tTo)`,
        ` same => n,Hangup()`,
    ].join('\n');
    const audioSocketBlock = [
        `; === OPTION B (Asterisk 18+ on ViciBox 11/12): Native AudioSocket TCP Mode ===`,
        `; Verify module first: asterisk -rx "module show like audiosocket"`,
        `; /api/vici/register-call returns a canonical 36-char RFC4122 UUID & pre-hydrates the VICIdial lead!`,
        `exten => _${v.aiExten}X.,1,NoOp(VICIdial AI Bot AudioSocket -> \${EXTEN} | ViciCID: \${CALLERID(name)})`,
        ` same => n,Answer()`,
        ` same => n,Set(CHANNEL(audioreadformat)=slin)`,
        ` same => n,Set(CHANNEL(audiowriteformat)=slin)`,
        ` same => n,Set(_BRIDGE_UUID=\${CURL(http://${v.bridgeHost}:3000/api/vici/register-call,uniqueid=\${CHANNEL(uniqueid)}&vici_cid=\${URIENCODE(\${CALLERID(name)})}&phone=\${URIENCODE(\${CALLERID(num)})}&exten=\${EXTEN}&channel=\${URIENCODE(\${CHANNEL})})})`,
        ` same => n,AudioSocket(\${_BRIDGE_UUID},${v.bridgeHost}:${v.bridgePort})`,
        ` same => n,Hangup()`,
    ].join('\n');
    const dialplanBlock = v.transport === 'sip_trunk'
        ? `${sipCarrierBlock}\n\n${audioSocketBlock}`
        : `${audioSocketBlock}\n\n${sipCarrierBlock}`;
    return [
        `; ============================================================================`,
        `; VICIdial <-> Voice Agent Bridge Configuration (Active Primary: ${v.transport === 'sip_trunk' ? 'SIP/RTP :' + v.sipPort : 'AudioSocket :' + v.bridgePort})`,
        `; Both listeners (:9092 AudioSocket TCP & :${v.sipPort} SIP/RTP UDP) run simultaneously!`,
        `; ============================================================================`,
        campaignLines,
        ``,
        `; === VICIdial Admin Setup Checklist (Co-Located on ViciBox ${v.bridgeHost}) ===`,
        `; 1. Users -> API User "${v.apiUser}": User Level=8, Modify Leads=1, Modify Lists=1, Agent API Access=1`,
        `; 2. Remote Agents -> Create Remote Agent User ${v.remoteAgentUser} (Lines=${state.campaigns[0]?.maxCalls || 10}, External Exten=${v.aiExten}1, On-Hook=N, Status=ACTIVE)`,
        `; 3. Inbound Groups -> Create Closer In-Group "${state.campaigns[0]?.xferTarget || 'FE_CLOSERS'}" & enable in Campaign "Allowed Transfer Groups"`,
        `; 4. Inbound Routing -> Point "${v.inIngroup}" Drop/No-Agent Action -> EXTENSION ${v.aiExten}1`,
        ``,
        dialplanBlock,
        ``,
        `; === Call Lifecycle Executed by Bridge Server ===`,
        `; 1. On Connect : Extracts 20-char caller_code & lead_id from VICIdial CALLERID(name) (VmmddhhmmssLLLLLLLLL)`,
        `; 2. Hydrate    : GET ${nonAgentUrl}?function=lead_all_info (fallback: lead_field_info) &user=${v.apiUser}&source=${v.source}`,
        `; 3. Converse   : Opens Deepgram Voice Agent WebSocket (8000 Hz) with hydrated lead prompt + campaign disclosure`,
        `; 4. Transfer   : Saves AI qualification notes via update_lead, then GET ${agentApiUrl}?function=ra_call_control&stage=INGROUPTRANSFER|EXTENSIONTRANSFER`,
        `; 5. Dispo/DNC  : Updates status via ${nonAgentUrl} (update_lead + add_dnc_phone) & releases Remote Agent via ${agentApiUrl} (stage=HANGUP)`,
        ``,
        `# === Bridge Server .env (Co-Located on ViciBox) ===`,
        `PORT=3000`,
        `DEEPGRAM_API_KEY=***`,
        `VICI_API_PASS=***`,
        `AMI_SECRET=***`,
        `AUDIOSOCKET_PORT=${v.bridgePort}`,
        `BRIDGE_SIP_PORT=${v.sipPort}`,
    ].join('\n');
}
