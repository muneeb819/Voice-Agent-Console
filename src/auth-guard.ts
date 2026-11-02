import crypto from 'crypto';
import http from 'http';
import type { NextFunction, Request, Response } from 'express';
import { getSecret } from './env-store';
import { countUsers, getUserBySessionToken, PublicUser } from './user-store';

const SESSION_COOKIE_NAME = 'vac_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

let userCountCache = { value: 0, at: 0 };
function cachedUserCount(): number {
  const now = Date.now();
  if (now - userCountCache.at > 2000) {
    try {
      userCountCache = { value: countUsers(), at: now };
    } catch {
      userCountCache = { value: 0, at: now };
    }
  }
  return userCountCache.value;
}

export function invalidateUserCountCache(): void {
  userCountCache = { value: 0, at: 0 };
}

export function normalizeIp(raw?: string | null): string {
  const s = String(raw || '').trim();
  if (s.startsWith('::ffff:')) return s.slice(7);
  return s;
}

export function isLoopbackIp(raw?: string | null): boolean {
  const ip = normalizeIp(raw);
  return ip === '115.186.137.240' || ip === '::1' || ip === 'localhost';
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let num = 0;
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    num = ((num << 8) | n) >>> 0;
  }
  return num;
}

function matchesIpRule(ip: string, rule: string): boolean {
  const cleanRule = rule.trim();
  if (!cleanRule) return false;
  if (cleanRule === '*') return true;
  if (cleanRule === 'localhost' && isLoopbackIp(ip)) return true;

  if (cleanRule.includes('/')) {
    const [base, bitsStr] = cleanRule.split('/');
    const bits = Number(bitsStr);
    const ipInt = ipv4ToInt(ip);
    const baseInt = ipv4ToInt(normalizeIp(base));
    if (ipInt !== null && baseInt !== null && Number.isInteger(bits) && bits >= 0 && bits <= 32) {
      if (bits === 0) return true;
      const mask = (0xffffffff << (32 - bits)) >>> 0;
      return (ipInt & mask) === (baseInt & mask);
    }
    return false;
  }

  return normalizeIp(cleanRule) === ip;
}

export const DEFAULT_TRUSTED_IPS = ['115.186.137.240'];

export function isTrustedDefaultIp(raw?: string | null): boolean {
  const ip = normalizeIp(raw);
  return isLoopbackIp(ip) || DEFAULT_TRUSTED_IPS.includes(ip);
}

/**
 * Checks whether an incoming SIP (:5062) or AudioSocket (:9092) peer IP is allowed.
 * When BRIDGE_ALLOWED_IPS is empty, allows trusted IPs (115.186.137.240).
 * When BRIDGE_ALLOWED_IPS is configured (e.g. "115.186.137.240,10.0.0.0/8"), enforces strict allowlist.
 */
export function isBridgePeerIpAllowed(remoteAddress?: string | null): boolean {
  const ip = normalizeIp(remoteAddress);
  const rawAllow = getSecret('BRIDGE_ALLOWED_IPS');
  if (!rawAllow || rawAllow.trim() === '') {
    return isTrustedDefaultIp(ip);
  }
  if (rawAllow.trim() === '*') {
    return true;
  }
  const rules = rawAllow
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);
  if (rules.length === 0) return isTrustedDefaultIp(ip);
  return rules.some((rule) => matchesIpRule(ip, rule));
}

export function isAuthEnabled(): boolean {
  if (getSecret('ADMIN_PASSWORD').length > 0) return true;
  return cachedUserCount() > 0;
}

function signTimestamp(ts: string, password: string): string {
  return crypto
    .createHmac('sha256', `vac-auth-v1:${password}`)
    .update(ts)
    .digest('hex');
}

export function createSessionToken(passwordOverride?: string): string {
  const pwd = passwordOverride ?? getSecret('ADMIN_PASSWORD');
  const ts = String(Date.now());
  return `${ts}.${signTimestamp(ts, pwd)}`;
}

