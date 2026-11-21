/**
 * Consented voice cloning for Voice Lab.
 *
 *  - ElevenLabs (cloud): Instant Voice Cloning. Live calls can use the voice:
 *    Deepgram's Voice Agent speaks through ElevenLabs when the TTS provider is
 *    `eleven_labs` with the voice id in the endpoint URL and the key in headers.
 *  - Self-hosted (Chatterbox Turbo in the bundled speech service, NVIDIA GPU):
 *    previews in Voice Lab; not usable as a Deepgram live-call voice.
 *
 * Every clone requires the speaker's name, an explicit permission confirmation
 * and a consent statement. A consent record is kept in SQLite.
 */
import crypto from 'crypto';
import { getSecret } from './env-store';
import { getSpeechServiceBaseUrl, getSpeechServiceHeaders } from './speech-service-client';

// ELEVENLABS_API_BASE exists for tests only; live calls always use the real ElevenLabs endpoint.
export const ELEVEN_API = (process.env.ELEVENLABS_API_BASE || 'https://api.elevenlabs.io').replace(/\/+$/, '');
export const ELEVEN_LIVE_MODELS = ['eleven_flash_v2_5', 'eleven_turbo_v2_5'] as const;
export const MAX_SAMPLE_BYTES = 20 * 1024 * 1024;

export class CloneError extends Error {
  constructor(message: string, public statusCode = 400, public code = 'VOICE_CLONE_FAILED') {
    super(message);
  }
}

export interface CloneRequest {
  name: string;
  speakerName: string;
  consentConfirmed: boolean;
  consentStatement: string;
  description?: string;
  removeBackgroundNoise?: boolean;
  sample: Buffer;
  filename: string;
  mimeType: string;
}

export interface ClonedVoice {
  provider: 'elevenlabs' | 'selfhosted';
  id: string;
  name: string;
  /** The value the console stores as the TTS model/voice for live calls or previews. */
  voice: string;
  liveCalls: boolean;
  createdAt?: string | null;
  durationSec?: number | null;
}

export function validateCloneRequest(req: Partial<CloneRequest>): CloneRequest {
  const name = String(req.name || '').trim();
  const speakerName = String(req.speakerName || '').trim();
  const consentStatement = String(req.consentStatement || '').trim();
  if (!name || name.length > 80) throw new CloneError('Give the voice a name (1–80 characters).');
  if (!speakerName || speakerName.length > 120) throw new CloneError('Enter the name of the person whose voice this is.');
  if (req.consentConfirmed !== true) throw new CloneError('Confirm that the speaker has given permission to clone their voice.', 400, 'CONSENT_REQUIRED');
  if (consentStatement.length < 10 || consentStatement.length > 1000) throw new CloneError('Describe how the speaker gave permission (10–1,000 characters).', 400, 'CONSENT_REQUIRED');
  if (!req.sample || !Buffer.isBuffer(req.sample) || req.sample.length < 8000) throw new CloneError('Upload or record a voice sample (at least a few seconds).');
  if (req.sample.length > MAX_SAMPLE_BYTES) throw new CloneError('The sample is larger than 20 MB. Use a shorter clip (1–2 minutes is enough).');
  const mimeType = String(req.mimeType || 'application/octet-stream').toLowerCase();
  if (!/^audio\/|^video\/webm|^application\/octet-stream/.test(mimeType)) throw new CloneError('The sample must be an audio file (mp3, wav, m4a, ogg or webm).');
  return {
    name,
    speakerName,
    consentConfirmed: true,
    consentStatement,
    description: String(req.description || '').trim().slice(0, 500),
    removeBackgroundNoise: req.removeBackgroundNoise === true,
    sample: req.sample,
    filename: String(req.filename || 'sample').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'sample',
    mimeType,
  };
}

export const sampleSha256 = (buf: Buffer) => crypto.createHash('sha256').update(buf).digest('hex');

// ─────────────────────────────── ElevenLabs ───────────────────────────────
function elevenKey(): string {
  const key = getSecret('ELEVENLABS_API_KEY');
  if (!key) throw new CloneError('Add your ElevenLabs API key in API Keys (ELEVENLABS_API_KEY) first.', 400, 'ELEVENLABS_KEY_MISSING');
  return key;
}

async function elevenError(res: Response): Promise<CloneError> {
  let detail = '';
  try {
    const j: any = await res.json();
    detail = j?.detail?.message || j?.detail?.status || (typeof j?.detail === 'string' ? j.detail : '') || j?.message || '';
  } catch { /* not JSON */ }
  if (res.status === 401) return new CloneError('ElevenLabs rejected the API key. Check ELEVENLABS_API_KEY in API Keys.', 401, 'ELEVENLABS_AUTH');
  if (res.status === 402 || /subscription|plan|upgrade|quota|limit/i.test(detail)) return new CloneError(`ElevenLabs: ${detail || 'your plan does not allow this (voice cloning needs a paid plan).'}`, 402, 'ELEVENLABS_PLAN');
  return new CloneError(`ElevenLabs error ${res.status}${detail ? `: ${detail}` : ''}`, res.status >= 500 ? 502 : 400, 'ELEVENLABS_ERROR');
}

