/**
 * Smoke test for a bot or campaign: proves the settings an operator edited are
 * (1) saved in the server's JSON state and (2) actually reach the prompt a live
 * phone call would send to Deepgram. It uses the same builder a call uses
 * (buildDeepgramSettings + the opening sequence), so a pass here is not a guess.
 */
import type { Agent, Campaign, ConsoleState } from './types';
import { buildDeepgramSettings, validateAgent, validateCampaign } from './settings-builder';
import { MED_BENEFITS_RULE_MARKER, MAX_CAMPAIGN_RULES } from './persona';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { prepareDelayedOpening } = require('../public/opening.js');

export type SmokeLevel = 'ok' | 'wn' | 'er';
export interface SmokeCheck { level: SmokeLevel; label: string; detail: string; group?: string }
export interface SmokeResult {
  ok: boolean;
  kind: 'agent' | 'campaign';
  id: string;
  name: string;
  savedAt: string | null;
  checks: SmokeCheck[];
  summary: { passed: number; warnings: number; failed: number };
}

const PROMPT_HARD_LIMIT = 25000;

// Fields an operator edits on each form. Compared screen-vs-saved so an
// unsaved edit is reported instead of silently "passing" on old settings.
const AGENT_FIELDS = ['name', 'mode', 'greeting', 'prompt', 'randomGreetingEnabled', 'injectCampaignDisclosure', 'acceptViciCalls', 'language', 'behavior', 'stt', 'llm', 'audio', 'fnIds'];
const CAMPAIGN_FIELDS = ['name', 'viciCampaign', 'lists', 'agentId', 'agentIds', 'start', 'end', 'tz', 'attempts', 'retry', 'maxCalls', 'maxCallSec', 'xferType', 'xferTarget', 'fallback', 'dnc', 'disclosure', 'dispos', 'complianceRules'];

function stable(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().filter((k) => obj[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable(obj[k])}`).join(',')}}`;
}

function unsavedFields(saved: any, draft: any, fields: string[]): string[] {
  if (!draft || typeof draft !== 'object') return [];
  const out: string[] = [];
  for (const key of fields) {
    if (!(key in draft)) continue;
    const a = saved?.[key];
    const b = draft[key];
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a)) {
      for (const sub of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (stable(a[sub]) !== stable(b[sub])) out.push(`${key}.${sub}`);
      }
    } else if (stable(a) !== stable(b)) {
      out.push(key);
    }
  }
  return out;
}

const FIELD_NAMES: Record<string, string> = {
  prompt: 'Bot instructions', greeting: 'Opening line', complianceRules: 'Campaign rules', name: 'Name',
  'behavior.bargeIn': 'Caller can interrupt', 'behavior.bargeInSensitivityPct': 'Interrupt sensitivity',
  'behavior.backgroundVoiceFilterPct': 'Background voice filter', 'behavior.latencyProfile': 'Reply length',
  maxCallSec: 'Max call length', dispos: 'Allowed call results', xferTarget: 'Transfer destination',
};
const nice = (k: string) => FIELD_NAMES[k] || k;

