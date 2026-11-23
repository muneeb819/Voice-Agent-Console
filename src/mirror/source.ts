// SQLite side of the SQL Server mirror: settings row, table discovery,
// change-capture triggers and the outbox they write to.
//
// Triggers only record WHICH row changed (its key). The worker reads the row's
// current values when it syncs, so a row changed ten times is sent once, and a
// row that no longer exists is deleted from SQL Server.
import { getDb } from '../db';
import { ColumnSpec, isValidName, kindOf, TableSpec } from './sql';

/** Never mirrored: login sessions, revoked tokens and internal rotation cursors. */
export const EXCLUDED_TABLES = new Set([
  'user_sessions',
  'revoked_admin_sessions',
  'greeting_rotation_used',
  'greeting_rotation_state',
  'greeting_line_used',
]);
/** Never mirrored from any table: password hashes, secrets and tokens. */
export const EXCLUDED_COLUMN_RE = /pass(word)?|hash|secret|token|salt/i;
export const OUTBOX_LIMIT = 100_000;

export interface MirrorSettings {
  enabled: boolean;
  host: string;
  port: number;
  database: string;
  username: string;
  schema: string;
  verifyCert: boolean;
  keepDeleted: boolean;
  intervalSec: number;
  updatedAt: string;
  updatedBy: string;
}

export interface MirrorBookkeeping {
  fingerprint: string; // target the copied tables belong to
  syncedTables: string[]; // tables fully copied to that target
  lastFullSyncAt: string;
  lastOkAt: string;
  lastError: string;
  lastErrorAt: string;
}

export const DEFAULT_SETTINGS: MirrorSettings = {
  enabled: false,
  host: '',
  port: 1433,
  database: 'VoiceAgentConsole',
  username: '',
  schema: 'vac',
  verifyCert: true,
  keepDeleted: false,
  intervalSec: 5,
  updatedAt: '',
  updatedBy: '',
};

let ready = false;
function db() {
  const d = getDb();
  if (!ready) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS mirror_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        settings_json TEXT NOT NULL,
        book_json TEXT NOT NULL DEFAULT '{}',
        lease_owner TEXT NOT NULL DEFAULT '',
        lease_until INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS mirror_outbox (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        tbl TEXT NOT NULL,
        pk TEXT NOT NULL,
        at TEXT NOT NULL
      );
    `);
    d.prepare(`INSERT OR IGNORE INTO mirror_settings (id, settings_json) VALUES (1, ?)`).run(JSON.stringify(DEFAULT_SETTINGS));
    ready = true;
  }
  return d;
}

/** Tests reopen the database between cases. */
export function resetMirrorSourceForTests(): void { ready = false; }

export function loadSettings(): MirrorSettings {
  const row = db().prepare('SELECT settings_json FROM mirror_settings WHERE id = 1').get() as { settings_json: string } | undefined;
  let parsed: Partial<MirrorSettings> = {};
  try { parsed = JSON.parse(row?.settings_json || '{}'); } catch { parsed = {}; }
  return { ...DEFAULT_SETTINGS, ...parsed };
}

export function saveSettings(next: MirrorSettings): void {
  db().prepare('UPDATE mirror_settings SET settings_json = ? WHERE id = 1').run(JSON.stringify(next));
}

export function loadBook(): MirrorBookkeeping {
  const row = db().prepare('SELECT book_json FROM mirror_settings WHERE id = 1').get() as { book_json: string } | undefined;
  let parsed: Partial<MirrorBookkeeping> = {};
  try { parsed = JSON.parse(row?.book_json || '{}'); } catch { parsed = {}; }
  return {
    fingerprint: '', syncedTables: [], lastFullSyncAt: '', lastOkAt: '', lastError: '', lastErrorAt: '',
    ...parsed,
  };
}

export function saveBook(book: MirrorBookkeeping): void {
  db().prepare('UPDATE mirror_settings SET book_json = ? WHERE id = 1').run(JSON.stringify(book));
}

/** One worker at a time, even if two console processes share the data folder. */
export function acquireLease(owner: string, ttlMs: number): boolean {
  const now = Date.now();
  const r = db().prepare(
    `UPDATE mirror_settings SET lease_owner = ?, lease_until = ? WHERE id = 1 AND (lease_owner = ? OR lease_until < ?)`
  ).run(owner, now + ttlMs, owner, now);
  return Number(r.changes || 0) === 1;
}

export function releaseLease(owner: string): void {
  db().prepare(`UPDATE mirror_settings SET lease_until = 0 WHERE id = 1 AND lease_owner = ?`).run(owner);
}

/** Current mirrorable tables and their columns, straight from SQLite. */
export function discoverTables(): Map<string, TableSpec> {
  const d = db();
  const names = (d.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as Array<{ name: string }>)
    .map((r) => r.name)
    .filter((n) => isValidName(n) && !n.startsWith('sqlite_') && !n.startsWith('mirror_') && !EXCLUDED_TABLES.has(n));
  const out = new Map<string, TableSpec>();
  for (const name of names) {
    const info = d.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string; type: string; pk: number }>;
    const pk = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    if (!pk.length || pk.some((k) => EXCLUDED_COLUMN_RE.test(k) || !isValidName(k))) continue;
    const columns: ColumnSpec[] = info
      .filter((c) => isValidName(c.name) && !EXCLUDED_COLUMN_RE.test(c.name))
      .map((c) => ({ name: c.name, kind: kindOf(c.type) }));
    out.set(name, { name, columns, pk });
  }
  return out;
}

const TRIGGER_SUFFIXES = ['ai', 'au', 'ad'] as const;
const triggerName = (table: string, suffix: string) => `mirror_${table}_${suffix}`;

function installedTriggers(): Set<string> {
  return new Set(
    (db().prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'mirror\\_%' ESCAPE '\\'`).all() as Array<{ name: string }>).map((r) => r.name)
  );
}

