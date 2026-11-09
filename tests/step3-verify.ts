import net from 'net';
import WebSocket from 'ws';
import { createServerWithSimulator } from '../src/server';
import { getConsoleState, saveConsoleState } from '../src/db';
import { getSecret } from '../src/env-store';
import {
  linear16ToUlaw,
  ulawToLinear16,
  buildRtpPacket,
  parseRtpPacket,
  downsample16kTo8kLinear16,
} from '../src/g711';
import { parseVicidialCallerCode } from '../src/vici-client';
import { AsteriskAmiClient } from '../src/ami-client';

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
  if (!state.agents.length || !state.campaigns.length) throw new Error('Bridge test fixture requires at least one agent and campaign.');
  for (const campaign of state.campaigns) {
    if (!state.agents.some((agent) => agent.id === campaign.agentId)) campaign.agentId = state.agents[0].id;
    if (String(campaign.complianceRules || '').trim().length < 20 || /^REVIEW REQUIRED\b/i.test(campaign.complianceRules || '')) {
      campaign.complianceRules = 'Reviewed bridge test rules: be truthful, avoid unsupported claims, and honor do-not-call requests immediately.';
    }
  }
  saveConsoleState(state, 'Test setup: ready campaigns and services');
  const campaign = state.campaigns[0];
  return { campaignId: campaign.id, exten: `${state.vici.aiExten}${state.campaigns.indexOf(campaign) + 1}` };
}

async function startMockAmiServer(): Promise<{
  port: number;
  actions: Record<string, string>[];
  close: () => Promise<void>;
}> {
  const actions: Record<string, string>[] = [];
  const amiSrv = net.createServer((sock) => {
    sock.write('Asterisk Call Manager/5.0.2\r\n');
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx: number;
      while ((idx = buf.indexOf('\r\n\r\n')) !== -1) {
        const rawBlock = buf.slice(0, idx);
        buf = buf.slice(idx + 4);
        const map: Record<string, string> = {};
        for (const line of rawBlock.split('\r\n')) {
          const colon = line.indexOf(':');
          if (colon > 0) {
            map[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
          }
        }
        actions.push(map);
        const actionIdHeader = map.actionid ? `ActionID: ${map.actionid}\r\n` : '';
        if (map.action === 'Login') {
          sock.write(`Response: Success\r\n${actionIdHeader}Message: Authentication accepted\r\n\r\n`);
        } else if (map.action === 'Ping') {
          sock.write(`Response: Success\r\n${actionIdHeader}Ping: Pong\r\nTimestamp: 1730000000.000\r\n\r\n`);
        } else if (map.action === 'Redirect' || map.action === 'Hangup') {
          sock.write(`Response: Success\r\n${actionIdHeader}Message: ${map.action} queued\r\n\r\n`);
        } else if (map.action === 'Logoff') {
          sock.end();
        }
      }
    });
  });

  await new Promise<void>((resolve) => amiSrv.listen(0, 'localhost', resolve));
  const port = (amiSrv.address() as net.AddressInfo).port;
  return {
    port,
    actions,
    close: () => new Promise<void>((resolve) => amiSrv.close(() => resolve())),
  };
}

