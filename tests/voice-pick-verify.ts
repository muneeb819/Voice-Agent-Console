import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { createDefaultState, normalizeState } from '../src/defaults';
import { buildDeepgramSettings, validateAgent } from '../src/settings-builder';
import { isValidVoiceId, pickDistinctFemaleVoice, voiceFitsProvider } from '../src/voice-pick';
import type { DeepgramVoice } from '../src/types';

function voice(id: string, gender: DeepgramVoice['gender'], family: DeepgramVoice['family'], featured = false, lang = 'en'): DeepgramVoice {
  return {
    id, name: id, displayName: id, family, providerVersion: family === 'flux-v2' ? 'v2' : 'v1', languages: [lang], primaryLanguage: lang,
    accent: 'American', gender, age: 'Adult', tags: [], useCases: [], sampleUrl: null, avatarUrl: null, featured,
  };
}

// Voice ids.
assert(isValidVoiceId('flux-haley-en') && isValidVoiceId('aura-2-thalia-en') && isValidVoiceId('af_heart'), 'known voice ids are valid');
assert(!isValidVoiceId('') && !isValidVoiceId('gpt-4') && !isValidVoiceId(null) && !isValidVoiceId('flux haley'), 'junk is not a voice id');
assert(voiceFitsProvider('flux-haley-en', 'deepgram') && !voiceFitsProvider('af_heart', 'deepgram'), 'Deepgram speaks only Flux/Aura voices');
assert(voiceFitsProvider('af_heart', 'speech_service') && !voiceFitsProvider('flux-haley-en', 'speech_service'), 'local speech speaks only its own voices');

// Picker: women only, English only, nobody repeated while others are free.
const catalog = [
  voice('flux-miles-en', 'masculine', 'flux-v2', true),
  voice('aura-2-thalia-en', 'feminine', 'aura-2', true),
  voice('flux-haley-en', 'feminine', 'flux-v2', true),
  voice('flux-sienna-en', 'feminine', 'flux-v2', false),
  voice('aura-2-celeste-es', 'feminine', 'aura-2', true, 'es'),
];
const first = pickDistinctFemaleVoice(catalog, []);
assert.equal(first.voice?.id, 'flux-haley-en', 'first pick is the best featured Flux woman');
const second = pickDistinctFemaleVoice(catalog, ['flux-haley-en']);
assert.equal(second.voice?.id, 'flux-sienna-en', 'second pick skips the voice already in use');
const third = pickDistinctFemaleVoice(catalog, ['flux-haley-en', 'flux-sienna-en']);
assert.equal(third.voice?.id, 'aura-2-thalia-en', 'third pick moves on to the next family');
const none = pickDistinctFemaleVoice(catalog, ['flux-haley-en', 'flux-sienna-en', 'aura-2-thalia-en']);
assert(none.reused && ['flux-haley-en', 'flux-sienna-en', 'aura-2-thalia-en'].includes(none.voice!.id), 'when all are used one is reused, never a man or a Spanish voice');
assert(!pickDistinctFemaleVoice([voice('flux-miles-en', 'masculine', 'flux-v2')], []).voice, 'no suitable voice gives null');

// A bot keeps its own voice through load and is sent to Deepgram with it.
const st = normalizeState(createDefaultState());
const tts = st.providers.find((p) => p.kind === 'tts' && p.type === 'deepgram')!;
st.services.tts = { providerId: tts.id, model: 'aura-2-thalia-en' };
const agent = st.agents[0];
assert.equal(agent.tts.voice, '', 'a bot starts on the global voice');
assert.equal(buildDeepgramSettings(st, agent).agent.speak.provider.model, 'aura-2-thalia-en', 'global voice is used by default');

agent.tts.voice = 'flux-haley-en';
const reloaded = normalizeState(JSON.parse(JSON.stringify(st)));
assert.equal(reloaded.agents[0].tts.voice, 'flux-haley-en', 'own voice survives saving and loading');
const own = buildDeepgramSettings(reloaded, reloaded.agents[0]).agent.speak.provider;
assert.equal(own.model, 'flux-haley-en', 'the bot speaks with its own voice');
assert.equal(own.version, 'v2', 'a Flux voice is sent as v2');
assert.equal(reloaded.services.tts.model, 'aura-2-thalia-en', 'the global voice is untouched');

// Junk or a voice the provider cannot speak falls back to the global voice instead of breaking the call.
reloaded.agents[0].tts.voice = 'af_heart';
assert.equal(buildDeepgramSettings(reloaded, reloaded.agents[0]).agent.speak.provider.model, 'aura-2-thalia-en', 'voice the provider cannot speak falls back to global');
assert(validateAgent(reloaded, reloaded.agents[0]).some((i) => /own voice/.test(i.message) && !i.ok), 'pre-flight warns about it');
const junk = normalizeState({ ...JSON.parse(JSON.stringify(st)), agents: [{ ...st.agents[0], tts: { ...st.agents[0].tts, voice: 'drop table' } }] });
assert.equal(junk.agents[0].tts.voice, '', 'junk voice id is cleared on load');

// Wiring: route, console select and duplicate use the shared picker.
const server = fs.readFileSync(path.join(__dirname, '../src/server.ts'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
assert(server.includes("'/api/voices/suggest'") && server.includes('pickDistinctFemaleVoice'), 'server exposes the voice suggestion');
assert(app.includes("'a.tts.voice'") && app.includes('/api/voices/suggest'), 'console has the per-bot voice select and asks for a distinct voice on duplicate');
assert(app.includes('pickFemaleVoiceFromCatalog') && app.includes('serverlessCloudMode'), 'static/serverless builds pick from the catalog file instead of the server route');

console.log('voice-pick-verify: all checks passed');
