// Call start, greeting lines, speaking style and voice settings: all set per bot
// on the front end, saved with the bot, and used on the next call.
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { createDefaultState, normalizeState } from '../src/defaults';
import { getConsoleState, getDb, saveConsoleState, selectGreetingLine } from '../src/db';
import { createOpeningGate, greetingLineList, localizeGreeting, OPENING_DELAY_MS, wordCount } from '../src/opening';
import { composeBehavioralPrompt, FLOW_DEFAULTS, TONE_MAP } from '../src/persona';
import { buildDeepgramSettings, validateAgent } from '../src/settings-builder';
import { createServerWithSimulator } from '../src/server';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, label: string, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (predicate()) return; await wait(10); }
  throw new Error(`Timed out waiting for ${label}`);
}

function gate(opts: Record<string, unknown>) {
  const sent: Array<{ text: string; at: number }> = [];
  const played: number[] = [];
  const start = Date.now();
  const g = createOpeningGate({
    greeting: 'Hi there! How are you doing today?',
    sendOpening: (text) => sent.push({ text, at: Date.now() - start }),
    playAudio: () => played.push(Date.now() - start),
    ...opts,
  } as any);
  return { g, sent, played, start };
}

async function gateChecks() {
  // 1. Caller says hello during the wait: the bot replies at once, no "are you there?".
  {
    const t = gate({ waitForCaller: true, waitForCallerMs: 3000, noAnswerText: 'Hello? Are you there?', noAnswerRepeats: 2 });
    t.g.start();
    t.g.audio(Buffer.alloc(320));
    await wait(300);
    assert.equal(t.played.length, 0, 'nothing plays before the caller speaks');
    t.g.userTurn();
    assert.equal(t.played.length, 1, 'the reply plays as soon as the caller has spoken');
    await wait(3300);
    assert.equal(t.sent.length, 0, 'no "are you there?" once the caller has spoken');
    t.g.cancel();
  }
  // 2. Silence: "are you there?" after the wait, repeated the set number of times, then quiet.
  {
    const t = gate({ waitForCaller: true, waitForCallerMs: 1000, noAnswerText: 'Hello? Are you there?', noAnswerRepeats: 2 });
    t.g.start();
    await wait(3400);
    assert.deepEqual(t.sent.map((s) => s.text), ['Hello? Are you there?', 'Hello? Are you there?']);
    assert.ok(t.sent[0].at >= 990 && t.sent[1].at >= 1990, `timing ${t.sent.map((s) => s.at)}`);
    t.g.cancel();
  }
  // 3. Repeats set to 0: the greeting itself after the wait.
  {
    const t = gate({ waitForCaller: true, waitForCallerMs: 1500, noAnswerText: 'Hello? Are you there?', noAnswerRepeats: 0 });
    t.g.start();
    await wait(1700);
    assert.deepEqual(t.sent.map((s) => s.text), ['Hi there! How are you doing today?']);
    assert.ok(t.sent[0].at >= 1490);
    t.g.cancel();
  }
  // 4. Sound but no words yet (a hello still being transcribed): no "are you there?".
  {
    const t = gate({ waitForCaller: true, waitForCallerMs: 1000, noAnswerText: 'Hello? Are you there?', noAnswerRepeats: 2 });
    t.g.start();
    await wait(200);
    t.g.userStarted();
    await wait(1200);
    assert.equal(t.sent.length, 0, 'a caller who started talking is not asked if they are there');
    t.g.userTurn();
    t.g.cancel();
  }
  // 5. Wait-for-hello off: the old speak-after-one-second opening.
  {
    const t = gate({ waitForCaller: false });
    t.g.start();
    await wait(OPENING_DELAY_MS + 150);
    assert.deepEqual(t.sent.map((s) => s.text), ['Hi there! How are you doing today?']);
    t.g.cancel();
  }
  // 6. Hang-up during the wait cancels every timer.
  {
    const t = gate({ waitForCaller: true, waitForCallerMs: 1000, noAnswerText: 'Hello?', noAnswerRepeats: 3 });
    t.g.start();
    t.g.cancel();
    await wait(1300);
    assert.equal(t.sent.length, 0);
  }
  console.log('✓ Call start: waits for the caller, asks "are you there?" the set number of times, replies at once to a hello, never interrupts a caller who started talking');
}

