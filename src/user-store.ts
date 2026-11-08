import crypto from 'crypto';
import { getDb } from './db';

export type UserRole = 'owner' | 'admin' | 'operator' | 'qa' | 'viewer';

export interface PublicUser {
  id: string;
  role: UserRole;
  email: string;
  fullName: string;
  createdAt: string;
  lastLoginAt: string | null;
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

function ensureSchema(): void {
  if (schemaReady) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'operator',
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_login_at TEXT
    );
    CREATE TABLE IF NOT EXISTS user_sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_sessions_expiry ON user_sessions(expires_at);
    CREATE TABLE IF NOT EXISTS revoked_admin_sessions (
      token_hash TEXT PRIMARY KEY,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_revoked_admin_sessions_expiry ON revoked_admin_sessions(expires_at);
  `);
  const columns = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'role')) {
    db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'operator'");
  }
  // Preserve access for existing installations: promote the oldest account once
  // when migrating a database that predates roles and has no owner yet.
  const hasOwner = db.prepare("SELECT 1 FROM users WHERE role = 'owner' LIMIT 1").get();
  if (!hasOwner) {
    const firstUser = db.prepare('SELECT id FROM users ORDER BY created_at ASC, rowid ASC LIMIT 1').get() as { id: string } | undefined;
    if (firstUser) db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(firstUser.id);
  }
  schemaReady = true;
}

// ---------------------------------------------------------------- passwords

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  if (salt.length === 0 || expected.length === 0) return false;
  let actual: Buffer;
  try {
    actual = crypto.scryptSync(password, salt, expected.length);
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

function rowToUser(row: any): PublicUser {
  return {
    id: String(row.id),
    role: (['owner', 'admin', 'operator', 'qa', 'viewer'].includes(String(row.role)) ? String(row.role) : 'operator') as UserRole,
    email: String(row.email),
    fullName: String(row.full_name),
    createdAt: String(row.created_at),
    lastLoginAt: row.last_login_at ? String(row.last_login_at) : null,
  };
}

export interface CreateUserResult {
  ok: boolean;
  error?: string;
  field?: 'email' | 'fullName' | 'password';
  user?: PublicUser;
}

export function createUser(input: SignupInput, role: UserRole = 'operator'): CreateUserResult {
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
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    return { ok: false, field: 'email', error: 'An account with this email already exists.' };
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    db.prepare(
      'INSERT INTO users (id, email, full_name, role, password_hash, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, NULL)'
    ).run(id, email, fullName, role, hashPassword(password), now);
  } catch (err: any) {
    if (String(err?.message || '').toLowerCase().includes('unique')) {
      return { ok: false, field: 'email', error: 'An account with this email already exists.' };
    }
    throw err;
  }

  return {
    ok: true,
    user: { id, email, fullName, role, createdAt: now, lastLoginAt: null },
  };
}

export function findUserByEmail(rawEmail: unknown): PublicUser | null {
  ensureSchema();
  const email = normalizeEmail(rawEmail);
  if (!email) return null;
  const row = getDb().prepare('SELECT * FROM users WHERE email = ?').get(email);
  return row ? rowToUser(row) : null;
}

export function authenticateUser(rawEmail: unknown, password: string): PublicUser | null {
  ensureSchema();
  const email = normalizeEmail(rawEmail);
  if (!email) return null;
  const row: any = getDb().prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!row) return null;
  if (!verifyPassword(password, String(row.password_hash))) return null;
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

export function createUserSession(userId: string): string {
  ensureSchema();
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  getDb()
    .prepare('INSERT INTO user_sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(
      token,
      userId,
      new Date(now).toISOString(),
      new Date(now + SESSION_TTL_MS).toISOString()
    );
  return token;
}

export function getUserBySessionToken(token?: string | null): PublicUser | null {
  if (!token || token.length < 32 || token.includes('.')) return null;
  ensureSchema();
  const db = getDb();
  const row: any = db.prepare('SELECT * FROM user_sessions WHERE token = ?').get(token);
  if (!row) return null;
  if (new Date(String(row.expires_at)).getTime() <= Date.now()) {
    db.prepare('DELETE FROM user_sessions WHERE token = ?').run(token);
    return null;
  }
  return getUserById(String(row.user_id));
}

export function destroyUserSession(token?: string | null): void {
  if (!token || token.includes('.')) return;
  ensureSchema();
  getDb().prepare('DELETE FROM user_sessions WHERE token = ?').run(token);
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
