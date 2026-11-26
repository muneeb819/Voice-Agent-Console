import fs from 'fs';
import path from 'path';
import type WebSocket from 'ws';
import { DATA_DIR } from './data-paths';

/**
 * Usage ledger: how long each Deepgram Voice Agent connection stayed open.
 * Deepgram bills agent time for the whole connection, not only for talking,
 * so a connection that outlives its call still costs money. Every connection
 * the console opens is recorded here, with where it came from, so the total can
 * be checked against the provider's own bill.
 */

export type UsageSource = 'phone_call' | 'simulator';

export interface UsageRecord {
  source: UsageSource;
  /** Call or session id this connection belonged to. */
  ref: string;
  openedAt: string;
  closedAt: string;
  ms: number;
  closeCode: number | null;
}

interface OpenConnection {
  source: UsageSource;
  ref: string;
  openedAtMs: number;
}

const FILE_NAME = 'usage-ledger.jsonl';
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const open = new Map<number, OpenConnection>();
let nextId = 1;

function filePath(): string {
  return path.join(DATA_DIR, FILE_NAME);
}

function append(record: UsageRecord): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const file = filePath();
    try {
      // Keep the newest half when the file gets large, so it cannot grow without bound.
      if (fs.statSync(file).size > MAX_FILE_BYTES) {
        const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
        fs.writeFileSync(file, `${lines.slice(Math.floor(lines.length / 2)).join('\n')}\n`, { mode: 0o600 });
      }
    } catch {
      // No file yet.
    }
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch {
    // Usage tracking must never break a call.
  }
}

/** Start timing a Deepgram connection. Counts from the moment the socket opens until it closes. */
export function trackAgentConnection(ws: WebSocket, source: UsageSource, ref: string): void {
  const id = nextId++;
  let counted = false;
  const start = () => {
    if (counted) return;
    counted = true;
    open.set(id, { source, ref, openedAtMs: Date.now() });
  };
  if (ws.readyState === 1) start();
  ws.on('open', start);
  ws.on('close', (code: number) => {
    const conn = open.get(id);
    if (!conn) return;
    open.delete(id);
    const closedAtMs = Date.now();
    append({
      source: conn.source,
      ref: conn.ref,
      openedAt: new Date(conn.openedAtMs).toISOString(),
      closedAt: new Date(closedAtMs).toISOString(),
      ms: closedAtMs - conn.openedAtMs,
      closeCode: typeof code === 'number' ? code : null,
    });
  });
}

export function readLedger(): UsageRecord[] {
  try {
    return fs
      .readFileSync(filePath(), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line) as UsageRecord; } catch { return null; }
      })
      .filter((r): r is UsageRecord => !!r && typeof r.ms === 'number' && typeof r.openedAt === 'string');
  } catch {
    return [];
  }
}

export function openConnections(now = Date.now()): Array<{ source: UsageSource; ref: string; openedAt: string; ms: number }> {
  return Array.from(open.values()).map((c) => ({
    source: c.source,
    ref: c.ref,
    openedAt: new Date(c.openedAtMs).toISOString(),
    ms: now - c.openedAtMs,
  }));
}

export interface UsageReport {
  /** Connection time per UTC day, newest first. */
  days: Array<{ day: string; connections: number; hours: number; phoneHours: number; simulatorHours: number; longestMinutes: number }>;
  openNow: Array<{ source: UsageSource; ref: string; openedAt: string; minutes: number }>;
  /** True when the ledger has no records yet (it only counts from when it was installed). */
  empty: boolean;
  since: string | null;
}

export function buildUsageReport(records: UsageRecord[], open_ = openConnections(), dayCount = 7): UsageReport {
  const byDay = new Map<string, UsageRecord[]>();
  for (const r of records) {
    const day = r.openedAt.slice(0, 10);
    const list = byDay.get(day) || [];
    list.push(r);
    byDay.set(day, list);
  }
  const hours = (ms: number) => Number((ms / 3600000).toFixed(2));
  const days = Array.from(byDay.entries())
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, Math.max(1, dayCount))
    .map(([day, rows]) => ({
      day,
      connections: rows.length,
      hours: hours(rows.reduce((s, r) => s + r.ms, 0)),
      phoneHours: hours(rows.filter((r) => r.source === 'phone_call').reduce((s, r) => s + r.ms, 0)),
      simulatorHours: hours(rows.filter((r) => r.source === 'simulator').reduce((s, r) => s + r.ms, 0)),
      longestMinutes: Math.round(Math.max(...rows.map((r) => r.ms)) / 60000),
    }));
  return {
    days,
    openNow: open_.map((c) => ({ source: c.source, ref: c.ref, openedAt: c.openedAt, minutes: Math.round(c.ms / 60000) })),
    empty: records.length === 0,
    since: records.length ? records.reduce((m, r) => (r.openedAt < m ? r.openedAt : m), records[0].openedAt) : null,
  };
}
