"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDb = getDb;
exports.listGreetingLibrary = listGreetingLibrary;
exports.selectGreetingForAgent = selectGreetingForAgent;
exports.trySelectGreeting = trySelectGreeting;
exports.getConsoleState = getConsoleState;
exports.saveConsoleState = saveConsoleState;
exports.listRevisions = listRevisions;
exports.saveSimulatorCallLog = saveSimulatorCallLog;
exports.listSimulatorCallLogs = listSimulatorCallLogs;
exports.getSimulatorCallLog = getSimulatorCallLog;
exports.attachSimulatorRecording = attachSimulatorRecording;
exports.deleteSimulatorRecording = deleteSimulatorRecording;
exports.clearSimulatorCallLogs = clearSimulatorCallLogs;
exports.saveBridgeCallLog = saveBridgeCallLog;
exports.listBridgeCallLogs = listBridgeCallLogs;
exports.clearBridgeCallLogs = clearBridgeCallLogs;
exports.getBridgeAnalyticsSummary = getBridgeAnalyticsSummary;
exports.exportBridgeLogsCsv = exportBridgeLogsCsv;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const call_recorder_1 = require("./call-recorder");
const simulator_recordings_1 = require("./simulator-recordings");
const defaults_1 = require("./defaults");
const settings_builder_1 = require("./settings-builder");
const data_paths_1 = require("./data-paths");
const greetings_1 = require("./greetings");
const opening_1 = require("./opening");
function openSqliteEngine(dbPath) {
    const normArgs = (args) => args.map((v) => (v === undefined ? null : v));
    // 1) Primary engine: better-sqlite3 (fast C++ native binding with prebuilds for Node 20..25)
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const BetterSqlite3 = require('better-sqlite3');
        const raw = new BetterSqlite3(dbPath);
        raw.pragma('journal_mode = WAL');
        raw.pragma('busy_timeout = 5000');
        return {
            exec: (sql) => raw.exec(sql),
            prepare: (sql) => {
                const stmt = raw.prepare(sql);
                return {
                    get: (...p) => stmt.get(...normArgs(p)),
                    all: (...p) => stmt.all(...normArgs(p)),
                    run: (...p) => stmt.run(...normArgs(p)),
                };
            },
            transaction: (fn) => raw.transaction(fn),
            transactionImmediate: (fn) => raw.transaction(fn).immediate,
        };
    }
    catch {
        // 2) Built-in fallback for Node 22.5+ / 23 / 24 / 25+ when native C++ addon isn't built
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { DatabaseSync } = require('node:sqlite');
        const raw = new DatabaseSync(dbPath);
        raw.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000');
        const transaction = (fn) => () => {
            raw.exec('BEGIN IMMEDIATE');
            try {
                const out = fn();
                raw.exec('COMMIT');
                return out;
            }
            catch (err) {
                try {
                    raw.exec('ROLLBACK');
                }
                catch {
                    // ignore rollback error
                }
                throw err;
            }
        };
        return {
            exec: (sql) => raw.exec(sql),
            prepare: (sql) => {
                const stmt = raw.prepare(sql);
                return {
                    get: (...p) => stmt.get(...normArgs(p)),
                    all: (...p) => stmt.all(...normArgs(p)),
                    run: (...p) => stmt.run(...normArgs(p)),
                };
            },
            transaction,
            transactionImmediate: transaction,
        };
    }
}
const DB_PATH = path_1.default.join(data_paths_1.DATA_DIR, 'console.sqlite');
const JSON_MIRROR_PATH = path_1.default.join(data_paths_1.DATA_DIR, 'console-state.json');
let db = null;
function getDb() {
    if (db)
        return db;
    fs_1.default.mkdirSync(data_paths_1.DATA_DIR, { recursive: true });
    db = openSqliteEngine(DB_PATH);
    db.exec(`
    CREATE TABLE IF NOT EXISTS console_store (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS state_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      saved_at TEXT NOT NULL,
      summary TEXT NOT NULL,
      snapshot TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS greeting_library (
      greeting_id TEXT PRIMARY KEY,
      persona TEXT NOT NULL,
      context TEXT NOT NULL,
      greeting_text TEXT NOT NULL,
      tone TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS greeting_rotation_used (
      agent_id TEXT NOT NULL,
      greeting_id TEXT NOT NULL,
      PRIMARY KEY (agent_id, greeting_id)
    );
    CREATE TABLE IF NOT EXISTS greeting_rotation_state (
      agent_id TEXT PRIMARY KEY,
      last_greeting_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS simulator_calls (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      campaign_id TEXT,
      greeting_id TEXT,
      upstream_mode TEXT NOT NULL,
      sample_rate_in INTEGER NOT NULL,
      sample_rate_out INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      turns INTEGER NOT NULL,
      avg_ttfb_ms INTEGER,
      disposition TEXT,
      transferred_to TEXT,
      recording_requested INTEGER NOT NULL DEFAULT 0,
      recording_status TEXT NOT NULL DEFAULT 'not_requested',
      recording_file TEXT,
      recording_mime TEXT,
      recording_bytes INTEGER NOT NULL DEFAULT 0,
      recording_truncated INTEGER NOT NULL DEFAULT 0,
      transcript_json TEXT NOT NULL,
      functions_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bridge_calls (
      id TEXT PRIMARY KEY,
      transport TEXT NOT NULL,
      exten TEXT NOT NULL,
      caller_code TEXT NOT NULL,
      lead_id TEXT,
      phone TEXT NOT NULL,
      campaign_id TEXT,
      vici_campaign TEXT,
      agent_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      greeting_id TEXT,
      remote_agent_user TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      turns INTEGER NOT NULL,
      avg_ttfb_ms INTEGER,
      disposition TEXT,
      transferred_to TEXT,
      dnc_added INTEGER NOT NULL DEFAULT 0,
      recording_file TEXT,
      recording_bytes INTEGER NOT NULL DEFAULT 0,
      transcript_json TEXT NOT NULL,
      functions_json TEXT NOT NULL,
      vici_api_audit_json TEXT NOT NULL
    );
  `);
    // Add optional browser recording metadata without changing old test logs.
    const simCols = new Set(db.prepare('PRAGMA table_info(simulator_calls)').all().map((c) => c.name));
    for (const [name, definition] of [
        ['recording_requested', 'INTEGER NOT NULL DEFAULT 0'],
        ['recording_status', "TEXT NOT NULL DEFAULT 'not_requested'"],
        ['recording_file', 'TEXT'],
        ['recording_mime', 'TEXT'],
        ['recording_bytes', 'INTEGER NOT NULL DEFAULT 0'],
        ['recording_truncated', 'INTEGER NOT NULL DEFAULT 0'],
        ['greeting_id', 'TEXT'],
    ]) {
        if (!simCols.has(name))
            db.exec(`ALTER TABLE simulator_calls ADD COLUMN ${name} ${definition}`);
    }
    // Safe Step 4 schema migration for existing SQLite databases
    const bridgeCols = db.prepare('PRAGMA table_info(bridge_calls)').all();
    const colNames = new Set(bridgeCols.map((c) => c.name));
    if (!colNames.has('recording_file')) {
        db.exec('ALTER TABLE bridge_calls ADD COLUMN recording_file TEXT');
    }
    if (!colNames.has('recording_bytes')) {
        db.exec('ALTER TABLE bridge_calls ADD COLUMN recording_bytes INTEGER NOT NULL DEFAULT 0');
    }
    if (!colNames.has('greeting_id')) {
        db.exec('ALTER TABLE bridge_calls ADD COLUMN greeting_id TEXT');
    }
    // The CSV-derived catalog is an idempotent seed, not console state or a
    // secret. Keep any already-imported database rows/edits on subsequent starts.
    try {
        const rows = (0, greetings_1.loadBundledGreetings)();
        const insert = db.prepare(`INSERT OR IGNORE INTO greeting_library
      (greeting_id, persona, context, greeting_text, tone) VALUES (?, ?, ?, ?, ?)`);
        db.transactionImmediate(() => {
            for (const row of rows)
                insert.run(row.greeting_id, row.persona, row.context, row.greeting_text, row.tone);
        })();
    }
    catch (err) {
        // A missing/corrupt seed must not prevent calls from using the saved greeting.
        console.error('[greetings] Could not seed the bundled greeting library:', err instanceof Error ? err.message : err);
    }
    return db;
}
function listGreetingLibrary() {
    return getDb().prepare(`SELECT greeting_id, persona, context, greeting_text, tone
    FROM greeting_library ORDER BY CAST(greeting_id AS INTEGER), greeting_id`).all();
}
/**
 * Randomly choose an unused library row under a cross-process SQLite lock.
 * When the saved opening is available, prefer a row that produces different
 * wording from the previous draw. IDs still complete their entire cycle; if
 * every remaining row produces the same wording, an occasional repeat is
 * unavoidable without discarding rows or changing the operator's script.
 */
