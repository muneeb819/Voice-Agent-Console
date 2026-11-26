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
  /** True when the end time is the last heartbeat before a crash, not a real close. */
  estimated?: boolean;
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

const OPEN_FILE_NAME = 'usage-open.json';
const HEARTBEAT_MS = 30_000;
let heartbeat: NodeJS.Timeout | null = null;

function openFilePath(): string {
  return path.join(DATA_DIR, OPEN_FILE_NAME);
}

/** Writes the connections that are open right now, with the time of writing as proof they were alive. */
function persistOpen(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (open.size === 0) {
      fs.rmSync(openFilePath(), { force: true });
      return;
    }
    const payload = { aliveAt: new Date().toISOString(), open: Array.from(open.values()) };
    const tmp = `${openFilePath()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
    fs.renameSync(tmp, openFilePath());
  } catch {
    // Usage tracking must never break a call.
  }
}

function syncHeartbeat(): void {
  if (open.size > 0 && !heartbeat) {
    heartbeat = setInterval(persistOpen, HEARTBEAT_MS);
    heartbeat.unref?.();
  } else if (open.size === 0 && heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
}

/**
 * After a crash or restart, connections that were still open have no close event.
 * Record each one as ending at the last heartbeat, so its billed time is not lost.
 * Run once when the process starts.
 */
let reconciled = false;

export function reconcileOpenConnections(): number {
  // Once per process: a second call would mistake this process's own live connections for crashed ones.
  if (reconciled || open.size > 0) return 0;
  reconciled = true;
  let recovered = 0;
  try {
    const saved = JSON.parse(fs.readFileSync(openFilePath(), 'utf8'));
    const aliveAtMs = Date.parse(saved?.aliveAt);
    for (const c of Array.isArray(saved?.open) ? saved.open : []) {
      if (!c || typeof c.openedAtMs !== 'number' || !Number.isFinite(aliveAtMs)) continue;
      const endMs = Math.max(aliveAtMs, c.openedAtMs);
      append({
        source: c.source === 'simulator' ? 'simulator' : 'phone_call',
        ref: String(c.ref || 'unknown').slice(0, 80),
        openedAt: new Date(c.openedAtMs).toISOString(),
        closedAt: new Date(endMs).toISOString(),
        ms: endMs - c.openedAtMs,
        closeCode: null,
        estimated: true,
      });
      recovered += 1;
    }
    fs.rmSync(openFilePath(), { force: true });
  } catch {
    // Nothing saved means nothing to recover.
  }
  return recovered;
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
    persistOpen();
    syncHeartbeat();
  };
  if (ws.readyState === 1) start();
  ws.on('open', start);
  ws.on('close', (code: number) => {
    const conn = open.get(id);
    if (!conn) return;
    open.delete(id);
    persistOpen();
    syncHeartbeat();
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
  /** Connection time per UTC day, newest first. Open connections count as provisional time. */
  days: Array<{ day: string; connections: number; hours: number; phoneHours: number; simulatorHours: number; longestMinutes: number; openHours: number }>;
  openNow: Array<{ source: UsageSource; ref: string; openedAt: string; minutes: number }>;
  /** True when there is nothing recorded and nothing open (the ledger only counts from when it was installed). */
  empty: boolean;
  since: string | null;
}

const DAY_MS = 86_400_000;

/** Cuts [startMs, endMs) at UTC midnights, so a connection that crosses midnight counts toward both days. */
function splitByUtcDay(startMs: number, endMs: number): Array<{ day: string; ms: number }> {
  const parts: Array<{ day: string; ms: number }> = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const nextMidnight = (Math.floor(cursor / DAY_MS) + 1) * DAY_MS;
    const stop = Math.min(endMs, nextMidnight);
    parts.push({ day: new Date(cursor).toISOString().slice(0, 10), ms: stop - cursor });
    cursor = stop;
  }
  return parts;
}

interface DayTotals {
  ids: Set<string>;
  ms: number;
  phoneMs: number;
  simulatorMs: number;
  openMs: number;
  longestMs: number;
}

export function buildUsageReport(records: UsageRecord[], open_ = openConnections(), dayCount = 7): UsageReport {
  const days = new Map<string, DayTotals>();
  const add = (source: UsageSource, ref: string, startMs: number, endMs: number, isOpen: boolean) => {
    for (const part of splitByUtcDay(startMs, endMs)) {
      const d = days.get(part.day) || { ids: new Set<string>(), ms: 0, phoneMs: 0, simulatorMs: 0, openMs: 0, longestMs: 0 };
      d.ids.add(`${source}:${ref}:${startMs}`);
      d.ms += part.ms;
      if (source === 'simulator') d.simulatorMs += part.ms;
      else d.phoneMs += part.ms;
      if (isOpen) d.openMs += part.ms;
      d.longestMs = Math.max(d.longestMs, endMs - startMs);
      days.set(part.day, d);
    }
  };
  for (const r of records) {
    const startMs = Date.parse(r.openedAt);
    if (Number.isFinite(startMs)) add(r.source, r.ref, startMs, startMs + Math.max(0, r.ms), false);
  }
  for (const c of open_) {
    const startMs = Date.parse(c.openedAt);
    if (Number.isFinite(startMs)) add(c.source, c.ref, startMs, startMs + Math.max(0, c.ms), true);
  }
  const hours = (ms: number) => Number((ms / 3600000).toFixed(2));
  const rows = Array.from(days.entries())
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, Math.max(1, dayCount))
    .map(([day, d]) => ({
      day,
      connections: d.ids.size,
      hours: hours(d.ms),
      phoneHours: hours(d.phoneMs),
      simulatorHours: hours(d.simulatorMs),
      longestMinutes: Math.round(d.longestMs / 60000),
      openHours: hours(d.openMs),
    }));
  return {
    days: rows,
    openNow: open_.map((c) => ({ source: c.source, ref: c.ref, openedAt: c.openedAt, minutes: Math.round(c.ms / 60000) })),
    empty: records.length === 0 && open_.length === 0,
    since: records.length ? records.reduce((m, r) => (r.openedAt < m ? r.openedAt : m), records[0].openedAt) : null,
  };
}
