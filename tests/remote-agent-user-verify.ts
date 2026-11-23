// Multi-line VICIdial remote agents: each line is its own user (9003, 9004, ...).
// Transfers and hang-ups must name the user that actually holds the call.
import assert from 'node:assert/strict';
import { lookupCallAgentUser, usableAgentUser } from '../src/vici-bridge';

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
  console.log(`✓ Remote agent user per line: ${checks} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
