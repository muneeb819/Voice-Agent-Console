import WebSocket from 'ws';
import { getPreferredLanIpv4 } from './demo-tunnel';
import { getSecret } from './env-store';

export const KOKORO_STOCK_VOICES = [
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
] as const;

export const SPEECH_SERVICE_STT_MODELS = ['large-v3-turbo', 'whisper-1'] as const;

export function getSpeechServiceBaseUrl(explicitUrl?: string): string {
  const raw = String(
    explicitUrl || getSecret('SPEECH_SERVICE_URL') || process.env.SPEECH_SERVICE_URL || ''
  ).trim();
  if (raw) return raw.replace(/\/+$/, '');
  const lanIp = getPreferredLanIpv4() || 'localhost';
  return `http://${lanIp}:8000`;
}

export function getSpeechServiceWsBaseUrl(explicitUrl?: string): string {
  return getSpeechServiceBaseUrl(explicitUrl)
    .replace(/^http:/i, 'ws:')
    .replace(/^https:/i, 'wss:');
}

export function getSpeechServiceHeaders(explicitKey?: string): Record<string, string> {
  const key = String(explicitKey ?? getSecret('SPEECH_SERVICE_API_KEY') ?? '').trim();
  return key ? { Authorization: `Bearer ${key}`, 'X-API-Key': key } : {};
}

export interface SpeechServiceDiagnostic {
  ok: boolean;
  baseUrl: string;
  latencyMs: number;
  ready?: { status: string; stt: string; tts: string; clone: boolean };
  stockVoices: string[];
  clonedVoices: Array<{ id: string; name: string; speaker_name: string; duration: number }>;
  ttsSmokeOk: boolean;
  error?: string;
}

export async function verifySpeechServiceConnection(
  explicitUrl?: string,
  explicitKey?: string
): Promise<SpeechServiceDiagnostic> {
  const baseUrl = getSpeechServiceBaseUrl(explicitUrl);
  const headers = getSpeechServiceHeaders(explicitKey);
  const started = Date.now();
  const out: SpeechServiceDiagnostic = {
    ok: false,
    baseUrl,
    latencyMs: 0,
    stockVoices: [...KOKORO_STOCK_VOICES],
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
    out.ready = (await readyRes.json()) as SpeechServiceDiagnostic['ready'];

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
      const sj: any = await stockRes.json();
      if (Array.isArray(sj?.voices) && sj.voices.length > 0) out.stockVoices = sj.voices;
    }
    if (cloneRes.ok) {
      const cj: any = await cloneRes.json();
      if (Array.isArray(cj?.voices)) out.clonedVoices = cj.voices;
    }
    if (ttsRes.ok) {
      const wav = await ttsRes.arrayBuffer();
      out.ttsSmokeOk = wav.byteLength > 44;
    } else {
      const errTxt = await ttsRes.text();
      out.error = `TTS check failed (${ttsRes.status}): ${errTxt.slice(0, 160)}`;
      return out;
    }
    out.ok = Boolean(out.ready?.status === 'ready' && out.ttsSmokeOk);
    return out;
  } catch (err: any) {
    out.latencyMs = Date.now() - started;
    out.error = err?.message || `Unable to reach Speech Service at ${baseUrl}`;
    return out;
  }
}

export interface SpeechServiceRoundTripResult {
  ok: boolean;
  baseUrl: string;
  voice: string;
  sttEngine: string;
  ttsEngine: string;
  ttsBytes: number;
  ttsMs: number;
  sttText: string;
  sttMs: number;
  audioBase64?: string;
  error?: string;
}

export async function runSpeechServiceRoundTripSmoke(opts?: {
  url?: string;
  apiKey?: string;
  voice?: string;
  text?: string;
}): Promise<SpeechServiceRoundTripResult> {
  const baseUrl = getSpeechServiceBaseUrl(opts?.url);
  const headers = getSpeechServiceHeaders(opts?.apiKey);
  const voice = (opts?.voice || 'af_heart').trim();
  const sampleText =
    (opts?.text || '').trim() || 'Hello from Voice Agent Console! Local Kokoro and Faster-Whisper are ready.';

  const out: SpeechServiceRoundTripResult = {
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
    const rj: any = await readyRes.json();
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
    const sttJson: any = await sttRes.json();
    out.sttText = String(sttJson?.text || '').trim();
    out.ok = out.ttsBytes > 44 && out.sttText.length > 0;
    return out;
  } catch (err: any) {
    out.error = err?.message || `Round-trip check failed against ${baseUrl}`;
    return out;
  }
}

