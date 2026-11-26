"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isValidVoiceId = isValidVoiceId;
exports.voiceFitsProvider = voiceFitsProvider;
exports.pickDistinctFemaleVoice = pickDistinctFemaleVoice;
/** Voice ids a bot may carry: Deepgram Flux/Aura, a cloned voice, or a local speech-service voice. */
const VOICE_ID = /^(?:(?:flux|aura)-[a-z0-9-]+|clone:[0-9a-f]{32}|[a-z]{2}_[a-z0-9]+)$/i;
function isValidVoiceId(value) {
    return typeof value === 'string' && VOICE_ID.test(value.trim());
}
/** Whether a voice id can be spoken by the given TTS provider type. */
function voiceFitsProvider(voiceId, providerType) {
    if (providerType === 'deepgram')
        return /^(flux|aura)-/i.test(voiceId);
    if (providerType === 'speech_service')
        return /^(clone:[0-9a-f]{32}|[a-z]{2}_[a-z0-9]+)$/i.test(voiceId);
    return false;
}
/**
 * Choose a female English voice for a new bot that no other bot is using yet.
 * Natural-sounding Flux voices come first, then featured ones, so the result is stable and not random.
 * When all are taken, the least-used voice is reused.
 */
function pickDistinctFemaleVoice(voices, taken) {
    const candidates = voices
        .filter((v) => v.gender === 'feminine' && (v.primaryLanguage === 'en' || v.languages.some((l) => /^en/i.test(l))))
        .sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
    if (!candidates.length)
        return { voice: null, reused: false };
    const uses = new Map();
    for (const id of taken)
        if (id)
            uses.set(id, (uses.get(id) || 0) + 1);
    const unused = candidates.find((v) => !uses.has(v.id));
    if (unused)
        return { voice: unused, reused: false };
    const leastUsed = [...candidates].sort((a, b) => (uses.get(a.id) || 0) - (uses.get(b.id) || 0))[0];
    return { voice: leastUsed, reused: true };
}
function rank(v) {
    return (v.family === 'flux-v2' ? 0 : v.family === 'aura-2' ? 10 : 20) + (v.featured ? 0 : 5);
}
