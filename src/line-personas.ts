import type { Agent, AgentLinePersona } from './types';

export const MAX_LINE_PERSONAS = 50;

export const DEFAULT_LINE_PERSONA_PRESETS: Array<{ name: string; voice: string; personaStyle: string }> = [
  { name: 'Jessica', voice: 'aura-stella-en', personaStyle: 'Warm, gentle Oakland California local; patient and caring granddaughter tone.' },
  { name: 'Emma', voice: 'aura-asteria-en', personaStyle: 'Bright, friendly, reassuring; clear and steady cadence for older callers.' },
  { name: 'Chloe', voice: 'aura-luna-en', personaStyle: 'Soft, calm, empathetic; unhurried and respectful listener.' },
  { name: 'Sophia', voice: 'aura-athena-en', personaStyle: 'Confident, polite, warm; crisp pronunciation for benefits and zip codes.' },
  { name: 'Hannah', voice: 'aura-hera-en', personaStyle: 'Kind, approachable, conversational; relaxed everyday warmth.' },
  { name: 'Maya', voice: 'aura-2-thalia-en', personaStyle: 'Upbeat, natural, welcoming; keeps transitions smooth and concise.' },
  { name: 'Rachel', voice: 'aura-2-andromeda-en', personaStyle: 'Gentle, attentive, trustworthy; soft reassuring phrasing.' },
  { name: 'Lauren', voice: 'aura-2-helena-en', personaStyle: 'Polite, grounded, clear; respectful tone with natural warmth.' },
  { name: 'Sarah', voice: 'aura-2-cora-en', personaStyle: 'Friendly, easygoing, empathetic; natural everyday contractions.' },
  { name: 'Claire', voice: 'aura-2-aurora-en', personaStyle: 'Warm, cheerful, patient; crisp clarity on numbers and eligibility.' },
];

export function normalizeLinePersonas(raw: unknown): AgentLinePersona[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentLinePersona[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < raw.length && out.length < MAX_LINE_PERSONAS; i += 1) {
    const item = raw[i] as any;
    if (!item || typeof item !== 'object') continue;
    const name = String(item.name || '').trim().slice(0, 60);
    const voice = String(item.voice || '').trim().slice(0, 120);
    if (!name && !voice) continue;
    const lineNumRaw = Number(item.lineNumber);
    const lineNumber = Number.isInteger(lineNumRaw) && lineNumRaw >= 1 && lineNumRaw <= 500 ? lineNumRaw : out.length + 1;
    let id = String(item.id || `lp_${lineNumber}`).trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48);
    if (!id || seenIds.has(id)) id = `lp_${lineNumber}_${out.length + 1}`;
    seenIds.add(id);
    out.push({
      id,
      lineNumber,
      name: name || `Line ${lineNumber}`,
      voice,
      personaStyle: String(item.personaStyle || '').trim().slice(0, 260),
      greeting: String(item.greeting || '').trim().slice(0, 500),
      introLine: String(item.introLine || '').trim().slice(0, 600),
      active: item.active !== false,
    });
  }
  return out;
}

export function buildDefaultLinePersonas(parentAgent: Pick<Agent, 'name' | 'tts'>, count = 10): AgentLinePersona[] {
  const n = Math.max(1, Math.min(MAX_LINE_PERSONAS, Math.floor(count)));
  const parentFirst = extractFirstName(parentAgent.name);
  const parentVoice = String(parentAgent.tts?.voice || '').trim();
  const out: AgentLinePersona[] = [];
  for (let i = 0; i < n; i += 1) {
    const preset = DEFAULT_LINE_PERSONA_PRESETS[i % DEFAULT_LINE_PERSONA_PRESETS.length];
    const name = i === 0 && parentFirst ? parentFirst : preset.name;
    const voice = i === 0 && parentVoice ? parentVoice : preset.voice;
    out.push({
      id: `lp_${i + 1}`,
      lineNumber: i + 1,
      name,
      voice,
      personaStyle: preset.personaStyle,
      greeting: '',
      introLine: '',
      active: true,
    });
  }
  return out;
}

export function extractFirstName(agentName: string): string {
  const clean = String(agentName || '').trim();
  if (!clean) return '';
  // "Jessica - Medicare" -> "Jessica"; "Jessica Bruce" -> "Jessica"
  const head = clean.split(/[-—–(|]/)[0].trim();
  const token = head.split(/\s+/)[0].replace(/[^A-Za-z']/g, '');
  return token.length >= 2 ? token : '';
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replacePersonaName(text: string, fromName: string, toName: string): string {
  if (!text || !fromName || !toName || fromName.toLowerCase() === toName.toLowerCase()) return text;
  const re = new RegExp(`\\b${escapeRegExp(fromName)}\\b`, 'g');
  return text.replace(re, toName);
}

/**
 * Resolves a 1-to-many line persona under a parent Agent (e.g. 10 sub-bots
 * under Jessica sharing Jessica's master Medicare System Prompt).
 *
 * Returns a call-scoped clone of `agent` with the selected line persona's
 * name, voice, and style applied, while preserving the parent agent's `id`
 * and master System Prompt.
 */
export function resolveAgentForLine(
  agent: Agent,
  opts?: { lineOffset?: number; rotationIndex?: number },
): { agent: Agent; persona: AgentLinePersona | null } {
  const personas = normalizeLinePersonas(agent.linePersonas).filter((p) => p.active);
  if (!personas.length) return { agent, persona: null };

  let picked: AgentLinePersona | undefined;
  const lineOffset = opts?.lineOffset;
  if (typeof lineOffset === 'number' && Number.isInteger(lineOffset) && lineOffset >= 0) {
    // Prefer exact 1-based lineNumber match (offset 0 -> lineNumber 1), else wrap modulo active list
    picked = personas.find((p) => p.lineNumber === lineOffset + 1) || personas[lineOffset % personas.length];
  } else {
    const idx = Math.max(0, Math.floor(Number(opts?.rotationIndex || 0)));
    picked = personas[idx % personas.length];
  }
  if (!picked) return { agent, persona: null };

  const parentFirst = extractFirstName(agent.name);
  const subFirst = extractFirstName(picked.name) || picked.name;
  const swap = (s: string) => replacePersonaName(s, parentFirst, subFirst);

  const styleNote = picked.personaStyle
    ? `\n\nLINE PERSONA (Line ${picked.lineNumber} — ${picked.name}):\n- Your name on this call is ${picked.name}. Introduce yourself as ${picked.name}.\n- Speaking style for this line: ${picked.personaStyle}`
    : `\n\nLINE PERSONA (Line ${picked.lineNumber} — ${picked.name}):\n- Your name on this call is ${picked.name}. Introduce yourself as ${picked.name}.`;

  const nextPrompt = `${swap(agent.prompt || '')}${styleNote}`;
  const nextGreeting = picked.greeting ? picked.greeting : swap(agent.greeting || '');
  const nextFlow = agent.flow
    ? {
        ...agent.flow,
        introLine: picked.introLine ? picked.introLine : swap(agent.flow.introLine || ''),
      }
    : undefined;
  const nextBehavior = {
    ...agent.behavior,
    selfIntro: swap(agent.behavior?.selfIntro || ''),
  };
  const nextTts = {
    ...agent.tts,
    voice: picked.voice || agent.tts?.voice,
  };

  return {
    agent: {
      ...agent,
      prompt: nextPrompt,
      greeting: nextGreeting,
      flow: nextFlow,
      behavior: nextBehavior,
      tts: nextTts,
    },
    persona: picked,
  };
}