function callPromptChecks(state: ConsoleState, agent: Agent, campaign: Campaign, checks: SmokeCheck[], groupName: string) {
  const push = (level: SmokeLevel, label: string, detail: string) => checks.push({ level, label, detail, group: groupName });
  let wire: any;
  try {
    wire = buildDeepgramSettings(state, agent, campaign);
  } catch (error) {
    push('er', 'Call setup', error instanceof Error ? error.message : String(error));
    return;
  }
  const think = String(wire?.agent?.think?.prompt || '');
  let finalPrompt = think;
  let tooLong = false;
  try {
    finalPrompt = String(prepareDelayedOpening(wire).settings.agent.think.prompt || '');
  } catch (error) {
    tooLong = true;
    push('er', 'Prompt size', `${error instanceof Error ? error.message : String(error)} (${think.length.toLocaleString('en-US')} characters before the opening sequence).`);
  }
  const size = finalPrompt.length;
  const headroom = PROMPT_HARD_LIMIT - size;
  if (!tooLong) {
    push(headroom < 500 ? 'wn' : 'ok', 'Prompt size',
      `${size.toLocaleString('en-US')} of ${PROMPT_HARD_LIMIT.toLocaleString('en-US')} characters on a phone call (${headroom.toLocaleString('en-US')} to spare)${headroom < 500 ? ' — very little room; shorten the instructions or rules before adding more' : ''}.`);
  }

  const instructions = String(agent.prompt || '').trim();
  if (think.includes('[Agent prompt shortened to preserve the mandatory campaign rules below.]') || (instructions && !think.includes(instructions))) {
    const kept = instructions ? instructions.split('\n').filter((line) => line.trim() && think.includes(line)).length : 0;
    const total = instructions.split('\n').filter((line) => line.trim()).length;
    push('er', 'Bot instructions reach the call', `Cut short: only ${kept} of ${total} lines fit. Shorten the instructions or the campaign rules.`);
  } else {
    push('ok', 'Bot instructions reach the call', `All ${instructions.split('\n').filter((l) => l.trim()).length} lines of the saved instructions are in the call prompt.`);
  }

  const rules = String(campaign.complianceRules || '').trim().slice(0, MAX_CAMPAIGN_RULES);
  if (rules && think.includes(rules)) push('ok', 'Campaign rules reach the call', `All ${rules.length.toLocaleString('en-US')} characters of the saved campaign rules are in the call prompt.`);
  else push('er', 'Campaign rules reach the call', 'The saved campaign rules were not found in the call prompt.');

  const greeting = String(wire?.agent?.greeting || '');
  if (agent.randomGreetingEnabled) push('wn', 'Opening line', 'Random openings are ON: calls may use a library greeting instead of the saved opening line.');
  else if (greeting && greeting === String(agent.greeting || '').trim()) push('ok', 'Opening line', `Calls open with: “${greeting.length > 140 ? `${greeting.slice(0, 140)}…` : greeting}”`);
  else push('er', 'Opening line', 'The saved opening line is not what the call will say.');

  const isPrimary = campaign.agentId === agent.id;
  const limit = Number(campaign.maxCallSec) || 0;
  if (isPrimary && limit > 0) {
    if (think.includes('CALL TIME LIMIT')) push('ok', 'Max call length', `${limit} s limit is in the call prompt and enforced by the bridge.`);
    else push('er', 'Max call length', `${limit} s limit is saved but missing from the call prompt.`);
  }

  const fnNames = (Array.isArray(wire?.agent?.think?.functions) ? wire.agent.think.functions : []).map((f: any) => String(f.name));
  const missing = ['transfer_to_live_agent', 'set_disposition', 'end_call'].filter((n) => !fnNames.includes(n));
  push(missing.length ? 'wn' : 'ok', 'Actions on the call', fnNames.length ? `${fnNames.join(', ')}${missing.length ? ` — missing: ${missing.join(', ')}` : ''}` : 'No actions enabled.');

  const dispoFn = (wire?.agent?.think?.functions || []).find((f: any) => f.name === 'set_disposition');
  const allowed: string[] = dispoFn?.parameters?.properties?.code?.enum || [];
  const configured = String(campaign.dispos || '').split(',').map((d) => d.trim()).filter(Boolean);
  if (dispoFn && configured.length) {
    const absent = configured.filter((d) => !allowed.includes(d));
    push(absent.length ? 'er' : 'ok', 'Call results the bot can set', absent.length ? `Not wired: ${absent.join(', ')}` : configured.join(', '));
  }

  if (String(campaign.complianceRules || '').includes(MED_BENEFITS_RULE_MARKER)) {
    push('ok', 'Transfer gate', 'Med Benefits screening is enforced by the server: no transfer unless the caller stated an age in range (30–64 also needs a disability yes) and confirmed BOTH Part A and Part B.');
  }
}

function finish(kind: 'agent' | 'campaign', id: string, name: string, savedAt: string | null, checks: SmokeCheck[]): SmokeResult {
  const summary = {
    passed: checks.filter((c) => c.level === 'ok').length,
    warnings: checks.filter((c) => c.level === 'wn').length,
    failed: checks.filter((c) => c.level === 'er').length,
  };
  return { ok: summary.failed === 0, kind, id, name, savedAt, checks, summary };
}

