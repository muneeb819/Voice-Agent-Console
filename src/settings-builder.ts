import { Agent, Campaign, ConsoleState, Provider, ValidationItem } from './types';
import { deepgramModelsForProviderType, VOICE_AGENT_STT_MODELS } from './defaults';
import { composeOpening } from './opening';

export function isPlainObject(val: unknown): val is Record<string, any> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

export function parseJsonObject(raw: string): { ok: true; value: Record<string, any> } | { ok: false; error: string } {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) {
    return { ok: true, value: {} };
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (!isPlainObject(parsed)) {
      return { ok: false, error: 'Must be a JSON object {...}, not an array or primitive' };
    }
    return { ok: true, value: parsed };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Invalid JSON syntax' };
  }
}

export function parseJsonSchema(raw: string): { ok: true; value: Record<string, any> } | { ok: false; error: string } {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) {
    return { ok: true, value: { type: 'object', properties: {} } };
  }
  const res = parseJsonObject(trimmed);
  if (!res.ok) return res;
  if (res.value.type !== 'object' || (res.value.properties !== undefined && !isPlainObject(res.value.properties))) {
    return {
      ok: false,
      error: 'Function parameters schema must have {"type":"object","properties":{...}}',
    };
  }
  const reqList = Array.isArray(res.value.required) ? res.value.required.filter(Boolean) : [];
  return {
    ok: true,
    value: {
      type: 'object',
      properties: res.value.properties || {},
      ...(reqList.length > 0 ? { required: reqList } : {}),
    },
  };
}

export function isValidFluxSpeed(speed: number): boolean {
  if (!Number.isFinite(speed) || speed < 0.5 || speed > 1.5) return false;
  const scaled = Math.round(speed * 20);
  return Math.abs(speed * 20 - scaled) < 1e-6;
}

// Flux TTS accepts speed only in 0.05 increments. Settings can also arrive
// from imported or older browser state, so normalize before sending them to
// Deepgram instead of allowing a speak failure to terminate the greeting.
export function normalizeFluxSpeed(speed: number): number {
  const safeSpeed = Number.isFinite(speed) ? speed : 1;
  const clamped = Math.min(1.5, Math.max(0.5, safeSpeed));
  return Math.round(clamped * 20) / 20;
}

