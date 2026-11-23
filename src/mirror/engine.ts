// The mirror worker: keeps an AWS RDS SQL Server database in step with the
// console's SQLite database. SQLite stays the live database for calls; the
// mirror only reads it, so an RDS outage never affects a call.
import crypto from 'crypto';
import { getSecret } from '../env-store';
import {
  acquireLease, clearOutbox, countRows, deleteOutboxThrough, discoverTables, ensureTriggers, loadBook, loadSettings,
  maxOutboxSeq, MirrorBookkeeping, MirrorSettings, OUTBOX_LIMIT, outboxStats, readAllRows, readOutbox, readRowsByKeys,
  releaseLease, removeTriggersAndOutbox, saveBook, saveSettings,
} from './source';
import { TableSpec } from './sql';
import { explainSqlError, MirrorTarget, MssqlTarget, TargetConfig } from './target';

export type TargetFactory = (cfg: TargetConfig) => MirrorTarget;
let targetFactory: TargetFactory = (cfg) => new MssqlTarget(cfg);
/** Tests swap in an in-memory target. */
export function setTargetFactoryForTests(f: TargetFactory | null): void {
  targetFactory = f || ((cfg) => new MssqlTarget(cfg));
}

const OWNER = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
const BATCH = 500;
let leaseMs = 60_000;

/** Renews the lease before each write so a long copy never runs past it. */
function holdLease(): void {
  if (!acquireLease(OWNER, leaseMs)) throw new Error('Another console process took over the SQL Server mirror; this one stopped.');
}
const MAX_BATCHES_PER_TICK = 40;

interface Runtime {
  phase: 'off' | 'starting' | 'copying' | 'syncing' | 'idle' | 'error';
  serverVersion: string;
  rowsSent: number;
  rowsDeleted: number;
  lastTickAt: string;
  copying: string;
  tableRows: Record<string, number>;
  views: string[];
  failures: number;
}

const rt: Runtime = { phase: 'off', serverVersion: '', rowsSent: 0, rowsDeleted: 0, lastTickAt: '', copying: '', tableRows: {}, views: [], failures: 0 };
let target: MirrorTarget | null = null;
let targetKey = '';
let timer: NodeJS.Timeout | null = null;
let running = false;
let rerun = false;
let started = false;

export function fingerprint(s: MirrorSettings): string {
  return [s.host.toLowerCase(), s.port, s.database.toLowerCase(), s.schema.toLowerCase()].join('|');
}

function targetConfig(s: MirrorSettings): TargetConfig {
  return {
    host: s.host, port: s.port, database: s.database, username: s.username,
    password: getSecret('MSSQL_PASSWORD'), schema: s.schema, verifyCert: s.verifyCert,
  };
}

export function missingSettings(s: MirrorSettings): string[] {
  const missing: string[] = [];
  if (!s.host) missing.push('RDS endpoint');
  if (!s.database) missing.push('database name');
  if (!s.username) missing.push('username');
  if (!getSecret('MSSQL_PASSWORD')) missing.push('password');
  return missing;
}

async function dropTarget(): Promise<void> {
  const t = target;
  target = null;
  targetKey = '';
  if (t) await t.close().catch(() => {});
}

async function openTarget(s: MirrorSettings): Promise<MirrorTarget> {
  const key = `${fingerprint(s)}|${s.username}|${s.verifyCert}|${crypto.createHash('sha256').update(getSecret('MSSQL_PASSWORD')).digest('hex')}`;
  if (target && targetKey === key) return target;
  await dropTarget();
  const t = targetFactory(targetConfig(s));
  const info = await t.open();
  rt.serverVersion = info.version;
  target = t;
  targetKey = key;
  return t;
}

