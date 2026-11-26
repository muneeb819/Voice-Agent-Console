import assert from 'assert';
import { createDefaultState, normalizeState } from '../src/defaults';
import { DEFAULT_SKILLS_HEADER, DEFAULT_SKILLS_TEXT, callPromptReport, composeBehavioralPrompt } from '../src/persona';

const state = normalizeState(createDefaultState());
const campaign = state.campaigns[0];

// Every existing bot carries the skills, on by default.
for (const a of state.agents) {
  if (a.id === 'a_qa') {
    assert.strictEqual(a.flow!.defaultSkillsEnabled, false, 'the QA reviewer never takes calls, so it starts without them');
    assert.ok(!callPromptReport(a, campaign, 300).defaultSkillsOmitted, 'and is not warned about it');
    continue;
  }
  assert.strictEqual(a.flow!.defaultSkillsEnabled, true, `${a.name}: default skills on`);
  assert.ok(composeBehavioralPrompt(a, campaign).includes(DEFAULT_SKILLS_HEADER), `${a.name}: prompt carries the skills`);
}
assert.ok(DEFAULT_SKILLS_TEXT.length < 3000, 'the skills block stays compact');

// A brand-new bot (no flow saved) and a duplicate both get them; a duplicate keeps its own on/off choice.
const fresh = normalizeState({ ...createDefaultState(), agents: [{ ...state.agents[0], id: 'fresh', flow: undefined }] } as any).agents.find((a) => a.id === 'fresh')!;
assert.strictEqual(fresh.flow!.defaultSkillsEnabled, true, 'new bot: on');
const copy = JSON.parse(JSON.stringify(state.agents[0]));
copy.id = 'copy';
assert.ok(composeBehavioralPrompt(copy, campaign).includes(DEFAULT_SKILLS_HEADER), 'duplicate: carries the skills');
const offBot = { ...state.agents[0], flow: { ...state.agents[0].flow!, defaultSkillsEnabled: false } };
assert.ok(!composeBehavioralPrompt(offBot, campaign).includes(DEFAULT_SKILLS_HEADER), 'turned off: not in the prompt');
const reloaded = normalizeState({ ...state, agents: [offBot, ...state.agents.slice(1)] } as any);
assert.strictEqual(reloaded.agents[0].flow!.defaultSkillsEnabled, false, 'off survives a save and reload');

// Priority: they never push out the bot's own instructions; with no room they are left out and reported.
const big = { ...state.agents[0], prompt: 'x'.repeat(22000) };
const r = callPromptReport(big, campaign, 300);
assert.ok(r.defaultSkillsOmitted, 'no room: skills left out and reported');
assert.ok(!composeBehavioralPrompt(big, campaign).includes(DEFAULT_SKILLS_HEADER));
assert.ok(!callPromptReport(state.agents[0], campaign, 300).defaultSkillsOmitted, 'normal bots: nothing left out');
assert.ok(!callPromptReport(state.agents[0], campaign, 300).callWillFail, 'normal bots still fit');

// Honesty rules are untouched and the skills add none of their own claims about being human.
assert.ok(!/\bI am (a )?human\b/i.test(DEFAULT_SKILLS_TEXT));
console.log('default-skills: OK');