function greetingChecks() {
  for (const line of greetingLineList(FLOW_DEFAULTS.greetingLines, 20)) {
    assert.ok(wordCount(line) <= 12 && line.endsWith('?'), `default greeting "${line}" is short and ends in a question`);
  }
  assert.ok(greetingLineList(FLOW_DEFAULTS.greetingLines, 20).length >= 15);
  const list = 'One two three?\n\n  Hello there, how are you?  \n' + 'word '.repeat(25).trim() + '?\nHi!';
  assert.deepEqual(greetingLineList(list, 20), ['One two three?', 'Hello there, how are you?', 'Hi!'], 'blank and over-long lines are skipped');
  const noon = new Date('2026-06-15T19:00:00Z'); // 15:00 New York, 20:00 London, 00:30 Karachi next day
  assert.equal(localizeGreeting('Good {timeOfDay}! How are you?', 'America/New_York', noon), 'Good afternoon! How are you?');
  assert.equal(localizeGreeting('Good morning! How are you?', 'Europe/London', noon), 'Good evening! How are you?');
  assert.equal(localizeGreeting("Hi, how's your {timeOfDay}?", 'Asia/Karachi', noon), "Hi, how's your morning?");
  assert.equal(localizeGreeting('Good {timeOfDay}!', 'Not/AZone', noon).startsWith('Good '), true);

  // Shuffle bag in the database: every line once before any repeats, never twice in a row.
  const lines = ['A?', 'B?', 'C?', 'D?', 'E?'];
  getDb().prepare('DELETE FROM greeting_line_used WHERE agent_id = ?').run('qa-bot');
  const picks: string[] = [];
  for (let i = 0; i < 25; i++) picks.push(selectGreetingLine('qa-bot', lines.join('\n'), 20)!);
  for (let cycle = 0; cycle < 5; cycle++) assert.deepEqual([...picks.slice(cycle * 5, cycle * 5 + 5)].sort(), lines, `cycle ${cycle + 1} uses every line once`);
  for (let i = 1; i < picks.length; i++) assert.notEqual(picks[i], picks[i - 1], 'never the same greeting twice in a row');
  assert.equal(selectGreetingLine('qa-bot', '', 20), null);
  assert.equal(selectGreetingLine('qa-bot', 'word '.repeat(30), 20), null, 'only over-long lines: none usable');
  console.log('✓ Greeting lines: short defaults, over-long lines skipped, time of day for the caller, every line used once before repeats, never twice in a row');
}

function promptChecks() {
  const st = normalizeState(createDefaultState());
  const a = st.agents.find((x) => x.id === 'a_medicare')!;
  const c = st.campaigns.find((x) => x.agentIds.includes(a.id))!;
  assert.equal(a.flow!.waitForHello, true);
  assert.equal(a.behavior.speakingStyle, FLOW_DEFAULTS.speakingStyle);
  const p = composeBehavioralPrompt(a, c);
  assert.ok(!/SOUND LIKE A REAL PERSON|NATURAL VOCAL GESTURES/.test(p), 'no stacked hard-coded tone rules');
  // Voice delivery comes only from the bot's saved setting (on by default), never from code.
  assert.ok(p.includes(a.flow!.voiceDelivery), 'voice delivery is the saved per-bot text');
  assert.ok(!/VOICE DELIVERY/.test(composeBehavioralPrompt({ ...a, flow: { ...a.flow!, voiceDeliveryEnabled: false } }, c)), 'voice delivery off: no section');
  assert.equal(p.split('Personality: warm').length - 1, 1, 'tone is defined once');
  assert.ok(p.includes('TRANSFERS:'));
  assert.ok(p.includes(`After the caller answers your greeting, introduce yourself`) && p.includes(a.greeting.slice(0, 30)), 'saved opening becomes the introduction');
  const jessica = { ...a, flow: { ...a.flow!, introLine: "My name is Jessica, I'm calling from the Medicare Marketplace. I believe you have Medicare Part A and B?", transferOnYes: true, repeatLine: 'Pardon? Could you repeat that for me?' }, behavior: { ...a.behavior, speakingStyle: 'Personality: sweet and caring.' } };
  const jp = composeBehavioralPrompt(jessica, c);
  assert.ok(jp.includes('Medicare Marketplace') && /says yes to that question.*transfer_to_live_agent right away/.test(jp));
  assert.ok(jp.includes('"Pardon? Could you repeat that for me?"'));
  assert.ok(jp.includes('Personality: sweet and caring.') && !jp.includes('VOCAL EXPRESSION STYLE'));
  const empty = composeBehavioralPrompt({ ...a, behavior: { ...a.behavior, speakingStyle: '' } }, c);
  assert.ok(empty.includes(TONE_MAP[a.behavior.expressionStyle]), 'empty style falls back to the tone menu');
  const noIntro = composeBehavioralPrompt({ ...a, flow: { ...a.flow!, greetingLines: '', introLine: '' } }, c);
  assert.ok(!noIntro.includes('introduce yourself in one or two'), 'no introduction rule without lines or an introduction');
  console.log('✓ Prompt: tone defined once from the bot\'s own style, introduction / transfer-on-yes / pardon lines from the bot\'s settings, no stacked rules');
}

