import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { createDefaultState, normalizeState } from '../src/defaults';
import { DATA_DIR } from '../src/data-paths';
import { fetchAllowedSampleAudio } from '../src/deepgram-catalog';
import {
  buildDeepgramSettings,
  generateViciConfig,
  getCampaignCallReadinessBlockers,
  getDeploymentReadinessBlockers,
  parseJsonObject,
  parseJsonSchema,
  validateAgent,
  validateState,
} from '../src/settings-builder';

const BASE = process.env.TEST_URL || 'http://localhost:3000';

function configureTestServices(state: any) {
  const stt = state.providers.find((p: any) => p.kind === 'stt');
  const llm = state.providers.find((p: any) => p.kind === 'llm' && p.type === 'open_ai');
  const tts = state.providers.find((p: any) => p.kind === 'tts' && p.type === 'deepgram');
  state.services = {
    stt: { providerId: stt.id, model: 'flux-general-multi' },
    llm: { providerId: llm.id, model: 'gpt-4o-mini' },
    tts: { providerId: tts.id, model: 'flux-haley-en' },
  };
  return state;
}

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
  await check('2. Deepgram voice catalog (cached or live) & filtering', async () => {
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

  await check('3. Studio Sample Audio Proxy (mocked upstream, unavailable response + SSRF block)', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (_url: any, options: any) => {
        assert.strictEqual(options.redirect, 'error');
        return new Response(Buffer.from('RIFF-mocked-sample'), { headers: { 'Content-Type': 'audio/wav' } });
      }) as typeof fetch;
      const sample = await fetchAllowedSampleAudio('https://static.deepgram.com/sample.wav');
      assert.strictEqual(sample.buffer.toString(), 'RIFF-mocked-sample');
      globalThis.fetch = (async () => new Response('<html>not audio</html>', { headers: { 'Content-Type': 'text/html' } })) as typeof fetch;
      await assert.rejects(fetchAllowedSampleAudio('https://static.deepgram.com/sample.wav'), /not a supported audio type/);
      globalThis.fetch = (async () => { throw new Error('offline'); }) as typeof fetch;
      await assert.rejects(fetchAllowedSampleAudio('https://static.deepgram.com/sample.wav'), /Voice sample unavailable/);
    } finally {
      globalThis.fetch = originalFetch;
    }
    const res = await fetch(`${BASE}/api/deepgram/sample?url=${encodeURIComponent(sampleVoiceUrl)}`);
    if (res.status === 200) {
      assert.match(res.headers.get('content-type') || '', /^audio\/(?:wav|x-wav|wave|mpeg|mp3|ogg|webm|mp4|x-m4a|aac|flac)(?:\s*;|$)/i);
      assert.ok((await res.arrayBuffer()).byteLength > 0, 'A real upstream response must contain audio');
    } else {
      assert.strictEqual(res.status, 502, 'Unavailable samples must not be replaced with fake audio');
      assert.strictEqual((await res.json() as any).code, 'SAMPLE_UNAVAILABLE');
    }
    const blocked = await fetch(`${BASE}/api/deepgram/sample?url=${encodeURIComponent('https://evil.example.com/x.wav')}`);
    assert.strictEqual(blocked.status, 400, 'Expected SSRF host allowlist to reject untrusted domain');
  });

  await check('4. TTS preview validation (live synthesis only when configured)', async () => {
    const emptyRes = await fetch(`${BASE}/api/tts/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'flux-haley-en', text: '   ' }),
    });
    assert.strictEqual(emptyRes.status, 400);
    const emptyData: any = await emptyRes.json();
    assert.strictEqual(emptyData.code, 'EMPTY_TEXT');

    // Live synthesis using Universal DEEPGRAM_API_KEY in .env (or verify MISSING_DEEPGRAM_KEY when .env is absent in offline CI)
    const liveTtsRes = await fetch(`${BASE}/api/tts/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerType: 'deepgram', model: 'flux-haley-en', text: 'Hello Robert, this is Sarah!' }),
    });
    if (liveTtsRes.status === 200) {
      const liveTtsBuf = Buffer.from(await liveTtsRes.arrayBuffer());
      assert.ok(liveTtsBuf.length > 5000, `Expected >5KB synthesized MP3 audio, got ${liveTtsBuf.length}`);
    } else {
      const errData: any = await liveTtsRes.json();
      assert.strictEqual(errData.code, 'MISSING_DEEPGRAM_KEY', 'Expected 200 OK or MISSING_DEEPGRAM_KEY when .env has no key');
    }

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
    const st = configureTestServices(createDefaultState());
    const fnDispo = st.functions.find((f: any) => f.id === 'fn_dispo')!;
    fnDispo.name = 'record_vici_outcome';
    const settings = buildDeepgramSettings(st, st.agents[0]);
    const emittedNames = settings.agent.think.functions.map((f: any) => f.name);
    assert.ok(emittedNames.includes('record_vici_outcome'), 'Renamed function must remain bound to agent via fnIds');
  });

  await check('7. Bug Fix Regression: Strict JSON Object & Schema validation (no string spreading)', () => {
    assert.strictEqual(parseJsonObject('"hello"').ok, false, 'JSON string primitive must be rejected');
    assert.strictEqual(parseJsonObject('[1,2,3]').ok, false, 'JSON array must be rejected');
    assert.strictEqual(parseJsonSchema('{"foo":"bar"}').ok, false, 'Non-object-schema must be rejected');

    const st = configureTestServices(createDefaultState());
    st.providers[0].extra = '"corrupt"';
    const built = buildDeepgramSettings(st, st.agents[0]);
    assert.strictEqual('0' in built.agent.listen.provider, false, 'Must never spread string chars into Settings');
    const checks = validateAgent(st, st.agents[0]);
    assert.ok(checks.some((c) => c.level === 'er' && c.message.includes('JSON')));
  });

  await check('8. Global service routing: unset services block use; legacy Nova cannot override the Console selection', () => {
    const unconfigured = createDefaultState();
    const missing = validateAgent(unconfigured, unconfigured.agents[0]);
    assert.ok(missing.some((item) => item.level === 'er' && item.message.includes('global STT')));
    assert.ok(missing.some((item) => item.level === 'er' && item.message.includes('global LLM')));
    assert.ok(missing.some((item) => item.level === 'er' && item.message.includes('global TTS')));

    const legacy: any = createDefaultState();
    legacy.agents[0].language = 'en,es';
    (legacy.agents[0].stt as any).model = 'nova-3';
    legacy.providers.find((p: any) => p.kind === 'stt').models = 'nova-3,nova-2';
    legacy.providers.find((p: any) => p.kind === 'stt').extra = '{"model":"nova-3","version":"v1","smart_format":true}';
    const migrated = normalizeState(legacy);
    assert.strictEqual((migrated.agents[0].stt as any).model, undefined, 'Per-agent STT model overrides are removed during migration');
    assert.strictEqual(migrated.providers.find((p) => p.kind === 'stt')?.models, 'nova-3,flux-general-en,flux-general-multi');
    assert.strictEqual(migrated.services.stt.providerId, '', 'Old per-agent values must not silently choose a global channel');

    const ready = configureTestServices(migrated);
    ready.services.stt.model = 'flux-general-multi';
    (ready.agents[0].stt as any).model = 'nova-3'; // Legacy agent field must be ignored at runtime.
    const settings = buildDeepgramSettings(ready, ready.agents[0]);
    const listen = settings.agent.listen.provider;
    assert.strictEqual(listen.type, 'deepgram');
    assert.strictEqual(listen.version, 'v2');
    assert.strictEqual(listen.model, 'flux-general-multi');
    assert.strictEqual('smart_format' in listen, false);
    assert.strictEqual(settings.agent.think.provider.model, 'gpt-4o-mini');
    assert.strictEqual(settings.agent.speak.provider.model, 'flux-haley-en');
  });

  await check('9. Global LLM provider/model routes only the saved Deepgram-managed channel', () => {
    const st = configureTestServices(createDefaultState());
    const gemini = st.providers.find((p: any) => p.kind === 'llm' && p.type === 'google')!;
    st.services.llm = { providerId: gemini.id, model: 'gemini-3-flash-preview' };
    const settings = buildDeepgramSettings(st, st.agents[0]);
    assert.strictEqual(settings.agent.think.provider.type, 'google');
    assert.strictEqual(settings.agent.think.provider.model, 'gemini-3-flash-preview');
    assert.strictEqual(validateAgent(st, st.agents[0]).filter((c) => c.level === 'er').length, 0);

    // Even a malformed provider endpoint/extra cannot override the global managed model route.
    gemini.endpoint = 'https://example.invalid/custom';
    gemini.extra = '{"model":"gpt-4o-mini","endpoint":"https://example.invalid/override"}';
    const guarded = buildDeepgramSettings(st, st.agents[0]);
    assert.strictEqual(guarded.agent.think.provider.model, 'gemini-3-flash-preview');
    assert.strictEqual('endpoint' in guarded.agent.think, false);
    assert.strictEqual('endpoint' in guarded.agent.think.provider, false);
    assert.ok(validateAgent(st, st.agents[0]).some((c) => c.level === 'er' && c.message.includes('no BYO endpoint')));
  });

  await check('10. Bug Fix Regression: Flux TTS speed 0.05 step, integer expressivity & Aura speed range', () => {
    const st = configureTestServices(createDefaultState());
    st.services.tts.model = 'flux-haley-en';
    st.agents[0].tts.speed = 1.03; // Invalid (not 0.05 increment)
    assert.ok(validateAgent(st, st.agents[0]).some((c) => c.level === 'er' && c.message.includes('0.05')));

    st.agents[0].tts.speed = 1.05; // Valid
    assert.strictEqual(validateAgent(st, st.agents[0]).filter((c) => c.level === 'er').length, 0);

    st.services.tts.model = 'aura-2-thalia-en';
    st.agents[0].tts.speed = 0.55; // Invalid for Aura (< 0.7)
    assert.ok(validateAgent(st, st.agents[0]).some((c) => c.level === 'er' && c.message.includes('0.7–1.5')));
  });

  await check('11. Bug Fix Regression: Campaign disclosure + dispo enum + multi-campaign Vici config + legacy vac-v2 migration', () => {
    const st = configureTestServices(createDefaultState());
    assert.equal(st.agents[0].injectCampaignDisclosure, false);
    st.agents[0].injectCampaignDisclosure = true;
    const settings = buildDeepgramSettings(st, st.agents[0]);
    assert.ok(
      settings.agent.greeting.startsWith('This call may be recorded'),
      'The opted-in campaign disclosure should prepend to the opening'
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

  await check('12. SQLite + JSON persistence & duplicate-named agent export preservation', async () => {
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
    const dbFile = path.join(DATA_DIR, 'console.sqlite');
    const jsonFile = path.join(DATA_DIR, 'console-state.json');
    assert.ok(fs.existsSync(dbFile), 'SQLite DB file must exist on disk');
    assert.ok(fs.existsSync(jsonFile), 'JSON mirror file must exist on disk');

    // Restore clean default state after test so UI starts crisp for user inspection
    const resetRes = await fetch(`${BASE}/api/state/reset`, { method: 'POST' });
    assert.strictEqual(resetRes.status, 200);
  });

  await check('13. Regression: Aura v1 (aura-stella-en), Jessica - Medicare, Nova Concierge & Medicare — Fronter Outbound pass with 0 errors/warnings', () => {
    const raw: any = configureTestServices(createDefaultState());
    raw.services.tts = { providerId: 't1', model: 'aura-stella-en' };
    raw.agents.push({
      id: 'a_jessica',
      name: 'Jessica - Medicare',
      mode: 'outbound',
      language: 'en',
      greeting: 'Hello! This is Jessica calling from the Medicare Benefits Department.',
      prompt: 'You are Jessica, a Medicare advisor helping seniors review their Part A and Part B benefits.',
      acceptViciCalls: true,
      injectCampaignDisclosure: true,
      stt: { keyterms: 'Medicare', eot: 0.55, eager: 0.35, eotms: 1800, smartFormat: false },
      llm: { temp: 0.45, reasoning: 'low' },
      tts: { speed: 1.0, expr: 0 },
      audio: { inEnc: 'linear16', inRate: 16000, outEnc: 'linear16', outRate: 24000 },
      fnIds: ['fn_xfer', 'fn_dispo', 'fn_end'],
    });
    raw.campaigns.push({
      id: 'c_med_fronter',
      name: 'Medicare — Fronter Outbound',
      agentId: 'a_jessica',
      viciCampaign: 'MEDFRONT',
      lists: '2001',
      start: '09:00',
      end: '20:00',
      tz: 'America/New_York',
      attempts: 3,
      retry: 120,
      maxCalls: 10,
      xferType: 'ingroup',
      xferTarget: 'MED_CLOSERS',
      fallback: 'Dispo CALLBK',
      dnc: true,
      disclosure: '',
      dispos: 'XFER,DQ,LANG,DNC,NI,NA,CALLBK',
      complianceRules: 'Medicare campaign rules reviewed: identify accurately, avoid benefit and coverage guarantees, never invent eligibility, and honor refusal or do-not-call requests immediately.',
    });

    const normalized = normalizeState(raw);
    const items = validateState(normalized);
    const nonOk = items.filter((i) => i.level !== 'ok');
    assert.deepStrictEqual(nonOk, [], `Expected 0 errors and 0 warnings, got: ${JSON.stringify(nonOk)}`);
    const jessica = normalized.agents.find((a) => a.name === 'Jessica - Medicare')!;
    const jessicaSettings = buildDeepgramSettings(normalized, jessica);
    assert.deepStrictEqual(jessicaSettings.agent.speak.provider, {
      type: 'deepgram',
      version: 'v1',
      model: 'aura-stella-en',
    });
  });

  await check('14. Explicit campaign rules, multi-campaign routing, and hard readiness blockers', () => {
    const state = configureTestServices(createDefaultState());
    const agent = state.agents[0];
    const first = state.campaigns.find((campaign: any) => campaign.agentId === agent.id)!;
    const firstRules = first.complianceRules;
    const firstSettings = buildDeepgramSettings(state, agent, first);
    assert.ok(firstSettings.agent.think.prompt.includes(firstRules));

    const second = { ...first, id: 'c_second_same_agent', name: 'Second campaign', viciCampaign: 'SECOND', complianceRules: 'Second campaign rules: use a distinct approved script and never assert unverified benefits.' };
    state.campaigns.push(second);
    const secondSettings = buildDeepgramSettings(state, agent, second);
    assert.ok(secondSettings.agent.think.prompt.includes(second.complianceRules));
    assert.ok(!secondSettings.agent.think.prompt.includes(firstRules), 'Explicit campaign B must not inherit campaign A rules');
    assert.ok(!buildDeepgramSettings(state, agent).agent.think.prompt.includes('MANDATORY CAMPAIGN-SPECIFIC'), 'Ambiguous multi-campaign previews do not silently choose the first campaign');
    assert.throws(() => buildDeepgramSettings(state, agent, { ...second, id: 'missing-campaign' }), /not explicitly assigned/i);
    const wrongAssignment = structuredClone(state);
    const wrongCampaign = wrongAssignment.campaigns.find((campaign: any) => campaign.id === second.id)!;
    wrongCampaign.agentId = 'someone-else';
    wrongCampaign.agentIds = ['someone-else'];
    assert.throws(() => buildDeepgramSettings(wrongAssignment, wrongAssignment.agents[0], wrongCampaign), /not explicitly assigned/i);
    assert.deepStrictEqual(getCampaignCallReadinessBlockers(state, first), [], 'Multiple campaign assignments are allowed');

    const noCampaigns = normalizeState({ ...structuredClone(state), campaigns: [] });
    assert.deepStrictEqual(noCampaigns.campaigns, [], 'Missing campaigns are not silently recreated from defaults');
    const orphan = normalizeState({ ...structuredClone(state), campaigns: [{ ...first, agentId: '', agentIds: [], viciCampaign: '', xferTarget: '' }] });
    assert.equal(orphan.campaigns[0].agentId, '', 'Missing agent assignment is not silently defaulted');
    assert.equal(orphan.campaigns[0].viciCampaign, '', 'Missing VICIdial ID is not replaced with a made-up campaign');
    assert.equal(orphan.campaigns[0].xferTarget, '', 'Missing closer routing is not inferred from the campaign name');
    assert.ok(getCampaignCallReadinessBlockers(orphan, orphan.campaigns[0]).length > 0);
    const noXferDisposition = { ...first, dispos: 'NI,DNC' };
    assert.ok(getCampaignCallReadinessBlockers(state, noXferDisposition).some((message) => message.includes('XFER')));
    const noDispositions = { ...first, dispos: '' };
    assert.ok(getCampaignCallReadinessBlockers(state, noDispositions).some((message) => message.includes('At least one')));

    const unassigned = structuredClone(state);
    unassigned.campaigns = unassigned.campaigns.filter((campaign: any) => campaign.agentId !== agent.id).map((campaign: any) => ({ ...campaign, agentIds: (campaign.agentIds || []).filter((id: string) => id !== agent.id) }));
    assert.ok(validateAgent(unassigned, agent).some((item) => item.level === 'er' && item.message.includes('assigned')));
    assert.ok(getDeploymentReadinessBlockers(unassigned).some((message) => message.includes('must be explicitly assigned')));

    const legacyAutomaticSilence = normalizeState({ ...structuredClone(state), campaigns: [{ ...first,
      presenceCheckText: 'Old presence prompt', deadAirTimeoutSec: 3, deadAirDisposition: 'DAIR', deadAirDispositionVerified: false,
    }] });
    assert.deepStrictEqual(getCampaignCallReadinessBlockers(legacyAutomaticSilence, legacyAutomaticSilence.campaigns[0]), [],
      'Retired automatic-silence fields must not block a saved campaign');
    for (const key of ['presenceCheckText', 'deadAirTimeoutSec', 'deadAirDisposition', 'deadAirDispositionVerified']) {
      assert.equal(Object.prototype.hasOwnProperty.call(legacyAutomaticSilence.campaigns[0], key), false);
    }
    assert.ok(!buildDeepgramSettings(legacyAutomaticSilence, agent, legacyAutomaticSilence.campaigns[0]).agent.think.prompt.includes('Old presence prompt'));
  });

  await check('14. Multi-bot campaign assignment migrates legacy state, preserves primary routing and rejects unassigned bots', () => {
    const state = configureTestServices(createDefaultState());
    const campaign = state.campaigns[0];
    const secondary = state.agents[1];
    campaign.agentIds = [campaign.agentId, secondary.id, secondary.id];
    const normalized = normalizeState(state);
    const saved = normalized.campaigns[0];
    assert.deepStrictEqual(saved.agentIds, [campaign.agentId, secondary.id]);
    assert.equal(saved.agentId, campaign.agentId);
    assert.deepStrictEqual(getCampaignCallReadinessBlockers(normalized, saved, secondary), []);
    assert(buildDeepgramSettings(normalized, secondary, saved).agent.think.prompt.includes('Medicare'));
    const outsider = normalized.agents[2];
    assert.throws(() => buildDeepgramSettings(normalized, outsider, saved), /not explicitly assigned/i);
    assert(getCampaignCallReadinessBlockers(normalized, saved, outsider).some((message) => message.includes('not assigned')));
    const legacy = normalizeState({ ...structuredClone(state), campaigns: [{ ...campaign, agentIds: undefined }] });
    assert.deepStrictEqual(legacy.campaigns[0].agentIds, [campaign.agentId]);
    const stale = normalizeState({ ...structuredClone(state), campaigns: [{ ...campaign, agentId: 'missing', agentIds: [secondary.id, 'missing'] }] });
    assert.equal(stale.campaigns[0].agentId, secondary.id);
    assert.deepStrictEqual(stale.campaigns[0].agentIds, [secondary.id]);
    const exportPayload = generateViciConfig(normalized);
    assert(exportPayload.includes('Assigned Bot Pool'));
    assert(exportPayload.includes(secondary.name));
  });

  console.log(`\nALL ${results.length}/${results.length} STEP 1 VERIFICATION CHECKS PASSED!`);
}

run().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
