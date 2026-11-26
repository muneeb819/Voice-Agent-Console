import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { createDefaultState, normalizeState } from '../src/defaults';
import { probeDeepgramKey, runDiagnostics, type DiagnosticInputs, type DiagnosticReport } from '../src/diagnostics';
import type { AlertRecord } from '../src/alerts';

const ok = async () => ({ ok: true, detail: 'fine' });
function base(over: Partial<DiagnosticInputs> = {}): DiagnosticInputs {
  const state = normalizeState(createDefaultState());
  state.vici.viciBaseUrl = 'https://dialer.example';
  state.vici.amiHost = 'dialer.example';
  state.vici.amiUser = 'aibridge';
  return {
    state,
    secrets: { DEEPGRAM_API_KEY: { configured: true } },
    bridge: { sipRegistration: { status: 'registered' }, rejectedOverCapacityCount: 0, sipRtpListening: true, audioSocketListening: true },
    botSleep: { sleeping: false },
    alerts: [],
    probes: { deepgram: ok, viciApi: ok, ami: ok, disk: async () => ({ writable: true, freeBytes: 50 * 1024 ** 3 }) },
    probeTimeoutMs: 80,
    ...over,
  };
}
const find = (r: DiagnosticReport, id: string) => {
  const f = r.findings.find((x) => x.id === id);
  assert(f, `finding ${id} exists`);
  return f!;
};
function alert(over: Partial<AlertRecord>): AlertRecord {
  return { id: 'a1', kind: 'transfer_failed', severity: 'critical', title: 'Transfer to 8200 failed', detail: 'AMI unreachable', key: 'k', count: 2, firstAt: '', lastAt: '', acknowledged: false, ...over };
}

