"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createApp = createApp;
exports.createServerWithSimulator = createServerWithSimulator;
const child_process_1 = __importDefault(require("child_process"));
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
const db_1 = require("./db");
const defaults_1 = require("./defaults");
const data_paths_1 = require("./data-paths");
const deepgram_catalog_1 = require("./deepgram-catalog");
const env_store_1 = require("./env-store");
const live_simulator_1 = require("./live-simulator");
const settings_builder_1 = require("./settings-builder");
const vici_bridge_1 = require("./vici-bridge");
const vici_client_1 = require("./vici-client");
const vici_loopback_tester_1 = require("./vici-loopback-tester");
const webhook_executor_1 = require("./webhook-executor");
const user_store_1 = require("./user-store");
(0, env_store_1.loadEnv)();
function createApp(viciBridge) {
    const app = (0, express_1.default)();
    const loginAttempts = new Map();
    const loginWindowMs = 15 * 60 * 1000;
    const loginAttemptLimit = 5;
    app.use((req, res, next) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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
    const rateKey = (req) => String(req.socket?.remoteAddress || req.ip || 'unknown');
    const rateLimited = (key) => {
        const now = Date.now();
        const attempts = loginAttempts.get(key);
        if (attempts && attempts.resetAt <= now) {
            loginAttempts.delete(key);
            return { limited: false, retryAfter: 0 };
        }
        if (attempts && attempts.count >= loginAttemptLimit) {
            return { limited: true, retryAfter: Math.max(1, Math.ceil((attempts.resetAt - now) / 1000)) };
        }
        return { limited: false, retryAfter: 0 };
    };
    const noteFailure = (key) => {
        const now = Date.now();
        let attempts = loginAttempts.get(key);
        if (!attempts || attempts.resetAt <= now) {
            if (loginAttempts.size >= 1000) {
                const oldestIp = loginAttempts.keys().next().value;
                if (oldestIp)
                    loginAttempts.delete(oldestIp);
            }
            attempts = { count: 0, resetAt: now + loginWindowMs };
            loginAttempts.set(key, attempts);
        }
        attempts.count += 1;
    };
    app.get('/api/auth/status', (req, res) => {
        res.json({
            ok: true,
            authEnabled: (0, auth_guard_1.isAuthEnabled)(),
            authenticated: (0, auth_guard_1.isRequestAuthorized)(req),
            user: (0, auth_guard_1.getAuthenticatedUser)(req),
            signupOpen: true,
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
    app.post('/api/auth/signup', (req, res) => {
        const key = rateKey(req);
        const gate = rateLimited(key);
        if (gate.limited) {
            res.setHeader('Retry-After', String(gate.retryAfter));
            res.status(429).json({ ok: false, code: 'SIGNUP_RATE_LIMITED', error: 'Too many attempts. Try again later.' });
            return;
        }
        const result = (0, user_store_1.createUser)(req.body || {});
        if (!result.ok || !result.user) {
            res.status(400).json({
                ok: false,
                code: 'SIGNUP_INVALID',
                field: result.field || null,
                error: result.error || 'Unable to create account.',
            });
            return;
        }
        loginAttempts.delete(key);
        (0, auth_guard_1.invalidateUserCountCache)();
        (0, user_store_1.purgeExpiredSessions)();
        const token = (0, user_store_1.createUserSession)(result.user.id);
        (0, auth_guard_1.setAuthCookie)(res, token);
        res.status(201).json({
            ok: true,
            authEnabled: true,
            authenticated: true,
            user: result.user,
        });
    });
    app.post('/api/auth/login', (req, res) => {
        const key = rateKey(req);
        const gate = rateLimited(key);
        if (gate.limited) {
            res.setHeader('Retry-After', String(gate.retryAfter));
            res.status(429).json({ ok: false, code: 'LOGIN_RATE_LIMITED', error: 'Too many failed sign-in attempts. Try again later.' });
            return;
        }
        const email = String(req.body?.email ?? '').trim();
        const candidate = String(req.body?.password ?? '');
        // --- Email/password account sign-in ---
        if (email) {
            const user = (0, user_store_1.authenticateUser)(email, candidate);
            if (!user) {
                noteFailure(key);
                res.status(401).json({ ok: false, code: 'INVALID_CREDENTIALS', error: 'Invalid email or password.' });
                return;
            }
            loginAttempts.delete(key);
            const token = (0, user_store_1.createUserSession)(user.id);
            (0, auth_guard_1.setAuthCookie)(res, token);
            res.json({ ok: true, authEnabled: true, authenticated: true, user });
            return;
        }
        // --- Legacy admin password sign-in ---
        if (!(0, auth_guard_1.isAuthEnabled)()) {
            res.json({ ok: true, authEnabled: false, authenticated: true });
            return;
        }
        if (!(0, auth_guard_1.constantTimePasswordMatch)(candidate)) {
            noteFailure(key);
            res.status(401).json({ ok: false, code: 'INVALID_PASSWORD', error: 'Invalid admin password' });
            return;
        }
        loginAttempts.delete(key);
        const token = (0, auth_guard_1.createSessionToken)();
        (0, auth_guard_1.setAuthCookie)(res, token);
        res.json({ ok: true, authEnabled: true, authenticated: true, token });
    });
    app.post('/api/auth/logout', (req, res) => {
        (0, user_store_1.destroyUserSession)((0, auth_guard_1.getRequestSessionToken)(req));
        (0, auth_guard_1.clearAuthCookie)(res);
        res.json({ ok: true, authEnabled: (0, auth_guard_1.isAuthEnabled)(), authenticated: !(0, auth_guard_1.isAuthEnabled)() });
    });
    app.use('/api', auth_guard_1.apiAuthMiddleware);
    const buildPayload = (state = (0, db_1.getConsoleState)()) => {
        const validations = (0, settings_builder_1.validateState)(state);
        const counts = {
            ok: validations.filter((v) => v.level === 'ok').length,
            wn: validations.filter((v) => v.level === 'wn').length,
            er: validations.filter((v) => v.level === 'er').length,
        };
        const settingsByAgentId = Object.fromEntries(state.agents.map((a) => [
            a.id,
            {
                agentId: a.id,
                agentName: a.name,
                settings: (0, settings_builder_1.buildDeepgramSettings)(state, a),
            },
        ]));
        return {
            state,
            validations,
            counts,
            settingsByAgentId,
            viciConfig: (0, settings_builder_1.generateViciConfig)(state),
            revisions: (0, db_1.listRevisions)(12),
            secrets: (0, env_store_1.getSecretsStatus)(),
            viciBridge: viciBridge ? viciBridge.getStatus() : null,
        };
    };
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
    app.get('/api/state', (_req, res) => {
        res.json({ ok: true, ...buildPayload() });
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
    // Step 2: Simulator call log history endpoints
    app.get('/api/simulator/logs', (req, res) => {
        const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : undefined;
        const logs = (0, db_1.listSimulatorCallLogs)(agentId, 20);
        res.json({ ok: true, count: logs.length, logs });
    });
    app.delete('/api/simulator/logs', (req, res) => {
        const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : undefined;
        (0, db_1.clearSimulatorCallLogs)(agentId);
        res.json({ ok: true });
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
    app.get('/api/vici/logs', (_req, res) => {
        const logs = (0, db_1.listBridgeCallLogs)(25);
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
    app.post('/api/vici/verify', async (req, res) => {
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
    });
    app.post('/api/vici/simulate-call', async (req, res) => {
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
    });
    app.get('/api/vici/deploy-script', (_req, res) => {
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
    app.post('/api/vici/calls/:callId/transfer', async (req, res) => {
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
    });
    app.post('/api/functions/test-webhook', async (req, res) => {
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
    });
    app.get('/api/vici/release-bundle', (_req, res) => {
        const bundlePath = path_1.default.join(data_paths_1.DATA_DIR, 'voice-agent-vicibox-release.tar.gz');
        try {
            if (!fs_1.default.existsSync(bundlePath)) {
                const projectRoot = path_1.default.resolve(__dirname, '..');
                child_process_1.default.execFileSync('tar', [
                    '-czf',
                    bundlePath,
                    '--exclude=node_modules',
                    '--exclude=.git',
                    '--exclude=.env',
                    '--exclude=data',
                    '--exclude=logs',
                    '--exclude=logs/*',
                    '--exclude=tools/cloudflared.exe',
                    '-C',
                    path_1.default.dirname(projectRoot),
                    path_1.default.basename(projectRoot),
                ], { timeout: 20000 });
            }
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
    app.post('/api/secrets', async (req, res) => {
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
    });
    app.post('/api/deepgram/verify', async (req, res) => {
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
    });
    app.get('/api/deepgram/voices', async (req, res) => {
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
    });
    app.get('/api/deepgram/llm-models', async (_req, res) => {
        const models = await (0, deepgram_catalog_1.fetchDeepgramLlmModels)();
        res.json({ ok: true, count: models.length, models });
    });
    app.get('/api/deepgram/sample', async (req, res) => {
        try {
            const sampleUrl = String(req.query.url || '');
            const { buffer, contentType } = await (0, deepgram_catalog_1.fetchAllowedSampleAudio)(sampleUrl);
            res.setHeader('Content-Type', contentType);
            res.setHeader('Cache-Control', 'public, max-age=86400');
            res.send(buffer);
        }
        catch (err) {
            res.status(400).json({ ok: false, error: err?.message || 'Unable to stream sample audio' });
        }
    });
    app.post('/api/tts/preview', async (req, res) => {
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
    });
    const publicDir = path_1.default.resolve(__dirname, '..', 'public');
    app.use(express_1.default.static(publicDir));
    // Dedicated authentication pages (same shell, tabbed Sign In / Sign Up)
    app.get('/login', (_req, res) => {
        res.sendFile(path_1.default.join(publicDir, 'login.html'));
    });
    app.get('/signup', (_req, res) => {
        res.sendFile(path_1.default.join(publicDir, 'login.html'));
    });
    app.get('*', (_req, res) => {
        res.sendFile(path_1.default.join(publicDir, 'index.html'));
    });
    return app;
}
function createServerWithSimulator(bridgeOpts) {
    const enableBridge = bridgeOpts?.enableBridge ?? false;
    const viciBridge = enableBridge ? new vici_bridge_1.VicidialBridgeService(bridgeOpts) : undefined;
    const app = createApp(viciBridge);
    const server = http_1.default.createServer(app);
    const simWss = (0, live_simulator_1.attachLiveSimulator)(undefined, true);
    const monitorWss = viciBridge ? viciBridge.createMonitorWebSocketServer() : null;
    server.on('upgrade', (req, socket, head) => {
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
    });
    return { app, server, viciBridge };
}
if (require.main === module) {
    const initialPort = Number(process.env.PORT || 3000);
    const host = process.env.HOST || '127.0.0.1';
    const debugMode = process.env.VAC_DEBUG === '1';
    if (!(0, auth_guard_1.isLoopbackIp)(host) && !(0, auth_guard_1.isAuthEnabled)() && !debugMode) {
        console.error('[VoiceAgentConsole] Refusing to bind to a non-loopback interface without ADMIN_PASSWORD.');
        process.exit(1);
    }
    const { server, viciBridge } = createServerWithSimulator({ enableBridge: true });
    (async () => {
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
        const listenWithFallback = (candidatePort, retriesLeft) => {
            const onError = (err) => {
                if (err.code === 'EADDRINUSE' && retriesLeft > 0) {
                    const nextPort = candidatePort === 3000 ? 3850 : candidatePort + 1;
                    console.warn(`[VoiceAgentConsole] Port ${candidatePort} is busy (EADDRINUSE) — switching automatically to port ${nextPort}...`);
                    server.removeListener('error', onError);
                    listenWithFallback(nextPort, retriesLeft - 1);
                    return;
                }
                console.error('[VoiceAgentConsole] HTTP listen error:', err);
                process.exit(1);
            };
            server.once('error', onError);
            server.listen(candidatePort, host, () => {
                server.removeListener('error', onError);
                process.env.PORT = String(candidatePort);
                console.log(`[VoiceAgentConsole] Step 4 Production Server + Bridge listening on http://localhost:${candidatePort} (bound ${host}:${candidatePort})${debugMode ? ' [DEBUG MODE]' : ''}`);
                if (debugMode) {
                    const currentState = (0, db_1.getConsoleState)();
                    const checks = (0, settings_builder_1.validateState)(currentState);
                    const okCount = checks.filter((c) => c.level === 'ok').length;
                    const wnCount = checks.filter((c) => c.level === 'wn').length;
                    const erCount = checks.filter((c) => c.level === 'er').length;
                    console.log(`[VAC:DEBUG] Active state loaded: ${currentState.agents.length} agents (${currentState.agents.map((a) => `"${a.name}"`).join(', ')}), ${currentState.campaigns.length} campaigns (${currentState.campaigns.map((c) => `"${c.name}"`).join(', ')}) | TTS=${currentState.services.tts.model || 'none'} | Pre-flight checks: ${okCount} passed, ${wnCount} warnings, ${erCount} errors`);
                }
                (0, deepgram_catalog_1.fetchDeepgramVoiceCatalog)().catch(() => { });
            });
        };
        listenWithFallback(initialPort, 100);
    })().catch((err) => {
        console.error('[VoiceAgentConsole] Startup fatal error:', err);
        process.exit(1);
    });
}
