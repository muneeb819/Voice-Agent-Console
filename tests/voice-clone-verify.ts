/**
 * Voice Lab cloning: consent is required, ElevenLabs clones become a live-call
 * voice Deepgram can use, self-hosted clones register with a consent record,
 * and nothing else can sneak a TTS endpoint past the provider filter.
 */
import assert from 'node:assert/strict';
process.env.ELEVENLABS_API_KEY = 'test-eleven-key';
process.env.SPEECH_SERVICE_URL = 'http://speech.local:8000';
import {
  CloneError, elevenCreateClone, elevenLabsLiveProvider, elevenListClones, elevenListLibrary, elevenSetExpressiveness, selfHostedCreateClone, validateCloneRequest,
} from '../src/voice-clone';
import { createDefaultState, normalizeState } from '../src/defaults';
import { buildDeepgramSettings, validateAgent } from '../src/settings-builder';

const sample = Buffer.alloc(64000, 1);
const good = { name: 'Jessica Warm', speakerName: 'Jessica Lane', consentConfirmed: true, consentStatement: 'Signed consent form on 21 Nov 2026', sample, filename: 'a.wav', mimeType: 'audio/wav' };

async function main() {
  // Consent and sample validation
  assert.throws(() => validateCloneRequest({ ...good, consentConfirmed: false }), (e: any) => e instanceof CloneError && e.code === 'CONSENT_REQUIRED');
  assert.throws(() => validateCloneRequest({ ...good, consentStatement: 'ok' }), /permission/);
  assert.throws(() => validateCloneRequest({ ...good, speakerName: '' }), /whose voice/);
  assert.throws(() => validateCloneRequest({ ...good, sample: Buffer.alloc(10) }), /sample/);
  assert.throws(() => validateCloneRequest({ ...good, mimeType: 'text/html' }), /audio file/);
  console.log('✓ Cloning refuses without the speaker name, a permission confirmation, a consent statement and a real audio sample');

  // ElevenLabs: multipart upload with the key; list keeps only cloned voices
  const calls: any[] = [];
  const fakeFetch: any = async (url: string, init: any = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/v1/voices/add')) {
      const fd = init.body as FormData;
      assert.equal(init.headers['xi-api-key'], 'test-eleven-key');
      assert.equal(fd.get('name'), 'Jessica Warm');
      assert.ok(fd.get('files') instanceof Blob, 'sample uploaded as a file');
      return new Response(JSON.stringify({ voice_id: 'CloneAbc12345' }), { status: 200 });
    }
    if (url.endsWith('/v1/voices')) return new Response(JSON.stringify({ voices: [{ voice_id: 'Premade1', name: 'Rachel', category: 'premade' }, { voice_id: 'CloneAbc12345', name: 'Jessica Warm', category: 'cloned' }] }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  const created = await elevenCreateClone(validateCloneRequest(good), fakeFetch);
  assert.equal(created.voice, 'CloneAbc12345');
  const listed = await elevenListClones(fakeFetch);
  assert.deepEqual(listed.map((v) => v.id), ['CloneAbc12345'], 'premade voices are not listed as clones');
  const planFail: any = async () => new Response(JSON.stringify({ detail: { message: 'Your subscription does not include instant voice cloning' } }), { status: 403 });
  await assert.rejects(elevenCreateClone(validateCloneRequest(good), planFail), (e: any) => e.code === 'ELEVENLABS_PLAN');
  console.log('✓ ElevenLabs: sample uploaded with your key, only cloned voices listed, plan limits explained');

  // Ready-made voices + expressiveness written onto the voice (Deepgram sends no voice settings)
  const lib = await elevenListLibrary(fakeFetch);
  assert.deepEqual(lib.map((v) => v.id), ['Premade1'], 'library lists ready-made voices, not clones');
  let edited: any = null;
  const editFetch: any = async (url: string, init: any) => { edited = { url, body: JSON.parse(init.body), key: init.headers['xi-api-key'] }; return new Response('{"status":"ok"}', { status: 200 }); };
  assert.equal(await elevenSetExpressiveness('CloneAbc12345', 'warm', editFetch), 'warm');
  assert.ok(edited.url.endsWith('/v1/voices/CloneAbc12345/settings/edit'));
  assert.equal(edited.key, 'test-eleven-key');
  assert.ok(edited.body.stability < 0.4 && edited.body.style > 0.3 && edited.body.use_speaker_boost === true, 'warm = low stability, real style');
  assert.ok(!('label' in edited.body));
  await assert.rejects(elevenSetExpressiveness('CloneAbc12345', 'robotic', editFetch), /Warm, Balanced or Steady/);
  console.log('✓ ElevenLabs: ready-made voices listed; Warm & expressive preset written onto the voice (stability 0.32, style 0.45)');

  // Live calls: Deepgram speaks through ElevenLabs with the cloned voice
  const state: any = normalizeState(createDefaultState());
  state.providers.push(elevenLabsLiveProvider('CloneAbc12345', 'Jessica Warm'));
  state.services.tts = { providerId: 'p_elevenlabs_clone', model: 'eleven_flash_v2_5' };
  const n: any = normalizeState(state);
  const agent = n.agents[0];
  const campaign = n.campaigns.find((c: any) => c.agentId === agent.id);
  const speak = buildDeepgramSettings(n, agent, campaign).agent.speak;
  assert.deepEqual(speak.provider, { type: 'eleven_labs', model_id: 'eleven_flash_v2_5' });
  assert.equal(speak.endpoint.url, 'wss://api.elevenlabs.io/v1/text-to-speech/CloneAbc12345/multi-stream-input');
  assert.deepEqual(speak.endpoint.headers, { 'xi-api-key': '{{ELEVENLABS_API_KEY}}' }, 'key comes from stored secrets, never saved in settings');
  assert.ok(validateAgent(n, agent).filter((v) => /TTS/.test(v.message)).every((v) => v.level === 'ok'));
  // Anything else stays filtered out
  const tampered: any = normalizeState({ ...state, providers: [...state.providers.filter((p: any) => p.id !== 'p_elevenlabs_clone'), { ...elevenLabsLiveProvider('CloneAbc12345', 'x'), endpoint: 'wss://evil.example/steal' }] });
  assert.ok(!tampered.providers.some((p: any) => p.type === 'eleven_labs'), 'a non-ElevenLabs endpoint is dropped');
  const rawKey: any = normalizeState({ ...state, providers: [...state.providers.filter((p: any) => p.id !== 'p_elevenlabs_clone'), { ...elevenLabsLiveProvider('CloneAbc12345', 'x'), headers: '{"xi-api-key":"sk-plaintext"}' }] });
  assert.ok(!rawKey.providers.some((p: any) => p.type === 'eleven_labs'), 'a pasted plaintext key is not accepted');
  console.log('✓ Live calls: Deepgram speaks with the ElevenLabs clone (key from stored secret); tampered endpoints or plaintext keys are dropped');

  // Self-hosted: consent fields reach the speech service
  const sh: any = async (url: string, init: any) => {
    const fd = init.body as FormData;
    assert.ok(url.startsWith('http://speech.local:8000/v1/voices'));
    assert.equal(fd.get('consent_confirmed'), 'true');
    assert.equal(fd.get('speaker_name'), 'Jessica Lane');
    assert.ok(String(fd.get('consent_statement')).length >= 10);
    return new Response(JSON.stringify({ id: 'a'.repeat(32), voice: `clone:${'a'.repeat(32)}`, name: 'Jessica Warm', duration: 42 }), { status: 201 });
  };
  const local = await selfHostedCreateClone(validateCloneRequest(good), sh);
  assert.equal(local.voice, `clone:${'a'.repeat(32)}`);
  assert.equal(local.liveCalls, false);
  const off: any = async () => new Response(JSON.stringify({ detail: 'Voice cloning is not enabled on this deployment' }), { status: 501 });
  await assert.rejects(selfHostedCreateClone(validateCloneRequest(good), off), (e: any) => e.code === 'SELFHOSTED_CLONE_OFF');
  console.log('✓ Self-hosted: consent record sent to the speech service; "needs a GPU clone container" explained when it is off');
  // Transfer announcements (the bot SAYS it is connecting) vs offers/questions
  const { announcesTransfer } = await import('../src/call-limit');
  for (const t of ['You meet all the requirements! Please hold the line for just a brief moment while I connect you with our licensed specialist.', "Great, I'll connect you now.", 'Let me transfer you to my supervisor.'])
    assert.ok(announcesTransfer(t), `announced: ${t}`);
  for (const t of ['Would you like me to connect you with a specialist?', "I can connect you if you'd like.", 'Do you have Medicare Part A and B?', "No problem, I'm not transferring you.", "I won't connect you, have a nice day.", "I can't transfer you until you confirm Part A and B.", "I'll connect you once you confirm your ZIP code."])
    assert.ok(!announcesTransfer(t), `not announced: ${t}`);
  const { callLimitWrapUpPrompt, callerDeclined } = await import('../src/call-limit');
  for (const t of ["No, I'm not interested.", "Don't transfer me.", 'Nah, call me later.', 'Please take me off your list.'])
    assert.ok(callerDeclined(t), `declined: ${t}`);
  for (const t of ['Yes, please connect me.', 'Sure, go ahead.', 'I have Part A and B, yes.', "Yes, I'm interested."])
    assert.ok(!callerDeclined(t), `not declined: ${t}`);
  assert.match(callLimitWrapUpPrompt(20), /Never transfer without the caller's agreement/);
  console.log('✓ Transfer announcements detected ("hold while I connect you"); offers, questions and negated/conditional statements are not; a caller refusal is recognised; wrap-up keeps consent mandatory');
  console.log('\nVoice clone verification passed.');
}
main().catch((e) => { console.error(e); process.exit(1); });