function selectGreetingForAgent(agentId, savedOpening = '') {
    if (!agentId)
        return null;
    const conn = getDb();
    return conn.transactionImmediate(() => {
        const findUnused = conn.prepare(`SELECT g.greeting_id, g.persona, g.context, g.greeting_text, g.tone
      FROM greeting_library g WHERE NOT EXISTS (
        SELECT 1 FROM greeting_rotation_used u WHERE u.agent_id = ? AND u.greeting_id = g.greeting_id
      ) ORDER BY RANDOM()`);
        const last = conn.prepare(`SELECT g.greeting_id, g.greeting_text FROM greeting_rotation_state s
      LEFT JOIN greeting_library g ON g.greeting_id = s.last_greeting_id WHERE s.agent_id = ?`).get(agentId);
        let candidates = findUnused.all(agentId);
        if (!candidates.length) {
            const total = conn.prepare('SELECT COUNT(*) AS count FROM greeting_library').get();
            if (!Number(total.count))
                return null;
            conn.prepare('DELETE FROM greeting_rotation_used WHERE agent_id = ?').run(agentId);
            candidates = findUnused.all(agentId);
            if (candidates.length > 1 && last?.greeting_id) {
                candidates = candidates.filter((row) => row.greeting_id !== last.greeting_id);
            }
        }
        const prior = savedOpening && last?.greeting_text
            ? (0, opening_1.composeOpening)(savedOpening, last.greeting_text, false, '') : '';
        const row = (prior && candidates.find((candidate) => (0, opening_1.composeOpening)(savedOpening, candidate.greeting_text, false, '') !== prior)) || candidates[0];
        if (!row)
            return null;
        conn.prepare('INSERT INTO greeting_rotation_used (agent_id, greeting_id) VALUES (?, ?)').run(agentId, row.greeting_id);
        conn.prepare(`INSERT INTO greeting_rotation_state (agent_id, last_greeting_id) VALUES (?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET last_greeting_id = excluded.last_greeting_id`).run(agentId, row.greeting_id);
        return row;
    })();
}
/** Continue with the configured opening if the library or rotation is unavailable. */
function trySelectGreeting(agentId, enabled, savedOpening = '') {
    if (!enabled)
        return null;
    try {
        return selectGreetingForAgent(agentId, savedOpening);
    }
    catch (err) {
        console.error('[greetings] Could not select a greeting; using the configured opening:', err instanceof Error ? err.message : err);
        return null;
    }
}
function writeJsonMirror(state) {
    fs_1.default.mkdirSync(data_paths_1.DATA_DIR, { recursive: true });
    const tmpPath = `${JSON_MIRROR_PATH}.tmp`;
    fs_1.default.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf8');
    fs_1.default.renameSync(tmpPath, JSON_MIRROR_PATH);
}
function getConsoleState() {
    const conn = getDb();
    const row = conn.prepare('SELECT value FROM console_store WHERE key = ?').get('active_state');
    if (row?.value) {
        try {
            const parsed = JSON.parse(row.value);
            const normalized = (0, defaults_1.normalizeState)(parsed);
            const beforeComparable = JSON.stringify({ ...parsed, updatedAt: '' });
            const afterComparable = JSON.stringify({ ...normalized, updatedAt: '' });
            if (beforeComparable !== afterComparable) {
                const json = JSON.stringify(normalized, null, 2);
                conn
                    .prepare('INSERT OR REPLACE INTO console_store (key, value, updated_at) VALUES (?, ?, ?)')
                    .run('active_state', json, normalized.updatedAt);
                try {
                    fs_1.default.writeFileSync(JSON_MIRROR_PATH, json, 'utf8');
                }
                catch {
                    // Ignore mirror write error
                }
            }
            return normalized;
        }
        catch {
            // Fallback below
        }
    }
    if (fs_1.default.existsSync(JSON_MIRROR_PATH)) {
        try {
            const mirrored = (0, defaults_1.normalizeState)(JSON.parse(fs_1.default.readFileSync(JSON_MIRROR_PATH, 'utf8')));
            saveConsoleState(mirrored, 'Restored from JSON mirror');
            return mirrored;
        }
        catch {
            // Fallback to default
        }
    }
    const initial = (0, defaults_1.createDefaultState)();
    saveConsoleState(initial, 'Initial default state created');
    return initial;
}
function saveConsoleState(rawState, explicitSummary) {
    const conn = getDb();
    const prevRow = conn.prepare('SELECT value FROM console_store WHERE key = ?').get('active_state');
    const prevState = prevRow?.value ? (0, defaults_1.normalizeState)(JSON.parse(prevRow.value)) : null;
    const nextState = (0, defaults_1.normalizeState)(rawState);
    nextState.updatedAt = new Date().toISOString();
    const changes = prevState ? (0, settings_builder_1.diffStates)(prevState, nextState) : ['Initial console configuration created'];
    const summary = explicitSummary || (changes.length ? changes.join('; ') : 'Saved with verification check');
    const serialized = JSON.stringify(nextState);
    const tx = conn.transaction(() => {
        conn
            .prepare(`INSERT INTO console_store (key, value, updated_at)
         VALUES ('active_state', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
            .run(serialized, nextState.updatedAt);
        const info = conn
            .prepare('INSERT INTO state_revisions (saved_at, summary, snapshot) VALUES (?, ?, ?)')
            .run(nextState.updatedAt, summary, serialized);
        conn.prepare(`
      DELETE FROM state_revisions
      WHERE id NOT IN (SELECT id FROM state_revisions ORDER BY id DESC LIMIT 50)
    `).run();
        return Number(info.lastInsertRowid);
    });
    const revisionId = tx();
    writeJsonMirror(nextState);
    return { state: nextState, changes, revisionId };
}
function listRevisions(limit = 15) {
    const conn = getDb();
    return conn
        .prepare('SELECT id, saved_at, summary FROM state_revisions ORDER BY id DESC LIMIT ?')
        .all(limit);
}
function saveSimulatorCallLog(record) {
    const conn = getDb();
    // The recording belongs to its history row. Prune files before deleting rows
    // so a failed unlink cannot silently leave untracked private audio behind.
    conn.transaction(() => {
        const previous = conn.prepare('SELECT recording_file FROM simulator_calls WHERE id = ?').get(record.id);
        if (previous?.recording_file && previous.recording_file !== record.recordingFile) {
            (0, simulator_recordings_1.removeSimulatorRecording)(previous.recording_file);
        }
        conn.prepare(`INSERT OR REPLACE INTO simulator_calls (
        id, agent_id, agent_name, campaign_id, greeting_id, upstream_mode,
        sample_rate_in, sample_rate_out, started_at, ended_at,
        duration_ms, turns, avg_ttfb_ms, disposition, transferred_to,
        recording_requested, recording_status, recording_file, recording_mime,
        recording_bytes, recording_truncated, transcript_json, functions_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(record.id, record.agentId, record.agentName, record.campaignId, record.greetingId || null, record.upstreamMode, record.sampleRateIn, record.sampleRateOut, record.startedAt, record.endedAt, record.durationMs, record.turns, record.avgTtfbMs, record.disposition, record.transferredTo, record.recordingRequested ? 1 : 0, record.recordingStatus || (record.recordingRequested ? 'pending' : 'not_requested'), record.recordingFile || null, record.recordingMime || null, record.recordingBytes || 0, record.recordingTruncated ? 1 : 0, JSON.stringify(record.transcript), JSON.stringify(record.functionCalls));
        const stale = conn.prepare('SELECT recording_file FROM simulator_calls ORDER BY started_at DESC, rowid DESC LIMIT -1 OFFSET 100').all();
        for (const row of stale)
            (0, simulator_recordings_1.removeSimulatorRecording)(row.recording_file);
        conn.prepare(`
      DELETE FROM simulator_calls
      WHERE id NOT IN (SELECT id FROM simulator_calls ORDER BY started_at DESC, rowid DESC LIMIT 100)
    `).run();
    })();
}
function simulatorLogFromRow(r) {
    return {
        id: r.id,
        agentId: r.agent_id,
        agentName: r.agent_name,
        campaignId: r.campaign_id,
        greetingId: r.greeting_id || null,
        upstreamMode: r.upstream_mode,
        sampleRateIn: r.sample_rate_in,
        sampleRateOut: r.sample_rate_out,
        startedAt: r.started_at,
        endedAt: r.ended_at,
        durationMs: r.duration_ms,
        turns: r.turns,
        avgTtfbMs: r.avg_ttfb_ms,
        disposition: r.disposition,
        transferredTo: r.transferred_to,
        recordingRequested: Boolean(r.recording_requested),
        recordingStatus: r.recording_status || 'not_requested',
        recordingFile: r.recording_file || null,
        recordingMime: r.recording_mime || null,
        recordingBytes: Number(r.recording_bytes || 0),
        recordingTruncated: Boolean(r.recording_truncated),
        transcript: JSON.parse(r.transcript_json || '[]'),
        functionCalls: JSON.parse(r.functions_json || '[]'),
    };
}
function listSimulatorCallLogs(agentId, limit = 20) {
    const conn = getDb();
    const rows = (agentId
        ? conn.prepare('SELECT * FROM simulator_calls WHERE agent_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?').all(agentId, limit)
        : conn.prepare('SELECT * FROM simulator_calls ORDER BY started_at DESC, rowid DESC LIMIT ?').all(limit));
    return rows.map(simulatorLogFromRow);
}
function getSimulatorCallLog(id) {
    const row = getDb().prepare('SELECT * FROM simulator_calls WHERE id = ?').get(id);
    return row ? simulatorLogFromRow(row) : null;
}
function attachSimulatorRecording(id, file, mime, bytes, truncated) {
    const result = getDb().prepare(`UPDATE simulator_calls
    SET recording_status = 'available', recording_file = ?, recording_mime = ?, recording_bytes = ?, recording_truncated = ?
    WHERE id = ? AND recording_requested = 1 AND recording_status = 'pending' AND recording_file IS NULL`)
        .run(file, mime, bytes, truncated ? 1 : 0, id);
    return Number(result.changes || 0) === 1;
}
function deleteSimulatorRecording(id) {
    const conn = getDb();
    return conn.transaction(() => {
        const row = conn.prepare('SELECT recording_file, recording_status FROM simulator_calls WHERE id = ?').get(id);
        if (!row)
            return false;
        (0, simulator_recordings_1.removeSimulatorRecording)(row.recording_file);
        conn.prepare(`UPDATE simulator_calls SET recording_status = 'deleted', recording_file = NULL,
      recording_mime = NULL, recording_bytes = 0, recording_truncated = 0 WHERE id = ?`).run(id);
        return true;
    })();
}
function clearSimulatorCallLogs(agentId) {
    const conn = getDb();
    conn.transaction(() => {
        const rows = (agentId
            ? conn.prepare('SELECT recording_file FROM simulator_calls WHERE agent_id = ?').all(agentId)
            : conn.prepare('SELECT recording_file FROM simulator_calls').all());
        for (const row of rows)
            (0, simulator_recordings_1.removeSimulatorRecording)(row.recording_file);
        if (agentId)
            conn.prepare('DELETE FROM simulator_calls WHERE agent_id = ?').run(agentId);
        else
            conn.prepare('DELETE FROM simulator_calls').run();
    })();
}
function saveBridgeCallLog(record) {
    const conn = getDb();
    conn
        .prepare(`INSERT OR REPLACE INTO bridge_calls (
        id, transport, exten, caller_code, lead_id, phone,
        campaign_id, vici_campaign, agent_id, agent_name, greeting_id, remote_agent_user,
        started_at, ended_at, duration_ms, turns, avg_ttfb_ms,
        disposition, transferred_to, dnc_added,
        recording_file, recording_bytes,
        transcript_json, functions_json, vici_api_audit_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(record.id, record.transport, record.exten, record.callerCode, record.leadId, record.phone, record.campaignId, record.viciCampaign, record.agentId, record.agentName, record.greetingId || null, record.remoteAgentUser, record.startedAt, record.endedAt, record.durationMs, record.turns, record.avgTtfbMs, record.disposition, record.transferredTo, record.dncAdded ? 1 : 0, record.recordingFile || null, record.recordingBytes || 0, JSON.stringify(record.transcript), JSON.stringify(record.functionCalls), JSON.stringify(record.viciApiAudit));
    conn.prepare(`
    DELETE FROM bridge_calls
    WHERE id NOT IN (SELECT id FROM bridge_calls ORDER BY started_at DESC LIMIT 200)
  `).run();
}
function listBridgeCallLogs(limit = 25) {
    const conn = getDb();
    const rows = conn
        .prepare('SELECT * FROM bridge_calls ORDER BY started_at DESC LIMIT ?')
        .all(limit);
    return rows.map((r) => ({
        id: r.id,
        transport: r.transport,
        exten: r.exten,
        callerCode: r.caller_code,
        leadId: r.lead_id,
        phone: r.phone,
        campaignId: r.campaign_id,
        viciCampaign: r.vici_campaign,
        agentId: r.agent_id,
        agentName: r.agent_name,
        greetingId: r.greeting_id || null,
        remoteAgentUser: r.remote_agent_user,
        startedAt: r.started_at,
        endedAt: r.ended_at,
        durationMs: r.duration_ms,
        turns: r.turns,
        avgTtfbMs: r.avg_ttfb_ms,
        disposition: r.disposition,
        transferredTo: r.transferred_to,
        dncAdded: Boolean(r.dnc_added),
        recordingFile: r.recording_file || null,
        recordingBytes: Number(r.recording_bytes || 0),
        transcript: JSON.parse(r.transcript_json || '[]'),
        functionCalls: JSON.parse(r.functions_json || '[]'),
        viciApiAudit: JSON.parse(r.vici_api_audit_json || '[]'),
    }));
}
function clearBridgeCallLogs() {
    const conn = getDb();
    conn.prepare('DELETE FROM bridge_calls').run();
    (0, call_recorder_1.clearAllRecordings)();
}
function getBridgeAnalyticsSummary() {
    const logs = listBridgeCallLogs(200);
    const simLogs = listSimulatorCallLogs(undefined, 100);
    const totalCalls = logs.length;
    const xferCount = logs.filter((l) => Boolean(l.transferredTo)).length;
    const dncCount = logs.filter((l) => l.dncAdded || l.disposition === 'DNC' || l.disposition === 'DNCL').length;
    const recordedCount = logs.filter((l) => Boolean(l.recordingFile)).length;
    const ttfbList = logs
        .map((l) => l.avgTtfbMs)
        .filter((v) => typeof v === 'number' && Number.isFinite(v) && v > 0)
        .sort((a, b) => a - b);
    const avgTtfbMs = ttfbList.length
        ? Math.round(ttfbList.reduce((a, b) => a + b, 0) / ttfbList.length)
        : null;
    const p95TtfbMs = ttfbList.length
        ? ttfbList[Math.min(ttfbList.length - 1, Math.floor(ttfbList.length * 0.95))]
        : null;
    const avgDurationSec = totalCalls
        ? Number((logs.reduce((s, l) => s + (l.durationMs || 0), 0) / totalCalls / 1000).toFixed(1))
        : 0;
    const dispositions = {};
    const byTransport = { sip_rtp: 0, audiosocket: 0 };
    const byCampaign = {};
    for (const l of logs) {
        const d = l.disposition || 'UNSET';
        dispositions[d] = (dispositions[d] || 0) + 1;
        byTransport[l.transport] = (byTransport[l.transport] || 0) + 1;
        const cKey = l.viciCampaign || 'UNASSIGNED';
        if (!byCampaign[cKey]) {
            byCampaign[cKey] = { campaign: cKey, total: 0, transfers: 0, dncs: 0, avgDurationSec: 0 };
        }
        byCampaign[cKey].total += 1;
        if (l.transferredTo)
            byCampaign[cKey].transfers += 1;
        if (l.dncAdded || l.disposition === 'DNC')
            byCampaign[cKey].dncs += 1;
        byCampaign[cKey].avgDurationSec += (l.durationMs || 0) / 1000;
    }
    for (const c of Object.values(byCampaign)) {
        c.avgDurationSec = c.total ? Number((c.avgDurationSec / c.total).toFixed(1)) : 0;
    }
    return {
        // Counts and rates cover retained logs only, not lifetime call volume.
        retentionLimits: { bridgeCalls: 200, simulatorCalls: 100 },
        totalBridgeCalls: totalCalls,
        totalSimulatorCalls: simLogs.length,
        transfersCount: xferCount,
        transferRatePct: totalCalls ? Number(((xferCount / totalCalls) * 100).toFixed(1)) : 0,
        dncCount,
        dncRatePct: totalCalls ? Number(((dncCount / totalCalls) * 100).toFixed(1)) : 0,
        recordedCount,
        avgTtfbMs,
        p95TtfbMs,
        avgDurationSec,
        dispositions,
        byTransport,
        campaigns: Object.values(byCampaign),
    };
}
function csvCell(val) {
    const s = val === null || val === undefined ? '' : String(val);
    if (/[",\r\n]/.test(s)) {
        return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
}
function exportBridgeLogsCsv(limit = 200) {
    const logs = listBridgeCallLogs(limit);
    const headers = [
        'call_id',
        'started_at',
        'ended_at',
        'duration_sec',
        'transport',
        'vici_campaign',
        'exten',
        'caller_code',
        'lead_id',
        'phone',
        'agent_name',
        'greeting_id',
        'remote_agent_user',
        'turns',
        'avg_ttfb_ms',
        'disposition',
        'transferred_to',
        'dnc_added',
        'recording_file',
        'vici_api_calls',
        'transcript_summary',
    ];
    const rows = [headers.join(',')];
    for (const l of logs) {
        const transcriptSummary = (l.transcript || [])
            .filter((t) => t.role !== 'system')
            .map((t) => `${t.role}: ${t.content}`)
            .join(' | ');
        const apiSummary = (l.viciApiAudit || []).map((a) => `${a.fn}:${a.ok ? 'OK' : 'ERR'}`).join(';');
        rows.push([
            l.id,
            l.startedAt,
            l.endedAt,
            ((l.durationMs || 0) / 1000).toFixed(1),
            l.transport,
            l.viciCampaign || '',
            l.exten,
            l.callerCode,
            l.leadId || '',
            l.phone,
            l.agentName,
            l.greetingId || '',
            l.remoteAgentUser,
            l.turns,
            l.avgTtfbMs ?? '',
            l.disposition || '',
            l.transferredTo || '',
            l.dncAdded ? 'YES' : 'NO',
            l.recordingFile || '',
            apiSummary,
            transcriptSummary,
        ]
            .map(csvCell)
            .join(','));
    }
    return rows.join('\r\n') + '\r\n';
}
