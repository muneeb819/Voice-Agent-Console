/**
 * Background voice filter — mutes people talking behind the customer before
 * the audio reaches speech-to-text, plus the matching persona rules.
 */
import assert from 'node:assert/strict';
import { BackgroundVoiceFilter, normalizeVoiceFilterPct, voiceFilterMarginDb } from '../src/voice-isolation';
import { createDefaultState, normalizeState } from '../src/defaults';
import { composeBehavioralPrompt, backgroundVoiceLines, conversationIntegrityLines } from '../src/persona';

const RATE = 8000;
let phase = 0;
/** Speech-like 20 ms frame: two harmonics with a syllable-rate envelope, at a given dBFS. */
function voiceFrame(db: number, t: number): Buffer {
  const amp = Math.pow(10, db / 20) * Math.SQRT2 * 32767;
  const env = 0.75 + 0.25 * Math.sin(2 * Math.PI * 4 * t);
  const b = Buffer.alloc(320);
  for (let i = 0; i < 160; i += 1) {
    phase += 1;
    const s = 0.8 * Math.sin((2 * Math.PI * 180 * phase) / RATE) + 0.45 * Math.sin((2 * Math.PI * 540 * phase) / RATE);
    b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((amp * env * s) / 0.92))), i * 2);
  }
  return b;
}
function noiseFrame(db: number): Buffer {
  const amp = Math.pow(10, db / 20) * Math.sqrt(3) * 32767;
  const b = Buffer.alloc(320);
  for (let i = 0; i < 160; i += 1) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((Math.random() * 2 - 1) * amp))), i * 2);
  return b;
}
const dbOf = (frames: Buffer[]) => {
  let sum = 0;
  let n = 0;
  for (const f of frames) for (let i = 0; i < f.length / 2; i += 1) { const v = f.readInt16LE(i * 2); sum += v * v; n += 1; }
  return 20 * Math.log10(Math.sqrt(sum / n) / 32768 + 1e-9);
};

type Seg = { kind: 'voice' | 'noise'; db: number; ms: number; tag: string };
function run(pct: number, segs: Seg[]) {
  const f = new BackgroundVoiceFilter(pct, RATE);
  const byTag: Record<string, { in: Buffer[]; out: Buffer[] }> = {};
  let t = 0;
  for (const s of segs) {
    for (let k = 0; k < s.ms / 20; k += 1) {
      const frame = s.kind === 'voice' ? voiceFrame(s.db, t) : noiseFrame(s.db);
      const out = f.process(frame);
      (byTag[s.tag] ||= { in: [], out: [] });
      // Skip the first 200 ms of each segment: gate hold/release transitions.
      if (k >= 10) { byTag[s.tag].in.push(frame); byTag[s.tag].out.push(out); }
      t += 0.02;
    }
  }
  const loss: Record<string, number> = {};
  for (const [tag, v] of Object.entries(byTag)) loss[tag] = dbOf(v.in) - dbOf(v.out);
  return { loss, filter: f };
}

// Mapping
assert.equal(voiceFilterMarginDb(0), 0, '0% = off');
assert.ok(Math.abs(voiceFilterMarginDb(50) - 13) < 0.01, '50% mutes voices ~13 dB quieter');
assert.ok(voiceFilterMarginDb(100) < voiceFilterMarginDb(50), 'higher % = stronger filter');
assert.equal(normalizeVoiceFilterPct(undefined), 0);
assert.equal(normalizeVoiceFilterPct(140), 100);
console.log('✓ Percentage mapping: 0% off, 50% ≈ 13 dB, 100% strongest');

// Typical call: customer near the phone (-14 dBFS), someone behind them (-32 dBFS), line noise (-58 dBFS).
const call: Seg[] = [
  { kind: 'noise', db: -58, ms: 400, tag: 'line' },
  { kind: 'voice', db: -14, ms: 1500, tag: 'customer' },
  { kind: 'noise', db: -58, ms: 300, tag: 'line' },
  { kind: 'voice', db: -32, ms: 1200, tag: 'background' },
  { kind: 'voice', db: -15, ms: 1200, tag: 'customer2' },
  { kind: 'voice', db: -31, ms: 1200, tag: 'background2' },
];
const r50 = run(50, call);
assert.ok(r50.loss.customer < 1 && r50.loss.customer2 < 1, `customer kept (loss ${r50.loss.customer.toFixed(1)}/${r50.loss.customer2.toFixed(1)} dB)`);
assert.ok(r50.loss.background > 20 && r50.loss.background2 > 20, `background muted (loss ${r50.loss.background.toFixed(1)}/${r50.loss.background2.toFixed(1)} dB)`);
console.log(`✓ 50%: customer passes (${r50.loss.customer.toFixed(1)} dB loss), background voice muted by ${r50.loss.background.toFixed(0)} dB`);

