// Live call listening: owners/admins hear a live bridge call (caller + bot),
// listen only, limited, logged in the call transcript, closed when the call ends.
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { getConsoleState, listBridgeCallLogs, saveConsoleState } from '../src/db';
import { createServerWithSimulator } from '../src/server';
import { createUser, createUserSession, setUserRole } from '../src/user-store';
import { canonicalUuidToBytes } from '../src/vici-bridge';

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(fn: () => boolean, label: string, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (fn()) return; await wait(10); }
  throw new Error(`Timed out waiting for ${label}`);
}
let checks = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); checks++; console.log(`✓ ${m}`); };

(async () => {
  const state = getConsoleState();
  const stt = state.providers.find((p) => p.kind === 'stt')!;
  const llm = state.providers.find((p) => p.kind === 'llm' && p.type === 'open_ai')!;
  const tts = state.providers.find((p) => p.kind === 'tts' && p.type === 'deepgram')!;
  state.services = { stt: { providerId: stt.id, model: 'nova-3' }, llm: { providerId: llm.id, model: 'gpt-4o-mini' }, tts: { providerId: tts.id, model: 'aura-2-thalia-en' } };
  const campaign = state.campaigns[0];
  const agent = state.agents.find((a) => a.id === campaign.agentId) || state.agents[0];
  campaign.agentId = agent.id;
  campaign.complianceRules = 'Reviewed fixture rules: be truthful and honour do-not-call requests.';
  (agent as any).flow = { ...((agent as any).flow || {}), waitForHello: false, greetingLines: '' };
  agent.injectCampaignDisclosure = false;
  const vici = http.createServer((_q, r) => { r.writeHead(200); r.end('SUCCESS: fixture'); });
  await new Promise<void>((r) => vici.listen(0, '127.0.0.1', r));
  state.vici.viciBaseUrl = `http://127.0.0.1:${(vici.address() as net.AddressInfo).port}`;
  saveConsoleState(state, 'Live listen fixture');

  // Provider: answers Settings, then speaks a recognisable bot tone (0x2222) on request.
  const provider = http.createServer();
  const pwss = new WebSocketServer({ server: provider, path: '/agent' });
  let providerWs: WebSocket | null = null;
  let openingSent = false;
  pwss.on('connection', (ws) => {
    providerWs = ws;
    ws.send(JSON.stringify({ type: 'Welcome', request_id: 'listen-fixture' }));
    ws.on('message', (raw, bin) => {
      if (bin) return;
      const t = JSON.parse(raw.toString()).type;
      if (t === 'Settings') ws.send(JSON.stringify({ type: 'SettingsApplied' }));
      if (t === 'InjectAgentMessage') openingSent = true;
    });
  });
  await new Promise<void>((r) => provider.listen(0, '127.0.0.1', r));
  process.env.DEEPGRAM_AGENT_URL = `ws://127.0.0.1:${(provider.address() as net.AddressInfo).port}/agent`;
  process.env.DEEPGRAM_API_KEY = 'synthetic-key';
  process.env.BRIDGE_ALLOWED_IPS = '127.0.0.1';

  const owner = await createUser({ email: 'owner@listen.test', fullName: 'Owner Person', password: 'listen-owner-password-123' } as any);
  const viewer = await createUser({ email: 'viewer@listen.test', fullName: 'Viewer Person', password: 'listen-viewer-password-123' } as any);
  setUserRole(viewer.user!.id, 'viewer');
  const ownerToken = createUserSession(owner.user!.id);
  const viewerToken = createUserSession(viewer.user!.id);

  const { server, viciBridge } = createServerWithSimulator({ enableBridge: true, host: '127.0.0.1', audioSocketPort: 0, sipPort: 0 });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  await viciBridge!.start();
  const port = (server.address() as net.AddressInfo).port;
  const status = viciBridge!.getStatus();

  // A live AudioSocket call; the caller sends a recognisable pattern (0x1111).
  const reg = viciBridge!.registerPreCall({ vici_cid: 'V1027153012000104892', phone: '3055550192', exten: `${state.vici.aiExten}1` });
  const tcp = net.createConnection({ host: '127.0.0.1', port: status.audioSocketPort });
  let callerReceived = 0;
  tcp.on('data', () => { callerReceived++; });
  tcp.on('error', () => {});
  await new Promise<void>((r) => tcp.on('connect', () => r()));
  tcp.write(Buffer.concat([Buffer.from([0x01, 0x00, 0x10]), canonicalUuidToBytes(reg.uuid)]));
  await until(() => viciBridge!.getStatus().activeCalls.length === 1, 'live call');
  const callId = viciBridge!.getStatus().activeCalls[0].callId;
  const callerFrame = Buffer.concat([Buffer.from([0x10, 0x01, 0x40]), Buffer.alloc(320, 0x11)]);
  const pump = setInterval(() => { if (!tcp.destroyed) tcp.write(callerFrame); }, 20);

  const open = (token: string, id: string, origin = `http://127.0.0.1:${port}`) => new Promise<{ ws?: WebSocket; status?: number; msgs: any[]; frames: Buffer[] }>((resolve) => {
    const msgs: any[] = [];
    const frames: Buffer[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/vici-listen?callId=${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token}`, Origin: origin } });
    ws.on('message', (d, bin) => { if (bin) frames.push(Buffer.from(d as Buffer)); else msgs.push(JSON.parse(d.toString())); });
    ws.on('unexpected-response', (_q, res) => resolve({ status: res.statusCode, msgs, frames }));
    ws.on('open', () => resolve({ ws, msgs, frames }));
    ws.on('error', () => {});
  });

  try {
    // Access control.
    ok((await open(viewerToken, callId)).status === 403, 'a viewer cannot listen (403)');
    ok((await open('not-a-session', callId)).status === 401, 'no session cannot listen (401)');
    ok((await open(ownerToken, callId, 'https://evil.example')).status === 403, 'another website cannot open the listening socket');
    ok((await open(ownerToken, '../../etc/passwd')).status === 400, 'malformed call ID refused (400)');
    const gone = await open(ownerToken, 'vici_abcd1234_deadbeef');
    await until(() => gone.msgs.some((m) => m.type === 'error'), 'not-live error');
    ok(/not live/.test(gone.msgs.find((m) => m.type === 'error').error), 'a call that is not live is refused with a message');

    // Owner listens: caller and bot audio, in order, labelled.
    const l1 = await open(ownerToken, callId);
    await until(() => l1.msgs.some((m) => m.type === 'listening'), 'listening ack');
    await until(() => l1.frames.some((f) => f[0] === 1), 'caller audio');
    const callerAudio = l1.frames.find((f) => f[0] === 1)!;
    ok(callerAudio.length === 321 && callerAudio[1] === 0x11 && callerAudio[320] === 0x11, 'listener hears the caller (kind 1, unchanged PCM)');
    await until(() => providerWs !== null && openingSent, 'bot opening released', 6000);
    providerWs!.send(Buffer.alloc(3200, 0x22), { binary: true });
    await until(() => l1.frames.some((f) => f[0] === 2 && f[1] === 0x22), 'bot audio', 5000);
    const botFrames = l1.frames.filter((f) => f[0] === 2 && f[1] === 0x22);
    ok(botFrames.every((f) => f.length === 321), 'listener hears the bot as it is played, in 20 ms frames (kind 2)');

    // Listen only: messages from the listener change nothing on the call.
    const before = callerReceived;
    l1.ws!.send(Buffer.alloc(320, 0x7f));
    l1.ws!.send('{"type":"InjectAgentMessage","message":"hi"}');
    await wait(300);
    ok(viciBridge!.getStatus().activeCalls.length === 1, 'listener messages do not affect the call');
    ok(callerReceived >= before, 'caller line unaffected');

    // Limits: 3 per call.
    const l2 = await open(ownerToken, callId); const l3 = await open(ownerToken, callId); const l4 = await open(ownerToken, callId);
    await until(() => l4.msgs.some((m) => m.type === 'error'), 'limit error');
    ok(/Already 3/.test(l4.msgs.find((m) => m.type === 'error').error), 'a 4th listener on the same call is refused');
    ok(viciBridge!.listenerCount(callId) === 3, 'three listeners attached');
    l3.ws!.close(); l2.ws!.close();
    await until(() => viciBridge!.listenerCount(callId) === 1, 'listeners detached');

    // The call ends: listeners are told and closed; the transcript records who listened.
    clearInterval(pump);
    tcp.write(Buffer.from([0x00, 0x00, 0x00]));
    await until(() => l1.msgs.some((m) => m.type === 'ended'), 'ended message');
    await until(() => l1.ws!.readyState === WebSocket.CLOSED, 'listener closed');
    ok(true, 'listener is told the call ended and is closed');
    ok(viciBridge!.listenerCount() === 0, 'no listener left after the call');
    await until(() => listBridgeCallLogs(5).some((c) => c.id === callId), 'call log');
    const log = listBridgeCallLogs(5).find((c) => c.id === callId)!;
    ok(log.transcript.some((t) => /owner@listen\.test started listening \(listen only\)/.test(t.content)), 'call transcript records who started listening');
    ok(log.transcript.some((t) => /stopped listening/.test(t.content)), 'call transcript records when they stopped');
  } finally {
    clearInterval(pump);
    tcp.destroy();
    await viciBridge!.stop();
    server.close(); provider.close(); vici.close(); pwss.close();
  }
  console.log(`✓ Live listening: ${checks} checks passed`);
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
