import type { DeepgramVoice } from './types';

/** Voice ids a bot may carry: Deepgram Flux/Aura, a cloned voice, or a local speech-service voice. */
const VOICE_ID = /^(?:(?:flux|aura)-[a-z0-9-]+|clone:[0-9a-f]{32}|[a-z]{2}_[a-z0-9]+)$/i;

export function isValidVoiceId(value: unknown): value is string {
  return typeof value === 'string' && VOICE_ID.test(value.trim());
}

/** Whether a voice id can be spoken by the given TTS provider type. */
export function voiceFitsProvider(voiceId: string, providerType: string): boolean {
  if (providerType === 'deepgram') return /^(flux|aura)-/i.test(voiceId);
  if (providerType === 'speech_service') return /^(clone:[0-9a-f]{32}|[a-z]{2}_[a-z0-9]+)$/i.test(voiceId);
  return false;
}

export interface VoicePick {
  voice: DeepgramVoice | null;
  /** True when every suitable voice was already used and one had to be reused. */
  reused: boolean;
}

/**
 * Choose a female English voice for a new bot that no other bot is using yet.
 * Natural-sounding Flux voices come first, then featured ones, so the result is stable and not random.
 * When all are taken, the least-used voice is reused.
 */
export function pickDistinctFemaleVoice(voices: DeepgramVoice[], taken: string[]): VoicePick {
  const candidates = voices
    .filter((v) => v.gender === 'feminine' && (v.primaryLanguage === 'en' || v.languages.some((l) => /^en/i.test(l))))
    .sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
  if (!candidates.length) return { voice: null, reused: false };

  const uses = new Map<string, number>();
  for (const id of taken) if (id) uses.set(id, (uses.get(id) || 0) + 1);

  const unused = candidates.find((v) => !uses.has(v.id));
  if (unused) return { voice: unused, reused: false };

  const leastUsed = [...candidates].sort((a, b) => (uses.get(a.id) || 0) - (uses.get(b.id) || 0))[0];
  return { voice: leastUsed, reused: true };
}

function rank(v: DeepgramVoice): number {
  return (v.family === 'flux-v2' ? 0 : v.family === 'aura-2' ? 10 : 20) + (v.featured ? 0 : 5);
}
