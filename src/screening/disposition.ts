// Sends the screening disposition to VICIdial exactly once, through the
// Remote Agent API (ra_call_control HANGUP with a status), which also frees
// the remote-agent slot so VICIdial can place its next call. Then reads the
// call log (callid_info) and the lead (lead_all_info) back to confirm the
// status was really recorded. No direct database writes.
import { claimDisposition, getScreeningResult, updateDispositionState } from './store';

export interface DispositionViciClient {
  hangupRemoteAgentCall(opts: { callerCode: string; remoteAgentUser: string; status?: string }): Promise<{ ok: boolean; responseText: string }>;
  lookupCallIdInfo(callerCode: string): Promise<{ ok: boolean; status?: string }>;
  fetchLeadInfo(opts: { leadId?: string; phone?: string; campaignId?: string }): Promise<{ status?: string; sourceApi?: string }>;
}

export interface ApplyDispositionInput {
  callId: string;
  callerCode: string;
  remoteAgentUser: string;
  leadId: string;
  campaignViciId: string;
  status: string;
  client: DispositionViciClient;
  retries?: number;
  retryDelayMs?: number;
  verifyDelayMs?: number;
  log?: (line: string) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const accepted = (text: string) => !/^\s*ERROR/i.test(text);

/**
 * Returns the final state. Safe to call more than once for the same call:
 * only the first caller sends anything (database claim).
 */
export async function applyScreeningDisposition(input: ApplyDispositionInput): Promise<'sent' | 'verified' | 'mismatch' | 'unverifiable' | 'failed' | 'duplicate' | 'skipped'> {
  const log = input.log || (() => {});
  if (!input.callerCode) {
    log('Screening disposition skipped: not a VICIdial remote-agent call');
    return 'skipped';
  }
  if (!claimDisposition(input.callId)) {
    log('Screening disposition already handled for this call; not sending again');
    return 'duplicate';
  }
  const retries = Math.max(0, Math.min(3, input.retries ?? 2));
  let lastText = '';
  let sent = false;
  for (let attempt = 0; attempt <= retries && !sent; attempt++) {
    if (attempt > 0) await sleep(input.retryDelayMs ?? 700);
    try {
      const res = await input.client.hangupRemoteAgentCall({ callerCode: input.callerCode, remoteAgentUser: input.remoteAgentUser, status: input.status });
      lastText = String(res.responseText || '').slice(0, 300);
      sent = res.ok && accepted(lastText);
      // The call is already gone on the VICIdial side: retrying cannot help.
      if (!sent && /not found|no active call|invalid/i.test(lastText)) break;
    } catch (err: any) {
      lastText = err?.message || 'request failed';
    }
  }
  if (!sent) {
    updateDispositionState(input.callId, 'failed', `ra_call_control HANGUP not accepted: ${lastText}`);
    log(`✗ VICIdial did not accept status ${input.status}: ${lastText}`);
    return 'failed';
  }
  updateDispositionState(input.callId, 'sent', lastText);
  log(`VICIdial accepted status ${input.status}; checking the call log and lead`);

  await sleep(input.verifyDelayMs ?? 1500);
  let callStatus = '';
  let leadStatus = '';
  try { const c = await input.client.lookupCallIdInfo(input.callerCode); if (c.ok) callStatus = String(c.status || '').toUpperCase(); } catch {}
  try {
    if (input.leadId) {
      const l = await input.client.fetchLeadInfo({ leadId: input.leadId, campaignId: input.campaignViciId });
      if (l.sourceApi !== 'fallback') leadStatus = String(l.status || '').toUpperCase();
    }
  } catch {}
  const want = input.status.toUpperCase();
  if (!callStatus && !leadStatus) {
    updateDispositionState(input.callId, 'unverifiable', 'Call log and lead could not be read back', { lead: '', call: '' });
    log('Disposition sent, but the call log and lead could not be read back to confirm it');
    return 'unverifiable';
  }
  const ok = (!callStatus || callStatus === want) && (!leadStatus || leadStatus === want);
  updateDispositionState(input.callId, ok ? 'verified' : 'mismatch', ok ? 'Status confirmed in VICIdial' : `Expected ${want}; call log ${callStatus || '-'}, lead ${leadStatus || '-'}`, { lead: leadStatus, call: callStatus });
  log(ok ? `✓ VICIdial shows status ${want}` : `✗ VICIdial shows call log ${callStatus || '-'}, lead ${leadStatus || '-'} (expected ${want})`);
  return ok ? 'verified' : 'mismatch';
}

export { getScreeningResult };
