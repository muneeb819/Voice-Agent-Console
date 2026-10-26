import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { clearAllRecordings } from './call-recorder';
import { ConsoleState } from './types';
import { createDefaultState, normalizeState } from './defaults';
import { diffStates } from './settings-builder';

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'console.sqlite');
const JSON_MIRROR_PATH = path.join(DATA_DIR, 'console-state.json');

export interface SimulatorCallLogRecord {
  id: string;
  agentId: string;
  agentName: string;
  campaignId: string | null;
  upstreamMode: 'deepgram' | 'sandbox';
  sampleRateIn: number;
  sampleRateOut: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  turns: number;
  avgTtfbMs: number | null;
  disposition: string | null;
  transferredTo: string | null;
  transcript: Array<{ ts: string; role: 'user' | 'assistant' | 'system'; content: string }>;
  functionCalls: Array<{
    ts: string;
    id: string;
    name: string;
    args: Record<string, any>;
    status: 'completed' | 'cancelled' | 'server_side';
    response?: Record<string, any>;
  }>;
}

export interface BridgeCallLogRecord {
  id: string;
  transport: 'audiosocket' | 'sip_rtp';
  exten: string;
  callerCode: string;
  leadId: string | null;
  phone: string;
  campaignId: string | null;
  viciCampaign: string | null;
  agentId: string;
  agentName: string;
  remoteAgentUser: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  turns: number;
  avgTtfbMs: number | null;
  disposition: string | null;
  transferredTo: string | null;
  dncAdded: boolean;
  recordingFile?: string | null;
  recordingBytes?: number | null;
  transcript: Array<{ ts: string; role: 'user' | 'assistant' | 'system'; content: string }>;
  functionCalls: Array<{
    ts: string;
    id: string;
    name: string;
    args: Record<string, any>;
    status: string;
    response?: Record<string, any>;
  }>;
  viciApiAudit: Array<{
    ts: string;
    api: string;
    fn: string;
    urlOrAction: string;
    ok: boolean;
    responseText: string;
  }>;
}

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
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
    CREATE TABLE IF NOT EXISTS simulator_calls (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      campaign_id TEXT,
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

  // Safe Step 4 schema migration for existing SQLite databases
  const bridgeCols = db.pragma('table_info(bridge_calls)') as Array<{ name: string }>;
  const colNames = new Set(bridgeCols.map((c) => c.name));
  if (!colNames.has('recording_file')) {
    db.exec('ALTER TABLE bridge_calls ADD COLUMN recording_file TEXT');
  }
  if (!colNames.has('recording_bytes')) {
    db.exec('ALTER TABLE bridge_calls ADD COLUMN recording_bytes INTEGER NOT NULL DEFAULT 0');
  }

  return db;
}