export function composeBehavioralPrompt(agent: Agent): string {
  const basePrompt = (agent.prompt || '').trim();
  const b = agent.behavior;
  if (!b) return basePrompt;

  // Respect Deepgram's 25,000-char managed prompt ceiling
  if (basePrompt.length > 23500) return basePrompt;

  const toneMap: Record<string, string> = {
    warm_empathetic:
      'Warm, caring, empathetic, and reassuring — sound genuinely attentive and human.',
    energetic_upbeat:
      'Bright, upbeat, friendly, and enthusiastic — speak with a natural smile in your voice.',
    charismatic_closer:
      'Confident, poised, articulate, and high-trust — crisp executive advisor energy.',
    calm_concierge:
      'Calm, composed, clear, and soothing — smooth concierge presence.',
  };

  const lines: string[] = [
    '',
    '=== REAL-TIME VOICE ASSISTANT, BARGE-IN, EXPRESSIONS & GENERAL Q&A ===',
    '- Be honest about being an AI assistant if asked. Do not claim an external action succeeded unless its tool result confirms success.',
  ];

  if (b.selfIntro && b.selfIntro.trim()) {
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

export function buildDeepgramSettings(
  state: ConsoleState,
  agent: Agent,
  explicitCampaign?: Campaign,
  options?: { forceClientSideWebhooks?: boolean; greetingText?: string }
) {
  const sp: Partial<Provider> = state.providers.find((p) => p.kind === 'stt' && p.id === state.services?.stt?.providerId) || {};
  const lp: Partial<Provider> = state.providers.find((p) => p.kind === 'llm' && p.id === state.services?.llm?.providerId) || {};
  const tp: Partial<Provider> = state.providers.find((p) => p.kind === 'tts' && p.id === state.services?.tts?.providerId) || {};

  const linkedCampaign = explicitCampaign || state.campaigns.find((c) => c.agentId === agent.id);

  // 1. Listen (STT) — Nova-3 / Flux v2 for Deepgram, or Faster-Whisper for Local Speech Service.
  const selectedSttModel = String(state.services?.stt?.model || '').trim();
  const isSpeechServiceStt = sp.type === 'speech_service';
  const spModels = String(sp.models || '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  const sttModel = isSpeechServiceStt
    ? spModels.includes(selectedSttModel)
      ? selectedSttModel
      : ''
    : VOICE_AGENT_STT_MODELS.includes(selectedSttModel as (typeof VOICE_AGENT_STT_MODELS)[number])
      ? selectedSttModel
      : '';
  const isFluxListen = !isSpeechServiceStt && sttModel.startsWith('flux-');
  const listenProvider: Record<string, any> = {
    type: sttModel ? (isSpeechServiceStt ? 'speech_service' : sp.type === 'deepgram' ? 'deepgram' : '') : '',
    model: sttModel,
  };
  if (isFluxListen) {
    listenProvider.version = 'v2';
    listenProvider.eot_threshold = Number(agent.stt.eot);
    listenProvider.eager_eot_threshold = Number(agent.stt.eager);
    listenProvider.eot_timeout_ms = Math.round(Number(agent.stt.eotms));
    if (sttModel === 'flux-general-multi' && agent.language) {
      listenProvider.language_hints = agent.language
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    const keyterms = (agent.stt.keyterms || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (keyterms.length > 0) listenProvider.keyterms = keyterms;
  }

  const spExtra = parseJsonObject(sp.extra || '{}');
  if (spExtra.ok) Object.assign(listenProvider, spExtra.value);
  // Plugin extras may add provider options, but never replace the saved
  // provider/model. Nova listen accepts only the provider/model pair, so
  // Flux-only fields are stripped there to keep the payload wire-exact.
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
  const listen: Record<string, any> = { provider: listenProvider };
  if (isSpeechServiceStt && sp.endpoint && sp.endpoint.trim()) {
    const shdrs = parseJsonObject(sp.headers || '{}');
    listen.endpoint = {
      url: sp.endpoint.trim(),
      headers: shdrs.ok ? shdrs.value : {},
    };
  }

  // 2. Think (LLM)
  const selectedLlmModel = String(state.services?.llm?.model || '').trim();
  const llmModel = deepgramModelsForProviderType(lp.type || '').includes(selectedLlmModel) ? selectedLlmModel : '';
  const thinkProvider: Record<string, any> = {
    type: lp.kind === 'llm' ? lp.type || '' : '',
  };
  // Deepgram-managed selection is global; never fall back to an agent's legacy model.
  if (llmModel) thinkProvider.model = llmModel;

  if (lp.type === 'open_ai' && /^gpt-5/.test(llmModel)) {
    thinkProvider.reasoning_mode = agent.llm.reasoning;
  } else {
    thinkProvider.temperature = Number(agent.llm.temp);
  }

  const lpExtra = parseJsonObject(lp.extra || '{}');
  if (lpExtra.ok) Object.assign(thinkProvider, lpExtra.value);
  thinkProvider.type = lp.kind === 'llm' ? lp.type || '' : '';
  delete thinkProvider.endpoint;
  delete thinkProvider.model;
  if (llmModel) thinkProvider.model = llmModel;

  const campaignDispos = (linkedCampaign?.dispos || '')
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);

  const fns = agent.fnIds
    .map((id) => state.functions.find((f) => f.id === id))
    .filter((f): f is NonNullable<typeof f> => Boolean(f))
    .map((f) => {
      const schemaRes = parseJsonSchema(f.params);
      const parameters = schemaRes.ok
        ? JSON.parse(JSON.stringify(schemaRes.value))
        : { type: 'object', properties: {} };

      // Wire campaign dispositions directly into set_disposition enum
      if (f.name === 'set_disposition' && campaignDispos.length > 0 && parameters.properties?.code) {
        parameters.properties.code = {
          ...parameters.properties.code,
          enum: campaignDispos,
        };
      }

      const fnDef: Record<string, any> = {
        name: f.name,
        description: f.description,
        parameters,
      };
      if (f.defer) fnDef.defer_until_eot = true;
      if (f.url && f.url.trim() && !options?.forceClientSideWebhooks) {
        const hdrs = parseJsonObject(f.headers);
        fnDef.endpoint = {
          url: f.url.trim(),
          method: f.method,
          headers: hdrs.ok ? hdrs.value : {},
        };
      }
      return fnDef;
    });

  const think: Record<string, any> = {
    provider: thinkProvider,
    prompt: composeBehavioralPrompt(agent),
    functions: fns,
  };

  // LLMs are Deepgram-managed only; do not expose per-plugin BYO endpoints to agents.
  // 3. Speak (TTS)
  const selectedTtsModel = String(state.services?.tts?.model || '').trim();
  const availableTtsModels = String(tp.models || '').split(',').map((entry) => entry.trim()).filter(Boolean);
  const isDeepgramVoice = tp.type === 'deepgram' && /^(flux|aura)-/i.test(selectedTtsModel);
  const isSpeechServiceVoice =
    tp.type === 'speech_service' && /^(clone:[0-9a-f]{32}|[a-z]{2}_[a-z0-9]+)$/.test(selectedTtsModel);
  const ttsModel =
    tp.kind === 'tts' && (availableTtsModels.includes(selectedTtsModel) || isDeepgramVoice || isSpeechServiceVoice)
      ? selectedTtsModel
      : '';
  const speakProvider: Record<string, any> = {
    type: tp.kind === 'tts' ? tp.type || '' : '',
  };
  const modelKey =
    tp.type === 'deepgram' || tp.type === 'open_ai' || tp.type === 'speech_service' ? 'model' : tp.mk || 'model_id';
  if (tp.type && ttsModel && tp.type !== 'aws_polly') {
    speakProvider[modelKey] = ttsModel;
  }

  if (tp.type === 'deepgram' && ttsModel) {
    // Voice Agent speak provider: exactly {type, version, model}.
    // Aura voices are v1, Flux voices are v2 (the verified baseline).
    speakProvider.version = ttsModel.startsWith('flux') ? 'v2' : 'v1';
  } else if (tp.type === 'cartesia') {
    speakProvider.speed = Number(agent.tts.speed);
  }

  const tpExtra = parseJsonObject(tp.extra || '{}');
  if (tpExtra.ok && tp.type !== 'deepgram') {
    const extraCopy = { ...tpExtra.value };
    Object.assign(speakProvider, extraCopy);
  }
  // Plugin extras may add provider options, but the saved global choice is authoritative.
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
    speakProvider[modelKey] = ttsModel;
  }

  const speak: Record<string, any> = { provider: speakProvider };
  if (tp.endpoint && tp.endpoint.trim()) {
    const hdrs = parseJsonObject(tp.headers || '{}');
    speak.endpoint = {
      url: tp.endpoint.trim(),
      headers: hdrs.ok ? hdrs.value : {},
    };
  }

  // The saved opening supplies the identity. A library draw varies its short
  // salutation/question instead of appending a second, unrelated greeting.
  // Previews have no draw and therefore never consume the rotation.
  const variation = agent.randomGreetingEnabled !== false ? (options?.greetingText || '') : '';
  const finalGreeting = composeOpening(agent.greeting, variation, agent.injectCampaignDisclosure, linkedCampaign?.disclosure || '');

  return {
    type: 'Settings',
    tags: ['voice-console', agent.mode, ...(linkedCampaign?.viciCampaign ? [linkedCampaign.viciCampaign] : [])],
    audio: {
      input: {
        encoding: agent.audio.inEnc,
        sample_rate: Number(agent.audio.inRate),
      },
      output: {
        encoding: agent.audio.outEnc,
        sample_rate: Number(agent.audio.outRate),
        container: 'none',
      },
    },
    agent: {
      listen,
      think,
      speak,
      greeting: finalGreeting,
    },
  };
}

export function validateAgent(state: ConsoleState, agent: Agent): ValidationItem[] {
  const items: ValidationItem[] = [];
  const push = (ok: boolean, message: string, warnOnly = false) => {
    items.push({
      level: ok ? 'ok' : warnOnly ? 'wn' : 'er',
      icon: ok ? '✓' : warnOnly ? '!' : '✗',
      scope: `Agent "${agent.name}"`,
      message,
    });
  };

  const sp = state.providers.find((p) => p.kind === 'stt' && p.id === state.services?.stt?.providerId);
  const lp = state.providers.find((p) => p.kind === 'llm' && p.id === state.services?.llm?.providerId);
  const tp = state.providers.find((p) => p.kind === 'tts' && p.id === state.services?.tts?.providerId);
  const sttModel = String(state.services?.stt?.model || '');
  const llmModel = String(state.services?.llm?.model || '');
  const ttsModel = String(state.services?.tts?.model || '');

  push(Boolean(sp), 'One global STT provider is selected in Plug-Ins');
  push(Boolean(lp), 'One global LLM provider is selected in Plug-Ins');
  push(Boolean(tp), 'One global TTS provider is selected in Plug-Ins');

  // STT validations
  const isLocalStt = Boolean(sp && sp.type === 'speech_service');
  const spAllowedStt = sp ? sp.models.split(',').map((s) => s.trim()).filter(Boolean) : [];
  push(
    Boolean(sp && (sp.type === 'deepgram' || sp.type === 'speech_service')),
    isLocalStt
      ? 'Global STT provider is Local Speech Service (Faster-Whisper)'
      : 'Global STT provider is Deepgram (required by Voice Agent API)'
  );
  push(
    Boolean(
      sp &&
        (isLocalStt
          ? spAllowedStt.includes(sttModel)
          : VOICE_AGENT_STT_MODELS.includes(sttModel as (typeof VOICE_AGENT_STT_MODELS)[number]))
    ),
    isLocalStt
      ? `Global STT model "${sttModel || 'not selected'}" is supported by Local Speech Service`
      : `Global STT model "${sttModel || 'not selected'}" is supported by Voice Agent (Nova-3 or Flux v2)`
  );
  push(agent.greeting.trim().length > 10, 'Greeting is set (> 10 chars)');
  const maxPromptOk = agent.prompt.trim().length > 0 && agent.prompt.length <= 25000;
  push(maxPromptOk, 'System prompt is non-empty and within Deepgram 25,000-char managed limit');

  if (sttModel.startsWith('flux')) {
    const eot = Number(agent.stt.eot);
    const eager = Number(agent.stt.eager);
    const eotms = Number(agent.stt.eotms);
    push(eot >= 0.5 && eot <= 1.0, `Flux STT eot_threshold (${eot}) is within 0.5–1.0`);
    push(eager >= 0.3 && eager <= 0.9, `Flux STT eager_eot_threshold (${eager}) is within 0.3–0.9`);
    push(eager <= eot, `eager_eot_threshold (${eager}) ≤ eot_threshold (${eot})`);
    push(Number.isInteger(eotms) && eotms >= 500, `eot_timeout_ms (${eotms} ms) is a valid integer ≥ 500`);
    push(!agent.stt.smartFormat, 'smart_format is disabled (not supported with Flux v2 STT)');
  }

  // LLM validations (strictly Deepgram-managed LLM providers & models)
  const dgManagedProviders = ['open_ai', 'anthropic', 'google', 'groq', 'nvidia'];
  push(
    Boolean(lp && dgManagedProviders.includes(lp.type) && !lp.endpoint.trim()),
    `Selected global LLM provider (${lp?.name || 'none'}) is natively managed by Deepgram (no BYO endpoint)`
  );
  const allowedModels = lp ? deepgramModelsForProviderType(lp.type) : [];
  push(
    Boolean(lp && allowedModels.includes(llmModel)),
    `Selected global LLM model "${llmModel || 'not selected'}" is offered by the chosen Deepgram-managed provider`
  );

  // TTS validations
  const ttsNeedsEndpoint = Boolean(tp && !['deepgram', 'cartesia'].includes(tp.type));
  push(Boolean(tp && (!ttsNeedsEndpoint || tp.endpoint.trim())), `TTS endpoint configured where required (${tp?.type || 'no provider'})`);
  const tpModelList = tp ? tp.models.split(',').map((s) => s.trim()).filter(Boolean) : [];
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
      push(
        isValidFluxSpeed(spd),
        `Flux TTS speed (${spd}) is in 0.5–1.5 (0.05 increments)`
      );
      const expr = Number(agent.tts.expr);
      push(
        Number.isInteger(expr) && expr >= -2 && expr <= 2,
        `Flux TTS expressivity (${expr}) is an integer in -2..+2`
      );
    } else if (ttsModel.startsWith('aura-')) {
      const spd = Number(agent.tts.speed);
      push(
        spd >= 0.7 && spd <= 1.5,
        `Aura TTS speed (${spd}) is within 0.7–1.5`
      );
    }
  }

  const hasPlaceholderVoice = Boolean(
    tp && (tp.endpoint.includes('{voice_id}') || tp.extra.includes('"VOICE_ID"'))
  );
  push(!hasPlaceholderVoice, 'TTS endpoint/extra has no unreplaced {voice_id} or VOICE_ID placeholder', true);

  // JSON syntax & object schema checks
  const providersValidJson = [sp, lp, tp].every(
    (p) => Boolean(p && parseJsonObject(p.headers).ok && parseJsonObject(p.extra).ok)
  );
  const fnsForAgent = agent.fnIds
    .map((id) => state.functions.find((f) => f.id === id))
    .filter((f): f is NonNullable<typeof f> => Boolean(f));
  const fnsValidJson = fnsForAgent.every(
    (f) => parseJsonSchema(f.params).ok && parseJsonObject(f.headers).ok
  );
  push(providersValidJson && fnsValidJson, 'All linked plug-in JSON objects and function JSON schemas are valid');

  // Call lifecycle & compliance checks
  const fnNames = fnsForAgent.map((f) => f.name);
  push(agent.acceptViciCalls, 'Bridge VICIdial call-connect & lead hydration enabled', agent.mode === 'outbound');
  push(fnNames.includes('transfer_to_live_agent'), 'transfer_to_live_agent function enabled');
  push(
    !fnNames.includes('transfer_to_live_agent') || /transfer_to_live_agent/i.test(agent.prompt),
    'System prompt specifies when to call transfer_to_live_agent'
  );
  push(/(dnc|do not call|take me off|stop)/i.test(agent.prompt), 'System prompt handles Do-Not-Call requests');
  push(fnNames.includes('end_call'), 'end_call function enabled');
  push(Number(agent.audio.inRate) === 8000, '8000 Hz input sample rate matches Asterisk/VICIdial telephony', true);
  push(state.campaigns.some((c) => c.agentId === agent.id), 'Assigned to at least one campaign', true);

  return items;
}

export function validateCampaign(state: ConsoleState, campaign: Campaign): ValidationItem[] {
  const items: ValidationItem[] = [];
  const push = (ok: boolean, message: string, warnOnly = false) => {
    items.push({
      level: ok ? 'ok' : warnOnly ? 'wn' : 'er',
      icon: ok ? '✓' : warnOnly ? '!' : '✗',
      scope: `Campaign "${campaign.name}"`,
      message,
    });
  };

  push(Boolean(campaign.viciCampaign.trim()), 'VICIdial campaign ID is set');
  push(Boolean(campaign.xferTarget.trim()), 'Live-agent transfer target (ingroup/extension/number) is set');
  push(Boolean(campaign.dnc), 'DNC scrub is enabled');
  push(Boolean(campaign.disclosure.trim()), 'Call recording disclosure line is present', true);
  push(campaign.start < campaign.end, `Calling window valid (${campaign.start} – ${campaign.end})`);
  push(state.agents.some((a) => a.id === campaign.agentId), 'Assigned bot agent exists');

  return items;
}

export function validateState(state: ConsoleState): ValidationItem[] {
  const results: ValidationItem[] = [];
  for (const agent of state.agents) {
    results.push(...validateAgent(state, agent));
  }
  for (const campaign of state.campaigns) {
    results.push(...validateCampaign(state, campaign));
  }
  return results;
}

export function diffStates(prev: ConsoleState, next: ConsoleState): string[] {
  const changes: string[] = [];
  const sections: Array<{ key: 'agents' | 'campaigns' | 'providers' | 'functions'; label: string }> = [
    { key: 'agents', label: 'agent' },
    { key: 'campaigns', label: 'campaign' },
    { key: 'providers', label: 'plug-in' },
    { key: 'functions', label: 'function' },
  ];

  for (const { key, label } of sections) {
    const oldMap = new Map<string, any>((prev[key] as any[]).map((x) => [x.id, x]));
    const newMap = new Map<string, any>((next[key] as any[]).map((x) => [x.id, x]));

    for (const item of next[key] as any[]) {
      if (!oldMap.has(item.id)) {
        changes.push(`+ Added ${label}: ${item.name}`);
      } else if (JSON.stringify(oldMap.get(item.id)) !== JSON.stringify(item)) {
        const oldItem = oldMap.get(item.id);
        const renameNote = oldItem.name !== item.name ? ` (renamed from "${oldItem.name}")` : '';
        changes.push(`✎ Updated ${label}: ${item.name}${renameNote}`);
      }
    }
    for (const item of prev[key] as any[]) {
      if (!newMap.has(item.id)) {
        changes.push(`- Removed ${label}: ${item.name}`);
      }
    }
  }

  if (JSON.stringify(prev.vici) !== JSON.stringify(next.vici)) {
    changes.push('✎ Updated VICIdial / dialer bridge configuration');
  }
  if (JSON.stringify(prev.tests) !== JSON.stringify(next.tests)) {
    changes.push('✎ Updated scenario test cases');
  }
  return changes;
}

export function generateViciConfig(state: ConsoleState): string {
  const v = state.vici;
  const nonAgentUrl = `${v.viciBaseUrl}${v.nonAgentApiPath}`;
  const agentApiUrl = `${v.viciBaseUrl}${v.agentApiPath}`;

  const campaignLines = state.campaigns
    .map((c, idx) => {
      const ag = state.agents.find((a) => a.id === c.agentId);
      const ext = `${v.aiExten}${idx + 1}`;
      const xferNote =
        c.xferType === 'ingroup'
          ? `Agent API ra_call_control (stage=INGROUPTRANSFER, ingroup_choices=${c.xferTarget}) -> preserves Vici lead screen-pop`
          : `Agent API ra_call_control (stage=EXTENSIONTRANSFER, consultative=NO, exten=${c.xferTarget})`;
      return [
        `; [Campaign ${idx + 1}: ${c.name}]`,
        `;   VICIdial Campaign ID : ${c.viciCampaign || '(unset)'} | Lists: ${c.lists || '(none)'} | Max Concurrent: ${c.maxCalls}`,
        `;   Bot Persona          : ${ag ? ag.name : '(missing)'} (${ag?.mode || 'outbound'})`,
        `;   Remote Agent Exten   : ${ext} (Remote Agent User: ${Number(v.remoteAgentUser || 9001) + idx})`,
        `;   Live Closer Transfer : ${xferNote}`,
        `;   Allowed Dispositions : ${c.dispos}`,
      ].join('\n');
    })
    .join('\n;\n');

  const sipCarrierBlock = [
    `; === OPTION A (Universal — Asterisk 13 / 16 / 18+ on ViciBox 8/9/10/11/12): SIP + RTP Mode ===`,
    `; 1) VICIdial Admin -> Admin -> Carriers -> Add New Carrier:`,
    `;    Carrier ID: AIBRIDGE | Registration String: (blank) | Server IP: ALL`,
    `;    Account Entry:`,
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
    `;    Dialplan Entry (under the same Carrier):`,
    `exten => _${v.aiExten}X.,1,NoOp(VICIdial AI Bot SIP -> Ext \${EXTEN} | ViciCID: \${CALLERID(name)} | Phone: \${CALLERID(num)})`,
    ` same => n,SIPAddHeader(X-Vici-CallName: \${CALLERID(name)})`,
    ` same => n,SIPAddHeader(X-Vici-UniqueID: \${CHANNEL(uniqueid)})`,
    ` same => n,SIPAddHeader(X-Vici-Channel: \${CHANNEL})`,
    ` same => n,SIPAddHeader(X-Vici-Exten: \${EXTEN})`,
    ` same => n,Dial(SIP/\${EXTEN}@ai-bridge,60,tTo)`,
    ` same => n,Hangup()`,
  ].join('\n');

  const audioSocketBlock = [
    `; === OPTION B (Asterisk 18+ on ViciBox 11/12): Native AudioSocket TCP Mode ===`,
    `; Verify module first: asterisk -rx "module show like audiosocket"`,
    `; /api/vici/register-call returns a canonical 36-char RFC4122 UUID & pre-hydrates the VICIdial lead!`,
    `exten => _${v.aiExten}X.,1,NoOp(VICIdial AI Bot AudioSocket -> \${EXTEN} | ViciCID: \${CALLERID(name)})`,
    ` same => n,Answer()`,
    ` same => n,Set(CHANNEL(audioreadformat)=slin)`,
    ` same => n,Set(CHANNEL(audiowriteformat)=slin)`,
    ` same => n,Set(_BRIDGE_UUID=\${CURL(http://${v.bridgeHost}:533/api/vici/register-call,uniqueid=\${CHANNEL(uniqueid)}&vici_cid=\${URIENCODE(\${CALLERID(name)})}&phone=\${URIENCODE(\${CALLERID(num)})}&exten=\${EXTEN}&channel=\${URIENCODE(\${CHANNEL})})})`,
    ` same => n,AudioSocket(\${_BRIDGE_UUID},${v.bridgeHost}:${v.bridgePort})`,
    ` same => n,Hangup()`,
  ].join('\n');

  const dialplanBlock =
    v.transport === 'sip_trunk'
      ? `${sipCarrierBlock}\n\n${audioSocketBlock}`
      : `${audioSocketBlock}\n\n${sipCarrierBlock}`;

  return [
    `; ============================================================================`,
    `; VICIdial <-> Voice Agent Bridge Configuration (Active Primary: ${v.transport === 'sip_trunk' ? 'SIP/RTP :' + v.sipPort : 'AudioSocket :' + v.bridgePort})`,
    `; Both listeners (:9092 AudioSocket TCP & :${v.sipPort} SIP/RTP UDP) run simultaneously!`,
    `; ============================================================================`,
    campaignLines,
    ``,
    `; === VICIdial Admin Setup Checklist (Co-Located on ViciBox ${v.bridgeHost}) ===`,
    `; 1. Users -> API User "${v.apiUser}": User Level=8, Modify Leads=1, Modify Lists=1, Agent API Access=1`,
    `; 2. Remote Agents -> Create Remote Agent User ${v.remoteAgentUser} (Lines=${state.campaigns[0]?.maxCalls || 10}, External Exten=${v.aiExten}1, On-Hook=N, Status=ACTIVE)`,
    `; 3. Inbound Groups -> Create Closer In-Group "${state.campaigns[0]?.xferTarget || 'FE_CLOSERS'}" & enable in Campaign "Allowed Transfer Groups"`,
    `; 4. Inbound Routing -> Point "${v.inIngroup}" Drop/No-Agent Action -> EXTENSION ${v.aiExten}1`,
    ``,
    dialplanBlock,
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
    `# Set HOST explicitly for remote access after configuring authentication`,
    `HOST=127.0.0.1`,
    `DEEPGRAM_API_KEY=***`,
    `VICI_API_PASS=***`,
    `AMI_SECRET=***`,
    `AUDIOSOCKET_PORT=${v.bridgePort}`,
    `BRIDGE_SIP_PORT=${v.sipPort}`,
  ].join('\n');
}
