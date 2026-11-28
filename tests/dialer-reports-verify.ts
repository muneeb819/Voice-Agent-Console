import assert from 'assert';
import { createDefaultState, normalizeState } from '../src/defaults';
import {
  buildBotReport,
  buildCampaignReport,
  buildListReport,
  buildProblems,
  buildRealtime,
  buildSources,
  coverageOf,
  mapLimit,
  classifyDialerReply,
  countAgentStates,
  listIdsOf,
  parseRows,
  summarizeLogs,
  type DialerSource,
} from '../src/dialer-reports';

const state = normalizeState(createDefaultState());
state.campaigns[0].viciCampaign = 'FEX1';
state.campaigns[0].lists = '1001, 1002;1001';
state.campaigns[0].xferType = 'ingroup';
state.campaigns[0].xferTarget = 'CLOSER1';
state.campaigns = [state.campaigns[0]];

const calls: Array<{ fn: string; params: Record<string, string> }> = [];
const source = (reply: (fn: string) => { ok: boolean; status: number; text: string }): DialerSource => ({
  id: 'default',
  label: 'Test dialer',
  type: 'vicidial',
  query: async (fn, params = {}) => {
    calls.push({ fn, params });
    return reply(fn);
  },
});

const log = (over: Record<string, any>): any => ({
  id: 'x', transport: 'sip_rtp', exten: '8800', callerCode: '', leadId: null, phone: '1', campaignId: null,
  viciCampaign: 'FEX1', agentId: 'a1', agentName: 'Anna', remoteAgentUser: '9003', startedAt: new Date().toISOString(),
  endedAt: '', durationMs: 30000, turns: 3, avgTtfbMs: 400, disposition: 'XFER', transferredTo: '8200', dncAdded: false,
  transcript: [], functionCalls: [], viciApiAudit: [], ...over,
});

