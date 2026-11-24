// Every bot assigned to a campaign answers phone calls in turn (QA reviewer excluded).
import assert from 'node:assert/strict';
import { getConsoleState } from '../src/db';
import { phoneBotPool, resetPhoneRotationForTests } from '../src/campaign-assignment';
import { resolveCampaignAndAgent } from '../src/vici-bridge';
import { campaignExtension } from '../src/campaign-assignment';
import { smokeTestAgent } from '../src/smoke-test';

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

const pool = phoneBotPool(state, c).map((a) => a.id);
ok(!pool.includes('a_qa') && pool[0] === primary.id && pool.length === 4, 'pool = primary first + clones, QA reviewer excluded');

resetPhoneRotationForTests();
const picks = Array.from({ length: 8 }, () => resolveCampaignAndAgent(state, exten, { rotate: true }));
ok(picks.every((p) => !p.error), `rotation resolves without errors: ${picks.find((p) => p.error)?.error || ''}`);
ok(JSON.stringify(picks.map((p) => p.agent!.id)) === JSON.stringify([...pool, ...pool]), 'calls go to each bot in turn');
ok(resolveCampaignAndAgent(state, exten).agent!.id === primary.id, 'without rotation the primary is still used');

// An unready bot is skipped, not blocking the others.
const broken = JSON.parse(JSON.stringify(state));
const b = broken.agents.find((a: any) => a.id === 'clone_1'); b.prompt = '';
resetPhoneRotationForTests();
const seen = new Set(Array.from({ length: 8 }, () => resolveCampaignAndAgent(broken, exten, { rotate: true }).agent!.id));
ok(!seen.has('clone_1') && seen.size >= 2, 'a bot that is not ready is skipped');

// Smoke test no longer warns that only the primary takes calls.
const report = smokeTestAgent(state, 'clone_2');
{
  const items = JSON.stringify(report);
  ok(!items.includes('Make this bot primary'), 'the "make this bot primary" warning is gone');
  ok(items.includes('shared in turn'), 'smoke test says calls are shared in turn');
}
console.log(`✓ Phone bot rotation: ${checks} checks passed`);
