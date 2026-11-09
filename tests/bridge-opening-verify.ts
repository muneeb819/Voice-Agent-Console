import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import http from 'node:http';
import net from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { getConsoleState, listBridgeCallLogs, saveConsoleState } from '../src/db';
import { buildRtpPacket, linear16ToUlaw, parseRtpPacket, ulawToLinear16 } from '../src/g711';
import { canonicalUuidToBytes, VicidialBridgeService } from '../src/vici-bridge';

// Local protocol fixtures only. They do not connect to a real PBX or provider.
type Transport = 'audiosocket' | 'sip_rtp';
type Mode = 'silent' | 'early' | 'cancel' | 'refused' | 'silent_wait' | 'bad_disposition' | 'bad_transfer';
type Scenario = {
  transport: Transport;
  mode: Mode;
  ready: Promise<void>;
  appliedAt: number;
  audioTimes: number[];
  audioPcm: Buffer[];
  comfortSilenceBytes: number;
  providerStates: string[];
  endedAt: number;
  callerBytes: number;
  injected: Array<{ text: string; at: number }>;
  functionResponses: any[];
  settings: any;
  sendCaller: () => void;
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(fn: () => boolean, label: string, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (fn()) return; await wait(10); }
  throw new Error(`Timed out waiting for ${label}`);
}
function socketAddress(socket: dgram.Socket) { return socket.address() as net.AddressInfo; }

