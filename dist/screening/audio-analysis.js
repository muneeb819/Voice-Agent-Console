"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CallAudioAnalyzer = void 0;
exports.analyzeFrame = analyzeFrame;
exports.findSitTone = findSitTone;
exports.findBeep = findBeep;
const SAMPLE_RATE = 8000;
const FRAME = 160; // 20 ms
const FRAME_MS = 20;
const BIN_MIN_HZ = 300;
const BIN_MAX_HZ = 2200;
const BIN_STEP_HZ = 25;
const BINS = [];
for (let hz = BIN_MIN_HZ; hz <= BIN_MAX_HZ; hz += BIN_STEP_HZ) {
    BINS.push({ hz, coeff: 2 * Math.cos((2 * Math.PI * hz) / SAMPLE_RATE) });
}
function analyzeFrame(samples) {
    let energy = 0;
    for (let i = 0; i < samples.length; i++)
        energy += samples[i] * samples[i];
    const rms = Math.sqrt(energy / Math.max(1, samples.length));
    const rmsDb = rms > 0 ? 20 * Math.log10(rms / 32768) : -120;
    if (rmsDb < -70)
        return { rmsDb, tonality: 0, flatness: 1, peakHz: 0 };
    const powers = new Float64Array(BINS.length);
    let total = 0;
    let peakIdx = 0;
    let logSum = 0;
    for (let k = 0; k < BINS.length; k++) {
        const c = BINS[k].coeff;
        let s0 = 0, s1 = 0, s2 = 0;
        for (let i = 0; i < samples.length; i++) {
            s0 = samples[i] + c * s1 - s2;
            s2 = s1;
            s1 = s0;
        }
        const power = Math.max(1e-9, s1 * s1 + s2 * s2 - c * s1 * s2);
        powers[k] = power;
        total += power;
        logSum += Math.log(power);
        if (power > powers[peakIdx])
            peakIdx = k;
    }
    const mean = total / BINS.length;
    const geo = Math.exp(logSum / BINS.length);
    // Adjacent bins overlap (50 Hz resolution, 25 Hz step), so a pure tone fills ~3 bins.
    let local = 0;
    for (let k = Math.max(0, peakIdx - 1); k <= Math.min(BINS.length - 1, peakIdx + 1); k++)
        local += powers[k];
    const peakHz = BINS[peakIdx].hz;
    return { rmsDb, tonality: total > 0 ? local / total : 0, flatness: mean > 0 ? geo / mean : 1, peakHz };
}
/**
 * Streaming analyzer. Feed it caller PCM in any chunk size; it keeps its own
 * 20 ms framing and a clock based on samples received (not wall time), so
 * results are deterministic for tests and immune to network jitter.
 */
