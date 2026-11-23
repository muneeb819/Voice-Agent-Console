// Deepgram streaming speech-to-text for screening only. Separate from the
// voice-agent session, which is not opened until a person is confirmed.
import WebSocket from 'ws';
import { getSecret } from '../env-store';

export interface ScreeningAsr {
  send(pcm8k: Buffer): void;
  close(): void;
}

export interface AsrCallbacks {
  onReady(): void;
  onTranscript(text: string, isFinal: boolean): void;
  onError(message: string): void;
}

export type AsrFactory = (cb: AsrCallbacks) => ScreeningAsr;

export function deepgramListenUrl(model: string): string {
  const q = new URLSearchParams({
    model: model || 'nova-3',
    encoding: 'linear16',
    sample_rate: '8000',
    channels: '1',
    interim_results: 'true',
    punctuate: 'true',
    endpointing: '300',
    smart_format: 'false',
  });
  return `wss://api.deepgram.com/v1/listen?${q.toString()}`;
}

export function createDeepgramAsr(model: string, connectTimeoutMs = 3000): AsrFactory {
  return (cb) => {
    const key = getSecret('DEEPGRAM_API_KEY');
    let closed = false;
    let ready = false;
    let failed = false;
    const queue: Buffer[] = [];
    const fail = (msg: string) => {
      if (failed || closed) return;
      failed = true;
      cb.onError(msg);
    };
    if (!key) {
      setImmediate(() => fail('DEEPGRAM_API_KEY is not set'));
      return { send: () => {}, close: () => { closed = true; } };
    }
    const ws = new WebSocket(deepgramListenUrl(model), { headers: { Authorization: `Token ${key}` }, handshakeTimeout: connectTimeoutMs, family: 4 });
    const timer = setTimeout(() => { if (!ready) { fail('Deepgram did not connect in time'); try { ws.terminate(); } catch {} } }, connectTimeoutMs);
    const keepAlive = setInterval(() => { if (ready && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'KeepAlive' })); }, 5000);
    ws.on('open', () => {
      ready = true;
      clearTimeout(timer);
      while (queue.length) ws.send(queue.shift() as Buffer, { binary: true });
      cb.onReady();
    });
    ws.on('message', (raw, isBinary) => {
      if (isBinary || closed) return;
      try {
        const msg = JSON.parse(raw.toString());
        if (msg?.type === 'Results') {
          const text = String(msg?.channel?.alternatives?.[0]?.transcript || '');
          if (text.trim()) cb.onTranscript(text, Boolean(msg.is_final));
        } else if (msg?.type === 'Error' || msg?.err_code) {
          fail(String(msg.description || msg.err_msg || msg.err_code || 'Deepgram error'));
        }
      } catch {}
    });
    ws.on('unexpected-response', (_req, res) => fail(`Deepgram HTTP ${res.statusCode}`));
    ws.on('error', (err) => fail(err?.message || 'Deepgram connection error'));
    ws.on('close', () => { clearTimeout(timer); clearInterval(keepAlive); if (!closed) fail('Deepgram connection closed'); });
    return {
      send(pcm) {
        if (closed || failed) return;
        if (ready && ws.readyState === WebSocket.OPEN) ws.send(pcm, { binary: true });
        else if (queue.length < 150) queue.push(Buffer.from(pcm));
      },
      close() {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        clearInterval(keepAlive);
        try {
          if (ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ type: 'CloseStream' })); setTimeout(() => { try { ws.close(); } catch {} }, 200); }
          else ws.terminate();
        } catch {}
      },
    };
  };
}

/** Synthesises the short probe line once per text/voice and keeps it in memory. */
const probeCache = new Map<string, Buffer>();
export async function deepgramProbeAudio(text: string, voice: string, timeoutMs = 4000): Promise<Buffer | null> {
  const cacheKey = `${voice}|${text}`;
  const hit = probeCache.get(cacheKey);
  if (hit) return hit;
  const key = getSecret('DEEPGRAM_API_KEY');
  if (!key || !text.trim()) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const url = `https://api.deepgram.com/v1/speak?${new URLSearchParams({ model: voice, encoding: 'linear16', sample_rate: '8000', container: 'none' })}`;
    const res = await fetch(url, { method: 'POST', headers: { Authorization: `Token ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal: ctrl.signal });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 800 || buf.length > 8000 * 2 * 6) return null; // 50 ms – 6 s
    probeCache.set(cacheKey, buf);
    return buf;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
