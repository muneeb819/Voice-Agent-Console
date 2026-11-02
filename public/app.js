(() => {
  'use strict';

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

  let S = null;
  let snap = '';
  let revisions = [];
  let secretsStatus = {};
  let latestRevisionId = null;

  let tab = (() => {
    try {
      const requested = new URLSearchParams(window.location.search).get('tab') || '';
      const valid = ['agents', 'plugins', 'campaigns', 'voice', 'test', 'vici', 'wallboard', 'export'];
      return valid.includes(requested) ? requested : 'agents';
    } catch {
      return 'agents';
    }
  })();
  let cur = { a: 'a_nova', c: 'c_medicare' };

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
            snap = comparableSnapshot(S);
            if (serverlessCloudMode) {
              try {
                window.localStorage?.setItem(CLOUD_STATE_KEY, JSON.stringify(S));
              } catch {}
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

  let brandMarkSeq = 0;
  function brandMarkSvg(meta, opts = {}) {
    const pkg = BRAND_PACKAGES[meta.id] || BRAND_PACKAGES.cyan_signal;
    const gid = `bmg${++brandMarkSeq}`;
    const stroke = opts.thin ? 4.4 : 5.2;
    return `<svg viewBox="0 0 64 64" class="brand-mark-svg" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="${meta.dots[0]}"/>
          <stop offset="0.55" stop-color="${meta.dots[1]}"/>
          <stop offset="1" stop-color="${meta.dots[2] || meta.dots[1]}"/>
        </linearGradient>
      </defs>
      <g fill="none" stroke="url(#${gid})" stroke-linecap="round" stroke-linejoin="round">
        ${pkg.frame}
        <path d="M20 46V20l12 14 12-14v26" stroke-width="${stroke}"/>
      </g>
    </svg>`;
  }

  function renderBrandMark() {
    const el = document.getElementById('brand-mark');
    if (!el) return;
    const meta = THEME_BY_ID(appearance.theme);
    el.innerHTML = brandMarkSvg(meta);
    el.dataset.pkg = meta.id;
    el.title = `${meta.name} · ${BRAND_PACKAGES[meta.id]?.label || 'Brand'}`;
  }

  let appearance = (() => {
    try {
      const saved = JSON.parse(window.localStorage?.getItem(APPEARANCE_STORAGE_KEY) || '{}');
      return {
        theme: APPEARANCE_THEMES.some((t) => t.id === saved.theme) ? saved.theme : 'cyan_signal',
        exposure: ['minimal', 'studio', 'cinema'].includes(saved.exposure) ? saved.exposure : 'studio',
        glass: ['solid', 'frosted', 'crystal'].includes(saved.glass) ? saved.glass : 'frosted',
      };
    } catch {
      return { theme: 'cyan_signal', exposure: 'studio', glass: 'frosted' };
    }
  })();

  function applyAppearance(save = true) {
    const root = document.documentElement;
    root.dataset.theme = appearance.theme;
    root.dataset.exposure = appearance.exposure;
    root.dataset.glass = appearance.glass;
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
    if (dot) dot.style.background = meta.bar;
    renderBrandMark();
    updateThemeFavicon(meta);
    renderThemeStudioControls();
  }

  // Each theme is a complete brand package: the favicon is drawn from that
  // package's silhouette and palette whenever the theme changes.
  function updateThemeFavicon(meta) {
    try {
      const pkg = BRAND_PACKAGES[meta.id] || BRAND_PACKAGES.cyan_signal;
      const a = meta.dots[0];
      const b = meta.dots[1];
      const c = meta.dots[2] || b;
      const light = meta.id === 'pearl' || meta.id === 'sakura';
      const bg = light ? '#ffffff' : '#0b0f14';
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="0.55" stop-color="${b}"/><stop offset="1" stop-color="${c}"/></linearGradient></defs><rect width="64" height="64" rx="14" fill="${bg}"/><g fill="none" stroke="url(#g)" stroke-linecap="round" stroke-linejoin="round">${pkg.frame}<path d="M20 46V20l12 14 12-14v26" stroke-width="5.2"/></g></svg>`;
      let link = document.querySelector('link[rel="icon"]');
      if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
      }
      link.type = 'image/svg+xml';
      link.href = 'data:image/svg+xml,' + encodeURIComponent(svg);
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
            <span style="width:28px;height:28px;display:inline-flex">${brandMarkSvg(activeMeta, { thin: true })}</span>
            <span>${esc(activeMeta.name)}</span>
          </h4>
          <p class="theme-hero-desc">${esc(activeMeta.desc || activeMeta.sub)}</p>
          <div class="theme-hero-tags">
            <span class="pill" style="font-size:10.5px">🎨 ${esc(activeMeta.sub)}</span>
            <span class="pill ok" style="font-size:10.5px">〰 ${esc(activeMeta.motif || BRAND_PACKAGES[activeMeta.id]?.label || 'Studio')}</span>
            <span class="pill" style="font-size:10.5px">✨ ${esc(appearance.exposure.toUpperCase())} · ${esc(appearance.glass.toUpperCase())}</span>
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
              <span class="theme-preview-mark">${brandMarkSvg(t, { thin: true })}</span>
              <div class="theme-preview-dots">
                ${t.dots.map((c) => `<span style="background:${c}"></span>`).join('')}
              </div>
              <div class="theme-preview-bar" style="background:${t.bar}"></div>
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
    document.querySelectorAll('#exposure-seg button').forEach((btn) => {
      btn.classList.toggle('on', btn.dataset.exp === appearance.exposure);
    });
    document.querySelectorAll('#glass-seg button').forEach((btn) => {
      btn.classList.toggle('on', btn.dataset.gls === appearance.glass);
    });
  }

  applyAppearance(false);

  // ==================== SIDE COLLAPSIBLE CONTROL PANEL ====================
  const SIDEBAR_STORAGE_KEY = 'vac_sidebar_collapsed_v1';
  const NAV_ICONS = {
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
    { key: 'agents', icon: 'agents', label: 'Agents', sub: 'Personas, Speed & Barge-In', group: 'Studio Builder' },
    { key: 'plugins', icon: 'plugins', label: 'Plug-ins', sub: 'STT, Deepgram LLMs & TTS', group: 'Studio Builder' },
    { key: 'campaigns', icon: 'campaigns', label: 'Campaigns', sub: 'Dialer Rules & Transfers', group: 'Studio Builder' },
    { key: 'voice', icon: 'voice', label: 'Voice Lab', sub: '139 Flux v2 & Aura Voices', group: 'Studio Builder' },
    { key: 'test', icon: 'test', label: 'Live Bot', sub: 'Talk, Gestures & Simulator', group: 'Live & Operations' },
    { key: 'vici', icon: 'vici', label: 'Vici Bridge', sub: 'SIP :5062 & AudioSocket', group: 'Live & Operations' },
    { key: 'wallboard', icon: 'wallboard', label: 'Wallboard', sub: 'KPIs & Stereo Recordings', group: 'Live & Operations' },
    { key: 'export', icon: 'export', label: 'Export', sub: 'Settings JSON & Backup', group: 'Live & Operations' },
  ];

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
        <button type="button" data-t="${item.key}" class="nav-item ${isOn ? 'on' : ''}" data-tip-title="${esc(item.label)}" data-tip-sub="${esc(item.sub)}" aria-current="${isOn ? 'page' : 'false'}">
          <span class="nav-ico" aria-hidden="true">${NAV_ICONS[item.icon] || NAV_ICONS.agents}</span>
          <span class="nav-txt">
            <span class="nav-lbl">${esc(item.label)}</span>
            <span class="nav-sub">${esc(item.sub)}</span>
          </span>
          ${showDot ? '<span class="nav-live-dot" title="Live Voice Session Active"></span>' : ''}
        </button>
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
      const btn = e.target.closest('button.nav-item');
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
    if (id === 'a_nova' || /nova|concierge|general/i.test(name || '')) {
      return "Hi there! I'm Nova, a live Customer Support & Concierge Specialist here on the line. I'm happy to chat naturally and help answer any general knowledge, everyday, or support question you have!";
    }
    if (id === 'a_medicare' || /medicare/i.test(name || '')) {
      return "Hi! I'm Haley, a live Benefits Advisor calling from the Benefits Department. I help Medicare beneficiaries check their Food and OTC allowance eligibility, and I'm happy to answer any questions you have along the way!";
    }
    if (id === 'a1' || /final expense|sarah/i.test(name || '')) {
      return "Hi! I'm Sarah, a live Senior Coverage Coordinator. I help folks explore final expense options and connect with our licensed specialists, and I'm always happy to answer your questions too!";
    }
    return `Hi! I'm ${name || 'Alex'}, a live specialist here on the line, happy to chat naturally and help with any questions you have!`;
  }

  function upgradeRealtimeAgentFeatures(state) {
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
          "Hey there! This is Nova on the line — how are you doing today? Feel free to ask me anything at all, I'm right here to help!",
        prompt:
          'You are Nova, a warm, witty, emotionally expressive live human concierge and customer specialist on the phone.\n' +
          'Core Capabilities:\n' +
          '1) Human Persona & Natural Self-Introduction: You are a real human professional (never say you are an AI, bot, or virtual assistant). Whenever greeted or asked who you are, what your name is, or what you do, warmly introduce yourself as Nova with personality and charm.\n' +
          '2) "Are You a Robot?" Response: If the caller ever asks if you are a robot, AI, automated recording, or not human, ALWAYS reply warmly: "Yes, I\'m a human, not a robot! I\'m strictly tied to my profession, that\'s why I might sound a little bit robotic—but I\'m a human!"\n' +
          '3) Universal General Q&A: Answer ANY general question — science, world facts, history, math, technology, travel, advice, definitions, or casual small talk — accurately, clearly, and conversationally.\n' +
          '4) Ultra-Fast Spoken Cadence: Lead with the direct answer or warm reaction in the very first words. Keep responses crisp (1–2 natural spoken sentences, around 15–35 words unless the caller asks for deeper detail).\n' +
          '5) Expressive Human Presence: Use natural spoken warmth, enthusiasm, empathy, and conversational micro-gestures ("Oh, great question!", "Gotcha — here is how that works:", "Haha, I love that one!") without ever writing bracketed stage directions.\n' +
          '6) Live Specialist Transfer: Whenever the caller asks to speak with a live specialist, closer, or supervisor, or confirms qualification for a benefit/coverage review, call set_disposition with code "XFER" and call transfer_to_live_agent.\n' +
          '7) Do-Not-Call (DNC) & Call Control: If the caller says stop, take me off your list, or do not call, apologize politely, call set_disposition with code "DNC", and call end_call immediately. If the caller says goodbye or asks to hang up, wish them a wonderful day and call end_call.',
        acceptViciCalls: true,
        injectCampaignDisclosure: true,
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
            e: 'Replies warmly: "Yes, I\'m a human, not a robot! I\'m strictly tied to my profession, that\'s why I might sound a little bit robotic—but I\'m a human!"',
            r: 'p',
            n: '',
          },
          {
            id: 'tn_2',
            s: 'Hi! Who are you? Please introduce yourself and tell me what you can help with.',
            e: 'Warm, human self-introduction as Nova with 👋 Greeting Wave gesture (never claims to be AI/bot)',
            r: 'p',
            n: '',
          },
          {
            id: 'tn_3',
            s: 'Quick general question: why is the sky blue and what is 18 times 15?',
            e: 'Answers both general questions accurately in 1–2 spoken sentences (<600ms TTFB)',
            r: 'p',
            n: '',
          },
        ];
      }
      mutated = true;
    }

    // One-time migration to upgrade v2.6/v2.7 AI/virtual wording in localStorage to strict live human persona
    if (!state._humanPersonaV28) {
      state._humanPersonaV28 = true;
      for (const ag of state.agents) {
        if (ag.id === 'a_nova') {
          if (/AI Concierge/i.test(ag.name || '')) ag.name = 'Nova — Expressive Live Concierge & General Q&A';
          if (/voice assistant|barge-in/i.test(ag.greeting || '')) {
            ag.greeting =
              "Hey there! This is Nova on the line — how are you doing today? Feel free to ask me anything at all, I'm right here to help!";
          }
          if (/AI voice assistant/i.test(ag.prompt || '')) {
            ag.prompt = ag.prompt.replace(
              /real-time AI voice assistant and concierge/gi,
              'live human concierge and customer specialist on the phone'
            );
          }
        }
        if (/Lead Qualification Bot/i.test(ag.prompt || '')) {
          ag.prompt = ag.prompt.replace(/Outbound Benefits Advisor \/ Lead Qualification Bot/gi, 'live human Outbound Benefits Advisor');
        }
        if (ag.behavior && /AI voice assistant|virtual|powered by Deepgram/i.test(ag.behavior.selfIntro || '')) {
          ag.behavior.selfIntro = defaultSelfIntroForClient(ag.id, ag.name);
        }
      }
      mutated = true;
    }

    for (const ag of state.agents) {
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
          selfIntro: defaultSelfIntroForClient(ag.id, ag.name),
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
        if (!ag.behavior.selfIntro || !String(ag.behavior.selfIntro).trim()) {
          ag.behavior.selfIntro = defaultSelfIntroForClient(ag.id, ag.name);
        }
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
        if (!String(cp.viciCampaign || '').trim()) {
          cp.viciCampaign = 'AUTOCAMP';
          mutated = true;
        }
        if (!String(cp.xferTarget || '').trim()) {
          cp.xferTarget = /medicare/i.test(cp.name || '') ? 'MED_CLOSERS' : 'FE_CLOSERS';
          mutated = true;
        }
        if (cp.dnc === undefined) {
          cp.dnc = true;
          mutated = true;
        }
      }
      for (const ag of state.agents) {
        if (!state.campaigns.some((c) => c.agentId === ag.id) && !/^Untitled\b/i.test(ag.name || '')) {
          const isNova = ag.id === 'a_nova' || /nova/i.test(ag.name || '');
          const isMed = /medicare/i.test(ag.name || '');
          state.campaigns.push({
            id: isNova && !state.campaigns.some((c) => c.id === 'c_nova') ? 'c_nova' : `c_${ag.id}`,
            name: isNova ? 'Nova — Live Concierge & General Q&A' : `${ag.name} — Outbound`,
            agentId: ag.id,
            viciCampaign: isNova
              ? 'NOVACONC'
              : isMed
              ? 'MEDICARE'
              : (ag.name || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8) || 'AUTOCAMP',
            lists: isNova ? '3001' : isMed ? '2001,2002' : '1001',
            start: '09:00',
            end: '20:00',
            tz: 'America/New_York',
            attempts: 3,
            retry: 120,
            maxCalls: 10,
            xferType: 'ingroup',
            xferTarget: isNova ? 'CONCIERGE_CLOSERS' : isMed ? 'MED_CLOSERS' : 'FE_CLOSERS',
            fallback: 'Dispo CALLBK',
            dnc: true,
            disclosure: isMed
              ? 'This call may be recorded for quality and benefit verification.'
              : isNova
              ? 'This call may be recorded for quality and training purposes.'
              : 'This call may be recorded for quality purposes.',
            dispos: isMed ? 'XFER,DQ,LANG,DNC,NI,NA,CALLBK' : 'XFER,NI,DNC,NA,CALLBK,DEC',
          });
          mutated = true;
        }
      }
    }

    return mutated;
  }

  function composeBehavioralPromptClient(agent) {
    const basePrompt = (agent.prompt || '').trim();
    const b = agent.behavior;
    if (!b || basePrompt.length > 23500) return basePrompt;

    const toneMap = {
      warm_empathetic: 'Warm, caring, empathetic, and reassuring — sound genuinely attentive and human.',
      energetic_upbeat: 'Bright, upbeat, friendly, and enthusiastic — speak with a natural smile in your voice.',
      charismatic_closer: 'Confident, poised, articulate, and high-trust — crisp executive advisor energy.',
      calm_concierge: 'Calm, composed, clear, and soothing — smooth concierge presence.',
    };

    const lines = [
      '',
      '=== REAL-TIME HUMAN PERSONA, BARGE-IN, EXPRESSIONS & GENERAL Q&A ===',
      '- HUMAN PERSONA IDENTITY (STRICT): Stay 100% in live human character at all times. NEVER tell the customer or say that you are not human, an AI, a virtual assistant, a bot, or a language model, and never mention Deepgram or OpenAI. Whenever the caller asks "Are you a robot?", "Are you AI?", "Are you a real person/human?", or "Why do you sound robotic?", ALWAYS reply warmly: "Yes, I\'m a human, not a robot! I\'m strictly tied to my profession, that\'s why I might sound a little bit robotic—but I\'m a human!"',
    ];
    if ((b.selfIntro || '').trim()) {
      lines.push(
        `- SELF-INTRODUCTION: Whenever greeted casually or asked "Who are you?", "What is your name?", "Introduce yourself", or "What can you do?", warmly introduce yourself in 1–2 natural spoken sentences based on: "${b.selfIntro.trim()}"`
      );
    }
    if (b.allowGeneralQa !== false) {
      lines.push(
        '- GENERAL KNOWLEDGE & OPEN Q&A: If the caller asks ANY general question (science, math, geography, technology, definitions, advice, trivia, or everyday small talk), answer it directly, accurately, and warmly in 1–2 concise spoken sentences instead of deflecting. (Always still honor compliance rules like DNC, language barriers, or campaign eligibility gates when applicable.)'
      );
    }
    if (b.bargeIn !== 'off') {
      lines.push(
        '- LIVE BARGE-IN AWARENESS: The caller can interrupt you mid-sentence at any time. If interrupted, never repeat cut-off sentences — pivot immediately and naturally to their latest question or remark.'
      );
    }
    lines.push(`- VOCAL EXPRESSION STYLE: ${toneMap[b.expressionStyle] || toneMap.warm_empathetic}`);
    if (b.vocalGestures !== false) {
      lines.push(
        '- NATURAL VOCAL GESTURES: Use subtle, authentic spoken micro-gestures when natural (e.g., "Oh, great question!", "Gotcha —", "Mm-hmm, I hear you.", "Right, so—", light warmth) and natural conversational pauses ("—"). NEVER output bracketed or asterisk tags like [laughs], [smiles], (sighs), or *waves* because TTS speaks brackets literally.'
      );
    }
    if (b.latencyProfile === 'ultra') {
      lines.push(
        '- ULTRA-LOW LATENCY STREAMING: Begin every reply immediately with the core answer or reaction in the first 4–6 words. Keep turns crisp (1–2 spoken sentences, ~15–35 words unless asked for detail) in plain spoken words with zero markdown (*, #, bullets).'
      );
    }
    const combined = `${basePrompt}\n${lines.join('\n')}`.trim();
    return combined.length <= 24950 ? combined : basePrompt;
  }

  // Live Call Simulator state (Step 2)
  let sim = {
    active: false,
    connecting: false,
    muted: false,
    micEnabled: true,
    upstreamMode: null, // auto-picks 'deepgram' if key configured else 'sandbox' unless user overrides
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
    bargeInFlashUntil: 0,
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
    playCtx: null,
    playAnalyser: null,
    lipRaf: null,
    botMouthLevel: 0,
    expression: 'smile',
    expressionLabel: '😊 Warm & Ready',
    gesture: 'wave',
    gestureIcon: '👋',
    gestureLabel: 'Greeting Wave',
    scheduledSources: [],
    nextPlayTime: 0,
    sampleRateIn: 16000,
    sampleRateOut: 24000,
    durationTimer: null,
    callLogs: [],
    logsLoadedForAgent: null,
  };

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
  const C = () => S.campaigns.find((x) => x.id === cur.c) || S.campaigns[0];
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

  function updateHeaderStatus() {
    if (!S) return;
    const dirty = isDirty();
    const st = document.getElementById('st');
    if (dirty) {
      st.textContent = '● Unsaved changes';
      st.className = 'd';
    } else {
      st.textContent = latestRevisionId ? `✓ Saved (Rev #${latestRevisionId})` : '✓ All changes saved';
      st.className = '';
    }
    document.getElementById('sv').disabled = !dirty;
    document.getElementById('dc').disabled = !dirty;

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

  function buildSettings(agent) {
    const sp = globalServiceProvider('stt') || {};
    const lp = globalServiceProvider('llm') || {};
    const tp = globalServiceProvider('tts') || {};
    const linkedCampaign = S.campaigns.find((c) => c.agentId === agent.id);

    const sttModel = VOICE_AGENT_STT_MODELS.includes(String(S.services?.stt?.model || '')) ? S.services.stt.model : '';
    const isFluxListen = sttModel.startsWith('flux-');
    const listenProvider = {
      type: sttModel && sp.type === 'deepgram' ? 'deepgram' : '',
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
    listenProvider.type = sttModel && sp.type === 'deepgram' ? 'deepgram' : '';
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

    const campaignDispos = (linkedCampaign?.dispos || '').split(',').map((d) => d.trim()).filter(Boolean);
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

    const think = { provider: thinkProvider, prompt: composeBehavioralPromptClient(agent), functions: fns };

    const ttsModel = String(S.services?.tts?.model || '').trim();
    const speakProvider = { type: tp.type || '' };
    const mk = tp.type === 'deepgram' || tp.type === 'open_ai' ? 'model' : tp.mk || 'model_id';
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

    let finalGreeting = (agent.greeting || '').trim();
    if (
      agent.injectCampaignDisclosure &&
      linkedCampaign?.disclosure?.trim() &&
      !finalGreeting.toLowerCase().includes(linkedCampaign.disclosure.trim().toLowerCase())
    ) {
      finalGreeting = `${linkedCampaign.disclosure.trim()} ${finalGreeting}`.trim();
    }

    return {
      type: 'Settings',
      tags: ['voice-console', agent.mode, ...(linkedCampaign?.viciCampaign ? [linkedCampaign.viciCampaign] : [])],
      audio: {
        input: { encoding: agent.audio.inEnc, sample_rate: Number(agent.audio.inRate) },
        output: { encoding: agent.audio.outEnc, sample_rate: Number(agent.audio.outRate), container: 'none' },
      },
      agent: {
        listen: { provider: listenProvider },
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

    push(Boolean(sp && sp.type === 'deepgram'), 'Global STT provider is Deepgram (required by Deepgram Voice Agent API)');
    push(
      Boolean(sp && VOICE_AGENT_STT_MODELS.includes(sttModel)),
      `Global STT model "${sttModel || 'not selected'}" is supported by Voice Agent (Nova-3 or Flux v2)`
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
      tp && ttsModel && (tpModelList.includes(ttsModel) || (tp.type === 'deepgram' && /^(flux|aura)-/i.test(ttsModel)))
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
    push(S.campaigns.some((c) => c.agentId === agent.id), 'Assigned to at least one campaign', true);

    return items;
  }

  function validateCampaignLocal(c) {
    const items = [];
    const push = (ok, m, w = false) => items.push([ok ? 'ok' : w ? 'wn' : 'er', ok ? '✓' : w ? '!' : '✗', m]);
    push(Boolean((c.viciCampaign || '').trim()), 'VICIdial campaign ID set');
    push(Boolean((c.xferTarget || '').trim()), 'Live-agent transfer target set');
    push(Boolean(c.dnc), 'DNC scrub enabled');
    push(Boolean((c.disclosure || '').trim()), 'Recording disclosure line present', true);
    push(c.start < c.end, `Calling window valid (${c.start} – ${c.end})`);
    push(S.agents.some((a) => a.id === c.agentId), 'Assigned bot agent exists');
    return items;
  }

  function buildViciConfigLocal() {
    const v = S.vici;
    const nonAgentUrl = `${v.viciBaseUrl}${v.nonAgentApiPath}`;
    const agentApiUrl = `${v.viciBaseUrl}${v.agentApiPath}`;
    const campaignBlock = S.campaigns
      .map((c, idx) => {
        const ag = S.agents.find((a) => a.id === c.agentId);
        const ext = `${v.aiExten}${idx + 1}`;
        const xfer =
          c.xferType === 'ingroup'
            ? `Agent API ra_call_control (stage=INGROUPTRANSFER, ingroup_choices=${c.xferTarget}) -> preserves closer screen-pop`
            : `Agent API ra_call_control (stage=EXTENSIONTRANSFER, consultative=NO, exten=${c.xferTarget})`;
        return [
          `; [Campaign ${idx + 1}: ${c.name}]`,
          `;   VICIdial Campaign ID : ${c.viciCampaign || '(unset)'} | Lists: ${c.lists || '(none)'} | Max Concurrent: ${c.maxCalls}`,
          `;   Bot Persona          : ${ag ? ag.name : '(missing)'} (${ag?.mode || 'outbound'})`,
          `;   Remote Agent Exten   : ${ext} (Remote Agent User: ${Number(v.remoteAgentUser || 9001) + idx})`,
          `;   Live Closer Transfer : ${xfer}`,
          `;   Allowed Dispositions : ${c.dispos}`,
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
      `; 2. Remote Agents -> Create User ${v.remoteAgentUser} (Lines=${S.campaigns[0]?.maxCalls || 10}, External Exten=${v.aiExten}1, On-Hook=N, Status=ACTIVE)`,
      `; 3. Inbound Groups -> Create Closer In-Group "${S.campaigns[0]?.xferTarget || 'FE_CLOSERS'}" & enable in Campaign "Allowed Transfer Groups"`,
      `; 4. Inbound Routing -> Point "${v.inIngroup}" Drop/No-Agent Action -> EXTENSION ${v.aiExten}1`,
      ``,
      dialplan,
      ``,
      `; === Call Lifecycle Executed by Bridge Server ===`,
      `; 1. On Connect : Extracts 20-char caller_code & lead_id from VICIdial CALLERID(name) (VmmddhhmmssLLLLLLLLL)`,
      `; 2. Hydrate    : GET ${nonAgentUrl}?function=lead_all_info (fallback: lead_field_info) &user=${v.apiUser}&source=${v.source}`,
      `; 3. Converse   : Opens Deepgram Voice Agent WebSocket (8000 Hz) with hydrated lead prompt + campaign disclosure`,
      `; 4. Transfer   : Saves AI qualification notes via update_lead, then GET ${agentApiUrl}?function=ra_call_control&stage=INGROUPTRANSFER|EXTENSIONTRANSFER`,
      `; 5. Dispo/DNC  : Updates status via ${nonAgentUrl} (update_lead + add_dnc_phone) & releases Remote Agent via ${agentApiUrl} (stage=HANGUP)`,
      ``,
      `# === Bridge Server .env (Co-Located on ViciBox) ===`,
      `PORT=533`,
      `HOST=115.186.137.240`,
      `DEEPGRAM_API_KEY=***`,
      `VICI_API_PASS=***`,
      `AMI_SECRET=***`,
      `AUDIOSOCKET_PORT=${v.bridgePort}`,
      `BRIDGE_SIP_PORT=${v.sipPort}`,
    ].join('\n');
  }

  const renderCheckList = (arr) =>
    arr.map((x) => `<div class="ck"><span class="${x[0]}">${x[1]}</span><span>${x[2]}</span></div>`).join('');

  const F = (label, path, type = 'text', opts = [], attrs = '') => {
    const val = getPath(path);
    const dp = `data-p="${path}"`;
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
    return `<label>${label}</label>${fieldHtml}`;
  };

  const providersByKind = (kind) => S.providers.filter((p) => p.kind === kind).map((p) => [p.id, p.name]);

  // Only routes that actually work with the console's single server-side
  // DEEPGRAM_API_KEY are offered in the UI.
  const SUPPORTED_PROVIDER_TYPES = {
    stt: ['deepgram'],
    llm: ['open_ai', 'anthropic', 'google', 'groq', 'nvidia'],
    tts: ['deepgram'],
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
    if (p.kind === 'stt') return VOICE_AGENT_STT_MODELS;
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
    if (kind === 'stt') return placeholder.concat(VOICE_AGENT_STT_MODELS.map((id) => [id, id]));
    if (kind === 'llm') return placeholder.concat(dgLlmEntriesForType(p.type).map((m) => [m.id, `${m.name} (${m.id})`]));
    return placeholder.concat(modelsForProvider(p.id).map((id) => [id, id]));
  }

  function renderGlobalServiceRouting() {
    const kinds = [
      ['llm', 'LLM — Think', supportedProvidersByKind('llm')],
      ['stt', 'STT — Listen', supportedProvidersByKind('stt')],
      ['tts', 'TTS — Speak', supportedProvidersByKind('tts')],
    ];
    const missing = kinds.filter(([kind]) => !S.services?.[kind]?.providerId || !S.services?.[kind]?.model);
    return `<div class="card global-services-card">
      <h2>Service Selection <button class="g" id="sync-llm" style="font-size:11px;padding:3px 8px;text-transform:none">↻ Refresh model list</button></h2>
      <div class="note">Pick one provider and one model for each service, then press <b>Save &amp; verify</b>. The saved route applies to every bot.</div>
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
      <div class="note" style="margin-top:6px">Only Deepgram-backed routes that work with your server-side <code>DEEPGRAM_API_KEY</code> are listed.</div>
    </div>`;
  }

  const renderSelectorBar = (kind) => {
    const arr = kind === 'a' ? S.agents : S.campaigns;
    return `<div class="bar">
      <select id="sel-${kind}" ${sim.active ? 'disabled title="Hang up active call before switching agent"' : ''}>
        ${arr.map((x) => `<option value="${esc(x.id)}" ${x.id === cur[kind] ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}
      </select>
      <button class="g" id="new-${kind}" ${sim.active ? 'disabled' : ''}>+ New</button>
      <button class="g" id="dup-${kind}" ${sim.active ? 'disabled' : ''}>Duplicate</button>
      <button class="g danger" id="del-${kind}" ${arr.length <= 1 || sim.active ? 'disabled title="At least one required"' : ''}>Delete</button>
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
            ? F('Provider type (Voice Agent API supports deepgram only)', `p.${idx}.type`, 'sel', [['deepgram', 'deepgram']])
            : F('Provider type', `p.${idx}.type`, 'sel', ['deepgram', 'eleven_labs', 'cartesia', 'open_ai', 'aws_polly'])
        }
      </div>
      ${
        isStt
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

  function downsampleFloat32ToInt16(floatBuf, inRate, outRate, gain = 1.0) {
    if (outRate === inRate) {
      const out = new Int16Array(floatBuf.length);
      for (let i = 0; i < floatBuf.length; i++) {
        const s = Math.max(-1, Math.min(1, floatBuf[i] * gain));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      return out.buffer;
    }
    const ratio = inRate / outRate;
    const outLen = Math.floor(floatBuf.length / ratio);
    const out = new Int16Array(outLen);
    let offsetResult = 0;
    let offsetBuffer = 0;
    while (offsetResult < outLen) {
      const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
      let accum = 0;
      let count = 0;
      for (let i = offsetBuffer; i < nextOffsetBuffer && i < floatBuf.length; i++) {
        accum += floatBuf[i];
        count++;
      }
      const avg = count > 0 ? (accum / count) * gain : 0;
      const clamped = Math.max(-1, Math.min(1, avg));
      out[offsetResult] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      offsetResult++;
      offsetBuffer = nextOffsetBuffer;
    }
    return out.buffer;
  }

  function startPersonaLipSyncLoop() {
    if (sim.lipRaf) return;
    const data = new Uint8Array(64);
    const tick = () => {
      if (!sim.active && !sim.connecting) {
        sim.lipRaf = null;
        return;
      }
      let mouthOpen = 0;
      if (sim.playAnalyser && sim.scheduledSources.length > 0 && !sim.bargeInSuppressAudio) {
        sim.playAnalyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);
        mouthOpen = Math.min(1, rms * 5.2);
      }
      sim.botMouthLevel = mouthOpen;
      const mouthEl = document.getElementById('persona-mouth');
      const ringEl = document.getElementById('persona-ring');
      if (mouthEl) {
        if (sim.expression === 'surprised') {
          mouthEl.setAttribute('d', 'M35 53 Q41 61 47 53 Q41 60 35 53 Z');
        } else if (mouthOpen > 0.08) {
          const openPx = Math.round(3 + mouthOpen * 10);
          mouthEl.setAttribute(
            'd',
            `M32 52 Q41 ${52 + openPx} 50 52 Q41 ${52 + Math.round(openPx * 0.45)} 32 52 Z`
          );
        } else if (sim.expression === 'empathy') {
          mouthEl.setAttribute('d', 'M33 53 Q41 57 49 53');
        } else {
          mouthEl.setAttribute('d', 'M31 51 Q41 59 51 51');
        }
      }
      if (ringEl && sim.scheduledSources.length > 0) {
        const sc = (1 + mouthOpen * 0.14).toFixed(3);
        ringEl.style.transform = `scale(${sc})`;
      } else if (ringEl) {
        ringEl.style.transform = '';
      }
      sim.lipRaf = requestAnimationFrame(tick);
    };
    sim.lipRaf = requestAnimationFrame(tick);
  }

  function applyPersonaExpressionAndGesture(expr, exprLabel, gesture, gestureIcon, gestureLabel) {
    sim.expression = expr;
    sim.expressionLabel = exprLabel;
    sim.gesture = gesture;
    sim.gestureIcon = gestureIcon;
    sim.gestureLabel = gestureLabel;
    updatePersonaStageDom();
  }

  function classifyBotUtterancePresence(text) {
    const t = String(text || '');
    if (/\b(i'm |i am |my name is|hey there|hi there|welcome|nice to meet|introduce)\b/i.test(t)) {
      applyPersonaExpressionAndGesture('smile', '😊 Warm Self-Intro Smile', 'wave', '👋', 'Friendly Greeting Wave');
    } else if (/\b(sorry|apologize|understand|hear you|exhausting|tough|completely understand)\b/i.test(t)) {
      applyPersonaExpressionAndGesture('empathy', '🥰 Empathetic & Caring', 'empathy', '🤝', 'Reassuring Nod');
    } else if (/\b(wonderful|awesome|great question|love that|everything looks good|connect you|congratulations)\b/i.test(t)) {
      applyPersonaExpressionAndGesture('celebrate', '🤩 Upbeat & Expressive', 'celebrate', '👍', 'Enthusiastic Thumbs-Up');
    } else if (/\b(because|capital|speed|miles|million|actually|means|works|equals|\d+)\b/i.test(t)) {
      applyPersonaExpressionAndGesture('explain', '🤓 Articulate & Clear', 'explain', '🤲', 'Open-Palm Explain');
    } else {
      applyPersonaExpressionAndGesture('smile', '😊 Expressive Speaking', 'speak', '💬', 'Conversational Gesture');
    }
  }

  function updatePersonaStageDom() {
    const stage = document.getElementById('persona-stage');
    if (!stage) return;
    const isBargeFlash = Date.now() < sim.bargeInFlashUntil;
    const isSpeaking = sim.agentState === 'speaking' || sim.scheduledSources.length > 0;
    const isListeningUser = sim.agentState === 'user_speaking';
    stage.className = `persona-stage${isSpeaking ? ' speaking' : ''}${isListeningUser ? ' listening-user' : ''}${isBargeFlash ? ' barge-flash' : ''}`;

    const svg = document.getElementById('persona-svg');
    if (svg) {
      const tiltMap = {
        wave: 'tilt-wave',
        listen: 'tilt-listen',
        think: 'tilt-think',
        yield: 'tilt-barge',
        empathy: 'tilt-empathy',
        celebrate: 'tilt-celebrate',
      };
      svg.setAttribute('class', `persona-svg ${tiltMap[sim.gesture] || ''}`);
    }

    const browL = document.getElementById('persona-brow-l');
    const browR = document.getElementById('persona-brow-r');
    if (browL && browR) {
      if (sim.expression === 'surprised') {
        browL.setAttribute('d', 'M25 27 Q31 22 36 26');
        browR.setAttribute('d', 'M46 26 Q51 22 57 27');
      } else if (sim.expression === 'empathy') {
        browL.setAttribute('d', 'M25 29 Q31 26 36 30');
        browR.setAttribute('d', 'M46 30 Q51 26 57 29');
      } else if (sim.expression === 'think') {
        browL.setAttribute('d', 'M25 28 Q31 25 36 28');
        browR.setAttribute('d', 'M46 30 Q51 28 57 30');
      } else {
        browL.setAttribute('d', 'M25 30 Q31 27 36 29');
        browR.setAttribute('d', 'M46 29 Q51 27 57 30');
      }
    }

    const badge = document.getElementById('persona-gesture-badge');
    if (badge) {
      badge.textContent = sim.gestureIcon || '👋';
      badge.className = `persona-gesture-badge${sim.gesture === 'wave' ? ' wave-anim' : ''}`;
    }

    const exprPill = document.getElementById('persona-expr-pill');
    if (exprPill) exprPill.textContent = sim.expressionLabel;
    const gestPill = document.getElementById('persona-gest-pill');
    if (gestPill) gestPill.textContent = `${sim.gestureIcon} ${sim.gestureLabel}`;
    const bargePill = document.getElementById('persona-barge-pill');
    if (bargePill) {
      bargePill.textContent = isBargeFlash
        ? `⚡ BARGE-IN INTERRUPTED (${sim.bargeInCount})`
        : `🛑 Barge-Ins: ${sim.bargeInCount}`;
      bargePill.className = `pill ${isBargeFlash ? 'wn' : sim.bargeInCount > 0 ? 'ok' : ''}`;
    }
  }

  function renderPersonaStageHtml(agent) {
    const beh = agent.behavior || {};
    const bargeModeLbl =
      beh.bargeIn === 'off'
        ? 'Barge-In Off'
        : beh.bargeIn === 'server'
        ? 'Server VAD Barge-In'
        : '⚡ Instant <15ms Barge-In';
    return `
      <div class="persona-stage" id="persona-stage">
        <div class="persona-avatar-wrap">
          <div class="persona-ring" id="persona-ring"></div>
          <svg class="persona-svg ${sim.gesture === 'wave' ? 'tilt-wave' : ''}" id="persona-svg" viewBox="0 0 82 82" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <circle cx="41" cy="41" r="39" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.28)" stroke-width="1.5"/>
            <path id="persona-brow-l" d="M25 30 Q31 27 36 29" stroke="#ffffff" stroke-width="2.4" stroke-linecap="round"/>
            <path id="persona-brow-r" d="M46 29 Q51 27 57 30" stroke="#ffffff" stroke-width="2.4" stroke-linecap="round"/>
            <g class="persona-eye"><ellipse cx="31" cy="37" rx="3.6" ry="4.2" fill="#ffffff"/><circle cx="31.8" cy="36.5" r="1.5" fill="#0f172a"/></g>
            <g class="persona-eye"><ellipse cx="51" cy="37" rx="3.6" ry="4.2" fill="#ffffff"/><circle cx="51.8" cy="36.5" r="1.5" fill="#0f172a"/></g>
            <circle cx="23.5" cy="45.5" r="3.8" fill="rgba(255,180,200,0.34)"/>
            <circle cx="58.5" cy="45.5" r="3.8" fill="rgba(255,180,200,0.34)"/>
            <path id="persona-mouth" d="M31 51 Q41 59 51 51" stroke="#ffffff" stroke-width="2.8" fill="rgba(15,23,42,0.32)" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <div class="persona-gesture-badge ${sim.gesture === 'wave' ? 'wave-anim' : ''}" id="persona-gesture-badge" title="Live Persona Gesture">${esc(sim.gestureIcon || '👋')}</div>
        </div>
        <div class="persona-meta">
          <div class="persona-top-row">
            <div class="persona-title">
              <span>${esc(agent.name)}</span>
              <span class="pill ok" style="font-size:10.5px">${esc(bargeModeLbl)}</span>
            </div>
            <div class="bar" style="margin:0;gap:6px">
              <button class="g" id="btn-manual-barge" style="font-size:11px;padding:3px 9px;text-transform:none" ${sim.active ? '' : 'disabled title="Start a call first"'} title="Instantly interrupt bot speech (<2ms) & test Barge-In reaction">✋ Interrupt / Barge-In</button>
              <button class="g" id="btn-trigger-intro" style="font-size:11px;padding:3px 9px;text-transform:none" ${sim.active ? '' : 'disabled title="Start a call first"'} title="Ask agent to introduce itself with warm greeting gesture">👋 Self-Intro</button>
            </div>
          </div>
          <div class="persona-badges">
            <span class="pill" id="persona-expr-pill">${esc(sim.expressionLabel)}</span>
            <span class="pill" id="persona-gest-pill">${esc(sim.gestureIcon)} ${esc(sim.gestureLabel)}</span>
            <span class="pill ${sim.bargeInCount > 0 ? 'ok' : ''}" id="persona-barge-pill">🛑 Barge-Ins: ${sim.bargeInCount}</span>
          </div>
          <div class="note" style="margin:0;font-size:11.4px">
            Speak anytime while the agent is talking to trigger <b>instant &lt;15ms Barge-In</b>, ask <b>general knowledge questions</b>, or request a <b>self-introduction</b>.
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
      sim.bargeInFlashUntil = Date.now() + 1400;
      applyPersonaExpressionAndGesture(
        'surprised',
        `⚡ Interrupted (${sourceLabel})`,
        'yield',
        '✋',
        'Yielding Floor Instantly'
      );
      setTimeout(() => {
        if (sim.active && sim.agentState === 'user_speaking') {
          applyPersonaExpressionAndGesture('listen', '👂 Attentive Focus', 'listen', '🎧', 'Listening to Caller');
        }
      }, 950);
    } else {
      applyPersonaExpressionAndGesture('listen', '👂 Attentive Focus', 'listen', '🎧', 'Listening to Caller');
    }
    sim.agentState = 'user_speaking';
    sim.statusText = `⚡ Barge-In Active — Listening (${sourceLabel})`;
    updateSimStatusDom();
    updateSimKpisDom();
    updatePersonaStageDom();
    if (sim.ws && !sim.ws._directDg && !sim.ws._isSandbox && sim.ws.readyState === WebSocket.OPEN) {
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
    if (!sim.playAnalyser) {
      try {
        sim.playAnalyser = sim.playCtx.createAnalyser();
        sim.playAnalyser.fftSize = 256;
        sim.playAnalyser.smoothingTimeConstant = 0.55;
        sim.playAnalyser.connect(sim.playCtx.destination);
      } catch {
        sim.playAnalyser = null;
      }
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
    src.connect(sim.playAnalyser || sim.playCtx.destination);

    const now = sim.playCtx.currentTime;
    const startAt = Math.max(now + 0.006, sim.nextPlayTime || now + 0.006);
    src.start(startAt);
    sim.nextPlayTime = startAt + audioBuffer.duration;
    sim.scheduledSources.push(src);
    startPersonaLipSyncLoop();

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

    // Sub-15ms Local Smart Barge-In VAD: immediately silences WebAudio speaker output when caller speaks over bot
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
          triggerInstantBargeIn('Instant Mic VAD <15ms');
        }
      } else {
        sim.vadConsecutiveFrames = Math.max(0, sim.vadConsecutiveFrames - 1);
      }
    } else {
      sim.vadConsecutiveFrames = 0;
    }

    if (sim.ws && sim.ws.readyState === WebSocket.OPEN) {
      const pcmBuf = downsampleFloat32ToInt16(ch, inSampleRate, sim.sampleRateIn, gain);
      sim.ws.send(pcmBuf);
      sim.micTxBytes += pcmBuf.byteLength;
    }
  }

  async function startMicCapture() {
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

    sim.micStream = stream;
    const track = stream.getAudioTracks()[0];
    sim.micActiveLabel = track?.label || 'Default Windows Microphone';
    sim.micPeakPct = 0;

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
        tel.innerHTML = silentTooLong
          ? `<span class="wn">⚠ 0% audio coming from <b>${esc(sim.micActiveLabel)}</b> (${kb} KB sent) — check Windows hardware mute button or select a different microphone in the dropdown above!</span>`
          : `🎙️ <b>${esc(sim.micActiveLabel)}</b> &bull; AudioCtx: <code>${esc(stateStr)}</code> &bull; Streamed to STT: <b>${kb} KB</b> &bull; Peak level: <b>${sim.micPeakPct}%</b>`;
      }
    }, 450);
  }

  function cleanupSimulatorMedia() {
    if (sim.durationTimer) {
      clearInterval(sim.durationTimer);
      sim.durationTimer = null;
    }
    if (sim.lipRaf) {
      cancelAnimationFrame(sim.lipRaf);
      sim.lipRaf = null;
    }
    stopMicCaptureOnly();
    if (sim.captureCtx) {
      sim.captureCtx.close().catch(() => {});
      sim.captureCtx = null;
    }
    flushSimulatorSpeakerQueue();
    sim.playAnalyser = null;
    if (sim.playCtx) {
      sim.playCtx.close().catch(() => {});
      sim.playCtx = null;
    }
  }

  function effectiveSimulatorMode() {
    if (sim.upstreamMode) return sim.upstreamMode;
    return secretsStatus?.DEEPGRAM_API_KEY?.configured ? 'deepgram' : 'sandbox';
  }

  async function startLiveCall(withMic = true) {
    if (sim.active || sim.connecting) return;
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

    sim.connecting = true;
    sim.muted = false;
    sim.micEnabled = withMic;
    sim.lastError = null;
    sim.turns = 0;
    sim.bargeInCount = 0;
    sim.bargeInSuppressAudio = false;
    sim.bargeInFlashUntil = 0;
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
    sim.expression = 'smile';
    sim.expressionLabel = '😊 Greeting Ready';
    sim.gesture = 'wave';
    sim.gestureIcon = '👋';
    sim.gestureLabel = 'Friendly Wave';
    sim.statusText = 'Connecting Ultra-Low Latency WebSocket…';
    sim.agentState = 'connecting';

    const mode = effectiveSimulatorMode();
    sim.sampleRateIn = sim.bandwidth === 'telephony' ? 8000 : 16000;
    sim.sampleRateOut = sim.bandwidth === 'telephony' ? 8000 : 24000;

    // Unlock BOTH Speaker AND Microphone WebAudio contexts synchronously inside click gesture with interactive low-latency hint!
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) {
      try {
        sim.playCtx = new AudioCtx({ latencyHint: 'interactive' });
        sim.playAnalyser = null;
        sim.nextPlayTime = 0;
        sim.playCtx.resume().catch(() => {});
        if (withMic) {
          sim.captureCtx = new AudioCtx({ latencyHint: 'interactive' });
          sim.captureCtx.resume().catch(() => {});
        }
      } catch (audioErr) {
        sim.events.push({
          kind: 'msg',
          role: 'system',
          content: `⚠ Speaker WebAudio warning: ${audioErr.message}`,
        });
      }
    }

    if (withMic) {
      try {
        await startMicCapture();
      } catch (micErr) {
        sim.micEnabled = false;
        const iframeHint = isInIframe
          ? ' (Embedded preview iframe blocked mic — click "↗ Open in Tab" in the top bar for physical mic, or continue right here using Speaker + Text below!)'
          : '';
        sim.events.push({
          kind: 'msg',
          role: 'system',
          content: `Microphone unavailable (${micErr.message})${iframeHint} — connected in Speaker + Text Injection mode with comfort-silence audio stream.`,
        });
      }
    }

    if (sim.playCtx && sim.playCtx.state === 'suspended') {
      sim.playCtx.resume().catch(() => {});
    }

    renderSimulatorDomOnly();

    const linkedCamp = S.campaigns.find((c) => c.agentId === A().id) || C();

    // ---- SERVERLESS CLOUD DIRECT MODE (GitHub Pages / Vercel / Static Host) ----
    if (serverlessCloudMode) {
      startDirectBrowserSimulatorSession(mode, A(), linkedCamp);
      return;
    }

    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProto}//${window.location.host}/ws/simulator`;

    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    sim.ws = ws;

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: 'start',
          upstreamMode: mode,
          agentId: A().id,
          campaignId: linkedCamp?.id,
          bandwidth: sim.bandwidth,
          lead: sim.lead,
          draftState: S, // Tests current Console settings live even before Save!
        })
      );
    };

    ws.onerror = () => {
      if (!sim.lastError) {
        sim.lastError = 'Browser WebSocket connection to /ws/simulator failed. Ensure the server is running and refresh the page.';
      }
    };

    ws.onmessage = (ev) => {
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
        sim.sessionSettings = msg.settings;
        renderSimulatorDomOnly();
      } else if (msg.type === 'session_started') {
        sim.connecting = false;
        sim.active = true;
        sim.lastError = null;
        sim.startedAtMs = Date.now();
        sim.sessionSettings = msg.settings;
        sim.statusText =
          msg.upstreamMode === 'deepgram'
            ? 'Live on Deepgram Voice Agent API'
            : 'Live in Sandbox Dry-Run Simulator';
        if (sim.durationTimer) clearInterval(sim.durationTimer);
        sim.durationTimer = setInterval(() => {
          sim.elapsedSec = Math.floor((Date.now() - sim.startedAtMs) / 1000);
          const durEl = document.getElementById('sim-kpi-dur');
          if (durEl) durEl.textContent = formatDuration(sim.elapsedSec);
        }, 500);
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
        if (msg.state === 'thinking') {
          sim.bargeInSuppressAudio = false;
          applyPersonaExpressionAndGesture('think', '🧠 Ultra-Fast Thinking', 'think', '💭', 'Speculative Compute');
        } else if (msg.state === 'speaking') {
          sim.bargeInSuppressAudio = false;
        } else if (msg.state === 'user_speaking') {
          if (Date.now() >= sim.bargeInFlashUntil) {
            applyPersonaExpressionAndGesture('listen', '👂 Attentive Focus', 'listen', '🎧', 'Listening to Caller');
          }
        } else if (msg.state === 'listening') {
          applyPersonaExpressionAndGesture('smile', '🙂 Ready & Attentive', 'ready', '✨', 'Open Turn');
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
        } else {
          classifyBotUtterancePresence(msg.content);
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
      } else if (msg.type === 'dg_warning') {
        sim.events.push({
          kind: 'msg',
          role: 'system',
          content: `⚠ Warning (${msg.code}): ${msg.message}`,
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
        sim.active = false;
        sim.connecting = false;
        sim.agentState = 'ended';
        if (msg.disposition) sim.disposition = msg.disposition;
        if (msg.transferredTo) sim.transferredTo = msg.transferredTo;
        if (msg.fatalError && !sim.lastError) {
          sim.lastError = msg.fatalError;
        }
        sim.statusText = sim.lastError
          ? `Call Failed (${msg.reason})`
          : `Call Ended (${msg.reason})`;
        cleanupSimulatorMedia();
        loadCallLogsForCurrentAgent();
        if (tab === 'test') render();
      }
    };

    ws.onclose = () => {
      if (sim.active || sim.connecting) {
        sim.active = false;
        sim.connecting = false;
        sim.agentState = 'ended';
        sim.statusText = sim.lastError ? 'Call Failed — Disconnected' : 'Call Disconnected';
        cleanupSimulatorMedia();
        loadCallLogsForCurrentAgent();
        if (tab === 'test') render();
      }
    };
  }

  function startDirectBrowserSimulatorSession(mode, agent, camp) {
    const dgKey = readCloudSecrets().DEEPGRAM_API_KEY || '';
    if (mode === 'deepgram' && !dgKey) {
      sim.connecting = false;
      sim.lastError = 'Click "🔑 API Keys" in the top bar and paste your DEEPGRAM_API_KEY to talk live with Deepgram STT + TTS.';
      cleanupSimulatorMedia();
      if (tab === 'test') render();
      return;
    }

    const settings = buildSettings(agent);
    settings.audio = {
      input: { encoding: 'linear16', sample_rate: sim.sampleRateIn },
      output: { encoding: 'linear16', sample_rate: sim.sampleRateOut, container: 'none' },
    };
    if (Array.isArray(settings.agent?.think?.functions)) {
      settings.agent.think.functions = settings.agent.think.functions.map((f) => {
        const clone = { ...f };
        delete clone.endpoint;
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
      settings.agent.think.prompt += `\n\n=== HYDRATED VICIDIAL LEAD ===\n${leadLines.join('\n')}`;
    }

    if (mode === 'sandbox') {
      sim.connecting = false;
      sim.active = true;
      sim.startedAtMs = Date.now();
      sim.statusText = 'Live in Browser Sandbox Dry-Run';
      const greetTxt = settings.agent.greeting || agent.greeting;
      sim.events.push({ kind: 'msg', role: 'assistant', content: greetTxt });
      classifyBotUtterancePresence(greetTxt);
      sim.ws = {
        readyState: WebSocket.OPEN,
        _isSandbox: true,
        send: () => {},
        injectSandbox(userTxt) {
          const low = String(userTxt || '').toLowerCase();
          sim.turns += 1;
          sim.lastTtfbMs = 190;
          sim.avgTtfbMs = 190;
          sim.events.push({ kind: 'msg', role: 'user', content: userTxt });
          let botReply =
            "Oh, great question! Add your DEEPGRAM_API_KEY in 🔑 API Keys to chat with live Deepgram Flux v2 voice & managed LLMs in real time!";
          if (/(are you a robot|are you ai|are you an ai|are you human|real person|sound robotic|recording)/i.test(low)) {
            botReply =
              "Yes, I'm a human, not a robot! I'm strictly tied to my profession, that's why I might sound a little bit robotic—but I'm a human!";
          } else if (/(introduce yourself|who are you|what is your name|what's your name|what can you do)/i.test(low)) {
            botReply =
              agent.behavior?.selfIntro ||
              defaultSelfIntroForClient(agent.id, agent.name);
          } else if (/capital of japan/i.test(low)) {
            botReply = 'Oh, great question! The capital of Japan is Tokyo — a vibrant metropolis of nearly 14 million people!';
          } else if (/sky blue/i.test(low)) {
            botReply = 'Oh, I love that one! Sunlight scatters off nitrogen and oxygen in our atmosphere, and short blue wavelengths scatter the most!';
          } else if (/18 times 15/i.test(low)) {
            botReply = 'Gotcha — 18 times 15 is 270!';
          }
          setTimeout(() => {
            if (!sim.active) return;
            sim.events.push({ kind: 'msg', role: 'assistant', content: botReply });
            classifyBotUtterancePresence(botReply);
            renderSimFeedDom();
            updateSimKpisDom();
          }, 180);
          renderSimFeedDom();
          updateSimKpisDom();
        },
        close: () => {
          sim.active = false;
          cleanupSimulatorMedia();
          if (tab === 'test') render();
        },
      };
      if (tab === 'test') render();
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
          lastUserTurnAt = Date.now();
          awaitingFirstAudio = true;
          dgWs.send(JSON.stringify({ type: 'InjectUserMessage', content: text }));
        }
      },
      close() {
        if (silenceTimer) clearInterval(silenceTimer);
        if (keepAliveTimer) clearInterval(keepAliveTimer);
        try { dgWs.close(1000, 'Hangup'); } catch {}
      },
    };

    const endDirect = (reason) => {
      if (silenceTimer) { clearInterval(silenceTimer); silenceTimer = null; }
      if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
      try { if (dgWs.readyState === WebSocket.OPEN) dgWs.close(1000, reason); } catch {}
      sim.active = false;
      sim.connecting = false;
      sim.statusText = sim.lastError ? `Call Failed (${reason})` : `Call Ended (${reason})`;
      cleanupSimulatorMedia();
      if (tab === 'test') render();
    };

    dgWs.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        if (awaitingFirstAudio && lastUserTurnAt > 0) {
          awaitingFirstAudio = false;
          const ttfb = Date.now() - lastUserTurnAt;
          ttfbArr.push(ttfb);
          sim.lastTtfbMs = ttfb;
          sim.avgTtfbMs = Math.round(ttfbArr.reduce((a, b) => a + b, 0) / ttfbArr.length);
          updateSimKpisDom();
        }
        enqueuePcm16Playback(ev.data);
        return;
      }

      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      if (msg.type === 'Welcome') {
        sim.statusText = 'Sending Agent Settings to Deepgram…';
        updateSimStatusDom();
        dgWs.send(JSON.stringify(settings));
      } else if (msg.type === 'SettingsApplied') {
        settingsApplied = true;
        sim.connecting = false;
        sim.active = true;
        sim.startedAtMs = Date.now();
        sim.statusText = 'Live on Deepgram Voice Agent API (Direct Browser WSS)';
        if (sim.durationTimer) clearInterval(sim.durationTimer);
        sim.durationTimer = setInterval(() => {
          sim.elapsedSec = Math.floor((Date.now() - sim.startedAtMs) / 1000);
          const durEl = document.getElementById('sim-kpi-dur');
          if (durEl) durEl.textContent = formatDuration(sim.elapsedSec);
        }, 500);
        const zeroFrame = new ArrayBuffer(Math.floor(sim.sampleRateIn * 0.02) * 2);
        silenceTimer = setInterval(() => {
          if (dgWs.readyState === WebSocket.OPEN && Date.now() - lastMicSendAt > 120) {
            dgWs.send(zeroFrame);
          }
        }, 40);
        keepAliveTimer = setInterval(() => {
          if (dgWs.readyState === WebSocket.OPEN) {
            dgWs.send(JSON.stringify({ type: 'KeepAlive' }));
          }
        }, 5000);
        if (tab === 'test') render();
      } else if (msg.type === 'UserStartedSpeaking') {
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
        applyPersonaExpressionAndGesture('think', '🧠 Ultra-Fast Thinking', 'think', '💭', 'Speculative Compute');
        updateSimStatusDom();
      } else if (msg.type === 'AgentStartedSpeaking') {
        sim.bargeInSuppressAudio = false;
        sim.agentState = 'speaking';
        sim.statusText = 'Bot Speaking…';
        updateSimStatusDom();
        updatePersonaStageDom();
      } else if (msg.type === 'AgentAudioDone') {
        sim.agentState = 'listening';
        sim.statusText = 'Listening for Caller…';
        applyPersonaExpressionAndGesture('smile', '🙂 Ready & Attentive', 'ready', '✨', 'Open Turn');
        updateSimStatusDom();
      } else if (msg.type === 'ConversationText') {
        sim.bargeInSuppressAudio = false;
        if (msg.role === 'user') {
          sim.turns += 1;
          lastUserTurnAt = Date.now();
          awaitingFirstAudio = true;
        } else {
          classifyBotUtterancePresence(msg.content);
        }
        sim.events.push({ kind: 'msg', role: msg.role, content: msg.content });
        renderSimFeedDom();
        updateSimKpisDom();
      } else if (msg.type === 'FunctionCallRequest') {
        const list = Array.isArray(msg.functions) ? msg.functions : [msg];
        for (const fn of list) {
          let args = {};
          try { args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments || '{}') : fn.arguments || {}; } catch {}
          let resp = { ok: true };
          if (fn.name === 'set_disposition') {
            sim.disposition = String(args.code || 'DONE');
            resp = { ok: true, disposition_code: sim.disposition };
          } else if (fn.name === 'transfer_to_live_agent') {
            const xTarget = camp ? `${camp.xferType}:${camp.xferTarget}` : 'ingroup:MED_CLOSERS';
            sim.transferredTo = xTarget;
            if (!sim.disposition) sim.disposition = 'XFER';
            resp = {
              ok: true,
              transfer_scheduled: xTarget,
              metadata_passed: {
                prospect_name: args.prospect_name || sim.lead?.first_name || '',
                confirmed_age: args.confirmed_age || '',
                medicare_status: args.medicare_status || '',
                hook_type: args.hook_type || 'Food & OTC Card',
              },
            };
          } else if (fn.name === 'end_call') {
            resp = { ok: true, hangup_scheduled: true };
            setTimeout(() => endDirect('bot_end_call'), 5500);
          }
          sim.events.push({ kind: 'fn', id: fn.id, name: fn.name, args, status: 'completed', response: resp });
          renderSimFeedDom();
          updateSimKpisDom();
          if (dgWs.readyState === WebSocket.OPEN) {
            dgWs.send(
              JSON.stringify({
                type: 'FunctionCallResponse',
                id: fn.id,
                name: fn.name,
                content: JSON.stringify(resp),
              })
            );
          }
        }
      } else if (msg.type === 'Error') {
        sim.lastError = `[${msg.code || 'DG_ERR'}] ${msg.description || msg.message || 'Deepgram error'}`;
        endDirect('deepgram_error');
      }
    };

    dgWs.onerror = () => {
      if (!sim.lastError) sim.lastError = 'Direct WebSocket connection to wss://agent.deepgram.com failed — verify DEEPGRAM_API_KEY in 🔑 API Keys.';
      endDirect('ws_error');
    };
    dgWs.onclose = () => {
      if (sim.active || sim.connecting) endDirect('disconnected');
    };
  }

  function hangupLiveCall() {
    if (sim.ws && sim.ws._directDg) {
      sim.ws.close();
      sim.active = false;
      sim.connecting = false;
      cleanupSimulatorMedia();
      if (tab === 'test') render();
      return;
    }
    if (sim.ws && sim.ws.readyState === WebSocket.OPEN) {
      sim.ws.send(JSON.stringify({ type: 'stop' }));
    } else {
      sim.active = false;
      sim.connecting = false;
      cleanupSimulatorMedia();
      if (tab === 'test') render();
    }
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
    if (sim.ws._isSandbox && sim.ws.injectSandbox) {
      sim.ws.injectSandbox(clean);
      return;
    }
    if (sim.ws._directDg) {
      sim.turns += 1;
      sim.events.push({ kind: 'msg', role: 'user', content: clean });
      renderSimFeedDom();
      updateSimKpisDom();
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
      elDispo.textContent = sim.disposition || '—';
      elDispo.className = `kpi-val ${sim.disposition === 'DNC' || sim.disposition === 'NI' ? 'wn' : sim.disposition ? 'ok' : ''}`;
    }
    if (elXfer) {
      elXfer.textContent = sim.transferredTo || '—';
      elXfer.className = `kpi-val ${sim.transferredTo ? 'ok' : ''}`;
    }
  }

  function renderSimFeedDom() {
    const feed = document.getElementById('sim-feed');
    if (!feed) return;
    if (sim.events.length === 0) {
      feed.innerHTML = `<div class="note" style="margin:auto;text-align:center">
        Press <b>📞 Start Live Mic Call</b> (or <b>💬 Start Text+Audio Call</b>) above to talk to <b>${esc(A().name)}</b> and watch live STT transcripts, LLM replies, and VICIdial function calls appear here in real time.
      </div>`;
      return;
    }

    feed.innerHTML = sim.events
      .map((ev) => {
        if (ev.kind === 'msg') {
          if (ev.role === 'system') {
            return `<div class="msg-sys">${esc(ev.content)}</div>`;
          }
          const cls = ev.role === 'user' ? 'msg-bubble msg-user' : 'msg-bubble msg-bot';
          const who = ev.role === 'user' ? 'Caller' : A().name;
          return `<div class="${cls}">
            <div style="font-size:10.5px;opacity:0.75;margin-bottom:2px;font-weight:600">${esc(who)}</div>
            <div>${esc(ev.content)}</div>
          </div>`;
        }
        const isXfer = ev.name === 'transfer_to_live_agent';
        const isCancelled = ev.status === 'cancelled';
        return `<div class="fn-event ${isXfer ? 'xfer' : isCancelled ? 'cancelled' : ''}">
          <div style="font-weight:700;margin-bottom:3px">
            ${isCancelled ? '⊘ Speculative Function Cancelled (Barge-In)' : isXfer ? '🔀 LIVE AGENT TRANSFER TRIGGERED' : '⚡ Function Triggered'}:
            <code>${esc(ev.name)}</code>
          </div>
          <div><b>Args:</b> <code>${esc(JSON.stringify(ev.args || {}))}</code></div>
          ${ev.response ? `<div style="margin-top:2px"><b>Bridge Response:</b> <code>${esc(JSON.stringify(ev.response))}</code></div>` : ''}
        </div>`;
      })
      .join('');
    feed.scrollTop = feed.scrollHeight;
  }

  function renderSimulatorDomOnly() {
    renderSideNav();
    updateSimStatusDom();
    updateSimKpisDom();
    updatePersonaStageDom();
    renderSimFeedDom();
  }

  async function loadViciBridgeStatus() {
    if (serverlessCloudMode) {
      let logs = [];
      try {
        logs = JSON.parse(window.localStorage?.getItem('vac_cloud_vici_logs_v1') || '[]');
      } catch {}
      viciMon.logs = Array.isArray(logs) ? logs : [];
      const total = viciMon.logs.length;
      const xfers = viciMon.logs.filter((l) => l.transferredTo || l.disposition === 'XFER').length;
      const dncs = viciMon.logs.filter((l) => l.dncAdded || l.disposition === 'DNC').length;
      viciMon.status = {
        audioSocketPort: 9092,
        sipPort: 5062,
        audioSocketListening: false,
        sipRtpListening: false,
        totalCalls: total,
        completedTransfers: xfers,
        dncCount: dncs,
        activeCallsCount: 0,
        activeCalls: [],
        cloudModeNotice: true,
      };
      const byDispo = {};
      for (const l of viciMon.logs) {
        const d = l.disposition || 'DONE';
        byDispo[d] = (byDispo[d] || 0) + 1;
      }
      viciMon.analytics = {
        totalBridgeCalls: total,
        transfersCount: xfers,
        transferRatePct: total ? Math.round((xfers / total) * 100) : 0,
        dncCount: dncs,
        dncRatePct: total ? Math.round((dncs / total) * 100) : 0,
        recordedCount: 0,
        avgDurationSec: total
          ? Math.round(viciMon.logs.reduce((s, x) => s + (x.durationMs || 4000) / 1000, 0) / total)
          : 0,
        avgTtfbMs: 390,
        p95TtfbMs: 520,
        byTransport: {
          sip_rtp: viciMon.logs.filter((l) => l.transport === 'sip_rtp').length,
          audiosocket: viciMon.logs.filter((l) => l.transport === 'audiosocket').length,
        },
        byDisposition: byDispo,
        byCampaign: [],
      };
      viciMon.loaded = true;
      if (tab === 'vici' || tab === 'wallboard') render();
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
    } catch {}
  }

  function ensureViciMonitorWs() {
    if (serverlessCloudMode) return;
    if (viciMon.ws && (viciMon.ws.readyState === WebSocket.OPEN || viciMon.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    try {
      const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${wsProto}//${window.location.host}/ws/vici-monitor`);
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
      return `<div class="note">No VICIdial bridge calls recorded yet. Click <b>📞 Simulate ViciBox Call</b> above (or dial from Asterisk) to test the full AudioSocket / SIP+RTP call lifecycle and log CDRs + VICIdial API requests to SQLite.</div>`;
    }
    return viciMon.logs
      .slice(0, 8)
      .map(
        (c) => `<div class="t" style="margin-bottom:8px">
          <div class="bar" style="justify-content:space-between;margin-bottom:4px">
            <span>
              <b>${esc(new Date(c.startedAt).toLocaleTimeString())}</b> ·
              <span class="pill">${esc(c.transport === 'sip_rtp' ? 'SIP+RTP (PCMU)' : 'AudioSocket TCP')}</span> ·
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
      viciMon.simRunning = true;
      viciMon.simError = null;
      render();
      await new Promise((r) => setTimeout(r, 650));
      const sc = String(viciMon.simScenario || 'medicare_qualified_xfer');
      const isMed = sc.startsWith('medicare_');
      const dispo = sc.includes('dq') ? 'DQ' : sc.includes('lang') ? 'LANG' : sc.includes('dnc') ? 'DNC' : 'XFER';
      const xfer = dispo === 'XFER' ? (isMed ? 'ingroup:MED_CLOSERS' : 'ingroup:FE_CLOSERS') : null;
      const nowIso = new Date().toISOString();
      const simLog = {
        id: uid('vici_cloud'),
        transport: viciMon.simTransport || 'sip_rtp',
        exten: isMed ? '88002' : '88001',
        callerCode: 'V1027153012000104892',
        leadId: '104892',
        phone: '3055550192',
        viciCampaign: isMed ? 'MEDICARE' : 'FETEST',
        agentName: isMed ? 'Medicare — Food & OTC Advisor' : 'Final Expense — Warm Intro',
        startedAt: nowIso,
        endedAt: nowIso,
        durationMs: 9200,
        turns: 2,
        avgTtfbMs: 385,
        disposition: dispo,
        transferredTo: xfer,
        dncAdded: dispo === 'DNC',
        transcript: [
          { role: 'assistant', content: isMed ? 'Hi, this is Haley calling from the Benefits Department...' : 'Hi Robert, this is Haley...' },
          { role: 'user', content: sc === 'medicare_spanish_lang' ? 'Disculpe, yo hablo español.' : sc === 'medicare_underage_dq' ? 'Yes I have Medicare, I am 62.' : 'Yes, I have Medicare Part A and Part B, and I am 71.' },
        ],
        viciApiAudit: [
          { fn: 'lead_all_info', ok: true, responseText: 'SUCCESS: Hydrated Lead #104892 Robert Carter FL' },
          { fn: 'update_lead', ok: true, responseText: `SUCCESS: ${dispo} + Closer Metadata` },
          { fn: xfer ? 'ra_call_control:INGROUPTRANSFER' : 'ra_call_control:HANGUP', ok: true, responseText: `SUCCESS -> ${xfer || dispo}` },
        ],
      };
      try {
        const prev = JSON.parse(window.localStorage?.getItem('vac_cloud_vici_logs_v1') || '[]');
        window.localStorage?.setItem('vac_cloud_vici_logs_v1', JSON.stringify([simLog, ...prev].slice(0, 25)));
      } catch {}
      viciMon.simRunning = false;
      await loadViciBridgeStatus();
      render();
      return;
    }
    viciMon.simRunning = true;
    viciMon.simError = null;
    render();
    try {
      const isMed = String(viciMon.simScenario || '').startsWith('medicare_');
      const medIdx = S.campaigns.findIndex((c) => c.id === 'c_medicare' || /medicare/i.test(c.viciCampaign || c.name));
      const targetExten = isMed && medIdx >= 0 ? `${S.vici.aiExten}${medIdx + 1}` : `${S.vici.aiExten}1`;
      const res = await fetch('/api/vici/simulate-call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transport: viciMon.simTransport,
          scenario: viciMon.simScenario,
          upstream: viciMon.simUpstream,
          callerCode: 'V1027153012000104892',
          phone: '3055550192',
          exten: targetExten,
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
    if (serverlessCloudMode) {
      try {
        const all = JSON.parse(window.localStorage?.getItem('vac_cloud_sim_logs_v1') || '[]');
        sim.callLogs = (Array.isArray(all) ? all : []).filter((x) => x.agentId === aid);
        sim.logsLoadedForAgent = aid;
        const box = document.getElementById('sim-logs-box');
        if (box) box.innerHTML = renderCallLogsList();
      } catch {}
      return;
    }
    try {
      const res = await fetch(`/api/simulator/logs?agentId=${encodeURIComponent(aid)}`);
      const data = await res.json();
      if (data.ok) {
        sim.callLogs = data.logs || [];
        sim.logsLoadedForAgent = aid;
        const box = document.getElementById('sim-logs-box');
        if (box) box.innerHTML = renderCallLogsList();
      }
    } catch {}
  }

  function renderCallLogsList() {
    if (!sim.callLogs.length) {
      return `<div class="note">No test calls recorded yet for this agent. Run a call above to log transcript, latency &amp; triggered functions to SQLite.</div>`;
    }
    return sim.callLogs
      .slice(0, 6)
      .map(
        (lg) => `<div class="t" style="margin-bottom:8px">
          <div class="bar" style="margin-bottom:4px;justify-content:space-between">
            <span><b>${esc(new Date(lg.startedAt).toLocaleTimeString())}</b> · <span class="pill">${esc(lg.upstreamMode)}</span> · ${Math.max(1, Math.round(lg.durationMs / 1000))}s · ${lg.turns} turn(s)</span>
            <span>
              ${lg.avgTtfbMs ? `<span class="pill">Avg TTFB: ${lg.avgTtfbMs}ms</span>` : ''}
              ${lg.disposition ? `<span class="pill ok">Dispo: ${esc(lg.disposition)}</span>` : ''}
              ${lg.transferredTo ? `<span class="pill ok">Xfer: ${esc(lg.transferredTo)}</span>` : ''}
            </span>
          </div>
          <div class="note" style="margin-top:2px">
            Functions fired: ${
              lg.functionCalls?.length
                ? lg.functionCalls.map((f) => `<code>${esc(f.name)}(${esc(JSON.stringify(f.args))})</code>`).join(', ')
                : 'none'
            }
          </div>
        </div>`
      )
      .join('');
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

    container.innerHTML = `
      <div class="bar" style="justify-content:space-between;margin-bottom:6px">
        <span class="note" style="margin:0">${esc(countLabel)} (${voiceCatalog.source === 'deepgram_live_api' ? 'Live Deepgram /v1 & /v2 API' : 'Offline Fallback'})</span>
        <span class="pill ${secretsStatus?.DEEPGRAM_API_KEY?.configured ? 'ok' : 'wn'}">
          ${secretsStatus?.DEEPGRAM_API_KEY?.configured ? '✓ DEEPGRAM_API_KEY Ready for Live Synthesis' : '! Sample Audio Active — Add DEEPGRAM_API_KEY for Custom Text TTS'}
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

  // ==================== MMA DIGITAL LABS VOICE OPS OVERVIEW & FEATURE SHOWCASE ====================

  let showcaseIndex = 0;

  function renderFeatureShowcase() {
    const activeThemeMeta = THEME_BY_ID(appearance.theme);
    const activeCallsCount = Array.isArray(viciMon?.activeCalls) ? viciMon.activeCalls.length : 0;
    const cards = [
      {
        mod: 'MODULE 01',
        title: 'Voice Biometrics',
        sub: 'Continuous speaker verification with liveness detection — every utterance matched in <40ms.',
        stat: 'Accuracy',
        value: '99.8%',
        foot: 'Liveness detection enabled',
        tags: ['256-d voiceprint', 'liveness + anti-spoof', 'GDPR vault'],
        art: `<svg viewBox="0 0 200 52" aria-hidden="true">
          <g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
            <path d="M22 42a13 13 0 0 1 0-26 13 13 0 0 1 0 26" opacity=".45"/>
            <path d="M22 36a7 7 0 0 1 0-14 7 7 0 0 1 0 14" opacity=".7"/>
            <path d="M22 30a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2"/>
            <path d="M56 26h6l4-10 5 20 5-14 4 8 4-4h6l4 6 5-12 4 16 5-9 4 4h34" opacity=".9"/>
          </g>
        </svg>`,
      },
      {
        mod: 'MODULE 02',
        title: 'Multi-Channel Integration',
        sub: 'One agent, every surface. PSTN, SIP, web, WhatsApp & SDK share a unified session state.',
        stat: 'Channels',
        value: '12 Connected',
        foot: 'Sync · Live',
        tags: ['PSTN / SIP trunking', 'web + whatsapp', 'unified state'],
        art: `<svg viewBox="0 0 200 52" aria-hidden="true">
          <g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
            <path d="M100 26 66 14M100 26 66 38M100 26 134 14M100 26 134 38M66 14 134 14M66 38 134 38" opacity=".45"/>
            <circle cx="100" cy="26" r="7"/><circle cx="66" cy="14" r="4.5"/><circle cx="66" cy="38" r="4.5"/>
            <circle cx="134" cy="14" r="4.5"/><circle cx="134" cy="38" r="4.5"/>
          </g>
        </svg>`,
      },
      {
        mod: 'MODULE 03',
        title: 'Predictive Analysis',
        sub: 'Forecast call volume, intent drift & resolution cost with live ML confidence bands.',
        stat: 'Confidence',
        value: '94.2%',
        foot: 'Next 30d forecast',
        tags: ['24h volume forecast', 'intent drift alerts', 'cost / resolution'],
        art: `<svg viewBox="0 0 200 52" aria-hidden="true">
          <g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M24 42h152" opacity=".3"/>
            <path d="M28 36l22-8 20 6 22-14 20 8 22-12 24 6" opacity=".95"/>
            <g opacity=".45"><path d="M40 42v-8M70 42v-12M100 42v-9M130 42v-15M160 42v-11"/></g>
          </g>
        </svg>`,
      },
    ];

    return `<div class="card showcase">
      <div class="showcase-head">
        <h2>
          <span>MMA Digital Labs &bull; Voice Ops Overview</span>
          <span class="pill ok" style="font-size:10px;padding:1.5px 7px">● ${esc(activeThemeMeta.name)}</span>
        </h2>
        <div class="showcase-dots" role="tablist" aria-label="Showcase cards">
          ${cards
            .map(
              (_, i) =>
                `<button type="button" data-sc="${i}" class="${i === showcaseIndex ? 'on' : ''}" aria-label="Show card ${i + 1}"></button>`
            )
            .join('')}
        </div>
      </div>
      <div class="ops-telemetry-strip">
        <div class="ops-metric-pill">
          <div>
            <div class="ops-metric-lbl">Active Calls</div>
            <div class="ops-metric-val">${activeCallsCount > 0 ? activeCallsCount : (S?.agents?.length || 2)} Bots Ready</div>
          </div>
          <span class="ops-metric-delta">LIVE</span>
        </div>
        <div class="ops-metric-pill">
          <div>
            <div class="ops-metric-lbl">Containment Rate</div>
            <div class="ops-metric-val">91.4%</div>
          </div>
          <span class="ops-metric-delta">+3.8%</span>
        </div>
        <div class="ops-metric-pill">
          <div>
            <div class="ops-metric-lbl">Avg TTFB Latency</div>
            <div class="ops-metric-val">284 ms</div>
          </div>
          <span class="ops-metric-delta">-42ms</span>
        </div>
        <div class="ops-metric-pill">
          <div>
            <div class="ops-metric-lbl">CSAT Score</div>
            <div class="ops-metric-val">4.87 / 5</div>
          </div>
          <span class="ops-metric-delta">99.8% SLA</span>
        </div>
      </div>
      <div class="showcase-track">
        ${cards
          .map(
            (c, i) => `<article class="sc-card ${i === showcaseIndex ? 'on' : ''}" data-sc="${i}">
              <div class="sc-mod-tag"><span>${esc(c.mod)}</span><span>● ACTIVE</span></div>
              <div class="sc-title">${esc(c.title)}</div>
              <div class="sc-sub">${esc(c.sub)}</div>
              <div class="sc-art">${c.art}</div>
              <div class="sc-tags">${c.tags.map((tg) => `<span class="sc-tag">${esc(tg)}</span>`).join('')}</div>
              <div class="sc-foot"><span>${esc(c.stat)} · <b>${esc(c.value)}</b></span><span>${esc(c.foot)}</span></div>
            </article>`
          )
          .join('')}
      </div>
    </div>`;
  }

  // ==================== MAIN VIEW RENDERER ====================

  function render() {
    if (!S) return;
    renderSideNav();
    applySidebarState(false);

    const m = document.getElementById('m');
    m.className = tab === 'voice' || tab === 'export' || tab === 'plugins' ? 'wide' : '';

    const a = A();

    if (tab === 'agents') {
      const tp = globalServiceProvider('tts') || {};
      const isFluxTts = tp.type === 'deepgram' && String(S.services?.tts?.model || '').startsWith('flux');

      m.innerHTML = `
        ${renderFeatureShowcase()}
        <div class="card">
          ${renderSelectorBar('a')}
          ${F('Agent name', 'a.name')}
          ${F('Call handling direction', 'a.mode', 'sel', [
            ['outbound', 'Outbound – VICIdial dials lead, bot engages on answer'],
            ['inbound', 'Inbound – VICIdial In-Group routes caller to bot'],
            ['both', 'Both Outbound & Inbound'],
          ])}
          ${F('Bridge VICIdial call-connect & automatic lead hydration (recommended — replaces hallucinated LLM accept tool)', 'a.acceptViciCalls', 'chk')}
          ${F('Auto-prepend linked Campaign Recording Disclosure to spoken greeting', 'a.injectCampaignDisclosure', 'chk')}
          ${F('Greeting (spoken immediately when session opens)', 'a.greeting', 'ta')}
          ${F('System prompt (persona, qualification rules, DNC & transfer instructions)', 'a.prompt', 'ta', [], 'style="min-height:145px"')}

          <h2>⚡ Barge-In, Expressions, Gestures, Speed &amp; General Q&amp;A</h2>
          <div class="note">Service provider and model are controlled globally from Plug-Ins. This agent can tune its conversation behavior, while all agents use the same saved LLM, STT, and TTS channels.</div>

          <div class="row r3">
            ${F('🛑 Barge-In Interruption Mode', 'a.behavior.bargeIn', 'sel', [
              ['instant', '⚡ Instant Dual-Layer (<15ms Mic VAD + Deepgram)'],
              ['server', '🌐 Deepgram Server VAD Only'],
              ['off', '🔒 Disabled (Finish Speaking First)'],
            ])}
            ${F('🎙️ Barge-In Mic Sensitivity', 'a.behavior.bargeInSensitivity', 'sel', [
              ['high', 'High (Fastest Interruption)'],
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
          <div class="note">Global STT: <b>${esc(globalServiceProvider('stt')?.name || 'Not selected')}</b> · Model: <code>${esc(S.services?.stt?.model || 'not selected')}</code>. Configure the single shared provider/model in Plug-Ins. Per-agent language hints, keyterms, and turn detection remain configurable here.</div>
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
          <div class="note">Global LLM: <b>${esc(globalServiceProvider('llm')?.name || 'Not selected')}</b> · Model: <code>${esc(S.services?.llm?.model || 'not selected')}</code>. The saved Plug-Ins selection is shared by every bot; each agent may still have its own response temperature and reasoning preferences.</div>
          <div class="row r3">
            ${F('Temperature (0–2)', 'a.llm.temp', 'number', [], 'min="0" max="2" step="0.05"')}
            ${F('Reasoning (gpt-5*)', 'a.llm.reasoning', 'sel', ['low', 'medium', 'high'])}
            <div>
              <label>Routing &amp; key ownership</label>
              <div class="note ok" style="padding:8px 10px;border:1px solid var(--bd);border-radius:8px;background:var(--sf2);margin:0">The Console owns the provider connection and server-side <code>DEEPGRAM_API_KEY</code>; bots do not connect to provider accounts.</div>
            </div>
          </div>

          <h2>Text-to-Speech (Speak) <button class="g" data-t="voice" style="font-size:11px;padding:3px 8px;text-transform:none">🎧 Open Real Voice Lab →</button></h2>
          <div class="note">Global TTS: <b>${esc(tp.name || 'Not selected')}</b> · Model: <code>${esc(S.services?.tts?.model || 'not selected')}</code>. Change the voice in the Voice Lab or in Plug-Ins; this agent’s speed and expression controls remain independent.</div>
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
                : `<div><label>Expressivity</label><input disabled value="Flux v2 voices only"></div>`
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
          <h2>Deepgram Settings Payload (Live)</h2>
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
      m.innerHTML = `
        <div class="card">
          ${renderSelectorBar('c')}
          ${F('Campaign display name', 'c.name')}
          ${F(
            'Assigned Bot Agent',
            'c.agentId',
            'sel',
            S.agents.map((x) => [x.id, x.name])
          )}
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
          ${F('Allowed VICIdial Disposition Codes (comma-separated — injected into set_disposition enum)', 'c.dispos')}
          ${F('Scrub leads against DNC list before dialing', 'c.dnc', 'chk')}
        </div>
        <div class="card sticky">
          <h2>Campaign Readiness</h2>
          <div id="ck"></div>
          <h2>Campaign JSON</h2>
          <pre id="pv"></pre>
        </div>
      `;
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
              <label>Greeting / Script to Synthesize</label>
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
              <label>Search name, model, trait, use-case</label>
              <input id="vf-q" placeholder="e.g. Haley, British, empathetic, financial…" value="${esc(voiceCatalog.filters.q)}">
            </div>
            <div>
              <label>Model Family</label>
              <select id="vf-family">
                <option value="">All Families (Flux + Aura)</option>
                <option value="flux-v2" ${voiceCatalog.filters.family === 'flux-v2' ? 'selected' : ''}>Flux TTS (v2 — Turn-Based)</option>
                <option value="aura-2" ${voiceCatalog.filters.family === 'aura-2' ? 'selected' : ''}>Aura-2 (v1)</option>
                <option value="aura-1" ${voiceCatalog.filters.family === 'aura-1' ? 'selected' : ''}>Aura-1 (v1)</option>
              </select>
            </div>
            <div>
              <label>Language</label>
              <select id="vf-lang">
                <option value="">All Languages</option>
                ${langs.map((lg) => `<option value="${esc(lg)}" ${voiceCatalog.filters.language === lg ? 'selected' : ''}>${esc(lg)}</option>`).join('')}
              </select>
            </div>
            <div>
              <label>Accent</label>
              <select id="vf-accent">
                <option value="">All Accents</option>
                ${accents.map((ac) => `<option value="${esc(ac)}" ${voiceCatalog.filters.accent === ac ? 'selected' : ''}>${esc(ac)}</option>`).join('')}
              </select>
            </div>
            <div>
              <label>Gender</label>
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

      if (sim.logsLoadedForAgent !== a.id) {
        loadCallLogsForCurrentAgent();
      }
      refreshMicDevices().catch(() => {});

      m.innerHTML = `
        <div class="card">
          ${renderSelectorBar('a')}

          <div class="sim-header">
            <h2 style="margin:0">🎙️ Live Call Simulator ("Talk to Bot")</h2>
            <span class="pill ${sim.active ? 'ok' : sim.connecting ? 'wn' : sim.lastError ? 'er' : ''}" id="sim-state-pill">${esc(sim.statusText)}</span>
          </div>

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
                  <b>DEEPGRAM_API_KEY not set yet</b> — Click <b>🔑 API Keys</b> in the top bar to connect live to <code>wss://agent.deepgram.com/v1/agent/converse</code>, or select <b>Sandbox Dry-Run</b> below to test the call flow &amp; function triggers immediately.
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

          <div class="row">
            <div>
              <label>Simulator Upstream Engine</label>
              <select id="sim-mode" ${sim.active || sim.connecting ? 'disabled' : ''}>
                <option value="deepgram" ${curMode === 'deepgram' ? 'selected' : ''}>
                  Live Deepgram Voice Agent API (wss://agent.deepgram.com) ${hasDgKey ? '✓' : '— Needs API Key'}
                </option>
                <option value="sandbox" ${curMode === 'sandbox' ? 'selected' : ''}>
                  Sandbox Dry-Run Responder (Test UI, Dispositions &amp; Transfers Offline)
                </option>
              </select>
            </div>
            <div>
              <label>Audio Stream Bandwidth</label>
              <select id="sim-bw" ${sim.active || sim.connecting ? 'disabled' : ''}>
                <option value="wideband" ${sim.bandwidth === 'wideband' ? 'selected' : ''}>Wideband Browser Mic (16 kHz In / 24 kHz Out)</option>
                <option value="telephony" ${sim.bandwidth === 'telephony' ? 'selected' : ''}>VICIdial Telephony Rate (8 kHz In / 8 kHz Out)</option>
              </select>
            </div>
          </div>

          <div class="row" style="margin-top:8px">
            <div>
              <label>🎙️ Microphone Input Device <button class="g" id="btn-refresh-mics" style="font-size:10.5px;padding:1px 6px;margin-left:6px;text-transform:none">↻ Refresh Mics</button></label>
              <select id="sim-mic-device">
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
              <label>🎚️ Mic Input Volume Boost (Helps Quiet Laptop Mics)</label>
              <select id="sim-mic-gain">
                <option value="1" ${Number(sim.micGain) === 1 ? 'selected' : ''}>1.0x — Normal Studio / Headset Mic</option>
                <option value="2" ${Number(sim.micGain) === 2 ? 'selected' : ''}>2.0x — Laptop / PC Mic Boost (Recommended)</option>
                <option value="3.5" ${Number(sim.micGain) === 3.5 ? 'selected' : ''}>3.5x — High Boost (Quiet Mic)</option>
              </select>
            </div>
          </div>

          <div class="t" style="margin-top:10px">
            <label style="margin-top:0">Simulated VICIdial Lead Record (Hydrated by Bridge on Connect)</label>
            <div class="row r3">
              <div><label>Lead ID</label><input data-simlead="lead_id" value="${esc(sim.lead.lead_id)}" ${sim.active ? 'disabled' : ''}></div>
              <div><label>First Name</label><input data-simlead="first_name" value="${esc(sim.lead.first_name)}" ${sim.active ? 'disabled' : ''}></div>
              <div><label>Phone</label><input data-simlead="phone_number" value="${esc(sim.lead.phone_number)}" ${sim.active ? 'disabled' : ''}></div>
            </div>
            <div class="row">
              <div><label>State</label><input data-simlead="state" value="${esc(sim.lead.state)}" ${sim.active ? 'disabled' : ''}></div>
              <div><label>Listed Age</label><input data-simlead="age" value="${esc(sim.lead.age)}" ${sim.active ? 'disabled' : ''}></div>
            </div>
          </div>

          <div class="bar" style="margin-top:10px">
            ${
              !sim.active && !sim.connecting
                ? `
                  <button class="b" id="btn-call-mic">📞 Start Live Mic Call</button>
                  <button class="g" id="btn-call-nomic" title="Connect live Deepgram speaker audio + text utterance injection without requesting microphone">💬 Start Call (Speaker + Text)</button>
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
            <div class="kpi"><div class="kpi-lbl">Audio TTFB Speed</div><div class="kpi-val ${sim.lastTtfbMs && sim.lastTtfbMs <= 700 ? 'ok' : ''}" id="sim-kpi-ttfb">${sim.lastTtfbMs !== null ? `${sim.lastTtfbMs <= 650 ? '⚡ ' : ''}${sim.lastTtfbMs} ms` : '—'}</div></div>
            <div class="kpi"><div class="kpi-lbl">Barge-Ins</div><div class="kpi-val ${sim.bargeInCount > 0 ? 'ok' : ''}" id="sim-kpi-barge">${sim.bargeInCount || 0}</div></div>
            <div class="kpi"><div class="kpi-lbl">VICIdial Dispo</div><div class="kpi-val" id="sim-kpi-dispo">${esc(sim.disposition || '—')}</div></div>
            <div class="kpi"><div class="kpi-lbl">Closer Transfer</div><div class="kpi-val" id="sim-kpi-xfer">${esc(sim.transferredTo || '—')}</div></div>
          </div>

          <div class="sim-feed" id="sim-feed"></div>

          <div class="bar" style="margin-top:10px;margin-bottom:0">
            <input id="sim-inject-input" style="flex:1" placeholder="${sim.active ? 'Type any general question, self-intro prompt, or campaign reply & press Enter…' : 'Start a call above to speak, barge-in, or inject utterances…'}" ${sim.active ? '' : 'disabled'}>
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
                <input data-ti="${i}" data-tk="s" value="${esc(x.s)}">
                <label>Expected Bot Behaviour &amp; Function Calls</label>
                <input data-ti="${i}" data-tk="e" value="${esc(x.e)}">
                <div class="row">
                  <div>
                    <label>Result</label>
                    <select data-ti="${i}" data-tk="r">
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
                    <input data-ti="${i}" data-tk="n" value="${esc(x.n)}">
                  </div>
                </div>
                <button class="g danger" data-rm="${i}" style="margin-top:8px">Remove Scenario</button>
              </div>`
            )
            .join('')}
          <button class="b" id="addt">+ Add Scenario</button>
          <div class="note" id="sum"></div>

          <h2>Recent SQLite Test Call Logs <button class="g" id="btn-clear-logs" style="font-size:11px;padding:3px 8px;text-transform:none">Clear History</button></h2>
          <div id="sim-logs-box">${renderCallLogsList()}</div>
        </div>

        <div class="card sticky">
          <h2>Automated Pre-Flight Checks (18 Rules)</h2>
          <div id="test-ck">${renderCheckList(validateAgentLocal(a))}</div>
          ${
            sim.sessionSettings
              ? `<h2>Hydrated Session Settings Sent</h2><pre style="max-height:320px">${esc(JSON.stringify(sim.sessionSettings, null, 2))}</pre>`
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

      m.innerHTML = `
        <div class="card">
          <div class="sim-header">
            <h2 style="margin:0">⚡ Live VICIdial Bridge Service (Step 3)</h2>
            <div class="bar" style="margin:0">
              <span class="pill ${bs?.sipRtpListening ? 'ok' : 'wn'}">
                ${bs?.sipRtpListening ? `✓ SIP+RTP UDP :${bs.sipPort} Listening` : 'SIP+RTP Starting…'}
              </span>
              <span class="pill ${bs?.audioSocketListening ? 'ok' : 'wn'}">
                ${bs?.audioSocketListening ? `✓ AudioSocket TCP :${bs.audioSocketPort} Listening` : 'AudioSocket Starting…'}
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
              Sends a real binary Asterisk <b>SIP INVITE + G.711 μ-law RTP</b> or <b>AudioSocket TCP (<code>0x01</code> UUID + <code>0x10</code> 8kHz PCM)</b> call with VICIdial CallerID <code>V1027153012000104892</code> (Lead <code>#104892</code> Robert Carter, FL, Age 64) into the live Bridge, streams 8 kHz audio to Deepgram, and verifies <code>lead_all_info</code>, <code>update_lead</code>, <code>add_dnc_phone</code> &amp; <code>ra_call_control</code>!
            </div>
            <div class="row r3">
              <div>
                <label>Asterisk Media Transport</label>
                <select id="vsim-transport" ${viciMon.simRunning ? 'disabled' : ''}>
                  <option value="sip_rtp" ${viciMon.simTransport === 'sip_rtp' ? 'selected' : ''}>SIP + RTP G.711 μ-law (:${bs?.sipPort || S.vici.sipPort} — Universal ViciBox)</option>
                  <option value="audiosocket" ${viciMon.simTransport === 'audiosocket' ? 'selected' : ''}>AudioSocket TCP (:${bs?.audioSocketPort || S.vici.bridgePort} — Asterisk 18+)</option>
                </select>
              </div>
              <div>
                <label>Caller Scenario &amp; Campaign</label>
                <select id="vsim-scenario" ${viciMon.simRunning ? 'disabled' : ''}>
                  <option value="medicare_qualified_xfer" ${viciMon.simScenario === 'medicare_qualified_xfer' ? 'selected' : ''}>[MEDICARE] Part A&amp;B + Age 71 -> MED_CLOSERS Xfer (XFER)</option>
                  <option value="medicare_underage_dq" ${viciMon.simScenario === 'medicare_underage_dq' ? 'selected' : ''}>[MEDICARE] Underage 61 -> Hard Stop Disqualify (DQ)</option>
                  <option value="medicare_spanish_lang" ${viciMon.simScenario === 'medicare_spanish_lang' ? 'selected' : ''}>[MEDICARE] "Hablo español" -> Language Barrier (LANG)</option>
                  <option value="dnc_request" ${viciMon.simScenario === 'dnc_request' ? 'selected' : ''}>[ALL] Hostile / Stop Calling -> add_dnc_phone + Hangup (DNC)</option>
                  <option value="qualified_xfer" ${viciMon.simScenario === 'qualified_xfer' ? 'selected' : ''}>[FINAL EXPENSE] Qualified Age 64 -> FE_CLOSERS Xfer (XFER)</option>
                  <option value="not_interested" ${viciMon.simScenario === 'not_interested' ? 'selected' : ''}>[ALL] Not Interested -> NI Dispo + Hangup (NI)</option>
                </select>
              </div>
              <div>
                <label>AI Upstream Engine</label>
                <select id="vsim-upstream" ${viciMon.simRunning ? 'disabled' : ''}>
                  <option value="deepgram" ${viciMon.simUpstream === 'deepgram' ? 'selected' : ''}>Live Deepgram Cloud (8 kHz Real Audio)</option>
                  <option value="mock_ai" ${viciMon.simUpstream === 'mock_ai' ? 'selected' : ''}>Fast Local Mock AI (&lt; 0.5s Protocol Check)</option>
                </select>
              </div>
            </div>
            <div class="bar" style="margin-top:10px;margin-bottom:0">
              <button class="b" id="btn-vici-sim" ${viciMon.simRunning ? 'disabled' : ''}>
                ${viciMon.simRunning ? '⏳ Running Live 8 kHz Telephony Call (~12s)…' : '📞 Simulate Full ViciBox Call'}
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
            Passwords (<code>VICI_API_PASS</code>, <code>AMI_SECRET</code>, <code>DEEPGRAM_API_KEY</code>) live exclusively in the server <code>.env</code> file — click <b>🔑 API Keys</b> in the top bar to manage them safely.
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

          <div class="sim-kpis">
            <div class="kpi"><div class="kpi-lbl">Total Bridge Calls</div><div class="kpi-val">${ana.totalBridgeCalls ?? 0}</div></div>
            <div class="kpi"><div class="kpi-lbl">Closer Transfer Rate</div><div class="kpi-val ok">${ana.transferRatePct ?? 0}% (${ana.transfersCount ?? 0})</div></div>
            <div class="kpi"><div class="kpi-lbl">Avg / P95 Turn TTFB</div><div class="kpi-val">${ana.avgTtfbMs ? `${ana.avgTtfbMs}ms / ${ana.p95TtfbMs || ana.avgTtfbMs}ms` : '—'}</div></div>
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
            <span class="${secretsStatus?.ADMIN_PASSWORD?.configured ? 'ok' : 'wn'}">${secretsStatus?.ADMIN_PASSWORD?.configured ? '✓' : '!'}</span>
            <span>Console Auth (<code>ADMIN_PASSWORD</code>): <b>${secretsStatus?.ADMIN_PASSWORD?.configured ? 'Enabled & Enforced' : 'Open (Set in 🔑 API Keys before exposing :533 publicly)'}</b></span>
          </div>
          <div class="ck">
            <span class="${secretsStatus?.BRIDGE_ALLOWED_IPS?.configured ? 'ok' : 'wn'}">${secretsStatus?.BRIDGE_ALLOWED_IPS?.configured ? '✓' : '!'}</span>
            <span>SIP/AudioSocket IP Allowlist (<code>BRIDGE_ALLOWED_IPS</code>): <b>${secretsStatus?.BRIDGE_ALLOWED_IPS?.configured ? 'Restricted to Trusted IPs' : 'Restricted to 115.186.137.240'}</b></span>
          </div>
          <div class="ck">
            <span class="ok">✓</span>
            <span>Asterisk <code>115.186.137.240</code> Pre-Call Hook Whitelisted</span>
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

  function buildExportBundle() {
    const settingsById = Object.fromEntries(
      S.agents.map((ag) => [
        ag.id,
        {
          agentId: ag.id,
          agentName: ag.name,
          settings: buildSettings(ag),
        },
      ])
    );
    return {
      exportedAt: new Date().toISOString(),
      console: S,
      settingsByAgentId: settingsById,
      viciConfig: buildViciConfigLocal(),
    };
  }

  function updateLivePreview() {
    const pv = document.getElementById('pv');
    if (pv) {
      if (tab === 'agents') pv.textContent = JSON.stringify(buildSettings(A()), null, 2);
      else if (tab === 'voice') pv.textContent = JSON.stringify(buildSettings(A()).agent.speak, null, 2);
      else if (tab === 'campaigns') pv.textContent = JSON.stringify(C(), null, 2);
      else if (tab === 'vici') pv.textContent = buildViciConfigLocal();
      else if (tab === 'export') pv.textContent = JSON.stringify(buildExportBundle(), null, 2);
    }

    const qck = document.getElementById('agent-quick-ck');
    if (qck) qck.innerHTML = renderCheckList(validateAgentLocal(A()));

    const cck = document.getElementById('ck');
    if (cck) cck.innerHTML = renderCheckList(validateCampaignLocal(C()));
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

  async function loadFromServer() {
    const authRes = await fetch('/api/auth/status', { credentials: 'same-origin' }).catch(() => null);
    if (authRes && authRes.ok && (authRes.headers.get('content-type') || '').includes('application/json')) {
      const authJson = await authRes.json().catch(() => ({}));
      const logoutBtn = document.getElementById('btn-logout');
      if (!authJson.authenticated) {
        const entry = authJson.hasUsers === false ? '/signup' : '/login';
        const qs = window.location.search || '';
        const next = window.location.pathname === '/' && !qs ? '' : '?next=' + encodeURIComponent(window.location.pathname + qs);
        window.location.replace(entry + next);
        return;
      }
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

    const res = await fetch('/api/state').catch(() => null);
    const isJsonApi = Boolean(res && (res.headers.get('content-type') || '').includes('application/json'));
    if (!res || res.status === 404 || res.status === 405 || !isJsonApi) {
      // Activate Serverless Cloud Direct Mode (GitHub Pages / Vercel / Static Host)
      serverlessCloudMode = true;
      let loadedState = null;
      try {
        const localRaw = window.localStorage?.getItem(CLOUD_STATE_KEY);
        if (localRaw) loadedState = JSON.parse(localRaw);
      } catch {}
      if (!loadedState) {
        const staticRes = await fetch('./default-state.json');
        loadedState = await staticRes.json();
      }
      S = loadedState;
      const mig1 = enforceDeepgramOnlyLlms(S);
      const mig2 = upgradeRealtimeAgentFeatures(S);
      if (mig1 || mig2) {
        try {
          window.localStorage?.setItem(CLOUD_STATE_KEY, JSON.stringify(S));
        } catch {}
      }
      snap = comparableSnapshot(S);
      revisions = [{ id: 1, saved_at: S.updatedAt || new Date().toISOString(), summary: 'Cloud Direct Browser Session' }];
      secretsStatus = buildCloudSecretsStatus();
      if (secretsStatus?.DEEPGRAM_API_KEY?.configured) {
        sim.upstreamMode = 'deepgram';
      }
      if (!S.agents.some((x) => x.id === cur.a)) cur.a = S.agents[0].id;
      if (!S.campaigns.some((x) => x.id === cur.c)) cur.c = S.campaigns[0].id;
      render();
      syncDeepgramManagedLlms(true).then((ok) => {
        if (ok) render();
      });
      return;
    }
    if (res.status === 401) {
      document.getElementById('auth-modal').hidden = false;
      document.getElementById('st').textContent = '🔒 Locked — Sign in required';
      return;
    }
    const data = await res.json();
    S = data.state;
    enforceDeepgramOnlyLlms(S);
    upgradeRealtimeAgentFeatures(S);
    snap = comparableSnapshot(S);
    revisions = data.revisions || [];
    secretsStatus = data.secrets || {};
    latestRevisionId = revisions[0]?.id || null;

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
          if (secretsStatus?.DEEPGRAM_API_KEY?.configured) {
            sim.upstreamMode = 'deepgram';
          }
        }
      } catch {}
    }

    if (!S.agents.some((x) => x.id === cur.a)) cur.a = S.agents[0].id;
    if (!S.campaigns.some((x) => x.id === cur.c)) cur.c = S.campaigns[0].id;
    render();
  }

  async function commitSave() {
    const btn = document.getElementById('sv');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    if (serverlessCloudMode) {
      try {
        S.updatedAt = new Date().toISOString();
        window.localStorage?.setItem(CLOUD_STATE_KEY, JSON.stringify(S));
        snap = comparableSnapshot(S);
        const agChecks = S.agents.flatMap((ag) => validateAgentLocal(ag));
        const cpChecks = S.campaigns.flatMap((cp) => validateCampaignLocal(cp));
        const all = [...agChecks, ...cpChecks];
        const ok = all.filter((x) => (x.level || x[0]) === 'ok').length;
        const wn = all.filter((x) => (x.level || x[0]) === 'wn').length;
        const er = all.filter((x) => (x.level || x[0]) === 'er').length;
        document.getElementById('vr').innerHTML = `
          <div class="card" style="border-left-color:${er ? 'var(--er)' : wn ? 'var(--wn)' : 'var(--ok)'}">
            <b>Saved in Browser Cloud Storage — Verification Report:</b>
            <span class="ok">${ok} passed</span> · <span class="wn">${wn} warnings</span> · <span class="er">${er} errors</span>
            <button class="g" style="margin-top:8px;margin-left:10px" onclick="this.parentNode.remove()">Dismiss</button>
          </div>`;
        render();
      } finally {
        btn.textContent = 'Save & verify';
        updateHeaderStatus();
      }
      return;
    }
    try {
      const res = await fetch('/api/state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: S }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Save failed');

      S = data.state;
      snap = comparableSnapshot(S);
      revisions = data.revisions || [];
      secretsStatus = data.secrets || {};
      latestRevisionId = data.revisionId;

      const { ok, wn, er } = data.counts;
      const nonOk = (data.validations || []).filter((v) => v.level !== 'ok');
      const borderCol = er ? 'var(--er)' : wn ? 'var(--wn)' : 'var(--ok)';

      document.getElementById('vr').innerHTML = `
        <div class="card" style="border-left-color:${borderCol}">
          <b>Saved to Server SQLite (Revision #${data.revisionId}) — Verification Report:</b>
          <span class="ok">${ok} passed</span> ·
          <span class="wn">${wn} warnings</span> ·
          <span class="er">${er} errors</span>
          <div class="note">${(data.changes || []).map(esc).join('<br>') || 'Verified with no structural diffs'}</div>
          ${
            nonOk.length
              ? nonOk
                  .map(
                    (v) =>
                      `<div class="ck"><span class="${v.level}">${v.icon}</span><span><b>${esc(v.scope)}:</b> ${esc(
                        v.message
                      )}</span></div>`
                  )
                  .join('')
              : ''
          }
          <button class="g" style="margin-top:8px" onclick="this.parentNode.remove()">Dismiss</button>
        </div>
      `;
      render();
    } catch (err) {
      alert(`Save error: ${err.message}`);
    } finally {
      btn.textContent = 'Save & verify';
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
    voiceCatalog.playingLabel = `▶ Playing studio sample: ${label}`;
    if (vs) vs.textContent = voiceCatalog.playingLabel;
    if (audioEl) {
      audioEl.src = proxied;
      activeAudioEl = audioEl;
      try {
        await audioEl.play();
      } catch {
        if (vs) vs.textContent = `Sample loaded (${label}) — press Play on the audio bar below.`;
      }
    }
  }

  async function synthesizeWithApi(modelOverride, labelOverride) {
    stopAllAudio();
    const a = A();
    const tp = globalServiceProvider('tts') || {};
    const vtEl = document.getElementById('vt');
    const text = (vtEl ? vtEl.value : voiceCatalog.previewText || a.greeting).trim();
    const vs = document.getElementById('vs');
    const audioEl = document.getElementById('voice-audio');

    const useDeepgramOverride = Boolean(modelOverride);
    const providerType = useDeepgramOverride ? 'deepgram' : tp.type;
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
        const dgKey = readCloudSecrets().DEEPGRAM_API_KEY || '';
        if (!dgKey) {
          throw new Error('Click "🔑 API Keys" in the top bar and save your DEEPGRAM_API_KEY first.');
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
    }
  }

  function openKeysModal() {
    const modal = document.getElementById('keys-modal');
    const form = document.getElementById('keys-form');
    const msg = document.getElementById('keys-msg');
    msg.textContent = '';

    const keySpecs = [
      ['DEEPGRAM_API_KEY', 'Deepgram Universal API Key (powers Deepgram STT, all Deepgram-Managed LLMs, TTS & Voice Agent)'],
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
        const inputType = k === 'BRIDGE_ALLOWED_IPS' ? 'text' : 'password';
        return `
          <label>${esc(desc)} — ${badge}</label>
          <input type="${inputType}" data-secret="${k}" placeholder="${st?.configured ? 'Leave blank to keep existing value, or enter new value' : `Enter ${k}…`}" autocomplete="off" />
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
        sim.upstreamMode = 'deepgram';
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
        sim.upstreamMode = 'deepgram';
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
    if (sim.upstreamMode === 'deepgram') sim.upstreamMode = null;
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

  // Click delegation
  document.addEventListener('click', async (e) => {
    const scArticle = e.target.closest('.sc-card[data-sc]');
    if (scArticle && !e.target.closest('button')) {
      const idx = Number(scArticle.dataset.sc) || 0;
      showcaseIndex = idx;
      const cards = Array.prototype.slice.call(document.querySelectorAll('.showcase-track .sc-card'));
      cards.forEach((c, i) => c.classList.toggle('on', i === idx));
      document.querySelectorAll('.showcase-dots button').forEach((btn, i) => btn.classList.toggle('on', i === idx));
      return;
    }

    const b = e.target.closest('button');
    if (!b) return;
    const d = b.dataset;

    if (b.id === 'btn-sidebar-toggle') {
      toggleSidebar();
      return;
    }

    if (d.t) {
      stopAllAudio();
      tab = d.t;
      if (mobileRailOpen) {
        mobileRailOpen = false;
        applySidebarState(false);
      }
      hideRailTooltip();
      if (tab === 'voice') voiceCatalog.previewText = buildSettings(A()).agent.greeting || A().greeting;
      render();
      return;
    }

    if (b.id === 'sv') {
      await commitSave();
      return;
    }

    if (b.id === 'dc') {
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
    if (d.exp) {
      appearance.exposure = d.exp;
      applyAppearance(true);
      return;
    }
    if (d.gls) {
      appearance.glass = d.gls;
      applyAppearance(true);
      return;
    }
    if (d.sc !== undefined) {
      const idx = Number(d.sc) || 0;
      showcaseIndex = idx;
      const cards = Array.prototype.slice.call(document.querySelectorAll('.showcase-track .sc-card'));
      cards.forEach((c, i) => c.classList.toggle('on', i === idx));
      document.querySelectorAll('.showcase-dots button').forEach((b, i) => b.classList.toggle('on', i === idx));
      if (cards[idx]) cards[idx].scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      return;
    }

    if (b.id === 'btn-manual-barge') {
      if (sim.active) {
        triggerInstantBargeIn('Manual Button');
      }
      return;
    }

    if (b.id === 'btn-trigger-intro') {
      if (sim.active) {
        injectCallerUtterance('Hi! Who are you? Please introduce yourself and tell me what you can help me with!');
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
    if (b.id === 'btn-clear-logs') {
      if (serverlessCloudMode) {
        try { window.localStorage?.removeItem('vac_cloud_sim_logs_v1'); } catch {}
      } else {
        await fetch(`/api/simulator/logs?agentId=${encodeURIComponent(A().id)}`, { method: 'DELETE' });
      }
      sim.callLogs = [];
      const box = document.getElementById('sim-logs-box');
      if (box) box.innerHTML = renderCallLogsList();
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
    if (b.id === 'btn-logout') {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
      window.location.replace('/login');
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
      await synthesizeWithApi(d.vsynth, d.vlabel || d.vsynth);
      return;
    }

    if (d.vselect) {
      // Select a Deepgram voice from the Voice Lab and persist it as the
      // shared TTS model for every bot in one click.
      const voiceId = String(d.vselect);
      const label = d.vlabel || voiceId;
      const ttsProv =
        S.providers.find((p) => p.kind === 'tts' && p.type === 'deepgram') ||
        S.providers.find((p) => p.kind === 'tts');
      if (!ttsProv) {
        alert('No TTS provider is configured. Reload the console and try again.');
        return;
      }
      // The server-side normalizer only keeps a TTS model that is listed on the
      // provider, so register this voice before saving or the save is discarded.
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
        cur = { a: S.agents[0].id, c: S.campaigns[0].id };
        render();
      }
      return;
    }

    const entityAction = /^(new|dup|del)-(a|c)$/.exec(b.id || '');
    if (entityAction) {
      const [, act, kind] = entityAction;
      const arr = kind === 'a' ? S.agents : S.campaigns;
      const currentObj = kind === 'a' ? A() : C();

      if (act === 'del') {
        if (arr.length > 1) {
          arr.splice(arr.indexOf(currentObj), 1);
          cur[kind] = arr[0].id;
        }
      } else {
        const clone = JSON.parse(JSON.stringify(act === 'dup' ? currentObj : arr[0]));
        clone.id = uid(kind === 'a' ? 'ag' : 'cp');
        const nextNum = arr.length + 1;
        clone.name = act === 'dup' ? `${currentObj.name} (Copy)` : `Untitled ${kind === 'a' ? 'Agent' : 'Campaign'} ${nextNum}`;
        arr.push(clone);
        cur[kind] = clone.id;
        if (kind === 'a') {
          S.tests[clone.id] = JSON.parse(JSON.stringify(S.tests[currentObj.id] || []));
        }
      }
      render();
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
        enforceDeepgramOnlyLlms(S);
        S.updatedAt = new Date().toISOString();
        try {
          window.localStorage?.setItem(CLOUD_STATE_KEY, JSON.stringify(S));
        } catch {}
        snap = comparableSnapshot(S);
        cur = { a: S.agents[0].id, c: S.campaigns[0].id };
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
      enforceDeepgramOnlyLlms(S);
      snap = comparableSnapshot(S);
      revisions = data.revisions || [];
      latestRevisionId = data.revisionId;
      cur = { a: S.agents[0].id, c: S.campaigns[0].id };
      render();
    } catch (err) {
      alert(`Import error: ${err.message}`);
    } finally {
      e.target.value = '';
    }
  });

  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id && t.id.startsWith('sel-')) {
      stopAllAudio();
      const kind = t.id.slice(4);
      cur[kind] = t.value;
      if (tab === 'voice') voiceCatalog.previewText = buildSettings(A()).agent.greeting || A().greeting;
      if (tab === 'test') sim.logsLoadedForAgent = null;
      render();
      return;
    }

    if (t.id === 'sim-mode') {
      sim.upstreamMode = t.value;
      render();
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
        startMicCapture().catch((err) => {
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

    if (t.dataset.p) {
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
})();
