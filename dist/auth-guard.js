"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeIp = normalizeIp;
exports.isLoopbackIp = isLoopbackIp;
exports.isBridgePeerIpAllowed = isBridgePeerIpAllowed;
exports.isAuthEnabled = isAuthEnabled;
exports.createSessionToken = createSessionToken;
exports.verifySessionToken = verifySessionToken;
exports.constantTimePasswordMatch = constantTimePasswordMatch;
exports.isRequestAuthorized = isRequestAuthorized;
exports.setAuthCookie = setAuthCookie;
exports.clearAuthCookie = clearAuthCookie;
exports.apiAuthMiddleware = apiAuthMiddleware;
const crypto_1 = __importDefault(require("crypto"));
const env_store_1 = require("./env-store");
const SESSION_COOKIE_NAME = 'vac_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
function normalizeIp(raw) {
    const s = String(raw || '').trim();
    if (s.startsWith('::ffff:'))
        return s.slice(7);
    return s;
}
function isLoopbackIp(raw) {
    const ip = normalizeIp(raw);
    return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}
function ipv4ToInt(ip) {
    const parts = ip.split('.');
    if (parts.length !== 4)
        return null;
    let num = 0;
    for (const p of parts) {
        const n = Number(p);
        if (!Number.isInteger(n) || n < 0 || n > 255)
            return null;
        num = ((num << 8) | n) >>> 0;
    }
    return num;
}
function matchesIpRule(ip, rule) {
    const cleanRule = rule.trim();
    if (!cleanRule)
        return false;
    if (cleanRule === '*')
        return true;
    if (cleanRule === 'localhost' && isLoopbackIp(ip))
        return true;
    if (cleanRule.includes('/')) {
        const [base, bitsStr] = cleanRule.split('/');
        const bits = Number(bitsStr);
        const ipInt = ipv4ToInt(ip);
        const baseInt = ipv4ToInt(normalizeIp(base));
        if (ipInt !== null && baseInt !== null && Number.isInteger(bits) && bits >= 0 && bits <= 32) {
            if (bits === 0)
                return true;
            const mask = (0xffffffff << (32 - bits)) >>> 0;
            return (ipInt & mask) === (baseInt & mask);
        }
        return false;
    }
    return normalizeIp(cleanRule) === ip;
}
/**
 * Checks whether an incoming SIP (:5062) or AudioSocket (:9092) peer IP is allowed.
 * When BRIDGE_ALLOWED_IPS is empty, allows all peers (dev/cloud test mode).
 * When BRIDGE_ALLOWED_IPS is configured (e.g. "127.0.0.1,::1,10.0.0.0/8"), enforces strict allowlist.
 */
function isBridgePeerIpAllowed(remoteAddress) {
    const ip = normalizeIp(remoteAddress);
    const rawAllow = (0, env_store_1.getSecret)('BRIDGE_ALLOWED_IPS');
    if (!rawAllow || rawAllow.trim() === '' || rawAllow.trim() === '*') {
        return true;
    }
    const rules = rawAllow
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean);
    if (rules.length === 0)
        return true;
    return rules.some((rule) => matchesIpRule(ip, rule));
}
function isAuthEnabled() {
    return (0, env_store_1.getSecret)('ADMIN_PASSWORD').length > 0;
}
function signTimestamp(ts, password) {
    return crypto_1.default
        .createHmac('sha256', `vac-auth-v1:${password}`)
        .update(ts)
        .digest('hex');
}
function createSessionToken(passwordOverride) {
    const pwd = passwordOverride ?? (0, env_store_1.getSecret)('ADMIN_PASSWORD');
    const ts = String(Date.now());
    return `${ts}.${signTimestamp(ts, pwd)}`;
}
function verifySessionToken(token) {
    const pwd = (0, env_store_1.getSecret)('ADMIN_PASSWORD');
    if (!pwd)
        return true;
    if (!token)
        return false;
    const dot = token.indexOf('.');
    if (dot <= 0)
        return false;
    const ts = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const tsNum = Number(ts);
    if (!Number.isFinite(tsNum) || Date.now() - tsNum > SESSION_TTL_MS || tsNum > Date.now() + 60_000) {
        return false;
    }
    const expected = signTimestamp(ts, pwd);
    if (sig.length !== expected.length)
        return false;
    return crypto_1.default.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}
function parseCookies(cookieHeader) {
    const out = {};
    if (!cookieHeader)
        return out;
    for (const part of cookieHeader.split(';')) {
        const eq = part.indexOf('=');
        if (eq > 0) {
            const k = part.slice(0, eq).trim();
            const v = decodeURIComponent(part.slice(eq + 1).trim());
            out[k] = v;
        }
    }
    return out;
}
function constantTimePasswordMatch(candidate) {
    const pwd = (0, env_store_1.getSecret)('ADMIN_PASSWORD');
    if (!pwd)
        return true;
    const a = Buffer.from(String(candidate || ''), 'utf8');
    const b = Buffer.from(pwd, 'utf8');
    if (a.length !== b.length)
        return false;
    return crypto_1.default.timingSafeEqual(a, b);
}
/**
 * Verifies an HTTP Request or WebSocket Upgrade IncomingMessage.
 */
function isRequestAuthorized(req) {
    if (!isAuthEnabled())
        return true;
    // 1. Check Authorization header (Bearer <ADMIN_PASSWORD> or Basic base64(user:<ADMIN_PASSWORD>))
    const authHdr = String(req.headers.authorization || '').trim();
    if (authHdr) {
        if (/^Bearer\s+/i.test(authHdr)) {
            const tok = authHdr.replace(/^Bearer\s+/i, '').trim();
            if (constantTimePasswordMatch(tok) || verifySessionToken(tok))
                return true;
        }
        else if (/^Basic\s+/i.test(authHdr)) {
            try {
                const decoded = Buffer.from(authHdr.replace(/^Basic\s+/i, '').trim(), 'base64').toString('utf8');
                const colon = decoded.indexOf(':');
                const passPart = colon >= 0 ? decoded.slice(colon + 1) : decoded;
                if (constantTimePasswordMatch(passPart))
                    return true;
            }
            catch { }
        }
    }
    // 2. Check signed HttpOnly session cookie
    const cookies = parseCookies(req.headers.cookie);
    if (cookies[SESSION_COOKIE_NAME] && verifySessionToken(cookies[SESSION_COOKIE_NAME])) {
        return true;
    }
    return false;
}
function setAuthCookie(res, token) {
    const maxAgeSec = Math.floor(SESSION_TTL_MS / 1000);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`);
}
function clearAuthCookie(res) {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
/**
 * Express middleware protecting /api/* routes when ADMIN_PASSWORD is set,
 * while whitelisting /api/health, /api/auth/*, and trusted/loopback Asterisk
 * pre-call hooks (/api/vici/register-call & /api/vici/precall).
 */
function apiAuthMiddleware(req, res, next) {
    if (!isAuthEnabled()) {
        next();
        return;
    }
    const p = req.path;
    if (p === '/health' ||
        p.startsWith('/auth/')) {
        next();
        return;
    }
    // Co-located Asterisk dialplan CURL() pre-call registration whitelist
    if (p === '/vici/register-call' || p === '/vici/precall') {
        const peerIp = req.socket?.remoteAddress || req.ip;
        if (isLoopbackIp(peerIp) || ((0, env_store_1.getSecret)('BRIDGE_ALLOWED_IPS') && isBridgePeerIpAllowed(peerIp))) {
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
        error: 'Console authentication required. Sign in with ADMIN_PASSWORD.',
    });
}
