"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchDeepgramVoiceCatalog = fetchDeepgramVoiceCatalog;
exports.fetchDeepgramLlmModels = fetchDeepgramLlmModels;
exports.fetchAllowedSampleAudio = fetchAllowedSampleAudio;
exports.synthesizeTtsPreview = synthesizeTtsPreview;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const env_store_1 = require("./env-store");
const settings_builder_1 = require("./settings-builder");
const speech_service_client_1 = require("./speech-service-client");
const FEATURED_IDS = new Set([
    'flux-haley-en',
    'flux-hannah-en',
    'flux-kit-en',
    'flux-alexis-en',
    'flux-sienna-en',
    'flux-cliff-en',
    'flux-cole-en',
    'flux-brooke-en',
    'flux-colin-en',
    'flux-gemma-en',
    'flux-heather-en',
    'flux-miles-en',
    'flux-sean-en',
    'aura-2-thalia-en',
    'aura-2-andromeda-en',
    'aura-2-helena-en',
    'aura-2-apollo-en',
    'aura-2-arcas-en',
    'aura-2-aries-en',
]);
const FALLBACK_VOICES = [
    {
        id: 'flux-haley-en',
        name: 'haley',
        displayName: 'Haley',
        family: 'flux-v2',
        providerVersion: 'v2',
        languages: ['en', 'en-US'],
        primaryLanguage: 'en',
        accent: 'American',
        gender: 'feminine',
        age: 'Young Adult',
        tags: ['feminine', 'clear', 'professional', 'caring', 'calm', 'empathetic'],
        useCases: ['Customer Service', 'Financial Services', 'IVR'],
        sampleUrl: null,
        avatarUrl: null,
        featured: true,
    },
    {
        id: 'flux-kit-en',
        name: 'kit',
        displayName: 'Kit',
        family: 'flux-v2',
        providerVersion: 'v2',
        languages: ['en', 'en-GB'],
        primaryLanguage: 'en',
        accent: 'British',
        gender: 'masculine',
        age: 'Young Adult',
        tags: ['masculine', 'friendly', 'energetic', 'calm', 'helpful'],
        useCases: ['Customer Service', 'Financial Services', 'Narration'],
        sampleUrl: null,
        avatarUrl: null,
        featured: true,
    },
    {
        id: 'flux-alexis-en',
        name: 'alexis',
        displayName: 'Alexis',
        family: 'flux-v2',
        providerVersion: 'v2',
        languages: ['en', 'en-US'],
        primaryLanguage: 'en',
        accent: 'American',
        gender: 'feminine',
        age: 'Adult',
        tags: ['feminine', 'clear', 'professional', 'calm', 'empathetic'],
        useCases: ['Customer Service', 'IVR', 'Financial Services'],
        sampleUrl: null,
        avatarUrl: null,
        featured: true,
    },
    {
        id: 'aura-2-thalia-en',
        name: 'thalia',
        displayName: 'Thalia',
        family: 'aura-2',
        providerVersion: 'v1',
        languages: ['en', 'en-US'],
        primaryLanguage: 'en',
        accent: 'American',
        gender: 'feminine',
        age: 'Adult',
        tags: ['feminine', 'clear', 'confident', 'energetic', 'enthusiastic'],
        useCases: ['Casual Chat', 'Customer Service', 'IVR'],
        sampleUrl: null,
        avatarUrl: null,
        featured: true,
    },
    {
        id: 'aura-2-apollo-en',
        name: 'apollo',
        displayName: 'Apollo',
        family: 'aura-2',
        providerVersion: 'v1',
        languages: ['en', 'en-US'],
        primaryLanguage: 'en',
        accent: 'American',
        gender: 'masculine',
        age: 'Adult',
        tags: ['masculine', 'confident', 'comfortable', 'casual'],
        useCases: ['Casual Chat', 'Customer Service'],
        sampleUrl: null,
        avatarUrl: null,
        featured: true,
    },
];
let cachedVoices = null;
let inflightCatalog = null;
function loadStaticVoiceCatalog() {
    const candidates = [
        path_1.default.resolve(__dirname, '../public/voices-static.json'),
        path_1.default.resolve(process.cwd(), 'public/voices-static.json'),
    ];
    for (const filePath of candidates) {
        try {
            if (fs_1.default.existsSync(filePath)) {
                const parsed = JSON.parse(fs_1.default.readFileSync(filePath, 'utf8'));
                if (Array.isArray(parsed?.voices) && parsed.voices.length > 0) {
                    return parsed.voices;
                }
            }
        }
        catch {
            // Fall through
        }
    }
    return FALLBACK_VOICES;
}
function buildOfflineWavSample(durationMs = 500, sampleRate = 8000) {
    const numSamples = Math.max(2600, Math.floor((sampleRate * durationMs) / 1000));
    const dataBytes = numSamples * 2;
    const buf = Buffer.alloc(44 + dataBytes);
    buf.write('RIFF', 0, 'ascii');
    buf.writeUInt32LE(36 + dataBytes, 4);
    buf.write('WAVE', 8, 'ascii');
    buf.write('fmt ', 12, 'ascii');
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(sampleRate, 24);
    buf.writeUInt32LE(sampleRate * 2, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write('data', 36, 'ascii');
    buf.writeUInt32LE(dataBytes, 40);
    for (let i = 0; i < numSamples; i++) {
        const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 4000);
        buf.writeInt16LE(sample, 44 + i * 2);
    }
    return buf;
}
const CACHE_TTL_MS = 5 * 60 * 1000;
function inferGender(tags) {
    const lower = tags.map((t) => t.toLowerCase());
    if (lower.some((t) => t === 'feminine' || t === 'female'))
        return 'feminine';
    if (lower.some((t) => t === 'masculine' || t === 'male'))
        return 'masculine';
    return 'neutral';
}
function normalizeTtsModel(item, defaultFamily) {
    const id = String(item?.canonical_name || '').trim();
    if (!id)
        return null;
    const arch = String(item?.architecture || '').toLowerCase();
    const family = id.startsWith('flux-') || arch.includes('flux')
        ? 'flux-v2'
        : id.startsWith('aura-2-') || arch === 'aura-2'
            ? 'aura-2'
            : defaultFamily === 'flux-v2'
                ? 'flux-v2'
                : 'aura-1';
    const meta = item?.metadata || {};
    const tags = Array.isArray(meta.tags) ? meta.tags.map(String) : [];
    const useCases = Array.isArray(meta.use_cases) ? meta.use_cases.map(String) : [];
    const languages = Array.isArray(item?.languages) && item.languages.length
        ? item.languages.map(String)
        : ['en'];
    const primaryLanguage = (languages[0] || 'en').split('-')[0].toLowerCase();
    const rawName = String(item?.name || id.split('-')[1] || id);
    const displayName = String(meta.display_name || rawName.charAt(0).toUpperCase() + rawName.slice(1));
    return {
        id,
        name: rawName,
        displayName,
        family,
        providerVersion: family === 'flux-v2' ? 'v2' : 'v1',
        languages,
        primaryLanguage,
        accent: String(meta.accent || 'General'),
        gender: inferGender(tags),
        age: String(meta.age || 'Adult'),
        tags,
        useCases,
        sampleUrl: typeof meta.sample === 'string' && meta.sample.startsWith('https://') ? meta.sample : null,
        avatarUrl: typeof meta.image === 'string' && meta.image.startsWith('https://') ? meta.image : null,
        featured: FEATURED_IDS.has(id),
    };
}
async function fetchDeepgramVoiceCatalog(forceRefresh = false) {
    const apiKey = (0, env_store_1.getSecret)('DEEPGRAM_API_KEY');
    const now = Date.now();
    if (!forceRefresh &&
        cachedVoices &&
        now - cachedVoices.fetchedAt < CACHE_TTL_MS &&
        cachedVoices.authenticated === Boolean(apiKey)) {
        return cachedVoices;
    }
    if (inflightCatalog && !forceRefresh) {
        return inflightCatalog;
    }
    const runFetch = async () => {
        const headers = {
            Accept: 'application/json',
            'Accept-Encoding': 'identity',
        };
        if (apiKey) {
            headers.Authorization = `Token ${apiKey}`;
        }
        const fetchJsonWithRetry = async (url) => {
            let lastErr;
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    const res = await fetch(url, {
                        headers,
                        signal: AbortSignal.timeout(20000),
                    });
                    if (apiKey && res.status === 401) {
                        throw new Error('DEEPGRAM_API_KEY was rejected (401 Unauthorized) by api.deepgram.com');
                    }
                    return res.ok ? await res.json() : { tts: [], stt: [] };
                }
                catch (e) {
                    if (String(e?.message || '').includes('401 Unauthorized'))
                        throw e;
                    lastErr = e;
                }
            }
            throw lastErr;
        };
        try {
            const v2Json = await fetchJsonWithRetry('https://api.deepgram.com/v2/models');
            const v1Json = await fetchJsonWithRetry('https://api.deepgram.com/v1/models');
            const byId = new Map();
            for (const item of Array.isArray(v2Json.tts) ? v2Json.tts : []) {
                const v = normalizeTtsModel(item, 'flux-v2');
                if (v)
                    byId.set(v.id, v);
            }
            for (const item of Array.isArray(v1Json.tts) ? v1Json.tts : []) {
                const v = normalizeTtsModel(item, 'aura-2');
                if (v && !byId.has(v.id))
                    byId.set(v.id, v);
            }
            const voices = Array.from(byId.values()).sort((a, b) => {
                if (a.featured !== b.featured)
                    return a.featured ? -1 : 1;
                const famRank = { 'flux-v2': 0, 'aura-2': 1, 'aura-1': 2 };
                if (famRank[a.family] !== famRank[b.family])
                    return famRank[a.family] - famRank[b.family];
                return a.displayName.localeCompare(b.displayName);
            });
            // Voice Agent Settings accepts Nova-3 plus the Flux v2 listen models.
            const sttSet = new Set(['nova-3', 'flux-general-en', 'flux-general-multi']);
            if (voices.length === 0) {
                throw new Error('Deepgram models response returned 0 TTS voices');
            }
            cachedVoices = {
                fetchedAt: Date.now(),
                source: 'deepgram_live_api',
                authenticated: Boolean(apiKey),
                voices,
                sttModels: Array.from(sttSet),
            };
            return cachedVoices;
        }
        catch (err) {
            if (String(err?.message || '').includes('401 Unauthorized')) {
                throw err;
            }
            const staticVoices = loadStaticVoiceCatalog();
            cachedVoices = {
                fetchedAt: Date.now(),
                source: 'fallback_catalog',
                authenticated: false,
                voices: staticVoices,
                sttModels: ['nova-3', 'flux-general-en', 'flux-general-multi'],
            };
            return cachedVoices;
        }
        finally {
            inflightCatalog = null;
        }
    };
    inflightCatalog = runFetch();
    return inflightCatalog;
}
const defaults_1 = require("./defaults");
async function fetchDeepgramLlmModels() {
    try {
        const res = await fetch('https://agent.deepgram.com/v1/agent/settings/think/models', {
            headers: { Accept: 'application/json', 'Accept-Encoding': 'identity' },
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        return Array.isArray(data?.models) && data.models.length > 0 ? data.models : defaults_1.DEEPGRAM_MANAGED_LLM_CATALOG;
    }
    catch {
        return defaults_1.DEEPGRAM_MANAGED_LLM_CATALOG;
    }
}
const ALLOWED_SAMPLE_HOSTS = new Set(['cdn.sanity.io', 'static.deepgram.com']);
async function fetchAllowedSampleAudio(sampleUrl) {
    let parsed;
    try {
        parsed = new URL(sampleUrl);
    }
    catch {
        throw new Error('Invalid sample URL');
    }
    if (parsed.protocol !== 'https:' || !ALLOWED_SAMPLE_HOSTS.has(parsed.hostname)) {
        throw new Error('Sample URL host is not allowlisted');
    }
    try {
        const res = await fetch(parsed.toString(), { signal: AbortSignal.timeout(12000) });
        if (!res.ok) {
            throw new Error(`Upstream sample returned HTTP ${res.status}`);
        }
        const contentType = res.headers.get('content-type') || 'audio/wav';
        const arr = await res.arrayBuffer();
        return { buffer: Buffer.from(arr), contentType };
    }
    catch (err) {
        if (String(err?.message || '').includes('Upstream sample returned HTTP')) {
            throw err;
        }
        return { buffer: buildOfflineWavSample(600, 8000), contentType: 'audio/wav' };
    }
}
async function synthesizeTtsPreview(req) {
    const text = (req.text || '').trim();
    if (!text) {
        throw Object.assign(new Error('Text to synthesize cannot be empty.'), { statusCode: 400, code: 'EMPTY_TEXT' });
    }
    if (text.length > 2000) {
        throw Object.assign(new Error('Preview text must be 2,000 characters or fewer.'), {
            statusCode: 400,
            code: 'TEXT_TOO_LONG',
        });
    }
    const providerType = req.providerType || 'deepgram';
    if (providerType === 'deepgram') {
        const apiKey = (0, env_store_1.getSecret)('DEEPGRAM_API_KEY');
        if (!apiKey) {
            throw Object.assign(new Error('DEEPGRAM_API_KEY is not configured yet. Click "🔑 API Keys" in the top bar (or add DEEPGRAM_API_KEY to .env) to synthesize custom text with real Deepgram TTS — or click "▶ Sample" on any voice card to hear its studio sample immediately!'), { statusCode: 400, code: 'MISSING_DEEPGRAM_KEY' });
        }
        const model = (req.model || 'flux-haley-en').trim();
        const isFlux = model.startsWith('flux-');
        const baseEndpoint = isFlux ? 'https://api.deepgram.com/v2/speak' : 'https://api.deepgram.com/v1/speak';
        const params = new URLSearchParams({ model, encoding: 'mp3' });
        const speed = Number(req.speed ?? 1.0);
        if (isFlux) {
            const snappedSpeed = (0, settings_builder_1.isValidFluxSpeed)(speed) ? speed : Math.round(Math.min(1.5, Math.max(0.5, speed)) * 20) / 20;
            if (snappedSpeed !== 1.0)
                params.set('speed', String(snappedSpeed));
            const expr = Math.round(Number(req.expressivity ?? 0));
            if (expr >= -2 && expr <= 2 && expr !== 0)
                params.set('expressivity', String(expr));
        }
        else if (speed >= 0.7 && speed <= 1.5 && speed !== 1.0) {
            params.set('speed', String(speed));
        }
        const callSpeak = async (qs) => fetch(`${baseEndpoint}?${qs.toString()}`, {
            method: 'POST',
            headers: {
                Authorization: `Token ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ text }),
            signal: AbortSignal.timeout(15000),
        });
        let res = await callSpeak(params);
        if (!res.ok && params.has('speed')) {
            const bodyTxt = await res.text();
            if (bodyTxt.includes('SPEED_NOT_SUPPORTED')) {
                params.delete('speed');
                res = await callSpeak(params);
            }
            else {
                throw Object.assign(new Error(`Deepgram TTS error (${res.status}): ${bodyTxt.slice(0, 240)}`), {
                    statusCode: res.status === 401 ? 401 : 400,
                    code: 'DEEPGRAM_TTS_ERROR',
                });
            }
        }
        if (!res.ok) {
            const bodyTxt = await res.text();
            throw Object.assign(new Error(`Deepgram TTS error (${res.status}): ${bodyTxt.slice(0, 240)}`), {
                statusCode: res.status === 401 ? 401 : 400,
                code: 'DEEPGRAM_TTS_ERROR',
            });
        }
        const arr = await res.arrayBuffer();
        return {
            buffer: Buffer.from(arr),
            contentType: res.headers.get('content-type') || 'audio/mpeg',
            usedModel: model,
        };
    }
    if (providerType === 'eleven_labs') {
        const apiKey = (0, env_store_1.getSecret)('ELEVENLABS_API_KEY');
        if (!apiKey) {
            throw Object.assign(new Error('ELEVENLABS_API_KEY is not set in server .env. Click "🔑 API Keys" to add it.'), { statusCode: 400, code: 'MISSING_ELEVENLABS_KEY' });
        }
        const voiceId = req.voiceId || '21m00Tcm4TlvDq8ikWAM';
        const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
            method: 'POST',
            headers: {
                'xi-api-key': apiKey,
                'Content-Type': 'application/json',
                Accept: 'audio/mpeg',
            },
            body: JSON.stringify({
                text,
                model_id: req.model || 'eleven_turbo_v2_5',
            }),
            signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
            const errTxt = await res.text();
            throw Object.assign(new Error(`ElevenLabs TTS error (${res.status}): ${errTxt.slice(0, 200)}`), {
                statusCode: 400,
            });
        }
        return {
            buffer: Buffer.from(await res.arrayBuffer()),
            contentType: res.headers.get('content-type') || 'audio/mpeg',
            usedModel: req.model,
        };
    }
    if (providerType === 'cartesia') {
        const apiKey = (0, env_store_1.getSecret)('CARTESIA_API_KEY');
        if (!apiKey) {
            throw Object.assign(new Error('CARTESIA_API_KEY is not set in server .env. Click "🔑 API Keys" to add it.'), { statusCode: 400, code: 'MISSING_CARTESIA_KEY' });
        }
        const res = await fetch('https://api.cartesia.ai/tts/bytes', {
            method: 'POST',
            headers: {
                'X-API-Key': apiKey,
                'Cartesia-Version': '2024-06-10',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                transcript: text,
                model_id: req.model || 'sonic-2',
                voice: { mode: 'id', id: req.voiceId || 'a167e0f3-df7e-4d52-a9c3-f949145efdab' },
                output_format: { container: 'wav', encoding: 'pcm_s16le', sample_rate: 24000 },
            }),
            signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
            const errTxt = await res.text();
            throw Object.assign(new Error(`Cartesia TTS error (${res.status}): ${errTxt.slice(0, 200)}`), {
                statusCode: 400,
            });
        }
        return {
            buffer: Buffer.from(await res.arrayBuffer()),
            contentType: 'audio/wav',
            usedModel: req.model,
        };
    }
    if (providerType === 'speech_service') {
        const out = await (0, speech_service_client_1.synthesizeWithSpeechService)({
            text,
            voice: req.voiceId || req.model || 'af_heart',
            format: 'wav',
            speed: req.speed,
        });
        return {
            buffer: out.buffer,
            contentType: out.contentType,
            usedModel: out.usedVoice,
        };
    }
    throw Object.assign(new Error(`Live preview synthesis is supported for Deepgram, Local Speech Service, ElevenLabs, and Cartesia (got "${providerType}").`), { statusCode: 400, code: 'UNSUPPORTED_PREVIEW_PROVIDER' });
}
