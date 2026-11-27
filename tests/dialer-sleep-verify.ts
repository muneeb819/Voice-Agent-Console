import { getBotSleep, setBotSleep } from '../src/bot-sleep';
import { applyDialerSleep, type CampaignSwitch } from '../src/dialer-sleep';
import { VicidialApiClient } from '../src/vici-client';

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

class Fake implements CampaignSwitch {
  calls: string[] = [];
  failFor = new Set<string>();
  async setCampaignActive(id: string, active: boolean) {
    this.calls.push(`${id}:${active ? 'Y' : 'N'}`);
    return this.failFor.has(id) ? { ok: false, text: 'ERROR: not allowed' } : { ok: true, text: 'SUCCESS' };
  }
}

async function run() {
  const camps = [{ viciCampaign: 'MEDICARE' }, { viciCampaign: 'FETEST' }, { viciCampaign: 'MEDICARE' }, { viciCampaign: '' }];
  const f = new Fake();

  // Sleep turns each distinct campaign off once and remembers them.
  setBotSleep(true, 'test');
  const s = await applyDialerSleep(true, camps, f);
  assert(f.calls.join() === 'MEDICARE:N,FETEST:N', `sleep turns campaigns off once each: ${f.calls}`);
  assert(s.changed.length === 2 && !s.failed.length, 'sleep reports both changed');
  assert(getBotSleep().pausedCampaigns.join() === 'MEDICARE,FETEST', 'paused campaigns are remembered');

  // Wake with one failure: only that one stays on the list for a retry.
  f.calls = []; f.failFor.add('FETEST');
  setBotSleep(false, 'test');
  const w = await applyDialerSleep(false, camps, f);
  assert(f.calls.join() === 'MEDICARE:Y,FETEST:Y', `wake turns the paused campaigns on: ${f.calls}`);
  assert(w.failed.length === 1 && w.failed[0].campaign === 'FETEST', 'wake reports the failure');
  assert(getBotSleep().pausedCampaigns.join() === 'FETEST', 'failed campaign stays listed for retry');
  assert(getBotSleep().dialerErrors[0]?.error.includes('not allowed'), 'error text is kept for the screen');

  // Retry wake succeeds and clears the list.
  f.calls = []; f.failFor.clear();
  await applyDialerSleep(false, camps, f);
  assert(f.calls.join() === 'FETEST:Y' && getBotSleep().pausedCampaigns.length === 0, 'retry resumes only the leftover and clears it');

  // A failed sleep is not remembered as paused, so wake will not start it.
  f.calls = []; f.failFor.add('MEDICARE');
  setBotSleep(true, 'test');
  await applyDialerSleep(true, camps, f);
  assert(getBotSleep().pausedCampaigns.join() === 'FETEST', 'failed pause is not remembered');
  setBotSleep(false, 'test');
  f.calls = [];
  await applyDialerSleep(false, camps, f);
  assert(f.calls.join() === 'FETEST:Y', 'wake leaves campaigns it never paused alone');

  // No campaign ids: nothing attempted, and it says so.
  setBotSleep(true, 'test');
  const none = await applyDialerSleep(true, [{ viciCampaign: '' }], new Fake());
  assert(none.skipped && !none.changed.length, 'no campaign ids is reported, not faked');

  // The real client refuses a bad campaign id before any request.
  const bad = await new VicidialApiClient({ viciBaseUrl: 'http://127.0.0.1:1', apiUser: 'x' } as any, 'p').setCampaignActive('A&B', false);
  assert(!bad.ok && /invalid/.test(bad.text), 'bad campaign id is refused');
  setBotSleep(false, 'test');
  console.log('Dialer sleep verification passed.');
}
run().then(() => process.exit(0), (e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