function writeJsonMirror(state: ConsoleState): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmpPath = `${JSON_MIRROR_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmpPath, JSON_MIRROR_PATH);
}

export function getConsoleState(): ConsoleState {
  const conn = getDb();
  const row = conn.prepare('SELECT value FROM console_store WHERE key = ?').get('active_state') as
    | { value: string }
    | undefined;

  if (row?.value) {
    try {
      return normalizeState(JSON.parse(row.value));
    } catch {
      // Fallback below
    }
  }

  if (fs.existsSync(JSON_MIRROR_PATH)) {
    try {
      const mirrored = normalizeState(JSON.parse(fs.readFileSync(JSON_MIRROR_PATH, 'utf8')));
      saveConsoleState(mirrored, 'Restored from JSON mirror');
      return mirrored;
    } catch {
      // Fallback to default
    }
  }

  const initial = createDefaultState();
  saveConsoleState(initial, 'Initial default state created');
  return initial;
}

export function saveConsoleState(
  rawState: unknown,
  explicitSummary?: string
): { state: ConsoleState; changes: string[]; revisionId: number } {
  const conn = getDb();
  const prevRow = conn.prepare('SELECT value FROM console_store WHERE key = ?').get('active_state') as
    | { value: string }
    | undefined;
  const prevState = prevRow?.value ? normalizeState(JSON.parse(prevRow.value)) : null;

  const nextState = normalizeState(rawState);
  nextState.updatedAt = new Date().toISOString();

  const changes = prevState ? diffStates(prevState, nextState) : ['Initial console configuration created'];
  const summary = explicitSummary || (changes.length ? changes.join('; ') : 'Saved with verification check');
  const serialized = JSON.stringify(nextState);

  const tx = conn.transaction(() => {
    conn
      .prepare(
        `INSERT INTO console_store (key, value, updated_at)
         VALUES ('active_state', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
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

export function listRevisions(limit = 15): Array<{ id: number; saved_at: string; summary: string }> {
  const conn = getDb();
  return conn
    .prepare('SELECT id, saved_at, summary FROM state_revisions ORDER BY id DESC LIMIT ?')
    .all(limit) as Array<{ id: number; saved_at: string; summary: string }>;
}

export function saveSimulatorCallLog(record: SimulatorCallLogRecord): void {
  const conn = getDb();
  conn
    .prepare(
      `INSERT OR REPLACE INTO simulator_calls (
        id, agent_id, agent_name, campaign_id, upstream_mode,
        sample_rate_in, sample_rate_out, started_at, ended_at,
        duration_ms, turns, avg_ttfb_ms, disposition, transferred_to,
        transcript_json, functions_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      record.id,
      record.agentId,
      record.agentName,
      record.campaignId,
      record.upstreamMode,
      record.sampleRateIn,
      record.sampleRateOut,
      record.startedAt,
      record.endedAt,
      record.durationMs,
      record.turns,
      record.avgTtfbMs,
      record.disposition,
      record.transferredTo,
      JSON.stringify(record.transcript),
      JSON.stringify(record.functionCalls)
    );

  conn.prepare(`
    DELETE FROM simulator_calls
    WHERE id NOT IN (SELECT id FROM simulator_calls ORDER BY started_at DESC LIMIT 100)
  `).run();
}

export function listSimulatorCallLogs(agentId?: string, limit = 20): SimulatorCallLogRecord[] {
  const conn = getDb();
  const rows = (
    agentId
      ? conn
          .prepare('SELECT * FROM simulator_calls WHERE agent_id = ? ORDER BY started_at DESC LIMIT ?')
          .all(agentId, limit)
      : conn.prepare('SELECT * FROM simulator_calls ORDER BY started_at DESC LIMIT ?').all(limit)
  ) as any[];

  return rows.map((r) => ({
    id: r.id,
    agentId: r.agent_id,
    agentName: r.agent_name,
    campaignId: r.campaign_id,
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
    transcript: JSON.parse(r.transcript_json || '[]'),
    functionCalls: JSON.parse(r.functions_json || '[]'),
  }));
}

export function clearSimulatorCallLogs(agentId?: string): void {
  const conn = getDb();
  if (agentId) {
    conn.prepare('DELETE FROM simulator_calls WHERE agent_id = ?').run(agentId);
  } else {
    conn.prepare('DELETE FROM simulator_calls').run();
  }
}

export function saveBridgeCallLog(record: BridgeCallLogRecord): void {
  const conn = getDb();
  conn
    .prepare(
      `INSERT OR REPLACE INTO bridge_calls (
        id, transport, exten, caller_code, lead_id, phone,
        campaign_id, vici_campaign, agent_id, agent_name, remote_agent_user,
        started_at, ended_at, duration_ms, turns, avg_ttfb_ms,
        disposition, transferred_to, dnc_added,
        recording_file, recording_bytes,
        transcript_json, functions_json, vici_api_audit_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      record.id,
      record.transport,
      record.exten,
      record.callerCode,
      record.leadId,
      record.phone,
      record.campaignId,
      record.viciCampaign,
      record.agentId,
      record.agentName,
      record.remoteAgentUser,
      record.startedAt,
      record.endedAt,
      record.durationMs,
      record.turns,
      record.avgTtfbMs,
      record.disposition,
      record.transferredTo,
      record.dncAdded ? 1 : 0,
      record.recordingFile || null,
      record.recordingBytes || 0,
      JSON.stringify(record.transcript),
      JSON.stringify(record.functionCalls),
      JSON.stringify(record.viciApiAudit)
    );

  conn.prepare(`
    DELETE FROM bridge_calls
    WHERE id NOT IN (SELECT id FROM bridge_calls ORDER BY started_at DESC LIMIT 200)
  `).run();
}

export function listBridgeCallLogs(limit = 25): BridgeCallLogRecord[] {
  const conn = getDb();
  const rows = conn
    .prepare('SELECT * FROM bridge_calls ORDER BY started_at DESC LIMIT ?')
    .all(limit) as any[];

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

export function clearBridgeCallLogs(): void {
  const conn = getDb();
  conn.prepare('DELETE FROM bridge_calls').run();
  clearAllRecordings();
}

export function getBridgeAnalyticsSummary() {
  const logs = listBridgeCallLogs(200);
  const simLogs = listSimulatorCallLogs(undefined, 100);

  const totalCalls = logs.length;
  const xferCount = logs.filter((l) => Boolean(l.transferredTo)).length;
  const dncCount = logs.filter((l) => l.dncAdded || l.disposition === 'DNC' || l.disposition === 'DNCL').length;
  const recordedCount = logs.filter((l) => Boolean(l.recordingFile)).length;

  const ttfbList = logs
    .map((l) => l.avgTtfbMs)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0)
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

  const dispositions: Record<string, number> = {};
  const byTransport: Record<string, number> = { sip_rtp: 0, audiosocket: 0 };
  const byCampaign: Record<
    string,
    { campaign: string; total: number; transfers: number; dncs: number; avgDurationSec: number }
  > = {};

  for (const l of logs) {
    const d = l.disposition || 'UNSET';
    dispositions[d] = (dispositions[d] || 0) + 1;
    byTransport[l.transport] = (byTransport[l.transport] || 0) + 1;

    const cKey = l.viciCampaign || 'UNASSIGNED';
    if (!byCampaign[cKey]) {
      byCampaign[cKey] = { campaign: cKey, total: 0, transfers: 0, dncs: 0, avgDurationSec: 0 };
    }
    byCampaign[cKey].total += 1;
    if (l.transferredTo) byCampaign[cKey].transfers += 1;
    if (l.dncAdded || l.disposition === 'DNC') byCampaign[cKey].dncs += 1;
    byCampaign[cKey].avgDurationSec += (l.durationMs || 0) / 1000;
  }

  for (const c of Object.values(byCampaign)) {
    c.avgDurationSec = c.total ? Number((c.avgDurationSec / c.total).toFixed(1)) : 0;
  }

  return {
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

function csvCell(val: unknown): string {
  const s = val === null || val === undefined ? '' : String(val);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function exportBridgeLogsCsv(limit = 200): string {
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
    rows.push(
      [
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
        .join(',')
    );
  }
  return rows.join('\r\n') + '\r\n';
}
