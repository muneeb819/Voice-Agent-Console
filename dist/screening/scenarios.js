"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SCENARIOS = void 0;
exports.renderSound = renderSound;
exports.runScenario = runScenario;
const session_1 = require("./session");
const types_1 = require("./types");
const RATE = 8000;
function seeded(seed) {
    let s = seed % 2147483647;
    if (s <= 0)
        s += 2147483646;
    return () => (s = (s * 16807) % 2147483647) / 2147483647;
}
const dbToAmp = (db) => 32768 * Math.pow(10, db / 20);
/** Renders one sound into 16-bit PCM. `offsetSamples` keeps phases continuous. */
function renderSound(sound, seed = 7) {
    const n = Math.round((sound.ms * RATE) / 1000);
    const out = new Int16Array(n);
    const rnd = seeded(seed);
    if (sound.kind === 'silence') {
        for (let i = 0; i < n; i++)
            out[i] = Math.round((rnd() - 0.5) * 6); // line hiss
    }
    else if (sound.kind === 'noise') {
        const a = dbToAmp(sound.db) * 1.7;
        for (let i = 0; i < n; i++)
            out[i] = Math.round((rnd() - 0.5) * 2 * a);
    }
    else if (sound.kind === 'tone') {
        const a = dbToAmp(sound.db) * Math.SQRT2;
        for (let i = 0; i < n; i++)
            out[i] = Math.round(a * Math.sin((2 * Math.PI * sound.hz * i) / RATE));
    }
    else {
        // Voiced speech: harmonics of a gliding pitch, shaped by two formants,
        // with syllable-rate loudness changes. Not a tone, not noise.
        const a = dbToAmp(sound.db) * 0.9;
        let phase = 0;
        for (let i = 0; i < n; i++) {
            const t = i / RATE;
            const f0 = 140 + 35 * Math.sin(2 * Math.PI * 1.3 * t + seed);
            phase += (2 * Math.PI * f0) / RATE;
            const f1 = 600 + 250 * Math.sin(2 * Math.PI * 2.1 * t + seed * 0.3);
            const f2 = 1500 + 400 * Math.sin(2 * Math.PI * 1.7 * t + seed * 0.7);
            let v = 0;
            for (let h = 1; h <= 20; h++) {
                const hz = h * f0;
                if (hz > 3400)
                    break;
                const g = Math.exp(-((hz - f1) ** 2) / (2 * 160 ** 2)) + 0.6 * Math.exp(-((hz - f2) ** 2) / (2 * 220 ** 2)) + 0.05;
                v += g * Math.sin(h * phase);
            }
            const syllable = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t) ** 2;
            out[i] = Math.max(-32767, Math.min(32767, Math.round(a * syllable * v * 0.35)));
        }
    }
    return out;
}
const NONE = { status: 'NONE', cause: '', authenticated: false };
exports.SCENARIOS = [
    { id: 'human_greeting', label: 'Human greeting ("Hello?") then waits', expect: 'HUMAN_CONFIRMED',
        sounds: [{ kind: 'silence', ms: 600 }, { kind: 'speech', ms: 700, db: -22 }, { kind: 'silence', ms: 4000 }],
        transcripts: [{ atMs: 1450, text: 'Hello?', final: true }] },
    { id: 'human_two_words', label: 'Human greeting ("Yeah, hello") on a noisy line', expect: 'HUMAN_CONFIRMED',
        sounds: [{ kind: 'noise', ms: 800, db: -52 }, { kind: 'speech', ms: 900, db: -20 }, { kind: 'noise', ms: 4000, db: -52 }],
        transcripts: [{ atMs: 1800, text: 'Yeah, hello', final: true }] },
    { id: 'voicemail_greeting', label: 'Voicemail greeting', expect: 'VOICEMAIL',
        sounds: [{ kind: 'silence', ms: 400 }, { kind: 'speech', ms: 5200, db: -21 }, { kind: 'silence', ms: 1000 }],
        transcripts: [{ atMs: 1600, text: "Hi, you've reached Mike", final: false }, { atMs: 3200, text: "Hi, you've reached Mike. I can't take your call right now, please leave a message after the tone", final: true }] },
    { id: 'voicemail_long_no_words', label: 'Long recorded greeting (no words recognised)', expect: 'VOICEMAIL',
        sounds: [{ kind: 'silence', ms: 300 }, { kind: 'speech', ms: 4500, db: -22 }, { kind: 'silence', ms: 1500 }] },
    { id: 'voicemail_beep', label: 'Voicemail beep', expect: 'VOICEMAIL',
        sounds: [{ kind: 'silence', ms: 500 }, { kind: 'tone', ms: 600, hz: 1000, db: -18 }, { kind: 'silence', ms: 2000 }] },
    { id: 'ivr_menu', label: 'IVR / phone menu', expect: 'IVR',
        sounds: [{ kind: 'speech', ms: 2600, db: -22 }, { kind: 'silence', ms: 2500 }],
        transcripts: [{ atMs: 2000, text: 'Thank you for calling. For sales, press 1.', final: true }] },
    { id: 'call_screening_assistant', label: 'Phone call-screening assistant', expect: 'IVR',
        sounds: [{ kind: 'speech', ms: 2400, db: -22 }, { kind: 'silence', ms: 2500 }],
        transcripts: [{ atMs: 2300, text: "Hi, the person you're calling is using a screening service. Go ahead and say your name and why you're calling.", final: true }] },
    { id: 'sit_announcement', label: 'Prerecorded network announcement (SIT tones)', expect: 'PRERECORDED_AUDIO',
        sounds: [{ kind: 'tone', ms: 280, hz: 914, db: -16 }, { kind: 'tone', ms: 280, hz: 1371, db: -16 }, { kind: 'tone', ms: 380, hz: 1777, db: -16 }, { kind: 'speech', ms: 2500, db: -22 }] },
    { id: 'prerecorded_message', label: 'Prerecorded message (words)', expect: 'PRERECORDED_AUDIO',
        sounds: [{ kind: 'speech', ms: 2600, db: -22 }, { kind: 'silence', ms: 2000 }],
        transcripts: [{ atMs: 2400, text: 'The number you have dialed is not in service.', final: true }] },
    { id: 'silence', label: 'Silence (nobody answers the probe)', expect: 'UNCERTAIN',
        sounds: [{ kind: 'silence', ms: 9000 }] },
    { id: 'background_noise', label: 'Background noise only', expect: 'UNCERTAIN',
        sounds: [{ kind: 'noise', ms: 9000, db: -38 }] },
    { id: 'uncertain_unrecognised', label: 'Sound but no recognisable words', expect: 'UNCERTAIN',
        sounds: [{ kind: 'silence', ms: 500 }, { kind: 'speech', ms: 1200, db: -24 }, { kind: 'silence', ms: 7500 }], asr: 'silent' },
    { id: 'human_after_probe', label: 'Silent at first, answers the probe', expect: 'HUMAN_CONFIRMED',
        sounds: [{ kind: 'silence', ms: 9000 }],
        afterProbe: { delayMs: 500, sounds: [{ kind: 'speech', ms: 800, db: -21 }], transcripts: [{ atMs: 1200, text: 'Yes, who is this?', final: true }] } },
    { id: 'deepgram_outage', label: 'Speech recognition outage (person cannot be confirmed)', expect: 'UNCERTAIN',
        sounds: [{ kind: 'silence', ms: 600 }, { kind: 'speech', ms: 700, db: -22 }, { kind: 'silence', ms: 8000 }], asr: 'fail' },
    { id: 'native_machine', label: 'Native AMD reported MACHINE (signed)', expect: 'VOICEMAIL',
        sounds: [{ kind: 'speech', ms: 1000, db: -22 }], nativeAmd: { status: 'MACHINE', cause: 'LONGGREETING', authenticated: true } },
    { id: 'native_machine_forged', label: 'Unsigned MACHINE header is ignored; person still confirmed', expect: 'HUMAN_CONFIRMED',
        sounds: [{ kind: 'silence', ms: 600 }, { kind: 'speech', ms: 700, db: -22 }, { kind: 'silence', ms: 4000 }],
        transcripts: [{ atMs: 1450, text: 'Hello', final: true }], nativeAmd: { status: 'MACHINE', cause: 'FORGED', authenticated: false } },
    { id: 'native_notsure', label: 'Native AMD NOTSURE goes to AI screening', expect: 'HUMAN_CONFIRMED',
        sounds: [{ kind: 'silence', ms: 600 }, { kind: 'speech', ms: 700, db: -22 }, { kind: 'silence', ms: 4000 }],
        transcripts: [{ atMs: 1450, text: 'Hello?', final: true }], nativeAmd: { status: 'NOTSURE', cause: 'TOOLONG', authenticated: true } },
    { id: 'test_endpoint', label: 'Authorised test number', expect: 'KNOWN_TEST_ENDPOINT', sounds: [{ kind: 'silence', ms: 500 }], testEndpoint: true },
];
/** Speech recognition stand-in that releases scripted results as caller audio passes their time. */
function scriptedAsr(sc, probeAt) {
    return (cb) => {
        let sentMs = 0;
        const emitted = new Set();
        if (sc.asr === 'fail') {
            setImmediate(() => cb.onError('simulated outage'));
            return { send() { }, close() { } };
        }
        setImmediate(() => cb.onReady());
        return {
            send(pcm) {
                sentMs += pcm.length / 16;
                if (sc.asr === 'silent')
                    return;
                const list = (sc.transcripts || []).map((t, i) => ({ at: t.atMs, t, key: i }));
                const p = probeAt();
                if (p !== null && sc.afterProbe)
                    sc.afterProbe.transcripts.forEach((t, i) => list.push({ at: p + sc.afterProbe.delayMs + t.atMs, t, key: 1000 + i }));
                for (const item of list) {
                    if (!emitted.has(item.key) && sentMs >= item.at) {
                        emitted.add(item.key);
                        cb.onTranscript(item.t.text, item.t.final !== false);
                    }
                }
            },
            close() { },
        };
    };
}
async function runScenario(sc, thresholds = types_1.DEFAULT_THRESHOLDS) {
    let probeAtMs = null;
    let fedMs = 0;
    const probePcm = Buffer.from(renderSound({ kind: 'speech', ms: 450, db: -20 }, 99).buffer);
    const session = new session_1.ScreeningSession({
        thresholds,
        nativeAmd: sc.nativeAmd || NONE,
        testEndpoint: { matched: Boolean(sc.testEndpoint), label: sc.testEndpoint ? 'Scenario test line' : undefined },
        asrFactory: scriptedAsr(sc, () => probeAtMs),
        probe: { enabled: true, always: false, loadAudio: async () => probePcm },
        playAudio: () => { probeAtMs = fedMs; },
        tickMs: 1000000, // driven by audio progress only, so results never depend on machine speed
    });
    session.start();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const timeline = sc.sounds.map((s, i) => renderSound(s, 11 + i));
    let main = Int16Array.from(timeline.flatMap((a) => Array.from(a)));
    const total = sc.feedMs ?? Math.max(main.length / 8, thresholds.maxScreeningMs + 1500);
    let probeAudio = null;
    let probeOffset = 0;
    let decided = null;
    void session.result.then((d) => { decided = d; });
    for (let t = 0; t < total && !decided; t += 20) {
        const frame = new Int16Array(160);
        const startSample = (t * RATE) / 1000;
        for (let i = 0; i < 160; i++)
            frame[i] = main[startSample + i] ?? 0;
        if (probeAtMs !== null && sc.afterProbe && !probeAudio) {
            probeAudio = Int16Array.from(sc.afterProbe.sounds.flatMap((s, i) => Array.from(renderSound(s, 51 + i))));
            probeOffset = Math.round(((probeAtMs + sc.afterProbe.delayMs) * RATE) / 1000);
        }
        if (probeAudio) {
            for (let i = 0; i < 160; i++) {
                const k = startSample + i - probeOffset;
                if (k >= 0 && k < probeAudio.length)
                    frame[i] = probeAudio[k];
            }
        }
        session.pushAudio(Buffer.from(frame.buffer));
        fedMs = t + 20;
        if (t % 200 === 0)
            await new Promise((r) => setImmediate(r));
    }
    if (!decided)
        session.cancel('Scenario audio ended');
    const d = await session.result;
    void main;
    main = new Int16Array(0);
    return { id: sc.id, label: sc.label, expect: sc.expect, got: d.outcome, pass: d.outcome === sc.expect, reason: d.reason, decidedAtMs: d.decidedAtMs };
}
