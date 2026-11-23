"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScreeningSession = void 0;
// One screening run per call: feeds caller audio to the analyzer and to speech
// recognition, plays the probe when asked, and resolves once with a decision.
// Any internal error resolves as UNCERTAIN, never as HUMAN_CONFIRMED.
const audio_analysis_1 = require("./audio-analysis");
const decision_engine_1 = require("./decision-engine");
class ScreeningSession {
    opts;
    analyzer = new audio_analysis_1.CallAudioAnalyzer();
    transcripts = [];
    asr = null;
    asrState = 'connecting';
    asrError = '';
    probeAudio = null;
    probeLoaded = false;
    probeStartedAtMs = null;
    probeEndedAtMs = null;
    timer = null;
    done = false;
    startedWallMs = 0;
    lastEvalAudioMs = 0;
    resolveFn = () => { };
    result;
    constructor(opts) {
        this.opts = opts;
        this.result = new Promise((resolve) => { this.resolveFn = resolve; });
    }
    /** Audio clock: time is measured in caller audio received, so a stalled stream cannot fake silence. */
    nowMs() {
        return this.analyzer.snapshot().analyzedMs;
    }
    start() {
        try {
            this.startedWallMs = Date.now();
            this.evaluate();
            if (this.done)
                return;
            this.asr = this.opts.asrFactory({
                onReady: () => { if (this.asrState === 'connecting')
                    this.asrState = 'ok'; },
                onTranscript: (text, isFinal) => {
                    if (this.done)
                        return;
                    this.transcripts.push({ text, isFinal, atMs: this.nowMs() });
                    if (isFinal)
                        this.opts.onLog?.(`Screening heard: "${text.slice(0, 120)}"`);
                    this.evaluate();
                },
                onError: (message) => {
                    if (this.asrState === 'failed')
                        return;
                    this.asrState = 'failed';
                    this.asrError = message;
                    this.opts.onLog?.(`Screening speech recognition failed: ${message}`);
                },
            });
            if (this.opts.probe.enabled) {
                this.opts.probe.loadAudio().then((buf) => { this.probeAudio = buf; this.probeLoaded = true; }).catch(() => { this.probeLoaded = true; });
            }
            this.timer = setInterval(() => this.evaluate(), this.opts.tickMs ?? 100);
        }
        catch (err) {
            this.finish({ outcome: 'UNCERTAIN', reason: `Screening error: ${err?.message || 'unknown'}`, decidedAtMs: 0, evidence: {} });
        }
    }
    pushAudio(pcm8k) {
        if (this.done)
            return;
        try {
            this.analyzer.pushPcm(pcm8k);
            this.asr?.send(pcm8k);
            // Re-evaluate every 100 ms of caller audio as well as on the wall-clock tick.
            const t = this.nowMs();
            if (t - this.lastEvalAudioMs >= 100) {
                this.lastEvalAudioMs = t;
                this.evaluate();
            }
        }
        catch (err) {
            this.finish({ outcome: 'UNCERTAIN', reason: `Screening audio error: ${err?.message || 'unknown'}`, decidedAtMs: this.nowMs(), evidence: {} });
        }
    }
    /** Ends screening early (caller hung up, call torn down). */
    cancel(reason) {
        this.finish({ outcome: 'UNCERTAIN', reason, decidedAtMs: this.nowMs(), evidence: { cancelled: true } });
    }
    evaluate() {
        if (this.done)
            return;
        try {
            const audio = this.analyzer.snapshot();
            const evidence = {
                nowMs: audio.analyzedMs,
                audio,
                transcripts: this.transcripts,
                asrState: this.asrState,
                asrError: this.asrError,
                nativeAmd: this.opts.nativeAmd,
                testEndpoint: this.opts.testEndpoint,
                probe: { enabled: this.opts.probe.enabled, available: Boolean(this.probeAudio), startedAtMs: this.probeStartedAtMs, endedAtMs: this.probeEndedAtMs },
                alwaysProbe: this.opts.probe.always,
            };
            // Wall-clock backstop: if caller audio stops arriving, the audio clock stalls.
            if (Date.now() - this.startedWallMs > this.opts.thresholds.maxScreeningMs + 3000) {
                this.finish({ outcome: 'UNCERTAIN', reason: 'Caller audio stopped arriving during screening', decidedAtMs: audio.analyzedMs, evidence: { analyzedMs: audio.analyzedMs } });
                return;
            }
            const step = (0, decision_engine_1.evaluateScreening)(evidence, this.opts.thresholds);
            if (step.kind === 'decide')
                this.finish(step.decision);
            else if (step.kind === 'probe')
                this.playProbe(step.reason);
        }
        catch (err) {
            this.finish({ outcome: 'UNCERTAIN', reason: `Screening error: ${err?.message || 'unknown'}`, decidedAtMs: this.nowMs(), evidence: {} });
        }
    }
    playProbe(reason) {
        if (this.probeStartedAtMs !== null || !this.probeAudio)
            return;
        const now = this.nowMs();
        this.probeStartedAtMs = now;
        this.probeEndedAtMs = now + Math.round(this.probeAudio.length / 16); // 16 bytes per ms at 8 kHz 16-bit
        this.opts.onLog?.(`Screening probe played (${reason})`);
        this.opts.playAudio(this.probeAudio);
    }
    finish(decision) {
        if (this.done)
            return;
        this.done = true;
        if (this.timer)
            clearInterval(this.timer);
        this.timer = null;
        try {
            this.asr?.close();
        }
        catch { }
        this.asr = null;
        this.resolveFn(decision);
    }
    get probeWasLoaded() { return this.probeLoaded; }
}
exports.ScreeningSession = ScreeningSession;
