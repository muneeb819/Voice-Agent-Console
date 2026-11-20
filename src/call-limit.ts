// Shared by the VICIdial bridge and the Live Bot simulator.

/** Per-campaign hard call-length limit in ms (0 = no limit). */
export function callLimitMsForCampaign(campaign?: { maxCallSec?: number } | null): number {
  const sec = Number(campaign?.maxCallSec ?? 0);
  return Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) : 0;
}

/** When to nudge the bot to wrap up and when to speak the closing line. */
export function callLimitSchedule(limitMs: number): { wrapUpAtMs: number; closingAtMs: number } {
  const wrapUpAtMs = Math.max(limitMs - 20000, Math.round(limitMs * 0.6));
  const closingAtMs = Math.max(limitMs - 6000, wrapUpAtMs + 1000);
  return { wrapUpAtMs, closingAtMs };
}

export const CALL_LIMIT_CLOSING_LINE = "I'm sorry, I have to let you go now. Thank you for your time, and have a great day!";

export function callLimitWrapUpPrompt(secondsLeft: number): string {
  return [
    `TIME CHECK: about ${secondsLeft} seconds remain before this call ends automatically.`,
    'Wrap up NOW. If the caller is qualified and agrees, call set_disposition with "XFER" and transfer_to_live_agent immediately, without any more questions.',
    'If one single answer is still needed to qualify, ask only that one short question.',
    'Otherwise say one short, polite closing sentence, record the matching allowed disposition, and call end_call.',
  ].join(' ');
}
