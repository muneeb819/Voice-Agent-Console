// One screening run per call: feeds caller audio to the analyzer and to speech
// recognition, plays the probe when asked, and resolves once with a decision.
// Any internal error resolves as UNCERTAIN, never as HUMAN_CONFIRMED.
import { CallAudioAnalyzer } from './audio-analysis';
import { AsrFactory, ScreeningAsr } from './asr';
import { evaluateScreening, EngineEvidence } from './decision-engine';
import { NativeAmdResult, ScreeningDecision, ScreeningThresholds, TranscriptEvent } from './types';

export interface ScreeningSessionOptions {
  thresholds: ScreeningThresholds;
  nativeAmd: NativeAmdResult;
  testEndpoint: { matched: boolean; label?: string };
  asrFactory: AsrFactory;
  probe: { enabled: boolean; always: boolean; loadAudio: () => Promise<Buffer | null> };
  playAudio: (pcm8k: Buffer) => void;
  onLog?: (line: string) => void;
  /** Tick interval for re-evaluating the evidence (tests can shorten it). */
  tickMs?: number;
}

export class ScreeningSession {
  private readonly analyzer = new CallAudioAnalyzer();
  private readonly transcripts: TranscriptEvent[] = [];
  private asr: ScreeningAsr | null = null;
  private asrState: 'connecting' | 'ok' | 'failed' = 'connecting';
  private asrError = '';
  private probeAudio: Buffer | null = null;
  private probeLoaded = false;
  private probeStartedAtMs: number | null = null;
  private probeEndedAtMs: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private done = false;
  private startedWallMs = 0;
  private lastEvalAudioMs = 0;
  private resolveFn: (d: ScreeningDecision) => void = () => {};
  readonly result: Promise<ScreeningDecision>;

  constructor(private readonly opts: ScreeningSessionOptions) {
    this.result = new Promise((resolve) => { this.resolveFn = resolve; });
  }

  /** Audio clock: time is measured in caller audio received, so a stalled stream cannot fake silence. */
  private nowMs(): number {
    return this.analyzer.snapshot().analyzedMs;
  }

  start(): void {
    try {
      this.startedWallMs = Date.now();
      this.evaluate();
      if (this.done) return;
      this.asr = this.opts.asrFactory({
        onReady: () => { if (this.asrState === 'connecting') this.asrState = 'ok'; },
        onTranscript: (text, isFinal) => {
          if (this.done) return;
          this.transcripts.push({ text, isFinal, atMs: this.nowMs() });
          if (isFinal) this.opts.onLog?.(`Screening heard: "${text.slice(0, 120)}"`);
          this.evaluate();
        },
        onError: (message) => {
          if (this.asrState === 'failed') return;
          this.asrState = 'failed';
          this.asrError = message;
          this.opts.onLog?.(`Screening speech recognition failed: ${message}`);
        },
      });
      if (this.opts.probe.enabled) {
        this.opts.probe.loadAudio().then((buf) => { this.probeAudio = buf; this.probeLoaded = true; }).catch(() => { this.probeLoaded = true; });
      }
      this.timer = setInterval(() => this.evaluate(), this.opts.tickMs ?? 100);
    } catch (err: any) {
      this.finish({ outcome: 'UNCERTAIN', reason: `Screening error: ${err?.message || 'unknown'}`, decidedAtMs: 0, evidence: {} });
    }
  }

  pushAudio(pcm8k: Buffer): void {
    if (this.done) return;
    try {
      this.analyzer.pushPcm(pcm8k);
      this.asr?.send(pcm8k);
      // Re-evaluate every 100 ms of caller audio as well as on the wall-clock tick.
      const t = this.nowMs();
      if (t - this.lastEvalAudioMs >= 100) { this.lastEvalAudioMs = t; this.evaluate(); }
    } catch (err: any) {
      this.finish({ outcome: 'UNCERTAIN', reason: `Screening audio error: ${err?.message || 'unknown'}`, decidedAtMs: this.nowMs(), evidence: {} });
    }
  }

  /** Ends screening early (caller hung up, call torn down). */
  cancel(reason: string): void {
    this.finish({ outcome: 'UNCERTAIN', reason, decidedAtMs: this.nowMs(), evidence: { cancelled: true } });
  }

  private evaluate(): void {
    if (this.done) return;
    try {
      const audio = this.analyzer.snapshot();
      const evidence: EngineEvidence = {
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
      const step = evaluateScreening(evidence, this.opts.thresholds);
      if (step.kind === 'decide') this.finish(step.decision);
      else if (step.kind === 'probe') this.playProbe(step.reason);
    } catch (err: any) {
      this.finish({ outcome: 'UNCERTAIN', reason: `Screening error: ${err?.message || 'unknown'}`, decidedAtMs: this.nowMs(), evidence: {} });
    }
  }

  private playProbe(reason: string): void {
    if (this.probeStartedAtMs !== null || !this.probeAudio) return;
    const now = this.nowMs();
    this.probeStartedAtMs = now;
    this.probeEndedAtMs = now + Math.round(this.probeAudio.length / 16); // 16 bytes per ms at 8 kHz 16-bit
    this.opts.onLog?.(`Screening probe played (${reason})`);
    this.opts.playAudio(this.probeAudio);
  }

  private finish(decision: ScreeningDecision): void {
    if (this.done) return;
    this.done = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try { this.asr?.close(); } catch {}
    this.asr = null;
    this.resolveFn(decision);
  }

  get probeWasLoaded(): boolean { return this.probeLoaded; }
}
