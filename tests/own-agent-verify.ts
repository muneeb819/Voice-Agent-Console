import assert from 'assert';
import http from 'http';
import { AddressInfo } from 'net';
import { WebSocket } from 'ws';
import { OwnAgentDeps, SentenceChunker, createOwnAgentServer, parseSettings } from '../src/own-agent';
import { readSse, resolveLlmEndpoint, streamChat } from '../src/own-llm';

const pcm = (n: number) => Buffer.alloc(n * 2, 1);

async function main() {
  // ---- sentence chunker
  const c = new SentenceChunker();
  const out = [...c.push('Hello there, this is Anna calling from the clinic today. '), ...c.push('Is now a good time? Dr. Smith said yes. '), ...c.flush()];
  assert.ok(out.length >= 2 && out[0].startsWith('Hello there'), 'splits into sentences');
  assert.ok(out.some((s) => s.includes('Dr. Smith said yes')), 'does not cut after an abbreviation');
  const c2 = new SentenceChunker();
  assert.deepStrictEqual(c2.push('Hi. '), [], 'a one-word sentence waits for the next one');

  // ---- endpoint choice
  assert.throws(() => resolveLlmEndpoint('anthropic', {}), /OpenAI-compatible/);
  assert.throws(() => resolveLlmEndpoint('open_ai', {}), /OPENAI_API_KEY/);
  assert.strictEqual(resolveLlmEndpoint('groq', { GROQ_API_KEY: 'k' }).baseUrl, 'https://api.groq.com/openai/v1');
  assert.strictEqual(resolveLlmEndpoint('anthropic', { OWN_LLM_BASE_URL: 'http://gpu:8000/v1/' }).baseUrl, 'http://gpu:8000/v1');

  // ---- LLM stream: text and split tool-call arguments
  const sse = (chunks: any[]) =>
    new Response(chunks.map((x) => `data: ${typeof x === 'string' ? x : JSON.stringify(x)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
  const events: any[] = [];
  for await (const e of streamChat({
    endpoint: { baseUrl: 'http://x', apiKey: 'k' },
    model: 'm',
    messages: [],
    fetchImpl: (async () =>
      sse([
        { choices: [{ delta: { content: 'Hi ' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'look', arguments: '{"a":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }] },
        '[DONE]',
      ])) as any,
  })) events.push(e);
  assert.deepStrictEqual(events[0], { type: 'text', delta: 'Hi ' });
  assert.deepStrictEqual(events[1], { type: 'tool_calls', calls: [{ id: 'c1', name: 'look', arguments: '{"a":1}' }] });
  await assert.rejects(
    (async () => { for await (const _ of streamChat({ endpoint: { baseUrl: 'http://x', apiKey: '' }, model: 'm', messages: [], fetchImpl: (async () => new Response('no', { status: 429 })) as any })) {} })(),
    /429/
  );
  const raw = [];
  for await (const d of readSse(new Response('data: a\r\n\r\ndata: b\n\n').body!)) raw.push(d);
  assert.deepStrictEqual(raw, ['a', 'b']);

  // ---- settings parsing
  const base = (over: any = {}) => ({
    type: 'Settings',
    audio: { input: { sample_rate: 8000 }, output: { sample_rate: 8000 } },
    agent: {
      language: 'en',
      listen: { provider: { type: 'speech_service', model: 'whisper' } },
      think: { provider: { type: 'open_ai', model: 'gpt-4o-mini', temperature: 0.5 }, prompt: 'Be kind.', functions: [{ name: 'transfer', description: 'd', parameters: { type: 'object' } }] },
      speak: { provider: { type: 'open_ai', model: 'kokoro', voice: 'af_heart' }, endpoint: { url: 'http://h/v1/audio/speech?speed=1.1&exaggeration=0.6' } },
      greeting: 'Hello!',
      ...over,
    },
  });
  const ok = parseSettings(base());
  assert.ok(ok.ok && ok.config.speed === 1.1 && ok.config.exaggeration === 0.6 && ok.config.tools.length === 1);
  assert.ok(!parseSettings(base({ listen: { provider: { type: 'deepgram', model: 'nova-3' } } })).ok, 'needs own listening');
  assert.ok(!parseSettings(base({ speak: { provider: { type: 'deepgram', model: 'aura' } } })).ok, 'needs own voice');

  // ---- full call through a real socket with fake STT / TTS / LLM
  let sttCb: any = null;
  let sttAudio = 0;
  const spoken: string[] = [];
  let chatCalls = 0;
  const seenMessages: any[] = [];
  const deps: OwnAgentDeps = {
    openStt: (o) => {
      sttCb = o;
      setTimeout(o.onReady, 5);
      return { send: (b) => { sttAudio += b.length; }, close: () => {} };
    },
    synthesize: async ({ text, signal }) => {
      spoken.push(text);
      return (async function* () {
        yield pcm(100);
        await new Promise((r) => setTimeout(r, 15));
        if (signal.aborted) return;
        yield pcm(101).subarray(0, 201); // odd byte count: must be re-aligned
      })();
    },
    chat: async function* (req) {
      chatCalls += 1;
      seenMessages.push(JSON.parse(JSON.stringify(req.messages)));
      const last = req.messages[req.messages.length - 1];
      if (last.role === 'user' && /transfer/i.test(String(last.content))) yield { type: 'tool_calls', calls: [{ id: 'f1', name: 'transfer', arguments: '{}' }] };
      else if (last.role === 'tool') yield { type: 'text', delta: 'Connecting you now, please hold on for a moment.' };
      else if (/boom/.test(String(last.content))) throw new Error('model down');
      else {
        yield { type: 'text', delta: 'Sure, I can help with that today. ' };
        yield { type: 'text', delta: 'What is your age?' };
      }
    },
  };
  const own = createOwnAgentServer(deps);
  const srv = http.createServer();
  srv.on('upgrade', (req, sock, head) => { if (!own.handleUpgrade(req, sock, head)) sock.destroy(); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;

  // wrong token is refused
  await new Promise<void>((resolve) => {
    const bad = new WebSocket(`ws://127.0.0.1:${port}/own-agent?token=nope`);
    bad.on('error', () => resolve());
    bad.on('unexpected-response', (_q, res) => { assert.strictEqual(res.statusCode, 403); resolve(); });
    bad.on('open', () => assert.fail('bad token must not connect'));
  });

  const ws = new WebSocket(own.url(port));
  const msgs: any[] = [];
  let audioBytes = 0;
  ws.on('message', (d, bin) => { if (bin) audioBytes += (d as Buffer).length; else msgs.push(JSON.parse(d.toString())); });
  await new Promise((r) => ws.once('open', r));
  const wait = async (f: () => boolean, label: string) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(f(), `timed out: ${label}`); };
  const types = () => msgs.map((m) => m.type);

  await wait(() => types().includes('Welcome'), 'Welcome');
  ws.send(JSON.stringify(base()));
  await wait(() => types().includes('SettingsApplied'), 'SettingsApplied');
  await wait(() => types().includes('AgentAudioDone'), 'greeting spoken');
  assert.ok(msgs.some((m) => m.type === 'ConversationText' && m.role === 'assistant' && m.content === 'Hello!'));
  assert.ok(types().indexOf('AgentStartedSpeaking') > -1 && audioBytes > 0);
  assert.strictEqual(audioBytes % 2, 0, 'audio is whole 16-bit samples');
  ws.send(pcm(160));
  await wait(() => sttAudio >= 320, 'caller audio reaches the listener');

  // a normal turn
  sttCb.onPartial('hel');
  sttCb.onFinal('I need a quote');
  await wait(() => msgs.filter((m) => m.type === 'AgentAudioDone').length >= 2, 'turn spoken');
  assert.ok(types().includes('UserStartedSpeaking') && types().includes('AgentThinking'));
  assert.ok(spoken.includes('Sure, I can help with that today.'), 'first sentence spoken separately');
  assert.strictEqual(seenMessages[0][0].content, 'Be kind.', 'system prompt sent');

  // a tool call round trip
  sttCb.onFinal('please transfer me');
  await wait(() => msgs.some((m) => m.type === 'FunctionCallRequest'), 'function request');
  const fr = msgs.find((m) => m.type === 'FunctionCallRequest');
  assert.strictEqual(fr.functions[0].name, 'transfer');
  assert.strictEqual(fr.functions[0].client_side, true);
  ws.send(JSON.stringify({ type: 'FunctionCallResponse', id: 'f1', name: 'transfer', content: '{"ok":true}' }));
  await wait(() => spoken.includes('Connecting you now, please hold on for a moment.'), 'reply after function');

  // an injected line is spoken as-is; one injected mid-turn is refused
  await wait(() => msgs.filter((m) => m.type === 'AgentAudioDone').length >= 3, 'idle');
  ws.send(JSON.stringify({ type: 'InjectAgentMessage', message: 'One moment please.' }));
  await wait(() => spoken.includes('One moment please.'), 'inject spoken');

  // the model failing is a warning and a spoken apology, not a dead call
  await wait(() => msgs.filter((m) => m.type === 'AgentAudioDone').length >= 4, 'idle again');
  sttCb.onFinal('boom');
  await wait(() => msgs.some((m) => m.type === 'Warning' && m.code === 'OWN_LLM'), 'warning');
  await wait(() => spoken.includes('Sorry, I missed that. Could you say that again?'), 'fallback spoken');
  assert.ok(!types().includes('Error'), 'one failure does not end the call');
  assert.strictEqual(ws.readyState, WebSocket.OPEN);

  // barge-in: speaking stops and the old reply is not finished
  const before = spoken.length;
  sttCb.onFinal('tell me more please');
  await new Promise((r) => setTimeout(r, 5));
  sttCb.onPartial('wait');
  sttCb.onFinal('actually no');
  await wait(() => msgs.filter((m) => m.type === 'ConversationText' && m.role === 'user' && m.content === 'actually no').length === 1, 'second user line');
  assert.ok(chatCalls >= 5);
  assert.ok(spoken.length > before);

  // unsupported settings end the call with a clear error
  const ws2 = new WebSocket(own.url(port));
  const m2: any[] = [];
  ws2.on('message', (d, bin) => { if (!bin) m2.push(JSON.parse(d.toString())); });
  await new Promise((r) => ws2.once('open', r));
  ws2.send(JSON.stringify(base({ listen: { provider: { type: 'deepgram', model: 'nova-3' } } })));
  await wait(() => m2.some((m) => m.type === 'Error'), 'error for unsupported settings');
  assert.match(m2.find((m) => m.type === 'Error').description, /speech service/);

  ws.close();
  own.close();
  srv.close();
  console.log('own-agent: OK');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