/** Copies one whole table: empties it in SQL Server (unless keeping deleted rows), then sends every row. */
async function copyTable(t: MirrorTarget, spec: TableSpec, keepDeleted: boolean): Promise<number> {
  rt.copying = spec.name;
  await t.ensureTable(spec);
  let sent = 0;
  let first = true;
  for (const page of readAllRows(spec, BATCH)) {
    holdLease();
    await t.apply(spec, { truncate: first && !keepDeleted, upserts: page, deletes: [] });
    first = false;
    sent += page.length;
  }
  if (first && !keepDeleted) await t.apply(spec, { truncate: true, upserts: [], deletes: [] });
  rt.rowsSent += sent;
  rt.tableRows[spec.name] = sent;
  rt.copying = '';
  return sent;
}

/** Sends queued changes, oldest first, until the queue is empty or the tick's budget is spent. */
async function drain(t: MirrorTarget, tables: Map<string, TableSpec>, s: MirrorSettings, book: MirrorBookkeeping): Promise<void> {
  for (let n = 0; n < MAX_BATCHES_PER_TICK; n++) {
    const entries = readOutbox(BATCH);
    if (!entries.length) return;
    holdLease();
    const byTable = new Map<string, Map<string, unknown[]>>();
    for (const e of entries) {
      if (!tables.has(e.tbl)) continue; // table no longer mirrored
      let keys = byTable.get(e.tbl);
      if (!keys) byTable.set(e.tbl, (keys = new Map()));
      try {
        const key = JSON.parse(e.pk);
        if (Array.isArray(key)) keys.set(e.pk, key);
      } catch { /* malformed key: skip it */ }
    }
    for (const [name, keys] of byTable) {
      const spec = tables.get(name)!;
      if (!book.syncedTables.includes(name)) continue; // a full copy will cover it
      if (await t.ensureTable(spec)) {
        // New columns: re-copy so existing rows get their values.
        await copyTable(t, spec, s.keepDeleted);
        continue;
      }
      const { rows, missing } = readRowsByKeys(spec, [...keys.values()]);
      const deletes = s.keepDeleted ? [] : missing;
      await t.apply(spec, { upserts: rows, deletes });
      rt.rowsSent += rows.length;
      rt.rowsDeleted += deletes.length;
    }
    deleteOutboxThrough(entries[entries.length - 1].seq);
  }
}

async function tick(): Promise<void> {
  const s = loadSettings();
  const book = loadBook();
  rt.lastTickAt = new Date().toISOString();
  if (!s.enabled) {
    rt.phase = 'off';
    await dropTarget();
    return;
  }
  if (missingSettings(s).length) {
    rt.phase = 'error';
    book.lastError = `Missing: ${missingSettings(s).join(', ')}.`;
    book.lastErrorAt = rt.lastTickAt;
    saveBook(book);
    return;
  }
  leaseMs = Math.max(60_000, s.intervalSec * 4000);
  if (!acquireLease(OWNER, leaseMs)) return; // another process is syncing

  const tables = discoverTables();
  // Capture changes first, so nothing written during a copy is missed.
  const newlyCovered = ensureTriggers(tables);
  const fp = fingerprint(s);
  if (book.fingerprint !== fp) {
    book.fingerprint = fp;
    book.syncedTables = [];
  }
  if (newlyCovered.length) book.syncedTables = book.syncedTables.filter((tn) => !newlyCovered.includes(tn));
  if (outboxStats().pending > OUTBOX_LIMIT) {
    // Too far behind: a full copy is cheaper than replaying every change.
    clearOutbox();
    book.syncedTables = [];
  }

  rt.phase = 'starting';
  const t = await openTarget(s);
  const toCopy = [...tables.keys()].filter((tn) => !book.syncedTables.includes(tn));
  if (toCopy.length) {
    rt.phase = 'copying';
    const startSeq = maxOutboxSeq();
    for (const tn of toCopy) {
      await copyTable(t, tables.get(tn)!, s.keepDeleted);
      book.syncedTables.push(tn);
      saveBook(book);
    }
    // Changes to these tables queued before their copy began are already in it.
    deleteOutboxThrough(startSeq, toCopy);
    if (toCopy.length >= tables.size) book.lastFullSyncAt = new Date().toISOString();
    saveBook(book);
    rt.views = await t.ensureViews(tables);
  }
  rt.phase = 'syncing';
  await drain(t, tables, s, book);
  rt.phase = 'idle';
  rt.failures = 0;
  book.lastOkAt = new Date().toISOString();
  book.lastError = '';
  saveBook(book);
}

