// Call screening module: the bridge's only entry points.
import { createDeepgramAsr, deepgramProbeAudio, AsrFactory } from './asr';
import { loadScreeningConfig, normalisePhone, parseNativeAmdHeader } from './config';
import { applyScreeningDisposition, DispositionViciClient } from './disposition';
import { ScreeningSession } from './session';
import { isScreeningEnabled, recordScreeningResult } from './store';
import { NativeAmdResult, ScreeningDecision } from './types';

export * from './types';
export { isScreeningEnabled, setScreeningEnabled, screeningSettingsRow, recentScreeningResults, screeningCounts, lastTestRun } from './store';
export { runScreeningVerification } from './verify';
export { loadScreeningConfig, parseNativeAmdHeader } from './config';

export interface StartScreeningInput {
  callerCode: string;
  phone: string;
  amdHeader: string;
  amdSignature: string;
  playAudio: (pcm8k: Buffer) => void;
  log: (line: string) => void;
  /** Tests inject a fake recogniser. */
  asrFactory?: AsrFactory;
  probeLoader?: () => Promise<Buffer | null>;
}

let testHooks: { asrFactory?: AsrFactory; probeLoader?: () => Promise<Buffer | null> } | null = null;
/** Test-only: replace live speech recognition and the probe voice for bridge integration tests. */
export function setScreeningTestHooks(hooks: typeof testHooks): void { testHooks = hooks; }

export function startCallScreening(input: StartScreeningInput): { session: ScreeningSession; nativeAmd: NativeAmdResult } {
  const cfg = loadScreeningConfig();
  const nativeAmd = parseNativeAmdHeader(input.amdHeader, input.amdSignature, input.callerCode, cfg.eventSecret);
  const phone = normalisePhone(input.phone);
  const label = phone ? cfg.testEndpoints.get(phone) : undefined;
  if (nativeAmd.status !== 'NONE') {
    input.log(`Native AMD: ${nativeAmd.status}${nativeAmd.cause ? ` (${nativeAmd.cause})` : ''}${nativeAmd.authenticated ? '' : ', signature not valid, ignored'}`);
  }
  const session = new ScreeningSession({
    thresholds: cfg.thresholds,
    nativeAmd,
    testEndpoint: { matched: Boolean(label), label },
    asrFactory: input.asrFactory || testHooks?.asrFactory || createDeepgramAsr(cfg.asrModel),
    probe: { enabled: cfg.probeEnabled, always: cfg.alwaysProbe, loadAudio: input.probeLoader || testHooks?.probeLoader || (() => deepgramProbeAudio(cfg.probeText, cfg.probeVoice)) },
    playAudio: input.playAudio,
    onLog: input.log,
  });
  session.start();
  return { session, nativeAmd };
}

export interface FinishScreeningInput {
  callId: string;
  campaignId: string;
  campaignViciId: string;
  leadId: string;
  callerCode: string;
  remoteAgentUser: string;
  phone: string;
  nativeAmd: NativeAmdResult;
  decision: ScreeningDecision;
}

/** Saves the decision once and returns the VICIdial status to set ('' for a confirmed person). */
export function recordScreeningDecision(input: FinishScreeningInput, log: (line: string) => void, statusOverride?: string): string {
  const cfg = loadScreeningConfig();
  const status = statusOverride !== undefined ? statusOverride : input.decision.outcome === 'HUMAN_CONFIRMED' ? '' : cfg.dispositions[input.decision.outcome];
  try {
    const first = recordScreeningResult({
      callId: input.callId,
      campaignId: input.campaignId,
      leadId: input.leadId,
      callerCode: input.callerCode,
      phone: input.phone,
      nativeAmd: input.nativeAmd.status,
      decision: input.decision,
      disposition: status,
    });
    if (!first) log('Screening result was already recorded for this call (duplicate ignored)');
  } catch (err: any) {
    log(`Screening result not saved: ${err?.message || 'database error'}`);
  }
  return status;
}

export async function sendScreeningDisposition(input: FinishScreeningInput & { status: string; client: DispositionViciClient }, log: (line: string) => void) {
  return applyScreeningDisposition({
    callId: input.callId,
    callerCode: input.callerCode,
    remoteAgentUser: input.remoteAgentUser,
    leadId: input.leadId,
    campaignViciId: input.campaignViciId,
    status: input.status,
    client: input.client,
    log,
  });
}

export { isScreeningEnabled as screeningEnabled };
export type { DispositionViciClient };
