"use strict";
/**
 * Background-voice filter ("primary speaker isolation") for caller audio.
 *
 * Problem: on a phone call the customer is close to the microphone while other
 * people in the room (family, a TV, a coworker) are further away. Deepgram
 * transcribes every voice it hears, so the bot answered words the customer
 * never said.
 *
 * Approach: track how loud the customer's own speech is (a robust percentile of
 * recent voiced audio, so a door bang cannot hijack it) and mute audio that is
 * clearly quieter than that level before it reaches Deepgram and the barge-in
 * gate. The call recording keeps the raw audio.
 *
 *   0%   = off (audio passes untouched)
 *   50%  = mutes voices about 13 dB quieter than the customer
 *   100% = strongest: mutes anything about 6 dB quieter than the customer
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BackgroundVoiceFilter = void 0;
exports.normalizeVoiceFilterPct = normalizeVoiceFilterPct;
exports.voiceFilterMarginDb = voiceFilterMarginDb;
function normalizeVoiceFilterPct(pct) {
    const n = Number(pct);
    if (pct === undefined || pct === null || pct === '' || !Number.isFinite(n))
        return 0;
    return Math.min(100, Math.max(0, Math.round(n)));
}
/** dB below the customer's speech level at which audio is muted (0 => filter off). */
function voiceFilterMarginDb(pct) {
    const p = normalizeVoiceFilterPct(pct);
    if (p <= 0)
        return 0;
    return 20 - 0.14 * p; // 1% -> ~19.9 dB, 50% -> 13 dB, 100% -> 6 dB
}
const BLOCK_MS = 10;
const BINS = 100; // 1 dB bins covering -100..0 dBFS
const HISTORY_BLOCKS = 800; // ~8 s of voiced caller audio
const MIN_HISTORY = 30; // ~300 ms of voiced audio before the filter engages
const HOLD_MS = 150; // keep word tails (s, f, t) after a loud vowel
const CLOSED_GAIN = 0.03; // about -30 dB
const SPEECH_PERCENTILE = 0.8;
function dbfs(sumSquares, samples) {
    if (!samples || sumSquares <= 0)
        return -100;
    const rms = Math.sqrt(sumSquares / samples) / 32768;
    return Math.max(-100, 20 * Math.log10(Math.max(rms, 1e-5)));
}
class BackgroundVoiceFilter {
    sampleRate;
    margin;
    blockSamples;
    hist = new Uint16Array(BINS);
    ring = new Uint8Array(HISTORY_BLOCKS);
    ringLen = 0;
    ringPos = 0;
    floorDb = -60;
    smoothDb = -100;
    holdLeftMs = 0;
    gain = 1;
    constructor(pct, sampleRate = 8000) {
        this.sampleRate = sampleRate;
        this.margin = voiceFilterMarginDb(pct);
        this.blockSamples = Math.max(1, Math.round((sampleRate * BLOCK_MS) / 1000));
    }
    get enabled() {
        return this.margin > 0;
    }
    /** Current estimate of the customer's speech level in dBFS (null until learned). */
    speechLevelDb() {
        if (this.ringLen < MIN_HISTORY)
            return null;
        const target = Math.ceil(this.ringLen * (1 - SPEECH_PERCENTILE));
        let seen = 0;
        for (let b = BINS - 1; b >= 0; b -= 1) {
            seen += this.hist[b];
            if (seen >= target)
                return b - 100 + 0.5;
        }
        return null;
    }
    remember(levelDb) {
        const bin = Math.min(BINS - 1, Math.max(0, Math.floor(levelDb + 100)));
        if (this.ringLen === HISTORY_BLOCKS) {
            this.hist[this.ring[this.ringPos]] -= 1;
        }
        else {
            this.ringLen += 1;
        }
        this.ring[this.ringPos] = bin;
        this.hist[bin] += 1;
        this.ringPos = (this.ringPos + 1) % HISTORY_BLOCKS;
    }
    /**
     * Filter 16-bit little-endian mono PCM. Returns a new buffer (or the input
     * itself when the filter is off). Odd trailing bytes are passed through.
     */
    process(pcm) {
        if (!this.enabled || pcm.length < 2)
            return pcm;
        const out = Buffer.from(pcm);
        const total = Math.floor(out.length / 2);
        for (let start = 0; start < total; start += this.blockSamples) {
            const end = Math.min(total, start + this.blockSamples);
            const n = end - start;
            let sum = 0;
            for (let i = start; i < end; i += 1) {
                const v = out.readInt16LE(i * 2);
                sum += v * v;
            }
            const levelDb = dbfs(sum, n);
            const blockMs = (n / this.sampleRate) * 1000;
            // Smoothed level (~100 ms) so a single click cannot count as speech.
            this.smoothDb = this.smoothDb <= -99 ? levelDb : this.smoothDb + 0.1 * (levelDb - this.smoothDb);
            // Line noise floor: falls instantly, rises slowly (~5 dB/s).
            if (this.smoothDb < this.floorDb)
                this.floorDb = this.smoothDb;
            else
                this.floorDb += 0.05 * (blockMs / BLOCK_MS);
            const voiced = this.smoothDb > this.floorDb + 9 && this.smoothDb > -60;
            if (voiced)
                this.remember(this.smoothDb);
            const speechDb = this.speechLevelDb();
            let targetGain = 1;
            if (speechDb !== null) {
                const threshold = speechDb - this.margin;
                if (levelDb >= threshold) {
                    this.holdLeftMs = HOLD_MS;
                }
                else {
                    this.holdLeftMs = Math.max(0, this.holdLeftMs - blockMs);
                }
                targetGain = this.holdLeftMs > 0 ? 1 : CLOSED_GAIN;
            }
            // Open instantly, close over ~50 ms; ramp inside the block to avoid clicks.
            const startGain = this.gain;
            const endGain = targetGain >= startGain ? targetGain : Math.max(targetGain, startGain - 0.2 * (blockMs / BLOCK_MS));
            if (startGain !== 1 || endGain !== 1) {
                for (let i = start; i < end; i += 1) {
                    const g = startGain + (endGain - startGain) * ((i - start + 1) / n);
                    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(out.readInt16LE(i * 2) * g))), i * 2);
                }
            }
            this.gain = endGain;
        }
        return out;
    }
}
exports.BackgroundVoiceFilter = BackgroundVoiceFilter;
