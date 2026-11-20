"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BargeInGate = exports.PRESET_TO_PCT = void 0;
exports.normalizeBargeInPct = normalizeBargeInPct;
exports.presetForPct = presetForPct;
exports.bargeInThresholds = bargeInThresholds;
exports.PRESET_TO_PCT = { high: 80, balanced: 50, low: 20 };
function normalizeBargeInPct(pct, preset) {
    const n = Number(pct);
    if (pct !== undefined && pct !== null && pct !== '' && Number.isFinite(n))
        return Math.min(100, Math.max(0, Math.round(n)));
    return exports.PRESET_TO_PCT[preset] ?? 50;
}
function presetForPct(pct) {
    return pct >= 67 ? 'high' : pct <= 33 ? 'low' : 'balanced';
}
/** Loudness (normalised RMS 0..1) and duration a caller sound needs to interrupt. */
function bargeInThresholds(pct) {
    const p = Math.min(100, Math.max(0, pct));
    // Log-linear through the old presets: 80 -> 0.022, 50 -> 0.038, 20 -> 0.065.
    // Capped at the Low level (0.065): below 20% only the required duration grows,
    // so clear speech can always interrupt even at 0%.
    const rms = Math.min(0.065, Math.exp(-2.733 - 0.01807 * (p - 20)));
    const frames = Math.max(1, Math.round(5 - p / 25)); // 100 -> 1, 80 -> 2, 50 -> 3, 20 -> 4, 0 -> 5
    return { rms, minMs: frames * 40, frames };
}
function rmsOfPcm16(pcm) {
    const samples = Math.floor(pcm.length / 2);
    if (!samples)
        return 0;
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
class BargeInGate {
    onFlush;
    now;
    loudMs = 0;
    pendingSince = 0;
    rms;
    minMs;
    constructor(pct, onFlush, now = Date.now) {
        this.onFlush = onFlush;
        this.now = now;
        const t = bargeInThresholds(pct);
        this.rms = t.rms;
        this.minMs = pct >= 100 ? 0 : t.minMs;
    }
    /** Feed 8 kHz 16-bit caller audio. */
    onCallerAudio(pcm8k) {
        const frameMs = (pcm8k.length / 2) / 8;
        if (rmsOfPcm16(pcm8k) >= this.rms)
            this.loudMs += frameMs;
        else
            this.loudMs = Math.max(0, this.loudMs - frameMs);
        if (this.pendingSince) {
            if (this.loudMs >= this.minMs) {
                this.pendingSince = 0;
                this.onFlush();
            }
            else if (this.now() - this.pendingSince > 1500) {
                this.pendingSince = 0; // a cough or noise blip: keep talking
            }
        }
    }
    /** Deepgram reported the caller started speaking. Returns true if flushed now. */
    onUserStartedSpeaking() {
        if (this.loudMs >= this.minMs) {
            this.pendingSince = 0;
            this.onFlush();
            return true;
        }
        this.pendingSince = this.now();
        return false;
    }
}
exports.BargeInGate = BargeInGate;
