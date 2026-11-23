// SQL Server side of the mirror (AWS RDS for SQL Server, managed in SSMS).
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../data-paths';
import {
  addColumnSql, createDatabaseSql, createTableSql, deleteAllSql, deleteBatchSql, ensureSchemaSql,
  listColumnsSql, objectName, paramName, reportingViewsSql, rowsPerStatement, TableSpec, textKeyLength, upsertBatchSql,
} from './sql';

export interface TargetConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  schema: string;
  verifyCert: boolean;
}

export interface MirrorTarget {
  /** Connects, creating the database and schema when missing. */
  open(): Promise<{ version: string; createdDatabase: boolean }>;
  /** Creates the table, or adds columns it lacks. Returns true when columns were added. */
  ensureTable(spec: TableSpec): Promise<boolean>;
  /** In one transaction: optionally empty the table, upsert rows, delete keys. */
  apply(spec: TableSpec, change: { truncate?: boolean; upserts: Record<string, unknown>[]; deletes: unknown[][] }): Promise<void>;
  ensureViews(tables: Map<string, TableSpec>): Promise<string[]>;
  close(): Promise<void>;
}

export const CA_BUNDLE_URL = 'https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem';
export function caBundlePath(): string {
  return process.env.MSSQL_CA_FILE?.trim() || path.join(DATA_DIR, 'rds-global-bundle.pem');
}

/** Downloads the AWS RDS certificate bundle once, so the server certificate can be verified. */
export async function ensureCaBundle(): Promise<string> {
  const file = caBundlePath();
  if (fs.existsSync(file) && fs.statSync(file).size > 1000) return file;
  const res = await fetch(CA_BUNDLE_URL);
  if (!res.ok) throw new Error(`Could not download the AWS RDS certificate bundle (HTTP ${res.status}).`);
  const pem = await res.text();
  if (!pem.includes('BEGIN CERTIFICATE')) throw new Error('The AWS RDS certificate bundle download was not a certificate file.');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, pem, { mode: 0o644 });
  return file;
}

/** Plain-language hints for the errors people hit when connecting to RDS. */
export function explainSqlError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/ETIMEOUT|ESOCKET|ECONNREFUSED|timeout|ENOTFOUND|EAI_AGAIN|Failed to connect|Could not connect/i.test(msg)) {
    return `${msg} — the console cannot reach the RDS endpoint. Check the endpoint and port, and that the RDS security group allows TCP 1433 from this server.`;
  }
  if (/Login failed/i.test(msg)) return `${msg} — check the username and password.`;
  if (/certificate|self[- ]signed|unable to verify|altnames|CERT_/i.test(msg)) {
    return `${msg} — use the RDS endpoint name (not an IP address) so the certificate matches.`;
  }
  return msg;
}

let sqlModule: any = null;
/** Tests replace the driver with a recording fake. */
export function setSqlDriverForTests(driver: any): void { sqlModule = driver; }
function driver(): any {
  if (!sqlModule) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    sqlModule = require('mssql');
  }
  return sqlModule;
}

function paramType(sql: any, spec: TableSpec, colName: string): any {
  const col = spec.columns.find((c) => c.name === colName)!;
  const isKey = spec.pk.includes(colName);
  switch (col.kind) {
    case 'int': return sql.BigInt;
    case 'real': return sql.Float;
    case 'blob': return sql.VarBinary(isKey ? 450 : sql.MAX);
    default: return sql.NVarChar(isKey ? textKeyLength(spec) : sql.MAX);
  }
}

function paramValue(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array && !Buffer.isBuffer(v)) return Buffer.from(v);
  return v;
}

export class MssqlTarget implements MirrorTarget {
  private pool: any = null;
  private columns = new Map<string, Set<string>>();

  constructor(private cfg: TargetConfig) {}

  private async poolConfig(database: string) {
    const options: Record<string, unknown> = {
      encrypt: true,
      trustServerCertificate: !this.cfg.verifyCert,
      appName: 'VoiceAgentConsole-mirror',
    };
    if (this.cfg.verifyCert) {
      const file = await ensureCaBundle();
      options.cryptoCredentialsDetails = { ca: fs.readFileSync(file, 'utf8') };
    }
    return {
      server: this.cfg.host,
      port: this.cfg.port,
      database,
      user: this.cfg.username,
      password: this.cfg.password,
      options,
      pool: { max: 2, min: 0, idleTimeoutMillis: 60000 },
      connectionTimeout: 15000,
      requestTimeout: 120000,
    };
  }

