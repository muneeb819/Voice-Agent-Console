import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './data-paths';

/**
 * Alert center: problems that need a person to look, kept in a small persisted
 * list. A repeat of the same problem inside the dedup window raises the count
 * on the existing alert instead of adding a new row, so one outage cannot bury
 * the list.
 */

export type AlertKind =
  | 'transfer_failed'
  | 'llm_overload'
  | 'provider_error'
  | 'missing_key'
  | 'call_rejected'
  | 'bridge_error';

export type AlertSeverity = 'critical' | 'warning';

export interface AlertRecord {
  id: string;
  kind: AlertKind;
  severity: AlertSeverity;
  title: string;
  detail: string;
  /** Same key inside the dedup window means the same problem happening again. */
  key: string;
  count: number;
  firstAt: string;
  lastAt: string;
  acknowledged: boolean;
}

export interface RaiseInput {
  kind: AlertKind;
  severity?: AlertSeverity;
  title: string;
  detail?: string;
  key?: string;
}

const FILE_NAME = 'alerts.json';
const MAX_ALERTS = 100;
export const DEDUP_WINDOW_MS = 10 * 60 * 1000;

let cache: AlertRecord[] | null = null;
let cacheFor = '';

function filePath(): string {
  return path.join(DATA_DIR, FILE_NAME);
}

function load(): AlertRecord[] {
  const file = filePath();
  if (cache && cacheFor === file) return cache;
  let list: AlertRecord[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(parsed)) list = parsed.filter((a) => a && typeof a.id === 'string' && typeof a.title === 'string');
  } catch {
    // No file yet.
  }
  cache = list;
  cacheFor = file;
  return list;
}

function save(list: AlertRecord[]): void {
  cache = list;
  cacheFor = filePath();
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${filePath()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list), { mode: 0o600 });
    fs.renameSync(tmp, filePath());
  } catch {
    // An alert must never break a call.
  }
}

/** Credentials and long bodies do not belong in an alert shown to every operator. */
export function cleanAlertText(text: string, max = 300): string {
  return String(text ?? '')
    // "Authorization: Token abc..." / "Bearer abc...": hide the credential that follows the scheme word.
    .replace(/\b(token|bearer|basic)\s+[A-Za-z0-9._~+\/=-]{8,}/gi, '$1 [hidden]')
    .replace(/(authorization|api[_-]?key|secret|password|pass|pwd)(["'\s:=]+)(?!\[hidden\])([^\s"'&,;]+)/gi, '$1$2[hidden]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, max)
    .trim();
}

export function raiseAlert(input: RaiseInput, now = Date.now()): AlertRecord {
  const list = load();
  const key = input.key || `${input.kind}:${input.title}`;
  const existing = list.find((a) => a.key === key && now - Date.parse(a.lastAt) < DEDUP_WINDOW_MS);
  const iso = new Date(now).toISOString();
  if (existing) {
    existing.count += 1;
    existing.lastAt = iso;
    existing.detail = cleanAlertText(input.detail ?? existing.detail);
    existing.acknowledged = false;
    save(list);
    return { ...existing };
  }
  const record: AlertRecord = {
    id: crypto.randomBytes(6).toString('hex'),
    kind: input.kind,
    severity: input.severity || 'warning',
    title: cleanAlertText(input.title, 120),
    detail: cleanAlertText(input.detail ?? ''),
    key,
    count: 1,
    firstAt: iso,
    lastAt: iso,
    acknowledged: false,
  };
  list.unshift(record);
  save(list.slice(0, MAX_ALERTS));
  return { ...record };
}

export function listAlerts(): { alerts: AlertRecord[]; unacknowledged: number } {
  const list = load().map((a) => ({ ...a }));
  return { alerts: list, unacknowledged: list.filter((a) => !a.acknowledged).length };
}

/** Marks one alert, or all of them, as seen. Returns how many changed. */
export function acknowledgeAlerts(id?: string): number {
  const list = load();
  let changed = 0;
  for (const a of list) {
    if ((!id || a.id === id) && !a.acknowledged) {
      a.acknowledged = true;
      changed += 1;
    }
  }
  if (changed) save(list);
  return changed;
}

/**
 * Sorts an error from the speech/AI provider into "overloaded, try again" or a
 * plain provider error, so overload shows up as its own alert.
 */
export function classifyProviderError(text: string): 'llm_overload' | 'provider_error' {
  const t = String(text || '').toLowerCase();
  if (/rate.?limit|too many requests|\b429\b|overload|capacity|\b503\b|temporarily unavailable|quota|throttl|busy/.test(t)) {
    return 'llm_overload';
  }
  return 'provider_error';
}
