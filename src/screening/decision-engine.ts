// Pure decision engine. Given the evidence gathered so far, it returns a final
// decision, a request to play the probe, or nothing (keep listening).
// Safety rule: HUMAN_CONFIRMED needs positive evidence from speech recognition;
// any missing or failed input can only lead to a machine outcome or UNCERTAIN.
import { findBeep, findSitTone, AnalyzerSnapshot } from './audio-analysis';
import { matchTranscriptCue, wordCount } from './transcript-rules';
import { NativeAmdResult, ScreeningDecision, ScreeningThresholds, TranscriptEvent } from './types';

export interface EngineEvidence {
  nowMs: number;
  audio: AnalyzerSnapshot;
  transcripts: TranscriptEvent[];
  asrState: 'connecting' | 'ok' | 'failed';
  asrError?: string;
  nativeAmd: NativeAmdResult;
  testEndpoint: { matched: boolean; label?: string };
  probe: { enabled: boolean; available: boolean; startedAtMs: number | null; endedAtMs: number | null };
  alwaysProbe: boolean;
}

export type EngineStep =
  | { kind: 'decide'; decision: ScreeningDecision }
  | { kind: 'probe'; reason: string }
  | { kind: 'wait' };

const decide = (e: EngineEvidence, outcome: ScreeningDecision['outcome'], reason: string, extra: Record<string, unknown> = {}): EngineStep => ({
  kind: 'decide',
  decision: {
    outcome,
    reason,
    decidedAtMs: e.nowMs,
    evidence: {
      nativeAmd: e.nativeAmd.status,
      nativeAmdAuthenticated: e.nativeAmd.authenticated,
      asr: e.asrState,
      speechSegments: e.audio.speech.length + (e.audio.inSpeech ? 1 : 0),
      transcript: transcriptText(e).slice(0, 400),
      noiseFloorDb: e.audio.noiseFloorDb,
      probed: e.probe.startedAtMs !== null,
      ...extra,
    },
  },
});

function transcriptText(e: EngineEvidence): string {
  // Finals in order, plus the latest interim if it is newer than the last final.
  const finals = e.transcripts.filter((t) => t.isFinal).map((t) => t.text.trim()).filter(Boolean);
  const lastInterim = [...e.transcripts].reverse().find((t) => !t.isFinal);
  const lastFinal = [...e.transcripts].reverse().find((t) => t.isFinal);
  const parts = [...finals];
  if (lastInterim && (!lastFinal || lastInterim.atMs > lastFinal.atMs) && lastInterim.text.trim()) parts.push(lastInterim.text.trim());
  return parts.join(' ');
}

/** Speech merged into utterances: gaps shorter than `joinMs` belong to the same utterance. */
function utterances(audio: AnalyzerSnapshot, joinMs: number): Array<{ startMs: number; endMs: number; open: boolean }> {
  const segs = audio.speech.map((s) => ({ ...s, open: false }));
  if (audio.inSpeech && audio.currentSpeechStartMs !== null) segs.push({ startMs: audio.currentSpeechStartMs, endMs: audio.analyzedMs, open: true });
  const out: Array<{ startMs: number; endMs: number; open: boolean }> = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last && s.startMs - last.endMs < joinMs) { last.endMs = s.endMs; last.open = s.open; }
    else out.push({ ...s });
  }
  return out;
}

