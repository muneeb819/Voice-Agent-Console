/**
 * Every bot, end to end over SIP against the real bridge (mock Deepgram + mock VICIdial):
 *  - end_call hangs up (SIP BYE + VICIdial ra_call_control HANGUP), after speech
 *    and via the 9-second fallback when no AgentAudioDone follows
 *  - set_disposition + transfer_to_live_agent performs the VICIdial in-group transfer
 *  - prompt and campaign-rule edits saved through the console API reach the
 *    very next call, and a newer save replaces the older text
 *
 * Loopback only, synthetic credentials and leads.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vac-botfn-'));
process.env.VAC_DATA_DIR = dataDir;
process.env.VAC_ENV_FILE = path.join(dataDir, '.env');
process.env.ADMIN_PASSWORD = '';
process.env.TRUST_PROXY = '';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, label: string, timeout = 8000) {
  const end = Date.now() + timeout;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
    await wait(25);
  }
}

type Step =
  | { raw: Record<string, unknown> }
  | { sleep: number }
  | { user: string }
  | { fn: string; args?: Record<string, unknown> }
  | { audioDone: true };
interface Scenario { steps: Step[]; speakInjected?: boolean }
interface ProviderSession {
  settings: any;
  responses: Array<{ name: string; content: any }>;
  messages: any[];
  closed: boolean;
}

async function main() {
  const { getConsoleState, saveConsoleState } = await import('../src/db');
  const { VicidialBridgeService } = await import('../src/vici-bridge');
  const { buildDeepgramSettings } = await import('../src/settings-builder');
  const { createApp } = await import('../src/server');
  const { createUser, createUserSession } = await import('../src/user-store');
  const { invalidateUserCountCache } = await import('../src/auth-guard');

  // ---------------------------------------------------------------- fixtures
  const viciRequests: Array<Record<string, string>> = [];
  const viciApi = http.createServer((req, res) => {
    const params = Object.fromEntries(new URL(req.url || '/', 'http://x').searchParams.entries());
    viciRequests.push(params);
    if (params.function === 'update_lead' && Object.values(params).some((v) => /SLOWNOTES/.test(String(v)))) {
      setTimeout(() => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('SUCCESS: synthetic slow'); }, 3000);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(params.function === 'lead_all_info'
      ? 'lead_id|phone_number|first_name|last_name|state|date_of_birth|age|status|campaign_id\n104892|3055550192|Robert|Fixture|FL|1955-04-10|71|NEW|FETEST'
      : 'SUCCESS: synthetic');
  });
  await new Promise<void>((r) => viciApi.listen(0, '127.0.0.1', r));

  const state0 = getConsoleState();
  const prov = (k: string, t?: string) => state0.providers.find((p) => p.kind === k && (!t || p.type === t))!;
  state0.services = {
    stt: { providerId: prov('stt').id, model: 'nova-3' },
    llm: { providerId: prov('llm', 'open_ai').id, model: 'gpt-4o-mini' },
    tts: { providerId: prov('tts', 'deepgram').id, model: 'aura-2-thalia-en' },
  };
  state0.vici.viciBaseUrl = `http://127.0.0.1:${(viciApi.address() as net.AddressInfo).port}`;
  saveConsoleState(state0, 'bot function fixture');

  // ------------------------------------------------------------ bot inventory
  const inv = getConsoleState();
  console.log(`Bots configured: ${inv.agents.length}`);
  for (const a of inv.agents) {
    const fns = a.fnIds.map((id) => inv.functions.find((f) => f.id === id)?.name).filter(Boolean);
    const camps = inv.campaigns.filter((c) => c.agentId === a.id).map((c) => `${c.name} (ext ${inv.vici.aiExten}${c.slot})`);
    console.log(`  - ${a.name} [${a.id}] functions: ${fns.join(', ')} | phone campaign: ${camps.join(', ') || 'none (QA/browser only)'}`);
    assert.ok(fns.includes('end_call'), `${a.name} has end_call`);
  }

  // ---------------------------------------------- edits through the real API
  const owner = await createUser({ email: 'owner@botfn.test', fullName: 'Owner Person', password: 'Owner-Passphrase-2026!' });
  const operator = await createUser({ email: 'operator@botfn.test', fullName: 'Operator Person', password: 'Operator-Passphrase-2026!' });
  assert.ok(owner.ok && operator.ok);
    invalidateUserCountCache();
  const operatorCookie = `vac_session=${createUserSession(operator.user!.id)}`;
  const app = createApp();
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const apiBase = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  const putState = async (mutate: (s: any) => void) => {
    const cur = JSON.parse(JSON.stringify(getConsoleState()));
    mutate(cur);
    const r = await fetch(`${apiBase}/api/state`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: operatorCookie }, body: JSON.stringify({ state: cur }),
    });
    const body = await r.json().catch(() => ({}));
    assert.equal(r.status, 200, `operator save accepted: ${JSON.stringify(body).slice(0, 200)}`);
  };
  const tag = crypto.randomBytes(3).toString('hex');
  const promptMark = (v: string, id: string) => `PROMPT-${v}-${id}-${tag}`;
  const ruleMark = (v: string, id: string) => `RULE-${v}-${id}-${tag}`;
  const applyVersion = (v: string) => (s: any) => {
    for (const a of s.agents) a.prompt = `${String(a.prompt).replace(/\nPROMPT-v\d-[^\n]*/g, '')}\n${promptMark(v, a.id)}`;
    for (const c of s.campaigns) c.complianceRules = `${String(c.complianceRules).replace(/\nRULE-v\d-[^\n]*/g, '')}\n${ruleMark(v, c.id)}`;
  };
  await putState(applyVersion('v1'));
  console.log('✓ Operator saved new prompts for all bots and new rules for all campaigns (HTTP 200)');

  // ------------------------------------------------------------ mock Deepgram
  const sessions: ProviderSession[] = [];
  const scenarios: Scenario[] = [];
  const provider = http.createServer();
  const wss = new WebSocketServer({ server: provider, path: '/agent' });
  wss.on('connection', (ws) => {
    const session: ProviderSession = { settings: null, responses: [], messages: [], closed: false };
    sessions.push(session);
    const scenario = scenarios.shift() || { steps: [] };
    let fnSeq = 0;
    const pending = new Map<string, () => void>();
    ws.on('close', () => { session.closed = true; });
    ws.send(JSON.stringify({ type: 'Welcome' }));
    ws.on('message', async (raw, binary) => {
      if (binary) return;
      const msg = JSON.parse(raw.toString());
      session.messages.push(msg);
      if (msg.type === 'InjectAgentMessage' && scenario.speakInjected) {
        ws.send(JSON.stringify({ type: 'AgentStartedSpeaking' }));
        setTimeout(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'AgentAudioDone' })); }, 300);
        return;
      }
      if (msg.type === 'FunctionCallResponse') {
        let content: any = msg.content;
        try { content = JSON.parse(msg.content); } catch {}
        session.responses.push({ name: msg.name, content });
        pending.get(msg.id)?.();
        return;
      }
      if (msg.type !== 'Settings') return;
      session.settings = msg;
      ws.send(JSON.stringify({ type: 'SettingsApplied' }));
      await wait(1600); // let the opening gate release
      for (const step of scenario.steps) {
        if (ws.readyState !== WebSocket.OPEN) return;
        if ('raw' in step) {
          ws.send(JSON.stringify(step.raw));
        } else if ('sleep' in step) {
          await wait(step.sleep);
        } else if ('user' in step) {
          ws.send(JSON.stringify({ type: 'ConversationText', role: 'user', content: step.user }));
          await wait(80);
        } else if ('fn' in step) {
          const id = `fc_${++fnSeq}_${tag}`;
          const done = new Promise<void>((r) => pending.set(id, r));
          ws.send(JSON.stringify({ type: 'FunctionCallRequest', functions: [{ id, name: step.fn, arguments: JSON.stringify(step.args || {}), client_side: true }] }));
          await Promise.race([done, wait(5000)]);
        } else {
          ws.send(JSON.stringify({ type: 'AgentStartedSpeaking' }));
          await wait(50);
          ws.send(JSON.stringify({ type: 'AgentAudioDone' }));
        }
      }
    });
  });
  await new Promise<void>((r) => provider.listen(0, '127.0.0.1', r));
  process.env.DEEPGRAM_AGENT_URL = `ws://127.0.0.1:${(provider.address() as net.AddressInfo).port}/agent`;
  process.env.DEEPGRAM_API_KEY = 'synthetic-bridge-key';
  process.env.BRIDGE_ALLOWED_IPS = '127.0.0.1';

  const bridge = new VicidialBridgeService({ host: '127.0.0.1', audioSocketPort: 0, sipPort: 0 });
  await bridge.start();
  const sipPort = bridge.getStatus().sipPort;

  // ---------------------------------------------------------- SIP call driver
  let leadSeq = 104892;
  async function placeCall(ext: string, scenario: Scenario) {
    scenarios.push(scenario);
    const before = sessions.length;
    const sip = dgram.createSocket('udp4');
    const rtp = dgram.createSocket('udp4');
    await Promise.all([sip, rtp].map((s) => new Promise<void>((r) => s.bind(0, '127.0.0.1', r))));
    const port = (s: dgram.Socket) => (s.address() as net.AddressInfo).port;
    const result = { answered: false, byeAt: 0, startedAt: Date.now(), bridgeRtpPort: 0 };
    sip.on('message', (data, rinfo) => {
      const m = data.toString();
      if (m.startsWith('SIP/2.0 200') && /^CSeq:\s*1 INVITE/im.test(m)) {
        result.answered = true;
        result.bridgeRtpPort = Number(/^m=audio\s+(\d+)/m.exec(m)?.[1] || 0);
      }
      if (m.startsWith('BYE ')) {
        result.byeAt = Date.now();
        const via = /^Via:.*$/im.exec(m)?.[0] || '';
        const hdr = (n: string) => new RegExp(`^${n}:.*$`, 'im').exec(m)?.[0] || '';
        sip.send(Buffer.from(['SIP/2.0 200 OK', via, hdr('From'), hdr('To'), hdr('Call-ID'), hdr('CSeq'), 'Content-Length: 0', '', ''].join('\r\n')), rinfo.port, rinfo.address);
      }
    });
    const callerCode = `V1120${String(leadSeq).padStart(15, '0')}`.slice(0, 20);
    const lead = leadSeq++;
    const sdp = ['v=0', 'o=fixture 1 1 IN IP4 127.0.0.1', 's=Fixture', 'c=IN IP4 127.0.0.1', 't=0 0',
      `m=audio ${port(rtp)} RTP/AVP 0`, 'a=rtpmap:0 PCMU/8000', ''].join('\r\n');
    const invite = [
      `INVITE sip:${ext}@127.0.0.1:${sipPort} SIP/2.0`,
      `Via: SIP/2.0/UDP 127.0.0.1:${port(sip)};branch=z9hG4bK${crypto.randomBytes(4).toString('hex')};rport`,
      `From: "${callerCode}" <sip:3055550192@127.0.0.1>;tag=${crypto.randomBytes(3).toString('hex')}`,
      `To: <sip:${ext}@127.0.0.1>`, `Contact: <sip:fixture@127.0.0.1:${port(sip)}>`,
      `Call-ID: ${crypto.randomUUID()}@botfn`, 'CSeq: 1 INVITE', `X-Vici-Exten: ${ext}`,
      'Content-Type: application/sdp', `Content-Length: ${Buffer.byteLength(sdp)}`, '', sdp,
    ].join('\r\n');
    sip.send(Buffer.from(invite), sipPort, '127.0.0.1');
    await until(() => result.answered, `call to ${ext} answered`);
    await until(() => sessions.length > before && Boolean(sessions[before].settings), 'provider Settings received');
    const session = sessions[before];
    return {
      session, result, callerCode, lead, rtp,
      close: () => { try { sip.close(); } catch {} try { rtp.close(); } catch {} },
    };
  }

  const viciCallsFor = (callerCode: string) => viciRequests.filter((p) => p.value === callerCode || p.function === 'update_lead');
  const phoneBots = inv.campaigns.map((c) => ({ campaign: c, agent: inv.agents.find((a) => a.id === c.agentId)! }));

  // ------------------------------------------------ 1) hang-up for every bot
  for (const { campaign, agent } of phoneBots) {
    const ext = `${inv.vici.aiExten}${campaign.slot}`;
    const call = await placeCall(ext, { steps: [
      { user: "No thanks, I'm not interested. Goodbye." },
      { fn: 'set_disposition', args: { code: 'NI', notes: 'Not interested' } },
      { fn: 'end_call' },
      { audioDone: true },
    ] });
    const prompt = String(call.session.settings?.agent?.think?.prompt || '');
    const fnNames = (call.session.settings?.agent?.think?.functions || []).map((f: any) => f.name);
    assert.ok(fnNames.includes('end_call') && fnNames.includes('transfer_to_live_agent') && fnNames.includes('set_disposition'), `${agent.name}: functions declared to the provider`);
    assert.ok(prompt.includes(promptMark('v1', agent.id)), `${agent.name}: saved prompt reached the call`);
    assert.ok(/CALL ENDING \(MANDATORY/.test(prompt) && /says goodbye, bye/.test(prompt), `${agent.name}: universal call-ending policy is in the live prompt`);
    assert.ok(/SOUND LIKE A REAL PERSON/.test(prompt) && /CALL TIME LIMIT \(70 SECONDS\)/.test(prompt), `${agent.name}: human-speech and 70 s fast-transfer policy in the live prompt`);
    assert.ok(prompt.includes(ruleMark('v1', campaign.id)), `${agent.name}: saved campaign rules reached the call`);
    for (const other of inv.campaigns.filter((c) => c.id !== campaign.id)) {
      assert.ok(!prompt.includes(ruleMark('v1', other.id)), `${agent.name}: no rules leaked from ${other.name}`);
    }
    await until(() => call.result.byeAt > 0, `${agent.name}: SIP BYE after end_call`, 6000);
    const secs = ((call.result.byeAt - call.result.startedAt) / 1000).toFixed(1);
    await until(() => viciRequests.some((p) => p.function === 'ra_call_control' && p.stage === 'HANGUP' && p.value === call.callerCode), `${agent.name}: VICIdial HANGUP`);
    const dispo = viciRequests.find((p) => p.function === 'update_lead' && p.status === 'NI');
    assert.ok(dispo, `${agent.name}: disposition NI written to VICIdial`);
    const endResp = call.session.responses.find((r) => r.name === 'end_call');
    assert.equal(endResp?.content?.ok, true, `${agent.name}: end_call acknowledged`);
    await until(() => call.session.closed, `${agent.name}: provider session closed`);
    console.log(`✓ HANG-UP  ${agent.name} (ext ${ext}): NI disposition saved, bot hung up after speech in ${secs}s, VICIdial HANGUP sent`);
    call.close();
    viciRequests.length = 0;
  }

  // ------------------------- 2) hang-up fallback when no AgentAudioDone follows
  {
    const { campaign, agent } = phoneBots[0];
    const ext = `${inv.vici.aiExten}${campaign.slot}`;
    const call = await placeCall(ext, { steps: [{ user: 'Please hang up.' }, { fn: 'end_call' }] });
    await until(() => call.result.byeAt > 0, `${agent.name}: fallback BYE`, 14000);
    const secs = (call.result.byeAt - call.result.startedAt) / 1000;
    assert.ok(secs >= 9, 'fallback waits for the bot to finish speaking');
    console.log(`✓ HANG-UP fallback ${agent.name}: no "audio done" signal, call still ended after ${secs.toFixed(1)}s`);
    call.close();
    viciRequests.length = 0;
  }

  // ------------------------------------------------- 3) transfer for every bot
  for (const { campaign, agent } of phoneBots) {
    const ext = `${inv.vici.aiExten}${campaign.slot}`;
    const call = await placeCall(ext, { steps: [
      { user: "Yes, I'm interested. I'm 70 and I have Medicare Part A and Part B." },
      { fn: 'set_disposition', args: { code: 'XFER', notes: 'Qualified' } },
      { fn: 'transfer_to_live_agent', args: { reason: 'Qualified and interested' } },
      { audioDone: true },
    ] });
    await until(() => viciRequests.some((p) => p.function === 'ra_call_control' && p.value === call.callerCode && /TRANSFER/.test(p.stage || '')), `${agent.name}: VICIdial transfer`, 10000);
    const xfer = viciRequests.find((p) => p.function === 'ra_call_control' && p.value === call.callerCode && /TRANSFER/.test(p.stage || ''))!;
    const expected = campaign.xferType === 'ingroup' ? 'INGROUPTRANSFER' : 'EXTENSIONTRANSFER';
    assert.equal(xfer.stage, expected);
    if (expected === 'INGROUPTRANSFER') assert.equal(xfer.ingroup_choices, campaign.xferTarget, `${agent.name}: transferred to ${campaign.xferTarget}`);
    const tr = call.session.responses.find((r) => r.name === 'transfer_to_live_agent');
    assert.equal(tr?.content?.ok, true, `${agent.name}: transfer scheduled`);
    await until(() => call.result.byeAt > 0, `${agent.name}: bot leg released after transfer`, 15000);
    assert.ok(!viciRequests.some((p) => p.function === 'ra_call_control' && p.stage === 'HANGUP' && p.value === call.callerCode), `${agent.name}: transferred call is not hung up in VICIdial`);
    console.log(`✓ TRANSFER ${agent.name} (ext ${ext}): XFER saved, ${xfer.stage} to ${xfer.ingroup_choices || xfer.phone_number}, caller NOT hung up`);
    call.close();
    viciRequests.length = 0;
  }

  // ------------------------------------- 4) a newer save replaces older text
  await putState(applyVersion('v2'));
  {
    const { campaign, agent } = phoneBots[0];
    const call = await placeCall(`${inv.vici.aiExten}${campaign.slot}`, { steps: [{ fn: 'end_call' }, { audioDone: true }] });
    const prompt = String(call.session.settings?.agent?.think?.prompt || '');
    assert.ok(prompt.includes(promptMark('v2', agent.id)) && prompt.includes(ruleMark('v2', campaign.id)), 'v2 edits reach the next call');
    assert.ok(!prompt.includes(promptMark('v1', agent.id)) && !prompt.includes(ruleMark('v1', campaign.id)), 'v1 text is gone');
    await until(() => call.result.byeAt > 0, 'v2 call hung up');
    console.log(`✓ EDIT AGAIN ${agent.name}: the next call used the newest prompt and rules; the old text was gone`);
    call.close();
  }

  // ------------------------------------------ 5) hard call-length limit
  {
    const { campaign, agent } = phoneBots[phoneBots.length - 1];
    await putState((st) => { st.campaigns.find((c: any) => c.id === campaign.id).maxCallSec = 30; });
    const call = await placeCall(`${inv.vici.aiExten}${campaign.slot}`, { steps: [{ user: 'Haha, tell me a joke and keep talking.' }], speakInjected: true });
    const prompt = String(call.session.settings?.agent?.think?.prompt || '');
    assert.match(prompt, /CALL TIME LIMIT \(30 SECONDS\) & FAST TRANSFER/, 'time-limit and fast-transfer policy is in the prompt');
    await until(() => call.result.byeAt > 0, `${agent.name}: call ended by the time limit`, 40000);
    const secs = (call.result.byeAt - call.result.startedAt) / 1000;
    const wrap = call.session.messages.find((m) => m.type === 'UpdatePrompt');
    const closing = call.session.messages.find((m) => m.type === 'InjectAgentMessage' && /have to let you go/.test(m.message || ''));
    assert.ok(wrap && /TIME CHECK/.test(wrap.prompt), 'wrap-up instruction sent before the limit');
    assert.ok(closing, 'closing line spoken before hanging up');
    assert.ok(secs >= 23 && secs <= 31, `call ended inside the window (${secs.toFixed(1)}s)`);
    await until(() => viciRequests.some((p) => p.function === 'ra_call_control' && p.stage === 'HANGUP' && p.value === call.callerCode), 'VICIdial HANGUP after time limit');
    console.log(`✓ TIME LIMIT ${agent.name}: 30 s limit -> wrap-up instruction at 18 s, closing line at 24 s, hung up at ${secs.toFixed(1)}s`);
    call.close();
    viciRequests.length = 0;
    // Codex P2: a transfer requested just before the limit, while the VICIdial
    // notes update is still in flight, must not be hung up by the limit.
    {
      const late = await placeCall(`${inv.vici.aiExten}${campaign.slot}`, { steps: [
        { user: "Yes, I'm interested, connect me." },
        { sleep: 26500 },
        { fn: 'set_disposition', args: { code: 'XFER', notes: 'Qualified' } },
        { fn: 'transfer_to_live_agent', args: { reason: 'SLOWNOTES qualified late' } },
        { audioDone: true },
      ] });
      await until(() => viciRequests.some((p) => p.function === 'ra_call_control' && p.value === late.callerCode && /TRANSFER/.test(p.stage || '')), 'late transfer still executed', 45000);
      assert.ok(!viciRequests.some((p) => p.function === 'ra_call_control' && p.stage === 'HANGUP' && p.value === late.callerCode), 'time limit did not hang up the transfer');
      console.log(`✓ TIME LIMIT ${agent.name}: transfer requested 1.5 s before the limit (slow VICIdial) still went through, not cut off`);
      late.close();
      viciRequests.length = 0;
    }
    // Bot SAYS it is connecting the caller but never calls transfer_to_live_agent,
    // close to the limit (the screenshot case: hung up at the limit mid-handoff).
    // The bridge must protect the call and complete the transfer itself.
    {
      const announced = await placeCall(`${inv.vici.aiExten}${campaign.slot}`, { steps: [
        { user: "Yes, I'm 70 and I have Medicare Part A and Part B. My name is Mary Jones, ZIP 94601, please connect me." },
        { sleep: 21000 },
        { raw: { type: 'ConversationText', role: 'assistant', content: 'You meet all the requirements! Please hold the line for just a brief moment while I connect you with our licensed specialist.' } },
        { audioDone: true },
      ] });
      await until(() => viciRequests.some((p) => p.function === 'ra_call_control' && p.value === announced.callerCode && /TRANSFER/.test(p.stage || '')), 'announced transfer completed by the bridge', 45000);
      assert.ok(!viciRequests.some((p) => p.function === 'ra_call_control' && p.stage === 'HANGUP' && p.value === announced.callerCode), 'time limit did not hang up the announced transfer');
      assert.ok(!announced.session.messages.some((m) => m.type === 'InjectAgentMessage' && /have to let you go/.test(m.message || '')), 'no closing line spoken over the handoff');
      console.log(`✓ TIME LIMIT ${agent.name}: bot announced "I'm connecting you" without calling the transfer → bridge completed the transfer, no hang-up at the limit`);
      announced.close();
      viciRequests.length = 0;
    }
    await putState((st) => { st.campaigns.find((c: any) => c.id === campaign.id).maxCallSec = 70; });
  }

  // ------------------------------- 6) barge-in sensitivity (%) on phone calls
  {
    const { buildRtpPacket, linear16ToUlaw } = await import('../src/g711');
    const { campaign, agent } = phoneBots[0];
    const states: string[] = [];
    const origBroadcast = (bridge as any).broadcastMonitor.bind(bridge);
    (bridge as any).broadcastMonitor = (m: any) => { if (m?.type === 'call_state' && m.call?.state) states.push(`${m.call.callId}:${m.call.state}`); return origBroadcast(m); };
    const tone = (amp: number) => {
      const b = Buffer.alloc(320);
      for (let i = 0; i < 160; i += 1) b.writeInt16LE(Math.round(Math.sin(i / 3) * amp * 32767), i * 2);
      return linear16ToUlaw(b);
    };
    const tryBarge = async (pct: number, amp: number) => {
      await putState((st) => { st.agents.find((a: any) => a.id === agent.id).behavior.bargeInSensitivityPct = pct; });
      states.length = 0;
      const call = await placeCall(`${inv.vici.aiExten}${campaign.slot}`, { steps: [
        { raw: { type: 'AgentStartedSpeaking' } },
        { sleep: 200 },
        { raw: { type: 'UserStartedSpeaking' } },
        { sleep: 900 },
        { fn: 'end_call' }, { audioDone: true },
      ] });
      // Stream caller audio for ~3 s at the given level.
      for (let i = 0; i < 150 && !call.result.byeAt; i += 1) {
        call.rtp.send(buildRtpPacket({ payloadType: 0, sequenceNumber: i + 1, timestamp: 160 * (i + 1), ssrc: 4242, marker: i === 0, payload: tone(amp) }), call.result.bridgeRtpPort, '127.0.0.1');
        await wait(20);
      }
      await until(() => call.result.byeAt > 0, 'barge-in test call ended', 8000);
      const interrupted = states.some((x) => x.endsWith(':caller_speaking'));
      call.close();
      return interrupted;
    };
    assert.equal(await tryBarge(10, 0.02), false, '10%: quiet background does not interrupt the bot');
    assert.equal(await tryBarge(10, 0.15), true, '10%: clear caller speech still interrupts');
    assert.equal(await tryBarge(100, 0.02), true, '100%: even quiet sound interrupts');
    (bridge as any).broadcastMonitor = origBroadcast;
    await putState((st) => { st.agents.find((a: any) => a.id === agent.id).behavior.bargeInSensitivityPct = 50; });
    viciRequests.length = 0;
    console.log(`✓ BARGE-IN ${agent.name}: 10% ignores quiet background but stops for clear speech; 100% stops for any sound (live SIP/RTP)`);
  }

  // ------------------------------------ 6) Sentinel QA bot (browser/QA only)
  {
    const s = getConsoleState();
    const qa = s.agents.find((a) => a.id === 'a_qa');
    if (qa) {
      const camp = s.campaigns.find((c) => c.agentIds.includes(qa.id))!;
      const settings: any = buildDeepgramSettings(s, qa, camp);
      const p = String(settings.agent.think.prompt);
      assert.ok(p.includes(promptMark('v2', qa.id)) && p.includes(ruleMark('v2', camp.id)));
      assert.ok(settings.agent.think.functions.some((f: any) => f.name === 'end_call'));
      assert.ok(!/CALL TIME LIMIT/.test(p), 'QA reviewer bot is not time-boxed');
      console.log(`✓ ${qa.name}: Live Bot session gets the newest prompt + rules and its end_call function`);
    }
  }

  await bridge.stop();
  wss.close(); provider.close(); viciApi.close();
  await new Promise<void>((r) => server.close(() => r()));
  console.log('ALL BOT FUNCTION CHECKS PASSED');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
