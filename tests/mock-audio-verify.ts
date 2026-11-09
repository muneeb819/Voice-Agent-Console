import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import WebSocket, { WebSocketServer } from 'ws';
import { getConsoleState, getSimulatorCallLog, saveConsoleState } from '../src/db';
import { createServerWithSimulator } from '../src/server';

const root = path.resolve(__dirname, '..');
const publicDir = path.join(root, 'public');
const read = (file: string) => fs.readFileSync(path.join(publicDir, file), 'utf8');
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, label: string, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (predicate()) return; await wait(10); }
  throw new Error(`Timed out waiting for ${label}`);
}

function pcm16(samples: number, amplitude: number, frequency = 440, sampleRate = 24000): Buffer {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * frequency * i / sampleRate) * amplitude), i * 2);
  return buf;
}

async function serverMockSession() {
  const state = getConsoleState();
  const stt = state.providers.find((p) => p.kind === 'stt' && p.type === 'deepgram')!;
  const llm = state.providers.find((p) => p.kind === 'llm' && p.type === 'open_ai')!;
  const tts = state.providers.find((p) => p.kind === 'tts' && p.type === 'deepgram')!;
  state.services = {
    stt: { providerId: stt.id, model: 'nova-3' },
    llm: { providerId: llm.id, model: 'gpt-4o-mini' },
    tts: { providerId: tts.id, model: 'aura-2-thalia-en' },
  };
  const agent = state.agents.find((a) => a.id === 'a1') || state.agents[0];
  const campaign = state.campaigns.find((c) => c.agentId === agent.id) || state.campaigns[0];
  campaign.agentId = agent.id;
  campaign.agentIds = [...new Set([agent.id, ...(campaign.agentIds || [])])];
  campaign.complianceRules = 'Reviewed mock audio rules: be truthful, avoid unsupported claims, and honor do-not-call requests immediately.';
  agent.randomGreetingEnabled = false;
  agent.injectCampaignDisclosure = false;
  agent.greeting = 'Hi, this is the mock audio agent. How are you today?';
  saveConsoleState(state, 'Isolated mock audio streaming fixture');

  const upstream = http.createServer();
  const wss = new WebSocketServer({ server: upstream, path: '/agent' });
  const receivedPcm: Buffer[] = [];
  const openings: Array<{ text: string; at: number }> = [];
  const userMessages: string[] = [];
  let appliedAt = 0;
  let comfortSilenceBytes = 0;
  let wire: any;
  const openingPcm = pcm16(2400, 7000); // 100 ms at 24 kHz
  const replyPcm = pcm16(1200, 5000, 660); // 50 ms at 24 kHz
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'Welcome' }));
    const speak = (text: string, pcm: Buffer) => {
      ws.send(JSON.stringify({ type: 'AgentStartedSpeaking' }));
      ws.send(JSON.stringify({ type: 'ConversationText', role: 'assistant', content: text }));
      ws.send(pcm, { binary: true });
      ws.send(JSON.stringify({ type: 'AgentAudioDone' }));
    };
    ws.on('message', (raw, binary) => {
      if (binary) {
        const buf = Buffer.from(raw as Buffer);
        receivedPcm.push(buf);
        if (buf.every((byte) => byte === 0)) comfortSilenceBytes += buf.length;
        return;
      }
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'Settings') {
        wire = msg;
        appliedAt = Date.now();
        ws.send(JSON.stringify({ type: 'SettingsApplied' }));
      } else if (msg.type === 'InjectAgentMessage') {
        openings.push({ text: msg.message, at: Date.now() });
        speak(msg.message, openingPcm);
      } else if (msg.type === 'InjectUserMessage') {
        userMessages.push(msg.content);
        ws.send(JSON.stringify({ type: 'UserStartedSpeaking' }));
        ws.send(JSON.stringify({ type: 'ConversationText', role: 'user', content: msg.content }));
        ws.send(JSON.stringify({ type: 'AgentThinking' }));
        speak('Mock reply after the caller turn.', replyPcm);
      }
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const oldUrl = process.env.DEEPGRAM_AGENT_URL;
  const oldKey = process.env.DEEPGRAM_API_KEY;
  process.env.DEEPGRAM_AGENT_URL = `ws://127.0.0.1:${(upstream.address() as any).port}/agent`;
  process.env.DEEPGRAM_API_KEY = 'synthetic-mock-audio-key';
  const { server } = createServerWithSimulator();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new WebSocket(`ws://127.0.0.1:${(server.address() as any).port}/ws/simulator`);
  const events: any[] = [];
  const clientPcm: Buffer[] = [];
  client.on('message', (raw, binary) => {
    if (binary) clientPcm.push(Buffer.from(raw as Buffer));
    else events.push(JSON.parse(raw.toString()));
  });
  try {
    await new Promise<void>((resolve, reject) => { client.once('open', () => resolve()); client.once('error', reject); });
    const preSettings = pcm16(160, 3000, 220, 16000);
    const callerTurn = pcm16(320, 4000, 330, 16000);
    client.send(JSON.stringify({ type: 'start', agentId: agent.id, campaignId: campaign.id, upstreamMode: 'deepgram', bandwidth: 'wideband' }));
    client.send(preSettings, { binary: true });
    await until(() => events.some((e) => e.type === 'session_started'), 'mock session_started');
    client.send(callerTurn, { binary: true });
    await until(() => openings.length === 1 && clientPcm.length === 1, 'silent-caller opening and agent PCM');
    assert.equal(wire.agent.greeting, undefined, 'The provider automatic greeting stays disabled');
    assert.equal(openings[0].text, agent.greeting);
    assert.ok(openings[0].at - appliedAt >= 990, 'The opening waits for the one-second listen');
    assert.ok(receivedPcm.some((buf) => buf.equals(preSettings)), 'Pre-settings caller PCM is buffered and forwarded intact');
    assert.ok(receivedPcm.some((buf) => buf.equals(callerTurn)), 'Post-settings caller PCM reaches the mock provider intact');
    assert.ok(clientPcm[0].equals(openingPcm), 'The browser receives the exact provider PCM, not invented audio');
    const states = events.filter((e) => e.type === 'agent_state').map((e) => e.state);
    assert.deepEqual(states, ['listening', 'speaking', 'listening']);
    assert.ok(events.some((e) => e.type === 'transcript' && e.role === 'assistant' && e.content === agent.greeting));
    await until(() => comfortSilenceBytes >= 1600, 'comfort-silence keep-alive PCM');
    await wait(1200);
    assert.equal(events.some((e) => e.type === 'call_ended'), false, 'Silence after the opening must not end the mock session');
    assert.equal(openings.length, 1, 'Silence must not repeat the opening');

    client.send(JSON.stringify({ type: 'inject_user_message', content: 'Hello after the opening' }));
    await until(() => clientPcm.length === 2 && userMessages.length === 1, 'post-opening caller turn and reply');
    assert.ok(clientPcm[1].equals(replyPcm));
    assert.ok(events.some((e) => e.type === 'latency' && e.ttfbMs >= 1));
    client.send(JSON.stringify({ type: 'stop' }));
    await until(() => events.some((e) => e.type === 'call_ended'), 'explicit mock hangup');
    const ended = events.find((e) => e.type === 'call_ended');
    assert.equal(ended.reason, 'user_hangup');
    assert.equal(ended.logSaved, true);
    assert.equal(ended.disposition, null);
    assert.equal(ended.txAudioBytes, preSettings.length + callerTurn.length);
    assert.equal(ended.rxAudioBytes, openingPcm.length + replyPcm.length);
    const log = getSimulatorCallLog(ended.callId)!;
    assert.equal(log.disposition, null);
    assert.ok(log.transcript.some((entry) => entry.role === 'assistant' && entry.content === agent.greeting));
    assert.ok(!log.functionCalls.some((entry) => /dead.?air/i.test(entry.name)));
    console.log('✓ Mock Live Bot WebSocket: exact bidirectional PCM, comfort silence, opening/speaking/listening events, continued silence and explicit hangup');
  } finally {
    client.terminate();
    wss.clients.forEach((ws) => ws.terminate());
    wss.close();
    upstream.closeAllConnections?.();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (oldUrl === undefined) delete process.env.DEEPGRAM_AGENT_URL; else process.env.DEEPGRAM_AGENT_URL = oldUrl;
    if (oldKey === undefined) delete process.env.DEEPGRAM_API_KEY; else process.env.DEEPGRAM_API_KEY = oldKey;
  }
}

