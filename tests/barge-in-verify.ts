/**
 * Barge-in sensitivity (%) — mapping, legacy preset migration and the phone gate.
 */
import assert from 'node:assert/strict';
import { BargeInGate, bargeInThresholds, normalizeBargeInPct, presetForPct } from '../src/barge-in';
import { createDefaultState, normalizeState } from '../src/defaults';

// Old presets map exactly onto the previous browser thresholds.
const near = (a: number, b: number) => Math.abs(a - b) < 0.0015;
assert.ok(near(bargeInThresholds(80).rms, 0.022) && bargeInThresholds(80).frames === 2, '80% = old High');
assert.ok(near(bargeInThresholds(50).rms, 0.038) && bargeInThresholds(50).frames === 3, '50% = old Balanced');
assert.ok(near(bargeInThresholds(20).rms, 0.065) && bargeInThresholds(20).frames === 4, '20% = old Low');
assert.ok(bargeInThresholds(100).rms < bargeInThresholds(50).rms && bargeInThresholds(50).rms < bargeInThresholds(0).rms, 'higher % needs less loudness');
assert.ok(bargeInThresholds(0).rms <= 0.065, 'clear speech can always interrupt, even at 0%');
assert.ok(bargeInThresholds(100).minMs < bargeInThresholds(0).minMs, 'higher % needs less duration');
assert.equal(normalizeBargeInPct(undefined, 'high'), 80);
assert.equal(normalizeBargeInPct(undefined, 'low'), 20);
assert.equal(normalizeBargeInPct(150), 100);
assert.equal(normalizeBargeInPct(-5), 0);
assert.equal(presetForPct(85), 'high');
console.log('✓ Percentage mapping: 80/50/20 % reproduce the old High/Balanced/Low presets exactly');

// Saved bots with only the old preset migrate; a saved percentage is kept.
const st: any = createDefaultState();
st.agents[0].behavior.bargeInSensitivity = 'low';
delete st.agents[0].behavior.bargeInSensitivityPct;
st.agents[1].behavior.bargeInSensitivityPct = 35;
const n = normalizeState(st);
assert.equal(n.agents[0].behavior.bargeInSensitivityPct, 20, 'old Low preset becomes 20%');
assert.equal(n.agents[1].behavior.bargeInSensitivityPct, 35, 'saved percentage is kept');
assert.equal(n.agents[1].behavior.bargeInSensitivity, 'balanced', 'legacy preset follows the percentage');
console.log('✓ Saved bots migrate from presets; percentages persist');

// Phone gate with synthetic 8 kHz audio (20 ms frames = 160 samples).
const frame = (amp: number) => {
  const b = Buffer.alloc(320);
  for (let i = 0; i < 160; i += 1) b.writeInt16LE(Math.round(Math.sin(i / 3) * amp * 32767), i * 2);
  return b;
};
const quiet = frame(0.02);   // ~0.014 RMS: line noise / distant TV
const speech = frame(0.12);  // ~0.085 RMS: normal speech
let t = 0;
const run = (pct: number, frames: Buffer[], startIdx = 0) => {
  let flushed = 0;
  const g = new BargeInGate(pct, () => { flushed += 1; }, () => t);
  frames.forEach((f, i) => {
    if (i === startIdx) g.onUserStartedSpeaking();
    g.onCallerAudio(f); t += 20;
  });
  return flushed;
};
// A short noise blip (cough) while the bot talks.
const cough = [speech, quiet, quiet, quiet, quiet, quiet];
assert.equal(run(20, cough), 0, '20%: a 20 ms blip does not interrupt the bot');
assert.equal(run(100, cough), 1, '100%: any detected sound interrupts');
// Steady quiet background only.
assert.equal(run(50, Array(20).fill(quiet)), 0, '50%: quiet background never interrupts');
assert.equal(run(100, Array(20).fill(quiet)), 1, '100%: interrupts immediately');
// Real sustained speech interrupts at every setting.
for (const pct of [0, 20, 50, 80, 100]) assert.equal(run(pct, Array(15).fill(speech)), 1, `${pct}%: sustained speech interrupts`);
// Speech already under way when Deepgram reports it -> immediate flush.
let flushedNow = false;
const g = new BargeInGate(50, () => { flushedNow = true; }, () => t);
for (let i = 0; i < 8; i += 1) g.onCallerAudio(speech);
assert.equal(g.onUserStartedSpeaking(), true);
assert.ok(flushedNow);
// A pending barge-in expires after 1.5 s without enough speech.
let expired = 0;
const g2 = new BargeInGate(20, () => { expired += 1; }, () => t);
g2.onUserStartedSpeaking();
t += 1600;
for (let i = 0; i < 10; i += 1) g2.onCallerAudio(speech);
assert.equal(expired, 0, 'a stale pending barge-in does not fire later');
console.log('✓ Phone gate: low % ignores coughs/background, high % reacts to any sound, real speech always interrupts');

