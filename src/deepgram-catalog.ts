import { DeepgramVoice } from './types';
import { getSecret } from './env-store';
import { isValidFluxSpeed } from './settings-builder';

const FEATURED_IDS = new Set([
  'flux-haley-en',
  'flux-hannah-en',
  'flux-kit-en',
  'flux-alexis-en',
  'flux-sienna-en',
  'flux-cliff-en',
  'flux-cole-en',
  'flux-brooke-en',
  'flux-colin-en',
  'flux-gemma-en',
  'flux-heather-en',
  'flux-miles-en',
  'flux-sean-en',
  'aura-2-thalia-en',
  'aura-2-andromeda-en',
  'aura-2-helena-en',
  'aura-2-apollo-en',
  'aura-2-arcas-en',
  'aura-2-aries-en',
]);

const FALLBACK_VOICES: DeepgramVoice[] = [
  {
    id: 'flux-haley-en',
    name: 'haley',
    displayName: 'Haley',
    family: 'flux-v2',
    providerVersion: 'v2',
    languages: ['en', 'en-US'],
    primaryLanguage: 'en',
    accent: 'American',
    gender: 'feminine',
    age: 'Young Adult',
    tags: ['feminine', 'clear', 'professional', 'caring', 'calm', 'empathetic'],
    useCases: ['Customer Service', 'Financial Services', 'IVR'],
    sampleUrl: null,
    avatarUrl: null,
    featured: true,
  },
  {
    id: 'flux-kit-en',
    name: 'kit',
    displayName: 'Kit',
    family: 'flux-v2',
    providerVersion: 'v2',
    languages: ['en', 'en-GB'],
    primaryLanguage: 'en',
    accent: 'British',
    gender: 'masculine',
    age: 'Young Adult',
    tags: ['masculine', 'friendly', 'energetic', 'calm', 'helpful'],
    useCases: ['Customer Service', 'Financial Services', 'Narration'],
    sampleUrl: null,
    avatarUrl: null,
    featured: true,
  },
  {
    id: 'flux-alexis-en',
    name: 'alexis',
    displayName: 'Alexis',
    family: 'flux-v2',
    providerVersion: 'v2',
    languages: ['en', 'en-US'],
    primaryLanguage: 'en',
    accent: 'American',
    gender: 'feminine',
    age: 'Adult',
    tags: ['feminine', 'clear', 'professional', 'calm', 'empathetic'],
    useCases: ['Customer Service', 'IVR', 'Financial Services'],
    sampleUrl: null,
    avatarUrl: null,
    featured: true,
  },
  {
    id: 'aura-2-thalia-en',
    name: 'thalia',
    displayName: 'Thalia',
    family: 'aura-2',
    providerVersion: 'v1',
    languages: ['en', 'en-US'],
    primaryLanguage: 'en',
    accent: 'American',
    gender: 'feminine',
    age: 'Adult',
    tags: ['feminine', 'clear', 'confident', 'energetic', 'enthusiastic'],
    useCases: ['Casual Chat', 'Customer Service', 'IVR'],
    sampleUrl: null,
    avatarUrl: null,
    featured: true,
  },
  {
    id: 'aura-2-apollo-en',
    name: 'apollo',
    displayName: 'Apollo',
    family: 'aura-2',
    providerVersion: 'v1',
    languages: ['en', 'en-US'],
    primaryLanguage: 'en',
    accent: 'American',
    gender: 'masculine',
    age: 'Adult',
    tags: ['masculine', 'confident', 'comfortable', 'casual'],
    useCases: ['Casual Chat', 'Customer Service'],
    sampleUrl: null,
    avatarUrl: null,
    featured: true,
  },
];

export interface VoiceCatalogCache {
  fetchedAt: number;
  source: 'deepgram_live_api' | 'fallback_catalog';
  authenticated: boolean;
  voices: DeepgramVoice[];
  sttModels: string[];
}

let cachedVoices: VoiceCatalogCache | null = null;
let inflightCatalog: Promise<VoiceCatalogCache> | null = null;

const CACHE_TTL_MS = 5 * 60 * 1000;

function inferGender(tags: string[]): 'feminine' | 'masculine' | 'neutral' {
  const lower = tags.map((t) => t.toLowerCase());
  if (lower.some((t) => t === 'feminine' || t === 'female')) return 'feminine';
  if (lower.some((t) => t === 'masculine' || t === 'male')) return 'masculine';
  return 'neutral';
}

