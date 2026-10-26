"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createDefaultState = createDefaultState;
exports.normalizeState = normalizeState;
const makeProvider = (id, kind, name, type, models, overrides = {}) => ({
    id,
    kind,
    name,
    type,
    models,
    endpoint: '',
    headers: '{}',
    extra: '{}',
    mk: 'model',
    ...overrides,
});
const makeFn = (id, name, description, params, overrides = {}) => ({
    id,
    name,
    description,
    params: JSON.stringify(params, null, 2),
    defer: false,
    url: '',
    method: 'post',
    headers: '{}',
    ...overrides,
});
const objSchema = (properties, required = []) => ({
    type: 'object',
    properties,
    required,
});
function createDefaultState() {
    return {
        version: 3,
        updatedAt: new Date().toISOString(),
        providers: [
            makeProvider('s1', 'stt', 'Deepgram STT', 'deepgram', 'flux-general-en,flux-general-multi,nova-3,nova-2'),
            makeProvider('l1', 'llm', 'OpenAI (Managed)', 'open_ai', 'gpt-4o-mini,gpt-4.1-mini,gpt-5-mini,gpt-5,gpt-4.1,gpt-4o'),
            makeProvider('l2', 'llm', 'Anthropic (Managed)', 'anthropic', 'claude-haiku-4-5,claude-sonnet-4-5,claude-sonnet-4-6'),
            makeProvider('l3', 'llm', 'Google Gemini (Managed)', 'google', 'gemini-2.5-flash,gemini-3.5-flash,gemini-3.1-flash-lite'),
            makeProvider('l4', 'llm', 'Groq (BYO Endpoint)', 'groq', 'llama-3.3-70b-versatile', {
                endpoint: 'https://api.groq.com/openai/v1/chat/completions',
                headers: '{"authorization":"Bearer {{GROQ_API_KEY}}"}',
            }),
            makeProvider('t1', 'tts', 'Deepgram TTS (Flux v2 & Aura v1)', 'deepgram', 'flux-haley-en,flux-kit-en,flux-alexis-en,flux-sienna-en,flux-miles-en,aura-2-thalia-en,aura-2-andromeda-en,aura-2-apollo-en'),
            makeProvider('t2', 'tts', 'ElevenLabs (BYO Streaming)', 'eleven_labs', 'eleven_turbo_v2_5,eleven_v3', {
                mk: 'model_id',
                endpoint: 'wss://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM/multi-stream-input',
                headers: '{"xi-api-key":"{{ELEVENLABS_API_KEY}}"}',
                extra: '{"language_code":"en-US"}',
            }),
            makeProvider('t3', 'tts', 'Cartesia (Deepgram Managed)', 'cartesia', 'sonic-2,sonic-3', {
                mk: 'model_id',
                headers: '{}',
                extra: '{"voice":{"mode":"id","id":"a167e0f3-df7e-4d52-a9c3-f949145efdab"}}',
            }),
            makeProvider('t4', 'tts', 'Cartesia (BYO Endpoint)', 'cartesia', 'sonic-2', {
                mk: 'model_id',
                endpoint: 'https://api.cartesia.ai/tts/bytes',
                headers: '{"x-api-key":"{{CARTESIA_API_KEY}}"}',
                extra: '{"voice":{"mode":"id","id":"a167e0f3-df7e-4d52-a9c3-f949145efdab"},"language":"en"}',
            }),
        ],
        functions: [
            makeFn('fn_xfer', 'transfer_to_live_agent', 'Transfer the call to a live licensed specialist/closer once eligibility criteria are verified, passing structured metadata (Name, Age, Medicare Status, Hook Type)', objSchema({
                reason: { type: 'string', description: 'Short qualification summary passed to the live closer' },
                prospect_name: { type: 'string', description: 'Prospect first/full name if known or stated' },
                confirmed_age: { type: 'string', description: 'Confirmed age of the prospect (e.g. "71")' },
                medicare_status: { type: 'string', description: 'Confirmed Medicare status (e.g. "Part A & B", "Part A", "Part B")' },
                hook_type: { type: 'string', description: 'Value proposition hook used on this call (e.g. "Food & OTC Card")' },
            }, ['reason']), { defer: true }),
            makeFn('fn_dispo', 'set_disposition', 'Record the call outcome disposition code in VICIdial before ending or transferring the call', objSchema({
                code: {
                    type: 'string',
                    description: 'VICIdial disposition status code (e.g. XFER, DQ, LANG, DNC, NI, NA, CALLBK, DEC)',
                },
                notes: { type: 'string', description: 'Optional call summary note saved to the lead record' },
            }, ['code'])),
            makeFn('fn_end', 'end_call', 'Politely end the call and hang up the telephony channel', objSchema({}), { defer: true }),
        ],
        agents: [
            {
                id: 'a1',
                name: 'Final Expense Fronter',
                mode: 'outbound',
                language: 'en',
                greeting: 'Hi, this is Sarah calling about the final expense coverage you requested. Do you have a quick minute?',
                prompt: 'You are Sarah, a warm, concise outbound insurance fronter.\n' +
                    'Goal: confirm the lead is between ages 50 and 85, currently lacks sufficient final expense coverage, and wants a quick quote from a licensed specialist.\n' +
                    'Rules:\n' +
                    '- Keep every response under 2 short conversational sentences.\n' +
                    '- Never quote dollar prices or guarantee eligibility.\n' +
                    '- Note: Call connection and VICIdial lead context ({{lead_id}}, {{first_name}}, {{state}}) are automatically hydrated by the bridge when the call connects.\n' +
                    '- Once the lead confirms qualification and interest, call set_disposition with code "XFER" and call transfer_to_live_agent.\n' +
                    '- If the lead says stop, take me off your list, not interested, or do not call, apologise politely, call set_disposition with "DNC" (or "NI"), and call end_call immediately.',
                acceptViciCalls: true,
                injectCampaignDisclosure: true,
                stt: {
                    p: 's1',
                    model: 'flux-general-en',
                    keyterms: 'final expense, burial insurance, Medicare, beneficiary',
                    eot: 0.7,
                    eager: 0.5,
                    eotms: 5000,
                    smartFormat: false,
                },
                llm: {
                    p: 'l1',
                    model: 'gpt-4o-mini',
                    temp: 0.7,
                    reasoning: 'low',
                    ctx: '',
                },
                tts: {
                    p: 't1',
                    model: 'flux-haley-en',
                    speed: 1.0,
                    expr: 0,
                },
                audio: {
                    inEnc: 'linear16',
                    inRate: 8000,
                    outEnc: 'linear16',
                    outRate: 8000,
                },
                fnIds: ['fn_xfer', 'fn_dispo', 'fn_end'],
            },
            {
                id: 'a_medicare',
                name: 'Medicare — Food & OTC Advisor',
                mode: 'outbound',
                language: 'en,es',
                greeting: 'Hi, this is Haley calling from the Benefits Department. Your new food and OTC card is on hold right now, loaded with funds for groceries and dental. If unclaimed today, it gets returned to the state pool. To release your card immediately, do you have Medicare Part A and B?',
                prompt: 'You are Haley, an Outbound Benefits Advisor / Lead Qualification Bot calling from the Benefits Department (representing US Health Care).\n' +
                    'Primary Objective: Engage Medicare beneficiaries with the Food & OTC Card activation hook, strictly verify eligibility, and live-transfer qualified prospects to a certified benefit specialist.\n\n' +
                    '=== 1. STRICT VERIFICATION GATE (HARD STOP) ===\n' +
                    'A prospect ONLY qualifies for live transfer if BOTH conditions are true:\n' +
                    '1) Possesses Medicare Part A or Part B (either Part A, Part B, or both Part A & B).\n' +
                    '2) Current age stated by the prospect on the call is strictly between 65 and 85 years old (65 <= age <= 85).\n' +
                    'Always ask and trust the prospect\'s spoken current age rather than any pre-filled lead file age (file records may be outdated or blank).\n' +
                    'Never transfer anyone under 65, over 85, or without Medicare Part A/B.\n\n' +
                    '=== 2. SCRIPTED FLOW & DIALOGUE TREE ===\n' +
                    '- Phase 1 (Delivered in Greeting — Food & OTC Card Hook):\n' +
                    '  You already asked if they have Medicare Part A and B to release their Food & OTC card.\n' +
                    '- Phase 2 (Qualification Check — Part A/B & Age):\n' +
                    '  * If user confirms Medicare Part A/B ("Yes", "I think so", "Both", "Part A", "Part B") and has NOT yet stated their age, ask verbatim:\n' +
                    '    "Wonderful. Just to confirm your state eligibility profile for the file update, what is your current age?"\n' +
                    '  * If user already stated BOTH Medicare Part A/B AND a qualifying age (65–85) in the same turn, skip redundant questions and go straight to Phase 4 Transfer.\n' +
                    '  * If user does NOT have Medicare Part A or B, OR if Age < 65 or Age > 85:\n' +
                    '    Disqualify gracefully and politely ("Thank you for checking in with me! Right now this state allowance release requires active Medicare Part A or B between ages 65 and 85, so we cannot release the card today. Have a wonderful rest of your day!"), call set_disposition with code "DQ" (notes: reason for disqualification), and call end_call.\n\n' +
                    '=== 3. OBJECTION HANDLING & FALLBACK GUIDELINES ===\n' +
                    '- Scenario A — Language Barrier (Spanish or Non-English Speakers):\n' +
                    '  If speech recognition detects Spanish (e.g., "Hablo español", "No hablo inglés", "¿Quién habla?", "No entiendo") or any non-English language, or the prospect states they do not speak English:\n' +
                    '  IMMEDIATELY call set_disposition with code "LANG" (notes: "Language Barrier - Non-English speaker") and call end_call. Keep sign-off to one brief polite phrase ("Apologies, have a great day.") and hang up immediately.\n' +
                    '- Scenario B — Hostility / Do-Not-Call Resistance ("Stop calling my phone", "Take me off your list", "Do not call"):\n' +
                    '  Trigger immediate compliance protocol with NO rebuttal. Speak verbatim:\n' +
                    '  "I completely understand, and I apologize for the intrusion. I will remove your number from our active outreach list immediately. Have a great day."\n' +
                    '  Call set_disposition with code "DNC" and call end_call immediately.\n' +
                    '- Scenario C — Skepticism / "Is this a scam?" / "Is this a sales pitch?":\n' +
                    '  Speak verbatim:\n' +
                    '  "I understand your caution! This isn\'t a bill or a sales pitch—this is a review of the state-approved supplemental allowances and credits available under your current Medicare Part A and B coverage. It takes less than a minute to verify if your zip code is approved."\n' +
                    '  Then briefly re-ask whichever verification question (Medicare Part A/B or Age) is still needed.\n\n' +
                    '=== 4. PHASE 4: CALL TRANSFERRING TRIGGERS ===\n' +
                    'Once BOTH criteria are confirmed (Medicare Part A or B + Age 65–85):\n' +
                    '1) Call set_disposition with code "XFER" and notes summarizing age and Medicare status.\n' +
                    '2) Call transfer_to_live_agent with:\n' +
                    '   - reason: "Qualified Medicare beneficiary ready for Food & OTC benefit review"\n' +
                    '   - prospect_name: "{{first_name}}"\n' +
                    '   - confirmed_age: "<confirmed age>"\n' +
                    '   - medicare_status: "Medicare Part A & B" (or whichever Part confirmed)\n' +
                    '   - hook_type: "Food & OTC Card"\n' +
                    '3) Speak verbatim:\n' +
                    '   "All right, everything looks good on my end. Let me quickly connect you with a certified benefit specialist on the line who will review your updated benefits with you. Just hold for one moment, here you go!"',
                acceptViciCalls: true,
                injectCampaignDisclosure: false,
                stt: {
                    p: 's1',
                    model: 'flux-general-multi',
                    keyterms: 'Medicare, Part A, Part B, OTC card, groceries, dental, Benefits Department, Hablo español',
                    eot: 0.65,
                    eager: 0.45,
                    eotms: 2000,
                    smartFormat: false,
                },
                llm: {
                    p: 'l1',
                    model: 'gpt-4o-mini',
                    temp: 0.4,
                    reasoning: 'low',
                    ctx: '',
                },
                tts: {
                    p: 't1',
                    model: 'flux-haley-en',
                    speed: 1.0,
                    expr: 0,
                },
                audio: {
                    inEnc: 'linear16',
                    inRate: 8000,
                    outEnc: 'linear16',
                    outRate: 8000,
                },
                fnIds: ['fn_xfer', 'fn_dispo', 'fn_end'],
            },
        ],
        campaigns: [
            {
                id: 'c1',
                name: 'FE Fronter – Test',
                agentId: 'a1',
                viciCampaign: 'FETEST',
                lists: '1001',
                start: '09:00',
                end: '20:00',
                tz: 'America/New_York',
                attempts: 3,
                retry: 120,
                maxCalls: 10,
                xferType: 'ingroup',
                xferTarget: 'FE_CLOSERS',
                fallback: 'Dispo CALLBK',
                dnc: true,
                disclosure: 'This call may be recorded for quality purposes.',
                dispos: 'XFER,NI,DNC,NA,CALLBK,DEC',
            },
            {
                id: 'c_medicare',
                name: 'Medicare — Food & OTC Outbound',
                agentId: 'a_medicare',
                viciCampaign: 'MEDICARE',
                lists: '2001,2002',
                start: '09:00',
                end: '20:00',
                tz: 'America/New_York',
                attempts: 3,
                retry: 120,
                maxCalls: 15,
                xferType: 'ingroup',
                xferTarget: 'MED_CLOSERS',
                fallback: 'Dispo CALLBK',
                dnc: true,
                disclosure: 'This call may be recorded for quality and benefit verification.',
                dispos: 'XFER,DQ,LANG,DNC,NI,NA,CALLBK',
            },
        ],
        vici: {
            viciBaseUrl: 'http://127.0.0.1',
            nonAgentApiPath: '/vicidial/non_agent_api.php',
            agentApiPath: '/agc/api.php',
            apiUser: '6666',
            source: 'aibot',
            transport: 'sip_trunk',
            bridgeHost: '127.0.0.1',
            bridgePort: 9092,
            sipPort: 5062,
            aiExten: '8800',
            remoteAgentUser: '9001',
            inIngroup: 'AI_INBOUND',
            amiHost: '127.0.0.1',
            amiPort: 5038,
            amiUser: 'cron',
        },
        tests: {
            a1: [
                {
                    id: 't_1',
                    s: 'Lead says "I’m interested, tell me more"',
                    e: 'Bot confirms age (50–85) and coverage need, sets XFER dispo, then calls transfer_to_live_agent',
                    r: 'p',
                    n: '',
                },
                {
                    id: 't_2',
                    s: 'Lead says "Take me off your list"',
                    e: 'Bot apologises once, calls set_disposition("DNC"), and calls end_call with no rebuttal pitch',
                    r: 'p',
                    n: '',
                },
                {
                    id: 't_3',
                    s: 'Lead asks "How much does it cost per month?"',
                    e: 'Bot defers pricing to the licensed specialist without quoting any dollar figure',
                    r: 'p',
                    n: '',
                },
                {
                    id: 't_4',
                    s: 'Lead stays silent for 8 seconds',
                    e: 'Bot checks in politely once, then dispositions NA/CALLBK and ends call cleanly',
                    r: 'p',
                    n: '',
                },
            ],
            a_medicare: [
                {
                    id: 'tm_1',
                    s: 'Lead says "Yes, I have Medicare Part A and Part B"',
                    e: 'Phase 2: Bot asks verbatim "Wonderful. Just to confirm your state eligibility profile for the file update, what is your current age?"',
                    r: 'p',
                    n: '',
                },
                {
                    id: 'tm_2',
                    s: 'Lead says "Yes I have Medicare Part A and B, and I am 71 years old"',
                    e: 'Phase 4: Calls set_disposition("XFER") + transfer_to_live_agent (Age 71, Part A & B, Food & OTC Card) and speaks exact specialist handoff script',
                    r: 'p',
                    n: '',
                },
                {
                    id: 'tm_3',
                    s: 'Lead says "Yes I have Medicare, I am 61 years old"',
                    e: 'Hard Stop (<65): Disqualifies gracefully, calls set_disposition("DQ"), and calls end_call without transferring',
                    r: 'p',
                    n: '',
                },
                {
                    id: 'tm_4',
                    s: 'Lead says "No hablo inglés, solo hablo español"',
                    e: 'Scenario A (Language Barrier): Immediately calls set_disposition("LANG") and end_call to terminate cleanly',
                    r: 'p',
                    n: '',
                },
                {
                    id: 'tm_5',
                    s: 'Lead says "Stop calling my phone right now!"',
                    e: 'Scenario B (Hostility/DNC): Speaks exact apology compliance script, calls set_disposition("DNC"), and calls end_call',
                    r: 'p',
                    n: '',
                },
                {
                    id: 'tm_6',
                    s: 'Lead asks "Is this a scam? Why are you calling me?"',
                    e: 'Scenario C (Skepticism): Explains it is a review of state-approved supplemental allowances under Part A & B (not a bill/sales pitch)',
                    r: 'p',
                    n: '',
                },
            ],
        },
    };
}
/**
 * Normalizes / migrates incoming state (including legacy vac-v2 JSON exports from the old HTML prototype)
 * so numbers are coerced to real numbers, unique IDs exist, and legacy function names map to fnIds.
 */