class CallAudioAnalyzer {
    pending = new Int16Array(0);
    frames = 0;
    noiseFloorDb = -60;
    speech = [];
    segStart = null;
    lastVoicedMs = null;
    tones = [];
    toneStart = null;
    toneFreqSum = 0;
    toneFrames = 0;
    toneLastHz = 0;
    opts;
    constructor(opts = {}) {
        this.opts = {
            minSpeechDb: opts.minSpeechDb ?? -48,
            speechOverFloorDb: opts.speechOverFloorDb ?? 9,
            hangoverMs: opts.hangoverMs ?? 300,
            minSegmentMs: opts.minSegmentMs ?? 120,
        };
    }
    pushPcm(buf) {
        if (!buf || buf.length < 2)
            return;
        const incoming = new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + (buf.length - (buf.length % 2))));
        const merged = new Int16Array(this.pending.length + incoming.length);
        merged.set(this.pending, 0);
        merged.set(incoming, this.pending.length);
        let off = 0;
        while (merged.length - off >= FRAME) {
            this.processFrame(merged.subarray(off, off + FRAME));
            off += FRAME;
        }
        this.pending = merged.slice(off);
    }
    processFrame(frame) {
        const t = this.frames * FRAME_MS;
        this.frames += 1;
        const f = analyzeFrame(frame);
        // Tone: one dominant frequency holding most of the energy.
        const tonal = f.rmsDb > -50 && f.tonality > 0.55 && f.flatness < 0.2;
        if (tonal && (this.toneStart === null || Math.abs(f.peakHz - this.toneLastHz) <= 50)) {
            if (this.toneStart === null) {
                this.toneStart = t;
                this.toneFreqSum = 0;
                this.toneFrames = 0;
            }
            this.toneFreqSum += f.peakHz;
            this.toneFrames += 1;
            this.toneLastHz = f.peakHz;
        }
        else {
            this.closeTone(t);
            if (tonal) {
                this.toneStart = t;
                this.toneFreqSum = f.peakHz;
                this.toneFrames = 1;
                this.toneLastHz = f.peakHz;
            }
        }
        // Speech: loud enough over the floor, not a pure tone, not flat noise.
        const threshold = Math.max(this.opts.minSpeechDb, this.noiseFloorDb + this.opts.speechOverFloorDb);
        const voiced = f.rmsDb > threshold && !tonal && f.flatness < 0.45;
        if (voiced) {
            if (this.segStart === null)
                this.segStart = t;
            this.lastVoicedMs = t + FRAME_MS;
        }
        else if (this.segStart !== null && this.lastVoicedMs !== null && t + FRAME_MS - this.lastVoicedMs >= this.opts.hangoverMs) {
            this.closeSpeech();
        }
        // Noise floor: falls fast, rises slowly, and only on frames that are not speech.
        if (!voiced && !tonal) {
            const target = Math.max(-75, f.rmsDb);
            this.noiseFloorDb += (target - this.noiseFloorDb) * (target < this.noiseFloorDb ? 0.3 : 0.03);
        }
    }
    closeSpeech() {
        if (this.segStart === null || this.lastVoicedMs === null)
            return;
        if (this.lastVoicedMs - this.segStart >= this.opts.minSegmentMs) {
            this.speech.push({ startMs: this.segStart, endMs: this.lastVoicedMs });
        }
        this.segStart = null;
    }
    closeTone(t) {
        if (this.toneStart === null)
            return;
        if (t - this.toneStart >= 80) {
            this.tones.push({ startMs: this.toneStart, endMs: t, freqHz: Math.round(this.toneFreqSum / Math.max(1, this.toneFrames)) });
        }
        this.toneStart = null;
    }
    snapshot() {
        const now = this.frames * FRAME_MS;
        const speech = [...this.speech];
        const inSpeech = this.segStart !== null;
        const tones = [...this.tones];
        if (this.toneStart !== null && now - this.toneStart >= 80) {
            tones.push({ startMs: this.toneStart, endMs: now, freqHz: Math.round(this.toneFreqSum / Math.max(1, this.toneFrames)), open: true });
        }
        return {
            speech,
            inSpeech,
            currentSpeechStartMs: this.segStart,
            lastSpeechEndMs: inSpeech ? null : speech.length ? speech[speech.length - 1].endMs : null,
            tones,
            noiseFloorDb: Math.round(this.noiseFloorDb * 10) / 10,
            analyzedMs: now,
        };
    }
}
exports.CallAudioAnalyzer = CallAudioAnalyzer;
/** Special Information Tones (number not in service etc.): ~914/985 Hz then ~1371/1429 Hz. */
function findSitTone(tones) {
    for (let i = 0; i + 1 < tones.length; i++) {
        const a = tones[i], b = tones[i + 1];
        const first = a.freqHz >= 880 && a.freqHz <= 1020 && a.endMs - a.startMs >= 150;
        const second = b.freqHz >= 1330 && b.freqHz <= 1470 && b.endMs - b.startMs >= 150 && b.startMs - a.endMs <= 160;
        if (first && second)
            return a;
    }
    return null;
}
/** Voicemail beep: one steady tone, 400–2100 Hz, at least `minMs` long, that is not part of a SIT sequence. */
function findBeep(tones, minMs, nowMs = Infinity) {
    const sit = findSitTone(tones);
    for (let i = 0; i < tones.length; i++) {
        const t = tones[i];
        if (sit && t.startMs >= sit.startMs && t.startMs <= sit.startMs + 1500)
            continue;
        // A tone in the first SIT band might be the start of a network announcement:
        // wait until it is clearly long, or ended with no second tone right after it.
        if (t.freqHz >= 880 && t.freqHz <= 1020 && t.endMs - t.startMs < 450) {
            const next = tones[i + 1];
            if (t.open || (next && next.startMs - t.endMs <= 200) || nowMs - t.endMs < 200)
                continue;
        }
        if (t.freqHz >= 400 && t.freqHz <= 2100 && t.endMs - t.startMs >= minMs)
            return t;
    }
    return null;
}
