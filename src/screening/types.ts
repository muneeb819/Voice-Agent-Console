// Call screening (answering machine detection) shared types.

export type ScreeningOutcome =
  | 'HUMAN_CONFIRMED'
  | 'VOICEMAIL'
  | 'IVR'
  | 'PRERECORDED_AUDIO'
  | 'KNOWN_TEST_ENDPOINT'
  | 'UNCERTAIN';

export const SCREENING_OUTCOMES: ScreeningOutcome[] = [
  'HUMAN_CONFIRMED',
  'VOICEMAIL',
  'IVR',
  'PRERECORDED_AUDIO',
  'KNOWN_TEST_ENDPOINT',
  'UNCERTAIN',
];

/** Result of Asterisk's AMD() application, passed from VICIdial in a signed SIP header. */
export type NativeAmdStatus = 'HUMAN' | 'MACHINE' | 'NOTSURE' | 'HANGUP' | 'NONE';

export interface NativeAmdResult {
  status: NativeAmdStatus;
  cause: string;
  /** True only when the header carried a valid signature (or no secret is configured and the source IP is allow-listed). */
  authenticated: boolean;
}

export interface SpeechSegment {
  startMs: number;
  endMs: number;
}

export interface ToneSegment {
  startMs: number;
  endMs: number;
  freqHz: number;
  /** Still sounding when the snapshot was taken. */
  open?: boolean;
}

export interface TranscriptEvent {
  text: string;
  isFinal: boolean;
  atMs: number;
}

export interface ScreeningDecision {
  outcome: ScreeningOutcome;
  reason: string;
  decidedAtMs: number;
  evidence: Record<string, unknown>;
}

export interface ScreeningThresholds {
  /** Hard cap on screening time; past it the call is UNCERTAIN. */
  maxScreeningMs: number;
  /** Silence after a short greeting that marks the end of a human "hello". */
  afterGreetingSilenceMs: number;
  /** Longest greeting still treated as a human "hello". */
  maxHumanGreetingMs: number;
  /** A first utterance at least this long is a recorded greeting. */
  longGreetingMs: number;
  /** Most words a human answer may have before it looks like a recording. */
  maxHumanWords: number;
  /** With no speech at all by this time, play the probe. */
  silenceProbeAtMs: number;
  /** After the probe ends, how long a person has to start answering. */
  probeResponseWindowMs: number;
  /** Minimum tone length that counts as a voicemail beep. */
  minBeepMs: number;
  /** With a long first utterance, this many recognised words mark a recorded greeting. */
  minMachineWords: number;
}

export const DEFAULT_THRESHOLDS: ScreeningThresholds = {
  maxScreeningMs: 7000,
  afterGreetingSilenceMs: 800,
  maxHumanGreetingMs: 3000,
  longGreetingMs: 3500,
  maxHumanWords: 8,
  silenceProbeAtMs: 2500,
  probeResponseWindowMs: 3000,
  minBeepMs: 200,
  minMachineWords: 12,
};

export interface ScreeningDispositions {
  VOICEMAIL: string;
  IVR: string;
  PRERECORDED_AUDIO: string;
  KNOWN_TEST_ENDPOINT: string;
  UNCERTAIN: string;
}
