import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { createDefaultState, normalizeState } from '../src/defaults';
import { runDiagnostics, type DiagnosticInputs, type DiagnosticReport } from '../src/diagnostics';
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
    bridge: { sipRegistration: { status: 'registered' }, rejectedOverCapacityCount: 0 },
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
  assert.equal(find(await runDiagnostics(base({ state: stReg, bridge: { sipRegistration: { status: 'failed', lastError: '403 Forbidden' } } })), 'bridge.sip').status, 'fail', 'failed registration is a problem');
  assert(/403 Forbidden/.test(find(await runDiagnostics(base({ state: stReg, bridge: { sipRegistration: { status: 'failed', lastError: '403 Forbidden' } } })), 'bridge.sip').detail), 'registration error is shown');
  assert.equal(find(await runDiagnostics(base({ state: stReg })), 'bridge.sip').status, 'ok', 'registered is fine');
  assert.equal(find(await runDiagnostics(base({ bridge: { sipRegistration: { status: 'registered' }, rejectedOverCapacityCount: 3 } })), 'bridge.capacity').status, 'warn', 'turned-away calls are flagged');
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

  // Wiring.
  const server = fs.readFileSync(path.join(__dirname, '../src/server.ts'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  assert(server.includes("'/api/diagnostics'") && server.includes('runDiagnostics('), 'server exposes the scan');
  assert(app.includes('btn-run-scan') && app.includes('/api/diagnostics'), 'Command deck has the scan button');

  console.log('diagnostics-verify: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
