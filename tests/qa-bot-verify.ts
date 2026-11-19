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

  console.log('✓ Sentinel QA exists in defaults and the static demo; all campaigns can select it');
  console.log('✓ Chunked evidence, LIMITED REVIEW and INSUFFICIENT EVIDENCE guardrails are present');
  console.log('✓ QA is never a primary VICIdial agent and every composed prompt fits the limit');
}

try { run(); } catch (error) {
  console.error('QA bot verification FAILED:', error);
  process.exitCode = 1;
}