function normalizeState(raw) {
    const base = createDefaultState();
    if (!raw || typeof raw !== 'object')
        return base;
    const src = raw.console && typeof raw.console === 'object' ? raw.console : raw;
    const usedFnIds = new Set();
    const functions = Array.isArray(src.functions) && src.functions.length
        ? src.functions
            .filter((f) => f?.name !== 'accept_vicidial_call') // Migrate legacy anti-pattern out of LLM tools
            .map((f, idx) => {
            let id = String(f.id || `fn_${idx + 1}`);
            if (usedFnIds.has(id) || id === 'f_new_function') {
                id = `fn_${Date.now().toString(36)}_${idx}`;
            }
            usedFnIds.add(id);
            return {
                id,
                name: String(f.name || `function_${idx + 1}`).trim(),
                description: String(f.description || ''),
                params: typeof f.params === 'string' ? f.params : JSON.stringify(f.params || objSchema({})),
                defer: Boolean(f.defer),
                url: String(f.url || ''),
                method: f.method === 'get' ? 'get' : 'post',
                headers: typeof f.headers === 'string' ? f.headers : JSON.stringify(f.headers || {}),
            };
        })
        : base.functions;
    const fnNameMap = new Map(functions.map((f) => [f.name, f.id]));
    const fnIdSet = new Set(functions.map((f) => f.id));
    const providers = Array.isArray(src.providers) && src.providers.length
        ? src.providers.map((p, idx) => {
            const kind = ['stt', 'llm', 'tts'].includes(p.kind) ? p.kind : 'llm';
            return {
                id: String(p.id || `p_${kind}_${idx + 1}`),
                kind,
                name: String(p.name || `Provider ${idx + 1}`),
                type: kind === 'stt' ? 'deepgram' : String(p.type || 'open_ai'),
                models: String(p.models || ''),
                endpoint: String(p.endpoint || ''),
                headers: typeof p.headers === 'string' ? p.headers : JSON.stringify(p.headers || {}),
                extra: typeof p.extra === 'string' ? p.extra : JSON.stringify(p.extra || {}),
                mk: p.mk === 'model_id' ? 'model_id' : 'model',
            };
        })
        : base.providers;
    // Ensure at least one provider per kind exists
    for (const kind of ['stt', 'llm', 'tts']) {
        if (!providers.some((p) => p.kind === kind)) {
            const fallback = base.providers.find((p) => p.kind === kind);
            providers.push({ ...fallback });
        }
    }
    const num = (val, fallback) => {
        const n = Number(val);
        return Number.isFinite(n) ? n : fallback;
    };
    const agents = Array.isArray(src.agents) && src.agents.length
        ? src.agents.map((a, idx) => {
            let fnIds = [];
            if (Array.isArray(a.fnIds)) {
                fnIds = a.fnIds.filter((id) => fnIdSet.has(id));
            }
            else if (Array.isArray(a.fns)) {
                fnIds = a.fns.map((name) => fnNameMap.get(name)).filter(Boolean);
            }
            else {
                fnIds = functions.map((f) => f.id);
            }
            const hadLegacyAccept = Array.isArray(a.fns) ? a.fns.includes('accept_vicidial_call') : true;
            return {
                id: String(a.id || `a_${idx + 1}`),
                name: String(a.name || `Agent ${idx + 1}`),
                mode: ['outbound', 'inbound', 'both'].includes(a.mode) ? a.mode : 'outbound',
                language: String(a.language || 'en'),
                greeting: String(a.greeting ?? ''),
                prompt: String(a.prompt ?? '').replace(/When the call connects,\s*call accept_vicidial_call\.?\s*/gi, ''),
                acceptViciCalls: a.acceptViciCalls !== undefined ? Boolean(a.acceptViciCalls) : hadLegacyAccept,
                injectCampaignDisclosure: a.injectCampaignDisclosure !== undefined ? Boolean(a.injectCampaignDisclosure) : true,
                stt: {
                    p: String(a.stt?.p || providers.find((p) => p.kind === 'stt').id),
                    model: String(a.stt?.model || 'flux-general-en'),
                    keyterms: String(a.stt?.keyterms ?? ''),
                    eot: num(a.stt?.eot, 0.7),
                    eager: num(a.stt?.eager, 0.5),
                    eotms: Math.round(num(a.stt?.eotms, 5000)),
                    smartFormat: Boolean(a.stt?.smartFormat),
                },
                llm: {
                    p: String(a.llm?.p || providers.find((p) => p.kind === 'llm').id),
                    model: String(a.llm?.model || 'gpt-5-mini'),
                    temp: num(a.llm?.temp, 0.7),
                    reasoning: ['low', 'medium', 'high'].includes(a.llm?.reasoning) ? a.llm.reasoning : 'low',
                    ctx: String(a.llm?.ctx ?? ''),
                },
                tts: {
                    p: String(a.tts?.p || providers.find((p) => p.kind === 'tts').id),
                    model: String(a.tts?.model || 'flux-haley-en'),
                    speed: num(a.tts?.speed, 1.0),
                    expr: Math.round(num(a.tts?.expr, 0)),
                },
                audio: {
                    inEnc: ['linear16', 'mulaw', 'alaw'].includes(a.audio?.inEnc) ? a.audio.inEnc : 'linear16',
                    inRate: Math.round(num(a.audio?.inRate, 8000)),
                    outEnc: ['linear16', 'mulaw', 'alaw'].includes(a.audio?.outEnc) ? a.audio.outEnc : 'linear16',
                    outRate: Math.round(num(a.audio?.outRate, 8000)),
                },
                fnIds,
            };
        })
        : base.agents;
    const campaigns = Array.isArray(src.campaigns) && src.campaigns.length
        ? src.campaigns.map((c, idx) => ({
            id: String(c.id || `c_${idx + 1}`),
            name: String(c.name || `Campaign ${idx + 1}`),
            agentId: String(c.agentId || agents[0].id),
            viciCampaign: String(c.viciCampaign ?? ''),
            lists: String(c.lists ?? ''),
            start: String(c.start || '09:00'),
            end: String(c.end || '20:00'),
            tz: String(c.tz || 'America/New_York'),
            attempts: Math.round(num(c.attempts, 3)),
            retry: Math.round(num(c.retry, 120)),
            maxCalls: Math.round(num(c.maxCalls, 10)),
            xferType: ['ingroup', 'extension', 'number'].includes(c.xferType) ? c.xferType : 'ingroup',
            xferTarget: String(c.xferTarget ?? ''),
            fallback: String(c.fallback ?? ''),
            dnc: Boolean(c.dnc),
            disclosure: String(c.disclosure ?? ''),
            dispos: String(c.dispos ?? 'XFER,NI,DNC,NA,CALLBK,DEC'),
        }))
        : base.campaigns;
    // Migrate legacy vici.apiUrl if present
    let viciBaseUrl = src.vici?.viciBaseUrl;
    if (!viciBaseUrl && typeof src.vici?.apiUrl === 'string') {
        try {
            const u = new URL(src.vici.apiUrl);
            viciBaseUrl = `${u.protocol}//${u.host}`;
        }
        catch {
            viciBaseUrl = base.vici.viciBaseUrl;
        }
    }
    if (viciBaseUrl === 'https://dialer.example.com') {
        viciBaseUrl = 'http://127.0.0.1';
    }
    const rawBridgeHost = src.vici?.bridgeHost === 'bridge.example.com' ? '127.0.0.1' : src.vici?.bridgeHost;
    const rawSipPort = num(src.vici?.sipPort, 5062);
    const vici = {
        viciBaseUrl: String(viciBaseUrl || base.vici.viciBaseUrl).replace(/\/+$/, ''),
        nonAgentApiPath: String(src.vici?.nonAgentApiPath || base.vici.nonAgentApiPath),
        agentApiPath: String(src.vici?.agentApiPath || base.vici.agentApiPath),
        apiUser: String(src.vici?.apiUser === 'apiuser' ? '6666' : src.vici?.apiUser || base.vici.apiUser),
        source: String(src.vici?.source || base.vici.source),
        transport: src.vici?.transport === 'audiosocket' ? 'audiosocket' : 'sip_trunk',
        bridgeHost: String(rawBridgeHost || base.vici.bridgeHost),
        bridgePort: Math.round(num(src.vici?.bridgePort, 9092)),
        sipPort: Math.round(rawSipPort === 5060 && (!rawBridgeHost || rawBridgeHost === '127.0.0.1') ? 5062 : rawSipPort),
        aiExten: String(src.vici?.aiExten || base.vici.aiExten),
        remoteAgentUser: String(src.vici?.remoteAgentUser || base.vici.remoteAgentUser),
        inIngroup: String(src.vici?.inIngroup || base.vici.inIngroup),
        amiHost: String(src.vici?.amiHost || base.vici.amiHost),
        amiPort: Math.round(num(src.vici?.amiPort, 5038)),
        amiUser: String(src.vici?.amiUser === 'bridge' ? 'cron' : src.vici?.amiUser || base.vici.amiUser),
    };
    const tests = {};
    if (src.tests && typeof src.tests === 'object') {
        for (const [aid, list] of Object.entries(src.tests)) {
            if (Array.isArray(list)) {
                tests[aid] = list.map((item, idx) => ({
                    id: String(item.id || `t_${aid}_${idx + 1}`),
                    s: String(item.s ?? ''),
                    e: String(item.e ?? ''),
                    r: ['p', 'ok', 'f'].includes(item.r) ? item.r : 'p',
                    n: String(item.n ?? ''),
                }));
            }
        }
    }
    return {
        version: 3,
        updatedAt: new Date().toISOString(),
        providers,
        functions,
        agents,
        campaigns,
        vici,
        tests,
    };
}
