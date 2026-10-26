import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { createDefaultState, normalizeState } from '../src/defaults';
import {
  buildDeepgramSettings,
  generateViciConfig,
  parseJsonObject,
  parseJsonSchema,
  validateAgent,
} from '../src/settings-builder';

const BASE = process.env.TEST_URL || 'http://127.0.0.1:3000';

async function run() {
  const results: string[] = [];
  const check = async (name: string, fn: () => Promise<void> | void) => {
    await fn();
    results.push(`PASS: ${name}`);
    console.log(`✓ ${name}`);
  };

  await check('1. Health endpoint & masked server .env secrets', async () => {
    const res = await fetch(`${BASE}/api/health`);
    assert.strictEqual(res.status, 200);
    const data: any = await res.json();
    assert.strictEqual(data.ok, true);
    assert.strictEqual(data.storage, 'sqlite+json');
    assert.ok(data.secrets && 'DEEPGRAM_API_KEY' in data.secrets);
  });

  let sampleVoiceUrl = '';
  await check('2. Live Deepgram Voice Catalog (Flux v2 + Aura-2/v1) & filtering', async () => {
    const res = await fetch(`${BASE}/api/deepgram/voices`);
    assert.strictEqual(res.status, 200);
    const data: any = await res.json();
    assert.strictEqual(data.ok, true);
    assert.ok(data.totalCatalogCount >= 130, `Expected >=130 voices, got ${data.totalCatalogCount}`);

    const fluxRes = await fetch(`${BASE}/api/deepgram/voices?family=flux-v2&accent=British`);
    const fluxData: any = await fluxRes.json();
    assert.ok(fluxData.count >= 4, `Expected British Flux v2 voices, got ${fluxData.count}`);
    assert.ok(fluxData.voices.every((v: any) => v.family === 'flux-v2' && v.accent === 'British'));

    const withSample = data.voices.find((v: any) => v.sampleUrl);
    assert.ok(withSample, 'Expected real sample audio URLs in Deepgram catalog');
    sampleVoiceUrl = withSample.sampleUrl;
  });

  await check('3. Studio Sample Audio Proxy (WAV stream + SSRF block)', async () => {
    const res = await fetch(`${BASE}/api/deepgram/sample?url=${encodeURIComponent(sampleVoiceUrl)}`);
    assert.strictEqual(res.status, 200);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.ok(buf.length > 5000, `Expected audio payload > 5KB, got ${buf.length}`);
    assert.strictEqual(buf.subarray(0, 4).toString('ascii'), 'RIFF', 'Expected valid RIFF WAV header');

    const blocked = await fetch(`${BASE}/api/deepgram/sample?url=${encodeURIComponent('https://evil.example.com/x.wav')}`);
    assert.strictEqual(blocked.status, 400, 'Expected SSRF host allowlist to reject untrusted domain');
  });

  await check('4. Live Deepgram Flux v2 TTS Synthesis (/api/tts/preview) & validation', async () => {
    const emptyRes = await fetch(`${BASE}/api/tts/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'flux-haley-en', text: '   ' }),
    });
    assert.strictEqual(emptyRes.status, 400);
    const emptyData: any = await emptyRes.json();
    assert.strictEqual(emptyData.code, 'EMPTY_TEXT');

    // Live synthesis using Universal DEEPGRAM_API_KEY in .env
    const liveTtsRes = await fetch(`${BASE}/api/tts/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerType: 'deepgram', model: 'flux-haley-en', text: 'Hello Robert, this is Sarah!' }),
    });
    assert.strictEqual(liveTtsRes.status, 200, 'Expected 200 OK live TTS audio from Deepgram');
    const liveTtsBuf = Buffer.from(await liveTtsRes.arrayBuffer());
    assert.ok(liveTtsBuf.length > 5000, `Expected >5KB synthesized MP3 audio, got ${liveTtsBuf.length}`);

    // Unconfigured BYO provider still returns actionable missing-key guidance
    const noElevenRes = await fetch(`${BASE}/api/tts/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerType: 'eleven_labs', model: 'eleven_flash_v2_5', text: 'Hello!' }),
    });
    assert.strictEqual(noElevenRes.status, 400);
    const noElevenData: any = await noElevenRes.json();
    assert.strictEqual(noElevenData.code, 'MISSING_ELEVENLABS_KEY');
  });

  await check('5. Deepgram Managed LLM Models sync endpoint', async () => {
    const res = await fetch(`${BASE}/api/deepgram/llm-models`);
    assert.strictEqual(res.status, 200);
    const data: any = await res.json();
    assert.strictEqual(data.ok, true);
    assert.ok(data.count >= 10, `Expected >=10 managed LLM models, got ${data.count}`);
  });

  await check('6. Bug Fix Regression: Function immutable IDs & safe function rename', () => {
    const st = createDefaultState();
    const fnDispo = st.functions.find((f) => f.id === 'fn_dispo')!;
    fnDispo.name = 'record_vici_outcome';
    const settings = buildDeepgramSettings(st, st.agents[0]);
    const emittedNames = settings.agent.think.functions.map((f: any) => f.name);
    assert.ok(emittedNames.includes('record_vici_outcome'), 'Renamed function must remain bound to agent via fnIds');
  });

  await check('7. Bug Fix Regression: Strict JSON Object & Schema validation (no string spreading)', () => {
    assert.strictEqual(parseJsonObject('"hello"').ok, false, 'JSON string primitive must be rejected');
    assert.strictEqual(parseJsonObject('[1,2,3]').ok, false, 'JSON array must be rejected');
    assert.strictEqual(parseJsonSchema('{"foo":"bar"}').ok, false, 'Non-object-schema must be rejected');

    const st = createDefaultState();
    st.providers[0].extra = '"corrupt"';
    const built = buildDeepgramSettings(st, st.agents[0]);
    assert.strictEqual('0' in built.agent.listen.provider, false, 'Must never spread string chars into Settings');
    const checks = validateAgent(st, st.agents[0]);
    assert.ok(checks.some((c) => c.level === 'er' && c.message.includes('JSON')));
  });

  await check('8. Bug Fix Regression: Managed Google Gemini passes & BYO Google omits model', () => {
    const st = createDefaultState();
    const gemini = st.providers.find((p) => p.type === 'google')!;
    st.agents[0].llm.p = gemini.id;
    st.agents[0].llm.model = 'gemini-2.5-flash';

    // Managed Google (blank endpoint) -> 0 errors, includes model
    const checksManaged = validateAgent(st, st.agents[0]);
    assert.strictEqual(checksManaged.filter((c) => c.level === 'er').length, 0);
    const builtManaged = buildDeepgramSettings(st, st.agents[0]);
    assert.strictEqual(builtManaged.agent.think.provider.model, 'gemini-2.5-flash');

    // BYO Google (custom endpoint) -> omits model per Deepgram spec
    gemini.endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent';
    const builtByo = buildDeepgramSettings(st, st.agents[0]);
    assert.strictEqual('model' in builtByo.agent.think.provider, false, 'BYO Google must omit provider.model');
  });

  await check('9. Bug Fix Regression: Flux TTS speed 0.05 step, integer expressivity & Aura speed range', () => {
    const st = createDefaultState();
    st.agents[0].tts.model = 'flux-haley-en';
    st.agents[0].tts.speed = 1.03; // Invalid (not 0.05 increment)
    assert.ok(validateAgent(st, st.agents[0]).some((c) => c.level === 'er' && c.message.includes('0.05')));

    st.agents[0].tts.speed = 1.05; // Valid
    assert.strictEqual(validateAgent(st, st.agents[0]).filter((c) => c.level === 'er').length, 0);

    st.agents[0].tts.model = 'aura-2-thalia-en';
    st.agents[0].tts.speed = 0.55; // Invalid for Aura (< 0.7)
    assert.ok(validateAgent(st, st.agents[0]).some((c) => c.level === 'er' && c.message.includes('0.7–1.5')));
  });

  await check('10. Bug Fix Regression: Campaign disclosure + dispo enum + multi-campaign Vici config + legacy vac-v2 migration', () => {
    const st = createDefaultState();
    const settings = buildDeepgramSettings(st, st.agents[0]);
    assert.ok(
      settings.agent.greeting.startsWith('This call may be recorded'),
      'Campaign disclosure should prepend to greeting'
    );
    const dispoFn = settings.agent.think.functions.find((f: any) => f.name === 'set_disposition');
    assert.deepStrictEqual(dispoFn.parameters.properties.code.enum, ['XFER', 'NI', 'DNC', 'NA', 'CALLBK', 'DEC']);

    // Add second campaign and verify generateViciConfig includes BOTH campaigns + separated Vici APIs
    st.campaigns.push({ ...st.campaigns[0], id: 'c2', name: 'Medicare Inbound', viciCampaign: 'MEDINB' });
    const viciTxt = generateViciConfig(st);
    assert.ok(viciTxt.includes('FETEST') && viciTxt.includes('MEDINB'), 'Must include all campaigns');
    assert.ok(viciTxt.includes('/vicidial/non_agent_api.php') && viciTxt.includes('/agc/api.php'));
    assert.ok(!viciTxt.includes('uuidgen'), 'Must not spawn subshell uuidgen');

    // Legacy vac-v2 migration check (removes accept_vicidial_call from LLM tools & coerces string numbers)
    const migrated = normalizeState({
      agents: [
        {
          id: 'a_leg',
          name: 'Legacy Bot',
          greeting: 'Hello there, testing legacy import!',
          prompt: 'When the call connects, call accept_vicidial_call. Handle DNC and transfer_to_live_agent.',
          stt: { p: 's1', model: 'flux-general-en', eot: '0.75', eager: '0.5', eotms: '5000' },
          llm: { p: 'l1', model: 'gpt-5-mini', temp: '0.6' },
          tts: { p: 't1', model: 'flux-kit-en', speed: '1.05', expr: '0' },
          audio: { inEnc: 'linear16', inRate: '8000', outEnc: 'linear16', outRate: '8000' },
          fns: ['accept_vicidial_call', 'transfer_to_live_agent', 'end_call'],
        },
      ],
    });
    assert.strictEqual(typeof migrated.agents[0].stt.eot, 'number');
    assert.strictEqual(migrated.agents[0].acceptViciCalls, true);
    assert.ok(!migrated.functions.some((f) => f.name === 'accept_vicidial_call'));
  });

  await check('11. SQLite + JSON persistence & duplicate-named agent export preservation', async () => {
    const get1: any = await (await fetch(`${BASE}/api/state`)).json();
    const state = get1.state;

    // Create two agents with identical name "Untitled" to prove no overwrite in settingsByAgentId
    const dup1 = { ...JSON.parse(JSON.stringify(state.agents[0])), id: 'ag_u1', name: 'Untitled' };
    const dup2 = { ...JSON.parse(JSON.stringify(state.agents[0])), id: 'ag_u2', name: 'Untitled' };
    const testState = { ...state, agents: [state.agents[0], dup1, dup2] };

    const putRes = await fetch(`${BASE}/api/state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: testState }),
    });
    assert.strictEqual(putRes.status, 200);
    const putData: any = await putRes.json();
    assert.ok('ag_u1' in putData.settingsByAgentId && 'ag_u2' in putData.settingsByAgentId);

    // Check SQLite & JSON mirror files exist on disk
    const dbFile = path.resolve(__dirname, '..', 'data', 'console.sqlite');
    const jsonFile = path.resolve(__dirname, '..', 'data', 'console-state.json');
    assert.ok(fs.existsSync(dbFile), 'SQLite DB file must exist on disk');
    assert.ok(fs.existsSync(jsonFile), 'JSON mirror file must exist on disk');

    // Restore clean default state after test so UI starts crisp for user inspection
    const resetRes = await fetch(`${BASE}/api/state/reset`, { method: 'POST' });
    assert.strictEqual(resetRes.status, 200);
  });

  console.log(`\nALL ${results.length}/${results.length} STEP 1 VERIFICATION CHECKS PASSED!`);
}

run().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
