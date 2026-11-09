import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { createDefaultState, normalizeState } from '../src/defaults';
import { getConsoleState, saveConsoleState } from '../src/db';
import { loadBundledGreetings } from '../src/greetings';
import { composeOpening, createOpeningGate, migrateStockMedicarePrompt, migrateStockOpening, OPENING_DELAY_MS, prepareDelayedOpening } from '../src/opening';
import { createServerWithSimulator } from '../src/server';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, label: string, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (predicate()) return; await wait(10); }
  throw new Error(`Timed out waiting for ${label}`);
}

async function main() {
  const rows = loadBundledGreetings();
  const sample = "Hello! it Jessi here from Medicare Benefits. how's everything going so far?";
  const variations = rows.map((row) => composeOpening(sample, row.greeting_text, false, ''));
  for (let i = 0; i < rows.length; i++) {
    assert.equal((variations[i].match(/\?/g) || []).length, 1, `row ${rows[i].greeting_id}: exactly one question`);
    assert.match(variations[i], /it Jessi here from Medicare Benefits\./);
    assert.ok(!variations[i].includes(rows[i].greeting_text), 'Never append a full second imported greeting');
    assert.ok(variations[i].length < 145, 'The screenshot example stays concise');
  }
  assert.ok(new Set(variations).size >= 50, 'The 1,100 rows yield varied short openings');
  assert.match(variations[1], /How are you doing today\?$/, 'A suitable question from the selected row is reused');
  assert.equal(composeOpening(sample, '', false, ''), sample, 'A missing library or opt-out preserves the saved opening');
  const selected = composeOpening(sample, rows[2].greeting_text, false, '');
  const notice = 'This call may be recorded for quality and benefit verification.';
  assert.equal(composeOpening(sample, rows[2].greeting_text, true, notice), `${notice} ${selected}`);
  assert.equal(composeOpening(`${notice} ${sample}`, '', true, notice), `${notice} ${sample}`, 'A notice already in the opening is not duplicated');
  const qualification = 'Hi, this is Sarah from Example. Do you have a quick minute?';
  assert.match(composeOpening(qualification, rows[0].greeting_text, false, ''), /Do you have a quick minute\?$/);
  const custom = 'My carefully written introduction. Please note this required statement. How are you?';
  assert.ok(composeOpening(custom, rows[1].greeting_text, false, '').includes('Please note this required statement.'));
  console.log('✓ All 1,100 rows produce a single concise screenshot-style opening; identity, questions and optional notices are preserved');

  const oldNova = "Hey there! This is Nova on the line — how are you doing today? Feel free to ask me anything at all, I'm right here to help!";
  const oldMed = 'Hi, this is Haley calling from the Benefits Department. Your new food and OTC card is on hold right now, loaded with funds for groceries and dental. If unclaimed today, it gets returned to the state pool. To release your card immediately, do you have Medicare Part A and B?';
  const legacy = createDefaultState();
  const stockMed = legacy.agents.find((a) => a.id === 'a_medicare')!;
  const correctedPrompt = stockMed.prompt;
  assert.ok(correctedPrompt.includes('NEVER ask the caller their age'), 'Current stock Medicare policy must not ask age after confirmation');
  assert.ok(correctedPrompt.includes('Would you like me to connect you now?'), 'Current stock Medicare policy offers a consent handoff');
  const customizedPrompt = `${correctedPrompt}\nAn operator customization.`;
  stockMed.prompt = customizedPrompt;
  legacy.agents.find((a) => a.id === 'a_nova')!.greeting = oldNova;
  stockMed.greeting = oldMed;
  legacy.agents[0].greeting = custom;
  legacy.agents[0].injectCampaignDisclosure = true;
  const normalized = normalizeState(legacy);
  assert.equal(normalized.agents.find((a) => a.id === 'a_nova')!.greeting, migrateStockOpening(oldNova));
  assert.equal(normalized.agents.find((a) => a.id === 'a_medicare')!.greeting, migrateStockOpening(oldMed));
  assert.equal(normalized.agents.find((a) => a.id === 'a_medicare')!.prompt, customizedPrompt, 'Customized Medicare prompts are preserved');
  assert.equal(migrateStockMedicarePrompt(customizedPrompt, correctedPrompt), customizedPrompt, 'Customized prompts are not migrated');
  assert.equal(migrateStockMedicarePrompt(customizedPrompt, ''), customizedPrompt, 'Never guess when the stock reference is unavailable');
  assert.equal(normalized.agents[0].greeting, custom, 'Custom saved openings are never silently truncated');
  assert.equal(normalized.agents[0].injectCampaignDisclosure, true, 'Existing notice choice is preserved');
  assert.ok(createDefaultState().agents.every((a) => a.injectCampaignDisclosure === false));
  const missing: any = structuredClone(legacy);
  delete missing.agents[0].injectCampaignDisclosure;
  assert.equal(normalizeState(missing).agents[0].injectCampaignDisclosure, false);
  console.log('✓ Exact stock openings migrate; current Medicare consent/no-age policy and customized scripts/explicit notices remain intact');

  const display = { type: 'Settings', agent: { greeting: selected, think: { prompt: 'Be helpful.' } } };
  const prepared = prepareDelayedOpening(display);
  assert.equal(display.agent.greeting, selected, 'Preparing a wire payload must not mutate the display preview');
  assert.equal(prepared.settings.agent.greeting, undefined);
  assert.equal(prepared.greeting, selected);
  assert.ok(prepared.settings.agent.think.prompt.includes(selected));
  assert.match(prepared.settings.agent.think.prompt, /requests to stop/i);
  assert.throws(() => prepareDelayedOpening({ agent: { greeting: selected, think: { prompt: 'x'.repeat(25000) } } }), /too long/i);
  assert.equal(OPENING_DELAY_MS, 1000);
  console.log('✓ Provider settings omit automatic greeting, preserve preview, and guard the prompt limit');

  const sent: Array<{ text: string; at: number }> = [];
  const played: Array<{ text: string; at: number }> = [];
  const callbacks: string[] = [];
  const start = Date.now();
  const silentGate = createOpeningGate({
    greeting: selected,
    sendOpening: (text) => sent.push({ text, at: Date.now() }),
    playAudio: (buf) => played.push({ text: buf.toString(), at: Date.now() }),
  });
  silentGate.start();
  silentGate.start();
  silentGate.audio(Buffer.from('stale early audio'));
  silentGate.afterRelease(() => callbacks.push('released'));
  await wait(250);
  assert.equal(sent.length, 0); assert.equal(played.length, 0); assert.deepEqual(callbacks, []);
  await until(() => sent.length === 1, 'one-second configured opening');
  assert.ok(sent[0].at - start >= 990, 'The opening waits a full second');
  assert.equal(sent[0].text, selected);
  assert.equal(played.length, 0, 'Unsolicited early audio cannot replace the configured opening');
  assert.deepEqual(callbacks, ['released']);
  silentGate.audio(Buffer.from('provider speech'));
  assert.equal(played.at(-1)?.text, 'provider speech', 'Provider PCM flows after release');
  await wait(1200);
  assert.equal(sent.length, 1, 'Silence does not retry or replace the opening');
  silentGate.cancel();
  console.log('✓ Silent caller: one-second listen, one configured opening, continued streaming and no silence-triggered hangup');

  const early: string[] = [];
  const earlyStart = Date.now();
  const userGate = createOpeningGate({
    greeting: selected,
    sendOpening: () => early.push('unexpected opening'),
    playAudio: (buf) => early.push(`audio:${buf}`),
  });
  userGate.start();
  userGate.audio(Buffer.from('interrupted'));
  userGate.userStarted();
  userGate.userTurn();
  userGate.audio(Buffer.from('reply'));
  userGate.afterRelease(() => early.push('done'));
  await wait(250); assert.deepEqual(early, []);
  await until(() => early.includes('done'), 'early caller reply');
  assert.ok(Date.now() - earlyStart >= 990);
  assert.deepEqual(early, ['audio:reply', 'done'], 'Do not inject an opening or play stale audio after an early caller turn');
  userGate.cancel();

  let cancelledSent = 0, cancelledCallbacks = 0;
  const cancelled = createOpeningGate({ greeting: selected, sendOpening: () => cancelledSent++, playAudio: () => cancelledCallbacks++ });
  cancelled.start(); cancelled.audio(Buffer.from('x')); cancelled.afterRelease(() => cancelledCallbacks++); cancelled.cancel();
  await wait(1100); assert.equal(cancelledSent, 0); assert.equal(cancelledCallbacks, 0);
  console.log('✓ Early caller gets one response; stale audio is cleared and hangup cancels timers');

  let noiseSent = 0, overflow = 0;
  const noise = createOpeningGate({ greeting: selected, sendOpening: () => noiseSent++, playAudio: () => {}, onOverflow: () => overflow++ });
  noise.start(); noise.userStarted(); noise.audio(Buffer.alloc(300000)); noise.audio(Buffer.alloc(300000));
  await wait(1100); assert.equal(noiseSent, 0); assert.equal(overflow, 1);
  await until(() => noiseSent === 1, 'bounded unfinished-onset opening fallback', 3000);
  await wait(50); assert.equal(noiseSent, 1); noise.cancel();
  console.log('✓ An unfinished VAD onset gets a bounded opening fallback; early audio memory stays capped');

  // Real local simulator WebSockets, with a synthetic caller who speaks before
  // the one-second deadline and an end_call immediately after the mock reply.
  const state = getConsoleState();
  const sttProvider = state.providers.find((provider) => provider.kind === 'stt')!;
  const llmProvider = state.providers.find((provider) => provider.kind === 'llm' && provider.type === 'open_ai')!;
  const ttsProvider = state.providers.find((provider) => provider.kind === 'tts' && provider.type === 'deepgram')!;
  state.services = {
    stt: { providerId: sttProvider.id, model: 'nova-3' },
    llm: { providerId: llmProvider.id, model: 'gpt-4o-mini' },
    tts: { providerId: ttsProvider.id, model: 'aura-2-thalia-en' },
  };
  const campaign = state.campaigns.find((entry) => entry.agentId === state.agents[0].id) || state.campaigns[0];
  assert.ok(campaign, 'Opening fixture requires an explicit campaign');
  campaign.agentId = state.agents[0].id;
  campaign.complianceRules = 'Reviewed test campaign rules: be truthful, do not claim unverified benefits, and honor do-not-call requests immediately.';
  state.agents[0].greeting = 'Hi, this is Jessi from Example Services. How are you doing?';
  state.agents[0].injectCampaignDisclosure = false;
  saveConsoleState(state, 'Early caller timing fixture');
  const upstream = http.createServer();
  const wss = new WebSocketServer({ server: upstream, path: '/agent' });
  let appliedAt = 0, callerAudio = 0, unexpectedOpenings = 0, wire: any;
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'Welcome' }));
    ws.on('message', (raw, binary) => {
      if (binary) { if (Buffer.from(raw as Buffer).some((b) => b !== 0)) callerAudio++; return; }
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'Settings') {
        wire = msg; appliedAt = Date.now(); ws.send(JSON.stringify({ type: 'SettingsApplied' }));
        setTimeout(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          ws.send(JSON.stringify({ type: 'UserStartedSpeaking' }));
          ws.send(JSON.stringify({ type: 'ConversationText', role: 'user', content: 'Hello' }));
          ws.send(JSON.stringify({ type: 'AgentThinking' }));
          ws.send(JSON.stringify({ type: 'AgentStartedSpeaking' }));
          ws.send(JSON.stringify({ type: 'ConversationText', role: 'assistant', content: 'Hello, this is Jessi from Example Services. How are you?' }));
          ws.send(Buffer.alloc(640, 3), { binary: true });
          ws.send(JSON.stringify({ type: 'FunctionCallRequest', functions: [{ id: 'early-end', name: 'end_call', arguments: '{}', client_side: true }] }));
        }, 70);
      } else if (msg.type === 'InjectAgentMessage') unexpectedOpenings++;
      else if (msg.type === 'FunctionCallResponse' && msg.id === 'early-end') ws.send(JSON.stringify({ type: 'AgentAudioDone' }));
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
  let audioAt = 0;
  client.on('message', (data, binary) => {
    if (binary) { audioAt = Date.now(); events.push({ type: 'audio' }); }
    else events.push(JSON.parse(data.toString()));
  });
  try {
    await new Promise<void>((r, reject) => { client.once('open', () => r()); client.once('error', reject); });
    client.send(JSON.stringify({ type: 'start', agentId: state.agents[0].id, campaignId: campaign.id, upstreamMode: 'deepgram' }));
    await until(() => events.some((e) => e.type === 'session_started'), 'session_started');
    client.send(Buffer.alloc(320, 7), { binary: true });
    await until(() => events.some((e) => e.type === 'call_ended'), 'early end_call');
    assert.equal(wire.agent.greeting, undefined);
    assert.ok(wire.agent.think.prompt.includes('Jessi from Example Services'));
    assert.ok(callerAudio > 0, 'Caller audio continues flowing during the wait');
    assert.ok(audioAt - appliedAt >= 990, `Early response leaked after ${audioAt - appliedAt} ms`);
    assert.equal(unexpectedOpenings, 0, 'Never inject another greeting over the first caller turn');
    assert.ok(events.findIndex((e) => e.type === 'audio') < events.findIndex((e) => e.type === 'call_ended'),
      'The early reply reaches the client before end_call finalizes the session');
    assert.equal(events.filter((e) => e.type === 'transcript' && e.role === 'assistant').length, 1);
    console.log('✓ Mock Live Bot early hello: audio flows in, one reply waits 1 second, no double greeting, end_call drains');
  } finally {
    client.terminate(); wss.clients.forEach((ws) => ws.terminate()); wss.close(); upstream.close();
    await new Promise<void>((r) => server.close(() => r()));
    if (oldUrl === undefined) delete process.env.DEEPGRAM_AGENT_URL; else process.env.DEEPGRAM_AGENT_URL = oldUrl;
    if (oldKey === undefined) delete process.env.DEEPGRAM_API_KEY; else process.env.DEEPGRAM_API_KEY = oldKey;
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
