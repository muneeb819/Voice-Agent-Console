// SQL Server mirror (AWS RDS / SSMS): T-SQL generation, change capture,
// full copies, retries, safety exclusions, the real driver path against a
// recording fake, and the HTTP API. No real SQL Server is needed.
import assert from 'node:assert/strict';
import { getDb, saveConsoleState, getConsoleState } from '../src/db';
import { countUsers } from '../src/user-store';
import { mirrorStatus, runOnce, requestFullResync, setMirrorEnabled, setTargetFactoryForTests, testMirrorConnection, updateMirrorSettings, parseMirrorSettings } from '../src/mirror';
import { discoverTables, loadBook, loadSettings, outboxStats, OUTBOX_LIMIT } from '../src/mirror/source';
import {
  createTableSql, deleteBatchSql, isValidName, kindOf, MAX_PARAMS, q, reportingViewsSql, rowsPerStatement, TableSpec, upsertBatchSql,
} from '../src/mirror/sql';
import { MirrorTarget, MssqlTarget, setSqlDriverForTests, TargetConfig } from '../src/mirror/target';

let checks = 0;
const ok = (cond: unknown, msg: string) => { assert.ok(cond, msg); checks++; };
const eq = (a: unknown, b: unknown, msg: string) => { assert.deepEqual(a, b, msg); checks++; };

// ------------------------------------------------------------ T-SQL text
function sqlUnit() {
  ok(isValidName('bridge_calls') && !isValidName('a];DROP TABLE x;--') && !isValidName('1abc') && !isValidName(''), 'identifier rule');
  assert.throws(() => q('x] ; DROP'), /Unsafe/); checks++;
  eq([kindOf('INTEGER'), kindOf('TEXT'), kindOf('REAL'), kindOf(''), kindOf('VARCHAR(10)')], ['int', 'text', 'real', 'blob', 'text'], 'SQLite affinity mapping');
  const spec: TableSpec = { name: 'bridge_calls', pk: ['id'], columns: [{ name: 'id', kind: 'text' }, { name: 'turns', kind: 'int' }, { name: 'transcript_json', kind: 'text' }] };
  const ddl = createTableSql('vac', spec);
  ok(ddl.includes("IF OBJECT_ID(N'[vac].[bridge_calls]', N'U') IS NULL"), 'create is idempotent');
  ok(ddl.includes('[id] NVARCHAR(450) NOT NULL') && ddl.includes('[transcript_json] NVARCHAR(MAX) NULL') && ddl.includes('[turns] BIGINT NULL'), 'column types');
  ok(ddl.includes('PRIMARY KEY ([id])') && ddl.includes('[_mirrored_at] DATETIME2(3) NOT NULL'), 'key and mirrored-at column');
  const composite: TableSpec = { name: 't', pk: ['a', 'b'], columns: [{ name: 'a', kind: 'text' }, { name: 'b', kind: 'text' }] };
  ok(createTableSql('vac', composite).includes('NVARCHAR(225)'), 'composite text keys stay within the 900-byte key limit');
  const up = upsertBatchSql('vac', spec, 2);
  ok(up.includes('DELETE FROM [vac].[bridge_calls] WHERE [id] = @r1_0;') && up.includes('VALUES (@r1_0, @r1_1, @r1_2, SYSUTCDATETIME())'), 'upsert uses parameters only');
  ok(deleteBatchSql('vac', composite, 1).includes('[a] = @k0_0 AND [b] = @k0_1'), 'delete by composite key');
  const wide: TableSpec = { name: 'w', pk: ['c0'], columns: Array.from({ length: 30 }, (_, i) => ({ name: `c${i}`, kind: 'text' as const })) };
  ok(rowsPerStatement(wide) * 30 <= MAX_PARAMS && rowsPerStatement(wide) >= 1, 'batches stay under the 2100-parameter limit');
  const views = reportingViewsSql('vac', discoverTables());
  ok(views.some((v) => v.name === 'v_bridge_calls' && v.sql.includes('TRY_CONVERT(DATETIME2(3), [started_at], 127)')), 'reporting view with real dates');
}

