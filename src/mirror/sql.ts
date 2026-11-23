// T-SQL text for the SQL Server mirror. Every identifier passes NAME_RE and is
// bracket-quoted; every value travels as a typed parameter, never as SQL text.

export type ColKind = 'int' | 'real' | 'text' | 'blob';

export interface ColumnSpec {
  name: string;
  kind: ColKind;
}

export interface TableSpec {
  name: string;
  columns: ColumnSpec[]; // mirrored columns, in SQLite order
  pk: string[]; // primary key columns, in key order
}

export const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** SQL Server allows at most 2100 parameters per request; stay well under it. */
export const MAX_PARAMS = 2000;
export const MAX_ROWS_PER_STATEMENT = 100;
/** Added to every mirrored table: when the row last reached SQL Server (UTC). */
export const MIRRORED_AT = '_mirrored_at';

export function isValidName(name: string): boolean {
  return NAME_RE.test(name);
}

export function q(name: string): string {
  if (!NAME_RE.test(name)) throw new Error(`Unsafe SQL identifier: ${JSON.stringify(name)}`);
  return `[${name}]`;
}

/** SQLite type affinity rules (https://sqlite.org/datatype3.html §3.1). */
export function kindOf(declaredType: string): ColKind {
  const t = String(declaredType || '').toUpperCase();
  if (t.includes('INT')) return 'int';
  if (t.includes('CHAR') || t.includes('CLOB') || t.includes('TEXT')) return 'text';
  if (!t || t.includes('BLOB')) return 'blob';
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) return 'real';
  return 'text';
}

/** A clustered key may be 900 bytes at most, so text key columns share 450 characters. */
export function textKeyLength(spec: TableSpec): number {
  const textKeys = spec.pk.filter((k) => spec.columns.find((c) => c.name === k)?.kind === 'text').length;
  return Math.max(64, Math.floor(450 / Math.max(1, textKeys)));
}

export function sqlType(spec: TableSpec, col: ColumnSpec): string {
  const isKey = spec.pk.includes(col.name);
  switch (col.kind) {
    case 'int': return 'BIGINT';
    case 'real': return 'FLOAT';
    case 'blob': return isKey ? 'VARBINARY(450)' : 'VARBINARY(MAX)';
    default: return isKey ? `NVARCHAR(${textKeyLength(spec)})` : 'NVARCHAR(MAX)';
  }
}

export function objectName(schema: string, table: string): string {
  return `${q(schema)}.${q(table)}`;
}

export function ensureSchemaSql(schema: string): string {
  q(schema);
  return `IF SCHEMA_ID(N'${schema}') IS NULL EXEC(N'CREATE SCHEMA ${q(schema)}');`;
}

export function createDatabaseSql(database: string): string {
  q(database);
  return `IF DB_ID(N'${database}') IS NULL CREATE DATABASE ${q(database)};`;
}

export function createTableSql(schema: string, spec: TableSpec): string {
  const lines = spec.columns.map((c) => `  ${q(c.name)} ${sqlType(spec, c)} ${spec.pk.includes(c.name) ? 'NOT NULL' : 'NULL'}`);
  lines.push(`  ${q(MIRRORED_AT)} DATETIME2(3) NOT NULL CONSTRAINT ${q(`DF_${spec.name}_mirrored`.slice(0, 64))} DEFAULT SYSUTCDATETIME()`);
  lines.push(`  CONSTRAINT ${q(`PK_${spec.name}`.slice(0, 64))} PRIMARY KEY (${spec.pk.map(q).join(', ')})`);
  const obj = objectName(schema, spec.name);
  return `IF OBJECT_ID(N'${obj}', N'U') IS NULL\nCREATE TABLE ${obj} (\n${lines.join(',\n')}\n);`;
}

export function addColumnSql(schema: string, spec: TableSpec, col: ColumnSpec): string {
  return `ALTER TABLE ${objectName(schema, spec.name)} ADD ${q(col.name)} ${sqlType(spec, col)} NULL;`;
}

export function listColumnsSql(): string {
  return 'SELECT c.name FROM sys.columns c WHERE c.object_id = OBJECT_ID(@obj, N\'U\')';
}

export function paramName(row: number, col: number): string {
  return `r${row}_${col}`;
}

/** Rows per request so that rows × columns stays under the parameter limit. */
export function rowsPerStatement(spec: TableSpec): number {
  return Math.max(1, Math.min(MAX_ROWS_PER_STATEMENT, Math.floor(MAX_PARAMS / Math.max(1, spec.columns.length))));
}

/**
 * Replace each row: delete by key, then insert the current values. Runs inside
 * the caller's transaction, so readers never see a row missing.
 */
