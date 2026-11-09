"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_TRUSTED_IPS = void 0;
exports.invalidateUserCountCache = invalidateUserCountCache;
exports.normalizeIp = normalizeIp;
exports.isLoopbackIp = isLoopbackIp;
exports.isTrustedDefaultIp = isTrustedDefaultIp;
exports.isBridgePeerIpAllowed = isBridgePeerIpAllowed;
exports.hasRegisteredUsers = hasRegisteredUsers;
exports.isAuthEnabled = isAuthEnabled;
exports.createSessionToken = createSessionToken;
exports.verifySessionToken = verifySessionToken;
exports.invalidateAdminSession = invalidateAdminSession;
exports.constantTimePasswordMatch = constantTimePasswordMatch;
exports.getRequestSessionToken = getRequestSessionToken;
exports.getAuthenticatedUser = getAuthenticatedUser;
exports.hasActiveAuthSession = hasActiveAuthSession;
exports.isRequestAuthorized = isRequestAuthorized;
exports.setAuthCookie = setAuthCookie;
exports.clearAuthCookie = clearAuthCookie;
exports.apiAuthMiddleware = apiAuthMiddleware;
const crypto_1 = __importDefault(require("crypto"));
const net_1 = __importDefault(require("net"));
const env_store_1 = require("./env-store");
const user_store_1 = require("./user-store");
const SESSION_COOKIE_NAME = 'vac_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
let userCountCache = { value: 0, at: 0 };
function cachedUserCount() {
    const now = Date.now();
    if (now - userCountCache.at > 2000) {
        try {
            userCountCache = { value: (0, user_store_1.countUsers)(), at: now };
        }
        catch {
            // If the account store is unavailable, fail closed rather than treating
            // the installation as a fresh, unauthenticated one.
            userCountCache = { value: 1, at: now };
        }
    }
    return userCountCache.value;
}
function invalidateUserCountCache() {
    userCountCache = { value: 0, at: 0 };
}
function normalizeIp(raw) {
    const s = String(raw || '').trim();
    if (s.startsWith('::ffff:'))
        return s.slice(7);
    return s;
}
function isLoopbackIp(raw) {
    const ip = normalizeIp(raw).toLowerCase();
    return ip === 'localhost' || ip === '::1' || (net_1.default.isIP(ip) === 4 && ip.startsWith('127.'));
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
exports.DEFAULT_TRUSTED_IPS = [];
function isTrustedDefaultIp(raw) {
    return isLoopbackIp(raw);
}
/**
 * Checks whether an incoming SIP or AudioSocket peer IP is allowed.
 * An empty allowlist permits loopback only. Remote PBX addresses must be
 * explicitly configured with BRIDGE_ALLOWED_IPS.
 */
function isBridgePeerIpAllowed(remoteAddress) {
    const ip = normalizeIp(remoteAddress);
    const rawAllow = (0, env_store_1.getSecret)('BRIDGE_ALLOWED_IPS');
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
    if (rules.length === 0)
        return isTrustedDefaultIp(ip);
    return rules.some((rule) => matchesIpRule(ip, rule));
}
function hasRegisteredUsers() {
    return cachedUserCount() > 0;
}
function isAuthEnabled() {
    if ((0, env_store_1.getSecret)('ADMIN_PASSWORD').length > 0)
        return true;
    return hasRegisteredUsers();
}
function signTimestamp(ts, password) {
    return crypto_1.default
        .createHmac('sha256', `vac-auth-v1:${password}`)
        .update(ts)
        .digest('hex');
}
function createSessionToken(passwordOverride) {
    const pwd = passwordOverride ?? (0, env_store_1.getSecret)('ADMIN_PASSWORD');
    // A nonce prevents simultaneous logins from sharing the same revocable token.
    const payload = `${Date.now()}-${crypto_1.default.randomBytes(16).toString('hex')}`;
    return `${payload}.${signTimestamp(payload, pwd)}`;
}
function verifySessionToken(token) {
    const pwd = (0, env_store_1.getSecret)('ADMIN_PASSWORD');
    if (!pwd || !token)
        return false;
    const dot = token.indexOf('.');
    if (dot <= 0)
        return false;
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    // Accept older timestamp-only sessions until they expire, too.
    if (!/^\d+(?:-[0-9a-f]{32})?$/.test(payload) || !/^[0-9a-f]{64}$/.test(sig))
        return false;
    const tsNum = Number(payload.split('-')[0]);
    if (!Number.isFinite(tsNum) || Date.now() - tsNum > SESSION_TTL_MS || tsNum > Date.now() + 60_000) {
        return false;
    }
    const expected = signTimestamp(payload, pwd);
    if (!crypto_1.default.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)))
        return false;
    try {
        return !(0, user_store_1.isAdminSessionRevoked)(token);
    }
    catch {
        return false; // An unavailable revocation store must not authorize a session.
    }
}
function invalidateAdminSession(token) {
    if (!token || !verifySessionToken(token))
        return;
    const issuedAt = Number(token.slice(0, token.indexOf('.')).split('-')[0]);
    (0, user_store_1.revokeAdminSession)(token, issuedAt + SESSION_TTL_MS);
}
function parseCookies(cookieHeader) {
    const out = {};
    if (!cookieHeader)
        return out;
    for (const part of cookieHeader.split(';')) {
        const eq = part.indexOf('=');
        if (eq > 0) {
            const k = part.slice(0, eq).trim();
            try {
                out[k] = decodeURIComponent(part.slice(eq + 1).trim());
            }
            catch {
                continue;
            }
        }
    }
    return out;
}
function constantTimePasswordMatch(candidate) {
    const pwd = (0, env_store_1.getSecret)('ADMIN_PASSWORD');
    if (!pwd)
        return false;
    const a = Buffer.from(String(candidate || ''), 'utf8');
    const b = Buffer.from(pwd, 'utf8');
    if (a.length !== b.length)
        return false;
    return crypto_1.default.timingSafeEqual(a, b);
}
/** Resolves an explicit machine-client bearer credential or first-party cookie.
 * Query-string credentials are deliberately ignored to keep secrets out of URLs.
 */
