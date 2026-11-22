/**
 * Barge-in sensitivity as a percentage (0-100), shared by live phone calls and
 * (mirrored in public/app.js) the browser Live Bot.
 *
 *   100% = interrupts on soft speech quickly (quiet callers, clean lines)
 *    50% = balanced (old "Balanced" preset)
 *     0% = only clear, sustained speech interrupts (noisy rooms, TV, coughs)
 *
 * The old presets map to High = 80, Balanced = 50, Low = 20 and give exactly
 * the previous browser thresholds at those points.
 */
export type BargeInPreset = 'high' | 'balanced' | 'low';

export const PRESET_TO_PCT: Record<BargeInPreset, number> = { high: 80, balanced: 50, low: 20 };

export function normalizeBargeInPct(pct: unknown, preset?: unknown): number {
  const n = Number(pct);
  if (pct !== undefined && pct !== null && pct !== '' && Number.isFinite(n)) return Math.min(100, Math.max(0, Math.round(n)));
  // Own keys only: a saved value such as "__proto__" must not reach Object.prototype.
  return typeof preset === 'string' && Object.prototype.hasOwnProperty.call(PRESET_TO_PCT, preset) ? PRESET_TO_PCT[preset as BargeInPreset] : 50;
}

export function presetForPct(pct: number): BargeInPreset {
  return pct >= 67 ? 'high' : pct <= 33 ? 'low' : 'balanced';
}

/** Loudness (normalised RMS 0..1) and duration a caller sound needs to interrupt. */
export function bargeInThresholds(pct: number): { rms: number; minMs: number; frames: number } {
  const p = Math.min(100, Math.max(0, pct));
  // Log-linear through the old presets: 80 -> 0.022, 50 -> 0.038, 20 -> 0.065.
  // Capped at the Low level (0.065): below 20% only the required duration grows,
  // so clear speech can always interrupt even at 0%.
  const rms = Math.min(0.065, Math.exp(-2.733 - 0.01807 * (p - 20)));
  const frames = Math.max(1, Math.round(5 - p / 25)); // 100 -> 1, 80 -> 2, 50 -> 3, 20 -> 4, 0 -> 5
  return { rms, minMs: frames * 40, frames };
}

function rmsOfPcm16(pcm: Buffer): number {
  const samples = Math.floor(pcm.length / 2);
  if (!samples) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i += 1) {
    const v = pcm.readInt16LE(i * 2) / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / samples);
}

/**
 * Phone-call gate: Deepgram's UserStartedSpeaking fires on any detected sound.
 * Only flush the bot's queued speech when the caller's own audio has actually
 * been loud enough for long enough for this bot's sensitivity.
 */
export class BargeInGate {
  private loudMs = 0;
  private pendingSince = 0;
  private readonly rms: number;
  private readonly minMs: number;

  constructor(
    pct: number,
    private readonly onFlush: () => void,
    private readonly now: () => number = Date.now,
    private readonly sampleRate = 8000,
  ) {
    const t = bargeInThresholds(pct);
    this.rms = t.rms;
    this.minMs = pct >= 100 ? 0 : t.minMs;
  }

  /** Feed 16-bit mono caller audio at the gate's sample rate (8 kHz phone, 16 kHz browser). */
  onCallerAudio(pcm8k: Buffer): void {
    const frameMs = (pcm8k.length / 2) / (this.sampleRate / 1000);
    if (rmsOfPcm16(pcm8k) >= this.rms) this.loudMs += frameMs;
    else this.loudMs = Math.max(0, this.loudMs - frameMs);
    if (this.pendingSince) {
      if (this.loudMs >= this.minMs) {
        this.pendingSince = 0;
        this.onFlush();
      } else if (this.now() - this.pendingSince > 1500) {
        this.pendingSince = 0; // a cough or noise blip: keep talking
      }
    }
  }

  /** Deepgram reported the caller started speaking. Returns true if flushed now. */
  onUserStartedSpeaking(): boolean {
    if (this.loudMs >= this.minMs) {
      this.pendingSince = 0;
      this.onFlush();
      return true;
    }
    this.pendingSince = this.now();
    return false;
  }
}