export async function elevenListClones(fetchImpl: typeof fetch = fetch): Promise<ClonedVoice[]> {
  const res = await fetchImpl(`${ELEVEN_API}/v1/voices`, { headers: { 'xi-api-key': elevenKey() } });
  if (!res.ok) throw await elevenError(res);
  const data: any = await res.json();
  return (Array.isArray(data?.voices) ? data.voices : [])
    .filter((v: any) => ['cloned', 'professional'].includes(String(v?.category || '')))
    .map((v: any) => ({
      provider: 'elevenlabs' as const,
      id: String(v.voice_id),
      name: String(v.name || v.voice_id),
      voice: String(v.voice_id),
      liveCalls: true,
      createdAt: v.created_at_unix ? new Date(Number(v.created_at_unix) * 1000).toISOString() : null,
    }));
}

/** Ready-made voices on the ElevenLabs account (premade, library, generated): not clones. */
export async function elevenListLibrary(fetchImpl: typeof fetch = fetch): Promise<Array<ClonedVoice & { description: string }>> {
  const res = await fetchImpl(`${ELEVEN_API}/v1/voices`, { headers: { 'xi-api-key': elevenKey() } });
  if (!res.ok) throw await elevenError(res);
  const data: any = await res.json();
  return (Array.isArray(data?.voices) ? data.voices : [])
    .filter((v: any) => v?.voice_id && !['cloned', 'professional'].includes(String(v?.category || '')))
    .map((v: any) => {
      const l = v?.labels && typeof v.labels === 'object' ? v.labels : {};
      const description = [l.gender, l.age, l.accent, l.description || l.descriptive, l.use_case || l.use_case].filter(Boolean).map(String).join(' · ');
      return {
        provider: 'elevenlabs' as const,
        id: String(v.voice_id),
        name: String(v.name || v.voice_id),
        voice: String(v.voice_id),
        liveCalls: true,
        createdAt: null,
        description: description.slice(0, 160),
      };
    })
    .sort((a: any, b: any) => a.name.localeCompare(b.name));
}

/**
 * How expressive the live-call voice sounds. ElevenLabs uses a voice's saved
 * settings whenever a request sends none (Deepgram's speak provider sends none),
 * so these are written onto the voice itself.
 * Lower stability = more emotion and pitch movement; style adds delivery flair.
 */
export const EXPRESSIVE_PRESETS = {
  warm: { label: 'Warm & expressive', stability: 0.32, similarity_boost: 0.8, style: 0.45, use_speaker_boost: true, speed: 1.0 },
  balanced: { label: 'Balanced', stability: 0.5, similarity_boost: 0.75, style: 0.2, use_speaker_boost: true, speed: 1.0 },
  steady: { label: 'Steady & calm', stability: 0.7, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true, speed: 0.97 },
} as const;
export type ExpressivePreset = keyof typeof EXPRESSIVE_PRESETS;

