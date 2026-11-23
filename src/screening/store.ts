// Screening tables: the on/off switch, one result row per call (also the
// idempotency key for dispositions), and saved verification runs.
import { getDb } from '../db';
import { ScreeningDecision, ScreeningOutcome } from './types';

let ready = false;
function db() {
  const d = getDb();
  if (!ready) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS screening_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        enabled INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS screening_results (
        call_id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        lead_id TEXT NOT NULL DEFAULT '',
        caller_code TEXT NOT NULL DEFAULT '',
        phone_tail TEXT NOT NULL DEFAULT '',
        outcome TEXT NOT NULL,
        reason TEXT NOT NULL,
        native_amd TEXT NOT NULL DEFAULT 'NONE',
        decided_ms INTEGER NOT NULL,
        evidence TEXT NOT NULL DEFAULT '{}',
        disposition TEXT NOT NULL DEFAULT '',
        disposition_state TEXT NOT NULL DEFAULT 'none',
        disposition_attempts INTEGER NOT NULL DEFAULT 0,
        disposition_detail TEXT NOT NULL DEFAULT '',
        verified_lead_status TEXT NOT NULL DEFAULT '',
        verified_call_status TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_screening_results_created ON screening_results(created_at);
      CREATE TABLE IF NOT EXISTS screening_test_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ran_at TEXT NOT NULL,
        ran_by TEXT NOT NULL DEFAULT '',
        passed INTEGER NOT NULL,
        failed INTEGER NOT NULL,
        warnings INTEGER NOT NULL DEFAULT 0,
        report TEXT NOT NULL
      );
    `);
    ready = true;
  }
  return d;
}

/** Resets the cached "tables exist" flag (tests reopen the database). */
export function resetScreeningStoreForTests(): void { ready = false; }

export function isScreeningEnabled(): boolean {
  try {
    const row = db().prepare('SELECT enabled FROM screening_settings WHERE id = 1').get() as { enabled: number } | undefined;
    return Boolean(row?.enabled);
  } catch {
    return false;
  }
}

export function setScreeningEnabled(enabled: boolean, by: string): void {
  const now = new Date().toISOString();
  db().prepare(`INSERT INTO screening_settings (id, enabled, updated_at, updated_by) VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
    .run(enabled ? 1 : 0, now, by.slice(0, 120));
}

export function screeningSettingsRow(): { enabled: boolean; updatedAt: string; updatedBy: string } {
  const row = db().prepare('SELECT enabled, updated_at, updated_by FROM screening_settings WHERE id = 1').get() as any;
  return { enabled: Boolean(row?.enabled), updatedAt: row?.updated_at || '', updatedBy: row?.updated_by || '' };
}

export const CALL_ID_RE = /^vici_[a-z0-9]{4,16}_[0-9a-f]{8}$/i;
export const CAMPAIGN_ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
export const STATUS_CODE_RE = /^[A-Z0-9]{1,6}$/;

export interface ResultInput {
  callId: string;
  campaignId: string;
  leadId: string;
  callerCode: string;
  phone: string;
  nativeAmd: string;
  decision: ScreeningDecision;
  disposition: string;
}

