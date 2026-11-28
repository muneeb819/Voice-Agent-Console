"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.setRdsPoolFactoryForTests = setRdsPoolFactoryForTests;
exports.sanitizeTablePrefix = sanitizeTablePrefix;
exports.getRdsMssqlConfig = getRdsMssqlConfig;
exports.getRdsStatus = getRdsStatus;
exports.resetRdsPool = resetRdsPool;
exports.upsertBridgeCallToRds = upsertBridgeCallToRds;
exports.upsertScreeningResultToRds = upsertScreeningResultToRds;
exports.enqueueRdsBridgeCallSync = enqueueRdsBridgeCallSync;
exports.enqueueRdsScreeningSync = enqueueRdsScreeningSync;
exports.testRdsConnection = testRdsConnection;
exports.backfillToRds = backfillToRds;
exports.queryRdsCalls = queryRdsCalls;
const mssql_1 = __importDefault(require("mssql"));
const env_store_1 = require("./env-store");
let poolFactory = (cfg) => new mssql_1.default.ConnectionPool(cfg);
function setRdsPoolFactoryForTests(factory) {
    poolFactory = factory || ((cfg) => new mssql_1.default.ConnectionPool(cfg));
}
const MAX_PENDING_QUEUE = 2000;
function parseBoolEnv(raw, fallback) {
    const v = String(raw || '').trim().toLowerCase();
    if (!v)
        return fallback;
    if (['1', 'true', 'yes', 'on'].includes(v))
        return true;
    if (['0', 'false', 'no', 'off'].includes(v))
        return false;
    return fallback;
}
function sanitizeTablePrefix(raw) {
    const clean = String(raw || '').trim();
    if (!clean)
        return 'vac_';
    if (/^[A-Za-z_][A-Za-z0-9_]{0,20}$/.test(clean))
        return clean;
    return 'vac_';
}
function getRdsMssqlConfig() {
    const host = (0, env_store_1.getSecret)('RDS_MSSQL_HOST');
    const rawPort = Number((0, env_store_1.getSecret)('RDS_MSSQL_PORT') || 1433);
    const port = Number.isInteger(rawPort) && rawPort >= 1 && rawPort <= 65535 ? rawPort : 1433;
    const database = (0, env_store_1.getSecret)('RDS_MSSQL_DATABASE') || 'voice_agent_console';
    const user = (0, env_store_1.getSecret)('RDS_MSSQL_USER');
    const password = (0, env_store_1.getSecret)('RDS_MSSQL_PASSWORD');
    const configured = Boolean(host && user && password);
    const enabledFlag = (0, env_store_1.getSecret)('RDS_MSSQL_ENABLED');
    const enabled = configured && parseBoolEnv(enabledFlag, true);
    const encrypt = parseBoolEnv((0, env_store_1.getSecret)('RDS_MSSQL_ENCRYPT'), true);
    const trustServerCertificate = parseBoolEnv((0, env_store_1.getSecret)('RDS_MSSQL_TRUST_SERVER_CERT'), false);
    const tablePrefix = sanitizeTablePrefix((0, env_store_1.getSecret)('RDS_MSSQL_TABLE_PREFIX'));
    return {
        enabled,
        configured,
        host,
        port,
        database,
        user,
        hasPassword: Boolean(password),
        encrypt,
        trustServerCertificate,
        tablePrefix,
    };
}
let activePool = null;
let connectingPromise = null;
let schemaReady = false;
let syncedBridgeCalls = 0;
let syncedScreeningResults = 0;
let failedCount = 0;
let lastSyncAt = null;
let lastError = null;
const queue = [];
let draining = false;
function getRdsStatus() {
    const cfg = getRdsMssqlConfig();
    return {
        engine: 'mssql',
        enabled: cfg.enabled,
        configured: cfg.configured,
        connected: Boolean(activePool && activePool.connected),
        schemaReady,
        host: cfg.host,
        port: cfg.port,
        database: cfg.database,
        user: cfg.user,
        hasPassword: cfg.hasPassword,
        encrypt: cfg.encrypt,
        trustServerCertificate: cfg.trustServerCertificate,
        tablePrefix: cfg.tablePrefix,
        pendingCount: queue.length,
        syncedBridgeCalls,
        syncedScreeningResults,
        failedCount,
        lastSyncAt,
        lastError,
    };
}
async function resetRdsPool() {
    const prev = activePool;
    activePool = null;
    connectingPromise = null;
    schemaReady = false;
    if (prev) {
        try {
            await prev.close();
        }
        catch {
            // Ignore close errors during reset
        }
    }
}
function buildSqlConfig(cfg) {
    return {
        server: cfg.host,
        port: cfg.port,
        database: cfg.database,
        user: cfg.user,
        password: (0, env_store_1.getSecret)('RDS_MSSQL_PASSWORD'),
        connectionTimeout: 10000,
        requestTimeout: 15000,
        pool: {
            max: 5,
            min: 0,
            idleTimeoutMillis: 30000,
        },
        options: {
            encrypt: cfg.encrypt,
            trustServerCertificate: cfg.trustServerCertificate,
            enableArithAbort: true,
        },
    };
}
function tableNames(prefix) {
    const safe = sanitizeTablePrefix(prefix);
    return {
        calls: `[dbo].[${safe}bridge_calls]`,
        screening: `[dbo].[${safe}screening_results]`,
    };
}
async function ensureSchema(pool, prefix) {
    if (schemaReady)
        return;
    const safe = sanitizeTablePrefix(prefix);
    const callsTable = `${safe}bridge_calls`;
    const screeningTable = `${safe}screening_results`;
    await pool.request().query(`
    IF OBJECT_ID(N'dbo.${callsTable}', N'U') IS NULL
    BEGIN
      CREATE TABLE [dbo].[${callsTable}] (
        [id] NVARCHAR(128) NOT NULL PRIMARY KEY,
        [transport] NVARCHAR(32) NOT NULL,
        [exten] NVARCHAR(64) NOT NULL,
        [caller_code] NVARCHAR(128) NOT NULL,
        [lead_id] NVARCHAR(64) NULL,
        [phone] NVARCHAR(64) NOT NULL,
        [campaign_id] NVARCHAR(128) NOT NULL,
        [vici_campaign] NVARCHAR(128) NOT NULL,
        [agent_id] NVARCHAR(128) NOT NULL,
        [agent_name] NVARCHAR(255) NOT NULL,
        [greeting_id] NVARCHAR(128) NULL,
        [remote_agent_user] NVARCHAR(64) NOT NULL,
        [started_at] DATETIMEOFFSET NOT NULL,
        [ended_at] DATETIMEOFFSET NOT NULL,
        [duration_ms] INT NOT NULL,
        [turns] INT NOT NULL,
        [avg_ttfb_ms] INT NULL,
        [disposition] NVARCHAR(64) NOT NULL,
        [transferred_to] NVARCHAR(128) NULL,
        [dnc_added] BIT NOT NULL DEFAULT 0,
        [recording_file] NVARCHAR(255) NULL,
        [recording_bytes] INT NOT NULL DEFAULT 0,
        [transcript_json] NVARCHAR(MAX) NOT NULL,
        [functions_json] NVARCHAR(MAX) NOT NULL,
        [vici_api_audit_json] NVARCHAR(MAX) NOT NULL,
        [synced_at] DATETIMEOFFSET NOT NULL DEFAULT SYSUTCDATETIME()
      );
      CREATE INDEX [idx_${callsTable}_started] ON [dbo].[${callsTable}] ([started_at] DESC);
      CREATE INDEX [idx_${callsTable}_campaign] ON [dbo].[${callsTable}] ([vici_campaign], [started_at] DESC);
      CREATE INDEX [idx_${callsTable}_disposition] ON [dbo].[${callsTable}] ([disposition]);
      CREATE INDEX [idx_${callsTable}_lead] ON [dbo].[${callsTable}] ([lead_id]);
    END;

    IF OBJECT_ID(N'dbo.${screeningTable}', N'U') IS NULL
    BEGIN
      CREATE TABLE [dbo].[${screeningTable}] (
        [call_id] NVARCHAR(128) NOT NULL PRIMARY KEY,
        [campaign_id] NVARCHAR(128) NOT NULL DEFAULT '',
        [lead_id] NVARCHAR(64) NOT NULL DEFAULT '',
        [caller_code] NVARCHAR(128) NOT NULL DEFAULT '',
        [phone_tail] NVARCHAR(16) NOT NULL DEFAULT '',
        [outcome] NVARCHAR(64) NOT NULL DEFAULT '',
        [reason] NVARCHAR(512) NOT NULL DEFAULT '',
        [native_amd] NVARCHAR(64) NOT NULL DEFAULT '',
        [decided_ms] INT NOT NULL DEFAULT 0,
        [evidence_json] NVARCHAR(MAX) NOT NULL DEFAULT '{}',
        [disposition] NVARCHAR(64) NOT NULL DEFAULT '',
        [disposition_state] NVARCHAR(32) NOT NULL DEFAULT '',
        [verified_lead_status] NVARCHAR(64) NOT NULL DEFAULT '',
        [verified_call_status] NVARCHAR(64) NOT NULL DEFAULT '',
        [disposition_detail] NVARCHAR(512) NOT NULL DEFAULT '',
        [created_at] DATETIMEOFFSET NULL,
        [updated_at] DATETIMEOFFSET NULL,
        [synced_at] DATETIMEOFFSET NOT NULL DEFAULT SYSUTCDATETIME()
      );
      CREATE INDEX [idx_${screeningTable}_created] ON [dbo].[${screeningTable}] ([created_at] DESC);
    END;
  `);
    schemaReady = true;
}
async function getConnectedPool() {
    const cfg = getRdsMssqlConfig();
    if (!cfg.configured) {
        throw new Error('AWS RDS SQL Server is not configured (set RDS_MSSQL_HOST, RDS_MSSQL_USER, RDS_MSSQL_PASSWORD in .env).');
    }
    if (!cfg.enabled) {
        throw new Error('AWS RDS SQL Server sync is disabled (RDS_MSSQL_ENABLED=0).');
    }
    if (activePool && activePool.connected) {
        await ensureSchema(activePool, cfg.tablePrefix);
        return { pool: activePool, cfg };
    }
    if (!connectingPromise) {
        const candidate = poolFactory(buildSqlConfig(cfg));
        connectingPromise = candidate
            .connect()
            .then((connected) => {
            activePool = connected;
            connectingPromise = null;
            return connected;
        })
            .catch((err) => {
            activePool = null;
            connectingPromise = null;
            throw err;
        });
    }
    const pool = await connectingPromise;
    await ensureSchema(pool, cfg.tablePrefix);
    return { pool, cfg };
}
function safeIso(raw) {
    const s = String(raw || '').trim();
    const t = Date.parse(s);
    return Number.isFinite(t) ? new Date(t).toISOString() : new Date().toISOString();
}
async function upsertBridgeCallToRds(record) {
    const { pool, cfg } = await getConnectedPool();
    const { calls } = tableNames(cfg.tablePrefix);
    await pool
        .request()
        .input('id', mssql_1.default.NVarChar(128), String(record.id || '').slice(0, 128))
        .input('transport', mssql_1.default.NVarChar(32), String(record.transport || '').slice(0, 32))
        .input('exten', mssql_1.default.NVarChar(64), String(record.exten || '').slice(0, 64))
        .input('caller_code', mssql_1.default.NVarChar(128), String(record.callerCode || '').slice(0, 128))
        .input('lead_id', mssql_1.default.NVarChar(64), record.leadId ? String(record.leadId).slice(0, 64) : null)
        .input('phone', mssql_1.default.NVarChar(64), String(record.phone || '').slice(0, 64))
        .input('campaign_id', mssql_1.default.NVarChar(128), String(record.campaignId || '').slice(0, 128))
        .input('vici_campaign', mssql_1.default.NVarChar(128), String(record.viciCampaign || '').slice(0, 128))
        .input('agent_id', mssql_1.default.NVarChar(128), String(record.agentId || '').slice(0, 128))
        .input('agent_name', mssql_1.default.NVarChar(255), String(record.agentName || '').slice(0, 255))
        .input('greeting_id', mssql_1.default.NVarChar(128), record.greetingId ? String(record.greetingId).slice(0, 128) : null)
        .input('remote_agent_user', mssql_1.default.NVarChar(64), String(record.remoteAgentUser || '').slice(0, 64))
        .input('started_at', mssql_1.default.DateTimeOffset, new Date(safeIso(record.startedAt)))
        .input('ended_at', mssql_1.default.DateTimeOffset, new Date(safeIso(record.endedAt)))
        .input('duration_ms', mssql_1.default.Int, Math.max(0, Math.round(Number(record.durationMs || 0))))
        .input('turns', mssql_1.default.Int, Math.max(0, Math.round(Number(record.turns || 0))))
        .input('avg_ttfb_ms', mssql_1.default.Int, record.avgTtfbMs != null && Number.isFinite(record.avgTtfbMs) ? Math.round(record.avgTtfbMs) : null)
        .input('disposition', mssql_1.default.NVarChar(64), String(record.disposition || '').slice(0, 64))
        .input('transferred_to', mssql_1.default.NVarChar(128), record.transferredTo ? String(record.transferredTo).slice(0, 128) : null)
        .input('dnc_added', mssql_1.default.Bit, record.dncAdded ? 1 : 0)
        .input('recording_file', mssql_1.default.NVarChar(255), record.recordingFile ? String(record.recordingFile).slice(0, 255) : null)
        .input('recording_bytes', mssql_1.default.Int, Math.max(0, Math.round(Number(record.recordingBytes || 0))))
        .input('transcript_json', mssql_1.default.NVarChar(mssql_1.default.MAX), JSON.stringify(record.transcript || []))
        .input('functions_json', mssql_1.default.NVarChar(mssql_1.default.MAX), JSON.stringify(record.functionCalls || []))
        .input('vici_api_audit_json', mssql_1.default.NVarChar(mssql_1.default.MAX), JSON.stringify(record.viciApiAudit || []))
        .query(`
      MERGE ${calls} WITH (HOLDLOCK) AS target
      USING (SELECT @id AS id) AS src
      ON target.[id] = src.[id]
      WHEN MATCHED THEN UPDATE SET
        [transport] = @transport,
        [exten] = @exten,
        [caller_code] = @caller_code,
        [lead_id] = @lead_id,
        [phone] = @phone,
        [campaign_id] = @campaign_id,
        [vici_campaign] = @vici_campaign,
        [agent_id] = @agent_id,
        [agent_name] = @agent_name,
        [greeting_id] = @greeting_id,
        [remote_agent_user] = @remote_agent_user,
        [started_at] = @started_at,
        [ended_at] = @ended_at,
        [duration_ms] = @duration_ms,
        [turns] = @turns,
        [avg_ttfb_ms] = @avg_ttfb_ms,
        [disposition] = @disposition,
        [transferred_to] = @transferred_to,
        [dnc_added] = @dnc_added,
        [recording_file] = @recording_file,
        [recording_bytes] = @recording_bytes,
        [transcript_json] = @transcript_json,
        [functions_json] = @functions_json,
        [vici_api_audit_json] = @vici_api_audit_json,
        [synced_at] = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (
        [id],[transport],[exten],[caller_code],[lead_id],[phone],
        [campaign_id],[vici_campaign],[agent_id],[agent_name],[greeting_id],[remote_agent_user],
        [started_at],[ended_at],[duration_ms],[turns],[avg_ttfb_ms],
        [disposition],[transferred_to],[dnc_added],[recording_file],[recording_bytes],
        [transcript_json],[functions_json],[vici_api_audit_json]
      ) VALUES (
        @id,@transport,@exten,@caller_code,@lead_id,@phone,
        @campaign_id,@vici_campaign,@agent_id,@agent_name,@greeting_id,@remote_agent_user,
        @started_at,@ended_at,@duration_ms,@turns,@avg_ttfb_ms,
        @disposition,@transferred_to,@dnc_added,@recording_file,@recording_bytes,
        @transcript_json,@functions_json,@vici_api_audit_json
      );
    `);
    syncedBridgeCalls += 1;
    lastSyncAt = new Date().toISOString();
    lastError = null;
}
async function upsertScreeningResultToRds(row) {
    if (!row || !row.call_id)
        return;
    const { pool, cfg } = await getConnectedPool();
    const { screening } = tableNames(cfg.tablePrefix);
    await pool
        .request()
        .input('call_id', mssql_1.default.NVarChar(128), String(row.call_id).slice(0, 128))
        .input('campaign_id', mssql_1.default.NVarChar(128), String(row.campaign_id || '').slice(0, 128))
        .input('lead_id', mssql_1.default.NVarChar(64), String(row.lead_id || '').slice(0, 64))
        .input('caller_code', mssql_1.default.NVarChar(128), String(row.caller_code || '').slice(0, 128))
        .input('phone_tail', mssql_1.default.NVarChar(16), String(row.phone_tail || '').slice(0, 16))
        .input('outcome', mssql_1.default.NVarChar(64), String(row.outcome || '').slice(0, 64))
        .input('reason', mssql_1.default.NVarChar(512), String(row.reason || '').slice(0, 512))
        .input('native_amd', mssql_1.default.NVarChar(64), String(row.native_amd || '').slice(0, 64))
        .input('decided_ms', mssql_1.default.Int, Math.max(0, Math.round(Number(row.decided_ms || 0))))
        .input('evidence_json', mssql_1.default.NVarChar(mssql_1.default.MAX), typeof row.evidence === 'string' ? row.evidence : JSON.stringify(row.evidence || {}))
        .input('disposition', mssql_1.default.NVarChar(64), String(row.disposition || '').slice(0, 64))
        .input('disposition_state', mssql_1.default.NVarChar(32), String(row.disposition_state || '').slice(0, 32))
        .input('verified_lead_status', mssql_1.default.NVarChar(64), String(row.verified_lead_status || '').slice(0, 64))
        .input('verified_call_status', mssql_1.default.NVarChar(64), String(row.verified_call_status || '').slice(0, 64))
        .input('disposition_detail', mssql_1.default.NVarChar(512), String(row.disposition_detail || '').slice(0, 512))
        .input('created_at', mssql_1.default.DateTimeOffset, new Date(safeIso(row.created_at)))
        .input('updated_at', mssql_1.default.DateTimeOffset, new Date(safeIso(row.updated_at)))
        .query(`
      MERGE ${screening} WITH (HOLDLOCK) AS target
      USING (SELECT @call_id AS call_id) AS src
      ON target.[call_id] = src.[call_id]
      WHEN MATCHED THEN UPDATE SET
        [campaign_id] = @campaign_id,
        [lead_id] = @lead_id,
        [caller_code] = @caller_code,
        [phone_tail] = @phone_tail,
        [outcome] = @outcome,
        [reason] = @reason,
        [native_amd] = @native_amd,
        [decided_ms] = @decided_ms,
        [evidence_json] = @evidence_json,
        [disposition] = @disposition,
        [disposition_state] = @disposition_state,
        [verified_lead_status] = @verified_lead_status,
        [verified_call_status] = @verified_call_status,
        [disposition_detail] = @disposition_detail,
        [updated_at] = @updated_at,
        [synced_at] = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (
        [call_id],[campaign_id],[lead_id],[caller_code],[phone_tail],[outcome],[reason],
        [native_amd],[decided_ms],[evidence_json],[disposition],[disposition_state],
        [verified_lead_status],[verified_call_status],[disposition_detail],[created_at],[updated_at]
      ) VALUES (
        @call_id,@campaign_id,@lead_id,@caller_code,@phone_tail,@outcome,@reason,
        @native_amd,@decided_ms,@evidence_json,@disposition,@disposition_state,
        @verified_lead_status,@verified_call_status,@disposition_detail,@created_at,@updated_at
      );
    `);
    syncedScreeningResults += 1;
    lastSyncAt = new Date().toISOString();
    lastError = null;
}
async function drainQueue() {
    if (draining)
        return;
    draining = true;
    try {
        while (queue.length > 0) {
            const cfg = getRdsMssqlConfig();
            if (!cfg.enabled) {
                queue.length = 0;
                break;
            }
            const task = queue.shift();
            try {
                if (task.kind === 'bridge_call') {
                    await upsertBridgeCallToRds(task.record);
                }
                else {
                    await upsertScreeningResultToRds(task.row);
                }
            }
            catch (err) {
                failedCount += 1;
                lastError = String(err?.message || err || 'RDS SQL Server sync failed').slice(0, 400);
                // Reset dead connection so the next item reconnects cleanly
                if (activePool && !activePool.connected)
                    activePool = null;
            }
        }
    }
    finally {
        draining = false;
    }
}
function enqueueRdsBridgeCallSync(record) {
    const cfg = getRdsMssqlConfig();
    if (!cfg.enabled)
        return;
    if (queue.length >= MAX_PENDING_QUEUE)
        queue.shift();
    queue.push({ kind: 'bridge_call', record });
    void drainQueue();
}
function enqueueRdsScreeningSync(row) {
    const cfg = getRdsMssqlConfig();
    if (!cfg.enabled || !row?.call_id)
        return;
    if (queue.length >= MAX_PENDING_QUEUE)
        queue.shift();
    queue.push({ kind: 'screening', row });
    void drainQueue();
}
async function testRdsConnection() {
    const t0 = Date.now();
    try {
        await resetRdsPool();
        const { pool, cfg } = await getConnectedPool();
        const { calls, screening } = tableNames(cfg.tablePrefix);
        const meta = await pool.request().query(`SELECT @@VERSION AS server_version, DB_NAME() AS db_name`);
        const counts = await pool.request().query(`
      SELECT
        (SELECT COUNT(*) FROM ${calls}) AS bridge_calls_count,
        (SELECT COUNT(*) FROM ${screening}) AS screening_results_count
    `);
        const firstMeta = meta.recordset?.[0] || {};
        const firstCounts = counts.recordset?.[0] || {};
        lastError = null;
        return {
            ok: true,
            latencyMs: Date.now() - t0,
            serverVersion: String(firstMeta.server_version || '').split('\n')[0].trim(),
            database: String(firstMeta.db_name || cfg.database),
            bridgeCallsCount: Number(firstCounts.bridge_calls_count || 0),
            screeningResultsCount: Number(firstCounts.screening_results_count || 0),
        };
    }
    catch (err) {
        const msg = String(err?.message || err || 'Connection failed').slice(0, 400);
        lastError = msg;
        return {
            ok: false,
            latencyMs: Date.now() - t0,
            serverVersion: '',
            database: getRdsMssqlConfig().database,
            bridgeCallsCount: 0,
            screeningResultsCount: 0,
            error: msg,
        };
    }
}
async function backfillToRds(bridgeCalls, screeningRows) {
    const errors = [];
    let callsOk = 0;
    let screenOk = 0;
    for (const record of bridgeCalls) {
        try {
            await upsertBridgeCallToRds(record);
            callsOk += 1;
        }
        catch (err) {
            errors.push(`call ${record.id}: ${String(err?.message || err).slice(0, 180)}`);
            if (errors.length >= 10)
                break;
        }
    }
    for (const row of screeningRows) {
        try {
            await upsertScreeningResultToRds(row);
            screenOk += 1;
        }
        catch (err) {
            errors.push(`screening ${row.call_id}: ${String(err?.message || err).slice(0, 180)}`);
            if (errors.length >= 10)
                break;
        }
    }
    return {
        ok: errors.length === 0,
        bridgeCallsSynced: callsOk,
        screeningResultsSynced: screenOk,
        errors,
    };
}
async function queryRdsCalls(opts) {
    const { pool, cfg } = await getConnectedPool();
    const { calls } = tableNames(cfg.tablePrefix);
    const limit = Math.max(1, Math.min(500, Math.floor(Number(opts.limit || 50))));
    const where = [];
    const bind = (req) => {
        if (opts.campaign)
            req.input('campaign', mssql_1.default.NVarChar(128), String(opts.campaign).trim());
        if (opts.disposition)
            req.input('disposition', mssql_1.default.NVarChar(64), String(opts.disposition).trim().toUpperCase());
        if (opts.start)
            req.input('start', mssql_1.default.DateTimeOffset, new Date(safeIso(opts.start)));
        if (opts.end)
            req.input('end', mssql_1.default.DateTimeOffset, new Date(safeIso(opts.end)));
        return req;
    };
    if (opts.campaign)
        where.push('([vici_campaign] = @campaign OR [campaign_id] = @campaign)');
    if (opts.disposition)
        where.push('UPPER([disposition]) = @disposition');
    if (opts.start)
        where.push('[started_at] >= @start');
    if (opts.end)
        where.push('[started_at] <= @end');
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const summaryRes = await bind(pool.request()).query(`
    SELECT
      COUNT(*) AS total_matched,
      SUM(CASE WHEN [transferred_to] IS NOT NULL AND [transferred_to] <> '' THEN 1 ELSE 0 END) AS transfers,
      SUM(CASE WHEN [dnc_added] = 1 OR UPPER([disposition]) IN ('DNC','DNCL') THEN 1 ELSE 0 END) AS dnc,
      AVG(CAST([avg_ttfb_ms] AS FLOAT)) AS avg_ttfb_ms
    FROM ${calls}
    ${whereSql}
  `);
    const dispoRes = await bind(pool.request()).query(`
    SELECT [disposition], COUNT(*) AS cnt
    FROM ${calls}
    ${whereSql}
    GROUP BY [disposition]
  `);
    const rowsRes = await bind(pool.request())
        .input('limit', mssql_1.default.Int, limit)
        .query(`
      SELECT TOP (@limit)
        [id],[transport],[exten],[caller_code],[lead_id],[phone],
        [campaign_id],[vici_campaign],[agent_id],[agent_name],[greeting_id],[remote_agent_user],
        [started_at],[ended_at],[duration_ms],[turns],[avg_ttfb_ms],
        [disposition],[transferred_to],[dnc_added],[recording_file],[recording_bytes],[synced_at]
      FROM ${calls}
      ${whereSql}
      ORDER BY [started_at] DESC
    `);
    const sumRow = summaryRes.recordset?.[0] || {};
    const byDisposition = {};
    for (const r of dispoRes.recordset || []) {
        const key = String(r.disposition || 'UNSET');
        byDisposition[key] = Number(r.cnt || 0);
    }
    return {
        totalMatched: Number(sumRow.total_matched || 0),
        transfers: Number(sumRow.transfers || 0),
        dnc: Number(sumRow.dnc || 0),
        avgTtfbMs: sumRow.avg_ttfb_ms != null && Number.isFinite(Number(sumRow.avg_ttfb_ms))
            ? Math.round(Number(sumRow.avg_ttfb_ms))
            : null,
        byDisposition,
        calls: rowsRes.recordset || [],
    };
}
