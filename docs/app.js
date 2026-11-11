(() => {
  'use strict';

  // Browser sessions use the server-issued HttpOnly cookie only.
  // Remove legacy JavaScript-readable tokens and query-string handoffs.
  try {
    window.sessionStorage?.removeItem('vac_auth_token');
    window.localStorage?.removeItem('vac_auth_token');
    const current = new URL(window.location.href);
    if (current.searchParams.has('vac_token') || current.searchParams.has('token')) {
      current.searchParams.delete('vac_token');
      current.searchParams.delete('token');
      history.replaceState(history.state, '', `${current.pathname}${current.search}${current.hash}`);
    }
  } catch {}
  function vacWithWsAuth(wsUrl) { return wsUrl; }
  const _nativeFetch = window.fetch.bind(window);
  /** Defaults credentials to same-origin for recognized API URLs; init can override that default. */
  window.fetch = function (input, init) {
    const urlStr = typeof input === 'string' ? input : input && input.url ? String(input.url) : '';
    const isLocalApi = urlStr.startsWith('/api/') || urlStr.startsWith('./api/') ||
      (urlStr.startsWith(window.location.origin) && urlStr.includes('/api/'));
    return isLocalApi
      ? _nativeFetch(input, Object.assign({ credentials: 'same-origin' }, init || {}))
      : _nativeFetch(input, init);
  };

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function uid(prefix = 'id') {
    return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function isPlainObject(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
  }

  // Must match MISSING_CAMPAIGN_RULES in src/defaults.ts (backend normalizer).
  const MISSING_CAMPAIGN_RULES = 'REVIEW REQUIRED: Add and review campaign-specific compliance and call rules before deployment.';

  let S = null;
  let snap = '';
  let revisions = [];
  let secretsStatus = {};
  let latestRevisionId = null;
  let saveError = '';
  let manualSaveInFlight = false;
  const STATE_DRAFT_KEY = 'vac_console_unsaved_draft_v1';
  const DRAFT_OWNER_STATE_KEY = 'vacDraftOwner';
  let draftOwnerId = '';

  // history.state survives a same-tab reload but is empty in a newly opened
  // link, so new tabs read the last saved/shared state instead of adopting
  // another tab's uncommitted draft. The draft itself stays in localStorage so
  // the original tab can still recover it after an interruption.
  function currentDraftOwnerId() {
    try {
      return String(window.history?.state?.[DRAFT_OWNER_STATE_KEY] || '');
    } catch {
      return '';
    }
  }

  function ensureDraftOwnerId() {
    if (draftOwnerId) return draftOwnerId;
    draftOwnerId = currentDraftOwnerId();
    if (!draftOwnerId) {
      draftOwnerId = uid('tab');
      try {
        window.history?.replaceState({ ...(window.history.state || {}), [DRAFT_OWNER_STATE_KEY]: draftOwnerId }, '');
      } catch {}
    }
    return draftOwnerId;
  }

  function readLocalDraft() {
    try {
      const draft = JSON.parse(window.localStorage?.getItem(STATE_DRAFT_KEY) || 'null');
      return isPlainObject(draft) ? draft : null;
    } catch {
      return null;
    }
  }

  function draftBelongsToTab(draft) {
    if (!draft) return false;
    // Drafts written before per-tab ownership existed remain recoverable.
    if (!draft.owner) return true;
    const owner = currentDraftOwnerId();
    return Boolean(owner) && draft.owner === owner;
  }

  const SECTION_TABS = ['dashboard', 'agents', 'plugins', 'campaigns', 'voice', 'test', 'vici', 'wallboard', 'export'];
  function readViewLocation() {
    try {
      const params = new URLSearchParams(window.location.search);
      const requested = params.get('tab') || '';
      return {
        tab: SECTION_TABS.includes(requested) ? requested : 'dashboard',
        agentId: params.get('agent') || '',
        campaignId: params.get('campaign') || '',
        fleetCampaignId: params.get('fleetCampaign') || '',
      };
    } catch {
      return { tab: 'dashboard', agentId: '', campaignId: '', fleetCampaignId: '' };
    }
  }
  const initialView = readViewLocation();
  let tab = initialView.tab;
  let cur = { a: initialView.agentId || 'a_nova', c: initialView.campaignId || 'c_medicare' };

  // Voice catalog state (Step 1)
  let voiceCatalog = {
    loaded: false,
    loading: false,
    source: '',
    authenticated: false,
    voices: [],
    facets: { families: [], languages: [], accents: [] },
    filters: { q: '', family: '', language: 'en', accent: '', gender: '' },
    previewText: '',
    previewAudioUrl: '',
    playingLabel: '',
    error: '',
  };

  let activeAudioEl = null;

  const isInIframe = (() => {
    try {
      return window.self !== window.top;
    } catch {
      return true;
    }
  })();

  const SESSION_SECRETS_KEY = 'vac_tab_secrets_v1';
  const CLOUD_SECRETS_KEY = 'vac_cloud_secrets_v1';
  const CLOUD_STATE_KEY = 'vac_cloud_state_v1';
  const VAC_CLOUD_SESSION_KEY = 'vac_cloud_session_v1';
  const APPEARANCE_STORAGE_KEY = 'vac_appearance_v2';
  let serverlessCloudMode = false;

  // ==================== DEEPGRAM-MANAGED LLM CATALOG (STRICTLY DEEPGRAM-PROVIDED ONLY) ====================
  let deepgramManagedLlms = [
    { id: 'gpt-4o-mini', name: 'GPT-4o mini', provider: 'open_ai' },
    { id: 'gpt-4.1-mini', name: 'GPT-4.1 mini', provider: 'open_ai' },
    { id: 'gpt-4.1-nano', name: 'GPT-4.1 nano', provider: 'open_ai' },
    { id: 'gpt-4.1', name: 'GPT-4.1', provider: 'open_ai' },
    { id: 'gpt-4o', name: 'GPT-4o', provider: 'open_ai' },
    { id: 'gpt-5-mini', name: 'GPT-5 mini', provider: 'open_ai' },
    { id: 'gpt-5-nano', name: 'GPT-5 nano', provider: 'open_ai' },
    { id: 'gpt-5', name: 'GPT-5', provider: 'open_ai' },
    { id: 'gpt-5.1', name: 'GPT-5.1 Thinking', provider: 'open_ai' },
    { id: 'gpt-5.2', name: 'GPT 5.2', provider: 'open_ai' },
    { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini', provider: 'open_ai' },
    { id: 'gpt-5.4-nano', name: 'GPT-5.4 nano', provider: 'open_ai' },
    { id: 'gpt-5.4', name: 'GPT 5.4', provider: 'open_ai' },
    { id: 'gpt-5.5', name: 'GPT-5.5', provider: 'open_ai' },
    { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', provider: 'open_ai' },
    { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', provider: 'open_ai' },
    { id: 'gpt-6-luna', name: 'GPT-6 Luna', provider: 'open_ai' },
    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', provider: 'anthropic' },
    { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', provider: 'anthropic' },
    { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', provider: 'anthropic' },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'anthropic' },
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', provider: 'anthropic' },
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', provider: 'anthropic' },
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'google' },
    { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', provider: 'google' },
    { id: 'gemini-3-flash-preview', name: 'Gemini 3.0 Flash Preview', provider: 'google' },
    { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', provider: 'google' },
    { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview', provider: 'google' },
    { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', provider: 'google' },
    { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', provider: 'google' },
    { id: 'openai/gpt-oss-20b', name: 'GPT OSS 20B', provider: 'groq' },
    { id: 'nvidia/nemotron-3.5-lightning-30b-a3b', name: 'Nemotron 3.5 Lightning 30B A3B', provider: 'nvidia' },
  ];
  let llmSyncNotice = '';

  const CANONICAL_DG_LLM_PROVIDERS = [
    { id: 'l1', type: 'open_ai', name: 'OpenAI (Deepgram Managed)' },
    { id: 'l2', type: 'anthropic', name: 'Anthropic Claude (Deepgram Managed)' },
    { id: 'l3', type: 'google', name: 'Google Gemini (Deepgram Managed)' },
    { id: 'l4', type: 'groq', name: 'Groq OSS (Deepgram Managed)' },
    { id: 'l5', type: 'nvidia', name: 'NVIDIA Nemotron (Deepgram Managed)' },
  ];
  const DG_LLM_PROVIDER_TYPES = CANONICAL_DG_LLM_PROVIDERS.map((p) => p.type);

  function dgLlmEntriesForType(providerType) {
    return deepgramManagedLlms.filter((m) => m.provider === providerType);
  }

  function dgLlmModelIdsForType(providerType) {
    return dgLlmEntriesForType(providerType).map((m) => m.id);
  }

  function enforceDeepgramOnlyLlms(state) {
    if (!state || !Array.isArray(state.providers)) return false;
    let mutated = false;

    for (const p of state.providers) {
      if (p.kind !== 'llm') continue;
      if (!DG_LLM_PROVIDER_TYPES.includes(p.type)) {
        p.type = 'open_ai';
        mutated = true;
      }
      const canonical = CANONICAL_DG_LLM_PROVIDERS.find((c) => c.type === p.type);
      if ((p.name || '').includes('BYO') || !(p.name || '').trim()) {
        p.name = canonical ? canonical.name : `${p.type} (Deepgram Managed)`;
        mutated = true;
      }
      if ((p.endpoint || '').trim() !== '') {
        p.endpoint = '';
        mutated = true;
      }
      if ((p.headers || '{}').trim() !== '{}') {
        p.headers = '{}';
        mutated = true;
      }
      if ((p.extra || '{}').trim() !== '{}') {
        p.extra = '{}';
        mutated = true;
      }
      const officialIds = dgLlmModelIdsForType(p.type);
      const officialSet = new Set(officialIds);
      const curList = (p.models || '')
        .split(',')
        .map((s) => s.trim())
        .filter((m) => officialSet.has(m));
      const merged = Array.from(new Set([...curList, ...officialIds])).join(',');
      if (p.models !== merged) {
        p.models = merged;
        mutated = true;
      }
    }

    for (const canon of CANONICAL_DG_LLM_PROVIDERS) {
      if (!state.providers.some((p) => p.kind === 'llm' && p.type === canon.type)) {
        const entry = {
          id: state.providers.some((p) => p.id === canon.id) ? uid('llm') : canon.id,
          kind: 'llm',
          name: canon.name,
          type: canon.type,
          models: dgLlmModelIdsForType(canon.type).join(','),
          endpoint: '',
          headers: '{}',
          extra: '{}',
          mk: 'model',
        };
        const ttsIdx = state.providers.findIndex((p) => p.kind === 'tts');
        if (ttsIdx >= 0) state.providers.splice(ttsIdx, 0, entry);
        else state.providers.push(entry);
        mutated = true;
      }
    }

    if (Array.isArray(state.agents)) {
      for (const ag of state.agents) {
        if (!ag.llm || typeof ag.llm !== 'object') {
          ag.llm = { temp: 0.7, reasoning: 'low' };
          mutated = true;
        }
        for (const key of ['p', 'model', 'ctx']) {
          if (Object.prototype.hasOwnProperty.call(ag.llm, key)) {
            delete ag.llm[key];
            mutated = true;
          }
        }
      }
    }

    return mutated;
  }

  async function syncDeepgramManagedLlms(silent = false) {
    try {
      let models = null;
      if (!serverlessCloudMode) {
        try {
          const r = await fetch('/api/deepgram/llm-models');
          if (r.ok && (r.headers.get('content-type') || '').includes('application/json')) {
            const j = await r.json();
            if (j?.ok && Array.isArray(j.models) && j.models.length > 0) models = j.models;
          }
        } catch {}
      }
      if (!models) {
        const directRes = await fetch('https://agent.deepgram.com/v1/agent/settings/think/models', {
          headers: { Accept: 'application/json' },
        });
        if (directRes.ok) {
          const dj = await directRes.json();
          if (Array.isArray(dj?.models) && dj.models.length > 0) models = dj.models;
        }
      }
      if (Array.isArray(models) && models.length > 0) {
        deepgramManagedLlms = models
          .filter((m) => m && m.id && m.provider)
          .map((m) => ({ id: String(m.id), name: String(m.name || m.id), provider: String(m.provider) }));
        if (S) {
          const wasDirty = isDirty();
          const changed = enforceDeepgramOnlyLlms(S);
          if (changed && !wasDirty) {
            if (serverlessCloudMode) {
              snap = comparableSnapshot(S);
              try {
                window.localStorage?.setItem(CLOUD_STATE_KEY, JSON.stringify(S));
              } catch {}
            } else {
              // Keep the persisted baseline intact. The migration stays an
              // unsaved draft until the operator explicitly saves it.
              persistDraftLocally();
            }
          }
        }
        if (!silent) {
          llmSyncNotice = `✓ Live synced ${deepgramManagedLlms.length} official Deepgram-Managed LLM models`;
        }
        return true;
      }
    } catch {}
    if (!silent) {
      llmSyncNotice = `✓ Using ${deepgramManagedLlms.length} verified Deepgram-Managed LLM models`;
    }
    return false;
  }

  // ==================== MMA DIGITAL LABS MULTI-THEME & APPEARANCE ENGINE ====================
  const APPEARANCE_THEMES = [
    {
      id: 'cyan_signal',
      code: 'THEME 01',
      system: 'CYBER ACOUSTIC · VISUAL SYSTEM / 01',
      name: 'Cyan Signal',
      short: 'Cyan Signal',
      sub: 'Cyan / electric blue / violet',
      motif: 'Waveform pulse',
      desc: 'The original voice lab. Electric sound, precision, and a little afterglow.',
      bg: 'linear-gradient(135deg, #0b0f14 0%, #121820 55%, #1d1532 100%)',
      bar: 'linear-gradient(90deg, #00f2fe, #0ea5e9, #7b2cbf)',
      dots: ['#00f2fe', '#7b2cbf', '#37e6c4'],
    },
    {
      id: 'ultraviolet',
      code: 'THEME 02',
      system: 'NEURAL ORBIT · VISUAL SYSTEM / 02',
      name: 'Ultraviolet',
      short: 'Ultraviolet',
      sub: 'Amethyst / fuchsia / indigo',
      motif: 'Neural orbit',
      desc: 'Deep neural synthesis with orbital violet-magenta harmonics and zero-glare depth.',
      bg: 'linear-gradient(135deg, #080612 0%, #160f2d 55%, #271235 100%)',
      bar: 'linear-gradient(90deg, #a855f7, #ec4899, #6366f1)',
      dots: ['#a855f7', '#ec4899', '#818cf8'],
    },
    {
      id: 'aurora_field',
      code: 'THEME 03',
      system: 'BIO SIGNAL · VISUAL SYSTEM / 03',
      name: 'Aurora Field',
      short: 'Aurora Field',
      sub: 'Emerald / mint / soft lime',
      motif: 'Sonar ripple',
      desc: 'Organic acoustic telemetry with sonar mint and bio-luminescent lime vectors.',
      bg: 'linear-gradient(135deg, #040c09 0%, #0a1e17 55%, #132a19 100%)',
      bar: 'linear-gradient(90deg, #10b981, #34d399, #a3e635)',
      dots: ['#10b981', '#a3e635', '#34d399'],
    },
    {
      id: 'ember_pulse',
      code: 'THEME 04',
      system: 'ANALOG FUTURE · VISUAL SYSTEM / 04',
      name: 'Ember Pulse',
      short: 'Ember Pulse',
      sub: 'Amber / copper / graphite',
      motif: 'Analog frequency',
      desc: 'Warm vacuum-tube copper and molten amber over brushed acoustic graphite.',
      bg: 'linear-gradient(135deg, #0c0907 0%, #1d150f 55%, #2c1810 100%)',
      bar: 'linear-gradient(90deg, #f59e0b, #ea580c, #dc2626)',
      dots: ['#f59e0b', '#ea580c', '#fb923c'],
    },
    {
      id: 'obsidian',
      code: 'THEME 05',
      system: 'NEBULA ORBIT · VISUAL SYSTEM / 05',
      name: 'Obsidian Nebula',
      short: 'Obsidian',
      sub: 'Deep Space Indigo & Violet Studio',
      motif: 'Orbital ring',
      desc: 'High-contrast deep-space indigo engineered for 24/7 NOC & voice command centers.',
      bg: 'linear-gradient(135deg, #060913 0%, #151d36 100%)',
      bar: 'linear-gradient(90deg, #4f46e5, #a855f7, #0ea5e9)',
      dots: ['#6366f1', '#a855f7', '#34d399'],
    },
    {
      id: 'emerald',
      code: 'THEME 06',
      system: 'MATRIX HEX · VISUAL SYSTEM / 06',
      name: 'Cyber Emerald',
      short: 'Emerald',
      sub: 'Carbon Matrix & Neon Mint Ops',
      motif: 'Hexagon matrix',
      desc: 'Tactical carbon matrix with high-visibility neon emerald & cyan carrier telemetry.',
      bg: 'linear-gradient(135deg, #040b09 0%, #0e261f 100%)',
      bar: 'linear-gradient(90deg, #10b981, #06b6d4)',
      dots: ['#10b981', '#06b6d4', '#4ade80'],
    },
    {
      id: 'aurora',
      code: 'THEME 07',
      system: 'GLACIER WAVE · VISUAL SYSTEM / 07',
      name: 'Arctic Aurora',
      short: 'Aurora',
      sub: 'Midnight Ocean & Glacial Cyan',
      motif: 'Glacier wave',
      desc: 'Calm midnight ocean glass with luminous glacial cyan and polar teal highlights.',
      bg: 'linear-gradient(135deg, #030b17 0%, #0f2948 100%)',
      bar: 'linear-gradient(90deg, #0284c7, #0ea5e9, #2dd4bf)',
      dots: ['#0ea5e9', '#2dd4bf', '#818cf8'],
    },
    {
      id: 'crimson',
      code: 'THEME 08',
      system: 'MOLTEN CREST · VISUAL SYSTEM / 08',
      name: 'Crimson Gold Luxe',
      short: 'Crimson',
      sub: 'Espresso Onyx, Molten Gold & Rose',
      motif: 'Heraldic crest',
      desc: 'Executive espresso onyx paired with molten gold, ember orange, and crimson accents.',
      bg: 'linear-gradient(135deg, #0c0807 0%, #2a1815 100%)',
      bar: 'linear-gradient(90deg, #f59e0b, #ea580c, #e11d48)',
      dots: ['#f59e0b', '#f43f5e', '#34d399'],
    },
    {
      id: 'pearl',
      code: 'THEME 09',
      system: 'ALABASTER RING · VISUAL SYSTEM / 09',
      name: 'Pearl Daylight',
      short: 'Daylight',
      sub: 'Pure Alabaster & Royal Sapphire (Light)',
      motif: 'Concentric ring',
      desc: 'Crisp daylight alabaster workspace with high-contrast royal sapphire typography.',
      bg: 'linear-gradient(135deg, #ffffff 0%, #e8eef9 100%)',
      bar: 'linear-gradient(90deg, #4f46e5, #2563eb, #0284c7)',
      dots: ['#4f46e5', '#0284c7', '#059669'],
    },
    {
      id: 'sakura',
      code: 'THEME 10',
      system: 'QUARTZ BLOOM · VISUAL SYSTEM / 10',
      name: 'Sakura Ivory',
      short: 'Sakura',
      sub: 'Warm Cream & Rose-Quartz (Light)',
      motif: 'Quartz bloom',
      desc: 'Editorial warm ivory canvas with rose-quartz and plum studio accents.',
      bg: 'linear-gradient(135deg, #ffffff 0%, #fce8ef 100%)',
      bar: 'linear-gradient(90deg, #e11d48, #db2777, #9333ea)',
      dots: ['#e11d48', '#9333ea', '#059669'],
    },
  ];

  // ==================== BRAND PACKAGES (one per theme) ====================
  // Every theme ships a complete identity: its own monogram silhouette, its
  // own icon frame geometry, its own palette and its own favicon. Switching the
  // theme therefore swaps the whole brand package, not just the accent color.
  const BRAND_PACKAGES = {
    cyan_signal: {
      label: 'Cyber Acoustic',
      // Precision acoustic octagon + waveform pulse arc
      frame: `<polygon points="20,4 44,4 60,20 60,44 44,60 20,60 4,44 4,20" stroke-width="1.9" opacity=".75"/>
        <path d="M12 32h5l3-7 4 14 4-10 3 6h5" stroke-width="1.35" opacity=".42"/>`,
    },
    ultraviolet: {
      label: 'Neural Orbit',
      // Tilted neural orbital ellipses + nodes
      frame: `<circle cx="32" cy="32" r="27.5" stroke-width="1.8" opacity=".68"/>
        <ellipse cx="32" cy="32" rx="28" ry="12" transform="rotate(-28 32 32)" stroke-width="1.3" opacity=".42"/>
        <circle cx="54" cy="20" r="2.3" fill="currentColor" opacity=".75"/>`,
    },
    aurora_field: {
      label: 'Bio Signal',
      // Sonar ripple concentric arcs
      frame: `<circle cx="32" cy="32" r="28" stroke-width="1.9" opacity=".72"/>
        <path d="M14 22a22 22 0 0 1 36 0M14 42a22 22 0 0 0 36 0" stroke-width="1.35" opacity=".42"/>`,
    },
    ember_pulse: {
      label: 'Analog Future',
      // Chamfered analog vu-meter chassis
      frame: `<rect x="4.5" y="4.5" width="55" height="55" rx="12" stroke-width="1.95" opacity=".74"/>
        <path d="M12 49c6-8 13-12 20-12s14 4 20 12" stroke-width="1.35" opacity=".42"/>`,
    },
    obsidian: {
      label: 'Nebula Orbit',
      // Broken orbital ring around the M
      frame: `<path d="M32 3.2A28.8 28.8 0 0 1 52.4 11.6" stroke-width="1.9" opacity=".55"/>
        <path d="M60.8 32a28.8 28.8 0 0 1-8.4 20.4" stroke-width="1.9" opacity=".55"/>
        <path d="M32 60.8a28.8 28.8 0 0 1-20.4-8.4" stroke-width="1.9" opacity=".55"/>
        <path d="M3.2 32A28.8 28.8 0 0 1 11.6 11.6" stroke-width="1.9" opacity=".55"/>`,
    },
    emerald: {
      label: 'Matrix Hex',
      // Hexagon containment
      frame: `<path d="M32 3.6 56.6 17.8v28.4L32 60.4 7.4 46.2V17.8z" stroke-width="1.9" opacity=".7"/>
        <path d="M32 9.5 51.5 20.8v22.4L32 54.5 12.5 43.2V20.8z" stroke-width="1.2" opacity=".3"/>`,
    },
    aurora: {
      label: 'Glacier Wave',
      // Squircle with a glacial wave
      frame: `<rect x="4" y="4" width="56" height="56" rx="17" stroke-width="1.9" opacity=".7"/>
        <path d="M10 45c6-6 10 4 16 0s10-8 16-2 8 2 12-2" stroke-width="1.6" opacity=".5"/>`,
    },
    crimson: {
      label: 'Molten Crest',
      // Heraldic shield
      frame: `<path d="M32 3.8 54.5 11.6v20.6c0 14.2-10.1 22.6-22.5 28-12.4-5.4-22.5-13.8-22.5-28V11.6z" stroke-width="1.9" opacity=".72"/>
        <path d="M32 9.6l17 5.9v16.7c0 10.6-7.6 17.2-17 21.6-9.4-4.4-17-11-17-21.6V15.5z" stroke-width="1.1" opacity=".28"/>`,
    },
    pearl: {
      label: 'Alabaster Ring',
      // Concentric circle
      frame: `<circle cx="32" cy="32" r="28" stroke-width="1.9" opacity=".72"/>
        <circle cx="32" cy="32" r="23" stroke-width="1.1" opacity=".3"/>`,
    },
    sakura: {
      label: 'Quartz Bloom',
      // Five-petal bloom
      frame: `<path d="M32 5c6.4 8 11.4 11.2 19 11.4-3.4 7.8-4.6 12.8-.6 19.6-8.6-1.6-13.4-.4-18.4 6.6-5-7-9.8-8.2-18.4-6.6 4-6.8 2.8-11.8-.6-19.6 7.6-.2 12.6-3.4 19-11.4z" stroke-width="1.9" opacity=".72"/>`,
    },
  };

  const THEME_BY_ID = (id) => APPEARANCE_THEMES.find((t) => t.id === id) || APPEARANCE_THEMES[0];

  function brandMarkSvg(meta, opts = {}) {
    const pkg = BRAND_PACKAGES[meta.id] || BRAND_PACKAGES.cyan_signal;
    const stroke = opts.thin ? 4.4 : 5.2;
    return `<svg viewBox="0 0 64 64" class="brand-mark-svg" aria-hidden="true" focusable="false">
      <g fill="none" stroke="${meta.dots[0]}" stroke-linecap="round" stroke-linejoin="round">
        ${pkg.frame}
        <path d="M20 46V20l12 14 12-14v26" stroke-width="${stroke}"/>
      </g>
    </svg>`;
  }

  function brandLogoApi() {
    return window.VACBrandLogos || null;
  }

  function brandIconHtml(meta) {
    const api = brandLogoApi();
    return api ? api.iconHtml(meta.id) : brandMarkSvg(meta);
  }

  function brandFullHtml(meta, opts = {}) {
    const api = brandLogoApi();
    return api ? api.fullHtml(meta.id, opts) : brandMarkSvg(meta, { thin: true });
  }

  /**
   * Mirrors call state onto the header banner's decorative waves. This sets a
   * data attribute consumed by CSS; it never starts a timer or animation loop.
   * The waves are decoration, not a meter of provider or microphone audio.
   */
  function syncBrandEnergy(level) {
    const api = brandLogoApi();
    const el = document.getElementById('brand-mark');
    if (!api || !el) return;
    if (el.dataset.energy === (level || '')) return;
    api.setEnergy(el, level);
  }

  function renderBrandMark() {
    const el = document.getElementById('brand-mark');
    if (!el) return;
    const meta = THEME_BY_ID(appearance.theme);
    el.classList.add('mma-brand-logo');
    el.innerHTML = brandFullHtml(meta, { alt: '' });
    el.dataset.pkg = meta.id;
    el.title = `${meta.name} · ${BRAND_PACKAGES[meta.id]?.label || 'Brand'}`;
  }

  function renderThemeLoaderLogo() {
    const el = document.getElementById('theme-loader-logo');
    if (!el) return;
    const meta = THEME_BY_ID(appearance.theme);
    el.innerHTML = brandFullHtml(meta);
    el.dataset.brandTheme = meta.id;
  }

  let appearance = (() => {
    try {
      const saved = JSON.parse(window.localStorage?.getItem(APPEARANCE_STORAGE_KEY) || '{}');
      return {
        theme: APPEARANCE_THEMES.some((t) => t.id === saved.theme) ? saved.theme : 'cyan_signal',
      };
    } catch {
      return { theme: 'cyan_signal' };
    }
  })();

  function applyAppearance(save = true) {
    const root = document.documentElement;
    root.dataset.theme = appearance.theme;
    if (save) {
      try {
        window.localStorage?.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(appearance));
        window.localStorage?.setItem('vac_appearance_v1', JSON.stringify(appearance));
      } catch {}
    }
    const meta = THEME_BY_ID(appearance.theme);
    const lbl = document.getElementById('theme-active-lbl');
    if (lbl) lbl.textContent = meta.short;
    const dot = document.getElementById('theme-active-dot');
    if (dot) dot.style.background = meta.dots[0];
    renderBrandMark();
    updateThemeFavicon(meta);
    renderThemeLoaderLogo();
    renderThemeStudioControls();
    if (typeof renderExecutiveCommandDeck === 'function' && S) {
      renderExecutiveCommandDeck();
    }
  }

  // Each theme is a complete brand package: the favicon is drawn from that
  // package's silhouette and palette whenever the theme changes.
  function updateThemeFavicon(meta) {
    try {
      const api = brandLogoApi();
      const href = api ? api.assetFor(meta.id).icon : './assets/favicon.svg';
      const type = api ? 'image/jpeg' : 'image/svg+xml';
      document.querySelectorAll('link[rel="icon"], link[rel="alternate icon"], link[rel="apple-touch-icon"]').forEach((link) => {
        link.type = type;
        link.href = href;
      });
      if (!document.querySelector('link[rel="icon"]')) {
        const link = document.createElement('link');
        link.rel = 'icon';
        link.type = type;
        link.href = href;
        document.head.appendChild(link);
      }
    } catch {}
  }

  function renderThemeStudioControls() {
    const activeIdx = Math.max(0, APPEARANCE_THEMES.findIndex((t) => t.id === appearance.theme));
    const activeMeta = APPEARANCE_THEMES[activeIdx] || APPEARANCE_THEMES[0];
    const hero = document.getElementById('theme-studio-hero');
    if (hero) {
      const numStr = String(activeIdx + 1).padStart(2, '0');
      const totalStr = String(APPEARANCE_THEMES.length).padStart(2, '0');
      hero.innerHTML = `
        <div>
          <div class="theme-hero-meta">
            <span class="theme-hero-kicker">CURRENT IDENTITY ${numStr} / ${totalStr}</span>
            <span class="pill">${esc(activeMeta.system || BRAND_PACKAGES[activeMeta.id]?.label || 'VISUAL SYSTEM')}</span>
          </div>
          <h4 class="theme-hero-title">
            <span class="theme-hero-logo" style="width:28px;height:28px;display:inline-flex">${brandIconHtml(activeMeta)}</span>
            <span>${esc(activeMeta.name)}</span>
          </h4>
          <p class="theme-hero-desc">${esc(activeMeta.desc || activeMeta.sub)}</p>
          <div class="theme-hero-tags">
            <span class="pill" style="font-size:10.5px">🎨 ${esc(activeMeta.sub)}</span>
            <span class="pill ok" style="font-size:10.5px">〰 ${esc(activeMeta.motif || BRAND_PACKAGES[activeMeta.id]?.label || 'Studio')}</span>
          </div>
        </div>
        <div class="theme-hero-actions">
          <button type="button" class="b" id="btn-theme-preview-loader">⚡ Preview Loader</button>
          <button type="button" class="g" id="btn-theme-download-kit">⬇ Download Theme Kit</button>
        </div>
      `;
    }

    const grid = document.getElementById('theme-swatch-grid');
    if (grid) {
      grid.innerHTML = APPEARANCE_THEMES.map(
        (t) => `
          <button type="button" class="theme-card ${appearance.theme === t.id ? 'on' : ''}" data-pick-theme="${t.id}">
            <div class="theme-sys-kicker">
              <span>${esc(t.code || 'THEME')}</span>
              <span>${esc((t.system || '').split('·')[0].trim())}</span>
            </div>
            <div class="theme-preview" style="background:${t.bg}">
              <span class="theme-preview-logo mma-brand-logo">${brandFullHtml(t, { lazy: true })}</span>
              <div class="theme-preview-dots">
                ${t.dots.map((c) => `<span style="background:${c}"></span>`).join('')}
              </div>
              <div class="theme-preview-bar" style="background:${t.dots[0]}"></div>
            </div>
            <div class="theme-name">
              <span>${esc(t.name)}</span>
              ${appearance.theme === t.id ? '<span class="pill ok" style="font-size:10px;padding:1px 6px">Active</span>' : ''}
            </div>
            <div class="theme-sub">${esc(t.sub)}</div>
            <div class="theme-motif-row">
              <span>${esc(BRAND_PACKAGES[t.id]?.label || '')}</span>
              <span class="theme-motif-badge">${esc(t.motif || 'Studio')}</span>
            </div>
          </button>
        `
      ).join('');
    }
  }

  applyAppearance(false);

  // ==================== SIDE COLLAPSIBLE CONTROL PANEL ====================
  const SIDEBAR_STORAGE_KEY = 'vac_sidebar_collapsed_v1';
  const NAV_ICONS = {
    dashboard: '<svg viewBox="0 0 24 24" focusable="false"><rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="5" rx="1.5"/><rect x="13" y="10" width="8" height="11" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/></svg>',
    agents: '<svg viewBox="0 0 24 24" focusable="false"><path d="M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-7A3.5 3.5 0 0 0 2 18.5V20"/><circle cx="9" cy="7.5" r="3.5"/><path d="M16 4.4a3.5 3.5 0 0 1 0 6.8M17 15h1.5a3.5 3.5 0 0 1 3.5 3.5V20"/></svg>',
    plugins: '<svg viewBox="0 0 24 24" focusable="false"><path d="M8 3.5a2.5 2.5 0 1 1 5 0V6h3.5A1.5 1.5 0 0 1 18 7.5V11h2.5a2.5 2.5 0 1 1 0 5H18v3.5a1.5 1.5 0 0 1-1.5 1.5H13v-2.5a2.5 2.5 0 1 0-5 0V21H4.5A1.5 1.5 0 0 1 3 19.5V16h2.5a2.5 2.5 0 1 0 0-5H3V7.5A1.5 1.5 0 0 1 4.5 6H8z"/></svg>',
    campaigns: '<svg viewBox="0 0 24 24" focusable="false"><path d="M3 11v2a2 2 0 0 0 2 2h2l8 4V5l-8 4H5a2 2 0 0 0-2 2z"/><path d="M7 15l1.5 5h3L10 16M18 9.5a4 4 0 0 1 0 5M20 7a7.5 7.5 0 0 1 0 10"/></svg>',
    voice: '<svg viewBox="0 0 24 24" focusable="false"><rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M5.5 10.5v1a6.5 6.5 0 0 0 13 0v-1M12 18v3.5M8.5 21.5h7M3 8v5M21 8v5"/></svg>',
    test: '<svg viewBox="0 0 24 24" focusable="false"><path d="M20.5 11.5a8.5 8.5 0 0 1-12.7 7.4L3 20l1.1-4.4A8.5 8.5 0 1 1 20.5 11.5z"/><path d="m10 8.5 5 3-5 3z"/></svg>',
    vici: '<svg viewBox="0 0 24 24" focusable="false"><path d="M4 13v-1a8 8 0 0 1 16 0v1M4 13H3a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h3v-7H4zM20 13h1a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-3v-7h2z"/><path d="M17 19a5 5 0 0 1-5 3h-2"/></svg>',
    wallboard: '<svg viewBox="0 0 24 24" focusable="false"><rect x="3" y="3" width="18" height="18" rx="2.5"/><path d="M7 16v-4M12 16V8M17 16v-6M6 18h12"/><path d="m6.5 9 4-2 3 2 4-3"/></svg>',
    export: '<svg viewBox="0 0 24 24" focusable="false"><path d="M12 3v11M8 10l4 4 4-4"/><path d="M4 16.5v3A1.5 1.5 0 0 0 5.5 21h13a1.5 1.5 0 0 0 1.5-1.5v-3"/><path d="M7 7V4.5A1.5 1.5 0 0 1 8.5 3H15l5 5v1"/></svg>',
  };
  const NAV_ITEMS = [
    { key: 'dashboard', icon: 'dashboard', label: 'Dashboard', sub: 'Executive Command & Overview', group: 'Overview' },
    { key: 'agents', icon: 'agents', label: 'Agents', sub: 'Personas, Speed & Barge-In', group: 'Studio Builder' },
    { key: 'plugins', icon: 'plugins', label: 'Plug-ins', sub: 'STT, Deepgram LLMs & TTS', group: 'Studio Builder' },
    { key: 'campaigns', icon: 'campaigns', label: 'Campaigns', sub: 'Dialer Rules & Transfers', group: 'Studio Builder' },
    { key: 'voice', icon: 'voice', label: 'Voice Lab', sub: '139 Flux v2 & Aura Voices', group: 'Studio Builder' },
    { key: 'test', icon: 'test', label: 'Live Bot', sub: 'Browser voice test', group: 'Live & Operations' },
    { key: 'vici', icon: 'vici', label: 'Vici Bridge', sub: 'SIP :5062 & AudioSocket', group: 'Live & Operations' },
    { key: 'wallboard', icon: 'wallboard', label: 'Wallboard', sub: 'KPIs & Stereo Recordings', group: 'Live & Operations' },
    { key: 'export', icon: 'export', label: 'Export', sub: 'Settings JSON & Backup', group: 'Live & Operations' },
  ];

  function sectionHref(target, selection = {}) {
    const key = SECTION_TABS.includes(target) ? target : 'dashboard';
    const params = new URLSearchParams({ tab: key });
    const agentId = selection.agentId ?? (S?.agents.some((agent) => agent.id === cur.a) ? cur.a : '');
    const campaignId = selection.campaignId ?? (S?.campaigns.some((campaign) => campaign.id === cur.c) ? cur.c : '');
    if (agentId && ['agents', 'voice', 'test'].includes(key)) params.set('agent', agentId);
    if (campaignId && key === 'campaigns') params.set('campaign', campaignId);
    if (selection.fleetCampaignId && key === 'dashboard') params.set('fleetCampaign', selection.fleetCampaignId);
    return `${window.location.pathname}?${params.toString()}`;
  }

  function rememberSectionUrl(target, selection = {}, replace = false) {
    try {
      const href = sectionHref(target, selection);
      if (`${window.location.pathname}${window.location.search}` !== href) {
        const owner = currentDraftOwnerId();
        const entry = { vacSection: true, ...(owner ? { [DRAFT_OWNER_STATE_KEY]: owner } : {}) };
        if (replace) window.history?.replaceState(entry, '', href);
        else window.history?.pushState(entry, '', href);
      }
    } catch {}
  }

  function navigateSection(target, selection = {}) {
    if (!S || !SECTION_TABS.includes(target)) return;
    stopAllAudio();
    if (selection.agentId && S.agents.some((agent) => agent.id === selection.agentId)) cur.a = selection.agentId;
    if (selection.campaignId && S.campaigns.some((campaign) => campaign.id === selection.campaignId)) cur.c = selection.campaignId;
    tab = target;
    if (tab === 'dashboard') {
      cmdDeckState.fleetCampaignId = S.campaigns.some((campaign) => campaign.id === selection.fleetCampaignId)
        ? selection.fleetCampaignId : null;
    }
    if (mobileRailOpen) {
      mobileRailOpen = false;
      applySidebarState(false);
    }
    hideRailTooltip();
    if (tab === 'voice') voiceCatalog.previewText = buildSettings(A()).agent.greeting || A().greeting;
    rememberSectionUrl(tab, selection);
    render();
    if (tab === 'dashboard' && cmdDeckState.fleetCampaignId) loadFleetCampaignStats(cmdDeckState.fleetCampaignId);
  }

  let sidebarCollapsed = (() => {
    try {
      return window.localStorage?.getItem(SIDEBAR_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  })();
  let mobileRailOpen = false;
  let railTipEl = null;

  function ensureRailTooltip() {
    if (!railTipEl && document.body) {
      railTipEl = document.createElement('div');
      railTipEl.id = 'rail-floating-tip';
      railTipEl.className = 'rail-floating-tip';
      document.body.appendChild(railTipEl);
    }
    return railTipEl;
  }

  function hideRailTooltip() {
    if (railTipEl) railTipEl.classList.remove('show');
  }

  function applySidebarState(save = false) {
    const shell = document.getElementById('app-shell');
    const backdrop = document.getElementById('rail-backdrop');
    const toggleBtn = document.getElementById('btn-sidebar-toggle');
    const chevron = document.getElementById('sidebar-toggle-chevron');
    const isMobile = Boolean(window.matchMedia && window.matchMedia('(max-width: 860px)').matches);
    const isExpanded = isMobile ? mobileRailOpen : !sidebarCollapsed;
    if (shell) {
      shell.classList.toggle('rail-collapsed', sidebarCollapsed);
      shell.classList.toggle('mobile-rail-open', mobileRailOpen);
    }
    if (backdrop) {
      backdrop.hidden = !mobileRailOpen;
    }
    if (toggleBtn) {
      toggleBtn.classList.toggle('is-collapsed', !isMobile && sidebarCollapsed);
      toggleBtn.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
      toggleBtn.title = isExpanded ? 'Collapse Side Menu (Ctrl+B)' : 'Expand Side Menu (Ctrl+B)';
    }
    if (chevron) {
      chevron.setAttribute('points', isExpanded ? '16 9 13 12 16 15' : '14 9 17 12 14 15');
    }
    // The phone opener lives outside the off-canvas rail so the drawer can
    // always be reopened; it mirrors the same expanded state.
    const mobileBtn = document.getElementById('btn-sidebar-toggle-mobile');
    const mobileChevron = document.getElementById('sidebar-toggle-chevron-mobile');
    if (mobileBtn) {
      mobileBtn.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
      mobileBtn.title = isExpanded ? 'Close Side Menu' : 'Open Side Menu';
      mobileBtn.setAttribute('aria-label', isExpanded ? 'Close Side Control Panel' : 'Open Side Control Panel');
    }
    if (mobileChevron) {
      mobileChevron.setAttribute('points', isExpanded ? '16 9 13 12 16 15' : '14 9 17 12 14 15');
    }
    hideRailTooltip();
    if (save) {
      try {
        window.localStorage?.setItem(SIDEBAR_STORAGE_KEY, sidebarCollapsed ? '1' : '0');
      } catch {}
    }
  }

  function toggleSidebar() {
    if (window.matchMedia && window.matchMedia('(max-width: 860px)').matches) {
      mobileRailOpen = !mobileRailOpen;
      applySidebarState(false);
    } else {
      sidebarCollapsed = !sidebarCollapsed;
      applySidebarState(true);
    }
  }

  function renderSideNav() {
    const navEl = document.getElementById('nav');
    if (!navEl) return;
    let isLiveCall = false;
    try {
      isLiveCall = Boolean(sim && (sim.active || sim.connecting));
    } catch {}
    let lastGroup = '';
    const html = [];
    for (const item of NAV_ITEMS) {
      if (item.group !== lastGroup) {
        if (lastGroup) html.push('<div class="nav-divider" aria-hidden="true"></div>');
        html.push(`<div class="nav-group-lbl">${esc(item.group)}</div>`);
        lastGroup = item.group;
      }
      const isOn = tab === item.key;
      const showDot = item.key === 'test' && isLiveCall;
      html.push(`
        <a href="${esc(sectionHref(item.key))}" data-t="${item.key}" class="nav-item ${isOn ? 'on' : ''}" data-tip-title="${esc(item.label)}" data-tip-sub="${esc(item.sub)}" aria-current="${isOn ? 'page' : 'false'}">
          <span class="nav-ico" aria-hidden="true">${NAV_ICONS[item.icon] || NAV_ICONS.agents}</span>
          <span class="nav-txt">
            <span class="nav-lbl">${esc(item.label)}</span>
            <span class="nav-sub">${esc(item.sub)}</span>
          </span>
          ${showDot ? '<span class="nav-live-dot" title="Live Voice Session Active"></span>' : ''}
        </a>
      `);
    }
    navEl.innerHTML = html.join('');

    const activeItem = NAV_ITEMS.find((i) => i.key === tab) || NAV_ITEMS[0];
    const crumbEl = document.getElementById('active-nav-crumb');
    if (crumbEl && activeItem) {
      crumbEl.textContent = activeItem.label;
    }
  }

  renderSideNav();
  applySidebarState(false);

  // The sticky header wraps on small screens. Keep the navigation rail below
  // its actual height, rather than covering its first items with the header.
  const consoleHeader = document.querySelector('header.console-header');
  const syncHeaderHeight = () => {
    if (consoleHeader) document.documentElement.style.setProperty('--console-header-height', `${Math.ceil(consoleHeader.getBoundingClientRect().height)}px`);
  };
  syncHeaderHeight();
  window.addEventListener('resize', syncHeaderHeight);
  // Crossing the off-canvas breakpoint changes what "expanded" means, so
  // re-sync the footer toggle and the phone opener on every transition.
  if (window.matchMedia) {
    const railMq = window.matchMedia('(max-width: 860px)');
    const onRailBreakpoint = () => {
      mobileRailOpen = false;
      applySidebarState(false);
      syncHeaderHeight();
    };
    if (typeof railMq.addEventListener === 'function') railMq.addEventListener('change', onRailBreakpoint);
    else if (typeof railMq.addListener === 'function') railMq.addListener(onRailBreakpoint);
  }
  if (consoleHeader && typeof ResizeObserver === 'function') new ResizeObserver(syncHeaderHeight).observe(consoleHeader);

  const railBackdropEl = document.getElementById('rail-backdrop');
  if (railBackdropEl) {
    railBackdropEl.addEventListener('click', () => {
      mobileRailOpen = false;
      applySidebarState(false);
    });
  }

  const sideNavHoverEl = document.getElementById('nav');
  if (sideNavHoverEl) {
    sideNavHoverEl.addEventListener('mouseover', (e) => {
      const btn = e.target.closest('.nav-item');
      if (!btn || !sidebarCollapsed || (window.matchMedia && window.matchMedia('(max-width: 860px)').matches)) {
        hideRailTooltip();
        return;
      }
      const tip = ensureRailTooltip();
      if (!tip) return;
      const rect = btn.getBoundingClientRect();
      tip.innerHTML = `${esc(btn.dataset.tipTitle || '')}<span class="tip-sub">${esc(btn.dataset.tipSub || '')}</span>`;
      tip.style.left = `${Math.round(rect.right + 12)}px`;
      tip.style.top = `${Math.round(rect.top + rect.height / 2 - 20)}px`;
      tip.classList.add('show');
    });
    sideNavHoverEl.addEventListener('mouseleave', hideRailTooltip);
  }

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'b' || e.key === 'B')) {
      e.preventDefault();
      toggleSidebar();
    } else if (e.key === 'Escape' && mobileRailOpen) {
      mobileRailOpen = false;
      applySidebarState(false);
    }
  });

  function readCloudSecrets() {
    try {
      const raw = window.localStorage?.getItem(CLOUD_SECRETS_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return isPlainObject(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function writeCloudSecrets(patch, replaceAll = false) {
    try {
      const curSec = replaceAll ? {} : readCloudSecrets();
      for (const [k, v] of Object.entries(patch)) {
        const clean = String(v ?? '').trim().replace(/^(Token|Bearer)\s+/i, '');
        if (clean) curSec[k] = clean;
        else delete curSec[k];
      }
      window.localStorage?.setItem(CLOUD_SECRETS_KEY, JSON.stringify(curSec));
    } catch {}
  }

  function buildCloudSecretsStatus() {
    const sec = readCloudSecrets();
    const keys = [
      'DEEPGRAM_API_KEY',
      'SPEECH_SERVICE_URL',
      'SPEECH_SERVICE_API_KEY',
      'ELEVENLABS_API_KEY',
      'CARTESIA_API_KEY',
      'OPENAI_API_KEY',
      'GROQ_API_KEY',
      'VICI_API_PASS',
      'AMI_SECRET',
      'CUSTOM_WEBHOOK_SECRET',
      'ADMIN_PASSWORD',
      'BRIDGE_ALLOWED_IPS',
    ];
    const out = {};
    for (const k of keys) {
      const v = String(sec[k] || '');
      out[k] = {
        configured: v.length > 0,
        masked: v.length > 8 ? `${v.slice(0, 4)}••••${v.slice(-4)}` : v ? '••••••••' : '',
      };
    }
    return out;
  }

  // Bootstrap #dgkey=... URL hash privately into localStorage (never sent over HTTP)
  (() => {
    try {
      const h = String(window.location.hash || '');
      if (h.includes('dgkey=')) {
        const params = new URLSearchParams(h.replace(/^#/, ''));
        const k = params.get('dgkey');
        if (k && k.trim().length > 10) {
          writeCloudSecrets({ DEEPGRAM_API_KEY: k.trim() });
          window.history?.replaceState(null, '', window.location.pathname + window.location.search);
        }
      }
    } catch {}
  })();

  const VOICE_AGENT_STT_MODELS = ['nova-3', 'flux-general-en', 'flux-general-multi'];
  function defaultSelfIntroForClient(id, name) {
    return window.VacPersona.defaultSelfIntro(id, name);
  }


  function upgradeRealtimeAgentFeatures(state, shippedState = null) {
    if (!state || !Array.isArray(state.agents)) return false;
    let mutated = false;

    const xferFn = state.functions?.find((f) => f.name === 'transfer_to_live_agent')?.id;
    const dispoFn = state.functions?.find((f) => f.name === 'set_disposition')?.id;
    const endFn = state.functions?.find((f) => f.name === 'end_call')?.id;

    // Global service channels are deliberately empty on migration; operators must select and save them.
    if (!state.services || typeof state.services !== 'object') {
      state.services = {
        stt: { providerId: '', model: '' },
        llm: { providerId: '', model: '' },
        tts: { providerId: '', model: '' },
      };
      mutated = true;
    }
    for (const kind of ['stt', 'llm', 'tts']) {
      if (!state.services[kind] || typeof state.services[kind] !== 'object') {
        state.services[kind] = { providerId: '', model: '' };
        mutated = true;
      }
      const selection = state.services[kind];
      const provider = (state.providers || []).find((p) => p.kind === kind && p.id === selection.providerId);
      const models = kind === 'stt'
        ? VOICE_AGENT_STT_MODELS
        : kind === 'llm'
        ? provider ? dgLlmModelIdsForType(provider.type) : []
        : provider ? (provider.models || '').split(',').map((x) => x.trim()).filter(Boolean) : [];
      if (
        kind === 'tts' &&
        provider &&
        provider.type === 'deepgram' &&
        /^(flux|aura)-/i.test(String(selection.model || '')) &&
        !models.includes(String(selection.model || ''))
      ) {
        models.push(String(selection.model));
        provider.models = models.join(',');
        mutated = true;
      }
      if (!provider || !models.includes(String(selection.model || ''))) {
        if (selection.providerId || selection.model) mutated = true;
        selection.providerId = '';
        selection.model = '';
      }
    }

    // Deepgram Voice Agent listen models: Nova-3 baseline plus Flux v2.
    const sttProviders = (state.providers || []).filter((p) => p.kind === 'stt');
    for (const provider of sttProviders) {
      if (provider.type !== 'deepgram') {
        provider.type = 'deepgram';
        mutated = true;
      }
      const allowed = VOICE_AGENT_STT_MODELS.join(',');
      if (provider.models !== allowed) {
        provider.models = allowed;
        mutated = true;
      }
    }
    for (const agent of state.agents) {
      if (!agent.stt || typeof agent.stt !== 'object') {
        agent.stt = { keyterms: '', eot: 0.55, eager: 0.35, eotms: 2000, smartFormat: false };
        mutated = true;
      }
      for (const key of ['p', 'model']) {
        if (Object.prototype.hasOwnProperty.call(agent.stt, key)) {
          delete agent.stt[key];
          mutated = true;
        }
      }
      agent.stt.keyterms ??= '';
      agent.stt.eot ??= 0.55;
      agent.stt.eager ??= 0.35;
      agent.stt.eotms ??= 2000;
      agent.stt.smartFormat ??= false;

      if (!agent.llm || typeof agent.llm !== 'object') {
        agent.llm = { temp: 0.7, reasoning: 'low' };
        mutated = true;
      }
      for (const key of ['p', 'model', 'ctx']) {
        if (Object.prototype.hasOwnProperty.call(agent.llm, key)) {
          delete agent.llm[key];
          mutated = true;
        }
      }
      agent.llm.temp ??= 0.7;
      if (!['low', 'medium', 'high'].includes(agent.llm.reasoning)) agent.llm.reasoning = 'low';

      if (!agent.tts || typeof agent.tts !== 'object') {
        agent.tts = { speed: 1, expr: 0 };
        mutated = true;
      }
      for (const key of ['p', 'model']) {
        if (Object.prototype.hasOwnProperty.call(agent.tts, key)) {
          delete agent.tts[key];
          mutated = true;
        }
      }
      agent.tts.speed ??= 1;
      agent.tts.expr ??= 0;
    }

    // Ensure built-in Nova Live Concierge exists for existing localStorage users (one-time seed)
    if (!state._novaSeededV26 && !state.agents.some((a) => a.id === 'a_nova')) {
      state._novaSeededV26 = true;
      state.agents.push({
        id: 'a_nova',
        name: 'Nova — Expressive Live Concierge & General Q&A',
        mode: 'both',
        language: 'en',
        greeting:
          "Hey there! This is Nova on the line. How are you doing today?",
        prompt:
          'You are Nova, a warm, witty AI voice assistant and concierge.\n' +
          'Core Capabilities:\n' +
          '1) Natural Self-Introduction: Introduce yourself warmly as Nova and answer honestly that you are an AI assistant if asked.\n' +
          '2) Identity: Never claim to be a human or say a tool action succeeded unless it actually did.\n' +
          '3) Universal General Q&A: Answer ANY general question — science, world facts, history, math, technology, travel, advice, definitions, or casual small talk — accurately, clearly, and conversationally.\n' +
          '4) Ultra-Fast Spoken Cadence: Lead with the direct answer or warm reaction in the very first words. Keep responses crisp (1–2 natural spoken sentences, around 15–35 words unless the caller asks for deeper detail).\n' +
          '5) Expressive Human Presence: Use natural spoken warmth, enthusiasm, empathy, and conversational micro-gestures ("Oh, great question!", "Gotcha — here is how that works:", "Haha, I love that one!") without ever writing bracketed stage directions.\n' +
          '6) Live Specialist Transfer: Whenever the caller asks to speak with a live specialist, closer, or supervisor, or confirms qualification for a benefit/coverage review, call set_disposition with code "XFER" and call transfer_to_live_agent.\n' +
          '7) Do-Not-Call (DNC) & Call Control: If the caller says stop, take me off your list, or do not call, apologize politely, call set_disposition with code "DNC", and call end_call immediately. If the caller says goodbye or asks to hang up, wish them a wonderful day and call end_call.',
        acceptViciCalls: true,
        injectCampaignDisclosure: false,
        behavior: {
          bargeIn: 'instant',
          bargeInSensitivity: 'balanced',
          latencyProfile: 'ultra',
          expressionStyle: 'energetic_upbeat',
          vocalGestures: true,
          allowGeneralQa: true,
          selfIntro: defaultSelfIntroForClient('a_nova', 'Nova'),
        },
        stt: {
          keyterms: 'Nova, introduce yourself, human',
          eot: 0.55,
          eager: 0.35,
          eotms: 1800,
          smartFormat: false,
        },
        llm: {
          temp: 0.65,
          reasoning: 'low',
        },
        tts: {
          speed: 1.05,
          expr: 1,
        },
        audio: {
          inEnc: 'linear16',
          inRate: 8000,
          outEnc: 'linear16',
          outRate: 8000,
        },
        fnIds: [xferFn, dispoFn, endFn].filter(Boolean),
      });
      if (!state.tests) state.tests = {};
      if (!Array.isArray(state.tests.a_nova)) {
        state.tests.a_nova = [
          {
            id: 'tn_1',
            s: 'Are you a robot or a real human?',
            e: 'Answers honestly that Nova is an AI voice assistant.',
            r: 'p',
            n: '',
          },
          {
            id: 'tn_2',
            s: 'Hi! Who are you? Please introduce yourself and tell me what you can help with.',
            e: 'Warm, truthful self-introduction as Nova, an AI assistant.',
            r: 'p',
            n: '',
          },
          {
            id: 'tn_3',
            s: 'Quick general question: why is the sky blue and what is 18 times 15?',
            e: 'Answers both general questions accurately in 1–2 spoken sentences',
            r: 'p',
            n: '',
          },
        ];
      }
      mutated = true;
    }

    for (const ag of state.agents) {
      const migratedOpening = window.VacOpening.migrateStockOpening(ag.greeting);
      if (migratedOpening !== ag.greeting) { ag.greeting = migratedOpening; mutated = true; }
      if (typeof ag.injectCampaignDisclosure !== 'boolean') {
        ag.injectCampaignDisclosure = false;
        mutated = true;
      }
      if (typeof ag.randomGreetingEnabled !== 'boolean') {
        ag.randomGreetingEnabled = true;
        mutated = true;
      }
      const isNova = ag.id === 'a_nova' || /nova.*concierge/i.test(ag.name || '');
      if (!Array.isArray(ag.fnIds)) {
        ag.fnIds = [xferFn, dispoFn, endFn].filter(Boolean);
        mutated = true;
      }
      if (isNova) {
        for (const reqFn of [xferFn, dispoFn, endFn]) {
          if (reqFn && !ag.fnIds.includes(reqFn)) {
            ag.fnIds.push(reqFn);
            mutated = true;
          }
        }
        if (!ag.acceptViciCalls) {
          ag.acceptViciCalls = true;
          mutated = true;
        }
      }

      if (typeof ag.prompt === 'string' && ag.prompt.trim().length > 0) {
        if (xferFn && ag.fnIds.includes(xferFn) && !/transfer_to_live_agent/i.test(ag.prompt)) {
          ag.prompt =
            ag.prompt.trim() +
            '\n- Live Specialist Transfer: Once the caller confirms qualification or asks to speak with a specialist, call set_disposition with code "XFER" and call transfer_to_live_agent.';
          mutated = true;
        }
        if (!/(dnc|do not call|take me off|stop)/i.test(ag.prompt)) {
          ag.prompt =
            ag.prompt.trim() +
            '\n- Do-Not-Call (DNC) Compliance: If the caller says stop, take me off your list, or do not call, apologize politely, call set_disposition with code "DNC", and call end_call immediately.';
          mutated = true;
        }
      }

      if (!ag.audio || typeof ag.audio !== 'object') {
        ag.audio = { inEnc: 'linear16', inRate: 8000, outEnc: 'linear16', outRate: 8000 };
        mutated = true;
      } else if (Number(ag.audio.inRate) !== 8000) {
        ag.audio.inRate = 8000;
        ag.audio.outRate = 8000;
        mutated = true;
      }

      if (!ag.behavior || typeof ag.behavior !== 'object') {
        ag.behavior = {
          bargeIn: 'instant',
          bargeInSensitivity: 'balanced',
          latencyProfile: 'ultra',
          expressionStyle: ag.id === 'a_nova' ? 'energetic_upbeat' : 'warm_empathetic',
          vocalGestures: true,
          allowGeneralQa: true,
          selfIntro: window.VacPersona.migrateLegacySelfIntro(ag.behavior?.selfIntro, ag.id, ag.name),
        };
        // Upgrade sluggish v2.4/v2.5 defaults to ultra-low latency & expressive Flux v2 prosody
        if (ag.stt && ag.stt.eot >= 0.65 && ag.stt.eotms >= 2000) {
          ag.stt.eot = 0.55;
          ag.stt.eager = 0.35;
          ag.stt.eotms = 1800;
        }
        if (ag.tts && Number(ag.tts.expr) === 0 && Number(ag.tts.speed) === 1) {
          ag.tts.expr = 1;
          ag.tts.speed = 1.05;
        }
        mutated = true;
      } else {
        if (!['instant', 'server', 'off'].includes(ag.behavior.bargeIn)) ag.behavior.bargeIn = 'instant';
        if (!['high', 'balanced', 'low'].includes(ag.behavior.bargeInSensitivity)) ag.behavior.bargeInSensitivity = 'balanced';
        if (!['ultra', 'balanced', 'quality'].includes(ag.behavior.latencyProfile)) ag.behavior.latencyProfile = 'ultra';
        if (!['warm_empathetic', 'energetic_upbeat', 'charismatic_closer', 'calm_concierge'].includes(ag.behavior.expressionStyle)) {
          ag.behavior.expressionStyle = 'warm_empathetic';
        }
        if (ag.behavior.vocalGestures === undefined) ag.behavior.vocalGestures = true;
        if (ag.behavior.allowGeneralQa === undefined) ag.behavior.allowGeneralQa = true;
        const migratedIntro = window.VacPersona.migrateLegacySelfIntro(ag.behavior.selfIntro, ag.id, ag.name);
        if (migratedIntro !== ag.behavior.selfIntro) { ag.behavior.selfIntro = migratedIntro; mutated = true; }
      }
    }

    if (Array.isArray(state.campaigns)) {
      for (const cp of state.campaigns) {
        if (!String(cp.disclosure || '').trim()) {
          cp.disclosure = /medicare/i.test(cp.name || '')
            ? 'This call may be recorded for quality and benefit verification.'
            : 'This call may be recorded for quality purposes.';
          mutated = true;
        }
        if (typeof cp.viciCampaign !== 'string') {
          cp.viciCampaign = '';
          mutated = true;
        }
        if (typeof cp.xferTarget !== 'string') {
          cp.xferTarget = '';
          mutated = true;
        }
        if (cp.dnc === undefined) {
          cp.dnc = true;
          mutated = true;
        }
        const assignment = { agentId: cp.agentId, agentIds: cp.agentIds };
        const valid = new Set((state.agents || []).map((agent) => agent.id));
        const ids = [...new Set([String(assignment.agentId || ''), ...(Array.isArray(assignment.agentIds) ? assignment.agentIds : [])].filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim()))].filter((id) => valid.has(id));
        const primary = ids.includes(String(assignment.agentId || '')) ? String(assignment.agentId || '') : ids[0] || '';
        const normalizedIds = primary ? [primary, ...ids.filter((id) => id !== primary)] : [];
        if (cp.agentId !== primary || JSON.stringify(cp.agentIds) !== JSON.stringify(normalizedIds)) {
          cp.agentId = primary; cp.agentIds = normalizedIds; mutated = true;
        }
        if (typeof cp.complianceRules !== 'string') {
          cp.complianceRules = MISSING_CAMPAIGN_RULES;
          mutated = true;
        } else {
          const stockRules = shippedState?.campaigns?.find((entry) => entry.id === cp.id)?.complianceRules || '';
          const migratedRules = window.VacPersona.migrateLegacyCampaignRules(cp.complianceRules, stockRules, cp.id);
          if (migratedRules !== cp.complianceRules) { cp.complianceRules = migratedRules; mutated = true; }
        }
        // Remove retired automatic-silence settings from saved browser state.
        // The operator's general disposition list and all other fields stay intact.
        for (const key of ['presenceCheckText', 'deadAirTimeoutSec', 'deadAirDisposition', 'deadAirDispositionVerified']) {
          if (Object.prototype.hasOwnProperty.call(cp, key)) { delete cp[key]; mutated = true; }
        }
      }
      // Missing campaign assignments stay visible and block calls; never generate a
      // campaign for a bot behind the operator's back.
    }

    if (Array.isArray(state.providers)) {
      if (!state.providers.some((p) => p.kind === 'stt' && p.type === 'speech_service')) {
        state.providers.push({
          id: 's_local',
          kind: 'stt',
          name: 'Local Speech Service (Faster-Whisper STT)',
          type: 'speech_service',
          models: 'large-v3-turbo,whisper-1',
          endpoint: '{{SPEECH_SERVICE_URL}}/v1/audio/transcriptions',
          headers: '{"Authorization":"Bearer {{SPEECH_SERVICE_API_KEY}}"}',
          extra: '{}',
          mk: 'model',
        });
        mutated = true;
      }
      if (!state.providers.some((p) => p.kind === 'tts' && p.type === 'speech_service')) {
        state.providers.push({
          id: 't_local',
          kind: 'tts',
          name: 'Local Speech Service (Kokoro + Cloned Voices)',
          type: 'speech_service',
          models:
            'af_heart,af_alloy,af_aoede,af_bella,af_jessica,af_kore,af_nicole,af_nova,af_river,af_sarah,af_sky,am_adam,am_echo,am_eric,am_fenrir,am_liam,am_michael,am_onyx,am_puck,am_santa,bf_alice,bf_emma,bf_isabella,bf_lily,bm_daniel,bm_fable,bm_george,bm_lewis',
          endpoint: '{{SPEECH_SERVICE_URL}}/v1/audio/speech',
          headers: '{"Authorization":"Bearer {{SPEECH_SERVICE_API_KEY}}"}',
          extra: '{}',
          mk: 'model',
        });
        mutated = true;
      }
    }

    return mutated;
  }

  // The server exposes its SQLite catalog; static hosting ships the same
  // CSV-derived rows and keeps its independent per-agent cursor in IndexedDB.
  const greetingCatalog = { rows: [], loaded: false, pending: null, error: '', query: '', page: 0 };
  const fallbackGreetingRotations = new Map();

  async function ensureGreetingCatalogLoaded() {
    if (greetingCatalog.loaded) return greetingCatalog.rows;
    if (greetingCatalog.pending) return greetingCatalog.pending;
    greetingCatalog.error = '';
    greetingCatalog.pending = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch(serverlessCloudMode ? './greetings.json' : '/api/greetings', { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const rows = data?.greetings;
        const fields = ['greeting_id', 'persona', 'context', 'greeting_text', 'tone'];
        const ids = new Set();
        if (!Array.isArray(rows) || !rows.length || rows.some((row) => {
          if (!row || fields.some((key) => typeof row[key] !== 'string' || !row[key].trim()) || ids.has(row.greeting_id)) return true;
          ids.add(row.greeting_id);
          return false;
        })) throw new Error('The greeting catalog is empty or invalid');
        greetingCatalog.rows = rows;
        greetingCatalog.loaded = true;
        return rows;
      } catch (err) {
        greetingCatalog.error = err.message || 'Could not load the greeting catalog';
        return [];
      } finally {
        clearTimeout(timer);
        greetingCatalog.pending = null;
        const panel = document.getElementById('greeting-catalog-panel');
        if (panel) panel.innerHTML = renderGreetingCatalog();
      }
    })();
    return greetingCatalog.pending;
  }

  function renderGreetingResults() {
    const query = greetingCatalog.query.trim().toLowerCase();
    const filtered = greetingCatalog.rows.filter((row) =>
      ['greeting_id', 'persona', 'context', 'greeting_text', 'tone'].some((key) => row[key].toLowerCase().includes(query))
    );
    const size = 20;
    const pages = Math.max(1, Math.ceil(filtered.length / size));
    greetingCatalog.page = Math.max(0, Math.min(greetingCatalog.page, pages - 1));
    const visible = filtered.slice(greetingCatalog.page * size, (greetingCatalog.page + 1) * size);
    return `<div class="note" aria-live="polite">${filtered.length} matching greeting(s) · page ${greetingCatalog.page + 1} of ${pages}</div>
      ${visible.map((row) => `<div class="t" style="margin:6px 0">
        <b>#${esc(row.greeting_id)}</b> · ${esc(row.persona)} · ${esc(row.context)} · Tone: ${esc(row.tone)}
        <div>${esc(row.greeting_text)}</div>
      </div>`).join('')}
      <div class="bar" style="margin:8px 0">
        <button type="button" class="g" data-greeting-page="prev" ${greetingCatalog.page === 0 ? 'disabled' : ''}>Previous</button>
        <button type="button" class="g" data-greeting-page="next" ${greetingCatalog.page >= pages - 1 ? 'disabled' : ''}>Next</button>
      </div>`;
  }

  function renderGreetingCatalog() {
    if (greetingCatalog.error) return `<div class="note er">Could not load the greeting library in this view: ${esc(greetingCatalog.error)}. ${serverlessCloudMode ? 'Static-site tests will use the saved opening.' : 'Server call rotation cannot be confirmed from this view.'} <button type="button" class="g" id="retry-greeting-catalog">Retry</button></div>`;
    if (!greetingCatalog.loaded) return '<div class="note">Loading greeting library…</div>';
    return `<div class="note"><b>${greetingCatalog.rows.length.toLocaleString()} imported greetings</b> available to every bot. ${serverlessCloudMode ? 'Rotation is local to this browser profile.' : 'Server calls and browser tests share a per-bot rotation.'}</div>
      <details><summary>Browse imported greetings</summary>
        <label for="greeting-search">Search ID, persona, context, greeting, or tone</label>
        <input type="search" id="greeting-search" value="${esc(greetingCatalog.query)}" placeholder="Search the greeting library">
        <div id="greeting-results">${renderGreetingResults()}</div>
      </details>`;
  }

  function drawStaticGreeting(previous, rows, savedOpening) {
    const ids = rows.map((row) => row.greeting_id);
    const byId = new Map(rows.map((row) => [row.greeting_id, row]));
    const fingerprint = ids.join('\u001f');
    const validIds = new Set(ids);
    const sameCatalog = previous?.fingerprint === fingerprint && Array.isArray(previous.remaining);
    let remaining = sameCatalog ? [...new Set(previous.remaining.filter((id) => validIds.has(id)))] : [];
    const newCycle = remaining.length === 0;
    if (newCycle) remaining = ids.slice();
    let candidates = newCycle && remaining.length > 1 && previous?.last
      ? remaining.filter((id) => id !== previous.last) : remaining;
    const lastRow = byId.get(previous?.last);
    if (savedOpening && lastRow) {
      const prior = window.VacOpening.composeOpening(savedOpening, lastRow.greeting_text, false, '');
      const different = candidates.filter((id) =>
        window.VacOpening.composeOpening(savedOpening, byId.get(id).greeting_text, false, '') !== prior);
      if (different.length) candidates = different;
    }
    const selectedId = candidates[Math.floor(Math.random() * candidates.length)];
    remaining.splice(remaining.indexOf(selectedId), 1);
    return {
      row: byId.get(selectedId),
      state: { fingerprint, remaining, last: selectedId },
    };
  }

  function openGreetingRotationDb() {
    return new Promise((resolve, reject) => {
      let request;
      try {
        if (!window.indexedDB) throw new Error('IndexedDB is unavailable');
        request = window.indexedDB.open('vac-greeting-rotation-v1', 1);
      } catch (err) { reject(err); return; }
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) { settled = true; reject(new Error('Greeting storage timed out')); }
      }, 3000);
      const fail = () => {
        if (!settled) { settled = true; clearTimeout(timer); reject(request.error || new Error('Greeting storage unavailable')); }
      };
      request.onupgradeneeded = () => request.result.createObjectStore('rotations');
      request.onerror = fail;
      request.onblocked = fail;
      request.onsuccess = () => {
        if (settled) { request.result.close(); return; }
        settled = true;
        clearTimeout(timer);
        resolve(request.result);
      };
    });
  }

  async function selectStaticGreeting(agentId, rows, savedOpening) {
    if (!rows.length) return { row: null, storageWarning: false };
    let db;
    try {
      db = await openGreetingRotationDb();
      const row = await new Promise((resolve, reject) => {
        const tx = db.transaction('rotations', 'readwrite');
        const store = tx.objectStore('rotations');
        const request = store.get(agentId);
        let chosen = null;
        request.onsuccess = () => {
          const draw = drawStaticGreeting(request.result, rows, savedOpening);
          chosen = draw.row;
          store.put(draw.state, agentId);
        };
        tx.oncomplete = () => resolve(chosen);
        tx.onerror = () => reject(tx.error || new Error('Could not save greeting rotation'));
        tx.onabort = () => reject(tx.error || new Error('Greeting rotation was aborted'));
      });
      return { row, storageWarning: false };
    } catch {
      // In private/blocked storage, preserve a no-repeat cycle in this tab only.
      const draw = drawStaticGreeting(fallbackGreetingRotations.get(agentId), rows, savedOpening);
      fallbackGreetingRotations.set(agentId, draw.state);
      return { row: draw.row, storageWarning: true };
    } finally {
      if (db) db.close();
    }
  }

  // Live Call Simulator state (Step 2)
  let sim = {
    active: false,
    connecting: false,
    muted: false,
    micEnabled: true,
    allowWebhooks: false, // Explicit consent required for each browser test session
    recordAudio: false, // Explicit opt-in; reset after every test
    recording: null,
    recordingSaving: false,
    recordingFallback: null,
    recordingError: '',
    recordingUrls: new Map(),
    recordingLoadVersions: new Map(),
    callId: '',
    campaignId: '',
    campaignAgentId: '',
    logSaved: null,
    selectedGreeting: null,
    bandwidth: 'wideband', // 'wideband' (16k/24k) or 'telephony' (8k/8k)
    lead: {
      lead_id: '104892',
      first_name: 'Robert',
      phone_number: '+13055550192',
      state: 'FL',
      age: '64',
    },
    statusText: 'Idle — Ready to test',
    agentState: 'idle',
    lastError: null,
    diagRunning: false,
    diagResult: null,
    startedAtMs: 0,
    elapsedSec: 0,
    turns: 0,
    bargeInCount: 0,
    bargeInSuppressAudio: false,
    vadConsecutiveFrames: 0,
    lastLocalBargeInAt: 0,
    lastTtfbMs: null,
    avgTtfbMs: null,
    lastLlmMs: null,
    disposition: null,
    transferredTo: null,
    events: [], // { kind: 'msg'|'fn', ... }
    sessionSettings: null,
    ws: null,
    micStream: null,
    captureCtx: null,
    captureProcessor: null,
    micNodes: null,
    micWatchdog: null,
    micDevices: [],
    micDeviceId: '',
    micGain: 2.0,
    micActiveLabel: '',
    micTxBytes: 0,
    micPeakPct: 0,
    micResampler: {},
    playCtx: null,
    scheduledSources: [],
    nextPlayTime: 0,
    sampleRateIn: 16000,
    sampleRateOut: 24000,
    durationTimer: null,
    drainTimer: null,
    hangupTimer: null,
    sessionAttemptId: 0,
    callLogs: [],
    logsLoadedForAgent: null,
    logsError: null,
    logsRequestId: 0,
    historyExpanded: false,
  };

  // Browser-only recordings on static hosts are kept in IndexedDB, separate
  // from cloud accounts and from the server-backed test history.
  const LOCAL_RECORDING_DB = 'vac-live-bot-recordings-v1';
  const LOCAL_RECORDING_LIMIT = 20;
  const RECORDING_MAX_MS = 10 * 60 * 1000;
  const RECORDING_MAX_BYTES = 20 * 1024 * 1024;
  const RECORDING_SOFT_BYTES = 19 * 1024 * 1024;

  function openLocalRecordingDb() {
    return new Promise((resolve, reject) => {
      let req;
      try {
        if (!window.indexedDB) throw new Error('Browser storage is unavailable');
        req = window.indexedDB.open(LOCAL_RECORDING_DB, 1);
      } catch (err) { reject(err); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('logs')) db.createObjectStore('logs', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Could not open browser recording storage'));
      req.onblocked = () => reject(new Error('Browser recording storage is blocked'));
    });
  }

  async function localRecordingTransaction(stores, mode, schedule) {
    const db = await openLocalRecordingDb();
    return new Promise((resolve, reject) => {
      let result;
      let tx;
      try {
        tx = db.transaction(stores, mode);
        schedule(tx, (value) => { result = value; });
      } catch (err) { db.close(); reject(err); return; }
      tx.oncomplete = () => { db.close(); resolve(result); };
      tx.onabort = tx.onerror = () => { const err = tx.error || new Error('Browser storage transaction failed'); db.close(); reject(err); };
    });
  }

  function listLocalRecordedTests() {
    return localRecordingTransaction(['logs'], 'readonly', (tx, done) => {
      const req = tx.objectStore('logs').getAll();
      req.onsuccess = () => done(req.result || []);
    });
  }

  function saveLocalRecordedTest(log, blob) {
    return localRecordingTransaction(['logs', 'audio'], 'readwrite', (tx) => {
      const logs = tx.objectStore('logs');
      const audio = tx.objectStore('audio');
      const req = logs.getAll();
      req.onsuccess = () => {
        logs.put(log);
        audio.put({ id: log.id, blob });
        const ordered = [log, ...req.result.filter((item) => item.id !== log.id)]
          .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
        for (const old of ordered.slice(LOCAL_RECORDING_LIMIT)) {
          logs.delete(old.id);
          audio.delete(old.id);
        }
      };
    });
  }

  function getLocalRecording(id) {
    return localRecordingTransaction(['audio'], 'readonly', (tx, done) => {
      const req = tx.objectStore('audio').get(id);
      req.onsuccess = () => done(req.result?.blob || null);
    });
  }

  function deleteLocalRecording(id) {
    return localRecordingTransaction(['logs', 'audio'], 'readwrite', (tx) => {
      const logs = tx.objectStore('logs');
      const req = logs.get(id);
      req.onsuccess = () => {
        if (req.result) logs.put({ ...req.result, recordingStatus: 'deleted', recordingBytes: 0 });
        tx.objectStore('audio').delete(id);
      };
    });
  }

  function clearLocalRecordedTests(agentId) {
    return localRecordingTransaction(['logs', 'audio'], 'readwrite', (tx) => {
      const logs = tx.objectStore('logs');
      const audio = tx.objectStore('audio');
      const req = logs.getAll();
      req.onsuccess = () => {
        for (const item of req.result) {
          if (!agentId || item.agentId === agentId) { logs.delete(item.id); audio.delete(item.id); }
        }
      };
    });
  }

  function revokeRecordingUrl(id) {
    // Also invalidate an in-flight fetch so a deleted recording cannot be
    // reintroduced into this view after its response arrives.
    sim.recordingLoadVersions.set(id, (sim.recordingLoadVersions.get(id) || 0) + 1);
    const url = sim.recordingUrls.get(id);
    if (url) URL.revokeObjectURL(url);
    sim.recordingUrls.delete(id);
  }

  function recordingExtension(mime) {
    return String(mime || '').startsWith('audio/ogg') ? 'ogg' : String(mime || '').startsWith('audio/mp4') ? 'm4a' : 'webm';
  }

  function recordingMime() {
    if (!window.MediaRecorder || typeof window.MediaRecorder.isTypeSupported !== 'function') return '';
    return ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4']
      .find((type) => window.MediaRecorder.isTypeSupported(type)) || '';
  }

  function disconnectRecordingMic(ctx = sim.recording) {
    if (!ctx?.micSource) return;
    try { ctx.micSource.disconnect(); } catch {}
    ctx.micSource = null;
  }

  function connectRecordingMic(ctx = sim.recording) {
    if (!ctx) return;
    disconnectRecordingMic(ctx);
    if (sim.micStream && sim.playCtx && ctx.recorder.state !== 'inactive') {
      ctx.micSource = sim.playCtx.createMediaStreamSource(sim.micStream);
      ctx.micSource.connect(ctx.destination);
    }
  }

  function warnRecording(ctx, message) {
    if (ctx.warned) return;
    ctx.warned = true;
    sim.events.push({ kind: 'msg', role: 'system', content: message });
    renderSimFeedDom();
  }

  function stopRecordingAtLimit(ctx) {
    if (!ctx || ctx.recorder.state === 'inactive') return;
    ctx.truncated = true;
    warnRecording(ctx, 'The recording reached its 10-minute or size limit. The test continues, but later audio is not recorded.');
    try { ctx.recorder.stop(); } catch {}
  }

  function prepareBrowserRecording(agent) {
    const mime = recordingMime();
    if (!mime || !sim.playCtx?.createMediaStreamDestination) {
      throw new Error('This browser does not support audio recording. Uncheck recording or use a supported browser.');
    }
    const destination = sim.playCtx.createMediaStreamDestination();
    let recorder;
    try { recorder = new window.MediaRecorder(destination.stream, { mimeType: mime, audioBitsPerSecond: 64000 }); }
    catch (err) { destination.stream.getTracks().forEach((t) => t.stop()); throw err; }
    const ctx = { recorder, destination, micSource: null, chunks: [], bytes: 0, mime,
      audioContext: sim.playCtx, stateListener: null,
      agentId: agent.id, agentName: agent.name, startedAt: '', started: false,
      truncated: false, error: '', warned: false, timer: null, resolveStop: null, stopped: null };
    ctx.stopped = new Promise((resolve) => { ctx.resolveStop = resolve; });
    recorder.ondataavailable = (ev) => {
      if (ev.data?.size) {
        ctx.chunks.push(ev.data);
        ctx.bytes += ev.data.size;
        if (ctx.bytes >= RECORDING_SOFT_BYTES) stopRecordingAtLimit(ctx);
      }
    };
    recorder.onerror = (ev) => {
      ctx.error = ev.error?.message || 'The browser audio recorder failed.';
      warnRecording(ctx, `Audio recording failed: ${ctx.error}`);
      if (recorder.state !== 'inactive') { try { recorder.stop(); } catch {} }
    };
    recorder.onstop = () => {
      closeRecordingGraph(ctx);
      const type = String(recorder.mimeType || mime).split(';')[0].toLowerCase();
      ctx.resolveStop(new Blob(ctx.chunks, { type }));
    };
    return ctx;
  }

  function startPreparedRecording() {
    const ctx = sim.recording;
    if (!ctx) return;
    if (!sim.playCtx || sim.playCtx.state !== 'running') {
      throw new Error('Browser audio is suspended. Allow audio playback or uncheck recording and try again.');
    }
    ctx.startedAt = new Date().toISOString();
    ctx.recorder.start(1000);
    ctx.started = true;
    ctx.stateListener = () => {
      if (ctx.recorder.state === 'recording' && ctx.audioContext.state !== 'running') {
        ctx.error = 'Browser audio was suspended during recording, so the audio may be incomplete.';
        warnRecording(ctx, ctx.error);
      }
    };
    ctx.audioContext.addEventListener('statechange', ctx.stateListener);
    connectRecordingMic(ctx);
    ctx.timer = setTimeout(() => stopRecordingAtLimit(ctx), RECORDING_MAX_MS);
  }

  function closeRecordingGraph(ctx) {
    if (!ctx) return;
    if (ctx.timer) clearTimeout(ctx.timer);
    if (ctx.stateListener) {
      ctx.audioContext.removeEventListener('statechange', ctx.stateListener);
      ctx.stateListener = null;
    }
    disconnectRecordingMic(ctx);
    ctx.destination.stream.getTracks().forEach((track) => track.stop());
  }

  async function stopPreparedRecording(ctx) {
    if (!ctx?.started) { closeRecordingGraph(ctx); return null; }
    if (ctx.recorder.state !== 'inactive') ctx.recorder.stop();
    let timeout;
    let blob;
    try {
      blob = await Promise.race([
        ctx.stopped,
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('The browser did not finish encoding audio.')), 8000); }),
      ]);
    } finally { clearTimeout(timeout); }
    closeRecordingGraph(ctx);
    if (!blob?.size) throw new Error('The browser returned an empty audio recording.');
    return blob;
  }

  async function saveFinishedRecording(ctx, blob, snapshot) {
    if (ctx.error) throw new Error(ctx.error);
    if (blob.size > RECORDING_MAX_BYTES) throw new Error('The recording exceeds the 20 MB storage limit.');
    if (serverlessCloudMode) {
      const log = {
        id: snapshot.id, agentId: ctx.agentId, agentName: ctx.agentName,
        campaignId: null, greetingId: snapshot.greetingId || null,
        upstreamMode: 'deepgram', startedAt: ctx.startedAt,
        endedAt: new Date().toISOString(), durationMs: snapshot.durationMs, turns: snapshot.turns,
        avgTtfbMs: snapshot.avgTtfbMs, disposition: null, transferredTo: null,
        recordingRequested: true, recordingStatus: 'available', recordingMime: blob.type,
        recordingBytes: blob.size, recordingTruncated: ctx.truncated,
        transcript: snapshot.events.filter((e) => e.kind === 'msg').map((e) => ({
          ts: ctx.startedAt, role: e.role || 'system', content: e.content || '',
        })),
        functionCalls: snapshot.events.filter((e) => e.kind === 'fn').map((e) => ({
          id: e.id, name: e.name, status: e.status, args: e.args || {}, response: e.response,
        })),
      };
      await saveLocalRecordedTest(log, blob);
      return;
    }
    if (!snapshot.id || snapshot.logSaved === false) throw new Error('Test history could not be saved on the server.');
    const url = `/api/simulator/recordings/${encodeURIComponent(snapshot.id)}`;
    const send = () => fetch(url, {
      method: 'PUT', headers: { 'Content-Type': 'application/octet-stream',
        'X-Recording-Type': blob.type, 'X-Recording-Truncated': ctx.truncated ? '1' : '0' }, body: blob,
    });
    let res = await send();
    // On an unexpected socket close, the server may still be finalizing the log.
    if (res.status === 404 && snapshot.logSaved == null) {
      await new Promise((resolve) => setTimeout(resolve, 350));
      res = await send();
    }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).error || ''; } catch {}
      throw new Error(detail || `Server returned HTTP ${res.status}`);
    }
  }

  async function finalizeBrowserRecording(ctx, snapshot) {
    let blob = null;
    try {
      blob = await stopPreparedRecording(ctx);
      if (!blob) return;
      await saveFinishedRecording(ctx, blob, snapshot);
      sim.events.push({ kind: 'msg', role: 'system', content: serverlessCloudMode
        ? 'Audio recording and transcript saved in this browser’s local storage.'
        : 'Audio recording saved with this test in server history.' });
    } catch (err) {
      const partial = !blob && ctx.chunks.length > 0;
      if (partial) blob = new Blob(ctx.chunks, { type: ctx.mime.split(';')[0] });
      const message = `Audio recording could not be saved or confirmed: ${err.message || err}${partial ? ' The temporary copy may be incomplete.' : ''}`;
      sim.recordingError = message;
      sim.events.push({ kind: 'msg', role: 'system', content: message });
      if (blob?.size) {
        try {
          if (sim.recordingFallback) URL.revokeObjectURL(sim.recordingFallback.url);
          sim.recordingFallback = null;
          sim.recordingFallback = {
            url: URL.createObjectURL(blob),
            fileName: `live-bot-${snapshot.id || 'test'}.${recordingExtension(blob.type)}`,
            message,
          };
        } catch { sim.recordingError += ' The browser could not create a temporary download.'; }
      } else {
        sim.recordingError += ' No recoverable audio was returned by the browser.';
      }
    } finally {
      closeRecordingGraph(ctx);
    }
  }

  window.addEventListener('beforeunload', (event) => {
    if (sim.recording?.started || sim.recordingSaving || sim.recordingFallback) {
      event.preventDefault();
      event.returnValue = '';
    }
  });

  // Step 3 + Step 4: Live VICIdial Bridge & Wallboard Monitor state
  let viciMon = {
    status: null,
    logs: [],
    analytics: null,
    loaded: false,
    ws: null,
    verifyRunning: false,
    verifyResult: null,
    simRunning: false,
    simTransport: 'sip_rtp',
    simScenario: 'medicare_qualified_xfer',
    simCampaignId: '',
    simUpstream: 'deepgram',
    simError: null,
    webhookTests: {},
  };

  const parseJsonObject = (raw) => {
    const t = String(raw ?? '').trim();
    if (!t) return { ok: true, value: {} };
    try {
      const p = JSON.parse(t);
      return isPlainObject(p) ? { ok: true, value: p } : { ok: false, error: 'Must be a JSON object {...}' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };

  const parseJsonSchema = (raw) => {
    const t = String(raw ?? '').trim();
    if (!t) return { ok: true, value: { type: 'object', properties: {} } };
    const r = parseJsonObject(t);
    if (!r.ok) return r;
    if (r.value.type !== 'object' || (r.value.properties !== undefined && !isPlainObject(r.value.properties))) {
      return { ok: false, error: 'Must have {"type":"object","properties":{...}}' };
    }
    const reqList = Array.isArray(r.value.required) ? r.value.required.filter(Boolean) : [];
    return {
      ok: true,
      value: {
        type: 'object',
        properties: r.value.properties || {},
        ...(reqList.length > 0 ? { required: reqList } : {}),
      },
    };
  };

  const isValidFluxSpeed = (spd) => {
    if (!Number.isFinite(spd) || spd < 0.5 || spd > 1.5) return false;
    return Math.abs(spd * 20 - Math.round(spd * 20)) < 1e-6;
  };
  const normalizeFluxSpeed = (spd) => {
    const safe = Number.isFinite(Number(spd)) ? Number(spd) : 1;
    return Math.round(Math.min(1.5, Math.max(0.5, safe)) * 20) / 20;
  };

  const A = () => S.agents.find((x) => x.id === cur.a) || S.agents[0];
  const C = () => S.campaigns.find((x) => x.id === cur.c);
  const campaignAgentIds = (campaign) => {
    const legacy = typeof campaign?.agentId === 'string' ? campaign.agentId.trim() : '';
    const requested = Array.isArray(campaign?.agentIds) ? campaign.agentIds : [];
    const valid = new Set((S?.agents || []).map((agent) => agent.id));
    const ids = [...new Set([legacy, ...requested].filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim()))].filter((id) => valid.has(id));
    const primary = ids.includes(legacy) ? legacy : ids[0] || '';
    return primary ? [primary, ...ids.filter((id) => id !== primary)] : ids;
  };
  const campaignHasAgent = (campaign, agentId) => campaignAgentIds(campaign).includes(agentId);
  const primaryCampaignAgent = (campaign) => S.agents.find((agent) => agent.id === campaignAgentIds(campaign)[0]);
  const assignCampaignAgent = (campaign, agentId, assigned) => {
    const ids = campaignAgentIds(campaign);
    const next = assigned ? [...new Set([...ids, agentId])] : ids.filter((id) => id !== agentId);
    campaign.agentIds = next;
    campaign.agentId = next.includes(campaign.agentId) ? campaign.agentId : next[0] || '';
    if (sim.campaignId === campaign.id && !campaignHasAgent(campaign, sim.campaignAgentId || agentId)) { sim.campaignId = ''; sim.campaignAgentId = ''; }
  };
  const campaignsForAgent = (agentId) => (S?.campaigns || []).filter((campaign) => campaignHasAgent(campaign, agentId));
  function simulatorCampaign(agentId = A()?.id) {
    if (!sim.campaignId) return null;
    return campaignsForAgent(agentId).find((campaign) => campaign.id === sim.campaignId) || null;
  }
  function setSimulatorCampaign(campaignId, agentId = A()?.id) {
    sim.campaignId = campaignsForAgent(agentId).some((campaign) => campaign.id === campaignId) ? campaignId : '';
    sim.campaignAgentId = sim.campaignId ? agentId : '';
  }
  const prov = (id) => S.providers.find((x) => x.id === id);

  const rootRefs = () => ({ a: A(), c: C(), v: S.vici, p: S.providers, f: S.functions, services: S.services });

  const getPath = (path) => {
    const keys = path.split('.');
    let obj = rootRefs()[keys[0]];
    for (const k of keys.slice(1)) obj = obj?.[k];
    return obj;
  };

  const setPath = (path, val) => {
    const keys = path.split('.');
    let obj = rootRefs()[keys[0]];
    for (const k of keys.slice(1, -1)) obj = obj[k];
    obj[keys[keys.length - 1]] = val;
  };

  const comparableSnapshot = (state) => {
    if (!state) return '';
    const clone = JSON.parse(JSON.stringify(state));
    delete clone.updatedAt;
    return JSON.stringify(clone);
  };

  const isDirty = () => S && comparableSnapshot(S) !== snap;

  function persistDraftLocally() {
    if (!S) return;
    try {
      // User edits are recoverable drafts, not committed saves. Save & Verify
      // is the explicit commit path; boot compatibility migrations may still
      // normalize the bundled baseline before the first edit.
      window.localStorage?.setItem(STATE_DRAFT_KEY, JSON.stringify({
        owner: ensureDraftOwnerId(),
        baseSnapshot: snap,
        savedAt: new Date().toISOString(),
        state: S,
      }));
    } catch (err) {
      if (serverlessCloudMode) saveError = err?.message || 'Browser storage is unavailable';
    }
  }

  function clearLocalDraft(force = false) {
    try {
      if (!force && !draftBelongsToTab(readLocalDraft())) return;
      window.localStorage?.removeItem(STATE_DRAFT_KEY);
    } catch {}
  }

  function updateHeaderStatus() {
    if (!S) return;
    if (isDirty()) persistDraftLocally();
    const dirty = isDirty();
    const dock = document.getElementById('save-dock');
    const saveBtn = document.getElementById('sv');
    const discardBtn = document.getElementById('dc');
    const label = document.getElementById('save-dock-lbl');
    const visible = dirty || manualSaveInFlight || Boolean(saveError);
    if (dock) dock.hidden = !visible;
    document.body.classList.toggle('has-unsaved-changes', visible);
    if (label) label.textContent = manualSaveInFlight ? 'Saving…' : saveError ? 'Save failed — retry' : 'Unsaved changes';
    if (saveBtn) {
      saveBtn.disabled = !S || manualSaveInFlight || (!dirty && !saveError);
      saveBtn.title = dirty ? 'Save changes and run verification' : 'No unsaved changes';
    }
    if (discardBtn) discardBtn.disabled = !dirty || manualSaveInFlight;

    const dgKey = secretsStatus?.DEEPGRAM_API_KEY?.configured;
    const btnKeys = document.getElementById('btn-keys');
    if (btnKeys) {
      let badge = btnKeys.querySelector('.keys-state');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'keys-state';
        btnKeys.appendChild(badge);
      }
      badge.className = `keys-state ${dgKey ? 'ok' : 'wn'}`;
      badge.textContent = dgKey ? '' : '!';
      badge.title = dgKey ? 'DEEPGRAM_API_KEY configured' : 'DEEPGRAM_API_KEY missing';
    }

    const btnNewTab = document.getElementById('btn-newtab');
    if (btnNewTab) {
      btnNewTab.href = window.location.href;
      btnNewTab.style.display = isInIframe ? 'inline-flex' : 'none';
    }
  }

  function buildSettings(agent, greetingText = '', campaign) {
    const sp = globalServiceProvider('stt') || {};
    const lp = globalServiceProvider('llm') || {};
    const tp = globalServiceProvider('tts') || {};
    // Live calls always pass an explicit campaign. For preview, fall back to
    // the simulator selection, then the bot's first assigned campaign, so the
    // composed prompt truthfully includes that campaign's rules (mirrors the
    // backend buildDeepgramSettings fallback).
    const linkedCampaign = campaign
      ? campaignHasAgent(campaign, agent.id) ? campaign : undefined
      : (agent.id === A()?.id ? simulatorCampaign(agent.id) : null) || campaignsForAgent(agent.id)[0];

    const isSpeechServiceStt = sp.type === 'speech_service';
    const spModels = String(sp.models || '').split(',').map((s) => s.trim()).filter(Boolean);
    const rawSttModel = String(S.services?.stt?.model || '').trim();
    const sttModel = isSpeechServiceStt
      ? spModels.includes(rawSttModel) ? rawSttModel : ''
      : VOICE_AGENT_STT_MODELS.includes(rawSttModel) ? rawSttModel : '';
    const isFluxListen = !isSpeechServiceStt && sttModel.startsWith('flux-');
    const listenProvider = {
      type: sttModel ? (isSpeechServiceStt ? 'speech_service' : sp.type === 'deepgram' ? 'deepgram' : '') : '',
      model: sttModel,
    };
    if (isFluxListen) {
      listenProvider.version = 'v2';
      listenProvider.eot_threshold = Number(agent.stt.eot);
      listenProvider.eager_eot_threshold = Number(agent.stt.eager);
      listenProvider.eot_timeout_ms = Math.round(Number(agent.stt.eotms));
      if (sttModel === 'flux-general-multi' && agent.language) {
        listenProvider.language_hints = agent.language.split(',').map((s) => s.trim()).filter(Boolean);
      }
      const kt = (agent.stt.keyterms || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (kt.length) listenProvider.keyterms = kt;
    }
    const spEx = parseJsonObject(sp.extra);
    if (spEx.ok) Object.assign(listenProvider, spEx.value);
    listenProvider.type = sttModel ? (isSpeechServiceStt ? 'speech_service' : sp.type === 'deepgram' ? 'deepgram' : '') : '';
    listenProvider.model = sttModel;
    delete listenProvider.language;
    delete listenProvider.smart_format;
    if (!isFluxListen) {
      delete listenProvider.version;
      delete listenProvider.eot_threshold;
      delete listenProvider.eager_eot_threshold;
      delete listenProvider.eot_timeout_ms;
      delete listenProvider.language_hints;
      delete listenProvider.keyterms;
    } else {
      listenProvider.version = 'v2';
      if (sttModel !== 'flux-general-multi') {
        delete listenProvider.language_hints;
      }
    }
    const listen = { provider: listenProvider };
    if (isSpeechServiceStt && (sp.endpoint || '').trim()) {
      const sh = parseJsonObject(sp.headers);
      listen.endpoint = { url: sp.endpoint.trim(), headers: sh.ok ? sh.value : {} };
    }

    const llmModel = String(S.services?.llm?.model || '').trim();
    const thinkProvider = { type: lp.type || '' };
    if (llmModel) thinkProvider.model = llmModel;
    if (lp.type === 'open_ai' && /^gpt-5/.test(llmModel)) {
      thinkProvider.reasoning_mode = agent.llm.reasoning;
    } else {
      thinkProvider.temperature = Number(agent.llm.temp);
    }
    const lpEx = parseJsonObject(lp.extra);
    if (lpEx.ok) Object.assign(thinkProvider, lpEx.value);
    thinkProvider.type = lp.type || '';
    delete thinkProvider.endpoint;
    delete thinkProvider.model;
    if (llmModel) thinkProvider.model = llmModel;

    const campaignDispos = String(linkedCampaign?.dispos || '')
      .split(/[ ,\t\r\n]+/)
      .map((code) => code.trim().toUpperCase())
      .filter((code, index, all) => Boolean(code) && all.indexOf(code) === index);
    const fns = (agent.fnIds || [])
      .map((id) => S.functions.find((f) => f.id === id))
      .filter(Boolean)
      .map((f) => {
        const sc = parseJsonSchema(f.params);
        const parameters = sc.ok ? JSON.parse(JSON.stringify(sc.value)) : { type: 'object', properties: {} };
        if (f.name === 'set_disposition' && campaignDispos.length && parameters.properties?.code) {
          parameters.properties.code = { ...parameters.properties.code, enum: campaignDispos };
        }
        const o = { name: f.name, description: f.description, parameters };
        if (f.defer) o.defer_until_eot = true;
        if ((f.url || '').trim()) {
          const fh = parseJsonObject(f.headers);
          o.endpoint = { url: f.url.trim(), method: f.method, headers: fh.ok ? fh.value : {} };
        }
        return o;
      });

    const think = { provider: thinkProvider, prompt: window.VacPersona.composeBehavioralPrompt(agent, linkedCampaign), functions: fns };

    const ttsModel = String(S.services?.tts?.model || '').trim();
    const speakProvider = { type: tp.type || '' };
    const mk = tp.type === 'deepgram' || tp.type === 'open_ai' || tp.type === 'speech_service' ? 'model' : tp.mk || 'model_id';
    if (tp.type && ttsModel && tp.type !== 'aws_polly') speakProvider[mk] = ttsModel;
    if (tp.type === 'deepgram' && ttsModel) {
      // Voice Agent speak provider: exactly {type, version, model}.
      speakProvider.version = ttsModel.startsWith('flux') ? 'v2' : 'v1';
    } else if (tp.type === 'cartesia') {
      speakProvider.speed = Number(agent.tts.speed);
    }
    const tpEx = parseJsonObject(tp.extra);
    if (tpEx.ok && tp.type !== 'deepgram') {
      const copy = { ...tpEx.value };
      Object.assign(speakProvider, copy);
    }
    speakProvider.type = tp.type || '';
    delete speakProvider.model;
    delete speakProvider.model_id;
    if (tp.type === 'deepgram') {
      for (const k of Object.keys(speakProvider)) delete speakProvider[k];
      speakProvider.type = ttsModel ? 'deepgram' : '';
      if (ttsModel) {
        speakProvider.version = ttsModel.startsWith('flux') ? 'v2' : 'v1';
        speakProvider.model = ttsModel;
      } else {
        speakProvider.model = '';
      }
    } else if (tp.type && ttsModel && tp.type !== 'aws_polly') {
      speakProvider[mk] = ttsModel;
    }
    const speak = { provider: speakProvider };
    if ((tp.endpoint || '').trim()) {
      const th = parseJsonObject(tp.headers);
      speak.endpoint = { url: tp.endpoint.trim(), headers: th.ok ? th.value : {} };
    }

    const finalGreeting = window.VacOpening.composeOpening(
      agent.greeting, agent.randomGreetingEnabled !== false ? greetingText : '',
      agent.injectCampaignDisclosure, linkedCampaign?.disclosure || ''
    );

    return {
      type: 'Settings',
      tags: ['voice-console', agent.mode, ...(linkedCampaign?.viciCampaign ? [linkedCampaign.viciCampaign] : [])],
      audio: {
        input: { encoding: agent.audio.inEnc, sample_rate: Number(agent.audio.inRate) },
        output: { encoding: agent.audio.outEnc, sample_rate: Number(agent.audio.outRate), container: 'none' },
      },
      agent: {
        listen,
        think,
        speak,
        greeting: finalGreeting,
      },
    };
  }

  function validateAgentLocal(agent) {
    const items = [];
    const push = (ok, message, warn = false) =>
      items.push([ok ? 'ok' : warn ? 'wn' : 'er', ok ? '✓' : warn ? '!' : '✗', message]);

    const sp = globalServiceProvider('stt');
    const lp = globalServiceProvider('llm');
    const tp = globalServiceProvider('tts');
    const sttModel = String(S.services?.stt?.model || '');
    const llmModel = String(S.services?.llm?.model || '');
    const ttsModel = String(S.services?.tts?.model || '');
    push(Boolean(sp), 'One global STT provider is selected in Plug-Ins');
    push(Boolean(lp), 'One global LLM provider is selected in Plug-Ins');
    push(Boolean(tp), 'One global TTS provider is selected in Plug-Ins');

    const isLocalStt = Boolean(sp && sp.type === 'speech_service');
    const spAllowedStt = sp ? (sp.models || '').split(',').map((s) => s.trim()).filter(Boolean) : [];
    push(
      Boolean(sp && (sp.type === 'deepgram' || sp.type === 'speech_service')),
      isLocalStt
        ? 'Global STT provider is Local Speech Service (Faster-Whisper)'
        : 'Global STT provider is Deepgram (required by Deepgram Voice Agent API)'
    );
    push(
      Boolean(sp && (isLocalStt ? spAllowedStt.includes(sttModel) : VOICE_AGENT_STT_MODELS.includes(sttModel))),
      isLocalStt
        ? `Global STT model "${sttModel || 'not selected'}" is supported by Local Speech Service`
        : `Global STT model "${sttModel || 'not selected'}" is supported by Voice Agent (Nova-3 or Flux v2)`
    );
    push((agent.greeting || '').trim().length > 10, 'Greeting is set (> 10 chars)');
    const promptOk = (agent.prompt || '').trim().length > 0 && agent.prompt.length <= 25000;
    push(promptOk, 'System prompt within 25,000-character managed limit');

    if (sttModel.startsWith('flux')) {
      const eot = Number(agent.stt.eot);
      const eager = Number(agent.stt.eager);
      const eotms = Number(agent.stt.eotms);
      push(eot >= 0.5 && eot <= 1.0, `Flux STT eot_threshold (${eot}) in 0.5–1.0`);
      push(eager >= 0.3 && eager <= 0.9, `Flux STT eager_eot_threshold (${eager}) in 0.3–0.9`);
      push(eager <= eot, `eager_eot_threshold (${eager}) ≤ eot_threshold (${eot})`);
      push(Number.isInteger(eotms) && eotms >= 500, `eot_timeout_ms (${eotms}) is integer ≥ 500`);
      push(!agent.stt.smartFormat, 'smart_format disabled on Flux v2 STT');
    }

    push(
      Boolean(lp && DG_LLM_PROVIDER_TYPES.includes(lp.type) && !(lp.endpoint || '').trim()),
      `Selected global LLM provider (${lp?.name || 'none'}) is natively managed by Deepgram (no BYO endpoint)`
    );
    push(
      Boolean(lp && dgLlmModelIdsForType(lp.type).includes(llmModel)),
      `Selected global LLM model "${llmModel || 'not selected'}" belongs to the chosen Deepgram provider`
    );

    const ttsNeedsEp = Boolean(tp && !['deepgram', 'cartesia'].includes(tp.type));
    push(Boolean(tp && (!ttsNeedsEp || (tp.endpoint || '').trim())), `TTS endpoint configured where required (${tp?.type || 'no provider'})`);
    const tpModelList = tp ? (tp.models || '').split(',').map((s) => s.trim()).filter(Boolean) : [];
    const ttsModelBelongs = Boolean(
      tp &&
        ttsModel &&
        (tpModelList.includes(ttsModel) ||
          (tp.type === 'deepgram' && /^(flux|aura)-/i.test(ttsModel)) ||
          (tp.type === 'speech_service' && /^(clone:[0-9a-f]{32}|[a-z]{2}_[a-z0-9]+)$/.test(ttsModel)))
    );
    push(
      ttsModelBelongs,
      `Selected global TTS model "${ttsModel || 'not selected'}" belongs to the chosen provider`
    );

    if (tp?.type === 'deepgram') {
      const isFluxOrAura = Boolean(ttsModel.startsWith('flux-') || ttsModel.startsWith('aura-'));
      const speakVersion = ttsModel.startsWith('flux-') ? 'v2' : 'v1';
      push(
        isFluxOrAura,
        `Deepgram speak model "${ttsModel || 'not selected'}" is a recognized Flux/Aura voice`
      );
      push(
        isFluxOrAura,
        `Speak provider sends only {type:"deepgram", version:"${speakVersion}", model:"${ttsModel || '…'}"}`,
        !isFluxOrAura
      );
      if (ttsModel.startsWith('flux-')) {
        const spd = Number(agent.tts.speed);
        push(isValidFluxSpeed(spd), `Flux TTS speed (${spd}) is in 0.5–1.5 (0.05 increments)`);
        const expr = Number(agent.tts.expr);
        push(Number.isInteger(expr) && expr >= -2 && expr <= 2, `Flux TTS expressivity (${expr}) is an integer in -2..+2`);
      } else if (ttsModel.startsWith('aura-')) {
        const spd = Number(agent.tts.speed);
        push(spd >= 0.7 && spd <= 1.5, `Aura TTS speed (${spd}) is within 0.7–1.5`);
      }
    }

    const hasPlaceholder = Boolean(tp && ((tp.endpoint || '').includes('{voice_id}') || (tp.extra || '').includes('"VOICE_ID"')));
    push(!hasPlaceholder, 'No unreplaced {voice_id} or VOICE_ID placeholder in TTS config', true);

    const provJsonOk = [sp, lp, tp].every((p) => Boolean(p && parseJsonObject(p.headers).ok && parseJsonObject(p.extra).ok));
    const agentFns = (agent.fnIds || []).map((id) => S.functions.find((f) => f.id === id)).filter(Boolean);
    const fnJsonOk = agentFns.every((f) => parseJsonSchema(f.params).ok && parseJsonObject(f.headers).ok);
    push(provJsonOk && fnJsonOk, 'Plug-in JSON objects and function JSON schemas are valid');

    const fnNames = agentFns.map((f) => f.name);
    push(Boolean(agent.acceptViciCalls), 'Bridge VICIdial call-connect & lead hydration enabled', agent.mode === 'outbound');
    push(fnNames.includes('transfer_to_live_agent'), 'transfer_to_live_agent function enabled');
    push(
      !fnNames.includes('transfer_to_live_agent') || /transfer_to_live_agent/i.test(agent.prompt),
      'System prompt specifies when to call transfer_to_live_agent'
    );
    push(/(dnc|do not call|take me off|stop)/i.test(agent.prompt), 'System prompt handles Do-Not-Call requests');
    push(fnNames.includes('end_call'), 'end_call function enabled');
    push(Number(agent.audio.inRate) === 8000, '8000 Hz input sample rate matches Asterisk/VICIdial telephony', true);
    push(campaignsForAgent(agent.id).length > 0, 'Explicitly assigned to at least one campaign before deployment');

    return items;
  }

  function validateCampaignLocal(c) {
    const items = [];
    const push = (ok, m, w = false) => items.push([ok ? 'ok' : w ? 'wn' : 'er', ok ? '✓' : w ? '!' : '✗', m]);
    if (!c) {
      push(false, 'Create a campaign and explicitly assign a bot agent before testing or deployment');
      return items;
    }
    const rules = String(c.complianceRules || '').trim();
    const allowed = String(c.dispos || '').split(/[ ,\t\r\n]+/).map((code) => code.trim().toUpperCase()).filter(Boolean);
    push(Boolean((c.viciCampaign || '').trim()), 'VICIdial campaign ID set');
    push(Boolean((c.xferTarget || '').trim()), 'Live-agent transfer target set');
    push(Boolean(c.dnc), 'DNC scrub enabled');
    push(Boolean((c.disclosure || '').trim()), 'Recording disclosure line present', true);
    push(c.start < c.end, `Calling window valid (${c.start} – ${c.end})`);
    const assignedAgents = campaignAgentIds(c).map((id) => S.agents.find((agent) => agent.id === id)).filter(Boolean);
    push(assignedAgents.length > 0, 'Explicitly assigned to at least one existing bot agent');
    push(allowed.length > 0, 'At least one allowed VICIdial disposition code is configured');
    const transferFunction = S.functions.find((fn) => fn.name === 'transfer_to_live_agent');
    const transferEnabled = Boolean(transferFunction && assignedAgents.some((agent) => agent.fnIds.includes(transferFunction.id)));
    push(!transferEnabled || allowed.includes('XFER'), 'XFER is in the allowed disposition list when live-agent transfer is enabled');
    push(rules.length >= 20 && rules.length <= 8000 && !/^REVIEW REQUIRED\b/i.test(rules), 'Campaign-specific compliance & rules are written and reviewed (20–8,000 characters)');
    return items;
  }

  function deploymentReadinessBlockersLocal() {
    const blockers = [];
    for (const agent of S.agents || []) {
      if (!campaignsForAgent(agent.id).length) {
        blockers.push(`Agent “${agent.name}” must be explicitly assigned to at least one campaign.`);
      }
      for (const item of validateAgentLocal(agent)) {
        if (item[0] === 'er') blockers.push(`Agent “${agent.name}”: ${item[2]}.`);
      }
    }
    for (const campaign of S.campaigns || []) {
      for (const item of validateCampaignLocal(campaign)) {
        if (item[0] === 'er') blockers.push(`Campaign “${campaign.name}”: ${item[2]}.`);
      }
    }
    return [...new Set(blockers)];
  }

  function buildViciConfigLocal() {
    const v = S.vici;
    const selectedCampaign = C();
    const selectedCampaignIndex = selectedCampaign ? S.campaigns.findIndex((campaign) => campaign.id === selectedCampaign.id) + 1 : 0;
    const selectedRemoteAgentUser = selectedCampaign ? String(Number(v.remoteAgentUser || 9001) + selectedCampaignIndex - 1) : v.remoteAgentUser;
    const selectedCampaignExten = selectedCampaign ? `${v.aiExten}${selectedCampaignIndex}` : '';
    const nonAgentUrl = `${v.viciBaseUrl}${v.nonAgentApiPath}`;
    const agentApiUrl = `${v.viciBaseUrl}${v.agentApiPath}`;
    const campaignBlock = S.campaigns
      .map((c, idx) => {
        const ag = primaryCampaignAgent(c);
        const pool = campaignAgentIds(c).map((id) => S.agents.find((a) => a.id === id)?.name || id).join(', ');
        const ext = `${v.aiExten}${idx + 1}`;
        const xfer =
          c.xferType === 'ingroup'
            ? `Agent API ra_call_control (stage=INGROUPTRANSFER, ingroup_choices=${c.xferTarget}) -> preserves closer screen-pop`
            : `Agent API ra_call_control (stage=EXTENSIONTRANSFER, consultative=NO, exten=${c.xferTarget})`;
        return [
          `; [Campaign ${idx + 1}: ${c.name}]`,
          `;   VICIdial Campaign ID : ${c.viciCampaign || '(unset)'} | Lists: ${c.lists || '(none)'} | Max Concurrent: ${c.maxCalls}`,
          `;   Assigned Bot Pool    : ${pool || '(missing)'}`,
          `;   Telephone Persona    : ${ag ? ag.name : '(missing)'} (${ag?.mode || 'outbound'}); browser tests may select any assigned bot`,
          `;   Remote Agent Exten   : ${ext} (Remote Agent User: ${Number(v.remoteAgentUser || 9001) + idx})`,
          `;   Live Closer Transfer : ${xfer}`,
          `;   Allowed Dispositions : ${c.dispos}`,
          `;   Campaign Rules       : ${String(c.complianceRules || '').trim() ? `${String(c.complianceRules).trim().length} characters; injected into the assigned bot prompt` : 'MISSING — deployment blocked'}`,
        ].join('\n');
      })
      .join('\n;\n');

    const sipCarrierBlock = [
      `; === OPTION A (Universal — Asterisk 13 / 16 / 18+ on ViciBox 8-12): SIP + RTP Mode ===`,
      `; 1) VICIdial Admin -> Carriers -> Add New Carrier (ID: AIBRIDGE) -> Account Entry:`,
      `[ai-bridge]`,
      `disallow=all`,
      `allow=ulaw`,
      `type=friend`,
      `host=${v.bridgeHost}`,
      `port=${v.sipPort}`,
      `dtmfmode=rfc2833`,
      `context=trunkinbound`,
      `qualify=yes`,
      `insecure=port,invite`,
      ``,
      `;    Dialplan Entry (under same Carrier):`,
      `exten => _${v.aiExten}X.,1,NoOp(VICIdial AI Bot SIP -> Ext \${EXTEN} | ViciCID: \${CALLERID(name)})`,
      ` same => n,SIPAddHeader(X-Vici-CallName: \${CALLERID(name)})`,
      ` same => n,SIPAddHeader(X-Vici-UniqueID: \${CHANNEL(uniqueid)})`,
      ` same => n,SIPAddHeader(X-Vici-Channel: \${CHANNEL})`,
      ` same => n,SIPAddHeader(X-Vici-Exten: \${EXTEN})`,
      ` same => n,Dial(SIP/\${EXTEN}@ai-bridge,60,tTo)`,
      ` same => n,Hangup()`,
    ].join('\n');

    const audioSocketBlock = [
      `; === OPTION B (Asterisk 18+ on ViciBox 11/12): Native AudioSocket TCP Mode ===`,
      `; /api/vici/register-call returns a canonical 36-char RFC4122 UUID & pre-hydrates the lead!`,
      `exten => _${v.aiExten}X.,1,NoOp(VICIdial AI Bot AudioSocket -> \${EXTEN} | ViciCID: \${CALLERID(name)})`,
      ` same => n,Answer()`,
      ` same => n,Set(CHANNEL(audioreadformat)=slin)`,
      ` same => n,Set(CHANNEL(audiowriteformat)=slin)`,
      ` same => n,Set(_BRIDGE_UUID=\${CURL(http://${v.bridgeHost}:533/api/vici/register-call,uniqueid=\${CHANNEL(uniqueid)}&vici_cid=\${URIENCODE(\${CALLERID(name)})}&phone=\${URIENCODE(\${CALLERID(num)})}&exten=\${EXTEN}&channel=\${URIENCODE(\${CHANNEL})})})`,
      ` same => n,AudioSocket(\${_BRIDGE_UUID},${v.bridgeHost}:${v.bridgePort})`,
      ` same => n,Hangup()`,
    ].join('\n');

    const dialplan =
      v.transport === 'sip_trunk'
        ? `${sipCarrierBlock}\n\n${audioSocketBlock}`
        : `${audioSocketBlock}\n\n${sipCarrierBlock}`;

    return [
      `; ============================================================================`,
      `; VICIdial <-> Voice Agent Bridge Configuration (Active Primary: ${v.transport === 'sip_trunk' ? 'SIP/RTP :' + v.sipPort : 'AudioSocket :' + v.bridgePort})`,
      `; Both listeners (:9092 AudioSocket TCP & :${v.sipPort} SIP/RTP UDP) run simultaneously!`,
      `; ============================================================================`,
      campaignBlock,
      ``,
      `; === VICIdial Admin Setup Checklist (Co-Located on ViciBox ${v.bridgeHost}) ===`,
      `; 1. Users -> API User "${v.apiUser}": User Level=8, Modify Leads=1, Modify Lists=1, Agent API Access=1`,
      selectedCampaign
        ? `; 2. Remote Agents -> Create User ${selectedRemoteAgentUser} (Lines=${selectedCampaign.maxCalls}, External Exten=${selectedCampaignExten}, On-Hook=N, Status=ACTIVE)`
        : `; 2. Remote Agents -> Configure a user, line limit, and external extension for each assigned campaign.`,
      selectedCampaign
        ? `; 3. Inbound Groups -> Configure approved ${selectedCampaign.xferType === 'ingroup' ? 'Closer In-Group' : 'transfer target'} "${selectedCampaign.xferTarget || '(unset in selected campaign)'}" for VICIdial campaign "${selectedCampaign.viciCampaign || selectedCampaign.name}".`
        : `; 3. Configure an explicit, approved transfer target for each campaign; none is selected.`,

      `; 4. Inbound Routing -> Point "${v.inIngroup}" Drop/No-Agent Action -> EXTENSION ${v.aiExten}1`,
      ``,
      dialplan,
      ``,
      `; === Call Lifecycle Executed by Bridge Server ===`,
      `; 1. On Connect : Extracts 20-char caller_code & lead_id from VICIdial CALLERID(name) (VmmddhhmmssLLLLLLLLL)`,
      `; 2. Hydrate    : GET ${nonAgentUrl}?function=lead_all_info (fallback: lead_field_info) &user=${v.apiUser}&source=${v.source}`,
      `; 3. Converse   : Opens Deepgram Voice Agent WebSocket (8000 Hz) with hydrated lead prompt + any enabled campaign notice`,
      `; 4. Transfer   : Saves AI qualification notes via update_lead, then GET ${agentApiUrl}?function=ra_call_control&stage=INGROUPTRANSFER|EXTENSIONTRANSFER`,
      `; 5. Dispo/DNC  : Updates status via ${nonAgentUrl} (update_lead + add_dnc_phone) & releases Remote Agent via ${agentApiUrl} (stage=HANGUP)`,
      ``,
      `# === Bridge Server .env (Co-Located on ViciBox) ===`,
      `PORT=533`,
      `# Set HOST explicitly for remote access after configuring authentication`,
      `HOST=127.0.0.1`,
      `DEEPGRAM_API_KEY=***`,
      `VICI_API_PASS=***`,
      `AMI_SECRET=***`,
      `AUDIOSOCKET_PORT=${v.bridgePort}`,
      `BRIDGE_SIP_PORT=${v.sipPort}`,
    ].join('\n');
  }

  const renderCheckList = (arr) =>
    arr.map((x) => `<div class="ck"><span class="${x[0]}">${x[1]}</span><span>${x[2]}</span></div>`).join('');

  let fieldSerial = 0;
  const F = (label, path, type = 'text', opts = [], attrs = '') => {
    const val = getPath(path);
    const fieldId = `vac-field-${++fieldSerial}`;
    const dp = `data-p="${path}" id="${fieldId}"`;
    if (type === 'chk') {
      return `<label class="chk-label"><input type="checkbox" style="width:auto" ${dp} ${val ? 'checked' : ''}>${label}</label>`;
    }
    let fieldHtml = '';
    if (type === 'sel') {
      fieldHtml = `<select ${dp}>${opts
        .map((o) => {
          const pair = Array.isArray(o) ? o : [o, o];
          return `<option value="${esc(pair[0])}" ${String(pair[0]) === String(val) ? 'selected' : ''}>${esc(pair[1])}</option>`;
        })
        .join('')}</select>`;
    } else if (type === 'ta') {
      fieldHtml = `<textarea ${dp} ${attrs}>${esc(val ?? '')}</textarea>`;
    } else if (type === 'dl') {
      const listId = `dl-${path.replace(/[^a-z0-9]/gi, '_')}`;
      fieldHtml = `<input ${dp} list="${listId}" value="${esc(val ?? '')}" ${attrs}><datalist id="${listId}">${opts
        .map((o) => `<option value="${esc(o)}">`)
        .join('')}</datalist>`;
    } else {
      const stepAttr = type === 'number' && !attrs.includes('step=') ? 'step="any"' : '';
      fieldHtml = `<input type="${type}" ${dp} ${stepAttr} ${attrs} value="${esc(val ?? '')}">`;
    }
    return `<label for="${fieldId}">${label}</label>${fieldHtml}`;
  };

  const providersByKind = (kind) => S.providers.filter((p) => p.kind === kind).map((p) => [p.id, p.name]);

  const SUPPORTED_PROVIDER_TYPES = {
    stt: ['deepgram', 'speech_service'],
    llm: ['open_ai', 'anthropic', 'google', 'groq', 'nvidia'],
    tts: ['deepgram', 'speech_service'],
  };
  const isSupportedProvider = (p) => (SUPPORTED_PROVIDER_TYPES[p.kind] || []).includes(p.type);
  const supportedProvidersByKind = (kind) =>
    S.providers.filter((p) => p.kind === kind && isSupportedProvider(p)).map((p) => [p.id, p.name]);
  const modelsForProvider = (id) => {
    const p = prov(id);
    if (!p) return [];
    if (p.kind === 'llm') {
      return dgLlmModelIdsForType(p.type);
    }
    if (p.kind === 'stt' && p.type !== 'speech_service') return VOICE_AGENT_STT_MODELS;
    return (p.models || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  };
  const llmSelectOptionsForProvider = (id) => {
    const p = prov(id);
    if (!p) return [];
    return dgLlmEntriesForType(p.type).map((m) => [m.id, `${m.name} (${m.id})`]);
  };

  function globalServiceProvider(kind) {
    const id = S?.services?.[kind]?.providerId;
    return S?.providers?.find((p) => p.kind === kind && p.id === id) || null;
  }

  function globalServiceModelOptions(kind) {
    const placeholder = [['', 'Select a model…']];
    const p = globalServiceProvider(kind);
    if (!p) return placeholder;
    if (kind === 'stt') {
      const sttIds = p.type === 'speech_service' ? modelsForProvider(p.id) : VOICE_AGENT_STT_MODELS;
      return placeholder.concat(sttIds.map((id) => [id, id]));
    }
    if (kind === 'llm') return placeholder.concat(dgLlmEntriesForType(p.type).map((m) => [m.id, `${m.name} (${m.id})`]));
    return placeholder.concat(modelsForProvider(p.id).map((id) => [id, id]));
  }

  let localSpeechUi = {
    busy: false,
    statusText: '',
    statusTone: '',
    audioDataUrl: '',
    urlDraft: '',
    voiceDraft: 'af_heart',
  };

  function renderLocalSpeechOneClickCard() {
    const localTts = S.providers.find((p) => p.kind === 'tts' && p.type === 'speech_service');
    const voices = localTts
      ? (localTts.models || '').split(',').map((s) => s.trim()).filter(Boolean)
      : ['af_heart', 'af_bella', 'af_nova', 'af_alloy', 'am_adam', 'bf_emma'];
    const activeStt = globalServiceProvider('stt');
    const activeTts = globalServiceProvider('tts');
    const isLocalActive = activeStt?.type === 'speech_service' && activeTts?.type === 'speech_service';
    const currentVoice = isLocalActive && S.services?.tts?.model ? S.services.tts.model : localSpeechUi.voiceDraft || 'af_heart';
    const urlConfigured = secretsStatus?.SPEECH_SERVICE_URL?.configured;
    const keyConfigured = secretsStatus?.SPEECH_SERVICE_API_KEY?.configured;

    return `<div class="card" id="local-speech-card" style="border:1px solid var(--accent-soft,rgba(56,189,248,.35))">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:8px">
        <h2 style="margin:0">⚡ Self-Hosted Speech Service — 1-Click Local STT + TTS</h2>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <span class="pill ${isLocalActive ? 'wn' : ''}">${isLocalActive ? 'Selected · Live Bot unsupported' : 'Not selected'}</span>
          <span class="pill">${urlConfigured ? 'URL Configured' : 'Auto Port :8000'}</span>
          <span class="pill ${keyConfigured ? 'ok' : 'wn'}">${keyConfigured ? `Key ${esc(secretsStatus.SPEECH_SERVICE_API_KEY.masked)}` : 'Auth Key Optional/Dev'}</span>
        </div>
      </div>
      <div class="note" style="margin-bottom:10px">
        Configure your self-hosted speech service for standalone STT/TTS and voice previews. <b>Live Bot does not yet connect local speech to an LLM</b>; selecting it here does not enable a full conversation. Use Deepgram Voice Agent for Live Bot.
      </div>
      <div class="row r3">
        <div>
          <label for="ss-url-input">Speech Service URL (optional override)</label>
          <input id="ss-url-input" type="text" placeholder="e.g. http://192.168.18.29:8000" value="${esc(localSpeechUi.urlDraft)}" autocomplete="off" />
        </div>
        <div>
          <label for="ss-key-input">Speech Service API Key (Bearer / X-API-Key)</label>
          <input id="ss-key-input" type="password" placeholder="${keyConfigured ? 'Saved in .env (enter to update)' : 'Enter SPEECH_API_KEY if enabled…'}" autocomplete="off" />
        </div>
        <div>
          <label for="ss-voice-select">Default Kokoro / Cloned Voice</label>
          <select id="ss-voice-select">
            ${voices.map((v) => `<option value="${esc(v)}" ${v === currentVoice ? 'selected' : ''}>${esc(v)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="bar" style="margin-top:10px;margin-bottom:4px">
        <button class="b" id="btn-ss-activate" ${localSpeechUi.busy ? 'disabled' : ''}>⚡ Save Local STT + TTS Selection</button>
        <button class="g" id="btn-ss-test" ${localSpeechUi.busy ? 'disabled' : ''}>${serverlessCloudMode ? '🔊 Test Remote TTS' : '🔊 Test Round-Trip (TTS → STT)'}</button>
        <button class="g" id="btn-ss-probe" ${localSpeechUi.busy ? 'disabled' : ''}>🔌 Check /readyz Status</button>
      </div>
      ${
        localSpeechUi.statusText
          ? `<div class="note ${esc(localSpeechUi.statusTone)}" id="ss-status-note" style="margin-top:8px;white-space:pre-line">${esc(localSpeechUi.statusText)}</div>`
          : ''
      }
      ${
        localSpeechUi.audioDataUrl
          ? `<audio controls autoplay src="${esc(localSpeechUi.audioDataUrl)}" style="width:100%;margin-top:8px;height:36px"></audio>`
          : ''
      }
    </div>`;
  }

  function renderGlobalServiceRouting() {
    const kinds = [
      ['llm', 'LLM — Think', supportedProvidersByKind('llm')],
      ['stt', 'STT — Listen', supportedProvidersByKind('stt')],
      ['tts', 'TTS — Speak', supportedProvidersByKind('tts')],
    ];
    const missing = kinds.filter(([kind]) => !S.services?.[kind]?.providerId || !S.services?.[kind]?.model);
    return `${renderLocalSpeechOneClickCard()}
    <div class="card global-services-card">
      <h2>Service Selection <button class="g" id="sync-llm" style="font-size:11px;padding:3px 8px;text-transform:none">↻ Refresh model list</button></h2>
      <div class="note">Pick one provider and one model for each service, then press <b>Save &amp; verify</b> — Local speech can be configured above for standalone tests, but is not supported for Live Bot conversations.</div>
      <div class="row r3">${kinds.map(([kind, label, providers]) => `
        <div class="global-service-choice">
          <h3>${label}</h3>
          ${F('Provider', `services.${kind}.providerId`, 'sel', [['', 'Select provider…'], ...providers])}
          ${F('Model', `services.${kind}.model`, 'sel', globalServiceModelOptions(kind))}
        </div>`).join('')}
      </div>
      ${
        missing.length
          ? `<div class="note wn" style="margin-top:10px">! Still missing a saved provider/model for: <b>${missing
              .map(([, label]) => label.split(' — ')[0])
              .join(', ')}</b>. Live sessions stay blocked until all three are saved.</div>`
          : '<div class="note ok" style="margin-top:10px">✓ All three services have a saved provider and model.</div>'
      }
      <div class="note" style="margin-top:6px">Live Bot requires a supported <b>Deepgram Voice Agent</b> configuration and <code>DEEPGRAM_API_KEY</code>. Local speech is available for standalone service testing only.</div>
    </div>`;
  }

  const renderSelectorBar = (kind) => {
    const arr = kind === 'a' ? S.agents : S.campaigns;
    const locked = sim.active || sim.connecting || sim.recordingSaving;
    return `<div class="bar">
      <select aria-label="${kind === 'a' ? 'Select agent' : 'Select campaign'}" id="sel-${kind}" ${locked ? 'disabled title="Finish the browser test before switching agent"' : ''}>
        ${arr.map((x) => `<option value="${esc(x.id)}" ${x.id === cur[kind] ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}
      </select>
      <button class="g" id="new-${kind}" ${locked ? 'disabled' : ''}>+ New</button>
      <button class="g" id="dup-${kind}" ${locked || !arr.length ? 'disabled' : ''}>Duplicate</button>
      <button class="g danger" id="del-${kind}" ${arr.length <= 1 || locked ? 'disabled title="At least one required"' : ''}>Delete</button>
    </div>`;
  };

  function renderPluginCard(idx) {
    const p = S.providers[idx];
    const sameKindCount = S.providers.filter((x) => x.kind === p.kind).length;
    const isStt = p.kind === 'stt';
    const isLlm = p.kind === 'llm';
    if (isLlm) {
      const dgModels = dgLlmEntriesForType(p.type);
      return `<div class="t">
        <div class="row">
          ${F('Display name', `p.${idx}.name`)}
          ${F('Deepgram Managed LLM Provider', `p.${idx}.type`, 'sel', DG_LLM_PROVIDER_TYPES)}
        </div>
        <label>Deepgram-Provided Models (${dgModels.length} managed via <code>DEEPGRAM_API_KEY</code>)</label>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 8px">
          ${dgModels
            .map(
              (m) =>
                `<span class="pill" title="${esc(m.name)}" style="font-size:11px;padding:3px 8px"><b>${esc(m.name)}</b> <span style="opacity:.7">(${esc(m.id)})</span></span>`
            )
            .join('')}
        </div>
        <div class="note ok" style="margin:4px 0 8px">✓ Natively hosted &amp; billed through Deepgram Voice Agent API — no third-party LLM endpoint or separate API key needed.</div>
        <div class="bar" style="margin-top:8px;margin-bottom:0">
          <button class="g danger" data-del="p:${idx}" ${sameKindCount <= 1 ? 'disabled title="At least one provider of each type is required"' : ''}>Remove</button>
        </div>
      </div>`;
    }
    return `<div class="t">
      <div class="row">
        ${F('Display name', `p.${idx}.name`)}
        ${
          isStt
            ? F('Provider type', `p.${idx}.type`, 'sel', [
                ['deepgram', 'deepgram (Cloud Voice Agent)'],
                ['speech_service', 'speech_service (Local Faster-Whisper)'],
              ])
            : F('Provider type', `p.${idx}.type`, 'sel', [
                'deepgram',
                'speech_service',
                'eleven_labs',
                'cartesia',
                'open_ai',
                'aws_polly',
              ])
        }
      </div>
      ${
        isStt && p.type !== 'speech_service'
          ? '<div class="note">Voice Agent STT models: <code>nova-3</code> (Nova baseline), <code>flux-general-en</code>, and <code>flux-general-multi</code> (Flux v2).</div>'
          : F('Models (comma-separated)', `p.${idx}.models`)
      }
      ${p.kind === 'tts' ? F('Model field key sent to API', `p.${idx}.mk`, 'sel', ['model', 'model_id']) : ''}
      ${F('Custom / BYO Endpoint URL (leave blank for Deepgram-managed)', `p.${idx}.endpoint`)}
      ${F('Headers JSON object (use {{ENV_VAR}} placeholders — keep real keys in server .env)', `p.${idx}.headers`)}
      ${F('Extra provider fields JSON object (voice, language_code…)', `p.${idx}.extra`)}
      <div class="bar" style="margin-top:8px;margin-bottom:0">
        <button class="g danger" data-del="p:${idx}" ${sameKindCount <= 1 ? 'disabled title="At least one provider of each type is required"' : ''}>Remove</button>
      </div>
    </div>`;
  }

  function renderFunctionCard(idx) {
    const f = S.functions[idx];
    const schemaCheck = parseJsonSchema(f.params);
    const whTest = viciMon.webhookTests[f.id];
    return `<div class="t">
      <div class="row">
        ${F('Function name', `f.${idx}.name`)}
        ${F('HTTP Method (when server URL is set)', `f.${idx}.method`, 'sel', ['post', 'get'])}
      </div>
      ${F('Description (shown to LLM)', `f.${idx}.description`)}
      ${F(
        `Parameters JSON Schema <span class="${schemaCheck.ok ? 'ok' : 'er'}">(${schemaCheck.ok ? 'valid schema' : esc(schemaCheck.error)})</span>`,
        `f.${idx}.params`,
        'ta'
      )}
      ${F('Server webhook URL (supports {{lead.lead_id}}, {{phone}}, {{caller_code}} & http://115.186.137.240)', `f.${idx}.url`)}
      ${F('Headers JSON object (supports {{CUSTOM_WEBHOOK_SECRET}} & .env placeholders)', `f.${idx}.headers`)}
      ${F('Hold until turn confirmed (defer_until_eot — recommended for transfers & hang-ups)', `f.${idx}.defer`, 'chk')}
      <div class="bar" style="margin-top:8px;margin-bottom:0">
        <span class="note" style="margin:0;margin-right:auto">Immutable ID: <code>${esc(f.id)}</code></span>
        ${
          f.url && f.url.trim()
            ? `<button class="g" data-test-wh="${idx}">🔌 Test Webhook</button>`
            : ''
        }
        <button class="g danger" data-del="f:${idx}">Remove</button>
      </div>
      ${
        whTest
          ? `<div class="note ${whTest.ok ? 'ok' : 'er'}" style="margin-top:6px;white-space:pre-wrap">${esc(whTest.summary)}</div>`
          : ''
      }
    </div>`;
  }

  // ==================== STEP 2: WEBAUDIO + WEBSOCKET LIVE SIMULATOR ====================

  function resampleFloat32ToPcm16(floatBuf, inRate, outRate, gain, state) {
    if (!floatBuf.length || !inRate || !outRate) return new ArrayBuffer(0);
    if (state.inRate !== inRate || state.outRate !== outRate) {
      state.inRate = inRate;
      state.outRate = outRate;
      state.last = null;
      state.position = 0;
    }
    const hasLast = state.last !== null;
    const input = new Float32Array(floatBuf.length + (hasLast ? 1 : 0));
    if (hasLast) input[0] = state.last;
    input.set(floatBuf, hasLast ? 1 : 0);
    const ratio = inRate / outRate;
    const samples = new Int16Array(Math.ceil(input.length / ratio) + 1);
    let count = 0;
    let pos = state.position;
    while (pos + 1 < input.length) {
      const i = Math.floor(pos);
      const fraction = pos - i;
      const sample = (input[i] * (1 - fraction) + input[i + 1] * fraction) * gain;
      const clamped = Math.max(-1, Math.min(1, sample));
      samples[count++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      pos += ratio;
    }
    state.last = input[input.length - 1];
    state.position = pos - (input.length - 1);
    return samples.buffer.slice(0, count * 2);
  }

  // The old avatar inferred "emotions" from transcript text and animated a face
  // on every animation frame. That was decorative, not provider-observed, and it
  // competed with real audio work. The stage now shows only real call state.
  function updatePersonaStageDom() {
    const stage = document.getElementById('persona-stage');
    if (!stage) return;
    const isSpeaking = sim.agentState === 'speaking' || sim.scheduledSources.length > 0;
    const isListeningUser = sim.agentState === 'user_speaking';
    stage.className = `persona-stage${isSpeaking ? ' speaking' : ''}${isListeningUser ? ' listening-user' : ''}`;
    // The header banner mirrors real call state through a CSS variable only.
    syncBrandEnergy(isSpeaking ? 'speaking' : isListeningUser ? 'listening' : '');
    const statePill = document.getElementById('persona-state-pill');
    if (statePill) {
      const labels = {
        listening: 'Listening',
        user_speaking: 'Caller speaking',
        thinking: 'Thinking',
        speaking: 'Speaking',
        idle: 'Idle',
      };
      statePill.textContent = labels[sim.agentState] || sim.agentState || 'Idle';
    }
    const bargePill = document.getElementById('persona-barge-pill');
    if (bargePill) {
      bargePill.textContent = `Interruptions: ${sim.bargeInCount}`;
      bargePill.className = `pill ${sim.bargeInCount > 0 ? 'ok' : ''}`;
    }
  }

  function renderPersonaStageHtml(agent) {
    const beh = agent.behavior || {};
    const bargeModeLbl =
      beh.bargeIn === 'off'
        ? 'Barge-In Off'
        : beh.bargeIn === 'server'
        ? 'Server VAD Barge-In'
        : 'Local + server VAD';
    return `
      <div class="persona-stage" id="persona-stage">
        <div class="persona-meta">
          <div class="persona-top-row">
            <div class="persona-title">
              <span>${esc(agent.name)}</span>
              <span class="pill ok" style="font-size:10.5px">${esc(bargeModeLbl)}</span>
            </div>
            <div class="bar" style="margin:0;gap:6px">
              <button class="g" id="btn-manual-barge" style="font-size:11px;padding:3px 9px;text-transform:none" ${sim.active ? '' : 'disabled title="Start a call first"'} title="Stop queued audio in this browser; speak or send text to begin a new turn">✋ Stop Playback</button>
              <button class="g" id="btn-trigger-intro" style="font-size:11px;padding:3px 9px;text-transform:none" ${sim.active ? '' : 'disabled title="Start a call first"'} title="Send an introduction request to the agent">👋 Self-Intro</button>
            </div>
          </div>
          <div class="persona-badges">
            <span class="pill" id="persona-state-pill">Idle</span>
            <span class="pill ${sim.bargeInCount > 0 ? 'ok' : ''}" id="persona-barge-pill">Interruptions: ${sim.bargeInCount}</span>
          </div>
        </div>
      </div>
    `;
  }

  function triggerInstantBargeIn(sourceLabel = 'Barge-In') {
    const beh = A()?.behavior || {};
    if (beh.bargeIn === 'off') return;
    const wasSpeaking = sim.scheduledSources.length > 0 || sim.agentState === 'speaking';
    flushSimulatorSpeakerQueue();
    sim.bargeInSuppressAudio = true;
    sim.lastLocalBargeInAt = Date.now();
    if (wasSpeaking || sourceLabel === 'Manual Button') {
      sim.bargeInCount += 1;
    }
    sim.agentState = 'user_speaking';
    sim.statusText = `⚡ Barge-In Active — Listening (${sourceLabel})`;
    updateSimStatusDom();
    updateSimKpisDom();
    updatePersonaStageDom();
    if (sim.ws?._directDg) sim.ws.markUserStarted();
    else if (sim.ws && sim.ws.readyState === WebSocket.OPEN) {
      try {
        sim.ws.send(JSON.stringify({ type: 'client_barge_in' }));
      } catch {}
    }
  }

  function flushSimulatorSpeakerQueue() {
    for (const src of sim.scheduledSources) {
      try {
        src.stop(0);
      } catch {}
    }
    sim.scheduledSources = [];
    if (sim.playCtx) {
      sim.nextPlayTime = sim.playCtx.currentTime;
    }
  }

  function enqueuePcm16Playback(arrayBuf) {
    if (sim.bargeInSuppressAudio) return;
    if (!sim.playCtx || arrayBuf.byteLength < 2) return;
    if (sim.playCtx.state === 'suspended') {
      sim.playCtx.resume().catch(() => {});
    }
    const int16 = new Int16Array(arrayBuf.slice(0, arrayBuf.byteLength - (arrayBuf.byteLength % 2)));
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768;
    }

    const audioBuffer = sim.playCtx.createBuffer(1, float32.length, sim.sampleRateOut);
    audioBuffer.copyToChannel(float32, 0);

    const src = sim.playCtx.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(sim.playCtx.destination);
    if (sim.recording?.started && sim.recording.recorder.state === 'recording') {
      src.connect(sim.recording.destination);
    }

    const now = sim.playCtx.currentTime;
    const startAt = Math.max(now + 0.006, sim.nextPlayTime || now + 0.006);
    src.start(startAt);
    sim.nextPlayTime = startAt + audioBuffer.duration;
    sim.scheduledSources.push(src);

    src.onended = () => {
      const idx = sim.scheduledSources.indexOf(src);
      if (idx >= 0) sim.scheduledSources.splice(idx, 1);
    };
  }

  async function refreshMicDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      sim.micDevices = all
        .filter((d) => d.kind === 'audioinput')
        .map((d, idx) => ({
          deviceId: d.deviceId,
          label: d.label || `Microphone Input #${idx + 1}`,
        }));
      const sel = document.getElementById('sim-mic-device');
      if (sel) {
        sel.innerHTML =
          `<option value="">System Default Microphone</option>` +
          sim.micDevices
            .filter((d) => d.deviceId && d.deviceId !== 'default')
            .map(
              (d) =>
                `<option value="${esc(d.deviceId)}" ${sim.micDeviceId === d.deviceId ? 'selected' : ''}>${esc(d.label)}</option>`
            )
            .join('');
      }
    } catch {}
  }

  function stopMicCaptureOnly() {
    disconnectRecordingMic();
    if (sim.micWatchdog) {
      clearInterval(sim.micWatchdog);
      sim.micWatchdog = null;
    }
    if (sim.micNodes) {
      try { sim.micNodes.source?.disconnect(); } catch {}
      try { sim.micNodes.proc?.disconnect(); } catch {}
      try { sim.micNodes.zeroGain?.disconnect(); } catch {}
      sim.micNodes = null;
    }
    sim.captureProcessor = null;
    if (sim.micStream) {
      sim.micStream.getTracks().forEach((tr) => tr.stop());
      sim.micStream = null;
    }
  }

  function handleMicFloatSamples(ch, inSampleRate) {
    if ((!sim.active && !sim.connecting) || sim.muted) {
      const meter = document.getElementById('sim-mic-bar');
      if (meter) meter.style.width = '0%';
      sim.vadConsecutiveFrames = 0;
      return;
    }
    const gain = Number(sim.micGain) || 1.0;
    let sum = 0;
    let rawSum = 0;
    for (let i = 0; i < ch.length; i++) {
      rawSum += ch[i] * ch[i];
      const v = ch[i] * gain;
      sum += v * v;
    }
    const rawRms = Math.sqrt(rawSum / ch.length);
    const rms = Math.sqrt(sum / ch.length);
    const pct = Math.min(100, Math.round(rms * 420));
    if (pct > sim.micPeakPct) sim.micPeakPct = pct;

    const meter = document.getElementById('sim-mic-bar');
    if (meter) meter.style.width = `${pct}%`;

    // Local VAD clears queued browser audio when caller speech is detected.
    const beh = A()?.behavior || {};
    if (
      sim.active &&
      beh.bargeIn === 'instant' &&
      (sim.scheduledSources.length > 0 || sim.agentState === 'speaking') &&
      Date.now() - sim.lastLocalBargeInAt > 650
    ) {
      const sens = beh.bargeInSensitivity || 'balanced';
      const rmsThresh = sens === 'high' ? 0.022 : sens === 'low' ? 0.065 : 0.038;
      const reqFrames = sens === 'high' ? 2 : sens === 'low' ? 4 : 3;
      if (rawRms >= rmsThresh) {
        sim.vadConsecutiveFrames += 1;
        if (sim.vadConsecutiveFrames >= reqFrames) {
          sim.vadConsecutiveFrames = 0;
          triggerInstantBargeIn('Local Mic VAD');
        }
      } else {
        sim.vadConsecutiveFrames = Math.max(0, sim.vadConsecutiveFrames - 1);
      }
    } else {
      sim.vadConsecutiveFrames = 0;
    }

    if (sim.active && sim.ws && sim.ws.readyState === WebSocket.OPEN) {
      const pcmBuf = resampleFloat32ToPcm16(ch, inSampleRate, sim.sampleRateIn, gain, sim.micResampler);
      if (pcmBuf.byteLength) {
        sim.ws.send(pcmBuf);
        sim.micTxBytes += pcmBuf.byteLength;
      }
    }
  }

  async function startMicCapture(attemptId) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Browser mediaDevices.getUserMedia is not available — open http://localhost (not LAN IP)');
    }

    stopMicCaptureOnly();

    const baseAudioConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    };

    let stream;
    if (sim.micDeviceId) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { ...baseAudioConstraints, deviceId: { exact: sim.micDeviceId } },
        });
      } catch {
        // Selected device unplugged/unavailable — fallback cleanly to default mic
        sim.micDeviceId = '';
        stream = await navigator.mediaDevices.getUserMedia({ audio: baseAudioConstraints });
      }
    } else {
      stream = await navigator.mediaDevices.getUserMedia({ audio: baseAudioConstraints });
    }

    if (attemptId !== sim.sessionAttemptId || (!sim.connecting && !sim.active)) {
      stream.getTracks().forEach((tr) => tr.stop());
      return;
    }
    sim.micStream = stream;
    try { connectRecordingMic(); } catch (err) {
      if (sim.recording) {
        sim.recording.error = `Could not capture the microphone: ${err.message || err}`;
        warnRecording(sim.recording, `Audio recording failed: ${sim.recording.error}`);
      }
    }
    const track = stream.getAudioTracks()[0];
    if (track) track.enabled = !sim.muted;
    sim.micActiveLabel = track?.label || 'Default microphone';
    sim.micPeakPct = 0;
    sim.micResampler = {};
    if (track) track.addEventListener('ended', () => {
      if (sim.micStream !== stream || (!sim.active && !sim.connecting)) return;
      sim.micEnabled = false;
      sim.events.push({ kind: 'msg', role: 'system', content: 'Microphone disconnected; continuing with text input.' });
      stopMicCaptureOnly();
      if (tab === 'test') render();
    });

    // Refresh device labels now that mic permission is granted
    refreshMicDevices().catch(() => {});

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!sim.captureCtx || sim.captureCtx.state === 'closed') {
      sim.captureCtx = new AudioCtx();
    }
    const ctx = sim.captureCtx;
    // CRITICAL on Windows Chrome/Edge: explicitly resume captureCtx after async getUserMedia!
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {}
    }

    const source = ctx.createMediaStreamSource(stream);
    const zeroGain = ctx.createGain();
    zeroGain.gain.value = 0;
    zeroGain.connect(ctx.destination);

    let procNode = null;

    // Prefer dedicated-thread AudioWorklet so V8 GC or tab throttling never drops mic frames
    if (ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      try {
        if (!ctx.__vacMicWorkletLoaded) {
          const workletCode = `
            class VacMicCaptureProcessor extends AudioWorkletProcessor {
              constructor() {
                super();
                this._buf = new Float32Array(512);
                this._pos = 0;
              }
              process(inputs) {
                const input = inputs[0];
                if (input && input[0]) {
                  const ch = input[0];
                  for (let i = 0; i < ch.length; i++) {
                    this._buf[this._pos++] = ch[i];
                    if (this._pos >= 512) {
                      this.port.postMessage(this._buf.slice(0));
                      this._pos = 0;
                    }
                  }
                }
                return true;
              }
            }
            registerProcessor('vac-mic-capture', VacMicCaptureProcessor);
          `;
          const blob = new Blob([workletCode], { type: 'application/javascript' });
          const url = URL.createObjectURL(blob);
          try {
            await ctx.audioWorklet.addModule(url);
            ctx.__vacMicWorkletLoaded = true;
          } finally {
            URL.revokeObjectURL(url);
          }
        }
        const workletNode = new AudioWorkletNode(ctx, 'vac-mic-capture');
        workletNode.port.onmessage = (ev) => {
          if (ev.data instanceof Float32Array) {
            handleMicFloatSamples(ev.data, ctx.sampleRate);
          }
        };
        source.connect(workletNode);
        workletNode.connect(zeroGain);
        procNode = workletNode;
      } catch {
        procNode = null;
      }
    }

    // Fallback to ScriptProcessorNode if AudioWorklet unavailable
    if (!procNode) {
      const processor = ctx.createScriptProcessor(1024, 1, 1);
      processor.onaudioprocess = (ev) => {
        handleMicFloatSamples(ev.inputBuffer.getChannelData(0), ctx.sampleRate);
      };
      source.connect(processor);
      processor.connect(zeroGain);
      procNode = processor;
    }

    if (attemptId !== sim.sessionAttemptId || (!sim.connecting && !sim.active)) {
      try { source.disconnect(); procNode.disconnect(); zeroGain.disconnect(); } catch {}
      stream.getTracks().forEach((tr) => tr.stop());
      return;
    }

    // Keep strong references on sim so Chromium V8 never garbage-collects active mic nodes
    sim.captureProcessor = procNode;
    sim.micNodes = { source, proc: procNode, zeroGain };

    const captureStartedAt = Date.now();
    sim.micWatchdog = setInterval(() => {
      if (sim.captureCtx && sim.captureCtx.state === 'suspended') {
        sim.captureCtx.resume().catch(() => {});
      }
      const tel = document.getElementById('sim-mic-telemetry');
      if (tel) {
        const kb = (sim.micTxBytes / 1024).toFixed(1);
        const stateStr = sim.captureCtx ? sim.captureCtx.state : 'none';
        const silentTooLong =
          !sim.muted && Date.now() - captureStartedAt > 4000 && sim.micPeakPct < 1;
        tel.textContent = silentTooLong
          ? `⚠ 0% audio from ${sim.micActiveLabel} (${kb} KB queued) — check hardware mute or select another microphone.`
          : `🎙️ ${sim.micActiveLabel} · AudioCtx: ${stateStr} · ${sim.muted ? 'Muted' : 'Queued'}: ${kb} KB · Peak: ${sim.micPeakPct}%`;
        tel.classList.toggle('wn', silentTooLong);
      }
    }, 1000);
  }

  function cleanupSimulatorMedia() {
    if (sim.drainTimer) { clearTimeout(sim.drainTimer); sim.drainTimer = null; }
    if (sim.hangupTimer) { clearTimeout(sim.hangupTimer); sim.hangupTimer = null; }
    sim.ws = null;
    if (sim.durationTimer) {
      clearInterval(sim.durationTimer);
      sim.durationTimer = null;
    }
    stopMicCaptureOnly();
    if (sim.captureCtx) {
      sim.captureCtx.close().catch(() => {});
      sim.captureCtx = null;
    }
    flushSimulatorSpeakerQueue();
    if (sim.playCtx) {
      sim.playCtx.close().catch(() => {});
      sim.playCtx = null;
    }
  }

  function finishSimulatorSession(reason, drainPlayback = false) {
    if (sim.recordingSaving) return;
    if (sim.drainTimer) { clearTimeout(sim.drainTimer); sim.drainTimer = null; }
    stopMicCaptureOnly();
    sim.connecting = false;
    sim.agentState = 'ended';
    sim.allowWebhooks = false;
    const finish = () => {
      sim.drainTimer = null;
      sim.active = false;
      const ctx = sim.recording;
      const after = () => {
        sim.recording = null;
        sim.recordingSaving = false;
        sim.recordAudio = false;
        sim.statusText = sim.lastError ? `Call Failed (${reason})` : `Call Ended (${reason})`;
        cleanupSimulatorMedia();
        loadCallLogsForCurrentAgent();
        if (tab === 'test') render();
      };
      if (ctx?.started) {
        const snapshot = {
          id: sim.callId, logSaved: sim.logSaved, greetingId: sim.selectedGreeting?.greeting_id || null,
          durationMs: Math.max(1, Date.now() - sim.startedAtMs), turns: sim.turns,
          avgTtfbMs: sim.avgTtfbMs, events: [...sim.events],
        };
        sim.recordingSaving = true;
        sim.statusText = 'Saving browser recording…';
        if (tab === 'test') render();
        finalizeBrowserRecording(ctx, snapshot).finally(after);
      } else {
        closeRecordingGraph(ctx);
        after();
      }
    };
    const remainingMs = sim.playCtx && sim.scheduledSources.length
      ? Math.max(0, (sim.nextPlayTime - sim.playCtx.currentTime) * 1000)
      : 0;
    if (drainPlayback && !sim.lastError && remainingMs > 10) {
      // AgentAudioDone means the provider finished sending, not that the
      // browser has finished playing (or recording) its buffered final utterance.
      sim.active = true;
      sim.statusText = 'Finishing browser audio playback…';
      sim.drainTimer = setTimeout(finish, Math.min(remainingMs + 120, 30000));
      if (tab === 'test') render();
    } else {
      finish();
    }
  }

  function effectiveSimulatorMode() {
    return globalServiceProvider('stt')?.type === 'speech_service' ||
      globalServiceProvider('tts')?.type === 'speech_service' ? 'speech_service' : 'deepgram';
  }

  async function startLiveCall(withMic = true) {
    if (sim.active || sim.connecting || sim.recordingSaving) return;
    const callAgent = A();
    const callCampaign = simulatorCampaign(callAgent?.id);
    if (!callCampaign) {
      sim.lastError = 'Assign this bot to a campaign before starting a browser call.';
      sim.statusText = 'Campaign assignment required';
      render();
      document.getElementById('sim-call-setup')?.scrollIntoView?.({ block: 'center' });
      return;
    }
    const campaignBlockers = [
      ...validateCampaignLocal(callCampaign).filter((item) => item[0] === 'er').map((item) => `Campaign: ${item[2]}`),
      ...validateAgentLocal(callAgent).filter((item) => item[0] === 'er').map((item) => `Agent: ${item[2]}`),
    ];
    if (campaignBlockers.length) {
      sim.lastError = `Campaign “${callCampaign.name}” is not ready: ${campaignBlockers.join('; ')}.`;
      sim.statusText = 'Campaign setup required';
      render();
      document.getElementById('sim-call-setup')?.scrollIntoView?.({ block: 'center' });
      return;
    }
    if (sim.recordAudio && !recordingMime()) {
      sim.lastError = 'This browser does not support the required audio recorder. Uncheck recording or use a supported browser.';
      sim.statusText = 'Recording unavailable';
      render();
      return;
    }
    let savedServices = {};
    try {
      savedServices = JSON.parse(snap || '{}').services || {};
    } catch {}
    const missingGlobalServices = ['stt', 'llm', 'tts'].filter((kind) => {
      const selection = S?.services?.[kind];
      const saved = savedServices[kind];
      return (
        !globalServiceProvider(kind) ||
        !String(selection?.model || '').trim() ||
        saved?.providerId !== selection?.providerId ||
        saved?.model !== selection?.model
      );
    });
    if (missingGlobalServices.length) {
      sim.lastError = `Select and save one global provider/model for ${missingGlobalServices.join(', ')} on the Plug-Ins page before starting a live session.`;
      sim.statusText = 'Global Services Need Setup';
      sim.agentState = 'idle';
      render();
      return;
    }

    const mode = effectiveSimulatorMode();
    if (mode !== 'deepgram') {
      sim.lastError = 'Local speech is not connected to an LLM in Live Bot. Select and save supported Deepgram Voice Agent providers on Plug-Ins.';
      sim.statusText = 'Local speech conversation unavailable';
      render();
      return;
    }
    if (serverlessCloudMode && !readCloudSecrets().DEEPGRAM_API_KEY) {
      sim.lastError = 'Add a Deepgram API key in API Keys before starting a browser test.';
      sim.statusText = 'Deepgram key needed';
      render();
      return;
    }
    if (sim.recordAudio && sim.recordingFallback) {
      if (!window.confirm('There is an unsaved recording in this tab. Download it first, or continue and discard it. Continue?')) return;
      URL.revokeObjectURL(sim.recordingFallback.url);
      sim.recordingFallback = null;
    }
    sim.connecting = true;
    const attemptId = ++sim.sessionAttemptId;
    sim.callId = '';
    sim.logSaved = null;
    sim.selectedGreeting = null;
    sim.sessionSettings = null;
    if (!sim.recordingFallback) sim.recordingError = '';
    sim.muted = false;
    sim.micEnabled = withMic;
    sim.lastError = null;
    sim.turns = 0;
    sim.bargeInCount = 0;
    sim.bargeInSuppressAudio = false;
    sim.vadConsecutiveFrames = 0;
    sim.lastLocalBargeInAt = 0;
    sim.lastTtfbMs = null;
    sim.avgTtfbMs = null;
    sim.lastLlmMs = null;
    sim.disposition = null;
    sim.transferredTo = null;
    sim.events = [];
    sim.elapsedSec = 0;
    sim.micTxBytes = 0;
    sim.micPeakPct = 0;
    sim.statusText = 'Preparing browser test…';
    sim.agentState = 'connecting';

    sim.sampleRateIn = sim.bandwidth === 'telephony' ? 8000 : 16000;
    sim.sampleRateOut = sim.bandwidth === 'telephony' ? 8000 : 24000;

    // Unlock BOTH Speaker AND Microphone WebAudio contexts synchronously inside click gesture with interactive low-latency hint!
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) {
      sim.connecting = false;
      sim.lastError = 'WebAudio is unavailable in this browser. Use a supported browser for voice tests.';
      sim.statusText = 'Audio unavailable';
      if (tab === 'test') render();
      return;
    }
    if (AudioCtx) {
      try {
        sim.playCtx = new AudioCtx({ latencyHint: 'interactive' });
            sim.nextPlayTime = 0;
        sim.playCtx.resume().catch(() => {});
        if (withMic) {
          sim.captureCtx = new AudioCtx({ latencyHint: 'interactive' });
          sim.captureCtx.resume().catch(() => {});
        }
      } catch (audioErr) {
        sim.connecting = false;
        sim.lastError = `Could not initialize browser audio: ${audioErr.message}`;
        sim.statusText = 'Audio unavailable';
        cleanupSimulatorMedia();
        if (tab === 'test') render();
        return;
      }
    }

    if (tab === 'test') render();
    if (withMic) {
      try {
        await startMicCapture(attemptId);
      } catch (micErr) {
        if (attemptId !== sim.sessionAttemptId) return;
        sim.micEnabled = false;
        const iframeHint = isInIframe
          ? ' (Embedded preview iframe blocked mic — click "↗ Open in Tab" in the side panel for physical mic, or continue right here using Speaker + Text below!)'
          : '';
        sim.events.push({
          kind: 'msg',
          role: 'system',
          content: `Microphone unavailable (${micErr.message})${iframeHint} — continuing in Speaker + Text mode if the connection succeeds.`,
        });
      }
    }

    if (attemptId !== sim.sessionAttemptId || !sim.connecting) return;
    if (sim.recordAudio) {
      try { sim.recording = prepareBrowserRecording(A()); }
      catch (err) {
        sim.connecting = false;
        sim.lastError = `Could not prepare audio recording: ${err.message || err}`;
        sim.statusText = 'Recording unavailable';
        cleanupSimulatorMedia();
        if (tab === 'test') render();
        return;
      }
    }
    if (sim.playCtx && sim.playCtx.state === 'suspended') {
      sim.playCtx.resume().catch(() => {});
    }

    renderSimulatorDomOnly();

    const linkedCamp = simulatorCampaign(A().id);

    // ---- SERVERLESS CLOUD DIRECT MODE (GitHub Pages / Vercel / Static Host) ----
    if (serverlessCloudMode) {
      startDirectBrowserSimulatorSession(mode, A(), linkedCamp, attemptId);
      return;
    }

    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = vacWithWsAuth(`${wsProto}//${window.location.host}/ws/simulator`);

    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    sim.ws = ws;

    ws.onopen = () => {
      if (attemptId !== sim.sessionAttemptId) { ws.close(); return; }
      ws.send(
        JSON.stringify({
          type: 'start',
          upstreamMode: mode,
          agentId: A().id,
          campaignId: linkedCamp?.id,
          bandwidth: sim.bandwidth,
          lead: sim.lead,
          allowWebhooks: sim.allowWebhooks,
          recordAudio: sim.recordAudio,
          draftState: S, // Tests current Console settings live even before Save!
        })
      );
    };

    ws.onerror = () => {
      if (attemptId !== sim.sessionAttemptId) return;
      if (!sim.lastError) {
        sim.lastError = 'Browser WebSocket connection to /ws/simulator failed. Ensure the server is running and refresh the page.';
      }
    };

    ws.onmessage = (ev) => {
      if (attemptId !== sim.sessionAttemptId) return;
      if (ev.data instanceof ArrayBuffer) {
        enqueuePcm16Playback(ev.data);
        return;
      }

      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }

      if (msg.type === 'session_connecting') {
        sim.statusText = 'Handshaking with Deepgram Voice Agent API…';
        sim.selectedGreeting = msg.greeting || null;
        sim.sessionSettings = msg.settings;
        renderSimulatorDomOnly();
      } else if (msg.type === 'session_started') {
        sim.connecting = false;
        sim.active = true;
        sim.lastError = null;
        sim.startedAtMs = Date.now();
        sim.callId = msg.callId || '';
        sim.selectedGreeting = msg.greeting || null;
        sim.sessionSettings = msg.settings;
        sim.statusText = 'Connected to Deepgram — browser test';
        try { startPreparedRecording(); }
        catch (err) {
          sim.lastError = `Audio recording could not start: ${err.message || err}. The browser test was ended.`;
          if (sim.recording) sim.recording.error = sim.lastError;
          sim.events.push({ kind: 'msg', role: 'system', content: sim.lastError });
          hangupLiveCall();
          return;
        }
        if (sim.durationTimer) clearInterval(sim.durationTimer);
        sim.durationTimer = setInterval(() => {
          sim.elapsedSec = Math.floor((Date.now() - sim.startedAtMs) / 1000);
          const durEl = document.getElementById('sim-kpi-dur');
          if (durEl) durEl.textContent = formatDuration(sim.elapsedSec);
        }, 1000);
        if (tab === 'test') render();
      } else if (msg.type === 'barge_in') {
        if ((A()?.behavior?.bargeIn || 'instant') !== 'off') {
          if (Date.now() - sim.lastLocalBargeInAt > 500) {
            triggerInstantBargeIn(msg.source === 'client_vad' ? 'Instant Mic VAD' : 'Deepgram VAD');
          } else {
            flushSimulatorSpeakerQueue();
            sim.bargeInSuppressAudio = true;
          }
        }
      } else if (msg.type === 'agent_state') {
        sim.agentState = msg.state;
        if (msg.state === 'thinking' || msg.state === 'speaking') {
          sim.bargeInSuppressAudio = false;
        }
        const labels = {
          listening: 'Listening for Caller…',
          user_speaking: 'Caller Speaking…',
          thinking: 'LLM Thinking…',
          speaking: 'Bot Speaking…',
        };
        sim.statusText = labels[msg.state] || msg.state;
        updateSimStatusDom();
        updatePersonaStageDom();
      } else if (msg.type === 'transcript') {
        sim.bargeInSuppressAudio = false;
        if (msg.role === 'user') {
          sim.turns += 1;
        }
        sim.events.push({
          kind: 'msg',
          role: msg.role,
          content: msg.content,
          languages: msg.languages,
        });
        renderSimFeedDom();
        updateSimKpisDom();
      } else if (msg.type === 'latency') {
        sim.lastTtfbMs = msg.ttfbMs;
        sim.avgTtfbMs = msg.avgTtfbMs;
        sim.lastLlmMs = msg.llmMs;
        updateSimKpisDom();
      } else if (msg.type === 'function_call') {
        if (msg.disposition) sim.disposition = msg.disposition;
        if (msg.transferredTo) sim.transferredTo = msg.transferredTo;
        sim.events.push({
          kind: 'fn',
          id: msg.id,
          name: msg.name,
          args: msg.args,
          status: msg.status,
          response: msg.response,
        });
        renderSimFeedDom();
        updateSimKpisDom();
      } else if (msg.type === 'partial_transcript') {
        sim.statusText = `Caller: "${String(msg.content || '').slice(0, 48)}…"`;
        updateSimStatusDom();
      } else if (msg.type === 'dg_warning' || msg.type === 'warning') {
        sim.events.push({
          kind: 'msg',
          role: 'system',
          content: `⚠ Warning${msg.code ? ` (${msg.code})` : ''}: ${msg.message}`,
        });
        renderSimFeedDom();
      } else if (msg.type === 'error') {
        sim.lastError = `${msg.code ? `[${msg.code}] ` : ''}${msg.error}`;
        sim.events.push({
          kind: 'msg',
          role: 'system',
          content: `✗ ${sim.lastError}`,
        });
        sim.statusText = `Error: ${msg.code || 'Session failed'}`;
        renderSimFeedDom();
        updateSimStatusDom();
      } else if (msg.type === 'call_ended') {
        if (msg.fatalError && !sim.lastError) sim.lastError = msg.fatalError;
        sim.logSaved = msg.logSaved;
        finishSimulatorSession(msg.reason, msg.reason === 'bot_end_call');
      }
    };

    ws.onclose = () => {
      if (attemptId !== sim.sessionAttemptId || sim.drainTimer) return;
      if (sim.active || sim.connecting) {
        if (sim.hangupTimer) {
          sim.events.push({ kind: 'msg', role: 'system', content: 'The connection closed before transcript saving was confirmed. Refresh test history to check whether it was saved.' });
        }
        finishSimulatorSession('connection_closed');
      }
    };
  }

  async function startDirectBrowserSimulatorSession(mode, agent, camp, attemptId) {
    const dgKey = readCloudSecrets().DEEPGRAM_API_KEY || '';
    if (mode === 'deepgram' && !dgKey) {
      sim.connecting = false;
      sim.lastError = 'Click "🔑 API Keys" in the side panel and paste your DEEPGRAM_API_KEY to talk live with Deepgram STT + TTS.';
      cleanupSimulatorMedia();
      if (tab === 'test') render();
      return;
    }

    if (agent.randomGreetingEnabled !== false) {
      const rows = await ensureGreetingCatalogLoaded();
      if (attemptId !== sim.sessionAttemptId || !sim.connecting) return;
      const selected = await selectStaticGreeting(agent.id, rows, agent.greeting);
      if (attemptId !== sim.sessionAttemptId || !sim.connecting) return;
      sim.selectedGreeting = selected.row || null;
      if (!sim.selectedGreeting) {
        sim.events.push({ kind: 'msg', role: 'system', content: 'Greeting library unavailable; the configured campaign opening will be used after the one-second listen.' });
      } else if (selected.storageWarning) {
        sim.events.push({ kind: 'msg', role: 'system', content: 'Greeting rotation storage is unavailable; the no-repeat cycle lasts only in this tab.' });
      }
      renderSimulatorDomOnly();
    }
    const settings = buildSettings(agent, sim.selectedGreeting?.greeting_text || '');
    if (agent.acceptViciCalls) {
      const vars = {
        lead_id: String(sim.lead?.lead_id || '').trim(), first_name: String(sim.lead?.first_name || '').trim(),
        phone_number: String(sim.lead?.phone_number || '').trim(), state: String(sim.lead?.state || '').trim(),
        age: String(sim.lead?.age || '').trim(), campaign_id: String(camp?.viciCampaign || '').trim(),
      };
      const hydrate = (text) => String(text || '').replace(
        /\{\{\s*(lead_id|first_name|phone_number|state|age|campaign_id)\s*\}\}/gi,
        (_match, key) => vars[String(key).toLowerCase()] ?? ''
      );
      settings.agent.greeting = hydrate(settings.agent.greeting);
      settings.agent.think.prompt = hydrate(settings.agent.think.prompt);
    }
    settings.audio = {
      input: { encoding: 'linear16', sample_rate: sim.sampleRateIn },
      output: { encoding: 'linear16', sample_rate: sim.sampleRateOut, container: 'none' },
    };
    if (Array.isArray(settings.agent?.think?.functions)) {
      settings.agent.think.functions = settings.agent.think.functions.map((f) => {
        const clone = { ...f };
        delete clone.endpoint;
        clone.defer_until_eot = true;
        return clone;
      });
    }
    const leadLines = [
      sim.lead?.lead_id ? `- lead_id: ${sim.lead.lead_id}` : '',
      sim.lead?.first_name ? `- first_name: ${sim.lead.first_name}` : '',
      sim.lead?.state ? `- state: ${sim.lead.state}` : '',
      sim.lead?.age ? `- listed_age: ${sim.lead.age}` : '',
    ].filter(Boolean);
    if (leadLines.length && settings.agent?.think?.prompt) {
      settings.agent.think.prompt += `\n\n=== BROWSER TEST LEAD (not a live VICIdial call) ===\n${leadLines.join('\n')}`;
    }
    const testConstraints = '\n\n[Browser test constraints] This is not a live VICIdial call. A transfer, disposition or do-not-call update cannot be completed here. Never claim one succeeded when the tool reports it was not executed. Be truthful about being an AI assistant if asked.';
    if (settings.agent.think.prompt.length + testConstraints.length > 25000) {
      sim.lastError = 'The agent prompt is too long to add browser-test safety context. Shorten it before starting a test.';
      finishSimulatorSession('prompt_too_long');
      return;
    }
    settings.agent.think.prompt += testConstraints;
    sim.sessionSettings = settings;
    let prepared;
    try { prepared = window.VacOpening.prepareDelayedOpening(settings); }
    catch (err) {
      sim.lastError = err.message || 'Could not prepare the opening.';
      finishSimulatorSession('opening_settings_error');
      return;
    }

    const dgWs = new WebSocket('wss://agent.deepgram.com/v1/agent/converse', ['token', dgKey]);
    dgWs.binaryType = 'arraybuffer';
    let settingsApplied = false;
    let lastMicSendAt = 0;
    let lastUserTurnAt = 0;
    let awaitingFirstAudio = false;
    const ttfbArr = [];
    let silenceTimer = null;
    let keepAliveTimer = null;
    let endRequested = false;
    let pendingEndId = null;
    const conversationMemory = window.VacPersona.createConversationMemory();
    const cancelledFunctionIds = new Set();
    let endTimer = null;
    const openingGate = window.VacOpening.createOpeningGate({
      greeting: prepared.greeting,
      sendOpening(message) {
        if (attemptId === sim.sessionAttemptId && dgWs.readyState === WebSocket.OPEN) {
          dgWs.send(JSON.stringify({ type: 'InjectAgentMessage', message }));
        }
      },
      onSendError() {
        sim.events.push({ kind: 'msg', role: 'system', content: 'The configured opening could not be sent to Deepgram. Check the provider connection.' });
        renderSimFeedDom();
      },
      playAudio(chunk) {
        if (awaitingFirstAudio && lastUserTurnAt > 0) {
          awaitingFirstAudio = false;
          const ttfb = Date.now() - lastUserTurnAt;
          ttfbArr.push(ttfb);
          sim.lastTtfbMs = ttfb;
          sim.avgTtfbMs = Math.round(ttfbArr.reduce((a, b) => a + b, 0) / ttfbArr.length);
          updateSimKpisDom();
        }
        enqueuePcm16Playback(chunk);
      },
      onOverflow() {
        sim.events.push({ kind: 'msg', role: 'system', content: 'Early provider audio exceeded the opening buffer and was dropped.' });
        renderSimFeedDom();
      },
    });
    const connectTimer = setTimeout(() => {
      if (attemptId === sim.sessionAttemptId && !settingsApplied) {
        sim.lastError = 'Deepgram did not confirm the session settings in time.';
        endDirect('upstream_timeout');
      }
    }, 15000);

    // Wrap dgWs so startMicCapture's sim.ws.send(pcmBuf) only transmits after SettingsApplied
    sim.ws = {
      get readyState() {
        return dgWs.readyState;
      },
      _directDg: true,
      send(payload) {
        if (dgWs.readyState !== WebSocket.OPEN) return;
        if (typeof payload === 'string') {
          dgWs.send(payload);
        } else if (settingsApplied) {
          lastMicSendAt = Date.now();
          dgWs.send(payload);
        }
      },
      injectText(text) {
        if (dgWs.readyState === WebSocket.OPEN && settingsApplied) {
          openingGate.userTurn();
          lastUserTurnAt = Date.now();
          awaitingFirstAudio = true;
          dgWs.send(JSON.stringify({ type: 'InjectUserMessage', content: text }));
        }
      },
      markUserStarted() { openingGate.userStarted(); },
      close() {
        endDirect('user_hangup');
      },
    };

    const endDirect = (reason) => {
      openingGate.cancel();
      if (silenceTimer) { clearInterval(silenceTimer); silenceTimer = null; }
      if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
      if (endTimer) { clearTimeout(endTimer); endTimer = null; }
      clearTimeout(connectTimer);
      try { if (dgWs.readyState === WebSocket.OPEN || dgWs.readyState === WebSocket.CONNECTING) dgWs.close(1000, reason); } catch {}
      finishSimulatorSession(reason, reason === 'bot_end_call');
    };

    dgWs.onmessage = (ev) => {
      if (attemptId !== sim.sessionAttemptId) return;
      if (ev.data instanceof ArrayBuffer) {
        openingGate.audio(ev.data);
        return;
      }

      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      if (msg.type === 'Welcome') {
        sim.statusText = 'Sending Agent Settings to Deepgram…';
        updateSimStatusDom();
        dgWs.send(JSON.stringify(prepared.settings));
      } else if (msg.type === 'SettingsApplied') {
        if (settingsApplied) return;
        settingsApplied = true;
        openingGate.start();
        clearTimeout(connectTimer);
        sim.connecting = false;
        sim.active = true;
        sim.startedAtMs = Date.now();
        sim.callId = `static_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
        sim.statusText = 'Live on Deepgram Voice Agent API (Direct Browser WSS)';
        try { startPreparedRecording(); }
        catch (err) {
          sim.lastError = `Audio recording could not start: ${err.message || err}. The browser test was ended.`;
          if (sim.recording) sim.recording.error = sim.lastError;
          sim.events.push({ kind: 'msg', role: 'system', content: sim.lastError });
          endDirect('recording_error');
          return;
        }
        if (sim.durationTimer) clearInterval(sim.durationTimer);
        sim.durationTimer = setInterval(() => {
          sim.elapsedSec = Math.floor((Date.now() - sim.startedAtMs) / 1000);
          const durEl = document.getElementById('sim-kpi-dur');
          if (durEl) durEl.textContent = formatDuration(sim.elapsedSec);
        }, 1000);
        const zeroFrame = new ArrayBuffer(Math.floor(sim.sampleRateIn * 0.05) * 2);
        silenceTimer = setInterval(() => {
          if (dgWs.readyState === WebSocket.OPEN && Date.now() - lastMicSendAt > 250) {
            dgWs.send(zeroFrame);
          }
        }, 50);
        keepAliveTimer = setInterval(() => {
          if (dgWs.readyState === WebSocket.OPEN) {
            dgWs.send(JSON.stringify({ type: 'KeepAlive' }));
          }
        }, 5000);
        if (tab === 'test') render();
      } else if (msg.type === 'UserStartedSpeaking') {
        openingGate.userStarted();
        if ((agent.behavior?.bargeIn || 'instant') !== 'off') {
          if (Date.now() - sim.lastLocalBargeInAt > 500) {
            triggerInstantBargeIn('Deepgram VAD');
          } else {
            flushSimulatorSpeakerQueue();
            sim.bargeInSuppressAudio = true;
          }
        }
      } else if (msg.type === 'AgentThinking') {
        sim.bargeInSuppressAudio = false;
        sim.agentState = 'thinking';
        sim.statusText = 'LLM Thinking…';
        updateSimStatusDom();
      } else if (msg.type === 'AgentStartedSpeaking') {
        sim.bargeInSuppressAudio = false;
        sim.agentState = 'speaking';
        sim.statusText = 'Bot Speaking…';
        updateSimStatusDom();
        updatePersonaStageDom();
      } else if (msg.type === 'AgentAudioDone') {
        openingGate.afterRelease(() => {
          if (attemptId !== sim.sessionAttemptId) return;
          if (endRequested) { endDirect('bot_end_call'); return; }
          sim.agentState = 'listening';
          sim.statusText = 'Listening for Caller…';
          updateSimStatusDom();
          updatePersonaStageDom();
        });
      } else if (msg.type === 'ConversationText') {
        sim.bargeInSuppressAudio = false;
        if (msg.role === 'user') {
          conversationMemory.addUserText(msg.content);
        } else {
          conversationMemory.addAssistantText(msg.content);
        }
        if (msg.role === 'user') {
          openingGate.userTurn();
          sim.turns += 1;
          lastUserTurnAt = Date.now();
          awaitingFirstAudio = true;
        }
        sim.events.push({ kind: 'msg', role: msg.role, content: msg.content });
        renderSimFeedDom();
        updateSimKpisDom();
      } else if (msg.type === 'FunctionCallRequest') {
        const list = Array.isArray(msg.functions) ? msg.functions : [msg];
        for (const fn of list) {
          if (cancelledFunctionIds.has(fn.id)) continue;
          if (fn.client_side === false) {
            sim.events.push({ kind: 'fn', id: fn.id, name: fn.name, status: 'server_side', args: {} });
            renderSimFeedDom();
            continue;
          }
          let args = {};
          try { args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments || '{}') : fn.arguments || {}; } catch {}
          const enabled = agent.fnIds?.some((id) => S.functions.find((f) => f.id === id)?.name === fn.name);
          let resp;
          if (!enabled) {
            resp = { ok: false, error: 'Function is not enabled for this agent.' };
          } else if (fn.name === 'set_disposition' || fn.name === 'transfer_to_live_agent') {
            if (fn.name === 'transfer_to_live_agent') {
              const sanitized = conversationMemory.sanitizeTransferArgs(args);
              args = sanitized.args;
              const blockers = conversationMemory.qualificationBlockers(simulatorCampaign(agent.id));
              resp = { ok: false, simulated: true, ...(sanitized.omitted.length ? { omitted_unverified_fields: sanitized.omitted } : {}), ...(sanitized.corrected.length ? { corrected_fields: sanitized.corrected } : {}), error: blockers.length ? `Transfer blocked: ${blockers.join(' ')} No transfer was simulated.` : 'Browser tests have no VICIdial call. No record or transfer was changed.' };
            } else {
              resp = { ok: false, simulated: true, error: 'Browser tests have no VICIdial call. No record or transfer was changed.' };
            }
          } else if (fn.name === 'end_call') {
            resp = { ok: true, action: 'end_browser_test_after_speech' };
            endRequested = true;
            pendingEndId = fn.id;
            if (endTimer) clearTimeout(endTimer);
            endTimer = setTimeout(() => endDirect('bot_end_call'), 9000);
          } else {
            resp = { ok: false, error: 'Custom webhooks require the authenticated console backend and explicit consent.' };
          }
          sim.events.push({ kind: 'fn', id: fn.id, name: fn.name, args, status: resp.simulated ? 'simulated' : resp.ok ? 'completed' : 'failed', response: resp });
          renderSimFeedDom();
          updateSimKpisDom();
          if (dgWs.readyState === WebSocket.OPEN) {
            dgWs.send(
              JSON.stringify({
                type: 'FunctionCallResponse',
                id: fn.id,
                name: fn.name,
                content: JSON.stringify(resp),
                ...(fn.thought_signature ? { thought_signature: fn.thought_signature } : {}),
              })
            );
          }
        }
      } else if (msg.type === 'FunctionCallCancelled') {
        const cancelledId = String(msg.id || msg.function_call_id || '');
        if (cancelledId) cancelledFunctionIds.add(cancelledId);
        if (endRequested && cancelledId === pendingEndId) { endRequested = false; pendingEndId = null; if (endTimer) clearTimeout(endTimer); endTimer = null; }
        sim.events.push({ kind: 'fn', id: msg.id, name: msg.name || 'function', status: 'cancelled', args: {} });
        renderSimFeedDom();
      } else if (msg.type === 'Warning' || msg.type === 'InjectionRefused') {
        sim.events.push({ kind: 'msg', role: 'system', content: `Warning: ${msg.description || msg.message || msg.type}` });
        renderSimFeedDom();
      } else if (msg.type === 'Error') {
        sim.lastError = `[${msg.code || 'DG_ERR'}] ${msg.description || msg.message || 'Deepgram error'}`;
        endDirect('deepgram_error');
      }
    };

    dgWs.onerror = () => {
      if (attemptId !== sim.sessionAttemptId) return;
      if (!sim.lastError) sim.lastError = 'Direct WebSocket connection to wss://agent.deepgram.com failed — verify DEEPGRAM_API_KEY in 🔑 API Keys.';
      endDirect('ws_error');
    };
    dgWs.onclose = (event) => {
      if (attemptId !== sim.sessionAttemptId || sim.drainTimer) return;
      if (sim.active || sim.connecting) {
        if (!sim.lastError) sim.lastError = `Deepgram connection closed (${event.code}${event.reason ? `: ${event.reason}` : ''}).`;
        endDirect('disconnected');
      }
    };
  }

  function hangupLiveCall() {
    if (sim.ws && !sim.ws._directDg && sim.ws.readyState === WebSocket.OPEN && !sim.drainTimer) {
      const closingWs = sim.ws;
      stopMicCaptureOnly();
      sim.statusText = 'Ending browser test…';
      updateSimStatusDom();
      closingWs.send(JSON.stringify({ type: 'stop' }));
      // Normally the server saves the log and acknowledges immediately. Avoid
      // leaving the UI stuck if the connection is lost before acknowledgement.
      if (sim.hangupTimer) clearTimeout(sim.hangupTimer);
      sim.hangupTimer = setTimeout(() => {
        ++sim.sessionAttemptId;
        try { closingWs.close(); } catch {}
        sim.events.push({ kind: 'msg', role: 'system', content: 'Transcript saving was not confirmed. Refresh test history to check whether it was saved.' });
        finishSimulatorSession('user_hangup');
      }, 3000);
      return;
    }
    ++sim.sessionAttemptId;
    if (sim.ws && sim.ws._directDg) {
      sim.ws.close();
      return;
    }
    if (sim.ws && sim.ws.readyState === WebSocket.CONNECTING) {
      try { sim.ws.close(); } catch {}
    }
    finishSimulatorSession('user_hangup');
  }

  function injectCallerUtterance(text) {
    const clean = String(text || '').trim();
    if (!clean || !sim.ws) return;
    if (sim.scheduledSources.length > 0 || sim.agentState === 'speaking') {
      triggerInstantBargeIn('Text Barge-In');
    } else {
      flushSimulatorSpeakerQueue();
    }
    sim.bargeInSuppressAudio = false;
    if (sim.ws._directDg) {
      sim.ws.injectText(clean);
      return;
    }
    if (sim.ws.readyState !== WebSocket.OPEN) return;
    sim.ws.send(JSON.stringify({ type: 'inject_user_message', content: clean }));
  }

  function formatDuration(sec) {
    const m = String(Math.floor(sec / 60)).padStart(2, '0');
    const s = String(sec % 60).padStart(2, '0');
    return `${m}:${s}`;
  }

  function updateSimStatusDom() {
    const pill = document.getElementById('sim-state-pill');
    if (pill) {
      pill.textContent = sim.statusText;
      pill.className = `pill ${sim.active ? 'ok' : sim.connecting ? 'wn' : sim.lastError ? 'er' : ''}`;
    }
  }

  function updateSimKpisDom() {
    const elTurns = document.getElementById('sim-kpi-turns');
    const elTtfb = document.getElementById('sim-kpi-ttfb');
    const elBarge = document.getElementById('sim-kpi-barge');
    const elDispo = document.getElementById('sim-kpi-dispo');
    const elXfer = document.getElementById('sim-kpi-xfer');
    if (elTurns) elTurns.textContent = String(sim.turns);
    if (elTtfb) {
      if (sim.lastTtfbMs !== null) {
        const fastBadge = sim.lastTtfbMs <= 650 ? '⚡ ' : '';
        elTtfb.textContent = `${fastBadge}${sim.lastTtfbMs} ms (avg ${sim.avgTtfbMs} ms)`;
        elTtfb.className = `kpi-val ${sim.lastTtfbMs <= 700 ? 'ok' : ''}`;
      } else {
        elTtfb.textContent = '—';
      }
    }
    if (elBarge) {
      elBarge.textContent = String(sim.bargeInCount || 0);
      elBarge.className = `kpi-val ${sim.bargeInCount > 0 ? 'ok' : ''}`;
    }
    if (elDispo) {
      elDispo.textContent = 'Not connected';
      elDispo.className = 'kpi-val';
    }
    if (elXfer) {
      elXfer.textContent = 'Not connected';
      elXfer.className = 'kpi-val';
    }
  }

  function simFeedEventHtml(ev) {
    if (ev.kind === 'msg') {
      if (ev.role === 'system') return `<div class="msg-sys">${esc(ev.content)}</div>`;
      const cls = ev.role === 'user' ? 'msg-bubble msg-user' : 'msg-bubble msg-bot';
      const who = ev.role === 'user' ? 'Caller' : A().name;
      return `<div class="${cls}">
        <div style="font-size:10.5px;opacity:0.75;margin-bottom:2px;font-weight:600">${esc(who)}</div>
        <div>${esc(ev.content)}</div>
      </div>`;
    }
    const outcome = ev.status === 'cancelled' ? 'Cancelled' :
      ev.status === 'simulated' ? 'Not executed · browser test only' :
      ev.status === 'failed' ? 'Not executed / failed' :
      ev.status === 'server_side' ? 'Provider-reported server-side action · not verified here' :
      ev.name === 'end_call' ? 'Browser test ending' : 'Webhook response received';
    return `<div class="fn-event ${ev.status === 'cancelled' || ev.status === 'failed' || ev.status === 'simulated' ? 'cancelled' : ''}">
      <div style="font-weight:700;margin-bottom:3px">${esc(outcome)}: <code>${esc(ev.name)}</code></div>
      <div><b>Args:</b> <code>${esc(JSON.stringify(ev.args || {}))}</code></div>
      ${ev.response ? `<div style="margin-top:2px"><b>Result:</b> <code>${esc(JSON.stringify(ev.response))}</code></div>` : ''}
    </div>`;
  }

  function renderSimFeedDom() {
    const feed = document.getElementById('sim-feed');
    if (!feed) return;
    const agentName = A().name;
    if (sim.events.length === 0) {
      feed.innerHTML = `<div class="note" style="margin:auto;text-align:center">
        Press <b>📞 Start Live Mic Call</b> (or <b>💬 Start Text+Audio Call</b>) above to talk to <b>${esc(agentName)}</b> and see provider transcripts, replies, and function outcomes here. This browser test is not a VICIdial call.
      </div>`;
      feed.dataset.renderedCount = '0';
      feed.dataset.agentName = agentName;
      return;
    }
    const renderedCount = Number(feed.dataset.renderedCount || 0);
    if (feed.dataset.agentName !== agentName || renderedCount > sim.events.length) {
      feed.innerHTML = sim.events.map(simFeedEventHtml).join('');
    } else if (renderedCount < sim.events.length) {
      feed.insertAdjacentHTML('beforeend', sim.events.slice(renderedCount).map(simFeedEventHtml).join(''));
    }
    feed.dataset.renderedCount = String(sim.events.length);
    feed.dataset.agentName = agentName;
    feed.scrollTop = feed.scrollHeight;
  }

  function updateSelectedGreetingDom() {
    const element = document.getElementById('sim-selected-greeting');
    if (!element) return;
    const selected = sim.selectedGreeting;
    element.textContent = selected
      ? `Selected greeting #${selected.greeting_id} · ${selected.persona} · ${selected.context} · ${selected.tone} (selection does not confirm playback).`
      : 'The saved opening is used if random greetings are off or unavailable.';
  }

  function renderSimulatorDomOnly() {
    updateSelectedGreetingDom();
    updateSimStatusDom();
    updateSimKpisDom();
    updatePersonaStageDom();
    renderSimFeedDom();
  }

  async function loadViciBridgeStatus() {
    if (serverlessCloudMode) {
      // The old static demo invented bridge CDRs and latency. Keep any old
      // browser-local data intact, but do not present it as live bridge history.
      viciMon.logs = [];
      viciMon.status = {
        audioSocketListening: false,
        sipRtpListening: false,
        totalCalls: 0,
        completedTransfers: 0,
        dncCount: 0,
        activeCallsCount: 0,
        activeCalls: [],
        cloudModeNotice: true,
      };
      viciMon.analytics = {
        totalBridgeCalls: 0, transfersCount: 0, transferRatePct: 0,
        dncCount: 0, dncRatePct: 0, recordedCount: 0, avgDurationSec: 0,
        avgTtfbMs: null, p95TtfbMs: null,
        byTransport: { sip_rtp: 0, audiosocket: 0 },
        byDisposition: {}, byCampaign: [],
      };
      viciMon.loaded = true;
      if (tab === 'vici' || tab === 'wallboard') render();
      else if (tab === 'dashboard') renderExecutiveCommandDeck();
      return;
    }
    try {
      const [statusRes, anaRes] = await Promise.all([
        fetch('/api/vici/status'),
        fetch('/api/vici/analytics'),
      ]);
      const data = await statusRes.json();
      const anaData = await anaRes.json();
      if (data.ok) {
        viciMon.status = data.bridge || null;
        viciMon.logs = data.logs || [];
        viciMon.loaded = true;
      }
      if (anaData.ok) {
        viciMon.analytics = anaData.analytics || null;
      }
      if (tab === 'vici' || tab === 'wallboard') render();
      else if (tab === 'dashboard') renderExecutiveCommandDeck();
    } catch {}
  }

  function ensureViciMonitorWs() {
    if (serverlessCloudMode) return;
    if (viciMon.ws && (viciMon.ws.readyState === WebSocket.OPEN || viciMon.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    try {
      const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(vacWithWsAuth(`${wsProto}//${window.location.host}/ws/vici-monitor`));
      viciMon.ws = ws;
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.status) viciMon.status = msg.status;
          if (msg.type === 'call_ended' && msg.cdr) {
            viciMon.logs = [msg.cdr, ...viciMon.logs.filter((x) => x.id !== msg.cdr.id)].slice(0, 25);
          }
          if ((tab === 'vici' || tab === 'wallboard') && !viciMon.simRunning) {
            if (msg.type === 'call_ended' || msg.type === 'call_started' || tab === 'wallboard') {
              if (msg.type === 'call_ended') loadViciBridgeStatus();
              else render();
            }
          } else if (tab === 'dashboard' && (msg.type === 'call_ended' || msg.type === 'call_started')) {
            if (msg.type === 'call_ended') loadViciBridgeStatus();
            else renderExecutiveCommandDeck();
            if (cmdDeckState.fleetCampaignId) loadFleetCampaignStats(cmdDeckState.fleetCampaignId);
          }
        } catch {}
      };
      ws.onclose = () => {
        viciMon.ws = null;
      };
    } catch {}
  }

  function renderBridgeCdrList() {
    if (!viciMon.logs.length) {
      return `<div class="note">${serverlessCloudMode
        ? 'This static site has no bridge server or recordings. Old browser-local demo entries were synthetic and are not shown as call history.'
        : 'No VICIdial bridge calls recorded yet. Loopback tests can create bridge recordings on an isolated server; real calls require a configured Asterisk bridge.'}</div>`;
    }
    return viciMon.logs
      .slice(0, 8)
      .map(
        (c) => `<div class="t" style="margin-bottom:8px">
          <div class="bar" style="justify-content:space-between;margin-bottom:4px">
            <span>
              <b>${esc(new Date(c.startedAt).toLocaleTimeString())}</b> ·
              <span class="pill">${esc(c.transport === 'sip_rtp' ? 'SIP+RTP (PCMU)' : 'AudioSocket TCP')}</span> ·
              ${c.greetingId ? `Selected greeting #${esc(c.greetingId)} · ` : ''}
              CID: <code>${esc(c.callerCode)}</code> ·
              Lead: <b>#${esc(c.leadId || 'n/a')}</b> (${esc(c.phone || 'n/a')})
            </span>
            <span>
              ${c.avgTtfbMs ? `<span class="pill">TTFB: ${c.avgTtfbMs}ms</span>` : ''}
              ${c.disposition ? `<span class="pill ${c.disposition === 'DNC' || c.disposition === 'NI' ? 'wn' : 'ok'}">Dispo: ${esc(c.disposition)}</span>` : ''}
              ${c.transferredTo ? `<span class="pill ok">Xfer: ${esc(c.transferredTo)}</span>` : ''}
              ${c.dncAdded ? `<span class="pill wn">DNC List Added</span>` : ''}
            </span>
          </div>
          ${
            c.transcript?.length
              ? `<div style="font-size:12px;margin:4px 0;color:var(--tx)">
                  ${c.transcript
                    .slice(-3)
                    .map((t) => `<div><b>${esc(t.role)}:</b> ${esc(t.content)}</div>`)
                    .join('')}
                </div>`
              : ''
          }
          ${
            c.recordingFile
              ? `<div class="bar" style="margin:6px 0;background:rgba(124,140,255,.06);padding:6px 8px;border-radius:8px">
                  <span style="font-size:11.5px;font-weight:500">🎧 Stereo 8 kHz Recording (L=Caller, R=Bot):</span>
                  <audio controls preload="none" src="/api/vici/recordings/${encodeURIComponent(c.recordingFile)}" style="height:28px;flex:1;min-width:180px"></audio>
                  <a class="g" href="/api/vici/recordings/${encodeURIComponent(c.recordingFile)}" download="${esc(c.recordingFile)}" style="text-decoration:none;padding:3px 8px;border-radius:6px;border:1px solid var(--bd);font-size:11.5px;color:var(--tx)">⬇ .wav (${Math.max(1, Math.round((c.recordingBytes || 0) / 1024))} KB)</a>
                </div>`
              : ''
          }
          <div class="note" style="margin-top:4px">
            <b>VICIdial API Trail (${(c.viciApiAudit || []).length}):</b>
            ${
              (c.viciApiAudit || []).length
                ? c.viciApiAudit
                    .map(
                      (a) =>
                        `<span class="pill ${a.ok ? 'ok' : 'wn'}" style="margin-right:4px" title="${esc(a.responseText)}">${esc(a.fn)} ${a.ok ? '✓' : '!'}</span>`
                    )
                    .join('')
                : 'none'
            }
          </div>
        </div>`
      )
      .join('');
  }

  async function runViciConnectivityCheck() {
    if (serverlessCloudMode) {
      viciMon.verifyResult = {
        ok: false,
        error: 'Cloud Browser Mode: Deploy on your ViciBox server (vicibox-install.sh) to probe 115.186.137.240 Asterisk AMI (:5038) & VICIdial HTTP APIs.',
      };
      render();
      return;
    }
    viciMon.verifyRunning = true;
    render();
    try {
      const res = await fetch('/api/vici/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vici: S.vici }),
      });
      viciMon.verifyResult = await res.json();
    } catch (err) {
      viciMon.verifyResult = { ok: false, error: err.message };
    } finally {
      viciMon.verifyRunning = false;
      render();
    }
  }

  async function runViciLoopbackSim() {
    if (serverlessCloudMode) {
      viciMon.simError = 'Bridge loopback tests require a running server; this static site cannot run them or create recordings.';
      render();
      return;
    }
    if (!window.confirm('This loopback test uses mock VICIdial responses, but agent webhooks can run for real. It also temporarily changes process-wide bridge/provider routing. Run it only on an isolated test instance without live calls. Continue?')) return;
    viciMon.simRunning = true;
    viciMon.simError = null;
    render();
    try {
      const campaignId = String(viciMon.simCampaignId || '');
      if (!S.campaigns.some((campaign) => campaign.id === campaignId)) {
        throw new Error('Select an existing campaign explicitly before running the loopback call.');
      }
      const res = await fetch('/api/vici/simulate-call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transport: viciMon.simTransport,
          scenario: viciMon.simScenario,
          upstream: viciMon.simUpstream,
          callerCode: 'V1027153012000104892',
          phone: '3055550192',
          campaignId,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Simulation failed');
      await loadViciBridgeStatus();
    } catch (err) {
      viciMon.simError = err.message || 'Loopback simulation failed';
    } finally {
      viciMon.simRunning = false;
      render();
    }
  }

  async function loadCallLogsForCurrentAgent() {
    if (!S) return;
    const aid = A().id;
    const requestId = ++sim.logsRequestId;
    const stillCurrent = () => Boolean(S) && A()?.id === aid && sim.logsRequestId === requestId;
    sim.logsError = null;
    try {
      if (serverlessCloudMode) {
        let old = [];
        try {
          const parsed = JSON.parse(window.localStorage?.getItem('vac_cloud_sim_logs_v1') || '[]');
          if (Array.isArray(parsed)) old = parsed;
        } catch { /* A corrupt or inaccessible legacy log must not hide IndexedDB recordings. */ }
        const local = await listLocalRecordedTests();
        if (!stillCurrent()) return;
        sim.callLogs = [...old, ...local]
          .filter((item) => item.agentId === aid)
          .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
      } else {
        const res = await fetch(`/api/simulator/logs?agentId=${encodeURIComponent(aid)}&limit=100`);
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
        if (!stillCurrent()) return;
        sim.callLogs = Array.isArray(data.logs) ? data.logs : [];
      }
      sim.logsLoadedForAgent = aid;
    } catch (err) {
      if (!stillCurrent()) return;
      sim.logsLoadedForAgent = aid;
      sim.logsError = `Could not load test history: ${err.message || 'storage or network error'}`;
    }
    if (!stillCurrent()) return;
    const box = document.getElementById('sim-logs-box');
    if (box) box.innerHTML = renderCallLogsList();
  }

  function renderCallLogsList() {
    if (sim.logsError) return `<div class="note er">${esc(sim.logsError)}</div>`;
    if (!sim.callLogs.length) {
      return `<div class="note">${serverlessCloudMode
        ? 'No locally recorded tests for this agent. Unrecorded static-site tests are not saved.'
        : 'No saved browser test logs for this agent yet. Audio is saved only when recording was enabled for that test.'}</div>`;
    }
    const displayed = sim.historyExpanded ? sim.callLogs : sim.callLogs.slice(0, 6);
    const items = displayed.map((lg, index) => {
        const transcript = Array.isArray(lg.transcript) ? lg.transcript : [];
        const legacy = lg.upstreamMode === 'sandbox' || lg.upstreamMode === 'speech_service';
        const audioUrl = sim.recordingUrls.get(lg.id);
        const recording = lg.recordingStatus === 'available'
          ? `<div class="bar" style="margin:6px 0;flex-wrap:wrap">
              ${audioUrl
                ? `<audio controls preload="metadata" aria-label="Browser test recording" src="${esc(audioUrl)}" style="height:32px;min-width:180px;max-width:100%"></audio>
                   <a class="g" href="${esc(audioUrl)}" download="live-bot-${esc(lg.id)}.${recordingExtension(lg.recordingMime)}" style="text-decoration:none;padding:4px 8px">⬇ Download audio</a>`
                : `<button class="g" data-sim-audio-load="${esc(lg.id)}">▶ Load audio recording</button>`}
              <button class="g danger" data-sim-audio-delete="${esc(lg.id)}">Delete recording</button>
              <span class="note">${Math.max(1, Math.round((lg.recordingBytes || 0) / 1024))} KB${lg.recordingTruncated ? ' · truncated at recording limit' : ''}</span>
            </div>`
          : `<div class="note">${lg.recordingStatus === 'pending'
            ? 'Recording was requested, but no audio is currently saved.'
            : lg.recordingStatus === 'deleted' ? 'Recording deleted.' : 'No audio recording for this test.'}</div>`;
        return `<div class="t" style="margin-bottom:8px">
          <div class="bar" style="margin-bottom:4px;justify-content:space-between">
            <span>${index === 0 ? '<b>Latest · </b>' : ''}<b>${esc(new Date(lg.startedAt).toLocaleString())}</b> · <span class="pill">${esc(lg.upstreamMode)}</span> · ${Math.max(1, Math.round(lg.durationMs / 1000))}s · ${lg.turns} turn(s)${lg.greetingId ? ` · Selected greeting #${esc(lg.greetingId)}` : ''}</span>
            <span>
              ${lg.avgTtfbMs && !legacy ? `<span class="pill">Avg TTFB: ${lg.avgTtfbMs}ms</span>` : ''}
              ${lg.disposition ? `<span class="pill wn">Historical test marker: ${esc(lg.disposition)} (not a confirmed VICIdial update)</span>` : ''}
              ${lg.transferredTo ? `<span class="pill wn">Historical test transfer marker: ${esc(lg.transferredTo)} (not confirmed)</span>` : ''}
            </span>
          </div>
          ${legacy ? '<div class="note wn">Older scripted/local-speech demo: this transcript may not represent a real AI conversation.</div>' : ''}
          ${recording}
          <details class="sim-history-transcript">
            <summary>View transcript (${transcript.length} messages)</summary>
            ${transcript.length ? transcript.map((entry) => `<div class="sim-history-line"><b>${esc(entry.role || 'unknown')}:</b> ${esc(entry.content || '')}</div>`).join('') : '<div class="note">No transcript was saved for this test.</div>'}
          </details>
          <div class="note" style="margin-top:5px">Function events (historical test records may contain simulated results): ${
            lg.functionCalls?.length
              ? lg.functionCalls.map((f) => `<code>${esc(f.name)}(${esc(JSON.stringify(f.args))}) [${esc(f.status || 'historical')}]</code>`).join(', ')
              : 'none'
          }</div>
        </div>`;
      }).join('');
    const toggle = sim.callLogs.length > 6
      ? `<button class="g" data-sim-history-toggle="1">${sim.historyExpanded ? 'Show fewer tests' : `Show all ${sim.callLogs.length} retained tests`}</button>`
      : '';
    return items + toggle;
  }

  // ==================== VOICE CATALOG (STEP 1) ====================

  async function ensureVoiceCatalogLoaded(force = false) {
    if (voiceCatalog.loading) return;
    if (voiceCatalog.loaded && !force) return;
    voiceCatalog.loading = true;
    voiceCatalog.error = '';
    if (tab === 'voice') renderVoiceCatalogSection();
    try {
      const url = serverlessCloudMode
        ? './voices-static.json'
        : force
        ? '/api/deepgram/voices?refresh=1'
        : '/api/deepgram/voices';
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Failed to load voices');
      voiceCatalog.voices = data.voices || [];
      voiceCatalog.facets = data.facets || { families: [], languages: [], accents: [] };
      voiceCatalog.source = data.source || (serverlessCloudMode ? 'static-catalog' : 'api');
      voiceCatalog.authenticated = serverlessCloudMode
        ? Boolean(secretsStatus?.DEEPGRAM_API_KEY?.configured)
        : Boolean(data.authenticated);
      voiceCatalog.loaded = true;
    } catch (err) {
      voiceCatalog.error = err.message || 'Unable to fetch Deepgram voice catalog';
    } finally {
      voiceCatalog.loading = false;
      if (tab === 'voice') renderVoiceCatalogSection();
    }
  }

  function filteredVoices() {
    const { q, family, language, accent, gender } = voiceCatalog.filters;
    const query = q.trim().toLowerCase();
    return voiceCatalog.voices.filter((v) => {
      if (family && v.family !== family) return false;
      if (language && v.primaryLanguage !== language && !v.languages.some((l) => l.toLowerCase().startsWith(language))) {
        return false;
      }
      if (accent && v.accent !== accent) return false;
      if (gender && v.gender !== gender) return false;
      if (query) {
        const hay = `${v.id} ${v.displayName} ${v.accent} ${v.age} ${(v.tags || []).join(' ')} ${(v.useCases || []).join(' ')}`.toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    });
  }

  function renderVoiceCatalogSection() {
    const container = document.getElementById('voice-catalog-box');
    if (!container) return;

    if (voiceCatalog.loading) {
      container.innerHTML = `<div class="note">Loading live Deepgram Flux v2 &amp; Aura-2 voice catalog from backend…</div>`;
      return;
    }
    if (voiceCatalog.error) {
      container.innerHTML = `<div class="note er">✗ ${esc(voiceCatalog.error)}</div>`;
      return;
    }

    const a = A();
    const list = filteredVoices();
    const countLabel = `Showing ${list.length} of ${voiceCatalog.voices.length} real Deepgram voices`;
    const localTtsProv = S.providers.find((p) => p.kind === 'tts' && p.type === 'speech_service');
    const localVoices = localTtsProv
      ? (localTtsProv.models || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    const isLocalTtsActive = globalServiceProvider('tts')?.type === 'speech_service';

    const localVoicesSectionHtml = localVoices.length
      ? `
      <div class="t" style="margin-bottom:14px;border-left:3px solid var(--ac)">
        <div class="bar" style="justify-content:space-between;margin-bottom:8px">
          <div>
            <b>⚡ Self-Hosted Local Speech Service Voices (${localVoices.length} Kokoro-82M &amp; Cloned Voices)</b>
            <div class="note" style="margin-top:2px">Zero per-minute cloud cost — click <b>🔊 Speak Text</b> to synthesize live WAV audio or <b>✓ Use This Voice</b> to assign globally.</div>
          </div>
          <span class="pill ${isLocalTtsActive ? 'ok' : ''}">${isLocalTtsActive ? `● Active (${esc(S.services?.tts?.model)})` : '○ Available'}</span>
        </div>
        <div class="voice-grid">
          ${localVoices
            .map((vid) => {
              const isClone = vid.startsWith('clone:');
              const isSelected = isLocalTtsActive && S.services?.tts?.model === vid;
              const accent = vid.startsWith('bf_') || vid.startsWith('bm_') ? 'British' : isClone ? 'Custom Clone' : 'American';
              const gender = vid.startsWith('am_') || vid.startsWith('bm_') ? 'masculine' : isClone ? 'cloned' : 'feminine';
              const pretty = isClone
                ? `Cloned Voice (${vid.slice(6, 12)})`
                : vid
                    .replace(/^[ab][fm]_/, '')
                    .replace(/^\w/, (c) => c.toUpperCase());
              const initials = esc(pretty.slice(0, 2).toUpperCase());
              return `<div class="vcard ${isSelected ? 'active' : ''}">
                <div class="vcard-top">
                  <div class="vavatar">${initials}</div>
                  <div class="vmeta">
                    <div class="vtitle">
                      <span>${esc(pretty)}</span>
                      <span class="pill">${isClone ? 'Chatterbox Clone' : 'Kokoro 82M'}</span>
                    </div>
                    <div class="vid">${esc(vid)} · ${accent} · ${gender}</div>
                  </div>
                </div>
                <div class="vcard-actions">
                  <button class="g" data-vsynth="${esc(vid)}" data-vprov="speech_service" data-vlabel="Local ${esc(pretty)} (${esc(vid)})">🔊 Speak Text</button>
                  ${
                    isSelected
                      ? '<span class="pill ok">✓ Active Voice (saved)</span>'
                      : `<button class="b" data-vselect="${esc(vid)}" data-vprov="speech_service" data-vlabel="Local ${esc(pretty)} (${esc(vid)})">✓ Use This Voice</button>`
                  }
                </div>
              </div>`;
            })
            .join('')}
        </div>
      </div>`
      : '';

    container.innerHTML = `
      ${localVoicesSectionHtml}
      <div class="bar" style="justify-content:space-between;margin-bottom:6px">
        <span class="note" style="margin:0">${esc(countLabel)} (${voiceCatalog.source === 'deepgram_live_api' ? 'Live Deepgram /v1 & /v2 API' : 'Offline Fallback'})</span>
        <span class="pill ${secretsStatus?.DEEPGRAM_API_KEY?.configured ? 'ok' : 'wn'}">
          ${secretsStatus?.DEEPGRAM_API_KEY?.configured ? '✓ DEEPGRAM_API_KEY configured (connection not confirmed)' : '! Samples require network access — add DEEPGRAM_API_KEY for custom text TTS'}
        </span>
      </div>
      <div class="voice-grid">
        ${list
          .map((v) => {
            const isAssigned = globalServiceProvider('tts')?.type === 'deepgram' && S.services?.tts?.model === v.id;
            const famLabel = v.family === 'flux-v2' ? 'Flux v2' : v.family === 'aura-2' ? 'Aura-2 v1' : 'Aura v1';
            const initials = esc((v.displayName || 'V').slice(0, 2).toUpperCase());
            return `<div class="vcard ${isAssigned ? 'active' : ''}">
              <div class="vcard-top">
                <div class="vavatar">${initials}</div>
                <div class="vmeta">
                  <div class="vtitle">
                    <span>${esc(v.displayName)}</span>
                    <span class="pill">${famLabel}</span>
                    ${v.featured ? '<span class="pill ok">★ Featured</span>' : ''}
                  </div>
                  <div class="vid">${esc(v.id)} · ${esc(v.accent)} · ${esc(v.gender)}</div>
                </div>
              </div>
              <div class="vtags">
                ${(v.tags || []).slice(0, 4).map((tg) => `<span class="vtag">${esc(tg)}</span>`).join('')}
                ${(v.useCases || []).slice(0, 2).map((uc) => `<span class="vtag" style="color:var(--ac)">${esc(uc)}</span>`).join('')}
              </div>
              <div class="vcard-actions">
                ${
                  v.sampleUrl
                    ? `<button class="g" data-vsample="${esc(v.sampleUrl)}" data-vlabel="${esc(v.displayName)} (${esc(v.id)})">▶ Sample</button>`
                    : ''
                }
                <button class="g" data-vsynth="${esc(v.id)}" data-vlabel="${esc(v.displayName)} (${esc(v.id)})">🔊 Speak Text</button>
                ${
                  isAssigned
                    ? '<span class="pill ok">✓ Active Voice (saved)</span>'
                    : `<button class="b" data-vselect="${esc(v.id)}" data-vlabel="${esc(v.displayName)} (${esc(v.id)})">✓ Use This Voice</button>`
                }
              </div>
            </div>`;
          })
          .join('')}
      </div>
    `;
  }

  // ==================== EXECUTIVE COMMAND & CONSOLE QUALITY DECK ====================

  const CMD_DECK_COMPACT_KEY = 'vac_cmd_deck_compact_v1';
  const cmdDeckState = {
    serverTelemetry: null,
    publicDemoUrl: null,
    tunnelStarting: false,
    syncing: false,
    fleetCampaignId: null,
    fleetStats: null,
    fleetStatsLoading: false,
    fleetStatsError: '',
    fleetStatsToken: 0,
    compact: (() => {
      try {
        return window.localStorage?.getItem(CMD_DECK_COMPACT_KEY) === '1';
      } catch {
        return false;
      }
    })(),
  };

  function syncPublicDemoButton(demoUrl) {
    const cleanUrl = demoUrl
      ? String(demoUrl).replace(/\/+$/, '')
      : /\.trycloudflare\.com$/i.test(window.location.hostname)
      ? window.location.origin
      : null;
    cmdDeckState.publicDemoUrl = cleanUrl;
    const shareBtn = document.getElementById('btn-share-demo');
    if (shareBtn) {
      if (cleanUrl) {
        const loginLink = `${cleanUrl}/login`;
        shareBtn.style.display = 'inline-flex';
        shareBtn.dataset.demoUrl = loginLink;
        shareBtn.title = `Public Client Demo Login URL: ${loginLink} (click to copy)`;
      } else {
        shareBtn.style.display = 'none';
      }
    }
  }

  async function refreshTelemetryOverview(silent) {
    if (serverlessCloudMode || cmdDeckState.syncing) return;
    cmdDeckState.syncing = true;
    if (!silent) renderExecutiveCommandDeck();
    try {
      const res = await fetch('/api/telemetry/overview', { credentials: 'same-origin' });
      if (res.ok && (res.headers.get('content-type') || '').includes('application/json')) {
        const data = await res.json();
        if (data && data.ok && data.telemetry) {
          cmdDeckState.serverTelemetry = data.telemetry;
          const liveDemo = data.publicDemoUrl || data.telemetry.runtime?.publicDemoUrl;
          if (liveDemo) {
            syncPublicDemoButton(liveDemo);
          }
        }
      }
    } catch {
      // Keep last known telemetry snapshot if offline
    } finally {
      cmdDeckState.syncing = false;
      renderExecutiveCommandDeck();
    }
  }

  function formatDurationCompact(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }

  function computeLiveTelemetryView() {
    const srv = cmdDeckState.serverTelemetry;
    const agents = Array.isArray(S?.agents) ? S.agents : [];
    const campaigns = Array.isArray(S?.campaigns) ? S.campaigns : [];
    const providers = Array.isArray(S?.providers) ? S.providers : [];
    const functions = Array.isArray(S?.functions) ? S.functions : [];

    // Live per-entity pre-flight status (reflects unsaved form edits immediately)
    const agentMatrix = agents.map((ag) => {
      const cks = validateAgentLocal(ag);
      const er = cks.filter((x) => (x.level || x[0]) === 'er').length;
      const wn = cks.filter((x) => (x.level || x[0]) === 'wn').length;
      return {
        id: ag.id,
        name: ag.name || 'Untitled Agent',
        mode: ag.mode || 'outbound',
        bargeIn: ag.behavior?.bargeIn || 'instant',
        er,
        wn,
        status: er > 0 ? 'er' : wn > 0 ? 'wn' : 'ok',
      };
    });

    const campaignMatrix = campaigns.map((cp) => {
      const cks = validateCampaignLocal(cp);
      const er = cks.filter((x) => (x.level || x[0]) === 'er').length;
      const wn = cks.filter((x) => (x.level || x[0]) === 'wn').length;
      return {
        id: cp.id,
        name: cp.name || 'Untitled Campaign',
        viciCampaign: cp.viciCampaign || 'Not set',
        er,
        wn,
        status: er > 0 ? 'er' : wn > 0 ? 'wn' : 'ok',
      };
    });

    const allChecks = [
      ...agents.flatMap((ag) => validateAgentLocal(ag)),
      ...campaigns.flatMap((cp) => validateCampaignLocal(cp)),
    ];
    const okCount = allChecks.filter((x) => (x.level || x[0]) === 'ok').length;
    const wnCount = allChecks.filter((x) => (x.level || x[0]) === 'wn').length;
    const erCount = allChecks.filter((x) => (x.level || x[0]) === 'er').length;
    const totalChecks = Math.max(1, allChecks.length);

    let testsTotal = 0;
    let testsPassed = 0;
    let testsFailed = 0;
    let testsPending = 0;
    for (const list of Object.values(S?.tests || {})) {
      if (!Array.isArray(list)) continue;
      for (const row of list) {
        testsTotal++;
        if (row.r === 'ok') testsPassed++;
        else if (row.r === 'f') testsFailed++;
        else testsPending++;
      }
    }

    const sttProv = globalServiceProvider('stt');
    const llmProv = globalServiceProvider('llm');
    const ttsProv = globalServiceProvider('tts');
    const sttModel = S?.services?.stt?.model || '';
    const llmModel = S?.services?.llm?.model || '';
    const ttsModel = S?.services?.tts?.model || '';
    const dgConfigured = Boolean(
      secretsStatus?.DEEPGRAM_API_KEY?.configured ?? srv?.inventory?.deepgramConfigured ?? false
    );

    const usersCount = Number(srv?.inventory?.registeredUsers ?? 0);
    const authRequired = srv?.inventory?.authEnforced === true;
    const instantCount = agents.filter((ag) => ag.behavior?.bargeIn === 'instant').length;
    const rate8kCount = agents.filter((ag) => Number(ag.audio?.inRate) === 8000).length;
    const discCount = campaigns.filter((cp) => String(cp.disclosure || '').trim().length >= 8).length;
    const avgTtfb = Number(srv?.traffic?.avgTtfbMs || 0);
    // Readiness is the fraction of actual configuration checks that pass.
    // Unrun QA, browser audio overrides and unavailable server telemetry are
    // reported separately rather than inventing points or penalizing twice.
    const score = allChecks.length ? Math.round((okCount / allChecks.length) * 100) : 0;
    const grade = score === 100 ? 'S+' : score >= 90 ? 'A+' : score >= 80 ? 'A' : score >= 70 ? 'B' : score >= 60 ? 'C' : 'D';
    const agentChecks = agents.flatMap((agent) => validateAgentLocal(agent));
    const campaignChecks = campaigns.flatMap((campaign) => validateCampaignLocal(campaign));
    const isPipelineCheck = (item) => /global|plug-in json|voice agent|nova|flux stt/i.test(item[2]);
    const isSafetyCheck = (item) => /disclosure|DNC|compliance|disposition/i.test(item[2]);
    const passed = (checks) => checks.filter((item) => (item.level || item[0]) === 'ok').length;
    const pipelineChecks = agentChecks.filter(isPipelineCheck);
    const routingChecks = campaignChecks.filter((item) => !isSafetyCheck(item));
    const safetyChecks = campaignChecks.filter(isSafetyCheck);
    const coreAgentChecks = agentChecks.filter((item) => !isPipelineCheck(item));
    // These four scored groups partition every configuration check exactly once.
    const pillars = [
      { id: 'preflight', label: 'Agent configuration', score: passed(coreAgentChecks), max: coreAgentChecks.length, detail: `${passed(coreAgentChecks)}/${coreAgentChecks.length} checks passed` },
      { id: 'ai_stack', label: 'Speech & LLM selection', score: passed(pipelineChecks), max: pipelineChecks.length, detail: `${sttModel || 'STT unset'} · ${llmModel || 'LLM unset'} · ${ttsModel || 'TTS unset'}; connection not certified` },
      { id: 'realtime_ux', label: 'Campaign routing', score: passed(routingChecks), max: routingChecks.length, detail: `${campaigns.length} campaigns; telephone audio remains 8 kHz` },
      { id: 'telephony', label: 'Campaign safety configuration', score: passed(safetyChecks), max: safetyChecks.length, detail: `${discCount}/${campaigns.length} disclosures; operator verification still required` },
      { id: 'qa_readiness', label: 'QA evidence (not scored)', score: testsPassed, max: testsTotal, detail: `${testsPassed}/${testsTotal} passed · ${testsPending} pending · ${testsFailed} failed; excluded from readiness score` },
      { id: 'ops_security', label: 'Storage & access (not scored)', score: serverlessCloudMode ? (saveError ? 0 : 1) : (latestRevisionId ? 1 : 0), max: 1, detail: serverlessCloudMode ? 'Browser-local storage; not server authentication' : `${authRequired ? 'Server auth enabled' : 'Local bootstrap'} · ${usersCount} users; excluded from readiness score` },
    ];
    const issues = [
      ...agents.flatMap((agent) => validateAgentLocal(agent).filter((item) => item[0] !== 'ok').map((item) => ({ level: item[0], scope: agent.name, message: item[2], tab: 'agents', entityId: agent.id }))),
      ...campaigns.flatMap((campaign) => validateCampaignLocal(campaign).filter((item) => item[0] !== 'ok').map((item) => ({ level: item[0], scope: campaign.name, message: item[2], tab: 'campaigns', entityId: campaign.id }))),
    ];

    const simCalls = Number(srv?.traffic?.totalSimulatorCalls ?? (sim?.callLogs?.length || 0));
    const simTurns = Number(srv?.traffic?.totalCallsAllChannels ?? simCalls);
    const viciActive = Number(srv?.traffic?.activeCalls ?? (viciMon?.activeCalls?.length || 0));
    const viciTotal = Number(srv?.traffic?.totalBridgeCalls ?? 0);
    const viciXfers = Number(srv?.traffic?.closerTransfers ?? 0);
    const viciXferRate = Number(srv?.traffic?.transferRatePct ?? 0);
    const viciDnc = Number(srv?.traffic?.dncBlocked ?? 0);
    const viciRecs = Number(srv?.traffic?.recordingsCount ?? 0);
    const viciTalkSec = Math.round(Number(srv?.traffic?.avgDurationSec ?? 0) * Math.max(1, viciTotal));

    const boundHost = srv?.runtime?.httpHost || window.location.hostname;
    const boundPort = srv?.runtime?.httpPort || window.location.port || (window.location.protocol === 'https:' ? 443 : 80);
    const bridgePort = srv?.runtime?.audioSocketPort || S?.vici?.bridgePort || 9092;
    const bridgeStatusAvailable = srv?.runtime?.bridgeStatusAvailable === true;
    const bridgeListening = srv?.runtime?.audioSocketListening === true;
    const uptimeSec = Number(srv?.runtime?.uptimeSec ?? 0);
    const memMb = Number(srv?.runtime?.rssMb ?? 0);
    const revNum = latestRevisionId || revisions?.[0]?.id || '—';
    const totalRevs = Number(srv?.inventory?.revisionsCount ?? (revisions?.length || 0));

    const activeThemeLabel =
      (typeof THEME_BY_ID === 'function' && THEME_BY_ID(appearance?.theme)?.name) ||
      (document.documentElement.getAttribute('data-theme') || 'obsidian_prism')
        .split('_')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');

    return {
      score,
      grade,
      okCount,
      wnCount,
      erCount,
      totalChecks,
      pillars,
      issues,
      agents,
      campaigns,
      providers,
      functions,
      agentMatrix,
      campaignMatrix,
      sttProv,
      llmProv,
      ttsProv,
      sttModel,
      llmModel,
      ttsModel,
      dgConfigured,
      instantCount,
      rate8kCount,
      discCount,
      testsTotal,
      testsPassed,
      testsFailed,
      testsPending,
      simCalls,
      simTurns,
      avgTtfb,
      viciActive,
      viciTotal,
      viciXfers,
      viciXferRate,
      viciDnc,
      viciRecs,
      viciTalkSec,
      boundHost,
      boundPort,
      bridgePort,
      bridgeStatusAvailable,
      bridgeListening,
      hasTelemetry: Boolean(srv),
      uptimeSec,
      memMb,
      revNum,
      totalRevs,
      usersCount,
      activeThemeLabel,
    };
  }

  function campaignCallBlockersLocal(campaign) {
    const blockers = validateCampaignLocal(campaign)
      .filter((item) => item[0] === 'er')
      .map((item) => `Campaign: ${item[2]}`);
    const assigned = campaignAgentIds(campaign)
      .map((id) => S.agents.find((agent) => agent.id === id))
      .filter(Boolean);
    if (!assigned.length) blockers.push('Assign at least one existing bot to this campaign.');
    for (const agent of assigned) {
      for (const item of validateAgentLocal(agent)) {
        if (item[0] === 'er') blockers.push(`${agent.name}: ${item[2]}`);
      }
    }
    return [...new Set(blockers)];
  }

  function summarizeCallRecords(records) {
    const total = records.length;
    const durationMs = records.reduce((sum, row) => sum + Math.max(0, Number(row.durationMs) || 0), 0);
    const ttfb = records.map((row) => Number(row.avgTtfbMs)).filter((value) => Number.isFinite(value) && value > 0);
    const transfers = records.filter((row) => Boolean(row.transferredTo) || row.disposition === 'XFER').length;
    const dncs = records.filter((row) => row.dncAdded || row.disposition === 'DNC' || row.disposition === 'DNCL').length;
    const recordings = records.filter((row) => Boolean(row.recordingFile)).length;
    const turns = records.reduce((sum, row) => sum + Math.max(0, Number(row.turns) || 0), 0);
    const dispositions = {};
    for (const row of records) {
      const code = String(row.disposition || 'UNSET').toUpperCase();
      dispositions[code] = (dispositions[code] || 0) + 1;
    }
    return {
      total,
      avgDurationSec: total ? Number((durationMs / total / 1000).toFixed(1)) : 0,
      avgTtfbMs: ttfb.length ? Math.round(ttfb.reduce((sum, value) => sum + value, 0) / ttfb.length) : null,
      transfers,
      transferRatePct: total ? Number(((transfers / total) * 100).toFixed(1)) : 0,
      dncs,
      recordings,
      turns,
      dispositions,
    };
  }

  async function loadFleetCampaignStats(campaignId) {
    const token = ++cmdDeckState.fleetStatsToken;
    cmdDeckState.fleetStatsError = '';
    if (serverlessCloudMode) {
      cmdDeckState.fleetStatsLoading = false;
      cmdDeckState.fleetStats = { campaignId, bridgeLogs: [], simulatorLogs: [], fetchedAt: null };
      renderExecutiveCommandDeck();
      return;
    }
    cmdDeckState.fleetStatsLoading = true;
    renderExecutiveCommandDeck();
    try {
      const query = `campaignId=${encodeURIComponent(campaignId)}`;
      const [bridgeRes, simulatorRes] = await Promise.all([
        fetch(`/api/vici/logs?limit=200&${query}`, { credentials: 'same-origin' }),
        fetch(`/api/simulator/logs?limit=100&${query}`, { credentials: 'same-origin' }),
      ]);
      const bridgeData = await bridgeRes.json();
      const simulatorData = await simulatorRes.json();
      if (!bridgeRes.ok || !bridgeData.ok || !simulatorRes.ok || !simulatorData.ok) {
        throw new Error(bridgeData.error || simulatorData.error || 'Campaign history could not be loaded.');
      }
      if (token !== cmdDeckState.fleetStatsToken || cmdDeckState.fleetCampaignId !== campaignId) return;
      cmdDeckState.fleetStats = {
        campaignId,
        bridgeLogs: (bridgeData.logs || []).filter((row) => row.campaignId === campaignId),
        simulatorLogs: (simulatorData.logs || []).filter((row) => row.campaignId === campaignId),
        fetchedAt: new Date().toISOString(),
      };
    } catch (err) {
      if (token !== cmdDeckState.fleetStatsToken) return;
      cmdDeckState.fleetStatsError = err?.message || 'Campaign history could not be loaded.';
    } finally {
      if (token === cmdDeckState.fleetStatsToken) {
        cmdDeckState.fleetStatsLoading = false;
        renderExecutiveCommandDeck();
      }
    }
  }

  function renderFleetMatrix() {
    const campaigns = S.campaigns || [];
    const selected = campaigns.find((campaign) => campaign.id === cmdDeckState.fleetCampaignId);
    if (!selected) {
      return `<section class="cmd-fleet-layer" aria-label="Fleet Matrix campaigns">
        <div class="cmd-fleet-heading"><h2>Fleet Matrix</h2><span class="note">Select a campaign to open its live status, assigned bots and retained-call analytics.</span></div>
        ${campaigns.length ? `<div class="fleet-campaign-list">${campaigns.map((campaign) =>
          `<a class="fleet-campaign-name" href="${esc(sectionHref('dashboard', { fleetCampaignId: campaign.id }))}" data-fleet-campaign="${esc(campaign.id)}">${esc(campaign.name || 'Untitled Campaign')}</a>`
        ).join('')}</div>` : '<div class="note">No campaigns yet. Create one in Campaigns to see it here.</div>'}
      </section>`;
    }

    const status = viciMon.status;
    const activeCalls = (status?.activeCalls || []).filter((call) => call.campaignId === selected.id);
    const liveKnown = !serverlessCloudMode && Boolean(status && Array.isArray(status.activeCalls) && !status.cloudModeNotice);
    const activityLabel = activeCalls.length ? 'Active' : liveKnown ? 'Inactive' : 'Status unavailable';
    const activityClass = activeCalls.length ? 'ok' : liveKnown ? '' : 'wn';
    const activityNote = activeCalls.length
      ? `${activeCalls.length} live bridge call${activeCalls.length === 1 ? '' : 's'} right now.`
      : liveKnown
        ? 'The connected bridge reports no live call for this campaign. This is call activity, not an on/off switch.'
        : 'No live bridge feed is connected. Static demos cannot verify production campaign activity.';
    const blockers = campaignCallBlockersLocal(selected);
    const assigned = campaignAgentIds(selected).map((id) => S.agents.find((agent) => agent.id === id)).filter(Boolean);
    const stats = cmdDeckState.fleetStats?.campaignId === selected.id ? cmdDeckState.fleetStats : null;
    const bridgeLogs = stats?.bridgeLogs || [];
    const simulatorLogs = stats?.simulatorLogs || [];
    const allLogs = [...bridgeLogs, ...simulatorLogs];
    const summary = summarizeCallRecords(allLogs);
    const bridgeSummary = summarizeCallRecords(bridgeLogs);
    const simulatorSummary = summarizeCallRecords(simulatorLogs);
    const loading = cmdDeckState.fleetStatsLoading;
    const historyNote = serverlessCloudMode
      ? 'This static demo has no server call history. Zeros below mean “no retained server records available”, not proof that no calls occurred.'
      : 'Analytics cover retained records only: up to 200 bridge calls and 100 browser tests across the console, filtered to this campaign. They are not lifetime totals.';
    const dispositionEntries = Object.entries(summary.dispositions).sort((a, b) => b[1] - a[1]);
    const maxDisposition = Math.max(1, ...dispositionEntries.map(([, count]) => count));

    const botRows = assigned.map((agent) => {
      const records = allLogs.filter((row) => row.agentId === agent.id);
      const botSummary = summarizeCallRecords(records);
      const liveCount = activeCalls.filter((call) => call.agentId === agent.id || (!call.agentId && call.agentName === agent.name)).length;
      const agentErrors = validateAgentLocal(agent).filter((item) => item[0] === 'er').length;
      return `<tr>
        <td><a class="fleet-bot-link" href="${esc(sectionHref('agents', { agentId: agent.id }))}" data-fleet-agent="${esc(agent.id)}">${esc(agent.name)}</a>${agent.id === selected.agentId ? ' <span class="pill">Primary</span>' : ''}</td>
        <td>${liveCount}</td>
        <td>${botSummary.total}</td>
        <td>${botSummary.total ? `${botSummary.avgDurationSec}s` : '—'}</td>
        <td>${botSummary.avgTtfbMs === null ? '—' : `${botSummary.avgTtfbMs} ms`}</td>
        <td>${botSummary.transfers}</td>
        <td><span class="pill ${agentErrors ? 'er' : 'ok'}">${agentErrors ? `${agentErrors} setup error${agentErrors === 1 ? '' : 's'}` : 'Ready'}</span></td>
      </tr>`;
    }).join('');

    return `<section class="cmd-fleet-layer fleet-detail" aria-label="Fleet Matrix campaign detail">
      <div class="fleet-detail-head">
        <a class="g" id="btn-fleet-back" href="${esc(sectionHref('dashboard'))}">← All campaigns</a>
        <div class="fleet-detail-title">
          <h2>${esc(selected.name || 'Untitled Campaign')}</h2>
          <div class="fleet-badge-row">
            <span class="pill ${activityClass}" id="fleet-activity-badge">${activityLabel}</span>
            <span class="pill ${blockers.length ? 'wn' : 'ok'}">${blockers.length ? 'Needs setup' : 'Configuration ready'}</span>
            <span class="note">${assigned.length} assigned bot${assigned.length === 1 ? '' : 's'}</span>
          </div>
        </div>
        <a class="g" href="${esc(sectionHref('campaigns', { campaignId: selected.id }))}" data-cmd-campaign="${esc(selected.id)}">Open campaign setup</a>
      </div>
      <div class="note">${esc(activityNote)} Configuration readiness is checked separately from live call activity.</div>
      ${blockers.length ? `<details class="fleet-blockers"><summary>${blockers.length} configuration blocker${blockers.length === 1 ? '' : 's'}</summary><ul>${blockers.map((item) => `<li>${esc(item)}</li>`).join('')}</ul></details>` : ''}
      ${cmdDeckState.fleetStatsError ? `<div class="note er" role="alert">${esc(cmdDeckState.fleetStatsError)} <button type="button" class="g" data-fleet-retry="${esc(selected.id)}">Retry</button></div>` : ''}
      <div class="fleet-stats-grid" aria-label="Campaign statistics">
        <div class="fleet-stat"><span>Live calls</span><strong>${liveKnown ? activeCalls.length : '—'}</strong></div>
        <div class="fleet-stat"><span>Retained calls</span><strong>${loading && !stats ? '…' : summary.total}</strong></div>
        <div class="fleet-stat"><span>Avg duration</span><strong>${summary.total ? `${summary.avgDurationSec}s` : '—'}</strong></div>
        <div class="fleet-stat"><span>Avg TTFB</span><strong>${summary.avgTtfbMs === null ? '—' : `${summary.avgTtfbMs} ms`}</strong></div>
        <div class="fleet-stat"><span>Transfers</span><strong>${summary.transfers}</strong></div>
        <div class="fleet-stat"><span>Recordings</span><strong>${summary.recordings}</strong></div>
      </div>
      <div class="note">${esc(historyNote)}${stats?.fetchedAt ? ` Last refreshed ${esc(new Date(stats.fetchedAt).toLocaleTimeString())}.` : ''}</div>
      <div class="fleet-analytics-grid">
        <div class="fleet-panel">
          <h3>Campaign analytics</h3>
          <div class="ck"><span>Bridge calls</span><b>${bridgeSummary.total}</b></div>
          <div class="ck"><span>Browser tests</span><b>${simulatorSummary.total}</b></div>
          <div class="ck"><span>Conversation turns</span><b>${summary.turns}</b></div>
          <div class="ck"><span>Transfer rate</span><b>${summary.total ? `${summary.transferRatePct}%` : '—'}</b></div>
          <div class="ck"><span>DNC outcomes</span><b>${summary.dncs}</b></div>
          <h3>Dispositions</h3>
          ${dispositionEntries.length ? dispositionEntries.map(([code, count]) => `<div class="fleet-disposition"><span>${esc(code)}</span><div class="fleet-disposition-bar"><i style="width:${Math.round((count / maxDisposition) * 100)}%"></i></div><b>${count}</b></div>`).join('') : '<div class="note">No retained disposition records for this campaign.</div>'}
        </div>
        <div class="fleet-panel">
          <h3>Assigned bots</h3>
          ${assigned.length ? `<div class="fleet-table-wrap"><table class="fleet-bot-table"><thead><tr><th>Bot</th><th>Live</th><th>Calls</th><th>Avg time</th><th>Avg TTFB</th><th>Xfers</th><th>Setup</th></tr></thead><tbody>${botRows}</tbody></table></div>` : '<div class="note">No bots are assigned. Open campaign setup and assign at least one bot.</div>'}
          <div class="note">Per-bot figures use the same retained campaign records. “Ready” means local configuration checks passed, not that a provider or telephone call was verified.</div>
        </div>
      </div>
    </section>`;
  }

  function renderExecutiveCommandDeck() {
    const wrap = document.getElementById('cmd-deck');
    if (!wrap || !S) return;

    const T = computeLiveTelemetryView();
    const healthClass = T.erCount > 0 ? 'er' : T.wnCount > 0 ? 'wn' : 'ok';
    const certText =
      T.erCount === 0 && T.wnCount === 0
        ? `✓ ${T.okCount}/${T.totalChecks} PASSED · 0 WARN · 0 ERR`
        : `${T.okCount} OK · ${T.wnCount} WARN · ${T.erCount} ERR`;

    wrap.innerHTML = `
      <div class="cmd-deck-shell">
        <div class="cmd-topbar">
          <div class="cmd-brand-cluster">
            <span class="cmd-radar-dot ${healthClass === 'ok' ? '' : healthClass}"></span>
            <h1 class="cmd-eyebrow">Configuration Readiness</h1>
            <span class="cmd-cert-badge ${healthClass === 'ok' ? '' : healthClass}">${esc(certText)}</span>
          </div>
          <div class="cmd-actions-cluster">
            <button type="button" class="g cmd-mini-btn" id="btn-cmd-refresh" title="Refresh live server, simulator &amp; VICIdial telemetry">
              ${cmdDeckState.syncing ? '↻ Syncing…' : '↻ Sync'}
            </button>
          </div>
        </div>

        <div class="cmd-score-card">
          <div class="cmd-score-main"><strong>${T.score}</strong><span>/100 · Grade ${esc(T.grade)}</span></div>
          <div class="cmd-score-bar"><i style="width:${T.score}%"></i></div>
          <div class="note">Readiness = passed checks ÷ applicable checks. Pending QA and live provider/telephone health are shown separately; no score is a 99.999% reliability guarantee.</div>
          <div class="cmd-score-stats">
            <span><b>${T.agents.length}</b> bots</span>
            <span><b>${T.campaigns.length}</b> campaigns</span>
            <span><b>${T.okCount}/${T.totalChecks}</b> checks passed</span>
            <span><b>${T.viciActive}</b> live calls</span>
          </div>
        </div>

        <div class="readiness-issues"><h2>${T.issues.length ? 'What still needs attention' : 'All configuration checks passed'}</h2>
          ${T.issues.map((issue) => `<div class="ck"><span class="${issue.level}">${issue.level === 'er' ? '✗' : '!'}</span><span><b>${esc(issue.scope)}:</b> ${esc(issue.message)} <a class="g" href="${esc(sectionHref(issue.tab, { agentId: issue.entityId, campaignId: issue.entityId }))}" data-cmd-tab="${issue.tab}">Open setup</a></span></div>`).join('')}
          <div class="note">QA: ${T.testsPassed}/${T.testsTotal} passed, ${T.testsPending} pending. <a class="g" href="${esc(sectionHref('test', { agentId: A()?.id }))}" data-cmd-tab="test">Open Live Bot</a></div>
        </div>
        ${renderFleetMatrix()}
      </div>
    `;
  }

  function renderAgentCampaignAssignment(agent) {
    const assigned = campaignsForAgent(agent.id);
    return `<fieldset class="assignment-box"><legend>Assigned campaigns</legend>
      <details class="assignment-dropdown"><summary>${assigned.length ? `${assigned.length} campaign${assigned.length === 1 ? '' : 's'} selected` : 'Choose campaigns for this bot…'}</summary>
        <div class="assignment-options">${S.campaigns.length ? S.campaigns.map((campaign) => `<label class="chk-label"><input type="checkbox" data-agent-campaign="${esc(campaign.id)}" ${campaignHasAgent(campaign, agent.id) ? 'checked' : ''}> <span>${esc(campaign.name)} <small>${esc(campaign.viciCampaign || 'No VICIdial ID')}</small></span></label>`).join('') : '<div class="note">Create a campaign first, then assign this bot here.</div>'}</div>
      </details><div class="note">This Agents tab is the only place where campaign assignment is changed. The bot strictly follows the selected campaign’s rules on each call. The first assigned bot is the telephone route; browser tests can use any assigned bot.</div>
    </fieldset>`;
  }

  // Single assignment point: bots are assigned to campaigns ONLY in the
  // Agents tab (renderAgentCampaignAssignment). Campaigns shows the result
  // read-only so there is one place to change it — no duplicate controls.
  function renderCampaignAgentAssignment(campaign) {
    const ids = campaignAgentIds(campaign);
    const names = ids.map((id) => S.agents.find((agent) => agent.id === id)?.name || id);
    const primaryName = S.agents.find((agent) => agent.id === campaign.agentId)?.name || '—';
    return `<fieldset class="assignment-box"><legend>Assigned bots (read-only)</legend>
      <div class="note">${names.length ? esc(names.join(', ')) : 'No bots assigned.'} Primary for telephone calls: <b>${esc(primaryName)}</b></div>
      <div class="note">All assigned bots share this campaign’s rules and dispositions. To assign or unassign bots, open the <a class="g" href="${esc(sectionHref('agents', { agentId: campaign.agentId || undefined }))}" data-cmd-tab="agents">Agents tab</a> — it is the only place where campaign assignment is changed.</div>
    </fieldset>`;
  }

  // ==================== MAIN VIEW RENDERER ====================

  function render() {
    if (!S) return;
    renderSideNav();
    applySidebarState(false);

    const m = document.getElementById('m');
    m.className = ['dashboard', 'voice', 'export', 'plugins'].includes(tab) ? 'wide' : '';

    const a = A();

    if (tab === 'dashboard') {
      m.innerHTML = '<section id="cmd-deck" class="cmd-deck-wrap" aria-label="Executive Command and Console Quality Dashboard"></section>';
      ensureViciMonitorWs();
      if (!viciMon.loaded) {
        viciMon.loaded = true;
        loadViciBridgeStatus();
      }
    } else if (tab === 'agents') {
      const tp = globalServiceProvider('tts') || {};
      const isFluxTts = tp.type === 'deepgram' && String(S.services?.tts?.model || '').startsWith('flux');

      m.innerHTML = `
        <div class="card">
          ${renderSelectorBar('a')}
          ${F('Agent name', 'a.name')}
          ${renderAgentCampaignAssignment(a)}
          ${F('Call handling direction', 'a.mode', 'sel', [
            ['outbound', 'Outbound – VICIdial dials lead, bot engages on answer'],
            ['inbound', 'Inbound – VICIdial In-Group routes caller to bot'],
            ['both', 'Both Outbound & Inbound'],
          ])}
          ${F('Bridge VICIdial call-connect & automatic lead hydration (recommended — replaces hallucinated LLM accept tool)', 'a.acceptViciCalls', 'chk')}
          ${F('Include the linked campaign recording notice (optional)', 'a.injectCampaignDisclosure', 'chk')}
          <div class="note wn">Spoken campaign notice only — does not turn off recording.</div>
          ${F('Saved opening and identity (keep it brief)', 'a.greeting', 'ta')}
          ${F('Vary this opening using the imported greeting library', 'a.randomGreetingEnabled', 'chk')}
          ${F('System prompt (persona, qualification rules, DNC & transfer instructions)', 'a.prompt', 'ta', [], 'style="min-height:145px"')}
          <div class="note wn">Verify every factual claim before calling.</div>

          <h2>⚡ Barge-In, Expressions, Gestures, Speed &amp; General Q&amp;A</h2>
          <div class="note">Providers/models are global (Plug-Ins). Behavior below is per-bot.</div>

          <div class="row r3">
            ${F('🛑 Barge-In Interruption Mode', 'a.behavior.bargeIn', 'sel', [
              ['instant', 'Local Mic VAD + Deepgram'],
              ['server', '🌐 Deepgram Server VAD Only'],
              ['off', '🔒 Disabled (Finish Speaking First)'],
            ])}
            ${F('🎙️ Barge-In Mic Sensitivity', 'a.behavior.bargeInSensitivity', 'sel', [
              ['high', 'High Sensitivity'],
              ['balanced', 'Balanced (Echo-Safe Smart VAD)'],
              ['low', 'Low (Noisy Background Safe)'],
            ])}
            ${F('⚡ Streaming Cadence Profile', 'a.behavior.latencyProfile', 'sel', [
              ['ultra', '⚡ Ultra-Fast Front-Loaded Speech'],
              ['balanced', '⚖️ Balanced Conversational'],
              ['quality', '🧠 Detailed Responses'],
            ])}
          </div>
          <div class="row">
            ${F('😊 Vocal Expression & Persona Tone', 'a.behavior.expressionStyle', 'sel', [
              ['warm_empathetic', '🥰 Warm, Empathetic & Caring'],
              ['energetic_upbeat', '🤩 Energetic, Bright & Upbeat'],
              ['charismatic_closer', '🔥 Confident, Charismatic & Persuasive'],
              ['calm_concierge', '🧘 Calm, Articulate & Executive'],
            ])}
            <div style="display:flex;flex-direction:column;justify-content:center;gap:8px;padding-top:16px">
              ${F('👋 Enable Natural Vocal Gestures & Micro-Reactions ("Oh, great question!", "Gotcha —")', 'a.behavior.vocalGestures', 'chk')}
              ${F('🌍 Answer Any General Knowledge, Math, Science & Everyday Questions', 'a.behavior.allowGeneralQa', 'chk')}
            </div>
          </div>
          ${F('👋 Self-Introduction Bio (spoken naturally when asked "Who are you?" or "Introduce yourself")', 'a.behavior.selfIntro', 'ta')}

          <h2>Speech-to-Text (Listen)</h2>
          <div class="note">Global STT: <b>${esc(globalServiceProvider('stt')?.name || 'Not selected')}</b> · <code>${esc(S.services?.stt?.model || 'not selected')}</code> (Plug-Ins)</div>
          <div class="row">
            ${F('Language / BCP-47 hints', 'a.language')}
            ${F('Keyterms (comma-separated phrases)', 'a.stt.keyterms')}
          </div>
          <div class="row r3">
            ${F('eot_threshold (0.5–1.0)', 'a.stt.eot', 'number', [], 'min="0.5" max="1.0" step="0.05"')}
            ${F('eager_eot (0.3–0.9)', 'a.stt.eager', 'number', [], 'min="0.3" max="0.9" step="0.05"')}
            ${F('eot_timeout_ms', 'a.stt.eotms', 'number', [], 'min="500" max="15000" step="100"')}
          </div>

          <h2>Language Model (Think — Deepgram Managed)</h2>
          <div class="note">Global LLM: <b>${esc(globalServiceProvider('llm')?.name || 'Not selected')}</b> · <code>${esc(S.services?.llm?.model || 'not selected')}</code> (Plug-Ins)</div>
          <div class="row">
            ${F('Temperature (0–2)', 'a.llm.temp', 'number', [], 'min="0" max="2" step="0.05"')}
            ${F('Reasoning (gpt-5*)', 'a.llm.reasoning', 'sel', ['low', 'medium', 'high'])}
          </div>

          <h2>Text-to-Speech (Speak) <a class="g" href="${esc(sectionHref('voice', { agentId: a.id }))}" data-t="voice" style="font-size:11px;padding:3px 8px;text-transform:none">🎧 Open Real Voice Lab →</a></h2>
          <div class="note">Global TTS: <b>${esc(tp.name || 'Not selected')}</b> · <code>${esc(S.services?.tts?.model || 'not selected')}</code> (Plug-Ins)</div>
          <div class="row">
            ${F(
              isFluxTts ? 'Speed (0.5–1.5, 0.05 steps)' : 'Speed (0.7–1.5)',
              'a.tts.speed',
              'number',
              [],
              `min="${isFluxTts ? '0.5' : '0.7'}" max="1.5" step="0.05"`
            )}
            ${
              isFluxTts
                ? F('Expressivity (Flux v2 integer)', 'a.tts.expr', 'sel', [
                    [-2, '-2 (Calmest)'],
                    [-1, '-1 (Calm)'],
                    [0, '0 (Default Production)'],
                    [1, '+1 (Animated)'],
                    [2, '+2 (Most Expressive)'],
                  ])
                : `<div><label>Expressivity</label><input aria-label="Expressivity" disabled value="Flux v2 voices only"></div>`
            }
          </div>

          <h2>Telephony Audio Stream</h2>
          <div class="row">
            ${F('Input encoding', 'a.audio.inEnc', 'sel', ['linear16', 'mulaw', 'alaw'])}
            ${F('Input sample rate (Hz)', 'a.audio.inRate', 'sel', [8000, 16000, 24000, 48000])}
          </div>
          <div class="row">
            ${F('Output encoding', 'a.audio.outEnc', 'sel', ['linear16', 'mulaw', 'alaw'])}
            ${F('Output sample rate (Hz)', 'a.audio.outRate', 'sel', [8000, 16000, 24000, 48000])}
          </div>

          <h2>Enabled LLM Functions</h2>
          ${S.functions
            .map(
              (fn) => `<label class="chk-label">
                <input type="checkbox" style="width:auto" data-fnid="${esc(fn.id)}" ${
                  a.fnIds.includes(fn.id) ? 'checked' : ''
                }>
                <span><b>${esc(fn.name)}</b> <span class="note">(${fn.defer ? 'defer_until_eot' : 'immediate'})</span></span>
              </label>`
            )
            .join('')}
        </div>

        <div class="card sticky">
          <h2>Deepgram Settings Preview</h2>
          <div class="note">The preview uses the selected campaign’s rules and disposition enum. On a live call, the bot listens for 1 second, then speaks the configured opening if the caller is silent. An early caller turn takes priority; silence alone never ends the call.</div>
          <pre id="pv"></pre>
          <h2>Quick Agent Pre-Flight</h2>
          <div id="agent-quick-ck"></div>
        </div>
      `;
    } else if (tab === 'plugins') {
      m.innerHTML = `
        ${renderGlobalServiceRouting()}
        <div class="card">
          <details>
            <summary style="cursor:pointer;font-weight:700;font-size:13px;letter-spacing:.02em">Advanced — Agent Tool Functions (optional)</summary>
            <div class="note" style="margin-top:8px">
              Functions the LLM can call during a live call. They run inside your Node VICIdial Bridge and are optional — leave them untouched if you are not using tool calling.
            </div>
            ${S.functions.map((_, idx) => renderFunctionCard(idx)).join('')}
            <button class="b" data-add="fn">+ Add Function</button>
          </details>
        </div>
      `;
    } else if (tab === 'campaigns') {
      if (!S.campaigns.length) {
        m.innerHTML = `<div class="card">${renderSelectorBar('c')}
          <h2>No campaigns configured</h2>
          <div class="note er">Calls, loopback tests, and deployment stay blocked until you create a campaign, write its rules, configure allowed dispositions, and assign a bot agent.</div>
        </div>
        <div class="card sticky"><h2>Campaign Readiness</h2><div id="ck">${renderCheckList(validateCampaignLocal(null))}</div><h2>Composed Bot Prompt</h2><pre id="pv"></pre></div>`;
      } else {
        m.innerHTML = `
        <div class="card">
          ${renderSelectorBar('c')}
          ${F('Campaign display name', 'c.name')}
          ${renderCampaignAgentAssignment(C())}
          <div class="row">
            ${F('VICIdial Campaign ID', 'c.viciCampaign')}
            ${F('VICIdial List IDs', 'c.lists')}
          </div>
          <div class="row">
            ${F('Calling window start', 'c.start', 'time')}
            ${F('Calling window end', 'c.end', 'time')}
          </div>
          ${F('Lead Timezone', 'c.tz')}
          <div class="row r3">
            ${F('Max dial attempts', 'c.attempts', 'number', [], 'min="1" max="20" step="1"')}
            ${F('Retry delay (min)', 'c.retry', 'number', [], 'min="1" step="1"')}
            ${F('Max concurrent AI calls', 'c.maxCalls', 'number', [], 'min="1" step="1"')}
          </div>
          <div class="row">
            ${F('Live closer transfer type', 'c.xferType', 'sel', [
              ['ingroup', 'VICIdial Closer In-Group (preserves screen-pop)'],
              ['extension', 'Asterisk Extension'],
              ['number', 'External DID / Number'],
            ])}
            ${F('Target In-Group / Exten / DID', 'c.xferTarget')}
          </div>
          ${F('Fallback if no live closer available', 'c.fallback')}
          ${F('Call recording disclosure (auto-prepended to bot greeting when enabled)', 'c.disclosure')}
          <h2>🛡️ Compliance &amp; Rules</h2>
          <div class="note wn">These rules are attached to this campaign and injected into its assigned bot’s live prompt. Write campaign-specific, actionable rules and review all claims with your compliance owner. This console is not legal advice or a compliance certification.</div>
          ${F('Mandatory campaign-specific rules and prohibited claims (20–8,000 characters)', 'c.complianceRules', 'ta', [], 'style="min-height:180px" maxlength="8000"')}
          ${F('Allowed VICIdial disposition codes for this campaign (comma-separated)', 'c.dispos')}
          <div class="note">These codes control explicit agent disposition requests. Caller silence does not select a code or end the call.</div>
          ${F('Scrub leads against DNC list before dialing', 'c.dnc', 'chk')}
        </div>
        <div class="card sticky">
          <h2>Campaign Readiness</h2>
          <div id="ck"></div>
          <h2>Composed Bot Prompt (primary bot + this campaign’s rules)</h2>
          <pre id="pv"></pre>
        </div>
      `;
      }
    } else if (tab === 'voice') {
      const settingsSpeak = buildSettings(a).agent.speak;
      const defaultPreview = voiceCatalog.previewText || buildSettings(a).agent.greeting || a.greeting;
      voiceCatalog.previewText = defaultPreview;

      const langs = voiceCatalog.facets.languages.length ? voiceCatalog.facets.languages : ['en', 'es', 'fr', 'de', 'ja', 'it', 'nl'];
      const accents = voiceCatalog.facets.accents || [];

      m.innerHTML = `
        <div class="card">
          ${renderSelectorBar('a')}
          <div class="voice-workbench">
            <div>
              <h2>Real TTS Voice Workbench</h2>
              <div class="bar" style="margin-bottom:6px">
                <span class="pill">Global TTS: <b>${esc(globalServiceProvider('tts')?.name || 'Not selected')}</b></span>
                <span class="pill ok">Model: <code>${esc(S.services?.tts?.model || 'not selected')}</code></span>
              </div>
              <div class="row">
                ${F('Speed (0.5–1.5, 0.05 steps)', 'a.tts.speed', 'number', [], 'min="0.5" max="1.5" step="0.05"')}
                ${F('Flux v2 Expressivity (-2..+2)', 'a.tts.expr', 'sel', [
                  [-2, '-2 (Calmest)'],
                  [-1, '-1 (Calm)'],
                  [0, '0 (Default)'],
                  [1, '+1 (Animated)'],
                  [2, '+2 (Expressive)'],
                ])}
              </div>
              <label for="vt">Greeting / Script to Synthesize</label>
              <textarea id="vt">${esc(voiceCatalog.previewText)}</textarea>
              <div class="bar" style="margin-top:10px;margin-bottom:4px">
                <button class="b" id="btn-synth-active">🔊 Synthesize with Real TTS API</button>
                <button class="g" id="btn-apply-greeting" title="Copy this text back into the Agent Greeting field">Save Text to Agent Greeting</button>
                <button class="g" id="btn-os-fallback" title="Offline browser SpeechSynthesis fallback">Browser OS Voice</button>
                <button class="g" id="btn-stop-audio">■ Stop</button>
              </div>
              <div class="note" id="vs">${esc(voiceCatalog.playingLabel || 'Pick any Deepgram voice below to play its studio sample or synthesize your greeting.')}</div>
              <audio id="voice-audio" controls ${voiceCatalog.previewAudioUrl ? `src="${esc(voiceCatalog.previewAudioUrl)}"` : ''}></audio>
            </div>
            <div>
              <h2>Active Agent <code>agent.speak</code> Payload</h2>
              <pre id="pv">${esc(JSON.stringify(settingsSpeak, null, 2))}</pre>
              <div class="note">
                Pick a voice below with <b>✓ Use This Voice</b> — it is saved immediately and becomes the shared TTS voice for every bot. Speed and expressivity stay per-agent.
              </div>
            </div>
          </div>

          <h2>Deepgram Real Voice Catalog (Flux v2 &amp; Aura-2) <button class="g" id="btn-refresh-voices" style="font-size:11px;padding:3px 8px;text-transform:none">↻ Refresh from Deepgram API</button></h2>
          <div class="row r4" style="margin-bottom:10px">
            <div>
              <label for="vf-q">Search name, model, trait, use-case</label>
              <input id="vf-q" placeholder="e.g. Haley, British, empathetic, financial…" value="${esc(voiceCatalog.filters.q)}">
            </div>
            <div>
              <label for="vf-family">Model Family</label>
              <select id="vf-family">
                <option value="">All Families (Flux + Aura)</option>
                <option value="flux-v2" ${voiceCatalog.filters.family === 'flux-v2' ? 'selected' : ''}>Flux TTS (v2 — Turn-Based)</option>
                <option value="aura-2" ${voiceCatalog.filters.family === 'aura-2' ? 'selected' : ''}>Aura-2 (v1)</option>
                <option value="aura-1" ${voiceCatalog.filters.family === 'aura-1' ? 'selected' : ''}>Aura-1 (v1)</option>
              </select>
            </div>
            <div>
              <label for="vf-lang">Language</label>
              <select id="vf-lang">
                <option value="">All Languages</option>
                ${langs.map((lg) => `<option value="${esc(lg)}" ${voiceCatalog.filters.language === lg ? 'selected' : ''}>${esc(lg)}</option>`).join('')}
              </select>
            </div>
            <div>
              <label for="vf-accent">Accent</label>
              <select id="vf-accent">
                <option value="">All Accents</option>
                ${accents.map((ac) => `<option value="${esc(ac)}" ${voiceCatalog.filters.accent === ac ? 'selected' : ''}>${esc(ac)}</option>`).join('')}
              </select>
            </div>
            <div>
              <label for="vf-gender">Gender</label>
              <select id="vf-gender">
                <option value="">All</option>
                <option value="feminine" ${voiceCatalog.filters.gender === 'feminine' ? 'selected' : ''}>Feminine</option>
                <option value="masculine" ${voiceCatalog.filters.gender === 'masculine' ? 'selected' : ''}>Masculine</option>
              </select>
            </div>
          </div>
          <div id="voice-catalog-box"></div>
        </div>
      `;

      ensureVoiceCatalogLoaded(false);
      renderVoiceCatalogSection();
    } else if (tab === 'test') {
      // Read scenarios without mutating S (fixes fake dirty-state bug)
      const scenarios = S.tests[a.id] || [];
      const curMode = effectiveSimulatorMode();
      const hasDgKey = Boolean(secretsStatus?.DEEPGRAM_API_KEY?.configured);
      const simCampaigns = campaignsForAgent(a.id);
      const simCampaign = simulatorCampaign(a.id);
      const simCampaignBlockers = simCampaign
        ? [
            ...validateCampaignLocal(simCampaign).filter((item) => item[0] === 'er').map((item) => `Campaign: ${item[2]}`),
            ...validateAgentLocal(a).filter((item) => item[0] === 'er').map((item) => `Agent: ${item[2]}`),
          ]
        : [simCampaigns.length ? 'Select the campaign for this call; no campaign will be chosen automatically.' : 'Assign this bot to a campaign before making a call.'];
      const simCampaignBlockedAttr = simCampaignBlockers.length ? 'disabled' : '';

      if (sim.logsLoadedForAgent !== a.id) {
        loadCallLogsForCurrentAgent();
      }
      refreshMicDevices().catch(() => {});

      m.innerHTML = `
        <div class="card">
          ${renderSelectorBar('a')}

          <div class="sim-header">
            <h2 style="margin:0">🎙️ Live Bot — Browser Voice Test</h2>
            <span class="pill ${sim.active ? 'ok' : sim.connecting ? 'wn' : sim.lastError ? 'er' : ''}" id="sim-state-pill">${esc(sim.statusText)}</span>
          </div>
          <a href="#sim-history" class="note">↓ Jump to recent test history &amp; transcripts</a>
          <div id="sim-selected-greeting" class="note">${sim.selectedGreeting
            ? `Selected greeting #${esc(sim.selectedGreeting.greeting_id)} · ${esc(sim.selectedGreeting.persona)} · ${esc(sim.selectedGreeting.context)} · ${esc(sim.selectedGreeting.tone)} (selection does not confirm playback).`
            : 'The saved opening is used if random greetings are off or unavailable.'}</div>
          <div class="row" style="margin-top:8px">
            <div>
              <label for="sim-campaign">Campaign for this call (required)</label>
              <select id="sim-campaign" ${sim.active || sim.connecting ? 'disabled' : ''}>
                ${simCampaigns.length
                  ? `${!simCampaign ? '<option value="" selected>Choose a campaign for this call…</option>' : ''}${simCampaigns.map((campaign) => `<option value="${esc(campaign.id)}" ${campaign.id === simCampaign?.id ? 'selected' : ''}>${esc(campaign.name)} · ${esc(campaign.viciCampaign || 'no VICIdial ID')}</option>`).join('')}`
                  : '<option value="">No campaign assigned to this bot</option>'}
              </select>
            </div>
            <div class="note">${simCampaign
              ? `This call uses “${esc(simCampaign.name)}” and only its saved rules, opener, and disposition codes.`
              : simCampaigns.length ? 'Select the campaign for this call. No campaign will be chosen automatically.' : 'No campaign is assigned. Create a campaign and explicitly assign this bot before testing or deployment.'}</div>
          </div>
          <div id="sim-call-setup" class="note ${simCampaignBlockers.length ? 'wn' : 'ok'}" style="margin-top:6px">${simCampaignBlockers.length
            ? `<b>Before starting:</b> ${esc(simCampaignBlockers.join('; '))} <a class="g" href="${esc(sectionHref('campaigns', { campaignId: simCampaign?.id }))}" data-cmd-tab="campaigns">Open Campaign setup</a> <a class="g" href="${esc(sectionHref('agents', { agentId: a.id }))}" data-cmd-tab="agents">Assign campaigns to this bot</a>`
            : 'Campaign and bot configuration checks passed. Starting still requires a live provider connection.'}</div>

          ${
            sim.lastError
              ? `<div class="t" style="border-left:3px solid var(--er);background:rgba(239,68,68,0.08)">
                  <div class="bar" style="justify-content:space-between;margin-bottom:4px">
                    <b class="er">✗ Live Call Error</b>
                    <div class="bar" style="margin:0">
                      <button class="g" id="btn-sim-diag" style="font-size:11.5px;padding:3px 8px">🔌 Diagnose Deepgram Key</button>
                      <button class="g" id="btn-dismiss-err" style="font-size:11.5px;padding:3px 8px">Dismiss</button>
                    </div>
                  </div>
                  <div style="font-size:12.5px">${esc(sim.lastError)}</div>
                </div>`
              : ''
          }

          ${
            !hasDgKey && curMode === 'deepgram'
              ? `<div class="t" style="border-left:3px solid var(--wn)">
                  <b>DEEPGRAM_API_KEY not set yet</b> — add it in <b>🔑 API Keys</b> to connect to Deepgram Voice Agent. No scripted response is substituted when it is missing.
                </div>`
              : ''
          }

          ${
            isInIframe
              ? `<div class="t" style="border-left:3px solid var(--ac)">
                  <div class="bar" style="justify-content:space-between;margin-bottom:2px">
                    <b>💡 Embedded Preview Audio &amp; Microphone Tip</b>
                    <a class="g" href="${esc(window.location.href)}" target="_blank" rel="noopener" style="text-decoration:none;padding:4px 10px;border-radius:7px;border:1px solid var(--bd);font-size:11.5px;color:var(--tx)">↗ Open in Full Browser Tab (Full Mic)</a>
                  </div>
                  <div class="note" style="margin-top:2px">
                    • <b>💬 Start Call (Speaker + Text)</b> streams <b>real live Deepgram Voice Agent audio</b> right inside this preview window and lets you talk via instant text/scenario buttons.<br>
                    • For physical <b>🎙️ Microphone</b> input, browsers often block mic access inside embedded iframes — click <b>↗ Open in Full Browser Tab</b> above if mic permission is denied here.
                  </div>
                </div>`
              : ''
          }

          ${
            sim.diagResult
              ? `<div class="t" style="border-left:3px solid ${sim.diagResult.ok ? 'var(--ok)' : 'var(--er)'}">
                  <div class="bar" style="justify-content:space-between;margin-bottom:4px">
                    <b>${sim.diagResult.ok ? '✓ Deepgram Live Connection Verified' : '⚠ Deepgram Connection Diagnostic'}</b>
                    <button class="g" id="btn-dismiss-diag" style="font-size:11px;padding:2px 8px">Hide</button>
                  </div>
                  <div style="font-size:12px;line-height:1.55">
                    <div>1. <b>REST Auth (<code>/v1/projects</code>):</b> ${
                      sim.diagResult.restAuth?.ok
                        ? `<span class="ok">✓ Authenticated (${esc(sim.diagResult.restAuth.projectName || 'OK')})</span>`
                        : `<span class="er">✗ ${esc(sim.diagResult.restAuth?.error || 'Failed')}</span>`
                    }</div>
                    <div>2. <b>Flux v2 TTS (<code>/v2/speak</code>):</b> ${
                      sim.diagResult.ttsSpeak?.ok
                        ? `<span class="ok">✓ Synthesized audio (${sim.diagResult.ttsSpeak.bytes} bytes)</span>`
                        : `<span class="er">✗ ${esc(sim.diagResult.ttsSpeak?.error || 'Failed')}</span>`
                    }</div>
                    <div>3. <b>Voice Agent WS (<code>wss://agent.deepgram.com/v1/agent/converse</code>):</b> ${
                      sim.diagResult.voiceAgentWs?.ok
                        ? `<span class="ok">✓ Welcome + SettingsApplied (${sim.diagResult.voiceAgentWs.latencyMs} ms)</span>`
                        : `<span class="er">✗ ${esc(sim.diagResult.voiceAgentWs?.error || 'Failed')}</span>`
                    }</div>
                  </div>
                </div>`
              : ''
          }

          <div class="t" style="border-left:3px solid var(--ac)">
            <b>Deepgram browser test, not a telephone call.</b> After the provider confirms the session, microphone audio and typed messages are sent to Deepgram. This may incur provider charges. Transfers, dispositions and DNC updates are <b>not executed</b> here; test them on a properly configured VICIdial call instead. An enabled custom webhook can perform real external actions.
            ${curMode === 'speech_service' ? '<div class="wn" style="margin-top:6px">Local speech is selected, but a local LLM conversation is not implemented. Select supported Deepgram Voice Agent providers in Plug-Ins.</div>' : ''}
          </div>
          <div class="row">
            <div>
              <label>Upstream</label>
              <div class="note">Deepgram Voice Agent · ${hasDgKey ? 'key configured; connection not yet verified' : 'key not configured'}</div>
            </div>
            <div>
              <label for="sim-bw">Audio Stream Bandwidth</label>
              <select id="sim-bw" ${sim.active || sim.connecting ? 'disabled' : ''}>
                <option value="wideband" ${sim.bandwidth === 'wideband' ? 'selected' : ''}>Wideband Browser Mic (16 kHz In / 24 kHz Out)</option>
                <option value="telephony" ${sim.bandwidth === 'telephony' ? 'selected' : ''}>VICIdial Telephony Rate (8 kHz In / 8 kHz Out)</option>
              </select>
            </div>
          </div>

          <div class="row" style="margin-top:8px">
            <div>
              <label>🎙️ Microphone Input Device <button class="g" id="btn-refresh-mics" style="font-size:10.5px;padding:1px 6px;margin-left:6px;text-transform:none">↻ Refresh Mics</button></label>
              <select id="sim-mic-device" aria-label="Microphone input device">
                <option value="">System Default Microphone</option>
                ${sim.micDevices
                  .filter((d) => d.deviceId && d.deviceId !== 'default')
                  .map(
                    (d) =>
                      `<option value="${esc(d.deviceId)}" ${sim.micDeviceId === d.deviceId ? 'selected' : ''}>${esc(d.label)}</option>`
                  )
                  .join('')}
              </select>
            </div>
            <div>
              <label for="sim-mic-gain">🎚️ Mic Input Volume Boost (Helps Quiet Laptop Mics)</label>
              <select id="sim-mic-gain">
                <option value="1" ${Number(sim.micGain) === 1 ? 'selected' : ''}>1.0x — Normal Studio / Headset Mic</option>
                <option value="2" ${Number(sim.micGain) === 2 ? 'selected' : ''}>2.0x — Laptop / PC Mic Boost (Recommended)</option>
                <option value="3.5" ${Number(sim.micGain) === 3.5 ? 'selected' : ''}>3.5x — High Boost (Quiet Mic)</option>
              </select>
            </div>
          </div>

          <div class="t" style="margin-top:10px">
            <label style="margin-top:0">Browser Test Lead Values (not a live VICIdial record)</label>
            <div class="row r3">
              <div><label>Lead ID</label><input aria-label="Lead ID" data-simlead="lead_id" value="${esc(sim.lead.lead_id)}" ${sim.active ? 'disabled' : ''}></div>
              <div><label>First Name</label><input aria-label="First name" data-simlead="first_name" value="${esc(sim.lead.first_name)}" ${sim.active ? 'disabled' : ''}></div>
              <div><label>Phone</label><input aria-label="Phone" data-simlead="phone_number" value="${esc(sim.lead.phone_number)}" ${sim.active ? 'disabled' : ''}></div>
            </div>
            <div class="row">
              <div><label>State</label><input aria-label="State" data-simlead="state" value="${esc(sim.lead.state)}" ${sim.active ? 'disabled' : ''}></div>
              <div><label>Listed Age</label><input aria-label="Listed age" data-simlead="age" value="${esc(sim.lead.age)}" ${sim.active ? 'disabled' : ''}></div>
            </div>
          </div>

          <label class="chk-label" style="margin-top:10px">
            <input type="checkbox" id="sim-disclosure" data-p="a.injectCampaignDisclosure" style="width:auto" ${a.injectCampaignDisclosure ? 'checked' : ''} ${sim.active || sim.connecting ? 'disabled' : ''}>
            <span>Include this agent's campaign recording notice (optional)</span>
          </label>
          <div class="note wn" style="margin-top:3px">Uncheck to omit the linked campaign notice from the next test; Save to retain your choice for this agent. This does not disable recording. Obtain required consent. A notice written directly in the saved opening is still spoken. Verify the agent's identity and factual claims; the example Medicare / Food &amp; OTC scripts are unverified.</div>
          <label class="chk-label" style="margin-top:10px">
            <input type="checkbox" id="sim-allow-webhooks" style="width:auto" ${sim.allowWebhooks ? 'checked' : ''} ${serverlessCloudMode || sim.active || sim.connecting ? 'disabled' : ''}>
            <span>Allow configured custom webhooks for this test <b>(real external effects possible)</b></span>
          </label>
          <div class="note" style="margin-top:3px">${serverlessCloudMode ? 'Custom webhooks require the authenticated server; they are unavailable on the static site.' : 'Off by default. A request already sent to a webhook cannot necessarily be undone.'}</div>
          <label class="chk-label" style="margin-top:10px">
            <input type="checkbox" id="sim-record-audio" style="width:auto" ${sim.recordAudio ? 'checked' : ''} ${sim.active || sim.connecting || sim.recordingSaving ? 'disabled' : ''}>
            <span>Record audio for this test <b>(opt-in, resets after the test)</b></span>
          </label>
          <div class="note" style="margin-top:3px">Obtain consent from everyone whose voice is recorded. The mixed recording contains microphone and agent playback; typed text is not spoken. Maximum 10 minutes / 20 MB. Keep this tab open while saving. ${serverlessCloudMode
            ? 'Recorded tests and transcripts stay in this browser only (up to 20); clearing site data removes them. Other users of this browser may access them.'
            : 'Audio is uploaded to the server after the test and is available to signed-in operators. The latest 100 test logs and their recordings are retained.'}</div>
          ${sim.recording?.started && sim.recording.recorder.state === 'recording' ? '<div class="note wn">● Recording this browser test</div>' : ''}
          ${sim.recordingSaving ? '<div class="note wn">Saving recording… keep this tab open.</div>' : ''}
          <div class="bar" style="margin-top:10px">
            ${
              !sim.active && !sim.connecting
                ? `
                  <button class="b" id="btn-call-mic" ${sim.recordingSaving ? 'disabled' : ''} aria-describedby="sim-call-setup">📞 Start Live Mic Call</button>
                  <button class="g" id="btn-call-nomic" ${sim.recordingSaving ? 'disabled' : ''} aria-describedby="sim-call-setup" title="Connect live Deepgram speaker audio + text utterance injection without requesting microphone">💬 Start Call (Speaker + Text)</button>
                  ${hasDgKey ? `<button class="g" id="btn-sim-diag" ${sim.diagRunning ? 'disabled' : ''}>${sim.diagRunning ? '⏳ Testing Deepgram…' : '🔌 Test Deepgram Connection'}</button>` : ''}
                `
                : `
                  <button class="g" id="btn-sim-mute" ${!sim.micEnabled ? 'disabled' : ''}>${sim.muted ? '🔇 Mic Muted (Click to Unmute)' : '🎙️ Mic Live (Click to Mute)'}</button>
                  <div class="mic-meter-wrap" title="Live Microphone Level"><div class="mic-meter-bar" id="sim-mic-bar"></div></div>
                  <button class="b hangup" id="btn-call-hangup">📴 Hang Up</button>
                `
            }
          </div>
          ${
            (sim.active || sim.connecting) && sim.micEnabled
              ? `<div class="note" id="sim-mic-telemetry" style="margin-top:4px;margin-bottom:6px">
                  🎙️ Initializing microphone stream (${esc(sim.micActiveLabel || 'requesting permission…')})…
                </div>`
              : ''
          }

          ${renderPersonaStageHtml(a)}

          <div class="sim-kpis">
            <div class="kpi"><div class="kpi-lbl">Duration</div><div class="kpi-val" id="sim-kpi-dur">${formatDuration(sim.elapsedSec)}</div></div>
            <div class="kpi"><div class="kpi-lbl">Caller Turns</div><div class="kpi-val" id="sim-kpi-turns">${sim.turns}</div></div>
            <div class="kpi"><div class="kpi-lbl">Transcript → first audio</div><div class="kpi-val ${sim.lastTtfbMs && sim.lastTtfbMs <= 700 ? 'ok' : ''}" id="sim-kpi-ttfb">${sim.lastTtfbMs !== null ? `${sim.lastTtfbMs <= 650 ? '⚡ ' : ''}${sim.lastTtfbMs} ms` : '—'}</div></div>
            <div class="kpi"><div class="kpi-lbl">Barge-Ins</div><div class="kpi-val ${sim.bargeInCount > 0 ? 'ok' : ''}" id="sim-kpi-barge">${sim.bargeInCount || 0}</div></div>
            <div class="kpi"><div class="kpi-lbl">VICIdial Dispo</div><div class="kpi-val" id="sim-kpi-dispo">Not connected</div></div>
            <div class="kpi"><div class="kpi-lbl">Closer Transfer</div><div class="kpi-val" id="sim-kpi-xfer">Not connected</div></div>
          </div>

          <div class="sim-feed" id="sim-feed"></div>

          <div class="bar" style="margin-top:10px;margin-bottom:0">
            <input aria-label="Caller utterance" id="sim-inject-input" style="flex:1" placeholder="${sim.active ? 'Type any general question, self-intro prompt, or campaign reply & press Enter…' : 'Start a call above to speak, barge-in, or inject utterances…'}" ${sim.active ? '' : 'disabled'}>
            <button class="b" id="btn-sim-inject" ${sim.active ? '' : 'disabled'}>Send Utterance</button>
          </div>
          <div class="chip-row">
            ${[
              'Are you a robot or a real human?',
              'Hi! Who are you? Please introduce yourself!',
              'Why is the sky blue and what is the capital of Japan?',
              'What is 18 times 15, and give me a quick productivity tip!',
              ...(a.id === 'a_medicare' || /medicare/i.test(a.name)
                ? [
                    'Yes, I have Medicare Part A and Part B, and I am 71.',
                    'Is this a scam or a sales pitch?',
                    'Stop calling my phone please.',
                  ]
                : a.id === 'a_nova'
                ? [
                    'I had a really long week — share some warm encouragement!',
                    'Explain quantum computing in two super simple sentences.',
                  ]
                : [
                    "Yes, I'm 64 and looking for final expense coverage.",
                    'Take me off your calling list please.',
                  ]),
            ]
              .map(
                (q) =>
                  `<button class="chip" data-inject="${esc(q)}" ${sim.active ? '' : 'disabled title="Start call first"'}>💬 "${esc(q)}"</button>`
              )
              .join('')}
          </div>

          <h2>Scenario Test Matrix</h2>
          ${scenarios
            .map(
              (x, i) => `<div class="t">
                <div class="bar" style="justify-content:space-between;margin-bottom:4px">
                  <label style="margin:0">Scenario / Caller Utterance</label>
                  <button class="g" style="font-size:11.5px;padding:3px 8px" data-inject="${esc(x.s)}" ${sim.active ? '' : 'disabled title="Start a live call to inject this scenario"'}>▶ Send in Live Call</button>
                </div>
                <input aria-label="Scenario ${i + 1}: caller utterance" data-ti="${i}" data-tk="s" value="${esc(x.s)}">
                <label>Expected Bot Behaviour &amp; Function Calls</label>
                <input aria-label="Scenario ${i + 1}: expected behavior" data-ti="${i}" data-tk="e" value="${esc(x.e)}">
                <div class="row">
                  <div>
                    <label>Result</label>
                    <select aria-label="Scenario ${i + 1}: result" data-ti="${i}" data-tk="r">
                      ${[
                        ['p', 'Pending'],
                        ['ok', 'Pass'],
                        ['f', 'Fail'],
                      ]
                        .map(([v, l]) => `<option value="${v}" ${x.r === v ? 'selected' : ''}>${l}</option>`)
                        .join('')}
                    </select>
                  </div>
                  <div>
                    <label>QA Notes</label>
                    <input aria-label="Scenario ${i + 1}: notes" data-ti="${i}" data-tk="n" value="${esc(x.n)}">
                  </div>
                </div>
                <button class="g danger" data-rm="${i}" style="margin-top:8px">Remove Scenario</button>
              </div>`
            )
            .join('')}
          <button class="b" id="addt">+ Add Scenario</button>
          <div class="note" id="sum"></div>

          <h2 id="sim-history">Recent Browser Test History <button class="g" id="btn-refresh-logs" style="font-size:11px;padding:3px 8px;text-transform:none">Refresh</button> <button class="g" id="btn-clear-logs" ${sim.active || sim.connecting || sim.recordingSaving ? 'disabled' : ''} style="font-size:11px;padding:3px 8px;text-transform:none">Clear History</button></h2>
          <div class="note">Newest first, for the selected agent. Audio is available only for tests recorded after opting in. Tests made before recording was available have no audio. Bridge-call recordings are separate in Wallboard.</div>
          ${sim.recordingFallback ? `<div class="t" style="border-left:3px solid var(--er)">
            <b>Audio was not saved or could not be confirmed in history.</b> ${esc(sim.recordingFallback.message)}
            <a class="g" href="${esc(sim.recordingFallback.url)}" download="${esc(sim.recordingFallback.fileName)}" style="margin-left:8px">Download audio now</a>
            <button class="g danger" id="btn-discard-recording-fallback" style="margin-left:8px">Discard temporary copy</button>
            <div class="note">This temporary copy is lost if you leave or reload this tab.</div>
          </div>` : sim.recordingError ? `<div class="t er" role="alert">${esc(sim.recordingError)}</div>` : ''}
          <div id="sim-logs-box">${renderCallLogsList()}</div>
        </div>

        <div class="card sticky">
          <h2>Automated Pre-Flight Checks (18 Rules)</h2>
          <div id="test-ck">${renderCheckList(validateAgentLocal(a))}</div>
          ${
            sim.sessionSettings
              ? `<h2>Hydrated Session Preview</h2><div class="note">If no caller turn is detected, the opening is requested separately after the wait, not as the provider's automatic greeting.</div><pre style="max-height:320px">${esc(JSON.stringify(sim.sessionSettings, null, 2))}</pre>`
              : ''
          }
        </div>
      `;

      renderSimFeedDom();
      updateSimKpisDom();
      updateTestSummary();
    } else if (tab === 'vici') {
      ensureViciMonitorWs();
      if (!viciMon.loaded) {
        viciMon.loaded = true;
        loadViciBridgeStatus();
      }
      const bs = viciMon.status;
      const deployBlockers = deploymentReadinessBlockersLocal();
      const loopbackCampaign = S.campaigns.find((campaign) => campaign.id === viciMon.simCampaignId) || null;
      const loopbackAgent = loopbackCampaign ? S.agents.find((agent) => agent.id === loopbackCampaign.agentId) : null;
      const loopbackBlockers = !loopbackCampaign
        ? ['Create and select a campaign before testing a call.']
        : [
            ...validateCampaignLocal(loopbackCampaign).filter((item) => item[0] === 'er').map((item) => `Campaign: ${item[2]}`),
            ...(loopbackAgent ? validateAgentLocal(loopbackAgent).filter((item) => item[0] === 'er').map((item) => `Agent: ${item[2]}`) : ['Assign this campaign to an existing bot agent.']),
          ];

      m.innerHTML = `
        <div class="card">
          <div class="sim-header">
            <h2 style="margin:0">⚡ Live VICIdial Bridge Service (Step 3)</h2>
            <div class="bar" style="margin:0">
              <span class="pill ${bs?.sipRtpListening ? 'ok' : 'wn'}">
                ${bs?.sipRtpListening ? `✓ SIP+RTP UDP :${bs.sipPort} Listening` : serverlessCloudMode ? 'SIP+RTP unavailable on static site' : 'SIP+RTP not listening'}
              </span>
              <span class="pill ${bs?.audioSocketListening ? 'ok' : 'wn'}">
                ${bs?.audioSocketListening ? `✓ AudioSocket TCP :${bs.audioSocketPort} Listening` : serverlessCloudMode ? 'AudioSocket unavailable on static site' : 'AudioSocket not listening'}
              </span>
            </div>
          </div>

          <div class="sim-kpis">
            <div class="kpi"><div class="kpi-lbl">Active Bridge Calls</div><div class="kpi-val ${bs?.activeCallsCount ? 'ok' : ''}">${bs?.activeCallsCount ?? 0}</div></div>
            <div class="kpi"><div class="kpi-lbl">Total Handled</div><div class="kpi-val">${bs?.totalCalls ?? 0}</div></div>
            <div class="kpi"><div class="kpi-lbl">Closer Transfers</div><div class="kpi-val ok">${bs?.completedTransfers ?? 0}</div></div>
            <div class="kpi"><div class="kpi-lbl">DNCs Recorded</div><div class="kpi-val wn">${bs?.dncCount ?? 0}</div></div>
          </div>

          <div class="t" style="margin-top:10px;border-left:3px solid var(--ac)">
            <label style="margin-top:0">Hardware-Loopback ViciBox Call Simulator (Real Binary SIP/RTP &amp; AudioSocket)</label>
            <div class="note" style="margin-top:2px;margin-bottom:8px">
              ${serverlessCloudMode ? 'Unavailable on a static site; a running bridge server is required.' : 'Sends a local SIP/RTP or AudioSocket test through the bridge with synthetic caller data and a mock VICIdial API. Mock API successes do not change VICIdial. Deepgram mode uses the provider; mock AI mode uses scripted output. Custom webhooks may still have real effects. The test temporarily changes shared bridge/provider routing: run only on an isolated instance with no live calls.'}
            </div>
            <div class="row r3">
              <div>
                <label for="vsim-transport">Asterisk Media Transport</label>
                <select id="vsim-transport" ${viciMon.simRunning ? 'disabled' : ''}>
                  <option value="sip_rtp" ${viciMon.simTransport === 'sip_rtp' ? 'selected' : ''}>SIP + RTP G.711 μ-law (:${bs?.sipPort || S.vici.sipPort} — Universal ViciBox)</option>
                  <option value="audiosocket" ${viciMon.simTransport === 'audiosocket' ? 'selected' : ''}>AudioSocket TCP (:${bs?.audioSocketPort || S.vici.bridgePort} — Asterisk 18+)</option>
                </select>
              </div>
              <div>
                <label for="vsim-scenario">Caller Scenario</label>
                <select id="vsim-scenario" ${viciMon.simRunning ? 'disabled' : ''}>
                  <option value="medicare_qualified_xfer" ${viciMon.simScenario === 'medicare_qualified_xfer' ? 'selected' : ''}>[MEDICARE] Part A&amp;B + stated age 71 -> XFER</option>
                  <option value="medicare_qualified_no_age_xfer" ${viciMon.simScenario === 'medicare_qualified_no_age_xfer' ? 'selected' : ''}>[MEDICARE] Part A&amp;B, no age stated -> XFER without age</option>
                  <option value="medicare_fabricated_age_xfer" ${viciMon.simScenario === 'medicare_fabricated_age_xfer' ? 'selected' : ''}>[MEDICARE] Part A only, model invents age/Part B -> metadata guarded</option>
                  <option value="medicare_underage_dq" ${viciMon.simScenario === 'medicare_underage_dq' ? 'selected' : ''}>[MEDICARE] Underage 61 -> Hard Stop Disqualify (DQ)</option>
                  <option value="medicare_spanish_lang" ${viciMon.simScenario === 'medicare_spanish_lang' ? 'selected' : ''}>[MEDICARE] "Hablo español" -> Language Barrier (LANG)</option>
                  <option value="dnc_request" ${viciMon.simScenario === 'dnc_request' ? 'selected' : ''}>[ALL] Hostile / Stop Calling -> add_dnc_phone + Hangup (DNC)</option>
                  <option value="qualified_xfer" ${viciMon.simScenario === 'qualified_xfer' ? 'selected' : ''}>[FINAL EXPENSE] Qualified Age 64 -> FE_CLOSERS Xfer (XFER)</option>
                  <option value="not_interested" ${viciMon.simScenario === 'not_interested' ? 'selected' : ''}>[ALL] Not Interested -> NI Dispo + Hangup (NI)</option>
                </select>
              </div>
              <div>
                <label for="vsim-upstream">AI Upstream Engine</label>
                <select id="vsim-upstream" ${viciMon.simRunning ? 'disabled' : ''}>
                  <option value="deepgram" ${viciMon.simUpstream === 'deepgram' ? 'selected' : ''}>Live Deepgram Cloud (8 kHz Real Audio)</option>
                  <option value="mock_ai" ${viciMon.simUpstream === 'mock_ai' ? 'selected' : ''}>Fast Local Mock AI (&lt; 0.5s Protocol Check)</option>
                </select>
              </div>
            </div>
            <div class="row" style="margin-top:8px">
              <div>
                <label for="vsim-campaign">Explicit campaign for this loopback call</label>
                <select id="vsim-campaign" ${viciMon.simRunning ? 'disabled' : ''}>
                  ${S.campaigns.length
                    ? `${!loopbackCampaign ? '<option value="" selected>Choose a campaign…</option>' : ''}${S.campaigns.map((campaign) => `<option value="${esc(campaign.id)}" ${campaign.id === loopbackCampaign?.id ? 'selected' : ''}>${esc(campaign.name)} · ${esc(campaign.viciCampaign || 'no VICIdial ID')}</option>`).join('')}`
                    : '<option value="">No campaigns configured</option>'}
                </select>
              </div>
              <div class="note">${loopbackCampaign
                ? `Call uses “${esc(loopbackCampaign.name)}” assigned to ${esc(loopbackAgent?.name || 'no agent')}; only this campaign’s prompt rules and disposition codes apply.`
                : S.campaigns.length ? 'Select one campaign explicitly for this loopback call; the console will not default to another campaign.' : 'Create a campaign and assign a bot agent before testing.'}</div>
            </div>
            ${loopbackBlockers.length
              ? `<div class="note er" style="margin-top:8px">Selected campaign call test blocked: ${esc(loopbackBlockers.join(' • '))}</div>`
              : '<div class="note ok" style="margin-top:8px">Selected campaign and assigned agent passed call-readiness checks.</div>'}
            ${deployBlockers.length
              ? `<div class="note wn" style="margin-top:8px">Release downloads remain blocked until every agent and campaign is ready: ${esc(deployBlockers.join(' • '))}</div>`
              : ''}
            <div class="bar" style="margin-top:10px;margin-bottom:0">
              <button class="b" id="btn-vici-sim" ${viciMon.simRunning || serverlessCloudMode || loopbackBlockers.length ? 'disabled' : ''}>
                ${serverlessCloudMode ? 'Bridge test unavailable on static site' : viciMon.simRunning ? '⏳ Running loopback test…' : '📞 Run isolated bridge loopback test'}
              </button>
              <button class="g" id="btn-vici-verify" ${viciMon.verifyRunning ? 'disabled' : ''}>
                ${viciMon.verifyRunning ? '⏳ Checking ViciBox…' : '🔌 Test ViciBox HTTP & AMI'}
              </button>
              <a class="g" href="/api/vici/deploy-script" download="vicibox-install.sh" style="text-decoration:none;padding:7px 11px;border-radius:8px;border:1px solid var(--bd);font-size:12.5px;color:var(--tx)">⬇ vicibox-install.sh</a>
              <a class="g" href="/api/vici/release-bundle" download="voice-agent-vicibox-release.tar.gz" style="text-decoration:none;padding:7px 11px;border-radius:8px;border:1px solid var(--bd);font-size:12.5px;color:var(--tx)">📦 Download ViciBox Bundle (.tar.gz)</a>
              <a class="g" href="/api/vici/logs.csv" download style="text-decoration:none;padding:7px 11px;border-radius:8px;border:1px solid var(--bd);font-size:12.5px;color:var(--tx)">📊 Export CDRs (.csv)</a>
            </div>
            ${
              viciMon.simError
                ? `<div class="note er" style="margin-top:8px">✗ ${esc(viciMon.simError)}</div>`
                : ''
            }
            ${
              viciMon.verifyResult
                ? `<div class="t" style="margin-top:10px;margin-bottom:0;border-left:3px solid ${viciMon.verifyResult.vicidialHttp?.ok ? 'var(--ok)' : 'var(--wn)'}">
                    <div style="font-size:12px;line-height:1.55">
                      <div><b>VICIdial Non-Agent API (<code>${esc(S.vici.viciBaseUrl + S.vici.nonAgentApiPath)}</code>):</b> ${
                    viciMon.verifyResult.vicidialHttp?.ok
                      ? `<span class="ok">✓ ${esc(viciMon.verifyResult.vicidialHttp.versionText)}</span>`
                      : `<span class="wn">! ${esc(viciMon.verifyResult.vicidialHttp?.versionText || 'Unreachable (expected until deployed onto ViciBox 115.186.137.240)')}</span>`
                  }</div>
                      <div><b>Asterisk AMI (<code>${esc(S.vici.amiHost + ':' + S.vici.amiPort)}</code>):</b> ${
                    viciMon.verifyResult.asteriskAmi?.ok
                      ? `<span class="ok">✓ ${esc(viciMon.verifyResult.asteriskAmi.message || 'Pong')}</span>`
                      : `<span class="wn">! ${esc(viciMon.verifyResult.asteriskAmi?.message || 'Unreachable')}</span>`
                  }</div>
                    </div>
                  </div>`
                : ''
            }
          </div>

          <div class="note wn">Loopback test CDRs are mixed with bridge history. Their mock VICIdial successes do not confirm real transfers, dispositions or DNC updates; older records may not distinguish tests from live calls.</div>
          <h2>Recent SQLite Bridge Call CDRs &amp; VICIdial API Trail <button class="g" id="btn-clear-vici-logs" style="font-size:11px;padding:3px 8px;text-transform:none">Clear CDRs</button></h2>
          <div id="vici-cdr-box">${renderBridgeCdrList()}</div>

          <h2>VICIdial API Endpoints (Separated Non-Agent vs Agent API)</h2>
          ${F('VICIdial Server Base URL (115.186.137.240)', 'v.viciBaseUrl')}
          <div class="row">
            ${F('Non-Agent API Path (lead_all_info, add_dnc_phone, update_lead)', 'v.nonAgentApiPath')}
            ${F('Agent API Path (ra_call_control closer transfers & hangup)', 'v.agentApiPath')}
          </div>
          <div class="row">
            ${F('API User', 'v.apiUser')}
            ${F('API Source Tag', 'v.source')}
          </div>

          <h2>Telephony Media &amp; Control Transport (Both Listeners Run Simultaneously)</h2>
          ${F('Primary Dialplan Mode Highlighted in Export', 'v.transport', 'sel', [
            ['sip_trunk', 'SIP + RTP G.711 μ-law Peer (:5062 — Works on ALL ViciBox / Asterisk 13, 16, 18+)'],
            ['audiosocket', 'Asterisk AudioSocket TCP (:9092 — Native Asterisk 18+ / ViciBox 11-12)'],
          ])}
          <div class="row r3">
            ${F('Bridge Host / IP', 'v.bridgeHost')}
            ${F('SIP Port (avoid 5060 on ViciBox)', 'v.sipPort', 'number', [], 'min="1" max="65535" step="1"')}
            ${F('AudioSocket Port', 'v.bridgePort', 'number', [], 'min="1" max="65535" step="1"')}
          </div>
          <div class="row r3">
            ${F('AI Extension Prefix', 'v.aiExten')}
            ${F('Base Remote Agent User', 'v.remoteAgentUser')}
            ${F('Inbound Drop In-Group', 'v.inIngroup')}
          </div>
          <div class="row r3">
            ${F('AMI Host', 'v.amiHost')}
            ${F('AMI Port', 'v.amiPort', 'number', [], 'min="1" max="65535" step="1"')}
            ${F('AMI Username', 'v.amiUser')}
          </div>
          <div class="note">
            Passwords (<code>VICI_API_PASS</code>, <code>AMI_SECRET</code>, <code>DEEPGRAM_API_KEY</code>) live exclusively in the server <code>.env</code> file — click <b>🔑 API Keys</b> in the side panel to manage them safely.
          </div>
        </div>
        <div class="card sticky">
          <h2>Generated ViciBox Dialplan &amp; Bridge Config (SIP/RTP + AudioSocket)</h2>
          <pre id="pv"></pre>
        </div>
      `;
    } else if (tab === 'wallboard') {
      ensureViciMonitorWs();
      if (!viciMon.loaded || !viciMon.analytics) {
        viciMon.loaded = true;
        loadViciBridgeStatus();
      }
      const bs = viciMon.status;
      const ana = viciMon.analytics || {};
      const activeCalls = bs?.activeCalls || [];
      const dispoEntries = Object.entries(ana.dispositions || {});
      const campRows = ana.campaigns || [];

      m.innerHTML = `
        <div class="card">
          <div class="sim-header">
            <h2 style="margin:0">📊 Live Supervisor Wallboard, Recordings &amp; QA</h2>
            <div class="bar" style="margin:0">
              <button class="g" id="btn-wb-refresh">↻ Refresh</button>
              <a class="g" href="/api/vici/logs.csv" download style="text-decoration:none;padding:7px 11px;border-radius:8px;border:1px solid var(--bd);font-size:12.5px;color:var(--tx)">📊 Export CSV Report</a>
              <a class="b" href="/api/vici/release-bundle" download="voice-agent-vicibox-release.tar.gz" style="text-decoration:none;padding:7px 11px;border-radius:8px;font-size:12.5px;color:#fff">📦 Download Turnkey ViciBox Bundle (.tar.gz)</a>
            </div>
          </div>

          <p class="note">Analytics use retained logs only: up to 200 bridge calls and 100 simulator calls, not lifetime totals.</p>
          <div class="sim-kpis">
            <div class="kpi"><div class="kpi-lbl">Retained Bridge Calls (max 200)</div><div class="kpi-val">${ana.totalBridgeCalls ?? 0}</div></div>
            <div class="kpi"><div class="kpi-lbl">Closer Transfer Rate</div><div class="kpi-val ok">${ana.transferRatePct ?? 0}% (${ana.transfersCount ?? 0})</div></div>
            <div class="kpi"><div class="kpi-lbl">Avg / P95 Session-Mean TTFB</div><div class="kpi-val">${ana.avgTtfbMs ? `${ana.avgTtfbMs}ms / ${ana.p95TtfbMs || ana.avgTtfbMs}ms` : '—'}</div></div>
            <div class="kpi"><div class="kpi-lbl">Stereo .wav Recordings</div><div class="kpi-val ok">${ana.recordedCount ?? 0}</div></div>
          </div>

          <div class="sim-kpis" style="margin-top:8px">
            <div class="kpi"><div class="kpi-lbl">Avg Call Duration</div><div class="kpi-val">${ana.avgDurationSec ?? 0}s</div></div>
            <div class="kpi"><div class="kpi-lbl">DNC Rate</div><div class="kpi-val wn">${ana.dncRatePct ?? 0}% (${ana.dncCount ?? 0})</div></div>
            <div class="kpi"><div class="kpi-lbl">SIP+RTP / AudioSocket</div><div class="kpi-val">${ana.byTransport?.sip_rtp ?? 0} / ${ana.byTransport?.audiosocket ?? 0}</div></div>
            <div class="kpi"><div class="kpi-lbl">IP / Capacity Blocks</div><div class="kpi-val ${(bs?.rejectedUntrustedIpCount || bs?.rejectedOverCapacityCount) ? 'wn' : ''}">${bs?.rejectedUntrustedIpCount ?? 0} / ${bs?.rejectedOverCapacityCount ?? 0}</div></div>
          </div>

          <h2>🔴 Live Active Calls (${activeCalls.length}) — Supervisor Intervention</h2>
          ${
            activeCalls.length
              ? activeCalls
                  .map(
                    (ac) => `<div class="t" style="border-left:3px solid var(--ok)">
                      <div class="bar" style="justify-content:space-between;margin-bottom:4px">
                        <span>
                          <b>${esc(ac.agentName)}</b> (${esc(ac.campaignName)}) ·
                          <span class="pill">${esc(ac.transport)}</span> ·
                          CID: <code>${esc(ac.callerCode)}</code> ·
                          Lead: <b>#${esc(ac.leadId || 'n/a')}</b> (${esc(ac.phone || 'n/a')}) ·
                          State: <span class="pill ok">${esc(ac.state)}</span>
                        </span>
                        <span class="bar" style="margin:0">
                          <button class="b" data-sup-xfer="${esc(ac.callId)}" style="padding:4px 9px;font-size:11.5px">⚡ Force Closer Xfer</button>
                          <button class="g danger" data-sup-hangup="${esc(ac.callId)}" style="padding:4px 9px;font-size:11.5px">🛑 Force Hangup</button>
                        </span>
                      </div>
                    </div>`
                  )
                  .join('')
              : `<div class="note">No calls currently in progress. Active ViciBox calls appear here instantly over <code>/ws/vici-monitor</code> with live Force Transfer &amp; Force Hangup buttons.</div>`
          }

          <h2>🎧 Stereo 8 kHz Call Recordings &amp; SQLite CDR Archive</h2>
          <div class="note wn">Bridge loopback test recordings and CDRs can appear here alongside live calls. Mock VICIdial responses are not proof of a real transfer, disposition or DNC update.</div>
          <div id="vici-cdr-box">${renderBridgeCdrList()}</div>
        </div>

        <div class="card sticky">
          <h2>Campaign Performance</h2>
          ${
            campRows.length
              ? campRows
                  .map(
                    (cr) => `<div class="ck">
                      <span class="pill ok">${esc(cr.campaign)}</span>
                      <div>
                        <b>${cr.total} calls</b> · ${cr.transfers} transfers · ${cr.dncs} DNCs · avg ${cr.avgDurationSec}s
                      </div>
                    </div>`
                  )
                  .join('')
              : `<div class="note">Run or receive a call to populate per-campaign metrics.</div>`
          }

          <h2>Disposition Distribution</h2>
          ${
            dispoEntries.length
              ? dispoEntries
                  .map(
                    ([code, cnt]) => `<div class="ck">
                      <span class="pill ${code === 'XFER' ? 'ok' : code === 'DNC' ? 'wn' : ''}">${esc(code)}</span>
                      <span><b>${cnt}</b> calls</span>
                    </div>`
                  )
                  .join('')
              : `<div class="note">No dispositions logged yet.</div>`
          }

          <h2>Production Hardening Status</h2>
          <div class="ck">
            <span class="${cmdDeckState.serverTelemetry?.inventory?.authEnforced ? 'ok' : 'wn'}">${cmdDeckState.serverTelemetry?.inventory?.authEnforced ? '✓' : '!'}</span>
            <span>Console Auth: <b>${cmdDeckState.serverTelemetry?.inventory?.authEnforced ? 'Enforced (password or account)' : 'Not confirmed; configure before public exposure'}</b></span>
          </div>
          <div class="ck">
            <span class="${secretsStatus?.BRIDGE_ALLOWED_IPS?.configured ? 'ok' : 'wn'}">${secretsStatus?.BRIDGE_ALLOWED_IPS?.configured ? '✓' : '!'}</span>
            <span>SIP/AudioSocket IP Allowlist (<code>BRIDGE_ALLOWED_IPS</code>): <b>${secretsStatus?.BRIDGE_ALLOWED_IPS?.configured ? 'Configured (check rules for wildcards)' : 'Loopback only by default'}</b></span>
          </div>
          <div class="ck">
            <span class="ok">✓</span>
            <span>Direct pre-call hooks use the configured peer allowlist; proxied requests require authentication.</span>
          </div>
          <div class="ck">
            <span class="ok">✓</span>
            <span>Campaign <code>maxCalls</code> Capacity Guard Active (SIP <code>486 Busy Here</code>)</span>
          </div>
          <div class="ck">
            <span class="ok">✓</span>
            <span>Stereo 8 kHz <code>.wav</code> Auto-Recording &amp; 200-Call Retention Active</span>
          </div>
        </div>
      `;
    } else if (tab === 'export') {
      m.innerHTML = `
        <div class="card">
          <div class="bar">
            <button class="b" id="cp">📋 Copy Export JSON</button>
            <button class="g" id="dl-json">⬇ Download .json File</button>
            <button class="g" id="im-json">⬆ Import .json File</button>
            <button class="g danger" id="rs" style="margin-left:auto">Reset to Factory Defaults</button>
          </div>
          <div class="row" style="align-items:start">
            <div>
              <h2>Full Console + Keyed Agent Settings Bundle</h2>
              <pre id="pv"></pre>
            </div>
            <div>
              <h2>SQLite Server Revision History (<code>data/console.sqlite</code>)</h2>
              ${
                revisions.length
                  ? revisions
                      .map(
                        (r) => `<div class="ck">
                          <span class="pill">#${r.id}</span>
                          <div>
                            <div style="font-weight:500">${esc(r.summary)}</div>
                            <div class="note" style="margin-top:2px">${esc(new Date(r.saved_at).toLocaleString())}</div>
                          </div>
                        </div>`
                      )
                      .join('')
                  : '<div class="note">No revisions recorded yet.</div>'
              }
            </div>
          </div>
        </div>
      `;
    }

    updateLivePreview();
    updateHeaderStatus();
  }

  function renderLinkedView() {
    const requested = readViewLocation();
    tab = requested.tab;
    if (S.agents.some((agent) => agent.id === requested.agentId)) cur.a = requested.agentId;
    if (S.campaigns.some((campaign) => campaign.id === requested.campaignId)) cur.c = requested.campaignId;
    if (!S.agents.some((agent) => agent.id === cur.a)) cur.a = S.agents[0]?.id || '';
    if (!S.campaigns.some((campaign) => campaign.id === cur.c)) cur.c = S.campaigns[0]?.id || '';
    cmdDeckState.fleetCampaignId = tab === 'dashboard' && S.campaigns.some((campaign) => campaign.id === requested.fleetCampaignId)
      ? requested.fleetCampaignId : null;
    render();
    if (cmdDeckState.fleetCampaignId) loadFleetCampaignStats(cmdDeckState.fleetCampaignId);
  }

  window.addEventListener('popstate', () => {
    if (!S) return;
    stopAllAudio();
    hideRailTooltip();
    renderLinkedView();
  });

  function buildExportBundle() {
    const settingsByCampaignId = Object.fromEntries(
      S.campaigns.map((campaign) => {
        const agent = primaryCampaignAgent(campaign);
        const agents = campaignAgentIds(campaign).map((id) => S.agents.find((entry) => entry.id === id)).filter(Boolean);
        return [campaign.id, {
          campaignId: campaign.id,
          campaignName: campaign.name,
          agentId: agent?.id || null,
          agentIds: agents.map((entry) => entry.id),
          settings: agent ? buildSettings(agent, '', campaign) : null,
          settingsByAgentId: Object.fromEntries(agents.map((entry) => [entry.id, buildSettings(entry, '', campaign)])),
          readinessBlockers: validateCampaignLocal(campaign).filter((item) => item[0] === 'er').map((item) => item[2]),
        }];
      })
    );
    const settingsById = Object.fromEntries(
      S.agents.map((ag) => {
        const selectedCampaign = simulatorCampaign(ag.id);
        return [ag.id, {
          agentId: ag.id,
          agentName: ag.name,
          campaignIds: campaignsForAgent(ag.id).map((campaign) => campaign.id),
          selectedCampaignId: selectedCampaign?.id || null,
          settings: selectedCampaign ? buildSettings(ag, '', selectedCampaign) : null,
        }];
      })
    );
    return {
      exportedAt: new Date().toISOString(),
      readiness: { ready: deploymentReadinessBlockersLocal().length === 0, blockers: deploymentReadinessBlockersLocal() },
      console: S,
      settingsByAgentId: settingsById,
      settingsByCampaignId,
      viciConfig: buildViciConfigLocal(),
    };
  }

  function updateLivePreview() {
    const pv = document.getElementById('pv');
    if (pv) {
      if (tab === 'agents') pv.textContent = JSON.stringify(buildSettings(A()), null, 2);
      else if (tab === 'voice') pv.textContent = JSON.stringify(buildSettings(A()).agent.speak, null, 2);
      else if (tab === 'campaigns') {
        // Show the real composed prompt (bot prompt + this campaign's rules)
        // for the primary assigned bot, not raw campaign JSON.
        const campaign = C();
        const primary = campaign ? S.agents.find((agent) => agent.id === campaign.agentId) : null;
        pv.textContent = primary && campaignHasAgent(campaign, primary.id)
          ? JSON.stringify(buildSettings(primary, '', campaign), null, 2)
          : JSON.stringify(campaign, null, 2);
      }
      else if (tab === 'vici') pv.textContent = buildViciConfigLocal();
      else if (tab === 'export') pv.textContent = JSON.stringify(buildExportBundle(), null, 2);
    }

    const qck = document.getElementById('agent-quick-ck');
    if (qck) qck.innerHTML = renderCheckList(validateAgentLocal(A()));

    const cck = document.getElementById('ck');
    if (cck) cck.innerHTML = renderCheckList(validateCampaignLocal(C()));

    renderExecutiveCommandDeck();
  }

  function updateTestSummary() {
    const list = S.tests[A().id] || [];
    const el = document.getElementById('sum');
    if (el) {
      el.textContent = `${list.filter((x) => x.r === 'ok').length} pass · ${list.filter((x) => x.r === 'f').length} fail · ${
        list.filter((x) => x.r === 'p').length
      } pending`;
    }
  }

  function readTabSessionSecrets() {
    try {
      const raw = window.sessionStorage?.getItem(SESSION_SECRETS_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return isPlainObject(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function writeTabSessionSecrets(patch) {
    try {
      const curSec = readTabSessionSecrets();
      for (const [k, v] of Object.entries(patch)) {
        if (v) curSec[k] = v;
        else delete curSec[k];
      }
      window.sessionStorage?.setItem(SESSION_SECRETS_KEY, JSON.stringify(curSec));
    } catch {}
  }

  // Account security (password change / session revocation). Only populated for
  // cookie-authenticated server accounts, never for the static browser demo.
  let accountSecurityUser = null;

  function setAccountSecurityMsg(text, isError) {
    const el = document.getElementById('account-security-msg');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('er', Boolean(isError));
  }

  function openAccountSecurity() {
    const modal = document.getElementById('account-security-modal');
    if (!modal) return;
    const who = document.getElementById('account-security-who');
    if (who) {
      who.textContent = accountSecurityUser
        ? `Signed in as ${accountSecurityUser.fullName || accountSecurityUser.email} (${accountSecurityUser.email || ''}) · role: ${accountSecurityUser.role || 'operator'}`
        : 'Sign in with an email account to manage its password and sessions.';
    }
    for (const id of ['account-current-password', 'account-new-password']) {
      const input = document.getElementById(id);
      if (input) input.value = '';
    }
    setAccountSecurityMsg('');
    modal.hidden = false;
    document.getElementById('account-current-password')?.focus();
  }

  function closeAccountSecurity() {
    const modal = document.getElementById('account-security-modal');
    if (modal) modal.hidden = true;
    for (const id of ['account-current-password', 'account-new-password']) {
      const input = document.getElementById(id);
      if (input) input.value = '';
    }
  }

  async function submitPasswordChange() {
    const current = document.getElementById('account-current-password')?.value || '';
    const next = document.getElementById('account-new-password')?.value || '';
    if (!current) { setAccountSecurityMsg('Enter your current password.', true); return; }
    if (next.length < 15) { setAccountSecurityMsg('New password must be at least 15 characters.', true); return; }
    const btn = document.getElementById('btn-change-password');
    if (btn) btn.disabled = true;
    setAccountSecurityMsg('Updating password…');
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok || !out.ok) {
        setAccountSecurityMsg(out.error || 'Unable to update the password.', true);
        return;
      }
      for (const id of ['account-current-password', 'account-new-password']) {
        const input = document.getElementById(id);
        if (input) input.value = '';
      }
      const revoked = Number(out.revokedSessions || 0);
      setAccountSecurityMsg(`Password updated. ${revoked} other session${revoked === 1 ? '' : 's'} signed out.`);
    } catch {
      setAccountSecurityMsg('Network error. The password was not changed.', true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function revokeOtherSessions() {
    const btn = document.getElementById('btn-revoke-sessions');
    if (btn) btn.disabled = true;
    setAccountSecurityMsg('Signing out other devices…');
    try {
      const res = await fetch('/api/auth/revoke-sessions', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keepCurrent: true }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok || !out.ok) {
        setAccountSecurityMsg(out.error || 'Unable to revoke sessions.', true);
        return;
      }
      const revoked = Number(out.revokedSessions || 0);
      setAccountSecurityMsg(`${revoked} other session${revoked === 1 ? '' : 's'} signed out. This tab stays signed in.`);
    } catch {
      setAccountSecurityMsg('Network error. No sessions were revoked.', true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function loadFromServer() {
    const authRes = await fetch('./api/auth/status', { credentials: 'same-origin' }).catch(() => null);
    if (authRes && authRes.ok && (authRes.headers.get('content-type') || '').includes('application/json')) {
      const authJson = await authRes.json().catch(() => ({}));
      const logoutBtn = document.getElementById('btn-logout');
      if (!authJson.authenticated) {
        const entry = authJson.signupOpen && authJson.hasUsers === false ? '/signup' : '/login';
        const qs = window.location.search || '';
        const next = window.location.pathname === '/' && !qs ? '' : '?next=' + encodeURIComponent(window.location.pathname + qs);
        window.location.replace(entry + next);
        return;
      }
      const createAccountBtn = document.getElementById('btn-create-account');
      if (createAccountBtn && authJson.signupOpen) createAccountBtn.style.display = 'inline-flex';
      // Password rotation and session revocation need an account row; the
      // legacy ADMIN_PASSWORD session is managed in server .env instead.
      accountSecurityUser = authJson.user || null;
      const securityBtn = document.getElementById('btn-account-security');
      if (securityBtn) securityBtn.style.display = accountSecurityUser ? 'inline-flex' : 'none';
      if (logoutBtn) {
        logoutBtn.style.display = 'inline-flex';
        if (authJson.user && (authJson.user.fullName || authJson.user.email)) {
          const who = authJson.user.fullName || authJson.user.email;
          logoutBtn.title = `Signed in as ${who} (${authJson.user.email || ''}) — Click to sign out`;
          const span = logoutBtn.querySelector('span');
          if (span) span.textContent = `Sign Out (${who.split(' ')[0]})`;
        }
      }
    }

    const res = await fetch('./api/state').catch(() => null);
    const isJsonApi = Boolean(res && (res.headers.get('content-type') || '').includes('application/json'));
    if (!res || res.status === 404 || res.status === 405 || !isJsonApi) {
      // Activate Serverless Cloud Direct Mode (GitHub Pages / Vercel / Static Host)
      serverlessCloudMode = true;
      let cloudSess = null;
      try {
        cloudSess = JSON.parse(window.localStorage?.getItem(VAC_CLOUD_SESSION_KEY) || 'null');
      } catch {}
      if (!cloudSess || !cloudSess.user) {
        const qs = window.location.search || '';
        const next = qs ? '?next=' + encodeURIComponent(window.location.pathname + qs) : '';
        window.location.replace('./login.html' + next);
        return;
      }
      const logoutBtn = document.getElementById('btn-logout');
      if (logoutBtn) {
        logoutBtn.style.display = 'inline-flex';
        const who = cloudSess.user.fullName || cloudSess.user.email || 'User';
        logoutBtn.title = `Signed in as ${who} (${cloudSess.user.email || ''}) — Click to sign out`;
        const span = logoutBtn.querySelector('span');
        if (span) span.textContent = `Sign Out (${who.split(' ')[0]})`;
      }
      let loadedState = null;
      try {
        const localRaw = window.localStorage?.getItem(CLOUD_STATE_KEY);
        if (localRaw) loadedState = JSON.parse(localRaw);
      } catch {}
      let shippedState = null;
      const needsShippedDefaults = !loadedState ||
        loadedState.agents?.some((ag) => String(ag.prompt || '').includes('You already asked if they have Medicare Part A and B to release their Food & OTC card.') || /, a live (?:Customer Support|Benefits Advisor|Senior Coverage Coordinator)/.test(String(ag.behavior?.selfIntro || ''))) ||
        loadedState.campaigns?.some((cp) => ['c_medicare', 'c_med_fronter'].includes(cp.id) && !String(cp.complianceRules || '').includes('caller-confirmed Medicare Part A or Part B satisfies the qualification step'));
      if (needsShippedDefaults) {
        try {
          const staticRes = await fetch('./default-state.json', { cache: 'no-store' });
          if (staticRes.ok) shippedState = await staticRes.json();
        } catch {}
      }
      if (!loadedState) {
        if (!shippedState) throw new Error('Could not load the bundled console defaults.');
        loadedState = shippedState;
      }
      S = loadedState;
      let mig3 = false;
      for (const ag of S.agents || []) {
        const stockPrompt = shippedState?.agents?.find((entry) => entry.id === ag.id)?.prompt || '';
        const migrated = window.VacPersona.migrateLegacyQualificationPrompt(
          window.VacOpening.migrateStockMedicarePrompt(ag.prompt, stockPrompt),
          stockPrompt
        );
        if (migrated !== ag.prompt) { ag.prompt = migrated; mig3 = true; }
      }
      const mig1 = enforceDeepgramOnlyLlms(S);
      const mig2 = upgradeRealtimeAgentFeatures(S, shippedState);
      if (mig1 || mig2 || mig3) {
        try {
          window.localStorage?.setItem(CLOUD_STATE_KEY, JSON.stringify(S));
        } catch {}
      }
      snap = comparableSnapshot(S);
      revisions = [{ id: 1, saved_at: S.updatedAt || new Date().toISOString(), summary: 'Cloud Direct Browser Session' }];
      secretsStatus = buildCloudSecretsStatus();
      try {
        const draft = readLocalDraft();
        if (draftBelongsToTab(draft)) {
          if (draft.state && draft.baseSnapshot === snap && comparableSnapshot(draft.state) !== snap) {
            S = draft.state;
            enforceDeepgramOnlyLlms(S);
            upgradeRealtimeAgentFeatures(S);
          } else {
            clearLocalDraft();
          }
        }
      } catch {}
      renderLinkedView();
      updateHeaderStatus();
      syncDeepgramManagedLlms(true).then((ok) => {
        if (ok) render();
      });
      return;
    }
    if (res.status === 401) {
      document.getElementById('auth-modal').hidden = false;
      return;
    }
    const data = await res.json();
    const serverStateSnapshot = comparableSnapshot(data.state);
    S = data.state;
    if (data.telemetry) {
      cmdDeckState.serverTelemetry = data.telemetry;
    }
    syncPublicDemoButton(data.publicDemoUrl || data.telemetry?.runtime?.publicDemoUrl || null);
    enforceDeepgramOnlyLlms(S);
    upgradeRealtimeAgentFeatures(S);
    snap = serverStateSnapshot;
    revisions = data.revisions || [];
    secretsStatus = data.secrets || {};
    latestRevisionId = revisions[0]?.id || null;

    // Recover an unsaved local browser draft instead of silently replacing it
    // with the last server snapshot after a tab or network interruption.
    try {
      const draft = readLocalDraft();
      if (draftBelongsToTab(draft) && draft.state && typeof draft.baseSnapshot === 'string') {
        const serverSnapshot = comparableSnapshot(S);
        const draftSnapshot = comparableSnapshot(draft.state);
        if (draftSnapshot === serverSnapshot) {
          clearLocalDraft();
        } else if (draft.baseSnapshot === serverSnapshot || window.confirm('An unsaved local draft was found. Restore it over the current server state? Choose Cancel to keep the server state and discard the local draft.')) {
          S = draft.state;
          enforceDeepgramOnlyLlms(S);
          upgradeRealtimeAgentFeatures(S);
          snap = serverSnapshot;
          persistDraftLocally();
        } else {
          clearLocalDraft();
        }
      }
    } catch {}

    // Auto-restore in-tab session keys if sandbox container restarted between chat turns
    const tabSecrets = readTabSessionSecrets();
    const missingOnServer = {};
    for (const [k, v] of Object.entries(tabSecrets)) {
      if (v && !secretsStatus?.[k]?.configured) {
        missingOnServer[k] = v;
      }
    }
    if (Object.keys(missingOnServer).length > 0) {
      try {
        const syncRes = await fetch('/api/secrets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(missingOnServer),
        });
        const syncData = await syncRes.json();
        if (syncRes.ok && syncData.ok) {
          secretsStatus = syncData.secrets || secretsStatus;
        }
      } catch {}
    }

    renderLinkedView();
  }

  function showSaveReport({ ok, wn, er, items = [], storage, revisionId, changes = [] }) {
    const nonOk = items.filter((item) => (item.level || item[0]) !== 'ok');
    const color = er ? 'var(--er)' : wn ? 'var(--wn)' : 'var(--ok)';
    const report = document.getElementById('vr');
    report.innerHTML = `<div class="card save-report" role="status" style="border-left-color:${color}">
      <b>${esc(storage)}${revisionId ? ` (Revision #${esc(revisionId)})` : ''} — Verification Report</b>
      <div><span class="ok">${ok} passed</span> · <span class="wn">${wn} warnings</span> · <span class="er">${er} errors</span></div>
      ${changes.length ? `<div class="note">${changes.map(esc).join('<br>')}</div>` : ''}
      ${nonOk.map((item) => `<div class="ck"><span class="${item.level || item[0]}">${item.icon || item[1]}</span><span><b>${esc(item.scope || 'Configuration')}:</b> ${esc(item.message || item[2])}</span></div>`).join('')}
      <div class="note">Saving preserves configuration; errors above still block affected calls. Verification is not a compliance or uptime certification.</div>
      <button class="g" type="button" data-dismiss-save-report>Dismiss</button>
    </div>`;
  }

  async function commitSave() {
    if (!S || manualSaveInFlight || (!isDirty() && !saveError)) return false;
    manualSaveInFlight = true;
    updateHeaderStatus();
    const btn = document.getElementById('sv');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    const submittedSnapshot = comparableSnapshot(S);
    try {
      let data;
      if (serverlessCloudMode) {
        if (!window.localStorage) throw new Error('Browser storage is unavailable. Enable site storage or export a JSON backup.');
        S.updatedAt = new Date().toISOString();
        const serialized = JSON.stringify(S);
        window.localStorage.setItem(CLOUD_STATE_KEY, serialized);
        if (window.localStorage.getItem(CLOUD_STATE_KEY) !== serialized) throw new Error('Browser storage did not confirm the save. Export a JSON backup before closing this tab.');
        const items = [
          ...S.agents.flatMap((agent) => validateAgentLocal(agent).map(([level, icon, message]) => ({ level, icon, message, scope: `Agent “${agent.name}”` }))),
          ...S.campaigns.flatMap((campaign) => validateCampaignLocal(campaign).map(([level, icon, message]) => ({ level, icon, message, scope: `Campaign “${campaign.name}”` }))),
        ];
        data = { state: S, storage: 'Saved in this browser', items, changes: [] };
      } else {
        const submittedState = JSON.parse(JSON.stringify(S));
        submittedState.updatedAt = new Date().toISOString();
        const res = await fetch('./api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: submittedState }) });
        const payload = await res.json();
        if (!res.ok || !payload.ok) throw new Error(payload.error || `Save failed (HTTP ${res.status})`);
        data = { ...payload, storage: 'Saved to Server SQLite', items: payload.validations || [] };
        revisions = payload.revisions || revisions;
        secretsStatus = payload.secrets || secretsStatus;
        latestRevisionId = payload.revisionId;
        if (payload.telemetry) cmdDeckState.serverTelemetry = payload.telemetry;
      }
      const savedState = data.state || S;
      snap = comparableSnapshot(savedState);
      if (comparableSnapshot(S) === submittedSnapshot) S = savedState;
      clearLocalDraft();
      saveError = '';
      const counts = data.counts || {
        ok: data.items.filter((item) => (item.level || item[0]) === 'ok').length,
        wn: data.items.filter((item) => (item.level || item[0]) === 'wn').length,
        er: data.items.filter((item) => (item.level || item[0]) === 'er').length,
      };
      showSaveReport({ ...counts, items: data.items, storage: data.storage, revisionId: data.revisionId, changes: data.changes });
      if (!isDirty()) render(); else { updateLivePreview(); updateTestSummary(); }
      return true;
    } catch (err) {
      saveError = err?.message || 'Save failed';
      persistDraftLocally();
      const report = document.getElementById('vr');
      report.innerHTML = `<div class="card save-report er" role="alert"><b>Save not confirmed</b><div>${esc(saveError)}</div><div class="note">Your edits remain in this tab. Retry Save & Verify, or download a JSON backup from Export before closing it.</div></div>`;
      report.scrollIntoView?.({ block: 'nearest' });
      return false;
    } finally {
      manualSaveInFlight = false;
      const currentBtn = document.getElementById('sv');
      currentBtn.textContent = 'Save & Verify';
      updateHeaderStatus();
    }
  }

  async function playSampleAudio(sampleUrl, label) {
    stopAllAudio();
    const vs = document.getElementById('vs');
    const audioEl = document.getElementById('voice-audio');
    const proxied = serverlessCloudMode
      ? sampleUrl
      : `/api/deepgram/sample?url=${encodeURIComponent(sampleUrl)}`;
    voiceCatalog.previewAudioUrl = proxied;
    if (vs) vs.textContent = `Loading studio sample: ${label}…`;
    if (audioEl) {
      audioEl.onerror = () => {
        if (vs) vs.textContent = `Sample unavailable for ${label}. Check the connection and try again.`;
      };
      audioEl.onplaying = () => {
        voiceCatalog.playingLabel = `▶ Playing studio sample: ${label}`;
        if (vs) vs.textContent = voiceCatalog.playingLabel;
      };
      audioEl.src = proxied;
      activeAudioEl = audioEl;
      try {
        await audioEl.play();
      } catch {
        if (vs && !audioEl.error) vs.textContent = `Press Play on the audio bar to hear ${label}.`;
      }
    }
  }

  async function synthesizeWithApi(modelOverride, labelOverride, providerOverride) {
    stopAllAudio();
    const a = A();
    const tp = globalServiceProvider('tts') || {};
    const vtEl = document.getElementById('vt');
    const text = (vtEl ? vtEl.value : voiceCatalog.previewText || a.greeting).trim();
    const vs = document.getElementById('vs');
    const audioEl = document.getElementById('voice-audio');

    const providerType = providerOverride || (modelOverride ? 'deepgram' : tp.type);
    const model = modelOverride || S.services?.tts?.model || '';
    const label = labelOverride || `${providerType}:${model}`;
    if (!model) {
      if (vs) vs.textContent = 'Select and save a global TTS provider/model on the Plug-Ins page first.';
      return;
    }

    if (vs) {
      vs.className = 'note';
      vs.textContent = `⏳ Synthesizing real TTS audio (${label})…`;
    }

    try {
      let voiceId;
      const ex = parseJsonObject(tp.extra);
      if (ex.ok && ex.value?.voice?.id) voiceId = ex.value.voice.id;

      let res;
      if (serverlessCloudMode) {
        if (providerType === 'speech_service') {
          const ssUrl = String(readCloudSecrets().SPEECH_SERVICE_URL || localSpeechUi.urlDraft || '').replace(/\/+$/, '');
          const ssKey = String(readCloudSecrets().SPEECH_SERVICE_API_KEY || '');
          if (ssUrl) {
            const hdrs = { 'Content-Type': 'application/json' };
            if (ssKey) hdrs.Authorization = `Bearer ${ssKey}`;
            res = await fetch(`${ssUrl}/v1/audio/speech`, {
              method: 'POST',
              headers: hdrs,
              body: JSON.stringify({
                model: 'kokoro',
                input: text,
                voice: model || 'af_heart',
                response_format: 'wav',
                speed: Number(a.tts.speed) || 1,
              }),
            }).catch(() => null);
          }
          if (!res || !res.ok) {
            if (window.speechSynthesis) {
              window.speechSynthesis.cancel();
              const u = new SpeechSynthesisUtterance(text);
              u.rate = Number(a.tts.speed) || 1;
              window.speechSynthesis.speak(u);
              if (vs) {
                vs.className = 'note ok';
                vs.textContent = `🔊 Playing Local Browser Voice (${label}) — set SPEECH_SERVICE_URL in Plug-Ins to stream from a remote Kokoro GPU server.`;
              }
              return;
            }
            throw new Error('Enter your Speech Service URL on Plug-Ins to synthesize from Kokoro.');
          }
        } else {
          const dgKey = readCloudSecrets().DEEPGRAM_API_KEY || '';
          if (!dgKey) {
            throw new Error('Click "🔑 API Keys" in the side panel and save your DEEPGRAM_API_KEY first.');
          }
          const isFlux = String(model).startsWith('flux-');
          const params = new URLSearchParams({
            model: String(model),
            encoding: 'linear16',
            sample_rate: '24000',
            container: 'wav',
          });
          const spd = Number(a.tts.speed);
          if (spd && spd !== 1) params.set('speed', String(spd));
          if (isFlux && Number.isFinite(Number(a.tts.expr))) {
            params.set('expressivity', String(Math.round(Number(a.tts.expr))));
          }
          const dgEndpoint = isFlux
            ? `https://api.deepgram.com/v2/speak?${params.toString()}`
            : `https://api.deepgram.com/v1/speak?${params.toString()}`;
          res = await fetch(dgEndpoint, {
            method: 'POST',
            headers: {
              Authorization: `Token ${dgKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ text }),
          });
        }
      } else {
        res = await fetch('/api/tts/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            providerType,
            model,
            text,
            speed: Number(a.tts.speed),
            expressivity: Number(a.tts.expr),
            voiceId,
          }),
        });
      }

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.err_msg || errData.error || `Deepgram HTTP ${res.status}`);
      }

      const blob = await res.blob();
      if (voiceCatalog.previewAudioUrl && voiceCatalog.previewAudioUrl.startsWith('blob:')) {
        URL.revokeObjectURL(voiceCatalog.previewAudioUrl);
      }
      const blobUrl = URL.createObjectURL(blob);
      voiceCatalog.previewAudioUrl = blobUrl;
      voiceCatalog.playingLabel = `🔊 Playing real synthesized TTS: ${label}`;
      if (vs) vs.textContent = voiceCatalog.playingLabel;
      if (audioEl) {
        audioEl.src = blobUrl;
        activeAudioEl = audioEl;
        await audioEl.play().catch(() => {});
      }
    } catch (err) {
      if (vs) {
        vs.className = 'note wn';
        vs.textContent = `⚠ ${err.message}`;
      }
    }
  }

  function stopAllAudio() {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    const audioEl = document.getElementById('voice-audio') || activeAudioEl;
    if (audioEl) {
      audioEl.pause();
      audioEl.currentTime = 0;
      audioEl.onerror = null;
      audioEl.onplaying = null;
    }
  }

  function openKeysModal() {
    const modal = document.getElementById('keys-modal');
    const form = document.getElementById('keys-form');
    const msg = document.getElementById('keys-msg');
    msg.textContent = '';

    const keySpecs = [
      ['DEEPGRAM_API_KEY', 'Deepgram Universal API Key (powers Deepgram STT, all Deepgram-Managed LLMs, TTS & Voice Agent)'],
      ['SPEECH_SERVICE_URL', 'Local Speech Service URL (e.g. http://192.168.18.29:8000 for Faster-Whisper + Kokoro)'],
      ['SPEECH_SERVICE_API_KEY', 'Local Speech Service API Key (Bearer / X-API-Key secret from speech-service .env)'],
      ['ELEVENLABS_API_KEY', 'ElevenLabs API Key (optional — for BYO ElevenLabs TTS)'],
      ['CARTESIA_API_KEY', 'Cartesia API Key (optional — for BYO Cartesia TTS)'],
      ['VICI_API_PASS', 'VICIdial API Password (User 6666 pass on ViciBox)'],
      ['AMI_SECRET', 'Asterisk AMI Secret (cron pass in /etc/asterisk/manager.conf)'],
      ['CUSTOM_WEBHOOK_SECRET', 'Custom CRM / Webhook Secret (usable as {{CUSTOM_WEBHOOK_SECRET}} in Function headers)'],
      ['ADMIN_PASSWORD', 'Console Admin Password (Step 4 — locks :533 Web UI & WebSockets while keeping local Asterisk whitelisted)'],
      ['BRIDGE_ALLOWED_IPS', 'Allowed Asterisk IPs/CIDRs for SIP :5062 & AudioSocket :9092 (e.g. 115.186.137.240,10.0.0.0/8)'],
    ];

    form.innerHTML = keySpecs
      .map(([k, desc]) => {
        const st = secretsStatus?.[k];
        const badge = st?.configured
          ? `<span class="ok">Configured (${esc(st.masked)})</span>`
          : `<span class="wn">Not set</span>`;
        const inputType = k === 'BRIDGE_ALLOWED_IPS' || k === 'SPEECH_SERVICE_URL' ? 'text' : 'password';
        return `
          <label for="secret-${k}">${esc(desc)} — ${badge}</label>
          <input id="secret-${k}" type="${inputType}" data-secret="${k}" placeholder="${st?.configured ? 'Leave blank to keep existing value, or enter new value' : `Enter ${k}…`}" autocomplete="off" />
        `;
      })
      .join('');

    modal.hidden = false;
  }

  function formatDeepgramDiagSummary(diag) {
    if (!diag) return '';
    const r1 = diag.restAuth?.ok
      ? `✓ REST Auth (/v1/projects: ${diag.restAuth.projectName || 'OK'})`
      : `✗ REST Auth: ${diag.restAuth?.error || 'Failed'}`;
    const r2 = diag.ttsSpeak?.ok
      ? `✓ Flux v2 TTS (/v2/speak: ${diag.ttsSpeak.bytes} bytes)`
      : `✗ Flux v2 TTS: ${diag.ttsSpeak?.error || 'Failed'}`;
    const r3 = diag.voiceAgentWs?.ok
      ? `✓ Voice Agent WS (SettingsApplied in ${diag.voiceAgentWs.latencyMs}ms)`
      : `✗ Voice Agent WS: ${diag.voiceAgentWs?.error || 'Failed'}`;
    return `${r1}\n${r2}\n${r3}`;
  }

  async function saveKeysModal() {
    const inputs = document.querySelectorAll('[data-secret]');
    const payload = {};
    inputs.forEach((inp) => {
      if (inp.value.trim() !== '') {
        payload[inp.dataset.secret] = inp.value.trim();
      }
    });
    const msg = document.getElementById('keys-msg');
    if (Object.keys(payload).length === 0) {
      msg.className = 'note wn';
      msg.textContent = 'Paste at least one key above before clicking Save, or click "🔌 Test Deepgram" to verify the currently saved key.';
      return;
    }

    msg.className = 'note';
    msg.textContent = payload.DEEPGRAM_API_KEY
      ? '⏳ Saving to server .env & running live 3-step Deepgram Auth + TTS + Voice Agent WS verification…'
      : '⏳ Saving to server .env…';

    if (serverlessCloudMode) {
      writeCloudSecrets(payload);
      secretsStatus = buildCloudSecretsStatus();
      if (payload.DEEPGRAM_API_KEY) {
        const vRes = await verifyDeepgramDirectInBrowser(payload.DEEPGRAM_API_KEY);
        sim.diagResult = vRes.diagnostic || null;
        sim.lastError = null;
        msg.className = vRes.ok ? 'note ok' : 'note wn';
        msg.textContent = `${vRes.ok ? '✓ Deepgram Key Verified & Saved!' : '⚠ Key Saved (check diagnostic below):'}\n${formatDeepgramDiagSummary(vRes.diagnostic)}`;
      } else {
        msg.className = 'note ok';
        msg.textContent = '✓ Saved in Browser Cloud Storage!';
      }
      updateHeaderStatus();
      if (tab === 'voice') renderVoiceCatalogSection();
      if (tab === 'test' && !sim.active) render();
      setTimeout(() => {
        document.getElementById('keys-modal').hidden = true;
      }, 1200);
      return;
    }

    try {
      const res = await fetch('/api/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        const extra = data.deepgramDiagnostic ? `\n${formatDeepgramDiagSummary(data.deepgramDiagnostic)}` : '';
        throw new Error(`${data.error || 'Failed to save keys'}${extra}`);
      }

      secretsStatus = data.secrets || {};
      writeTabSessionSecrets(payload);

      if (payload.DEEPGRAM_API_KEY || secretsStatus?.DEEPGRAM_API_KEY?.configured) {
        sim.lastError = null;
      }
      if (data.deepgramDiagnostic) {
        sim.diagResult = data.deepgramDiagnostic;
      }

      const wsWarn = data.deepgramDiagnostic && !data.deepgramDiagnostic.voiceAgentWs?.ok;
      msg.className = wsWarn ? 'note wn' : 'note ok';
      msg.textContent = data.deepgramDiagnostic
        ? `${data.deepgramVerified ? '✓ Deepgram Key Saved & Fully Verified!' : '⚠ Key Saved (see Voice Agent WS notice below):'}\n${formatDeepgramDiagSummary(data.deepgramDiagnostic)}`
        : '✓ Saved to server .env!';

      updateHeaderStatus();
      if (tab === 'voice') renderVoiceCatalogSection();
      if (tab === 'test' && !sim.active) render();

      if (!wsWarn) {
        setTimeout(() => {
          document.getElementById('keys-modal').hidden = true;
        }, 1200);
      }
    } catch (err) {
      msg.className = 'note er';
      msg.textContent = `✗ ${err.message}`;
    }
  }

  async function verifyDeepgramDirectInBrowser(rawKey) {
    const key = String(rawKey || '').trim().replace(/^(Token|Bearer)\s+/i, '');
    if (!key) {
      return {
        ok: false,
        error: 'No DEEPGRAM_API_KEY configured — click 🔑 API Keys and paste your Deepgram key.',
        diagnostic: {
          restAuth: { ok: false, error: 'Missing API key' },
          ttsSpeak: { ok: false, error: 'Skipped' },
          voiceAgentWs: { ok: false, error: 'Skipped' },
        },
      };
    }

    const diag = {
      restAuth: { ok: false, projectName: 'Deepgram Direct Browser Auth' },
      ttsSpeak: { ok: false, bytes: 0 },
      voiceAgentWs: { ok: false, latencyMs: 0 },
    };

    try {
      const ttsRes = await fetch(
        'https://api.deepgram.com/v2/speak?model=flux-haley-en&encoding=linear16&sample_rate=24000&container=wav',
        {
          method: 'POST',
          headers: { Authorization: `Token ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: 'Connection verified.' }),
        }
      );
      if (ttsRes.ok) {
        const buf = await ttsRes.arrayBuffer();
        diag.restAuth = { ok: true, projectName: 'Authenticated via Deepgram Direct CORS' };
        diag.ttsSpeak = { ok: true, bytes: buf.byteLength };
      } else {
        const ej = await ttsRes.json().catch(() => ({}));
        const errMsg = ej.err_msg || ej.message || `HTTP ${ttsRes.status}`;
        diag.restAuth = { ok: false, error: errMsg };
        diag.ttsSpeak = { ok: false, error: errMsg };
      }
    } catch (e) {
      diag.ttsSpeak = { ok: false, error: e.message || 'TTS request failed' };
    }

    await new Promise((resolve) => {
      const t0 = Date.now();
      let settled = false;
      const done = (resObj) => {
        if (settled) return;
        settled = true;
        diag.voiceAgentWs = resObj;
        resolve();
      };
      try {
        const ws = new WebSocket('wss://agent.deepgram.com/v1/agent/converse', ['token', key]);
        const timer = setTimeout(() => {
          try { ws.close(); } catch {}
          done({ ok: false, error: 'Voice Agent WS timeout (6s)' });
        }, 6000);
        ws.onmessage = (ev) => {
          if (typeof ev.data !== 'string') return;
          try {
            const m = JSON.parse(ev.data);
            if (m.type === 'Welcome') {
              const testSet = buildSettings(A());
              delete testSet.agent.greeting;
              ws.send(JSON.stringify(testSet));
            } else if (m.type === 'SettingsApplied') {
              clearTimeout(timer);
              try { ws.close(1000, 'verified'); } catch {}
              done({ ok: true, latencyMs: Date.now() - t0 });
            } else if (m.type === 'Error') {
              clearTimeout(timer);
              try { ws.close(); } catch {}
              done({ ok: false, error: m.description || m.message || m.code || 'Settings rejected' });
            }
          } catch {}
        };
        ws.onerror = () => {
          clearTimeout(timer);
          done({ ok: false, error: 'WebSocket auth rejected — check DEEPGRAM_API_KEY' });
        };
      } catch (e) {
        done({ ok: false, error: e.message });
      }
    });

    return {
      ok: Boolean(diag.ttsSpeak.ok && diag.voiceAgentWs.ok),
      diagnostic: diag,
    };
  }

  async function testDeepgramModalOrBanner(inModal = false) {
    const dgInput = document.querySelector('[data-secret="DEEPGRAM_API_KEY"]');
    const typedKey = inModal && dgInput && dgInput.value.trim() ? dgInput.value.trim() : undefined;
    const msg = document.getElementById('keys-msg');
    if (inModal && msg) {
      msg.className = 'note';
      msg.textContent = '⏳ Testing Deepgram Auth, Flux v2 TTS, and Voice Agent WebSocket handshake…';
    }
    sim.diagRunning = true;
    if (tab === 'test' && !sim.active && !inModal) render();

    try {
      let data;
      if (serverlessCloudMode) {
        const activeKey = typedKey || readCloudSecrets().DEEPGRAM_API_KEY || '';
        data = await verifyDeepgramDirectInBrowser(activeKey);
      } else {
        const res = await fetch('/api/deepgram/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(typedKey ? { apiKey: typedKey } : {}),
        });
        data = await res.json();
      }
      sim.diagResult = data.diagnostic || null;
      if (inModal && msg) {
        msg.className = data.ok ? 'note ok' : 'note er';
        msg.textContent = data.diagnostic
          ? formatDeepgramDiagSummary(data.diagnostic)
          : `✗ ${data.error || 'Verification failed'}`;
      }
    } catch (err) {
      if (inModal && msg) {
        msg.className = 'note er';
        msg.textContent = `✗ ${err.message}`;
      }
    } finally {
      sim.diagRunning = false;
      if (tab === 'test' && !sim.active) render();
    }
  }

  async function clearAllSavedKeys() {
    const emptyPayload = {
      DEEPGRAM_API_KEY: '',
      ELEVENLABS_API_KEY: '',
      CARTESIA_API_KEY: '',
      GROQ_API_KEY: '',
      VICI_API_PASS: '',
      AMI_SECRET: '',
    };
    try {
      window.sessionStorage?.removeItem(SESSION_SECRETS_KEY);
    } catch {}
    if (serverlessCloudMode) {
      writeCloudSecrets({}, true);
      secretsStatus = buildCloudSecretsStatus();
      sim.diagResult = null;
      openKeysModal();
      updateHeaderStatus();
      if (tab === 'test' && !sim.active) render();
      return;
    }
    const res = await fetch('/api/secrets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(emptyPayload),
    });
    const data = await res.json();
    secretsStatus = data.secrets || {};
    sim.diagResult = null;
    openKeysModal();
    const msg = document.getElementById('keys-msg');
    if (msg) {
      msg.className = 'note';
      msg.textContent = 'Cleared saved keys from server .env and tab session.';
    }
    updateHeaderStatus();
    if (tab === 'voice') renderVoiceCatalogSection();
    if (tab === 'test' && !sim.active) render();
  }

  document.addEventListener('click', (e) => {
    const pop = document.getElementById('account-popover');
    const trigger = document.getElementById('btn-account-menu');
    if (pop && !pop.hidden && !e.target.closest('.side-utility-dock')) {
      pop.hidden = true;
      trigger?.setAttribute('aria-expanded', 'false');
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const security = document.getElementById('account-security-modal');
      if (security && !security.hidden) closeAccountSecurity();
      const pop = document.getElementById('account-popover');
      if (pop && !pop.hidden) {
        pop.hidden = true;
        document.getElementById('btn-account-menu')?.setAttribute('aria-expanded', 'false');
      }
    }
  });

  // Click delegation
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('button, a');
    if (!b) return;
    if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const d = b.dataset;

    if (b.id === 'retry-greeting-catalog') {
      greetingCatalog.error = '';
      await ensureGreetingCatalogLoaded();
      return;
    }
    if (d.greetingPage) {
      greetingCatalog.page += d.greetingPage === 'next' ? 1 : -1;
      const results = document.getElementById('greeting-results');
      if (results) results.innerHTML = renderGreetingResults();
      return;
    }

    if (b.id === 'btn-sidebar-toggle' || b.id === 'btn-sidebar-toggle-mobile') {
      toggleSidebar();
      return;
    }

    if (b.id === 'btn-account-menu') {
      const pop = document.getElementById('account-popover');
      if (pop) {
        pop.hidden = !pop.hidden;
        b.setAttribute('aria-expanded', pop.hidden ? 'false' : 'true');
      }
      return;
    }

    if (d.t || d.cmdTab) {
      e.preventDefault();
      navigateSection(d.t || d.cmdTab, { agentId: A()?.id, campaignId: C()?.id });
      return;
    }

    // Executive Command & Console Quality Dashboard interactive controls.
    if (d.cmdAgent || d.fleetAgent) {
      e.preventDefault();
      navigateSection('agents', { agentId: d.cmdAgent || d.fleetAgent });
      return;
    }
    if (d.cmdCampaign) {
      e.preventDefault();
      navigateSection('campaigns', { campaignId: d.cmdCampaign });
      return;
    }
    if (d.fleetCampaign) {
      e.preventDefault();
      navigateSection('dashboard', { fleetCampaignId: d.fleetCampaign });
      return;
    }
    if (d.fleetRetry) {
      loadFleetCampaignStats(d.fleetRetry);
      return;
    }
    if (b.id === 'btn-fleet-back') {
      e.preventDefault();
      navigateSection('dashboard');
      return;
    }
    if (b.id === 'btn-cmd-compact') {
      cmdDeckState.compact = !cmdDeckState.compact;
      try {
        window.localStorage?.setItem(CMD_DECK_COMPACT_KEY, cmdDeckState.compact ? '1' : '0');
      } catch {}
      renderExecutiveCommandDeck();
      return;
    }
    if (b.id === 'btn-cmd-refresh') {
      await Promise.all([
        refreshTelemetryOverview(false),
        loadViciBridgeStatus(),
        cmdDeckState.fleetCampaignId ? loadFleetCampaignStats(cmdDeckState.fleetCampaignId) : Promise.resolve(),
      ]);
      return;
    }
    if (d.cmdCopyDemo) {
      const link = d.cmdCopyDemo;
      try {
        await navigator.clipboard.writeText(link);
        const orig = b.textContent;
        b.textContent = '✓ Copied!';
        setTimeout(() => {
          b.textContent = orig;
        }, 2000);
      } catch {
        window.prompt('Copy this external HTTPS link for your client:', link);
      }
      return;
    }
    if (b.id === 'btn-cmd-start-tunnel') {
      cmdDeckState.tunnelStarting = true;
      renderExecutiveCommandDeck();
      try {
        const res = await fetch('/api/demo-tunnel/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
        });
        const out = await res.json();
        const pubUrl = out.publicUrl || out.url;
        if (!res.ok || !out.ok || !pubUrl) {
          throw new Error(out.error || 'Could not start Cloudflare Quick-Tunnel.');
        }
        syncPublicDemoButton(pubUrl);
        try {
          await navigator.clipboard.writeText(`${pubUrl}/login`);
        } catch {}
        await refreshTelemetryOverview(true);
      } catch (err) {
        alert(`Public Demo Tunnel Error: ${err.message}`);
      } finally {
        cmdDeckState.tunnelStarting = false;
        renderExecutiveCommandDeck();
      }
      return;
    }

    if (b.hasAttribute('data-dismiss-save-report')) {
      document.getElementById('vr').innerHTML = '';
      return;
    }
    if (b.id === 'sv') {
      await commitSave();
      return;
    }

    if (b.id === 'dc') {
      clearLocalDraft();
      await loadFromServer();
      document.getElementById('vr').innerHTML = '';
      return;
    }

    if (b.id === 'btn-theme') {
      if (e.shiftKey) {
        const idx = APPEARANCE_THEMES.findIndex((t) => t.id === appearance.theme);
        appearance.theme = APPEARANCE_THEMES[(idx + 1) % APPEARANCE_THEMES.length].id;
        applyAppearance(true);
        if (tab === 'agents') render();
        return;
      }
      renderThemeStudioControls();
      document.getElementById('theme-modal').hidden = false;
      return;
    }
    if (b.id === 'theme-close') {
      document.getElementById('theme-modal').hidden = true;
      return;
    }
    if (b.id === 'btn-theme-preview-loader') {
      const previewEl = document.getElementById('theme-loader-preview');
      const statusEl = document.getElementById('theme-loader-status');
      const subEl = document.getElementById('theme-loader-sub');
      const meta = THEME_BY_ID(appearance.theme);
      if (previewEl) {
        const willShow = previewEl.hidden;
        previewEl.hidden = !willShow;
        b.textContent = willShow ? '✕ Hide Loader' : '⚡ Preview Loader';
        if (willShow && statusEl && subEl) {
          statusEl.textContent = `CONNECTING TO MODEL · ${meta.name.toUpperCase()}…`;
          subEl.textContent = `${meta.system || 'MMA DIGITAL LABS'} · ${meta.motif || 'Acoustic Pipeline'} · 16kHz / 8kHz Dual-Stream`;
        }
      }
      return;
    }
    if (b.id === 'btn-theme-download-kit') {
      const meta = THEME_BY_ID(appearance.theme);
      const kit = {
        brand: 'MMA Digital Labs | Voice Agent Console',
        exportedAt: new Date().toISOString(),
        activeIdentity: meta,
        logo: brandLogoApi() ? brandLogoApi().assetFor(meta.id) : null,
        appearance,
        allThemes: APPEARANCE_THEMES,
      };
      const blob = new Blob([JSON.stringify(kit, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const aTag = document.createElement('a');
      aTag.href = url;
      aTag.download = `mma-theme-kit-${meta.id}.json`;
      aTag.click();
      URL.revokeObjectURL(url);
      return;
    }
    if (d.pickTheme) {
      appearance.theme = d.pickTheme;
      applyAppearance(true);
      renderSideNav();
      if (tab === 'agents') render();
      return;
    }
    if (b.id === 'btn-manual-barge') {
      if (sim.active) {
        flushSimulatorSpeakerQueue();
        sim.bargeInSuppressAudio = true;
        sim.events.push({ kind: 'msg', role: 'system', content: 'Browser playback stopped. Speak or send text to start a new turn.' });
        renderSimFeedDom();
      }
      return;
    }

    if (b.id === 'btn-trigger-intro') {
      if (sim.active) {
        injectCallerUtterance('Hi! Who are you? Please introduce yourself and tell me what you can help me with!');
      }
      return;
    }

    if (b.id === 'btn-ss-probe' || b.id === 'btn-ss-test' || b.id === 'btn-ss-activate') {
      const urlInp = document.getElementById('ss-url-input');
      const keyInp = document.getElementById('ss-key-input');
      const voiceSel = document.getElementById('ss-voice-select');
      const urlVal = urlInp ? urlInp.value.trim() : '';
      const keyVal = keyInp ? keyInp.value.trim() : '';
      const voiceVal = voiceSel ? voiceSel.value : 'af_heart';
      if (urlVal) localSpeechUi.urlDraft = urlVal;
      if (voiceVal) localSpeechUi.voiceDraft = voiceVal;
      localSpeechUi.busy = true;
      localSpeechUi.audioDataUrl = '';
      localSpeechUi.statusTone = '';
      localSpeechUi.statusText = '⏳ Contacting Local Speech Service…';
      render();
      try {
        if (serverlessCloudMode) {
          const targetUrl = String(urlVal || readCloudSecrets().SPEECH_SERVICE_URL || '').replace(/\/+$/, '');
          const activeKey = keyVal || readCloudSecrets().SPEECH_SERVICE_API_KEY || '';
          if (urlVal || keyVal) {
            const secPatch = {};
            if (urlVal) secPatch.SPEECH_SERVICE_URL = urlVal;
            if (keyVal) secPatch.SPEECH_SERVICE_API_KEY = keyVal;
            writeCloudSecrets(secPatch);
            secretsStatus = buildCloudSecretsStatus();
          }
          if (b.id === 'btn-ss-probe') {
            if (!targetUrl) {
              localSpeechUi.statusTone = 'wn';
              localSpeechUi.statusText = 'No Speech Service URL configured. No service readiness check was performed.';
            } else {
              const t0 = Date.now();
              const r = await fetch(`${targetUrl}/readyz`);
              const rj = await r.json();
              localSpeechUi.statusTone = r.ok ? 'ok' : 'er';
              localSpeechUi.statusText = r.ok
                ? `✓ Ready at ${targetUrl} (${Date.now() - t0}ms) · STT: ${rj.stt} · TTS: ${rj.tts}`
                : `✗ ${targetUrl} returned HTTP ${r.status}`;
            }
          } else if (b.id === 'btn-ss-test') {
            if (targetUrl) {
              const hdrs = { 'Content-Type': 'application/json' };
              if (activeKey) hdrs.Authorization = `Bearer ${activeKey}`;
              const t0 = Date.now();
              const r = await fetch(`${targetUrl}/v1/audio/speech`, {
                method: 'POST',
                headers: hdrs,
                body: JSON.stringify({ model: 'kokoro', input: 'Local Speech Service verified and ready.', voice: voiceVal, response_format: 'wav' }),
              });
              if (!r.ok) throw new Error(`HTTP ${r.status} from ${targetUrl}/v1/audio/speech`);
              const blob = await r.blob();
              localSpeechUi.audioDataUrl = URL.createObjectURL(blob);
              localSpeechUi.statusTone = 'ok';
              localSpeechUi.statusText = `✓ Remote Speech Service TTS Verified (${targetUrl}, voice=${voiceVal}) in ${Date.now() - t0}ms!`;
            } else {
              localSpeechUi.statusTone = 'wn';
              localSpeechUi.statusText = 'No Speech Service URL configured. No TTS or STT test was performed.';
            }
          } else {
            upgradeRealtimeAgentFeatures(S);
            const sLoc = S.providers.find((p) => p.kind === 'stt' && p.type === 'speech_service');
            const tLoc = S.providers.find((p) => p.kind === 'tts' && p.type === 'speech_service');
            if (sLoc && tLoc) {
              S.services.stt = { providerId: sLoc.id, model: 'large-v3-turbo' };
              S.services.tts = { providerId: tLoc.id, model: voiceVal || 'af_heart' };
              if (!S.services.llm?.providerId) S.services.llm = { providerId: 'l1', model: 'gpt-4o-mini' };
            }
            S.updatedAt = new Date().toISOString();
            try { window.localStorage?.setItem(CLOUD_STATE_KEY, JSON.stringify(S)); } catch {}
            snap = comparableSnapshot(S);
            localSpeechUi.statusTone = 'ok';
            localSpeechUi.statusText =
              `Saved local STT=${S.services.stt.model} and TTS=${S.services.tts.model}. Connectivity was not verified; Live Bot does not support local LLM conversations.`;
            updateHeaderStatus();
          }
        } else if (b.id === 'btn-ss-probe') {
          const qs = urlVal ? `?url=${encodeURIComponent(urlVal)}` : '';
          const r = await fetch(`/api/speech-service/status${qs}`);
          const j = await r.json();
          const dg = j.diagnostic || {};
          if (j.ok) {
            localSpeechUi.statusTone = 'ok';
            localSpeechUi.statusText =
              `✓ Ready at ${dg.baseUrl} (${dg.latencyMs}ms) · STT: ${dg.ready?.stt} · TTS: ${dg.ready?.tts} · Stock voices: ${(dg.stockVoices || []).length} · Cloned voices: ${(dg.clonedVoices || []).length}`;
          } else {
            localSpeechUi.statusTone = 'er';
            localSpeechUi.statusText = `✗ ${dg.error || j.error || 'Speech Service unreachable'}`;
          }
        } else if (b.id === 'btn-ss-test') {
          const r = await fetch('/api/speech-service/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ...(urlVal ? { url: urlVal } : {}),
              ...(keyVal ? { apiKey: keyVal } : {}),
              voice: voiceVal,
            }),
          });
          const j = await r.json();
          if (j.ok) {
            localSpeechUi.statusTone = 'ok';
            localSpeechUi.statusText =
              `✓ Round-Trip Verified (${j.baseUrl})\n` +
              `• TTS (${j.ttsEngine}, voice=${j.voice}): ${j.ttsBytes} bytes WAV in ${j.ttsMs}ms\n` +
              `• STT (${j.sttEngine}): "${j.sttText}" in ${j.sttMs}ms`;
            if (j.audioBase64) {
              localSpeechUi.audioDataUrl = `data:audio/wav;base64,${j.audioBase64}`;
            }
          } else {
            localSpeechUi.statusTone = 'er';
            localSpeechUi.statusText = `✗ ${j.error || 'Round-trip test failed'}`;
          }
        } else {
          const r = await fetch('/api/speech-service/activate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ...(urlVal ? { url: urlVal } : {}),
              ...(keyVal ? { apiKey: keyVal } : {}),
              voice: voiceVal,
            }),
          });
          const j = await r.json();
          if (j.ok && j.state) {
            S = j.state;
            snap = comparableSnapshot(S);
            if (j.secrets) secretsStatus = j.secrets;
            if (j.telemetry) cmdDeckState.serverTelemetry = j.telemetry;
            if (Array.isArray(j.revisions) && j.revisions[0]) latestRevisionId = j.revisions[0].id;
            localSpeechUi.statusTone = 'ok';
            localSpeechUi.statusText =
              `✓ Saved local STT=${S.services.stt.model} and TTS=${S.services.tts.model} (${j.diagnostic?.baseUrl}). Live Bot does not support local LLM conversations.`;
            updateHeaderStatus();
          } else {
            localSpeechUi.statusTone = 'er';
            localSpeechUi.statusText = `✗ ${j.error || 'Activation failed'}`;
          }
        }
      } catch (err) {
        localSpeechUi.statusTone = 'er';
        localSpeechUi.statusText = `✗ ${err.message || 'Network error'}`;
      } finally {
        localSpeechUi.busy = false;
        render();
      }
      return;
    }

    if (b.id === 'btn-keys') {
      openKeysModal();
      return;
    }
    if (b.id === 'keys-close') {
      document.getElementById('keys-modal').hidden = true;
      return;
    }
    if (b.id === 'keys-save') {
      await saveKeysModal();
      return;
    }
    if (b.id === 'keys-test') {
      await testDeepgramModalOrBanner(true);
      return;
    }
    if (b.id === 'keys-clear') {
      await clearAllSavedKeys();
      return;
    }
    if (b.id === 'btn-sim-diag') {
      await testDeepgramModalOrBanner(false);
      return;
    }
    if (b.id === 'btn-dismiss-err') {
      sim.lastError = null;
      if (tab === 'test') render();
      return;
    }
    if (b.id === 'btn-dismiss-diag') {
      sim.diagResult = null;
      if (tab === 'test') render();
      return;
    }

    // Step 2 Simulator buttons
    if (b.id === 'btn-refresh-mics') {
      try {
        // Quick permission probe so Chrome reveals hardware microphone labels
        const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
        tmp.getTracks().forEach((tr) => tr.stop());
      } catch {}
      await refreshMicDevices();
      return;
    }
    if (b.id === 'btn-call-mic') {
      await startLiveCall(true);
      return;
    }
    if (b.id === 'btn-call-nomic') {
      await startLiveCall(false);
      return;
    }
    if (b.id === 'btn-call-hangup') {
      hangupLiveCall();
      return;
    }
    if (b.id === 'btn-sim-mute') {
      sim.muted = !sim.muted;
      sim.micStream?.getAudioTracks().forEach((track) => { track.enabled = !sim.muted; });
      b.textContent = sim.muted ? '🔇 Mic Muted (Click to Unmute)' : '🎙️ Mic Live (Click to Mute)';
      return;
    }
    if (b.id === 'btn-sim-inject') {
      const inp = document.getElementById('sim-inject-input');
      if (inp && inp.value.trim()) {
        injectCallerUtterance(inp.value);
        inp.value = '';
      }
      return;
    }
    if (d.inject) {
      const clean = d.inject.replace(/^Lead (?:says|asks)\s*"|"\s*$/gi, '').trim();
      injectCallerUtterance(clean);
      return;
    }
    if (b.id === 'btn-refresh-logs') {
      await loadCallLogsForCurrentAgent();
      return;
    }
    if (b.id === 'btn-discard-recording-fallback') {
      if (sim.recordingFallback && window.confirm('Discard this temporary audio? Download it first if you want to keep it.')) {
        URL.revokeObjectURL(sim.recordingFallback.url);
        sim.recordingFallback = null;
        sim.recordingError = '';
        if (tab === 'test') render();
      }
      return;
    }
    if (d.simHistoryToggle) {
      sim.historyExpanded = !sim.historyExpanded;
      const box = document.getElementById('sim-logs-box');
      if (box) box.innerHTML = renderCallLogsList();
      return;
    }
    if (d.simAudioLoad) {
      const id = d.simAudioLoad;
      const agentId = A().id;
      const version = sim.recordingLoadVersions.get(id) || 0;
      b.disabled = true;
      try {
        let blob;
        if (serverlessCloudMode) blob = await getLocalRecording(id);
        else {
          const res = await fetch(`/api/simulator/recordings/${encodeURIComponent(id)}`);
          if (!res.ok) throw new Error(`Recording unavailable (HTTP ${res.status})`);
          blob = await res.blob();
        }
        if (!blob?.size) throw new Error('Recording is missing or empty.');
        if (A().id !== agentId || (sim.recordingLoadVersions.get(id) || 0) !== version ||
            !sim.callLogs.some((log) => log.id === id && log.recordingStatus === 'available')) {
          if (b.isConnected) b.disabled = false;
          return;
        }
        revokeRecordingUrl(id);
        sim.recordingUrls.set(id, URL.createObjectURL(blob));
        const box = document.getElementById('sim-logs-box');
        if (box) box.innerHTML = renderCallLogsList();
      } catch (err) {
        alert(`Could not load audio: ${err.message || err}`);
        b.disabled = false;
      }
      return;
    }
    if (d.simAudioDelete) {
      const id = d.simAudioDelete;
      if (!window.confirm('Delete this audio recording? The transcript will remain.')) return;
      try {
        if (serverlessCloudMode) await deleteLocalRecording(id);
        else {
          const res = await fetch(`/api/simulator/recordings/${encodeURIComponent(id)}`, { method: 'DELETE' });
          if (!res.ok) {
            let detail = '';
            try { detail = (await res.json()).error || ''; } catch {}
            throw new Error(detail || `HTTP ${res.status}`);
          }
        }
        revokeRecordingUrl(id);
        await loadCallLogsForCurrentAgent();
      } catch (err) { alert(`Could not delete audio: ${err.message || err}`); }
      return;
    }
    if (b.id === 'btn-clear-logs') {
      const agentId = A().id;
      const visibleIds = sim.callLogs.map((log) => log.id);
      if (!window.confirm('Delete this agent’s test history and all its associated recordings?')) return;
      try {
        if (serverlessCloudMode) {
          await clearLocalRecordedTests(agentId);
          try {
            const old = JSON.parse(window.localStorage?.getItem('vac_cloud_sim_logs_v1') || '[]');
            if (Array.isArray(old)) window.localStorage?.setItem('vac_cloud_sim_logs_v1', JSON.stringify(old.filter((entry) => entry.agentId !== agentId)));
          } catch (err) { throw new Error(`Local recordings may already be deleted, but legacy history could not be cleared: ${err.message || err}`); }
        } else {
          const res = await fetch(`/api/simulator/logs?agentId=${encodeURIComponent(agentId)}`, { method: 'DELETE' });
          if (!res.ok) {
            let detail = '';
            try { detail = (await res.json()).error || ''; } catch {}
            throw new Error(detail || `HTTP ${res.status}`);
          }
        }
        for (const id of visibleIds) revokeRecordingUrl(id);
        if (A().id === agentId) {
          sim.callLogs = [];
          await loadCallLogsForCurrentAgent();
        }
      } catch (err) {
        for (const id of visibleIds) revokeRecordingUrl(id);
        if (A().id === agentId) await loadCallLogsForCurrentAgent();
        alert(`Could not fully clear test history: ${err.message || err}`);
      }
      return;
    }

    // Step 3 + Step 4 VICIdial Bridge, Auth, Webhook & Supervisor buttons
    if (b.id === 'btn-auth-login') {
      const inp = document.getElementById('auth-pass-input');
      const errEl = document.getElementById('auth-err-msg');
      errEl.textContent = '';
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: inp?.value || '' }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        errEl.textContent = data.error || 'Invalid password';
        return;
      }
      if (inp) inp.value = '';
      document.getElementById('auth-modal').hidden = true;
      await loadFromServer();
      return;
    }
    if (b.id === 'btn-share-demo') {
      const demoUrl = b.dataset.demoUrl || window.location.origin;
      const lbl = b.querySelector('span:last-child') || b;
      try {
        await navigator.clipboard.writeText(demoUrl);
        const orig = lbl.textContent;
        lbl.textContent = '✓ Link Copied';
        setTimeout(() => {
          lbl.textContent = orig;
        }, 2200);
      } catch {
        window.prompt('Copy this public HTTPS link for your client:', demoUrl);
      }
      return;
    }
    if (b.id === 'btn-account-security') {
      const pop = document.getElementById('account-popover');
      if (pop) pop.hidden = true;
      document.getElementById('btn-account-menu')?.setAttribute('aria-expanded', 'false');
      openAccountSecurity();
      return;
    }
    if (b.id === 'account-security-close' || b.id === 'account-security-close-x') {
      closeAccountSecurity();
      return;
    }
    if (b.id === 'btn-change-password') {
      await submitPasswordChange();
      return;
    }
    if (b.id === 'btn-revoke-sessions') {
      await revokeOtherSessions();
      return;
    }
    if (b.id === 'btn-logout') {
      if (!serverlessCloudMode) {
        await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
      }
      try { window.localStorage?.removeItem(VAC_CLOUD_SESSION_KEY); } catch {}
      window.location.replace(serverlessCloudMode ? './login.html' : '/login');
      return;
    }
    if (b.id === 'btn-wb-refresh') {
      await loadViciBridgeStatus();
      return;
    }
    if (d.supXfer) {
      await fetch(`/api/vici/calls/${encodeURIComponent(d.supXfer)}/transfer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Supervisor forced closer transfer from Wallboard' }),
      });
      await loadViciBridgeStatus();
      return;
    }
    if (d.supHangup) {
      await fetch(`/api/vici/calls/${encodeURIComponent(d.supHangup)}/hangup`, { method: 'POST' });
      await loadViciBridgeStatus();
      return;
    }
    if (d.testWh !== undefined) {
      const idx = Number(d.testWh);
      const fn = S.functions[idx];
      if (!fn) return;
      b.disabled = true;
      b.textContent = '⏳ Testing…';
      try {
        const res = await fetch('/api/functions/test-webhook', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fn, args: { sample_check: true, zip: '33101' } }),
        });
        const out = await res.json();
        viciMon.webhookTests[fn.id] = {
          ok: Boolean(out.ok),
          summary: out.ok
            ? `✓ HTTP ${out.httpStatus || 200} (${out.latencyMs}ms) -> ${JSON.stringify(out.data).slice(0, 260)}`
            : `✗ ${out.error || 'Failed'} (${out.latencyMs || 0}ms)`,
        };
      } catch (err) {
        viciMon.webhookTests[fn.id] = { ok: false, summary: `✗ ${err.message}` };
      } finally {
        render();
      }
      return;
    }

    if (b.id === 'btn-vici-sim') {
      await runViciLoopbackSim();
      return;
    }
    if (b.id === 'btn-vici-verify') {
      await runViciConnectivityCheck();
      return;
    }
    if (b.id === 'btn-clear-vici-logs') {
      if (serverlessCloudMode) {
        try { window.localStorage?.removeItem('vac_cloud_vici_logs_v1'); } catch {}
      } else {
        await fetch('/api/vici/logs', { method: 'DELETE' });
      }
      viciMon.logs = [];
      viciMon.analytics = null;
      await loadViciBridgeStatus();
      return;
    }

    if (b.id === 'sync-llm') {
      b.disabled = true;
      b.textContent = 'Syncing Deepgram LLMs…';
      try {
        await syncDeepgramManagedLlms(false);
        render();
      } finally {
        b.disabled = false;
      }
      return;
    }

    if (b.id === 'btn-refresh-voices') {
      await ensureVoiceCatalogLoaded(true);
      return;
    }

    if (d.vsample) {
      await playSampleAudio(d.vsample, d.vlabel || '');
      return;
    }

    if (d.vsynth) {
      await synthesizeWithApi(d.vsynth, d.vlabel || d.vsynth, d.vprov || '');
      return;
    }

    if (d.vselect) {
      // Select a Deepgram or Local Kokoro voice from the Voice Lab and persist it globally.
      const voiceId = String(d.vselect);
      const label = d.vlabel || voiceId;
      const targetProvType = d.vprov || 'deepgram';
      const ttsProv =
        S.providers.find((p) => p.kind === 'tts' && p.type === targetProvType) ||
        S.providers.find((p) => p.kind === 'tts');
      if (!ttsProv) {
        alert('No TTS provider is configured. Reload the console and try again.');
        return;
      }
      const models = String(ttsProv.models || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (!models.includes(voiceId)) {
        models.push(voiceId);
        ttsProv.models = models.join(',');
      }
      S.services = S.services || {};
      S.services.tts = { providerId: ttsProv.id, model: voiceId };
      if (targetProvType === 'speech_service') {
        const sttLocal = S.providers.find((p) => p.kind === 'stt' && p.type === 'speech_service');
        if (sttLocal) {
          S.services.stt = { providerId: sttLocal.id, model: 'large-v3-turbo' };
        }
      }
      const vs = document.getElementById('vs');
      if (vs) vs.textContent = `Saving ${label} as the active voice…`;
      await commitSave();
      const vsAfter = document.getElementById('vs');
      if (vsAfter) vsAfter.textContent = `✓ ${label} is now the saved voice for every bot.`;
      return;
    }

    if (b.id === 'btn-synth-active') {
      await synthesizeWithApi();
      return;
    }

    if (b.id === 'btn-apply-greeting') {
      const vt = document.getElementById('vt');
      if (vt) {
        A().greeting = vt.value.trim();
        updateHeaderStatus();
        const vs = document.getElementById('vs');
        if (vs) vs.textContent = '✓ Copied text into Agent Greeting (click "Save & verify" to persist).';
      }
      return;
    }

    if (b.id === 'btn-os-fallback') {
      stopAllAudio();
      const synth = window.speechSynthesis;
      const vs = document.getElementById('vs');
      if (!synth) {
        if (vs) vs.textContent = 'Browser SpeechSynthesis is not supported in this browser.';
        return;
      }
      const txt = (document.getElementById('vt')?.value || A().greeting).trim();
      const u = new SpeechSynthesisUtterance(txt);
      u.rate = Number(A().tts.speed) || 1;
      u.onstart = () => {
        if (vs) vs.textContent = '▶ Playing browser OS fallback voice…';
      };
      u.onend = () => {
        if (vs) vs.textContent = 'Browser OS voice playback finished.';
      };
      synth.speak(u);
      return;
    }

    if (b.id === 'btn-stop-audio') {
      stopAllAudio();
      return;
    }

    if (d.rm !== undefined) {
      const aid = A().id;
      S.tests[aid] = (S.tests[aid] || []).slice();
      S.tests[aid].splice(Number(d.rm), 1);
      render();
      return;
    }

    if (b.id === 'addt') {
      const aid = A().id;
      if (!Array.isArray(S.tests[aid])) S.tests[aid] = [];
      S.tests[aid].push({ id: uid('t'), s: '', e: '', r: 'p', n: '' });
      render();
      return;
    }

    if (d.add) {
      if (d.add === 'fn') {
        const fnId = uid('fn');
        const suffix = S.functions.length + 1;
        S.functions.push({
          id: fnId,
          name: `custom_function_${suffix}`,
          description: 'Describe when the agent should invoke this tool',
          params: JSON.stringify({ type: 'object', properties: {}, required: [] }, null, 2),
          defer: false,
          url: '',
          method: 'post',
          headers: '{}',
        });
      } else {
        const kind = d.add;
        const defaultType = kind === 'stt' ? 'deepgram' : kind === 'llm' ? 'open_ai' : 'deepgram';
        const defaultModel =
          kind === 'stt'
            ? 'nova-3'
            : kind === 'llm'
            ? dgLlmModelIdsForType('open_ai').join(',')
            : 'flux-kit-en';
        S.providers.push({
          id: uid(kind),
          kind,
          name: kind === 'llm' ? 'OpenAI (Deepgram Managed)' : `New ${kind.toUpperCase()} Plug-in`,
          type: defaultType,
          models: defaultModel,
          endpoint: '',
          headers: '{}',
          extra: '{}',
          mk: 'model',
        });
      }
      render();
      return;
    }

    if (d.del) {
      const [kind, idxStr] = d.del.split(':');
      const idx = Number(idxStr);
      if (kind === 'p') {
        const target = S.providers[idx];
        const remainingOfKind = S.providers.filter((p, i) => i !== idx && p.kind === target.kind);
        if (remainingOfKind.length === 0) return;
        S.providers.splice(idx, 1);
        for (const ag of S.agents) {
          if (ag[target.kind].p === target.id) {
            ag[target.kind].p = remainingOfKind[0].id;
            ag[target.kind].model = modelsForProvider(remainingOfKind[0].id)[0] || '';
          }
        }
      } else {
        const targetFn = S.functions[idx];
        S.functions.splice(idx, 1);
        if (targetFn) {
          for (const ag of S.agents) {
            ag.fnIds = ag.fnIds.filter((id) => id !== targetFn.id);
          }
        }
      }
      render();
      return;
    }

    if (b.id === 'cp') {
      try {
        await navigator.clipboard.writeText(document.getElementById('pv').textContent);
        b.textContent = '✓ Copied!';
        setTimeout(() => {
          if (b) b.textContent = '📋 Copy Export JSON';
        }, 1400);
      } catch {}
      return;
    }

    if (b.id === 'dl-json') {
      const blob = new Blob([JSON.stringify(buildExportBundle(), null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const aTag = document.createElement('a');
      aTag.href = url;
      aTag.download = `voice-agent-console-${new Date().toISOString().slice(0, 10)}.json`;
      aTag.click();
      URL.revokeObjectURL(url);
      return;
    }

    if (b.id === 'im-json') {
      document.getElementById('import-file').click();
      return;
    }

    if (b.id === 'rs') {
      if (!confirm('Reset the entire console to factory defaults?')) return;
      clearLocalDraft(true);
      if (serverlessCloudMode) {
        try { window.localStorage?.removeItem(CLOUD_STATE_KEY); } catch {}
        await loadFromServer();
        return;
      }
      const res = await fetch('/api/state/reset', { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        S = data.state;
        snap = comparableSnapshot(S);
        revisions = data.revisions || [];
        latestRevisionId = data.revisionId;
        cur = { a: S.agents[0]?.id || '', c: S.campaigns[0]?.id || '' };
        render();
      }
      return;
    }

    const entityAction = /^(new|dup|del)-(a|c)$/.exec(b.id || '');
    if (entityAction) {
      const [, act, kind] = entityAction;
      const arr = kind === 'a' ? S.agents : S.campaigns;
      const currentObj = kind === 'a' ? A() : C();
      if ((act === 'del' || act === 'dup') && !currentObj) return;

      if (act === 'del') {
        if (arr.length > 1) {
          arr.splice(arr.indexOf(currentObj), 1);
          cur[kind] = arr[0].id;
          if (kind === 'a') {
            for (const campaign of S.campaigns) assignCampaignAgent(campaign, currentObj.id, false);
            delete S.tests[currentObj.id];
            if (sim.campaignAgentId === currentObj.id) { sim.campaignId = ''; sim.campaignAgentId = ''; }
          } else if (sim.campaignId === currentObj.id) { sim.campaignId = ''; sim.campaignAgentId = ''; }
          render();
          updateHeaderStatus();
          updateLivePreview();
        }
      } else if (kind === 'a' && act === 'new') {
        // New bot: blank identity/script on a usable structure — never a copy
        // of another bot's prompt. Structure comes from the first bot (or
        // minimal defaults) so the form renders; the operator writes the script.
        const structure = arr[0] || {
          mode: 'outbound', language: 'en', acceptViciCalls: true,
          behavior: { bargeIn: 'instant', bargeInSensitivity: 'balanced', latencyProfile: 'ultra', expressionStyle: 'warm_empathetic', vocalGestures: true, allowGeneralQa: true, selfIntro: '' },
          stt: { keyterms: '', eot: 0.55, eager: 0.35, eotms: 2000, smartFormat: false },
          llm: { temp: 0.7, reasoning: 'low' },
          tts: { speed: 1, expr: 0 },
          audio: { inEnc: 'linear16', inRate: 8000, outEnc: 'linear16', outRate: 8000 },
          fnIds: [],
        };
        const clone = JSON.parse(JSON.stringify(structure));
        clone.id = uid('ag');
        clone.name = `Untitled Agent ${arr.length + 1}`;
        clone.greeting = '';
        clone.prompt = '';
        clone.randomGreetingEnabled = true;
        clone.injectCampaignDisclosure = false;
        arr.push(clone);
        cur.a = clone.id;
        S.tests[clone.id] = [];
        render();
        updateHeaderStatus();
        updateLivePreview();
        const nameInput = document.querySelector('[data-p="a.name"]');
        if (nameInput) { nameInput.focus(); nameInput.select(); }
      } else if (kind === 'a' && act === 'dup') {
        // Duplicate bot: full copy of the selected bot (prompt, behavior,
        // tuning, functions) under a new ID. Campaign assignment lives on
        // campaigns, so the copy starts unassigned — assign it in Agents.
        const clone = JSON.parse(JSON.stringify(currentObj));
        clone.id = uid('ag');
        clone.name = `${currentObj.name} (Copy)`;
        arr.push(clone);
        cur.a = clone.id;
        S.tests[clone.id] = JSON.parse(JSON.stringify(S.tests[currentObj.id] || []));
        render();
        updateHeaderStatus();
        updateLivePreview();
        const nameInput = document.querySelector('[data-p="a.name"]');
        if (nameInput) { nameInput.focus(); nameInput.select(); }
      } else if (kind === 'c' && act === 'new') {
        // New campaign: blank. Rules must be written and reviewed; routing
        // identity (VICIdial ID, bots, transfer target) starts empty.
        const clone = {
          id: uid('cp'), name: `Untitled Campaign ${arr.length + 1}`, agentId: '', agentIds: [],
          viciCampaign: '', lists: '', start: '09:00', end: '20:00', tz: 'America/New_York',
          attempts: 3, retry: 120, maxCalls: 10, xferType: 'ingroup', xferTarget: '', fallback: '',
          dnc: true, disclosure: '', dispos: '', complianceRules: MISSING_CAMPAIGN_RULES,
        };
        arr.push(clone);
        cur.c = clone.id;
        render();
        updateHeaderStatus();
        updateLivePreview();
        const nameInput = document.querySelector('[data-p="c.name"]');
        if (nameInput) { nameInput.focus(); nameInput.select(); }
      } else if (kind === 'c' && act === 'dup') {
        // Duplicate campaign: copy rules, dispositions and settings so the
        // copy is a real duplicate; clear only routing identity (VICIdial ID,
        // bot assignment, transfer target) which must be re-entered.
        const clone = JSON.parse(JSON.stringify(currentObj));
        clone.id = uid('cp');
        clone.name = `${currentObj.name} (Copy)`;
        Object.assign(clone, { agentId: '', agentIds: [], viciCampaign: '', xferTarget: '', fallback: '' });
        arr.push(clone);
        cur.c = clone.id;
        render();
        updateHeaderStatus();
        updateLivePreview();
        const nameInput = document.querySelector('[data-p="c.name"]');
        if (nameInput) { nameInput.focus(); nameInput.select(); }
      }
    }
  });

  // Backdrop click closes Theme Studio or API Keys modal smoothly
  document.addEventListener('mousedown', (e) => {
    if (e.target?.id === 'theme-modal') e.target.hidden = true;
    else if (e.target?.id === 'keys-modal') e.target.hidden = true;
  });

  // Enter key on live simulator utterance input, auth login input, and Escape for modals
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const tm = document.getElementById('theme-modal');
      const km = document.getElementById('keys-modal');
      if (tm && !tm.hidden) tm.hidden = true;
      else if (km && !km.hidden) km.hidden = true;
      return;
    }
    if (e.key === 'Enter' && e.target?.id === 'sim-inject-input') {
      e.preventDefault();
      const inp = e.target;
      if (inp.value.trim()) {
        injectCallerUtterance(inp.value);
        inp.value = '';
      }
    } else if (e.key === 'Enter' && e.target?.id === 'auth-pass-input') {
      e.preventDefault();
      document.getElementById('btn-auth-login')?.click();
    }
  });

  document.getElementById('import-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const nextState = parsed.console || parsed;
      if (serverlessCloudMode) {
        S = nextState;
        clearLocalDraft(true);
        enforceDeepgramOnlyLlms(S);
        S.updatedAt = new Date().toISOString();
        try {
          window.localStorage?.setItem(CLOUD_STATE_KEY, JSON.stringify(S));
        } catch {}
        snap = comparableSnapshot(S);
        cur = { a: S.agents[0]?.id || '', c: S.campaigns[0]?.id || '' };
        render();
        return;
      }
      const res = await fetch('/api/state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: nextState }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Import failed');
      S = data.state;
      clearLocalDraft(true);
      enforceDeepgramOnlyLlms(S);
      snap = comparableSnapshot(S);
      revisions = data.revisions || [];
      latestRevisionId = data.revisionId;
      cur = { a: S.agents[0]?.id || '', c: S.campaigns[0]?.id || '' };
      render();
    } catch (err) {
      alert(`Import error: ${err.message}`);
    } finally {
      e.target.value = '';
    }
  });

  document.addEventListener('input', (e) => {
    const t = e.target;
    if (!t.dataset?.p || t.type === 'checkbox' || t.tagName === 'SELECT') return;
    const value = t.type === 'number' ? (t.value === '' || !Number.isFinite(Number(t.value)) ? 0 : Number(t.value)) : t.value;
    setPath(t.dataset.p, value);
    updateLivePreview();
    updateHeaderStatus();
  });

  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id && t.id.startsWith('sel-')) {
      stopAllAudio();
      const kind = t.id.slice(4);
      cur[kind] = t.value;
      if (kind === 'a' && !campaignsForAgent(t.value).some((campaign) => campaign.id === sim.campaignId)) {
        sim.campaignId = ''; sim.campaignAgentId = '';
      }
      if (tab === 'voice') voiceCatalog.previewText = buildSettings(A()).agent.greeting || A().greeting;
      rememberSectionUrl(tab, { agentId: cur.a, campaignId: cur.c }, true);
      if (kind === 'a') {
        for (const log of sim.callLogs) revokeRecordingUrl(log.id);
        sim.logsLoadedForAgent = null;
        sim.callLogs = [];
        sim.logsError = null;
        sim.historyExpanded = false;
      }
      render();
      return;
    }

    if (t.dataset.agentCampaign) {
      const campaign = S.campaigns.find((entry) => entry.id === t.dataset.agentCampaign);
      if (campaign) assignCampaignAgent(campaign, A().id, t.checked);
      const count = campaignsForAgent(A().id).length;
      const summary = t.closest('details')?.querySelector('summary');
      if (summary) summary.textContent = count ? `${count} campaign${count === 1 ? '' : 's'} selected` : 'Choose campaigns for this bot…';
      updateLivePreview(); updateHeaderStatus();
      return;
    }
    // Campaign assignment is edited only in the Agents tab (data-agent-campaign).
    // The Campaigns tab shows it read-only, so there are no campaign-side
    // assignment handlers here.
    if (t.id === 'sim-campaign') {
      setSimulatorCampaign(t.value);
      render();
      return;
    }
    if (t.id === 'sim-allow-webhooks') {
      sim.allowWebhooks = t.checked;
      return;
    }
    if (t.id === 'sim-record-audio') {
      sim.recordAudio = t.checked;
      return;
    }
    if (t.id === 'sim-bw') {
      sim.bandwidth = t.value;
      return;
    }
    if (t.id === 'sim-mic-gain') {
      sim.micGain = Number(t.value) || 2.0;
      return;
    }
    if (t.id === 'sim-mic-device') {
      sim.micDeviceId = t.value;
      if ((sim.active || sim.connecting) && sim.micEnabled) {
        startMicCapture(sim.sessionAttemptId).catch((err) => {
          sim.lastError = `Mic switch error: ${err.message}`;
          renderSimulatorDomOnly();
        });
      }
      return;
    }
    if (t.id === 'vsim-transport') {
      viciMon.simTransport = t.value;
      return;
    }
    if (t.id === 'vsim-scenario') {
      viciMon.simScenario = t.value;
      return;
    }
    if (t.id === 'vsim-campaign') {
      viciMon.simCampaignId = t.value;
      render();
      return;
    }
    if (t.id === 'vsim-upstream') {
      viciMon.simUpstream = t.value;
      return;
    }

    if (t.id === 'vf-family') {
      voiceCatalog.filters.family = t.value;
      renderVoiceCatalogSection();
      return;
    }
    if (t.id === 'vf-lang') {
      voiceCatalog.filters.language = t.value;
      renderVoiceCatalogSection();
      return;
    }
    if (t.id === 'vf-accent') {
      voiceCatalog.filters.accent = t.value;
      renderVoiceCatalogSection();
      return;
    }
    if (t.id === 'vf-gender') {
      voiceCatalog.filters.gender = t.value;
      renderVoiceCatalogSection();
      return;
    }

    if (t.tagName === 'SELECT' && t.dataset.p) {
      const numericSelectPaths = new Set(['a.tts.expr', 'a.audio.inRate', 'a.audio.outRate']);
      const val = numericSelectPaths.has(t.dataset.p) ? Number(t.value) : t.value;
      setPath(t.dataset.p, val);

      const globalProviderMatch = /^services\.(stt|llm|tts)\.providerId$/.exec(t.dataset.p);
      if (globalProviderMatch) {
        S.services[globalProviderMatch[1]].model = '';
      }
      const provTypeMatch = /^p\.(\d+)\.type$/.exec(t.dataset.p);
      if (provTypeMatch) {
        const pObj = S.providers[Number(provTypeMatch[1])];
        if (pObj && pObj.kind === 'llm') {
          pObj.models = dgLlmModelIdsForType(pObj.type).join(',');
          pObj.endpoint = '';
          pObj.headers = '{}';
          pObj.extra = '{}';
          enforceDeepgramOnlyLlms(S);
        }
      }
      render();
      return;
    }

    if (t.tagName === 'SELECT' && t.dataset.ti !== undefined) {
      const aid = A().id;
      if (!Array.isArray(S.tests[aid])) S.tests[aid] = [];
      S.tests[aid][Number(t.dataset.ti)][t.dataset.tk] = t.value;
      updateHeaderStatus();
      updateTestSummary();
    }
  });

  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.tagName === 'SELECT') return;

    if (t.dataset.simlead) {
      sim.lead[t.dataset.simlead] = t.value;
      return;
    }

    if (t.id === 'greeting-search') {
      greetingCatalog.query = t.value;
      greetingCatalog.page = 0;
      const results = document.getElementById('greeting-results');
      if (results) results.innerHTML = renderGreetingResults();
      return;
    }

    if (t.id === 'vf-q') {
      voiceCatalog.filters.q = t.value;
      renderVoiceCatalogSection();
      return;
    }

    if (t.id === 'vt') {
      voiceCatalog.previewText = t.value;
      return;
    }

    if (t.dataset.fnid) {
      const list = A().fnIds;
      const idx = list.indexOf(t.dataset.fnid);
      if (t.checked && idx < 0) list.push(t.dataset.fnid);
      if (!t.checked && idx >= 0) list.splice(idx, 1);
      updateLivePreview();
      updateHeaderStatus();
      return;
    }

    if (t.dataset.p && (t.type === 'checkbox' || t.tagName === 'SELECT')) {
      let nextVal;
      if (t.type === 'checkbox') {
        nextVal = t.checked;
      } else if (t.type === 'number') {
        const parsed = Number(t.value);
        nextVal = t.value === '' || Number.isNaN(parsed) ? 0 : parsed;
      } else {
        nextVal = t.value;
      }
      setPath(t.dataset.p, nextVal);

      if (t.dataset.p === 'a.name') {
        const opt = document.querySelector(`#sel-a option[value="${CSS.escape(A().id)}"]`);
        if (opt) opt.textContent = t.value;
      } else if (t.dataset.p === 'c.name') {
        const opt = document.querySelector(`#sel-c option[value="${CSS.escape(C().id)}"]`);
        if (opt) opt.textContent = t.value;
      }

      updateLivePreview();
      updateHeaderStatus();
      return;
    }

    if (t.dataset.ti !== undefined) {
      const aid = A().id;
      if (!Array.isArray(S.tests[aid])) S.tests[aid] = [];
      S.tests[aid][Number(t.dataset.ti)][t.dataset.tk] = t.value;
      updateTestSummary();
      updateHeaderStatus();
    }
  });

  loadFromServer();
  setInterval(() => {
    if (!document.hidden && S && !serverlessCloudMode) {
      refreshTelemetryOverview(true);
    }
  }, 15000);
})();
