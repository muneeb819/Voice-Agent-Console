// Per-bot Active switch and Lines: every combination, checked against an independent rule.
import assert from 'node:assert/strict';
import { getConsoleState } from '../src/db';
import { phoneBotPool, resetPhoneRotationForTests } from '../src/campaign-assignment';
import { resolveCampaignAndAgent } from '../src/vici-bridge';
import { campaignExtension } from '../src/campaign-assignment';
import { normalizeState } from '../src/defaults';

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


c.agentIds = [primary.id, 'clone_1', 'clone_2'];
const bots = [primary.id, 'clone_1', 'clone_2'];
const ACTIVE = [true, false];
const LINES = [0, 1, 3];
const CALLS = [0, 1, 3];
const options: Array<{ active: boolean; lines: number; calls: number }> = [];
for (const active of ACTIVE) for (const lines of LINES) for (const calls of CALLS) options.push({ active, lines, calls });

let combos = 0;
for (const o0 of options) for (const o1 of options) for (const o2 of options) {
  const cfg = [o0, o1, o2];
  const st = JSON.parse(JSON.stringify(state));
  bots.forEach((id, i) => { const a = st.agents.find((x: any) => x.id === id); a.active = cfg[i].active; a.lines = cfg[i].lines; });
  const counts: Record<string, number> = {}; bots.forEach((id, i) => { counts[id] = cfg[i].calls; });
  const eligible = bots.filter((id, i) => cfg[i].active && (cfg[i].lines === 0 || cfg[i].calls < cfg[i].lines));
  resetPhoneRotationForTests();
  const r = resolveCampaignAndAgent(st, exten, { rotate: true, callsOnBot: (id) => counts[id] || 0 });
  combos++;
  if (eligible.length) {
    ok(!r.error, `combo ${combos}: a free active bot exists, so the call is answered (${r.error || ''})`);
    ok(eligible.includes(r.agent!.id), `combo ${combos}: the call goes only to an active bot with a free line, not ${r.agent?.id}`);
  } else {
    ok(!!r.error, `combo ${combos}: nobody can take it, so the call is turned away ${JSON.stringify(cfg)} picked ${r.agent?.id}`);
    ok(/inactive|lines/.test(r.error || ''), `combo ${combos}: the reason says inactive or lines: ${r.error}`);
  }
  // Without the phone-rotation flag (browser tests and the capacity pre-check) these limits do not apply.
  const plain = resolveCampaignAndAgent(st, exten);
  ok(!/inactive|using all of its/.test(plain.error || ''), `combo ${combos}: browser tests and the pre-check ignore the phone switch`);
}

// Existing data without the new fields keeps working: active, no per-bot limit.
const legacy = JSON.parse(JSON.stringify(state));
legacy.agents.forEach((a: any) => { delete a.active; delete a.lines; });
const norm = normalizeState(legacy);
ok(norm.agents.every((a) => a.active === true && a.lines === 0), 'old bots load as active with no per-bot limit');
const clamp = JSON.parse(JSON.stringify(state)); clamp.agents[0].lines = 99999; clamp.agents[0].active = false; clamp.agents[1].lines = -4;
const nc = normalizeState(clamp);
ok(nc.agents[0].lines === 1000 && nc.agents[0].active === false && nc.agents[1].lines === 0, 'lines are clamped to 0-1000 and the inactive flag is kept');
resetPhoneRotationForTests();
ok(resolveCampaignAndAgent(legacy, exten, { rotate: true, callsOnBot: () => 50 }).agent?.id !== undefined, 'with no limits set, many calls never block a bot');

console.log(`✓ Bot active/lines: ${checks} checks passed over ${combos} combinations`);
