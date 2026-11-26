import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../src/data-paths';
import { acknowledgeAlerts, classifyProviderError, cleanAlertText, DEDUP_WINDOW_MS, listAlerts, raiseAlert } from '../src/alerts';

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function run() {
  assert(listAlerts().alerts.length === 0 && listAlerts().unacknowledged === 0, 'starts with no alerts');

  // A new problem becomes one alert.
  const t0 = Date.parse('2026-11-26T08:00:00.000Z');
  const first = raiseAlert({ kind: 'transfer_failed', severity: 'critical', title: 'Transfer to 8200 failed', detail: 'AMI unreachable', key: 'k1' }, t0);
  assert(first.count === 1 && !first.acknowledged && first.severity === 'critical', 'new alert is unread with count 1');
  assert(listAlerts().unacknowledged === 1, 'unread count is shown');

  // The same problem inside the window raises the count, not a new row.
  const again = raiseAlert({ kind: 'transfer_failed', title: 'Transfer to 8200 failed', detail: 'REFER timed out', key: 'k1' }, t0 + 60_000);
  assert(again.id === first.id && again.count === 2, 'repeat inside the window raises the count');
  assert(listAlerts().alerts.length === 1 && listAlerts().alerts[0].detail === 'REFER timed out', 'one row, latest detail kept');

  // Acknowledged alert comes back as unread when the problem repeats.
  assert(acknowledgeAlerts(first.id) === 1 && listAlerts().unacknowledged === 0, 'acknowledge marks it read');
  raiseAlert({ kind: 'transfer_failed', title: 'Transfer to 8200 failed', key: 'k1' }, t0 + 120_000);
  assert(listAlerts().unacknowledged === 1, 'a repeat after acknowledging is unread again');

  // After the window the same problem is a new alert.
  const later = raiseAlert({ kind: 'transfer_failed', title: 'Transfer to 8200 failed', key: 'k1' }, t0 + DEDUP_WINDOW_MS + 300_000);
  assert(later.id !== first.id && listAlerts().alerts.length === 2, 'outside the window it is a new alert');

  // Acknowledge all.
  raiseAlert({ kind: 'bridge_error', title: 'Other problem', key: 'k2' }, t0 + DEDUP_WINDOW_MS + 400_000);
  assert(acknowledgeAlerts() === 3 && listAlerts().unacknowledged === 0, 'acknowledge all clears the unread count');
  assert(acknowledgeAlerts('does-not-exist') === 0, 'unknown id changes nothing');

  // Secrets and long text are not stored in an alert.
  const clean = cleanAlertText('Deepgram HTTP 401 Authorization: Token abc123SECRET and api_key=xyz987 \n more');
  assert(!/abc123SECRET|xyz987/.test(clean) && /\[hidden\]/.test(clean) && !/\n/.test(clean), `credentials are hidden (${clean})`);
  assert(cleanAlertText('x'.repeat(1000)).length === 300, 'detail is length limited');

  // Overload is told apart from other provider errors.
  for (const text of ['429 Too Many Requests', 'rate limit exceeded', 'HTTP 503 temporarily unavailable', 'model overloaded', 'quota exceeded']) {
    assert(classifyProviderError(text) === 'llm_overload', `overload recognised: ${text}`);
  }
  for (const text of ['invalid api key', 'HTTP 401', 'socket hang up']) {
    assert(classifyProviderError(text) === 'provider_error', `plain provider error: ${text}`);
  }

  // The list is private and capped.
  assert((fs.statSync(path.join(DATA_DIR, 'alerts.json')).mode & 0o077) === 0, 'alerts file is owner-only');
  for (let i = 0; i < 130; i += 1) raiseAlert({ kind: 'bridge_error', title: `p${i}`, key: `cap${i}` }, t0 + 10 * DEDUP_WINDOW_MS + i);
  assert(listAlerts().alerts.length === 100, 'list is capped at 100');
  assert(listAlerts().alerts[0].title === 'p129', 'newest alert is first');
  console.log('Alerts verification passed.');
}

try { run(); process.exit(0); } catch (err) { console.error(err instanceof Error ? err.message : err); process.exit(1); }