(async () => {
  // Parsing and plain-word errors
  assert.deepStrictEqual(parseRows('a|b\n\n c | d \n'), [['a', 'b'], ['c', 'd']]);
  assert.strictEqual(classifyDialerReply('x', 0, 'ERROR: fetch failed').title, 'The dialer cannot be reached');
  assert(/API login/.test(classifyDialerReply('x', 200, 'ERROR: invalid user or password').title));
  assert(/may not run reports/.test(classifyDialerReply('x', 200, 'ERROR: user does not have permission').title));
  assert(/does not offer "call_status_stats"/.test(classifyDialerReply('call_status_stats', 200, 'ERROR: function not supported').title));
  for (const t of ['ERROR: fetch failed', 'ERROR: weird']) assert(classifyDialerReply('f', 0, t).suggestion.length > 20, 'every problem says what to do');

  // Agent counts by the state word the dialer reports
  assert.deepStrictEqual(countAgentStates([['1001', 'READY', 'FEX1'], ['1002', 'INCALL'], ['1003', 'incall'], ['1004', 'zzz']]), { READY: 1, INCALL: 2, OTHER: 1 });

  // Real-time: agents counted, in-group asked once, failures become problems instead of crashes
  const ok = source((fn) => ({ ok: true, status: 200, text: fn === 'logged_in_agents' ? '1001|READY\n1002|INCALL' : 'CLOSER1|2|0' }));
  const rt = await buildRealtime(ok, state, { activeCalls: 3, capacity: null });
  assert.strictEqual(rt.agents?.loggedIn, 2);
  assert.strictEqual(rt.inGroups[0].id, 'CLOSER1');
  assert.strictEqual(rt.bot.activeCalls, 3);
  assert.strictEqual(calls.find((c) => c.fn === 'in_group_status')?.params.in_groups, 'CLOSER1');
  const down = source(() => ({ ok: false, status: 0, text: 'ERROR: fetch failed' }));
  const rtDown = await buildRealtime(down, state, { activeCalls: 0, capacity: null });
  assert(rtDown.agents === null && rtDown.problems.length >= 1 && rtDown.problems[0].suggestion);

  // Lists: ids de-duplicated, only for campaigns with a dialer campaign
  assert.deepStrictEqual(listIdsOf(state).map((l) => l.listId), ['1001', '1002']);
  const lr = await buildListReport(ok, state);
  assert.strictEqual(lr.lists.length, 2);
  assert.strictEqual(calls.filter((c) => c.fn === 'list_info').length, 2);
  assert.strictEqual(lr.problems.length, 0);
  const lrBad = await buildListReport(down, state);
  assert.strictEqual(lrBad.problems.length, 1, 'the same failure is reported once, not per list');

  // Campaign report keeps dialer rows and bot numbers apart, filtered by day
  const today = new Date().toISOString().slice(0, 10);
  const logs = [log({}), log({ transferredTo: null, disposition: 'NI' }), log({ startedAt: '2020-01-01T00:00:00Z' })];
  const cr = await buildCampaignReport(ok, state, logs, today);
  const row = cr.rows.find((r) => r.campaign === 'FEX1')!;
  assert.strictEqual(row.bot.calls, 2, 'old calls are left out of the day');
  assert.strictEqual(row.bot.transferRate, 50);
  assert(row.dialer.length > 0);
  assert.strictEqual(calls.filter((c) => c.fn === 'call_status_stats').pop()?.params.query_date, today);

  // Bot report: per bot and per campaign within the window
  const br = buildBotReport([...logs, log({ agentId: 'a2', agentName: 'Bea', viciCampaign: 'FEX2' })], 24);
  assert.strictEqual(br.totals.calls, 3);
  assert.deepStrictEqual(br.byBot.map((b) => b.agentName), ['Anna', 'Bea']);
  assert.strictEqual(br.byCampaign.length, 2);
  assert.strictEqual(summarizeLogs([]).transferRate, 0);

  // Problems: failed dialer requests grouped, with advice; active alerts included, acknowledged ones not
  const bad = log({ viciApiAudit: [
    { ts: new Date().toISOString(), api: 'agent_api', fn: 'transfer_remote_agent_call', urlOrAction: '', ok: false, responseText: 'ERROR: no agent' },
    { ts: new Date().toISOString(), api: 'agent_api', fn: 'transfer_remote_agent_call', urlOrAction: '', ok: false, responseText: 'ERROR: no agent' },
    { ts: new Date().toISOString(), api: 'agent_api', fn: 'hangup_remote_agent_call', urlOrAction: '', ok: true, responseText: 'SUCCESS' },
  ] });
  const alert = (ack: boolean): any => ({ id: 'a', kind: 'x', severity: 'critical', title: 'Bots are full', detail: 'd', key: 'k', count: 4, firstAt: '', lastAt: '', acknowledged: ack });
  const pr = buildProblems([bad], [alert(false), alert(true)]);
  assert.strictEqual(pr.length, 2);
  const xfer = pr.find((p) => p.area === 'Transfers')!;
  assert.strictEqual(xfer.count, 2);
  assert(/remote agent/.test(xfer.suggestion));
  assert.strictEqual(buildProblems([log({ viciApiAudit: bad.viciApiAudit, startedAt: '2020-01-01T00:00:00Z' })], []).length, 0, 'old failures are not shown');

  // Several in-groups: one request each, so the dialer's combined row cannot hide any of them
  const two = normalizeState(createDefaultState());
  two.campaigns = two.campaigns.slice(0, 2).map((c, i) => ({ ...c, viciCampaign: `C${i}`, xferType: 'ingroup' as const, xferTarget: i ? 'SUPPORT' : 'SALESLINE' }));
  calls.length = 0;
  const rt2 = await buildRealtime(ok, two, { activeCalls: 0, capacity: null });
  assert.deepStrictEqual(calls.filter((c) => c.fn === 'in_group_status').map((c) => c.params.in_groups).sort(), ['SALESLINE', 'SUPPORT']);
  assert.deepStrictEqual(rt2.inGroups.map((g) => g.id).sort(), ['SALESLINE', 'SUPPORT']);

  // Many lists with a dead dialer: bounded concurrency, and the rest are skipped instead of waited for
  const many = normalizeState(createDefaultState());
  many.campaigns = [{ ...many.campaigns[0], viciCampaign: 'M1', lists: Array.from({ length: 30 }, (_, i) => String(2000 + i)).join(',') }];
  calls.length = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const slowDead: DialerSource = {
    id: 'default', label: 'dead', type: 'vicidial',
    query: async (fn) => {
      calls.push({ fn, params: {} });
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { ok: false, status: 0, text: 'ERROR: fetch failed' };
    },
  };
  const deadLists = await buildListReport(slowDead, many);
  assert(maxInFlight <= 5, `at most 5 requests at once (saw ${maxInFlight})`);
  assert(calls.length <= 5 && deadLists.lists.length === 30, `a dead dialer is asked ${calls.length} times, not 30; every list still appears`);
  assert.strictEqual(deadLists.problems.length, 1);
  assert.deepStrictEqual(deadLists.lists.map((l) => l.listId), Array.from({ length: 30 }, (_, i) => String(2000 + i)), 'lists stay in order');
  const big = normalizeState(createDefaultState());
  big.campaigns = [{ ...big.campaigns[0], viciCampaign: 'B1', lists: Array.from({ length: 33 }, (_, i) => String(3000 + i)).join(',') }];
  assert.strictEqual((await buildListReport(ok, big)).omittedLists, 3, 'lists beyond the cap are counted, not hidden');
  assert.strictEqual(deadLists.omittedLists, 0);
  const groups12 = normalizeState(createDefaultState());
  groups12.campaigns = Array.from({ length: 12 }, (_, i) => ({ ...groups12.campaigns[0], viciCampaign: `G${i}`, xferType: 'ingroup' as const, xferTarget: `GRP${i}` }));
  assert.strictEqual((await buildRealtime(ok, groups12, { activeCalls: 0, capacity: null })).omittedInGroups, 2, 'in-groups beyond the cap are counted, not hidden');
  assert.deepStrictEqual(await mapLimit([1, 2, 3], 2, async (n) => n * 2), [2, 4, 6]);

  // Retention is configurable via BRIDGE_LOG_RETENTION (default 5000); say so when a window reaches further back
  const prevRet = process.env.BRIDGE_LOG_RETENTION;
  process.env.BRIDGE_LOG_RETENTION = '200';
  const recent = Array.from({ length: 200 }, (_, i) => log({ startedAt: new Date(Date.now() - i * 60000).toISOString() }));
  const week = coverageOf(recent, Date.now() - 7 * 86400_000);
  assert(week.limited && /newest 200 calls/.test(week.note), 'a 7-day window over a full log is flagged');
  assert(!coverageOf(recent, Date.now() - 60_000).limited, 'a window the log fully covers is not flagged');
  assert(!coverageOf(recent.slice(0, 50), Date.now() - 7 * 86400_000).limited, 'a log below the limit is complete');
  assert(buildBotReport(recent, 168).coverage.limited);
  if (prevRet === undefined) delete process.env.BRIDGE_LOG_RETENTION;
  else process.env.BRIDGE_LOG_RETENTION = prevRet;

  // A dialer is a source: this is where a second dialer would be added
  const srcs = buildSources(state, () => async () => ({ ok: true, status: 200, text: '' }));
  assert.strictEqual(srcs[0].id, 'default');
  assert(srcs[0].label.startsWith('VICIdial'));

  // The Reports tab exists and every endpoint it calls is served
  const fs = require('fs');
  const path = require('path');
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '../src/server.ts'), 'utf8');
  assert(/SECTION_TABS = \[[^\]]*'reports'/.test(app) && app.includes("key: 'reports'"), 'Reports tab is in the navigation');
  for (const name of ['dialers', 'realtime', 'campaigns', 'lists', 'bots', 'problems']) {
    assert(server.includes(`'/api/reports/${name}'`), `server serves /api/reports/${name}`);
    assert(app.includes(`get('${name}'`), `console calls /api/reports/${name}`);
  }
  assert(!/\.(post|put|delete)\(\s*'\/api\/reports/.test(server), 'reports are read-only');

  console.log('dialer-reports-verify: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
