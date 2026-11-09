"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isValidEmail = isValidEmail;
exports.normalizeEmail = normalizeEmail;
exports.normalizeFullName = normalizeFullName;
exports.validatePassword = validatePassword;
exports.validateFullName = validateFullName;
exports.createUser = createUser;
exports.findUserByEmail = findUserByEmail;
exports.authenticateUser = authenticateUser;
exports.countUsers = countUsers;
exports.getUserById = getUserById;
exports.createUserSession = createUserSession;
exports.getUserBySessionToken = getUserBySessionToken;
exports.destroyUserSession = destroyUserSession;
exports.revokeAllUserSessions = revokeAllUserSessions;
exports.purgeExpiredSessions = purgeExpiredSessions;
exports.isAdminSessionRevoked = isAdminSessionRevoked;
exports.revokeAdminSession = revokeAdminSession;
exports.listUsers = listUsers;
exports.countUserSessions = countUserSessions;
exports.destroyUserSessions = destroyUserSessions;
exports.changeUserPassword = changeUserPassword;
exports.setUserActive = setUserActive;
exports.setUserRole = setUserRole;
const crypto_1 = __importDefault(require("crypto"));
const db_1 = require("./db");
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Password-only administrative access needs length, not composition rules.
// Existing shorter hashes keep working; only new/changed passwords are gated.
const MIN_PASSWORD_LENGTH = 15;
const MAX_PASSWORD_LENGTH = 200;
const MAX_NAME_LENGTH = 80;
let schemaReady = false;
/**
 * Creates the account and session tables and adds missing role and active
 * columns. When adding roles, the oldest account becomes owner and the others
 * default to operator. Database errors propagate to the caller.
 */
