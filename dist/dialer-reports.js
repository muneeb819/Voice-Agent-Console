"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseRows = parseRows;
exports.classifyDialerReply = classifyDialerReply;
exports.runDialerQuery = runDialerQuery;
exports.countAgentStates = countAgentStates;
exports.campaignsOf = campaignsOf;
exports.buildRealtime = buildRealtime;
exports.summarizeLogs = summarizeLogs;
exports.buildCampaignReport = buildCampaignReport;
exports.listIdsOf = listIdsOf;
exports.buildListReport = buildListReport;
exports.buildBotReport = buildBotReport;
exports.buildProblems = buildProblems;
exports.buildSources = buildSources;
const BLANK_NOTE = 'The dialer answered with no rows.';
function parseRows(text) {
    return String(text || '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => l.split('|').map((c) => c.trim()));
}
/** Turns a dialer error reply into a plain problem with a next step. */
function classifyDialerReply(fn, status, text) {
    const t = String(text || '');
    const detail = t.replace(/^ERROR:\s*/i, '').slice(0, 200) || 'No reply from the dialer.';
    if (status === 0 || /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|timeout|network/i.test(t)) {
        return {
            title: 'The dialer cannot be reached',
            detail,
            suggestion: 'Check the VICIdial address under Vici Bridge and that the dialer web server accepts requests from this server.',
        };
    }
    if (/invalid|bad (user|pass|login)|login|not a valid user|user.*(not found|does not exist)/i.test(t) && !/function/i.test(t)) {
        return {
            title: 'The dialer refused the API login',
            detail,
            suggestion: 'Check the API user and the saved API password, and that the user has API access in VICIdial.',
        };
    }
    if (/permission|not allowed|user level|no access|view reports|api_only/i.test(t)) {
        return {
            title: 'This API user may not run reports',
            detail,
            suggestion: 'In VICIdial, give this API user a high enough user level and the permission to view reports and use the API.',
        };
    }
    if (/function|not supported|unknown|not found|invalid_function/i.test(t) || status === 404) {
        return {
            title: `This dialer does not offer "${fn}"`,
            detail,
            suggestion: 'This usually means an older VICIdial version. The rest of the report still works; upgrade VICIdial if you need this section.',
        };
    }
    return {
        title: `The dialer could not run "${fn}"`,
        detail,
        suggestion: 'Open the dialer in a browser and check the same report there; if it fails too, the problem is on the dialer.',
    };
}
async function runDialerQuery(source, fn, params = {}) {
    const r = await source.query(fn, params);
    if (!r.ok) {
        const c = classifyDialerReply(fn, r.status, r.text);
        return {
            ok: false,
            rows: [],
            problem: { id: `dialer.${source.id}.${fn}`, area: 'Dialer', count: 1, ...c },
        };
    }
    return { ok: true, rows: parseRows(r.text) };
}
const AGENT_STATES = ['INCALL', 'READY', 'PAUSED', 'CLOSER', 'QUEUE', 'DISPO', 'DEAD', 'MANUAL'];
function countAgentStates(rows) {
    const out = {};
    for (const row of rows) {
        const hit = AGENT_STATES.find((s) => row.some((c) => c.toUpperCase() === s));
        const key = hit || 'OTHER';
        out[key] = (out[key] || 0) + 1;
    }
    return out;
}
function campaignsOf(state) {
    return state.campaigns.filter((c) => c.viciCampaign);
}
async function buildRealtime(source, state, bot) {
    const problems = [];
    const logged = await runDialerQuery(source, 'logged_in_agents', { stage: 'pipe', header: 'NO', show_sub_status: 'YES' });
    let agents = null;
    if (logged.ok) {
        agents = { loggedIn: logged.rows.length, byState: countAgentStates(logged.rows), rows: logged.rows.slice(0, 100) };
    }
    else if (logged.problem)
        problems.push(logged.problem);
    const groups = Array.from(new Set(state.campaigns.filter((c) => c.xferType === 'ingroup' && c.xferTarget).map((c) => String(c.xferTarget))));
    const inGroups = [];
    if (groups.length) {
        const r = await runDialerQuery(source, 'in_group_status', { in_groups: groups.join('|'), stage: 'pipe', header: 'NO' });
        if (r.ok)
            for (const g of groups)
                inGroups.push({ id: g, rows: r.rows.filter((row) => row[0] === g || row.includes(g)) });
        else if (r.problem)
            problems.push(r.problem);
    }
    return { dialer: { id: source.id, label: source.label }, at: new Date().toISOString(), agents, inGroups, bot, problems };
}
function summarizeLogs(logs) {
    const calls = logs.length;
    const transfers = logs.filter((l) => l.transferredTo).length;
    const dnc = logs.filter((l) => l.dncAdded || l.disposition === 'DNC' || l.disposition === 'DNCL').length;
    const ttfb = logs.map((l) => l.avgTtfbMs).filter((v) => typeof v === 'number' && v > 0);
    const dispositions = {};
    for (const l of logs) {
        const d = l.disposition || 'UNSET';
        dispositions[d] = (dispositions[d] || 0) + 1;
    }
    return {
        calls,
        transfers,
        transferRate: calls ? Number(((transfers / calls) * 100).toFixed(1)) : 0,
        dnc,
        avgDurationSec: calls ? Number((logs.reduce((s, l) => s + (l.durationMs || 0), 0) / calls / 1000).toFixed(1)) : 0,
        avgTtfbMs: ttfb.length ? Math.round(ttfb.reduce((a, b) => a + b, 0) / ttfb.length) : null,
        dispositions,
    };
}
const dayOf = (iso) => String(iso || '').slice(0, 10);
async function buildCampaignReport(source, state, logs, date) {
    const problems = [];
    const rows = [];
    for (const c of campaignsOf(state)) {
        const q = await runDialerQuery(source, 'call_status_stats', { campaigns: c.viciCampaign, query_date: date });
        if (!q.ok && q.problem)
            problems.push(q.problem);
        rows.push({
            campaign: c.viciCampaign,
            name: c.name,
            dialer: q.rows,
            dialerNote: q.ok ? (q.rows.length ? '' : BLANK_NOTE) : q.problem.title,
            bot: summarizeLogs(logs.filter((l) => l.viciCampaign === c.viciCampaign && dayOf(l.startedAt) === date)),
        });
    }
    return { date, rows, problems: dedupeProblems(problems) };
}
function listIdsOf(state) {
    const out = [];
    const seen = new Set();
    for (const c of campaignsOf(state)) {
        for (const id of String(c.lists || '').split(/[\s,;|]+/)) {
            if (/^\d{1,12}$/.test(id) && !seen.has(id)) {
                seen.add(id);
                out.push({ listId: id, campaign: c.viciCampaign });
            }
        }
    }
    return out;
}
async function buildListReport(source, state) {
    const problems = [];
    const lists = [];
    for (const l of listIdsOf(state).slice(0, 30)) {
        const q = await runDialerQuery(source, 'list_info', { list_id: l.listId, dialable_count: 'Y', leads_counts: 'Y' });
        if (!q.ok && q.problem)
            problems.push(q.problem);
        lists.push({ ...l, rows: q.rows, note: q.ok ? (q.rows.length ? '' : BLANK_NOTE) : q.problem.title });
    }
    return { lists, problems: dedupeProblems(problems) };
}
function buildBotReport(logs, sinceHours, now = Date.now()) {
    const cutoff = now - sinceHours * 3600_000;
    const inWindow = logs.filter((l) => Date.parse(l.startedAt) >= cutoff);
    const group = (key) => {
        const m = new Map();
        for (const l of inWindow)
            m.set(key(l), [...(m.get(key(l)) || []), l]);
        return m;
    };
    const names = new Map(inWindow.map((l) => [l.agentId, l.agentName]));
    return {
        sinceHours,
        totals: summarizeLogs(inWindow),
        byBot: [...group((l) => l.agentId)].map(([agentId, ls]) => ({ agentId, agentName: names.get(agentId) || agentId, ...summarizeLogs(ls) })).sort((a, b) => b.calls - a.calls),
        byCampaign: [...group((l) => l.viciCampaign || 'UNASSIGNED')].map(([campaign, ls]) => ({ campaign, ...summarizeLogs(ls) })).sort((a, b) => b.calls - a.calls),
    };
}
function dedupeProblems(list) {
    const m = new Map();
    for (const p of list) {
        const prev = m.get(p.id);
        if (prev)
            prev.count += p.count;
        else
            m.set(p.id, { ...p });
    }
    return [...m.values()];
}
const API_FAIL_ADVICE = {
    transfer_remote_agent_call: 'Check the transfer target (in-group or extension) and that the remote agent session is still logged in.',
    hangup_remote_agent_call: 'The call may already have ended; if it keeps happening, check the remote agent user.',
    update_lead: 'Check the API user may edit leads and the lead still exists.',
    add_dnc_phone: 'Check the API user may edit DNC lists.',
    lead_search: 'Check the API user may read leads.',
};
/** Errors seen in recent calls and active alerts, each with what to do next. */
function buildProblems(logs, alerts, now = Date.now(), sinceHours = 24) {
    const cutoff = now - sinceHours * 3600_000;
    const out = [];
    const byFn = new Map();
    for (const l of logs) {
        if (Date.parse(l.startedAt) < cutoff)
            continue;
        for (const a of l.viciApiAudit || []) {
            if (a.ok)
                continue;
            const prev = byFn.get(a.fn) || { count: 0, last: '', sample: '' };
            prev.count += 1;
            if (a.ts > prev.last) {
                prev.last = a.ts;
                prev.sample = a.responseText;
            }
            byFn.set(a.fn, prev);
        }
    }
    for (const [fn, v] of byFn) {
        const c = classifyDialerReply(fn, 200, v.sample);
        out.push({
            id: `calls.${fn}`,
            area: /transfer|hangup/.test(fn) ? 'Transfers' : 'Calls',
            title: `${v.count} failed dialer request${v.count === 1 ? '' : 's'}: ${fn}`,
            detail: c.detail,
            suggestion: API_FAIL_ADVICE[fn] || c.suggestion,
            count: v.count,
            lastAt: v.last,
        });
    }
    for (const a of alerts) {
        if (a.acknowledged)
            continue;
        out.push({
            id: `alert.${a.key}`,
            area: 'Bots',
            title: a.title,
            detail: a.detail,
            suggestion: 'Open Diagnostics and run a scan; it points at the cause.',
            count: a.count,
            lastAt: a.lastAt,
        });
    }
    return out.sort((a, b) => b.count - a.count);
}
/** The dialers this console can report on. Add a source here to report on a second dialer. */
function buildSources(state, makeQuery) {
    let host = state.vici.viciBaseUrl || '';
    try {
        host = new URL(host).host;
    }
    catch { }
    return [{ id: 'default', label: host ? `VICIdial (${host})` : 'VICIdial', type: 'vicidial', query: makeQuery(state) }];
}
