"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.EXPRESSIVE_PRESETS = exports.sampleSha256 = exports.CloneError = exports.MAX_SAMPLE_BYTES = exports.ELEVEN_LIVE_MODELS = exports.ELEVEN_API = void 0;
exports.validateCloneRequest = validateCloneRequest;
exports.elevenListClones = elevenListClones;
exports.elevenListLibrary = elevenListLibrary;
exports.elevenSetExpressiveness = elevenSetExpressiveness;
exports.elevenCreateClone = elevenCreateClone;
exports.elevenPreview = elevenPreview;
exports.elevenDelete = elevenDelete;
exports.elevenLabsLiveProvider = elevenLabsLiveProvider;
exports.selfHostedListClones = selfHostedListClones;
exports.selfHostedCreateClone = selfHostedCreateClone;
exports.selfHostedDelete = selfHostedDelete;
/**
 * Consented voice cloning for Voice Lab.
 *
 *  - ElevenLabs (cloud): Instant Voice Cloning. Live calls can use the voice:
 *    Deepgram's Voice Agent speaks through ElevenLabs when the TTS provider is
 *    `eleven_labs` with the voice id in the endpoint URL and the key in headers.
 *  - Self-hosted (Chatterbox Turbo in the bundled speech service, NVIDIA GPU):
 *    previews in Voice Lab; not usable as a Deepgram live-call voice.
 *
 * Every clone requires the speaker's name, an explicit permission confirmation
 * and a consent statement. A consent record is kept in SQLite.
 */
const crypto_1 = __importDefault(require("crypto"));
const env_store_1 = require("./env-store");
const speech_service_client_1 = require("./speech-service-client");
// ELEVENLABS_API_BASE exists for tests only; live calls always use the real ElevenLabs endpoint.
exports.ELEVEN_API = (process.env.ELEVENLABS_API_BASE || 'https://api.elevenlabs.io').replace(/\/+$/, '');
exports.ELEVEN_LIVE_MODELS = ['eleven_flash_v2_5', 'eleven_turbo_v2_5'];
exports.MAX_SAMPLE_BYTES = 20 * 1024 * 1024;
class CloneError extends Error {
    statusCode;
    code;
    constructor(message, statusCode = 400, code = 'VOICE_CLONE_FAILED') {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
    }
}
exports.CloneError = CloneError;
function validateCloneRequest(req) {
    const name = String(req.name || '').trim();
    const speakerName = String(req.speakerName || '').trim();
    const consentStatement = String(req.consentStatement || '').trim();
    if (!name || name.length > 80)
        throw new CloneError('Give the voice a name (1–80 characters).');
    if (!speakerName || speakerName.length > 120)
        throw new CloneError('Enter the name of the person whose voice this is.');
    if (req.consentConfirmed !== true)
        throw new CloneError('Confirm that the speaker has given permission to clone their voice.', 400, 'CONSENT_REQUIRED');
    if (consentStatement.length < 10 || consentStatement.length > 1000)
        throw new CloneError('Describe how the speaker gave permission (10–1,000 characters).', 400, 'CONSENT_REQUIRED');
    if (!req.sample || !Buffer.isBuffer(req.sample) || req.sample.length < 8000)
        throw new CloneError('Upload or record a voice sample (at least a few seconds).');
    if (req.sample.length > exports.MAX_SAMPLE_BYTES)
        throw new CloneError('The sample is larger than 20 MB. Use a shorter clip (1–2 minutes is enough).');
    const mimeType = String(req.mimeType || 'application/octet-stream').toLowerCase();
    if (!/^audio\/|^video\/webm|^application\/octet-stream/.test(mimeType))
        throw new CloneError('The sample must be an audio file (mp3, wav, m4a, ogg or webm).');
    return {
        name,
        speakerName,
        consentConfirmed: true,
        consentStatement,
        description: String(req.description || '').trim().slice(0, 500),
        removeBackgroundNoise: req.removeBackgroundNoise === true,
        sample: req.sample,
        filename: String(req.filename || 'sample').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'sample',
        mimeType,
    };
}
const sampleSha256 = (buf) => crypto_1.default.createHash('sha256').update(buf).digest('hex');
exports.sampleSha256 = sampleSha256;
// ─────────────────────────────── ElevenLabs ───────────────────────────────
function elevenKey() {
    const key = (0, env_store_1.getSecret)('ELEVENLABS_API_KEY');
    if (!key)
        throw new CloneError('Add your ElevenLabs API key in API Keys (ELEVENLABS_API_KEY) first.', 400, 'ELEVENLABS_KEY_MISSING');
    return key;
}
async function elevenError(res) {
    let detail = '';
    try {
        const j = await res.json();
        detail = j?.detail?.message || j?.detail?.status || (typeof j?.detail === 'string' ? j.detail : '') || j?.message || '';
    }
    catch { /* not JSON */ }
    if (res.status === 401)
        return new CloneError('ElevenLabs rejected the API key. Check ELEVENLABS_API_KEY in API Keys.', 401, 'ELEVENLABS_AUTH');
    if (res.status === 402 || /subscription|plan|upgrade|quota|limit/i.test(detail))
        return new CloneError(`ElevenLabs: ${detail || 'your plan does not allow this (voice cloning needs a paid plan).'}`, 402, 'ELEVENLABS_PLAN');
    return new CloneError(`ElevenLabs error ${res.status}${detail ? `: ${detail}` : ''}`, res.status >= 500 ? 502 : 400, 'ELEVENLABS_ERROR');
}
async function elevenListClones(fetchImpl = fetch) {
    const res = await fetchImpl(`${exports.ELEVEN_API}/v1/voices`, { headers: { 'xi-api-key': elevenKey() } });
    if (!res.ok)
        throw await elevenError(res);
    const data = await res.json();
    return (Array.isArray(data?.voices) ? data.voices : [])
        .filter((v) => ['cloned', 'professional'].includes(String(v?.category || '')))
        .map((v) => ({
        provider: 'elevenlabs',
        id: String(v.voice_id),
        name: String(v.name || v.voice_id),
        voice: String(v.voice_id),
        liveCalls: true,
        createdAt: v.created_at_unix ? new Date(Number(v.created_at_unix) * 1000).toISOString() : null,
    }));
}
/** Ready-made voices on the ElevenLabs account (premade, library, generated): not clones. */
async function elevenListLibrary(fetchImpl = fetch) {
    const res = await fetchImpl(`${exports.ELEVEN_API}/v1/voices`, { headers: { 'xi-api-key': elevenKey() } });
    if (!res.ok)
        throw await elevenError(res);
    const data = await res.json();
    return (Array.isArray(data?.voices) ? data.voices : [])
        .filter((v) => v?.voice_id && !['cloned', 'professional'].includes(String(v?.category || '')))
        .map((v) => {
        const l = v?.labels && typeof v.labels === 'object' ? v.labels : {};
        const description = [l.gender, l.age, l.accent, l.description || l.descriptive, l.use_case || l.use_case].filter(Boolean).map(String).join(' · ');
        return {
            provider: 'elevenlabs',
            id: String(v.voice_id),
            name: String(v.name || v.voice_id),
            voice: String(v.voice_id),
            liveCalls: true,
            createdAt: null,
            description: description.slice(0, 160),
        };
    })
        .sort((a, b) => a.name.localeCompare(b.name));
}
/**
 * How expressive the live-call voice sounds. ElevenLabs uses a voice's saved
 * settings whenever a request sends none (Deepgram's speak provider sends none),
 * so these are written onto the voice itself.
 * Lower stability = more emotion and pitch movement; style adds delivery flair.
 */
