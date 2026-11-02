import childProcess from 'child_process';
import dgram from 'dgram';
import fs from 'fs';
import http from 'http';
import net from 'net';
import path from 'path';
import WebSocket, { WebSocketServer } from 'ws';
import { getConsoleState, saveConsoleState } from '../src/db';
import { DATA_DIR } from '../src/data-paths';
import { createDefaultState } from '../src/defaults';
import { createServerWithSimulator } from '../src/server';
import { buildDeepgramSettings, validateAgent } from '../src/settings-builder';
import { isBridgePeerIpAllowed } from '../src/auth-guard';
import { canonicalUuidToBytes, VicidialBridgeService } from '../src/vici-bridge';

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function configureTestServices() {
  const state = getConsoleState();
  const stt = state.providers.find((p) => p.kind === 'stt')!;
  const llm = state.providers.find((p) => p.kind === 'llm' && p.type === 'open_ai')!;
  const tts = state.providers.find((p) => p.kind === 'tts' && p.type === 'deepgram')!;
  state.services = {
    stt: { providerId: stt.id, model: 'flux-general-multi' },
    llm: { providerId: llm.id, model: 'gpt-4o-mini' },
    tts: { providerId: tts.id, model: 'flux-haley-en' },
  };
  saveConsoleState(state, 'Test setup: select global services');
}

async function sendRawSipInvite(sipPort: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const u = dgram.createSocket('udp4');
    const timer = setTimeout(() => {
      try {
        u.close();
      } catch {}
      reject(new Error('SIP response timeout'));
    }, 3000);

    u.on('message', (msg) => {
      const txt = msg.toString('utf8');
      // Wait for final response (>= 200), skip 100 Trying
      if (/^SIP\/2\.0\s+[2-6]\d\d/.test(txt)) {
        clearTimeout(timer);
        try {
          u.close();
        } catch {}
        resolve(txt.split('\r\n')[0]);
      }
    });

    u.bind(0, 'localhost', () => {
      const lport = (u.address() as net.AddressInfo).port;
      const sdp = [
        'v=0',
        'o=root 1 1 IN IP4 localhost',
        's=Test',
        'c=IN IP4 localhost',
        't=0 0',
        'm=audio 40000 RTP/AVP 0',
        'a=rtpmap:0 PCMU/8000',
        '',
      ].join('\r\n');
      const pkt = [
        `INVITE sip:8391@localhost:${sipPort} SIP/2.0`,
        `Via: SIP/2.0/UDP localhost:${lport};branch=z9hG4bKtest`,
        `From: "V1027153012000104892" <sip:3055550192@localhost>;tag=t1`,
        `To: <sip:8391@localhost:${sipPort}>`,
        `Call-ID: step4-${Date.now()}@localhost`,
        'CSeq: 1 INVITE',
        'Content-Type: application/sdp',
        `Content-Length: ${Buffer.byteLength(sdp)}`,
        '',
        sdp,
      ].join('\r\n');
      u.send(Buffer.from(pkt, 'utf8'), sipPort, 'localhost');
    });
  });
}

