#!/usr/bin/env node
/* Offline browser/provider integration test. Requires playwright-core + Chromium.
 * It uses synthetic audio, a local mock provider/webhook, and isolated data only. */
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { chromium } = require('playwright-core');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vac-live-bot-browser-'));
let child, browser, mock, mockWss, staticServer;
let childLog = '';
const requests = [];
const settingsReceived = [];
const fnResponses = [];
let nonSilentAudioBytes = 0;
let webhooks = 0;
const pageErrors = [];

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
async function until(fn, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out waiting for ${label}; server log: ${childLog}`);
}
async function blockExternal(context) {
  await context.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    return host === '127.0.0.1' || host === 'localhost' ? route.continue() : route.abort();
  });
}
function mockAudio(seconds = 0.25) {
  const samples = Math.floor(24000 * seconds);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) pcm.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 220 / 24000) * 2000), i * 2);
  return pcm;
}

async function run() {
  mock = http.createServer((_req, res) => { webhooks++; res.writeHead(200); res.end('{}'); });
  mockWss = new WebSocketServer({ server: mock, path: '/agent' });
  mockWss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'Welcome', request_id: 'browser-mock' }));
    ws.on('message', (raw, binary) => {
      if (binary) {
        const buf = Buffer.from(raw);
        if (buf.some((byte) => byte !== 0)) nonSilentAudioBytes += buf.length;
        return;
      }
      const message = JSON.parse(raw.toString());
      if (message.type === 'Settings') {
        settingsReceived.push(message);
        setTimeout(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'SettingsApplied' })); }, 180);
      } else if (message.type === 'InjectUserMessage') {
        requests.push(message.content);
        ws.send(JSON.stringify({ type: 'ConversationText', role: 'user', content: message.content }));
        ws.send(JSON.stringify({ type: 'AgentThinking' }));
        ws.send(JSON.stringify({ type: 'AgentStartedSpeaking' }));
        const finishing = message.content === 'finish the browser test';
        ws.send(JSON.stringify({ type: 'ConversationText', role: 'assistant', content: finishing ? 'Final mock audio.' : 'Response from the local mock provider.' }));
        ws.send(mockAudio(finishing ? 2 : 0.25), { binary: true });
        ws.send(JSON.stringify({ type: 'FunctionCallRequest', functions: finishing ? [
          { id: 'end-browser', name: 'end_call', arguments: '{}', client_side: true },
        ] : [
          { id: 'dispo-browser', name: 'set_disposition', arguments: '{"code":"DNC"}', client_side: true },
          { id: 'xfer-browser', name: 'transfer_to_live_agent', arguments: '{"reason":"test"}', client_side: true },
        ] }));
      } else if (message.type === 'FunctionCallResponse') {
        fnResponses.push(message);
        if (message.id === 'end-browser') ws.send(JSON.stringify({ type: 'AgentAudioDone' }));
      }
    });
  });
  const mockPort = await listen(mock);
  const probe = http.createServer();
  const serverPort = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  const base = `http://127.0.0.1:${serverPort}`;
  const env = {
    ...process.env, HOST: '127.0.0.1', PORT: String(serverPort), VAC_DATA_DIR: temp, VAC_ENV_FILE: path.join(temp, '.env'),
    BRIDGE_BIND_HOST: '127.0.0.1', AUDIOSOCKET_PORT: '0', BRIDGE_SIP_PORT: '0', BRIDGE_ALLOWED_IPS: '127.0.0.1',
    ADMIN_PASSWORD: 'synthetic-browser-admin', TRUST_PROXY: '', DEEPGRAM_API_KEY: 'synthetic-browser-key',
    DEEPGRAM_AGENT_URL: `ws://127.0.0.1:${mockPort}/agent`,
    SPEECH_SERVICE_URL: '', SPEECH_SERVICE_API_KEY: '', ELEVENLABS_API_KEY: '', CARTESIA_API_KEY: '',
    OPENAI_API_KEY: '', GROQ_API_KEY: '', VICI_API_PASS: '', AMI_SECRET: '', CUSTOM_WEBHOOK_SECRET: '',
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${JSON.stringify(path.join(root, 'tests/offline-fetch.cjs'))}`.trim(),
  };
  child = cp.spawn(process.execPath, ['dist/server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (buf) => { childLog = (childLog + buf.toString()).slice(-6000); });
  child.stderr.on('data', (buf) => { childLog = (childLog + buf.toString()).slice(-6000); });
  await until(() => childLog.includes('Server listening') || child.exitCode !== null, 'fixture server');
  if (child.exitCode !== null) throw new Error(`Fixture exited: ${childLog}`);

  browser = await chromium.launch({
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await blockExternal(context);
  await context.grantPermissions(['microphone'], { origin: base });
  await context.addInitScript(() => {
    window.__vacAudioStarts = 0;
    const original = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      window.__vacAudioStarts++;
      return original.apply(this, args);
    };
  });
  const page = await context.newPage();
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto(`${base}/login`);
  await page.click('#admin-toggle');
  await page.fill('#admin-password', 'synthetic-browser-admin');
  await page.click('#admin-submit');
  await page.waitForSelector('#btn-logout:visible');
  await page.evaluate(async () => {
    const data = await (await fetch('/api/state')).json();
    data.state.services = {
      stt: { providerId: 's1', model: 'nova-3' },
      llm: { providerId: 'l1', model: 'gpt-4o-mini' },
      tts: { providerId: 't1', model: 'aura-2-thalia-en' },
    };
    const result = await fetch('/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: data.state }) });
    if (!result.ok) throw new Error('Could not save isolated test services');
  });
  await page.goto(`${base}/?tab=test`);
  await page.waitForSelector('#btn-call-mic');
  await page.click('#btn-call-mic');
  await page.waitForSelector('#btn-sim-mute:not([disabled])', { timeout: 10000 });
  await until(() => settingsReceived.length === 1 && nonSilentAudioBytes > 2048, 'non-silent fake microphone frames');
  await page.waitForFunction(() => /Queued to WebSocket/.test(document.querySelector('#sim-mic-telemetry')?.textContent || ''));
  assert.doesNotMatch(await page.locator('#sim-mic-telemetry').innerText(), /streamed to stt/i);
  assert.deepEqual(settingsReceived[0].audio.input, { encoding: 'linear16', sample_rate: 16000 });
  console.log('PASS Browser microphone -> actual local mock Voice Agent PCM stream');

  await page.click('#btn-sim-mute');
  await page.waitForTimeout(500);
  const mutedBytes = nonSilentAudioBytes;
  await page.waitForTimeout(700);
  assert.equal(nonSilentAudioBytes, mutedBytes, 'Muted mic must stop non-silent audio');
  assert.match(await page.locator('#sim-mic-telemetry').innerText(), /muted/i);
  await page.click('#btn-sim-mute');
  await until(() => nonSilentAudioBytes > mutedBytes + 1024, 'microphone resumes after unmute');
  console.log('PASS Mute stops mic frames; unmute resumes them');

  await page.fill('#sim-inject-input', 'browser mock question');
  await page.click('#btn-sim-inject');
  await until(() => requests.includes('browser mock question'), 'text at provider');
  await page.waitForFunction(() => (document.querySelector('#sim-feed')?.textContent || '').includes('Response from the local mock provider.'));
  await page.waitForFunction(() => window.__vacAudioStarts > 0);
  await until(() => fnResponses.some((r) => r.id === 'xfer-browser'), 'provider function response');
  const xfer = JSON.parse(fnResponses.find((r) => r.id === 'xfer-browser').content);
  const dispo = JSON.parse(fnResponses.find((r) => r.id === 'dispo-browser').content);
  assert.equal(xfer.ok, false);
  assert.equal(dispo.ok, false);
  assert.match(await page.locator('#sim-feed').innerText(), /not executed.*browser test only/i);
  assert.equal(await page.locator('#sim-kpi-xfer').innerText(), 'Not connected');
  assert.equal(webhooks, 0);
  await page.click('#btn-call-hangup');
  await page.waitForSelector('#btn-call-nomic');
  await page.waitForSelector('#sim-logs-box .sim-history-transcript summary');
  await page.locator('#sim-logs-box .sim-history-transcript summary').first().click();
  const history = await page.locator('#sim-logs-box').innerText();
  assert.match(history, /Latest/);
  assert.match(history, /browser mock question/);
  assert.match(history, /Response from the local mock provider/);
  assert.equal(await page.locator('#sim-logs-box audio').count(), 0);
  assert.match(await page.locator('#sim-history').locator('..').innerText(), /not audio recordings/i);
  console.log('PASS Provider transcript is saved and discoverable; PBX actions fail without side effects or fake recording');

  await page.click('#btn-call-nomic');
  await page.waitForSelector('#sim-inject-input:enabled');
  await page.fill('#sim-inject-input', 'finish the browser test');
  await page.click('#btn-sim-inject');
  await page.waitForFunction(() => /Finishing browser audio playback/i.test(document.querySelector('#sim-state-pill')?.textContent || ''), null, { timeout: 7000 });
  await page.waitForTimeout(350);
  assert.equal(await page.locator('#btn-call-nomic').count(), 0, 'Final queued audio should not be cut off');
  await page.waitForSelector('#btn-call-nomic', { timeout: 5000 });
  console.log('PASS Bot end_call waits for buffered browser playback');
  await page.locator('#nav [data-t="vici"]').click();
  const confirmed = new Promise((resolve) => page.once('dialog', async (dialog) => { const message = dialog.message(); await dialog.dismiss(); resolve(message); }));
  await page.click('#btn-vici-sim');
  assert.match(await confirmed, /mock VICIdial responses.*webhooks can run for real/i);
  assert.equal(await page.locator('#btn-vici-sim').isEnabled(), true);
  console.log('PASS Bridge loopback warns about mock outcomes and real webhook/shared-routing risks');
  assert.deepEqual(pageErrors, []);

  // Static-host mode uses a fake in-browser WebSocket. No provider or external
  // webhook is contacted; inspect precisely what would be sent on the wire.
  const docs = path.join(root, 'docs');
  staticServer = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    if (pathname.startsWith('/api/')) { res.writeHead(404); res.end('not found'); return; }
    const file = path.resolve(docs, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(docs + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return; }
    res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'image/svg+xml');
    fs.createReadStream(file).pipe(res);
  });
  const staticPort = await listen(staticServer);
  const staticContext = await browser.newContext();
  await blockExternal(staticContext);
  const state = JSON.parse(fs.readFileSync(path.join(docs, 'default-state.json'), 'utf8'));
  state.services = { stt: { providerId: 's1', model: 'nova-3' }, llm: { providerId: 'l1', model: 'gpt-4o-mini' }, tts: { providerId: 't1', model: 'aura-2-thalia-en' } };
  state.functions.push({ id: 'browser_custom', name: 'custom_demo', description: 'test', params: '{"type":"object","properties":{}}', defer: false,
    url: 'https://example.invalid/never-execute', method: 'post', headers: '{}' });
  state.agents.find((a) => a.id === 'a_nova').fnIds.push('browser_custom');
  await staticContext.addInitScript((initialState) => {
    localStorage.setItem('vac_cloud_session_v1', JSON.stringify({ user: { fullName: 'Synthetic user' } }));
    localStorage.setItem('vac_cloud_state_v1', JSON.stringify(initialState));
    localStorage.setItem('vac_cloud_vici_logs_v1', JSON.stringify([{ id: 'old-demo', callerCode: 'SYNTHETIC-OLD-ENTRY', disposition: 'XFER', startedAt: new Date().toISOString() }]));
    window.__mockWs = { created: 0, settings: null, responses: [] };
    class FakeWebSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      constructor() {
        window.__mockWs.created++;
        this.readyState = 0;
        setTimeout(() => { this.readyState = 1; this.onmessage?.({ data: JSON.stringify({ type: 'Welcome' }) }); }, 5);
      }
      send(payload) {
        if (typeof payload !== 'string') return;
        const message = JSON.parse(payload);
        if (message.type === 'Settings') {
          window.__mockWs.settings = message;
          setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: 'SettingsApplied' }) }), 5);
        } else if (message.type === 'InjectUserMessage') {
          const emit = (event) => this.onmessage?.({ data: JSON.stringify(event) });
          emit({ type: 'ConversationText', role: 'user', content: message.content });
          emit({ type: 'FunctionCallCancelled', id: 'cancelled', name: 'custom_demo' });
          emit({ type: 'FunctionCallRequest', functions: [
            { id: 'cancelled', name: 'custom_demo', arguments: '{}', client_side: true },
            { id: 'custom', name: 'custom_demo', arguments: '{}', client_side: true },
            { id: 'xfer', name: 'transfer_to_live_agent', arguments: '{}', client_side: true, thought_signature: 'static-sig' },
          ] });
        } else if (message.type === 'FunctionCallResponse') window.__mockWs.responses.push(message);
      }
      close() { this.readyState = 3; setTimeout(() => this.onclose?.({ code: 1000, reason: 'closed' }), 0); }
    }
    window.WebSocket = FakeWebSocket;
  }, state);
  const staticPage = await staticContext.newPage();
  staticPage.on('pageerror', (err) => pageErrors.push(String(err)));
  const staticBase = `http://127.0.0.1:${staticPort}`;
  await staticPage.goto(`${staticBase}/index.html?tab=test`);
  await staticPage.waitForSelector('#btn-call-nomic');
  await staticPage.click('#btn-call-nomic');
  assert.match(await staticPage.locator('#sim-state-pill').innerText(), /key needed/i);
  assert.equal(await staticPage.evaluate(() => window.__mockWs.created), 0, 'Missing key must not start a fake session');
  await staticPage.evaluate(() => localStorage.setItem('vac_cloud_secrets_v1', JSON.stringify({ DEEPGRAM_API_KEY: 'synthetic-static-key' })));
  await staticPage.reload();
  await staticPage.waitForSelector('#btn-call-nomic');
  await staticPage.click('#btn-call-nomic');
  await staticPage.waitForSelector('#sim-inject-input:enabled');
  assert(await staticPage.locator('#sim-allow-webhooks').isDisabled());
  await staticPage.fill('#sim-inject-input', 'static mock question');
  await staticPage.click('#btn-sim-inject');
  await staticPage.waitForFunction(() => window.__mockWs.responses.length === 2);
  const staticWire = await staticPage.evaluate(() => window.__mockWs);
  assert.ok(staticWire.settings.agent.think.functions.every((f) => !f.endpoint && f.defer_until_eot === true));
  assert.ok(!staticWire.responses.some((r) => r.id === 'cancelled'));
  assert.equal(JSON.parse(staticWire.responses.find((r) => r.id === 'custom').content).ok, false);
  assert.equal(JSON.parse(staticWire.responses.find((r) => r.id === 'xfer').content).ok, false);
  assert.equal(staticWire.responses.find((r) => r.id === 'xfer').thought_signature, 'static-sig');
  assert.match(await staticPage.locator('#sim-feed').innerText(), /not executed/i);
  assert.deepEqual(pageErrors, []);
  console.log('PASS Static mode rejects missing key and never fabricates webhook/transfer success');

  await staticPage.click('#btn-call-hangup');
  await staticPage.locator('#nav [data-t="vici"]').click();
  await staticPage.waitForSelector('#btn-vici-sim');
  assert(await staticPage.locator('#btn-vici-sim').isDisabled());
  assert.match(await staticPage.locator('#vici-cdr-box').innerText(), /no bridge server or recordings/i);
  assert.doesNotMatch(await staticPage.locator('#vici-cdr-box').innerText(), /SYNTHETIC-OLD-ENTRY/);
  assert.match(await staticPage.evaluate(() => localStorage.getItem('vac_cloud_vici_logs_v1')), /SYNTHETIC-OLD-ENTRY/, 'Legacy local data should not be deleted');
  await staticPage.locator('#nav [data-t="wallboard"]').click();
  assert.doesNotMatch(await staticPage.locator('main').innerText(), /390ms|520ms|SYNTHETIC-OLD-ENTRY/);
  console.log('PASS Static bridge demo is unavailable and old synthetic CDRs are not presented as live history');
  assert.deepEqual(pageErrors, []);
}

run().catch((err) => { console.error(err.stack || err); process.exitCode = 1; }).finally(async () => {
  if (browser) await Promise.race([browser.close().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 5000))]);
  if (child && child.exitCode === null) child.kill();
  if (mockWss) { mockWss.clients.forEach((ws) => ws.terminate()); mockWss.close(); }
  if (mock) { mock.closeAllConnections(); mock.close(); }
  if (staticServer) { staticServer.closeAllConnections(); staticServer.close(); }
  fs.rmSync(temp, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
});