export function upsertBatchSql(schema: string, spec: TableSpec, rowCount: number): string {
  const obj = objectName(schema, spec.name);
  const cols = spec.columns.map((c) => q(c.name)).join(', ');
  const parts: string[] = [];
  for (let r = 0; r < rowCount; r++) {
    const where = spec.pk.map((k) => `${q(k)} = @${paramName(r, spec.columns.findIndex((c) => c.name === k))}`).join(' AND ');
    const values = spec.columns.map((_c, i) => `@${paramName(r, i)}`).join(', ');
    parts.push(`DELETE FROM ${obj} WHERE ${where};`);
    parts.push(`INSERT INTO ${obj} (${cols}, ${q(MIRRORED_AT)}) VALUES (${values}, SYSUTCDATETIME());`);
  }
  return parts.join('\n');
}

/** Delete rows by key; key values are parameters named k{row}_{keyIndex}. */
export function deleteBatchSql(schema: string, spec: TableSpec, rowCount: number): string {
  const obj = objectName(schema, spec.name);
  const parts: string[] = [];
  for (let r = 0; r < rowCount; r++) {
    parts.push(`DELETE FROM ${obj} WHERE ${spec.pk.map((k, i) => `${q(k)} = @k${r}_${i}`).join(' AND ')};`);
  }
  return parts.join('\n');
}

export function deleteAllSql(schema: string, spec: TableSpec): string {
  return `DELETE FROM ${objectName(schema, spec.name)};`;
}

const iso = (col: string) => `TRY_CONVERT(DATETIME2(3), ${q(col)}, 127)`;

/**
 * Reporting views with real date/time columns (SQLite stores ISO-8601 text).
 * One statement each: CREATE OR ALTER VIEW must be alone in its batch.
 */
export function reportingViewsSql(schema: string, tables: Map<string, TableSpec>): Array<{ name: string; sql: string }> {
  const has = (t: string, cols: string[]) => {
    const spec = tables.get(t);
    return Boolean(spec && cols.every((c) => spec.columns.some((x) => x.name === c)));
  };
  const out: Array<{ name: string; sql: string }> = [];
  const bridgeCols = ['id', 'transport', 'campaign_id', 'vici_campaign', 'agent_name', 'phone', 'lead_id', 'disposition', 'transferred_to', 'dnc_added', 'started_at', 'ended_at', 'duration_ms', 'turns', 'avg_ttfb_ms'];
  if (has('bridge_calls', bridgeCols)) {
    out.push({
      name: 'v_bridge_calls',
      sql: `CREATE OR ALTER VIEW ${objectName(schema, 'v_bridge_calls')} AS
SELECT [id], [transport], [campaign_id], [vici_campaign], [agent_name], [phone], [lead_id],
       [disposition], [transferred_to], CAST([dnc_added] AS BIT) AS [dnc_added],
       ${iso('started_at')} AS [started_at_utc], ${iso('ended_at')} AS [ended_at_utc],
       CAST([duration_ms] / 1000.0 AS DECIMAL(10,1)) AS [duration_sec], [turns], [avg_ttfb_ms]
FROM ${objectName(schema, 'bridge_calls')};`,
    });
  }
  const simCols = ['id', 'agent_name', 'campaign_id', 'upstream_mode', 'started_at', 'ended_at', 'duration_ms', 'turns', 'avg_ttfb_ms', 'disposition', 'transferred_to'];
  if (has('simulator_calls', simCols)) {
    out.push({
      name: 'v_simulator_calls',
      sql: `CREATE OR ALTER VIEW ${objectName(schema, 'v_simulator_calls')} AS
SELECT [id], [agent_name], [campaign_id], [upstream_mode], ${iso('started_at')} AS [started_at_utc],
       ${iso('ended_at')} AS [ended_at_utc], CAST([duration_ms] / 1000.0 AS DECIMAL(10,1)) AS [duration_sec],
       [turns], [avg_ttfb_ms], [disposition], [transferred_to]
FROM ${objectName(schema, 'simulator_calls')};`,
    });
  }
  const scrCols = ['call_id', 'campaign_id', 'lead_id', 'outcome', 'reason', 'native_amd', 'decided_ms', 'disposition', 'disposition_state', 'created_at'];
  if (has('screening_results', scrCols)) {
    out.push({
      name: 'v_screening_results',
      sql: `CREATE OR ALTER VIEW ${objectName(schema, 'v_screening_results')} AS
SELECT [call_id], [campaign_id], [lead_id], [outcome], [reason], [native_amd],
       CAST([decided_ms] / 1000.0 AS DECIMAL(10,1)) AS [decided_sec], [disposition], [disposition_state],
       ${iso('created_at')} AS [created_at_utc]
FROM ${objectName(schema, 'screening_results')};`,
    });
  }
  return out;
}
