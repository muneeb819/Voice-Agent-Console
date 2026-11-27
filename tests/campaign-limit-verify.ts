// The campaign-wide call limit is optional: it only applies when it is ticked.
import assert from 'node:assert/strict';
import { getConsoleState } from '../src/db';
import { normalizeState } from '../src/defaults';
import { createServerWithSimulator } from '../src/server';

let checks = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); checks++; };

async function main() {
  const base = getConsoleState();
  const camp = base.campaigns[0];

  // Data saved before the box existed keeps its limit; an explicit untick is kept.
  const legacy = JSON.parse(JSON.stringify(base)); delete legacy.campaigns[0].maxCallsEnabled;
  ok(normalizeState(legacy).campaigns[0].maxCallsEnabled === true, 'older data without the box keeps its limit on');
  const off = JSON.parse(JSON.stringify(base)); off.campaigns[0].maxCallsEnabled = false;
  ok(normalizeState(off).campaigns[0].maxCallsEnabled === false, 'an unticked box is saved as off');
  const on = JSON.parse(JSON.stringify(base)); on.campaigns[0].maxCallsEnabled = true;
  ok(normalizeState(on).campaigns[0].maxCallsEnabled === true, 'a ticked box is saved as on');

  const { server, viciBridge } = createServerWithSimulator({ enableBridge: true, host: 'localhost', audioSocketPort: 0, sipPort: 0 });
  const bridge: any = viciBridge!;
  try {
    for (const enabled of [true, false, undefined]) {
      for (let max = 1; max <= 5; max++) {
        for (let active = 0; active <= 6; active++) {
          bridge.activeCalls.clear();
          for (let i = 0; i < active; i++) bridge.activeCalls.set(`c${i}`, { callId: `c${i}`, campaignId: camp.id, agentId: 'x' });
          // A call on another campaign never counts against this one.
          bridge.activeCalls.set('other', { callId: 'other', campaignId: 'someone_else', agentId: 'x' });
          const c: any = { ...camp, maxCalls: max };
          if (enabled === undefined) delete c.maxCallsEnabled; else c.maxCallsEnabled = enabled;
          const expected = enabled !== false && active >= max;
          ok(bridge.isCampaignOverCapacity(c) === expected, `limit ${enabled === undefined ? 'unset' : enabled ? 'ticked' : 'unticked'}, max ${max}, ${active} active: ${expected ? 'full' : 'room'}`);
        }
      }
    }
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
  console.log(`✓ Optional campaign limit: ${checks} checks passed`);
  process.exit(0);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
