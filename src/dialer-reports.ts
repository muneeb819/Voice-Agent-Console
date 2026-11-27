import type { AlertRecord } from './alerts';
import { BRIDGE_LOG_RETENTION, type BridgeCallLogRecord } from './db';
import type { Campaign, ConsoleState } from './types';

/**
 * Dialer reports.
 *
 * Two kinds of numbers are kept apart on purpose:
 *  - "dialer" numbers come from the dialer itself (VICIdial's read-only report API);
 *  - "bot" numbers come from this console's own call records.
 * Each dialer is a `DialerSource`, so a second dialer can be added without touching the reports.
 */

export interface DialerSource {
  id: string;
  label: string;
  type: 'vicidial';
  /** Runs one read-only report function on the dialer. */
  query(fn: string, params?: Record<string, string>): Promise<{ ok: boolean; status: number; text: string }>;
}

export interface ReportProblem {
  id: string;
  area: 'Dialer' | 'Transfers' | 'Calls' | 'Bots';
  title: string;
  detail: string;
  suggestion: string;
  count: number;
  lastAt?: string;
}

export interface DialerQueryResult {
  ok: boolean;
  /** Parsed rows (pipe-separated fields). Empty when the dialer had nothing to report. */
  rows: string[][];
  problem?: ReportProblem;
}

/** Runs `fn` over `items` with at most `limit` at a time, so one slow dialer cannot stack up waits. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const REPORT_CONCURRENCY = 5;
export const MAX_REPORT_LISTS = 30;
export const MAX_REPORT_IN_GROUPS = 10;
const UNREACHABLE_TITLE = 'The dialer cannot be reached';

export interface Coverage {
  /** Calls available to the reports. */
  kept: number;
  oldestAt: string | null;
  /** True when the console has dropped calls older than `oldestAt` that fall inside the requested window. */
  limited: boolean;
  note: string;
}

/** Says plainly when the kept calls do not reach back as far as the report asks. */
export function coverageOf(logs: BridgeCallLogRecord[], windowStartMs: number, retention = BRIDGE_LOG_RETENTION): Coverage {
  const times = logs.map((l) => Date.parse(l.startedAt)).filter((t) => Number.isFinite(t));
  const oldest = times.length ? Math.min(...times) : null;
  const limited = logs.length >= retention && oldest !== null && oldest > windowStartMs;
  return {
    kept: logs.length,
    oldestAt: oldest === null ? null : new Date(oldest).toISOString(),
    limited,
    note: limited ? `This console keeps only the newest ${retention} calls, so these bot numbers start at ${new Date(oldest!).toLocaleString()}, not at the start of the period.` : '',
  };
}

const BLANK_NOTE = 'The dialer answered with no rows.';

export function parseRows(text: string): string[][] {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split('|').map((c) => c.trim()));
}