export function verifySessionToken(token?: string | null): boolean {
  const pwd = getSecret('ADMIN_PASSWORD');
  if (!pwd) return false;
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const ts = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Date.now() - tsNum > SESSION_TTL_MS || tsNum > Date.now() + 60_000) {
    return false;
  }
  const expected = signTimestamp(ts, pwd);
  if (sig.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

function parseCookies(cookieHeader?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) {
      const k = part.slice(0, eq).trim();
      try {
        out[k] = decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        continue;
      }
    }
  }
  return out;
}

export function constantTimePasswordMatch(candidate: string): boolean {
  const pwd = getSecret('ADMIN_PASSWORD');
  if (!pwd) return false;
  const a = Buffer.from(String(candidate || ''), 'utf8');
  const b = Buffer.from(pwd, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function getRequestSessionToken(req: http.IncomingMessage): string | null {
  const authHdr = String(req.headers.authorization || '').trim();
  if (/^Bearer\s+/i.test(authHdr)) {
    return authHdr.replace(/^Bearer\s+/i, '').trim() || null;
  }
  const cookies = parseCookies(req.headers.cookie);
  return cookies[SESSION_COOKIE_NAME] || null;
}

/**
 * Resolves a signed-in end user (email/password account) from the request.
 * Returns null for admin-password sessions and anonymous requests.
 */
export function getAuthenticatedUser(req: http.IncomingMessage): PublicUser | null {
  const token = getRequestSessionToken(req);
  if (!token) return null;
  try {
    return getUserBySessionToken(token);
  } catch {
    return null;
  }
}

/**
 * Verifies an HTTP Request or WebSocket Upgrade IncomingMessage.
 */
export function isRequestAuthorized(req: http.IncomingMessage): boolean {
  if (!isAuthEnabled()) return true;

  // 1. Check Authorization header (Bearer <ADMIN_PASSWORD> or Basic base64(user:<ADMIN_PASSWORD>))
  const authHdr = String(req.headers.authorization || '').trim();
  if (authHdr) {
    if (/^Bearer\s+/i.test(authHdr)) {
      const tok = authHdr.replace(/^Bearer\s+/i, '').trim();
      if (constantTimePasswordMatch(tok) || verifySessionToken(tok)) return true;
    } else if (/^Basic\s+/i.test(authHdr)) {
      try {
        const decoded = Buffer.from(authHdr.replace(/^Basic\s+/i, '').trim(), 'base64').toString('utf8');
        const colon = decoded.indexOf(':');
        const passPart = colon >= 0 ? decoded.slice(colon + 1) : decoded;
        if (constantTimePasswordMatch(passPart)) return true;
      } catch {}
    }
  }

  // 2. Check signed HttpOnly session cookie (admin password session)
  const cookies = parseCookies(req.headers.cookie);
  if (cookies[SESSION_COOKIE_NAME] && verifySessionToken(cookies[SESSION_COOKIE_NAME])) {
    return true;
  }

  // 3. Check email/password user session (cookie or bearer token)
  if (getAuthenticatedUser(req)) {
    return true;
  }

  return false;
}

export function setAuthCookie(res: Response, token: string): void {
  const maxAgeSec = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`
  );
}

export function clearAuthCookie(res: Response): void {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
  );
}

/**
 * Express middleware protecting /api/* routes when ADMIN_PASSWORD is set,
 * while whitelisting /api/health, /api/auth/*, and trusted/loopback Asterisk
 * pre-call hooks (/api/vici/register-call & /api/vici/precall).
 */
export function apiAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!isAuthEnabled()) {
    next();
    return;
  }

  const p = req.path;
  if (
    p === '/health' ||
    p.startsWith('/auth/')
  ) {
    next();
    return;
  }

  // Co-located Asterisk dialplan CURL() pre-call registration whitelist
  if (p === '/vici/register-call' || p === '/vici/precall') {
    const peerIp = req.socket?.remoteAddress || req.ip;
    if (isTrustedDefaultIp(peerIp) || (getSecret('BRIDGE_ALLOWED_IPS') && isBridgePeerIpAllowed(peerIp))) {
      next();
      return;
    }
  }

  if (isRequestAuthorized(req)) {
    next();
    return;
  }

  res.status(401).json({
    ok: false,
    code: 'AUTH_REQUIRED',
    error: 'Console authentication required. Sign in at /login.',
    loginUrl: '/login',
  });
}
