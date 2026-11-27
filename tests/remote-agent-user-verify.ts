// Multi-line VICIdial remote agents: each line is its own user (9003, 9004, ...).
// Transfers and hang-ups must name the user that actually holds the call.
import assert from 'node:assert/strict';
import { lookupCallAgentUser, usableAgentUser } from '../src/vici-bridge';
import { VicidialApiClient } from '../src/vici-client';

let checks = 0;
const eq = (a: unknown, b: unknown, m: string) => { assert.deepEqual(a, b, m); checks++; };

(async () => {
  eq(usableAgentUser('9005'), '9005', 'plain remote agent user is used');
  eq(usableAgentUser(' 9004 '), '9004', 'whitespace trimmed');
  eq(usableAgentUser('VDAD'), '', 'dialer placeholder ignored');
  eq(usableAgentUser('VDCL'), '', 'closer placeholder ignored');
  eq(usableAgentUser(''), '', 'empty ignored');
  eq(usableAgentUser('90 01;DROP'), '', 'unsafe value ignored');

  const client = (r: any) => ({ lookupCallIdInfo: async () => r });
  eq(await lookupCallAgentUser(client({ ok: true, agentUser: '9006' }), 'V1124013012000104892'), '9006', 'line user read from callid_info');
  eq(await lookupCallAgentUser(client({ ok: false }), 'V1124013012000104892'), '', 'failed lookup falls back');
  eq(await lookupCallAgentUser({ lookupCallIdInfo: async () => { throw new Error('down'); } } as any, 'V1'), '', 'API error falls back');
  eq(await lookupCallAgentUser(client({ ok: true, agentUser: '9006' }), ''), '', 'no caller code, no lookup');

  // On-hook RINGAGENT... CID must NEVER trigger callid_info (eliminates callid_info:ERR)
  let ringAgentLookups = 0;
  eq(
    await lookupCallAgentUser({ lookupCallIdInfo: async () => { ringAgentLookups++; return { ok: false }; } } as any, 'RINGAGENT00001'),
    '',
    'RINGAGENT skips callid_info lookup',
  );
  eq(ringAgentLookups, 0, 'zero callid_info calls made for RINGAGENT');

  // Concurrent multi-line pool (9003..9010): Call 2 excludes Call 1's claimed 9003 / Y...001
  const vici = new VicidialApiClient({
    viciBaseUrl: 'http://127.0.0.1:1',
    nonAgentApiPath: '/vicidial/non_agent_api.php',
    agentApiPath: '/agc/api.php',
    apiUser: 'admin2',
    source: 'test',
    remoteAgentUser: '9003',
  } as any);
  (vici as any).getAgentStatus = async (u: string) => {
    if (u === '9003') {
      return { ok: true, agentUser: '9003', status: 'INCALL', callId: 'Y1127000000000000001', leadId: '1001', campaignId: 'wavebot', phone: '3055550001', raw: {} };
    }
    if (u === '9004') {
      return { ok: true, agentUser: '9004', status: 'INCALL', callId: 'Y1127000000000000002', leadId: '1002', campaignId: 'wavebot', phone: '3055550002', raw: {} };
    }
    return { ok: true, agentUser: u, status: 'READY', callId: '', leadId: null, campaignId: 'wavebot', phone: '', raw: {} };
  };
  const first = await vici.resolveLiveViciCall({ baseRemoteAgentUser: '9003', maxLines: 8, campaignId: 'wavebot' });
  eq(first.remoteAgentUser, '9003', 'first concurrent call claims 9003');
  eq(first.callerCode, 'Y1127000000000000001', 'first call gets 9003 Y... call_id');

  const second = await vici.resolveLiveViciCall({
    baseRemoteAgentUser: '9003',
    maxLines: 8,
    campaignId: 'wavebot',
    excludeCallIds: [first.callerCode],
    excludeAgentUsers: [first.remoteAgentUser],
  });
  eq(second.remoteAgentUser, '9004', 'second concurrent call claims 9004 without colliding with 9003');
  eq(second.callerCode, 'Y1127000000000000002', 'second call gets 9004 Y... call_id');

  console.log(`✓ Remote agent user per line: ${checks} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
