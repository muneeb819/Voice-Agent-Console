import crypto from 'crypto';
import { getDb } from './db';

export interface PublicUser {
  id: string;
  email: string;
  fullName: string;
  createdAt: string;
  lastLoginAt: string | null;
  role: 'owner' | 'admin' | 'operator' | 'qa' | 'viewer';
  active: boolean;
}

export interface SignupInput {
  email?: unknown;
  fullName?: unknown;
  password?: unknown;
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 200;
const MAX_NAME_LENGTH = 80;

let schemaReady = false;

/**
 * Creates the account and session tables and adds missing role and active
 * columns. When adding roles, the oldest account becomes owner and the others
 * default to operator. Database errors propagate to the caller.
 */
function ensureSchema(): void {
  if (schemaReady) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      full_name TEXT NOT NULL, password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL, last_login_at TEXT
    );
    CREATE TABLE IF NOT EXISTS user_sessions (
      token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_sessions_expiry ON user_sessions(expires_at);
    CREATE TABLE IF NOT EXISTS revoked_admin_sessions (token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_revoked_admin_sessions_expiry ON revoked_admin_sessions(expires_at);
  `);
  const columns = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'role')) {
    db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'operator'");
    const first = db.prepare('SELECT id FROM users ORDER BY created_at ASC, id ASC LIMIT 1').get() as { id?: string } | undefined;
    if (first?.id) db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(first.id);
  }
  if (!columns.some((column) => column.name === 'active')) db.exec('ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
  schemaReady = true;
}

// ---------------------------------------------------------------- passwords

const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const scryptAsync = (password: string, salt: Buffer, keylen: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, SCRYPT_OPTIONS, (err, derived) => err ? reject(err) : resolve(derived));
  });

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  if (salt.length < 16 || salt.length > 64 || expected.length !== 64) return false;
  let actual: Buffer;
  try {
    actual = await scryptAsync(password, salt, 64);
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------- validation

export function isValidEmail(email: string): boolean {
  if (!email || email.length > 254) return false;
  if (email.includes('..')) return false;
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(email);
}

export function normalizeEmail(raw: unknown): string {
  return String(raw ?? '').trim().toLowerCase();
}

export function normalizeFullName(raw: unknown): string {
  return String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function validatePassword(raw: unknown): string | null {
  const pw = String(raw ?? '');
  if (pw.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (pw.length > MAX_PASSWORD_LENGTH) {
    return `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`;
  }
  return null;
}

export function validateFullName(raw: unknown): string | null {
  const name = normalizeFullName(raw);
  if (name.length < 2) return 'Please enter your full name.';
  if (name.length > MAX_NAME_LENGTH) return `Full name must be at most ${MAX_NAME_LENGTH} characters.`;
  if (!/[A-Za-z\u00C0-\u024F]/.test(name)) return 'Full name must contain letters.';
  return null;
}

// ---------------------------------------------------------------- users

/** Converts a user row to its public form, defaulting unknown roles to operator and a missing active value to active. */
function rowToUser(row: any): PublicUser {
  return {
    id: String(row.id),
    email: String(row.email),
    fullName: String(row.full_name),
    createdAt: String(row.created_at),
    lastLoginAt: row.last_login_at ? String(row.last_login_at) : null,
    role: (['owner', 'admin', 'operator', 'qa', 'viewer'].includes(String(row.role)) ? String(row.role) : 'operator') as PublicUser['role'],
    active: Number(row.active ?? 1) === 1,
  };
}

export interface CreateUserResult {
  ok: boolean;
  error?: string;
  field?: 'email' | 'fullName' | 'password';
  user?: PublicUser;
}

/**
 * Creates an active account, assigning owner when there are no users and
 * operator otherwise. Returns a field error for invalid input or a duplicate
 * email; other database or password hashing errors can propagate.
 */
export async function createUser(input: SignupInput): Promise<CreateUserResult> {
  ensureSchema();

  const email = normalizeEmail(input.email);
  const fullName = normalizeFullName(input.fullName);
  const password = String(input.password ?? '');

  if (!isValidEmail(email)) {
    return { ok: false, field: 'email', error: 'Enter a valid email address.' };
  }
  const nameErr = validateFullName(fullName);
  if (nameErr) return { ok: false, field: 'fullName', error: nameErr };
  const pwErr = validatePassword(password);
  if (pwErr) return { ok: false, field: 'password', error: pwErr };

  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  // Hash off the event loop, then decide ownership and insert under one write
  // lock. Two simultaneous first signups must not both become owner.
  const passwordHash = await hashPassword(password);
  try {
    const role = db.transactionImmediate(() => {
      const count = Number((db.prepare('SELECT COUNT(*) AS n FROM users').get() as any)?.n || 0);
      const assigned: PublicUser['role'] = count === 0 ? 'owner' : 'operator';
      db.prepare(
        'INSERT INTO users (id, email, full_name, password_hash, created_at, last_login_at, role, active) VALUES (?, ?, ?, ?, ?, NULL, ?, 1)'
      ).run(id, email, fullName, passwordHash, now, assigned);
      return assigned;
    })();
    return { ok: true, user: { id, email, fullName, createdAt: now, lastLoginAt: null, role, active: true } };
  } catch (err: any) {
    if (String(err?.message || '').toLowerCase().includes('unique')) {
      return { ok: false, field: 'email', error: 'An account with this email already exists.' };
    }
    throw err;
  }
}

export function findUserByEmail(rawEmail: unknown): PublicUser | null {
  ensureSchema();
  const email = normalizeEmail(rawEmail);
  if (!email) return null;
  const row = getDb().prepare('SELECT * FROM users WHERE email = ?').get(email);
  return row ? rowToUser(row) : null;
}

/**
 * Authenticates an active account and updates its last login time. Returns null
 * for a missing account, inactive account, or invalid credentials. Database
 * errors propagate.
 */
export async function authenticateUser(rawEmail: unknown, password: string): Promise<PublicUser | null> {
  ensureSchema();
  const email = normalizeEmail(rawEmail);
  if (!email) return null;
  const row: any = getDb().prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!row) return null;
  if (Number(row.active ?? 1) !== 1 || !(await verifyPassword(password, String(row.password_hash)))) return null;
  const active = Number((getDb().prepare('SELECT active FROM users WHERE id = ?').get(row.id) as any)?.active ?? 0);
  if (active !== 1) return null;
  const now = new Date().toISOString();
  getDb().prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, row.id);
  const user = rowToUser(row);
  user.lastLoginAt = now;
  return user;
}

export function countUsers(): number {
  ensureSchema();
  const row: any = getDb().prepare('SELECT COUNT(*) AS n FROM users').get();
  return Number(row?.n || 0);
}

export function getUserById(id: string): PublicUser | null {
  ensureSchema();
  const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
  return row ? rowToUser(row) : null;
}

// ---------------------------------------------------------------- sessions

function userSessionHash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function createUserSession(userId: string): string {
  ensureSchema();
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  getDb()
    .prepare('INSERT INTO user_sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(
      userSessionHash(token),
      userId,
      new Date(now).toISOString(),
      new Date(now + SESSION_TTL_MS).toISOString()
    );
  return token;
}

/**
 * Resolves a user session to an active account, or returns null for a rejected,
 * unknown, or expired token or a missing or inactive account. Deletes an expired
 * session; database errors propagate.
 */
export function getUserBySessionToken(token?: string | null): PublicUser | null {
  if (!token || token.length < 32 || token.includes('.')) return null;
  ensureSchema();
  const db = getDb();
  const hashed = userSessionHash(token);
  let row: any = db.prepare('SELECT * FROM user_sessions WHERE token = ?').get(hashed);
  if (!row && /^[a-f0-9]{64}$/.test(token)) {
    row = db.prepare('SELECT * FROM user_sessions WHERE token = ?').get(token);
    if (row) db.prepare('UPDATE user_sessions SET token = ? WHERE token = ?').run(hashed, token);
  }
  if (!row) return null;
  if (new Date(String(row.expires_at)).getTime() <= Date.now()) {
    db.prepare('DELETE FROM user_sessions WHERE token = ?').run(hashed);
    return null;
  }
  const user = getUserById(String(row.user_id));
  return user?.active ? user : null;
}

export function destroyUserSession(token?: string | null): void {
  if (!token || token.includes('.')) return;
  ensureSchema();
  getDb().prepare('DELETE FROM user_sessions WHERE token = ? OR token = ?').run(userSessionHash(token), token);
}

export function purgeExpiredSessions(): void {
  ensureSchema();
  const now = new Date().toISOString();
  getDb().prepare('DELETE FROM user_sessions WHERE expires_at <= ?').run(now);
  getDb().prepare('DELETE FROM revoked_admin_sessions WHERE expires_at <= ?').run(now);
}

function sessionTokenHash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function isAdminSessionRevoked(token: string): boolean {
  ensureSchema();
  return Boolean(getDb().prepare('SELECT 1 FROM revoked_admin_sessions WHERE token_hash = ?').get(sessionTokenHash(token)));
}

export function revokeAdminSession(token: string, expiresAt: number): void {
  ensureSchema();
  getDb()
    .prepare('INSERT OR REPLACE INTO revoked_admin_sessions (token_hash, expires_at) VALUES (?, ?)')
    .run(sessionTokenHash(token), new Date(expiresAt).toISOString());
}