function normalizeTtsModel(item: any, defaultFamily: 'flux-v2' | 'aura-2'): DeepgramVoice | null {
  const id = String(item?.canonical_name || '').trim();
  if (!id) return null;

  const arch = String(item?.architecture || '').toLowerCase();
  const family: DeepgramVoice['family'] =
    id.startsWith('flux-') || arch.includes('flux')
      ? 'flux-v2'
      : id.startsWith('aura-2-') || arch === 'aura-2'
      ? 'aura-2'
      : defaultFamily === 'flux-v2'
      ? 'flux-v2'
      : 'aura-1';

  const meta = item?.metadata || {};
  const tags: string[] = Array.isArray(meta.tags) ? meta.tags.map(String) : [];
  const useCases: string[] = Array.isArray(meta.use_cases) ? meta.use_cases.map(String) : [];
  const languages: string[] = Array.isArray(item?.languages) && item.languages.length
    ? item.languages.map(String)
    : ['en'];
  const primaryLanguage = (languages[0] || 'en').split('-')[0].toLowerCase();

  const rawName = String(item?.name || id.split('-')[1] || id);
  const displayName = String(
    meta.display_name || rawName.charAt(0).toUpperCase() + rawName.slice(1)
  );

  return {
    id,
    name: rawName,
    displayName,
    family,
    providerVersion: family === 'flux-v2' ? 'v2' : 'v1',
    languages,
    primaryLanguage,
    accent: String(meta.accent || 'General'),
    gender: inferGender(tags),
    age: String(meta.age || 'Adult'),
    tags,
    useCases,
    sampleUrl: typeof meta.sample === 'string' && meta.sample.startsWith('https://') ? meta.sample : null,
    avatarUrl: typeof meta.image === 'string' && meta.image.startsWith('https://') ? meta.image : null,
    featured: FEATURED_IDS.has(id),
  };
}

export async function fetchDeepgramVoiceCatalog(forceRefresh = false): Promise<VoiceCatalogCache> {
  const apiKey = getSecret('DEEPGRAM_API_KEY');
  const now = Date.now();

  if (
    !forceRefresh &&
    cachedVoices &&
    now - cachedVoices.fetchedAt < CACHE_TTL_MS &&
    cachedVoices.authenticated === Boolean(apiKey)
  ) {
    return cachedVoices;
  }

  if (inflightCatalog && !forceRefresh) {
    return inflightCatalog;
  }

  const runFetch = async (): Promise<VoiceCatalogCache> => {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Accept-Encoding': 'identity',
    };
    if (apiKey) {
      headers.Authorization = `Token ${apiKey}`;
    }

    const fetchJsonWithRetry = async (url: string) => {
      let lastErr: any;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await fetch(url, {
            headers,
            signal: AbortSignal.timeout(20000),
          });
          if (apiKey && res.status === 401) {
            throw new Error('DEEPGRAM_API_KEY was rejected (401 Unauthorized) by api.deepgram.com');
          }
          return res.ok ? await res.json() : { tts: [], stt: [] };
        } catch (e: any) {
          if (String(e?.message || '').includes('401 Unauthorized')) throw e;
          lastErr = e;
        }
      }
      throw lastErr;
    };

    try {
      const v2Json: any = await fetchJsonWithRetry('https://api.deepgram.com/v2/models');
      const v1Json: any = await fetchJsonWithRetry('https://api.deepgram.com/v1/models');

      const byId = new Map<string, DeepgramVoice>();

      for (const item of Array.isArray(v2Json.tts) ? v2Json.tts : []) {
        const v = normalizeTtsModel(item, 'flux-v2');
        if (v) byId.set(v.id, v);
      }
      for (const item of Array.isArray(v1Json.tts) ? v1Json.tts : []) {
        const v = normalizeTtsModel(item, 'aura-2');
        if (v && !byId.has(v.id)) byId.set(v.id, v);
      }

      const voices = Array.from(byId.values()).sort((a, b) => {
        if (a.featured !== b.featured) return a.featured ? -1 : 1;
        const famRank = { 'flux-v2': 0, 'aura-2': 1, 'aura-1': 2 };
        if (famRank[a.family] !== famRank[b.family]) return famRank[a.family] - famRank[b.family];
        return a.displayName.localeCompare(b.displayName);
      });

      // Voice Agent Settings accepts only these Flux v2 listen models. Keep Nova models
      // out of the Agent console catalog even though the standalone STT API offers them.
      const sttSet = new Set<string>(['flux-general-en', 'flux-general-multi']);

      if (voices.length === 0) {
        throw new Error('Deepgram models response returned 0 TTS voices');
      }

      cachedVoices = {
        fetchedAt: Date.now(),
        source: 'deepgram_live_api',
        authenticated: Boolean(apiKey),
        voices,
        sttModels: Array.from(sttSet),
      };
      return cachedVoices;
    } catch (err: any) {
      if (String(err?.message || '').includes('401 Unauthorized')) {
        throw err;
      }
      return {
        fetchedAt: Date.now(),
        source: 'fallback_catalog' as const,
        authenticated: false,
        voices: FALLBACK_VOICES,
        sttModels: ['flux-general-en', 'flux-general-multi'],
      };
    } finally {
      inflightCatalog = null;
    }
  };

  inflightCatalog = runFetch();
  return inflightCatalog;
}