// Off = untouched bytes
const off = new BackgroundVoiceFilter(0, RATE);
const sample = voiceFrame(-30, 0);
assert.equal(off.process(sample), sample, '0% returns the input untouched');
const r0 = run(0, call);
assert.ok(Math.abs(r0.loss.background) < 0.01, 'filter off leaves background alone');
console.log('✓ 0%: audio passes untouched');

// Soft-spoken customer on a quiet line: the filter adapts to them, nothing clipped.
const soft = run(50, [
  { kind: 'noise', db: -62, ms: 300, tag: 'line' },
  { kind: 'voice', db: -36, ms: 2000, tag: 'customer' },
  { kind: 'voice', db: -52, ms: 1000, tag: 'background' },
  { kind: 'voice', db: -37, ms: 1500, tag: 'customer2' },
]);
assert.ok(soft.loss.customer < 1 && soft.loss.customer2 < 1, `soft customer kept (${soft.loss.customer2.toFixed(1)} dB)`);
assert.ok(soft.loss.background > 20, 'background under a soft customer still muted');
console.log('✓ Soft-spoken customer: level learned, their speech kept, quieter background still muted');

// A loud door bang does not hijack the level and mute the customer afterwards.
const bang = run(50, [
  { kind: 'voice', db: -18, ms: 1500, tag: 'customer' },
  { kind: 'noise', db: -3, ms: 80, tag: 'bang' },
  { kind: 'voice', db: -18, ms: 1500, tag: 'customer2' },
]);
assert.ok(bang.loss.customer2 < 1, `customer after a bang kept (${bang.loss.customer2.toFixed(1)} dB)`);
console.log('✓ Door bang / short loud noise does not mute the customer afterwards');

// Similar-loudness voices pass (we never mute the customer to guess at a second speaker).
const close = run(50, [
  { kind: 'voice', db: -16, ms: 1500, tag: 'customer' },
  { kind: 'voice', db: -20, ms: 1200, tag: 'nearby' },
]);
assert.ok(close.loss.nearby < 1, 'a voice only 4 dB quieter is not muted at 50%');
console.log('✓ Voices within a few dB of the customer are kept (safe default)');

// Stronger % catches closer background voices.
const strong = run(90, [
  { kind: 'voice', db: -14, ms: 1500, tag: 'customer' },
  { kind: 'voice', db: -24, ms: 1200, tag: 'background' },
]);
assert.ok(strong.loss.customer < 1 && strong.loss.background > 20, '90% mutes a voice 10 dB quieter');
console.log('✓ 90%: mutes a background voice only 10 dB quieter, customer kept');

// Settings: missing value migrates to 0 (off); saved value persists.
const st: any = createDefaultState();
delete st.agents[0].behavior.backgroundVoiceFilterPct;
st.agents[1].behavior.backgroundVoiceFilterPct = 55;
const n = normalizeState(st);
assert.equal(n.agents[0].behavior.backgroundVoiceFilterPct, 0);
assert.equal(n.agents[1].behavior.backgroundVoiceFilterPct, 55);
console.log('✓ Saved bots: missing value = off, saved % persists');

// Prompt rules: every bot gets the background-voice block, before the integrity rules (which stay last).
const prompt = composeBehavioralPrompt(n.agents[0], n.campaigns[0]);
const bv = backgroundVoiceLines().find((l: string) => l.startsWith('==='))!;
assert.ok(prompt.includes(bv), 'background voice rules in the prompt');
const lastIntegrity = conversationIntegrityLines().filter(Boolean).pop()!;
assert.ok(prompt.indexOf(bv) < prompt.indexOf(lastIntegrity), 'integrity rules stay last');
assert.ok(prompt.trimEnd().endsWith(lastIntegrity.trim()), 'prompt still ends with the integrity rules');
console.log('✓ Persona: "BACKGROUND VOICES" rules in every bot prompt; integrity rules stay last');

console.log('\nBackground voice filter verification passed.');
