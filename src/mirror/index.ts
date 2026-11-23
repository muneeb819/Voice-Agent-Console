// SQL Server mirror (AWS RDS for SQL Server, managed in SSMS). See docs/SQL-SERVER-MIRROR.md.
export {
  fingerprint, missingSettings, mirrorStatus, requestFullResync, runOnce, setMirrorEnabled, setTargetFactoryForTests,
  startMirror, stopMirror, testMirrorConnection, updateMirrorSettings,
} from './engine';
export { DEFAULT_SETTINGS, loadSettings } from './source';
export type { MirrorSettings } from './source';
export { isValidName } from './sql';

import { DEFAULT_SETTINGS, loadSettings, MirrorSettings } from './source';
import { isValidName } from './sql';

const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}))*$/;
const USER_RE = /^[A-Za-z0-9_.@\\-]{1,128}$/;

/** Validates settings from the console form; returns the merged settings or an error. */
export function parseMirrorSettings(body: any, by: string): { settings?: MirrorSettings; error?: string } {
  const cur = loadSettings();
  const str = (v: unknown, fallback: string) => (typeof v === 'string' ? v.trim() : fallback);
  const host = str(body?.host, cur.host).replace(/:\d+$/, '').replace(/,\d+$/, '');
  const database = str(body?.database, cur.database) || DEFAULT_SETTINGS.database;
  const schema = str(body?.schema, cur.schema) || DEFAULT_SETTINGS.schema;
  const username = str(body?.username, cur.username);
  const port = body?.port === undefined || body?.port === '' ? cur.port : Number(body.port);
  const intervalSec = body?.intervalSec === undefined || body?.intervalSec === '' ? cur.intervalSec : Number(body.intervalSec);
  if (host && !HOST_RE.test(host)) return { error: 'RDS endpoint must be a host name such as mydb.abc123.ap-southeast-2.rds.amazonaws.com.' };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'Port must be a number from 1 to 65535 (RDS uses 1433).' };
  if (!isValidName(database)) return { error: 'Database name may use letters, digits and _ only, starting with a letter.' };
  if (!isValidName(schema)) return { error: 'Schema may use letters, digits and _ only, starting with a letter.' };
  if (username && !USER_RE.test(username)) return { error: 'Username has characters SQL Server logins do not allow.' };
  if (!Number.isInteger(intervalSec) || intervalSec < 2 || intervalSec > 300) return { error: 'Sync interval must be 2 to 300 seconds.' };
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