export function smokeTestAgent(state: ConsoleState, agentId: string, draft?: unknown): SmokeResult {
  const checks: SmokeCheck[] = [];
  const push = (level: SmokeLevel, label: string, detail: string) => checks.push({ level, label, detail });
  const agent = state.agents.find((a) => a.id === agentId);
  if (!agent) {
    push('er', 'Saved in the server database', 'This bot is not in the saved JSON yet. Press Save first, then run the smoke test.');
    return finish('agent', agentId, String((draft as any)?.name || agentId), state.updatedAt || null, checks);
  }
  push('ok', 'Saved in the server database', `Found in the saved JSON (last save ${state.updatedAt || 'unknown'}).`);
  const diff = unsavedFields(agent, draft, AGENT_FIELDS);
  if (diff.length) push('er', 'Screen matches saved JSON', `Unsaved changes: ${diff.map(nice).join(', ')}. Press Save, then run the smoke test again.`);
  else if (draft) push('ok', 'Screen matches saved JSON', 'Everything on screen is saved; calls will use exactly these settings.');

  const b: any = agent.behavior || {};
  const bargeIn = b.bargeIn === 'off' ? 'No — bot finishes speaking first' : b.bargeIn === 'server' ? 'Yes — Deepgram detection' : 'Yes — fastest detection';
  push('ok', 'Saved behaviour', `Interrupt: ${bargeIn}${b.bargeIn === 'off' ? '' : ` at ${b.bargeInSensitivityPct}%`} · Background voice filter: ${Number(b.backgroundVoiceFilterPct) > 0 ? `${b.backgroundVoiceFilterPct}%` : 'off'} · Reply length: ${b.latencyProfile || 'balanced'}`);

  const linked = state.campaigns.filter((c) => (Array.isArray(c.agentIds) ? c.agentIds : []).includes(agent.id) || c.agentId === agent.id);
  if (!linked.length) push('wn', 'Assigned campaigns', 'Not assigned to any campaign, so phone calls cannot use this bot yet.');
  for (const campaign of linked) callPromptChecks(state, agent, campaign, checks, `On campaign “${campaign.name}”`);

  const errors = validateAgent(state, agent).filter((v) => v.level === 'er');
  if (errors.length) push('wn', 'Pre-flight checks', `${errors.length} not passing yet: ${errors.slice(0, 3).map((e) => e.message).join('; ')}${errors.length > 3 ? '; …' : ''}`);
  else push('ok', 'Pre-flight checks', 'All pre-flight checks pass.');
  return finish('agent', agent.id, agent.name, state.updatedAt || null, checks);
}

export function smokeTestCampaign(state: ConsoleState, campaignId: string, draft?: unknown): SmokeResult {
  const checks: SmokeCheck[] = [];
  const push = (level: SmokeLevel, label: string, detail: string) => checks.push({ level, label, detail });
  const campaign = state.campaigns.find((c) => c.id === campaignId);
  if (!campaign) {
    push('er', 'Saved in the server database', 'This campaign is not in the saved JSON yet. Press Save first, then run the smoke test.');
    return finish('campaign', campaignId, String((draft as any)?.name || campaignId), state.updatedAt || null, checks);
  }
  push('ok', 'Saved in the server database', `Found in the saved JSON (last save ${state.updatedAt || 'unknown'}).`);
  const diff = unsavedFields(campaign, draft, CAMPAIGN_FIELDS);
  if (diff.length) push('er', 'Screen matches saved JSON', `Unsaved changes: ${diff.map(nice).join(', ')}. Press Save, then run the smoke test again.`);
  else if (draft) push('ok', 'Screen matches saved JSON', 'Everything on screen is saved; calls will use exactly these settings.');

  const rules = String(campaign.complianceRules || '');
  push(rules.length >= 20 && rules.length <= MAX_CAMPAIGN_RULES ? 'ok' : 'er', 'Campaign rules length', `${rules.length.toLocaleString('en-US')} characters (allowed 20–${MAX_CAMPAIGN_RULES.toLocaleString('en-US')}).`);
  push(campaign.viciCampaign ? 'ok' : 'er', 'VICIdial campaign ID', campaign.viciCampaign || 'Missing.');
  push(campaign.xferTarget ? 'ok' : 'wn', 'Transfer destination', campaign.xferTarget ? `${campaign.xferType}: ${campaign.xferTarget}` : 'Not set: qualified callers cannot be transferred.');
  push('ok', 'Max call length', Number(campaign.maxCallSec) > 0 ? `${campaign.maxCallSec} seconds` : 'No limit.');

  const ids = Array.from(new Set([campaign.agentId, ...(Array.isArray(campaign.agentIds) ? campaign.agentIds : [])].filter(Boolean)));
  const bots = ids.map((id) => state.agents.find((a) => a.id === id)).filter((a): a is Agent => Boolean(a) && a!.id !== 'a_qa');
  if (!bots.length) push('er', 'Assigned bots', 'No calling bot is assigned to this campaign.');
  for (const agent of bots) callPromptChecks(state, agent, campaign, checks, `Bot “${agent.name}”`);

  const errors = validateCampaign(state, campaign).filter((v) => v.level === 'er');
  if (errors.length) push('wn', 'Pre-flight checks', `${errors.length} not passing yet: ${errors.slice(0, 3).map((e) => e.message).join('; ')}${errors.length > 3 ? '; …' : ''}`);
  else push('ok', 'Pre-flight checks', 'All pre-flight checks pass.');
  return finish('campaign', campaign.id, campaign.name, state.updatedAt || null, checks);
}