async function browserMockPlayback() {
  const state = JSON.parse(read('default-state.json'));
  const stt = state.providers.find((p: any) => p.kind === 'stt' && p.type === 'deepgram');
  const llm = state.providers.find((p: any) => p.kind === 'llm' && p.type === 'open_ai');
  const tts = state.providers.find((p: any) => p.kind === 'tts' && p.type === 'deepgram');
  state.services = { stt: { providerId: stt.id, model: 'nova-3' }, llm: { providerId: llm.id, model: 'gpt-4o-mini' }, tts: { providerId: tts.id, model: 'aura-2-thalia-en' } };
  for (const agent of state.agents) { agent.randomGreetingEnabled = false; agent.injectCampaignDisclosure = false; }
  const agent = state.agents.find((a: any) => a.id === 'a1') || state.agents[0];
  agent.greeting = 'Hi, this is the browser mock agent. How are you today?';
  const campaign = state.campaigns.find((c: any) => c.agentId === agent.id) || state.campaigns[0];
  campaign.agentId = agent.id;
  campaign.agentIds = [agent.id];
  campaign.complianceRules = 'Reviewed browser mock rules: be truthful, avoid unsupported claims, and honor do-not-call requests immediately.';

  const html = read('index.html').replace(/<script[\s\S]*?<\/script>/g, '');
  const errors: string[] = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (error) => errors.push(error.message));
  const dom = new JSDOM(html, { url: 'https://console.example/Voice-Agent-Console/?tab=test', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  (w as any).Response = Response;
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} } as any);
  w.requestAnimationFrame = (() => 0) as any;
  w.cancelAnimationFrame = (() => {}) as any;
  w.localStorage.setItem('vac_cloud_session_v1', JSON.stringify({ user: { id: 'mock', fullName: 'Mock Operator', email: 'mock@example.test' } }));
  w.localStorage.setItem('vac_cloud_state_v1', JSON.stringify(state));
  w.localStorage.setItem('vac_cloud_secrets_v1', JSON.stringify({ DEEPGRAM_API_KEY: 'synthetic-browser-mock-key' }));
  w.fetch = (async (input: any) => {
    const url = String(input);
    if (url.includes('/api/')) return new Response('<html>Not found</html>', { status: 404, headers: { 'content-type': 'text/html' } });
    const name = new URL(url, 'https://console.example/Voice-Agent-Console/').pathname.split('/').pop()!;
    if (['default-state.json', 'greetings.json', 'version.json'].includes(name)) return new Response(read(name), { headers: { 'content-type': 'application/json' } });
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  }) as any;
  (w as any).indexedDB = undefined;

  const scheduled: any[] = [];
  const contexts: any[] = [];
  (w as any).AudioContext = class {
    state = 'running'; currentTime = 0; destination = {};
    constructor() { contexts.push(this); }
    resume() { this.state = 'running'; return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    createAnalyser() { return { fftSize: 0, smoothingTimeConstant: 0, connect() {}, getByteTimeDomainData(data: Uint8Array) { data.fill(128); } }; }
    createBuffer(_channels: number, length: number, sampleRate: number) {
      return { length, sampleRate, duration: length / sampleRate, data: new Float32Array(length), copyToChannel(source: Float32Array) { this.data.set(source); } };
    }
    createBufferSource() {
      const source: any = { buffer: null, startAt: null, stopped: false, onended: null, connect() {}, start(at: number) { this.startAt = at; }, stop() { this.stopped = true; this.onended?.(); } };
      scheduled.push(source);
      return source;
    }
  };

  const sent: any[] = [];
  const browserOpeningPcm = pcm16(2400, 6000);
  const browserReplyPcm = pcm16(1200, 4500, 660);
  let socket: any = null;
  let appliedAt = 0;
  let openings = 0;
  (w as any).WebSocket = class {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    readyState = 0; binaryType = ''; onopen: any = null; onmessage: any = null; onclose: any = null; onerror: any = null;
    constructor(public url: string, public protocols?: string[]) {
      socket = this;
      setTimeout(() => { this.readyState = 1; this.onopen?.(); this.emit({ type: 'Welcome' }); }, 5);
    }
    emit(message: any) { this.onmessage?.({ data: JSON.stringify(message) }); }
    emitAudio(pcm: Buffer) { const frame = new (w as any).ArrayBuffer(pcm.length); new Uint8Array(frame).set(pcm); this.onmessage?.({ data: frame }); }
    send(payload: any) {
      if (typeof payload !== 'string') return;
      const msg = JSON.parse(payload); sent.push(msg);
      if (msg.type === 'Settings') {
        setTimeout(() => { appliedAt = Date.now(); this.emit({ type: 'SettingsApplied' }); }, 5);
      } else if (msg.type === 'InjectAgentMessage') {
        openings++;
        this.emit({ type: 'AgentStartedSpeaking' });
        this.emit({ type: 'ConversationText', role: 'assistant', content: msg.message });
        this.emitAudio(browserOpeningPcm);
        setTimeout(() => { if (this.readyState === 1) this.emit({ type: 'AgentAudioDone' }); }, 60);
      } else if (msg.type === 'InjectUserMessage') {
        this.emit({ type: 'ConversationText', role: 'user', content: msg.content });
        this.emit({ type: 'AgentThinking' });
        this.emit({ type: 'AgentStartedSpeaking' });
        this.emit({ type: 'ConversationText', role: 'assistant', content: 'Browser mock reply.' });
        this.emitAudio(browserReplyPcm);
        setTimeout(() => { if (this.readyState === 1) this.emit({ type: 'AgentAudioDone' }); }, 60);
      }
    }
    close() { this.readyState = 3; this.onclose?.({ code: 1000, reason: 'mock close' }); }
  };

  w.eval(read('opening.js'));
  w.eval(read('persona.js'));
  w.eval(read('brand-logos.js'));
  w.eval(read('app.js'));
  const d = w.document;
  await until(() => Boolean(d.getElementById('m')?.children.length), 'static console boot');
  const click = (id: string) => d.getElementById(id)!.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const change = (el: Element) => el.dispatchEvent(new w.Event('change', { bubbles: true }));
  try {
    (d.getElementById('sel-a') as HTMLSelectElement).value = agent.id; change(d.getElementById('sel-a')!);
    (d.getElementById('sim-campaign') as HTMLSelectElement).value = campaign.id; change(d.getElementById('sim-campaign')!);
    click('btn-call-nomic');
    await until(() => openings === 1 && scheduled.length === 1, 'browser mock opening scheduled for playback');
    assert.ok(appliedAt > 0 && Date.now() - appliedAt >= 990);
    assert.equal(sent.find((m) => m.type === 'Settings').agent.greeting, undefined);
    assert.equal(sent.filter((m) => m.type === 'InjectAgentMessage')[0].message, agent.greeting);
    const first = scheduled[0];
    assert.equal(first.buffer.sampleRate, 24000);
    assert.equal(first.buffer.length, browserOpeningPcm.length / 2);
    assert.ok(Math.abs(first.buffer.data[0] - browserOpeningPcm.readInt16LE(0) / 32768) < 1e-6);
    assert.ok(first.startAt >= 0.006, 'Playback is scheduled on the AudioContext timeline');
    assert.match(d.getElementById('sim-state-pill')!.textContent || '', /Bot Speaking/);
    assert.match(d.getElementById('persona-stage')!.className, /speaking/);
    await until(() => /Listening for Caller/.test(d.getElementById('sim-state-pill')!.textContent || ''), 'agent returns to listening after opening audio');
    assert.match(d.getElementById('sim-feed')!.textContent || '', new RegExp(agent.greeting.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    click('btn-manual-barge');
    assert.equal(first.stopped, true, 'Manual barge-in stops queued browser playback');
    socket.emitAudio(pcm16(1200, 9000));
    assert.equal(scheduled.length, 1, 'Stale PCM after barge-in is not scheduled');
    (d.getElementById('sim-inject-input') as HTMLInputElement).value = 'A new caller turn';
    click('btn-sim-inject');
    await until(() => scheduled.length === 2, 'new-turn browser playback');
    assert.equal(scheduled[1].buffer.length, browserReplyPcm.length / 2);
    assert.ok(scheduled[1].startAt >= first.startAt, 'New audio stays on the playback timeline');
    assert.match(d.getElementById('sim-state-pill')!.textContent || '', /Bot Speaking/);
    await until(() => /Listening for Caller/.test(d.getElementById('sim-state-pill')!.textContent || ''), 'agent returns to listening after reply audio');
    await wait(1100);
    assert.equal(openings, 1, 'Browser silence does not inject another opening');
    assert.match(d.getElementById('sim-state-pill')!.textContent || '', /Listening for Caller/);
    click('btn-call-hangup');
    await until(() => contexts.every((ctx) => ctx.state === 'closed'), 'browser audio cleanup');
    await until(() => Boolean(d.getElementById('btn-call-nomic')), 'browser session finished');
    await wait(80); // Let the static history loader settle before closing JSDOM.
    assert.deepEqual(errors, []);
    console.log('✓ Static browser mock: PCM16→WebAudio scheduling, agent speaking/listening UI, barge-in flush, new-turn audio and cleanup (no physical speaker)');
  } finally {
    w.close();
  }
}

async function main() {
  assert(process.env.VAC_DATA_DIR, 'Run through the isolated test runner');
  await serverMockSession();
  await browserMockPlayback();
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