exports.EXPRESSIVE_PRESETS = {
    warm: { label: 'Warm & expressive', stability: 0.32, similarity_boost: 0.8, style: 0.45, use_speaker_boost: true, speed: 1.0 },
    balanced: { label: 'Balanced', stability: 0.5, similarity_boost: 0.75, style: 0.2, use_speaker_boost: true, speed: 1.0 },
    steady: { label: 'Steady & calm', stability: 0.7, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true, speed: 0.97 },
};
async function elevenSetExpressiveness(voiceId, preset, fetchImpl = fetch) {
    if (!/^[A-Za-z0-9]{8,64}$/.test(voiceId))
        throw new CloneError('Unknown ElevenLabs voice id.');
    if (!Object.prototype.hasOwnProperty.call(exports.EXPRESSIVE_PRESETS, preset))
        throw new CloneError('Choose Warm, Balanced or Steady.');
    const { label: _label, ...settings } = exports.EXPRESSIVE_PRESETS[preset];
    const res = await fetchImpl(`${exports.ELEVEN_API}/v1/voices/${voiceId}/settings/edit`, {
        method: 'POST',
        headers: { 'xi-api-key': elevenKey(), 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
    });
    if (!res.ok)
        throw await elevenError(res);
    return preset;
}
async function elevenCreateClone(req, fetchImpl = fetch) {
    const form = new FormData();
    form.append('name', req.name);
    form.append('description', req.description || `Consented clone of ${req.speakerName}. ${req.consentStatement}`.slice(0, 500));
    form.append('remove_background_noise', req.removeBackgroundNoise ? 'true' : 'false');
    form.append('labels', JSON.stringify({ speaker: req.speakerName.slice(0, 60), source: 'voice-agent-console' }));
    form.append('files', new Blob([new Uint8Array(req.sample)], { type: req.mimeType }), req.filename);
    const res = await fetchImpl(`${exports.ELEVEN_API}/v1/voices/add`, { method: 'POST', headers: { 'xi-api-key': elevenKey() }, body: form });
    if (!res.ok)
        throw await elevenError(res);
    const data = await res.json();
    if (!data?.voice_id)
        throw new CloneError('ElevenLabs did not return a voice id.', 502, 'ELEVENLABS_ERROR');
    return { provider: 'elevenlabs', id: String(data.voice_id), name: req.name, voice: String(data.voice_id), liveCalls: true, createdAt: new Date().toISOString() };
}
async function elevenPreview(voiceId, text, fetchImpl = fetch) {
    if (!/^[A-Za-z0-9]{8,64}$/.test(voiceId))
        throw new CloneError('Unknown ElevenLabs voice id.');
    const res = await fetchImpl(`${exports.ELEVEN_API}/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'xi-api-key': elevenKey(), 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify({ text: String(text || '').slice(0, 600), model_id: exports.ELEVEN_LIVE_MODELS[0] }),
    });
    if (!res.ok)
        throw await elevenError(res);
    return Buffer.from(await res.arrayBuffer());
}
async function elevenDelete(voiceId, fetchImpl = fetch) {
    if (!/^[A-Za-z0-9]{8,64}$/.test(voiceId))
        throw new CloneError('Unknown ElevenLabs voice id.');
    const res = await fetchImpl(`${exports.ELEVEN_API}/v1/voices/${voiceId}`, { method: 'DELETE', headers: { 'xi-api-key': elevenKey() } });
    if (!res.ok && res.status !== 404)
        throw await elevenError(res);
}
/** The TTS provider that makes Deepgram's Voice Agent speak with an ElevenLabs voice. */
function elevenLabsLiveProvider(voiceId, voiceName) {
    return {
        id: 'p_elevenlabs_clone',
        kind: 'tts',
        name: `ElevenLabs — ${voiceName}`.slice(0, 120),
        type: 'eleven_labs',
        models: exports.ELEVEN_LIVE_MODELS.join(','),
        endpoint: `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/multi-stream-input`,
        headers: '{"xi-api-key":"{{ELEVENLABS_API_KEY}}"}',
        extra: '{}',
        mk: 'model_id',
    };
}
// ─────────────────────────── Self-hosted (Chatterbox) ───────────────────────────
async function speechServiceError(res) {
    let detail = '';
    try {
        const j = await res.json();
        detail = typeof j?.detail === 'string' ? j.detail : j?.error || '';
    }
    catch { /* ignore */ }
    if (res.status === 501)
        return new CloneError('Voice cloning is not enabled on your speech service (it needs the clone container on an NVIDIA GPU server).', 501, 'SELFHOSTED_CLONE_OFF');
    if (res.status === 401 || res.status === 403)
        return new CloneError('The speech service rejected the key. Check SPEECH_SERVICE_API_KEY.', 401, 'SELFHOSTED_AUTH');
    return new CloneError(`Speech service error ${res.status}${detail ? `: ${detail}` : ''}`, res.status >= 500 ? 502 : 400, 'SELFHOSTED_ERROR');
}
function speechServiceUrl() {
    const base = (0, speech_service_client_1.getSpeechServiceBaseUrl)();
    if (!base)
        throw new CloneError('Connect your self-hosted speech service first (Plug-Ins → Self-Hosted Speech Service).', 400, 'SELFHOSTED_NOT_CONFIGURED');
    return base.replace(/\/+$/, '');
}
async function selfHostedListClones(fetchImpl = fetch) {
    const res = await fetchImpl(`${speechServiceUrl()}/v1/voices`, { headers: (0, speech_service_client_1.getSpeechServiceHeaders)() });
    if (!res.ok)
        throw await speechServiceError(res);
    const data = await res.json();
    return (Array.isArray(data?.voices) ? data.voices : []).map((v) => ({
        provider: 'selfhosted',
        id: String(v.id),
        name: String(v.name || v.id),
        voice: `clone:${v.id}`,
        liveCalls: false,
        createdAt: v.created_at || null,
        durationSec: typeof v.duration === 'number' ? v.duration : null,
    }));
}
async function selfHostedCreateClone(req, fetchImpl = fetch) {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(req.sample)], { type: req.mimeType }), req.filename);
    form.append('name', req.name);
    form.append('speaker_name', req.speakerName);
    form.append('consent_confirmed', 'true');
    form.append('consent_statement', req.consentStatement);
    const res = await fetchImpl(`${speechServiceUrl()}/v1/voices`, { method: 'POST', headers: (0, speech_service_client_1.getSpeechServiceHeaders)(), body: form });
    if (!res.ok)
        throw await speechServiceError(res);
    const data = await res.json();
    return { provider: 'selfhosted', id: String(data.id), name: String(data.name || req.name), voice: String(data.voice || `clone:${data.id}`), liveCalls: false, durationSec: data.duration ?? null, createdAt: new Date().toISOString() };
}
async function selfHostedDelete(id, fetchImpl = fetch) {
    if (!/^[0-9a-f]{32}$/.test(id))
        throw new CloneError('Unknown self-hosted voice id.');
    const res = await fetchImpl(`${speechServiceUrl()}/v1/voices/${id}`, { method: 'DELETE', headers: (0, speech_service_client_1.getSpeechServiceHeaders)() });
    if (!res.ok && res.status !== 404)
        throw await speechServiceError(res);
}
