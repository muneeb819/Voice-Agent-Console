import assert from 'assert';
import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { sanitizeSecretValue } from '../src/env-store';
import { getConsoleState, saveConsoleState } from '../src/db';
import { createServerWithSimulator } from '../src/server';

const LIVE_HTTP = process.env.TEST_URL || 'http://127.0.0.1:3000';
const LIVE_WS = LIVE_HTTP.replace(/^http/, 'ws') + '/ws/simulator';

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
  saveConsoleState(state, 'Test setup: select global services');
}

function waitForEvent<T = any>(
  queue: any[],
  waiters: Array<() => boolean>,
  predicate: (msg: any) => boolean,
  timeoutMs = 5000,
  label = 'event'
): Promise<T> {
  return new Promise((resolve, reject) => {
    const checkNow = () => {
      const idx = queue.findIndex(predicate);
      if (idx >= 0) {
        const [found] = queue.splice(idx, 1);
        clearTimeout(timer);
        resolve(found);
        return true;
      }
      return false;
    };

    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${label} (queue has: ${queue.map((x) => x.type || 'bin').join(',')})`));
    }, timeoutMs);

    if (checkNow()) return;
    waiters.push(checkNow);
  });
}

async function run() {
  configureTestServices();
  const results: string[] = [];
  const check = async (name: string, fn: () => Promise<void> | void) => {
    await fn();
    results.push(name);
    console.log(`✓ ${name}`);
  };

  await check('1. Live Server Health reports Step 2 & /ws/simulator endpoint', async () => {
    const res = await fetch(`${LIVE_HTTP}/api/health`);
    assert.strictEqual(res.status, 200);
    const data: any = await res.json();
    assert.strictEqual(data.ok, true);
    assert.ok(data.step >= 2, `Expected step >= 2, got ${data.step}`);
    assert.strictEqual(data.websocket, '/ws/simulator');
  });

  await check('2. Deepgram Voice Agent v1 Protocol E2E (Welcome -> Settings -> Audio -> Barge-In -> Functions -> Latency)', async () => {
    // Spin up a spec-compliant Mock Deepgram Voice Agent server
    const dgHttp = http.createServer();
    const dgWss = new WebSocketServer({ server: dgHttp, path: '/v1/agent/converse' });

    let receivedAuthHeader = '';
    let settingsBeforeWelcome = false;
    let welcomeSent = false;
    let receivedSettings: any = null;
    const receivedBinaryFrames: Buffer[] = [];
    const receivedFnResponses: any[] = [];

    dgWss.on('connection', (ws, req) => {
      receivedAuthHeader = String(req.headers.authorization || '');

      ws.on('message', (raw, isBinary) => {
        if (!welcomeSent) {
          settingsBeforeWelcome = true;
        }
        if (isBinary) {
          receivedBinaryFrames.push(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer));
          return;
        }
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'Settings') {
          receivedSettings = msg;
          setTimeout(() => {
            ws.send(JSON.stringify({ type: 'SettingsApplied' }));
          }, 25);
        } else if (msg.type === 'InjectUserMessage') {
          // Simulate Deepgram full turn lifecycle:
          // 1. UserStartedSpeaking (barge-in)
          ws.send(JSON.stringify({ type: 'UserStartedSpeaking' }));
          // 2. ConversationText (user)
          ws.send(
            JSON.stringify({
              type: 'ConversationText',
              role: 'user',
              content: msg.content,
            })
          );
          // 3. AgentThinking
          setTimeout(() => {
            ws.send(JSON.stringify({ type: 'AgentThinking' }));

            // 4. Test speculative FunctionCallCancelled (must NOT receive FunctionCallResponse)
            ws.send(
              JSON.stringify({
                type: 'FunctionCallCancelled',
                id: 'fc_cancelled_99',
                name: 'transfer_to_live_agent',
              })
            );
            ws.send(
              JSON.stringify({
                type: 'FunctionCallRequest',
                functions: [
                  {
                    id: 'fc_cancelled_99',
                    name: 'transfer_to_live_agent',
                    arguments: '{"reason":"speculative"}',
                    client_side: true,
                  },
                ],
              })
            );

            // 5. Real confirmed FunctionCallRequest: set_disposition + transfer_to_live_agent (with Gemini thought_signature)
            ws.send(
              JSON.stringify({
                type: 'FunctionCallRequest',
                functions: [
                  {
                    id: 'fc_dispo_1',
                    name: 'set_disposition',
                    arguments: JSON.stringify({ code: 'XFER', notes: 'Qualified lead in TX' }),
                    client_side: true,
                  },
                  {
                    id: 'fc_xfer_1',
                    name: 'transfer_to_live_agent',
                    arguments: JSON.stringify({ reason: 'Age 67 in TX, wants quote', confirmed_age: '67' }),
                    client_side: true,
                    thought_signature: 'gemini_sig_abc123',
                  },
                ],
              })
            );
          }, 20);
        } else if (msg.type === 'FunctionCallResponse') {
          receivedFnResponses.push(msg);
          if (msg.id === 'fc_xfer_1') {
            // Emit assistant ConversationText + binary PCM16 TTS audio + end_call + AgentAudioDone
            ws.send(JSON.stringify({ type: 'AgentStartedSpeaking' }));
            ws.send(
              JSON.stringify({
                type: 'ConversationText',
                role: 'assistant',
                content: 'Awesome Amina, connecting you to our licensed specialist right now!',
              })
            );
            const pcmReply = Buffer.alloc(960, 0x12);
            ws.send(pcmReply, { binary: true });

            ws.send(
              JSON.stringify({
                type: 'FunctionCallRequest',
                functions: [
                  {
                    id: 'fc_end_1',
                    name: 'end_call',
                    arguments: '{}',
                    client_side: true,
                  },
                ],
              })
            );
          } else if (msg.id === 'fc_end_1') {
            ws.send(JSON.stringify({ type: 'AgentAudioDone' }));
          }
        }
      });

      // Delay Welcome slightly so we prove backend waits for Welcome before sending Settings
      setTimeout(() => {
        welcomeSent = true;
        ws.send(JSON.stringify({ type: 'Welcome', request_id: 'req_mock_dg_001' }));
      }, 30);
    });

    await new Promise<void>((r) => dgHttp.listen(0, '127.0.0.1', () => r()));
    const dgPort = (dgHttp.address() as any).port;

    const prevKey = process.env.DEEPGRAM_API_KEY;
    const prevUrl = process.env.DEEPGRAM_AGENT_URL;
    process.env.DEEPGRAM_API_KEY = 'dg_test_secret_token_999';
    process.env.DEEPGRAM_AGENT_URL = `ws://127.0.0.1:${dgPort}/v1/agent/converse`;

    const { server: appServer } = createServerWithSimulator();
    await new Promise<void>((r) => appServer.listen(0, '127.0.0.1', () => r()));
    const simPort = (appServer.address() as any).port;

    try {
      const clientEvents: any[] = [];
      const waiters: Array<() => boolean> = [];
      let clientAudioBytes = 0;

      const client = new WebSocket(`ws://127.0.0.1:${simPort}/ws/simulator`);
      client.on('message', (data, isBinary) => {
        if (isBinary) {
          const b = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
          clientAudioBytes += b.length;
          clientEvents.push({ type: '_binary_audio', length: b.length });
        } else {
          clientEvents.push(JSON.parse(data.toString()));
        }
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i]()) waiters.splice(i, 1);
        }
      });

      await new Promise<void>((r, rej) => {
        client.once('open', () => r());
        client.once('error', rej);
      });

      client.send(
        JSON.stringify({
          type: 'start',
          upstreamMode: 'deepgram',
          agentId: 'a1',
          bandwidth: 'telephony',
          lead: {
            lead_id: '99201',
            first_name: 'Amina',
            phone_number: '+12145550199',
            state: 'TX',
            age: '67',
          },
        })
      );

      // Send pre-SettingsApplied binary mic frame to test gating/buffering
      client.send(Buffer.alloc(320, 0x05), { binary: true });

      const startedEvt = await waitForEvent(
        clientEvents,
        waiters,
        (m) => m.type === 'session_started',
        4000,
        'session_started'
      );
      assert.strictEqual(settingsBeforeWelcome, false, 'Backend must wait for Welcome before sending Settings');
      assert.strictEqual(receivedAuthHeader, 'Token dg_test_secret_token_999');
      assert.strictEqual(startedEvt.sampleRateIn, 8000);
      assert.strictEqual(startedEvt.sampleRateOut, 8000);
      assert.ok(
        receivedSettings.agent.think.prompt.includes('Amina') &&
          receivedSettings.agent.think.prompt.includes('99201'),
        'Prompt must include hydrated VICIdial lead fields'
      );

      // Stream post-SettingsApplied mic frame + InjectUserMessage
      client.send(Buffer.alloc(320, 0x07), { binary: true });
      client.send(
        JSON.stringify({
          type: 'inject_user_message',
          content: "Yes, I'm 67 in Texas and I'd like a quote.",
        })
      );

      await waitForEvent(clientEvents, waiters, (m) => m.type === 'barge_in', 4000, 'barge_in');
      const latencyEvt = await waitForEvent(clientEvents, waiters, (m) => m.type === 'latency', 4000, 'latency');
      assert.ok(latencyEvt.ttfbMs >= 1 && latencyEvt.avgTtfbMs >= 1);

      const endedEvt = await waitForEvent(clientEvents, waiters, (m) => m.type === 'call_ended', 4000, 'call_ended');
      assert.strictEqual(endedEvt.reason, 'bot_end_call');
      assert.strictEqual(endedEvt.disposition, 'XFER');
      assert.strictEqual(endedEvt.transferredTo, 'ingroup:FE_CLOSERS');
      assert.strictEqual(clientAudioBytes, 960, 'Expected 960 bytes of binary TTS PCM16 audio');
      assert.strictEqual(receivedBinaryFrames.length, 2, 'Expected both pre- and post-SettingsApplied mic frames');

      // Ensure cancelled speculative function was NOT answered
      assert.ok(
        !receivedFnResponses.some((r) => r.id === 'fc_cancelled_99'),
        'Must NOT send FunctionCallResponse for FunctionCallCancelled id'
      );
      // Ensure thought_signature was echoed back for Gemini compatibility
      const xferResp = receivedFnResponses.find((r) => r.id === 'fc_xfer_1');
      assert.ok(xferResp, 'Expected FunctionCallResponse for transfer_to_live_agent');
      assert.strictEqual(xferResp.thought_signature, 'gemini_sig_abc123');
    } finally {
      process.env.DEEPGRAM_API_KEY = prevKey || '';
      if (prevUrl === undefined) delete process.env.DEEPGRAM_AGENT_URL;
      else process.env.DEEPGRAM_AGENT_URL = prevUrl;
      appServer.close();
      dgHttp.close();
    }
  });

  await check('3. Live Running Server Sandbox Call Flow (Price Deferral -> Transfer -> DNC End Call + SQLite Call Log)', async () => {
    const events: any[] = [];
    const waiters: Array<() => boolean> = [];
    let rxAudio = 0;

    const ws = new WebSocket(LIVE_WS);
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const b = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        rxAudio += b.length;
      } else {
        events.push(JSON.parse(data.toString()));
      }
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i]()) waiters.splice(i, 1);
      }
    });

    await new Promise<void>((r, rej) => {
      ws.once('open', () => r());
      ws.once('error', rej);
    });

    ws.send(
      JSON.stringify({
        type: 'start',
        upstreamMode: 'sandbox',
        agentId: 'a1',
        bandwidth: 'wideband',
        lead: { lead_id: '50012', first_name: 'Carlos', state: 'FL', age: '62' },
      })
    );

    await waitForEvent(events, waiters, (m) => m.type === 'session_started', 4000, 'sandbox session_started');
    await waitForEvent(
      events,
      waiters,
      (m) => m.type === 'transcript' && m.role === 'assistant',
      4000,
      'sandbox greeting transcript'
    );

    // Turn 1: Ask price ("How much does it cost?") -> bot must defer without dollar figure
    ws.send(JSON.stringify({ type: 'inject_user_message', content: 'How much does it cost per month?' }));
    const priceReply = await waitForEvent(
      events,
      waiters,
      (m) => m.type === 'transcript' && m.role === 'assistant' && m.content.includes('licensed specialist'),
      4000,
      'price deferral reply'
    );
    assert.ok(!/\$\d+/.test(priceReply.content), 'Bot must never quote dollar figures');

    // Turn 2: DNC ("Take me off your list") -> sets DNC disposition & triggers end_call auto-hangup
    ws.send(JSON.stringify({ type: 'inject_user_message', content: 'Take me off your list please' }));
    const dncFn = await waitForEvent(
      events,
      waiters,
      (m) => m.type === 'function_call' && m.name === 'set_disposition',
      4000,
      'DNC set_disposition'
    );
    assert.strictEqual(dncFn.args.code, 'DNC');

    const callEnded = await waitForEvent(events, waiters, (m) => m.type === 'call_ended', 5000, 'sandbox call_ended');
    assert.strictEqual(callEnded.disposition, 'DNC');
    assert.ok(rxAudio > 1000, 'Expected binary audio frames during sandbox call');

    // Verify call log persisted in SQLite via GET /api/simulator/logs
    const logsRes = await fetch(`${LIVE_HTTP}/api/simulator/logs?agentId=a1`);
    assert.strictEqual(logsRes.status, 200);
    const logsData: any = await logsRes.json();
    assert.ok(logsData.count >= 1, 'Expected saved call log in SQLite');
    assert.ok(logsData.logs.some((l: any) => l.id === callEnded.callId && l.disposition === 'DNC'));

    // Clean up test logs so user starts with a clean slate
    await fetch(`${LIVE_HTTP}/api/simulator/logs`, { method: 'DELETE' });
  });

  await check('4. Secret Sanitization (Token/Bearer/Quotes) & Real Deepgram Auth Verification on /api/secrets', async () => {
    assert.strictEqual(sanitizeSecretValue('  "Token dg_abc123"  '), 'dg_abc123');
    assert.strictEqual(sanitizeSecretValue("'Bearer dg_xyz987'"), 'dg_xyz987');
    assert.strictEqual(sanitizeSecretValue('dg_raw_key\r\n'), 'dg_raw_key');

    // Verify invalid Deepgram key is caught immediately (not falsely accepted via public /v1/models)
    const badRes = await fetch(`${LIVE_HTTP}/api/secrets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ DEEPGRAM_API_KEY: 'Token definitely_invalid_key_000' }),
    });
    assert.strictEqual(badRes.status, 400);
    const badData: any = await badRes.json();
    assert.strictEqual(badData.ok, false);
    assert.strictEqual(badData.deepgramDiagnostic.restAuth.ok, false);
  });

  await check('5. Speaker+Text / Iframe-Blocked-Mic Comfort-Silence PCM Streamer (Prevents ASR_DRIVER_TIMEOUT)', async () => {
    const dgHttp = http.createServer();
    const dgWss = new WebSocketServer({ server: dgHttp, path: '/v1/agent/converse' });
    const receivedFrames: Buffer[] = [];

    dgWss.on('connection', (ws) => {
      ws.on('message', (raw, isBinary) => {
        if (isBinary) {
          receivedFrames.push(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer));
          return;
        }
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'Settings') {
          // Verify end_call omits empty required: [] array
          const endFn = msg.agent.think.functions.find((f: any) => f.name === 'end_call');
          assert.ok(endFn && !('required' in endFn.parameters), 'end_call must omit empty required array');
          ws.send(JSON.stringify({ type: 'SettingsApplied' }));
        }
      });
      ws.send(JSON.stringify({ type: 'Welcome', request_id: 'req_silence_01' }));
    });

    await new Promise<void>((r) => dgHttp.listen(0, '127.0.0.1', () => r()));
    const dgPort = (dgHttp.address() as any).port;

    const prevKey = process.env.DEEPGRAM_API_KEY;
    const prevUrl = process.env.DEEPGRAM_AGENT_URL;
    process.env.DEEPGRAM_API_KEY = 'dg_test_silence_token';
    process.env.DEEPGRAM_AGENT_URL = `ws://127.0.0.1:${dgPort}/v1/agent/converse`;

    const { server: appServer } = createServerWithSimulator();
    await new Promise<void>((r) => appServer.listen(0, '127.0.0.1', () => r()));
    const simPort = (appServer.address() as any).port;

    try {
      const events: any[] = [];
      const waiters: Array<() => boolean> = [];
      const client = new WebSocket(`ws://127.0.0.1:${simPort}/ws/simulator`);
      client.on('message', (d, isBin) => {
        if (!isBin) events.push(JSON.parse(d.toString()));
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i]()) waiters.splice(i, 1);
        }
      });
      await new Promise<void>((r) => client.once('open', () => r()));
      client.send(JSON.stringify({ type: 'start', upstreamMode: 'deepgram', agentId: 'a1', bandwidth: 'wideband' }));
      await waitForEvent(events, waiters, (m) => m.type === 'session_started', 3000, 'session_started');

      // Send ZERO browser mic frames for 450ms -> comfort-silence pump must inject 50ms PCM16 frames (1600 bytes @ 16kHz)
      await new Promise((r) => setTimeout(r, 450));
      assert.ok(
        receivedFrames.length >= 2 && receivedFrames[0].length === 1600,
        `Expected comfort-silence 1600B PCM frames in no-mic mode, got ${receivedFrames.length}`
      );
      client.send(JSON.stringify({ type: 'stop' }));
      await waitForEvent(events, waiters, (m) => m.type === 'call_ended', 3000, 'call_ended');
    } finally {
      process.env.DEEPGRAM_API_KEY = prevKey || '';
      if (prevUrl === undefined) delete process.env.DEEPGRAM_AGENT_URL;
      else process.env.DEEPGRAM_AGENT_URL = prevUrl;
      appServer.close();
      dgHttp.close();
    }
  });

  await check('6. Upstream HTTP 401 Handshake Rejection Surfaces Detailed Error & Preserves fatalError', async () => {
    const rejectHttp = http.createServer((_req, res) => {
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'dg-error': 'Invalid credentials.',
      });
      res.end(JSON.stringify({ err_code: 'INVALID_AUTH', err_msg: 'Invalid credentials.' }));
    });
    await new Promise<void>((r) => rejectHttp.listen(0, '127.0.0.1', () => r()));
    const rPort = (rejectHttp.address() as any).port;

    const prevKey = process.env.DEEPGRAM_API_KEY;
    const prevUrl = process.env.DEEPGRAM_AGENT_URL;
    process.env.DEEPGRAM_API_KEY = 'dg_bad_key';
    process.env.DEEPGRAM_AGENT_URL = `ws://127.0.0.1:${rPort}/v1/agent/converse`;

    const { server: appServer } = createServerWithSimulator();
    await new Promise<void>((r) => appServer.listen(0, '127.0.0.1', () => r()));
    const simPort = (appServer.address() as any).port;

    try {
      const events: any[] = [];
      const waiters: Array<() => boolean> = [];
      const client = new WebSocket(`ws://127.0.0.1:${simPort}/ws/simulator`);
      client.on('message', (d, isBin) => {
        if (!isBin) events.push(JSON.parse(d.toString()));
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i]()) waiters.splice(i, 1);
        }
      });
      await new Promise<void>((r) => client.once('open', () => r()));
      client.send(JSON.stringify({ type: 'start', upstreamMode: 'deepgram', agentId: 'a1' }));

      const errEvt = await waitForEvent(events, waiters, (m) => m.type === 'error', 3000, 'HTTP 401 error event');
      assert.strictEqual(errEvt.code, 'DEEPGRAM_HTTP_401');
      assert.ok(errEvt.error.includes('INVALID_AUTH'), 'Must surface Deepgram HTTP 401 body');

      const endedEvt = await waitForEvent(events, waiters, (m) => m.type === 'call_ended', 3000, 'HTTP 401 call_ended');
      assert.ok(endedEvt.fatalError && endedEvt.fatalError.includes('DEEPGRAM_HTTP_401'), 'Must preserve fatalError');
    } finally {
      process.env.DEEPGRAM_API_KEY = prevKey || '';
      if (prevUrl === undefined) delete process.env.DEEPGRAM_AGENT_URL;
      else process.env.DEEPGRAM_AGENT_URL = prevUrl;
      appServer.close();
      rejectHttp.close();
    }
  });

  await check('7. REAL Live Deepgram Cloud E2E (/api/deepgram/verify + wss://agent.deepgram.com/v1/agent/converse)', async () => {
    const verifyRes = await fetch(`${LIVE_HTTP}/api/deepgram/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.strictEqual(verifyRes.status, 200);
    const verifyData: any = await verifyRes.json();
    assert.strictEqual(verifyData.ok, true);
    assert.strictEqual(verifyData.diagnostic.restAuth.ok, true);
    assert.strictEqual(verifyData.diagnostic.ttsSpeak.ok, true);
    assert.strictEqual(verifyData.diagnostic.voiceAgentWs.ok, true);

    // Connect a real live call through /ws/simulator -> wss://agent.deepgram.com/v1/agent/converse
    const events: any[] = [];
    const waiters: Array<() => boolean> = [];
    let livePcmBytes = 0;

    const ws = new WebSocket(LIVE_WS);
    ws.on('message', (data, isBin) => {
      if (isBin) {
        const b = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        livePcmBytes += b.length;
        events.push({ type: '_pcm', bytes: b.length });
      } else {
        events.push(JSON.parse(data.toString()));
      }
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i]()) waiters.splice(i, 1);
      }
    });

    await new Promise<void>((r, rej) => {
      ws.once('open', () => r());
      ws.once('error', rej);
    });

    ws.send(
      JSON.stringify({
        type: 'start',
        upstreamMode: 'deepgram',
        agentId: 'a1',
        bandwidth: 'wideband',
        lead: { lead_id: '104892', first_name: 'Robert', state: 'FL', age: '64' },
      })
    );

    await waitForEvent(events, waiters, (m) => m.type === 'dg_welcome', 8000, 'live dg_welcome');
    await waitForEvent(events, waiters, (m) => m.type === 'session_started', 8000, 'live session_started');
    await waitForEvent(
      events,
      waiters,
      (m) => m.type === 'transcript' && m.role === 'assistant',
      10000,
      'live assistant greeting transcript'
    );
    await waitForEvent(events, waiters, () => livePcmBytes > 20000, 10000, 'live >20KB PCM16 greeting audio');

    ws.send(JSON.stringify({ type: 'stop' }));
    await waitForEvent(events, waiters, (m) => m.type === 'call_ended', 5000, 'live call_ended');

    // Clean up test call logs so UI starts clean for user
    await fetch(`${LIVE_HTTP}/api/simulator/logs`, { method: 'DELETE' });
  });

  console.log(`\nALL ${results.length}/${results.length} STEP 2 VERIFICATION CHECKS PASSED!`);
}

run().catch((err) => {
  console.error('STEP 2 TEST FAILED:', err);
  process.exit(1);
});
