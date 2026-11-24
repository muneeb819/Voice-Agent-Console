"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.smokeTestAgent = smokeTestAgent;
exports.smokeTestCampaign = smokeTestCampaign;
/**
 * Smoke test for a bot or campaign. Answers the operator's question after a
 * Save: "is the running server using my change, and will the next call get it?"
 *
 * Calls read the saved state from the database at call start, so a saved change
 * applies to the next call with no restart. This check proves it using the same
 * builder a phone call uses (buildDeepgramSettings + the opening sequence), and
 * reports anything that would silently stop a change from reaching the call.
 */
const campaign_assignment_1 = require("./campaign-assignment");
const settings_builder_1 = require("./settings-builder");
const opening_1 = require("./opening");
const persona_1 = require("./persona");
const AGENT_FIELDS = ['name', 'mode', 'greeting', 'prompt', 'randomGreetingEnabled', 'flow', 'injectCampaignDisclosure', 'acceptViciCalls', 'language', 'behavior', 'stt', 'llm', 'audio', 'fnIds'];
const CAMPAIGN_FIELDS = ['name', 'viciCampaign', 'lists', 'agentId', 'agentIds', 'start', 'end', 'tz', 'attempts', 'retry', 'maxCalls', 'maxCallSec', 'xferType', 'xferTarget', 'fallback', 'dnc', 'disclosure', 'dispos', 'complianceRules'];
const NAMES = {
    prompt: 'Bot instructions', greeting: 'Opening line', complianceRules: 'Campaign rules', name: 'Name', disclosure: 'Recording notice',
    maxCallSec: 'Max call length', dispos: 'Allowed call results', xferTarget: 'Transfer destination', xferType: 'Transfer type',
    randomGreetingEnabled: 'Random openings', injectCampaignDisclosure: 'Speak recording notice', agentIds: 'Assigned bots', agentId: 'Primary bot',
    'behavior.bargeIn': 'Caller can interrupt', 'behavior.bargeInSensitivityPct': 'Barge-in sensitivity', 'behavior.latencyProfile': 'Reply length',
    'behavior.expressionStyle': 'Tone of voice', 'behavior.selfIntro': 'Self-introduction',
};
const nice = (k) => NAMES[k] || k;
const fmt = (n) => n.toLocaleString('en-US');
function stable(value) {
    if (value === undefined)
        return 'undefined';
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(stable).join(',')}]`;
    const obj = value;
    return `{${Object.keys(obj).sort().filter((k) => obj[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable(obj[k])}`).join(',')}}`;
}
/** Field paths that differ between two versions of a bot/campaign. */
function changedFields(a, b, fields, onlyKeysInB = false) {
    const out = [];
    for (const key of fields) {
        if (onlyKeysInB && !(key in (b || {})))
            continue;
        const x = a?.[key];
        const y = b?.[key];
        if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x)) {
            for (const sub of new Set([...Object.keys(x), ...Object.keys(y)]))
                if (stable(x[sub]) !== stable(y[sub]))
                    out.push(`${key}.${sub}`);
        }
        else if (stable(x) !== stable(y))
            out.push(key);
    }
    return out;
}
/** "+3 lines, −1 line" for multi-line text. */
function lineDiff(before, after) {
    const a = String(before || '').split('\n').map((l) => l.trim()).filter(Boolean);
    const b = String(after || '').split('\n').map((l) => l.trim()).filter(Boolean);
    const count = (list) => list.reduce((m, l) => m.set(l, (m.get(l) || 0) + 1), new Map());
    const ca = count(a);
    const cb = count(b);
    let added = 0;
    let removed = 0;
    for (const [l, n] of cb)
        added += Math.max(0, n - (ca.get(l) || 0));
    for (const [l, n] of ca)
        removed += Math.max(0, n - (cb.get(l) || 0));
    const parts = [];
    if (added)
        parts.push(`+${added} line${added === 1 ? '' : 's'}`);
    if (removed)
        parts.push(`−${removed} line${removed === 1 ? '' : 's'}`);
    return parts.join(', ') || 'edited';
}
/** The most recent save that changed this bot/campaign, described in plain words. */
function lastChange(kind, id, current, revisions) {
    const listKey = kind === 'agent' ? 'agents' : 'campaigns';
    const fields = kind === 'agent' ? AGENT_FIELDS : CAMPAIGN_FIELDS;
    let newer = current;
    let newerAt = null;
    for (const rev of revisions) {
        const older = (rev.state?.[listKey] || []).find((x) => x && x.id === id);
        if (!older)
            return newerAt ? { at: newerAt, what: ['created'] } : null;
        const diff = changedFields(older, newer, fields);
        if (diff.length && newerAt) {
            const what = diff.map((f) => (f === 'prompt' || f === 'complianceRules' ? `${nice(f)} ${lineDiff(older[f], newer[f])}` : nice(f)));
            return { at: newerAt, what };
        }
        newer = older;
        newerAt = rev.saved_at;
    }
    return null;
}
function finish(kind, id, name, savedAt, checks) {
    const summary = {
        passed: checks.filter((c) => c.level === 'ok').length,
        warnings: checks.filter((c) => c.level === 'wn').length,
        failed: checks.filter((c) => c.level === 'er').length,
    };
    return { ok: summary.failed === 0, kind, id, name, savedAt, checks, summary };
}
/** What the next phone call on `campaign` with `agent` will contain. */
function nextCallChecks(state, agent, campaign, checks, group) {
    const push = (level, label, detail) => checks.push({ level, label, detail, group });
    let wire;
    try {
        wire = (0, settings_builder_1.buildDeepgramSettings)(state, agent, campaign);
    }
    catch (error) {
        push('er', 'Call setup', error instanceof Error ? error.message : String(error));
        return;
    }
    const prompt = String(wire?.agent?.think?.prompt || '');
    const r = (0, settings_builder_1.promptReachReport)(agent, campaign);
    if (r.instructionsCutChars > 0) {
        push('er', 'Bot instructions reach the call', `The last ${r.cutLines.length} line(s) (${fmt(r.instructionsCutChars)} characters) are cut because the call prompt is full. First line cut: “${(r.cutLines[0] || '').slice(0, 120)}”. Shorten the instructions or the campaign rules.`);
    }
    else {
        push('ok', 'Bot instructions reach the call', `All ${r.instructionsLines} saved lines are in the next call's prompt, including the newest at the end.`);
    }
    const rules = String(campaign.complianceRules || '').trim();
    if (rules && prompt.includes(rules.slice(0, persona_1.MAX_CAMPAIGN_RULES)))
        push(rules.length > persona_1.MAX_CAMPAIGN_RULES ? 'er' : 'ok', 'Campaign rules reach the call', rules.length > persona_1.MAX_CAMPAIGN_RULES ? `Only the first ${fmt(persona_1.MAX_CAMPAIGN_RULES)} of ${fmt(rules.length)} characters are used.` : `All ${fmt(rules.length)} characters of the saved rules are in the next call's prompt.`);
    else
        push('er', 'Campaign rules reach the call', rules ? 'The saved campaign rules are not in the call prompt.' : 'This campaign has no rules saved.');
    if (r.callWillFail)
        push('er', 'Call prompt size', `${fmt(r.phoneChars)} of ${fmt(r.phoneLimit)} characters with the opening — calls cannot start.`);
    else
        push(r.phoneRoom < 1000 ? 'wn' : 'ok', 'Call prompt size', `${fmt(r.phoneChars)} of ${fmt(r.phoneLimit)} characters (${fmt(r.phoneRoom)} to spare)${r.phoneRoom < 1000 ? ' — little room left for more rules' : ''}.`);
    const greeting = String(wire?.agent?.greeting || '');
    if (agent.randomGreetingEnabled)
        push('wn', 'Opening line', 'Random openings are ON, so calls may open with a library greeting instead of the saved opening line.');
    else if (greeting && greeting === (0, opening_1.composeOpening)(agent.greeting, '', agent.injectCampaignDisclosure, campaign.disclosure || ''))
        push('ok', 'Opening line', `Calls open with: “${greeting.length > 160 ? `${greeting.slice(0, 160)}…` : greeting}”`);
    else
        push('er', 'Opening line', 'The saved opening line is not what the next call will say.');
    const pool = (0, campaign_assignment_1.phoneBotPool)(state, campaign);
    const takesCalls = pool.some((a) => a.id === agent.id);
    if (takesCalls) {
        const others = pool.filter((a) => a.id !== agent.id).map((a) => `“${a.name}”`);
        push('ok', 'Who answers phone calls', others.length ? `Phone calls on this campaign are shared in turn between this bot and ${others.join(', ')}.` : 'This bot answers every phone call on this campaign.');
    }
    const limit = Number(campaign.maxCallSec) || 0;
    if (takesCalls && limit > 0)
        push(prompt.includes('CALL TIME LIMIT') ? 'ok' : 'er', 'Max call length', prompt.includes('CALL TIME LIMIT') ? `${limit} s limit applies to the next call.` : `${limit} s limit is saved but not in the call prompt.`);
}
function commonHeader(kind, saved, draft, state, revisions, push) {
    push('ok', 'Saved on the server', `Found in the server's saved settings (last save ${state.updatedAt || 'unknown'}).`);
    const fields = kind === 'agent' ? AGENT_FIELDS : CAMPAIGN_FIELDS;
    const unsaved = draft ? changedFields(saved, draft, fields, true) : [];
    if (unsaved.length)
        push('er', 'Screen matches what is saved', `Not saved yet: ${unsaved.map(nice).join(', ')}. Press Save, then run the smoke test again.`);
    else if (draft)
        push('ok', 'Screen matches what is saved', 'Everything on screen is saved.');
    const change = lastChange(kind, saved.id, saved, revisions);
    if (change)
        push('ok', 'Last saved change', `${change.what.join(' · ')} — saved ${change.at}. Live for every new call since then; calls already in progress keep their old settings until they end.`);
    push('ok', 'Live without restart', 'Each new call reads the saved settings when it starts, so no restart or redeploy is needed.');
}
function smokeTestAgent(state, agentId, draft, revisions = []) {
    const checks = [];
    const push = (level, label, detail) => checks.push({ level, label, detail });
    const agent = state.agents.find((a) => a.id === agentId);
    if (!agent) {
        push('er', 'Saved on the server', 'This bot is not in the saved settings yet. Press Save first, then run the smoke test.');
        return finish('agent', agentId, String(draft?.name || agentId), state.updatedAt || null, checks);
    }
    commonHeader('agent', agent, draft, state, revisions, push);
    const linked = state.campaigns.filter((c) => (Array.isArray(c.agentIds) ? c.agentIds : []).includes(agent.id) || c.agentId === agent.id);
    if (!linked.length)
        push('wn', 'Campaigns', 'Not assigned to any campaign, so phone calls cannot use this bot yet.');
    for (const campaign of linked)
        nextCallChecks(state, agent, campaign, checks, `Next call on “${campaign.name}”`);
    const errors = (0, settings_builder_1.validateAgent)(state, agent).filter((v) => v.level === 'er');
    push(errors.length ? 'wn' : 'ok', 'Pre-flight checks', errors.length ? `${errors.length} not passing: ${errors.slice(0, 3).map((e) => e.message).join('; ')}${errors.length > 3 ? '; …' : ''}` : 'All pre-flight checks pass.');
    return finish('agent', agent.id, agent.name, state.updatedAt || null, checks);
}
function smokeTestCampaign(state, campaignId, draft, revisions = []) {
    const checks = [];
    const push = (level, label, detail) => checks.push({ level, label, detail });
    const campaign = state.campaigns.find((c) => c.id === campaignId);
    if (!campaign) {
        push('er', 'Saved on the server', 'This campaign is not in the saved settings yet. Press Save first, then run the smoke test.');
        return finish('campaign', campaignId, String(draft?.name || campaignId), state.updatedAt || null, checks);
    }
    commonHeader('campaign', campaign, draft, state, revisions, push);
    const ids = Array.from(new Set([campaign.agentId, ...(Array.isArray(campaign.agentIds) ? campaign.agentIds : [])].filter(Boolean)));
    const bots = ids.map((id) => state.agents.find((a) => a.id === id)).filter((a) => Boolean(a) && a.id !== 'a_qa');
    if (!bots.length)
        push('er', 'Assigned bots', 'No calling bot is assigned to this campaign.');
    for (const agent of bots)
        nextCallChecks(state, agent, campaign, checks, `Next call with “${agent.name}”${campaign.agentId === agent.id ? ' (answers phone calls)' : ''}`);
    const errors = (0, settings_builder_1.validateCampaign)(state, campaign).filter((v) => v.level === 'er');
    push(errors.length ? 'wn' : 'ok', 'Pre-flight checks', errors.length ? `${errors.length} not passing: ${errors.slice(0, 3).map((e) => e.message).join('; ')}${errors.length > 3 ? '; …' : ''}` : 'All pre-flight checks pass.');
    return finish('campaign', campaign.id, campaign.name, state.updatedAt || null, checks);
}
