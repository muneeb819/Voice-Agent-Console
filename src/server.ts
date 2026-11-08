import dns from 'dns';
import fs from 'fs';
import http from 'http';
import net from 'net';
import path from 'path';
import express, { Request, Response } from 'express';

dns.setDefaultResultOrder('ipv4first');
if (typeof net.setDefaultAutoSelectFamily === 'function') {
  net.setDefaultAutoSelectFamily(false);
}

import { AsteriskAmiClient } from './ami-client';
import {
  apiAuthMiddleware,
  clearAuthCookie,
  constantTimePasswordMatch,
  createSessionToken,
  getAuthenticatedUser,
  getRequestSessionToken,
  hasActiveAuthSession,
  hasRegisteredUsers,
  invalidateAdminSession,
  invalidateUserCountCache,
  isAuthEnabled,
  isLoopbackIp,
  isRequestAuthorized,
  setAuthCookie,
} from './auth-guard';
import { resolveRecordingPath } from './call-recorder';
import { createReleaseBundle } from './release-bundle';
import { isSameOriginRequest } from './request-origin';
import {
  attachSimulatorRecording,
  clearBridgeCallLogs,
  clearSimulatorCallLogs,
  deleteSimulatorRecording,
  exportBridgeLogsCsv,
  getBridgeAnalyticsSummary,
  getConsoleState,
  getSimulatorCallLog,
  listBridgeCallLogs,
  listGreetingLibrary,
  listRevisions,
  listSimulatorCallLogs,
  saveConsoleState,
} from './db';
import { createDefaultState } from './defaults';
import { DATA_DIR } from './data-paths';
import {
  fetchAllowedSampleAudio,
  fetchDeepgramLlmModels,
  fetchDeepgramVoiceCatalog,
  synthesizeTtsPreview,
} from './deepgram-catalog';
import {
  getSecret,
  getSecretsStatus,
  loadEnv,
  MANAGED_SECRET_KEYS,
  SecretKeyName,
  updateSecrets,
  verifyDeepgramConnection,
} from './env-store';
import { attachLiveSimulator } from './live-simulator';
import {
  isSupportedRecording,
  MAX_SIMULATOR_RECORDING_BYTES,
  removeSimulatorRecording,
  resolveSimulatorRecording,
  writeSimulatorRecording,
} from './simulator-recordings';
import {
  buildDeepgramSettings,
  generateViciConfig,
  getDeploymentReadinessBlockers,
  validateState,
} from './settings-builder';
import { VicidialBridgeService, ViciBridgeOptions } from './vici-bridge';
import { parseVicidialCallerCode, VicidialApiClient } from './vici-client';
import { runSimulatedViciBridgeCall } from './vici-loopback-tester';
import { executeCustomFunctionWebhook } from './webhook-executor';
import {
  authenticateUser,
  countUsers,
  createUser,
  createUserSession,
  destroyUserSession,
  purgeExpiredSessions,
} from './user-store';
import {
  discoverActiveTunnelUrl,
  getCachedTunnelUrlSync,
  getPreferredLanIpv4,
  isTunnelProxyReady,
  startPublicDemoTunnel,
  stopPublicDemoTunnel,
} from './demo-tunnel';
import {
  getSpeechServiceBaseUrl,
  runSpeechServiceRoundTripSmoke,
  verifySpeechServiceConnection,
} from './speech-service-client';

loadEnv();