function normalizeSpeechServiceVoice(raw?: string): string {
  const v = String(raw || '').trim();
  if (!v) return 'af_heart';
  if (/^(clone:[0-9a-f]{32}|[a-z]{2}_[a-z0-9]+)$/i.test(v)) return v;
  if (/^(alloy|ash|ballad|coral|echo|fable|nova|onyx|sage|shimmer|verse)$/i.test(v)) return v.toLowerCase();
  return 'af_heart';
}

export async function synthesizeWithSpeechService(opts: {
  text: string;
  voice?: string;
  format?: 'wav' | 'pcm' | 'ulaw' | 'mp3' | 'opus' | 'flac';
  sampleRate?: number;
  speed?: number;
  explicitUrl?: string;
  explicitKey?: string;
}): Promise<{ buffer: Buffer; contentType: string; usedVoice: string }> {
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

export function openSpeechServiceSttStream(opts: {
  sampleRate: 8000 | 16000 | 24000 | 48000;
  encoding?: 'pcm' | 'ulaw';
  language?: string;
  endpointMs?: number;
  onReady?: () => void;
  onPartial?: (text: string) => void;
  onFinal: (text: string, start: number, end: number) => void;
  onError?: (err: string) => void;
}): WebSocket {
  const ws = new WebSocket(`${getSpeechServiceWsBaseUrl()}/v1/stream/stt`, {
    headers: getSpeechServiceHeaders(),
    family: 4,
  });
  ws.on('open', () => {
    ws.send(
      JSON.stringify({
        sample_rate: opts.sampleRate,
        encoding: opts.encoding || 'pcm',
        language: opts.language || 'en',
        endpoint_ms: opts.endpointMs ?? 550,
        partials: Boolean(opts.onPartial),
      })
    );
  });
  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'ready' && opts.onReady) opts.onReady();
      else if (msg.type === 'partial' && opts.onPartial) opts.onPartial(msg.text);
      else if (msg.type === 'final') opts.onFinal(msg.text, msg.start, msg.end);
      else if (msg.type === 'error' && opts.onError) opts.onError(msg.message || 'STT stream error');
    } catch {}
  });
  ws.on('error', (err) => {
    if (opts.onError) opts.onError(err?.message || 'STT WebSocket connection error');
  });
  return ws;
}

export function openSpeechServiceTtsStream(opts: {
  voice?: string;
  speed?: number;
  format: 'pcm' | 'ulaw';
  sampleRate?: number;
  onAudioChunk: (chunk: Buffer) => void;
  onDone?: (id?: string) => void;
  onError?: (err: string) => void;
}): {
  ws: WebSocket;
  speak: (text: string, id?: string) => void;
  bargeInCancel: () => void;
  close: () => void;
} {
  let configured = false;
  const pendingUtterances: Array<{ id: string; text: string }> = [];
  const ws = new WebSocket(`${getSpeechServiceWsBaseUrl()}/v1/stream/tts`, {
    headers: getSpeechServiceHeaders(),
    family: 4,
  });
  ws.on('open', () => {
    ws.send(
      JSON.stringify({
        type: 'config',
        voice: normalizeSpeechServiceVoice(opts.voice),
        speed: opts.speed ?? 1.0,
        format: opts.format,
        ...(opts.sampleRate ? { sample_rate: opts.sampleRate } : {}),
      })
    );
  });
  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      opts.onAudioChunk(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer));
      return;
    }
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'configured') {
        configured = true;
        while (pendingUtterances.length > 0 && ws.readyState === WebSocket.OPEN) {
          const next = pendingUtterances.shift()!;
          ws.send(JSON.stringify({ type: 'speak', id: next.id, text: next.text }));
        }
      } else if (msg.type === 'done' && opts.onDone) {
        opts.onDone(msg.id);
      } else if (msg.type === 'error' && opts.onError) {
        opts.onError(msg.message || 'TTS stream error');
      }
    } catch {}
  });
  ws.on('error', (err) => {
    if (opts.onError) opts.onError(err?.message || 'TTS WebSocket connection error');
  });
  return {
    ws,
    speak: (text: string, id = `utt_${Date.now()}`) => {
      if (!configured || ws.readyState !== WebSocket.OPEN) {
        pendingUtterances.push({ id, text });
        return;
      }
      ws.send(JSON.stringify({ type: 'speak', id, text }));
    },
    bargeInCancel: () => {
      pendingUtterances.length = 0;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'cancel' }));
      }
    },
    close: () => {
      pendingUtterances.length = 0;
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'close' }));
        ws.close();
      } catch {}
    },
  };
}