// Live Bot (server simulator) uses the same gate on 16 kHz browser audio.
{
  const frame16 = (amp: number) => {
    const b = Buffer.alloc(640); // 20 ms at 16 kHz
    for (let i = 0; i < 320; i += 1) b.writeInt16LE(Math.round(Math.sin(i / 6) * amp * 32767), i * 2);
    return b;
  };
  let flushed = 0;
  const g16 = new BargeInGate(20, () => { flushed += 1; }, () => t, 16000);
  g16.onUserStartedSpeaking();
  g16.onCallerAudio(frame16(0.12)); t += 20; // one 20 ms blip
  for (let i = 0; i < 5; i += 1) { g16.onCallerAudio(frame16(0.02)); t += 20; }
  assert.equal(flushed, 0, 'Live Bot 20%: a 20 ms blip is ignored at 16 kHz');
  g16.onUserStartedSpeaking();
  for (let i = 0; i < 10; i += 1) { g16.onCallerAudio(frame16(0.12)); t += 20; }
  assert.equal(flushed, 1, 'Live Bot 20%: sustained speech interrupts at 16 kHz (duration measured correctly)');
  console.log('✓ Live Bot server path: same percentage gate on 16 kHz browser audio');
}
console.log('ALL BARGE-IN UNIT CHECKS PASSED');

// ---- End to end through the real Live Bot WebSocket (/ws/simulator) --------
async function liveBotE2E() {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const http = await import('node:http');
  const { default: WebSocket, WebSocketServer } = await import('ws');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vac-barge-'));
  process.env.VAC_DATA_DIR = dataDir;
  process.env.VAC_ENV_FILE = path.join(dataDir, '.env');
  process.env.ADMIN_PASSWORD = '';
  const { getConsoleState, saveConsoleState } = await import('../src/db');
  const { createServerWithSimulator } = await import('../src/server');

  const state = getConsoleState();
  const prov = (k: string, ty?: string) => state.providers.find((p) => p.kind === k && (!ty || p.type === ty))!;
  state.services = {
    stt: { providerId: prov('stt').id, model: 'nova-3' },
    llm: { providerId: prov('llm', 'open_ai').id, model: 'gpt-4o-mini' },
    tts: { providerId: prov('tts', 'deepgram').id, model: 'aura-2-thalia-en' },
  };
  const agent = state.agents[0];
  const campaign = state.campaigns.find((c) => c.agentId === agent.id)!;
  saveConsoleState(state, 'barge-in e2e fixture');

  const dg = http.createServer();
  const wss = new WebSocketServer({ server: dg });
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'Welcome' }));
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      const m = JSON.parse(raw.toString());
      if (m.type === 'Settings') {
        ws.send(JSON.stringify({ type: 'SettingsApplied' }));
        setTimeout(() => {
          ws.send(JSON.stringify({ type: 'AgentStartedSpeaking' }));
          setTimeout(() => ws.send(JSON.stringify({ type: 'UserStartedSpeaking' })), 600);
        }, 300);
      }
    });
  });
  await new Promise<void>((r) => dg.listen(0, '127.0.0.1', () => r()));
  process.env.DEEPGRAM_API_KEY = 'dg_test_barge';
  process.env.DEEPGRAM_AGENT_URL = `ws://127.0.0.1:${(dg.address() as any).port}/v1/agent/converse`;
  const { server } = createServerWithSimulator();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;

  const session = async (pct: number, amp: number) => {
    const s = getConsoleState();
    s.agents.find((a) => a.id === agent.id)!.behavior.bargeInSensitivityPct = pct;
    saveConsoleState(s, `barge ${pct}`);
    const events: any[] = [];
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/simulator`);
    client.on('message', (d, bin) => { if (!bin) events.push(JSON.parse(d.toString())); });
    await new Promise<void>((r, j) => { client.once('open', () => r()); client.once('error', j); });
    client.send(JSON.stringify({ type: 'start', upstreamMode: 'deepgram', agentId: agent.id, campaignId: campaign.id, bandwidth: 'wideband', lead: {} }));
    const frame = Buffer.alloc(640);
    for (let i = 0; i < 320; i += 1) frame.writeInt16LE(Math.round(Math.sin(i / 6) * amp * 32767), i * 2);
    for (let i = 0; i < 120; i += 1) { client.send(frame, { binary: true }); await new Promise((r) => setTimeout(r, 20)); }
    client.send(JSON.stringify({ type: 'stop' }));
    client.close();
    return events.some((e) => e.type === 'barge_in' && e.source === 'deepgram_server');
  };
  try {
    assert.equal(await session(10, 0.02), false, 'Live Bot 10%: quiet background does not interrupt');
    assert.equal(await session(10, 0.15), true, 'Live Bot 10%: clear speech interrupts');
    assert.equal(await session(100, 0.02), true, 'Live Bot 100%: any sound interrupts');
    console.log('✓ Live Bot end to end (/ws/simulator): server barge-in honours the percentage');
  } finally {
    server.close(); wss.close(); dg.close();
  }
}

liveBotE2E().then(() => { console.log('ALL BARGE-IN E2E CHECKS PASSED'); process.exit(0); }).catch((e) => { console.error(e); process.exit(1); });
