"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.trackAgentConnection = trackAgentConnection;
exports.readLedger = readLedger;
exports.openConnections = openConnections;
exports.buildUsageReport = buildUsageReport;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const data_paths_1 = require("./data-paths");
const FILE_NAME = 'usage-ledger.jsonl';
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const open = new Map();
let nextId = 1;
function filePath() {
    return path_1.default.join(data_paths_1.DATA_DIR, FILE_NAME);
}
function append(record) {
    try {
        fs_1.default.mkdirSync(data_paths_1.DATA_DIR, { recursive: true });
        const file = filePath();
        try {
            // Keep the newest half when the file gets large, so it cannot grow without bound.
            if (fs_1.default.statSync(file).size > MAX_FILE_BYTES) {
                const lines = fs_1.default.readFileSync(file, 'utf8').split('\n').filter(Boolean);
                fs_1.default.writeFileSync(file, `${lines.slice(Math.floor(lines.length / 2)).join('\n')}\n`, { mode: 0o600 });
            }
        }
        catch {
            // No file yet.
        }
        fs_1.default.appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    }
    catch {
        // Usage tracking must never break a call.
    }
}
/** Start timing a Deepgram connection. Counts from the moment the socket opens until it closes. */
function trackAgentConnection(ws, source, ref) {
    const id = nextId++;
    let counted = false;
    const start = () => {
        if (counted)
            return;
        counted = true;
        open.set(id, { source, ref, openedAtMs: Date.now() });
    };
    if (ws.readyState === 1)
        start();
    ws.on('open', start);
    ws.on('close', (code) => {
        const conn = open.get(id);
        if (!conn)
            return;
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
function readLedger() {
    try {
        return fs_1.default
            .readFileSync(filePath(), 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => {
            try {
                return JSON.parse(line);
            }
            catch {
                return null;
            }
        })
            .filter((r) => !!r && typeof r.ms === 'number' && typeof r.openedAt === 'string');
    }
    catch {
        return [];
    }
}
function openConnections(now = Date.now()) {
    return Array.from(open.values()).map((c) => ({
        source: c.source,
        ref: c.ref,
        openedAt: new Date(c.openedAtMs).toISOString(),
        ms: now - c.openedAtMs,
    }));
}
function buildUsageReport(records, open_ = openConnections(), dayCount = 7) {
    const byDay = new Map();
    for (const r of records) {
        const day = r.openedAt.slice(0, 10);
        const list = byDay.get(day) || [];
        list.push(r);
        byDay.set(day, list);
    }
    const hours = (ms) => Number((ms / 3600000).toFixed(2));
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
