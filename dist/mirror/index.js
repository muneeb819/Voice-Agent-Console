"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isValidName = exports.loadSettings = exports.DEFAULT_SETTINGS = exports.updateMirrorSettings = exports.testMirrorConnection = exports.stopMirror = exports.startMirror = exports.setTargetFactoryForTests = exports.setMirrorEnabled = exports.runOnce = exports.requestFullResync = exports.mirrorStatus = exports.missingSettings = exports.fingerprint = void 0;
exports.parseMirrorSettings = parseMirrorSettings;
// SQL Server mirror (AWS RDS for SQL Server, managed in SSMS). See docs/SQL-SERVER-MIRROR.md.
var engine_1 = require("./engine");
Object.defineProperty(exports, "fingerprint", { enumerable: true, get: function () { return engine_1.fingerprint; } });
Object.defineProperty(exports, "missingSettings", { enumerable: true, get: function () { return engine_1.missingSettings; } });
Object.defineProperty(exports, "mirrorStatus", { enumerable: true, get: function () { return engine_1.mirrorStatus; } });
Object.defineProperty(exports, "requestFullResync", { enumerable: true, get: function () { return engine_1.requestFullResync; } });
Object.defineProperty(exports, "runOnce", { enumerable: true, get: function () { return engine_1.runOnce; } });
Object.defineProperty(exports, "setMirrorEnabled", { enumerable: true, get: function () { return engine_1.setMirrorEnabled; } });
Object.defineProperty(exports, "setTargetFactoryForTests", { enumerable: true, get: function () { return engine_1.setTargetFactoryForTests; } });
Object.defineProperty(exports, "startMirror", { enumerable: true, get: function () { return engine_1.startMirror; } });
Object.defineProperty(exports, "stopMirror", { enumerable: true, get: function () { return engine_1.stopMirror; } });
Object.defineProperty(exports, "testMirrorConnection", { enumerable: true, get: function () { return engine_1.testMirrorConnection; } });
Object.defineProperty(exports, "updateMirrorSettings", { enumerable: true, get: function () { return engine_1.updateMirrorSettings; } });
var source_1 = require("./source");
Object.defineProperty(exports, "DEFAULT_SETTINGS", { enumerable: true, get: function () { return source_1.DEFAULT_SETTINGS; } });
Object.defineProperty(exports, "loadSettings", { enumerable: true, get: function () { return source_1.loadSettings; } });
var sql_1 = require("./sql");
Object.defineProperty(exports, "isValidName", { enumerable: true, get: function () { return sql_1.isValidName; } });
const source_2 = require("./source");
const sql_2 = require("./sql");
const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}))*$/;
const USER_RE = /^[A-Za-z0-9_.@\\-]{1,128}$/;
/** Validates settings from the console form; returns the merged settings or an error. */
function parseMirrorSettings(body, by) {
    const cur = (0, source_2.loadSettings)();
    const str = (v, fallback) => (typeof v === 'string' ? v.trim() : fallback);
    const host = str(body?.host, cur.host).replace(/:\d+$/, '').replace(/,\d+$/, '');
    const database = str(body?.database, cur.database) || source_2.DEFAULT_SETTINGS.database;
    const schema = str(body?.schema, cur.schema) || source_2.DEFAULT_SETTINGS.schema;
    const username = str(body?.username, cur.username);
    const port = body?.port === undefined || body?.port === '' ? cur.port : Number(body.port);
    const intervalSec = body?.intervalSec === undefined || body?.intervalSec === '' ? cur.intervalSec : Number(body.intervalSec);
    if (host && !HOST_RE.test(host))
        return { error: 'RDS endpoint must be a host name such as mydb.abc123.ap-southeast-2.rds.amazonaws.com.' };
    if (!Number.isInteger(port) || port < 1 || port > 65535)
        return { error: 'Port must be a number from 1 to 65535 (RDS uses 1433).' };
    if (!(0, sql_2.isValidName)(database))
        return { error: 'Database name may use letters, digits and _ only, starting with a letter.' };
    if (!(0, sql_2.isValidName)(schema))
        return { error: 'Schema may use letters, digits and _ only, starting with a letter.' };
    if (username && !USER_RE.test(username))
        return { error: 'Username has characters SQL Server logins do not allow.' };
    if (!Number.isInteger(intervalSec) || intervalSec < 2 || intervalSec > 300)
        return { error: 'Sync interval must be 2 to 300 seconds.' };
    return {
        settings: {
            ...cur,
            host, port, database, schema, username, intervalSec,
            verifyCert: typeof body?.verifyCert === 'boolean' ? body.verifyCert : cur.verifyCert,
            keepDeleted: typeof body?.keepDeleted === 'boolean' ? body.keepDeleted : cur.keepDeleted,
            updatedAt: new Date().toISOString(),
            updatedBy: by,
        },
    };
}
