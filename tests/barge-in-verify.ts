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
console.log('ALL BARGE-IN CHECKS PASSED');
