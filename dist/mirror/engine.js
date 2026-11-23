"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.setTargetFactoryForTests = setTargetFactoryForTests;
exports.fingerprint = fingerprint;
exports.missingSettings = missingSettings;
exports.runOnce = runOnce;
exports.startMirror = startMirror;
exports.stopMirror = stopMirror;
exports.setMirrorEnabled = setMirrorEnabled;
exports.requestFullResync = requestFullResync;
exports.updateMirrorSettings = updateMirrorSettings;
exports.testMirrorConnection = testMirrorConnection;
exports.mirrorStatus = mirrorStatus;
// The mirror worker: keeps an AWS RDS SQL Server database in step with the
// console's SQLite database. SQLite stays the live database for calls; the
// mirror only reads it, so an RDS outage never affects a call.
const crypto_1 = __importDefault(require("crypto"));
const env_store_1 = require("../env-store");
const source_1 = require("./source");
const target_1 = require("./target");
let targetFactory = (cfg) => new target_1.MssqlTarget(cfg);
/** Tests swap in an in-memory target. */
function setTargetFactoryForTests(f) {
    targetFactory = f || ((cfg) => new target_1.MssqlTarget(cfg));
}
const OWNER = `${process.pid}-${crypto_1.default.randomBytes(4).toString('hex')}`;
const BATCH = 500;
const MAX_BATCHES_PER_TICK = 40;
const rt = { phase: 'off', serverVersion: '', rowsSent: 0, rowsDeleted: 0, lastTickAt: '', copying: '', tableRows: {}, views: [], failures: 0 };
let target = null;
let targetKey = '';
let timer = null;
let running = false;
let rerun = false;
let started = false;
function fingerprint(s) {
    return [s.host.toLowerCase(), s.port, s.database.toLowerCase(), s.schema.toLowerCase()].join('|');
}
function targetConfig(s) {
    return {
        host: s.host, port: s.port, database: s.database, username: s.username,
        password: (0, env_store_1.getSecret)('MSSQL_PASSWORD'), schema: s.schema, verifyCert: s.verifyCert,
    };
}
function missingSettings(s) {
    const missing = [];
    if (!s.host)
        missing.push('RDS endpoint');
    if (!s.database)
        missing.push('database name');
    if (!s.username)
        missing.push('username');
    if (!(0, env_store_1.getSecret)('MSSQL_PASSWORD'))
        missing.push('password');
    return missing;
}
async function dropTarget() {
    const t = target;
    target = null;
    targetKey = '';
    if (t)
        await t.close().catch(() => { });
}
async function openTarget(s) {
    const key = `${fingerprint(s)}|${s.username}|${s.verifyCert}|${crypto_1.default.createHash('sha256').update((0, env_store_1.getSecret)('MSSQL_PASSWORD')).digest('hex')}`;
    if (target && targetKey === key)
        return target;
    await dropTarget();
    const t = targetFactory(targetConfig(s));
    const info = await t.open();
    rt.serverVersion = info.version;
    target = t;
    targetKey = key;
    return t;
}
/** Copies one whole table: empties it in SQL Server (unless keeping deleted rows), then sends every row. */
async function copyTable(t, spec, keepDeleted) {
    rt.copying = spec.name;
    await t.ensureTable(spec);
    let sent = 0;
    let first = true;
    for (const page of (0, source_1.readAllRows)(spec, BATCH)) {
        await t.apply(spec, { truncate: first && !keepDeleted, upserts: page, deletes: [] });
        first = false;
        sent += page.length;
    }
    if (first && !keepDeleted)
        await t.apply(spec, { truncate: true, upserts: [], deletes: [] });
    rt.rowsSent += sent;
    rt.tableRows[spec.name] = sent;
    rt.copying = '';
    return sent;
}
/** Sends queued changes, oldest first, until the queue is empty or the tick's budget is spent. */
async function drain(t, tables, s, book) {
    for (let n = 0; n < MAX_BATCHES_PER_TICK; n++) {
        const entries = (0, source_1.readOutbox)(BATCH);
        if (!entries.length)
            return;
        const byTable = new Map();
        for (const e of entries) {
            if (!tables.has(e.tbl))
                continue; // table no longer mirrored
            let keys = byTable.get(e.tbl);
            if (!keys)
                byTable.set(e.tbl, (keys = new Map()));
            try {
                const key = JSON.parse(e.pk);
                if (Array.isArray(key))
                    keys.set(e.pk, key);
            }
            catch { /* malformed key: skip it */ }
        }
        for (const [name, keys] of byTable) {
            const spec = tables.get(name);
            if (!book.syncedTables.includes(name))
                continue; // a full copy will cover it
            if (await t.ensureTable(spec)) {
                // New columns: re-copy so existing rows get their values.
                await copyTable(t, spec, s.keepDeleted);
                continue;
            }
            const { rows, missing } = (0, source_1.readRowsByKeys)(spec, [...keys.values()]);
            const deletes = s.keepDeleted ? [] : missing;
            await t.apply(spec, { upserts: rows, deletes });
            rt.rowsSent += rows.length;
            rt.rowsDeleted += deletes.length;
        }
        (0, source_1.deleteOutboxThrough)(entries[entries.length - 1].seq);
    }
}
async function tick() {
    const s = (0, source_1.loadSettings)();
    const book = (0, source_1.loadBook)();
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
        (0, source_1.saveBook)(book);
        return;
    }
    if (!(0, source_1.acquireLease)(OWNER, Math.max(60_000, s.intervalSec * 4000)))
        return; // another process is syncing
    const tables = (0, source_1.discoverTables)();
    // Capture changes first, so nothing written during a copy is missed.
    const newlyCovered = (0, source_1.ensureTriggers)(tables);
    const fp = fingerprint(s);
    if (book.fingerprint !== fp) {
        book.fingerprint = fp;
        book.syncedTables = [];
    }
    if (newlyCovered.length)
        book.syncedTables = book.syncedTables.filter((tn) => !newlyCovered.includes(tn));
    if ((0, source_1.outboxStats)().pending > source_1.OUTBOX_LIMIT) {
        // Too far behind: a full copy is cheaper than replaying every change.
        (0, source_1.clearOutbox)();
        book.syncedTables = [];
    }
    rt.phase = 'starting';
    const t = await openTarget(s);
    const toCopy = [...tables.keys()].filter((tn) => !book.syncedTables.includes(tn));
    if (toCopy.length) {
        rt.phase = 'copying';
        const startSeq = (0, source_1.maxOutboxSeq)();
        for (const tn of toCopy) {
            await copyTable(t, tables.get(tn), s.keepDeleted);
            book.syncedTables.push(tn);
            (0, source_1.saveBook)(book);
        }
        // Changes to these tables queued before their copy began are already in it.
        (0, source_1.deleteOutboxThrough)(startSeq, toCopy);
        if (toCopy.length >= tables.size)
            book.lastFullSyncAt = new Date().toISOString();
        (0, source_1.saveBook)(book);
        rt.views = await t.ensureViews(tables);
    }
    rt.phase = 'syncing';
    await drain(t, tables, s, book);
    rt.phase = 'idle';
    rt.failures = 0;
    book.lastOkAt = new Date().toISOString();
    book.lastError = '';
    (0, source_1.saveBook)(book);
}
function schedule(ms) {
    if (timer)
        clearTimeout(timer);
    timer = setTimeout(() => { void runOnce(); }, ms);
    timer.unref?.();
}
/** Runs one sync cycle now (or right after the current one). */
async function runOnce() {
    if (running) {
        rerun = true;
        return;
    }
    running = true;
    let delay = 5000;
    try {
        await tick();
        delay = (0, source_1.loadSettings)().intervalSec * 1000;
    }
    catch (err) {
        rt.failures += 1;
        rt.phase = 'error';
        rt.copying = '';
        const book = (0, source_1.loadBook)();
        book.lastError = (0, target_1.explainSqlError)(err);
        book.lastErrorAt = new Date().toISOString();
        (0, source_1.saveBook)(book);
        await dropTarget();
        const base = (0, source_1.loadSettings)().intervalSec * 1000;
        delay = Math.min(120_000, base * 2 ** Math.min(rt.failures, 5));
    }
    finally {
        running = false;
    }
    if (rerun) {
        rerun = false;
        delay = 0;
    }
    if (started)
        schedule(delay);
}
function startMirror() {
    if (started)
        return;
    started = true;
    schedule(3000);
}
async function stopMirror() {
    started = false;
    if (timer)
        clearTimeout(timer);
    timer = null;
    (0, source_1.releaseLease)(OWNER);
    await dropTarget();
}
function setMirrorEnabled(enabled, by) {
    const s = { ...(0, source_1.loadSettings)(), enabled, updatedAt: new Date().toISOString(), updatedBy: by };
    (0, source_1.saveSettings)(s);
    if (!enabled) {
        (0, source_1.removeTriggersAndOutbox)();
        const book = (0, source_1.loadBook)();
        book.syncedTables = []; // changes made while off are not tracked, so re-copy on the next start
        (0, source_1.saveBook)(book);
        rt.phase = 'off';
        void dropTarget();
    }
    if (started)
        schedule(0);
    return s;
}
function requestFullResync() {
    const book = (0, source_1.loadBook)();
    book.syncedTables = [];
    (0, source_1.saveBook)(book);
    if (started)
        schedule(0);
}
function updateMirrorSettings(next) {
    (0, source_1.saveSettings)(next);
    void dropTarget();
    if (started)
        schedule(0);
}
/** Connects with the given settings and reports the server, without changing anything else. */
async function testMirrorConnection(s) {
    const missing = missingSettings(s);
    if (missing.length)
        return { ok: false, error: `Missing: ${missing.join(', ')}.` };
    const t = targetFactory(targetConfig(s));
    try {
        const info = await t.open();
        return { ok: true, version: info.version, createdDatabase: info.createdDatabase };
    }
    catch (err) {
        return { ok: false, error: (0, target_1.explainSqlError)(err) };
    }
    finally {
        await t.close().catch(() => { });
    }
}
function mirrorStatus() {
    const s = (0, source_1.loadSettings)();
    const book = (0, source_1.loadBook)();
    const tables = [...(0, source_1.discoverTables)().keys()];
    const { pending, oldestAt } = (0, source_1.outboxStats)();
    return {
        ok: true,
        settings: { ...s, passwordSet: Boolean((0, env_store_1.getSecret)('MSSQL_PASSWORD')) },
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
        tables: tables.map((name) => ({ name, rows: (0, source_1.countRows)(name), copied: book.syncedTables.includes(name) })),
    };
}