/** Records the decision once. Returns false if the call already has a result (duplicate event). */
export function recordScreeningResult(r: ResultInput): boolean {
  if (!CALL_ID_RE.test(r.callId)) throw new Error('Invalid call ID');
  if (!CAMPAIGN_ID_RE.test(r.campaignId)) throw new Error('Invalid campaign ID');
  if (r.disposition && !STATUS_CODE_RE.test(r.disposition)) throw new Error('Invalid disposition code');
  const now = new Date().toISOString();
  const res = db().prepare(`INSERT OR IGNORE INTO screening_results
    (call_id, campaign_id, lead_id, caller_code, phone_tail, outcome, reason, native_amd, decided_ms, evidence, disposition, disposition_state, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    r.callId, r.campaignId, String(r.leadId || '').replace(/\D/g, '').slice(0, 20), String(r.callerCode || '').slice(0, 40),
    String(r.phone || '').replace(/\D/g, '').slice(-4), r.decision.outcome, r.decision.reason.slice(0, 300), r.nativeAmd,
    Math.round(r.decision.decidedAtMs), JSON.stringify(r.decision.evidence).slice(0, 4000), r.disposition,
    r.disposition ? 'pending' : 'none', now, now,
  ) as { changes?: number };
  return Number(res?.changes || 0) === 1;
}

/** Atomically claims the right to send the disposition. Only one caller ever gets true. */
export function claimDisposition(callId: string): boolean {
  const res = db().prepare(`UPDATE screening_results SET disposition_state = 'sending', disposition_attempts = disposition_attempts + 1, updated_at = ?
    WHERE call_id = ? AND disposition_state = 'pending'`).run(new Date().toISOString(), callId) as { changes?: number };
  return Number(res?.changes || 0) === 1;
}

export function updateDispositionState(callId: string, state: 'sent' | 'failed' | 'verified' | 'mismatch' | 'unverifiable', detail: string, verified?: { lead?: string; call?: string }): void {
  db().prepare(`UPDATE screening_results SET disposition_state = ?, disposition_detail = ?, verified_lead_status = COALESCE(?, verified_lead_status),
    verified_call_status = COALESCE(?, verified_call_status), updated_at = ? WHERE call_id = ?`)
    .run(state, detail.slice(0, 500), verified?.lead ?? null, verified?.call ?? null, new Date().toISOString(), callId);
}

export function getScreeningResult(callId: string): any {
  return db().prepare('SELECT * FROM screening_results WHERE call_id = ?').get(callId) || null;
}

export function recentScreeningResults(limit = 50): any[] {
  return db().prepare('SELECT call_id, campaign_id, lead_id, phone_tail, outcome, reason, native_amd, decided_ms, disposition, disposition_state, verified_lead_status, verified_call_status, created_at FROM screening_results ORDER BY created_at DESC LIMIT ?').all(Math.max(1, Math.min(500, limit)));
}

export function screeningCounts(sinceIso: string): Record<ScreeningOutcome | 'total', number> {
  const rows = db().prepare('SELECT outcome, COUNT(*) AS n FROM screening_results WHERE created_at >= ? GROUP BY outcome').all(sinceIso) as Array<{ outcome: ScreeningOutcome; n: number }>;
  const out: any = { total: 0, HUMAN_CONFIRMED: 0, VOICEMAIL: 0, IVR: 0, PRERECORDED_AUDIO: 0, KNOWN_TEST_ENDPOINT: 0, UNCERTAIN: 0 };
  for (const r of rows) { out[r.outcome] = Number(r.n); out.total += Number(r.n); }
  return out;
}

export function dispositionStateCounts(sinceIso: string): Record<string, number> {
  const rows = db().prepare("SELECT disposition_state AS s, COUNT(*) AS n FROM screening_results WHERE created_at >= ? AND disposition <> '' GROUP BY disposition_state").all(sinceIso) as Array<{ s: string; n: number }>;
  const out: Record<string, number> = {};
  for (const r of rows) out[r.s] = Number(r.n);
  return out;
}

export function saveTestRun(by: string, passed: number, failed: number, warnings: number, report: unknown): number {
  const res = db().prepare('INSERT INTO screening_test_runs (ran_at, ran_by, passed, failed, warnings, report) VALUES (?, ?, ?, ?, ?, ?)')
    .run(new Date().toISOString(), by.slice(0, 120), passed, failed, warnings, JSON.stringify(report).slice(0, 200000)) as { lastInsertRowid?: number | bigint };
  return Number(res?.lastInsertRowid || 0);
}

export function lastTestRun(): { ranAt: string; ranBy: string; passed: number; failed: number; warnings: number; report: any } | null {
  const row = db().prepare('SELECT * FROM screening_test_runs ORDER BY id DESC LIMIT 1').get() as any;
  if (!row) return null;
  let report: any = null;
  try { report = JSON.parse(row.report); } catch {}
  return { ranAt: row.ran_at, ranBy: row.ran_by, passed: row.passed, failed: row.failed, warnings: row.warnings, report };
}
