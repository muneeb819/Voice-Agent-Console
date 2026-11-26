import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../src/data-paths';
import { buildUsageReport, openConnections, readLedger, reconcileOpenConnections, trackAgentConnection } from '../src/usage-ledger';

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
  const rows3 = [mk('phone_call', 90), mk('simulator', 30), mk('phone_call', 60, '2026-11-25')];
  const closedOnly = buildUsageReport(rows3, []);
  assert(closedOnly.days[0].day === day && closedOnly.days[1].day === '2026-11-25', 'newest day first');
  assert(closedOnly.days[0].hours === 2 && closedOnly.days[0].phoneHours === 1.5 && closedOnly.days[0].simulatorHours === 0.5, 'hours split by source');
  assert(closedOnly.days[0].longestMinutes === 90 && closedOnly.days[0].connections === 2, 'longest and count');
  const report = buildUsageReport(rows3, [
    { source: 'phone_call', ref: 'stuck', openedAt: '2026-11-26T00:00:00.000Z', ms: 3 * 3600000 },
  ]);
  assert(report.openNow[0].ref === 'stuck' && report.openNow[0].minutes === 180, 'long-open connection is surfaced');
  assert(!report.empty, 'report with rows is not empty');
  // The 3-hour-old open connection counts as provisional usage on the days it covers.
  assert(report.days[0].openHours === 3 && report.days[0].hours === 5, `open time is included (${report.days[0].hours}h, ${report.days[0].openHours}h open)`);
  assert(!buildUsageReport([], [{ source: 'phone_call', ref: 'x', openedAt: day + 'T01:00:00.000Z', ms: 60000 }]).empty, 'a report with only an open connection is not empty');

  // A connection that crosses UTC midnight is split between both days.
  const cross = buildUsageReport([{ source: 'phone_call', ref: 'late', openedAt: '2026-11-25T23:45:00.000Z', closedAt: '2026-11-26T00:15:00.000Z', ms: 30 * 60000, closeCode: 1000 }], []);
  const d25 = cross.days.find((d) => d.day === '2026-11-25');
  const d26 = cross.days.find((d) => d.day === '2026-11-26');
  assert(d25 && d26 && d25.hours === 0.25 && d26.hours === 0.25, 'midnight crossing is split 15 min / 15 min');
  assert(d25.connections === 1 && d26.connections === 1, 'the connection counts once on each day it touched');

  // After a crash, a connection left open is recovered, ending at the last heartbeat.
  const before = readLedger().length;
  const openFile = path.join(DATA_DIR, 'usage-open.json');
  fs.writeFileSync(openFile, JSON.stringify({
    aliveAt: '2026-11-26T05:00:00.000Z',
    open: [{ source: 'phone_call', ref: 'crashed', openedAtMs: Date.parse('2026-11-26T03:00:00.000Z') }],
  }));
  assert(reconcileOpenConnections() === 1, 'one orphaned connection recovered');
  const recovered = readLedger().slice(before)[0];
  assert(recovered.ref === 'crashed' && recovered.ms === 2 * 3600000 && recovered.estimated === true, 'recovered record ends at the last heartbeat and is marked estimated');
  assert(!fs.existsSync(openFile), 'the open-connection file is cleared after recovery');
  assert(reconcileOpenConnections() === 0, 'recovery runs once per process');
  console.log('Usage ledger verification passed.');
}

run().then(() => process.exit(0), (err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