  async open(): Promise<{ version: string; createdDatabase: boolean }> {
    const sql = driver();
    let createdDatabase = false;
    try {
      this.pool = await new sql.ConnectionPool(await this.poolConfig(this.cfg.database)).connect();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/Cannot open database|4060/i.test(msg)) throw err;
      // A new RDS instance only has master: create the database, then reconnect.
      const master = await new sql.ConnectionPool(await this.poolConfig('master')).connect();
      try {
        await master.request().query(createDatabaseSql(this.cfg.database));
        createdDatabase = true;
      } finally {
        await master.close();
      }
      this.pool = await new sql.ConnectionPool(await this.poolConfig(this.cfg.database)).connect();
    }
    await this.pool.request().query(ensureSchemaSql(this.cfg.schema));
    const v = await this.pool.request().query(`SELECT CAST(SERVERPROPERTY('ProductVersion') AS NVARCHAR(64)) AS v, CAST(SERVERPROPERTY('Edition') AS NVARCHAR(128)) AS e`);
    const row = v.recordset?.[0] || {};
    return { version: `SQL Server ${row.v || '?'} (${row.e || 'unknown edition'})`, createdDatabase };
  }

  async ensureTable(spec: TableSpec): Promise<boolean> {
    const sql = driver();
    let have = this.columns.get(spec.name);
    if (!have) {
      await this.pool.request().query(createTableSql(this.cfg.schema, spec));
      const r = await this.pool.request().input('obj', sql.NVarChar(300), objectName(this.cfg.schema, spec.name)).query(listColumnsSql());
      have = new Set<string>((r.recordset || []).map((x: { name: string }) => x.name.toLowerCase()));
      this.columns.set(spec.name, have);
    }
    let added = false;
    for (const col of spec.columns) {
      if (have.has(col.name.toLowerCase())) continue;
      await this.pool.request().query(addColumnSql(this.cfg.schema, spec, col));
      have.add(col.name.toLowerCase());
      added = true;
    }
    return added;
  }

  async apply(spec: TableSpec, change: { truncate?: boolean; upserts: Record<string, unknown>[]; deletes: unknown[][] }): Promise<void> {
    const sql = driver();
    const tx = new sql.Transaction(this.pool);
    await tx.begin();
    try {
      if (change.truncate) await new sql.Request(tx).query(deleteAllSql(this.cfg.schema, spec));
      const per = rowsPerStatement(spec);
      for (let i = 0; i < change.upserts.length; i += per) {
        const chunk = change.upserts.slice(i, i + per);
        const req = new sql.Request(tx);
        chunk.forEach((row, r) => spec.columns.forEach((c, ci) => req.input(paramName(r, ci), paramType(sql, spec, c.name), paramValue(row[c.name]))));
        await req.query(upsertBatchSql(this.cfg.schema, spec, chunk.length));
      }
      const perDel = Math.max(1, Math.floor(2000 / spec.pk.length));
      for (let i = 0; i < change.deletes.length; i += perDel) {
        const chunk = change.deletes.slice(i, i + perDel);
        const req = new sql.Request(tx);
        chunk.forEach((key, r) => spec.pk.forEach((k, ki) => req.input(`k${r}_${ki}`, paramType(sql, spec, k), paramValue(key[ki]))));
        await req.query(deleteBatchSql(this.cfg.schema, spec, chunk.length));
      }
      await tx.commit();
    } catch (err) {
      try { await tx.rollback(); } catch { /* already rolled back */ }
      throw err;
    }
  }

  async ensureViews(tables: Map<string, TableSpec>): Promise<string[]> {
    const made: string[] = [];
    for (const v of reportingViewsSql(this.cfg.schema, tables)) {
      try {
        await this.pool.request().batch(v.sql);
        made.push(v.name);
      } catch {
        // Views are a convenience; a failure must not stop the data copy.
      }
    }
    return made;
  }

  async close(): Promise<void> {
    const p = this.pool;
    this.pool = null;
    this.columns.clear();
    if (p) await p.close().catch(() => {});
  }
}
