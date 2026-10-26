import childProcess from 'child_process';
import dgram from 'dgram';
import fs from 'fs';
import http from 'http';
import net from 'net';
import path from 'path';
import WebSocket, { WebSocketServer } from 'ws';
import { getConsoleState, saveConsoleState } from '../src/db';
import { createServerWithSimulator } from '../src/server';
import { canonicalUuidToBytes } from '../src/vici-bridge';

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
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

    u.bind(0, '127.0.0.1', () => {
      const lport = (u.address() as net.AddressInfo).port;
      const sdp = [
        'v=0',
        'o=root 1 1 IN IP4 127.0.0.1',
        's=Test',
        'c=IN IP4 127.0.0.1',
        't=0 0',
        'm=audio 40000 RTP/AVP 0',
        'a=rtpmap:0 PCMU/8000',
        '',
      ].join('\r\n');
      const pkt = [
        `INVITE sip:8391@127.0.0.1:${sipPort} SIP/2.0`,
        `Via: SIP/2.0/UDP 127.0.0.1:${lport};branch=z9hG4bKtest`,
        `From: "V1027153012000104892" <sip:3055550192@127.0.0.1>;tag=t1`,
        `To: <sip:8391@127.0.0.1:${sipPort}>`,
        `Call-ID: step4-${Date.now()}@127.0.0.1`,
        'CSeq: 1 INVITE',
        'Content-Type: application/sdp',
        `Content-Length: ${Buffer.byteLength(sdp)}`,
        '',
        sdp,
      ].join('\r\n');
      u.send(Buffer.from(pkt, 'utf8'), sipPort, '127.0.0.1');
    });
  });
}

async function run() {
  console.log('=== Step 4 Automated Verification Suite (Production Hardening, Recordings, Analytics & Bundle) ===');

  const prevAdminPass = process.env.ADMIN_PASSWORD;
  const prevAllowedIps = process.env.BRIDGE_ALLOWED_IPS;
  const prevWhSecret = process.env.CUSTOM_WEBHOOK_SECRET;

  const { server, viciBridge: maybeBridge } = createServerWithSimulator({
    enableBridge: true,
    host: '127.0.0.1',
    audioSocketPort: 0,
    sipPort: 0,
  });
  const viciBridge = maybeBridge!;
  await viciBridge.start();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as net.AddressInfo).port;
  const httpBase = `http://127.0.0.1:${port}`;
  const wsBase = `ws://127.0.0.1:${port}`;

  try {
    // 1. Test ADMIN_PASSWORD Web/WS Auth + Localhost Asterisk Pre-Call Whitelist
    process.env.ADMIN_PASSWORD = 'vici-super-secret-2026';

    const lockedStateRes = await fetch(`${httpBase}/api/state`);
    assert(lockedStateRes.status === 401, `Expected 401 when ADMIN_PASSWORD active, got ${lockedStateRes.status}`);

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

    // Verify local Asterisk 127.0.0.1 /api/vici/register-call STILL SUCCEEDS without password!
    const astHookRes = await fetch(`${httpBase}/api/vici/register-call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'uniqueid=999.1&vici_cid=V1027153012000104892&phone=3055550192&exten=8391',
    });
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

    // Reset ADMIN_PASSWORD to empty for remaining checks
    delete process.env.ADMIN_PASSWORD;
    console.log('✓ [1/8] ADMIN_PASSWORD auth (HTTP + WS 401 lock, HMAC session cookie, and 127.0.0.1 Asterisk CURL whitelist) verified');

    // 2. Test BRIDGE_ALLOWED_IPS untrusted SIP IP block
    const bridgeStatus = viciBridge.getStatus();
    process.env.BRIDGE_ALLOWED_IPS = '10.250.250.1/32'; // Block 127.0.0.1 temporarily
    const forbiddenLine = await sendRawSipInvite(bridgeStatus.sipPort);
    assert(forbiddenLine.includes('403 Forbidden'), `Expected SIP 403 Forbidden, got: ${forbiddenLine}`);
    assert(
      viciBridge.getStatus().rejectedUntrustedIpCount >= 1,
      'Expected rejectedUntrustedIpCount >= 1'
    );
    process.env.BRIDGE_ALLOWED_IPS = '127.0.0.1,::1';
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
      await new Promise<void>((r) => holdHttp.listen(0, '127.0.0.1', () => r()));
      const holdPort = (holdHttp.address() as net.AddressInfo).port;
      const savedAgentUrl = process.env.DEEPGRAM_AGENT_URL;
      process.env.DEEPGRAM_AGENT_URL = `ws://127.0.0.1:${holdPort}/v1/agent/converse`;

      try {
        const reg1 = viciBridge.registerPreCall({
          uniqueid: 'cap.1',
          vici_cid: 'V1027153012000104892',
          phone: '3055550192',
          exten: '8391',
        });
        const asSock = net.createConnection({ host: '127.0.0.1', port: bridgeStatus.audioSocketPort });
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
    await new Promise<void>((r) => crmServer.listen(0, '127.0.0.1', () => r()));
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
            url: `http://127.0.0.1:${crmPort}/crm/lead/{{lead.lead_id}}`,
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
    const bundleDiskPath = path.resolve(__dirname, '..', '..', 'voice-agent-vicibox-release.tar.gz');
    if (fs.existsSync(bundleDiskPath)) fs.unlinkSync(bundleDiskPath);

    const bundleRes = await fetch(`${httpBase}/api/vici/release-bundle`);
    assert(bundleRes.status === 200, `Expected 200 from /api/vici/release-bundle, got ${bundleRes.status}`);
    const bundleBytes = Buffer.from(await bundleRes.arrayBuffer());
    assert(
      bundleBytes.length > 20000 && bundleBytes[0] === 0x1f && bundleBytes[1] === 0x8b,
      `Expected valid gzip archive >20KB, got ${bundleBytes.length} bytes`
    );
    const tarList = childProcess.execFileSync('tar', ['-tzf', bundleDiskPath], { encoding: 'utf8' });
    assert(
      tarList.includes('voice-agent-console/deploy/vicibox-install.sh') &&
        tarList.includes('voice-agent-console/dist/server.js') &&
        tarList.includes('voice-agent-console/VICIBOX-PRODUCTION-RUNBOOK.md'),
      'Release tarball missing vicibox-install.sh, dist/server.js, or VICIBOX-PRODUCTION-RUNBOOK.md'
    );
    console.log(
      `✓ [8/8] Turnkey ViciBox Release Bundle verified (${Math.round(bundleBytes.length / 1024)} KB -> /home/user/voice-agent-vicibox-release.tar.gz)`
    );

    console.log('\nALL 8 STEP 4 CHECKS PASSED SUCCESSFULLY!');
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
