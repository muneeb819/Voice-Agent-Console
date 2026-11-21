/**
 * Smoke test + Med Benefits Medicare (Jessica) template.
 */
import assert from 'node:assert/strict';
import { createDefaultState, normalizeState } from '../src/defaults';
import { smokeTestAgent, smokeTestCampaign } from '../src/smoke-test';
import { MEDICARE_TEMPLATE } from '../src/medicare-template';
import { buildDeepgramSettings } from '../src/settings-builder';
import { MED_BENEFITS_RULE_MARKER, MAX_CAMPAIGN_RULES } from '../src/persona';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { prepareDelayedOpening } = require('../public/opening.js');

const fail = (r: ReturnType<typeof smokeTestAgent>, label: RegExp) => r.checks.find((c) => c.level === 'er' && label.test(c.label));
const pass = (r: ReturnType<typeof smokeTestAgent>, label: RegExp) => r.checks.find((c) => c.level === 'ok' && label.test(c.label));

// Template shipped as the Medicare default, fitting the real phone-call budget.
const state = normalizeState(createDefaultState());
const jessica = state.agents.find((a) => a.id === 'a_medicare')!;
const medicare = state.campaigns.find((c) => c.id === 'c_medicare')!;
assert.equal(jessica.prompt, MEDICARE_TEMPLATE.AGENT.prompt);
assert.equal(jessica.greeting, MEDICARE_TEMPLATE.AGENT.greeting);
assert.equal(jessica.randomGreetingEnabled, false, 'Opening must disclose AI and ask age first');
assert.ok(/AI assistant/.test(jessica.greeting) && /how old are you\?$/i.test(jessica.greeting), 'Opening: AI disclosure + age first');
assert.equal(medicare.complianceRules, MEDICARE_TEMPLATE.CAMPAIGN.complianceRules);
assert.ok(medicare.complianceRules.includes(MED_BENEFITS_RULE_MARKER));
assert.ok(medicare.complianceRules.length <= MAX_CAMPAIGN_RULES);
for (const must of ['65–100', '30–64', 'BOTH Part A and Part B', 'five-digit ZIP', 'Social Security', 'DNC', 'TPMO', 'Oakland']) {
  assert.ok(`${medicare.complianceRules}\n${jessica.prompt}`.includes(must), `Template keeps: ${must}`);
}
const wire = buildDeepgramSettings(state, jessica, medicare);
const phonePrompt = prepareDelayedOpening(wire).settings.agent.think.prompt;
assert.ok(wire.agent.think.prompt.includes(jessica.prompt.trim()), 'Jessica’s full instructions reach the call (not truncated)');
assert.ok(phonePrompt.length <= 25000 - 800, `Phone prompt keeps headroom (${phonePrompt.length})`);
console.log(`✓ Medicare default = Med Benefits Jessica template: AI + age-first opening, rules ${medicare.complianceRules.length} chars, phone prompt ${phonePrompt.length}/25,000, nothing truncated`);

// Smoke test: saved + reaches the call.
let r = smokeTestAgent(state, 'a_medicare', JSON.parse(JSON.stringify(jessica)));
assert.ok(r.ok, JSON.stringify(r.checks.filter((c) => c.level === 'er')));
for (const label of [/Saved in the server/, /Screen matches/, /Bot instructions reach/, /Campaign rules reach/, /Opening line/, /Max call length/, /Transfer gate/]) {
  assert.ok(pass(r, label), `agent smoke passes: ${label}`);
}
console.log(`✓ Bot smoke test passes on saved settings (${r.summary.passed} checks)`);

// Unsaved edits are reported, never a false pass.
const draft = JSON.parse(JSON.stringify(jessica));
draft.greeting = 'Different unsaved opening';
draft.behavior.backgroundVoiceFilterPct = 60;
r = smokeTestAgent(state, 'a_medicare', draft);
assert.ok(!r.ok);
const unsaved = fail(r, /Screen matches/)!;
assert.ok(/Opening line/.test(unsaved.detail) && /Background voice filter/.test(unsaved.detail), unsaved.detail);
console.log('✓ Unsaved edits fail the smoke test and are named (Opening line, Background voice filter)');

// Not saved at all.
r = smokeTestAgent(state, 'a_new_unsaved', { name: 'New bot' });
assert.ok(!r.ok && fail(r, /Saved in the server/));
console.log('✓ A bot that was never saved fails with "press Save first"');

// Over-long instructions get cut: reported, not hidden.
const longState = JSON.parse(JSON.stringify(state));
const longBot = longState.agents.find((a: any) => a.id === 'a_medicare');
longBot.prompt = `${longBot.prompt}\n${'Extra line that makes the prompt too long. '.repeat(260)}`;
r = smokeTestAgent(longState, 'a_medicare', longBot);
assert.ok(!r.ok && (fail(r, /Bot instructions reach/) || fail(r, /Prompt size/)), JSON.stringify(r.checks.filter((c) => c.level !== 'ok')));
console.log('✓ Instructions that no longer fit the call prompt fail the smoke test (lines kept vs total)');

// Campaign smoke test.
let cr = smokeTestCampaign(state, 'c_medicare', JSON.parse(JSON.stringify(medicare)));
assert.ok(cr.ok, JSON.stringify(cr.checks.filter((c) => c.level === 'er')));
assert.ok(cr.checks.some((c) => c.group && /Jessica/.test(c.group)), 'Campaign smoke groups checks per assigned bot');
const cdraft = JSON.parse(JSON.stringify(medicare));
cdraft.complianceRules += '\n15. New unsaved rule.';
cr = smokeTestCampaign(state, 'c_medicare', cdraft);
assert.ok(!cr.ok && /Campaign rules/.test(fail(cr, /Screen matches/)!.detail));
console.log('✓ Campaign smoke test: rules length, VICIdial ID, transfer, per-bot call prompt; unsaved rule edits reported');

console.log('\nSmoke test verification passed.');
