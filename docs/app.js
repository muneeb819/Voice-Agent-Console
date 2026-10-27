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

  let tab = 'agents';
  let cur = { a: 'a_medicare', c: 'c_medicare' };

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

  // ==================== ELITE MULTI-THEME & APPEARANCE ENGINE ====================
  const APPEARANCE_THEMES = [
    {
      id: 'obsidian',
      name: 'Obsidian Nebula',
      short: 'Obsidian',
      sub: 'Deep Space Indigo & Violet Studio',
      bg: 'linear-gradient(135deg, #060913 0%, #151d36 100%)',
      bar: 'linear-gradient(90deg, #4f46e5, #a855f7, #0ea5e9)',
      dots: ['#6366f1', '#a855f7', '#34d399'],
    },
    {
      id: 'emerald',
      name: 'Cyber Emerald',
      short: 'Emerald',
      sub: 'Carbon Matrix & Neon Mint Ops',
      bg: 'linear-gradient(135deg, #040b09 0%, #0e261f 100%)',
      bar: 'linear-gradient(90deg, #10b981, #06b6d4)',
      dots: ['#10b981', '#06b6d4', '#4ade80'],
    },
    {
      id: 'aurora',
      name: 'Arctic Aurora',
      short: 'Aurora',
      sub: 'Midnight Ocean & Glacial Cyan',
      bg: 'linear-gradient(135deg, #030b17 0%, #0f2948 100%)',
      bar: 'linear-gradient(90deg, #0284c7, #0ea5e9, #2dd4bf)',
      dots: ['#0ea5e9', '#2dd4bf', '#818cf8'],
    },
    {
      id: 'crimson',
      name: 'Crimson Gold Luxe',
      short: 'Crimson',
      sub: 'Espresso Onyx, Molten Gold & Rose',
      bg: 'linear-gradient(135deg, #0c0807 0%, #2a1815 100%)',
      bar: 'linear-gradient(90deg, #f59e0b, #ea580c, #e11d48)',
      dots: ['#f59e0b', '#f43f5e', '#34d399'],
    },
    {
      id: 'pearl',
      name: 'Pearl Daylight',
      short: 'Daylight',
      sub: 'Pure Alabaster & Royal Sapphire (Light)',
      bg: 'linear-gradient(135deg, #ffffff 0%, #e8eef9 100%)',
      bar: 'linear-gradient(90deg, #4f46e5, #2563eb, #0284c7)',
      dots: ['#4f46e5', '#0284c7', '#059669'],
    },
    {
      id: 'sakura',
      name: 'Sakura Ivory',
      short: 'Sakura',
      sub: 'Warm Cream & Rose-Quartz (Light)',
      bg: 'linear-gradient(135deg, #ffffff 0%, #fce8ef 100%)',
      bar: 'linear-gradient(90deg, #e11d48, #db2777, #9333ea)',
      dots: ['#e11d48', '#9333ea', '#059669'],
    },
  ];

  let appearance = (() => {
    try {
      const saved = JSON.parse(window.localStorage?.getItem(APPEARANCE_STORAGE_KEY) || '{}');
      return {
        theme: APPEARANCE_THEMES.some((t) => t.id === saved.theme) ? saved.theme : 'obsidian',
        exposure: ['minimal', 'studio', 'cinema'].includes(saved.exposure) ? saved.exposure : 'studio',
        glass: ['solid', 'frosted', 'crystal'].includes(saved.glass) ? saved.glass : 'frosted',
      };
    } catch {
      return { theme: 'obsidian', exposure: 'studio', glass: 'frosted' };
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
      } catch {}
    }
    const meta = APPEARANCE_THEMES.find((t) => t.id === appearance.theme) || APPEARANCE_THEMES[0];
    const lbl = document.getElementById('theme-active-lbl');
    if (lbl) lbl.textContent = meta.short;
    renderThemeStudioControls();
  }

  function renderThemeStudioControls() {
    const grid = document.getElementById('theme-swatch-grid');
    if (grid) {
      grid.innerHTML = APPEARANCE_THEMES.map(
        (t) => `
          <button type="button" class="theme-card ${appearance.theme === t.id ? 'on' : ''}" data-pick-theme="${t.id}">
            <div class="theme-preview" style="background:${t.bg}">
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

  const A = () => S.agents.find((x) => x.id === cur.a) || S.agents[0];
  const C = () => S.campaigns.find((x) => x.id === cur.c) || S.campaigns[0];
  const prov = (id) => S.providers.find((x) => x.id === id);

  const rootRefs = () => ({ a: A(), c: C(), v: S.vici, p: S.providers, f: S.functions });

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
    btnKeys.innerHTML = dgKey ? '🔑 API Keys <span class="ok">●</span>' : '🔑 API Keys <span class="wn">!</span>';

    const btnNewTab = document.getElementById('btn-newtab');
    if (btnNewTab) {
      btnNewTab.href = window.location.href;
      btnNewTab.style.display = isInIframe ? 'inline-flex' : 'none';
    }
  }

  function buildSettings(agent) {
    const sp = prov(agent.stt.p) || {};
    const lp = prov(agent.llm.p) || {};
    const tp = prov(agent.tts.p) || {};
    const linkedCampaign = S.campaigns.find((c) => c.agentId === agent.id);

    const listenProvider = { type: sp.type || 'deepgram', model: agent.stt.model };
    if (listenProvider.type === 'deepgram') {
      if (agent.stt.model.startsWith('flux')) {
        listenProvider.version = 'v2';
        listenProvider.eot_threshold = Number(agent.stt.eot);
        listenProvider.eager_eot_threshold = Number(agent.stt.eager);
        listenProvider.eot_timeout_ms = Math.round(Number(agent.stt.eotms));
        if (agent.stt.model === 'flux-general-multi' && agent.language) {
          listenProvider.language_hints = agent.language.split(',').map((s) => s.trim()).filter(Boolean);
        }
      } else {
        listenProvider.version = 'v1';
        if (agent.language) listenProvider.language = agent.language;
        if (agent.stt.smartFormat) listenProvider.smart_format = true;
      }
      const kt = (agent.stt.keyterms || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (kt.length) listenProvider.keyterms = kt;
    }
    const spEx = parseJsonObject(sp.extra);
    if (spEx.ok) Object.assign(listenProvider, spEx.value);

    const isGoogleByo = lp.type === 'google' && Boolean((lp.endpoint || '').trim());
    const thinkProvider = { type: lp.type || 'open_ai' };
    if (!isGoogleByo) thinkProvider.model = agent.llm.model;
    if (lp.type === 'open_ai' && /^gpt-5/.test(agent.llm.model)) {
      thinkProvider.reasoning_mode = agent.llm.reasoning;
    } else {
      thinkProvider.temperature = Number(agent.llm.temp);
    }
    const lpEx = parseJsonObject(lp.extra);
    if (lpEx.ok) Object.assign(thinkProvider, lpEx.value);

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

    const think = { provider: thinkProvider, prompt: agent.prompt, functions: fns };
    if ((lp.endpoint || '').trim()) {
      const lh = parseJsonObject(lp.headers);
      think.endpoint = { url: lp.endpoint.trim(), headers: lh.ok ? lh.value : {} };
      if (String(agent.llm.ctx || '').trim()) {
        const raw = String(agent.llm.ctx).trim();
        think.context_length = raw === 'max' || Number.isNaN(Number(raw)) ? raw : Number(raw);
      }
    }

    const speakProvider = { type: tp.type || 'deepgram' };
    const mk = tp.type === 'deepgram' || tp.type === 'open_ai' ? 'model' : tp.mk || 'model_id';
    if (tp.type !== 'aws_polly') speakProvider[mk] = agent.tts.model;
    if (tp.type === 'deepgram') {
      const isFlux = agent.tts.model.startsWith('flux');
      speakProvider.version = isFlux ? 'v2' : 'v1';
      speakProvider.speed = Number(agent.tts.speed);
      if (isFlux && Number(agent.tts.expr) !== 0) speakProvider.expressivity = Math.round(Number(agent.tts.expr));
    } else if (tp.type === 'cartesia') {
      speakProvider.speed = Number(agent.tts.speed);
    }
    const tpEx = parseJsonObject(tp.extra);
    if (tpEx.ok) {
      const copy = { ...tpEx.value };
      if (tp.type === 'deepgram') delete copy.language;
      Object.assign(speakProvider, copy);
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

    const sp = prov(agent.stt.p);
    const lp = prov(agent.llm.p);
    const tp = prov(agent.tts.p);
    push(Boolean(sp && lp && tp), 'STT, LLM and TTS plug-ins exist and are linked');
    if (!sp || !lp || !tp) return items;

    push(sp.type === 'deepgram', 'STT provider type is "deepgram" (required by Deepgram Voice Agent API)');
    push((agent.greeting || '').trim().length > 10, 'Greeting is set (> 10 chars)');
    const promptOk = (lp.endpoint || '').trim()
      ? (agent.prompt || '').trim().length > 0
      : (agent.prompt || '').trim().length > 0 && agent.prompt.length <= 25000;
    push(promptOk, 'System prompt within 25,000-character managed limit');

    if (agent.stt.model.startsWith('flux')) {
      const eot = Number(agent.stt.eot);
      const eager = Number(agent.stt.eager);
      const eotms = Number(agent.stt.eotms);
      push(eot >= 0.5 && eot <= 1.0, `Flux STT eot_threshold (${eot}) in 0.5–1.0`);
      push(eager >= 0.3 && eager <= 0.9, `Flux STT eager_eot_threshold (${eager}) in 0.3–0.9`);
      push(eager <= eot, `eager_eot_threshold (${eager}) ≤ eot_threshold (${eot})`);
      push(Number.isInteger(eotms) && eotms >= 500, `eot_timeout_ms (${eotms}) is integer ≥ 500`);
      push(!agent.stt.smartFormat, 'smart_format disabled on Flux v2 STT');
    }

    const llmNeedsEp = ['groq', 'aws_bedrock'].includes(lp.type);
    push(!llmNeedsEp || Boolean((lp.endpoint || '').trim()), `LLM endpoint configured where required (${lp.type})`);
    push(!(agent.llm.ctx || '').trim() || Boolean((lp.endpoint || '').trim()), 'context_length only set with BYO LLM endpoint', true);

    const ttsNeedsEp = !['deepgram', 'cartesia'].includes(tp.type);
    push(!ttsNeedsEp || Boolean((tp.endpoint || '').trim()), `TTS endpoint configured where required (${tp.type})`);

    if (tp.type === 'deepgram') {
      const isFlux = agent.tts.model.startsWith('flux');
      const spd = Number(agent.tts.speed);
      const expr = Number(agent.tts.expr);
      if (isFlux) {
        push(isValidFluxSpeed(spd), `Flux TTS speed (${spd}) in 0.5–1.5 with 0.05 steps`);
        push(Number.isInteger(expr) && expr >= -2 && expr <= 2, `Flux TTS expressivity (${expr}) integer in -2..2`);
      } else {
        push(spd >= 0.7 && spd <= 1.5, `Aura TTS speed (${spd}) in 0.7–1.5`);
      }
    }

    const hasPlaceholder = (tp.endpoint || '').includes('{voice_id}') || (tp.extra || '').includes('"VOICE_ID"');
    push(!hasPlaceholder, 'No unreplaced {voice_id} or VOICE_ID placeholder in TTS config', true);

    const provJsonOk = [sp, lp, tp].every((p) => parseJsonObject(p.headers).ok && parseJsonObject(p.extra).ok);
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
    push(Number(agent.audio.inRate) === 8000, '8000 Hz input matches Asterisk/VICIdial telephony', true);
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
      ` same => n,Set(_BRIDGE_UUID=\${CURL(http://${v.bridgeHost}:3000/api/vici/register-call,uniqueid=\${CHANNEL(uniqueid)}&vici_cid=\${URIENCODE(\${CALLERID(name)})}&phone=\${URIENCODE(\${CALLERID(num)})}&exten=\${EXTEN}&channel=\${URIENCODE(\${CHANNEL})})})`,
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
      `PORT=3000`,
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
  const modelsForProvider = (id) =>
    (prov(id)?.models || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

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
    return `<div class="t">
      <div class="row">
        ${F('Display name', `p.${idx}.name`)}
        ${
          isStt
            ? F('Provider type (Voice Agent API supports deepgram only)', `p.${idx}.type`, 'sel', [['deepgram', 'deepgram']])
            : p.kind === 'llm'
            ? F('Provider type', `p.${idx}.type`, 'sel', ['open_ai', 'anthropic', 'google', 'groq', 'aws_bedrock', 'nvidia'])
            : F('Provider type', `p.${idx}.type`, 'sel', ['deepgram', 'eleven_labs', 'cartesia', 'open_ai', 'aws_polly'])
        }
      </div>
      ${F('Models (comma-separated)', `p.${idx}.models`)}
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
      ${F('Server webhook URL (supports {{lead.lead_id}}, {{phone}}, {{caller_code}} & LAN http://127.0.0.1)', `f.${idx}.url`)}
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

  function flushSimulatorSpeakerQueue() {
    for (const src of sim.scheduledSources) {
      try {
        src.stop();
      } catch {}
    }
    sim.scheduledSources = [];
    if (sim.playCtx) {
      sim.nextPlayTime = sim.playCtx.currentTime;
    }
  }

  function enqueuePcm16Playback(arrayBuf) {
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

    const now = sim.playCtx.currentTime;
    const startAt = Math.max(now + 0.015, sim.nextPlayTime || now + 0.015);
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
      return;
    }
    const gain = Number(sim.micGain) || 1.0;
    let sum = 0;
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i] * gain;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / ch.length);
    const pct = Math.min(100, Math.round(rms * 420));
    if (pct > sim.micPeakPct) sim.micPeakPct = pct;

    const meter = document.getElementById('sim-mic-bar');
    if (meter) meter.style.width = `${pct}%`;

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
                this._buf = new Float32Array(1024);
                this._pos = 0;
              }
              process(inputs) {
                const input = inputs[0];
                if (input && input[0]) {
                  const ch = input[0];
                  for (let i = 0; i < ch.length; i++) {
                    this._buf[this._pos++] = ch[i];
                    if (this._pos >= 1024) {
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
      const processor = ctx.createScriptProcessor(2048, 1, 1);
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

  function effectiveSimulatorMode() {
    if (sim.upstreamMode) return sim.upstreamMode;
    return secretsStatus?.DEEPGRAM_API_KEY?.configured ? 'deepgram' : 'sandbox';
  }

  async function startLiveCall(withMic = true) {
    if (sim.active || sim.connecting) return;

    sim.connecting = true;
    sim.muted = false;
    sim.micEnabled = withMic;
    sim.lastError = null;
    sim.turns = 0;
    sim.lastTtfbMs = null;
    sim.avgTtfbMs = null;
    sim.lastLlmMs = null;
    sim.disposition = null;
    sim.transferredTo = null;
    sim.events = [];
    sim.elapsedSec = 0;
    sim.micTxBytes = 0;
    sim.micPeakPct = 0;
    sim.statusText = 'Connecting WebSocket…';
    sim.agentState = 'connecting';

    const mode = effectiveSimulatorMode();
    sim.sampleRateIn = sim.bandwidth === 'telephony' ? 8000 : 16000;
    sim.sampleRateOut = sim.bandwidth === 'telephony' ? 8000 : 24000;

    // Unlock BOTH Speaker AND Microphone WebAudio contexts synchronously inside click gesture!
    // (In Chrome/Edge on Windows, creating captureCtx after async getUserMedia leaves it 'suspended'!)
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) {
      try {
        sim.playCtx = new AudioCtx();
        sim.nextPlayTime = 0;
        sim.playCtx.resume().catch(() => {});
        if (withMic) {
          sim.captureCtx = new AudioCtx();
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
        flushSimulatorSpeakerQueue();
        sim.agentState = 'user_speaking';
        sim.statusText = 'Caller Speaking (Barge-In Cleared Speaker Buffer)';
        updateSimStatusDom();
      } else if (msg.type === 'agent_state') {
        sim.agentState = msg.state;
        const labels = {
          listening: 'Listening for Caller…',
          user_speaking: 'Caller Speaking…',
          thinking: 'LLM Thinking…',
          speaking: 'Bot Speaking…',
        };
        sim.statusText = labels[msg.state] || msg.state;
        updateSimStatusDom();
      } else if (msg.type === 'transcript') {
        if (msg.role === 'user') sim.turns += 1;
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
      sim.events.push({ kind: 'msg', role: 'assistant', content: settings.agent.greeting || agent.greeting });
      sim.ws = {
        readyState: WebSocket.OPEN,
        _isSandbox: true,
        send: () => {},
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
        flushSimulatorSpeakerQueue();
        sim.agentState = 'user_speaking';
        sim.statusText = 'Caller Speaking…';
        updateSimStatusDom();
      } else if (msg.type === 'AgentThinking') {
        sim.agentState = 'thinking';
        sim.statusText = 'LLM Thinking…';
        updateSimStatusDom();
      } else if (msg.type === 'AgentStartedSpeaking') {
        sim.agentState = 'speaking';
        sim.statusText = 'Bot Speaking…';
        updateSimStatusDom();
      } else if (msg.type === 'AgentAudioDone') {
        sim.agentState = 'listening';
        sim.statusText = 'Listening for Caller…';
        updateSimStatusDom();
      } else if (msg.type === 'ConversationText') {
        if (msg.role === 'user') {
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
    flushSimulatorSpeakerQueue();
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
    const elDispo = document.getElementById('sim-kpi-dispo');
    const elXfer = document.getElementById('sim-kpi-xfer');
    if (elTurns) elTurns.textContent = String(sim.turns);
    if (elTtfb) {
      elTtfb.textContent = sim.lastTtfbMs !== null ? `${sim.lastTtfbMs} ms (avg ${sim.avgTtfbMs} ms)` : '—';
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
    updateSimStatusDom();
    updateSimKpisDom();
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
        error: 'Cloud Browser Mode: Deploy on your ViciBox server (vicibox-install.sh) to probe local 127.0.0.1 Asterisk AMI (:5038) & VICIdial HTTP APIs.',
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
            const isAssigned = prov(a.tts.p)?.type === 'deepgram' && a.tts.model === v.id;
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
                <button class="${isAssigned ? 'g' : 'b'}" data-vpick="${esc(v.id)}">
                  ${isAssigned ? '✓ Active Voice' : 'Set as Agent Voice'}
                </button>
              </div>
            </div>`;
          })
          .join('')}
      </div>
    `;
  }

  // ==================== MAIN VIEW RENDERER ====================

  function render() {
    if (!S) return;
    const tabs = [
      ['agents', '🤖 Agents'],
      ['plugins', '🧩 Plug-ins'],
      ['campaigns', '📢 Campaigns'],
      ['voice', '🎧 Voice Lab'],
      ['test', '📞 Live Bot'],
      ['vici', '☎️ Vici Bridge'],
      ['wallboard', '📊 Wallboard'],
      ['export', '💾 Export'],
    ];
    document.getElementById('nav').innerHTML = tabs
      .map(([k, lbl]) => `<button data-t="${k}" class="${tab === k ? 'on' : ''}">${lbl}</button>`)
      .join('');

    const m = document.getElementById('m');
    m.className = tab === 'voice' || tab === 'export' ? 'wide' : '';

    const a = A();

    if (tab === 'agents') {
      const isFluxStt = a.stt.model.startsWith('flux');
      const tp = prov(a.tts.p) || {};
      const isFluxTts = tp.type === 'deepgram' && a.tts.model.startsWith('flux');

      m.innerHTML = `
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

          <h2>Speech-to-Text (Listen)</h2>
          <div class="row">
            ${F('STT Plug-in', 'a.stt.p', 'sel', providersByKind('stt'))}
            ${F('STT Model', 'a.stt.model', 'dl', modelsForProvider(a.stt.p))}
          </div>
          <div class="row">
            ${F('Language / BCP-47 hints', 'a.language')}
            ${F('Keyterms (comma-separated phrases)', 'a.stt.keyterms')}
          </div>
          ${
            isFluxStt
              ? `<div class="row r3">
                  ${F('eot_threshold (0.5–1.0)', 'a.stt.eot', 'number', [], 'min="0.5" max="1.0" step="0.05"')}
                  ${F('eager_eot (0.3–0.9)', 'a.stt.eager', 'number', [], 'min="0.3" max="0.9" step="0.05"')}
                  ${F('eot_timeout_ms', 'a.stt.eotms', 'number', [], 'min="500" max="15000" step="100"')}
                </div>`
              : F('Enable smart_format (Nova v1 models only)', 'a.stt.smartFormat', 'chk')
          }

          <h2>Language Model (Think) <button class="g" id="sync-llm" style="font-size:11px;padding:3px 8px;text-transform:none">↻ Sync Deepgram Models</button></h2>
          <div class="row">
            ${F('LLM Plug-in', 'a.llm.p', 'sel', providersByKind('llm'))}
            ${F('LLM Model', 'a.llm.model', 'dl', modelsForProvider(a.llm.p))}
          </div>
          <div class="row r3">
            ${F('Temperature (0–2)', 'a.llm.temp', 'number', [], 'min="0" max="2" step="0.05"')}
            ${F('Reasoning (gpt-5*)', 'a.llm.reasoning', 'sel', ['low', 'medium', 'high'])}
            ${F('Context length (BYO only)', 'a.llm.ctx')}
          </div>

          <h2>Text-to-Speech (Speak) <button class="g" data-t="voice" style="font-size:11px;padding:3px 8px;text-transform:none">🎧 Open Real Voice Lab →</button></h2>
          <div class="row">
            ${F('TTS Plug-in', 'a.tts.p', 'sel', providersByKind('tts'))}
            ${F('Voice Model / ID', 'a.tts.model', 'dl', modelsForProvider(a.tts.p))}
          </div>
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
        <div class="card">
          ${['stt', 'llm', 'tts']
            .map(
              (kind) => `
              <h2>${kind.toUpperCase()} Plug-ins</h2>
              ${S.providers.map((p, idx) => (p.kind === kind ? renderPluginCard(idx) : '')).join('')}
              <button class="g" data-add="${kind}">+ Add ${kind.toUpperCase()} Plug-in</button>
            `
            )
            .join('')}
        </div>
        <div class="card">
          <h2>Agent Tool Functions</h2>
          ${S.functions.map((_, idx) => renderFunctionCard(idx)).join('')}
          <button class="b" data-add="fn">+ Add Function</button>
          <div class="note">
            Functions without a webhook URL execute client-side inside your Node VICIdial Bridge (<code>transfer_to_live_agent</code>, <code>set_disposition</code>, <code>end_call</code>). Agents bind to functions by immutable ID, so renaming a function automatically updates all linked agents.
          </div>
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
                <span class="pill">Active TTS: <b>${esc(prov(a.tts.p)?.name || a.tts.p)}</b></span>
                <span class="pill ok">Voice Model: <code>${esc(a.tts.model)}</code></span>
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
                Clicking <b>Set as Agent Voice</b> on any voice card below automatically sets this agent's TTS plug-in to Deepgram TTS, selects the exact model ID (<code>flux-*</code> v2 or <code>aura-*</code> v1), and updates the live <code>Settings</code> JSON.
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

          <div class="sim-kpis">
            <div class="kpi"><div class="kpi-lbl">Duration</div><div class="kpi-val" id="sim-kpi-dur">${formatDuration(sim.elapsedSec)}</div></div>
            <div class="kpi"><div class="kpi-lbl">Caller Turns</div><div class="kpi-val" id="sim-kpi-turns">${sim.turns}</div></div>
            <div class="kpi"><div class="kpi-lbl">Audio TTFB Latency</div><div class="kpi-val" id="sim-kpi-ttfb">${sim.lastTtfbMs !== null ? `${sim.lastTtfbMs} ms` : '—'}</div></div>
            <div class="kpi"><div class="kpi-lbl">VICIdial Dispo</div><div class="kpi-val" id="sim-kpi-dispo">${esc(sim.disposition || '—')}</div></div>
            <div class="kpi"><div class="kpi-lbl">Closer Transfer</div><div class="kpi-val" id="sim-kpi-xfer">${esc(sim.transferredTo || '—')}</div></div>
          </div>

          <div class="sim-feed" id="sim-feed"></div>

          <div class="bar" style="margin-top:10px;margin-bottom:0">
            <input id="sim-inject-input" style="flex:1" placeholder="${sim.active ? 'Type caller utterance & press Enter (sends InjectUserMessage)…' : 'Start a call above to speak or inject utterances…'}" ${sim.active ? '' : 'disabled'}>
            <button class="b" id="btn-sim-inject" ${sim.active ? '' : 'disabled'}>Send Utterance</button>
          </div>
          <div class="chip-row">
            ${(
              a.id === 'a_medicare' || /medicare/i.test(a.name)
                ? [
                    'Yes, I have Medicare Part A and Part B, and I am 71.',
                    'Is this a scam or a sales pitch?',
                    'Hablo español, no hablo inglés.',
                    'Stop calling my phone please.',
                  ]
                : [
                    "Yes, I'm 64 and looking for final expense coverage.",
                    'How much does it cost per month?',
                    'Take me off your calling list please.',
                  ]
            )
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
                      : `<span class="wn">! ${esc(viciMon.verifyResult.vicidialHttp?.versionText || 'Unreachable (expected until deployed onto ViciBox 127.0.0.1)')}</span>`
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
          ${F('VICIdial Server Base URL (127.0.0.1 when co-located on ViciBox)', 'v.viciBaseUrl')}
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
            <span>Console Auth (<code>ADMIN_PASSWORD</code>): <b>${secretsStatus?.ADMIN_PASSWORD?.configured ? 'Enabled & Enforced' : 'Open (Set in 🔑 API Keys before exposing :3000 publicly)'}</b></span>
          </div>
          <div class="ck">
            <span class="${secretsStatus?.BRIDGE_ALLOWED_IPS?.configured ? 'ok' : 'wn'}">${secretsStatus?.BRIDGE_ALLOWED_IPS?.configured ? '✓' : '!'}</span>
            <span>SIP/AudioSocket IP Allowlist (<code>BRIDGE_ALLOWED_IPS</code>): <b>${secretsStatus?.BRIDGE_ALLOWED_IPS?.configured ? 'Restricted to Trusted IPs' : 'Open (vicibox-install.sh locks to 127.0.0.1,::1)'}</b></span>
          </div>
          <div class="ck">
            <span class="ok">✓</span>
            <span>Local Asterisk <code>127.0.0.1</code> Pre-Call Hook Whitelisted</span>
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
    const authRes = await fetch('/api/auth/status').catch(() => null);
    if (authRes && authRes.ok && (authRes.headers.get('content-type') || '').includes('application/json')) {
      const authJson = await authRes.json().catch(() => ({}));
      const logoutBtn = document.getElementById('btn-logout');
      if (logoutBtn) logoutBtn.style.display = authJson.authEnabled && authJson.authenticated ? 'inline-block' : 'none';
      if (authJson.authEnabled && !authJson.authenticated) {
        document.getElementById('auth-modal').hidden = false;
        document.getElementById('st').textContent = '🔒 Locked — Sign in required';
        return;
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
      snap = comparableSnapshot(S);
      revisions = [{ id: 1, saved_at: S.updatedAt || new Date().toISOString(), summary: 'Cloud Direct Browser Session' }];
      secretsStatus = buildCloudSecretsStatus();
      if (secretsStatus?.DEEPGRAM_API_KEY?.configured) {
        sim.upstreamMode = 'deepgram';
      }
      if (!S.agents.some((x) => x.id === cur.a)) cur.a = S.agents[0].id;
      if (!S.campaigns.some((x) => x.id === cur.c)) cur.c = S.campaigns[0].id;
      render();
      return;
    }
    if (res.status === 401) {
      document.getElementById('auth-modal').hidden = false;
      document.getElementById('st').textContent = '🔒 Locked — Sign in required';
      return;
    }
    const data = await res.json();
    S = data.state;
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
        const ok = all.filter((x) => x.level === 'ok').length;
        const wn = all.filter((x) => x.level === 'wn').length;
        const er = all.filter((x) => x.level === 'er').length;
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
    const tp = prov(a.tts.p) || { type: 'deepgram' };
    const vtEl = document.getElementById('vt');
    const text = (vtEl ? vtEl.value : voiceCatalog.previewText || a.greeting).trim();
    const vs = document.getElementById('vs');
    const audioEl = document.getElementById('voice-audio');

    const useDeepgramOverride = Boolean(modelOverride);
    const providerType = useDeepgramOverride ? 'deepgram' : tp.type;
    const model = modelOverride || a.tts.model;
    const label = labelOverride || `${providerType}:${model}`;

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
      ['DEEPGRAM_API_KEY', 'Deepgram API Key (enables live custom TTS synthesis & live Voice Agent)'],
      ['ELEVENLABS_API_KEY', 'ElevenLabs API Key (optional — for BYO ElevenLabs TTS)'],
      ['CARTESIA_API_KEY', 'Cartesia API Key (optional — for BYO Cartesia TTS)'],
      ['GROQ_API_KEY', 'Groq API Key (optional — for BYO Groq LLM)'],
      ['VICI_API_PASS', 'VICIdial API Password (User 6666 pass on ViciBox)'],
      ['AMI_SECRET', 'Asterisk AMI Secret (cron pass in /etc/asterisk/manager.conf)'],
      ['CUSTOM_WEBHOOK_SECRET', 'Custom CRM / Webhook Secret (usable as {{CUSTOM_WEBHOOK_SECRET}} in Function headers)'],
      ['ADMIN_PASSWORD', 'Console Admin Password (Step 4 — locks :3000 Web UI & WebSockets while keeping local Asterisk whitelisted)'],
      ['BRIDGE_ALLOWED_IPS', 'Allowed Asterisk IPs/CIDRs for SIP :5062 & AudioSocket :9092 (e.g. 127.0.0.1,::1,10.0.0.0/8)'],
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
    const b = e.target.closest('button');
    if (!b) return;
    const d = b.dataset;

    if (d.t) {
      stopAllAudio();
      tab = d.t;
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
    if (d.pickTheme) {
      appearance.theme = d.pickTheme;
      applyAppearance(true);
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
      await fetch('/api/auth/logout', { method: 'POST' });
      await loadFromServer();
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
      if (serverlessCloudMode) {
        render();
        return;
      }
      b.disabled = true;
      b.textContent = 'Syncing…';
      try {
        const res = await fetch('/api/deepgram/llm-models');
        const data = await res.json();
        if (data.ok && Array.isArray(data.models)) {
          for (const p of S.providers.filter((x) => x.kind === 'llm' && !x.endpoint.trim())) {
            const matched = data.models.filter((m) => m.provider === p.type).map((m) => m.id);
            if (matched.length) p.models = Array.from(new Set(matched)).join(',');
          }
          render();
        }
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

    if (d.vpick) {
      const a = A();
      let dgTts = S.providers.find((p) => p.kind === 'tts' && p.type === 'deepgram');
      if (!dgTts) {
        dgTts = {
          id: uid('tts'),
          kind: 'tts',
          name: 'Deepgram TTS',
          type: 'deepgram',
          models: d.vpick,
          endpoint: '',
          headers: '{}',
          extra: '{}',
          mk: 'model',
        };
        S.providers.push(dgTts);
      } else {
        const existingModels = modelsForProvider(dgTts.id);
        if (!existingModels.includes(d.vpick)) {
          dgTts.models = [d.vpick, ...existingModels].join(',');
        }
      }
      a.tts.p = dgTts.id;
      a.tts.model = d.vpick;
      if (d.vpick.startsWith('flux-') && !isValidFluxSpeed(Number(a.tts.speed))) {
        a.tts.speed = Math.round(Math.min(1.5, Math.max(0.5, Number(a.tts.speed) || 1)) * 20) / 20;
      } else if (!d.vpick.startsWith('flux-') && Number(a.tts.speed) < 0.7) {
        a.tts.speed = 0.7;
      }
      render();
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
          kind === 'stt' ? 'flux-general-en' : kind === 'llm' ? 'gpt-5-mini' : 'flux-haley-en';
        S.providers.push({
          id: uid(kind),
          kind,
          name: `New ${kind.toUpperCase()} Plug-in`,
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
      const res = await fetch('/api/state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: parsed.console || parsed }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Import failed');
      S = data.state;
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

      const slotMatch = /^a\.(stt|llm|tts)\.p$/.exec(t.dataset.p);
      if (slotMatch) {
        A()[slotMatch[1]].model = modelsForProvider(t.value)[0] || '';
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
