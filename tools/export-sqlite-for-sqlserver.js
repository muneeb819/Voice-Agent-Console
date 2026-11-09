#!/usr/bin/env node
'use strict';

/**
 * Read-only SQLite export for the VAC SQL Server migration.
 * Usage: node tools/export-sqlite-for-sqlserver.js [sqlite-path] [output-dir]
 * Uses Node 22.5+ node:sqlite. Output is sensitive and must be protected.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const dbPath = path.resolve(process.argv[2] || path.join(process.cwd(), 'data', 'console.sqlite'));
const outDir = path.resolve(process.argv[3] || path.join(process.cwd(), 'data', 'sqlserver-export'));
const tables = [
  'console_store', 'state_revisions', 'users', 'user_sessions',
  'revoked_admin_sessions', 'greeting_library', 'greeting_rotation_used',
  'greeting_rotation_state', 'simulator_calls', 'bridge_calls'
];

if (!fs.existsSync(dbPath)) {
  console.error('SQLite database not found:', dbPath);
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
try { fs.chmodSync(outDir, 0o700); } catch {}
const db = new DatabaseSync(dbPath, { readOnly: true });
const report = { source: path.basename(dbPath), exportedAt: new Date().toISOString(), tables: {} };

try {
  const available = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
  for (const table of tables) {
    if (!available.has(table)) {
      report.tables[table] = { present: false, rows: 0 };
      continue;
    }
    const rows = db.prepare('SELECT * FROM "' + table + '"').all();
    const json = JSON.stringify(rows, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2);
    const file = table + '.json';
    fs.writeFileSync(path.join(outDir, file), json + '\n', { mode: 0o600, flag: 'w' });
    report.tables[table] = {
      present: true, rows: rows.length, file,
      sha256: crypto.createHash('sha256').update(json).digest('hex')
    };
  }
  // Also export the active state as a standalone source for relational projection.
  const stateRow = available.has('console_store')
    ? db.prepare("SELECT value, updated_at FROM console_store WHERE key='active_state'").get()
    : null;
  if (stateRow && stateRow.value) {
    fs.writeFileSync(path.join(outDir, 'active_state.json'), stateRow.value + '\n', { mode: 0o600 });
    report.activeState = {
      present: true, updatedAt: stateRow.updated_at,
      sha256: crypto.createHash('sha256').update(stateRow.value).digest('hex')
    };
  } else report.activeState = { present: false };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
} finally {
  db.close();
}