function settingsChecks() {
  const st = normalizeState(createDefaultState());
  const a = st.agents.find((x) => x.id === 'a_medicare')!;
  const c = st.campaigns.find((x) => x.agentIds.includes(a.id))!;
  const tts = st.providers.find((p) => p.kind === 'tts' && p.type === 'deepgram')!;
  st.services.tts = { providerId: tts.id, model: 'flux-haley-en' };
  a.tts.speed = 1.1; a.tts.expr = 1;
  const s1 = buildDeepgramSettings(st, a, c, { openingLine: 'Good {timeOfDay}! How are you?' });
  assert.equal(s1.agent.speak.provider.speed, 1.1);
  assert.equal(s1.agent.speak.provider.expressivity, 1);
  assert.match(s1.agent.greeting, /^Good (morning|afternoon|evening)! How are you\?$/, 'the greeting is the picked line alone');
  a.tts.speed = 1; a.tts.expr = 0;
  const s2 = buildDeepgramSettings(st, a, c, {});
  assert.deepEqual(Object.keys(s2.agent.speak.provider).sort(), ['model', 'type', 'version'], 'defaults send nothing extra');
  st.services.tts = { providerId: tts.id, model: 'aura-2-thalia-en' };
  a.tts.speed = 1.2; a.tts.expr = 2;
  const s3 = buildDeepgramSettings(st, a, c, {});
  assert.equal(s3.agent.speak.provider.speed, undefined, 'Aura voices get no Flux-only fields');

  // Self-hosted voice through Deepgram's OpenAI-compatible speak provider.
  const local = st.providers.find((p) => p.kind === 'tts' && p.type === 'speech_service')!;
  assert.ok(local, 'a self-hosted voice provider exists');
  st.services.tts = { providerId: local.id, model: 'clone:' + 'a'.repeat(32) };
  a.tts.speed = 1.05; a.tts.expressiveness = 0.7; a.tts.variation = 0.9;
  local.endpoint = 'https://54-79-152-235.sslip.io:8900/';
  const s4 = buildDeepgramSettings(st, a, c, {});
  assert.deepEqual(s4.agent.speak.provider, { type: 'open_ai', model: 'chatterbox', voice: 'clone:' + 'a'.repeat(32) });
  assert.equal(s4.agent.speak.endpoint.url, 'https://54-79-152-235.sslip.io:8900/v1/audio/speech?speed=1.05&exaggeration=0.7&temperature=0.9');
  assert.equal(s4.agent.speak.endpoint.headers.Authorization, 'Bearer {{SPEECH_SERVICE_API_KEY}}');
  local.endpoint = 'http://127.0.0.1:8000';
  const s5 = buildDeepgramSettings(st, a, c, {});
  assert.equal(s5.agent.speak.endpoint.url, '', 'a private or plain-http address is never handed to Deepgram');
  const items = validateAgent(st, a).map((i: any) => JSON.stringify(i));
  assert.ok(items.some((i) => /Self-hosted voice on calls/.test(i) && /"level":"wn"/.test(i)), 'validation warns about the missing public HTTPS address');
  st.services.tts = { providerId: local.id, model: 'af_heart' };
  local.endpoint = 'https://voice.example.com';
  assert.equal(buildDeepgramSettings(st, a, c, {}).agent.speak.provider.model, 'kokoro');
  console.log('✓ Voice: Flux speed and expressivity sent on calls, self-hosted Chatterbox reached over HTTPS with the bot\'s expressiveness and variation, never a private address');
}