function ensureSchema() {
    if (schemaReady)
        return;
    const db = (0, db_1.getDb)();
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
    const columns = db.prepare('PRAGMA table_info(users)').all();
    if (!columns.some((column) => column.name === 'role')) {
        db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'operator'");
        const first = db.prepare('SELECT id FROM users ORDER BY created_at ASC, id ASC LIMIT 1').get();
        if (first?.id)
            db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(first.id);
    }
    if (!columns.some((column) => column.name === 'active'))
        db.exec('ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
    schemaReady = true;
}
// ---------------------------------------------------------------- passwords
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const scryptAsync = (password, salt, keylen) => new Promise((resolve, reject) => {
    crypto_1.default.scrypt(password, salt, keylen, SCRYPT_OPTIONS, (err, derived) => err ? reject(err) : resolve(derived));
});
async function hashPassword(password) {
    const salt = crypto_1.default.randomBytes(16);
    const hash = await scryptAsync(password, salt, 64);
    return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
async function verifyPassword(password, stored) {
    const parts = String(stored || '').split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt')
        return false;
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    if (salt.length < 16 || salt.length > 64 || expected.length !== 64)
        return false;
    let actual;
    try {
        actual = await scryptAsync(password, salt, 64);
    }
    catch {
        return false;
    }
    if (actual.length !== expected.length)
        return false;
    return crypto_1.default.timingSafeEqual(actual, expected);
}
// ---------------------------------------------------------------- validation
function isValidEmail(email) {
    if (!email || email.length > 254)
        return false;
    if (email.includes('..'))
        return false;
    return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(email);
}
function normalizeEmail(raw) {
    return String(raw ?? '').trim().toLowerCase();
}
function normalizeFullName(raw) {
    return String(raw ?? '')
        .replace(/\s+/g, ' ')
        .trim();
}
function validatePassword(raw) {
    const pw = String(raw ?? '');
    if (pw.length < MIN_PASSWORD_LENGTH) {
        return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    }
    if (pw.length > MAX_PASSWORD_LENGTH) {
        return `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`;
    }
    return null;
}
function validateFullName(raw) {
    const name = normalizeFullName(raw);
    if (name.length < 2)
        return 'Please enter your full name.';
    if (name.length > MAX_NAME_LENGTH)
        return `Full name must be at most ${MAX_NAME_LENGTH} characters.`;
    if (!/[A-Za-z\u00C0-\u024F]/.test(name))
        return 'Full name must contain letters.';
    return null;
}
// ---------------------------------------------------------------- users
/** Converts a user row to its public form, defaulting unknown roles to operator and a missing active value to active. */
function rowToUser(row) {
    return {
        id: String(row.id),
        email: String(row.email),
        fullName: String(row.full_name),
        createdAt: String(row.created_at),
        lastLoginAt: row.last_login_at ? String(row.last_login_at) : null,
        role: (['owner', 'admin', 'operator', 'qa', 'viewer'].includes(String(row.role)) ? String(row.role) : 'operator'),
        active: Number(row.active ?? 1) === 1,
    };
}
/**
 * Creates an active account, assigning owner when there are no users and
 * operator otherwise. Returns a field error for invalid input or a duplicate
 * email; other database or password hashing errors can propagate.
 */
async function createUser(input) {
    ensureSchema();
    const email = normalizeEmail(input.email);
    const fullName = normalizeFullName(input.fullName);
    const password = String(input.password ?? '');
    if (!isValidEmail(email)) {
        return { ok: false, field: 'email', error: 'Enter a valid email address.' };
    }
    const nameErr = validateFullName(fullName);
    if (nameErr)
        return { ok: false, field: 'fullName', error: nameErr };
    const pwErr = validatePassword(password);
    if (pwErr)
        return { ok: false, field: 'password', error: pwErr };
    const db = (0, db_1.getDb)();
    const id = crypto_1.default.randomUUID();
    const now = new Date().toISOString();
    // Hash off the event loop, then decide ownership and insert under one write
    // lock. Two simultaneous first signups must not both become owner.
    const passwordHash = await hashPassword(password);
    try {
        const role = db.transactionImmediate(() => {
            const count = Number(db.prepare('SELECT COUNT(*) AS n FROM users').get()?.n || 0);
            const assigned = count === 0 ? 'owner' : 'operator';
            db.prepare('INSERT INTO users (id, email, full_name, password_hash, created_at, last_login_at, role, active) VALUES (?, ?, ?, ?, ?, NULL, ?, 1)').run(id, email, fullName, passwordHash, now, assigned);
            return assigned;
        })();
        return { ok: true, user: { id, email, fullName, createdAt: now, lastLoginAt: null, role, active: true } };
    }
    catch (err) {
        if (String(err?.message || '').toLowerCase().includes('unique')) {
            return { ok: false, field: 'email', error: 'An account with this email already exists.' };
        }
        throw err;
    }
}
function findUserByEmail(rawEmail) {
    ensureSchema();
    const email = normalizeEmail(rawEmail);
    if (!email)
        return null;
    const row = (0, db_1.getDb)().prepare('SELECT * FROM users WHERE email = ?').get(email);
    return row ? rowToUser(row) : null;
}
/**
 * Authenticates an active account and updates its last login time. Returns null
 * for a missing account, inactive account, or invalid credentials. Database
 * errors propagate.
 */
async function authenticateUser(rawEmail, password) {
    ensureSchema();
    const email = normalizeEmail(rawEmail);
    if (!email)
        return null;
    const row = (0, db_1.getDb)().prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!row)
        return null;
    if (Number(row.active ?? 1) !== 1 || !(await verifyPassword(password, String(row.password_hash))))
        return null;
    const active = Number((0, db_1.getDb)().prepare('SELECT active FROM users WHERE id = ?').get(row.id)?.active ?? 0);
    if (active !== 1)
        return null;
    const now = new Date().toISOString();
    (0, db_1.getDb)().prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, row.id);
    const user = rowToUser(row);
    user.lastLoginAt = now;
    return user;
}
function countUsers() {
    ensureSchema();
    const row = (0, db_1.getDb)().prepare('SELECT COUNT(*) AS n FROM users').get();
    return Number(row?.n || 0);
}
function getUserById(id) {
    ensureSchema();
    const row = (0, db_1.getDb)().prepare('SELECT * FROM users WHERE id = ?').get(id);
    return row ? rowToUser(row) : null;
}
// ---------------------------------------------------------------- sessions
function userSessionHash(token) {
    return crypto_1.default.createHash('sha256').update(token).digest('hex');
}
function createUserSession(userId) {
    ensureSchema();
    const token = crypto_1.default.randomBytes(32).toString('hex');
    const now = Date.now();
    (0, db_1.getDb)()
        .prepare('INSERT INTO user_sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
        .run(userSessionHash(token), userId, new Date(now).toISOString(), new Date(now + SESSION_TTL_MS).toISOString());
    return token;
}
/**
 * Resolves a user session to an active account, or returns null for a rejected,
 * unknown, or expired token or a missing or inactive account. Deletes an expired
 * session; database errors propagate.
 */
function getUserBySessionToken(token) {
    if (!token || token.length < 32 || token.includes('.'))
        return null;
    ensureSchema();
    const db = (0, db_1.getDb)();
    const hashed = userSessionHash(token);
    let row = db.prepare('SELECT * FROM user_sessions WHERE token = ?').get(hashed);
    if (!row && /^[a-f0-9]{64}$/.test(token)) {
        row = db.prepare('SELECT * FROM user_sessions WHERE token = ?').get(token);
        if (row)
            db.prepare('UPDATE user_sessions SET token = ? WHERE token = ?').run(hashed, token);
    }
    if (!row)
        return null;
    if (new Date(String(row.expires_at)).getTime() <= Date.now()) {
        db.prepare('DELETE FROM user_sessions WHERE token = ?').run(hashed);
        return null;
    }
    const user = getUserById(String(row.user_id));
    return user?.active ? user : null;
}
function destroyUserSession(token) {
    if (!token || token.includes('.'))
        return;
    ensureSchema();
    (0, db_1.getDb)().prepare('DELETE FROM user_sessions WHERE token = ? OR token = ?').run(userSessionHash(token), token);
}
/**
 * Revokes every session for one user. Retained as the name used by
 * POST /api/auth/logout-all; it delegates to destroyUserSessions so session
 * revocation has a single implementation rather than two that can drift.
 */
function revokeAllUserSessions(userId) {
    if (!userId)
        return 0;
    return destroyUserSessions(userId);
}
function purgeExpiredSessions() {
    ensureSchema();
    const now = new Date().toISOString();
    (0, db_1.getDb)().prepare('DELETE FROM user_sessions WHERE expires_at <= ?').run(now);
    (0, db_1.getDb)().prepare('DELETE FROM revoked_admin_sessions WHERE expires_at <= ?').run(now);
}
function sessionTokenHash(token) {
    return crypto_1.default.createHash('sha256').update(token).digest('hex');
}
function isAdminSessionRevoked(token) {
    ensureSchema();
    return Boolean((0, db_1.getDb)().prepare('SELECT 1 FROM revoked_admin_sessions WHERE token_hash = ?').get(sessionTokenHash(token)));
}
function revokeAdminSession(token, expiresAt) {
    ensureSchema();
    (0, db_1.getDb)()
        .prepare('INSERT OR REPLACE INTO revoked_admin_sessions (token_hash, expires_at) VALUES (?, ?)')
        .run(sessionTokenHash(token), new Date(expiresAt).toISOString());
}
// ------------------------------------------------- account & session lifecycle
/** Lists accounts newest-last for the administrator account screen. */
function listUsers() {
    ensureSchema();
    const rows = (0, db_1.getDb)().prepare('SELECT * FROM users ORDER BY created_at ASC, id ASC').all();
    return rows.map(rowToUser);
}
/** Counts unexpired sessions per account so revocation can be verified in the UI. */
function countUserSessions(userId) {
    ensureSchema();
    const row = (0, db_1.getDb)()
        .prepare('SELECT COUNT(*) AS n FROM user_sessions WHERE user_id = ? AND expires_at > ?')
        .get(userId, new Date().toISOString());
    return Number(row?.n || 0);
}
function countActiveOwners() {
    const row = (0, db_1.getDb)()
        .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND active = 1")
        .get();
    return Number(row?.n || 0);
}
/**
 * Deletes every session for an account, optionally keeping the caller's own
 * session so a password change does not sign out the tab that performed it.
 * Returns the number of sessions removed.
 */
function destroyUserSessions(userId, keepToken) {
    ensureSchema();
    const db = (0, db_1.getDb)();
    if (keepToken && !keepToken.includes('.')) {
        const result = db
            .prepare('DELETE FROM user_sessions WHERE user_id = ? AND token != ?')
            .run(userId, userSessionHash(keepToken));
        return Number(result.changes || 0);
    }
    const result = db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(userId);
    return Number(result.changes || 0);
}
/**
 * Changes an account password after verifying the current one, then revokes
 * every other session so a stolen session cannot outlive the change.
 */
async function changeUserPassword(userId, currentPassword, newPassword, keepToken) {
    ensureSchema();
    const row = (0, db_1.getDb)().prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!row)
        return { ok: false, error: 'Account not found.' };
    if (Number(row.active ?? 1) !== 1)
        return { ok: false, error: 'This account is disabled.' };
    if (!(await verifyPassword(String(currentPassword ?? ''), String(row.password_hash)))) {
        return { ok: false, field: 'currentPassword', error: 'Current password is incorrect.' };
    }
    const validation = validatePassword(newPassword);
    if (validation)
        return { ok: false, field: 'newPassword', error: validation };
    if (String(currentPassword ?? '') === String(newPassword ?? '')) {
        return { ok: false, field: 'newPassword', error: 'Choose a different password from the current one.' };
    }
    const passwordHash = await hashPassword(String(newPassword));
    const db = (0, db_1.getDb)();
    // Re-read under the write lock: the account may have been disabled or the
    // password changed by another tab while hashing was in flight.
    const revoked = db.transactionImmediate(() => {
        const current = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
        if (!current || Number(current.active ?? 1) !== 1)
            return null;
        if (String(current.password_hash) !== String(row.password_hash))
            return null;
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
        return destroyUserSessions(userId, keepToken);
    })();
    if (revoked === null) {
        return { ok: false, error: 'The account changed while updating the password. Sign in again and retry.' };
    }
    return { ok: true, revokedSessions: revoked, user: getUserById(userId) || undefined };
}
/** Enables or disables an account. Disabling immediately revokes its sessions. */
function setUserActive(userId, active) {
    ensureSchema();
    const db = (0, db_1.getDb)();
    return db.transactionImmediate(() => {
        const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
        if (!row)
            return { ok: false, error: 'Account not found.' };
        if (!active && String(row.role) === 'owner' && Number(row.active ?? 1) === 1 && countActiveOwners() <= 1) {
            return { ok: false, field: 'active', error: 'The last active owner cannot be disabled.' };
        }
        db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, userId);
        const revokedSessions = active ? 0 : destroyUserSessions(userId);
        return { ok: true, revokedSessions, user: getUserById(userId) || undefined };
    })();
}
/** Changes an account role. The last active owner cannot be demoted. */
function setUserRole(userId, role) {
    ensureSchema();
    if (!['owner', 'admin', 'operator', 'qa', 'viewer'].includes(role)) {
        return { ok: false, field: 'role', error: 'Unknown role.' };
    }
    const db = (0, db_1.getDb)();
    return db.transactionImmediate(() => {
        const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
        if (!row)
            return { ok: false, error: 'Account not found.' };
        if (String(row.role) === 'owner' && role !== 'owner' && Number(row.active ?? 1) === 1 && countActiveOwners() <= 1) {
            return { ok: false, field: 'role', error: 'The last active owner cannot be demoted.' };
        }
        db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);
        // A demotion must not leave a live session with the previous privileges.
        const revokedSessions = role === 'viewer' || role === 'qa' ? destroyUserSessions(userId) : 0;
        return { ok: true, revokedSessions, user: getUserById(userId) || undefined };
    })();
}
