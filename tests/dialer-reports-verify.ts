import assert from 'assert';
import { createDefaultState, normalizeState } from '../src/defaults';
import {
  buildBotReport,
  buildCampaignReport,
  buildListReport,
  buildProblems,
  buildRealtime,
  buildSources,
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