import { DEEPGRAM_MANAGED_LLM_CATALOG } from './defaults';

export async function fetchDeepgramLlmModels() {
  try {
    const res = await fetch('https://agent.deepgram.com/v1/agent/settings/think/models', {
      headers: { Accept: 'application/json', 'Accept-Encoding': 'identity' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: any = await res.json();
    return Array.isArray(data?.models) && data.models.length > 0 ? data.models : DEEPGRAM_MANAGED_LLM_CATALOG;
  } catch {
    return DEEPGRAM_MANAGED_LLM_CATALOG;
  }
}

const ALLOWED_SAMPLE_HOSTS = new Set(['cdn.sanity.io', 'static.deepgram.com']);

export async function fetchAllowedSampleAudio(sampleUrl: string): Promise<{ buffer: Buffer; contentType: string }> {
  let parsed: URL;
  try {
    parsed = new URL(sampleUrl);
  } catch {
    throw new Error('Invalid sample URL');
  }
  if (parsed.protocol !== 'https:' || !ALLOWED_SAMPLE_HOSTS.has(parsed.hostname)) {
    throw new Error('Sample URL host is not allowlisted');
  }

  const res = await fetch(parsed.toString(), { signal: AbortSignal.timeout(12000) });
  if (!res.ok) {
    throw new Error(`Upstream sample returned HTTP ${res.status}`);
  }
  const contentType = res.headers.get('content-type') || 'audio/wav';
  const arr = await res.arrayBuffer();
  return { buffer: Buffer.from(arr), contentType };
}

export interface TtsPreviewRequest {
  providerType?: string;
  model: string;
  text: string;
  speed?: number;
  expressivity?: number;
  voiceId?: string;
}

export async function synthesizeTtsPreview(
  req: TtsPreviewRequest
): Promise<{ buffer: Buffer; contentType: string; usedModel: string }> {
  const text = (req.text || '').trim();
  if (!text) {
    throw Object.assign(new Error('Text to synthesize cannot be empty.'), { statusCode: 400, code: 'EMPTY_TEXT' });
  }
  if (text.length > 2000) {
    throw Object.assign(new Error('Preview text must be 2,000 characters or fewer.'), {
      statusCode: 400,
      code: 'TEXT_TOO_LONG',
    });
  }

  const providerType = req.providerType || 'deepgram';

  if (providerType === 'deepgram') {
    const apiKey = getSecret('DEEPGRAM_API_KEY');
    if (!apiKey) {
      throw Object.assign(
        new Error(
          'DEEPGRAM_API_KEY is not configured yet. Click "🔑 API Keys" in the top bar (or add DEEPGRAM_API_KEY to .env) to synthesize custom text with real Deepgram TTS — or click "▶ Sample" on any voice card to hear its studio sample immediately!'
        ),
        { statusCode: 400, code: 'MISSING_DEEPGRAM_KEY' }
      );
    }

    const model = (req.model || 'flux-haley-en').trim();
    const isFlux = model.startsWith('flux-');
    const baseEndpoint = isFlux ? 'https://api.deepgram.com/v2/speak' : 'https://api.deepgram.com/v1/speak';
    const params = new URLSearchParams({ model, encoding: 'mp3' });

    const speed = Number(req.speed ?? 1.0);
    if (isFlux) {
      const snappedSpeed = isValidFluxSpeed(speed) ? speed : Math.round(Math.min(1.5, Math.max(0.5, speed)) * 20) / 20;
      if (snappedSpeed !== 1.0) params.set('speed', String(snappedSpeed));
      const expr = Math.round(Number(req.expressivity ?? 0));
      if (expr >= -2 && expr <= 2 && expr !== 0) params.set('expressivity', String(expr));
    } else if (speed >= 0.7 && speed <= 1.5 && speed !== 1.0) {
      params.set('speed', String(speed));
    }

    const callSpeak = async (qs: URLSearchParams) =>
      fetch(`${baseEndpoint}?${qs.toString()}`, {
        method: 'POST',
        headers: {
          Authorization: `Token ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(15000),
      });

    let res = await callSpeak(params);
    if (!res.ok && params.has('speed')) {
      const bodyTxt = await res.text();
      if (bodyTxt.includes('SPEED_NOT_SUPPORTED')) {
        params.delete('speed');
        res = await callSpeak(params);
      } else {
        throw Object.assign(new Error(`Deepgram TTS error (${res.status}): ${bodyTxt.slice(0, 240)}`), {
          statusCode: res.status === 401 ? 401 : 400,
          code: 'DEEPGRAM_TTS_ERROR',
        });
      }
    }

    if (!res.ok) {
      const bodyTxt = await res.text();
      throw Object.assign(new Error(`Deepgram TTS error (${res.status}): ${bodyTxt.slice(0, 240)}`), {
        statusCode: res.status === 401 ? 401 : 400,
        code: 'DEEPGRAM_TTS_ERROR',
      });
    }

    const arr = await res.arrayBuffer();
    return {
      buffer: Buffer.from(arr),
      contentType: res.headers.get('content-type') || 'audio/mpeg',
      usedModel: model,
    };
  }

  if (providerType === 'eleven_labs') {
    const apiKey = getSecret('ELEVENLABS_API_KEY');
    if (!apiKey) {
      throw Object.assign(
        new Error('ELEVENLABS_API_KEY is not set in server .env. Click "🔑 API Keys" to add it.'),
        { statusCode: 400, code: 'MISSING_ELEVENLABS_KEY' }
      );
    }
    const voiceId = req.voiceId || '21m00Tcm4TlvDq8ikWAM';
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: req.model || 'eleven_turbo_v2_5',
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const errTxt = await res.text();
      throw Object.assign(new Error(`ElevenLabs TTS error (${res.status}): ${errTxt.slice(0, 200)}`), {
        statusCode: 400,
      });
    }
    return {
      buffer: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get('content-type') || 'audio/mpeg',
      usedModel: req.model,
    };
  }

  if (providerType === 'cartesia') {
    const apiKey = getSecret('CARTESIA_API_KEY');
    if (!apiKey) {
      throw Object.assign(
        new Error('CARTESIA_API_KEY is not set in server .env. Click "🔑 API Keys" to add it.'),
        { statusCode: 400, code: 'MISSING_CARTESIA_KEY' }
      );
    }
    const res = await fetch('https://api.cartesia.ai/tts/bytes', {
      method: 'POST',
      headers: {
        'X-API-Key': apiKey,
        'Cartesia-Version': '2024-06-10',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        transcript: text,
        model_id: req.model || 'sonic-2',
        voice: { mode: 'id', id: req.voiceId || 'a167e0f3-df7e-4d52-a9c3-f949145efdab' },
        output_format: { container: 'wav', encoding: 'pcm_s16le', sample_rate: 24000 },
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const errTxt = await res.text();
      throw Object.assign(new Error(`Cartesia TTS error (${res.status}): ${errTxt.slice(0, 200)}`), {
        statusCode: 400,
      });
    }
    return {
      buffer: Buffer.from(await res.arrayBuffer()),
      contentType: 'audio/wav',
      usedModel: req.model,
    };
  }

  throw Object.assign(
    new Error(`Live preview synthesis is supported for Deepgram, ElevenLabs, and Cartesia (got "${providerType}").`),
    { statusCode: 400, code: 'UNSUPPORTED_PREVIEW_PROVIDER' }
  );
}