(async () => {
  // Healthy server: everything that was probed is OK.
  const good = await runDiagnostics(base());
  for (const id of ['keys.deepgram', 'keys.deepgram_live', 'bots.sleep', 'bridge.running', 'dialer.api', 'dialer.ami', 'transfers.recent', 'server.disk']) {
    assert.equal(find(good, id).status, 'ok', `${id} is ok when healthy`);
  }
  assert(good.findings.every((f) => f.status !== 'ok' || f.suggestion === ''), 'OK rows carry no fix text');
  assert(good.findings.every((f) => (f.status === 'ok' || f.status === 'skipped') || f.suggestion.length > 0), 'every problem row says what to do');
  assert.equal(good.counts.ok + good.counts.warn + good.counts.fail + good.counts.skipped, good.findings.length, 'counts add up');

  // No key: nothing is sent to Deepgram.
  let called = false;
  const noKey = await runDiagnostics(base({ secrets: {}, probes: { ...base().probes, deepgram: async () => { called = true; return { ok: true, detail: '' }; } } }));
  assert.equal(find(noKey, 'keys.deepgram').status, 'fail', 'missing key is a problem');
  assert.equal(find(noKey, 'keys.deepgram_live').status, 'skipped', 'live check is skipped without a key');
  assert(!called, 'Deepgram is not contacted without a key');
  assert.equal(noKey.overall, 'fail', 'overall follows the worst row');

  // A refused key, and a probe that throws, both come back as readable problems.
  const bad = await runDiagnostics(base({ probes: { ...base().probes, deepgram: async () => ({ ok: false, detail: 'Deepgram says 401' }), viciApi: async () => { throw new Error('connect ECONNREFUSED 1.2.3.4:443'); } } }));
  assert.equal(find(bad, 'keys.deepgram_live').status, 'fail');
  assert.equal(find(bad, 'dialer.api').status, 'fail', 'a throwing probe is a problem, not a crash');
  assert(/ECONNREFUSED/.test(find(bad, 'dialer.api').detail), 'the reason is shown');

  // A probe that never answers is cut off.
  const t0 = Date.now();
  const hung = await runDiagnostics(base({ probes: { ...base().probes, ami: () => new Promise(() => {}) } }));
  assert(Date.now() - t0 < 2000, 'a hung probe does not hang the scan');
  assert.equal(find(hung, 'dialer.ami').status, 'warn', 'AMI silence is a warning, since API and REFER still work');

  // Skipped when not configured.
  const st = base().state;
  st.vici.viciBaseUrl = '';
  st.vici.amiUser = '';
  const bare = await runDiagnostics(base({ state: st }));
  assert.equal(find(bare, 'dialer.api').status, 'skipped');
  assert.equal(find(bare, 'dialer.ami').status, 'skipped');

  // Bots, bridge, transfers, capacity.
  assert.equal(find(await runDiagnostics(base({ botSleep: { sleeping: true } })), 'bots.sleep').status, 'warn', 'sleeping bots are flagged');
  assert.equal(find(await runDiagnostics(base({ bridge: null })), 'bridge.running').status, 'fail', 'no bridge is a problem');
  const stReg = base().state;
  stReg.vici.transport = 'sip_trunk';
  stReg.vici.sipConnectionMode = 'registration';
  assert.equal(find(await runDiagnostics(base({ state: stReg, bridge: { sipRegistration: { status: 'failed', lastError: '403 Forbidden' }, sipRtpListening: true } })), 'bridge.sip').status, 'fail', 'failed registration is a problem');
  assert(/403 Forbidden/.test(find(await runDiagnostics(base({ state: stReg, bridge: { sipRegistration: { status: 'failed', lastError: '403 Forbidden' }, sipRtpListening: true } })), 'bridge.sip').detail), 'registration error is shown');
  assert.equal(find(await runDiagnostics(base({ state: stReg })), 'bridge.sip').status, 'ok', 'registered is fine');
  assert.equal(find(await runDiagnostics(base({ bridge: { sipRegistration: { status: 'registered' }, rejectedOverCapacityCount: 3, sipRtpListening: true } })), 'bridge.capacity').status, 'warn', 'turned-away calls are flagged');
  const tf = await runDiagnostics(base({ alerts: [alert({}), alert({ id: 'a2', acknowledged: true, kind: 'transfer_failed' })] }));
  assert.equal(find(tf, 'transfers.recent').status, 'fail', 'unread transfer failures are a problem');
  assert.equal(find(await runDiagnostics(base({ alerts: [alert({ acknowledged: true })] })), 'transfers.recent').status, 'ok', 'acknowledged failures stop counting');
  assert.equal(find(await runDiagnostics(base({ alerts: [alert({ kind: 'llm_overload', title: 'LLM overloaded' })] })), 'alerts.critical').status, 'warn', 'other critical alerts are surfaced');

  // Disk.
  const disk = (writable: boolean, freeBytes: number | null) => runDiagnostics(base({ probes: { ...base().probes, disk: async () => ({ writable, freeBytes }) } }));
  assert.equal(find(await disk(false, null), 'server.disk').status, 'fail', 'unwritable data folder is a problem');
  assert.equal(find(await disk(true, 50 * 1024 ** 2), 'server.disk').status, 'fail', 'almost-full disk is a problem');
  assert.equal(find(await disk(true, 300 * 1024 ** 2), 'server.disk').status, 'warn', 'low disk is a warning');
  assert.equal(find(await disk(true, null), 'server.disk').status, 'ok', 'unknown free space is fine when writable');


  // A bridge object that failed to start must not look healthy.
  const dead = await runDiagnostics(base({ bridge: { sipRtpListening: false, audioSocketListening: false, lastError: 'EADDRINUSE 5060' } }));
  assert.equal(find(dead, 'bridge.running').status, 'fail', 'bridge that is not listening is a problem');
  assert(/EADDRINUSE/.test(find(dead, 'bridge.running').detail), 'the start error is shown');
  const stAudio = base().state;
  stAudio.vici.transport = 'audiosocket';
  assert.equal(find(await runDiagnostics(base({ state: stAudio, bridge: { sipRtpListening: false, audioSocketListening: true } })), 'bridge.running').status, 'ok', 'AudioSocket mode looks at the AudioSocket listener');
  assert.equal(find(await runDiagnostics(base({ state: stAudio, bridge: { sipRtpListening: true, audioSocketListening: false } })), 'bridge.running').status, 'fail', 'and not at the SIP one');

  // Deepgram probe: a refused key and an unreachable service are told apart, and the request is cancellable.
  let seenSignal: AbortSignal | undefined;
  const fake = (status: number | Error) => (async (_url: any, init: any) => {
    seenSignal = init?.signal;
    if (status instanceof Error) throw status;
    return { status, ok: status >= 200 && status < 300 } as Response;
  }) as unknown as typeof fetch;
  assert.deepEqual((await probeDeepgramKey('k', fake(200))).ok, true, '200 accepts the key');
  assert(seenSignal instanceof AbortSignal, 'the request carries an abort signal so it is cancelled on timeout');
  const refused = await probeDeepgramKey('k', fake(401));
  assert(!refused.ok && refused.kind === 'auth', '401 means the key was refused');
  assert((await probeDeepgramKey('k', fake(403))).ok, '403 means a scoped key, which is fine');
  const down = await probeDeepgramKey('k', fake(503));
  assert(!down.ok && down.kind === 'unreachable', 'a Deepgram outage is not blamed on the key');
  const slow = await probeDeepgramKey('k', fake(Object.assign(new Error('x'), { name: 'TimeoutError' })));
  assert(!slow.ok && slow.kind === 'unreachable' && /in time/.test(slow.detail), 'a timeout is reported as unreachable');
  const authRun = await runDiagnostics(base({ probes: { ...base().probes, deepgram: async () => refused } }));
  const downRun = await runDiagnostics(base({ probes: { ...base().probes, deepgram: async () => down } }));
  assert(/current Deepgram key/.test(find(authRun, 'keys.deepgram_live').suggestion), 'refused key gets key advice');
  assert(/could not be reached/.test(find(downRun, 'keys.deepgram_live').suggestion), 'an outage gets connection advice, not key advice');
  const src = fs.readFileSync(path.join(__dirname, '../src/server.ts'), 'utf8');
  assert(src.includes('probeDeepgramKey(') && !/deepgram: async \(\) => \{\s*const catalog/.test(src), 'the scan no longer uses the retrying voice-catalog fetch');

  // Wiring.
  const server = fs.readFileSync(path.join(__dirname, '../src/server.ts'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  assert(server.includes("'/api/diagnostics'") && server.includes('runDiagnostics('), 'server exposes the scan');
  assert(app.includes('btn-run-scan') && app.includes('/api/diagnostics'), 'Command deck has the scan button');

  // Own voice engine: Deepgram rows are skipped and readiness is judged on the speech service and the model.
  {
    let dgCalled = false;
    const mk = (over: Partial<DiagnosticInputs> = {}) => {
      const b = base({ secrets: { OPENAI_API_KEY: { configured: true } }, ownEngine: true, probes: { ...base().probes, deepgram: async () => { dgCalled = true; return { ok: true, detail: '' }; } }, ...over });
      return b;
    };
    const notReady = await runDiagnostics(mk());
    assert.equal(find(notReady, 'keys.deepgram').status, 'skipped');
    assert(!dgCalled, 'Deepgram is not contacted in own mode');
    assert.equal(find(notReady, 'engine.own').status, 'fail', 'default providers are Deepgram, so own mode is not ready');
    assert(/listening|voice/.test(find(notReady, 'engine.own').detail));
    const ready = mk();
    const st = ready.state as any;
    const stt = st.providers.find((p: any) => p.kind === 'stt' && p.type === 'speech_service');
    const tts = st.providers.find((p: any) => p.kind === 'tts' && p.type === 'speech_service');
    if (stt && tts) {
      st.services.stt = { providerId: stt.id, model: stt.model || 'whisper' };
      st.services.tts = { providerId: tts.id, model: 'af_heart' };
      const llm = st.providers.find((p: any) => p.kind === 'llm' && p.type === 'open_ai');
      if (llm) st.services.llm = { providerId: llm.id, model: 'gpt-4o-mini' };
      assert.equal(find(await runDiagnostics(ready), 'engine.own').status, 'ok', 'ready when speech service + OpenAI key');
      const noLlmKey = await runDiagnostics({ ...ready, secrets: {} });
      assert(/OPENAI_API_KEY/.test(find(noLlmKey, 'engine.own').detail));
      assert.equal(find(await runDiagnostics({ ...ready, secrets: {}, ownLlmUrl: true }), 'engine.own').status, 'ok', 'own LLM server needs no key');
    }
  }

  console.log('diagnostics-verify: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
