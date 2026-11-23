// Call screening (answering machine detection): engine, safety rules,
// idempotent dispositions and the full bridge path with local fixtures only.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { WebSocketServer } from 'ws';
import { getConsoleState, saveConsoleState } from '../src/db';
import { canonicalUuidToBytes, VicidialBridgeService } from '../src/vici-bridge';
import { CallAudioAnalyzer, findBeep } from '../src/screening/audio-analysis';
import { AsrFactory } from '../src/screening/asr';
import { loadScreeningConfig, normalisePhone, parseNativeAmdHeader, parseTestEndpoints } from '../src/screening/config';
import { evaluateScreening } from '../src/screening/decision-engine';
import { applyScreeningDisposition } from '../src/screening/disposition';
import { setScreeningTestHooks } from '../src/screening';
import { renderSound, runScenario, SCENARIOS } from '../src/screening/scenarios';
import { ScreeningSession } from '../src/screening/session';
import { claimDisposition, getScreeningResult, isScreeningEnabled, recordScreeningResult, setScreeningEnabled } from '../src/screening/store';
import { matchTranscriptCue } from '../src/screening/transcript-rules';
import { DEFAULT_THRESHOLDS } from '../src/screening/types';

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(fn: () => boolean, label: string, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (fn()) return; await wait(10); }
  throw new Error(`Timed out waiting for ${label}`);
}
let checks = 0;
const ok = (cond: unknown, msg: string) => { assert.ok(cond, msg); checks++; };
const eq = (a: unknown, b: unknown, msg: string) => { assert.deepEqual(a, b, msg); checks++; };
const pcm = (s: Parameters<typeof renderSound>[0], seed = 3) => Buffer.from(renderSound(s, seed).buffer);

