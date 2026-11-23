"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MssqlTarget = exports.CA_BUNDLE_URL = void 0;
exports.caBundlePath = caBundlePath;
exports.ensureCaBundle = ensureCaBundle;
exports.explainSqlError = explainSqlError;
exports.setSqlDriverForTests = setSqlDriverForTests;
// SQL Server side of the mirror (AWS RDS for SQL Server, managed in SSMS).
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const data_paths_1 = require("../data-paths");
const sql_1 = require("./sql");
exports.CA_BUNDLE_URL = 'https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem';
function caBundlePath() {
    return process.env.MSSQL_CA_FILE?.trim() || path_1.default.join(data_paths_1.DATA_DIR, 'rds-global-bundle.pem');
}
/** Downloads the AWS RDS certificate bundle once, so the server certificate can be verified. */
async function ensureCaBundle() {
    const file = caBundlePath();
    if (fs_1.default.existsSync(file) && fs_1.default.statSync(file).size > 1000)
        return file;
    const res = await fetch(exports.CA_BUNDLE_URL);
    if (!res.ok)
        throw new Error(`Could not download the AWS RDS certificate bundle (HTTP ${res.status}).`);
    const pem = await res.text();
    if (!pem.includes('BEGIN CERTIFICATE'))
        throw new Error('The AWS RDS certificate bundle download was not a certificate file.');
    fs_1.default.mkdirSync(path_1.default.dirname(file), { recursive: true });
    fs_1.default.writeFileSync(file, pem, { mode: 0o644 });
    return file;
}
/** Plain-language hints for the errors people hit when connecting to RDS. */
function explainSqlError(err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/ETIMEOUT|ESOCKET|ECONNREFUSED|timeout|ENOTFOUND|EAI_AGAIN|Failed to connect|Could not connect/i.test(msg)) {
        return `${msg} — the console cannot reach the RDS endpoint. Check the endpoint and port, and that the RDS security group allows TCP 1433 from this server.`;
    }
    if (/Login failed/i.test(msg))
        return `${msg} — check the username and password.`;
    if (/certificate|self[- ]signed|unable to verify|altnames|CERT_/i.test(msg)) {
        return `${msg} — use the RDS endpoint name (not an IP address) so the certificate matches.`;
    }
    return msg;
}
let sqlModule = null;
/** Tests replace the driver with a recording fake. */
function setSqlDriverForTests(driver) { sqlModule = driver; }
function driver() {
    if (!sqlModule) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        sqlModule = require('mssql');
    }
    return sqlModule;
}
function paramType(sql, spec, colName) {
    const col = spec.columns.find((c) => c.name === colName);
    const isKey = spec.pk.includes(colName);
    switch (col.kind) {
        case 'int': return sql.BigInt;
        case 'real': return sql.Float;
        case 'blob': return sql.VarBinary(isKey ? 450 : sql.MAX);
        default: return sql.NVarChar(isKey ? (0, sql_1.textKeyLength)(spec) : sql.MAX);
    }
}
function paramValue(v) {
    if (v === undefined)
        return null;
    if (typeof v === 'bigint')
        return v.toString();
    if (v instanceof Uint8Array && !Buffer.isBuffer(v))
        return Buffer.from(v);
    return v;
}
class MssqlTarget {
    cfg;
    pool = null;
    columns = new Map();
    constructor(cfg) {
        this.cfg = cfg;
    }
    async poolConfig(database) {
        const options = {
            encrypt: true,
            trustServerCertificate: !this.cfg.verifyCert,
            appName: 'VoiceAgentConsole-mirror',
        };
        if (this.cfg.verifyCert) {
            const file = await ensureCaBundle();
            options.cryptoCredentialsDetails = { ca: fs_1.default.readFileSync(file, 'utf8') };
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
    async open() {
        const sql = driver();
        let createdDatabase = false;
        try {
            this.pool = await new sql.ConnectionPool(await this.poolConfig(this.cfg.database)).connect();
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!/Cannot open database|4060/i.test(msg))
                throw err;
            // A new RDS instance only has master: create the database, then reconnect.
            const master = await new sql.ConnectionPool(await this.poolConfig('master')).connect();
            try {
                await master.request().query((0, sql_1.createDatabaseSql)(this.cfg.database));
                createdDatabase = true;
            }
            finally {
                await master.close();
            }
            this.pool = await new sql.ConnectionPool(await this.poolConfig(this.cfg.database)).connect();
        }
        await this.pool.request().query((0, sql_1.ensureSchemaSql)(this.cfg.schema));
        const v = await this.pool.request().query(`SELECT CAST(SERVERPROPERTY('ProductVersion') AS NVARCHAR(64)) AS v, CAST(SERVERPROPERTY('Edition') AS NVARCHAR(128)) AS e`);
        const row = v.recordset?.[0] || {};
        return { version: `SQL Server ${row.v || '?'} (${row.e || 'unknown edition'})`, createdDatabase };
    }
    async ensureTable(spec) {
        const sql = driver();
        let have = this.columns.get(spec.name);
        if (!have) {
            await this.pool.request().query((0, sql_1.createTableSql)(this.cfg.schema, spec));
            const r = await this.pool.request().input('obj', sql.NVarChar(300), (0, sql_1.objectName)(this.cfg.schema, spec.name)).query((0, sql_1.listColumnsSql)());
            have = new Set((r.recordset || []).map((x) => x.name.toLowerCase()));
            this.columns.set(spec.name, have);
        }
        let added = false;
        for (const col of spec.columns) {
            if (have.has(col.name.toLowerCase()))
                continue;
            await this.pool.request().query((0, sql_1.addColumnSql)(this.cfg.schema, spec, col));
            have.add(col.name.toLowerCase());
            added = true;
        }
        return added;
    }
    async apply(spec, change) {
        const sql = driver();
        const tx = new sql.Transaction(this.pool);
        await tx.begin();
        try {
            if (change.truncate)
                await new sql.Request(tx).query((0, sql_1.deleteAllSql)(this.cfg.schema, spec));
            const per = (0, sql_1.rowsPerStatement)(spec);
            for (let i = 0; i < change.upserts.length; i += per) {
                const chunk = change.upserts.slice(i, i + per);
                const req = new sql.Request(tx);
                chunk.forEach((row, r) => spec.columns.forEach((c, ci) => req.input((0, sql_1.paramName)(r, ci), paramType(sql, spec, c.name), paramValue(row[c.name]))));
                await req.query((0, sql_1.upsertBatchSql)(this.cfg.schema, spec, chunk.length));
            }
            const perDel = Math.max(1, Math.floor(2000 / spec.pk.length));
            for (let i = 0; i < change.deletes.length; i += perDel) {
                const chunk = change.deletes.slice(i, i + perDel);
                const req = new sql.Request(tx);
                chunk.forEach((key, r) => spec.pk.forEach((k, ki) => req.input(`k${r}_${ki}`, paramType(sql, spec, k), paramValue(key[ki]))));
                await req.query((0, sql_1.deleteBatchSql)(this.cfg.schema, spec, chunk.length));
            }
            await tx.commit();
        }
        catch (err) {
            try {
                await tx.rollback();
            }
            catch { /* already rolled back */ }
            throw err;
        }
    }
    async ensureViews(tables) {
        const made = [];
        for (const v of (0, sql_1.reportingViewsSql)(this.cfg.schema, tables)) {
            try {
                await this.pool.request().batch(v.sql);
                made.push(v.name);
            }
            catch {
                // Views are a convenience; a failure must not stop the data copy.
            }
        }
        return made;
    }
    async close() {
        const p = this.pool;
        this.pool = null;
        this.columns.clear();
        if (p)
            await p.close().catch(() => { });
    }
}
exports.MssqlTarget = MssqlTarget;
