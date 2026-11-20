import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createDefaultState, normalizeState } from '../src/defaults';
import { buildDeepgramSettings } from '../src/settings-builder';
import { MAX_PROMPT_LENGTH } from '../src/persona';

const root = path.resolve(__dirname, '..');
const read = (file: string) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));

function checkState(label: string, state: any): void {
  const qa = state.agents.find((agent: any) => agent.id === 'a_qa');
  assert(qa, `${label}: Sentinel QA agent is present`);
  assert.equal(qa.name, 'Sentinel — Supervisor & Quality Control');
  assert.equal(qa.acceptViciCalls, false, `${label}: QA must never accept a live VICIdial call`);
  for (const phrase of ['100-POINT SCORECARD', 'CRITICAL RED FLAGS', 'EVIDENCE PART n/N', 'LIMITED REVIEW', 'INSUFFICIENT EVIDENCE']) {
    assert(qa.prompt.includes(phrase), `${label}: QA prompt is missing ${phrase}`);
  }
  assert.equal(new Set(state.agents.map((agent: any) => agent.id)).size, state.agents.length, `${label}: agent IDs are unique`);
  for (const campaign of state.campaigns) {
    assert(campaign.agentIds.includes('a_qa'), `${label}: ${campaign.id} does not include Sentinel`);
    assert.notEqual(campaign.agentId, 'a_qa', `${label}: Sentinel must not be a primary telephone agent`);
    const settings = buildDeepgramSettings(state, qa, campaign);
    const length = settings.agent.think.prompt.length;
    assert(length <= MAX_PROMPT_LENGTH, `${label}: ${campaign.id} prompt is ${length} > ${MAX_PROMPT_LENGTH}`);
  }
  assert(Array.isArray(state.tests?.a_qa) && state.tests.a_qa.length >= 7, `${label}: QA tests are present`);
}

function run(): void {
  const defaults = createDefaultState();
  checkState('defaults', defaults);
  assert(defaults.agents.length >= 5, 'defaults include the AI agents plus Sentinel');

  const normalized = normalizeState(JSON.parse(JSON.stringify(defaults)));
  checkState('normalized defaults', normalized);

  const staticState = read('public/default-state.json');
  checkState('static default-state', staticState);
  assert.equal(staticState.agents.length, 6, 'static demo includes all six configured bots');

  const mirrored = read('docs/default-state.json');
  assert.deepEqual(mirrored, staticState, 'docs/default-state.json must match public/default-state.json');

  // ---- Existing installs saved before the built-in bots shipped -------------
  // (e.g. only Sarah / Nova / Jesica): Sentinel and Build-In Bot are added
  // once, existing bots are untouched, and a later delete is respected.
  {
    const legacy: any = JSON.parse(JSON.stringify(defaults));
    const keep = ['a1', 'a_nova'];
    legacy.agents = legacy.agents.filter((a: any) => keep.includes(a.id)).map((a: any) => ({ ...a, name: a.id === 'a1' ? 'Sarah' : a.name }));
    legacy.campaigns = legacy.campaigns.filter((c: any) => ['c1', 'c_nova'].includes(c.id)).map((c: any) => ({ ...c, agentIds: [c.agentId] }));
    legacy.tests = {};
    delete legacy.seededBuiltins;
    const upgraded = normalizeState(legacy);
    const ids = upgraded.agents.map((a) => a.id);
    assert.deepEqual(ids.slice(0, 2), ['a1', 'a_nova'], 'existing bots keep their order');
    assert.ok(ids.includes('a_qa') && ids.includes('a_builtin'), 'Sentinel and Build-In Bot are added to an older install');
    assert.equal(upgraded.agents[0].name, 'Sarah', 'existing bot names are untouched');
    for (const c of upgraded.campaigns.filter((x) => x.id !== 'c_builtin')) {
      assert.ok(c.agentIds.includes('a_qa') && c.agentId !== 'a_qa', `${c.name}: Sentinel joins the pool, never the phone route`);
    }
    const builtinCamp = upgraded.campaigns.find((c) => c.id === 'c_builtin');
    assert.ok(builtinCamp && builtinCamp.agentId === 'a_builtin', 'Build-In Bot gets its own campaign');
    assert.ok(builtinCamp!.slot > Math.max(...upgraded.campaigns.filter((c) => c.id !== 'c_builtin').map((c) => c.slot)), 'new campaign takes a new extension');
    const qa = upgraded.agents.find((a) => a.id === 'a_qa')!;
    assert.deepEqual(qa.fnIds.map((id) => upgraded.functions.find((f) => f.id === id)?.name), ['end_call'], 'Sentinel keeps its end_call tool');
    const again = normalizeState(upgraded);
    assert.equal(again.agents.length, upgraded.agents.length, 'adding is one-time (idempotent)');
    const deleted = normalizeState({ ...upgraded, agents: upgraded.agents.filter((a) => a.id !== 'a_qa') });
    assert.ok(!deleted.agents.some((a) => a.id === 'a_qa'), 'a deleted Sentinel is not re-added');
    // Codex P2: a saved function without an id must still bind to the new bots.
    const noIds: any = JSON.parse(JSON.stringify(legacy));
    noIds.functions = noIds.functions.map((f: any) => { const { id, ...rest } = f; void id; return rest; });
    noIds.agents = noIds.agents.map((a: any) => { const { fnIds, ...rest } = a; void fnIds; return { ...rest, fns: ['end_call'] }; });
    const fromNoIds = normalizeState(noIds);
    const qa2 = fromNoIds.agents.find((a) => a.id === 'a_qa')!;
    const b2 = fromNoIds.agents.find((a) => a.id === 'a_builtin')!;
    assert.deepEqual(qa2.fnIds.map((id) => fromNoIds.functions.find((f) => f.id === id)?.name), ['end_call'], 'Sentinel binds end_call even when saved functions had no id');
    assert.deepEqual(b2.fnIds.map((id) => fromNoIds.functions.find((f) => f.id === id)?.name).sort(), ['end_call', 'set_disposition', 'transfer_to_live_agent'], 'Build-In Bot binds all three tools');
    console.log('✓ Older installs (e.g. Sarah/Nova/Jesica) gain Sentinel + Build-In Bot once; existing bots untouched; deletes respected');
  }

  console.log('✓ Sentinel QA exists in defaults and the static demo; all campaigns can select it');
  console.log('✓ Chunked evidence, LIMITED REVIEW and INSUFFICIENT EVIDENCE guardrails are present');
  console.log('✓ QA is never a primary VICIdial agent and every composed prompt fits the limit');
}

try { run(); } catch (error) {
  console.error('QA bot verification FAILED:', error);
  process.exitCode = 1;
}
