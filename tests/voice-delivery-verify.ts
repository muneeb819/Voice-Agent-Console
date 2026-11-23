// Voice delivery (prosody): every bot gets intonation, pace, tone, phrasing and
// duration guidance by default; it is saved with the bot, editable, can be
// switched off, and reaches the call prompt.
import assert from 'node:assert/strict';
import { createDefaultState, normalizeState } from '../src/defaults';
import { composeBehavioralPrompt, FLOW_DEFAULTS } from '../src/persona';
import { buildDeepgramSettings } from '../src/settings-builder';

let checks = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); checks++; };

const HEADER = '=== VOICE DELIVERY (INTONATION, PACE, TONE, PHRASING, DURATION) ===';
for (const term of ['Intonation', 'Pace', 'Tone', 'Phrasing', 'Duration']) {
  ok(FLOW_DEFAULTS.voiceDelivery.includes(term), `default guidance covers ${term}`);
}
ok(FLOW_DEFAULTS.voiceDelivery.length < 1500, 'default guidance stays compact for the prompt budget');

// Every stock bot, and an old saved bot without the field, gets it on load.
const state = normalizeState(createDefaultState());
for (const agent of state.agents) {
  ok(agent.flow.voiceDeliveryEnabled === true, `${agent.name}: voice delivery on by default`);
  ok(agent.flow.voiceDelivery === FLOW_DEFAULTS.voiceDelivery, `${agent.name}: default guidance filled`);
  ok(composeBehavioralPrompt(agent, state.campaigns[0]).includes(HEADER), `${agent.name}: guidance reaches the prompt`);
}
const legacy: any = createDefaultState();
for (const a of legacy.agents) { delete a.flow; if (a.tts) delete a.tts.expr; }
const migrated = normalizeState(legacy);
ok(migrated.agents.every((a) => a.flow.voiceDeliveryEnabled && a.flow.voiceDelivery === FLOW_DEFAULTS.voiceDelivery), 'bots saved before this setting get the default');
ok(migrated.agents.every((a) => a.tts.expr === 1), 'bots without a saved expressivity get +1 (livelier intonation on Flux voices)');

// Operator edits are kept; blank restores the default; off removes it.
const edited: any = createDefaultState();
edited.agents[0].flow = { ...edited.agents[0].flow, voiceDelivery: 'Speak slowly and warmly, rising at questions.' };
edited.agents[1].flow = { ...edited.agents[1].flow, voiceDelivery: '   ' };
edited.agents[2].flow = { ...edited.agents[2].flow, voiceDeliveryEnabled: false };
const s2 = normalizeState(edited);
ok(s2.agents[0].flow.voiceDelivery === 'Speak slowly and warmly, rising at questions.', 'edited guidance kept');
ok(composeBehavioralPrompt(s2.agents[0], null).includes('Speak slowly and warmly, rising at questions.'), 'edited guidance reaches the prompt');
ok(s2.agents[1].flow.voiceDelivery === FLOW_DEFAULTS.voiceDelivery, 'blank guidance restores the default');
ok(!composeBehavioralPrompt(s2.agents[2], null).includes(HEADER), 'switched off: no voice delivery section');
ok(normalizeState(s2).agents[2].flow.voiceDeliveryEnabled === false, 'off survives a save and reload');

// The section is in the prompt Deepgram receives on a call.
const settings = buildDeepgramSettings(state, state.agents[0], state.campaigns[0], { forceClientSideWebhooks: true });
const prompt = String(settings?.agent?.think?.prompt || '');
ok(prompt.includes(HEADER), 'live call Settings carry the voice delivery section');

console.log(`✓ Voice delivery: ${checks} checks passed`);