async function unit() {
  // 1. Every scenario reaches its expected decision (human, voicemail, beep, IVR,
  //    prerecorded, silence, noise, uncertain, Deepgram outage, native AMD, test line).
  for (const sc of SCENARIOS) {
    const r = await runScenario(sc);
    ok(r.pass, `${sc.id}: expected ${sc.expect}, got ${r.got} (${r.reason})`);
  }
  // Decisions are deterministic: same audio, same answer, every run.
  for (let i = 0; i < 3; i++) eq((await runScenario(SCENARIOS[0])).got, 'HUMAN_CONFIRMED', 'repeatable human decision');

  // 2. Acoustic front end.
  const a = new CallAudioAnalyzer();
  a.pushPcm(pcm({ kind: 'noise', ms: 3000, db: -35 }));
  eq(a.snapshot().speech.length, 0, 'steady background noise is not speech');
  const b = new CallAudioAnalyzer();
  b.pushPcm(pcm({ kind: 'silence', ms: 300 })); b.pushPcm(pcm({ kind: 'speech', ms: 800, db: -22 })); b.pushPcm(pcm({ kind: 'silence', ms: 600 }));
  const snap = b.snapshot();
  ok(snap.speech.length === 1 && Math.abs(snap.speech[0].startMs - 300) <= 60, `speech found at ~300 ms (${JSON.stringify(snap.speech)})`);
  const c = new CallAudioAnalyzer();
  c.pushPcm(pcm({ kind: 'tone', ms: 500, hz: 1400, db: -18 })); c.pushPcm(pcm({ kind: 'silence', ms: 300 }));
  ok(findBeep(c.snapshot().tones, 200, c.snapshot().analyzedMs)?.freqHz, 'a 1400 Hz beep is found');
  eq(c.snapshot().speech.length, 0, 'a beep is not speech');
  // Odd chunk sizes are framed correctly.
  const d = new CallAudioAnalyzer();
  const chunk = pcm({ kind: 'speech', ms: 1000, db: -22 });
  for (let i = 0; i < chunk.length; i += 37 * 2) d.pushPcm(chunk.subarray(i, i + 37 * 2));
  eq(d.snapshot().analyzedMs, 1000, 'odd chunk sizes keep the audio clock exact');

  // 3. Phrases.
  eq(matchTranscriptCue('Please leave a message after the beep')?.cue, 'VOICEMAIL', 'voicemail phrase');
  eq(matchTranscriptCue('Para español, oprima dos. Press 1 for billing')?.cue, 'IVR', 'IVR phrase');
  eq(matchTranscriptCue('The number you have dialed is not in service')?.cue, 'PRERECORDED_AUDIO', 'network announcement');
  eq(matchTranscriptCue('Hello?'), null, 'a hello has no machine cue');
  eq(matchTranscriptCue('Yeah who is this'), null, 'a short question has no machine cue');

  // 4. Safety: failure inputs can never confirm a person.
  const quietHuman = new CallAudioAnalyzer();
  quietHuman.pushPcm(pcm({ kind: 'silence', ms: 500 })); quietHuman.pushPcm(pcm({ kind: 'speech', ms: 600, db: -22 })); quietHuman.pushPcm(pcm({ kind: 'silence', ms: 1500 }));
  const base = { nowMs: 2600, audio: quietHuman.snapshot(), transcripts: [{ text: 'hello', isFinal: true, atMs: 1300 }], nativeAmd: { status: 'NONE' as const, cause: '', authenticated: false }, testEndpoint: { matched: false }, probe: { enabled: false, available: false, startedAtMs: null, endedAtMs: null }, alwaysProbe: false };
  const human = evaluateScreening({ ...base, asrState: 'ok' }, DEFAULT_THRESHOLDS);
  ok(human.kind === 'decide' && human.decision.outcome === 'HUMAN_CONFIRMED', 'baseline: recognised short hello confirms a person');
  for (const asrState of ['failed', 'connecting'] as const) {
    const step = evaluateScreening({ ...base, asrState }, DEFAULT_THRESHOLDS);
    ok(!(step.kind === 'decide' && step.decision.outcome === 'HUMAN_CONFIRMED'), `ASR ${asrState} never confirms a person`);
    const late = evaluateScreening({ ...base, asrState, nowMs: 9000 }, DEFAULT_THRESHOLDS);
    ok(late.kind === 'decide' && late.decision.outcome === 'UNCERTAIN', `ASR ${asrState} ends UNCERTAIN at the time limit`);
  }
  const interimOnly = evaluateScreening({ ...base, asrState: 'ok', transcripts: [{ text: 'hello', isFinal: false, atMs: 1300 }] }, DEFAULT_THRESHOLDS);
  ok(!(interimOnly.kind === 'decide' && interimOnly.decision.outcome === 'HUMAN_CONFIRMED'), 'an interim (unconfirmed) transcript does not confirm a person');
  // Errors inside the engine are UNCERTAIN.
  const broken = new ScreeningSession({
    thresholds: DEFAULT_THRESHOLDS, nativeAmd: base.nativeAmd, testEndpoint: { matched: false },
    asrFactory: () => { throw new Error('boom'); },
    probe: { enabled: false, always: false, loadAudio: async () => null }, playAudio: () => {},
  });
  broken.start();
  eq((await broken.result).outcome, 'UNCERTAIN', 'a recogniser that throws gives UNCERTAIN');
  // A stream that stops sending audio cannot hang screening.
  const stalled = new ScreeningSession({
    thresholds: { ...DEFAULT_THRESHOLDS, maxScreeningMs: 3000 }, nativeAmd: base.nativeAmd, testEndpoint: { matched: false },
    asrFactory: (cb) => { setImmediate(() => cb.onReady()); return { send() {}, close() {} }; },
    probe: { enabled: false, always: false, loadAudio: async () => null }, playAudio: () => {}, tickMs: 50,
  });
  stalled.start();
  const sd = await stalled.result;
  ok(sd.outcome === 'UNCERTAIN' && /stopped arriving/.test(sd.reason), 'no caller audio ends as UNCERTAIN by the wall-clock backstop');
  // SIP disconnect mid-screening.
  const cut = new ScreeningSession({
    thresholds: DEFAULT_THRESHOLDS, nativeAmd: base.nativeAmd, testEndpoint: { matched: false },
    asrFactory: (cb) => { setImmediate(() => cb.onReady()); return { send() {}, close() {} }; },
    probe: { enabled: false, always: false, loadAudio: async () => null }, playAudio: () => {},
  });
  cut.start(); cut.pushAudio(pcm({ kind: 'speech', ms: 400, db: -22 })); cut.cancel('caller hung up');
  const cd = await cut.result;
  ok(cd.outcome === 'UNCERTAIN' && cd.reason === 'caller hung up', 'cancel on disconnect resolves UNCERTAIN');
  cut.cancel('second cancel'); cut.pushAudio(pcm({ kind: 'speech', ms: 400, db: -22 }));
  eq((await cut.result).reason, 'caller hung up', 'duplicate cancel/audio after the decision changes nothing');

  // 5. Native AMD header authentication and call-ID binding.
  const secret = 'unit-secret';
  const sig = crypto.createHash('sha1').update(`${secret}MACHINE` + 'V1027153012000104892').digest('hex');
  eq(parseNativeAmdHeader('MACHINE/LONGGREETING', sig, 'V1027153012000104892', secret), { status: 'MACHINE', cause: 'LONGGREETING', authenticated: true }, 'signed header accepted');
  eq(parseNativeAmdHeader('MACHINE/LONGGREETING', sig, 'V1027153012000999999', secret).authenticated, false, 'signature for another call is rejected');
  eq(parseNativeAmdHeader('MACHINE/X', 'deadbeef', 'V1', secret).authenticated, false, 'bad signature rejected');
  eq(parseNativeAmdHeader('HUMAN/HUMAN', '', 'V1', '').authenticated, true, 'without a secret the allow-listed header is accepted');
  eq(parseNativeAmdHeader('DROP TABLE', '', 'V1', '').status, 'NONE', 'unknown status ignored');
  eq(parseNativeAmdHeader('', '', 'V1', secret).status, 'NONE', 'missing header is NONE');

  // 6. Config.
  eq(normalisePhone('+1 (305) 555-0100'), '3055550100', 'US number normalised');
  eq(parseTestEndpoints('3055550100=Carrier line, 12; 13055550111').size, 2, 'test endpoint list parsed, junk ignored');
  const cfg = loadScreeningConfig({ SCREENING_DISPO_VOICEMAIL: 'am', SCREENING_DISPO_UNCERTAIN: 'bad code!', SCREENING_MAX_MS: '999999' } as any);
  eq(cfg.dispositions.VOICEMAIL, 'AM', 'disposition upper-cased');
  eq(cfg.dispositions.UNCERTAIN, 'NA', 'invalid disposition falls back to default');
  eq(cfg.thresholds.maxScreeningMs, 15000, 'thresholds clamped');

  // 7. Store: duplicate events, wrong IDs, one disposition claim.
  const callId = `vici_${Date.now().toString(36)}_a1b2c3d4`;
  const dec = { outcome: 'VOICEMAIL' as const, reason: 'unit', decidedAtMs: 1200, evidence: {} };
  ok(recordScreeningResult({ callId, campaignId: 'camp_1', leadId: '104892', callerCode: 'V1', phone: '3055550192', nativeAmd: 'NONE', decision: dec, disposition: 'AA' }), 'first result saved');
  ok(!recordScreeningResult({ callId, campaignId: 'camp_1', leadId: '104892', callerCode: 'V1', phone: '3055550192', nativeAmd: 'NONE', decision: { ...dec, outcome: 'HUMAN_CONFIRMED' }, disposition: '' }), 'duplicate event ignored');
  eq(getScreeningResult(callId).outcome, 'VOICEMAIL', 'first decision kept');
  eq(getScreeningResult(callId).phone_tail, '0192', 'only the last 4 digits of the phone are stored');
  assert.throws(() => recordScreeningResult({ callId: '../etc', campaignId: 'c', leadId: '', callerCode: '', phone: '', nativeAmd: 'NONE', decision: dec, disposition: 'AA' }), /Invalid call ID/); checks++;
  assert.throws(() => recordScreeningResult({ callId: `vici_${Date.now().toString(36)}_ffffffff`, campaignId: "x'; DROP", leadId: '', callerCode: '', phone: '', nativeAmd: 'NONE', decision: dec, disposition: 'AA' }), /Invalid campaign ID/); checks++;
  assert.throws(() => recordScreeningResult({ callId: `vici_${Date.now().toString(36)}_eeeeeeee`, campaignId: 'c', leadId: '', callerCode: '', phone: '', nativeAmd: 'NONE', decision: dec, disposition: 'A&B' }), /Invalid disposition/); checks++;
  ok(claimDisposition(callId), 'first claim wins');
  ok(!claimDisposition(callId), 'second claim refused');
  ok(!claimDisposition('vici_unknown_00000000'), 'claim on an unknown call ID refused');

  // 8. Disposition: send once, retry, verify, detect mismatch.
  const fakeClient = (o: { accept?: boolean[]; call?: string; lead?: string; throwRead?: boolean }) => {
    const calls: string[] = [];
    let i = 0;
    return {
      calls,
      client: {
        async hangupRemoteAgentCall(x: { status?: string }) { calls.push(`hangup:${x.status}`); const a = o.accept?.[i++] ?? true; return { ok: a, responseText: a ? 'SUCCESS: ra_call_control' : 'ERROR: temporary' }; },
        async lookupCallIdInfo() { calls.push('callid_info'); if (o.throwRead) throw new Error('down'); return o.call === undefined ? { ok: false } : { ok: true, status: o.call }; },
        async fetchLeadInfo() { calls.push('lead_all_info'); if (o.throwRead) throw new Error('down'); return o.lead === undefined ? { sourceApi: 'fallback' } : { status: o.lead, sourceApi: 'lead_all_info' }; },
      },
    };
  };
  const mk = (suffix: string) => {
    const id = `vici_${Date.now().toString(36)}_${suffix}`;
    recordScreeningResult({ callId: id, campaignId: 'camp_1', leadId: '104892', callerCode: 'V1027153012000104892', phone: '', nativeAmd: 'NONE', decision: dec, disposition: 'AA' });
    return id;
  };
  const base2 = { callerCode: 'V1027153012000104892', remoteAgentUser: '9001', leadId: '104892', campaignViciId: 'FETEST', status: 'AA', retryDelayMs: 5, verifyDelayMs: 5 };
  let f = fakeClient({ call: 'AA', lead: 'AA' });
  let id = mk('00000001');
  eq(await applyScreeningDisposition({ ...base2, callId: id, client: f.client }), 'verified', 'status confirmed in call log and lead');
  eq(f.calls.filter((x) => x.startsWith('hangup')).length, 1, 'one HANGUP sent');
  eq(getScreeningResult(id).disposition_state, 'verified', 'verified state saved');
  eq(await applyScreeningDisposition({ ...base2, callId: id, client: f.client }), 'duplicate', 'second apply is a no-op');
  eq(f.calls.filter((x) => x.startsWith('hangup')).length, 1, 'still one HANGUP after a duplicate apply');
  f = fakeClient({ accept: [false, true], call: 'AA', lead: 'AA' });
  id = mk('00000002');
  eq(await applyScreeningDisposition({ ...base2, callId: id, client: f.client }), 'verified', 'a temporary error is retried');
  eq(f.calls.filter((x) => x.startsWith('hangup')).length, 2, 'retried exactly once');
  f = fakeClient({ accept: [false, false, false] });
  id = mk('00000003');
  eq(await applyScreeningDisposition({ ...base2, callId: id, client: f.client }), 'failed', 'repeated errors end as failed');
  eq(getScreeningResult(id).disposition_state, 'failed', 'failure saved for the report');
  f = fakeClient({ call: 'NA', lead: 'NEW' });
  id = mk('00000004');
  eq(await applyScreeningDisposition({ ...base2, callId: id, client: f.client }), 'mismatch', 'wrong status in VICIdial is detected (hang-up is not assumed to mean AA)');
  f = fakeClient({ throwRead: true });
  id = mk('00000005');
  eq(await applyScreeningDisposition({ ...base2, callId: id, client: f.client }), 'unverifiable', 'unreadable VICIdial is reported, not assumed');
  eq(await applyScreeningDisposition({ ...base2, callerCode: '', callId: mk('00000006'), client: f.client }), 'skipped', 'non-VICIdial calls are skipped');

  // 9. On/off switch.
  setScreeningEnabled(true, 'unit'); ok(isScreeningEnabled(), 'switch on');
  setScreeningEnabled(false, 'unit'); ok(!isScreeningEnabled(), 'switch off');
}

