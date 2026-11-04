"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SPEECH_SERVICE_STT_MODELS = exports.KOKORO_STOCK_VOICES = void 0;
exports.getSpeechServiceBaseUrl = getSpeechServiceBaseUrl;
exports.getSpeechServiceWsBaseUrl = getSpeechServiceWsBaseUrl;
exports.getSpeechServiceHeaders = getSpeechServiceHeaders;
exports.verifySpeechServiceConnection = verifySpeechServiceConnection;
exports.runSpeechServiceRoundTripSmoke = runSpeechServiceRoundTripSmoke;
exports.synthesizeWithSpeechService = synthesizeWithSpeechService;
exports.openSpeechServiceSttStream = openSpeechServiceSttStream;
exports.openSpeechServiceTtsStream = openSpeechServiceTtsStream;
const ws_1 = __importDefault(require("ws"));
const env_store_1 = require("./env-store");
exports.KOKORO_STOCK_VOICES = [
    'af_heart',
    'af_alloy',
    'af_aoede',
    'af_bella',
    'af_jessica',
    'af_kore',
    'af_nicole',
    'af_nova',
    'af_river',
    'af_sarah',
    'af_sky',
    'am_adam',
    'am_echo',
    'am_eric',
    'am_fenrir',
    'am_liam',
    'am_michael',
    'am_onyx',
    'am_puck',
    'am_santa',
    'bf_alice',
    'bf_emma',
    'bf_isabella',
    'bf_lily',
    'bm_daniel',
    'bm_fable',
    'bm_george',
    'bm_lewis',
];
exports.SPEECH_SERVICE_STT_MODELS = ['large-v3-turbo', 'whisper-1'];
function getSpeechServiceBaseUrl(explicitUrl) {
    const raw = String(explicitUrl || (0, env_store_1.getSecret)('SPEECH_SERVICE_URL') || process.env.SPEECH_SERVICE_URL || '').trim();
    if (raw)
        return raw.replace(/\/+$/, '');
    return 'http://127.0.0.1:8000';
}
function getSpeechServiceWsBaseUrl(explicitUrl) {
    return getSpeechServiceBaseUrl(explicitUrl)
        .replace(/^http:/i, 'ws:')
        .replace(/^https:/i, 'wss:');
}
function getSpeechServiceHeaders(explicitKey) {
    const key = String(explicitKey ?? (0, env_store_1.getSecret)('SPEECH_SERVICE_API_KEY') ?? '').trim();
    return key ? { Authorization: `Bearer ${key}`, 'X-API-Key': key } : {};
}
async function verifySpeechServiceConnection(explicitUrl, explicitKey) {
    const baseUrl = getSpeechServiceBaseUrl(explicitUrl);
    const headers = getSpeechServiceHeaders(explicitKey);
    const started = Date.now();
    const out = {
        ok: false,
        baseUrl,
        latencyMs: 0,
        stockVoices: [...exports.KOKORO_STOCK_VOICES],
        clonedVoices: [],
        ttsSmokeOk: false,
    };
    try {
        const readyRes = await fetch(`${baseUrl}/readyz`, { signal: AbortSignal.timeout(6000) });
        out.latencyMs = Date.now() - started;
        if (!readyRes.ok) {
            out.error = `/readyz returned HTTP ${readyRes.status}`;
            return out;
        }
        out.ready = (await readyRes.json());
        const [stockRes, cloneRes, ttsRes] = await Promise.all([
            fetch(`${baseUrl}/v1/voices/stock`, { headers, signal: AbortSignal.timeout(6000) }),
            fetch(`${baseUrl}/v1/voices`, { headers, signal: AbortSignal.timeout(6000) }),
            fetch(`${baseUrl}/v1/audio/speech`, {
                method: 'POST',
                headers: { ...headers, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    input: 'Speech service connected.',
                    voice: 'af_heart',
                    response_format: 'wav',
                }),
                signal: AbortSignal.timeout(10000),
            }),
        ]);
        if (stockRes.status === 401 || ttsRes.status === 401) {
            out.error = 'HTTP 401: Invalid or missing SPEECH_SERVICE_API_KEY';
            return out;
        }
        if (stockRes.ok) {
            const sj = await stockRes.json();
            if (Array.isArray(sj?.voices) && sj.voices.length > 0)
                out.stockVoices = sj.voices;
        }
        if (cloneRes.ok) {
            const cj = await cloneRes.json();
            if (Array.isArray(cj?.voices))
                out.clonedVoices = cj.voices;
        }
        if (ttsRes.ok) {
            const wav = await ttsRes.arrayBuffer();
            out.ttsSmokeOk = wav.byteLength > 44;
        }
        else {
            const errTxt = await ttsRes.text();
            out.error = `TTS check failed (${ttsRes.status}): ${errTxt.slice(0, 160)}`;
            return out;
        }
        out.ok = Boolean(out.ready?.status === 'ready' && out.ttsSmokeOk);
        return out;
    }
    catch (err) {
        out.latencyMs = Date.now() - started;
        out.error = err?.message || `Unable to reach Speech Service at ${baseUrl}`;
        return out;
    }
}
async function runSpeechServiceRoundTripSmoke(opts) {
    const baseUrl = getSpeechServiceBaseUrl(opts?.url);
    const headers = getSpeechServiceHeaders(opts?.apiKey);
    const voice = (opts?.voice || 'af_heart').trim();
    const sampleText = (opts?.text || '').trim() || 'Hello from Voice Agent Console! Local Kokoro and Faster-Whisper are ready.';
    const out = {
        ok: false,
        baseUrl,
        voice,
        sttEngine: 'unknown',
        ttsEngine: 'unknown',
        ttsBytes: 0,
        ttsMs: 0,
        sttText: '',
        sttMs: 0,
    };
    try {
        const readyRes = await fetch(`${baseUrl}/readyz`, { signal: AbortSignal.timeout(5000) });
        if (!readyRes.ok) {
            out.error = `/readyz returned HTTP ${readyRes.status}`;
            return out;
        }
        const rj = await readyRes.json();
        out.sttEngine = rj?.stt || 'faster-whisper';
        out.ttsEngine = rj?.tts || 'kokoro';
        const t0 = Date.now();
        const ttsRes = await fetch(`${baseUrl}/v1/audio/speech`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'kokoro',
                input: sampleText,
                voice,
                response_format: 'wav',
            }),
            signal: AbortSignal.timeout(15000),
        });
        out.ttsMs = Math.max(1, Date.now() - t0);
        if (!ttsRes.ok) {
            const txt = await ttsRes.text();
            out.error = `TTS HTTP ${ttsRes.status}: ${txt.slice(0, 180)}`;
            return out;
        }
        const wavBuf = Buffer.from(await ttsRes.arrayBuffer());
        out.ttsBytes = wavBuf.length;
        out.audioBase64 = wavBuf.toString('base64');
        const form = new FormData();
        form.append('file', new Blob([wavBuf], { type: 'audio/wav' }), 'roundtrip.wav');
        form.append('response_format', 'json');
        const t1 = Date.now();
        const sttRes = await fetch(`${baseUrl}/v1/audio/transcriptions`, {
            method: 'POST',
            headers,
            body: form,
            signal: AbortSignal.timeout(15000),
        });
        out.sttMs = Math.max(1, Date.now() - t1);
        if (!sttRes.ok) {
            const txt = await sttRes.text();
            out.error = `STT HTTP ${sttRes.status}: ${txt.slice(0, 180)}`;
            return out;
        }
        const sttJson = await sttRes.json();
        out.sttText = String(sttJson?.text || '').trim();
        out.ok = out.ttsBytes > 44 && out.sttText.length > 0;
        return out;
    }
    catch (err) {
        out.error = err?.message || `Round-trip check failed against ${baseUrl}`;
        return out;
    }
}
function normalizeSpeechServiceVoice(raw) {
    const v = String(raw || '').trim();
    if (!v)
        return 'af_heart';
    if (/^(clone:[0-9a-f]{32}|[a-z]{2}_[a-z0-9]+)$/i.test(v))
        return v;
    if (/^(alloy|ash|ballad|coral|echo|fable|nova|onyx|sage|shimmer|verse)$/i.test(v))
        return v.toLowerCase();
    return 'af_heart';
}
async function synthesizeWithSpeechService(opts) {
    const baseUrl = getSpeechServiceBaseUrl(opts.explicitUrl);
    const voice = normalizeSpeechServiceVoice(opts.voice);
    const res = await fetch(`${baseUrl}/v1/audio/speech`, {
        method: 'POST',
        headers: { ...getSpeechServiceHeaders(opts.explicitKey), 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'kokoro',
            input: opts.text,
            voice,
            response_format: opts.format || 'wav',
            speed: opts.speed ?? 1.0,
            ...(opts.sampleRate ? { sample_rate: opts.sampleRate } : {}),
        }),
        signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
        const txt = await res.text();
        throw Object.assign(new Error(`Speech Service TTS (${res.status}): ${txt.slice(0, 200)}`), {
            statusCode: res.status === 401 ? 401 : 400,
            code: 'SPEECH_SERVICE_TTS_FAILED',
        });
    }
    return {
        buffer: Buffer.from(await res.arrayBuffer()),
        contentType: res.headers.get('content-type') || 'audio/wav',
        usedVoice: voice,
    };
}
function openSpeechServiceSttStream(opts) {
    const ws = new ws_1.default(`${getSpeechServiceWsBaseUrl()}/v1/stream/stt`, {
        headers: getSpeechServiceHeaders(),
        family: 4,
    });
    ws.on('open', () => {
        ws.send(JSON.stringify({
            sample_rate: opts.sampleRate,
            encoding: opts.encoding || 'pcm',
            language: opts.language || 'en',
            endpoint_ms: opts.endpointMs ?? 550,
            partials: Boolean(opts.onPartial),
        }));
    });
    ws.on('message', (raw, isBinary) => {
        if (isBinary)
            return;
        try {
            const msg = JSON.parse(raw.toString());
            if (msg.type === 'ready' && opts.onReady)
                opts.onReady();
            else if (msg.type === 'partial' && opts.onPartial)
                opts.onPartial(msg.text);
            else if (msg.type === 'final')
                opts.onFinal(msg.text, msg.start, msg.end);
            else if (msg.type === 'error' && opts.onError)
                opts.onError(msg.message || 'STT stream error');
        }
        catch { }
    });
    ws.on('error', (err) => {
        if (opts.onError)
            opts.onError(err?.message || 'STT WebSocket connection error');
    });
    return ws;
}
function openSpeechServiceTtsStream(opts) {
    let configured = false;
    const pendingUtterances = [];
    const ws = new ws_1.default(`${getSpeechServiceWsBaseUrl()}/v1/stream/tts`, {
        headers: getSpeechServiceHeaders(),
        family: 4,
    });
    ws.on('open', () => {
        ws.send(JSON.stringify({
            type: 'config',
            voice: normalizeSpeechServiceVoice(opts.voice),
            speed: opts.speed ?? 1.0,
            format: opts.format,
            ...(opts.sampleRate ? { sample_rate: opts.sampleRate } : {}),
        }));
    });
    ws.on('message', (raw, isBinary) => {
        if (isBinary) {
            opts.onAudioChunk(Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
            return;
        }
        try {
            const msg = JSON.parse(raw.toString());
            if (msg.type === 'configured') {
                configured = true;
                while (pendingUtterances.length > 0 && ws.readyState === ws_1.default.OPEN) {
                    const next = pendingUtterances.shift();
                    ws.send(JSON.stringify({ type: 'speak', id: next.id, text: next.text }));
                }
            }
            else if (msg.type === 'done' && opts.onDone) {
                opts.onDone(msg.id);
            }
            else if (msg.type === 'error' && opts.onError) {
                opts.onError(msg.message || 'TTS stream error');
            }
        }
        catch { }
    });
    ws.on('error', (err) => {
        if (opts.onError)
            opts.onError(err?.message || 'TTS WebSocket connection error');
    });
    return {
        ws,
        speak: (text, id = `utt_${Date.now()}`) => {
            if (!configured || ws.readyState !== ws_1.default.OPEN) {
                pendingUtterances.push({ id, text });
                return;
            }
            ws.send(JSON.stringify({ type: 'speak', id, text }));
        },
        bargeInCancel: () => {
            pendingUtterances.length = 0;
            if (ws.readyState === ws_1.default.OPEN) {
                ws.send(JSON.stringify({ type: 'cancel' }));
            }
        },
        close: () => {
            pendingUtterances.length = 0;
            try {
                if (ws.readyState === ws_1.default.OPEN)
                    ws.send(JSON.stringify({ type: 'close' }));
                ws.close();
            }
            catch { }
        },
    };
}