function getRequestSessionToken(req) {
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
function getAuthenticatedUser(req) {
    const token = getRequestSessionToken(req);
    if (!token)
        return null;
    try {
        return (0, user_store_1.getUserBySessionToken)(token);
    }
    catch {
        return null;
    }
}
/**
 * Checks whether the request carries an explicit user account session or admin-password session.
 * Used to gate the web UI entry page (`/`) so Sign Up / Sign In is always shown first,
 * even before the first user account is created.
 */
function hasActiveAuthSession(req) {
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
    // 2. Check the signed HttpOnly admin-password session cookie.
    const cookies = parseCookies(req.headers.cookie);
    if (cookies[SESSION_COOKIE_NAME] && verifySessionToken(cookies[SESSION_COOKIE_NAME])) {
        return true;
    }
    // 3. Check an email/password user session from a cookie or explicit bearer header.
    if (getAuthenticatedUser(req)) {
        return true;
    }
    return false;
}
function hasForwardingHeaders(req) {
    return ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'cf-connecting-ip']
        .some((name) => Boolean(req.headers[name]));
}
// A browser can resolve an attacker-controlled hostname to loopback (DNS
// rebinding). Socket address alone is therefore insufficient for exemptions.
function hasLoopbackHost(req) {
    try {
        const url = new URL(`http://${String(req.headers.host || '')}`);
        if (url.username || url.password || url.pathname !== '/' || url.search || url.hash)
            return false;
        return isLoopbackIp(url.hostname.replace(/^\[|\]$/g, ''));
    }
    catch {
        return false;
    }
}
/**
 * Verifies an HTTP Request or WebSocket Upgrade IncomingMessage.
 */
function isRequestAuthorized(req) {
    if (!isAuthEnabled()) {
        // Fresh installations may be initialized directly on loopback only.
        // A reverse proxy/tunnel can also connect from loopback, so reject proxy
        // hints during bootstrap rather than mistaking its remote clients for local.
        return isLoopbackIp(req.socket?.remoteAddress) && hasLoopbackHost(req) && !hasForwardingHeaders(req);
    }
    return hasActiveAuthSession(req);
}
function isHttpsRequest(req) {
    if (!req)
        return false;
    const expressReq = req;
    // Trust the actual TLS connection first.
    if (expressReq.secure === true || Boolean(req.socket?.encrypted)) {
        return true;
    }
    // Never trust forwarded protocol headers from arbitrary clients.
    const trustProxy = expressReq.app?.get?.('trust proxy fn');
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
function setAuthCookie(res, token, req) {
    const maxAgeSec = Math.floor(SESSION_TTL_MS / 1000);
    const cookiePolicy = isHttpsRequest(req) ? 'SameSite=Lax; Secure' : 'SameSite=Lax';
    res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; ${cookiePolicy}; Max-Age=${maxAgeSec}`);
}
/** Expires the first-party session cookie using the same security policy as login. */
function clearAuthCookie(res, req) {
    const cookiePolicy = isHttpsRequest(req) ? 'SameSite=Lax; Secure' : 'SameSite=Lax';
    res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; ${cookiePolicy}; Max-Age=0`);
}
/**
 * Protects API routes, allowing health, auth, and eligible direct Asterisk
 * pre-call hooks through before authorization. Other requests require a session
 * or the direct loopback bootstrap exemption. Selected routes require owner or
 * admin access; viewers may otherwise use only GET and HEAD. An authorized
 * request with no resolved account is treated as owner. Responds with 401 for
 * unauthorized requests and 403 for role restrictions.
 */
function apiAuthMiddleware(req, res, next) {
    // Express route matching is case-insensitive and tolerates a trailing slash.
    // Authorization must use the same canonical shape, or /SECRETS/ bypasses it.
    const p = req.path.toLowerCase().replace(/\/+$/, '') || '/';
    if (p === '/health' ||
        p.startsWith('/auth/')) {
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
        const adminOnly = p === '/secrets' ||
            p === '/users' ||
            /^\/users\/[^/]+\/(?:status|role|revoke-sessions)$/.test(p) ||
            p === '/state/reset' ||
            p === '/demo-tunnel/start' ||
            p === '/demo-tunnel/stop' ||
            p === '/vici/deploy-script' ||
            p === '/vici/release-bundle' ||
            p === '/functions/test-webhook' ||
            p === '/speech-service/activate' ||
            p === '/speech-service/test' ||
            p === '/vici/verify' ||
            p === '/deepgram/verify' ||
            (p === '/speech-service/status' && (req.query.url !== undefined || req.query.apiKey !== undefined)) ||
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
