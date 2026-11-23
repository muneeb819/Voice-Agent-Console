"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_SETTINGS = exports.OUTBOX_LIMIT = exports.EXCLUDED_COLUMN_RE = exports.EXCLUDED_TABLES = void 0;
exports.resetMirrorSourceForTests = resetMirrorSourceForTests;
exports.loadSettings = loadSettings;
exports.saveSettings = saveSettings;
exports.loadBook = loadBook;
exports.saveBook = saveBook;
exports.acquireLease = acquireLease;
exports.releaseLease = releaseLease;
exports.discoverTables = discoverTables;
exports.ensureTriggers = ensureTriggers;
exports.removeTriggersAndOutbox = removeTriggersAndOutbox;
exports.hasTriggers = hasTriggers;
exports.readOutbox = readOutbox;
exports.maxOutboxSeq = maxOutboxSeq;
exports.deleteOutboxThrough = deleteOutboxThrough;
exports.clearOutbox = clearOutbox;
exports.outboxStats = outboxStats;
exports.readRowsByKeys = readRowsByKeys;
exports.readAllRows = readAllRows;
exports.countRows = countRows;
// SQLite side of the SQL Server mirror: settings row, table discovery,
// change-capture triggers and the outbox they write to.
//
// Triggers only record WHICH row changed (its key). The worker reads the row's
// current values when it syncs, so a row changed ten times is sent once, and a
// row that no longer exists is deleted from SQL Server.
const db_1 = require("../db");
const sql_1 = require("./sql");
/** Never mirrored: login sessions, revoked tokens and internal rotation cursors. */
exports.EXCLUDED_TABLES = new Set([
    'user_sessions',
    'revoked_admin_sessions',
    'greeting_rotation_used',
    'greeting_rotation_state',
    'greeting_line_used',
]);
/** Never mirrored from any table: password hashes, secrets and tokens. */
exports.EXCLUDED_COLUMN_RE = /pass(word)?|hash|secret|token|salt/i;
exports.OUTBOX_LIMIT = 100_000;
exports.DEFAULT_SETTINGS = {
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
    const d = (0, db_1.getDb)();
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
        d.prepare(`INSERT OR IGNORE INTO mirror_settings (id, settings_json) VALUES (1, ?)`).run(JSON.stringify(exports.DEFAULT_SETTINGS));
        ready = true;
    }
    return d;
}
/** Tests reopen the database between cases. */
function resetMirrorSourceForTests() { ready = false; }
function loadSettings() {
    const row = db().prepare('SELECT settings_json FROM mirror_settings WHERE id = 1').get();
    let parsed = {};
    try {
        parsed = JSON.parse(row?.settings_json || '{}');
    }
    catch {
        parsed = {};
    }
    return { ...exports.DEFAULT_SETTINGS, ...parsed };
}
function saveSettings(next) {
    db().prepare('UPDATE mirror_settings SET settings_json = ? WHERE id = 1').run(JSON.stringify(next));
}
function loadBook() {
    const row = db().prepare('SELECT book_json FROM mirror_settings WHERE id = 1').get();
    let parsed = {};
    try {
        parsed = JSON.parse(row?.book_json || '{}');
    }
    catch {
        parsed = {};
    }
    return {
        fingerprint: '', syncedTables: [], lastFullSyncAt: '', lastOkAt: '', lastError: '', lastErrorAt: '',
        ...parsed,
    };
}
function saveBook(book) {
    db().prepare('UPDATE mirror_settings SET book_json = ? WHERE id = 1').run(JSON.stringify(book));
}
/** One worker at a time, even if two console processes share the data folder. */
function acquireLease(owner, ttlMs) {
    const now = Date.now();
    const r = db().prepare(`UPDATE mirror_settings SET lease_owner = ?, lease_until = ? WHERE id = 1 AND (lease_owner = ? OR lease_until < ?)`).run(owner, now + ttlMs, owner, now);
    return Number(r.changes || 0) === 1;
}
function releaseLease(owner) {
    db().prepare(`UPDATE mirror_settings SET lease_until = 0 WHERE id = 1 AND lease_owner = ?`).run(owner);
}
/** Current mirrorable tables and their columns, straight from SQLite. */
function discoverTables() {
    const d = db();
    const names = d.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all()
        .map((r) => r.name)
        .filter((n) => (0, sql_1.isValidName)(n) && !n.startsWith('sqlite_') && !n.startsWith('mirror_') && !exports.EXCLUDED_TABLES.has(n));
    const out = new Map();
    for (const name of names) {
        const info = d.prepare(`PRAGMA table_info("${name}")`).all();
        const pk = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
        if (!pk.length || pk.some((k) => exports.EXCLUDED_COLUMN_RE.test(k) || !(0, sql_1.isValidName)(k)))
            continue;
        const columns = info
            .filter((c) => (0, sql_1.isValidName)(c.name) && !exports.EXCLUDED_COLUMN_RE.test(c.name))
            .map((c) => ({ name: c.name, kind: (0, sql_1.kindOf)(c.type) }));
        out.set(name, { name, columns, pk });
    }
    return out;
}
const TRIGGER_SUFFIXES = ['ai', 'au', 'ad'];
const triggerName = (table, suffix) => `mirror_${table}_${suffix}`;
function installedTriggers() {
    return new Set(db().prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'mirror\\_%' ESCAPE '\\'`).all().map((r) => r.name));
}
/**
 * Adds change-capture triggers to any table that lacks them and returns the
 * tables that were newly covered (they need a full copy).
 */
function ensureTriggers(tables) {
    const d = db();
    const have = installedTriggers();
    const added = [];
    const now = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
    for (const spec of tables.values()) {
        if (TRIGGER_SUFFIXES.every((s) => have.has(triggerName(spec.name, s))))
            continue;
        const key = (alias) => `json_array(${spec.pk.map((k) => `${alias}."${k}"`).join(', ')})`;
        const enqueue = (alias) => `INSERT INTO mirror_outbox (tbl, pk, at) VALUES ('${spec.name}', ${key(alias)}, ${now});`;
        d.transaction(() => {
            for (const s of TRIGGER_SUFFIXES)
                d.exec(`DROP TRIGGER IF EXISTS ${triggerName(spec.name, s)}`);
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
function removeTriggersAndOutbox() {
    const d = db();
    d.transaction(() => {
        for (const name of installedTriggers())
            if ((0, sql_1.isValidName)(name))
                d.exec(`DROP TRIGGER IF EXISTS ${name}`);
        d.exec('DELETE FROM mirror_outbox');
    })();
}
function hasTriggers(table) {
    const have = installedTriggers();
    return TRIGGER_SUFFIXES.every((s) => have.has(triggerName(table, s)));
}
function readOutbox(limit) {
    return db().prepare('SELECT seq, tbl, pk, at FROM mirror_outbox ORDER BY seq LIMIT ?').all(limit);
}
function maxOutboxSeq() {
    const r = db().prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM mirror_outbox').get();
    return Number(r.m || 0);
}
function deleteOutboxThrough(seq, tables) {
    if (!tables) {
        db().prepare('DELETE FROM mirror_outbox WHERE seq <= ?').run(seq);
        return;
    }
    const stmt = db().prepare('DELETE FROM mirror_outbox WHERE seq <= ? AND tbl = ?');
    for (const t of tables)
        stmt.run(seq, t);
}
function clearOutbox() {
    db().exec('DELETE FROM mirror_outbox');
}
function outboxStats() {
    const r = db().prepare('SELECT COUNT(*) AS n, MIN(at) AS oldest FROM mirror_outbox').get();
    return { pending: Number(r.n || 0), oldestAt: r.oldest || null };
}
const dq = (name) => `"${name}"`; // names already passed NAME_RE
const colList = (spec) => spec.columns.map((c) => dq(c.name)).join(', ');
/** Current values for the given keys; keys whose row no longer exists are returned in `missing`. */
function readRowsByKeys(spec, keys) {
    const stmt = db().prepare(`SELECT ${colList(spec)} FROM ${dq(spec.name)} WHERE ${spec.pk.map((k) => `${dq(k)} = ?`).join(' AND ')}`);
    const rows = [];
    const missing = [];
    for (const key of keys) {
        const row = stmt.get(...key);
        if (row)
            rows.push(row);
        else
            missing.push(key);
    }
    return { rows, missing };
}
/** Pages through a whole table in key order (for full copies). */
function* readAllRows(spec, pageSize = 500) {
    const d = db();
    const order = spec.pk.map(dq).join(', ');
    let offset = 0;
    for (;;) {
        const page = d.prepare(`SELECT ${colList(spec)} FROM ${dq(spec.name)} ORDER BY ${order} LIMIT ? OFFSET ?`).all(pageSize, offset);
        if (!page.length)
            return;
        yield page;
        if (page.length < pageSize)
            return;
        offset += page.length;
    }
}
function countRows(table) {
    if (!(0, sql_1.isValidName)(table))
        return 0;
    const r = db().prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get();
    return Number(r.n || 0);
}
