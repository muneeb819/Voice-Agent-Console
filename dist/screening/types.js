"use strict";
// Call screening (answering machine detection) shared types.
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_THRESHOLDS = exports.SCREENING_OUTCOMES = void 0;
exports.SCREENING_OUTCOMES = [
    'HUMAN_CONFIRMED',
    'VOICEMAIL',
    'IVR',
    'PRERECORDED_AUDIO',
    'KNOWN_TEST_ENDPOINT',
    'UNCERTAIN',
];
exports.DEFAULT_THRESHOLDS = {
    maxScreeningMs: 7000,
    afterGreetingSilenceMs: 800,
    maxHumanGreetingMs: 3000,
    longGreetingMs: 3500,
    maxHumanWords: 8,
    silenceProbeAtMs: 2500,
    probeResponseWindowMs: 3000,
    minBeepMs: 200,
};
