// Live status of each bot: every combination of call state, sleep and active, checked against an independent rule.
import assert from 'node:assert/strict';
import { getConsoleState } from '../src/db';
import { phoneBotPool, resetPhoneRotationForTests } from '../src/campaign-assignment';
import { resolveCampaignAndAgent } from '../src/vici-bridge';
import { campaignExtension } from '../src/campaign-assignment';
import { createServerWithSimulator } from '../src/server';
import { setBotSleep } from '../src/bot-sleep';
import { saveConsoleState } from '../src/db';

let checks = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); checks++; };

const base = getConsoleState();
const camp = base.campaigns.find((c) => c.agentIds && c.agentIds.length) || base.campaigns[0];
const primary = base.agents.find((a) => a.id === camp.agentId)!;
const clones = [1, 2, 3].map((n) => ({ ...JSON.parse(JSON.stringify(primary)), id: `clone_${n}`, name: `${primary.name} ${n + 1}` }));
const state = JSON.parse(JSON.stringify(base));
const stt = state.providers.find((p: any) => p.kind === 'stt');
const llm = state.providers.find((p: any) => p.kind === 'llm' && p.type === 'open_ai');
const tts = state.providers.find((p: any) => p.kind === 'tts' && p.type === 'deepgram');
state.services = { stt: { providerId: stt.id, model: 'nova-3' }, llm: { providerId: llm.id, model: 'gpt-4o-mini' }, tts: { providerId: tts.id, model: 'aura-2-thalia-en' } };
state.agents.push(...clones);
const c = state.campaigns.find((x: any) => x.id === camp.id);
c.agentIds = [primary.id, 'a_qa', ...clones.map((x) => x.id)];
c.agentId = primary.id;
c.complianceRules = c.complianceRules || 'Reviewed rotation fixture rules: be truthful, avoid unsupported claims, and honor do-not-call requests immediately.';
const exten = campaignExtension(state.vici.aiExten, c, state.campaigns.indexOf(c));


async function main() {
  saveConsoleState(state);
  const { server, viciBridge } = createServerWithSimulator({ enableBridge: true, host: 'localhost', audioSocketPort: 0, sipPort: 0 });
  const bridge: any = viciBridge!;
  const botId = primary.id;
  const callStates: Array<{ label: string; calls: string[]; pending: number }> = [
    { label: 'no call', calls: [], pending: 0 },
    { label: 'call registered', calls: [], pending: 1 },
    { label: 'talking', calls: ['listening'], pending: 0 },
    { label: 'bot speaking', calls: ['bot_speaking'], pending: 0 },
    { label: 'transferring', calls: ['transferring'], pending: 0 },
    { label: 'transferred', calls: ['transferred'], pending: 0 },
    { label: 'two calls, one transferring', calls: ['listening', 'transferring'], pending: 0 },
    { label: 'two calls talking', calls: ['listening', 'thinking'], pending: 0 },
    { label: 'call and a registered one', calls: ['listening'], pending: 1 },
  ];
  let combos = 0;
  try {
    for (const sleeping of [false, true]) for (const active of [true, false]) for (const cs of callStates) for (const lines of [0, 2, 5]) {
      const st = JSON.parse(JSON.stringify(state));
      const a = st.agents.find((x: any) => x.id === botId); a.active = active; a.lines = lines;
      saveConsoleState(st);
      setBotSleep(sleeping, 'test');
      bridge.activeCalls.clear(); bridge.preCallRegistry.clear();
      cs.calls.forEach((s, i) => bridge.activeCalls.set(`k${i}`, { callId: `k${i}`, campaignId: c.id, agentId: botId, state: s }));
      for (let i = 0; i < cs.pending; i++) bridge.preCallRegistry.set(`p${i}`, { agent: { id: botId } });
      const row = bridge.botStatuses().find((r: any) => r.agentId === botId);
      // Independent rule: a call in progress is shown as it is; otherwise sleep, then inactive, then waiting, then idle.
      const expected = cs.calls.includes('transferring') ? 'transferring' : cs.calls.length ? 'in_call' : sleeping ? 'asleep' : !active ? 'inactive' : cs.pending ? 'waiting' : 'idle';
      combos++;
      ok(!!row, `combo ${combos}: the bot is listed`);
      ok(row.status === expected, `combo ${combos} (${cs.label}, sleeping=${sleeping}, active=${active}): expected ${expected}, got ${row?.status}`);
      ok(row.calls === cs.calls.length, `combo ${combos}: call count ${cs.calls.length}`);
      ok(row.lines === lines, `combo ${combos}: lines shown as set`);
      ok(row.campaigns.includes(c.name), `combo ${combos}: campaign named`);
    }
    // A QA reviewer is never listed as a phone bot.
    ok(!bridge.botStatuses().some((r: any) => r.agentId === 'a_qa'), 'the QA reviewer is not listed');
    // One row per bot even when it sits in two campaigns.
    const st2 = JSON.parse(JSON.stringify(state));
    const extra = { ...JSON.parse(JSON.stringify(st2.campaigns.find((x: any) => x.id === c.id))), id: 'c_second', name: 'Second', slot: 9 };
    st2.campaigns.push(extra); saveConsoleState(st2); setBotSleep(false, 'test'); bridge.activeCalls.clear(); bridge.preCallRegistry.clear();
    const rows = bridge.botStatuses().filter((r: any) => r.agentId === botId);
    ok(rows.length === 1 && rows[0].campaigns.length === 2, 'a bot in two campaigns is one row naming both');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
  console.log(`✓ Bot live status: ${checks} checks passed over ${combos} combinations`);
  process.exit(0);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
