import childProcess from 'child_process';
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
  isAuthEnabled,
  isRequestAuthorized,
  setAuthCookie,
} from './auth-guard';
import { resolveRecordingPath } from './call-recorder';
import {
  clearBridgeCallLogs,
  clearSimulatorCallLogs,
  exportBridgeLogsCsv,
  getBridgeAnalyticsSummary,
  getConsoleState,
  listBridgeCallLogs,
  listRevisions,
  listSimulatorCallLogs,
  saveConsoleState,
} from './db';
import { createDefaultState } from './defaults';
import {
  fetchAllowedSampleAudio,
  fetchDeepgramLlmModels,
  fetchDeepgramVoiceCatalog,
  synthesizeTtsPreview,
} from './deepgram-catalog';
import {
  getSecretsStatus,
  loadEnv,
  MANAGED_SECRET_KEYS,
  SecretKeyName,
  updateSecrets,
  verifyDeepgramConnection,
} from './env-store';
import { attachLiveSimulator } from './live-simulator';
import {
  buildDeepgramSettings,
  generateViciConfig,
  validateState,
} from './settings-builder';
import { VicidialBridgeService, ViciBridgeOptions } from './vici-bridge';
import { parseVicidialCallerCode, VicidialApiClient } from './vici-client';
import { runSimulatedViciBridgeCall } from './vici-loopback-tester';
import { executeCustomFunctionWebhook } from './webhook-executor';

loadEnv();

export function createApp(viciBridge?: VicidialBridgeService) {
  const app = express();

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

  app.use(express.json({ limit: '4mb' }));
  app.use(express.urlencoded({ extended: false }));

  // ==================== STEP 4: AUTHENTICATION ROUTES & GUARD ====================

  app.get('/api/auth/status', (req: Request, res: Response) => {
    res.json({
      ok: true,
      authEnabled: isAuthEnabled(),
      authenticated: isRequestAuthorized(req),
    });
  });

  app.post('/api/auth/login', (req: Request, res: Response) => {
    const candidate = String(req.body?.password ?? '');
    if (!isAuthEnabled()) {
      res.json({ ok: true, authEnabled: false, authenticated: true });
      return;
    }
    if (!constantTimePasswordMatch(candidate)) {
      res.status(401).json({ ok: false, code: 'INVALID_PASSWORD', error: 'Invalid admin password' });
      return;
    }
    const token = createSessionToken();
    setAuthCookie(res, token);
    res.json({ ok: true, authEnabled: true, authenticated: true, token });
  });

  app.post('/api/auth/logout', (_req: Request, res: Response) => {
    clearAuthCookie(res);
    res.json({ ok: true, authEnabled: isAuthEnabled(), authenticated: !isAuthEnabled() });
  });

  app.use('/api', apiAuthMiddleware);

  const buildPayload = (state = getConsoleState()) => {
    const validations = validateState(state);
    const counts = {
      ok: validations.filter((v) => v.level === 'ok').length,
      wn: validations.filter((v) => v.level === 'wn').length,
      er: validations.filter((v) => v.level === 'er').length,
    };
    const settingsByAgentId = Object.fromEntries(
      state.agents.map((a) => [
        a.id,
        {
          agentId: a.id,
          agentName: a.name,
          settings: buildDeepgramSettings(state, a),
        },
      ])
    );
    return {
      state,
      validations,
      counts,
      settingsByAgentId,
      viciConfig: generateViciConfig(state),
      revisions: listRevisions(12),
      secrets: getSecretsStatus(),
      viciBridge: viciBridge ? viciBridge.getStatus() : null,
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
      viciBridge: viciBridge ? viciBridge.getStatus() : null,
      ...(authed ? { secrets: getSecretsStatus() } : {}),
    });
  });

  app.get('/api/state', (_req: Request, res: Response) => {
    res.json({ ok: true, ...buildPayload() });
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

  // Step 2: Simulator call log history endpoints
  app.get('/api/simulator/logs', (req: Request, res: Response) => {
    const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : undefined;
    const logs = listSimulatorCallLogs(agentId, 20);
    res.json({ ok: true, count: logs.length, logs });
  });

  app.delete('/api/simulator/logs', (req: Request, res: Response) => {
    const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : undefined;
    clearSimulatorCallLogs(agentId);
    res.json({ ok: true });
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
    const bundlePath = path.resolve(__dirname, '..', '..', 'voice-agent-vicibox-release.tar.gz');
    try {
      if (!fs.existsSync(bundlePath)) {
        const projectRoot = path.resolve(__dirname, '..');
        childProcess.execFileSync(
          'tar',
          [
            '-czf',
            bundlePath,
            '--exclude=node_modules',
            '--exclude=data/recordings/*.wav',
            '--exclude=data/*.sqlite*',
            '--exclude=.env',
            '-C',
            path.dirname(projectRoot),
            path.basename(projectRoot),
          ],
          { timeout: 20000 }
        );
      }
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
      res.status(400).json({ ok: false, error: err?.message || 'Unable to stream sample audio' });
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

  const publicDir = path.resolve(__dirname, '..', 'public');
  app.use(express.static(publicDir));

  app.get('*', (_req: Request, res: Response) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

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
  const initialPort = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  const { server, viciBridge } = createServerWithSimulator({ enableBridge: true });

  (async () => {
    if (viciBridge) {
      try {
        await viciBridge.start();
        const st = viciBridge.getStatus();
        console.log(
          `[ViciBridge] AudioSocket TCP listening on ${host}:${st.audioSocketPort} | SIP+RTP (PCMU) UDP listening on ${host}:${st.sipPort}`
        );
      } catch (bridgeErr: any) {
        console.warn(
          `[ViciBridge] Telephony UDP/TCP listener skipped on cloud host (${bridgeErr?.message || bridgeErr}) — Web Console & Live WebSocket Simulator remain active.`
        );
      }
    }

    const listenWithFallback = (candidatePort: number, retriesLeft: number) => {
      const onError = (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && retriesLeft > 0) {
          const nextPort = candidatePort === 3000 ? 3850 : candidatePort + 1;
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
      server.once('error', onError);
      server.listen(candidatePort, host, () => {
        server.removeListener('error', onError);
        process.env.PORT = String(candidatePort);
        console.log(
          `[VoiceAgentConsole] Step 4 Production Server + Bridge listening on http://localhost:${candidatePort} (bound ${host}:${candidatePort})`
        );
        fetchDeepgramVoiceCatalog().catch(() => {});
      });
    };

    listenWithFallback(initialPort, 15);
  })().catch((err) => {
    console.error('[VoiceAgentConsole] Startup fatal error:', err);
    process.exit(1);
  });
}