/** Turns a dialer error reply into a plain problem with a next step. */
export function classifyDialerReply(fn: string, status: number, text: string): { title: string; detail: string; suggestion: string } {
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

export async function runDialerQuery(source: DialerSource, fn: string, params: Record<string, string> = {}): Promise<DialerQueryResult> {
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

const AGENT_STATES = ['INCALL', 'READY', 'PAUSED', 'CLOSER', 'QUEUE', 'DISPO', 'DEAD', 'MANUAL'] as const;

export interface RealtimeReport {
  dialer: { id: string; label: string };
  at: string;
  /** Agents logged in on the dialer, counted by the state word the dialer reports for them. */
  agents: { loggedIn: number; byState: Record<string, number>; rows: string[][] } | null;
  inGroups: Array<{ id: string; rows: string[][] }>;
  /** In-groups left out because only the first few are queried. */
  omittedInGroups: number;
  bot: { activeCalls: number; capacity: number | null };
  problems: ReportProblem[];
}

export function countAgentStates(rows: string[][]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const hit = AGENT_STATES.find((s) => row.some((c) => c.toUpperCase() === s));
    const key = hit || 'OTHER';
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

export function campaignsOf(state: ConsoleState): Campaign[] {
  return state.campaigns.filter((c) => c.viciCampaign);
}

export async function buildRealtime(
  source: DialerSource,
  state: ConsoleState,
  bot: { activeCalls: number; capacity: number | null }
): Promise<RealtimeReport> {
  const problems: ReportProblem[] = [];
  const logged = await runDialerQuery(source, 'logged_in_agents', { stage: 'pipe', header: 'NO', show_sub_status: 'YES' });
  let agents: RealtimeReport['agents'] = null;
  if (logged.ok) {
    agents = { loggedIn: logged.rows.length, byState: countAgentStates(logged.rows), rows: logged.rows.slice(0, 100) };
  } else if (logged.problem) problems.push(logged.problem);

  const groups = Array.from(
    new Set(state.campaigns.filter((c) => c.xferType === 'ingroup' && c.xferTarget).map((c) => String(c.xferTarget)))
  );
  const inGroups: RealtimeReport['inGroups'] = [];
  // One request per group: with several groups the dialer folds them into a single combined row.
  const answers = await mapLimit(groups.slice(0, MAX_REPORT_IN_GROUPS), REPORT_CONCURRENCY, (g) =>
    runDialerQuery(source, 'in_group_status', { in_groups: g, stage: 'pipe', header: 'NO' })
  );
  groups.slice(0, MAX_REPORT_IN_GROUPS).forEach((g, i) => {
    if (answers[i].ok) inGroups.push({ id: g, rows: answers[i].rows });
    else if (answers[i].problem) problems.push(answers[i].problem!);
  });
  const uniqueProblems = dedupeProblems(problems);
  return { dialer: { id: source.id, label: source.label }, at: new Date().toISOString(), agents, inGroups, omittedInGroups: Math.max(0, groups.length - MAX_REPORT_IN_GROUPS), bot, problems: uniqueProblems };
}

export interface CampaignReportRow {
  campaign: string;
  name: string;
  /** Raw rows from the dialer's call status report for this campaign and day. */
  dialer: string[][];
  dialerNote: string;
  bot: BotNumbers;
}

export interface BotNumbers {
  calls: number;
  transfers: number;
  transferRate: number;
  dnc: number;
  avgDurationSec: number;
  avgTtfbMs: number | null;
  dispositions: Record<string, number>;
}

export function summarizeLogs(logs: BridgeCallLogRecord[]): BotNumbers {
  const calls = logs.length;
  const transfers = logs.filter((l) => l.transferredTo).length;
  const dnc = logs.filter((l) => l.dncAdded || l.disposition === 'DNC' || l.disposition === 'DNCL').length;
  const ttfb = logs.map((l) => l.avgTtfbMs).filter((v): v is number => typeof v === 'number' && v > 0);
  const dispositions: Record<string, number> = {};
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

const dayOf = (iso: string) => String(iso || '').slice(0, 10);

export async function buildCampaignReport(
  source: DialerSource,
  state: ConsoleState,
  logs: BridgeCallLogRecord[],
  date: string
): Promise<{ date: string; rows: CampaignReportRow[]; coverage: Coverage; problems: ReportProblem[] }> {
  const problems: ReportProblem[] = [];
  const camps = campaignsOf(state);
  const answers = await mapLimit(camps, REPORT_CONCURRENCY, (c) =>
    runDialerQuery(source, 'call_status_stats', { campaigns: c.viciCampaign, query_date: date })
  );
  const rows: CampaignReportRow[] = camps.map((c, i) => {
    const q = answers[i];
    if (!q.ok && q.problem) problems.push(q.problem);
    return {
      campaign: c.viciCampaign,
      name: c.name,
      dialer: q.rows,
      dialerNote: q.ok ? (q.rows.length ? '' : BLANK_NOTE) : q.problem!.title,
      bot: summarizeLogs(logs.filter((l) => l.viciCampaign === c.viciCampaign && dayOf(l.startedAt) === date)),
    };
  });
  return { date, rows, coverage: coverageOf(logs, Date.parse(`${date}T00:00:00Z`)), problems: dedupeProblems(problems) };
}

export function listIdsOf(state: ConsoleState): Array<{ listId: string; campaign: string }> {
  const out: Array<{ listId: string; campaign: string }> = [];
  const seen = new Set<string>();
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

export async function buildListReport(source: DialerSource, state: ConsoleState) {
  const problems: ReportProblem[] = [];
  const lists: Array<{ listId: string; campaign: string; rows: string[][]; note: string }> = [];
  const all = listIdsOf(state);
  const wanted = all.slice(0, MAX_REPORT_LISTS);
  let unreachable = false;
  await mapLimit(wanted, REPORT_CONCURRENCY, async (l) => {
    if (unreachable) {
      lists.push({ ...l, rows: [], note: 'Skipped: the dialer did not answer.' });
      return;
    }
    const q = await runDialerQuery(source, 'list_info', { list_id: l.listId, dialable_count: 'Y', leads_counts: 'Y' });
    if (!q.ok && q.problem) {
      problems.push(q.problem);
      if (q.problem.title === UNREACHABLE_TITLE) unreachable = true;
    }
    lists.push({ ...l, rows: q.rows, note: q.ok ? (q.rows.length ? '' : BLANK_NOTE) : q.problem!.title });
  });
  lists.sort((a, b) => wanted.findIndex((w) => w.listId === a.listId) - wanted.findIndex((w) => w.listId === b.listId));
  return { lists, omittedLists: Math.max(0, all.length - wanted.length), problems: dedupeProblems(problems) };
}

export interface BotReport {
  sinceHours: number;
  totals: BotNumbers;
  byBot: Array<{ agentId: string; agentName: string } & BotNumbers>;
  byCampaign: Array<{ campaign: string } & BotNumbers>;
  coverage: Coverage;
}

export function buildBotReport(logs: BridgeCallLogRecord[], sinceHours: number, now = Date.now()): BotReport {
  const cutoff = now - sinceHours * 3600_000;
  const inWindow = logs.filter((l) => Date.parse(l.startedAt) >= cutoff);
  const group = <K extends string>(key: (l: BridgeCallLogRecord) => K) => {
    const m = new Map<K, BridgeCallLogRecord[]>();
    for (const l of inWindow) m.set(key(l), [...(m.get(key(l)) || []), l]);
    return m;
  };
  const names = new Map(inWindow.map((l) => [l.agentId, l.agentName]));
  return {
    sinceHours,
    coverage: coverageOf(logs, cutoff),
    totals: summarizeLogs(inWindow),
    byBot: [...group((l) => l.agentId)].map(([agentId, ls]) => ({ agentId, agentName: names.get(agentId) || agentId, ...summarizeLogs(ls) })).sort((a, b) => b.calls - a.calls),
    byCampaign: [...group((l) => l.viciCampaign || 'UNASSIGNED')].map(([campaign, ls]) => ({ campaign, ...summarizeLogs(ls) })).sort((a, b) => b.calls - a.calls),
  };
}

function dedupeProblems(list: ReportProblem[]): ReportProblem[] {
  const m = new Map<string, ReportProblem>();
  for (const p of list) {
    const prev = m.get(p.id);
    if (prev) prev.count += p.count;
    else m.set(p.id, { ...p });
  }
  return [...m.values()];
}

const API_FAIL_ADVICE: Record<string, string> = {
  transfer_remote_agent_call: 'Check the transfer target (in-group or extension) and that the remote agent session is still logged in.',
  hangup_remote_agent_call: 'The call may already have ended; if it keeps happening, check the remote agent user.',
  update_lead: 'Check the API user may edit leads and the lead still exists.',
  add_dnc_phone: 'Check the API user may edit DNC lists.',
  lead_search: 'Check the API user may read leads.',
};

/** Errors seen in recent calls and active alerts, each with what to do next. */
export function buildProblems(logs: BridgeCallLogRecord[], alerts: AlertRecord[], now = Date.now(), sinceHours = 24): ReportProblem[] {
  const cutoff = now - sinceHours * 3600_000;
  const out: ReportProblem[] = [];
  const byFn = new Map<string, { count: number; last: string; sample: string }>();
  for (const l of logs) {
    if (Date.parse(l.startedAt) < cutoff) continue;
    for (const a of l.viciApiAudit || []) {
      if (a.ok) continue;
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
    if (a.acknowledged) continue;
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

export interface KeyedTable {
  headers: string[];
  records: Array<Record<string, string>>;
  rows: string[][];
}

export interface UserActivityStatsReport {
  dialer: { id: string; label: string };
  at: string;
  dateRange: { start: string; end: string };
  requestedUsers: string[];
  campaign: string | null;
  userGroup: string | null;
  summary: {
    loggedInCount: number;
    byState: Record<string, number>;
    statsRowCount: number;
    queriedUsers: number;
  };
  liveAgents: KeyedTable | null;
  userDetails: Array<{ user: string; ok: boolean; profile: Record<string, string> | null; rows: string[][] }>;
  liveStatus: Array<{ user: string; ok: boolean; status: Record<string, string> | null; rows: string[][] }>;
  statsExport: KeyedTable | null;
  problems: ReportProblem[];
}

export function parseKeyedRows(text: string): KeyedTable {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^NOTICE:/i.test(l));
  if (!lines.length) return { headers: [], records: [], rows: [] };
  const delim = lines[0].includes('|') ? '|' : ',';
  const rows = lines.map((l) => l.split(delim).map((c) => c.trim().replace(/^"|"$/g, '')));
  if (rows.length < 2) return { headers: [], records: [], rows };
  const headers = rows[0].map((h, i) => (h || `col_${i + 1}`).toLowerCase().replace(/\s+/g, '_'));
  const records = rows.slice(1).map((vals) => {
    const obj: Record<string, string> = {};
    for (let i = 0; i < headers.length; i += 1) {
      obj[headers[i]] = vals[i] ?? '';
    }
    return obj;
  });
  return { headers, records, rows: rows.slice(1) };
}

export const MAX_USER_ACTIVITY_TARGETS = 20;

export async function buildUserActivityStats(
  source: DialerSource,
  opts: {
    users?: string[];
    datetimeStart: string;
    datetimeEnd: string;
    campaign?: string;
    userGroup?: string;
  }
): Promise<UserActivityStatsReport> {
  const problems: ReportProblem[] = [];
  const cleanUsers = Array.from(
    new Set(
      (opts.users || [])
        .map((u) => String(u || '').trim())
        .filter((u) => /^[A-Za-z0-9_.@-]{1,20}$/.test(u))
    )
  ).slice(0, MAX_USER_ACTIVITY_TARGETS);

  const campaign = opts.campaign && /^[A-Za-z0-9_-]{1,20}$/.test(opts.campaign.trim()) ? opts.campaign.trim() : '';
  const userGroup = opts.userGroup && /^[A-Za-z0-9_-]{1,20}$/.test(opts.userGroup.trim()) ? opts.userGroup.trim() : '';

  const loggedParams: Record<string, string> = { stage: 'pipe', header: 'YES', show_sub_status: 'YES' };
  if (campaign) loggedParams.campaigns = campaign;
  if (userGroup) loggedParams.user_groups = userGroup;

  const statsParams: Record<string, string> = {
    datetime_start: opts.datetimeStart,
    datetime_end: opts.datetimeEnd,
    stage: 'pipe',
    header: 'YES',
    time_format: 'H',
  };
  if (cleanUsers.length === 1) statsParams.agent_user = cleanUsers[0];
  if (campaign) statsParams.campaign_id = campaign;
  if (userGroup) statsParams.user_group = userGroup;

  const [loggedRaw, statsRaw] = await Promise.all([
    source.query('logged_in_agents', loggedParams),
    source.query('agent_stats_export', statsParams),
  ]);

  let liveAgents: KeyedTable | null = null;
  if (loggedRaw.ok) {
    liveAgents = parseKeyedRows(loggedRaw.text);
  } else {
    const c = classifyDialerReply('logged_in_agents', loggedRaw.status, loggedRaw.text);
    problems.push({ id: `dialer.${source.id}.logged_in_agents`, area: 'Dialer', count: 1, ...c });
  }

  let statsExport: KeyedTable | null = null;
  if (statsRaw.ok) {
    const parsed = parseKeyedRows(statsRaw.text);
    if (cleanUsers.length > 1) {
      const wanted = new Set(cleanUsers.map((u) => u.toLowerCase()));
      const filtered = parsed.records.filter((r) => wanted.has(String(r.user || r.agent_user || '').toLowerCase()));
      statsExport = { headers: parsed.headers, records: filtered, rows: filtered.map((r) => parsed.headers.map((h) => r[h] || '')) };
    } else {
      statsExport = parsed;
    }
  } else {
    const c = classifyDialerReply('agent_stats_export', statsRaw.status, statsRaw.text);
    problems.push({ id: `dialer.${source.id}.agent_stats_export`, area: 'Dialer', count: 1, ...c });
  }

  const dialerUnreachable = problems.some((p) => p.title === UNREACHABLE_TITLE);
  const userDetails: UserActivityStatsReport['userDetails'] = [];
  const liveStatus: UserActivityStatsReport['liveStatus'] = [];

  if (cleanUsers.length && !dialerUnreachable) {
    const perUser = await mapLimit(cleanUsers, REPORT_CONCURRENCY, async (u) => {
      const [detRaw, stRaw] = await Promise.all([
        source.query('user_details', { agent_user: u, stage: 'pipe', header: 'YES' }),
        source.query('agent_status', { agent_user: u, stage: 'csv', header: 'YES' }),
      ]);
      return { user: u, detRaw, stRaw };
    });

    for (const item of perUser) {
      if (item.detRaw.ok) {
        const parsed = parseKeyedRows(item.detRaw.text);
        userDetails.push({ user: item.user, ok: true, profile: parsed.records[0] || null, rows: parsed.rows });
      } else {
        const c = classifyDialerReply('user_details', item.detRaw.status, item.detRaw.text);
        problems.push({ id: `dialer.${source.id}.user_details`, area: 'Dialer', count: 1, ...c });
        userDetails.push({ user: item.user, ok: false, profile: null, rows: [] });
      }

      if (item.stRaw.ok) {
        const parsed = parseKeyedRows(item.stRaw.text);
        liveStatus.push({ user: item.user, ok: true, status: parsed.records[0] || null, rows: parsed.rows });
      } else {
        const c = classifyDialerReply('agent_status', item.stRaw.status, item.stRaw.text);
        problems.push({ id: `dialer.${source.id}.agent_status`, area: 'Dialer', count: 1, ...c });
        liveStatus.push({ user: item.user, ok: false, status: null, rows: [] });
      }
    }
  }

  const liveRows = liveAgents ? liveAgents.rows : [];
  return {
    dialer: { id: source.id, label: source.label },
    at: new Date().toISOString(),
    dateRange: { start: opts.datetimeStart, end: opts.datetimeEnd },
    requestedUsers: cleanUsers,
    campaign: campaign || null,
    userGroup: userGroup || null,
    summary: {
      loggedInCount: liveAgents ? liveAgents.records.length : 0,
      byState: countAgentStates(liveRows),
      statsRowCount: statsExport ? statsExport.records.length : 0,
      queriedUsers: cleanUsers.length,
    },
    liveAgents,
    userDetails,
    liveStatus,
    statsExport,
    problems: dedupeProblems(problems),
  };
}

/** The dialers this console can report on. Add a source here to report on a second dialer. */
export function buildSources(
  state: ConsoleState,
  makeQuery: (state: ConsoleState) => DialerSource['query']
): DialerSource[] {
  let host = state.vici.viciBaseUrl || '';
  try {
    host = new URL(host).host;
  } catch {}
  return [{ id: 'default', label: host ? `VICIdial (${host})` : 'VICIdial', type: 'vicidial', query: makeQuery(state) }];
}