async function run() {
  const fixture = configureTestServices();
  console.log('=== Step 3 Automated Verification Suite (Universal VICIdial Bridge) ===');

  // 1. Unit-test VICIdial CallerID parser (outbound V..., inbound Y..., manual M..., SIP quoted)
  const outCid = parseVicidialCallerCode('"V1027153012000104892" <sip:3055550192@localhost>');
  assert(
    outCid.isVicidialCallId &&
      outCid.callType === 'outbound' &&
      outCid.callerCode === 'V1027153012000104892' &&
      outCid.leadId === '104892' &&
      outCid.phone === '3055550192',
    `Expected V1027153012000104892 -> leadId 104892 & phone 3055550192, got ${JSON.stringify(outCid)}`
  );
  const inCid = parseVicidialCallerCode('Y0316001655000402028');
  assert(
    inCid.isVicidialCallId && inCid.callType === 'inbound' && inCid.leadId === '402028',
    'Expected Y0316001655000402028 -> leadId 402028'
  );
  console.log('✓ [1/9] VICIdial CallerID parser verified (V... outbound, Y... inbound, SIP From header extraction)');

  // 2. Unit-test G.711 μ-law <-> linear16 PCM16 codec, RTP framing, and 16k->8k downsampler
  const pcm320 = Buffer.alloc(320);
  for (let i = 0; i < 160; i++) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / 8000) * 14000);
    pcm320.writeInt16LE(sample, i * 2);
  }
  const ulaw160 = linear16ToUlaw(pcm320);
  assert(ulaw160.length === 160, 'Expected 160-byte 20ms G.711 ulaw payload');
  const decoded320 = ulawToLinear16(ulaw160);
  assert(decoded320.length === 320, 'Expected 320-byte decoded linear16 frame');
  let maxErr = 0;
  for (let i = 0; i < 160; i++) {
    const orig = pcm320.readInt16LE(i * 2);
    const dec = decoded320.readInt16LE(i * 2);
    maxErr = Math.max(maxErr, Math.abs(orig - dec));
  }
  assert(maxErr < 700, `Expected high-accuracy ITU-T G.711 ulaw roundtrip, got maxErr=${maxErr}`);

  const rtpPkt = buildRtpPacket({
    payloadType: 0,
    sequenceNumber: 42,
    timestamp: 6720,
    ssrc: 0x12345678,
    marker: true,
    payload: ulaw160,
  });
  const parsedRtp = parseRtpPacket(rtpPkt);
  assert(
    parsedRtp && parsedRtp.payloadType === 0 && parsedRtp.sequenceNumber === 42 && parsedRtp.marker === true && parsedRtp.payload.length === 160,
    'RTP header build/parse mismatch'
  );
  const pcm16k = Buffer.alloc(640);
  assert(downsample16kTo8kLinear16(pcm16k).length === 320, '16kHz -> 8kHz downsample size mismatch');
  console.log(`✓ [2/9] ITU-T G.711 μ-law LUT codec (max error ${maxErr}/32768), RFC 3550 RTP framing & 16k->8k downsampler verified`);

  // 3. Boot HTTP server + Universal Bridge (ephemeral ports so zero collision with running preview)
  process.env.BRIDGE_ALLOWED_IPS = '*';
  const { server, viciBridge: maybeBridge } = createServerWithSimulator({
    enableBridge: true,
    host: 'localhost',
    audioSocketPort: 0,
    sipPort: 0,
  });
  const viciBridge = maybeBridge!;
  await viciBridge.start();
  await new Promise<void>((resolve) => server.listen(0, 'localhost', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to bind ephemeral HTTP server');
  const httpBase = `http://localhost:${addr.port}`;
  const wsBase = `ws://localhost:${addr.port}`;
  let monWs: WebSocket | null = null;

  try {
    const statusRes = await fetch(`${httpBase}/api/vici/status`);
    const statusJson = (await statusRes.json()) as any;
    assert(
      statusJson.ok && statusJson.bridge.audioSocketListening && statusJson.bridge.sipRtpListening,
      'Expected both AudioSocket TCP and SIP+RTP UDP listeners active'
    );
    console.log(
      `✓ [3/9] Dual Bridge listeners active simultaneously (AudioSocket TCP :${statusJson.bridge.audioSocketPort}, SIP+RTP UDP :${statusJson.bridge.sipPort})`
    );

    // 4. Test Asterisk CURL() form-urlencoded POST to /api/vici/register-call -> canonical 36-char UUID
    const curlForm = new URLSearchParams({
      uniqueid: '1761580001.77',
      vici_cid: 'V1027153012000104892',
      phone: '3055550192',
      exten: fixture.exten,
      channel: 'SIP/carrier-0000004d',
    });
    const regRes = await fetch(`${httpBase}/api/vici/register-call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: curlForm.toString(),
    });
    const plainUuid = (await regRes.text()).trim();
    assert(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(plainUuid),
      `Expected plain canonical RFC 4122 UUID for Asterisk AudioSocket(), got: ${plainUuid}`
    );
    console.log(`✓ [4/9] Asterisk CURL(/api/vici/register-call) returned canonical 36-char UUID: ${plainUuid}`);

    // 5. Connect /ws/vici-monitor to confirm live WebSocket telemetry works alongside /ws/simulator
    const monitorEvents: any[] = [];
    const wsMon = new WebSocket(`${wsBase}/ws/vici-monitor`);
    monWs = wsMon;
    await new Promise<void>((resolve, reject) => {
      wsMon.once('open', () => resolve());
      wsMon.once('error', reject);
    });
    wsMon.on('message', (data, isBinary) => {
      if (!isBinary) monitorEvents.push(JSON.parse(data.toString('utf8')));
    });

    // 6. Test Transport #1: Native Asterisk 18+ AudioSocket TCP (DNC scenario -> add_dnc_phone + update_lead + HANGUP)
    const asSimRes = await fetch(`${httpBase}/api/vici/simulate-call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transport: 'audiosocket',
        campaignId: fixture.campaignId,
        scenario: 'dnc_request',
        upstream: 'mock_ai',
        callerCode: 'V1027153012000104892',
        phone: '3055550192',
        exten: fixture.exten,
      }),
    });
    const asSim = (await asSimRes.json()) as any;
    assert(asSim.ok, `AudioSocket simulation failed: ${JSON.stringify(asSim)}`);
    assert(asSim.callerFramesReceived > 5, 'Expected Asterisk AudioSocket client to receive 8kHz slin audio frames');
    assert(asSim.cdr?.leadId === '104892', `Expected leadId 104892, got ${asSim.cdr?.leadId}`);
    assert(asSim.cdr?.disposition === 'DNC' && asSim.cdr?.dncAdded === true, 'Expected DNC disposition & dncAdded=true');
    const asFns = (asSim.viciRequestsReceived as any[]).map((r) => `${r.query.function}${r.query.stage ? ':' + r.query.stage : ''}`);
    assert(asFns.includes('lead_all_info'), 'Expected lead_all_info call');
    assert(asFns.includes('add_dnc_phone'), 'Expected add_dnc_phone call');
    assert(asFns.includes('update_lead'), 'Expected update_lead call');
    assert(asFns.includes('ra_call_control:HANGUP'), 'Expected ra_call_control:HANGUP call');
    console.log(`✓ [5/9] Asterisk 18+ AudioSocket TCP E2E verified (frames=${asSim.callerFramesReceived}, APIs=${asFns.join(', ')})`);

    // 7. Test Dynamic Closer Transfer Modes #2 & #3 ('number' external DID & 'extension') over SIP + RTP (G.711 μ-law)
    const origState = getConsoleState();
    try {
      // Test xferType = 'number'
      const numState = JSON.parse(JSON.stringify(origState));
      numState.campaigns[0].xferType = 'number';
      numState.campaigns[0].xferTarget = '8005559999';
      saveConsoleState(numState, 'Test xferType=number');

      const numRes = await fetch(`${httpBase}/api/vici/simulate-call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transport: 'sip_rtp',
          campaignId: fixture.campaignId,
          scenario: 'qualified_xfer',
          upstream: 'mock_ai',
          callerCode: 'V1027153012000104892',
          phone: '3055550192',
          exten: fixture.exten,
        }),
      });
      const numSim = (await numRes.json()) as any;
      assert(numSim.ok, 'SIP+RTP number transfer failed');
      const numXferReq = (numSim.viciRequestsReceived as any[]).find((r) => r.query.function === 'ra_call_control');
      assert(
        numXferReq?.query.stage === 'EXTENSIONTRANSFER' && numXferReq?.query.phone_number === '8005559999',
        `Expected EXTENSIONTRANSFER -> 8005559999, got ${JSON.stringify(numXferReq?.query)}`
      );

      // Test xferType = 'extension'
      const extState = JSON.parse(JSON.stringify(origState));
      extState.campaigns[0].xferType = 'extension';
      extState.campaigns[0].xferTarget = '8309';
      saveConsoleState(extState, 'Test xferType=extension');

      const extRes = await fetch(`${httpBase}/api/vici/simulate-call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transport: 'sip_rtp',
          campaignId: fixture.campaignId,
          scenario: 'qualified_xfer',
          upstream: 'mock_ai',
          callerCode: 'Y0316001655000402028',
          phone: '3055550192',
          exten: fixture.exten,
        }),
      });
      const extSim = (await extRes.json()) as any;
      assert(extSim.ok && extSim.cdr?.leadId === '402028', 'Inbound Y... callerCode lead extraction failed');
      const extXferReq = (extSim.viciRequestsReceived as any[]).find((r) => r.query.function === 'ra_call_control');
      assert(
        extXferReq?.query.stage === 'EXTENSIONTRANSFER' &&
          extXferReq?.query.phone_number === '8309' &&
          extXferReq?.query.value === 'Y0316001655000402028',
        `Expected EXTENSIONTRANSFER -> 8309 with Y... callerCode, got ${JSON.stringify(extXferReq?.query)}`
      );
      console.log(`✓ [6/9] Dynamic Campaign transfer modes 'number' (8005559999) & 'extension' (8309) + Inbound Y... CID verified`);
    } finally {
      saveConsoleState(origState, 'Restore default state after dynamic xfer test');
    }

    // 8. Test Transport #2 with LIVE DEEPGRAM VOICE AGENT API @ 8000 Hz over real UDP SIP + G.711 μ-law RTP + Closer INGROUPTRANSFER!
    const dgKey = getSecret('DEEPGRAM_API_KEY');
    const upstreamMode = dgKey && dgKey.length > 20 ? 'deepgram' : 'mock_ai';

    console.log(`  Dialing 8 kHz SIP + G.711 μ-law RTP call through ${upstreamMode} upstream…`);
    const liveSipRes = await fetch(`${httpBase}/api/vici/simulate-call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transport: 'sip_rtp',
        campaignId: fixture.campaignId,
        scenario: 'qualified_xfer',
        upstream: upstreamMode,
        callerCode: 'V1027153012000104892',
        phone: '3055550192',
        exten: fixture.exten,
      }),
    });
    const liveSip = (await liveSipRes.json()) as any;
    assert(liveSip.ok, `SIP+RTP call failed: ${JSON.stringify(liveSip)}`);
    assert(
      liveSip.callerFramesReceived >= (upstreamMode === 'deepgram' ? 25 : 4),
      `Expected real 20ms G.711 μ-law RTP packets, got ${liveSip.callerFramesReceived}`
    );
    assert(liveSip.cdr?.leadId === '104892', 'Expected hydrated lead #104892');
    assert(
      (liveSip.viciRequestsReceived as any[]).some(
        (request) => request.query.function === 'lead_all_info' && request.query.lead_id === '104892'
      ),
      'Expected the live call to hydrate lead #104892 from the mocked VICIdial API'
    );
    console.log(
      `✓ [7/9] 8 kHz (${upstreamMode}) SIP + G.711 μ-law RTP call verified! (${liveSip.callerFramesReceived} RTP packets, TTFB=${liveSip.cdr?.avgTtfbMs ?? 'n/a'}ms, lead=${liveSip.cdr?.leadId})`
    );

    // 9. Test Asterisk Manager Interface (AMI :5038) Login + Ping + Redirect fallback
    const mockAmi = await startMockAmiServer();
    try {
      const amiClient = new AsteriskAmiClient(
        {
          ...getConsoleState().vici,
          amiHost: 'localhost',
          amiPort: mockAmi.port,
          amiUser: 'cron',
        },
        '1234'
      );
      const pingRes = await amiClient.ping();
      assert(pingRes.ok, `AMI ping failed: ${pingRes.message}`);
      const redirRes = await amiClient.redirectChannel({
        channel: 'SIP/carrier-0000004d',
        exten: '8309',
        context: 'default',
      });
      assert(redirRes.ok, `AMI Redirect failed: ${redirRes.message}`);
      assert(
        mockAmi.actions.some((a) => a.action === 'Login') &&
          mockAmi.actions.some((a) => a.action === 'Ping') &&
          mockAmi.actions.some((a) => a.action === 'Redirect' && a.exten === '8309'),
        'Expected Login, Ping, and Redirect AMI actions'
      );
      console.log('✓ [8/9] Asterisk Manager Interface (AMI) Login, Ping & Channel Redirect fallback verified');
    } finally {
      await mockAmi.close();
    }

    // 10. Verify SQLite bridge_calls CDR persistence, /ws/vici-monitor events & deploy script download
    const logsRes = await fetch(`${httpBase}/api/vici/logs?limit=10`);
    const logsJson = (await logsRes.json()) as any;
    assert(logsJson.ok && logsJson.logs.length >= 4, `Expected >=4 persisted bridge_calls CDRs in SQLite, got ${logsJson.logs?.length}`);
    const filteredLogsRes = await fetch(`${httpBase}/api/vici/logs?limit=200&campaignId=${encodeURIComponent(fixture.campaignId)}`);
    const filteredLogsJson = (await filteredLogsRes.json()) as any;
    assert(filteredLogsRes.ok && filteredLogsJson.ok && filteredLogsJson.logs.length >= 1, 'Expected campaign-filtered bridge history');
    assert(filteredLogsJson.logs.every((row: any) => row.campaignId === fixture.campaignId), 'Campaign filter must not mix other campaigns');
    assert(/no-store/.test(filteredLogsRes.headers.get('cache-control') || ''), 'Campaign history must not be cached');
    assert(
      monitorEvents.some((e) => e.type === 'call_started') && monitorEvents.some((e) => e.type === 'call_ended'),
      'Expected /ws/vici-monitor to stream live call_started & call_ended telemetry'
    );
    const scriptRes = await fetch(`${httpBase}/api/vici/deploy-script`);
    const scriptBody = await scriptRes.text();
    assert(scriptRes.ok && scriptBody.includes('voice-agent-bridge.service'), 'Expected vicibox-install.sh download');
    wsMon.close();
    console.log(`✓ [9/9] SQLite bridge_calls CDR persistence (${logsJson.logs.length} calls), /ws/vici-monitor telemetry & vicibox-install.sh verified`);

    console.log('\nALL 9 STEP 3 CHECKS PASSED SUCCESSFULLY!');
  } finally {
    try {
      monWs?.close();
    } catch {}
    await viciBridge.stop();
    (server as any).closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

run().catch((err) => {
  console.error('Step 3 Verification FAILED:', err);
  process.exit(1);
});
