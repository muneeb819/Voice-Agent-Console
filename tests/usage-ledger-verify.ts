import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../src/data-paths';
import { buildUsageReport, openConnections, readLedger, trackAgentConnection } from '../src/usage-ledger';

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

class FakeSocket extends EventEmitter {
  readyState = 0;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run() {
  assert(readLedger().length === 0, 'ledger starts empty');
  assert(buildUsageReport([], []).empty, 'empty report is flagged');

  // A connection that never opens is not counted.
  const never = new FakeSocket();
  trackAgentConnection(never as any, 'phone_call', 'call-never');
  never.emit('close', 1006);
  assert(readLedger().length === 0, 'a socket that never opened costs nothing');

  // An open connection shows as open, then is recorded on close with its duration.
  const sock = new FakeSocket();
  trackAgentConnection(sock as any, 'phone_call', 'call-1');
  sock.readyState = 1;
  sock.emit('open');
  assert(openConnections().some((c) => c.ref === 'call-1'), 'open connection is listed while open');
  await wait(60);
  sock.emit('close', 1000);
  assert(!openConnections().some((c) => c.ref === 'call-1'), 'closed connection is no longer open');
  const rows = readLedger();
  assert(rows.length === 1 && rows[0].ref === 'call-1' && rows[0].source === 'phone_call', 'close is recorded');
  assert(rows[0].ms >= 50 && rows[0].closeCode === 1000, `duration and close code kept (${rows[0].ms}ms)`);

  // A second close event must not double count.
  sock.emit('close', 1000);
  assert(readLedger().length === 1, 'duplicate close is ignored');

  // The file is private and survives as JSON lines.
  const file = path.join(DATA_DIR, 'usage-ledger.jsonl');
  assert((fs.statSync(file).mode & 0o077) === 0, 'ledger file is owner-only');

  // Report: per-day totals split by source, longest connection, still-open list.
  const day = '2026-11-26';
  const mk = (source: 'phone_call' | 'simulator', minutes: number, d = day) => ({
    source, ref: `${source}-${minutes}`, openedAt: `${d}T01:00:00.000Z`, closedAt: `${d}T02:00:00.000Z`, ms: minutes * 60000, closeCode: 1000,
  });
  const report = buildUsageReport([mk('phone_call', 90), mk('simulator', 30), mk('phone_call', 60, '2026-11-25')], [
    { source: 'phone_call', ref: 'stuck', openedAt: '2026-11-26T00:00:00.000Z', ms: 3 * 3600000 },
  ]);
  assert(report.days[0].day === day && report.days[1].day === '2026-11-25', 'newest day first');
  assert(report.days[0].hours === 2 && report.days[0].phoneHours === 1.5 && report.days[0].simulatorHours === 0.5, 'hours split by source');
  assert(report.days[0].longestMinutes === 90 && report.days[0].connections === 2, 'longest and count');
  assert(report.openNow[0].ref === 'stuck' && report.openNow[0].minutes === 180, 'long-open connection is surfaced');
  assert(!report.empty, 'report with rows is not empty');
  console.log('Usage ledger verification passed.');
}

run().then(() => process.exit(0), (err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
