"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.asyncRoute = asyncRoute;
exports.createApp = createApp;
exports.createServerWithSimulator = createServerWithSimulator;
const dns_1 = __importDefault(require("dns"));
const fs_1 = __importDefault(require("fs"));
const http_1 = __importDefault(require("http"));
const net_1 = __importDefault(require("net"));
const path_1 = __importDefault(require("path"));
const express_1 = __importDefault(require("express"));
dns_1.default.setDefaultResultOrder('ipv4first');
if (typeof net_1.default.setDefaultAutoSelectFamily === 'function') {
    net_1.default.setDefaultAutoSelectFamily(false);
}
const ami_client_1 = require("./ami-client");
const auth_guard_1 = require("./auth-guard");
const call_recorder_1 = require("./call-recorder");
const release_bundle_1 = require("./release-bundle");
const request_origin_1 = require("./request-origin");
const db_1 = require("./db");
const defaults_1 = require("./defaults");
const data_paths_1 = require("./data-paths");
const deepgram_catalog_1 = require("./deepgram-catalog");
const env_store_1 = require("./env-store");
const live_simulator_1 = require("./live-simulator");
const simulator_recordings_1 = require("./simulator-recordings");
const settings_builder_1 = require("./settings-builder");
const campaign_assignment_1 = require("./campaign-assignment");
const vici_bridge_1 = require("./vici-bridge");
const vici_client_1 = require("./vici-client");
const vici_loopback_tester_1 = require("./vici-loopback-tester");
const webhook_executor_1 = require("./webhook-executor");
const user_store_1 = require("./user-store");
const demo_tunnel_1 = require("./demo-tunnel");
const speech_service_client_1 = require("./speech-service-client");
(0, env_store_1.loadEnv)();
function asyncRoute(handler) {
    return (req, res, next) => { void Promise.resolve(handler(req, res, next)).catch(next); };
}
function createApp(viciBridge) {
    const app = (0, express_1.default)();
    // Proxy headers are untrusted by default. Configure only known proxy IPs or
    // CIDRs (for example TRUST_PROXY=loopback) when running behind a proxy.
    const trustedProxies = String(process.env.TRUST_PROXY || '').trim();
    if (trustedProxies)
        app.set('trust proxy', trustedProxies.split(',').map((x) => x.trim()).filter(Boolean));
    const loginAttempts = new Map();
    const loginIpAttempts = new Map();
    const signupAttempts = new Map();
    const loginWindowMs = 15 * 60 * 1000;
    const loginAttemptLimit = 5;
    const signupAttemptLimit = 10;
    app.use((req, res, next) => {
        // Avoid leaking console URLs to external providers or sample hosts.
        res.setHeader('Referrer-Policy', 'no-referrer');
        // Session cookies are first-party (SameSite=Lax).
        // Do not grant cross-origin API access, and reject browser requests with a
        // mismatched Origin even when they would not need a CORS preflight.
        const requestPath = new URL(req.originalUrl || req.url || '/', 'http://local.invalid').pathname.toLowerCase();
        const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
        if (requestPath.startsWith('/api/') && (site === 'cross-site' || (site === 'same-site' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)))) {
            res.status(403).json({ ok: false, code: 'CROSS_SITE_REQUEST_BLOCKED', error: 'Cross-site API requests are not allowed.' });
            return;
        }
        if (requestPath.startsWith('/api/') && !(0, request_origin_1.isSameOriginRequest)(req, app.get('trust proxy fn'))) {
            res.status(403).json({ ok: false, error: 'Cross-origin API requests are not allowed.' });
            return;
        }
        // Pre-call GET hooks intentionally support Asterisk CURL without auth.
        // An image/navigation request may have no Origin, so also reject browser
        // fetches to these endpoints from another site or origin.
        const fetchSite = req.get('sec-fetch-site');
        if ((requestPath === '/api/vici/register-call' || requestPath === '/api/vici/precall') &&
            fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
            res.status(403).json({ ok: false, error: 'Cross-origin pre-call requests are not allowed.' });
            return;
        }
        if (req.method === 'OPTIONS') {
            res.status(204).end();
            return;
        }
        next();
    });
    app.use(express_1.default.json({ limit: '4mb' }));
    app.use(express_1.default.urlencoded({ extended: false }));
    if (process.env.VAC_DEBUG === '1') {
        app.use((req, res, next) => {
            const started = Date.now();
            res.on('finish', () => {
                console.log(`[VAC:DEBUG] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - started}ms)`);
            });
            next();
        });
    }
    // ==================== STEP 4: AUTHENTICATION ROUTES & GUARD ====================
    const rateKey = (req, subKey = '') => {
        // Express resolves req.ip using only explicitly trusted proxies. Never
        // accept client-supplied X-Forwarded-For / CF-Connecting-IP directly.
        const baseIp = String(req.ip || req.socket?.remoteAddress || 'unknown');
        return subKey ? `${baseIp}:${subKey}` : baseIp;
    };
    /** Allows direct bootstrap or an active session with an owner, admin, or no resolved account. */
    const canCreateAccount = (req) => {
        if (!(0, auth_guard_1.isAuthEnabled)() && (0, auth_guard_1.isRequestAuthorized)(req))
            return true;
        if (!(0, auth_guard_1.hasActiveAuthSession)(req))
            return false;
        const account = (0, auth_guard_1.getAuthenticatedUser)(req);
        // Legacy ADMIN_PASSWORD sessions remain owner-equivalent for recovery.
        return !account || account.role === 'owner' || account.role === 'admin';
    };
    const rateLimited = (key, bucket = loginAttempts, limit = loginAttemptLimit) => {
        const now = Date.now();
        const attempts = bucket.get(key);
        if (attempts && attempts.resetAt <= now) {
            bucket.delete(key);
            return { limited: false, retryAfter: 0 };
        }
        if (attempts && attempts.count >= limit) {
            return { limited: true, retryAfter: Math.max(1, Math.ceil((attempts.resetAt - now) / 1000)) };
        }
        return { limited: false, retryAfter: 0 };
    };
    const noteFailure = (key, bucket = loginAttempts) => {
        const now = Date.now();
        let attempts = bucket.get(key);
        if (!attempts || attempts.resetAt <= now) {
            if (bucket.size >= 1000) {
                const oldestIp = bucket.keys().next().value;
                if (oldestIp)
                    bucket.delete(oldestIp);
            }
            attempts = { count: 0, resetAt: now + loginWindowMs };
            bucket.set(key, attempts);
        }
        attempts.count += 1;
    };
    app.get('/api/auth/status', (req, res) => {
        const user = (0, auth_guard_1.getAuthenticatedUser)(req);
        const sessionAuth = (0, auth_guard_1.hasActiveAuthSession)(req);
        const hasUsers = (0, auth_guard_1.hasRegisteredUsers)();
        res.json({
            ok: true,
            authEnabled: true,
            apiAuthEnforced: (0, auth_guard_1.isAuthEnabled)(),
            hasUsers,
            adminPasswordConfigured: (0, env_store_1.getSecret)('ADMIN_PASSWORD').length > 0,
            authenticated: sessionAuth,
            user,
            signupOpen: canCreateAccount(req),
        });
    });
    app.get('/api/auth/me', (req, res) => {
        const user = (0, auth_guard_1.getAuthenticatedUser)(req);
        if (!user) {
            res.status(401).json({ ok: false, code: 'AUTH_REQUIRED', error: 'Not signed in.' });
            return;
        }
        res.json({ ok: true, user });
    });
    // Create a new account (email + full name + password) and sign in immediately.
    app.post('/api/auth/signup', asyncRoute(async (req, res) => {
        if (!canCreateAccount(req)) {
            res.status(403).json({
                ok: false,
                code: 'SIGNUP_CLOSED',
                error: 'Account creation requires an existing signed-in operator. Contact your administrator.',
            });
            return;
        }
        const key = rateKey(req);
        const gate = rateLimited(key, signupAttempts, signupAttemptLimit);
        if (gate.limited) {
            res.setHeader('Retry-After', String(gate.retryAfter));
            res.status(429).json({ ok: false, code: 'SIGNUP_RATE_LIMITED', error: 'Too many attempts. Try again later.' });
            return;
        }
        const result = await (0, user_store_1.createUser)(req.body || {});
        if (!result.ok || !result.user) {
            noteFailure(key, signupAttempts);
            res.status(400).json({
                ok: false,
                code: 'SIGNUP_INVALID',
                field: result.field || null,
                error: result.error || 'Unable to create account.',
            });
            return;
        }
        loginAttempts.delete(key);
        signupAttempts.delete(key);
        (0, auth_guard_1.invalidateUserCountCache)();
        (0, user_store_1.purgeExpiredSessions)();
        // Preserve an existing administrator's session when provisioning an account.
        // Only the first loopback bootstrap account needs an automatically issued session.
        if (!(0, auth_guard_1.hasActiveAuthSession)(req)) {
            const token = (0, user_store_1.createUserSession)(result.user.id);
            (0, auth_guard_1.setAuthCookie)(res, token, req);
        }
        res.status(201).json({
            ok: true,
            authEnabled: true,
            authenticated: true,
            user: result.user,
        });
    }));
    app.post('/api/auth/login', asyncRoute(async (req, res) => {
        const ip = req.socket?.remoteAddress || 'unknown';
        const ipNow = Date.now();
        let ipBucket = loginIpAttempts.get(ip);
        if (!ipBucket || ipBucket.resetAt <= ipNow) {
            if (loginIpAttempts.size >= 1000 && !loginIpAttempts.has(ip))
                loginIpAttempts.delete(loginIpAttempts.keys().next().value);
            ipBucket = { count: 0, resetAt: ipNow + 60_000 };
            loginIpAttempts.set(ip, ipBucket);
        }
        if (++ipBucket.count > 30) {
            res.setHeader('Retry-After', String(Math.max(1, Math.ceil((ipBucket.resetAt - ipNow) / 1000))));
            res.status(429).json({ ok: false, code: 'RATE_LIMITED', error: 'Too many sign-in attempts. Please wait a minute.' });
            return;
        }
        const email = String(req.body?.email ?? '').trim();
        const candidate = String(req.body?.password ?? '');
        const key = rateKey(req, email ? email.toLowerCase() : 'admin');
        const gate = rateLimited(key);
        if (gate.limited) {
            res.setHeader('Retry-After', String(gate.retryAfter));
            res.status(429).json({ ok: false, code: 'LOGIN_RATE_LIMITED', error: 'Too many failed sign-in attempts. Try again later.' });
            return;
        }
        // --- Email/password account sign-in ---
        if (email) {
            const user = await (0, user_store_1.authenticateUser)(email, candidate);
            if (!user) {
                noteFailure(key);
                res.status(401).json({ ok: false, code: 'INVALID_CREDENTIALS', error: 'Invalid email or password.' });
                return;
            }
            loginAttempts.delete(key);
            const token = (0, user_store_1.createUserSession)(user.id);
            (0, auth_guard_1.setAuthCookie)(res, token, req);
            res.json({ ok: true, authEnabled: true, authenticated: true, user });
            return;
        }
        // --- Legacy admin password sign-in ---
        if (!(0, env_store_1.getSecret)('ADMIN_PASSWORD')) {
            res.status(400).json({
                ok: false,
                code: 'ADMIN_PASSWORD_NOT_CONFIGURED',
                error: 'ADMIN_PASSWORD is not configured in server .env. Sign in with your email account or create an account.',
            });
            return;
        }
        if (!(0, auth_guard_1.constantTimePasswordMatch)(candidate)) {
            noteFailure(key);
            res.status(401).json({ ok: false, code: 'INVALID_PASSWORD', error: 'Invalid admin password' });
            return;
        }
        loginAttempts.delete(key);
        const token = (0, auth_guard_1.createSessionToken)();
        (0, auth_guard_1.setAuthCookie)(res, token, req);
        res.json({ ok: true, authEnabled: true, authenticated: true });
    }));
    app.post('/api/auth/logout', (req, res) => {
        const token = (0, auth_guard_1.getRequestSessionToken)(req);
        (0, auth_guard_1.invalidateAdminSession)(token);
        (0, user_store_1.destroyUserSession)(token);
        (0, auth_guard_1.clearAuthCookie)(res, req);
        res.json({ ok: true, authEnabled: true, authenticated: false });
    });
    app.use('/api', auth_guard_1.apiAuthMiddleware);
    // ---------------- account security: password change and session revocation
    // Registered after apiAuthMiddleware. /api/auth/* is intentionally reachable
    // before authentication, so each handler below re-resolves the account from
    // the session itself; no client supplied identifier can act on another
    // account. /api/users/* additionally passes the middleware adminOnly check.
    app.post('/api/auth/change-password', asyncRoute(async (req, res) => {
        const account = (0, auth_guard_1.getAuthenticatedUser)(req);
        if (!account) {
            res.status(403).json({
                ok: false,
                code: 'ACCOUNT_REQUIRED',
                error: 'Sign in with an email account to change a password. The server ADMIN_PASSWORD is changed in .env.',
            });
            return;
        }
        const ip = req.socket?.remoteAddress || 'unknown';
        const key = `${ip}:password-change:${account.id}`;
        const gate = rateLimited(key, loginAttempts);
        if (gate.limited) {
            res.setHeader('Retry-After', String(gate.retryAfter));
            res.status(429).json({ ok: false, code: 'RATE_LIMITED', error: 'Too many attempts. Try again later.' });
            return;
        }
        const result = await (0, user_store_1.changeUserPassword)(account.id, String(req.body?.currentPassword ?? ''), String(req.body?.newPassword ?? ''), (0, auth_guard_1.getRequestSessionToken)(req));
        if (!result.ok) {
            if (result.field === 'currentPassword')
                noteFailure(key, loginAttempts);
            res.status(result.field ? 400 : 409).json({
                ok: false,
                code: 'PASSWORD_CHANGE_FAILED',
                field: result.field || null,
                error: result.error || 'Unable to change the password.',
            });
            return;
        }
        loginAttempts.delete(key);
        res.json({
            ok: true,
            user: result.user,
            revokedSessions: result.revokedSessions ?? 0,
            message: 'Password updated. Other devices were signed out.',
        });
    }));
    app.post('/api/auth/revoke-sessions', (req, res) => {
        const account = (0, auth_guard_1.getAuthenticatedUser)(req);
        if (!account) {
            res.status(403).json({ ok: false, code: 'ACCOUNT_REQUIRED', error: 'Sign in with an email account first.' });
            return;
        }
        const keepCurrent = req.body?.keepCurrent !== false;
        const revoked = (0, user_store_1.destroyUserSessions)(account.id, keepCurrent ? (0, auth_guard_1.getRequestSessionToken)(req) : null);
        if (!keepCurrent)
            (0, auth_guard_1.clearAuthCookie)(res, req);
        res.json({ ok: true, revokedSessions: revoked, authenticated: keepCurrent });
    });
    app.get('/api/auth/sessions', (req, res) => {
        const account = (0, auth_guard_1.getAuthenticatedUser)(req);
        if (!account) {
            res.status(403).json({ ok: false, code: 'ACCOUNT_REQUIRED', error: 'Sign in with an email account first.' });
            return;
        }
        res.json({ ok: true, activeSessions: (0, user_store_1.countUserSessions)(account.id) });
    });
    // ---------------- owner/admin account administration
    const requireAccountAdmin = (req, res) => {
        const account = (0, auth_guard_1.getAuthenticatedUser)(req);
        // A legacy ADMIN_PASSWORD session has no account row and stays owner-equivalent.
        if (account && account.role !== 'owner' && account.role !== 'admin') {
            res.status(403).json({ ok: false, code: 'FORBIDDEN', error: 'Administrator permission required.' });
            return false;
        }
        return true;
    };
    /**
     * Owner accounts are managed only by another owner (or the legacy
     * ADMIN_PASSWORD recovery session). Without this, an admin could disable the
     * owner or grant itself ownership and escape the intended privilege boundary.
     */
    const mayManageTarget = (req, res, targetRole, grantingOwner = false) => {
        const actor = (0, auth_guard_1.getAuthenticatedUser)(req);
        if (!actor)
            return true; // legacy ADMIN_PASSWORD session is owner-equivalent
        if (actor.role === 'owner')
            return true;
        if (targetRole === 'owner' || grantingOwner) {
            res.status(403).json({ ok: false, code: 'FORBIDDEN', error: 'Only an owner can manage owner accounts or grant ownership.' });
            return false;
        }
        return true;
    };
    app.get('/api/users', (req, res) => {
        if (!requireAccountAdmin(req, res))
            return;
        res.json({
            ok: true,
            users: (0, user_store_1.listUsers)().map((user) => ({ ...user, activeSessions: (0, user_store_1.countUserSessions)(user.id) })),
        });
    });
    app.post('/api/users/:id/status', (req, res) => {
        if (!requireAccountAdmin(req, res))
            return;
        const active = req.body?.active;
        if (typeof active !== 'boolean') {
            res.status(400).json({ ok: false, code: 'INVALID_BODY', error: 'active must be a boolean.' });
            return;
        }
        const target = (0, user_store_1.listUsers)().find((user) => user.id === String(req.params.id));
        if (target && !mayManageTarget(req, res, target.role))
            return;
        const result = (0, user_store_1.setUserActive)(String(req.params.id), active);
        if (!result.ok) {
            res.status(result.field ? 409 : 404).json({ ok: false, code: 'ACCOUNT_UPDATE_FAILED', error: result.error });
            return;
        }
        (0, auth_guard_1.invalidateUserCountCache)();
        res.json({ ok: true, user: result.user, revokedSessions: result.revokedSessions ?? 0 });
    });
    app.post('/api/users/:id/role', (req, res) => {
        if (!requireAccountAdmin(req, res))
            return;
        const role = String(req.body?.role ?? '');
        const target = (0, user_store_1.listUsers)().find((user) => user.id === String(req.params.id));
        if (target && !mayManageTarget(req, res, target.role, role === 'owner'))
            return;
        const result = (0, user_store_1.setUserRole)(String(req.params.id), role);
        if (!result.ok) {
            res.status(result.field === 'role' && result.error === 'Unknown role.' ? 400 : result.field ? 409 : 404)
                .json({ ok: false, code: 'ACCOUNT_UPDATE_FAILED', error: result.error });
            return;
        }
        res.json({ ok: true, user: result.user, revokedSessions: result.revokedSessions ?? 0 });
    });
    app.post('/api/users/:id/revoke-sessions', (req, res) => {
        if (!requireAccountAdmin(req, res))
            return;
        const target = (0, user_store_1.listUsers)().find((user) => user.id === String(req.params.id));
        if (target && !mayManageTarget(req, res, target.role))
            return;
        const revoked = (0, user_store_1.destroyUserSessions)(String(req.params.id));
        res.json({ ok: true, revokedSessions: revoked });
    });
    const buildTelemetryOverview = (state = (0, db_1.getConsoleState)(), validations = (0, settings_builder_1.validateState)(state), publicDemoUrl = (0, demo_tunnel_1.getCachedTunnelUrlSync)()) => {
        const okChecks = validations.filter((v) => v.level === 'ok').length;
        const wnChecks = validations.filter((v) => v.level === 'wn').length;
        const erChecks = validations.filter((v) => v.level === 'er').length;
        const totalChecks = Math.max(1, validations.length);
        const bridgeStatus = viciBridge ? viciBridge.getStatus() : null;
        const bridgeAnalytics = (0, db_1.getBridgeAnalyticsSummary)();
        const simLogs = (0, db_1.listSimulatorCallLogs)(undefined, 100);
        // Older sandbox/local-speech logs contained synthetic latency; never mix them
        // into the measured Deepgram/bridge figures. Keep the logs themselves intact.
        const simTtfbValues = simLogs
            .filter((s) => s.upstreamMode === 'deepgram')
            .map((s) => s.avgTtfbMs)
            .filter((n) => typeof n === 'number' && Number.isFinite(n) && n > 0);
        // Average the retained per-session means, rather than assigning equal
        // weight to channels with different numbers of sessions.
        const bridgeTtfbValues = (0, db_1.listBridgeCallLogs)(200)
            .map((call) => call.avgTtfbMs)
            .filter((n) => typeof n === 'number' && Number.isFinite(n) && n > 0);
        const retainedTtfbValues = [...bridgeTtfbValues, ...simTtfbValues];
        const combinedTtfb = retainedTtfbValues.length
            ? Math.round(retainedTtfbValues.reduce((a, b) => a + b, 0) / retainedTtfbValues.length)
            : null;
        const secrets = (0, env_store_1.getSecretsStatus)();
        const configuredKeysCount = Object.values(secrets).filter((s) => s.configured).length;
        const dgConfigured = Boolean(secrets.DEEPGRAM_API_KEY?.configured);
        let recordingsFilesCount = 0;
        let recordingsTotalBytes = 0;
        try {
            const recDir = path_1.default.join(data_paths_1.DATA_DIR, 'recordings');
            if (fs_1.default.existsSync(recDir)) {
                for (const fn of fs_1.default.readdirSync(recDir)) {
                    if (fn.endsWith('.wav')) {
                        recordingsFilesCount += 1;
                        recordingsTotalBytes += fs_1.default.statSync(path_1.default.join(recDir, fn)).size;
                    }
                }
            }
        }
        catch { }
        const allQaTests = Object.values(state.tests || {}).flat();
        const qaPassed = allQaTests.filter((t) => t.r === 'ok').length;
        const qaFailed = allQaTests.filter((t) => t.r === 'f').length;
        const qaPending = allQaTests.filter((t) => t.r === 'p').length;
        const revs = (0, db_1.listRevisions)(50);
        let registeredUsers = 0;
        try {
            registeredUsers = (0, user_store_1.countUsers)();
        }
        catch { }
        // These are configuration heuristics, not a security audit or certification.
        const preflightScore = Math.max(0, Math.min(100, Math.round(((okChecks - erChecks * 8 - wnChecks * 2) / totalChecks) * 100)));
        const hasPipelineModels = Boolean(state.services?.stt?.model && state.services?.llm?.model && state.services?.tts?.model);
        const activeSttProv = state.providers.find((p) => p.kind === 'stt' && p.id === state.services?.stt?.providerId);
        const activeTtsProv = state.providers.find((p) => p.kind === 'tts' && p.id === state.services?.tts?.providerId);
        const localSpeechActive = activeSttProv?.type === 'speech_service' && activeTtsProv?.type === 'speech_service';
        const pipelineScore = hasPipelineModels ? (dgConfigured || localSpeechActive ? 100 : 92) : 55;
        const bridgeScore = bridgeStatus?.audioSocketListening && bridgeStatus?.sipRtpListening ? 100 : 0;
        const authEnforced = (0, auth_guard_1.isAuthEnabled)();
        const allowedIps = (0, env_store_1.getSecret)('BRIDGE_ALLOWED_IPS').trim();
        const restrictedPeers = !allowedIps || !allowedIps.split(',').some((rule) => /^(?:\*|\d+\.\d+\.\d+\.\d+\/0)$/.test(rule.trim()));
        const securityScore = (authEnforced ? 50 : 0) + (restrictedPeers ? 50 : 0);
        const storageScore = revs.length > 0 ? 100 : 90;
        const disclosureCount = state.campaigns.filter((c) => String(c.disclosure || '').trim().length >= 10).length;
        const disclosuresReady = disclosureCount === state.campaigns.length;
        const complianceScore = disclosuresReady && erChecks === 0 ? 100 : 78;
        const overallQualityScore = Math.round(preflightScore * 0.34 +
            pipelineScore * 0.20 +
            bridgeScore * 0.14 +
            securityScore * 0.12 +
            storageScore * 0.10 +
            complianceScore * 0.10);
        const qualityGrade = overallQualityScore >= 97 && erChecks === 0
            ? 'S+'
            : overallQualityScore >= 92 && erChecks === 0
                ? 'A+'
                : overallQualityScore >= 85
                    ? 'A'
                    : overallQualityScore >= 75
                        ? 'B'
                        : 'C';
        const mem = process.memoryUsage();
        return {
            generatedAt: new Date().toISOString(),
            quality: {
                score: overallQualityScore,
                grade: qualityGrade,
                certified: false,
                assessment: 'Configuration estimate only; not a security audit or certification.',
                checks: { passed: okChecks, warnings: wnChecks, errors: erChecks, total: validations.length },
                pillars: [
                    { id: 'preflight', label: 'Pre-Flight Schema Audit', score: preflightScore, detail: `${okChecks}/${validations.length} checks` },
                    {
                        id: 'pipeline',
                        label: 'Neural Speech Pipeline',
                        score: pipelineScore,
                        detail: localSpeechActive
                            ? 'Local speech providers selected (health not assessed)'
                            : dgConfigured
                                ? 'API key configured (health not assessed)'
                                : 'Model selection only',
                    },
                    { id: 'bridge', label: 'VICIdial Dual Bridge', score: bridgeScore, detail: bridgeStatus?.audioSocketListening ? `TCP :${bridgeStatus.audioSocketPort} · UDP :${bridgeStatus.sipPort}` : 'Standby' },
                    { id: 'security', label: 'Auth & Peer Configuration', score: securityScore, detail: `${authEnforced ? 'Auth enforced' : 'Local bootstrap only'} · ${restrictedPeers ? 'Peer allowlist configured/default' : 'Peer allowlist open'}; not a security assessment` },
                    { id: 'storage', label: 'SQLite WAL + JSON Mirror', score: storageScore, detail: `${revs.length} revisions` },
                    { id: 'compliance', label: 'Disclosure Configuration', score: complianceScore, detail: `${disclosureCount}/${state.campaigns.length} disclosures configured; not a compliance review` },
                ],
            },
            inventory: {
                agentsTotal: state.agents.length,
                agentsBargeInInstant: state.agents.filter((a) => a.behavior?.bargeIn === 'instant').length,
                agentsExpressive: state.agents.filter((a) => a.behavior?.vocalGestures).length,
                campaignsTotal: state.campaigns.length,
                totalMaxCallsCapacity: state.campaigns.reduce((s, c) => s + Number(c.maxCalls || 0), 0),
                functionsTotal: state.functions.length,
                providersTotal: state.providers.length,
                qaTotal: allQaTests.length,
                qaPassed,
                qaPending,
                qaFailed,
                registeredUsers,
                authEnforced,
                revisionsCount: revs.length,
                configuredSecretsCount: configuredKeysCount,
                deepgramConfigured: dgConfigured,
            },
            traffic: {
                activeCalls: bridgeStatus?.activeCallsCount || 0,
                totalBridgeCalls: bridgeAnalytics.totalBridgeCalls,
                totalSimulatorCalls: bridgeAnalytics.totalSimulatorCalls,
                totalCallsAllChannels: bridgeAnalytics.totalBridgeCalls + bridgeAnalytics.totalSimulatorCalls,
                retentionLimits: bridgeAnalytics.retentionLimits,
                closerTransfers: bridgeAnalytics.transfersCount,
                transferRatePct: bridgeAnalytics.transferRatePct,
                dncBlocked: bridgeAnalytics.dncCount,
                avgTtfbMs: combinedTtfb,
                p95TtfbMs: bridgeAnalytics.p95TtfbMs,
                avgDurationSec: bridgeAnalytics.avgDurationSec,
                recordingsCount: recordingsFilesCount,
                recordingsBytes: recordingsTotalBytes,
                rejectedUntrustedIp: bridgeStatus?.rejectedUntrustedIpCount || 0,
                rejectedOverCapacity: bridgeStatus?.rejectedOverCapacityCount || 0,
                byTransport: bridgeAnalytics.byTransport,
                dispositions: bridgeAnalytics.dispositions,
            },
            runtime: {
                uptimeSec: Math.round(process.uptime()),
                nodeVersion: process.version,
                rssMb: Math.round(mem.rss / 1048576),
                heapMb: Math.round(mem.heapUsed / 1048576),
                httpPort: Number(process.env.PORT || 533),
                httpHost: process.env.HOST || '127.0.0.1',
                lanIp: (0, demo_tunnel_1.getPreferredLanIpv4)(),
                allowedPeerIp: allowedIps || 'loopback only',
                audioSocketPort: bridgeStatus?.audioSocketPort || state.vici.bridgePort,
                sipPort: bridgeStatus?.sipPort || state.vici.sipPort,
                audioSocketListening: bridgeStatus?.audioSocketListening ?? false,
                sipRtpListening: bridgeStatus?.sipRtpListening ?? false,
                bridgeStatusAvailable: Boolean(bridgeStatus),
                publicDemoUrl,
            },
            agentMatrix: state.agents.map((a) => ({
                id: a.id,
                name: a.name,
                mode: a.mode,
                bargeIn: a.behavior?.bargeIn || 'instant',
            })),
        };
    };
    const buildPayload = (state = (0, db_1.getConsoleState)(), publicDemoUrlOverride) => {
        const validations = (0, settings_builder_1.validateState)(state);
        const counts = {
            ok: validations.filter((v) => v.level === 'ok').length,
            wn: validations.filter((v) => v.level === 'wn').length,
            er: validations.filter((v) => v.level === 'er').length,
        };
        const settingsByCampaignId = Object.fromEntries(state.campaigns.map((campaign) => {
            const agent = (0, campaign_assignment_1.primaryCampaignAgent)(state, campaign);
            const agents = (0, campaign_assignment_1.campaignAgentIds)(campaign).map((id) => state.agents.find((entry) => entry.id === id)).filter((entry) => Boolean(entry));
            return [campaign.id, {
                    campaignId: campaign.id,
                    campaignName: campaign.name,
                    agentId: agent?.id || null,
                    agentIds: agents.map((entry) => entry.id),
                    settings: agent ? (0, settings_builder_1.buildDeepgramSettings)(state, agent, campaign) : null,
                    settingsByAgentId: Object.fromEntries(agents.map((entry) => [entry.id, (0, settings_builder_1.buildDeepgramSettings)(state, entry, campaign)])),
                }];
        }));
        const settingsByAgentId = Object.fromEntries(state.agents.map((agent) => {
            const campaigns = state.campaigns.filter((campaign) => (0, campaign_assignment_1.campaignHasAgent)(campaign, agent.id));
            const selectedCampaign = campaigns.length === 1 ? campaigns[0] : undefined;
            return [agent.id, {
                    agentId: agent.id,
                    agentName: agent.name,
                    campaignIds: campaigns.map((campaign) => campaign.id),
                    settings: selectedCampaign ? (0, settings_builder_1.buildDeepgramSettings)(state, agent, selectedCampaign) : null,
                }];
        }));
        const pubUrl = publicDemoUrlOverride !== undefined ? publicDemoUrlOverride : (0, demo_tunnel_1.getCachedTunnelUrlSync)();
        return {
            state,
            validations,
            counts,
            readiness: { ready: (0, settings_builder_1.getDeploymentReadinessBlockers)(state).length === 0, blockers: (0, settings_builder_1.getDeploymentReadinessBlockers)(state) },
            settingsByAgentId,
            settingsByCampaignId,
            viciConfig: (0, settings_builder_1.generateViciConfig)(state),
            revisions: (0, db_1.listRevisions)(12),
            secrets: (0, env_store_1.getSecretsStatus)(),
            viciBridge: viciBridge ? viciBridge.getStatus() : null,
            publicDemoUrl: pubUrl,
            telemetry: buildTelemetryOverview(state, validations, pubUrl),
        };
    };
    // Container/orchestrator probes. Liveness must not depend on external providers.
    app.get('/health/live', (_req, res) => {
        res.status(200).json({ ok: true, status: 'live', service: 'voice-agent-console' });
    });
    // Readiness verifies local persisted state only; upstream outages must not cause restart loops.
    app.get('/health/ready', (_req, res) => {
        try {
            const state = (0, db_1.getConsoleState)();
            const stateUsable = Boolean(state && Array.isArray(state.agents) && Array.isArray(state.campaigns) &&
                Array.isArray(state.providers) && state.services && typeof state.services === 'object');
            if (!stateUsable) {
                res.status(503).json({ ok: false, status: 'not_ready', service: 'voice-agent-console', reason: 'application_state_unavailable' });
                return;
            }
            res.status(200).json({ ok: true, status: 'ready', service: 'voice-agent-console', checks: { applicationState: 'ok' } });
        }
        catch {
            // Never expose filesystem paths, database errors, secrets, or configuration in probes.
            res.status(503).json({ ok: false, status: 'not_ready', service: 'voice-agent-console', reason: 'application_state_unavailable' });
        }
    });
    app.get('/api/health', (req, res) => {
        const authed = (0, auth_guard_1.isRequestAuthorized)(req);
        res.json({
            ok: true,
            step: 4,
            service: 'voice-agent-console',
            storage: 'sqlite+json',
            authEnabled: (0, auth_guard_1.isAuthEnabled)(),
            authenticated: authed,
            websocket: '/ws/simulator',
            viciMonitorWs: '/ws/vici-monitor',
            ...(authed ? { viciBridge: viciBridge ? viciBridge.getStatus() : null } : {}),
            ...(authed ? { secrets: (0, env_store_1.getSecretsStatus)() } : {}),
        });
    });
    app.get('/api/state', asyncRoute(async (_req, res) => {
        const liveTunnel = await (0, demo_tunnel_1.discoverActiveTunnelUrl)();
        res.json({ ok: true, ...buildPayload((0, db_1.getConsoleState)(), liveTunnel) });
    }));
    app.get('/api/telemetry/overview', asyncRoute(async (_req, res) => {
        const state = (0, db_1.getConsoleState)();
        const liveTunnel = await (0, demo_tunnel_1.discoverActiveTunnelUrl)();
        res.json({
            ok: true,
            telemetry: buildTelemetryOverview(state, (0, settings_builder_1.validateState)(state), liveTunnel),
            publicDemoUrl: liveTunnel,
        });
    }));
    app.get('/api/demo-tunnel/status', asyncRoute(async (_req, res) => {
        const url = await (0, demo_tunnel_1.discoverActiveTunnelUrl)();
        res.json({
            ok: true,
            active: Boolean(url),
            publicUrl: url,
            loginUrl: url ? `${url}/login` : null,
            signupUrl: url ? `${url}/signup` : null,
            lanIp: (0, demo_tunnel_1.getPreferredLanIpv4)(),
        });
    }));
    app.post('/api/demo-tunnel/start', asyncRoute(async (req, res) => {
        if (!(0, auth_guard_1.isAuthEnabled)() || !(0, auth_guard_1.hasActiveAuthSession)(req)) {
            res.status(403).json({ ok: false, error: 'Sign in before opening a public tunnel.' });
            return;
        }
        const port = Number(process.env.PORT || 533);
        if (!(await (0, demo_tunnel_1.isTunnelProxyReady)(port))) {
            res.status(409).json({ ok: false, error: 'The local tunnel proxy is not trusted. Configure TRUST_PROXY for the cloudflared connection and restart the console before starting a tunnel.' });
            return;
        }
        const out = await (0, demo_tunnel_1.startPublicDemoTunnel)(port);
        if (!out.ok || !out.publicUrl) {
            res.status(500).json({ ok: false, error: out.error || 'Could not start public tunnel.' });
            return;
        }
        res.json({
            ok: true,
            active: true,
            publicUrl: out.publicUrl,
            loginUrl: `${out.publicUrl}/login`,
            signupUrl: `${out.publicUrl}/signup`,
        });
    }));
    app.post('/api/demo-tunnel/stop', (_req, res) => {
        (0, demo_tunnel_1.stopPublicDemoTunnel)();
        res.json({ ok: true, active: false, publicUrl: null });
    });
    app.put('/api/state', (req, res) => {
        try {
            const bodyState = req.body?.state ?? req.body;
            const { state, changes, revisionId } = (0, db_1.saveConsoleState)(bodyState);
            res.json({
                ok: true,
                changes,
                revisionId,
                ...buildPayload(state),
            });
        }
        catch (err) {
            res.status(400).json({ ok: false, error: err?.message || 'Failed to save console state' });
        }
    });
    app.post('/api/state/reset', (_req, res) => {
        const fresh = (0, defaults_1.createDefaultState)();
        const { state, changes, revisionId } = (0, db_1.saveConsoleState)(fresh, 'Reset console to factory defaults');
        res.json({
            ok: true,
            changes,
            revisionId,
            ...buildPayload(state),
        });
    });
    // Shared greeting catalog. The server database is authoritative for calls;
    // the static site uses its own bundled copy and browser-local rotation.
    app.get('/api/greetings', (_req, res) => {
        const greetings = (0, db_1.listGreetingLibrary)();
        res.setHeader('Cache-Control', 'private, no-store');
        res.json({ ok: true, count: greetings.length, greetings });
    });
    // Step 2: Simulator call log history endpoints
    app.get('/api/simulator/logs', (req, res) => {
        const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : undefined;
        const campaignId = typeof req.query.campaignId === 'string' ? req.query.campaignId : undefined;
        const requested = typeof req.query.limit === 'string' ? Number(req.query.limit) : 20;
        const limit = Number.isFinite(requested) && requested > 0 ? Math.max(1, Math.min(100, Math.floor(requested))) : 20;
        const logs = (0, db_1.listSimulatorCallLogs)(agentId, limit).filter((row) => !campaignId || row.campaignId === campaignId);
        res.setHeader('Cache-Control', 'private, no-store');
        res.json({ ok: true, count: logs.length, logs });
    });
    app.delete('/api/simulator/logs', (req, res) => {
        const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : undefined;
        try {
            (0, db_1.clearSimulatorCallLogs)(agentId);
            res.json({ ok: true });
        }
        catch {
            res.status(500).json({ ok: false, error: 'Could not delete all test recordings; some audio may already have been removed, but history was not cleared. Check server storage permissions and retry.' });
        }
    });
    // Upload is allowed only for a completed test that explicitly opted in. The
    // normal API auth/Origin guard applies to upload, playback and deletion.
    const simulatorAudioBody = express_1.default.raw({ type: 'application/octet-stream', limit: simulator_recordings_1.MAX_SIMULATOR_RECORDING_BYTES });
    app.put('/api/simulator/recordings/:id', (req, res, next) => {
        simulatorAudioBody(req, res, (err) => {
            if (!err) {
                next();
                return;
            }
            const tooLarge = err.type === 'entity.too.large';
            res.status(tooLarge ? 413 : 400).json({ ok: false, error: tooLarge
                    ? 'The browser recording exceeds the 20 MB limit.' : 'Could not read the browser recording upload.' });
        });
    }, (req, res) => {
        const id = String(req.params.id || '');
        const log = (0, db_1.getSimulatorCallLog)(id);
        if (!log) {
            res.status(404).json({ ok: false, error: 'Browser test not found.' });
            return;
        }
        if (!log.recordingRequested || log.recordingStatus !== 'pending') {
            res.status(409).json({ ok: false, error: 'This test did not opt in to a new recording, or it was already saved or deleted.' });
            return;
        }
        const mime = String(req.get('X-Recording-Type') || '').split(';')[0].trim().toLowerCase();
        const data = req.body;
        if (!Buffer.isBuffer(data) || !(0, simulator_recordings_1.isSupportedRecording)(data, mime)) {
            res.status(400).json({ ok: false, error: 'Invalid or unsupported audio recording.' });
            return;
        }
        let fileName = null;
        try {
            fileName = (0, simulator_recordings_1.writeSimulatorRecording)(id, data, mime);
            const attached = (0, db_1.attachSimulatorRecording)(id, fileName, mime, data.length, req.get('X-Recording-Truncated') === '1');
            if (!attached) {
                (0, simulator_recordings_1.removeSimulatorRecording)(fileName);
                res.status(409).json({ ok: false, error: 'Test history changed before audio could be saved.' });
                return;
            }
            res.setHeader('Cache-Control', 'no-store');
            res.status(201).json({ ok: true, bytes: data.length, mime });
        }
        catch {
            if (fileName) {
                try {
                    (0, simulator_recordings_1.removeSimulatorRecording)(fileName);
                }
                catch { }
            }
            res.status(500).json({ ok: false, error: 'Could not save the browser test recording.' });
        }
    });
    app.get('/api/simulator/recordings/:id', (req, res) => {
        const log = (0, db_1.getSimulatorCallLog)(String(req.params.id || ''));
        try {
            const fullPath = log?.recordingStatus === 'available' && log.recordingFile
                ? (0, simulator_recordings_1.resolveSimulatorRecording)(log.recordingFile) : null;
            if (!fullPath || !log?.recordingMime) {
                res.status(404).json({ ok: false, error: 'Browser test recording not found.' });
                return;
            }
            res.setHeader('Content-Type', log.recordingMime);
            res.setHeader('Cache-Control', 'private, no-store');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.sendFile(fullPath);
        }
        catch {
            res.status(500).json({ ok: false, error: 'Could not read the browser test recording.' });
        }
    });
    app.delete('/api/simulator/recordings/:id', (req, res) => {
        try {
            if (!(0, db_1.deleteSimulatorRecording)(String(req.params.id || ''))) {
                res.status(404).json({ ok: false, error: 'Browser test not found.' });
                return;
            }
            res.json({ ok: true });
        }
        catch {
            res.status(500).json({ ok: false, error: 'Could not delete the recording. Check server storage permissions and retry.' });
        }
    });
    // ==================== STEP 3: VICIDIAL BRIDGE ENDPOINTS ====================
    const handleRegisterCall = (req, res) => {
        if (!viciBridge) {
            res.status(503).send('ERROR: VICIdial Bridge not initialized');
            return;
        }
        const merged = { ...req.query, ...(req.body || {}) };
        const reg = viciBridge.registerPreCall({
            uniqueid: merged.uniqueid,
            vici_cid: merged.vici_cid || merged.caller_code,
            phone: merged.phone,
            exten: merged.exten,
            channel: merged.channel,
            agent_user: merged.agent_user,
        });
        const wantsJson = merged.format === 'json' ||
            String(req.headers.accept || '').includes('application/json');
        if (wantsJson) {
            res.json({ ok: true, ...reg });
        }
        else {
            // Plain 36-char RFC4122 UUID for Asterisk Set(_BRIDGE_UUID=${CURL(...)})
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.send(reg.uuid);
        }
    };
    app.get('/api/vici/register-call', handleRegisterCall);
    app.post('/api/vici/register-call', handleRegisterCall);
    app.get('/api/vici/precall', handleRegisterCall);
    app.post('/api/vici/precall', handleRegisterCall);
    app.get('/api/vici/status', (_req, res) => {
        res.json({
            ok: true,
            bridge: viciBridge ? viciBridge.getStatus() : null,
            logs: (0, db_1.listBridgeCallLogs)(20),
        });
    });
    app.get('/api/vici/logs', (req, res) => {
        const requested = typeof req.query.limit === 'string' ? Number(req.query.limit) : 25;
        const limit = Number.isFinite(requested) && requested > 0 ? Math.max(1, Math.min(200, Math.floor(requested))) : 25;
        const campaignId = typeof req.query.campaignId === 'string' ? req.query.campaignId : undefined;
        const logs = (0, db_1.listBridgeCallLogs)(limit).filter((row) => !campaignId || row.campaignId === campaignId);
        res.setHeader('Cache-Control', 'private, no-store');
        res.json({ ok: true, count: logs.length, logs });
    });
    app.delete('/api/vici/logs', (_req, res) => {
        (0, db_1.clearBridgeCallLogs)();
        res.json({ ok: true });
    });
    app.post('/api/vici/parse-cid', (req, res) => {
        const parsed = (0, vici_client_1.parseVicidialCallerCode)(req.body?.callerIdName, req.body?.callerIdNum);
        res.json({ ok: true, parsed });
    });
    app.post('/api/vici/verify', asyncRoute(async (req, res) => {
        try {
            const st = (0, db_1.getConsoleState)();
            const viciCfg = req.body?.vici ? { ...st.vici, ...req.body.vici } : st.vici;
            const viciClient = new vici_client_1.VicidialApiClient(viciCfg);
            const amiClient = new ami_client_1.AsteriskAmiClient(viciCfg);
            const [viciVersion, amiPing] = await Promise.all([
                viciClient.checkVersion(),
                amiClient.ping(),
            ]);
            res.json({
                ok: true,
                vicidialHttp: viciVersion,
                asteriskAmi: amiPing,
                bridgeListeners: viciBridge ? viciBridge.getStatus() : null,
            });
        }
        catch (err) {
            res.status(400).json({ ok: false, error: err?.message || 'VICIdial verification failed' });
        }
    }));
    app.post('/api/vici/simulate-call', asyncRoute(async (req, res) => {
        if (!viciBridge) {
            res.status(503).json({ ok: false, error: 'VICIdial Bridge service is not attached' });
            return;
        }
        try {
            const transport = req.body?.transport === 'audiosocket' ? 'audiosocket' : 'sip_rtp';
            const validScenarios = [
                'qualified_xfer',
                'dnc_request',
                'not_interested',
                'medicare_qualified_xfer',
                'medicare_qualified_no_age_xfer',
                'medicare_fabricated_age_xfer',
                'medicare_underage_dq',
                'medicare_spanish_lang',
            ];
            const scenario = validScenarios.includes(req.body?.scenario)
                ? req.body.scenario
                : 'qualified_xfer';
            const upstream = req.body?.upstream === 'mock_ai' ? 'mock_ai' : 'deepgram';
            const result = await (0, vici_loopback_tester_1.runSimulatedViciBridgeCall)(viciBridge, {
                transport,
                scenario,
                upstream,
                callerCode: req.body?.callerCode,
                phone: req.body?.phone,
                campaignId: String(req.body?.campaignId || ''),
                exten: req.body?.exten,
            });
            res.json(result);
        }
        catch (err) {
            res.status(400).json({
                ok: false,
                error: err?.message || 'Simulated VICIdial bridge call failed',
            });
        }
    }));
    app.get('/api/vici/deploy-script', (_req, res) => {
        const blockers = (0, settings_builder_1.getDeploymentReadinessBlockers)((0, db_1.getConsoleState)());
        if (blockers.length) {
            res.status(409).json({ ok: false, error: 'Deployment is blocked until all agents and campaigns are ready.', blockers });
            return;
        }
        const scriptPath = path_1.default.resolve(__dirname, '..', 'deploy', 'vicibox-install.sh');
        if (fs_1.default.existsSync(scriptPath)) {
            res.setHeader('Content-Type', 'text/x-shellscript; charset=utf-8');
            res.setHeader('Content-Disposition', 'attachment; filename="vicibox-install.sh"');
            res.send(fs_1.default.readFileSync(scriptPath, 'utf8'));
        }
        else {
            res.status(404).send('# Deploy script not found');
        }
    });
    // ==================== STEP 4: RECORDINGS, ANALYTICS, CSV, WEBHOOKS & BUNDLE ====================
    app.get('/api/vici/recordings/:file', (req, res) => {
        const wavPath = (0, call_recorder_1.resolveRecordingPath)(String(req.params.file || ''));
        if (!wavPath) {
            res.status(404).json({ ok: false, error: 'Recording WAV file not found' });
            return;
        }
        res.setHeader('Content-Type', 'audio/wav');
        res.sendFile(wavPath);
    });
    app.get('/api/vici/analytics', (_req, res) => {
        res.json({
            ok: true,
            analytics: (0, db_1.getBridgeAnalyticsSummary)(),
            bridge: viciBridge ? viciBridge.getStatus() : null,
        });
    });
    app.get('/api/vici/logs.csv', (_req, res) => {
        const csv = (0, db_1.exportBridgeLogsCsv)(200);
        const stamp = new Date().toISOString().slice(0, 10);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="vici-bridge-cdrs-${stamp}.csv"`);
        res.send(csv);
    });
    app.post('/api/vici/calls/:callId/hangup', (req, res) => {
        if (!viciBridge) {
            res.status(503).json({ ok: false, error: 'Bridge service not attached' });
            return;
        }
        const callId = String(req.params.callId || '');
        const ok = viciBridge.forceHangupCall(callId);
        if (!ok) {
            res.status(404).json({ ok: false, error: 'Active call not found or already ended' });
            return;
        }
        res.json({ ok: true, callId, action: 'force_hangup' });
    });
    app.post('/api/vici/calls/:callId/transfer', asyncRoute(async (req, res) => {
        if (!viciBridge) {
            res.status(503).json({ ok: false, error: 'Bridge service not attached' });
            return;
        }
        const callId = String(req.params.callId || '');
        const ok = await viciBridge.forceTransferCall(callId, req.body?.reason || 'Supervisor live transfer');
        if (!ok) {
            res.status(404).json({ ok: false, error: 'Active call not found or already ended' });
            return;
        }
        res.json({ ok: true, callId, action: 'force_transfer' });
    }));
    app.post('/api/functions/test-webhook', asyncRoute(async (req, res) => {
        try {
            const state = (0, db_1.getConsoleState)();
            const fnDef = req.body?.fn ||
                state.functions.find((f) => f.id === req.body?.fnId || f.name === req.body?.name);
            if (!fnDef) {
                res.status(404).json({ ok: false, error: 'Function definition not found' });
                return;
            }
            const args = req.body?.args && typeof req.body.args === 'object' ? req.body.args : {};
            const out = await (0, webhook_executor_1.executeCustomFunctionWebhook)(fnDef, args, {
                callId: 'webhook_test_ui',
                callerCode: 'V1027153012000104892',
                leadId: '104892',
                phone: '3055550192',
                viciCampaign: state.campaigns[0]?.viciCampaign || 'FETEST',
                lead: {
                    lead_id: '104892',
                    first_name: 'Robert',
                    last_name: 'Carter',
                    phone_number: '3055550192',
                    state: 'FL',
                    age: '64',
                },
            });
            res.json(out);
        }
        catch (err) {
            res.status(400).json({ ok: false, error: err?.message || 'Webhook test failed' });
        }
    }));
    app.get('/api/vici/release-bundle', (_req, res) => {
        const blockers = (0, settings_builder_1.getDeploymentReadinessBlockers)((0, db_1.getConsoleState)());
        if (blockers.length) {
            res.status(409).json({ ok: false, error: 'Release bundle is blocked until all agents and campaigns are ready.', blockers });
            return;
        }
        const bundlePath = path_1.default.join(data_paths_1.DATA_DIR, 'voice-agent-vicibox-release.tar.gz');
        try {
            // Rebuild from a filtered allowlist; a cached archive could otherwise be
            // stale or contain private files from an earlier installation.
            (0, release_bundle_1.createReleaseBundle)(path_1.default.resolve(__dirname, '..'), bundlePath);
            res.setHeader('Content-Type', 'application/gzip');
            res.setHeader('Content-Disposition', 'attachment; filename="voice-agent-vicibox-release.tar.gz"');
            res.sendFile(bundlePath);
        }
        catch (err) {
            res.status(500).json({ ok: false, error: err?.message || 'Failed to package release bundle' });
        }
    });
    // ==================== SECRETS & DEEPGRAM ENDPOINTS ====================
    app.get('/api/secrets', (_req, res) => {
        res.json({ ok: true, secrets: (0, env_store_1.getSecretsStatus)() });
    });
    app.post('/api/secrets', asyncRoute(async (req, res) => {
        try {
            const incoming = req.body || {};
            const updates = {};
            for (const key of env_store_1.MANAGED_SECRET_KEYS) {
                if (typeof incoming[key] === 'string') {
                    updates[key] = incoming[key];
                }
            }
            let deepgramDiagnostic = null;
            const hasCustomMockUpstream = Boolean((process.env.DEEPGRAM_AGENT_URL || '').trim());
            if (updates.DEEPGRAM_API_KEY && updates.DEEPGRAM_API_KEY.trim() && !hasCustomMockUpstream) {
                deepgramDiagnostic = await (0, env_store_1.verifyDeepgramConnection)(updates.DEEPGRAM_API_KEY);
                if (!deepgramDiagnostic.restAuth.ok) {
                    res.status(400).json({
                        ok: false,
                        error: `Deepgram API key rejected — ${deepgramDiagnostic.restAuth.error}`,
                        deepgramDiagnostic,
                        secrets: (0, env_store_1.getSecretsStatus)(),
                    });
                    return;
                }
            }
            (0, env_store_1.updateSecrets)(updates);
            if (updates.DEEPGRAM_API_KEY && updates.DEEPGRAM_API_KEY.trim() && !hasCustomMockUpstream) {
                await (0, deepgram_catalog_1.fetchDeepgramVoiceCatalog)(true).catch(() => { });
            }
            res.json({
                ok: true,
                deepgramVerified: Boolean(deepgramDiagnostic?.ok),
                deepgramDiagnostic,
                secrets: (0, env_store_1.getSecretsStatus)(),
            });
        }
        catch (err) {
            res.status(400).json({
                ok: false,
                error: err?.message || 'Failed to update server .env secrets',
                secrets: (0, env_store_1.getSecretsStatus)(),
            });
        }
    }));
    app.post('/api/deepgram/verify', asyncRoute(async (req, res) => {
        try {
            const explicitKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey : undefined;
            const diagnostic = await (0, env_store_1.verifyDeepgramConnection)(explicitKey);
            res.status(diagnostic.ok ? 200 : 400).json({
                ok: diagnostic.ok,
                diagnostic,
                secrets: (0, env_store_1.getSecretsStatus)(),
            });
        }
        catch (err) {
            res.status(400).json({
                ok: false,
                error: err?.message || 'Deepgram diagnostic check failed',
            });
        }
    }));
    app.get('/api/deepgram/voices', asyncRoute(async (req, res) => {
        try {
            const force = req.query.refresh === '1' || req.query.refresh === 'true';
            const catalog = await (0, deepgram_catalog_1.fetchDeepgramVoiceCatalog)(force);
            const q = String(req.query.q || '').trim().toLowerCase();
            const family = String(req.query.family || '').trim().toLowerCase();
            const lang = String(req.query.language || '').trim().toLowerCase();
            const accent = String(req.query.accent || '').trim().toLowerCase();
            const gender = String(req.query.gender || '').trim().toLowerCase();
            const useCase = String(req.query.useCase || '').trim().toLowerCase();
            const filtered = catalog.voices.filter((v) => {
                if (family && v.family !== family)
                    return false;
                if (lang &&
                    v.primaryLanguage !== lang &&
                    !v.languages.some((l) => l.toLowerCase().startsWith(lang))) {
                    return false;
                }
                if (accent && v.accent.toLowerCase() !== accent)
                    return false;
                if (gender && v.gender !== gender)
                    return false;
                if (useCase && !v.useCases.some((u) => u.toLowerCase().includes(useCase)))
                    return false;
                if (q) {
                    const hay = `${v.id} ${v.displayName} ${v.accent} ${v.age} ${v.tags.join(' ')} ${v.useCases.join(' ')}`.toLowerCase();
                    if (!hay.includes(q))
                        return false;
                }
                return true;
            });
            const accents = Array.from(new Set(catalog.voices.map((v) => v.accent))).sort();
            const languages = Array.from(new Set(catalog.voices.map((v) => v.primaryLanguage))).sort();
            const useCases = Array.from(new Set(catalog.voices.flatMap((v) => v.useCases))).sort();
            res.json({
                ok: true,
                source: catalog.source,
                authenticated: catalog.authenticated,
                totalCatalogCount: catalog.voices.length,
                count: filtered.length,
                facets: {
                    families: ['flux-v2', 'aura-2', 'aura-1'],
                    languages,
                    accents,
                    genders: ['feminine', 'masculine'],
                    useCases,
                },
                sttModels: catalog.sttModels,
                voices: filtered,
            });
        }
        catch (err) {
            res.status(400).json({
                ok: false,
                error: err?.message || 'Failed to load Deepgram voice catalog',
            });
        }
    }));
    app.get('/api/deepgram/llm-models', asyncRoute(async (_req, res) => {
        const models = await (0, deepgram_catalog_1.fetchDeepgramLlmModels)();
        res.json({ ok: true, count: models.length, models });
    }));
    app.get('/api/deepgram/sample', asyncRoute(async (req, res) => {
        try {
            const sampleUrl = String(req.query.url || '');
            const { buffer, contentType } = await (0, deepgram_catalog_1.fetchAllowedSampleAudio)(sampleUrl);
            res.setHeader('Content-Type', contentType);
            res.setHeader('Cache-Control', 'public, max-age=86400');
            res.send(buffer);
        }
        catch (err) {
            res.status(err?.statusCode || 400).json({ ok: false, code: err?.code, error: err?.message || 'Unable to stream sample audio' });
        }
    }));
    app.post('/api/tts/preview', asyncRoute(async (req, res) => {
        try {
            const result = await (0, deepgram_catalog_1.synthesizeTtsPreview)(req.body || {});
            res.setHeader('Content-Type', result.contentType);
            res.setHeader('X-TTS-Model', result.usedModel);
            res.setHeader('Cache-Control', 'no-store');
            res.send(result.buffer);
        }
        catch (err) {
            const status = typeof err?.statusCode === 'number' ? err.statusCode : 400;
            res.status(status).json({
                ok: false,
                code: err?.code || 'TTS_PREVIEW_FAILED',
                error: err?.message || 'Failed to synthesize TTS preview',
            });
        }
    }));
    // ==================== LOCAL SPEECH SERVICE (1-CLICK STT + TTS) ====================
    app.get('/api/speech-service/status', asyncRoute(async (req, res) => {
        try {
            const explicitUrl = typeof req.query.url === 'string' ? req.query.url : undefined;
            const diagnostic = await (0, speech_service_client_1.verifySpeechServiceConnection)(explicitUrl);
            const state = (0, db_1.getConsoleState)();
            const activeStt = state.providers.find((p) => p.kind === 'stt' && p.id === state.services?.stt?.providerId);
            const activeTts = state.providers.find((p) => p.kind === 'tts' && p.id === state.services?.tts?.providerId);
            res.json({
                ok: diagnostic.ok,
                activeInConsole: activeStt?.type === 'speech_service' && activeTts?.type === 'speech_service',
                configuredUrl: (0, speech_service_client_1.getSpeechServiceBaseUrl)(explicitUrl),
                diagnostic,
                secrets: (0, env_store_1.getSecretsStatus)(),
            });
        }
        catch (err) {
            res.status(400).json({
                ok: false,
                error: err?.message || 'Failed to query Speech Service status',
            });
        }
    }));
    app.post('/api/speech-service/test', asyncRoute(async (req, res) => {
        try {
            const result = await (0, speech_service_client_1.runSpeechServiceRoundTripSmoke)({
                url: typeof req.body?.url === 'string' ? req.body.url : undefined,
                apiKey: typeof req.body?.apiKey === 'string' ? req.body.apiKey : undefined,
                voice: typeof req.body?.voice === 'string' ? req.body.voice : undefined,
                text: typeof req.body?.text === 'string' ? req.body.text : undefined,
            });
            res.status(result.ok ? 200 : 400).json(result);
        }
        catch (err) {
            res.status(400).json({
                ok: false,
                error: err?.message || 'Speech Service round-trip test failed',
            });
        }
    }));
    app.post('/api/speech-service/activate', asyncRoute(async (req, res) => {
        try {
            const secretUpdates = {};
            if (typeof req.body?.url === 'string' && req.body.url.trim()) {
                secretUpdates.SPEECH_SERVICE_URL = req.body.url.trim();
            }
            if (typeof req.body?.apiKey === 'string') {
                secretUpdates.SPEECH_SERVICE_API_KEY = req.body.apiKey;
            }
            if (Object.keys(secretUpdates).length > 0) {
                (0, env_store_1.updateSecrets)(secretUpdates);
            }
            const diagnostic = await (0, speech_service_client_1.verifySpeechServiceConnection)();
            if (!diagnostic.ok) {
                res.status(400).json({
                    ok: false,
                    error: diagnostic.error || `Speech Service not ready at ${diagnostic.baseUrl}`,
                    diagnostic,
                    secrets: (0, env_store_1.getSecretsStatus)(),
                });
                return;
            }
            const state = (0, db_1.getConsoleState)();
            const localStt = state.providers.find((p) => p.kind === 'stt' && p.type === 'speech_service');
            const localTts = state.providers.find((p) => p.kind === 'tts' && p.type === 'speech_service');
            if (!localStt || !localTts) {
                res.status(500).json({ ok: false, error: 'Local Speech Service plug-in entries missing from state' });
                return;
            }
            const cloneVoiceIds = diagnostic.clonedVoices.map((v) => `clone:${v.id}`);
            const mergedVoices = Array.from(new Set([...diagnostic.stockVoices, ...cloneVoiceIds]));
            if (mergedVoices.length > 0) {
                localTts.models = mergedVoices.join(',');
            }
            const chosenSttModel = typeof req.body?.sttModel === 'string' && req.body.sttModel.trim()
                ? req.body.sttModel.trim()
                : 'large-v3-turbo';
            const chosenVoice = typeof req.body?.voice === 'string' && req.body.voice.trim() ? req.body.voice.trim() : 'af_heart';
            state.services.stt = { providerId: localStt.id, model: chosenSttModel };
            state.services.tts = { providerId: localTts.id, model: chosenVoice };
            if (!state.services.llm?.providerId || !state.services.llm?.model) {
                const defaultLlm = state.providers.find((p) => p.kind === 'llm' && p.type === 'open_ai') || state.providers.find((p) => p.kind === 'llm');
                if (defaultLlm) {
                    state.services.llm = { providerId: defaultLlm.id, model: 'gpt-4o-mini' };
                }
            }
            const saved = (0, db_1.saveConsoleState)(state, `1-Click Activated Local Speech Service (${chosenSttModel} + ${chosenVoice})`);
            res.json({
                ok: true,
                diagnostic,
                revisionId: saved.revisionId,
                changes: saved.changes,
                ...buildPayload(saved.state),
            });
        }
        catch (err) {
            res.status(400).json({
                ok: false,
                error: err?.message || 'Failed to activate Local Speech Service',
            });
        }
    }));
    const publicDir = path_1.default.resolve(__dirname, '..', 'public');
    // Dedicated authentication pages (same shell, tabbed Sign In / Create Account)
    const safeNextPath = (raw) => {
        const value = typeof raw === 'string' ? raw : '';
        if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\') || /[\x00-\x1f\x7f]/.test(value))
            return '/';
        try {
            const parsed = new URL(value, 'http://local.invalid');
            return parsed.origin === 'http://local.invalid' ? `${parsed.pathname}${parsed.search}` : '/';
        }
        catch {
            return '/';
        }
    };
    const serveAuthShell = (req, res) => {
        // A signed-in operator can explicitly open /signup to provision an account.
        if ((0, auth_guard_1.hasActiveAuthSession)(req) && req.path !== '/signup') {
            res.redirect(safeNextPath(req.query.next));
            return;
        }
        res.setHeader('Cache-Control', 'no-store');
        res.sendFile(path_1.default.join(publicDir, 'login.html'));
    };
    app.get('/login', serveAuthShell);
    app.get('/login.html', serveAuthShell);
    app.get('/signup', serveAuthShell);
    // Gate the web console entry point so Sign Up / Sign In is always the very first page
    const serveConsoleEntry = (req, res) => {
        if (!(0, auth_guard_1.hasActiveAuthSession)(req)) {
            const entryPath = (0, auth_guard_1.isAuthEnabled)() ? '/login' : '/signup';
            const qsIdx = req.originalUrl.indexOf('?');
            const nextSuffix = (req.path === '/' || req.path === '/index.html') && qsIdx === -1
                ? ''
                : `?next=${encodeURIComponent(req.originalUrl)}`;
            res.redirect(`${entryPath}${nextSuffix}`);
            return;
        }
        res.setHeader('Cache-Control', 'no-store');
        res.sendFile(path_1.default.join(publicDir, 'index.html'));
    };
    app.get('/', serveConsoleEntry);
    app.get('/index.html', serveConsoleEntry);
    app.use(express_1.default.static(publicDir, { index: false }));
    app.get('*', serveConsoleEntry);
    app.use((err, req, res, next) => {
        if (res.headersSent) {
            next(err);
            return;
        }
        const explicit = Number(err?.statusCode || err?.status);
        const status = err?.type === 'entity.too.large' ? 413 : err?.type === 'entity.parse.failed' ? 400 : explicit >= 400 && explicit < 500 ? explicit : 500;
        if (status >= 500)
            console.error('[http] Unhandled request failure:', err instanceof Error ? err.name : 'Error');
        res.status(status).json({ ok: false, code: status === 413 ? 'BODY_TOO_LARGE' : status === 400 ? 'INVALID_BODY' : 'INTERNAL_ERROR', error: status === 413 ? 'Request body is too large.' : status === 400 ? 'Request body is invalid.' : 'The server could not complete this request.' });
    });
    return app;
}
function createServerWithSimulator(bridgeOpts) {
    const enableBridge = bridgeOpts?.enableBridge ?? false;
    const viciBridge = enableBridge ? new vici_bridge_1.VicidialBridgeService(bridgeOpts) : undefined;
    const app = createApp(viciBridge);
    const server = http_1.default.createServer(app);
    server.requestTimeout = 60_000;
    server.headersTimeout = 15_000;
    server.keepAliveTimeout = 5_000;
    server.maxRequestsPerSocket = 1000;
    const simWss = (0, live_simulator_1.attachLiveSimulator)(undefined, true);
    const monitorWss = viciBridge ? viciBridge.createMonitorWebSocketServer() : null;
    server.on('upgrade', (req, socket, head) => {
        socket.on('error', () => { });
        try {
            if (!(0, request_origin_1.isSameOriginRequest)(req, app.get('trust proxy fn'))) {
                socket.write('HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: 9\r\n\r\nForbidden');
                socket.destroy();
                return;
            }
            if (!(0, auth_guard_1.isRequestAuthorized)(req)) {
                socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\nContent-Length: 12\r\n\r\nUnauthorized');
                socket.destroy();
                return;
            }
            const pathname = (req.url || '').split('?')[0];
            if (pathname === '/ws/simulator') {
                simWss.handleUpgrade(req, socket, head, (ws) => {
                    simWss.emit('connection', ws, req);
                });
            }
            else if (pathname === '/ws/vici-monitor' && monitorWss) {
                monitorWss.handleUpgrade(req, socket, head, (ws) => {
                    monitorWss.emit('connection', ws, req);
                });
            }
            else {
                socket.destroy();
            }
        }
        catch {
            socket.destroy();
        }
    });
    return { app, server, viciBridge, liveSimulator: simWss };
}
if (require.main === module) {
    const requestedPort = Number(process.env.PORT || 533);
    const initialPort = process.env.E2B_SANDBOX === 'true' && requestedPort > 0 && requestedPort < 1024
        ? requestedPort + 5000
        : requestedPort;
    const host = process.env.HOST || '127.0.0.1';
    const debugMode = process.env.VAC_DEBUG === '1';
    if (!(0, auth_guard_1.isLoopbackIp)(host) && !(0, auth_guard_1.isAuthEnabled)()) {
        console.error('[VoiceAgentConsole] Refusing to bind to a non-loopback interface without an admin password or a registered user.');
        process.exit(1);
    }
    const { server, viciBridge, liveSimulator } = createServerWithSimulator({ enableBridge: true });
    (async () => {
        if (initialPort !== requestedPort) {
            console.warn(`[VoiceAgentConsole] Cloud preview proxy blocks privileged ports <1024 (port ${requestedPort}) — mapping preview listener to port ${initialPort} (production ViciBox/115.186.137.240 keeps port ${requestedPort}).`);
        }
        let bindHost = host;
        await new Promise((resolveListen) => {
            const listenWithFallback = (candidatePort, retriesLeft) => {
                let onListening;
                const onError = (err) => {
                    server.removeListener('listening', onListening);
                    if (err.code === 'EACCES' && candidatePort < 1024 && retriesLeft > 0) {
                        const nextPort = candidatePort + 5000;
                        console.warn(`[VoiceAgentConsole] Privileged port ${candidatePort} requires CAP_NET_BIND_SERVICE (EACCES) — switching automatically to port ${nextPort}...`);
                        server.removeListener('error', onError);
                        listenWithFallback(nextPort, retriesLeft - 1);
                        return;
                    }
                    console.error('[VoiceAgentConsole] HTTP listen error:', err);
                    process.exit(1);
                };
                onListening = () => {
                    server.removeListener('error', onError);
                    process.env.PORT = String(candidatePort);
                    console.log(`[VoiceAgentConsole] Server listening on ${bindHost}:${candidatePort}${debugMode ? ' [DEBUG MODE]' : ''}`);
                    if (debugMode) {
                        const currentState = (0, db_1.getConsoleState)();
                        const checks = (0, settings_builder_1.validateState)(currentState);
                        const okCount = checks.filter((c) => c.level === 'ok').length;
                        const wnCount = checks.filter((c) => c.level === 'wn').length;
                        const erCount = checks.filter((c) => c.level === 'er').length;
                        console.log(`[VAC:DEBUG] Active state loaded: ${currentState.agents.length} agents (${currentState.agents.map((a) => `"${a.name}"`).join(', ')}), ${currentState.campaigns.length} campaigns (${currentState.campaigns.map((c) => `"${c.name}"`).join(', ')}) | TTS=${currentState.services.tts.model || 'none'} | Pre-flight checks: ${okCount} passed, ${wnCount} warnings, ${erCount} errors`);
                    }
                    (0, deepgram_catalog_1.fetchDeepgramVoiceCatalog)().catch(() => { });
                    resolveListen();
                };
                server.once('error', onError);
                server.once('listening', onListening);
                server.listen(candidatePort, bindHost);
            };
            listenWithFallback(initialPort, 0);
        });
        let shuttingDown = false;
        const shutdown = async (signal) => {
            if (shuttingDown)
                return;
            shuttingDown = true;
            console.log(`[VoiceAgentConsole] ${signal} received; shutting down.`);
            const force = setTimeout(() => process.exit(1), 10000);
            force.unref();
            (0, demo_tunnel_1.stopPublicDemoTunnel)();
            for (const client of liveSimulator.clients)
                client.terminate();
            await new Promise((resolve) => liveSimulator.close(() => resolve()));
            if (viciBridge)
                await viciBridge.stop().catch(() => { });
            await new Promise((resolve) => server.close(() => resolve()));
            server.closeAllConnections?.();
            (0, db_1.closeDb)();
            clearTimeout(force);
            process.exit(0);
        };
        process.once('SIGTERM', () => void shutdown('SIGTERM'));
        process.once('SIGINT', () => void shutdown('SIGINT'));
        if (viciBridge) {
            try {
                await viciBridge.start();
                const st = viciBridge.getStatus();
                console.log(`[ViciBridge] AudioSocket TCP listening on ${st.bindHost}:${st.audioSocketPort} | SIP+RTP (PCMU) UDP listening on ${st.bindHost}:${st.sipPort}`);
            }
            catch (bridgeErr) {
                console.warn(`[ViciBridge] Telephony UDP/TCP listener skipped on cloud host (${bridgeErr?.message || bridgeErr}) — Web Console & Live WebSocket Simulator remain active.`);
            }
        }
    })().catch((err) => {
        console.error('[VoiceAgentConsole] Startup fatal error:', err);
        process.exit(1);
    });
}