async function main() {
  const state = getConsoleState();
  const sttProvider = state.providers.find((provider) => provider.kind === 'stt')!;
  const llmProvider = state.providers.find((provider) => provider.kind === 'llm' && provider.type === 'open_ai')!;
  const ttsProvider = state.providers.find((provider) => provider.kind === 'tts' && provider.type === 'deepgram')!;
  state.services = {
    stt: { providerId: sttProvider.id, model: 'nova-3' },
    llm: { providerId: llmProvider.id, model: 'gpt-4o-mini' },
    tts: { providerId: ttsProvider.id, model: 'aura-2-thalia-en' },
  };
  const campaign = state.campaigns[0];
  assert.ok(campaign, 'Bridge fixture requires an explicit campaign');
  const agent = state.agents.find((entry) => entry.id === campaign.agentId) || state.agents[0];
  campaign.agentId = agent.id;
  campaign.complianceRules = 'Reviewed bridge fixture rules: be truthful, avoid unsupported claims, and honor do-not-call requests immediately.';
  agent.greeting = 'Hi, this is Jessi from Example Services. How are you doing?';
  agent.injectCampaignDisclosure = false;

  const viciRequests: Array<{ fn: string; params: URLSearchParams }> = [];
  const viciApi = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const fn = url.searchParams.get('function') || '';
    viciRequests.push({ fn, params: url.searchParams });
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    if (fn === 'lead_all_info') {
      res.end('lead_id|phone_number|first_name|last_name|state|date_of_birth|age|status|campaign_id\n104892|3055550192|Robert|Fixture|FL|1955-04-10|71|NEW|FETEST');
    } else if (fn === 'update_lead') {
      res.end(`SUCCESS: synthetic update accepted for ${url.searchParams.get('status') || 'notes only'}`);
    } else {
      res.end('SUCCESS: synthetic local response');
    }
  });
  await new Promise<void>((resolve) => viciApi.listen(0, '127.0.0.1', resolve));
  state.vici.viciBaseUrl = `http://127.0.0.1:${(viciApi.address() as net.AddressInfo).port}`;
  saveConsoleState(state, 'Isolated bridge opening timing fixture');

  let scenario: Scenario | null = null;
  const provider = http.createServer();
  const wss = new WebSocketServer({ server: provider, path: '/agent' });
  wss.on('connection', (ws) => {
    const current = scenario!;
    let answered = false;
    ws.send(JSON.stringify({ type: 'Welcome' }));
    const emitAnswer = (text: string) => {
      if (answered || ws.readyState !== WebSocket.OPEN) return;
      answered = true;
      ws.send(JSON.stringify({ type: 'AgentStartedSpeaking' }));
      ws.send(JSON.stringify({ type: 'ConversationText', role: 'assistant', content: text }));
      // 200 ms of signed PCM, delivered at once to test paced queue draining.
      const pcm = Buffer.alloc(320 * 10); pcm.writeInt16LE(6000, 0);
      ws.send(pcm, { binary: true });
      if (current.mode !== 'silent_wait') {
        ws.send(JSON.stringify({ type: 'FunctionCallRequest', functions: [
          { id: 'end-test', name: 'end_call', arguments: '{}', client_side: true },
        ] }));
      } else {
        ws.send(JSON.stringify({ type: 'AgentAudioDone' }));
      }
    };
    ws.on('message', (raw, binary) => {
      if (binary) {
        const pcm = Buffer.from(raw as Buffer);
        if (pcm.every((byte) => byte === 0)) current.comfortSilenceBytes += pcm.length;
        if (pcm.some((byte) => byte !== 0)) {
          current.callerBytes += pcm.length;
          if (current.mode === 'early' && !answered) {
            ws.send(JSON.stringify({ type: 'UserStartedSpeaking' }));
            ws.send(JSON.stringify({ type: 'ConversationText', role: 'user', content: 'Hello' }));
            ws.send(JSON.stringify({ type: 'AgentThinking' }));
            emitAnswer('Hello, this is Jessi from Example Services. How are you?');
          }
        }
        return;
      }
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'Settings') {
        current.settings = msg;
        current.ready.then(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          current.appliedAt = Date.now();
          ws.send(JSON.stringify({ type: 'SettingsApplied' }));
          if (current.mode === 'early') setTimeout(() => current.sendCaller(), 70);
        });
      } else if (msg.type === 'InjectAgentMessage') {
        current.injected.push({ text: msg.message, at: Date.now() });
        if (current.mode === 'bad_disposition') {
          ws.send(JSON.stringify({ type: 'FunctionCallRequest', functions: [
            { id: 'bad-disposition', name: 'set_disposition', arguments: JSON.stringify({ code: 'BAD' }), client_side: true },
          ] }));
          return;
        }
        if (current.mode === 'bad_transfer') {
          ws.send(JSON.stringify({ type: 'FunctionCallRequest', functions: [
            { id: 'set-dnc', name: 'set_disposition', arguments: JSON.stringify({ code: 'DNC' }), client_side: true },
            { id: 'transfer-after-dnc', name: 'transfer_to_live_agent', arguments: JSON.stringify({ reason: 'Must not transfer a do-not-call lead' }), client_side: true },
          ] }));
          return;
        }
        if (current.mode === 'refused') {
          ws.send(JSON.stringify({ type: 'InjectionRefused' }));
          ws.send(JSON.stringify({ type: 'Warning', code: 'INJECT_AGENT_MESSAGE_DURING_USER_SPEECH', description: 'Synthetic refusal warning.' }));
        } else emitAnswer(msg.message);
      } else if (msg.type === 'FunctionCallResponse') {
        if (msg.id === 'end-test') ws.send(JSON.stringify({ type: 'AgentAudioDone' }));
        else current.functionResponses.push(msg);
      }
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const oldUrl = process.env.DEEPGRAM_AGENT_URL;
  const oldKey = process.env.DEEPGRAM_API_KEY;
  const oldAllowed = process.env.BRIDGE_ALLOWED_IPS;
  process.env.DEEPGRAM_AGENT_URL = `ws://127.0.0.1:${(provider.address() as net.AddressInfo).port}/agent`;
  process.env.DEEPGRAM_API_KEY = 'synthetic-bridge-key';
  process.env.BRIDGE_ALLOWED_IPS = '127.0.0.1';
  const bridge = new VicidialBridgeService({ host: '127.0.0.1', audioSocketPort: 0, sipPort: 0 });
  await bridge.start();

  async function runScenario(transport: Transport, mode: Mode) {
    let ready!: () => void;
    const current: Scenario = {
      transport, mode, ready: new Promise<void>((resolve) => { ready = resolve; }),
      appliedAt: 0, audioTimes: [], audioPcm: [], comfortSilenceBytes: 0, providerStates: [], endedAt: 0, callerBytes: 0, injected: [], functionResponses: [], settings: null,
      sendCaller: () => {},
    };
    scenario = current;
    const previousLogs = new Set(listBridgeCallLogs(200).map((row) => row.id));
    const previousViciRequestCount = viciRequests.length;
    const status = bridge.getStatus();
    let client: net.Socket | null = null;
    let sip: dgram.Socket | null = null;
    let rtp: dgram.Socket | null = null;
    try {
      if (transport === 'audiosocket') {
        const registration = bridge.registerPreCall({ vici_cid: 'V1027153012000104892', phone: '3055550192', exten: `${state.vici.aiExten}1` });
        client = net.createConnection({ host: '127.0.0.1', port: status.audioSocketPort });
        const tcp = client;
        let rx = Buffer.alloc(0);
        tcp.on('connect', () => {
          tcp.write(Buffer.concat([Buffer.from([0x01, 0x00, 0x10]), canonicalUuidToBytes(registration.uuid)]));
          ready();
        });
        tcp.on('data', (data) => {
          rx = Buffer.concat([rx, data]);
          while (rx.length >= 3) {
            const kind = rx[0], len = rx.readUInt16BE(1);
            if (rx.length < len + 3) break;
            if (kind === 0x10) { current.audioTimes.push(Date.now()); current.audioPcm.push(Buffer.from(rx.subarray(3, len + 3))); }
            if (kind === 0x00) current.endedAt = Date.now();
            rx = rx.subarray(len + 3);
          }
        });
        tcp.on('error', () => {});
        current.sendCaller = () => {
          if (!tcp.destroyed) tcp.write(Buffer.concat([Buffer.from([0x10, 0x01, 0x40]), Buffer.alloc(320, 0x11)]));
        };
      } else {
        sip = dgram.createSocket('udp4');
        rtp = dgram.createSocket('udp4');
        const sipClient = sip, rtpClient = rtp;
        await Promise.all([
          new Promise<void>((resolve) => sipClient.bind(0, '127.0.0.1', resolve)),
          new Promise<void>((resolve) => rtpClient.bind(0, '127.0.0.1', resolve)),
        ]);
        const localSipPort = socketAddress(sipClient).port;
        const localRtpPort = socketAddress(rtpClient).port;
        const callId = `${crypto.randomUUID()}@fixture`;
        let remoteRtpPort = 0;
        rtpClient.on('message', (packet) => {
          const parsed = parseRtpPacket(packet);
          if (parsed?.payloadType === 0) { current.audioTimes.push(Date.now()); current.audioPcm.push(ulawToLinear16(parsed.payload)); }
        });
        sipClient.on('message', (data) => {
          const message = data.toString();
          if (message.startsWith('SIP/2.0 200') && /^CSeq:\s*1 INVITE/im.test(message)) {
            const port = /^m=audio\s+(\d+)\s+RTP\/AVP/m.exec(message);
            if (!port) return;
            remoteRtpPort = Number(port[1]);
            ready();
          } else if (message.startsWith('BYE ')) {
            current.endedAt = Date.now();
          }
        });
        current.sendCaller = () => {
          if (!remoteRtpPort) return;
          const packet = buildRtpPacket({ payloadType: 0, sequenceNumber: 1, timestamp: 160,
            ssrc: 12345, marker: true, payload: linear16ToUlaw(Buffer.alloc(320, 0x11)) });
          rtpClient.send(packet, remoteRtpPort, '127.0.0.1');
        };
        const sdp = [
          'v=0', 'o=fixture 1 1 IN IP4 127.0.0.1', 's=Fixture', 'c=IN IP4 127.0.0.1',
          't=0 0', `m=audio ${localRtpPort} RTP/AVP 0`, 'a=rtpmap:0 PCMU/8000', '',
        ].join('\r\n');
        const ext = `${state.vici.aiExten}1`;
        const invite = [
          `INVITE sip:${ext}@127.0.0.1:${status.sipPort} SIP/2.0`,
          `Via: SIP/2.0/UDP 127.0.0.1:${localSipPort};branch=z9hG4bKfixture;rport`,
          'From: "V1027153012000104892" <sip:3055550192@127.0.0.1>;tag=fixture',
          `To: <sip:${ext}@127.0.0.1>`, `Contact: <sip:fixture@127.0.0.1:${localSipPort}>`,
          `Call-ID: ${callId}`, 'CSeq: 1 INVITE', `X-Vici-Exten: ${ext}`,
          'Content-Type: application/sdp', `Content-Length: ${Buffer.byteLength(sdp)}`, '', sdp,
        ].join('\r\n');
        sipClient.send(Buffer.from(invite), status.sipPort, '127.0.0.1');
      }

      await until(() => current.appliedAt > 0, `${transport} ${mode} provider readiness`);
      assert.equal(current.settings.agent.greeting, undefined, 'Do not use provider automatic greeting');
      assert.match(current.settings.agent.think.prompt, /Jessi from Example Services/);
      if (mode === 'cancel' || mode === 'refused' || mode === 'bad_disposition' || mode === 'bad_transfer') {
        if (mode === 'cancel') await wait(90);
        else if (mode === 'refused') {
          await until(() => current.injected.length === 1, `${transport} rejected injection`);
          await wait(550);
          assert.equal(current.injected.length, 1, 'A refused opening must not be repeatedly injected');
        } else {
          const expectedResponses = mode === 'bad_transfer' ? 2 : 1;
          await until(() => current.functionResponses.length === expectedResponses, `${transport} ${mode} function result`);
          assert.equal(current.injected.length, 1, 'The configured opening is sent once before function validation');
        }
        const active = bridge.getStatus().activeCalls[0];
        assert.ok(active && bridge.forceHangupCall(active.callId));
      }
      if (mode !== 'silent_wait') {
        await until(() => current.endedAt > 0, `${transport} ${mode} hangup`);
        await until(() => bridge.getStatus().activeCallsCount === 0, `${transport} ${mode} cleanup`);
      }
      if (mode === 'cancel') {
        await wait(1100);
        assert.equal(current.injected.length, 0, 'Hangup cancels the opening timer');
        assert.equal(current.audioTimes.length, 0, 'Hangup does not leak audio');
      } else if (mode === 'refused') {
        assert.equal(current.audioTimes.length, 0, 'A refused injection must not invent playback');
        const cdr = listBridgeCallLogs(200).find((row) => !previousLogs.has(row.id));
        const systemMessages = cdr?.transcript.filter((entry) => entry.role === 'system').map((entry) => entry.content).join('\n') || '';
        assert.match(systemMessages, /declined an injected message/i);
        assert.match(systemMessages, /INJECT_AGENT_MESSAGE_DURING_USER_SPEECH/);
      } else if (mode === 'silent_wait') {
        await until(() => current.injected.length === 1 && current.audioTimes.length === 10, `${transport} silent opening and PCM drain`);
        assert.equal(current.injected.length, 1, 'A silent line receives the configured opening exactly once');
        assert.match(current.injected[0].text, /Jessi from Example Services/);
        assert.ok(current.settings.agent.think.prompt.includes(JSON.stringify(current.injected[0].text)), 'The injected opening is the selected campaign opening');
        assert.ok(current.injected[0].at - current.appliedAt >= 990);
        assert.equal(current.audioTimes.length, 10, 'The mock opening PCM is paced to the transport');
        assert.equal(Buffer.concat(current.audioPcm).length, 3200, 'All 200 ms of signed agent PCM reaches the transport');
        assert.ok(current.comfortSilenceBytes >= 800, 'Comfort-silence PCM keeps the upstream session alive');
        // Longer than the retired minimum response timeout. Silence alone must
        // not hang up, invent a disposition, or call either VICIdial update API.
        await wait(3300);
        assert.equal(current.endedAt, 0, 'Silence alone must not end the mock call');
        assert.equal(bridge.getStatus().activeCallsCount, 1);
        assert.equal(current.injected.length, 1, 'No repeated prompt while waiting');
        const waitingRequests = viciRequests.slice(previousViciRequestCount);
        assert.ok(!waitingRequests.some((request) => request.fn === 'update_lead' || request.fn === 'ra_call_control'),
          'Waiting in silence must not update a lead or release the Remote Agent slot');
        const active = bridge.getStatus().activeCalls[0];
        assert.ok(active && bridge.forceHangupCall(active.callId));
        await until(() => current.endedAt > 0, 'explicit operator hangup after silence');
        await until(() => bridge.getStatus().activeCallsCount === 0, 'silent-wait cleanup');
        const cdr = listBridgeCallLogs(200).find((row) => !previousLogs.has(row.id));
        assert.ok(cdr, 'The explicitly ended silent call is saved');
        assert.equal(cdr!.disposition, null, 'Silence does not fabricate a disposition');
        assert.ok(!cdr!.functionCalls.some((entry) => /dead.?air/i.test(entry.name)), 'No retired automatic-silence function is logged');
        const hangup = viciRequests.slice(previousViciRequestCount).find((request) => request.fn === 'ra_call_control');
        assert.equal(hangup?.params.get('stage'), 'HANGUP');
        assert.equal(hangup?.params.get('status'), 'NA', 'Only the explicit hangup uses the neutral fallback status');
      } else if (mode === 'bad_disposition') {
        const response = JSON.parse(current.functionResponses[0].content);
        assert.equal(response.ok, false);
        assert.match(response.error, /not allowed by selected campaign/i);
        const callRequests = viciRequests.slice(previousViciRequestCount);
        assert.ok(!callRequests.some((request) => request.fn === 'update_lead'), 'Disallowed disposition must not change VICIdial status');
        const hangup = callRequests.find((request) => request.fn === 'ra_call_control');
        assert.equal(hangup?.params.get('stage'), 'HANGUP');
        assert.equal(hangup?.params.get('status'), 'NA');
      } else if (mode === 'bad_transfer') {
        const setResponse = JSON.parse(current.functionResponses.find((response) => response.id === 'set-dnc').content);
        const transferResponse = JSON.parse(current.functionResponses.find((response) => response.id === 'transfer-after-dnc').content);
        assert.equal(setResponse.ok, true, `Selected campaign’s DNC status is allowed (${JSON.stringify(setResponse)})`);
        assert.equal(transferResponse.ok, false, 'A transfer cannot reuse a non-XFER disposition');
        assert.match(transferResponse.error, /requires the allowed XFER disposition/i);
        const callRequests = viciRequests.slice(previousViciRequestCount);
        assert.ok(!callRequests.some((request) => request.fn === 'ra_call_control' && request.params.get('stage') !== 'HANGUP'),
          'A DNC disposition cannot start a Remote Agent transfer');
        const hangup = callRequests.find((request) => request.fn === 'ra_call_control');
        assert.equal(hangup?.params.get('stage'), 'HANGUP');
        assert.equal(hangup?.params.get('status'), 'DNC');
      } else {
        assert.equal(current.audioTimes.length, 10, 'All 200 ms of queued output must be paced before hangup');
        assert.ok(current.audioTimes[0] - current.appliedAt >= 990,
          `${transport} ${mode} leaked audio after ${current.audioTimes[0] - current.appliedAt} ms`);
        assert.ok(current.audioTimes.at(-1)! - current.audioTimes[0] >= 150, 'Frames must be paced, not emitted in one burst');
        assert.ok(current.endedAt >= current.audioTimes.at(-1)!, 'Hangup must follow the final audio frame');
        if (mode === 'silent') {
          assert.equal(current.injected.length, 1);
          assert.ok(current.injected[0].at - current.appliedAt >= 990);
          assert.match(current.injected[0].text, /Jessi from Example Services/, 'A silent line receives the selected configured opening once');
          assert.ok(current.settings.agent.think.prompt.includes(JSON.stringify(current.injected[0].text)));
        } else {
          assert.ok(current.callerBytes > 0, 'Caller PCM must reach the mock provider during the wait');
          assert.equal(current.injected.length, 0, 'Early caller response must not be followed by a second opening');
        }
        const cdr = listBridgeCallLogs(200).find((row) => !previousLogs.has(row.id));
        assert.ok(cdr?.greetingId, 'The selected greeting ID is recorded');
        assert.equal(cdr!.transcript.filter((entry) => entry.role === 'assistant').length, 1);
      }
      const detail = mode === 'silent_wait' ? 'configured opening streams; silence stays connected until explicit hangup'
        : mode === 'bad_disposition' ? 'disallowed status is rejected before update_lead'
        : mode === 'bad_transfer' ? 'non-XFER disposition cannot initiate a transfer'
        : mode === 'refused' ? 'refusal is logged; no invented audio or retry'
        : mode === 'cancel' ? 'hangup cancels the opening without audio'
        : mode === 'early' ? 'early caller reply waits and drains without a duplicate'
        : 'configured opening and response drain before hangup';
      console.log(`✓ ${transport} ${mode}: ${detail} (local mock)`);
    } finally {
      client?.destroy();
      try { sip?.close(); } catch {}
      try { rtp?.close(); } catch {}
      for (const active of bridge.getStatus().activeCalls) bridge.forceHangupCall(active.callId);
    }
  }

  try {
    for (const transport of ['audiosocket', 'sip_rtp'] as const) {
      for (const mode of ['silent', 'early', 'cancel', 'refused', 'silent_wait', 'bad_disposition', 'bad_transfer'] as const) await runScenario(transport, mode);
    }
  } finally {
    await bridge.stop();
    wss.clients.forEach((ws) => ws.terminate());
    wss.close();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await new Promise<void>((resolve) => viciApi.close(() => resolve()));
    if (oldUrl === undefined) delete process.env.DEEPGRAM_AGENT_URL; else process.env.DEEPGRAM_AGENT_URL = oldUrl;
    if (oldKey === undefined) delete process.env.DEEPGRAM_API_KEY; else process.env.DEEPGRAM_API_KEY = oldKey;
    if (oldAllowed === undefined) delete process.env.BRIDGE_ALLOWED_IPS; else process.env.BRIDGE_ALLOWED_IPS = oldAllowed;
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