/**
 * Adds change-capture triggers to any table that lacks them and returns the
 * tables that were newly covered (they need a full copy).
 */
export function ensureTriggers(tables: Map<string, TableSpec>): string[] {
  const d = db();
  const have = installedTriggers();
  const added: string[] = [];
  const now = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
  for (const spec of tables.values()) {
    if (TRIGGER_SUFFIXES.every((s) => have.has(triggerName(spec.name, s)))) continue;
    const key = (alias: 'NEW' | 'OLD') => `json_array(${spec.pk.map((k) => `${alias}."${k}"`).join(', ')})`;
    const enqueue = (alias: 'NEW' | 'OLD') => `INSERT INTO mirror_outbox (tbl, pk, at) VALUES ('${spec.name}', ${key(alias)}, ${now});`;
    d.transaction(() => {
      for (const s of TRIGGER_SUFFIXES) d.exec(`DROP TRIGGER IF EXISTS ${triggerName(spec.name, s)}`);
      d.exec(`CREATE TRIGGER ${triggerName(spec.name, 'ai')} AFTER INSERT ON "${spec.name}" BEGIN ${enqueue('NEW')} END`);
      // Both keys: if an update changed the key, the old key's row is now gone.
      d.exec(`CREATE TRIGGER ${triggerName(spec.name, 'au')} AFTER UPDATE ON "${spec.name}" BEGIN ${enqueue('OLD')} ${enqueue('NEW')} END`);
      d.exec(`CREATE TRIGGER ${triggerName(spec.name, 'ad')} AFTER DELETE ON "${spec.name}" BEGIN ${enqueue('OLD')} END`);
    })();
    added.push(spec.name);
  }
  return added;
}

/** Turning the mirror off removes every trigger and pending change. */
export function removeTriggersAndOutbox(): void {
  const d = db();
  d.transaction(() => {
    for (const name of installedTriggers()) if (isValidName(name)) d.exec(`DROP TRIGGER IF EXISTS ${name}`);
    d.exec('DELETE FROM mirror_outbox');
  })();
}

export function hasTriggers(table: string): boolean {
  const have = installedTriggers();
  return TRIGGER_SUFFIXES.every((s) => have.has(triggerName(table, s)));
}

export interface OutboxEntry { seq: number; tbl: string; pk: string; at: string }

export function readOutbox(limit: number): OutboxEntry[] {
  return db().prepare('SELECT seq, tbl, pk, at FROM mirror_outbox ORDER BY seq LIMIT ?').all(limit) as OutboxEntry[];
}

export function maxOutboxSeq(): number {
  const r = db().prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM mirror_outbox').get() as { m: number };
  return Number(r.m || 0);
}

export function deleteOutboxThrough(seq: number, tables?: string[]): void {
  if (!tables) {
    db().prepare('DELETE FROM mirror_outbox WHERE seq <= ?').run(seq);
    return;
  }
  const stmt = db().prepare('DELETE FROM mirror_outbox WHERE seq <= ? AND tbl = ?');
  for (const t of tables) stmt.run(seq, t);
}

export function clearOutbox(): void {
  db().exec('DELETE FROM mirror_outbox');
}

export function outboxStats(): { pending: number; oldestAt: string | null } {
  const r = db().prepare('SELECT COUNT(*) AS n, MIN(at) AS oldest FROM mirror_outbox').get() as { n: number; oldest: string | null };
  return { pending: Number(r.n || 0), oldestAt: r.oldest || null };
}

const dq = (name: string) => `"${name}"`; // names already passed NAME_RE
const colList = (spec: TableSpec) => spec.columns.map((c) => dq(c.name)).join(', ');

/** Current values for the given keys; keys whose row no longer exists are returned in `missing`. */
export function readRowsByKeys(spec: TableSpec, keys: unknown[][]): { rows: Record<string, unknown>[]; missing: unknown[][] } {
  const stmt = db().prepare(`SELECT ${colList(spec)} FROM ${dq(spec.name)} WHERE ${spec.pk.map((k) => `${dq(k)} = ?`).join(' AND ')}`);
  const rows: Record<string, unknown>[] = [];
  const missing: unknown[][] = [];
  for (const key of keys) {
    const row = stmt.get(...key) as Record<string, unknown> | undefined;
    if (row) rows.push(row); else missing.push(key);
  }
  return { rows, missing };
}

/**
 * Pages through a whole table in key order (for full copies). Keyset paging
 * (key > last key seen), so rows deleted during the copy cannot shift a page
 * and make an unchanged row be skipped.
 */
export function* readAllRows(spec: TableSpec, pageSize = 500): Generator<Record<string, unknown>[]> {
  const d = db();
  const keys = spec.pk.map(dq).join(', ');
  const after = spec.pk.length === 1 ? `${keys} > ?` : `(${keys}) > (${spec.pk.map(() => '?').join(', ')})`;
  const first = d.prepare(`SELECT ${colList(spec)} FROM ${dq(spec.name)} ORDER BY ${keys} LIMIT ?`);
  const next = d.prepare(`SELECT ${colList(spec)} FROM ${dq(spec.name)} WHERE ${after} ORDER BY ${keys} LIMIT ?`);
  let last: unknown[] | null = null;
  for (;;) {
    const page = (last ? next.all(...last, pageSize) : first.all(pageSize)) as Record<string, unknown>[];
    if (!page.length) return;
    yield page;
    if (page.length < pageSize) return;
    const tail = page[page.length - 1];
    last = spec.pk.map((k) => tail[k]);
  }
}

export function countRows(table: string): number {
  if (!isValidName(table)) return 0;
  const r = db().prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number };
  return Number(r.n || 0);
}
