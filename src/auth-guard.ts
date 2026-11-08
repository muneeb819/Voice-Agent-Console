import crypto from 'crypto';
import http from 'http';
import net from 'net';
import type { NextFunction, Request, Response } from 'express';
import { getSecret } from './env-store';
import { countUsers, getUserBySessionToken, isAdminSessionRevoked, PublicUser, revokeAdminSession } from './user-store';

const SESSION_COOKIE_NAME = 'vac_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

let userCountCache = { value: 0, at: 0 };
function cachedUserCount(): number {
  const now = Date.now();
  if (now - userCountCache.at > 2000) {
    try {
      userCountCache = { value: countUsers(), at: now };
    } catch {
      // If the account store is unavailable, fail closed rather than treating
      // the installation as a fresh, unauthenticated one.
      userCountCache = { value: 1, at: now };
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
  const ip = normalizeIp(raw).toLowerCase();
  return ip === 'localhost' || ip === '::1' || (net.isIP(ip) === 4 && ip.startsWith('127.'));
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

export const DEFAULT_TRUSTED_IPS: string[] = [];

export function isTrustedDefaultIp(raw?: string | null): boolean {
  return isLoopbackIp(raw);
}

/**
 * Checks whether an incoming SIP or AudioSocket peer IP is allowed.
 * An empty allowlist permits loopback only. Remote PBX addresses must be
 * explicitly configured with BRIDGE_ALLOWED_IPS.
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

export function hasRegisteredUsers(): boolean {
  return cachedUserCount() > 0;
}

export function isAuthEnabled(): boolean {
  if (getSecret('ADMIN_PASSWORD').length > 0) return true;
  return hasRegisteredUsers();
}

function signTimestamp(ts: string, password: string): string {
  return crypto
    .createHmac('sha256', `vac-auth-v1:${password}`)
    .update(ts)
    .digest('hex');
}

export function createSessionToken(passwordOverride?: string): string {
  const pwd = passwordOverride ?? getSecret('ADMIN_PASSWORD');
  // A nonce prevents simultaneous logins from sharing the same revocable token.
  const payload = `${Date.now()}-${crypto.randomBytes(16).toString('hex')}`;
  return `${payload}.${signTimestamp(payload, pwd)}`;
}

export function verifySessionToken(token?: string | null): boolean {
  const pwd = getSecret('ADMIN_PASSWORD');
  if (!pwd || !token) return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  // Accept older timestamp-only sessions until they expire, too.
  if (!/^\d+(?:-[0-9a-f]{32})?$/.test(payload) || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const tsNum = Number(payload.split('-')[0]);
  if (!Number.isFinite(tsNum) || Date.now() - tsNum > SESSION_TTL_MS || tsNum > Date.now() + 60_000) {
    return false;
  }
  const expected = signTimestamp(payload, pwd);
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  try {
    return !isAdminSessionRevoked(token);
  } catch {
    return false; // An unavailable revocation store must not authorize a session.
  }
}

export function invalidateAdminSession(token?: string | null): void {
  if (!token || !verifySessionToken(token)) return;
  const issuedAt = Number(token.slice(0, token.indexOf('.')).split('-')[0]);
  revokeAdminSession(token, issuedAt + SESSION_TTL_MS);
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

function extractQueryToken(req: http.IncomingMessage): string | null {
  const rawUrl = String(req.url || '');
  const qIdx = rawUrl.indexOf('?');
  if (qIdx < 0) return null;
  try {
    const params = new URLSearchParams(rawUrl.slice(qIdx + 1));
    const tok = (params.get('vac_token') || params.get('token') || '').trim();
    return tok || null;
  } catch {
    return null;
  }
}

export function getRequestSessionToken(req: http.IncomingMessage): string | null {
  const authHdr = String(req.headers.authorization || '').trim();
  if (/^Bearer\s+/i.test(authHdr)) {
    return authHdr.replace(/^Bearer\s+/i, '').trim() || null;
  }
  const cookies = parseCookies(req.headers.cookie);
  if (cookies[SESSION_COOKIE_NAME]) {
    return cookies[SESSION_COOKIE_NAME];
  }
  return extractQueryToken(req);
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
 * Checks whether the request carries an explicit user account session or admin-password session.
 * Used to gate the web UI entry page (`/`) so Sign Up / Sign In is always shown first,
 * even before the first user account is created.
 */
export function hasActiveAuthSession(req: http.IncomingMessage): boolean {
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

  // 2. Check signed HttpOnly session cookie or query handoff token (admin password session)
  const cookies = parseCookies(req.headers.cookie);
  if (cookies[SESSION_COOKIE_NAME] && verifySessionToken(cookies[SESSION_COOKIE_NAME])) {
    return true;
  }
  const queryTok = extractQueryToken(req);
  if (queryTok && (constantTimePasswordMatch(queryTok) || verifySessionToken(queryTok))) {
    return true;
  }

  // 3. Check email/password user session (cookie, bearer token, or query handoff token)
  if (getAuthenticatedUser(req)) {
    return true;
  }

  return false;
}

function hasForwardingHeaders(req: http.IncomingMessage): boolean {
  return ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'cf-connecting-ip']
    .some((name) => Boolean(req.headers[name]));
}

// A browser can resolve an attacker-controlled hostname to loopback (DNS
// rebinding). Socket address alone is therefore insufficient for exemptions.
function hasLoopbackHost(req: http.IncomingMessage): boolean {
  try {
    const url = new URL(`http://${String(req.headers.host || '')}`);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return false;
    return isLoopbackIp(url.hostname.replace(/^\[|\]$/g, ''));
  } catch {
    return false;
  }
}

/**
 * Verifies an HTTP Request or WebSocket Upgrade IncomingMessage.
 */
export function isRequestAuthorized(req: http.IncomingMessage): boolean {
  if (!isAuthEnabled()) {
    // Fresh installations may be initialized directly on loopback only.
    // A reverse proxy/tunnel can also connect from loopback, so reject proxy
    // hints during bootstrap rather than mistaking its remote clients for local.
    return isLoopbackIp(req.socket?.remoteAddress) && hasLoopbackHost(req) && !hasForwardingHeaders(req);
  }
  return hasActiveAuthSession(req);
}

function isHttpsRequest(req?: http.IncomingMessage): boolean {
  if (!req) return false;

  const expressReq = req as Request;

  // Trust the actual TLS connection first.
  if (expressReq.secure === true || Boolean((req.socket as any)?.encrypted)) {
    return true;
  }

  // Never trust forwarded protocol headers from arbitrary clients.
  const trustProxy = expressReq.app?.get?.('trust proxy fn') as
    | ((address: string, hop: number) => boolean)
    | undefined;
  const peerAddress = req.socket?.remoteAddress;

  if (!peerAddress || !trustProxy || !trustProxy(peerAddress, 0)) {
    return false;
  }

  const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .find(Boolean);

  return forwardedProto === 'https';
}

/**
 * Sets the HttpOnly session cookie for seven days with SameSite=Lax.
 * Secure is added when the request is recognized as HTTPS; without a request
 * it is omitted. Replaces any existing Set-Cookie header on the response.
 * Throws URIError if the token contains an unpaired surrogate.
 */
export function setAuthCookie(res: Response, token: string, req?: http.IncomingMessage): void {
  const maxAgeSec = Math.floor(SESSION_TTL_MS / 1000);
  const cookiePolicy = isHttpsRequest(req) ? 'SameSite=Lax; Secure' : 'SameSite=Lax';
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; ${cookiePolicy}; Max-Age=${maxAgeSec}`
  );
}

export function clearAuthCookie(res: Response, req?: http.IncomingMessage): void {
  const cookiePolicy = isHttpsRequest(req)
    ? 'SameSite=None; Secure; Partitioned'
    : 'SameSite=Lax';
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; ${cookiePolicy}; Max-Age=0`
  );
}

/**
 * Protects API routes, allowing health, auth, and eligible direct Asterisk
 * pre-call hooks through before authorization. Other requests require a session
 * or the direct loopback bootstrap exemption. Selected routes require owner or
 * admin access; viewers may otherwise use only GET and HEAD. An authorized
 * request with no resolved account is treated as owner. Responds with 401 for
 * unauthorized requests and 403 for role restrictions.
 */
export function apiAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
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
    // Proxy requests must authenticate; a public reverse proxy may itself
    // connect from loopback and must not inherit the local PBX exemption.
    if (!hasForwardingHeaders(req) && isBridgePeerIpAllowed(peerIp) &&
        (!isLoopbackIp(peerIp) || hasLoopbackHost(req))) {
      next();
      return;
    }
  }

  if (isRequestAuthorized(req)) {
    const account = getAuthenticatedUser(req);
    const role = account?.role || 'owner'; // legacy ADMIN_PASSWORD session is owner-equivalent
    const adminOnly =
      p === '/secrets' ||
      p === '/state/reset' ||
      p === '/demo-tunnel/start' ||
      p === '/demo-tunnel/stop' ||
      p === '/vici/deploy-script' ||
      p === '/vici/release-bundle' ||
      p === '/functions/test-webhook' ||
      p === '/speech-service/activate' ||
      p === '/speech-service/test' ||
      p === '/vici/verify' ||
      /^\/vici\/calls\/[^/]+\/(?:hangup|transfer)$/.test(p);
    const readOnly = req.method === 'GET' || req.method === 'HEAD';
    if (adminOnly && role !== 'owner' && role !== 'admin') {
      res.status(403).json({ ok: false, code: 'FORBIDDEN', error: 'Administrator permission required.' });
      return;
    }
    if (role === 'viewer' && !readOnly) {
      res.status(403).json({ ok: false, code: 'FORBIDDEN', error: 'This account has read-only access.' });
      return;
    }
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
