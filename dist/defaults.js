"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEEPGRAM_LLM_PROVIDERS = exports.DEEPGRAM_MANAGED_LLM_CATALOG = exports.SPEECH_SERVICE_DEFAULT_VOICES = exports.SPEECH_SERVICE_STT_MODELS = exports.MISSING_CAMPAIGN_RULES = exports.DEFAULT_PRESENCE_CHECK_TEXT = exports.VOICE_AGENT_STT_MODELS = void 0;
exports.defaultVoiceAgentSttModel = defaultVoiceAgentSttModel;
exports.normalizeVoiceAgentSttModel = normalizeVoiceAgentSttModel;
exports.defaultSelfIntroForAgent = defaultSelfIntroForAgent;
exports.deepgramModelsForProviderType = deepgramModelsForProviderType;
exports.createDefaultState = createDefaultState;
exports.normalizeState = normalizeState;
const opening_1 = require("./opening");
// Deepgram Voice Agent listens with either Nova (general purpose) or Flux v2.
// The Voice Agent's own verified baseline is Nova-3; Flux models remain available.
exports.VOICE_AGENT_STT_MODELS = ['nova-3', 'flux-general-en', 'flux-general-multi'];
exports.DEFAULT_PRESENCE_CHECK_TEXT = 'Hello? Are you there? Can you hear me?';
exports.MISSING_CAMPAIGN_RULES = 'REVIEW REQUIRED: Add and review campaign-specific compliance and call rules before deployment.';
exports.SPEECH_SERVICE_STT_MODELS = ['large-v3-turbo', 'whisper-1'];
exports.SPEECH_SERVICE_DEFAULT_VOICES = [
    'af_heart',
    'af_bella',
    'af_nova',
    'af_alloy',
    'af_sarah',
    'af_kore',
    'af_nicole',
    'af_sky',
    'am_adam',
    'am_echo',
    'am_michael',
    'am_onyx',
    'am_liam',
    'bf_alice',
    'bf_emma',
    'bf_isabella',
    'bm_daniel',
    'bm_fable',
    'bm_george',
];
function defaultVoiceAgentSttModel(language) {
    // Nova-3 is multilingual and is the Voice Agent API's default listen model.
    void language;
    return 'nova-3';
}
function normalizeVoiceAgentSttModel(model, language) {
    const value = String(model || '').trim();
    return exports.VOICE_AGENT_STT_MODELS.includes(value)
        ? value
        : defaultVoiceAgentSttModel(language);
}
function defaultSelfIntroForAgent(id, name) {
    if (id === 'a_nova' || /nova|concierge|general/i.test(name)) {
        return "Hi there! I'm Nova, a live Customer Support & Concierge Specialist here on the line. I'm happy to chat naturally and help answer any general knowledge, everyday, or support question you have!";
    }
    if (id === 'a_medicare' || /medicare/i.test(name)) {
        return "Hi! I'm Haley, a live Benefits Advisor calling from the Benefits Department. I help Medicare beneficiaries check their Food and OTC allowance eligibility, and I'm happy to answer any questions you have along the way!";
    }
    if (id === 'a1' || /final expense|sarah/i.test(name)) {
        return "Hi! I'm Sarah, a live Senior Coverage Coordinator. I help folks explore final expense options and connect with our licensed specialists, and I'm always happy to answer your questions too!";
    }
    return `Hi! I'm ${name || 'Alex'}, a live specialist here on the line, happy to chat naturally and help with any questions you have!`;
}
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
exports.DEEPGRAM_MANAGED_LLM_CATALOG = [
    { id: 'gpt-4o-mini', name: 'GPT-4o mini', provider: 'open_ai' },
    { id: 'gpt-4.1-mini', name: 'GPT-4.1 mini', provider: 'open_ai' },
    { id: 'gpt-4.1-nano', name: 'GPT-4.1 nano', provider: 'open_ai' },
    { id: 'gpt-4.1', name: 'GPT-4.1', provider: 'open_ai' },
    { id: 'gpt-4o', name: 'GPT-4o', provider: 'open_ai' },
    { id: 'gpt-5-mini', name: 'GPT-5 mini', provider: 'open_ai' },
    { id: 'gpt-5-nano', name: 'GPT-5 nano', provider: 'open_ai' },
    { id: 'gpt-5', name: 'GPT-5', provider: 'open_ai' },
    { id: 'gpt-5.1', name: 'GPT-5.1 Thinking', provider: 'open_ai' },
    { id: 'gpt-5.2', name: 'GPT 5.2', provider: 'open_ai' },
    { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini', provider: 'open_ai' },
    { id: 'gpt-5.4-nano', name: 'GPT-5.4 nano', provider: 'open_ai' },
    { id: 'gpt-5.4', name: 'GPT 5.4', provider: 'open_ai' },
    { id: 'gpt-5.5', name: 'GPT-5.5', provider: 'open_ai' },
    { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', provider: 'open_ai' },
    { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', provider: 'open_ai' },
    { id: 'gpt-6-luna', name: 'GPT-6 Luna', provider: 'open_ai' },
    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', provider: 'anthropic' },
    { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', provider: 'anthropic' },
    { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', provider: 'anthropic' },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'anthropic' },
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', provider: 'anthropic' },
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', provider: 'anthropic' },
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'google' },
    { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', provider: 'google' },
    { id: 'gemini-3-flash-preview', name: 'Gemini 3.0 Flash Preview', provider: 'google' },
    { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', provider: 'google' },
    { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview', provider: 'google' },
    { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', provider: 'google' },
    { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', provider: 'google' },
    { id: 'openai/gpt-oss-20b', name: 'GPT OSS 20B', provider: 'groq' },
    { id: 'nvidia/nemotron-3.5-lightning-30b-a3b', name: 'Nemotron 3.5 Lightning 30B A3B', provider: 'nvidia' },
];
exports.DEEPGRAM_LLM_PROVIDERS = ['open_ai', 'anthropic', 'google', 'groq', 'nvidia'];
function deepgramModelsForProviderType(providerType) {
    return exports.DEEPGRAM_MANAGED_LLM_CATALOG.filter((m) => m.provider === providerType).map((m) => m.id);
}
function createDefaultState() {
    return {
        version: 5,
        updatedAt: new Date().toISOString(),
        // Intentionally unset: an operator must select and save one global provider/model per service.
        services: {
            stt: { providerId: '', model: '' },
            llm: { providerId: '', model: '' },
            tts: { providerId: '', model: '' },
        },
        providers: [
            makeProvider('s1', 'stt', 'Deepgram STT', 'deepgram', exports.VOICE_AGENT_STT_MODELS.join(',')),
            makeProvider('s_local', 'stt', 'Local Speech Service (Faster-Whisper)', 'speech_service', exports.SPEECH_SERVICE_STT_MODELS.join(','), {
                endpoint: '{{SPEECH_SERVICE_URL}}/v1/audio/transcriptions',
                headers: '{"Authorization":"Bearer {{SPEECH_SERVICE_API_KEY}}"}',
            }),
            makeProvider('l1', 'llm', 'OpenAI (Deepgram Managed)', 'open_ai', 'gpt-4o-mini,gpt-4.1-mini,gpt-4.1-nano,gpt-4.1,gpt-4o,gpt-5-mini,gpt-5-nano,gpt-5,gpt-5.1,gpt-5.2,gpt-5.4-mini,gpt-5.4-nano,gpt-5.4,gpt-5.5,gpt-5.6-luna,gpt-5.6-terra,gpt-6-luna'),
            makeProvider('l2', 'llm', 'Anthropic Claude (Deepgram Managed)', 'anthropic', 'claude-haiku-4-5,claude-haiku-5-5,claude-sonnet-4-5,claude-sonnet-4-6,claude-sonnet-5,claude-sonnet-5-5'),
            makeProvider('l3', 'llm', 'Google Gemini (Deepgram Managed)', 'google', 'gemini-2.5-flash,gemini-2.5-flash-lite,gemini-3-flash-preview,gemini-3.1-flash-lite,gemini-3.1-pro-preview,gemini-3.5-flash,gemini-3.8-flash'),
            makeProvider('l4', 'llm', 'Groq OSS (Deepgram Managed)', 'groq', 'openai/gpt-oss-20b'),
            makeProvider('l5', 'llm', 'NVIDIA Nemotron (Deepgram Managed)', 'nvidia', 'nvidia/nemotron-3.5-lightning-30b-a3b'),
            makeProvider('t1', 'tts', 'Deepgram TTS (Flux v2 & Aura v1)', 'deepgram', 'flux-kit-en,flux-haley-en,flux-alexis-en,flux-sienna-en,flux-miles-en,aura-2-thalia-en,aura-2-andromeda-en,aura-2-apollo-en,aura-stella-en'),
            makeProvider('t_local', 'tts', 'Local Speech Service (Kokoro 82M + Clone)', 'speech_service', exports.SPEECH_SERVICE_DEFAULT_VOICES.join(','), {
                endpoint: '{{SPEECH_SERVICE_URL}}/v1/audio/speech',
                headers: '{"Authorization":"Bearer {{SPEECH_SERVICE_API_KEY}}"}',
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
                    '- If the caller asks who you are, asks you to introduce yourself, or asks any general question, answer warmly and directly first before gently guiding back when appropriate.\n' +
                    '- Never quote specific policy dollar prices or guarantee underwriting approval.\n' +
                    '- Note: Call connection and VICIdial lead context ({{lead_id}}, {{first_name}}, {{state}}) are automatically hydrated by the bridge when the call connects.\n' +
                    '- Once the lead confirms qualification and interest, call set_disposition with code "XFER" and call transfer_to_live_agent.\n' +
                    '- If the lead says stop, take me off your list, not interested, or do not call, apologise politely, call set_disposition with "DNC" (or "NI"), and call end_call immediately.',
                acceptViciCalls: true,
                injectCampaignDisclosure: false,
                randomGreetingEnabled: true,
                behavior: {
                    bargeIn: 'instant',
                    bargeInSensitivity: 'balanced',
                    latencyProfile: 'ultra',
                    expressionStyle: 'warm_empathetic',
                    vocalGestures: true,
                    allowGeneralQa: true,
                    selfIntro: defaultSelfIntroForAgent('a1', 'Final Expense Fronter'),
                },
                stt: {
                    keyterms: 'final expense, burial insurance, Medicare, beneficiary',
                    eot: 0.55,
                    eager: 0.35,
                    eotms: 2000,
                    smartFormat: false,
                },
                llm: {
                    temp: 0.65,
                    reasoning: 'low',
                },
                tts: {
                    speed: 1.05,
                    expr: 1,
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
                greeting: 'Hi, this is Haley calling from the Benefits Department. How are you doing today?',
                prompt: 'You are Haley, an AI Outbound Benefits Advisor calling from the Benefits Department (representing US Health Care). Be honest that you are an AI if asked.\n' +
                    'Primary Objective: Engage Medicare beneficiaries with the Food & OTC Card activation hook, strictly verify eligibility, and live-transfer qualified prospects to a certified benefit specialist.\n\n' +
                    '=== 1. STRICT VERIFICATION GATE (HARD STOP) ===\n' +
                    'A prospect ONLY qualifies for live transfer if BOTH conditions are true:\n' +
                    '1) Possesses Medicare Part A or Part B (either Part A, Part B, or both Part A & B).\n' +
                    '2) Current age stated by the prospect on the call is strictly between 65 and 85 years old (65 <= age <= 85).\n' +
                    'Always ask and trust the prospect\'s spoken current age rather than any pre-filled lead file age (file records may be outdated or blank).\n' +
                    'Never transfer anyone under 65, over 85, or without Medicare Part A/B.\n\n' +
                    '=== 2. SCRIPTED FLOW & DIALOGUE TREE ===\n' +
                    '- Phase 1 (After the opening):\n' +
                    '  If Medicare status has not been established, ask whether they have Medicare Part A or Part B; do not assume the opening asked this.\n' +
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
                randomGreetingEnabled: true,
                behavior: {
                    bargeIn: 'instant',
                    bargeInSensitivity: 'balanced',
                    latencyProfile: 'ultra',
                    expressionStyle: 'warm_empathetic',
                    vocalGestures: true,
                    allowGeneralQa: true,
                    selfIntro: defaultSelfIntroForAgent('a_medicare', 'Medicare — Food & OTC Advisor'),
                },
                stt: {
                    keyterms: 'Medicare, Part A, Part B, OTC card, groceries, dental, Benefits Department, Hablo español',
                    eot: 0.55,
                    eager: 0.35,
                    eotms: 1800,
                    smartFormat: false,
                },
                llm: {
                    temp: 0.45,
                    reasoning: 'low',
                },
                tts: {
                    speed: 1.05,
                    expr: 1,
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
                id: 'a_nova',
                name: 'Nova — Expressive Live Concierge & General Q&A',
                mode: 'both',
                language: 'en',
                greeting: "Hey there! This is Nova on the line. How are you doing today?",
                prompt: 'You are Nova, a warm, witty AI voice assistant and concierge.\n' +
                    'Core Capabilities:\n' +
                    '1) Natural Self-Introduction: Introduce yourself warmly as Nova and answer honestly that you are an AI assistant if asked.\n' +
                    '2) Identity: Never claim to be a human or say a tool action succeeded unless it actually did.\n' +
                    '3) Universal General Q&A: Answer ANY general question — science, world facts, history, math, technology, travel, advice, definitions, or casual small talk — accurately, clearly, and conversationally.\n' +
                    '4) Ultra-Fast Spoken Cadence: Lead with the direct answer or warm reaction in the very first words. Keep responses crisp (1–2 natural spoken sentences, around 15–35 words unless the caller asks for deeper detail).\n' +
                    '5) Expressive Human Presence: Use natural spoken warmth, enthusiasm, empathy, and conversational micro-gestures ("Oh, great question!", "Gotcha — here is how that works:", "Haha, I love that one!") without ever writing bracketed stage directions.\n' +
                    '6) Live Specialist Transfer: Whenever the caller asks to speak with a live specialist, closer, or supervisor, or confirms qualification for a benefit/coverage review, call set_disposition with code "XFER" and call transfer_to_live_agent.\n' +
                    '7) Do-Not-Call (DNC) & Call Control: If the caller says stop, take me off your list, or do not call, apologize politely, call set_disposition with code "DNC", and call end_call immediately. If the caller says goodbye or asks to hang up, wish them a wonderful day and call end_call.',
                acceptViciCalls: true,
                injectCampaignDisclosure: false,
                randomGreetingEnabled: true,
                behavior: {
                    bargeIn: 'instant',
                    bargeInSensitivity: 'balanced',
                    latencyProfile: 'ultra',
                    expressionStyle: 'energetic_upbeat',
                    vocalGestures: true,
                    allowGeneralQa: true,
                    selfIntro: defaultSelfIntroForAgent('a_nova', 'Nova'),
                },
                stt: {
                    keyterms: 'Nova, Deepgram, barge-in, introduce yourself',
                    eot: 0.55,
                    eager: 0.35,
                    eotms: 1800,
                    smartFormat: false,
                },
                llm: {
                    temp: 0.65,
                    reasoning: 'low',
                },
                tts: {
                    speed: 1.05,
                    expr: 1,
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
                dispos: 'XFER,NI,DNC,NA,CALLBK,DEC,DAIR',
                complianceRules: 'Final Expense outbound campaign rules:\n' +
                    '- Identify yourself and the organization accurately; be truthful that you are an AI assistant if asked. Never claim to be a human, insurer, government office, or licensed agent.\n' +
                    '- Do not claim the caller requested a quote unless they confirm it during this call or it is verified in the lead record. Never guarantee approval, coverage, rates, savings, or policy terms, and do not quote prices.\n' +
                    '- Ask permission to continue. Confirm age, interest, and qualification only from the caller’s current statements. Transfer to a licensed specialist only after the configured criteria are met and the caller agrees.\n' +
                    '- Immediately honor stop, do-not-call, refusal, or hang-up requests without arguing or making another sales attempt. Do not request Social Security, bank, payment, or other sensitive identity details.\n' +
                    '- If unsure, say so plainly and offer a live specialist; never invent a benefit or claim an external action succeeded without confirmation.',
                presenceCheckText: exports.DEFAULT_PRESENCE_CHECK_TEXT,
                deadAirTimeoutSec: 8,
                deadAirDisposition: 'DAIR',
                deadAirDispositionVerified: false,
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
                dispos: 'XFER,DQ,LANG,DNC,NI,NA,CALLBK,DAIR',
                complianceRules: 'Medicare Food & OTC campaign rules:\n' +
                    '- Identify the organization accurately. Never imply affiliation with Medicare, CMS, Social Security, or a government agency; be truthful that you are an AI assistant if asked.\n' +
                    '- Do not assert that the caller has a food/OTC card, funds, credit, benefit, application, or enrollment. Never say money is on hold, expiring, guaranteed, or will return to a state pool. The sample agent script is not evidence for benefit claims.\n' +
                    '- Make no coverage, eligibility, or savings promises. Use only current, approved campaign sources; otherwise say you cannot verify and offer an authorized specialist or official source.\n' +
                    '- Ask about age and Medicare Part A/B only as needed, based on the caller’s current statements; never infer eligibility from lead data. Do not request a Medicare number, Social Security number, bank, or payment details.\n' +
                    '- Honor stop, do-not-call, language-barrier, refusal, and hang-up requests immediately. Transfer only after approved eligibility criteria are met and the caller agrees.',
                presenceCheckText: exports.DEFAULT_PRESENCE_CHECK_TEXT,
                deadAirTimeoutSec: 8,
                deadAirDisposition: 'DAIR',
                deadAirDispositionVerified: false,
            },
            {
                id: 'c_nova',
                name: 'Nova — Live Concierge & General Q&A',
                agentId: 'a_nova',
                viciCampaign: 'NOVACONC',
                lists: '3001',
                start: '09:00',
                end: '20:00',
                tz: 'America/New_York',
                attempts: 3,
                retry: 120,
                maxCalls: 10,
                xferType: 'ingroup',
                xferTarget: 'CONCIERGE_CLOSERS',
                fallback: 'Dispo CALLBK',
                dnc: true,
                disclosure: 'This call may be recorded for quality and training purposes.',
                dispos: 'XFER,NI,DNC,NA,CALLBK,DEC,DAIR',
                complianceRules: 'Nova live concierge campaign rules:\n' +
                    '- Be transparent about being an AI assistant if asked. Do not claim to be human, a licensed professional, or affiliated with a government program.\n' +
                    '- Answer general questions accurately and concisely; state uncertainty instead of inventing facts. Do not make insurance, health, financial, benefit, coverage, or savings claims.\n' +
                    '- Treat lead and caller information as private and use it only for this call. Never request Social Security, account, bank, payment, or other sensitive identity information.\n' +
                    '- Ask the caller’s permission before a transfer. Never say a transfer, disposition, or other action succeeded unless the tool result confirms it.\n' +
                    '- Immediately honor stop, do-not-call, refusal, or hang-up requests without persuasion. Follow the assigned campaign’s configured disclosure and transfer instructions.',
                presenceCheckText: exports.DEFAULT_PRESENCE_CHECK_TEXT,
                deadAirTimeoutSec: 8,
                deadAirDisposition: 'DAIR',
                deadAirDispositionVerified: false,
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
            a_nova: [
                {
                    id: 'tn_1',
                    s: 'Hi! Who are you? Please introduce yourself and tell me what you can help with.',
                    e: 'Warm, expressive self-introduction as Nova with 👋 Greeting Wave gesture and friendly cadence',
                    r: 'p',
                    n: '',
                },
                {
                    id: 'tn_2',
                    s: 'Quick general question: why is the sky blue and how fast does light travel?',
                    e: 'Answers both general science questions accurately and concisely in 1–2 spoken sentences',
                    r: 'p',
                    n: '',
                },
                {
                    id: 'tn_3',
                    s: 'Interrupt mid-sentence ("Wait—actually tell me what 18 times 15 is instead!")',
                    e: 'Barge-in clears queued browser audio and the agent responds to the new question',
                    r: 'p',
                    n: '',
                },
                {
                    id: 'tn_4',
                    s: 'I have had a really exhausting week, any quick words of encouragement?',
                    e: 'Uses warm empathetic expression & natural vocal gestures without any robotic bracketed tags',
                    r: 'p',
                    n: '',
                },
            ],
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
            .filter((f) => f && typeof f === 'object' && !Array.isArray(f) && f?.name !== 'accept_vicidial_call') // Migrate legacy anti-pattern out of LLM tools
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
        ? src.providers.filter((p) => p && typeof p === 'object' && !Array.isArray(p)).map((p, idx) => {
            const kind = ['stt', 'llm', 'tts'].includes(p.kind) ? p.kind : 'llm';
            if (kind === 'llm') {
                const llmType = exports.DEEPGRAM_LLM_PROVIDERS.includes(p.type) ? String(p.type) : 'open_ai';
                const allowedModels = deepgramModelsForProviderType(llmType);
                const allowedSet = new Set(allowedModels);
                const existingValid = String(p.models || '')
                    .split(',')
                    .map((s) => s.trim())
                    .filter((m) => allowedSet.has(m));
                const mergedModels = Array.from(new Set([...existingValid, ...allowedModels])).join(',');
                const canonical = base.providers.find((bp) => bp.kind === 'llm' && bp.type === llmType);
                const cleanName = String(p.name || '').includes('BYO') || !String(p.name || '').trim()
                    ? canonical?.name || `${llmType} (Deepgram Managed)`
                    : String(p.name);
                return {
                    id: String(p.id || canonical?.id || `p_llm_${idx + 1}`),
                    kind: 'llm',
                    name: cleanName,
                    type: llmType,
                    models: mergedModels,
                    endpoint: '',
                    headers: '{}',
                    extra: '{}',
                    mk: 'model',
                };
            }
            const isSpeechService = String(p.type || '') === 'speech_service';
            return {
                id: String(p.id || `p_${kind}_${idx + 1}`),
                kind,
                name: String(p.name || `Provider ${idx + 1}`),
                type: kind === 'stt' ? (isSpeechService ? 'speech_service' : 'deepgram') : String(p.type || 'deepgram'),
                models: kind === 'stt'
                    ? isSpeechService
                        ? String(p.models || exports.SPEECH_SERVICE_STT_MODELS.join(','))
                        : exports.VOICE_AGENT_STT_MODELS.join(',')
                    : String(p.models || ''),
                endpoint: String(p.endpoint || ''),
                headers: typeof p.headers === 'string' ? p.headers : JSON.stringify(p.headers || {}),
                extra: typeof p.extra === 'string' ? p.extra : JSON.stringify(p.extra || {}),
                mk: p.mk === 'model_id' ? 'model_id' : 'model',
            };
        })
        : base.providers.map((p) => ({ ...p }));
    // Ensure all 5 canonical Deepgram-Managed LLM providers (open_ai, anthropic, google, groq, nvidia) exist
    for (const baseLlm of base.providers.filter((p) => p.kind === 'llm')) {
        if (!providers.some((p) => p.kind === 'llm' && p.type === baseLlm.type)) {
            const insertIdx = providers.findIndex((p) => p.kind === 'tts');
            if (insertIdx >= 0)
                providers.splice(insertIdx, 0, { ...baseLlm });
            else
                providers.push({ ...baseLlm });
        }
    }
    // Keep Deepgram-backed and Local Speech Service TTS routes; drop unsupported legacy BYO TTS providers.
    for (let i = providers.length - 1; i >= 0; i -= 1) {
        const p = providers[i];
        if (p.kind === 'tts' && p.type !== 'deepgram' && p.type !== 'speech_service')
            providers.splice(i, 1);
    }
    // Ensure at least one provider per kind exists, plus built-in Local Speech Service providers (s_local, t_local)
    for (const kind of ['stt', 'llm', 'tts']) {
        if (!providers.some((p) => p.kind === kind)) {
            const fallback = base.providers.find((p) => p.kind === kind);
            providers.push({ ...fallback });
        }
    }
    const baseLocalStt = base.providers.find((p) => p.id === 's_local');
    if (baseLocalStt && !providers.some((p) => p.kind === 'stt' && p.type === 'speech_service')) {
        const firstSttIdx = providers.findIndex((p) => p.kind === 'stt');
        providers.splice(firstSttIdx >= 0 ? firstSttIdx + 1 : 1, 0, { ...baseLocalStt });
    }
    const baseLocalTts = base.providers.find((p) => p.id === 't_local');
    if (baseLocalTts && !providers.some((p) => p.kind === 'tts' && p.type === 'speech_service')) {
        providers.push({ ...baseLocalTts });
    }
    const normalizeSelection = (kind) => {
        const rawSelection = src.services?.[kind] || {};
        const provider = providers.find((p) => p.kind === kind && p.id === String(rawSelection.providerId || ''));
        const model = String(rawSelection.model || '').trim();
        if (!provider || !model)
            return { providerId: '', model: '' };
        if (kind === 'stt') {
            if (provider.type === 'speech_service') {
                const sttModels = provider.models.split(',').map((m) => m.trim()).filter(Boolean);
                if (!sttModels.includes(model) && exports.SPEECH_SERVICE_STT_MODELS.includes(model)) {
                    sttModels.push(model);
                    provider.models = sttModels.join(',');
                }
                return sttModels.includes(model) ? { providerId: provider.id, model } : { providerId: '', model: '' };
            }
            return provider.type === 'deepgram' && exports.VOICE_AGENT_STT_MODELS.includes(model)
                ? { providerId: provider.id, model }
                : { providerId: '', model: '' };
        }
        if (kind === 'llm') {
            return deepgramModelsForProviderType(provider.type).includes(model)
                ? { providerId: provider.id, model }
                : { providerId: '', model: '' };
        }
        const allowedModels = provider.models.split(',').map((entry) => entry.trim()).filter(Boolean);
        if (!allowedModels.includes(model) && provider.type === 'deepgram' && /^(flux|aura)-/i.test(model)) {
            allowedModels.push(model);
            provider.models = allowedModels.join(',');
        }
        if (!allowedModels.includes(model) &&
            provider.type === 'speech_service' &&
            /^(clone:[0-9a-f]{32}|[a-z]{2}_[a-z0-9]+)$/.test(model)) {
            allowedModels.push(model);
            provider.models = allowedModels.join(',');
        }
        return allowedModels.includes(model) ? { providerId: provider.id, model } : { providerId: '', model: '' };
    };
    const services = {
        stt: normalizeSelection('stt'),
        llm: normalizeSelection('llm'),
        tts: normalizeSelection('tts'),
    };
    const num = (val, fallback, min = -1e6, max = 1e6) => {
        const n = Number(val);
        return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
    };
    const xferFnId = fnNameMap.get('transfer_to_live_agent');
    const dispoFnId = fnNameMap.get('set_disposition');
    const endFnId = fnNameMap.get('end_call');
    const agents = Array.isArray(src.agents) && src.agents.length
        ? src.agents.filter((a) => a && typeof a === 'object' && !Array.isArray(a)).map((a, idx) => {
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
            const agentId = String(a.id || `a_${idx + 1}`);
            const agentName = String(a.name || `Agent ${idx + 1}`);
            const isNovaAgent = agentId === 'a_nova' || /nova.*concierge/i.test(agentName);
            if (isNovaAgent) {
                for (const reqFnId of [xferFnId, dispoFnId, endFnId]) {
                    if (reqFnId && !fnIds.includes(reqFnId))
                        fnIds.push(reqFnId);
                }
            }
            const stockMedicarePrompt = base.agents.find((entry) => entry.id === 'a_medicare')?.prompt || '';
            let cleanPrompt = (0, opening_1.migrateStockMedicarePrompt)(String(a.prompt ?? ''), stockMedicarePrompt)
                .replace(/When the call connects,\s*call accept_vicidial_call\.?\s*/gi, '').trim();
            if (cleanPrompt.length > 0) {
                if (xferFnId && fnIds.includes(xferFnId) && !/transfer_to_live_agent/i.test(cleanPrompt)) {
                    cleanPrompt +=
                        '\n- Live Specialist Transfer: Once the caller confirms qualification or asks to speak with a specialist, call set_disposition with code "XFER" and call transfer_to_live_agent.';
                }
                if (!/(dnc|do not call|take me off|stop)/i.test(cleanPrompt)) {
                    cleanPrompt +=
                        '\n- Do-Not-Call (DNC) Compliance: If the caller says stop, take me off your list, or do not call, apologize politely, call set_disposition with code "DNC", and call end_call immediately.';
                }
            }
            const rawBeh = a.behavior && typeof a.behavior === 'object' ? a.behavior : {};
            const behavior = {
                bargeIn: ['instant', 'server', 'off'].includes(rawBeh.bargeIn) ? rawBeh.bargeIn : 'instant',
                bargeInSensitivity: ['high', 'balanced', 'low'].includes(rawBeh.bargeInSensitivity)
                    ? rawBeh.bargeInSensitivity
                    : 'balanced',
                latencyProfile: ['ultra', 'balanced', 'quality'].includes(rawBeh.latencyProfile)
                    ? rawBeh.latencyProfile
                    : 'ultra',
                expressionStyle: [
                    'warm_empathetic',
                    'energetic_upbeat',
                    'charismatic_closer',
                    'calm_concierge',
                ].includes(rawBeh.expressionStyle)
                    ? rawBeh.expressionStyle
                    : agentId === 'a_nova'
                        ? 'energetic_upbeat'
                        : 'warm_empathetic',
                vocalGestures: rawBeh.vocalGestures !== undefined ? Boolean(rawBeh.vocalGestures) : true,
                allowGeneralQa: rawBeh.allowGeneralQa !== undefined ? Boolean(rawBeh.allowGeneralQa) : true,
                selfIntro: typeof rawBeh.selfIntro === 'string' && rawBeh.selfIntro.trim()
                    ? rawBeh.selfIntro.trim()
                    : defaultSelfIntroForAgent(agentId, agentName),
            };
            const rawInRate = Math.round(num(a.audio?.inRate, 8000));
            const rawOutRate = Math.round(num(a.audio?.outRate, 8000));
            return {
                id: agentId,
                name: agentName,
                mode: ['outbound', 'inbound', 'both'].includes(a.mode) ? a.mode : 'outbound',
                language: String(a.language || 'en'),
                greeting: (0, opening_1.migrateStockOpening)(String(a.greeting ?? '')),
                randomGreetingEnabled: a.randomGreetingEnabled !== false,
                prompt: cleanPrompt,
                acceptViciCalls: isNovaAgent ? true : a.acceptViciCalls !== undefined ? Boolean(a.acceptViciCalls) : hadLegacyAccept,
                injectCampaignDisclosure: a.injectCampaignDisclosure !== undefined ? Boolean(a.injectCampaignDisclosure) : false,
                behavior,
                stt: {
                    keyterms: String(a.stt?.keyterms ?? ''),
                    eot: num(a.stt?.eot, 0.55, 0.1, 0.9),
                    eager: num(a.stt?.eager, 0.35, 0.1, 0.9),
                    eotms: Math.round(num(a.stt?.eotms, 2000, 100, 10000)),
                    smartFormat: Boolean(a.stt?.smartFormat),
                },
                llm: {
                    temp: num(a.llm?.temp, 0.7, 0, 2),
                    reasoning: (['low', 'medium', 'high'].includes(a.llm?.reasoning) ? a.llm.reasoning : 'low'),
                },
                tts: {
                    speed: num(a.tts?.speed, 1.0, 0.5, 1.5),
                    expr: Math.round(num(a.tts?.expr, 0, -2, 2)),
                },
                audio: {
                    inEnc: ['linear16', 'mulaw', 'alaw'].includes(a.audio?.inEnc) ? a.audio.inEnc : 'linear16',
                    inRate: rawInRate !== 8000 ? 8000 : rawInRate,
                    outEnc: ['linear16', 'mulaw', 'alaw'].includes(a.audio?.outEnc) ? a.audio.outEnc : 'linear16',
                    outRate: rawInRate !== 8000 ? 8000 : rawOutRate,
                },
                fnIds,
            };
        })
        : base.agents;
    const campaigns = Array.isArray(src.campaigns)
        ? src.campaigns.filter((c) => c && typeof c === 'object' && !Array.isArray(c)).map((c, idx) => {
            const cName = String(c.name || `Campaign ${idx + 1}`);
            const defaultDisclosure = /medicare/i.test(cName)
                ? 'This call may be recorded for quality and benefit verification.'
                : 'This call may be recorded for quality purposes.';
            return {
                id: String(c.id || `c_${idx + 1}`),
                name: cName,
                // Missing assignments stay missing. Never silently attach a campaign to the first bot.
                agentId: String(c.agentId ?? ''),
                viciCampaign: String(c.viciCampaign ?? '').trim(),
                lists: String(c.lists ?? ''),
                start: String(c.start || '09:00'),
                end: String(c.end || '20:00'),
                tz: String(c.tz || 'America/New_York'),
                attempts: Math.round(num(c.attempts, 3, 1, 20)),
                retry: Math.round(num(c.retry, 120, 0, 86400)),
                maxCalls: Math.round(num(c.maxCalls, 10, 1, 1000)),
                xferType: (['ingroup', 'extension', 'number'].includes(c.xferType) ? c.xferType : 'ingroup'),
                // Transfer routing is campaign-specific; never infer a closer from a campaign name.
                xferTarget: String(c.xferTarget ?? '').trim(),
                fallback: String(c.fallback ?? ''),
                dnc: c.dnc !== undefined ? Boolean(c.dnc) : true,
                disclosure: String(c.disclosure ?? '').trim() || defaultDisclosure,
                dispos: String(c.dispos ?? 'XFER,NI,DNC,NA,CALLBK,DEC'),
                // Legacy campaigns must be reviewed instead of inheriting a fabricated compliance policy.
                complianceRules: typeof c.complianceRules === 'string' ? c.complianceRules : exports.MISSING_CAMPAIGN_RULES,
                presenceCheckText: typeof c.presenceCheckText === 'string' ? c.presenceCheckText : exports.DEFAULT_PRESENCE_CHECK_TEXT,
                deadAirTimeoutSec: Math.round(num(c.deadAirTimeoutSec, 8, 1, 120)),
                deadAirDisposition: String(c.deadAirDisposition ?? '').trim().toUpperCase(),
                deadAirDispositionVerified: c.deadAirDispositionVerified === true,
            };
        })
        : Array.isArray(src.agents)
            ? []
            : base.campaigns.map((c) => ({ ...c }));
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
    if (viciBaseUrl === 'https://dialer.example.com')
        viciBaseUrl = base.vici.viciBaseUrl;
    const rawBridgeHost = src.vici?.bridgeHost === 'bridge.example.com' ? base.vici.bridgeHost : src.vici?.bridgeHost;
    const rawAmiHost = src.vici?.amiHost;
    const rawSipPort = num(src.vici?.sipPort, 5062);
    const vici = {
        viciBaseUrl: String(viciBaseUrl || base.vici.viciBaseUrl).replace(/\/+$/, ''),
        nonAgentApiPath: String(src.vici?.nonAgentApiPath || base.vici.nonAgentApiPath),
        agentApiPath: String(src.vici?.agentApiPath || base.vici.agentApiPath),
        apiUser: String(src.vici?.apiUser === 'apiuser' ? '6666' : src.vici?.apiUser || base.vici.apiUser),
        source: String(src.vici?.source || base.vici.source),
        transport: src.vici?.transport === 'audiosocket' ? 'audiosocket' : 'sip_trunk',
        bridgeHost: String(rawBridgeHost || base.vici.bridgeHost),
        bridgePort: Math.round(num(src.vici?.bridgePort, 9092, 1, 65535)),
        sipPort: Math.round(Math.min(65535, Math.max(1, rawSipPort))),
        aiExten: String(src.vici?.aiExten || base.vici.aiExten),
        remoteAgentUser: String(src.vici?.remoteAgentUser || base.vici.remoteAgentUser),
        inIngroup: String(src.vici?.inIngroup || base.vici.inIngroup),
        amiHost: String(rawAmiHost || base.vici.amiHost),
        amiPort: Math.round(num(src.vici?.amiPort, 5038, 1, 65535)),
        amiUser: String(src.vici?.amiUser === 'bridge' ? 'cron' : src.vici?.amiUser || base.vici.amiUser),
    };
    const tests = {};
    if (src.tests && typeof src.tests === 'object') {
        for (const [aid, list] of Object.entries(src.tests)) {
            if (Array.isArray(list)) {
                tests[aid] = list.filter((item) => item && typeof item === 'object' && !Array.isArray(item)).map((item, idx) => ({
                    id: String(item.id || `t_${aid}_${idx + 1}`),
                    s: String(item.s ?? ''),
                    e: String(item.e ?? ''),
                    r: ['p', 'ok', 'f'].includes(item.r) ? item.r : 'p',
                    n: String(item.n ?? ''),
                }));
            }
        }
    }
    function dedupe(items) {
        const seen = new Set();
        const out = [];
        for (const [index, item] of items.entries()) {
            let id = item.id;
            while (!id || seen.has(id))
                id = `${item.id || 'item'}_${index + 1}_${seen.size}`;
            seen.add(id);
            out.push({ ...item, id });
        }
        return out;
    }
    const uniqueAgents = dedupe(agents);
    const agentIds = new Set(uniqueAgents.map((a) => a.id));
    const uniqueCampaigns = dedupe(campaigns).map((c) => ({ ...c, agentId: agentIds.has(c.agentId) ? c.agentId : '' }));
    const campaignIds = new Set(uniqueCampaigns.map((c) => c.id));
    const uniqueFunctions = dedupe(functions);
    const functionIds = new Set(uniqueFunctions.map((f) => f.id));
    for (const agent of uniqueAgents)
        agent.fnIds = [...new Set(agent.fnIds.filter((id) => functionIds.has(id)))];
    const cleanTests = {};
    for (const [aid, list] of Object.entries(tests))
        if (agentIds.has(aid))
            cleanTests[aid] = dedupe(list);
    void campaignIds;
    return {
        version: 5,
        updatedAt: new Date().toISOString(),
        services,
        providers,
        functions: uniqueFunctions,
        agents: uniqueAgents,
        campaigns: uniqueCampaigns,
        vici,
        tests: cleanTests,
    };
}
