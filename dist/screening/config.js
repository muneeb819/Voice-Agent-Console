"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalisePhone = normalisePhone;
exports.parseTestEndpoints = parseTestEndpoints;
exports.loadScreeningConfig = loadScreeningConfig;
exports.parseNativeAmdHeader = parseNativeAmdHeader;
// Screening configuration. The on/off switch lives in the database (set from
// the console); everything else is server configuration in .env with safe defaults.
const crypto_1 = __importDefault(require("crypto"));
const types_1 = require("./types");
const store_1 = require("./store");
const num = (env, key, def, min, max) => {
    const n = Number(env[key]);
    return Number.isFinite(n) && env[key] !== '' && env[key] !== undefined ? Math.min(max, Math.max(min, Math.round(n))) : def;
};
const code = (env, key, def) => {
    const v = String(env[key] || '').trim().toUpperCase();
    return store_1.STATUS_CODE_RE.test(v) ? v : def;
};
const flag = (env, key, def) => {
    const v = String(env[key] ?? '').trim().toLowerCase();
    if (!v)
        return def;
    return ['1', 'true', 'yes', 'on'].includes(v);
};
/** Digits only, US numbers reduced to 10 digits, so 1-305-555-0100 and 3055550100 match. */
function normalisePhone(raw) {
    const d = String(raw || '').replace(/\D/g, '');
    return d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
}
/** SCREENING_TEST_ENDPOINTS="3055550100=Carrier test line,3055550111" */
function parseTestEndpoints(raw) {
    const out = new Map();
    for (const part of String(raw || '').split(/[,;\n]/)) {
        const [num, ...label] = part.split('=');
        const n = normalisePhone(num);
        if (n.length >= 7 && n.length <= 15)
            out.set(n, label.join('=').trim().slice(0, 60) || 'Test endpoint');
    }
    return out;
}
function loadScreeningConfig(env = process.env) {
    const t = types_1.DEFAULT_THRESHOLDS;
    return {
        thresholds: {
            maxScreeningMs: num(env, 'SCREENING_MAX_MS', t.maxScreeningMs, 3000, 15000),
            afterGreetingSilenceMs: num(env, 'SCREENING_AFTER_GREETING_SILENCE_MS', t.afterGreetingSilenceMs, 400, 2000),
            maxHumanGreetingMs: num(env, 'SCREENING_MAX_HUMAN_GREETING_MS', t.maxHumanGreetingMs, 800, 5000),
            longGreetingMs: num(env, 'SCREENING_LONG_GREETING_MS', t.longGreetingMs, 2000, 8000),
            maxHumanWords: num(env, 'SCREENING_MAX_HUMAN_WORDS', t.maxHumanWords, 2, 20),
            silenceProbeAtMs: num(env, 'SCREENING_SILENCE_PROBE_AT_MS', t.silenceProbeAtMs, 1000, 6000),
            probeResponseWindowMs: num(env, 'SCREENING_PROBE_RESPONSE_MS', t.probeResponseWindowMs, 1000, 6000),
            minBeepMs: num(env, 'SCREENING_MIN_BEEP_MS', t.minBeepMs, 100, 1000),
            minMachineWords: num(env, 'SCREENING_MIN_MACHINE_WORDS', t.minMachineWords, 6, 40),
        },
        dispositions: {
            VOICEMAIL: code(env, 'SCREENING_DISPO_VOICEMAIL', 'AA'),
            IVR: code(env, 'SCREENING_DISPO_IVR', 'AA'),
            PRERECORDED_AUDIO: code(env, 'SCREENING_DISPO_PRERECORDED', 'AA'),
            KNOWN_TEST_ENDPOINT: code(env, 'SCREENING_DISPO_TEST_ENDPOINT', 'AA'),
            UNCERTAIN: code(env, 'SCREENING_DISPO_UNCERTAIN', 'NA'),
        },
        asrModel: String(env.SCREENING_ASR_MODEL || 'nova-3').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 60) || 'nova-3',
        probeEnabled: flag(env, 'SCREENING_PROBE', true),
        alwaysProbe: flag(env, 'SCREENING_ALWAYS_PROBE', false),
        probeText: String(env.SCREENING_PROBE_TEXT || 'Hello?').replace(/[\r\n]/g, ' ').slice(0, 80),
        probeVoice: String(env.SCREENING_PROBE_VOICE || 'aura-2-thalia-en').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 60) || 'aura-2-thalia-en',
        eventSecret: String(env.SCREENING_EVENT_SECRET || ''),
        testEndpoints: parseTestEndpoints(String(env.SCREENING_TEST_ENDPOINTS || '')),
    };
}
const AMD_STATUSES = ['HUMAN', 'MACHINE', 'NOTSURE', 'HANGUP'];
/**
 * Reads the X-MMA-AMD header set by the MMA AMD dialplan (extension 8370):
 *   X-MMA-AMD: <STATUS>/<CAUSE>
 *   X-MMA-AMD-Sig: sha1(<secret><STATUS><caller code>)
 * Without a configured secret the header is trusted only because SIP is
 * accepted from allow-listed dialer IPs alone. A bad signature is ignored
 * (treated as "native AMD not run"), so a forged header can never confirm a person.
 */
function parseNativeAmdHeader(headerValue, signature, callerCode, secret) {
    const raw = String(headerValue || '').trim();
    if (!raw)
        return { status: 'NONE', cause: '', authenticated: false };
    const [statusRaw, ...causeParts] = raw.split('/');
    const status = statusRaw.trim().toUpperCase();
    if (!AMD_STATUSES.includes(status))
        return { status: 'NONE', cause: '', authenticated: false };
    const cause = causeParts.join('/').replace(/[^A-Za-z0-9_\- ]/g, '').slice(0, 60);
    if (!secret)
        return { status, cause, authenticated: true };
    const expected = crypto_1.default.createHash('sha1').update(`${secret}${status}${callerCode}`).digest('hex');
    const given = String(signature || '').trim().toLowerCase();
    const ok = given.length === expected.length && crypto_1.default.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
    return ok ? { status, cause, authenticated: true } : { status, cause, authenticated: false };
}