export function evaluateScreening(e: EngineEvidence, th: ScreeningThresholds): EngineStep {
  // 1. Authorised automated test lines never reach a campaign prompt.
  if (e.testEndpoint.matched) return decide(e, 'KNOWN_TEST_ENDPOINT', `Number is on the authorised test list${e.testEndpoint.label ? ` (${e.testEndpoint.label})` : ''}`);

  // 2. Native Asterisk AMD said MACHINE (signed header): trust it.
  if (e.nativeAmd.authenticated && e.nativeAmd.status === 'MACHINE') {
    return decide(e, 'VOICEMAIL', `Native AMD reported MACHINE (${e.nativeAmd.cause || 'no cause'})`);
  }

  // 3. Tones.
  const sit = findSitTone(e.audio.tones);
  if (sit) return decide(e, 'PRERECORDED_AUDIO', 'Special information tone (network announcement)', { toneHz: sit.freqHz });
  const beep = findBeep(e.audio.tones, th.minBeepMs, e.audio.analyzedMs);
  if (beep) return decide(e, 'VOICEMAIL', `Voicemail beep at ${beep.freqHz} Hz`, { toneHz: beep.freqHz, toneMs: beep.endMs - beep.startMs });

  // 4. What the far end said.
  const text = transcriptText(e);
  const cue = matchTranscriptCue(text);
  if (cue) return decide(e, cue.cue, `Transcript matched "${cue.label}"`);

  // 5. Timing: a long first utterance is a recorded greeting.
  const utts = utterances(e.audio, 400);
  const first = utts[0];
  const probeActive = e.probe.startedAtMs !== null;
  if (first && first.endMs - first.startMs >= th.longGreetingMs && (!probeActive || first.startMs < (e.probe.startedAtMs as number))) {
    return decide(e, 'VOICEMAIL', `First utterance lasted ${Math.round((first.endMs - first.startMs) / 100) / 10}s without a pause`, { greetingMs: first.endMs - first.startMs });
  }

  const words = wordCount(text);
  const hasFinal = e.transcripts.some((t) => t.isFinal && t.text.trim());

  // 6. Human: a short answer, then quiet, recognised as words.
  const asrOk = e.asrState === 'ok';
  const answerUtts = probeActive && e.probe.endedAtMs !== null
    ? utts.filter((u) => u.startMs >= (e.probe.startedAtMs as number))
    : utts;
  const lastUtt = answerUtts[answerUtts.length - 1];
  const quietSince = lastUtt && !lastUtt.open ? e.nowMs - lastUtt.endMs : 0;
  const totalSpeech = answerUtts.reduce((a, u) => a + (u.endMs - u.startMs), 0);
  const shortAnswerThenQuiet = Boolean(lastUtt) && !lastUtt.open && quietSince >= th.afterGreetingSilenceMs && totalSpeech <= th.maxHumanGreetingMs;
  const answerWords = probeActive && e.probe.startedAtMs !== null
    ? wordCount(e.transcripts.filter((t) => t.atMs >= (e.probe.startedAtMs as number)).filter((t) => t.isFinal).map((t) => t.text).join(' '))
    : words;
  const recognisedAnswer = asrOk && hasFinal && answerWords >= 1 && answerWords <= th.maxHumanWords;

  if (shortAnswerThenQuiet && recognisedAnswer) {
    if (!e.alwaysProbe || probeActive) {
      return decide(e, 'HUMAN_CONFIRMED', probeActive ? 'Answered the probe with a short reply' : 'Short greeting followed by silence', { words: answerWords, greetingMs: totalSpeech });
    }
  }

  // 7. Interactive verification: one short "Hello?" when the evidence is thin.
  if (e.probe.enabled && e.probe.available && !probeActive && asrOk) {
    const silentTooLong = utts.length === 0 && e.nowMs >= th.silenceProbeAtMs;
    const greetingWithoutWords = shortAnswerThenQuiet && !recognisedAnswer && quietSince >= th.afterGreetingSilenceMs + 700;
    const wantsConfirmation = e.alwaysProbe && shortAnswerThenQuiet && recognisedAnswer;
    if (silentTooLong) return { kind: 'probe', reason: 'No speech yet' };
    if (greetingWithoutWords) return { kind: 'probe', reason: 'Sound heard but no words recognised' };
    if (wantsConfirmation) return { kind: 'probe', reason: 'Confirming the person with a short reply' };
  }

  // 8. Probe answered by nothing in its window: not confirmed.
  if (probeActive && e.probe.endedAtMs !== null && e.nowMs - e.probe.endedAtMs >= th.probeResponseWindowMs && answerUtts.length === 0) {
    return decide(e, 'UNCERTAIN', 'No reply to the probe');
  }

  // 9. Out of time.
  if (e.nowMs >= th.maxScreeningMs) {
    const reason = e.asrState === 'failed'
      ? `Speech recognition unavailable (${e.asrError || 'error'}); a person could not be confirmed`
      : utts.length === 0 ? 'No speech before the screening time limit' : 'Not enough evidence before the screening time limit';
    return decide(e, 'UNCERTAIN', reason);
  }
  return { kind: 'wait' };
}
