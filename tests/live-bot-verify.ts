import assert from 'assert';
import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { getConsoleState, getDb, saveConsoleState, saveSimulatorCallLog } from '../src/db';
import { createServerWithSimulator } from '../src/server';
import { executeCustomFunctionWebhook } from '../src/webhook-executor';
import { runSimulatedViciBridgeCall } from '../src/vici-loopback-tester';

function waitFor(queue: any[], predicate: (entry: any) => boolean, description: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 4000;
    const check = () => {
      const match = queue.find(predicate);
      if (match) return resolve(match);
      if (Date.now() >= deadline) return reject(new Error(`Timed out: ${description}`));
      setTimeout(check, 10);
    };
    check();
  });
}

async function main() {
  const original = getConsoleState();
  const state = structuredClone(original);
  state.services = {
    stt: { providerId: 's1', model: 'nova-3' },
    llm: { providerId: 'l1', model: 'gpt-4o-mini' },
    tts: { providerId: 't1', model: 'aura-2-thalia-en' },
  };
  saveConsoleState(state, 'Local mock Live Bot test');

  const webhookRequests: Array<{ path: string; body: any }> = [];
  const upstreamResponses: any[] = [];
  const upstreamSettings: any[] = [];
  const mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk.toString(); });
    req.on('end', () => {
      webhookRequests.push({ path: req.url || '', body: JSON.parse(body || '{}') });
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: '/redirect-target' });
        res.end();
        return;
      }
      res.writeHead(req.url?.startsWith('/failure') ? 503 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(req.url?.startsWith('/failure') ? { ok: false, error: 'test failure' } : { ok: true, receipt: 'local-only' }));
    });
  });
  const upstream = new WebSocketServer({ server: mock, path: '/agent' });
  upstream.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'Welcome', request_id: 'mock-request' }));
    ws.on('message', (raw, binary) => {
      if (binary) return;
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'Settings') {
        upstreamSettings.push(msg);
        ws.send(JSON.stringify({ type: 'SettingsApplied' }));
      } else if (msg.type === 'InjectUserMessage') {
        if (msg.content === 'provider-error') {
          ws.send(JSON.stringify({ type: 'Error', code: 'TEST_PROVIDER_ERROR', description: 'mock failure' }));
          return;
        }
        if (msg.content === 'cancel-end') {
          ws.send(JSON.stringify({ type: 'FunctionCallRequest', functions: [
            { id: 'end-cancel', name: 'end_call', arguments: '{}', client_side: true },
          ] }));
          return;
        }
        if (msg.content === 'after-cancel') {
          ws.send(JSON.stringify({ type: 'ConversationText', role: 'assistant', content: 'Session is still open.' }));
          return;
        }
        const suffix = msg.content;
        ws.send(JSON.stringify({ type: 'FunctionCallCancelled', id: `cancelled-${suffix}`, name: 'test_webhook' }));
        ws.send(JSON.stringify({ type: 'FunctionCallRequest', functions: [
          { id: `cancelled-${suffix}`, name: 'test_webhook', arguments: '{}', client_side: true },
          { id: `webhook-${suffix}`, name: 'test_webhook', arguments: '{"note":"hello"}', client_side: true, thought_signature: 'sig-123' },
          { id: `missing-${suffix}`, name: 'missing_url', arguments: '{}', client_side: true },
          { id: `unknown-${suffix}`, name: 'not_enabled', arguments: '{}', client_side: true },
          { id: `xfer-${suffix}`, name: 'transfer_to_live_agent', arguments: '{"reason":"test"}', client_side: true },
          { id: `dispo-${suffix}`, name: 'set_disposition', arguments: '{"code":"DNC"}', client_side: true },
          { id: `provider-${suffix}`, name: 'provider_tool', arguments: '{}', client_side: false },
        ] }));
      } else if (msg.type === 'FunctionCallResponse') {
        upstreamResponses.push(msg);
        if (msg.id === 'end-cancel') {
          ws.send(JSON.stringify({ type: 'FunctionCallCancelled', id: 'end-cancel', name: 'end_call' }));
          ws.send(JSON.stringify({ type: 'AgentAudioDone' }));
        }
      }
    });
  });
  await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', () => resolve()));
  const port = (mock.address() as any).port;
  const previousUrl = process.env.DEEPGRAM_AGENT_URL;
  const previousKey = process.env.DEEPGRAM_API_KEY;
  process.env.DEEPGRAM_AGENT_URL = `ws://127.0.0.1:${port}/agent`;
  process.env.DEEPGRAM_API_KEY = 'synthetic-test-key';

  const { server } = createServerWithSimulator();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const simPort = (server.address() as any).port;

  const draft = structuredClone(state);
  draft.functions.push({ id: 'fn_custom_test', name: 'test_webhook', description: 'Local test webhook',
    params: '{"type":"object","properties":{}}', defer: false,
    url: `http://127.0.0.1:${port}/webhook?lead={{lead.lead_id}}`, method: 'post', headers: '{}' });
  draft.functions.push({ id: 'fn_missing_test', name: 'missing_url', description: 'Missing test webhook',
    params: '{"type":"object","properties":{}}', defer: false, url: '', method: 'post', headers: '{}' });
  draft.agents.find((a) => a.id === 'a1')!.fnIds.push('fn_custom_test', 'fn_missing_test');

  async function openSession(allowWebhooks: boolean) {
    const events: any[] = [];
    const client = new WebSocket(`ws://127.0.0.1:${simPort}/ws/simulator`);
    client.on('message', (raw, binary) => { if (!binary) events.push(JSON.parse(raw.toString())); });
    await new Promise<void>((resolve, reject) => { client.once('open', () => resolve()); client.once('error', reject); });
    client.send(JSON.stringify({ type: 'start', agentId: 'a1', upstreamMode: 'deepgram', allowWebhooks,
      lead: { lead_id: 'test-472', first_name: 'Example', phone_number: '+15550000123', state: 'TX', age: '70' },
      draftState: draft }));
    await waitFor(events, (e) => e.type === 'session_started', 'provider-confirmed session');
    return { client, events };
  }

  async function exercise(allowWebhooks: boolean, suffix: string, fail = false) {
    draft.functions.find((f) => f.id === 'fn_custom_test')!.url =
      `http://127.0.0.1:${port}/${fail ? 'failure' : 'webhook'}?lead={{lead.lead_id}}`;
    const { client, events } = await openSession(allowWebhooks);
    client.send(JSON.stringify({ type: 'inject_user_message', content: suffix }));
    for (const prefix of ['webhook', 'missing', 'unknown', 'xfer', 'dispo']) {
      await waitFor(events, (e) => e.type === 'function_call' && e.id === `${prefix}-${suffix}`, `${prefix} result`);
      await waitFor(upstreamResponses, (e) => e.id === `${prefix}-${suffix}`, `${prefix} provider response`);
    }
    const response = (prefix: string) => JSON.parse(upstreamResponses.find((e) => e.id === `${prefix}-${suffix}`).content);
    assert.strictEqual(response('webhook').ok, allowWebhooks && !fail);
    assert.strictEqual(response('missing').ok, false);
    assert.strictEqual(response('unknown').ok, false);
    assert.strictEqual(response('xfer').ok, false);
    assert.strictEqual(response('xfer').simulated, true);
    assert.strictEqual(response('dispo').ok, false);
    assert.strictEqual(response('dispo').simulated, true);
    assert.strictEqual(upstreamResponses.find((e) => e.id === `webhook-${suffix}`).thought_signature, 'sig-123');
    assert.ok(!upstreamResponses.some((e) => e.id === `cancelled-${suffix}` || e.id === `provider-${suffix}`));
    assert.ok(events.some((e) => e.id === `provider-${suffix}` && e.status === 'server_side'));
    assert.ok(events.some((e) => e.id === `xfer-${suffix}` && e.status === 'simulated'));
    assert.strictEqual(events.find((e) => e.id === `webhook-${suffix}`).status, allowWebhooks && !fail ? 'completed' : 'failed');
    client.send(JSON.stringify({ type: 'stop' }));
    const ended = await waitFor(events, (e) => e.type === 'call_ended', 'test end');
    assert.strictEqual(ended.disposition, null);
    assert.strictEqual(ended.transferredTo, null);
    assert.strictEqual(ended.logSaved, true);
    return { client, events };
  }

  try {
    await exercise(false, 'blocked');
    assert.strictEqual(webhookRequests.length, 0, 'No webhook is sent without explicit consent');
    await exercise(true, 'allowed');
    assert.strictEqual(webhookRequests.length, 1);
    assert.strictEqual(webhookRequests[0].path, '/webhook?lead=test-472');
    assert.strictEqual(webhookRequests[0].body.note, 'hello');
    assert.strictEqual(webhookRequests[0].body._call_context.lead_id, 'test-472');
    assert.strictEqual(webhookRequests[0].body._call_context.phone, '+15550000123');
    await exercise(true, 'failed', true);
    assert.strictEqual(webhookRequests.length, 2);
    const redirectFn = { ...draft.functions.find((f) => f.id === 'fn_custom_test')!, url: `http://127.0.0.1:${port}/redirect`, headers: '{"X-Test-Secret":"synthetic"}' };
    const redirected = await executeCustomFunctionWebhook(redirectFn, {}, {});
    assert.strictEqual(redirected.ok, false);
    assert.strictEqual(redirected.httpStatus, 302);
    assert.match(redirected.error || '', /redirects are not followed/i);
    assert.strictEqual(webhookRequests.filter((request) => request.path === '/redirect-target').length, 0, 'A redirect must not forward credentials or bypass destination checks');
    for (const settings of upstreamSettings) {
      assert.ok(settings.agent.think.functions.every((f: any) => !f.endpoint && f.defer_until_eot === true));
      assert.match(settings.agent.think.prompt, /not a live VICIdial call/i);
    }
    console.log('✓ Webhook opt-in, test lead context, HTTP failures, cancellation, and non-PBX results');

    const missing = await executeCustomFunctionWebhook(undefined, {});
    assert.strictEqual(missing.ok, false);
    assert.strictEqual(missing.executedWebhook, false);
    console.log('✓ Unconfigured functions never report success');

    const cancelled = await openSession(false);
    cancelled.client.send(JSON.stringify({ type: 'inject_user_message', content: 'cancel-end' }));
    await waitFor(cancelled.events, (e) => e.type === 'function_call' && e.id === 'end-cancel' && e.status === 'cancelled', 'cancelled end');
    cancelled.client.send(JSON.stringify({ type: 'inject_user_message', content: 'after-cancel' }));
    await waitFor(cancelled.events, (e) => e.type === 'transcript' && e.content === 'Session is still open.', 'session after cancelled hangup');
    assert.ok(!cancelled.events.some((e) => e.type === 'call_ended'));
    cancelled.client.send(JSON.stringify({ type: 'stop' }));
    await waitFor(cancelled.events, (e) => e.type === 'call_ended', 'cancelled test end');
    console.log('✓ Cancelled end_call does not hang up the browser test');

    const errored = await openSession(false);
    errored.client.send(JSON.stringify({ type: 'inject_user_message', content: 'provider-error' }));
    await waitFor(errored.events, (e) => e.type === 'error' && e.code === 'TEST_PROVIDER_ERROR', 'provider error');
    const failed = await waitFor(errored.events, (e) => e.type === 'call_ended', 'provider error end');
    assert.match(failed.fatalError, /mock failure/);
    console.log('✓ Provider errors terminate the session and remain visible');

    getDb().exec("CREATE TRIGGER test_save_failure BEFORE INSERT ON simulator_calls BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
    try {
      const unsaved = await openSession(false);
      unsaved.client.send(JSON.stringify({ type: 'stop' }));
      const ended = await waitFor(unsaved.events, (e) => e.type === 'call_ended', 'failed history write');
      assert.strictEqual(ended.logSaved, false);
      assert.ok(unsaved.events.some((e) => e.type === 'warning' && /transcript could not be saved/i.test(e.message)));
    } finally {
      getDb().exec('DROP TRIGGER test_save_failure');
    }
    console.log('✓ Failed transcript persistence is reported rather than acknowledged as saved');

    for (const [id, mode, latency] of [
      ['historical-scripted', 'sandbox', 1],
      ['real-test-one', 'deepgram', 120],
      ['real-test-two', 'deepgram', 300],
    ] as const) {
      saveSimulatorCallLog({ id, agentId: 'a1', agentName: 'Test', campaignId: null, upstreamMode: mode,
        sampleRateIn: 16000, sampleRateOut: 24000, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
        durationMs: 100, turns: 1, avgTtfbMs: latency, disposition: null, transferredTo: null, transcript: [], functionCalls: [] });
    }
    const telemetry = await (await fetch(`http://127.0.0.1:${simPort}/api/telemetry/overview`)).json() as any;
    assert.strictEqual(telemetry.telemetry.traffic.avgTtfbMs, 210, 'Historic scripted latency must be excluded');
    console.log('✓ Dashboard latency excludes old scripted demo values');

    const oldKey = process.env.DEEPGRAM_API_KEY;
    const oldProviderUrl = process.env.DEEPGRAM_AGENT_URL;
    const bridgeOverrides: unknown[] = [];
    process.env.DEEPGRAM_API_KEY = '';
    try {
      await assert.rejects(
        runSimulatedViciBridgeCall({ setViciApiBaseOverride: (url: unknown) => bridgeOverrides.push(url) } as any,
          { transport: 'sip_rtp', scenario: 'qualified_xfer', upstream: 'deepgram' }),
        /DEEPGRAM_API_KEY required/
      );
      assert.deepEqual(bridgeOverrides, [], 'Failed caller synthesis must not change shared bridge routing');
      assert.strictEqual(process.env.DEEPGRAM_AGENT_URL, oldProviderUrl);
    } finally {
      if (oldKey === undefined) delete process.env.DEEPGRAM_API_KEY;
      else process.env.DEEPGRAM_API_KEY = oldKey;
    }
    console.log('✓ Failed bridge caller synthesis leaves shared routing untouched');
  } finally {
    saveConsoleState(original, 'Restore local mock test state');
    if (previousUrl === undefined) delete process.env.DEEPGRAM_AGENT_URL; else process.env.DEEPGRAM_AGENT_URL = previousUrl;
    if (previousKey === undefined) delete process.env.DEEPGRAM_API_KEY; else process.env.DEEPGRAM_API_KEY = previousKey;
    upstream.clients.forEach((client) => client.terminate());
    upstream.close();
    server.close();
    mock.close();
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