// ------------------------------------------------------------ in-memory SQL Server
class FakeTarget implements MirrorTarget {
  static tables = new Map<string, { cols: Set<string>; rows: Map<string, Record<string, unknown>> }>();
  static failNext = 0;
  static opens = 0;
  constructor(public cfg: TargetConfig) {}
  async open() { FakeTarget.opens++; if (FakeTarget.failNext) { FakeTarget.failNext--; throw new Error('connect ETIMEOUT'); } return { version: 'SQL Server 16.0 (fake)', createdDatabase: false }; }
  async ensureTable(spec: TableSpec) {
    let t = FakeTarget.tables.get(spec.name);
    if (!t) { FakeTarget.tables.set(spec.name, (t = { cols: new Set(spec.columns.map((c) => c.name)), rows: new Map() })); return false; }
    let added = false;
    for (const c of spec.columns) if (!t.cols.has(c.name)) { t.cols.add(c.name); added = true; }
    return added;
  }
  async apply(spec: TableSpec, change: { truncate?: boolean; upserts: Record<string, unknown>[]; deletes: unknown[][] }) {
    const t = FakeTarget.tables.get(spec.name)!;
    if (change.truncate) t.rows.clear();
    for (const r of change.upserts) t.rows.set(JSON.stringify(spec.pk.map((k) => r[k])), { ...r });
    for (const k of change.deletes) t.rows.delete(JSON.stringify(k));
  }
  async ensureViews() { return ['v_bridge_calls']; }
  async close() {}
}
const rowsOf = (t: string) => [...(FakeTarget.tables.get(t)?.rows.values() || [])];

function insertBridgeCall(id: string, disposition = 'SALE') {
  getDb().prepare(`INSERT INTO bridge_calls (id, transport, exten, caller_code, phone, agent_id, agent_name, remote_agent_user, started_at, ended_at, duration_ms, turns, disposition, transcript_json, functions_json, vici_api_audit_json)
    VALUES (?, 'sip_rtp', '8300', 'V1', '5550100', 'a1', 'Jessica', 'VDAD', '2026-11-23T10:00:00.000Z', '2026-11-23T10:01:00.000Z', 60000, 4, ?, '[]', '[]', '[]')`).run(id, disposition);
}