function schedule(ms: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { void runOnce(); }, ms);
  timer.unref?.();
}

/** Runs one sync cycle now (or right after the current one). */
export async function runOnce(): Promise<void> {
  if (running) { rerun = true; return; }
  running = true;
  let delay = 5000;
  try {
    await tick();
    delay = loadSettings().intervalSec * 1000;
  } catch (err) {
    rt.failures += 1;
    rt.phase = 'error';
    rt.copying = '';
    const book = loadBook();
    book.lastError = explainSqlError(err);
    book.lastErrorAt = new Date().toISOString();
    saveBook(book);
    await dropTarget();
    const base = loadSettings().intervalSec * 1000;
    delay = Math.min(120_000, base * 2 ** Math.min(rt.failures, 5));
  } finally {
    running = false;
  }
  if (rerun) { rerun = false; delay = 0; }
  if (started) schedule(delay);
}

export function startMirror(): void {
  if (started) return;
  started = true;
  schedule(3000);
}

export async function stopMirror(): Promise<void> {
  started = false;
  if (timer) clearTimeout(timer);
  timer = null;
  releaseLease(OWNER);
  await dropTarget();
}

export function setMirrorEnabled(enabled: boolean, by: string): MirrorSettings {
  const s = { ...loadSettings(), enabled, updatedAt: new Date().toISOString(), updatedBy: by };
  saveSettings(s);
  if (!enabled) {
    removeTriggersAndOutbox();
    const book = loadBook();
    book.syncedTables = []; // changes made while off are not tracked, so re-copy on the next start
    saveBook(book);
    rt.phase = 'off';
    void dropTarget();
  }
  if (started) schedule(0);
  return s;
}

export function requestFullResync(): void {
  const book = loadBook();
  book.syncedTables = [];
  saveBook(book);
  if (started) schedule(0);
}

export function updateMirrorSettings(next: MirrorSettings): void {
  saveSettings(next);
  void dropTarget();
  if (started) schedule(0);
}

/** Connects with the given settings and reports the server, without changing anything else. */
export async function testMirrorConnection(s: MirrorSettings): Promise<{ ok: boolean; version?: string; createdDatabase?: boolean; error?: string }> {
  const missing = missingSettings(s);
  if (missing.length) return { ok: false, error: `Missing: ${missing.join(', ')}.` };
  const t = targetFactory(targetConfig(s));
  try {
    const info = await t.open();
    return { ok: true, version: info.version, createdDatabase: info.createdDatabase };
  } catch (err) {
    return { ok: false, error: explainSqlError(err) };
  } finally {
    await t.close().catch(() => {});
  }
}

export function mirrorStatus() {
  const s = loadSettings();
  const book = loadBook();
  const tables = [...discoverTables().keys()];
  const { pending, oldestAt } = outboxStats();
  return {
    ok: true,
    settings: { ...s, passwordSet: Boolean(getSecret('MSSQL_PASSWORD')) },
    phase: s.enabled ? rt.phase : 'off',
    copying: rt.copying,
    serverVersion: rt.serverVersion,
    pending,
    lagSec: oldestAt ? Math.max(0, Math.round((Date.now() - Date.parse(oldestAt)) / 1000)) : 0,
    rowsSentSinceStart: rt.rowsSent,
    rowsDeletedSinceStart: rt.rowsDeleted,
    lastOkAt: book.lastOkAt,
    lastError: book.lastError,
    lastErrorAt: book.lastErrorAt,
    lastFullSyncAt: book.lastFullSyncAt,
    views: rt.views,
    tables: tables.map((name) => ({ name, rows: countRows(name), copied: book.syncedTables.includes(name) })),
  };
}
