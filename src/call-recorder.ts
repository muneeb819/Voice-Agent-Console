import fs from 'fs';
import path from 'path';

export const RECORDINGS_DIR = path.resolve(__dirname, '..', 'data', 'recordings');
const MAX_SAMPLE_FRAMES = 8000 * 60 * 15; // Cap per-call buffer at 15 minutes (8 kHz)
const MAX_STORED_RECORDINGS = 200;

export interface SavedRecordingMeta {
  fileName: string;
  filePath: string;
  byteSize: number;
  sampleFrames: number;
  durationMs: number;
}

/**
 * Timeline-accurate 8000 Hz 16-bit Stereo WAV Call Recorder:
 * - Left Channel  (Ch 0): Caller (VICIdial / Asterisk leg)
 * - Right Channel (Ch 1): AI Voice Agent (Deepgram TTS leg, barge-in aware)
 */
export class StereoCallRecorder8k {
  private readonly startedAtMs: number;
  private callerChunks: Array<{ startSample: number; pcm: Buffer }> = [];
  private botChunks: Array<{ startSample: number; pcm: Buffer }> = [];
  private callerCursor = 0;
  private botCursor = 0;
  private totalRawBytes = 0;

  constructor(startedAtMs = Date.now()) {
    this.startedAtMs = startedAtMs;
  }

  private nowSampleOffset(): number {
    const elapsedMs = Math.max(0, Date.now() - this.startedAtMs);
    return Math.min(MAX_SAMPLE_FRAMES, Math.floor((elapsedMs * 8000) / 1000));
  }

  public recordCallerPcm8k(pcm8kLe: Buffer): void {
    if (!pcm8kLe || pcm8kLe.length < 2) return;
    const evenLen = pcm8kLe.length & ~1;
    if (evenLen === 0) return;
    const samples = evenLen >> 1;
    const nowPos = this.nowSampleOffset();
    // Allow continuous 20ms packet streams without jitter gaps while anchoring after silence
    const startSample = Math.abs(nowPos - this.callerCursor) <= 800 ? this.callerCursor : Math.max(this.callerCursor, nowPos);
    if (startSample >= MAX_SAMPLE_FRAMES) return;

    const clippedSamples = Math.min(samples, MAX_SAMPLE_FRAMES - startSample);
    const copy = Buffer.from(pcm8kLe.subarray(0, clippedSamples * 2));
    this.callerChunks.push({ startSample, pcm: copy });
    this.callerCursor = startSample + clippedSamples;
    this.totalRawBytes += copy.length;
  }

  public recordBotPcm8k(pcm8kLe: Buffer): void {
    if (!pcm8kLe || pcm8kLe.length < 2) return;
    const evenLen = pcm8kLe.length & ~1;
    if (evenLen === 0) return;
    const samples = evenLen >> 1;
    const nowPos = this.nowSampleOffset();
    const startSample = Math.max(this.botCursor, nowPos);
    if (startSample >= MAX_SAMPLE_FRAMES) return;

    const clippedSamples = Math.min(samples, MAX_SAMPLE_FRAMES - startSample);
    const copy = Buffer.from(pcm8kLe.subarray(0, clippedSamples * 2));
    this.botChunks.push({ startSample, pcm: copy });
    this.botCursor = startSample + clippedSamples;
    this.totalRawBytes += copy.length;
  }

  /**
   * Trims any queued/unplayed future bot samples if caller barges in mid-utterance.
   */
  public onBargeIn(): void {
    const cutSample = this.nowSampleOffset();
    if (this.botCursor <= cutSample) return;
    const trimmed: Array<{ startSample: number; pcm: Buffer }> = [];
    for (const ch of this.botChunks) {
      if (ch.startSample >= cutSample) continue;
      const chSamples = ch.pcm.length >> 1;
      if (ch.startSample + chSamples <= cutSample) {
        trimmed.push(ch);
      } else {
        const keepSamples = Math.max(0, cutSample - ch.startSample);
        if (keepSamples > 0) {
          trimmed.push({
            startSample: ch.startSample,
            pcm: ch.pcm.subarray(0, keepSamples * 2),
          });
        }
      }
    }
    this.botChunks = trimmed;
    this.botCursor = cutSample;
  }