async function engine() {
  process.env.MSSQL_PASSWORD = 'test-password';
  setTargetFactoryForTests((cfg) => new FakeTarget(cfg));
  const by = 'test@example.com';
  const parsed = parseMirrorSettings({ host: 'mydb.abc123.ap-southeast-2.rds.amazonaws.com,1433', username: 'admin', database: 'VoiceAgentConsole', schema: 'vac' }, by);
  ok(parsed.settings && parsed.settings.host === 'mydb.abc123.ap-southeast-2.rds.amazonaws.com', 'SSMS-style "host,port" is accepted');
  ok(parseMirrorSettings({ host: 'bad host;--' }, by).error && parseMirrorSettings({ database: 'x]; DROP' }, by).error && parseMirrorSettings({ port: 0 }, by).error, 'unsafe settings are rejected');
  updateMirrorSettings(parsed.settings!);

  // Seed data before switching on.
  saveConsoleState(getConsoleState(), 'seed');
  insertBridgeCall('call-1');
  countUsers(); // creates the account tables
  getDb().prepare(`INSERT INTO user_sessions (token, user_id, created_at, expires_at) VALUES ('tok', 'u1', 'x', 'y')`).run();
  getDb().prepare(`INSERT OR IGNORE INTO users (id, email, full_name, password_hash, created_at) VALUES ('u1', 'a@b.c', 'Ann', 'secret-hash', '2026-11-23T00:00:00Z')`).run();

  await runOnce();
  eq(rowsOf('bridge_calls').length, 0, 'nothing is sent while the mirror is off');
  eq(outboxStats().pending, 0, 'no changes are queued while off');

  setMirrorEnabled(true, by);
  await runOnce();
  ok(rowsOf('bridge_calls').some((r) => r.id === 'call-1'), 'first full copy includes existing call logs');
  ok(rowsOf('console_store').length >= 1, 'console settings are copied');
  ok(!FakeTarget.tables.has('user_sessions') && !FakeTarget.tables.has('greeting_line_used') && !FakeTarget.tables.has('mirror_outbox'), 'sessions, internal cursors and mirror tables are never copied');
  const users = rowsOf('users');
  ok(users.length >= 1 && users.every((u) => !('password_hash' in u)), 'password hashes are never copied');
  ok(loadBook().lastFullSyncAt && mirrorStatus().tables.every((t) => t.copied), 'all tables marked copied');

  // Change capture: insert, update, delete.
  insertBridgeCall('call-2', 'NI');
  getDb().prepare(`UPDATE bridge_calls SET disposition = 'XFER' WHERE id = 'call-1'`).run();
  ok(outboxStats().pending >= 2, 'changes are queued by triggers');
  await runOnce();
  eq(rowsOf('bridge_calls').find((r) => r.id === 'call-1')?.disposition, 'XFER', 'update reaches SQL Server');
  ok(rowsOf('bridge_calls').some((r) => r.id === 'call-2'), 'insert reaches SQL Server');
  eq(outboxStats().pending, 0, 'queue is empty after sync');
  getDb().prepare(`DELETE FROM bridge_calls WHERE id = 'call-2'`).run();
  await runOnce();
  ok(!rowsOf('bridge_calls').some((r) => r.id === 'call-2'), 'delete reaches SQL Server');

  // Many changes to one row are sent once with the latest value.
  for (let i = 0; i < 50; i++) getDb().prepare(`UPDATE bridge_calls SET turns = ? WHERE id = 'call-1'`).run(i);
  await runOnce();
  eq(rowsOf('bridge_calls').find((r) => r.id === 'call-1')?.turns, 49, 'latest value wins');

  // Archive mode keeps deleted rows.
  updateMirrorSettings({ ...loadSettings(), keepDeleted: true });
  insertBridgeCall('call-3');
  await runOnce();
  getDb().prepare(`DELETE FROM bridge_calls WHERE id = 'call-3'`).run();
  await runOnce();
  ok(rowsOf('bridge_calls').some((r) => r.id === 'call-3'), 'archive mode keeps rows deleted in the console');
  updateMirrorSettings({ ...loadSettings(), keepDeleted: false });

  // A table created after the mirror started is picked up and copied.
  getDb().exec(`CREATE TABLE IF NOT EXISTS later_table (id INTEGER PRIMARY KEY, note TEXT)`);
  getDb().prepare(`INSERT INTO later_table (id, note) VALUES (1, 'hello')`).run();
  await runOnce();
  eq(rowsOf('later_table').map((r) => r.note), ['hello'], 'new tables are found and copied');

  // A new column is added in SQL Server and existing rows are re-sent with it.
  getDb().exec(`ALTER TABLE later_table ADD COLUMN extra TEXT DEFAULT 'x'`);
  getDb().prepare(`INSERT INTO later_table (id, note) VALUES (2, 'two')`).run();
  await runOnce();
  ok(FakeTarget.tables.get('later_table')!.cols.has('extra') && rowsOf('later_table').every((r) => r.extra === 'x'), 'new columns are added and back-filled');

  // SQL Server outage: changes wait in the queue, nothing is lost.
  FakeTarget.failNext = 1;
  updateMirrorSettings({ ...loadSettings(), intervalSec: 3 }); // forces a reconnect
  insertBridgeCall('call-4');
  await runOnce();
  ok(/cannot reach the RDS endpoint/.test(mirrorStatus().lastError) && mirrorStatus().phase === 'error', 'outage is reported in plain words');
  ok(outboxStats().pending >= 1, 'changes are kept while SQL Server is down');
  await runOnce();
  ok(rowsOf('bridge_calls').some((r) => r.id === 'call-4') && mirrorStatus().lastError === '', 'changes arrive after recovery');

  // New target (different server) triggers a full copy there.
  FakeTarget.tables.clear();
  updateMirrorSettings({ ...loadSettings(), database: 'OtherDb' });
  await runOnce();
  ok(rowsOf('bridge_calls').some((r) => r.id === 'call-1'), 'changing the server re-copies everything');

  // Manual full copy.
  FakeTarget.tables.get('bridge_calls')!.rows.clear();
  requestFullResync();
  await runOnce();
  ok(rowsOf('bridge_calls').some((r) => r.id === 'call-1'), '"Copy everything again" restores rows');

  // A queue that falls too far behind turns into a full copy.
  const stmt = getDb().prepare(`INSERT INTO mirror_outbox (tbl, pk, at) VALUES ('bridge_calls', '["call-1"]', '2026-01-01T00:00:00Z')`);
  getDb().transaction(() => { for (let i = 0; i <= OUTBOX_LIMIT; i++) stmt.run(); })();
  await runOnce();
  eq(outboxStats().pending, 0, 'overflowing queue is replaced by a full copy');

  // Full copy pages by key, so deleting rows mid-copy cannot skip a row.
  getDb().exec(`CREATE TABLE IF NOT EXISTS paging_table (id INTEGER PRIMARY KEY, v TEXT)`);
  const ins = getDb().prepare(`INSERT INTO paging_table (id, v) VALUES (?, 'x')`);
  getDb().transaction(() => { for (let i = 1; i <= 1200; i++) ins.run(i); })();
  const { readAllRows } = await import('../src/mirror/source');
  const pspec = discoverTables().get('paging_table')!;
  const seen: number[] = [];
  let pageNo = 0;
  for (const page of readAllRows(pspec, 500)) {
    seen.push(...page.map((r) => Number(r.id)));
    if (pageNo++ === 0) getDb().prepare('DELETE FROM paging_table WHERE id <= 100').run();
  }
  eq(seen.length, 1200, 'rows deleted during a copy do not make later rows be skipped');
  getDb().prepare(`UPDATE mirror_settings SET lease_owner = 'other-process', lease_until = ? WHERE id = 1`).run(Date.now() + 600000);
  const before = outboxStats().pending;
  await runOnce();
  ok(outboxStats().pending === before, 'a worker does nothing while another process holds the lease');
  getDb().prepare(`UPDATE mirror_settings SET lease_until = 0 WHERE id = 1`).run();
  await runOnce();
  eq(outboxStats().pending, 0, 'the lease is taken back once it expires');

  // Off: triggers and queue removed; changes are not tracked.
  setMirrorEnabled(false, by);
  const triggers = getDb().prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'mirror_%'`).get() as { n: number };
  eq(Number(triggers.n), 0, 'turning off removes the change triggers');
  insertBridgeCall('call-5');
  eq(outboxStats().pending, 0, 'nothing is queued while off');
  ok(!loadBook().syncedTables.length, 'next start will copy everything again');
  FakeTarget.failNext = 0;
  const t = await testMirrorConnection(loadSettings());
  ok(t.ok && t.version?.includes('fake'), 'connection test reports the server version');
  setTargetFactoryForTests(null);
}

// ------------------------------------------------------------ real driver path, recorded
async function driver() {
  const log: string[] = [];
  let paramsMax = 0;
  let commits = 0;
  let rollbacks = 0;
  let attempt = 0;
  const T = (name: string) => Object.assign((len?: unknown) => ({ name, len }), { type: name });
  class FakeRequest {
    params: Record<string, unknown> = {};
    constructor(_tx?: unknown) {}
    input(n: string, _t: unknown, v: unknown) { this.params[n] = v; return this; }
    async query(sql: string) {
      paramsMax = Math.max(paramsMax, Object.keys(this.params).length);
      log.push(sql);
      if (sql.includes('FAIL_ME')) throw new Error('boom');
      if (sql.includes('sys.columns')) return { recordset: [] };
      if (sql.includes('SERVERPROPERTY')) return { recordset: [{ v: '16.0.4135.4', e: 'Standard Edition (64-bit)' }] };
      return { recordset: [] };
    }
    async batch(sql: string) { log.push(sql); return {}; }
  }
  const fake = {
    MAX: -1, BigInt: T('BigInt'), Float: T('Float'), NVarChar: T('NVarChar'), VarBinary: T('VarBinary'),
    ConnectionPool: class {
      constructor(public cfg: any) {}
      async connect() {
        attempt++;
        log.push(`CONNECT ${this.cfg.database} encrypt=${this.cfg.options.encrypt} trust=${this.cfg.options.trustServerCertificate}`);
        if (this.cfg.database === 'NewDb' && attempt === 1) throw new Error("Cannot open database \"NewDb\" requested by the login. The login failed.");
        return this;
      }
      request() { return new FakeRequest(); }
      async close() {}
    },
    Transaction: class { constructor(_p: unknown) {} async begin() {} async commit() { commits++; } async rollback() { rollbacks++; } },
    Request: FakeRequest,
  };
  setSqlDriverForTests(fake);
  const target = new MssqlTarget({ host: 'h.rds.amazonaws.com', port: 1433, database: 'NewDb', username: 'admin', password: 'pw', schema: 'vac', verifyCert: false });
  const info = await target.open();
  ok(info.createdDatabase && log.some((l) => l.includes("IF DB_ID(N'NewDb') IS NULL CREATE DATABASE [NewDb]")), 'a missing database is created on a new RDS instance');
  ok(log.some((l) => l.startsWith('CONNECT master')) && log.some((l) => l.includes('CREATE SCHEMA [vac]')), 'schema is created');
  ok(log.every((l) => !l.startsWith('CONNECT') || l.includes('encrypt=true')), 'connections are always encrypted');
  ok(info.version.includes('16.0.4135.4'), 'server version reported');
  const tables = discoverTables();
  const spec = tables.get('bridge_calls')!;
  await target.ensureTable(spec);
  const rows = Array.from({ length: 250 }, (_, i) => ({ ...Object.fromEntries(spec.columns.map((c) => [c.name, c.kind === 'int' ? 1 : `v${i}`])), id: `id-${i}`, transcript_json: "it's '); DROP TABLE x; --" }));
  await target.apply(spec, { truncate: true, upserts: rows, deletes: [['gone']] });
  ok(commits === 1 && rollbacks === 0, 'one transaction per change set');
  ok(paramsMax < 2100, `requests stay under SQL Server's parameter limit (${paramsMax})`);
  ok(!log.some((l) => l.includes('DROP TABLE x')), 'values never appear in SQL text');
  ok(log.some((l) => l === 'DELETE FROM [vac].[bridge_calls];'), 'full copy empties the table inside the transaction');
  const badSpec: TableSpec = { name: 'FAIL_ME', pk: ['id'], columns: [{ name: 'id', kind: 'text' }] };
  await assert.rejects(target.apply(badSpec, { upserts: [{ id: 'x' }], deletes: [] })); checks++;
  eq(rollbacks, 1, 'a failed change set is rolled back');
  await target.close();
  setSqlDriverForTests(null);
}