async function simulatorCheck() {
  const state = getConsoleState();
  const stt = state.providers.find((p) => p.kind === 'stt' && p.type === 'deepgram')!;
  const llm = state.providers.find((p) => p.kind === 'llm' && p.type === 'open_ai')!;
  const tts = state.providers.find((p) => p.kind === 'tts' && p.type === 'deepgram')!;
  state.services = { stt: { providerId: stt.id, model: 'nova-3' }, llm: { providerId: llm.id, model: 'gpt-4o-mini' }, tts: { providerId: tts.id, model: 'aura-2-thalia-en' } };
  const agent = state.agents[0];
  const campaign = state.campaigns.find((c) => c.agentIds.includes(agent.id)) || state.campaigns[0];
  campaign.agentId = agent.id;
  campaign.agentIds = [...new Set([agent.id, ...(campaign.agentIds || [])])];
  campaign.complianceRules = 'Reviewed test campaign rules: be truthful, do not claim unverified benefits, and honor do-not-call requests immediately.';
  agent.randomGreetingEnabled = true;
  agent.injectCampaignDisclosure = false;
  agent.flow = { ...agent.flow!, waitForHello: true, waitForHelloSec: 1.5, noAnswerRepeats: 1, noAnswerLine: 'Hello? Can you hear me?', greetingLines: 'Hi there! How are you doing today?' };
  saveConsoleState(state, 'Call start fixture');

  const upstream = http.createServer();
  const wss = new WebSocketServer({ server: upstream, path: '/agent' });
  let appliedAt = 0, wire: any = null;
  const injected: Array<{ text: string; at: number }> = [];
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'Welcome' }));
    ws.on('message', (raw, binary) => {
      if (binary) return;
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'Settings') { wire = msg; appliedAt = Date.now(); ws.send(JSON.stringify({ type: 'SettingsApplied' })); }
      if (msg.type === 'InjectAgentMessage') injected.push({ text: msg.message, at: Date.now() - appliedAt });
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const oldUrl = process.env.DEEPGRAM_AGENT_URL, oldKey = process.env.DEEPGRAM_API_KEY;
  process.env.DEEPGRAM_AGENT_URL = `ws://127.0.0.1:${(upstream.address() as any).port}/agent`;
  process.env.DEEPGRAM_API_KEY = 'synthetic';
  const { server } = createServerWithSimulator();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const client = new WebSocket(`ws://127.0.0.1:${(server.address() as any).port}/ws/simulator`);
  const events: any[] = [];
  client.on('message', (data, binary) => { if (!binary) events.push(JSON.parse(data.toString())); });
  try {
    await new Promise<void>((r, reject) => { client.once('open', () => r()); client.once('error', reject); });
    client.send(JSON.stringify({ type: 'start', agentId: agent.id, campaignId: campaign.id, upstreamMode: 'deepgram' }));
    await until(() => events.some((e) => e.type === 'session_started'), 'session_started');
    await until(() => injected.length >= 1, '"are you there?" after the wait');
    await wait(2000);
    assert.equal(injected.length, 1, 'asked once, as set');
    assert.equal(injected[0].text, 'Hello? Can you hear me?');
    assert.ok(injected[0].at >= 1450, `asked after the 1.5 s wait (${injected[0].at} ms)`);
    assert.equal(wire.agent.greeting, undefined, 'Deepgram never speaks first on its own');
    assert.match(wire.agent.think.prompt, /\[Call opening\] Wait for the caller to speak first/);
    assert.ok(wire.agent.think.prompt.includes('"Hi there! How are you doing today?"'), 'the picked greeting line is the first reply');
    console.log('✓ Live Bot: Deepgram waits for the caller, asks "Hello? Can you hear me?" once after 1.5 s, and greets with the picked short line');
  } finally {
    client.terminate(); wss.clients.forEach((ws) => ws.terminate()); wss.close(); upstream.close();
    await new Promise<void>((r) => server.close(() => r()));
    if (oldUrl === undefined) delete process.env.DEEPGRAM_AGENT_URL; else process.env.DEEPGRAM_AGENT_URL = oldUrl;
    if (oldKey === undefined) delete process.env.DEEPGRAM_API_KEY; else process.env.DEEPGRAM_API_KEY = oldKey;
  }
}

async function main() {
  await gateChecks();
  greetingChecks();
  promptChecks();
  settingsChecks();
  await simulatorCheck();
  console.log('\nCall start verification passed.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