export function createApp(viciBridge?: VicidialBridgeService) {
  const app = express();
  // Proxy headers are untrusted by default. Configure only known proxy IPs or
  // CIDRs (for example TRUST_PROXY=loopback) when running behind a proxy.
  const trustedProxies = String(process.env.TRUST_PROXY || '').trim();
  if (trustedProxies) app.set('trust proxy', trustedProxies.split(',').map((x) => x.trim()).filter(Boolean));
  const loginAttempts = new Map<string, { count: number; resetAt: number }>();
  const signupAttempts = new Map<string, { count: number; resetAt: number }>();
  const loginWindowMs = 15 * 60 * 1000;
  const loginAttemptLimit = 5;
  const signupAttemptLimit = 10;

  app.use((req, res, next) => {
    // Login handoff and WebSocket URLs can carry a session token; do not send
    // the current URL as a Referer on subsequent browser requests.
    res.setHeader('Referrer-Policy', 'no-referrer');
    // Cookies can be sent cross-site (including when HTTPS uses SameSite=None).
    // Do not grant cross-origin API access, and reject browser requests with a
    // mismatched Origin even when they would not need a CORS preflight.
    if (req.path.startsWith('/api/') && !isSameOriginRequest(req, app.get('trust proxy fn'))) {
      res.status(403).json({ ok: false, error: 'Cross-origin API requests are not allowed.' });
      return;
    }
    // Pre-call GET hooks intentionally support Asterisk CURL without auth.
    // An image/navigation request may have no Origin, so also reject browser
    // fetches to these endpoints from another site or origin.
    const fetchSite = req.get('sec-fetch-site');
    if ((req.path === '/api/vici/register-call' || req.path === '/api/vici/precall') &&
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

  app.use(express.json({ limit: '4mb' }));
  app.use(express.urlencoded({ extended: false }));

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

  const rateKey = (req: Request, subKey = ''): string => {
    // Express resolves req.ip using only explicitly trusted proxies. Never
    // accept client-supplied X-Forwarded-For / CF-Connecting-IP directly.
    const baseIp = String(req.ip || req.socket?.remoteAddress || 'unknown');
    return subKey ? `${baseIp}:${subKey}` : baseIp;
  };

  const canCreateAccount = (req: Request): boolean =>
    hasActiveAuthSession(req) || (!isAuthEnabled() && isRequestAuthorized(req));

  const rateLimited = (
    key: string,
    bucket: Map<string, { count: number; resetAt: number }> = loginAttempts,
    limit = loginAttemptLimit
  ): { limited: boolean; retryAfter: number } => {
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

  const noteFailure = (
    key: string,
    bucket: Map<string, { count: number; resetAt: number }> = loginAttempts
  ): void => {
    const now = Date.now();
    let attempts = bucket.get(key);
    if (!attempts || attempts.resetAt <= now) {
      if (bucket.size >= 1000) {
        const oldestIp = bucket.keys().next().value;
        if (oldestIp) bucket.delete(oldestIp);
      }
      attempts = { count: 0, resetAt: now + loginWindowMs };
      bucket.set(key, attempts);
    }
    attempts.count += 1;
  };

  app.get('/api/auth/status', (req: Request, res: Response) => {
    const user = getAuthenticatedUser(req);
    const sessionAuth = hasActiveAuthSession(req);
    const hasUsers = hasRegisteredUsers();
    res.json({
      ok: true,
      authEnabled: true,
      apiAuthEnforced: isAuthEnabled(),
      hasUsers,
      adminPasswordConfigured: getSecret('ADMIN_PASSWORD').length > 0,
      authenticated: sessionAuth,
      user,
      signupOpen: canCreateAccount(req),
    });
  });

  app.get('/api/auth/me', (req: Request, res: Response) => {
    const user = getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({ ok: false, code: 'AUTH_REQUIRED', error: 'Not signed in.' });
      return;
    }
    res.json({ ok: true, user });
  });

  // Create a new account (email + full name + password) and sign in immediately.
  app.post('/api/auth/signup', (req: Request, res: Response) => {
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

    const result = createUser(req.body || {});
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
    invalidateUserCountCache();
    purgeExpiredSessions();

    const token = createUserSession(result.user.id);
    setAuthCookie(res, token, req);
    res.status(201).json({
      ok: true,
      authEnabled: true,
      authenticated: true,
      user: result.user,
      token,
    });
  });

  app.post('/api/auth/login', (req: Request, res: Response) => {
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
      const user = authenticateUser(email, candidate);
      if (!user) {
        noteFailure(key);
        res.status(401).json({ ok: false, code: 'INVALID_CREDENTIALS', error: 'Invalid email or password.' });
        return;
      }
      loginAttempts.delete(key);
      const token = createUserSession(user.id);
      setAuthCookie(res, token, req);
      res.json({ ok: true, authEnabled: true, authenticated: true, user, token });
      return;
    }

    // --- Legacy admin password sign-in ---
    if (!getSecret('ADMIN_PASSWORD')) {
      res.status(400).json({
        ok: false,
        code: 'ADMIN_PASSWORD_NOT_CONFIGURED',
        error: 'ADMIN_PASSWORD is not configured in server .env. Sign in with your email account or create an account.',
      });
      return;
    }
    if (!constantTimePasswordMatch(candidate)) {
      noteFailure(key);
      res.status(401).json({ ok: false, code: 'INVALID_PASSWORD', error: 'Invalid admin password' });
      return;
    }
    loginAttempts.delete(key);
    const token = createSessionToken();
    setAuthCookie(res, token, req);
    res.json({ ok: true, authEnabled: true, authenticated: true, token });
  });

  app.post('/api/auth/logout', (req: Request, res: Response) => {
    const token = getRequestSessionToken(req);
    invalidateAdminSession(token);
    destroyUserSession(token);
    clearAuthCookie(res, req);
    res.json({ ok: true, authEnabled: true, authenticated: false });
  });

  app.use('/api', apiAuthMiddleware);

  const buildTelemetryOverview = (
    state = getConsoleState(),
    validations = validateState(state),
    publicDemoUrl: string | null = getCachedTunnelUrlSync()
  ) => {
    const okChecks = validations.filter((v) => v.level === 'ok').length;
    const wnChecks = validations.filter((v) => v.level === 'wn').length;
    const erChecks = validations.filter((v) => v.level === 'er').length;
    const totalChecks = Math.max(1, validations.length);

    const bridgeStatus = viciBridge ? viciBridge.getStatus() : null;
    const bridgeAnalytics = getBridgeAnalyticsSummary();
    const simLogs = listSimulatorCallLogs(undefined, 100);
    // Older sandbox/local-speech logs contained synthetic latency; never mix them
    // into the measured Deepgram/bridge figures. Keep the logs themselves intact.
    const simTtfbValues = simLogs
      .filter((s) => s.upstreamMode === 'deepgram')
      .map((s) => s.avgTtfbMs)
      .filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0);
    // Average the retained per-session means, rather than assigning equal
    // weight to channels with different numbers of sessions.
    const bridgeTtfbValues = listBridgeCallLogs(200)
      .map((call) => call.avgTtfbMs)
      .filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0);
    const retainedTtfbValues = [...bridgeTtfbValues, ...simTtfbValues];
    const combinedTtfb = retainedTtfbValues.length
      ? Math.round(retainedTtfbValues.reduce((a, b) => a + b, 0) / retainedTtfbValues.length)
      : null;

    const secrets = getSecretsStatus();
    const configuredKeysCount = Object.values(secrets).filter((s) => s.configured).length;
    const dgConfigured = Boolean(secrets.DEEPGRAM_API_KEY?.configured);

    let recordingsFilesCount = 0;
    let recordingsTotalBytes = 0;
    try {
      const recDir = path.join(DATA_DIR, 'recordings');
      if (fs.existsSync(recDir)) {
        for (const fn of fs.readdirSync(recDir)) {
          if (fn.endsWith('.wav')) {
            recordingsFilesCount += 1;
            recordingsTotalBytes += fs.statSync(path.join(recDir, fn)).size;
          }
        }
      }
    } catch {}

    const allQaTests = Object.values(state.tests || {}).flat();
    const qaPassed = allQaTests.filter((t) => t.r === 'ok').length;
    const qaFailed = allQaTests.filter((t) => t.r === 'f').length;
    const qaPending = allQaTests.filter((t) => t.r === 'p').length;

    const revs = listRevisions(50);
    let registeredUsers = 0;
    try {
      registeredUsers = countUsers();
    } catch {}

    // These are configuration heuristics, not a security audit or certification.
    const preflightScore = Math.max(0, Math.min(100, Math.round(((okChecks - erChecks * 8 - wnChecks * 2) / totalChecks) * 100)));
    const hasPipelineModels = Boolean(
      state.services?.stt?.model && state.services?.llm?.model && state.services?.tts?.model
    );
    const activeSttProv = state.providers.find((p) => p.kind === 'stt' && p.id === state.services?.stt?.providerId);
    const activeTtsProv = state.providers.find((p) => p.kind === 'tts' && p.id === state.services?.tts?.providerId);
    const localSpeechActive = activeSttProv?.type === 'speech_service' && activeTtsProv?.type === 'speech_service';
    const pipelineScore = hasPipelineModels ? (dgConfigured || localSpeechActive ? 100 : 92) : 55;
    const bridgeScore = bridgeStatus?.audioSocketListening && bridgeStatus?.sipRtpListening ? 100 : 0;
    const authEnforced = isAuthEnabled();
    const allowedIps = getSecret('BRIDGE_ALLOWED_IPS').trim();
    const restrictedPeers = !allowedIps || !allowedIps.split(',').some((rule) => /^(?:\*|\d+\.\d+\.\d+\.\d+\/0)$/.test(rule.trim()));
    const securityScore = (authEnforced ? 50 : 0) + (restrictedPeers ? 50 : 0);
    const storageScore = revs.length > 0 ? 100 : 90;
    const disclosureCount = state.campaigns.filter((c) => String(c.disclosure || '').trim().length >= 10).length;
    const disclosuresReady = disclosureCount === state.campaigns.length;
    const complianceScore = disclosuresReady && erChecks === 0 ? 100 : 78;

    const overallQualityScore = Math.round(
      preflightScore * 0.34 +
        pipelineScore * 0.20 +
        bridgeScore * 0.14 +
        securityScore * 0.12 +
        storageScore * 0.10 +
        complianceScore * 0.10
    );

    const qualityGrade =
      overallQualityScore >= 97 && erChecks === 0
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
        lanIp: getPreferredLanIpv4(),
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

  const buildPayload = (state = getConsoleState(), publicDemoUrlOverride?: string | null) => {
    const validations = validateState(state);
    const counts = {
      ok: validations.filter((v) => v.level === 'ok').length,
      wn: validations.filter((v) => v.level === 'wn').length,
      er: validations.filter((v) => v.level === 'er').length,
    };
    const settingsByCampaignId = Object.fromEntries(
      state.campaigns.map((campaign) => {
        const agent = state.agents.find((entry) => entry.id === campaign.agentId);
        return [campaign.id, {
          campaignId: campaign.id,
          campaignName: campaign.name,
          agentId: campaign.agentId || null,
          settings: agent ? buildDeepgramSettings(state, agent, campaign) : null,
        }];
      })
    );
    const settingsByAgentId = Object.fromEntries(
      state.agents.map((agent) => {
        const campaigns = state.campaigns.filter((campaign) => campaign.agentId === agent.id);
        const selectedCampaign = campaigns.length === 1 ? campaigns[0] : undefined;
        return [agent.id, {
          agentId: agent.id,
          agentName: agent.name,
          campaignIds: campaigns.map((campaign) => campaign.id),
          settings: selectedCampaign ? buildDeepgramSettings(state, agent, selectedCampaign) : null,
        }];
      })
    );
    const pubUrl = publicDemoUrlOverride !== undefined ? publicDemoUrlOverride : getCachedTunnelUrlSync();
    return {
      state,
      validations,
      counts,
      readiness: { ready: getDeploymentReadinessBlockers(state).length === 0, blockers: getDeploymentReadinessBlockers(state) },
      settingsByAgentId,
      settingsByCampaignId,
      viciConfig: generateViciConfig(state),
      revisions: listRevisions(12),
      secrets: getSecretsStatus(),
      viciBridge: viciBridge ? viciBridge.getStatus() : null,
      publicDemoUrl: pubUrl,
      telemetry: buildTelemetryOverview(state, validations, pubUrl),
    };
  };

  app.get('/api/health', (req: Request, res: Response) => {
    const authed = isRequestAuthorized(req);
    res.json({
      ok: true,
      step: 4,
      service: 'voice-agent-console',
      storage: 'sqlite+json',
      authEnabled: isAuthEnabled(),
      authenticated: authed,
      websocket: '/ws/simulator',
      viciMonitorWs: '/ws/vici-monitor',
      ...(authed ? { viciBridge: viciBridge ? viciBridge.getStatus() : null } : {}),
      ...(authed ? { secrets: getSecretsStatus() } : {}),
    });
  });

  app.get('/api/state', async (_req: Request, res: Response) => {
    const liveTunnel = await discoverActiveTunnelUrl();
    res.json({ ok: true, ...buildPayload(getConsoleState(), liveTunnel) });
  });

  app.get('/api/telemetry/overview', async (_req: Request, res: Response) => {
    const state = getConsoleState();
    const liveTunnel = await discoverActiveTunnelUrl();
    res.json({
      ok: true,
      telemetry: buildTelemetryOverview(state, validateState(state), liveTunnel),
      publicDemoUrl: liveTunnel,
    });
  });

  app.get('/api/demo-tunnel/status', async (_req: Request, res: Response) => {
    const url = await discoverActiveTunnelUrl();
    res.json({
      ok: true,
      active: Boolean(url),
      publicUrl: url,
      loginUrl: url ? `${url}/login` : null,
      signupUrl: url ? `${url}/signup` : null,
      lanIp: getPreferredLanIpv4(),
    });
  });

  app.post('/api/demo-tunnel/start', async (req: Request, res: Response) => {
    if (!isAuthEnabled() || !hasActiveAuthSession(req)) {
      res.status(403).json({ ok: false, error: 'Sign in before opening a public tunnel.' });
      return;
    }
    const port = Number(process.env.PORT || 533);
    if (!(await isTunnelProxyReady(port))) {
      res.status(409).json({ ok: false, error: 'The local tunnel proxy is not trusted. Configure TRUST_PROXY for the cloudflared connection and restart the console before starting a tunnel.' });
      return;
    }
    const out = await startPublicDemoTunnel(port);
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
  });

  app.post('/api/demo-tunnel/stop', (_req: Request, res: Response) => {
    stopPublicDemoTunnel();
    res.json({ ok: true, active: false, publicUrl: null });
  });

  app.put('/api/state', (req: Request, res: Response) => {
    try {
      const bodyState = req.body?.state ?? req.body;
      const { state, changes, revisionId } = saveConsoleState(bodyState);
      res.json({
        ok: true,
        changes,
        revisionId,
        ...buildPayload(state),
      });
    } catch (err: any) {
      res.status(400).json({ ok: false, error: err?.message || 'Failed to save console state' });
    }
  });

  app.post('/api/state/reset', (_req: Request, res: Response) => {
    const fresh = createDefaultState();
    const { state, changes, revisionId } = saveConsoleState(fresh, 'Reset console to factory defaults');
    res.json({
      ok: true,
      changes,
      revisionId,
      ...buildPayload(state),
    });
  });

  // Shared greeting catalog. The server database is authoritative for calls;
  // the static site uses its own bundled copy and browser-local rotation.
  app.get('/api/greetings', (_req: Request, res: Response) => {
    const greetings = listGreetingLibrary();
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, count: greetings.length, greetings });
  });

  // Step 2: Simulator call log history endpoints
  app.get('/api/simulator/logs', (req: Request, res: Response) => {
    const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : undefined;
    const requested = typeof req.query.limit === 'string' ? Number(req.query.limit) : 20;
    const limit = Number.isFinite(requested) && requested > 0 ? Math.max(1, Math.min(100, Math.floor(requested))) : 20;
    const logs = listSimulatorCallLogs(agentId, limit);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, count: logs.length, logs });
  });

  app.delete('/api/simulator/logs', (req: Request, res: Response) => {
    const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : undefined;
    try {
      clearSimulatorCallLogs(agentId);
      res.json({ ok: true });
    } catch {
      res.status(500).json({ ok: false, error: 'Could not delete all test recordings; some audio may already have been removed, but history was not cleared. Check server storage permissions and retry.' });
    }
  });

  // Upload is allowed only for a completed test that explicitly opted in. The
  // normal API auth/Origin guard applies to upload, playback and deletion.
  const simulatorAudioBody = express.raw({ type: 'application/octet-stream', limit: MAX_SIMULATOR_RECORDING_BYTES });
  app.put('/api/simulator/recordings/:id', (req, res, next) => {
    simulatorAudioBody(req, res, (err: any) => {
      if (!err) { next(); return; }
      const tooLarge = err.type === 'entity.too.large';
      res.status(tooLarge ? 413 : 400).json({ ok: false, error: tooLarge
        ? 'The browser recording exceeds the 20 MB limit.' : 'Could not read the browser recording upload.' });
    });
  }, (req: Request, res: Response) => {
    const id = String(req.params.id || '');
    const log = getSimulatorCallLog(id);
    if (!log) { res.status(404).json({ ok: false, error: 'Browser test not found.' }); return; }
    if (!log.recordingRequested || log.recordingStatus !== 'pending') {
      res.status(409).json({ ok: false, error: 'This test did not opt in to a new recording, or it was already saved or deleted.' });
      return;
    }
    const mime = String(req.get('X-Recording-Type') || '').split(';')[0].trim().toLowerCase();
    const data = req.body;
    if (!Buffer.isBuffer(data) || !isSupportedRecording(data, mime)) {
      res.status(400).json({ ok: false, error: 'Invalid or unsupported audio recording.' });
      return;
    }
    let fileName: string | null = null;
    try {
      fileName = writeSimulatorRecording(id, data, mime);
      const attached = attachSimulatorRecording(id, fileName, mime, data.length, req.get('X-Recording-Truncated') === '1');
      if (!attached) {
        removeSimulatorRecording(fileName);
        res.status(409).json({ ok: false, error: 'Test history changed before audio could be saved.' });
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.status(201).json({ ok: true, bytes: data.length, mime });
    } catch {
      if (fileName) { try { removeSimulatorRecording(fileName); } catch {} }
      res.status(500).json({ ok: false, error: 'Could not save the browser test recording.' });
    }
  });

  app.get('/api/simulator/recordings/:id', (req: Request, res: Response) => {
    const log = getSimulatorCallLog(String(req.params.id || ''));
    try {
      const fullPath = log?.recordingStatus === 'available' && log.recordingFile
        ? resolveSimulatorRecording(log.recordingFile) : null;
      if (!fullPath || !log?.recordingMime) { res.status(404).json({ ok: false, error: 'Browser test recording not found.' }); return; }
      res.setHeader('Content-Type', log.recordingMime);
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.sendFile(fullPath);
    } catch {
      res.status(500).json({ ok: false, error: 'Could not read the browser test recording.' });
    }
  });

  app.delete('/api/simulator/recordings/:id', (req: Request, res: Response) => {
    try {
      if (!deleteSimulatorRecording(String(req.params.id || ''))) {
        res.status(404).json({ ok: false, error: 'Browser test not found.' });
        return;
      }
      res.json({ ok: true });
    } catch {
      res.status(500).json({ ok: false, error: 'Could not delete the recording. Check server storage permissions and retry.' });
    }
  });

  // ==================== STEP 3: VICIDIAL BRIDGE ENDPOINTS ====================

  const handleRegisterCall = (req: Request, res: Response) => {
    if (!viciBridge) {
      res.status(503).send('ERROR: VICIdial Bridge not initialized');
      return;
    }
    const merged = { ...(req.query as Record<string, any>), ...(req.body || {}) };
    const reg = viciBridge.registerPreCall({
      uniqueid: merged.uniqueid,
      vici_cid: merged.vici_cid || merged.caller_code,
      phone: merged.phone,
      exten: merged.exten,
      channel: merged.channel,
      agent_user: merged.agent_user,
    });

    const wantsJson =
      merged.format === 'json' ||
      String(req.headers.accept || '').includes('application/json');
    if (wantsJson) {
      res.json({ ok: true, ...reg });
    } else {
      // Plain 36-char RFC4122 UUID for Asterisk Set(_BRIDGE_UUID=${CURL(...)})
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.send(reg.uuid);
    }
  };

  app.get('/api/vici/register-call', handleRegisterCall);
  app.post('/api/vici/register-call', handleRegisterCall);
  app.get('/api/vici/precall', handleRegisterCall);
  app.post('/api/vici/precall', handleRegisterCall);

  app.get('/api/vici/status', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      bridge: viciBridge ? viciBridge.getStatus() : null,
      logs: listBridgeCallLogs(20),
    });
  });

  app.get('/api/vici/logs', (_req: Request, res: Response) => {
    const logs = listBridgeCallLogs(25);
    res.json({ ok: true, count: logs.length, logs });
  });

  app.delete('/api/vici/logs', (_req: Request, res: Response) => {
    clearBridgeCallLogs();
    res.json({ ok: true });
  });

  app.post('/api/vici/parse-cid', (req: Request, res: Response) => {
    const parsed = parseVicidialCallerCode(req.body?.callerIdName, req.body?.callerIdNum);
    res.json({ ok: true, parsed });
  });

  app.post('/api/vici/verify', async (req: Request, res: Response) => {
    try {
      const st = getConsoleState();
      const viciCfg = req.body?.vici ? { ...st.vici, ...req.body.vici } : st.vici;
      const viciClient = new VicidialApiClient(viciCfg);
      const amiClient = new AsteriskAmiClient(viciCfg);

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
    } catch (err: any) {
      res.status(400).json({ ok: false, error: err?.message || 'VICIdial verification failed' });
    }
  });

  app.post('/api/vici/simulate-call', async (req: Request, res: Response) => {
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

      const result = await runSimulatedViciBridgeCall(viciBridge, {
        transport,
        scenario,
        upstream,
        callerCode: req.body?.callerCode,
        phone: req.body?.phone,
        campaignId: String(req.body?.campaignId || ''),
        exten: req.body?.exten,
      });
      res.json(result);
    } catch (err: any) {
      res.status(400).json({
        ok: false,
        error: err?.message || 'Simulated VICIdial bridge call failed',
      });
    }
  });

  app.get('/api/vici/deploy-script', (_req: Request, res: Response) => {
    const blockers = getDeploymentReadinessBlockers(getConsoleState());
    if (blockers.length) {
      res.status(409).json({ ok: false, error: 'Deployment is blocked until all agents and campaigns are ready.', blockers });
      return;
    }
    const scriptPath = path.resolve(__dirname, '..', 'deploy', 'vicibox-install.sh');
    if (fs.existsSync(scriptPath)) {
      res.setHeader('Content-Type', 'text/x-shellscript; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="vicibox-install.sh"');
      res.send(fs.readFileSync(scriptPath, 'utf8'));
    } else {
      res.status(404).send('# Deploy script not found');
    }
  });

  // ==================== STEP 4: RECORDINGS, ANALYTICS, CSV, WEBHOOKS & BUNDLE ====================

  app.get('/api/vici/recordings/:file', (req: Request, res: Response) => {
    const wavPath = resolveRecordingPath(String(req.params.file || ''));
    if (!wavPath) {
      res.status(404).json({ ok: false, error: 'Recording WAV file not found' });
      return;
    }
    res.setHeader('Content-Type', 'audio/wav');
    res.sendFile(wavPath);
  });

  app.get('/api/vici/analytics', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      analytics: getBridgeAnalyticsSummary(),
      bridge: viciBridge ? viciBridge.getStatus() : null,
    });
  });

  app.get('/api/vici/logs.csv', (_req: Request, res: Response) => {
    const csv = exportBridgeLogsCsv(200);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="vici-bridge-cdrs-${stamp}.csv"`);
    res.send(csv);
  });

  app.post('/api/vici/calls/:callId/hangup', (req: Request, res: Response) => {
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

  app.post('/api/vici/calls/:callId/transfer', async (req: Request, res: Response) => {
    if (!viciBridge) {
      res.status(503).json({ ok: false, error: 'Bridge service not attached' });
      return;
    }
    const callId = String(req.params.callId || '');
    const ok = await viciBridge.forceTransferCall(
      callId,
      req.body?.reason || 'Supervisor live transfer'
    );
    if (!ok) {
      res.status(404).json({ ok: false, error: 'Active call not found or already ended' });
      return;
    }
    res.json({ ok: true, callId, action: 'force_transfer' });
  });

  app.post('/api/functions/test-webhook', async (req: Request, res: Response) => {
    try {
      const state = getConsoleState();
      const fnDef =
        req.body?.fn ||
        state.functions.find((f) => f.id === req.body?.fnId || f.name === req.body?.name);
      if (!fnDef) {
        res.status(404).json({ ok: false, error: 'Function definition not found' });
        return;
      }
      const args = req.body?.args && typeof req.body.args === 'object' ? req.body.args : {};
      const out = await executeCustomFunctionWebhook(fnDef, args, {
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
    } catch (err: any) {
      res.status(400).json({ ok: false, error: err?.message || 'Webhook test failed' });
    }
  });

  app.get('/api/vici/release-bundle', (_req: Request, res: Response) => {
    const blockers = getDeploymentReadinessBlockers(getConsoleState());
    if (blockers.length) {
      res.status(409).json({ ok: false, error: 'Release bundle is blocked until all agents and campaigns are ready.', blockers });
      return;
    }
    const bundlePath = path.join(DATA_DIR, 'voice-agent-vicibox-release.tar.gz');
    try {
      // Rebuild from a filtered allowlist; a cached archive could otherwise be
      // stale or contain private files from an earlier installation.
      createReleaseBundle(path.resolve(__dirname, '..'), bundlePath);
      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader('Content-Disposition', 'attachment; filename="voice-agent-vicibox-release.tar.gz"');
      res.sendFile(bundlePath);
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || 'Failed to package release bundle' });
    }
  });

  // ==================== SECRETS & DEEPGRAM ENDPOINTS ====================

  app.get('/api/secrets', (_req: Request, res: Response) => {
    res.json({ ok: true, secrets: getSecretsStatus() });
  });

  app.post('/api/secrets', async (req: Request, res: Response) => {
    try {
      const incoming = req.body || {};
      const updates: Partial<Record<SecretKeyName, string>> = {};
      for (const key of MANAGED_SECRET_KEYS) {
        if (typeof incoming[key] === 'string') {
          updates[key] = incoming[key];
        }
      }

      let deepgramDiagnostic = null;
      const hasCustomMockUpstream = Boolean((process.env.DEEPGRAM_AGENT_URL || '').trim());
      if (updates.DEEPGRAM_API_KEY && updates.DEEPGRAM_API_KEY.trim() && !hasCustomMockUpstream) {
        deepgramDiagnostic = await verifyDeepgramConnection(updates.DEEPGRAM_API_KEY);
        if (!deepgramDiagnostic.restAuth.ok) {
          res.status(400).json({
            ok: false,
            error: `Deepgram API key rejected — ${deepgramDiagnostic.restAuth.error}`,
            deepgramDiagnostic,
            secrets: getSecretsStatus(),
          });
          return;
        }
      }

      updateSecrets(updates);
      if (updates.DEEPGRAM_API_KEY && updates.DEEPGRAM_API_KEY.trim() && !hasCustomMockUpstream) {
        await fetchDeepgramVoiceCatalog(true).catch(() => {});
      }

      res.json({
        ok: true,
        deepgramVerified: Boolean(deepgramDiagnostic?.ok),
        deepgramDiagnostic,
        secrets: getSecretsStatus(),
      });
    } catch (err: any) {
      res.status(400).json({
        ok: false,
        error: err?.message || 'Failed to update server .env secrets',
        secrets: getSecretsStatus(),
      });
    }
  });

  app.post('/api/deepgram/verify', async (req: Request, res: Response) => {
    try {
      const explicitKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey : undefined;
      const diagnostic = await verifyDeepgramConnection(explicitKey);
      res.status(diagnostic.ok ? 200 : 400).json({
        ok: diagnostic.ok,
        diagnostic,
        secrets: getSecretsStatus(),
      });
    } catch (err: any) {
      res.status(400).json({
        ok: false,
        error: err?.message || 'Deepgram diagnostic check failed',
      });
    }
  });

  app.get('/api/deepgram/voices', async (req: Request, res: Response) => {
    try {
      const force = req.query.refresh === '1' || req.query.refresh === 'true';
      const catalog = await fetchDeepgramVoiceCatalog(force);

      const q = String(req.query.q || '').trim().toLowerCase();
      const family = String(req.query.family || '').trim().toLowerCase();
      const lang = String(req.query.language || '').trim().toLowerCase();
      const accent = String(req.query.accent || '').trim().toLowerCase();
      const gender = String(req.query.gender || '').trim().toLowerCase();
      const useCase = String(req.query.useCase || '').trim().toLowerCase();

      const filtered = catalog.voices.filter((v) => {
        if (family && v.family !== family) return false;
        if (
          lang &&
          v.primaryLanguage !== lang &&
          !v.languages.some((l) => l.toLowerCase().startsWith(lang))
        ) {
          return false;
        }
        if (accent && v.accent.toLowerCase() !== accent) return false;
        if (gender && v.gender !== gender) return false;
        if (useCase && !v.useCases.some((u) => u.toLowerCase().includes(useCase))) return false;
        if (q) {
          const hay = `${v.id} ${v.displayName} ${v.accent} ${v.age} ${v.tags.join(' ')} ${v.useCases.join(' ')}`.toLowerCase();
          if (!hay.includes(q)) return false;
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
    } catch (err: any) {
      res.status(400).json({
        ok: false,
        error: err?.message || 'Failed to load Deepgram voice catalog',
      });
    }
  });

  app.get('/api/deepgram/llm-models', async (_req: Request, res: Response) => {
    const models = await fetchDeepgramLlmModels();
    res.json({ ok: true, count: models.length, models });
  });

  app.get('/api/deepgram/sample', async (req: Request, res: Response) => {
    try {
      const sampleUrl = String(req.query.url || '');
      const { buffer, contentType } = await fetchAllowedSampleAudio(sampleUrl);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(buffer);
    } catch (err: any) {
      res.status(err?.statusCode || 400).json({ ok: false, code: err?.code, error: err?.message || 'Unable to stream sample audio' });
    }
  });

  app.post('/api/tts/preview', async (req: Request, res: Response) => {
    try {
      const result = await synthesizeTtsPreview(req.body || {});
      res.setHeader('Content-Type', result.contentType);
      res.setHeader('X-TTS-Model', result.usedModel);
      res.setHeader('Cache-Control', 'no-store');
      res.send(result.buffer);
    } catch (err: any) {
      const status = typeof err?.statusCode === 'number' ? err.statusCode : 400;
      res.status(status).json({
        ok: false,
        code: err?.code || 'TTS_PREVIEW_FAILED',
        error: err?.message || 'Failed to synthesize TTS preview',
      });
    }
  });

  // ==================== LOCAL SPEECH SERVICE (1-CLICK STT + TTS) ====================

  app.get('/api/speech-service/status', async (req: Request, res: Response) => {
    try {
      const explicitUrl = typeof req.query.url === 'string' ? req.query.url : undefined;
      const diagnostic = await verifySpeechServiceConnection(explicitUrl);
      const state = getConsoleState();
      const activeStt = state.providers.find((p) => p.kind === 'stt' && p.id === state.services?.stt?.providerId);
      const activeTts = state.providers.find((p) => p.kind === 'tts' && p.id === state.services?.tts?.providerId);
      res.json({
        ok: diagnostic.ok,
        activeInConsole: activeStt?.type === 'speech_service' && activeTts?.type === 'speech_service',
        configuredUrl: getSpeechServiceBaseUrl(explicitUrl),
        diagnostic,
        secrets: getSecretsStatus(),
      });
    } catch (err: any) {
      res.status(400).json({
        ok: false,
        error: err?.message || 'Failed to query Speech Service status',
      });
    }
  });

  app.post('/api/speech-service/test', async (req: Request, res: Response) => {
    try {
      const result = await runSpeechServiceRoundTripSmoke({
        url: typeof req.body?.url === 'string' ? req.body.url : undefined,
        apiKey: typeof req.body?.apiKey === 'string' ? req.body.apiKey : undefined,
        voice: typeof req.body?.voice === 'string' ? req.body.voice : undefined,
        text: typeof req.body?.text === 'string' ? req.body.text : undefined,
      });
      res.status(result.ok ? 200 : 400).json(result);
    } catch (err: any) {
      res.status(400).json({
        ok: false,
        error: err?.message || 'Speech Service round-trip test failed',
      });
    }
  });

  app.post('/api/speech-service/activate', async (req: Request, res: Response) => {
    try {
      const secretUpdates: Partial<Record<SecretKeyName, string>> = {};
      if (typeof req.body?.url === 'string' && req.body.url.trim()) {
        secretUpdates.SPEECH_SERVICE_URL = req.body.url.trim();
      }
      if (typeof req.body?.apiKey === 'string') {
        secretUpdates.SPEECH_SERVICE_API_KEY = req.body.apiKey;
      }
      if (Object.keys(secretUpdates).length > 0) {
        updateSecrets(secretUpdates);
      }

      const diagnostic = await verifySpeechServiceConnection();
      if (!diagnostic.ok) {
        res.status(400).json({
          ok: false,
          error: diagnostic.error || `Speech Service not ready at ${diagnostic.baseUrl}`,
          diagnostic,
          secrets: getSecretsStatus(),
        });
        return;
      }

      const state = getConsoleState();
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

      const chosenSttModel =
        typeof req.body?.sttModel === 'string' && req.body.sttModel.trim()
          ? req.body.sttModel.trim()
          : 'large-v3-turbo';
      const chosenVoice =
        typeof req.body?.voice === 'string' && req.body.voice.trim() ? req.body.voice.trim() : 'af_heart';

      state.services.stt = { providerId: localStt.id, model: chosenSttModel };
      state.services.tts = { providerId: localTts.id, model: chosenVoice };
      if (!state.services.llm?.providerId || !state.services.llm?.model) {
        const defaultLlm = state.providers.find((p) => p.kind === 'llm' && p.type === 'open_ai') || state.providers.find((p) => p.kind === 'llm');
        if (defaultLlm) {
          state.services.llm = { providerId: defaultLlm.id, model: 'gpt-4o-mini' };
        }
      }

      const saved = saveConsoleState(state, `1-Click Activated Local Speech Service (${chosenSttModel} + ${chosenVoice})`);
      res.json({
        ok: true,
        diagnostic,
        revisionId: saved.revisionId,
        changes: saved.changes,
        ...buildPayload(saved.state),
      });
    } catch (err: any) {
      res.status(400).json({
        ok: false,
        error: err?.message || 'Failed to activate Local Speech Service',
      });
    }
  });

  const publicDir = path.resolve(__dirname, '..', 'public');

  // Dedicated authentication pages (same shell, tabbed Sign In / Create Account)
  const serveAuthShell = (req: Request, res: Response) => {
    // A signed-in operator can explicitly open /signup to provision an account.
    if (hasActiveAuthSession(req) && req.path !== '/signup') {
      const rawNext = typeof req.query.next === 'string' ? req.query.next : '';
      const target = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/';
      res.redirect(target);
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(publicDir, 'login.html'));
  };

  app.get('/login', serveAuthShell);
  app.get('/login.html', serveAuthShell);
  app.get('/signup', serveAuthShell);

  // Gate the web console entry point so Sign Up / Sign In is always the very first page
  const serveConsoleEntry = (req: Request, res: Response) => {
    if (!hasActiveAuthSession(req)) {
      const entryPath = isAuthEnabled() ? '/login' : '/signup';
      const qsIdx = req.originalUrl.indexOf('?');
      const nextSuffix =
        (req.path === '/' || req.path === '/index.html') && qsIdx === -1
          ? ''
          : `?next=${encodeURIComponent(req.originalUrl)}`;
      res.redirect(`${entryPath}${nextSuffix}`);
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(publicDir, 'index.html'));
  };

  app.get('/', serveConsoleEntry);
  app.get('/index.html', serveConsoleEntry);

  app.use(express.static(publicDir, { index: false }));

  app.get('*', serveConsoleEntry);

  return app;
}

export function createServerWithSimulator(bridgeOpts?: ViciBridgeOptions & { enableBridge?: boolean }) {
  const enableBridge = bridgeOpts?.enableBridge ?? false;
  const viciBridge = enableBridge ? new VicidialBridgeService(bridgeOpts) : undefined;
  const app = createApp(viciBridge);
  const server = http.createServer(app);

  const simWss = attachLiveSimulator(undefined, true);
  const monitorWss = viciBridge ? viciBridge.createMonitorWebSocketServer() : null;

  server.on('upgrade', (req, socket, head) => {
    if (!isSameOriginRequest(req, app.get('trust proxy fn'))) {
      socket.write('HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: 9\r\n\r\nForbidden');
      socket.destroy();
      return;
    }
    if (!isRequestAuthorized(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\nContent-Length: 12\r\n\r\nUnauthorized');
      socket.destroy();
      return;
    }
    const pathname = (req.url || '').split('?')[0];
    if (pathname === '/ws/simulator') {
      simWss.handleUpgrade(req, socket, head, (ws) => {
        simWss.emit('connection', ws, req);
      });
    } else if (pathname === '/ws/vici-monitor' && monitorWss) {
      monitorWss.handleUpgrade(req, socket, head, (ws) => {
        monitorWss.emit('connection', ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  return { app, server, viciBridge };
}

if (require.main === module) {
  const requestedPort = Number(process.env.PORT || 533);
  const initialPort =
    process.env.E2B_SANDBOX === 'true' && requestedPort > 0 && requestedPort < 1024
      ? requestedPort + 5000
      : requestedPort;
  const host = process.env.HOST || '127.0.0.1';
  const debugMode = process.env.VAC_DEBUG === '1';
  if (!isLoopbackIp(host) && !isAuthEnabled()) {
    console.error('[VoiceAgentConsole] Refusing to bind to a non-loopback interface without an admin password or a registered user.');
    process.exit(1);
  }
  const { server, viciBridge } = createServerWithSimulator({ enableBridge: true });

  (async () => {
    if (initialPort !== requestedPort) {
      console.warn(
        `[VoiceAgentConsole] Cloud preview proxy blocks privileged ports <1024 (port ${requestedPort}) — mapping preview listener to port ${initialPort} (production ViciBox/115.186.137.240 keeps port ${requestedPort}).`
      );
    }

    let bindHost = host;
    await new Promise<void>((resolveListen) => {
      const listenWithFallback = (candidatePort: number, retriesLeft: number) => {
        let onListening: () => void;
        const onError = (err: NodeJS.ErrnoException) => {
          server.removeListener('listening', onListening);
          if (err.code === 'EACCES' && candidatePort < 1024 && retriesLeft > 0) {
            const nextPort = candidatePort + 5000;
            console.warn(
              `[VoiceAgentConsole] Privileged port ${candidatePort} requires CAP_NET_BIND_SERVICE (EACCES) — switching automatically to port ${nextPort}...`
            );
            server.removeListener('error', onError);
            listenWithFallback(nextPort, retriesLeft - 1);
            return;
          }
          if (err.code === 'EADDRINUSE' && retriesLeft > 0) {
            const nextPort = candidatePort + 1;
            console.warn(
              `[VoiceAgentConsole] Port ${candidatePort} is busy (EADDRINUSE) — switching automatically to port ${nextPort}...`
            );
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
          console.log(
            `[VoiceAgentConsole] Server listening on ${bindHost}:${candidatePort}${debugMode ? ' [DEBUG MODE]' : ''}`
          );
          if (debugMode) {
            const currentState = getConsoleState();
            const checks = validateState(currentState);
            const okCount = checks.filter((c) => c.level === 'ok').length;
            const wnCount = checks.filter((c) => c.level === 'wn').length;
            const erCount = checks.filter((c) => c.level === 'er').length;
            console.log(
              `[VAC:DEBUG] Active state loaded: ${currentState.agents.length} agents (${currentState.agents.map((a) => `"${a.name}"`).join(', ')}), ${currentState.campaigns.length} campaigns (${currentState.campaigns.map((c) => `"${c.name}"`).join(', ')}) | TTS=${currentState.services.tts.model || 'none'} | Pre-flight checks: ${okCount} passed, ${wnCount} warnings, ${erCount} errors`
            );
          }
          fetchDeepgramVoiceCatalog().catch(() => {});
          resolveListen();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(candidatePort, bindHost);
      };

      listenWithFallback(initialPort, 100);
    });

    if (viciBridge) {
      try {
        await viciBridge.start();
        const st = viciBridge.getStatus();
        console.log(
          `[ViciBridge] AudioSocket TCP listening on ${st.bindHost}:${st.audioSocketPort} | SIP+RTP (PCMU) UDP listening on ${st.bindHost}:${st.sipPort}`
        );
      } catch (bridgeErr: any) {
        console.warn(
          `[ViciBridge] Telephony UDP/TCP listener skipped on cloud host (${bridgeErr?.message || bridgeErr}) — Web Console & Live WebSocket Simulator remain active.`
        );
      }
    }
  })().catch((err) => {
    console.error('[VoiceAgentConsole] Startup fatal error:', err);
    process.exit(1);
  });
}