// ------------------------------------------------------------ HTTP API (shared test server)
async function http() {
  const base = process.env.TEST_URL;
  if (!base) return;
  const call = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, j: (await r.json().catch(() => ({}))) as any };
  };
  let r = await call('GET', '/api/mirror/status');
  if (r.status === 401) {
    console.log('  (HTTP checks skipped: the shared test server already requires sign-in)');
    return;
  }
  ok(r.status === 200 && r.j.settings && r.j.phase === 'off', `status endpoint: ${r.status} ${JSON.stringify(r.j).slice(0, 300)}`);
  r = await call('POST', '/api/mirror/settings', { host: 'not a host!' });
  eq(r.status, 400, 'bad endpoint rejected');
  r = await call('POST', '/api/mirror/toggle', { enabled: true });
  eq(r.status, 400, 'cannot turn on before the connection is filled in');
  r = await call('POST', '/api/mirror/settings', { host: '127.0.0.1', port: 9, username: 'admin', password: 'Sup3r-secret', verifyCert: false });
  ok(r.status === 200 && r.j.settings.passwordSet === true && !JSON.stringify(r.j).includes('Sup3r-secret'), 'password saved and never returned');
  r = await call('POST', '/api/mirror/test');
  ok(r.status === 502 && /cannot reach the RDS endpoint/.test(r.j.error), `real driver reports an unreachable server: ${r.j.error}`);
  r = await call('POST', '/api/mirror/resync');
  eq(r.status, 400, 'resync needs the mirror on');
}

(async () => {
  sqlUnit();
  await engine();
  await driver();
  await http();
  console.log(`✓ SQL Server mirror: ${checks} checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
