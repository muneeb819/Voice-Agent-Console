/**
 * Saved prompt/rule changes reach the next call (no restart) — and anything that
 * would silently stop them (size cut, unsaved edits, wrong primary bot) is reported.
 */
import assert from 'node:assert/strict';
import { createDefaultState, normalizeState } from '../src/defaults';
import { smokeTestAgent, smokeTestCampaign } from '../src/smoke-test';
import { buildDeepgramSettings, promptReachReport, validateAgent } from '../src/settings-builder';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const base = normalizeState(createDefaultState());
const a1 = base.agents.find((a) => a.id === 'a1')!;
const c1 = base.campaigns.find((c) => c.id === 'c1')!;
const fail = (r: any, re: RegExp) => r.checks.find((c: any) => c.level === 'er' && re.test(c.label));
const pass = (r: any, re: RegExp) => r.checks.find((c: any) => c.level === 'ok' && re.test(c.label));

// 1) A saved new line reaches the next call; the smoke test shows the last change.
const v1 = clone(base);
const v2 = clone(base);
v2.agents.find((a) => a.id === 'a1')!.prompt += '\nNEW-RULE-A: Always mention the callback number.';
v2.campaigns.find((c) => c.id === 'c1')!.complianceRules += '\nNEW-RULE-B: Never discuss pricing.';
v2.updatedAt = '2026-11-21T03:00:00.000Z';
const revisions = [{ id: 2, saved_at: v2.updatedAt, state: v2 }, { id: 1, saved_at: '2026-11-21T02:00:00.000Z', state: v1 }];
const wire = buildDeepgramSettings(v2 as any, v2.agents.find((a) => a.id === 'a1')! as any, v2.campaigns.find((c) => c.id === 'c1')! as any).agent.think.prompt;
assert.ok(wire.includes('NEW-RULE-A') && wire.includes('NEW-RULE-B'), 'saved edits are in the next call prompt');
let r = smokeTestAgent(v2 as any, 'a1', clone(v2.agents.find((a) => a.id === 'a1')), revisions);
assert.ok(r.ok, JSON.stringify(r.checks.filter((c) => c.level === 'er')));
assert.match(pass(r, /Last saved change/).detail, /Bot instructions \+1 line/);
assert.ok(pass(r, /Live without restart/) && pass(r, /Bot instructions reach the call/) && pass(r, /Campaign rules reach the call/));
let cr = smokeTestCampaign(v2 as any, 'c1', clone(v2.campaigns.find((c) => c.id === 'c1')), revisions);
assert.ok(cr.ok);
assert.match(pass(cr, /Last saved change/).detail, /Campaign rules \+1 line/);
console.log('✓ Saved new lines reach the next call with no restart; smoke test shows "Bot instructions +1 line" / "Campaign rules +1 line"');

// 2) Unsaved edits fail and are named.
const draft = clone(a1);
draft.prompt += '\nNot saved yet.';
r = smokeTestAgent(base as any, 'a1', draft);
assert.ok(!r.ok && /Bot instructions/.test(fail(r, /Screen matches/).detail));
console.log('✓ Unsaved edits fail the smoke test and are named');

// 3) Root cause: over budget, the newest lines at the END were cut silently. Now reported.
const big = clone(base);
const bigBot = big.agents.find((a) => a.id === 'a1')!;
bigBot.prompt += `\n${'Long operator rule that fills the prompt budget. '.repeat(330)}\nNEW-RULE-Z: the newest line at the end.`;
const reach = promptReachReport(bigBot as any, big.campaigns.find((c) => c.id === 'c1') as any);
assert.ok(reach.instructionsCutChars > 0 && reach.cutLines.includes('NEW-RULE-Z: the newest line at the end.'), 'the cut lines are identified');
assert.ok(validateAgent(big as any, bigBot as any).some((v) => v.level === 'er' && /do not reach calls/.test(v.message)), 'pre-flight error');
r = smokeTestAgent(big as any, 'a1', clone(bigBot));
assert.ok(!r.ok && fail(r, /Bot instructions reach the call/));
console.log(`✓ Over-long instructions: the cut lines (${reach.cutLines.length}) are named in the meter, pre-flight and smoke test instead of being dropped silently`);

// 4) Editing a pool bot that is not the campaign's primary: warn who answers calls.
const pool = clone(base);
const camp = pool.campaigns.find((c) => c.id === 'c1')!;
camp.agentIds = Array.from(new Set([...(camp.agentIds || []), 'a_nova']));
r = smokeTestAgent(pool as any, 'a_nova');
assert.ok(r.checks.some((c) => c.level === 'wn' && /Who answers phone calls/.test(c.label) && /primary bot/.test(c.detail)));
console.log('✓ A bot that is not the campaign\'s primary is told who actually answers phone calls');

// 5) Never saved.
r = smokeTestAgent(base as any, 'a_missing', { name: 'New' });
assert.ok(!r.ok && fail(r, /Saved on the server/));
console.log('✓ A bot that was never saved fails with "press Save first"');
console.log('\nSmoke test verification passed.');
