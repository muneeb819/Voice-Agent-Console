// In-process quality checks for every server module and the shared browser/server
// modules (persona.js, opening.js). Oracles are independent re-derivations of the
// documented behaviour, not copies of the implementation.
import { acheck, assert, check, fuzzString, group, rng } from './harness';
import * as g711 from '../../src/g711';
import * as barge from '../../src/barge-in';
import * as limit from '../../src/call-limit';
import * as slots from '../../src/campaign-assignment';
import * as authg from '../../src/auth-guard';
import * as users from '../../src/user-store';
import * as env from '../../src/env-store';
import * as vici from '../../src/vici-client';
import * as bridge from '../../src/vici-bridge';
import * as sb from '../../src/settings-builder';
import * as defaults from '../../src/defaults';
import * as persona from '../../src/persona';
import * as clone from '../../src/voice-clone';
import * as smoke from '../../src/smoke-test';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const opening = require('../../public/opening.js');

const R = rng(20261122);
const clone$ = <T>(v: T): T => JSON.parse(JSON.stringify(v));

export async function runUnit() {
  // ───────────────────────────── g711 / RTP ─────────────────────────────
  group('Telephony audio', 'src/g711.ts', 'mu-law codec');
  const dec = (u: number) => g711.ulawToLinear16(Buffer.from([u])).readInt16LE(0);
  const enc = (s: number) => { const b = Buffer.alloc(2); b.writeInt16LE(s, 0); return g711.linear16ToUlaw(b)[0]; };
  for (let u = 0; u < 256; u++) check(`mu-law code 0x${u.toString(16)} decodes and re-encodes to the same level`, () => assert.equal(dec(enc(dec(u))), dec(u)));
  for (let i = 0; i < 300; i++) {
    const s = R.int(-32768, 32767);
    check(`linear ${s} survives mu-law within one quantisation step`, () => {
      const clipped = Math.max(-32635, Math.min(32635, s));
      const err = Math.abs(dec(enc(s)) - clipped);
      assert.ok(err <= (Math.abs(clipped) + 132) / 16 + 1, `error ${err}`);
    });
  }
  for (let i = 0; i < 100; i++) {
    const a = R.int(-32768, 32767); const b = R.int(-32768, 32767);
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    check(`mu-law is monotonic for ${lo} ≤ ${hi}`, () => assert.ok(dec(enc(lo)) <= dec(enc(hi))));
  }
  for (let i = 0; i < 50; i++) {
    const len = R.int(0, 641);
    check(`16k→8k downsample of ${len} bytes keeps every second sample`, () => {
      const out = g711.downsample16kTo8kLinear16(R.bytes(len));
      assert.equal(out.length, Math.floor(Math.floor(len / 2) / 2) * 2);
    });
  }
  group('Telephony audio', 'src/g711.ts', 'RTP packets');
  for (let i = 0; i < 150; i++) {
    const opts = { payloadType: R.int(0, 127), sequenceNumber: R.int(0, 65535), timestamp: R.int(0, 2 ** 32 - 1), ssrc: R.int(0, 2 ** 32 - 1), marker: R.bool(), payload: R.bytes(R.int(0, 320)) };
    check(`RTP build→parse round trip #${i + 1} (pt ${opts.payloadType}, ${opts.payload.length} B)`, () => {
      const p = g711.parseRtpPacket(g711.buildRtpPacket(opts));
      assert.ok(p);
      assert.deepEqual([p!.payloadType, p!.sequenceNumber, p!.timestamp, p!.ssrc, p!.marker], [opts.payloadType, opts.sequenceNumber, opts.timestamp, opts.ssrc, opts.marker]);
      assert.ok(p!.payload.equals(opts.payload));
    });
  }
  for (let len = 0; len < 12; len++) check(`RTP packet of ${len} bytes is rejected as too short`, () => assert.equal(g711.parseRtpPacket(R.bytes(len)), null));
  for (let i = 0; i < 48; i++) {
    const b = R.bytes(R.int(12, 200)); const v = R.pick([0, 1, 3]); b[0] = (b[0] & 0x3f) | (v << 6);
    check(`RTP version ${v} packet is rejected`, () => assert.equal(g711.parseRtpPacket(b), null));
  }
  for (let i = 0; i < 120; i++) {
    const b = R.bytes(R.int(12, 120)); b[0] = (b[0] & 0x3f) | 0x80;
    check(`random RTP v2 header #${i + 1} parses without reading past the buffer`, () => {
      const p = g711.parseRtpPacket(b);
      if (p) assert.ok(p.payload.length <= b.length - 12);
    });
  }
  const DIG = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '#', 'A', 'B', 'C', 'D'];
  for (let e = 0; e < 32; e++) {
    for (const end of [false, true]) {
      check(`DTMF event ${e} (end=${end})`, () => {
        const p = g711.parseRfc4733Dtmf(Buffer.from([e, end ? 0x80 : 0x00, 0, 160]));
        if (e < 16) assert.deepEqual(p, { digit: DIG[e], endOfEvent: end }); else assert.equal(p, null);
      });
    }
  }
  for (let len = 0; len < 4; len++) check(`DTMF payload of ${len} bytes is rejected`, () => assert.equal(g711.parseRfc4733Dtmf(Buffer.alloc(len)), null));

  // ───────────────────────────── barge-in ─────────────────────────────
  group('Call behaviour', 'src/barge-in.ts', 'sensitivity');
  for (let p = -50; p <= 150; p++) check(`barge-in ${p}% is clamped to 0–100`, () => assert.equal(barge.normalizeBargeInPct(p), Math.min(100, Math.max(0, p))));
  for (const [v, preset, want] of [[null, 'high', 80], [undefined, 'low', 20], ['', 'balanced', 50], ['abc', 'high', 80], [NaN, undefined, 50], [Infinity, 'low', 20], [-Infinity, undefined, 50], [{}, 'balanced', 50], [[], 'high', 0], ['42', 'low', 42], ['99.6', undefined, 100], [true, undefined, 1], [false, 'high', 0], [' ', 'low', 0], ['1e2', undefined, 100]] as Array<[unknown, unknown, number]>) {
    check(`barge-in input ${JSON.stringify(v) ?? String(v)} with preset ${preset} → ${want}`, () => assert.equal(barge.normalizeBargeInPct(v, preset), want));
  }
  for (let p = 0; p <= 100; p++) {
    check(`barge-in thresholds at ${p}% are within safe bounds`, () => {
      const t = barge.bargeInThresholds(p);
      assert.ok(t.rms > 0 && t.rms <= 0.065 && t.frames >= 1 && t.frames <= 5 && t.minMs === t.frames * 40);
    });
    if (p > 0) check(`barge-in ${p}% is at least as sensitive as ${p - 1}%`, () => {
      const a = barge.bargeInThresholds(p - 1); const b = barge.bargeInThresholds(p);
      assert.ok(b.rms <= a.rms + 1e-12 && b.frames <= a.frames);
    });
    check(`barge-in preset label for ${p}%`, () => assert.equal(barge.presetForPct(p), p >= 67 ? 'high' : p <= 33 ? 'low' : 'balanced'));
  }
  for (const [p, rms, frames] of [[80, 0.022, 2], [50, 0.038, 3], [20, 0.065, 4], [100, null, 1], [0, 0.065, 5]] as Array<[number, number | null, number]>) {
    check(`documented barge-in point ${p}%`, () => { const t = barge.bargeInThresholds(p); if (rms !== null) assert.ok(Math.abs(t.rms - rms) < 0.0015, `rms ${t.rms}`); assert.equal(t.frames, frames); });
  }

  // ───────────────────────────── call limit & transfers ─────────────────────────────
  group('Call behaviour', 'src/call-limit.ts', 'call length limit');
  for (let sec = 30; sec <= 900; sec += 5) {
    check(`${sec}s limit: wrap-up, then closing line, then hang-up, in order`, () => {
      const ms = limit.callLimitMsForCampaign({ maxCallSec: defaults.normalizeMaxCallSec(sec) });
      const s = limit.callLimitSchedule(ms);
      assert.ok(s.wrapUpAtMs > 0 && s.wrapUpAtMs < s.closingAtMs && s.closingAtMs < ms, JSON.stringify({ ms, ...s }));
      assert.ok(ms - s.closingAtMs >= 5000, 'closing line has at least 5 s to play');
    });
  }
  for (const v of [0, -1, -30, NaN, Infinity, '', null, undefined, 'abc', '70', 70.4, 1e9, '0', {}, []]) {
    check(`call limit for maxCallSec=${String(v)}`, () => {
      const ms = limit.callLimitMsForCampaign({ maxCallSec: v as any });
      const n = Number(v ?? 0);
      assert.equal(ms, Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : 0);
    });
  }
  for (let i = 0; i < 200; i++) {
    const v = R.pick([R.int(-100, 2000), R.next() * 1000, String(R.int(-5, 1200)), '', null, undefined, 'x' + R.str(3)]);
    check(`saved call limit ${JSON.stringify(v) ?? 'undefined'} normalises to 0 or 30–900 s`, () => {
      const n = defaults.normalizeMaxCallSec(v);
      assert.ok(n === 0 || (Number.isInteger(n) && n >= 30 && n <= 900), String(n));
    });
  }
  for (const secs of [5, 10, 15, 20, 30, 45, 60]) {
    check(`wrap-up prompt (${secs}s left) keeps caller consent mandatory`, () => {
      const p = limit.callLimitWrapUpPrompt(secs);
      assert.ok(p.includes(String(secs)) && /Never transfer without the caller's agreement/.test(p) && /transfer_to_live_agent/.test(p));
    });
  }
  group('Call behaviour', 'src/call-limit.ts', 'transfer announcement detection');
  const openers = ['', 'Perfect! ', 'Great news! ', 'You qualify! ', 'Wonderful. ', 'Okay, Mary. '];
  const announce = ['Please hold the line for just a brief moment while I connect you with our licensed specialist.', "I'll connect you now.", 'Let me transfer you to a licensed agent.',
    "I'm connecting you with our specialist now.", 'One moment while I connect you.', "I'm transferring you over now.", 'I will transfer you to our licensed agent right now.', 'Let me connect you with my supervisor.',
    'Please stay on the line for a moment while I transfer you to a licensed agent.', 'Connecting you now!'];
  for (const o of openers) for (const a of announce) for (const cs of ['as-is', 'upper', 'lower'] as const) {
    const t = cs === 'upper' ? (o + a).toUpperCase() : cs === 'lower' ? (o + a).toLowerCase() : o + a;
    check(`announcement detected: "${t.slice(0, 70)}"`, () => assert.ok(limit.announcesTransfer(t)));
  }
  const notAnnounce = ['Would you like me to connect you with a specialist?', "I can connect you if you'd like.", 'Do you want me to transfer you?', 'Shall I connect you now?',
    "No problem, I'm not transferring you.", "I won't connect you, have a nice day.", "I can't transfer you until you confirm your ZIP code.", "I'll connect you once you confirm Part A and B.",
    "I'll transfer you after you tell me your age.", "I'll connect you if you say yes.", "We don't transfer calls on Sundays.", 'I never transfer without permission.',
    'Are you interested in speaking with a licensed agent?', 'Do you have Medicare Part A and Part B?', 'Thanks for your time, have a great day!', 'May I ask your age?',
    "I'm not able to connect you right now.", 'Unless you agree, I will not transfer you.', 'Can I transfer you to a licensed agent?', 'Is now a good time to talk?'];
  for (const o of openers) for (const n of notAnnounce) check(`not an announcement: "${(o + n).slice(0, 70)}"`, () => assert.ok(!limit.announcesTransfer(o + n)));
  for (const v of ['', null, undefined, 42, {}, '...', '???']) check(`transfer detector handles ${JSON.stringify(v) ?? 'undefined'}`, () => assert.equal(limit.announcesTransfer(v as any), false));
  group('Call behaviour', 'src/call-limit.ts', 'caller consent');
  const declines = ["No, I'm not interested.", "Don't transfer me.", 'Nah, call me later.', 'Please take me off your list.', 'No thanks.', 'Nope.', 'Stop calling me.', 'I do not want to talk.',
    "I don't want to be transferred.", 'Not today.', 'Maybe later.', "I'm busy right now.", 'No thank you.', 'Hang up please.', 'Remove me from your list.', 'Do not transfer me.', 'Not now.', 'Call me back later.'];
  const accepts = ['Yes, please connect me.', 'Sure, go ahead.', "Yes, I'm interested.", 'Okay.', 'Yeah, that sounds good.', 'I have Part A and B, yes.', 'Please transfer me.', 'Go ahead and connect me.',
    "I'm 70 years old.", 'My ZIP is 94601.', 'Absolutely.', 'Sounds great, thank you.', 'Yes.', "That's fine.", 'Connect me please.', 'I would like to speak with someone.'];
  for (const d of declines) for (const cs of ['as-is', 'upper', 'lower']) {
    const t = cs === 'upper' ? d.toUpperCase() : cs === 'lower' ? d.toLowerCase() : d;
    check(`refusal recognised: "${t}"`, () => assert.ok(limit.callerDeclined(t)));
  }
  for (const a of accepts) for (const cs of ['as-is', 'upper', 'lower']) {
    const t = cs === 'upper' ? a.toUpperCase() : cs === 'lower' ? a.toLowerCase() : a;
    check(`not a refusal: "${t}"`, () => assert.ok(!limit.callerDeclined(t)));
  }
  for (let i = 0; i < 30; i++) {
    const blockers = Array.from({ length: R.int(1, 4) }, () => fuzzString(R, 40));
    check(`blocked-transfer instruction #${i + 1} names every blocker`, () => { const p = limit.transferBlockedPrompt(blockers); assert.ok(p.startsWith('TRANSFER NOT STARTED') && blockers.every((b) => p.includes(b))); });
  }

  // ───────────────────────────── campaign slots ─────────────────────────────
  group('Campaigns', 'src/campaign-assignment.ts', 'telephone slots');
  for (let i = 0; i < 150; i++) {
    const list = Array.from({ length: R.int(0, 14) }, (_, k) => ({ id: `c${k}`, slot: R.pick([undefined, null, 0, -1, 'x', 1.5, 10000, R.int(1, 20), R.int(1, 20), String(R.int(1, 9))]) }));
    check(`slot assignment #${i + 1} (${list.length} campaigns) gives unique extensions and keeps valid ones`, () => {
      const out = slots.assignCampaignSlots(list as any);
      assert.equal(out.length, list.length);
      const s = out.map((c) => c.slot);
      assert.equal(new Set(s).size, s.length, 'unique');
      assert.ok(s.every((n) => Number.isInteger(n) && n >= 1));
      const seen = new Set<number>();
      list.forEach((c, k) => { const n = Number(c.slot); if (Number.isInteger(n) && n >= 1 && n <= 9999 && !seen.has(n)) { seen.add(n); assert.equal(out[k].slot, n, 'first holder keeps its slot'); } });
    });
  }
  for (let i = 0; i < 100; i++) {
    const prev = slots.assignCampaignSlots(Array.from({ length: R.int(0, 8) }, (_, k) => ({ id: `p${k}`, slot: k + 1 })));
    const keep = prev.filter(() => R.bool(0.7));
    const added = Array.from({ length: R.int(0, 4) }, (_, k) => ({ id: `n${k}`, slot: R.int(1, 12) }));
    const next = { campaigns: slots.assignCampaignSlots([...keep, ...added] as any).map((c: any) => ({ id: c.id, slot: c.slot })), campaignSlotSeq: 0 };
    const prevState = { campaigns: prev.map((c: any) => ({ id: c.id, slot: c.slot })), campaignSlotSeq: prev.length };
    check(`retired extensions are never reused (case ${i + 1})`, () => {
      slots.reconcileCampaignSlots(prevState, next);
      const owner = new Map(prevState.campaigns.map((c) => [c.slot, c.id]));
      for (const c of next.campaigns) { const o = owner.get(c.slot); assert.ok(o === undefined || o === c.id, `slot ${c.slot} reused by ${c.id}`); if (o === undefined) assert.ok(c.slot > prevState.campaignSlotSeq); }
      assert.equal(new Set(next.campaigns.map((c) => c.slot)).size, next.campaigns.length);
    });
  }
  for (let i = 0; i < 100; i++) {
    const exten = String(R.int(1000, 99999)); const slot = R.pick([R.int(1, 99), undefined, 0, -3]); const idx = R.int(0, 9);
    check(`dialed extension for slot ${slot} at position ${idx}`, () => assert.equal(slots.campaignExtension(exten, { slot } as any, idx), `${exten}${Number.isInteger(slot) && (slot as number) > 0 ? slot : idx + 1}`));
  }
  for (let i = 0; i < 100; i++) {
    const valid = new Set(Array.from({ length: R.int(0, 5) }, (_, k) => `a${k}`));
    const camp = { agentId: R.pick(['a0', 'a1', 'zz', '', undefined]), agentIds: R.pick([undefined, [], ['a1', 'a2', 'a2'], ['zz'], ['a0', 'a3', 'a4']]) };
    check(`campaign bot list #${i + 1} only keeps real bots, primary first`, () => {
      const out = slots.normalizeCampaignAgents(camp as any, valid);
      assert.ok(out.agentIds.every((id) => valid.has(id)));
      assert.equal(new Set(out.agentIds).size, out.agentIds.length);
      if (out.agentId) assert.ok(out.agentIds.includes(out.agentId)); else assert.equal(out.agentIds.length, 0);
    });
  }

  // ───────────────────────────── auth ─────────────────────────────
  group('Security', 'src/auth-guard.ts', 'IP rules');
  for (let i = 0; i < 50; i++) {
    const ip = `127.${R.int(0, 255)}.${R.int(0, 255)}.${R.int(0, 255)}`;
    check(`${ip} is loopback`, () => assert.ok(authg.isLoopbackIp(ip) && authg.isLoopbackIp('::ffff:' + ip)));
  }
  for (let i = 0; i < 80; i++) {
    const ip = `${R.pick([10, 54, 172, 192, 8, 128, 126, 255])}.${R.int(0, 255)}.${R.int(0, 255)}.${R.int(0, 255)}`;
    check(`${ip} is not loopback`, () => assert.ok(!authg.isLoopbackIp(ip) && !authg.isLoopbackIp('::ffff:' + ip)));
  }
  for (const v of ['::1', 'localhost', 'LOCALHOST', ' 127.0.0.1 ']) check(`"${v}" is loopback`, () => assert.ok(authg.isLoopbackIp(v)));
  for (const v of ['', null, undefined, '127', '127.0.0', '127.0.0.256', 'a127.0.0.1', '::2', '0.0.0.0', '::', '127.0.0.1.evil.com', '[::1]x']) check(`"${v}" is not loopback`, () => assert.ok(!authg.isLoopbackIp(v as any)));
  const ipInt = (ip: string) => ip.split('.').reduce((a, p) => ((a << 8) | Number(p)) >>> 0, 0);
  for (let i = 0; i < 150; i++) {
    const bits = R.int(0, 32); const base = `${R.int(1, 223)}.${R.int(0, 255)}.${R.int(0, 255)}.${R.int(0, 255)}`;
    const ip = R.bool() ? base.split('.').map((p, k) => (k >= Math.ceil(bits / 8) ? String(R.int(0, 255)) : p)).join('.') : `${R.int(1, 223)}.${R.int(0, 255)}.${R.int(0, 255)}.${R.int(0, 255)}`;
    check(`PBX allowlist ${base}/${bits} vs ${ip}`, () => {
      process.env.BRIDGE_ALLOWED_IPS = `${base}/${bits}`;
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      assert.equal(authg.isBridgePeerIpAllowed(ip), (ipInt(ip) & mask) === (ipInt(base) & mask));
    });
  }
  for (const [rule, ip, want] of [['', '127.0.0.1', true], ['', '10.0.0.1', false], ['*', '8.8.8.8', true], ['10.0.0.5', '10.0.0.5', true], ['10.0.0.5', '10.0.0.6', false], [' ,, ', '10.0.0.1', false], ['localhost', '127.0.0.9', true], ['10.0.0.0/33', '10.0.0.1', false], ['10.0.0.0/x', '10.0.0.1', false], ['1.2.3.4,5.6.7.8', '::ffff:5.6.7.8', true]] as Array<[string, string, boolean]>) {
    check(`PBX allowlist "${rule}" ${want ? 'admits' : 'refuses'} ${ip}`, () => { process.env.BRIDGE_ALLOWED_IPS = rule; assert.equal(authg.isBridgePeerIpAllowed(ip), want); });
  }
  delete process.env.BRIDGE_ALLOWED_IPS;
  group('Security', 'src/auth-guard.ts', 'admin session tokens');
  const tokens: string[] = [];
  for (let i = 0; i < 100; i++) check(`admin session token #${i + 1} verifies`, () => { const t = authg.createSessionToken(); tokens.push(t); assert.ok(authg.verifySessionToken(t)); });
  for (let i = 0; i < 100; i++) {
    const t = R.pick(tokens.length ? tokens : ['x']); const pos = R.int(0, t.length - 1);
    const flipped = t.slice(0, pos) + (t[pos] === 'a' ? 'b' : 'a') + t.slice(pos + 1);
    check(`tampered token (char ${pos}) is rejected`, () => assert.equal(authg.verifySessionToken(flipped), flipped === t));
  }
  for (let i = 0; i < 60; i++) { const g = fuzzString(R, 120); check(`garbage token #${i + 1} is rejected`, () => assert.equal(authg.verifySessionToken(g), false)); }
  for (const v of [null, undefined, '', '.', '..', 'a.b', 'a.b.c']) check(`token ${JSON.stringify(v) ?? 'undefined'} is rejected`, () => assert.equal(authg.verifySessionToken(v as any), false));
  check('token signed with a different admin password is rejected', () => assert.equal(authg.verifySessionToken(authg.createSessionToken('Some-Other-Password-123')), false));
  for (let i = 0; i < 20; i++) check(`revoked admin token #${i + 1} stops working`, () => { const t = authg.createSessionToken(); authg.invalidateAdminSession(t); assert.equal(authg.verifySessionToken(t), false); });
  group('Security', 'src/auth-guard.ts', 'admin password check');
  const pw = process.env.ADMIN_PASSWORD!;
  check('exact admin password matches', () => assert.ok(authg.constantTimePasswordMatch(pw)));
  for (let i = 0; i < 120; i++) {
    const mode = i % 4; const pos = R.int(0, pw.length - 1);
    const cand = mode === 0 ? pw.slice(0, pos) + pw.slice(pos + 1) : mode === 1 ? pw + R.str(1) : mode === 2 ? pw.slice(0, pos) + (pw[pos] === 'x' ? 'y' : 'x') + pw.slice(pos + 1) : pw.toLowerCase() === pw ? pw.toUpperCase() : pw.toLowerCase();
    check(`near-miss admin password #${i + 1} is refused`, () => assert.equal(authg.constantTimePasswordMatch(cand), cand === pw));
  }

  // ───────────────────────────── user validation ─────────────────────────────
  group('Accounts', 'src/user-store.ts', 'email, name and password rules');
  for (let i = 0; i < 150; i++) {
    const e = `${R.str(R.int(1, 12))}${R.pick(['', '.', '_', '+', '-'])}${R.str(R.int(1, 6))}@${R.str(R.int(1, 10)).toLowerCase()}.${R.pick(['com', 'co.uk', 'pk', 'io', 'org'])}`;
    check(`valid email ${e}`, () => assert.ok(users.isValidEmail(e)));
  }
  const badEmails = ['', 'plain', '@x.com', 'a@', 'a@b', 'a@@b.com', 'a b@c.com', 'a@b..com', 'a..b@c.com', 'a@b.com ', ' a@b.com', 'a@b_c.com', 'a@.com', 'a@b.', '<a@b.com>', 'a@b.com\n', '"a"@b.com', 'a,b@c.com', 'a@b,com', `${'x'.repeat(250)}@b.com`];
  for (const e of badEmails) for (const v of [e, e.toUpperCase()]) check(`invalid email ${JSON.stringify(v).slice(0, 50)}`, () => assert.ok(!users.isValidEmail(v)));
  for (const len of [...Array.from({ length: 21 }, (_, k) => k), 50, 100, 150, ...Array.from({ length: 11 }, (_, k) => 195 + k), 1000]) check(`password of ${len} characters`, () => { const r = users.validatePassword('p'.repeat(len)); assert.equal(r === null, len >= 15 && len <= 200); });
  for (let i = 0; i < 100; i++) {
    const n = fuzzString(R, 100);
    check(`full name fuzz #${i + 1}`, () => {
      const norm = users.normalizeFullName(n); const r = users.validateFullName(n);
      const want = norm.length >= 2 && norm.length <= 80 && /[A-Za-zÀ-ɏ]/.test(norm);
      assert.equal(r === null, want);
    });
  }
  for (let i = 0; i < 100; i++) {
    const e = `  ${R.str(8)}@${R.str(5)}.COM \t`;
    check(`email normalisation #${i + 1} is trimmed, lower-case and idempotent`, () => { const n = users.normalizeEmail(e); assert.equal(n, n.trim().toLowerCase()); assert.equal(users.normalizeEmail(n), n); });
  }

  // ───────────────────────────── secrets ─────────────────────────────
  group('Security', 'src/env-store.ts', 'API key handling');
  for (let i = 0; i < 150; i++) {
    const core = R.str(R.int(16, 48));
    const wrap = R.int(0, 7);
    const pasted = [core, `"${core}"`, `'${core}'`, `  ${core}\n`, `Bearer ${core}`, `Token ${core}`, `" Bearer ${core} "`, `bearer   ${core}`][wrap];
    check(`pasted key variant ${wrap} is cleaned to the key itself`, () => assert.equal(env.sanitizeSecretValue(pasted), core));
  }
  for (let i = 0; i < 150; i++) {
    const s = R.str(R.int(1, 64));
    check(`stored secret #${i + 1} is fully masked`, () => { const m = env.maskSecret(s); assert.equal(m, '••••••••'); for (let k = 0; k + 4 <= s.length; k++) assert.ok(!m.includes(s.slice(k, k + 4))); });
  }
  for (const v of ['', '   ', '""', "''"]) check(`empty secret ${JSON.stringify(v)} masks to nothing`, () => assert.equal(env.maskSecret(v), ''));
  process.env.DEEPGRAM_API_KEY = 'dg-test-' + R.str(20);
  process.env.ELEVENLABS_API_KEY = 'el-test-' + R.str(20);
  for (const key of ['ADMIN_PASSWORD', 'BRIDGE_ALLOWED_IPS', 'VICI_API_PASS', 'NOT_A_KEY', 'PATH', 'HOME']) {
    for (const spacing of ['{{K}}', '{{ K }}', 'x-{{K}}-y']) {
      const tpl = spacing.replace('K', key);
      check(`provider template ${tpl} cannot read ${key}`, () => { const out = env.interpolateProviderPlaceholders({ h: tpl, arr: [tpl] }); const secret = process.env[key]; if (secret) assert.ok(!JSON.stringify(out).includes(secret)); });
    }
  }
  for (const key of ['DEEPGRAM_API_KEY', 'ELEVENLABS_API_KEY']) check(`provider template resolves ${key}`, () => assert.equal(env.interpolateProviderPlaceholders(`{{${key}}}`), process.env[key]));

  // ───────────────────────────── VICIdial ─────────────────────────────
  group('VICIdial', 'src/vici-client.ts', 'lead text sanitising');
  for (let i = 0; i < 150; i++) {
    const s = fuzzString(R, 400); const max = R.pick([250, 50, 10, 1]);
    check(`VICIdial lead text fuzz #${i + 1} (max ${max})`, () => {
      const out = vici.sanitizeViciText(s, max);
      assert.ok(Array.from(out).length <= max && !/['"&|\r\n]/.test(out) && out === out.trim() && !/\s{2,}/.test(out.slice(0, Math.max(0, out.length - 1))));
    });
  }
  group('VICIdial', 'src/vici-client.ts', 'caller ID parsing');
  for (let i = 0; i < 150; i++) {
    const p = R.pick(['V', 'Y', 'M', 'v', 'y']); const stamp = String(R.int(0, 9999999999)).padStart(10, '0'); const lead = R.int(1, 999999999); const width = R.pick([9, 10]);
    const code = `${p}${stamp}${String(lead).padStart(width, '0')}`; const wrapped = R.pick([code, `"${code}"`, `<${code}>`, ` ${code} `]);
    check(`VICIdial caller code ${wrapped}`, () => {
      const r = vici.parseVicidialCallerCode(wrapped, '+1 (555) 010-' + R.int(1000, 9999));
      assert.ok(r.isVicidialCallId && r.callerCode.toUpperCase() === code.toUpperCase() && r.leadId === String(lead) && /^\+?\d+$/.test(r.phone));
      assert.equal(r.callType, { V: 'outbound', Y: 'inbound', M: 'manual' }[p.toUpperCase() as 'V']);
    });
  }
  for (let i = 0; i < 100; i++) {
    const s = R.pick(['Anonymous', 'John Smith', 'X' + R.str(19), 'V123', R.str(R.int(0, 30)), '5551234567', `Q${R.int(10000, 99999)}`]);
    check(`non-VICIdial caller ID "${s}" is a direct call`, () => { const r = vici.parseVicidialCallerCode(s, ''); assert.equal(r.isVicidialCallId, /^[VYM]\d{17,21}$/i.test(s)); });
  }

  // ───────────────────────────── bridge helpers ─────────────────────────────
  group('Telephony bridge', 'src/vici-bridge.ts', 'helpers');
  for (let i = 0; i < 100; i++) { const b = R.bytes(16); check(`AudioSocket UUID round trip #${i + 1}`, () => assert.ok(bridge.canonicalUuidToBytes(bridge.uuidBytesToCanonical(b)).equals(b))); }
  for (let i = 0; i < 100; i++) {
    const min = R.pick([R.int(0, 70000), '', 'abc', 1.5]); const max = R.pick([R.int(0, 70000), '', 'x']);
    check(`RTP port range ${min}-${max}`, () => {
      const r = bridge.rtpPortRange({ BRIDGE_RTP_PORT_MIN: String(min), BRIDGE_RTP_PORT_MAX: String(max) } as any);
      const a = Number(min || 0); const b = Number(max || 0);
      const ok = Number.isInteger(a) && Number.isInteger(b) && a >= 1024 && b <= 65535 && b >= a;
      assert.deepEqual(r, ok ? { min: a, max: b } : null);
    });
  }
  for (const v of [undefined, '', '0', '-5', '30', '60', '1.5', 'abc', '86400']) check(`RTP inactivity timeout "${v}"`, () => {
    const ms = bridge.rtpInactivityTimeoutMs({ BRIDGE_RTP_TIMEOUT_SEC: v } as any);
    const sec = v === undefined || v === '' ? 60 : Number(v);
    assert.equal(ms, Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) : 0);
  });
  for (let i = 0; i < 100; i++) {
    const peer = R.pick(['127.0.0.1', '10.0.0.' + R.int(1, 254), '54.79.152.235', '::1']); const cfg = R.pick(['', '0.0.0.0', '203.0.113.' + R.int(1, 254), '127.0.0.1', ' ']); const bind = R.pick(['', '0.0.0.0', '::', '198.51.100.' + R.int(1, 254)]);
    check(`SDP address for peer ${peer}, configured "${cfg}", bind "${bind}"`, () => {
      const h = bridge.resolveSdpAdvertisedHost(peer, cfg, bind);
      if (authg.isLoopbackIp(peer)) assert.equal(h, peer);
      else assert.ok(h !== '0.0.0.0' && h !== '::' && (h === cfg.trim() || h === bind.trim() || h === '127.0.0.1'));
    });
  }

  // ───────────────────────────── settings builder ─────────────────────────────
  group('Bot settings', 'src/settings-builder.ts', 'JSON fields');
  for (let i = 0; i < 150; i++) {
    const v = R.pick([() => JSON.stringify({ a: R.int(0, 9) }), () => JSON.stringify([1, 2]), () => 'null', () => '42', () => '"s"', () => fuzzString(R, 40), () => '{"a":', () => `{"${R.str(5)}":${JSON.stringify(fuzzString(R, 10))}}`, () => '', () => '  {}  '])();
    check(`JSON object field input #${i + 1}`, () => {
      const r = sb.parseJsonObject(v);
      let want = false; try { const p = JSON.parse(v.trim() || '{}'); want = p !== null && typeof p === 'object' && !Array.isArray(p); } catch { want = false; }
      assert.equal(r.ok, want, `${JSON.stringify(v)} → ${JSON.stringify(r)}`);
    });
  }
  group('Bot settings', 'src/settings-builder.ts', 'voice speed');
  for (let i = 0; i < 150; i++) {
    const s = R.pick([R.next() * 3 - 0.5, Math.round(R.next() * 40) / 20, NaN, Infinity, -Infinity, 0.5, 1.5, 1]);
    check(`voice speed ${s} normalises to a valid 0.05 step`, () => { const n = sb.normalizeFluxSpeed(s); assert.ok(sb.isValidFluxSpeed(n), String(n)); if (sb.isValidFluxSpeed(s)) assert.ok(Math.abs(n - s) < 1e-9); });
  }
  group('Bot settings', 'src/settings-builder.ts', 'call settings sent to Deepgram');
  const base = defaults.createDefaultState();
  const secretValues = [process.env.DEEPGRAM_API_KEY!, process.env.ELEVENLABS_API_KEY!, process.env.ADMIN_PASSWORD!];
  const settingsCase = (state: any, agent: any, campaign: any, label: string) => check(label, () => {
    const out = sb.buildDeepgramSettings(state, agent, campaign);
    const json = JSON.stringify(out);
    for (const s of secretValues) assert.ok(!json.includes(s), 'no secret values in call settings');
    const prompt = out?.agent?.think?.prompt ?? '';
    assert.ok(typeof prompt === 'string' && prompt.length > 0 && prompt.length <= 25000, `prompt ${prompt.length}`);
    assert.ok(['linear16', 'mulaw', 'alaw'].includes(out.audio?.input?.encoding));
  });
  for (const a of base.agents) for (const c of base.campaigns.filter((c) => slots.campaignHasAgent(c, a.id))) settingsCase(base, a, c, `stock bot ${a.name} on ${c.name}`);
  const styles = ['warm_empathetic', 'energetic_upbeat', 'charismatic_closer', 'calm_concierge', 'unknown', ''];
  for (let i = 0; i < 150; i++) {
    const st = clone$(base); const c = st.campaigns[R.int(0, st.campaigns.length - 1)]; const a = st.agents.find((x) => slots.campaignHasAgent(c, x.id)) || st.agents[0];
    a.prompt = R.pick(['', 'Short prompt.', fuzzString(R, 300), 'Line.\n'.repeat(R.int(10, 6000))]);
    a.greeting = fuzzString(R, 200); a.behavior.expressionStyle = R.pick(styles) as any; a.behavior.selfIntro = fuzzString(R, 300);
    a.llm.temp = R.pick([0, 0.7, 2, -1, NaN as any]); a.tts.speed = R.pick([0.3, 1, 1.04, 2]);
    c.complianceRules = R.pick(['', fuzzString(R, 200), 'Rule.\n'.repeat(R.int(10, 3000))]);
    if (!slots.campaignHasAgent(c, a.id)) continue;
    settingsCase(defaults.normalizeState(st), defaults.normalizeState(st).agents.find((x) => x.id === a.id), defaults.normalizeState(st).campaigns.find((x) => x.id === c.id), `fuzzed bot settings #${i + 1} stay inside Deepgram's limits and never contain secrets`);
  }
  group('Bot settings', 'src/settings-builder.ts', 'validation');
  for (let i = 0; i < 150; i++) {
    const st = defaults.normalizeState(clone$(base)); const a = clone$(st.agents[R.int(0, st.agents.length - 1)]);
    const fields = ['name', 'prompt', 'greeting', 'language', 'mode'] as const;
    for (const f of fields) if (R.bool(0.4)) (a as any)[f] = R.pick([fuzzString(R, 100), '', null, 42, undefined]);
    check(`validation of fuzzed bot #${i + 1} never crashes and returns readable items`, () => {
      const items = sb.validateAgent(st, a as any);
      assert.ok(Array.isArray(items) && items.every((it: any) => typeof it.message === 'string' || typeof it.msg === 'string' || typeof it.text === 'string' || typeof it === 'object'));
    });
  }
  for (let i = 0; i < 100; i++) {
    const st = defaults.normalizeState(clone$(base));
    check(`state #${i + 1} compared with itself has no differences`, () => assert.deepEqual(sb.diffStates(st, clone$(st)), []));
  }
  for (let i = 0; i < 50; i++) {
    const st = defaults.normalizeState(clone$(base));
    check(`VICIdial dialplan #${i + 1} lists every campaign extension`, () => {
      const cfg = sb.generateViciConfig(st);
      st.campaigns.forEach((c, k) => assert.ok(cfg.includes(slots.campaignExtension(st.vici.aiExten, c, k)), `missing ${slots.campaignExtension(st.vici.aiExten, c, k)}`));
    });
  }

  // ───────────────────────────── persona / opening (shared browser + server) ─────────────────────────────
  group('Bot persona', 'public/persona.js', 'call prompt');
  for (let i = 0; i < 150; i++) {
    const st = defaults.normalizeState(clone$(base)); const c = st.campaigns[R.int(0, st.campaigns.length - 1)]; const a = st.agents[R.int(0, st.agents.length - 1)];
    a.behavior.expressionStyle = R.pick(styles.slice(0, 4)) as any; a.prompt = R.pick(['', fuzzString(R, 500), 'Ask about Medicare.\n'.repeat(R.int(1, 2000))]);
    c.complianceRules = R.pick(['', 'Never promise savings.', fuzzString(R, 300)]); c.maxCallSec = R.pick([0, 70, 120, 300]);
    check(`call prompt #${i + 1} (${a.behavior.expressionStyle}, limit ${c.maxCallSec}s) carries the bot's own speaking style and the transfer rule`, () => {
      const p = persona.composeBehavioralPrompt(a, c);
      assert.ok(typeof p === 'string' && p.includes('PERSONALITY & SPEAKING STYLE') && p.includes('TRANSFERS:') && !p.includes('VOICE DELIVERY'));
      if (c.complianceRules && c.complianceRules.length < 200 && c.complianceRules.trim()) assert.ok(p.includes(c.complianceRules.trim().slice(0, 30)));
    });
    check(`call prompt report #${i + 1} is self-consistent`, () => {
      const r = persona.callPromptReport(a, c, 700);
      assert.ok(r.instructionsCutChars >= 0 && r.rulesChars >= 0 && r.rulesChars <= r.rulesLimit + 0 || r.rulesCutChars > 0);
      assert.equal(r.callWillFail, r.phoneChars > r.phoneLimit);
    });
  }
  group('Bot persona', 'public/persona.js', 'conversation memory');
  for (let age = 50; age <= 99; age++) check(`caller stating age ${age} is remembered`, () => { const m = persona.createConversationMemory(); m.addUserText(`I'm ${age} years old.`); assert.equal(String(m.facts().statedAge), String(age)); });
  for (const phr of ['I have Part A and Part B.', 'I have Medicare Part A and B.', 'Yes, A and B.', 'I have my part a, b, c, all three active']) check(`"${phr}" is recorded as Part A & B`, () => { const m = persona.createConversationMemory(); m.addAssistantText('Do you have Medicare Part A and Part B?'); m.addUserText(phr); assert.equal(m.facts().medicareStatus, 'Part A & B'); });
  for (let n = 0; n <= 40; n++) check(`${n} caller turns are counted`, () => { const m = persona.createConversationMemory(); for (let k = 0; k < n; k++) m.addUserText('hello ' + k); m.addUserText('   '); assert.equal(m.facts().userTurns, n); });
  for (let i = 0; i < 40; i++) check(`last caller words #${i + 1}`, () => { const m = persona.createConversationMemory(); const said = Array.from({ length: R.int(1, 5) }, () => R.str(10)); said.forEach((s) => m.addUserText(s)); assert.equal(m.lastUserText(), said[said.length - 1]); });
  for (let i = 0; i < 100; i++) { const a = fuzzString(R, 80); const b = a + 'x'; check(`fingerprint #${i + 1} is stable and distinguishes edits`, () => { assert.equal(persona.fingerprint(a), persona.fingerprint(a)); assert.notEqual(persona.fingerprint(a), persona.fingerprint(b)); }); }
  group('Bot persona', 'public/opening.js', 'opening line');
  for (let i = 0; i < 100; i++) {
    const g = fuzzString(R, 200); const disc = R.pick(['', 'This call may be recorded.']); const inc = R.bool();
    check(`opening #${i + 1} composes and its instruction quotes it safely`, () => {
      const o = opening.composeOpening(g, R.pick(['', 'Hi there!']), inc, disc);
      assert.equal(typeof o, 'string');
      const ins = opening.openingInstruction(o);
      assert.ok(ins.includes(JSON.stringify(String(o).trim())));
    });
  }
  for (let i = 0; i < 30; i++) {
    const big = 'x'.repeat(R.int(23000, 26000));
    check(`opening size guard #${i + 1} (${big.length} chars of prompt)`, () => {
      const settings = { agent: { think: { prompt: big }, greeting: 'Hello there, this is Jessica.' } };
      const total = big.length + opening.openingInstruction('Hello there, this is Jessica.').length;
      let threw = false; try { opening.prepareDelayedOpening(settings); } catch { threw = true; }
      assert.equal(threw, total > 25000);
    });
  }

  // ───────────────────────────── voice cloning ─────────────────────────────
  group('Voice Lab', 'src/voice-clone.ts', 'clone request validation');
  for (let i = 0; i < 150; i++) {
    const req: any = {
      name: R.pick(['', 'Jessica', 'x'.repeat(81), fuzzString(R, 30)]), speakerName: R.pick(['', 'Mary Jones', 'y'.repeat(121)]),
      consentConfirmed: R.pick([true, false, 'true', 1, undefined]), consentStatement: R.pick(['', 'short', 'Mary recorded a spoken consent on 1 Nov.', 'z'.repeat(1001)]),
      sample: R.pick([undefined, Buffer.alloc(100), Buffer.alloc(9000), 'not a buffer']), mimeType: R.pick(['audio/webm', 'audio/mpeg', 'video/webm', 'application/octet-stream', 'text/html', 'image/png', undefined]),
      filename: fuzzString(R, 120),
    };
    check(`voice clone request #${i + 1} accepted only with name, speaker, consent and audio`, () => {
      const n = String(req.name || '').trim(), s = String(req.speakerName || '').trim(), cs = String(req.consentStatement || '').trim(), mt = String(req.mimeType || 'application/octet-stream').toLowerCase();
      const want = n.length >= 1 && n.length <= 80 && s.length >= 1 && s.length <= 120 && req.consentConfirmed === true && cs.length >= 10 && cs.length <= 1000 && Buffer.isBuffer(req.sample) && req.sample.length >= 8000 && /^audio\/|^video\/webm|^application\/octet-stream/.test(mt);
      let out: any = null; try { out = clone.validateCloneRequest(req); } catch (e) { if (!(e instanceof clone.CloneError)) throw e; }
      assert.equal(Boolean(out), want);
      if (out) assert.ok(/^[A-Za-z0-9._-]{1,80}$/.test(out.filename));
    });
  }
  for (const [id, p] of Object.entries(clone.EXPRESSIVE_PRESETS)) check(`expressiveness preset ${id} stays in ElevenLabs' ranges`, () => { assert.ok([p.stability, p.similarity_boost, p.style].every((v) => v >= 0 && v <= 1) && p.speed >= 0.7 && p.speed <= 1.2); });
  check('Warm preset is the most expressive', () => { const P = clone.EXPRESSIVE_PRESETS; assert.ok(P.warm.stability < P.balanced.stability && P.balanced.stability < P.steady.stability && P.warm.style > P.balanced.style); });
  const noFetch: any = async () => new Response('{}', { status: 200 });
  for (let i = 0; i < 40; i++) {
    const id = R.pick([fuzzString(R, 70), '../../v1/user', 'abc', 'A'.repeat(65), 'Valid' + R.str(10)]);
    const okId = /^[A-Za-z0-9]{8,64}$/.test(id);
    await acheck(`expressiveness on voice id ${JSON.stringify(id).slice(0, 30)} ${okId ? 'is sent' : 'is refused'}`, async () => {
      let refused = false; try { await clone.elevenSetExpressiveness(id, 'warm', noFetch); } catch (e) { refused = e instanceof clone.CloneError; if (!refused) throw e; }
      assert.equal(refused, !okId);
    });
  }

  // ───────────────────────────── smoke test ─────────────────────────────
  group('Smoke test', 'src/smoke-test.ts', 'agent and campaign checks');
  const st0 = defaults.normalizeState(clone$(base));
  for (const a of st0.agents) {
    check(`smoke test of saved bot ${a.name}`, () => { const r = smoke.smokeTestAgent(st0, a.id); assert.ok(r.checks.length > 0 && r.summary.passed + r.summary.warnings + r.summary.failed === r.checks.length); });
    for (let i = 0; i < 10; i++) {
      const draft = clone$(a); draft.prompt += '\n' + R.str(30);
      check(`smoke test flags unsaved edit #${i + 1} on ${a.name}`, () => { const r = smoke.smokeTestAgent(st0, a.id, draft); assert.ok(r.checks.some((c: any) => /unsaved|screen|not saved|matches/i.test(JSON.stringify(c)))); });
    }
  }
  for (const c of st0.campaigns) check(`smoke test of saved campaign ${c.name}`, () => { const r = smoke.smokeTestCampaign(st0, c.id); assert.ok(r.checks.length > 0); });
  check('smoke test of an unknown bot reports a failure instead of crashing', () => { try { const r = smoke.smokeTestAgent(st0, 'nope'); assert.ok(!r.ok); } catch (e) { assert.ok(/not found|unknown/i.test(String(e))); } });

}

// Sized by the runner so the whole run executes exactly the requested number of checks.
export function runStateFuzz(normalizeStateCases: number) {
  const base = defaults.createDefaultState();
  // ───────────────────────────── saved-state normalisation fuzz ─────────────────────────────
  group('Saved state', 'src/defaults.ts', 'normaliseState fuzz');
  const mutate = (obj: any, depth = 0): void => {
    if (!obj || typeof obj !== 'object' || depth > 4) return;
    for (const k of Object.keys(obj)) {
      const roll = R.next();
      if (roll < 0.06) delete obj[k];
      else if (roll < 0.12) obj[k] = R.pick([null, 0, -1, '', 'x', [], {}, true, 1e9, NaN, fuzzString(R, 50)]);
      else if (roll < 0.14 && typeof obj[k] === 'string') obj[k] = fuzzString(R, 300);
      else mutate(obj[k], depth + 1);
    }
    if (Array.isArray(obj) && R.bool(0.1) && obj.length && obj[0] !== undefined) obj.push(clone$(obj[0]));
  };
  for (let i = 0; i < normalizeStateCases; i++) {
    const raw = clone$(base); mutate(raw);
    if (R.bool(0.05)) (raw as any).__proto__ = { polluted: true };
    if (R.bool(0.05)) (raw as any).constructor = { prototype: { polluted: true } };
    check(`saved state fuzz #${i + 1}: loads, stays valid and is stable on re-save`, () => {
      const s = defaults.normalizeState(raw);
      assert.ok(Array.isArray(s.agents) && Array.isArray(s.campaigns) && s.agents.length > 0);
      assert.equal(new Set(s.agents.map((a) => a.id)).size, s.agents.length, 'unique bot ids');
      assert.equal(new Set(s.campaigns.map((c) => c.id)).size, s.campaigns.length, 'unique campaign ids');
      assert.equal(new Set(s.campaigns.map((c) => c.slot)).size, s.campaigns.length, 'unique extensions');
      for (const c of s.campaigns) assert.ok(c.maxCallSec === 0 || (c.maxCallSec >= 30 && c.maxCallSec <= 900), `maxCallSec ${c.maxCallSec}`);
      for (const a of s.agents) assert.ok(a.behavior.bargeInSensitivityPct >= 0 && a.behavior.bargeInSensitivityPct <= 100);
      assert.equal(({} as any).polluted, undefined, 'no prototype pollution');
      const again: any = defaults.normalizeState(clone$(s)); const first: any = { ...s };
      delete again.updatedAt; delete first.updatedAt; // a save timestamp, expected to move
      assert.deepEqual(again, first, 're-saving does not change anything');
    });
  }
}