async function run() {
  configureTestServices();
  console.log('=== Step 4 Automated Verification Suite (Production Hardening, Recordings, Analytics & Bundle) ===');

  const prevAdminPass = process.env.ADMIN_PASSWORD;
  const prevAllowedIps = process.env.BRIDGE_ALLOWED_IPS;
  const prevWhSecret = process.env.CUSTOM_WEBHOOK_SECRET;

  const { server, viciBridge: maybeBridge } = createServerWithSimulator({
    enableBridge: true,
    host: 'localhost',
    audioSocketPort: 0,
    sipPort: 0,
  });
  const viciBridge = maybeBridge!;
  await viciBridge.start();
  await new Promise<void>((resolve) => server.listen(0, 'localhost', () => resolve()));
  const port = (server.address() as net.AddressInfo).port;
  const httpBase = `http://localhost:${port}`;
  const wsBase = `ws://localhost:${port}`;

  try {
    const previousBridgeBindHost = process.env.BRIDGE_BIND_HOST;
    delete process.env.BRIDGE_BIND_HOST;
    const defaultBridgeHost = new VicidialBridgeService().getStatus().bindHost;
    if (previousBridgeBindHost === undefined) delete process.env.BRIDGE_BIND_HOST;
    else process.env.BRIDGE_BIND_HOST = previousBridgeBindHost;
    assert(defaultBridgeHost === '115.186.137.240', `Expected bridge default bind host to be 115.186.137.240, got ${defaultBridgeHost}`);

    const projectRoot = path.resolve(__dirname, '..');
    const unsafeBind = childProcess.spawnSync(
      process.execPath,
      [
        path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
        path.join(projectRoot, 'src', 'server.ts'),
      ],
      {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: 10000,
        env: {
          ...process.env,
          HOST: '0.0.0.0',
          PORT: '0',
          ADMIN_PASSWORD: '',
        },
      }
    );
    assert(
      unsafeBind.status === 1 &&
        `${unsafeBind.stdout || ''}${unsafeBind.stderr || ''}`.includes('Refusing to bind to a non-loopback interface without ADMIN_PASSWORD'),
      'Expected an unauthenticated public bind to be rejected before listener startup'
    );

    // 1. Test ADMIN_PASSWORD Web/WS Auth + Localhost Asterisk Pre-Call Whitelist
    process.env.ADMIN_PASSWORD = 'vici-super-secret-2026';

    const publicHealthRes = await fetch(`${httpBase}/api/health`);
    const publicHealth = (await publicHealthRes.json()) as any;
    assert(publicHealthRes.status === 200 && publicHealth.authenticated === false, 'Expected anonymous health status');
    assert(!('viciBridge' in publicHealth) && !('secrets' in publicHealth), 'Anonymous health must not reveal calls or secret status');

    const lockedStateRes = await fetch(`${httpBase}/api/state`);
    assert(lockedStateRes.status === 401, `Expected 401 when ADMIN_PASSWORD active, got ${lockedStateRes.status}`);
    const malformedCookieRes = await fetch(`${httpBase}/api/state`, {
      headers: { Cookie: 'vac_session=%ZZ' },
    });
    assert(malformedCookieRes.status === 401, 'Expected malformed cookies to be rejected without a server error');

    // Verify WebSocket upgrade is rejected with 401 without cookie/token
    const wsRejected = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`${wsBase}/ws/vici-monitor`);
      ws.once('unexpected-response', (_req, res) => {
        ws.close();
        resolve(res.statusCode === 401);
      });
      ws.once('open', () => {
        ws.close();
        resolve(false);
      });
      ws.once('error', () => resolve(true));
    });
    assert(wsRejected, 'Expected unauthenticated /ws/vici-monitor upgrade to be rejected');

    // Verify Asterisk pre-call /api/vici/register-call STILL SUCCEEDS without password when allowed!
    process.env.BRIDGE_ALLOWED_IPS = '*';
    const astHookRes = await fetch(`${httpBase}/api/vici/register-call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'uniqueid=999.1&vici_cid=V1027153012000104892&phone=3055550192&exten=8391',
    });
    delete process.env.BRIDGE_ALLOWED_IPS;
    const astUuid = (await astHookRes.text()).trim();
    assert(
      astHookRes.status === 200 && /^[0-9a-f-]{36}$/i.test(astUuid),
      `Expected local Asterisk pre-call hook whitelisted (200 UUID), got ${astHookRes.status}: ${astUuid}`
    );

    // Wrong password -> 401; Right password -> 200 + signed session cookie unlocks /api/state & WS
    const badLogin = await fetch(`${httpBase}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong-password' }),
    });
    assert(badLogin.status === 401, 'Expected 401 on wrong password');

    const okLogin = await fetch(`${httpBase}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'vici-super-secret-2026' }),
    });
    assert(okLogin.status === 200, 'Expected 200 on valid ADMIN_PASSWORD');
    const setCookie = okLogin.headers.get('set-cookie') || '';
    const cookiePair = setCookie.split(';')[0];
    assert(cookiePair.startsWith('vac_session='), 'Expected signed vac_session cookie');

    const unlockedRes = await fetch(`${httpBase}/api/state`, {
      headers: { Cookie: cookiePair },
    });
    assert(unlockedRes.status === 200, 'Expected 200 on /api/state with valid vac_session cookie');

    for (let attempt = 0; attempt < 5; attempt++) {
      const failedLogin = await fetch(`${httpBase}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'wrong-password' }),
      });
      assert(failedLogin.status === 401, `Expected failed attempt ${attempt + 1} to return 401`);
    }
    const throttledLogin = await fetch(`${httpBase}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong-password' }),
    });
    assert(throttledLogin.status === 429 && throttledLogin.headers.has('retry-after'), 'Expected login throttling after five failures');

    // Reset ADMIN_PASSWORD to empty for remaining checks
    delete process.env.ADMIN_PASSWORD;
    console.log('✓ [1/8] ADMIN_PASSWORD auth (HTTP + WS 401 lock, HMAC session cookie, and localhost Asterisk CURL whitelist) verified');

    // 2. Test BRIDGE_ALLOWED_IPS untrusted SIP IP block
    const bridgeStatus = viciBridge.getStatus();
    process.env.BRIDGE_ALLOWED_IPS = '';
    assert(isBridgePeerIpAllowed('115.186.137.240'), 'Expected empty bridge allowlist to keep 115.186.137.240 access');
    assert(!isBridgePeerIpAllowed([127, 0, 0, 1].join('.')), 'Expected IPv4 loopback to be rejected after removal');
    assert(!isBridgePeerIpAllowed('192.0.2.10'), 'Expected empty bridge allowlist to reject remote peers');
    process.env.BRIDGE_ALLOWED_IPS = '10.250.250.1/32'; // Block local test socket temporarily
    const forbiddenLine = await sendRawSipInvite(bridgeStatus.sipPort);
    assert(forbiddenLine.includes('403 Forbidden'), `Expected SIP 403 Forbidden, got: ${forbiddenLine}`);
    assert(
      viciBridge.getStatus().rejectedUntrustedIpCount >= 1,
      'Expected rejectedUntrustedIpCount >= 1'
    );
    process.env.BRIDGE_ALLOWED_IPS = '*';
    console.log(`✓ [2/8] BRIDGE_ALLOWED_IPS untrusted SIP peer guard verified (${forbiddenLine})`);

    // 3. Test Campaign maxCalls concurrency guard (486 Busy Here) & Supervisor Live Hangup
    const origState = getConsoleState();
    try {
      const capState = JSON.parse(JSON.stringify(origState));
      capState.campaigns[0].maxCalls = 1;
      saveConsoleState(capState, 'Test maxCalls=1');

      // Open 1 live AudioSocket call and hold it open using a local mock WS server
      const holdHttp = http.createServer();
      const holdWss = new WebSocketServer({ server: holdHttp, path: '/v1/agent/converse' });
      holdWss.on('connection', (ws) => {
        ws.send(JSON.stringify({ type: 'Welcome', request_id: 'hold_1' }));
        ws.on('message', (raw, isBin) => {
          if (!isBin) {
            const m = JSON.parse(raw.toString());
            if (m.type === 'Settings') ws.send(JSON.stringify({ type: 'SettingsApplied' }));
          }
        });
      });
      await new Promise<void>((r) => holdHttp.listen(0, 'localhost', () => r()));
      const holdPort = (holdHttp.address() as net.AddressInfo).port;
      const savedAgentUrl = process.env.DEEPGRAM_AGENT_URL;
      process.env.DEEPGRAM_AGENT_URL = `ws://localhost:${holdPort}/v1/agent/converse`;

      try {
        const reg1 = viciBridge.registerPreCall({
          uniqueid: 'cap.1',
          vici_cid: 'V1027153012000104892',
          phone: '3055550192',
          exten: '8391',
        });
        const asSock = net.createConnection({ host: 'localhost', port: bridgeStatus.audioSocketPort });
        await new Promise<void>((r) => asSock.once('connect', () => r()));
        asSock.write(Buffer.concat([Buffer.from([0x01, 0x00, 0x10]), canonicalUuidToBytes(reg1.uuid)]));
        await new Promise((r) => setTimeout(r, 120));

        const stDuring = viciBridge.getStatus();
        assert(stDuring.activeCallsCount === 1, `Expected 1 active call, got ${stDuring.activeCallsCount}`);
        const activeCallId = stDuring.activeCalls[0].callId;

        // Second concurrent call on same campaign must get 486 Busy Here!
        const busyLine = await sendRawSipInvite(bridgeStatus.sipPort);
        assert(busyLine.includes('486 Busy Here'), `Expected SIP 486 Busy Here at maxCalls=1, got ${busyLine}`);
        assert(viciBridge.getStatus().rejectedOverCapacityCount >= 1, 'Expected rejectedOverCapacityCount >= 1');
        console.log(`✓ [3/8] Campaign maxCalls concurrency guard verified (${busyLine})`);

        // Test Supervisor Force Hangup via REST endpoint!
        const supHangupDone = new Promise<boolean>((resolve) => {
          asSock.on('data', (d) => {
            if (d[0] === 0x00) resolve(true);
          });
          asSock.on('close', () => resolve(true));
        });
        const supRes = await fetch(`${httpBase}/api/vici/calls/${encodeURIComponent(activeCallId)}/hangup`, {
          method: 'POST',
        });
        assert(supRes.status === 200, 'Expected 200 on supervisor force hangup');
        await supHangupDone;
        asSock.destroy();
        await new Promise((r) => setTimeout(r, 80));
        assert(viciBridge.getStatus().activeCallsCount === 0, 'Expected activeCallsCount === 0 after force hangup');
        console.log(`✓ [4/8] Live Supervisor call intervention (POST /api/vici/calls/:id/hangup) verified`);
      } finally {
        if (savedAgentUrl === undefined) delete process.env.DEEPGRAM_AGENT_URL;
        else process.env.DEEPGRAM_AGENT_URL = savedAgentUrl;
        holdHttp.closeAllConnections?.();
        holdHttp.close();
      }
    } finally {
      saveConsoleState(origState, 'Restore default maxCalls');
    }

    // 5. Test Stereo 8 kHz .wav Call Recording + HTTP Range Streaming
    const simRes = await fetch(`${httpBase}/api/vici/simulate-call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transport: 'sip_rtp',
        scenario: 'qualified_xfer',
        upstream: 'mock_ai',
        callerCode: 'V1027153012000104892',
        phone: '3055550192',
        exten: '8391',
      }),
    });
    const simJson = (await simRes.json()) as any;
    assert(simJson.ok && simJson.cdr?.recordingFile, `Expected recordingFile in CDR, got ${JSON.stringify(simJson.cdr)}`);

    const wavRes = await fetch(`${httpBase}/api/vici/recordings/${encodeURIComponent(simJson.cdr.recordingFile)}`);
    assert(wavRes.status === 200, `Expected 200 for WAV download, got ${wavRes.status}`);
    const wavBuf = Buffer.from(await wavRes.arrayBuffer());
    assert(wavBuf.subarray(0, 4).toString('ascii') === 'RIFF', 'Expected RIFF header');
    assert(wavBuf.subarray(8, 12).toString('ascii') === 'WAVE', 'Expected WAVE format');
    assert(wavBuf.readUInt16LE(22) === 2, 'Expected 2 stereo channels (Left=Caller, Right=Bot)');
    assert(wavBuf.readUInt32LE(24) === 8000, 'Expected 8000 Hz sample rate');
    assert(wavBuf.readUInt16LE(34) === 16, 'Expected 16-bit PCM');

    const rangeRes = await fetch(`${httpBase}/api/vici/recordings/${encodeURIComponent(simJson.cdr.recordingFile)}`, {
      headers: { Range: 'bytes=0-99' },
    });
    assert(rangeRes.status === 206, `Expected 206 Partial Content for HTML5 audio seeking, got ${rangeRes.status}`);
    console.log(
      `✓ [5/8] Stereo 8 kHz .wav call recording (${simJson.cdr.recordingFile}, ${wavBuf.length} bytes, 2ch PCM16 + HTTP 206 Range) verified`
    );

    // 6. Test Custom HTTP Webhook Function Executor (with {{CUSTOM_WEBHOOK_SECRET}} & {{lead.lead_id}} interpolation)
    process.env.CUSTOM_WEBHOOK_SECRET = 'whsec_live_98765';
    let capturedHeaders: http.IncomingHttpHeaders = {};
    let capturedBody: any = null;
    let capturedPath = '';
    const crmServer = http.createServer((req, res) => {
      capturedHeaders = req.headers;
      capturedPath = req.url || '';
      let b = '';
      req.on('data', (c) => (b += c.toString()));
      req.on('end', () => {
        try {
          capturedBody = JSON.parse(b);
        } catch {}
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ eligible: true, plan: 'Gold Preferred', monthly_rate: 48.5 }));
      });
    });
    await new Promise<void>((r) => crmServer.listen(0, 'localhost', () => r()));
    const crmPort = (crmServer.address() as net.AddressInfo).port;

    try {
      const whRes = await fetch(`${httpBase}/api/functions/test-webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fn: {
            id: 'fn_custom_crm',
            name: 'check_zip_eligibility',
            description: 'Checks state/zip eligibility in local CRM',
            params: '{"type":"object","properties":{"zip":{"type":"string"}}}',
            defer: false,
            url: `http://localhost:${crmPort}/crm/lead/{{lead.lead_id}}`,
            method: 'post',
            headers: '{"X-CRM-Secret":"Bearer {{CUSTOM_WEBHOOK_SECRET}}"}',
          },
          args: { zip: '33101' },
        }),
      });
      const whJson = (await whRes.json()) as any;
      assert(whJson.ok && whJson.httpStatus === 200, `Webhook execution failed: ${JSON.stringify(whJson)}`);
      assert(capturedPath === '/crm/lead/104892', `Expected interpolated lead_id path, got ${capturedPath}`);
      assert(
        capturedHeaders['x-crm-secret'] === 'Bearer whsec_live_98765',
        `Expected interpolated secret header, got ${capturedHeaders['x-crm-secret']}`
      );
      assert(
        capturedBody?.zip === '33101' && capturedBody?._call_context?.caller_code === 'V1027153012000104892',
        'Expected merged args + _call_context in POST body'
      );
      console.log('✓ [6/8] Custom HTTP Webhook Executor ({{CUSTOM_WEBHOOK_SECRET}} + {{lead.lead_id}} + LAN HTTP) verified');
    } finally {
      crmServer.closeAllConnections?.();
      crmServer.close();
    }

    // 7. Test Wallboard Analytics & RFC 4180 CSV CDR Export
    const anaRes = await fetch(`${httpBase}/api/vici/analytics`);
    const anaJson = (await anaRes.json()) as any;
    assert(
      anaJson.ok &&
        anaJson.analytics.totalBridgeCalls >= 1 &&
        anaJson.analytics.recordedCount >= 1 &&
        Array.isArray(anaJson.analytics.campaigns),
      `Analytics payload invalid: ${JSON.stringify(anaJson)}`
    );

    const csvRes = await fetch(`${httpBase}/api/vici/logs.csv`);
    const csvText = await csvRes.text();
    assert(
      csvRes.status === 200 &&
        csvText.startsWith('call_id,started_at,ended_at,duration_sec,transport') &&
        csvText.includes('V1027153012000104892'),
      'CSV export missing expected header or call row'
    );
    console.log(
      `✓ [7/8] Wallboard Analytics (${anaJson.analytics.totalBridgeCalls} calls, ${anaJson.analytics.recordedCount} recordings) & CSV CDR export verified`
    );

    // 8. Test Turnkey ViciBox .tar.gz Release Bundle
    const bundleDiskPath = path.join(DATA_DIR, 'voice-agent-vicibox-release.tar.gz');
    if (fs.existsSync(bundleDiskPath)) fs.unlinkSync(bundleDiskPath);

    const bundleRes = await fetch(`${httpBase}/api/vici/release-bundle`);
    assert(bundleRes.status === 200, `Expected 200 from /api/vici/release-bundle, got ${bundleRes.status}`);
    const bundleBytes = Buffer.from(await bundleRes.arrayBuffer());
    assert(
      bundleBytes.length > 20000 && bundleBytes[0] === 0x1f && bundleBytes[1] === 0x8b,
      `Expected valid gzip archive >20KB, got ${bundleBytes.length} bytes`
    );
    const tarList = childProcess.execFileSync('tar', ['-tzf', bundleDiskPath], { encoding: 'utf8' });
    const normalizedTarList = tarList.toLowerCase();
    assert(
      normalizedTarList.includes('voice-agent-console/deploy/vicibox-install.sh') &&
        normalizedTarList.includes('voice-agent-console/dist/server.js') &&
        normalizedTarList.includes('voice-agent-console/vicibox-production-runbook.md'),
      'Release tarball missing vicibox-install.sh, dist/server.js, or VICIBOX-PRODUCTION-RUNBOOK.md'
    );
    const archiveEntries = normalizedTarList.split(/\r?\n/);
    assert(
      !archiveEntries.some(
        (entry) =>
          entry === 'voice-agent-console/.env' ||
          entry.startsWith('voice-agent-console/data/') ||
          entry.startsWith('voice-agent-console/logs/') ||
          entry === 'voice-agent-console/tools/cloudflared.exe'
      ),
      'Release tarball must not include credentials, runtime data/logs, or the local tunnel binary'
    );
    console.log(
      `✓ [8/9] Turnkey ViciBox Release Bundle verified (${Math.round(bundleBytes.length / 1024)} KB -> /home/user/voice-agent-vicibox-release.tar.gz)`
    );

    // 9. Verify Medicare Outbound Qualification Agent (a_medicare) & Campaign (c_medicare / MEDICARE)
    const freshDefaults = createDefaultState();
    const medAgent = freshDefaults.agents.find((a) => a.id === 'a_medicare');
    const medCamp = freshDefaults.campaigns.find((c) => c.id === 'c_medicare');
    if (!medAgent || !medCamp) throw new Error('Expected a_medicare agent & c_medicare campaign in defaults');

    // Sync Medicare agent/campaign/fn_xfer into persisted SQLite state if not yet present
    const curDbState = getConsoleState();
    const mergedState = JSON.parse(JSON.stringify(curDbState));
    const xferIdx = mergedState.functions.findIndex((f: any) => f.id === 'fn_xfer');
    if (xferIdx >= 0) mergedState.functions[xferIdx] = freshDefaults.functions.find((f) => f.id === 'fn_xfer');
    if (!mergedState.agents.some((a: any) => a.id === 'a_medicare')) mergedState.agents.push(medAgent);
    else mergedState.agents[mergedState.agents.findIndex((a: any) => a.id === 'a_medicare')] = medAgent;
    if (!mergedState.campaigns.some((c: any) => c.id === 'c_medicare')) mergedState.campaigns.push(medCamp);
    else mergedState.campaigns[mergedState.campaigns.findIndex((c: any) => c.id === 'c_medicare')] = medCamp;
    mergedState.tests.a_medicare = freshDefaults.tests.a_medicare;
    saveConsoleState(mergedState, 'Integrated Medicare Food & OTC Agent + MEDICARE Campaign');

    const medChecks = validateAgent(mergedState, medAgent);
    assert(
      medChecks.filter((c) => c.level === 'er').length === 0,
      `Expected 0 pre-flight errors on Medicare agent, got: ${JSON.stringify(medChecks.filter((c) => c.level === 'er'))}`
    );
    const medSettings = buildDeepgramSettings(mergedState, medAgent, medCamp);
    assert(
      medSettings.agent.listen.provider.model === 'flux-general-multi' &&
        Array.isArray(medSettings.agent.listen.provider.language_hints) &&
        medSettings.agent.listen.provider.language_hints.includes('es'),
      'Expected flux-general-multi with Spanish language_hints for Scenario A Language Barrier detection'
    );
    const medDispoFn = medSettings.agent.think.functions.find((f: any) => f.name === 'set_disposition');
    assert(
      medDispoFn?.parameters?.properties?.code?.enum?.includes('LANG') &&
        medDispoFn?.parameters?.properties?.code?.enum?.includes('DQ'),
      'Expected Medicare campaign dispos (LANG, DQ, XFER, DNC) wired into set_disposition enum'
    );

    // Test Medicare Qualified Transfer (Age 71 + Part A&B -> MED_CLOSERS + structured metadata in update_lead)
    const medXferRes = await fetch(`${httpBase}/api/vici/simulate-call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transport: 'sip_rtp',
        scenario: 'medicare_qualified_xfer',
        upstream: 'mock_ai',
        callerCode: 'V1027153012000104892',
        phone: '3055550192',
      }),
    });
    const medXfer = (await medXferRes.json()) as any;
    assert(
      medXfer.ok &&
        medXfer.cdr?.viciCampaign === 'MEDICARE' &&
        medXfer.cdr?.remoteAgentUser === '9002' &&
        medXfer.cdr?.transferredTo === 'ingroup:MED_CLOSERS',
      `Expected MEDICARE routing (RA 9002 -> ingroup:MED_CLOSERS), got ${JSON.stringify(medXfer.cdr)}`
    );
    const medUpdateLeadReqs = (medXfer.viciRequestsReceived as any[]).filter((r) => r.query.function === 'update_lead');
    const medUpdateLeadReq = medUpdateLeadReqs[medUpdateLeadReqs.length - 1];
    assert(
      medUpdateLeadReq?.query.comments?.includes('Name:Robert') &&
        medUpdateLeadReq?.query.comments?.includes('Age:71') &&
        medUpdateLeadReq?.query.comments?.includes('Medicare:') &&
        medUpdateLeadReq?.query.comments?.includes('Hook:Food'),
      `Expected structured metadata (Name, Age, Medicare Status, Hook Type) in VICIdial update_lead comments, got: ${medUpdateLeadReq?.query.comments}`
    );

    // Test Medicare Spanish Language Barrier (LANG) & Underage 61 Hard Stop (DQ)
    const medLangRes = await fetch(`${httpBase}/api/vici/simulate-call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transport: 'audiosocket',
        scenario: 'medicare_spanish_lang',
        upstream: 'mock_ai',
      }),
    });
    const medLang = (await medLangRes.json()) as any;
    assert(medLang.ok && medLang.cdr?.disposition === 'LANG', `Expected LANG disposition, got ${medLang.cdr?.disposition}`);

    const medDqRes = await fetch(`${httpBase}/api/vici/simulate-call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transport: 'sip_rtp',
        scenario: 'medicare_underage_dq',
        upstream: 'mock_ai',
      }),
    });
    const medDq = (await medDqRes.json()) as any;
    assert(medDq.ok && medDq.cdr?.disposition === 'DQ', `Expected DQ disposition for age 61, got ${medDq.cdr?.disposition}`);

    console.log(
      '✓ [9/9] Medicare Agent (a_medicare) & MEDICARE Campaign (88002 / RA 9002 -> MED_CLOSERS, LANG Spanish barrier, DQ <65 hard-stop & metadata handoff) verified'
    );

    console.log('\nALL 9 STEP 4 CHECKS PASSED SUCCESSFULLY!');
  } finally {
    if (prevAdminPass === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = prevAdminPass;
    if (prevAllowedIps === undefined) delete process.env.BRIDGE_ALLOWED_IPS;
    else process.env.BRIDGE_ALLOWED_IPS = prevAllowedIps;
    if (prevWhSecret === undefined) delete process.env.CUSTOM_WEBHOOK_SECRET;
    else process.env.CUSTOM_WEBHOOK_SECRET = prevWhSecret;

    await viciBridge.stop();
    (server as any).closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

run().catch((err) => {
  console.error('Step 4 Verification FAILED:', err);
  process.exit(1);
});