export async function elevenSetExpressiveness(voiceId: string, preset: string, fetchImpl: typeof fetch = fetch): Promise<ExpressivePreset> {
  if (!/^[A-Za-z0-9]{8,64}$/.test(voiceId)) throw new CloneError('Unknown ElevenLabs voice id.');
  if (!Object.prototype.hasOwnProperty.call(EXPRESSIVE_PRESETS, preset)) throw new CloneError('Choose Warm, Balanced or Steady.');
  const { label: _label, ...settings } = EXPRESSIVE_PRESETS[preset as ExpressivePreset];
  const res = await fetchImpl(`${ELEVEN_API}/v1/voices/${voiceId}/settings/edit`, {
    method: 'POST',
    headers: { 'xi-api-key': elevenKey(), 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  if (!res.ok) throw await elevenError(res);
  return preset as ExpressivePreset;
}

export async function elevenCreateClone(req: CloneRequest, fetchImpl: typeof fetch = fetch): Promise<ClonedVoice> {
  const form = new FormData();
  form.append('name', req.name);
  form.append('description', req.description || `Consented clone of ${req.speakerName}. ${req.consentStatement}`.slice(0, 500));
  form.append('remove_background_noise', req.removeBackgroundNoise ? 'true' : 'false');
  form.append('labels', JSON.stringify({ speaker: req.speakerName.slice(0, 60), source: 'voice-agent-console' }));
  form.append('files', new Blob([new Uint8Array(req.sample)], { type: req.mimeType }), req.filename);
  const res = await fetchImpl(`${ELEVEN_API}/v1/voices/add`, { method: 'POST', headers: { 'xi-api-key': elevenKey() }, body: form });
  if (!res.ok) throw await elevenError(res);
  const data: any = await res.json();
  if (!data?.voice_id) throw new CloneError('ElevenLabs did not return a voice id.', 502, 'ELEVENLABS_ERROR');
  return { provider: 'elevenlabs', id: String(data.voice_id), name: req.name, voice: String(data.voice_id), liveCalls: true, createdAt: new Date().toISOString() };
}

export async function elevenPreview(voiceId: string, text: string, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
  if (!/^[A-Za-z0-9]{8,64}$/.test(voiceId)) throw new CloneError('Unknown ElevenLabs voice id.');
  const res = await fetchImpl(`${ELEVEN_API}/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': elevenKey(), 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text: String(text || '').slice(0, 600), model_id: ELEVEN_LIVE_MODELS[0] }),
  });
  if (!res.ok) throw await elevenError(res);
  return Buffer.from(await res.arrayBuffer());
}

export async function elevenDelete(voiceId: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!/^[A-Za-z0-9]{8,64}$/.test(voiceId)) throw new CloneError('Unknown ElevenLabs voice id.');
  const res = await fetchImpl(`${ELEVEN_API}/v1/voices/${voiceId}`, { method: 'DELETE', headers: { 'xi-api-key': elevenKey() } });
  if (!res.ok && res.status !== 404) throw await elevenError(res);
}

/** The TTS provider that makes Deepgram's Voice Agent speak with an ElevenLabs voice. */
export function elevenLabsLiveProvider(voiceId: string, voiceName: string) {
  return {
    id: 'p_elevenlabs_clone',
    kind: 'tts' as const,
    name: `ElevenLabs — ${voiceName}`.slice(0, 120),
    type: 'eleven_labs',
    models: ELEVEN_LIVE_MODELS.join(','),
    endpoint: `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/multi-stream-input`,
    headers: '{"xi-api-key":"{{ELEVENLABS_API_KEY}}"}',
    extra: '{}',
    mk: 'model_id',
  };
}

// ─────────────────────────── Self-hosted (Chatterbox) ───────────────────────────
async function speechServiceError(res: Response): Promise<CloneError> {
  let detail = '';
  try { const j: any = await res.json(); detail = typeof j?.detail === 'string' ? j.detail : j?.error || ''; } catch { /* ignore */ }
  if (res.status === 501) return new CloneError('Voice cloning is not enabled on your speech service (it needs the clone container on an NVIDIA GPU server).', 501, 'SELFHOSTED_CLONE_OFF');
  if (res.status === 401 || res.status === 403) return new CloneError('The speech service rejected the key. Check SPEECH_SERVICE_API_KEY.', 401, 'SELFHOSTED_AUTH');
  return new CloneError(`Speech service error ${res.status}${detail ? `: ${detail}` : ''}`, res.status >= 500 ? 502 : 400, 'SELFHOSTED_ERROR');
}

function speechServiceUrl(): string {
  const base = getSpeechServiceBaseUrl();
  if (!base) throw new CloneError('Connect your self-hosted speech service first (Plug-Ins → Self-Hosted Speech Service).', 400, 'SELFHOSTED_NOT_CONFIGURED');
  return base.replace(/\/+$/, '');
}

export async function selfHostedListClones(fetchImpl: typeof fetch = fetch): Promise<ClonedVoice[]> {
  const res = await fetchImpl(`${speechServiceUrl()}/v1/voices`, { headers: getSpeechServiceHeaders() });
  if (!res.ok) throw await speechServiceError(res);
  const data: any = await res.json();
  return (Array.isArray(data?.voices) ? data.voices : []).map((v: any) => ({
    provider: 'selfhosted' as const,
    id: String(v.id),
    name: String(v.name || v.id),
    voice: `clone:${v.id}`,
    liveCalls: false,
    createdAt: v.created_at || null,
    durationSec: typeof v.duration === 'number' ? v.duration : null,
  }));
}

export async function selfHostedCreateClone(req: CloneRequest, fetchImpl: typeof fetch = fetch): Promise<ClonedVoice> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(req.sample)], { type: req.mimeType }), req.filename);
  form.append('name', req.name);
  form.append('speaker_name', req.speakerName);
  form.append('consent_confirmed', 'true');
  form.append('consent_statement', req.consentStatement);
  const res = await fetchImpl(`${speechServiceUrl()}/v1/voices`, { method: 'POST', headers: getSpeechServiceHeaders(), body: form });
  if (!res.ok) throw await speechServiceError(res);
  const data: any = await res.json();
  return { provider: 'selfhosted', id: String(data.id), name: String(data.name || req.name), voice: String(data.voice || `clone:${data.id}`), liveCalls: false, durationSec: data.duration ?? null, createdAt: new Date().toISOString() };
}

export async function selfHostedDelete(id: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!/^[0-9a-f]{32}$/.test(id)) throw new CloneError('Unknown self-hosted voice id.');
  const res = await fetchImpl(`${speechServiceUrl()}/v1/voices/${id}`, { method: 'DELETE', headers: getSpeechServiceHeaders() });
  if (!res.ok && res.status !== 404) throw await speechServiceError(res);
}