  public finalizeAndSave(callId: string): SavedRecordingMeta | null {
    const totalSamples = Math.min(
      MAX_SAMPLE_FRAMES,
      Math.max(this.callerCursor, this.botCursor)
    );
    if (totalSamples === 0 || this.totalRawBytes === 0) {
      return null;
    }

    fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
    const safeId = callId.replace(/[^a-zA-Z0-9._-]/g, '_');
    const fileName = `${safeId}.wav`;
    const filePath = path.join(RECORDINGS_DIR, fileName);

    const left = new Int16Array(totalSamples);
    const right = new Int16Array(totalSamples);

    for (const c of this.callerChunks) {
      const count = c.pcm.length >> 1;
      for (let i = 0; i < count && c.startSample + i < totalSamples; i++) {
        const idx = c.startSample + i;
        const mixed = left[idx] + c.pcm.readInt16LE(i * 2);
        left[idx] = mixed > 32767 ? 32767 : mixed < -32768 ? -32768 : mixed;
      }
    }

    for (const b of this.botChunks) {
      const count = b.pcm.length >> 1;
      for (let i = 0; i < count && b.startSample + i < totalSamples; i++) {
        const idx = b.startSample + i;
        const mixed = right[idx] + b.pcm.readInt16LE(i * 2);
        right[idx] = mixed > 32767 ? 32767 : mixed < -32768 ? -32768 : mixed;
      }
    }

    const numChannels = 2;
    const sampleRate = 8000;
    const bitsPerSample = 16;
    const blockAlign = (numChannels * bitsPerSample) >> 3; // 4 bytes
    const byteRate = sampleRate * blockAlign; // 32000 bytes/sec
    const dataByteLength = totalSamples * blockAlign;

    const wavBuf = Buffer.allocUnsafe(44 + dataByteLength);
    wavBuf.write('RIFF', 0, 'ascii');
    wavBuf.writeUInt32LE(36 + dataByteLength, 4);
    wavBuf.write('WAVE', 8, 'ascii');
    wavBuf.write('fmt ', 12, 'ascii');
    wavBuf.writeUInt32LE(16, 16); // PCM chunk size
    wavBuf.writeUInt16LE(1, 20); // AudioFormat = 1 (PCM)
    wavBuf.writeUInt16LE(numChannels, 22);
    wavBuf.writeUInt32LE(sampleRate, 24);
    wavBuf.writeUInt32LE(byteRate, 28);
    wavBuf.writeUInt16LE(blockAlign, 32);
    wavBuf.writeUInt16LE(bitsPerSample, 34);
    wavBuf.write('data', 36, 'ascii');
    wavBuf.writeUInt32LE(dataByteLength, 40);

    let outOffset = 44;
    for (let i = 0; i < totalSamples; i++) {
      wavBuf.writeInt16LE(left[i], outOffset);
      wavBuf.writeInt16LE(right[i], outOffset + 2);
      outOffset += 4;
    }

    fs.writeFileSync(filePath, wavBuf);
    pruneOldRecordings();

    return {
      fileName,
      filePath,
      byteSize: wavBuf.length,
      sampleFrames: totalSamples,
      durationMs: Math.round((totalSamples * 1000) / sampleRate),
    };
  }
}

export function resolveRecordingPath(fileOrCallId: string): string | null {
  const clean = path.basename(String(fileOrCallId || '').trim());
  if (!clean) return null;
  const fileName = clean.endsWith('.wav') ? clean : `${clean}.wav`;
  if (!/^[a-zA-Z0-9._-]+\.wav$/.test(fileName)) return null;
  const full = path.join(RECORDINGS_DIR, fileName);
  return fs.existsSync(full) ? full : null;
}

export function pruneOldRecordings(maxKeep = MAX_STORED_RECORDINGS): void {
  try {
    if (!fs.existsSync(RECORDINGS_DIR)) return;
    const files = fs
      .readdirSync(RECORDINGS_DIR)
      .filter((f) => f.endsWith('.wav'))
      .map((f) => {
        const full = path.join(RECORDINGS_DIR, f);
        const st = fs.statSync(full);
        return { full, mtimeMs: st.mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const stale of files.slice(maxKeep)) {
      try {
        fs.unlinkSync(stale.full);
      } catch {}
    }
  } catch {}
}

export function clearAllRecordings(): void {
  try {
    if (!fs.existsSync(RECORDINGS_DIR)) return;
    for (const f of fs.readdirSync(RECORDINGS_DIR)) {
      if (f.endsWith('.wav')) {
        try {
          fs.unlinkSync(path.join(RECORDINGS_DIR, f));
        } catch {}
      }
    }
  } catch {}
}