async function bridgeIntegration() {
  const state = getConsoleState();
  const stt = state.providers.find((p) => p.kind === 'stt')!;
  const llm = state.providers.find((p) => p.kind === 'llm' && p.type === 'open_ai')!;
  const tts = state.providers.find((p) => p.kind === 'tts' && p.type === 'deepgram')!;
  state.services = { stt: { providerId: stt.id, model: 'nova-3' }, llm: { providerId: llm.id, model: 'gpt-4o-mini' }, tts: { providerId: tts.id, model: 'aura-2-thalia-en' } };
  const campaign = state.campaigns[0];
  const agent = state.agents.find((x) => x.id === campaign.agentId) || state.agents[0];
  campaign.agentId = agent.id;
  campaign.complianceRules = 'Reviewed fixture rules: be truthful and honour do-not-call requests.';
  agent.greeting = 'Hi, this is Jessica. How are you doing today?';
  (agent as any).flow = { ...((agent as any).flow || {}), waitForHello: true, greetingLines: '' };
  agent.injectCampaignDisclosure = false;

  const vici: Array<{ fn: string; stage: string; status: string }> = [];
  let leadStatus = 'NEW';
  const viciApi = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://x');
    const fn = u.searchParams.get('function') || '';
    vici.push({ fn, stage: u.searchParams.get('stage') || '', status: u.searchParams.get('status') || '' });
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    if (fn === 'ra_call_control' && u.searchParams.get('stage') === 'HANGUP') { leadStatus = u.searchParams.get('status') || 'NA'; res.end('SUCCESS: ra_call_control HANGUP'); return; }
    if (fn === 'callid_info') { res.end(`call_id,custtime,call_date,campaign_id,list_id,status,user,phone\nV1027153012000104892,0,2026-11-23,FETEST,999,${leadStatus},9001,3055550192`); return; }
    if (fn === 'lead_all_info') { res.end(`lead_id|phone_number|first_name|last_name|state|status|campaign_id\n104892|3055550192|Robert|Fixture|FL|${leadStatus}|FETEST`); return; }
    res.end('SUCCESS: fixture');
  });
  await new Promise<void>((r) => viciApi.listen(0, '127.0.0.1', r));
  state.vici.viciBaseUrl = `http://127.0.0.1:${(viciApi.address() as net.AddressInfo).port}`;
  saveConsoleState(state, 'Screening bridge fixture');

  let agentConnections = 0;
  let agentAudioBytes = 0;
  const provider = http.createServer();
  const wss = new WebSocketServer({ server: provider, path: '/agent' });
  wss.on('connection', (ws) => {
    agentConnections++;
    ws.on('message', (raw, isBinary) => {
      if (isBinary) { agentAudioBytes += (raw as Buffer).length; return; }
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'Settings') ws.send(JSON.stringify({ type: 'SettingsApplied' }));
    });
  });
  await new Promise<void>((r) => provider.listen(0, '127.0.0.1', r));
  const old = { url: process.env.DEEPGRAM_AGENT_URL, key: process.env.DEEPGRAM_API_KEY, allowed: process.env.BRIDGE_ALLOWED_IPS };
  process.env.DEEPGRAM_AGENT_URL = `ws://127.0.0.1:${(provider.address() as net.AddressInfo).port}/agent`;
  process.env.DEEPGRAM_API_KEY = 'synthetic-key';
  process.env.BRIDGE_ALLOWED_IPS = '127.0.0.1';

  let script: Array<{ atMs: number; text: string }> = [];
  const asr: AsrFactory = (cb) => {
    let sent = 0;
    const done = new Set<number>();
    setImmediate(() => cb.onReady());
    return { send(p) { sent += p.length / 16; script.forEach((s, i) => { if (!done.has(i) && sent >= s.atMs) { done.add(i); cb.onTranscript(s.text, true); } }); }, close() {} };
  };
  setScreeningTestHooks({ asrFactory: asr, probeLoader: async () => null });

  const bridge = new VicidialBridgeService({ host: '127.0.0.1', audioSocketPort: 0, sipPort: 0 });
  await bridge.start();
  const status = bridge.getStatus();

  async function call(sounds: Parameters<typeof renderSound>[0][], opts: { hangupAfterMs?: number } = {}) {
    const reg = bridge.registerPreCall({ vici_cid: 'V1027153012000104892', phone: '3055550192', exten: `${state.vici.aiExten}1` });
    const tcp = net.createConnection({ host: '127.0.0.1', port: status.audioSocketPort });
    let ended = false;
    tcp.on('data', (d) => { if (d.includes(Buffer.from([0x00, 0x00, 0x00]))) ended = true; });
    tcp.on('close', () => { ended = true; });
    tcp.on('error', () => {});
    await new Promise<void>((r) => tcp.on('connect', () => r()));
    tcp.write(Buffer.concat([Buffer.from([0x01, 0x00, 0x10]), canonicalUuidToBytes(reg.uuid)]));
    const audio = Buffer.concat(sounds.map((s, i) => pcm(s, 21 + i)));
    for (let off = 0, t = 0; off < audio.length && !ended && !tcp.destroyed; off += 320, t += 20) {
      if (opts.hangupAfterMs !== undefined && t >= opts.hangupAfterMs) { tcp.end(Buffer.from([0x00, 0x00, 0x00])); break; }
      const frame = audio.subarray(off, off + 320);
      const head = Buffer.from([0x10, 0, 0]); head.writeUInt16BE(frame.length, 1);
      tcp.write(Buffer.concat([head, frame]));
      if (t % 100 === 0) await wait(2);
    }
    return { tcp, isEnded: () => ended };
  }

  try {
    // OFF: unchanged behaviour, the bot session opens at once.
    setScreeningEnabled(false, 'test');
    let before = agentConnections;
    let c = await call([{ kind: 'silence', ms: 400 }]);
    await until(() => agentConnections > before, 'bot session with screening off');
    c.tcp.destroy();
    ok(true, 'screening off: bot session opens straight away'); await wait(300);

    // ON + voicemail: bot never starts, AA sent once and confirmed.
    setScreeningEnabled(true, 'test');
    script = [{ atMs: 1500, text: "Hi, you've reached Mike, please leave a message after the tone" }];
    before = agentConnections;
    const viciBefore = vici.length;
    c = await call([{ kind: 'silence', ms: 300 }, { kind: 'speech', ms: 3000, db: -21 }, { kind: 'silence', ms: 2000 }]);
    await until(() => vici.slice(viciBefore).some((v) => v.fn === 'callid_info'), 'voicemail disposition + read-back', 12000);
    await wait(200);
    eq(agentConnections, before, 'voicemail: the bot session is never opened');
    const hangups = vici.slice(viciBefore).filter((v) => v.fn === 'ra_call_control' && v.stage === 'HANGUP');
    eq(hangups.map((h) => h.status), ['AA'], 'voicemail: exactly one HANGUP with status AA');
    ok(vici.slice(viciBefore).some((v) => v.fn === 'callid_info'), 'voicemail: call log read back');
    const { recentScreeningResults } = await import('../src/screening/store');
    await until(() => recentScreeningResults(1)[0]?.disposition_state === 'verified', 'verified disposition saved', 5000);
    eq(recentScreeningResults(1)[0].outcome, 'VOICEMAIL', 'voicemail result saved');
    c.tcp.destroy(); await wait(300);

    // ON + person: bot starts after confirmation; screening audio is not sent to the bot.
    script = [{ atMs: 1250, text: 'Hello?' }];
    before = agentConnections;
    agentAudioBytes = 0;
    const viciBefore2 = vici.length;
    c = await call([{ kind: 'silence', ms: 500 }, { kind: 'speech', ms: 700, db: -22 }, { kind: 'silence', ms: 2500 }]);
    await until(() => agentConnections > before, 'bot session after a person is confirmed', 10000);
    ok(agentAudioBytes < 16 * 1200, `person: the bot did not receive the screening audio (${agentAudioBytes} bytes)`);
    ok(!vici.slice(viciBefore2).some((v) => v.fn === 'ra_call_control' && v.status === 'AA'), 'person: no machine status sent');
    c.tcp.destroy(); await wait(400);

    // ON + caller hangs up during screening: no AA, bot never starts.
    script = [];
    before = agentConnections;
    const viciBefore3 = vici.length;
    c = await call([{ kind: 'silence', ms: 3000 }], { hangupAfterMs: 600 });
    await wait(1500);
    eq(agentConnections, before, 'hang-up during screening: bot never starts');
    ok(!vici.slice(viciBefore3).some((v) => v.fn === 'ra_call_control' && v.status === 'AA'), 'hang-up during screening: no machine status');
    c.tcp.destroy();
  } finally {
    setScreeningTestHooks(null);
    setScreeningEnabled(false, 'test');
    await bridge.stop();
    wss.close(); provider.close(); viciApi.close();
    for (const [k, v] of [['DEEPGRAM_AGENT_URL', old.url], ['DEEPGRAM_API_KEY', old.key], ['BRIDGE_ALLOWED_IPS', old.allowed]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

(async () => {
  await unit();
  await bridgeIntegration();
  console.log(`✓ Call screening: ${checks} checks passed`);
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
