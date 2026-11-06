import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import http from 'node:http';
import net from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { getConsoleState, listBridgeCallLogs, saveConsoleState } from '../src/db';
import { buildRtpPacket, linear16ToUlaw, parseRtpPacket } from '../src/g711';
import { canonicalUuidToBytes, VicidialBridgeService } from '../src/vici-bridge';

// Local protocol fixtures only. They do not connect to a real PBX or provider.
type Transport = 'audiosocket' | 'sip_rtp';
type Mode = 'silent' | 'early' | 'cancel' | 'refused';
type Scenario = {
  transport: Transport;
  mode: Mode;
  ready: Promise<void>;
  appliedAt: number;
  audioTimes: number[];
  endedAt: number;
  callerBytes: number;
  injected: Array<{ text: string; at: number }>;
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
  state.services = {
    stt: { providerId: 's1', model: 'nova-3' },
    llm: { providerId: 'l1', model: 'gpt-4o-mini' },
    tts: { providerId: 't1', model: 'aura-2-thalia-en' },
  };
  const agent = state.agents.find((entry) => entry.id === state.campaigns[0].agentId)!;
  agent.greeting = 'Hi, this is Jessi from Example Services. How are you doing?';
  agent.injectCampaignDisclosure = false;
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
      // 200 ms of PCM, delivered at once to test paced queue draining.
      ws.send(Buffer.alloc(320 * 10, 0x18), { binary: true });
      ws.send(JSON.stringify({ type: 'FunctionCallRequest', functions: [
        { id: 'end-test', name: 'end_call', arguments: '{}', client_side: true },
      ] }));
    };
    ws.on('message', (raw, binary) => {
      if (binary) {
        const pcm = Buffer.from(raw as Buffer);
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
        if (current.mode === 'refused') {
          ws.send(JSON.stringify({ type: 'InjectionRefused' }));
          ws.send(JSON.stringify({ type: 'Warning', code: 'INJECT_AGENT_MESSAGE_DURING_USER_SPEECH', description: 'Synthetic refusal warning.' }));
        } else emitAnswer(msg.message);
      } else if (msg.type === 'FunctionCallResponse' && msg.id === 'end-test') {
        ws.send(JSON.stringify({ type: 'AgentAudioDone' }));
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
      appliedAt: 0, audioTimes: [], endedAt: 0, callerBytes: 0, injected: [], settings: null,
      sendCaller: () => {},
    };
    scenario = current;
    const previousLogs = new Set(listBridgeCallLogs(200).map((row) => row.id));
    const status = bridge.getStatus();
    let client: net.Socket | null = null;
    let sip: dgram.Socket | null = null;
    let rtp: dgram.Socket | null = null;
    try {
      if (transport === 'audiosocket') {
        const registration = bridge.registerPreCall({ vici_cid: 'Fixture Caller', exten: `${state.vici.aiExten}1` });
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
            if (kind === 0x10) current.audioTimes.push(Date.now());
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
          if (parsed?.payloadType === 0) current.audioTimes.push(Date.now());
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
          'From: "Fixture Caller" <sip:fixture@127.0.0.1>;tag=fixture',
          `To: <sip:${ext}@127.0.0.1>`, `Contact: <sip:fixture@127.0.0.1:${localSipPort}>`,
          `Call-ID: ${callId}`, 'CSeq: 1 INVITE', `X-Vici-Exten: ${ext}`,
          'Content-Type: application/sdp', `Content-Length: ${Buffer.byteLength(sdp)}`, '', sdp,
        ].join('\r\n');
        sipClient.send(Buffer.from(invite), status.sipPort, '127.0.0.1');
      }

      await until(() => current.appliedAt > 0, `${transport} ${mode} provider readiness`);
      assert.equal(current.settings.agent.greeting, undefined, 'Do not use provider automatic greeting');
      assert.match(current.settings.agent.think.prompt, /Jessi from Example Services/);
      if (mode === 'cancel' || mode === 'refused') {
        if (mode === 'cancel') await wait(90);
        else {
          await until(() => current.injected.length === 1, `${transport} rejected injection`);
          await wait(550);
          assert.equal(current.injected.length, 1, 'A refused opening must not be repeatedly injected');
        }
        const active = bridge.getStatus().activeCalls[0];
        assert.ok(active && bridge.forceHangupCall(active.callId));
      }
      await until(() => current.endedAt > 0, `${transport} ${mode} hangup`);
      await until(() => bridge.getStatus().activeCallsCount === 0, `${transport} ${mode} cleanup`);
      if (mode === 'cancel') {
        await wait(550);
        assert.equal(current.injected.length, 0, 'Hangup cancels the opening timer');
        assert.equal(current.audioTimes.length, 0, 'Hangup does not leak audio');
      } else if (mode === 'refused') {
        assert.equal(current.audioTimes.length, 0, 'A refused injection must not invent playback');
        const cdr = listBridgeCallLogs(200).find((row) => !previousLogs.has(row.id));
        const systemMessages = cdr?.transcript.filter((entry) => entry.role === 'system').map((entry) => entry.content).join('\n') || '';
        assert.match(systemMessages, /declined an injected message/i);
        assert.match(systemMessages, /INJECT_AGENT_MESSAGE_DURING_USER_SPEECH/);
      } else {
        assert.equal(current.audioTimes.length, 10, 'All 200 ms of queued output must be paced before hangup');
        assert.ok(current.audioTimes[0] - current.appliedAt >= 490,
          `${transport} ${mode} leaked audio after ${current.audioTimes[0] - current.appliedAt} ms`);
        assert.ok(current.audioTimes.at(-1)! - current.audioTimes[0] >= 150, 'Frames must be paced, not emitted in one burst');
        assert.ok(current.endedAt >= current.audioTimes.at(-1)!, 'Hangup must follow the final audio frame');
        if (mode === 'silent') {
          assert.equal(current.injected.length, 1);
          assert.ok(current.injected[0].at - current.appliedAt >= 490);
          assert.match(current.injected[0].text, /Jessi from Example Services/);
          assert.equal((current.injected[0].text.match(/\?/g) || []).length, 1);
        } else {
          assert.ok(current.callerBytes > 0, 'Caller PCM must reach the mock provider during the wait');
          assert.equal(current.injected.length, 0, 'Early caller response must not be followed by a second opening');
        }
        const cdr = listBridgeCallLogs(200).find((row) => !previousLogs.has(row.id));
        assert.ok(cdr?.greetingId, 'The selected greeting ID is recorded');
        assert.equal(cdr!.transcript.filter((entry) => entry.role === 'assistant').length, 1);
      }
      const detail = mode === 'refused' ? 'refusal is logged; no invented audio or retry'
        : mode === 'cancel' ? 'hangup cancels the opening without audio'
        : mode === 'early' ? 'early caller reply waits and drains without a duplicate'
        : 'one delayed opening drains before hangup';
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
      for (const mode of ['silent', 'early', 'cancel', 'refused'] as const) await runScenario(transport, mode);
    }
  } finally {
    await bridge.stop();
    wss.clients.forEach((ws) => ws.terminate());
    wss.close();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    if (oldUrl === undefined) delete process.env.DEEPGRAM_AGENT_URL; else process.env.DEEPGRAM_AGENT_URL = oldUrl;
    if (oldKey === undefined) delete process.env.DEEPGRAM_API_KEY; else process.env.DEEPGRAM_API_KEY = oldKey;
    if (oldAllowed === undefined) delete process.env.BRIDGE_ALLOWED_IPS; else process.env.BRIDGE_ALLOWED_IPS = oldAllowed;
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
