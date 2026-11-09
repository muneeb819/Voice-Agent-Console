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
const settingsAppliedTimes = [];
const openingMessages = [];
const { composeOpening } = require('../public/opening.js');
const importedGreetings = JSON.parse(fs.readFileSync(path.join(root, 'public/greetings.json'), 'utf8')).greetings;
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
        const index = settingsReceived.push(message) - 1;
        ws._fixtureSettingsIndex = index;
        setTimeout(() => { if (ws.readyState === 1) { settingsAppliedTimes[index] = Date.now(); ws.send(JSON.stringify({ type: 'SettingsApplied' })); } }, 180);
      } else if (message.type === 'InjectAgentMessage') {
        openingMessages.push({ index: ws._fixtureSettingsIndex, message: message.message, at: Date.now() });
        ws.send(JSON.stringify({ type: 'AgentStartedSpeaking' }));
        ws.send(JSON.stringify({ type: 'ConversationText', role: 'assistant', content: message.message }));
        ws.send(mockAudio(0.25), { binary: true });
        ws.send(JSON.stringify({ type: 'AgentAudioDone' }));
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
    window.__vacResumedContexts = [];
    const originalResume = AudioContext.prototype.resume;
    AudioContext.prototype.resume = function (...args) {
      if (!window.__vacResumedContexts.includes(this)) window.__vacResumedContexts.push(this);
      return originalResume.apply(this, args);
    };
    const original = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      window.__vacAudioStarts++;
      return original.apply(this, args);
    };
  });
  const page = await context.newPage();
  const recordingGets = [];
  page.on('request', (request) => {
    if (request.method() === 'GET' && request.url().includes('/api/simulator/recordings/')) recordingGets.push(request);
  });
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
    for (const campaign of data.state.campaigns) {
      campaign.complianceRules = 'Browser fixture campaign rules: be truthful, avoid unsupported claims, and honor do-not-call requests immediately.';
    }
    const result = await fetch('/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: data.state }) });
    if (!result.ok) throw new Error('Could not save isolated test services');
  });
  await page.goto(`${base}/?tab=test`);
  await page.waitForSelector('#sim-campaign');
  const serverCampaignId = await page.evaluate(async () => {
    const { state } = await (await fetch('/api/state')).json();
    const agentId = document.querySelector('#sel-a').value;
    return state.campaigns.find((campaign) => campaign.agentId === agentId)?.id || '';
  });
  assert(serverCampaignId, 'The selected server agent must have an assigned campaign');
  await page.selectOption('#sim-campaign', serverCampaignId);
  await page.waitForSelector('#btn-call-mic:enabled');
  assert.equal(await page.locator('#sim-record-audio').isChecked(), false, 'Audio recording must default off');
  await page.click('#btn-call-mic');
  await page.waitForSelector('#btn-sim-mute:not([disabled])', { timeout: 10000 });
  await until(() => settingsReceived.length === 1 && nonSilentAudioBytes > 2048, 'non-silent fake microphone frames');
  await page.waitForFunction(() => /Queued to WebSocket/.test(document.querySelector('#sim-mic-telemetry')?.textContent || ''));
  assert.doesNotMatch(await page.locator('#sim-mic-telemetry').innerText(), /streamed to stt/i);
  assert.deepEqual(settingsReceived[0].audio.input, { encoding: 'linear16', sample_rate: 16000 });
  const serverGreetingLabel = await page.locator('#sim-selected-greeting').innerText();
  const serverGreetingId = /Selected greeting #(\d+)/.exec(serverGreetingLabel)?.[1];
  const serverGreeting = importedGreetings.find((row) => row.greeting_id === serverGreetingId);
  assert(serverGreeting, `Selected server greeting should be in the imported catalog: ${serverGreetingLabel}`);
  assert.equal(settingsReceived[0].agent.greeting, undefined, 'Automatic provider greeting must be disabled');
  assert.match(await page.locator('main').innerText(), /Hydrated Session Preview/i);
  assert.doesNotMatch(await page.locator('main').innerText(), /Hydrated Session Settings Sent/i);
  const savedAgentData = await page.evaluate(async () => {
    const { state } = await (await fetch('/api/state')).json();
    const agent = state.agents.find((item) => item.id === document.querySelector('#sel-a').value);
    return { agent, campaign: state.campaigns.find((item) => item.id === document.querySelector('#sim-campaign').value) };
  });
  await until(() => openingMessages.some((entry) => entry.index === 0), 'single delayed configured opening');
  const firstOpening = openingMessages.find((entry) => entry.index === 0);
  assert(firstOpening.at - settingsAppliedTimes[0] >= 990, 'Server opening must wait at least one second');
  const expectedServerOpening = composeOpening(savedAgentData.agent.greeting, serverGreeting.greeting_text, false, '')
    .replace(/\{\{first_name\}\}/g, 'Robert').replace(/\{\{state\}\}/g, 'FL');
  assert.equal(firstOpening.message, expectedServerOpening);
  assert(!firstOpening.message.includes(serverGreeting.greeting_text));
  assert.equal(openingMessages.filter((entry) => entry.index === 0).length, 1);
  assert.equal(await page.locator('#sim-disclosure').isDisabled(), true);
  console.log('PASS Browser mic and server send one configured opening after the one-second listen');

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
  await page.waitForSelector('#btn-call-nomic:enabled');
  await page.waitForSelector('#sim-logs-box .sim-history-transcript summary');
  await page.locator('#sim-logs-box .sim-history-transcript summary').first().click();
  const history = await page.locator('#sim-logs-box').innerText();
  assert.match(history, /Latest/);
  assert.match(history, /browser mock question/);
  assert.match(history, /Response from the local mock provider/);
  assert.match(history, new RegExp(`Selected greeting #${serverGreetingId}\\b`));
  assert.equal(await page.locator('#sim-logs-box audio').count(), 0);
  assert.match(await page.locator('#sim-logs-box').innerText(), /No audio recording for this test/i);
  assert.equal(fs.existsSync(path.join(temp, 'simulator-recordings')), false, 'No audio should be saved by default');
  assert.match(await page.locator('#sim-history').locator('..').innerText(), /Tests made before recording was available have no audio/i);
  console.log('PASS Provider transcript is saved without default audio; PBX actions fail without side effects');

  // A Live Bot notice change is usable as an unsaved test draft; a saved
  // agent's normal value remains unchanged until Save & verify is pressed.
  const noticeCallIndex = settingsReceived.length;
  assert.equal(await page.locator('#sim-disclosure').isChecked(), false);
  await page.check('#sim-disclosure');
  await page.click('#btn-call-nomic');
  await page.waitForSelector('#sim-inject-input:enabled');
  await until(() => openingMessages.some((entry) => entry.index === noticeCallIndex), 'draft notice call opening');
  const withNotice = openingMessages.find((entry) => entry.index === noticeCallIndex);
  assert.ok(withNotice.message.startsWith(savedAgentData.campaign.disclosure), 'The opted-in notice is prepended to the configured opening');
  assert.ok(settingsReceived[noticeCallIndex].agent.think.prompt.includes(savedAgentData.campaign.disclosure),
    'The unsaved notice draft must reach the next test prompt');
  const persistedNotice = await page.evaluate(async (id) => {
    const { state } = await (await fetch('/api/state')).json();
    return state.agents.find((agent) => agent.id === id).injectCampaignDisclosure;
  }, savedAgentData.agent.id);
  assert.equal(persistedNotice, false, 'An unsaved test draft must not modify server settings');
  await page.click('#btn-call-hangup');
  await page.waitForSelector('#btn-call-nomic:enabled');
  await page.uncheck('#sim-disclosure');
  console.log('PASS Live Bot notice toggle affects the next test without silently saving the agent');

  await page.check('#sim-record-audio');
  await page.click('#btn-call-nomic');
  await page.waitForSelector('#sim-inject-input:enabled');
  await page.fill('#sim-inject-input', 'finish the browser test');
  await page.click('#btn-sim-inject');
  await page.waitForFunction(() => /Finishing browser audio playback/i.test(document.querySelector('#sim-state-pill')?.textContent || ''), null, { timeout: 7000 });
  await page.waitForTimeout(350);
  assert.equal(await page.locator('#btn-call-nomic').count(), 0, 'Final queued audio should not be cut off');
  await page.waitForSelector('#btn-call-nomic:enabled', { timeout: 12000 });
  await page.waitForSelector('[data-sim-audio-load]');
  await page.locator('[data-sim-audio-load]').first().click();
  await page.waitForSelector('#sim-logs-box audio');
  const finalAudio = await page.evaluate(async () => {
    const bytes = await (await fetch(document.querySelector('#sim-logs-box audio').src)).arrayBuffer();
    const ctx = new AudioContext(), audio = await ctx.decodeAudioData(bytes), samples = audio.getChannelData(0);
    let energy = 0; const from = Math.max(0, samples.length - audio.sampleRate);
    for (let i = from; i < samples.length; i++) energy += samples[i] * samples[i];
    await ctx.close(); return { duration: audio.duration, lastSecondRms: Math.sqrt(energy / (samples.length - from)) };
  });
  assert(finalAudio.duration > 1.8 && finalAudio.lastSecondRms > 0.01, `Final buffered speech must be in the recording: ${JSON.stringify(finalAudio)}`);
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('[data-sim-audio-delete]').first().click();
  await page.waitForFunction(() => (document.querySelector('#sim-logs-box')?.textContent || '').includes('Recording deleted.'));
  console.log('PASS Bot end_call drains buffered playback into the recording');

  // Record fake microphone first, then mute it and play the mock agent's 220 Hz tone.
  // Decode the actual stored WebM: this checks the mix, not just a mock MediaRecorder call.
  await page.check('#sim-record-audio');
  await page.click('#btn-call-mic');
  await page.waitForSelector('#btn-sim-mute:not([disabled])');
  await page.waitForTimeout(1800);
  await page.click('#btn-sim-mute');
  await page.fill('#sim-inject-input', 'recording test tone');
  await page.click('#btn-sim-inject');
  await page.waitForFunction(() => (document.querySelector('#sim-feed')?.textContent || '').includes('Response from the local mock provider.'));
  await page.waitForTimeout(800);
  await page.click('#btn-call-hangup');
  await page.waitForSelector('#btn-call-mic:enabled', { timeout: 12000 });
  assert.equal(await page.locator('#sim-record-audio').isChecked(), false, 'Opt-in resets after each test');
  await page.waitForSelector('[data-sim-audio-load]');
  const priorGets = recordingGets.length;
  await page.locator('[data-sim-audio-load]').first().click();
  await page.waitForSelector('#sim-logs-box audio');
  assert.equal(recordingGets.length, priorGets + 1);
  assert.match(recordingGets.at(-1).headers().authorization || '', /^Bearer /);
  assert.doesNotMatch(recordingGets.at(-1).url(), /token|authorization|synthetic-browser-admin/i);
  assert.match(await page.locator('#sim-logs-box audio').first().getAttribute('src'), /^blob:/);
  const decoded = await page.evaluate(async () => {
    const blob = await (await fetch(document.querySelector('#sim-logs-box audio').src)).arrayBuffer();
    const context = new AudioContext();
    const audio = await context.decodeAudioData(blob);
    const samples = audio.getChannelData(0), rate = audio.sampleRate;
    const rms = (start, end) => {
      let sum = 0; const from = Math.floor(start * rate), to = Math.min(samples.length, Math.floor(end * rate));
      for (let i = from; i < to; i++) sum += samples[i] * samples[i];
      return Math.sqrt(sum / Math.max(1, to - from));
    };
    let peak220 = 0;
    const width = Math.floor(rate / 10);
    for (let offset = Math.floor(rate * 1.5); offset + width < samples.length; offset += Math.floor(width / 2)) {
      let sin = 0, cos = 0;
      for (let i = 0; i < width; i++) {
        const phase = 2 * Math.PI * 220 * i / rate;
        sin += samples[offset + i] * Math.sin(phase); cos += samples[offset + i] * Math.cos(phase);
      }
      peak220 = Math.max(peak220, 2 * Math.sqrt(sin * sin + cos * cos) / width);
    }
    await context.close();
    return { duration: audio.duration, micRms: rms(0.4, 1.5), peak220, tailRms: rms(Math.max(0, audio.duration - 0.3), audio.duration) };
  });
  assert(decoded.duration > 2, `Recording should include the live test: ${JSON.stringify(decoded)}`);
  assert(decoded.micRms > 0.002, `Expected fake microphone audio in recording: ${JSON.stringify(decoded)}`);
  assert(decoded.peak220 > 0.01, `Expected the mock agent's 220 Hz tone after mic mute: ${JSON.stringify(decoded)}`);
  assert(decoded.tailRms < 0.005, `Muted microphone must not remain audible after agent playback: ${JSON.stringify(decoded)}`);
  assert.equal(await page.locator('#sim-logs-box a[download]').count(), 1);
  await page.reload();
  await page.waitForSelector('[data-sim-audio-load]');
  await page.locator('[data-sim-audio-load]').first().click();
  await page.waitForSelector('#sim-logs-box audio');
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('[data-sim-audio-delete]').first().click();
  await page.waitForSelector('#sim-logs-box audio', { state: 'detached' });
  assert.match(await page.locator('#sim-logs-box').innerText(), /Recording deleted/);
  console.log('PASS Opt-in records real mixed browser audio, plays with auth after reload, and deletes audio only');

  await page.check('#sim-record-audio');
  await page.click('#btn-call-nomic');
  await page.waitForSelector('#sim-inject-input:enabled');
  await page.fill('#sim-inject-input', 'recording before audio suspension');
  await page.click('#btn-sim-inject');
  await page.waitForTimeout(450);
  await page.evaluate(async () => window.__vacResumedContexts.at(-1).suspend());
  await page.waitForFunction(() => /Browser audio was suspended during recording/i.test(document.querySelector('#sim-feed')?.textContent || ''));
  await page.evaluate(async () => window.__vacResumedContexts.at(-1).resume());
  await page.waitForTimeout(300);
  await page.click('#btn-call-hangup');
  await page.waitForSelector('#btn-call-nomic:enabled', { timeout: 12000 });
  await page.getByText('Audio was not saved or could not be confirmed in history.', { exact: true }).waitFor();
  assert.match(await page.locator('main').innerText(), /audio may be incomplete/i);
  page.once('dialog', (dialog) => dialog.accept());
  await page.click('#btn-discard-recording-fallback');
  console.log('PASS Suspended browser audio is reported as potentially incomplete, not silently saved as complete');

  // A failed upload must leave the Blob downloadable and never report success.
  const failUpload = (route) => route.request().method() === 'PUT'
    ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"synthetic upload failure"}' })
    : route.continue();
  await page.route('**/api/simulator/recordings/**', failUpload);
  await page.check('#sim-record-audio');
  await page.click('#btn-call-nomic');
  await page.waitForSelector('#sim-inject-input:enabled');
  await page.fill('#sim-inject-input', 'recording upload fallback');
  await page.click('#btn-sim-inject');
  await page.waitForTimeout(700);
  await page.click('#btn-call-hangup');
  await page.waitForSelector('#btn-call-nomic:enabled', { timeout: 12000 });
  const fallback = page.locator('a[download^="live-bot-"]').filter({ hasText: 'Download audio now' });
  await fallback.waitFor();
  assert.match(await fallback.getAttribute('href'), /^blob:/);
  assert.match(await page.locator('main').innerText(), /Audio was not saved or could not be confirmed/i);
  assert((await page.evaluate(async (href) => (await (await fetch(href)).blob()).size, await fallback.getAttribute('href'))) > 100);
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.check('#sim-record-audio');
  await page.click('#btn-call-nomic');
  assert.equal(await page.locator('#btn-call-nomic').count(), 1, 'Declining fallback discard must not start a new call');
  await page.unroute('**/api/simulator/recordings/**', failUpload);
  console.log('PASS Failed upload retains a recoverable download and warns before discarding it');

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
  // An old bundled Medicare prompt is migrated only when the complete text
  // matches; an operator's customized version must remain unchanged.
  const migrationState = JSON.parse(fs.readFileSync(path.join(docs, 'default-state.json'), 'utf8'));
  const stockPrompt = migrationState.agents.find((a) => a.id === 'a_medicare').prompt;
  const newPhase = '- Phase 1 (After the opening):\n' +
    '  If Medicare status has not been established, ask whether they have Medicare Part A or Part B; do not assume the opening asked this.\n';
  const oldPhase = '- Phase 1 (Delivered in Greeting — Food & OTC Card Hook):\n' +
    '  You already asked if they have Medicare Part A and B to release their Food & OTC card.\n';
  const oldPrompt = stockPrompt.replace(newPhase, oldPhase);
  assert.notEqual(oldPrompt, stockPrompt);
  migrationState.agents.find((a) => a.id === 'a_medicare').prompt = oldPrompt;
  migrationState.agents[0].prompt = `${oldPrompt}\nOperator custom content.`;
  const migrationContext = await browser.newContext();
  await blockExternal(migrationContext);
  await migrationContext.addInitScript((fixture) => {
    localStorage.setItem('vac_cloud_session_v1', JSON.stringify({ user: { fullName: 'Synthetic user' } }));
    if (!localStorage.getItem('vac_cloud_state_v1')) localStorage.setItem('vac_cloud_state_v1', JSON.stringify(fixture));
  }, migrationState);
  const migrationPage = await migrationContext.newPage();
  migrationPage.on('pageerror', (err) => pageErrors.push(String(err)));
  await migrationPage.goto(`http://127.0.0.1:${staticPort}/index.html?tab=agents`);
  await migrationPage.waitForSelector('[data-p="a.greeting"]');
  const migratedState = await migrationPage.evaluate(() => JSON.parse(localStorage.getItem('vac_cloud_state_v1')));
  assert.equal(migratedState.agents.find((a) => a.id === 'a_medicare').prompt, stockPrompt);
  assert.equal(migratedState.agents[0].prompt, `${oldPrompt}\nOperator custom content.`);
  await migrationContext.close();
  console.log('PASS Static migration corrects only the exact stock Medicare prompt');

  const staticContext = await browser.newContext();
  await blockExternal(staticContext);
  const state = JSON.parse(fs.readFileSync(path.join(docs, 'default-state.json'), 'utf8'));
  state.services = { stt: { providerId: 's1', model: 'nova-3' }, llm: { providerId: 'l1', model: 'gpt-4o-mini' }, tts: { providerId: 't1', model: 'aura-2-thalia-en' } };
  for (const campaign of state.campaigns) {
    campaign.complianceRules = 'Static browser fixture campaign rules: be truthful, avoid unsupported claims, and honor do-not-call requests immediately.';
  }
  state.functions.push({ id: 'browser_custom', name: 'custom_demo', description: 'test', params: '{"type":"object","properties":{}}', defer: false,
    url: 'https://example.invalid/never-execute', method: 'post', headers: '{}' });
  state.agents.find((a) => a.id === 'a_nova').fnIds.push('browser_custom');
  const staticCampaignId = state.campaigns.find((campaign) => campaign.agentId === 'a_nova')?.id;
  assert(staticCampaignId, 'Static fixture agent must have an assigned campaign');
  const selectStaticCampaign = async (page) => {
    await page.waitForSelector('#sim-campaign');
    await page.selectOption('#sim-campaign', staticCampaignId);
  };
  await staticContext.addInitScript((initialState) => {
    localStorage.setItem('vac_cloud_session_v1', JSON.stringify({ user: { fullName: 'Synthetic user' } }));
    localStorage.setItem('vac_cloud_state_v1', JSON.stringify(initialState));
    localStorage.setItem('vac_cloud_vici_logs_v1', JSON.stringify([{ id: 'old-demo', callerCode: 'SYNTHETIC-OLD-ENTRY', disposition: 'XFER', startedAt: new Date().toISOString() }]));
    window.__mockWs = { created: 0, settings: null, responses: [], openings: [], playbackTimes: [], appliedAt: 0 };
    const nativeAudioStart = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      window.__mockWs.playbackTimes.push(Date.now());
      return nativeAudioStart.apply(this, args);
    };
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
          setTimeout(() => { window.__mockWs.appliedAt = Date.now(); this.onmessage?.({ data: JSON.stringify({ type: 'SettingsApplied' }) }); }, 5);
        } else if (message.type === 'InjectAgentMessage') {
          window.__mockWs.openings.push({ message: message.message, at: Date.now() });
          this.onmessage?.({ data: JSON.stringify({ type: 'AgentStartedSpeaking' }) });
          this.onmessage?.({ data: JSON.stringify({ type: 'ConversationText', role: 'assistant', content: message.message }) });
          this.onmessage?.({ data: new Int16Array(2400).buffer });
          this.onmessage?.({ data: JSON.stringify({ type: 'AgentAudioDone' }) });
        } else if (message.type === 'InjectUserMessage') {
          const emit = (event) => this.onmessage?.({ data: JSON.stringify(event) });
          emit({ type: 'ConversationText', role: 'user', content: message.content });
          emit({ type: 'ConversationText', role: 'assistant', content: 'Static mock audio response.' });
          emit({ type: 'AgentStartedSpeaking' });
          const pcm = new Int16Array(12000);
          for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(Math.sin(i * 2 * Math.PI * 220 / 24000) * 2000);
          this.onmessage?.({ data: pcm.buffer });
          emit({ type: 'AgentAudioDone' });
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
  await selectStaticCampaign(staticPage);
  await staticPage.waitForSelector('#btn-call-nomic:enabled');
  await staticPage.click('#btn-call-nomic');
  assert.match(await staticPage.locator('#sim-state-pill').innerText(), /key needed/i);
  assert.equal(await staticPage.evaluate(() => window.__mockWs.created), 0, 'Missing key must not start a fake session');
  await staticPage.evaluate(() => localStorage.setItem('vac_cloud_secrets_v1', JSON.stringify({ DEEPGRAM_API_KEY: 'synthetic-static-key' })));
  await staticPage.reload();
  await selectStaticCampaign(staticPage);
  await staticPage.waitForSelector('#btn-call-nomic:enabled');
  await staticPage.click('#btn-call-nomic');
  await staticPage.waitForSelector('#sim-inject-input:enabled');
  assert(await staticPage.locator('#sim-allow-webhooks').isDisabled());
  await staticPage.waitForFunction(() => window.__mockWs.openings.length === 1);
  await staticPage.fill('#sim-inject-input', 'static mock question');
  await staticPage.click('#btn-sim-inject');
  await staticPage.waitForFunction(() => window.__mockWs.responses.length === 2);
  const staticWire = await staticPage.evaluate(() => window.__mockWs);
  const staticLabel = await staticPage.locator('#sim-selected-greeting').innerText();
  const staticId = /Selected greeting #(\d+)/.exec(staticLabel)?.[1];
  const staticGreeting = importedGreetings.find((row) => row.greeting_id === staticId);
  assert(staticGreeting, `Selected static greeting should be in the catalog: ${staticLabel}`);
  const staticAgent = state.agents.find((agent) => agent.id === 'a_nova');
  const staticCampaign = state.campaigns.find((campaign) => campaign.agentId === staticAgent.id);
  assert.equal(staticWire.settings.agent.greeting, undefined);
  assert.equal(staticWire.openings.length, 1);
  assert.ok(staticWire.openings[0].at - staticWire.appliedAt >= 990, 'Static opening must wait at least one second');
  assert.equal(staticWire.openings[0].message, composeOpening(staticAgent.greeting, staticGreeting.greeting_text, false, '')
    .replace(/\{\{first_name\}\}/g, 'Robert').replace(/\{\{state\}\}/g, 'FL'));
  assert.ok(!staticWire.openings[0].message.includes(staticGreeting.greeting_text));
  assert.ok(staticWire.settings.agent.think.functions.every((f) => !f.endpoint && f.defer_until_eot === true));
  assert.ok(!staticWire.responses.some((r) => r.id === 'cancelled'));
  assert.equal(JSON.parse(staticWire.responses.find((r) => r.id === 'custom').content).ok, false);
  assert.equal(JSON.parse(staticWire.responses.find((r) => r.id === 'xfer').content).ok, false);
  assert.equal(staticWire.responses.find((r) => r.id === 'xfer').thought_signature, 'static-sig');
  assert.match(await staticPage.locator('#sim-feed').innerText(), /not executed/i);
  assert.deepEqual(pageErrors, []);
  console.log('PASS Static mode rejects missing key and never fabricates webhook/transfer success');

  await staticPage.click('#btn-call-hangup');
  await staticPage.waitForSelector('#btn-call-nomic:enabled');
  await staticPage.reload();
  await selectStaticCampaign(staticPage);
  await staticPage.waitForSelector('#btn-call-nomic:enabled');
  await staticPage.click('#btn-call-nomic');
  await staticPage.waitForSelector('#sim-inject-input:enabled');
  const afterReloadLabel = await staticPage.locator('#sim-selected-greeting').innerText();
  const afterReloadId = /Selected greeting #(\d+)/.exec(afterReloadLabel)?.[1];
  assert(afterReloadId && afterReloadId !== staticId, 'Static IndexedDB rotation survives reload without repeating');
  const afterReloadGreeting = importedGreetings.find((row) => row.greeting_id === afterReloadId);
  assert.notEqual(composeOpening(staticAgent.greeting, staticGreeting.greeting_text, false, ''),
    composeOpening(staticAgent.greeting, afterReloadGreeting.greeting_text, false, ''),
    'Static rotation prefers a different opening across reload');
  await staticPage.click('#btn-call-hangup');
  await staticPage.waitForSelector('#btn-call-nomic:enabled');

  // Send a caller turn immediately after SettingsApplied in direct-browser
  // mode. The mock replies immediately, but the browser must not play early
  // audio or inject a second opening over that response.
  const beforeEarly = await staticPage.evaluate(() => ({ openings: window.__mockWs.openings.length, playback: window.__mockWs.playbackTimes.length }));
  await staticPage.click('#btn-call-nomic');
  await staticPage.waitForSelector('#sim-inject-input:enabled');
  const earlyTiming = await staticPage.evaluate(() => {
    const input = document.querySelector('#sim-inject-input');
    input.value = 'Hello before the opening';
    const sentAt = Date.now();
    document.querySelector('#btn-sim-inject').click();
    return { sentAt, appliedAt: window.__mockWs.appliedAt };
  });
  assert.ok(earlyTiming.sentAt - earlyTiming.appliedAt < 450, 'Fixture must inject its caller turn before the gate opens');
  await staticPage.waitForFunction((count) => window.__mockWs.playbackTimes.length > count, beforeEarly.playback);
  const afterEarly = await staticPage.evaluate(() => window.__mockWs);
  assert.ok(afterEarly.playbackTimes[beforeEarly.playback] - earlyTiming.appliedAt >= 990, 'Direct-browser response must wait for the one-second listen');
  await staticPage.waitForTimeout(100);
  assert.equal(await staticPage.evaluate(() => window.__mockWs.openings.length), beforeEarly.openings, 'Early caller must not get a second opening');
  assert.match(await staticPage.locator('#sim-feed').innerText(), /Hello before the opening/);
  await staticPage.click('#btn-call-hangup');
  await staticPage.waitForSelector('#btn-call-nomic:enabled');
  console.log('PASS Direct-browser early caller gets delayed audio without a duplicate opening');

  // Two tabs in the same profile must serialize their per-bot IndexedDB draws.
  const secondStaticPage = await staticContext.newPage();
  secondStaticPage.on('pageerror', (err) => pageErrors.push(String(err)));
  await secondStaticPage.goto(`${staticBase}/index.html?tab=test`);
  await selectStaticCampaign(secondStaticPage);
  await secondStaticPage.waitForSelector('#btn-call-nomic:enabled');
  await Promise.all([staticPage.click('#btn-call-nomic'), secondStaticPage.click('#btn-call-nomic')]);
  await Promise.all([staticPage.waitForSelector('#sim-inject-input:enabled'), secondStaticPage.waitForSelector('#sim-inject-input:enabled')]);
  const tabIds = await Promise.all([staticPage, secondStaticPage].map(async (p) =>
    /Selected greeting #(\d+)/.exec(await p.locator('#sim-selected-greeting').innerText())?.[1]));
  assert(tabIds.every(Boolean));
  assert.equal(new Set([staticId, afterReloadId, ...tabIds]).size, 4, 'Static draws across reload and concurrent tabs should be distinct');
  await Promise.all([staticPage.click('#btn-call-hangup'), secondStaticPage.click('#btn-call-hangup')]);
  await Promise.all([staticPage.waitForSelector('#btn-call-nomic:enabled'), secondStaticPage.waitForSelector('#btn-call-nomic:enabled')]);
  await secondStaticPage.close();
  // Two eligible IDs with different output and a third whose wording matches
  // the previous selection: prefer the different one without discarding IDs.
  const wordFor = (row) => composeOpening(staticAgent.greeting, row.greeting_text, false, '');
  const priorRow = importedGreetings[0];
  const matchingRow = importedGreetings.find((row) => row.greeting_id !== priorRow.greeting_id && wordFor(row) === wordFor(priorRow));
  const differentRow = importedGreetings.find((row) => wordFor(row) !== wordFor(priorRow));
  assert(matchingRow && differentRow);
  await staticPage.evaluate(({ ids, prior, matching, different }) => new Promise((resolve, reject) => {
    const open = indexedDB.open('vac-greeting-rotation-v1', 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result, tx = db.transaction('rotations', 'readwrite');
      tx.objectStore('rotations').put({ fingerprint: ids.join('\u001f'), remaining: [matching, different], last: prior }, 'a_nova');
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = tx.onabort = () => reject(tx.error);
    };
  }), { ids: importedGreetings.map((row) => row.greeting_id), prior: priorRow.greeting_id, matching: matchingRow.greeting_id, different: differentRow.greeting_id });
  await staticPage.click('#btn-call-nomic');
  await staticPage.waitForSelector('#sim-inject-input:enabled');
  assert.match(await staticPage.locator('#sim-selected-greeting').innerText(), new RegExp(`Selected greeting #${differentRow.greeting_id}\\b`));
  await staticPage.click('#btn-call-hangup');
  await staticPage.waitForSelector('#btn-call-nomic:enabled');
  await staticPage.click('#btn-call-nomic');
  await staticPage.waitForSelector('#sim-inject-input:enabled');
  assert.match(await staticPage.locator('#sim-selected-greeting').innerText(), new RegExp(`Selected greeting #${matchingRow.greeting_id}\\b`));
  await staticPage.click('#btn-call-hangup');
  await staticPage.waitForSelector('#btn-call-nomic:enabled');
  // Seed the last remaining ID of a cycle to exercise the boundary without
  // starting 1,100 browser sessions.
  await staticPage.evaluate((ids) => new Promise((resolve, reject) => {
    const open = indexedDB.open('vac-greeting-rotation-v1', 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result, tx = db.transaction('rotations', 'readwrite');
      tx.objectStore('rotations').put({ fingerprint: ids.join('\u001f'), remaining: ['1100'], last: '1099' }, 'a_nova');
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = tx.onabort = () => reject(tx.error);
    };
  }), importedGreetings.map((row) => row.greeting_id));
  await staticPage.click('#btn-call-nomic');
  await staticPage.waitForSelector('#sim-inject-input:enabled');
  assert.match(await staticPage.locator('#sim-selected-greeting').innerText(), /Selected greeting #1100\b/);
  await staticPage.click('#btn-call-hangup');
  await staticPage.waitForSelector('#btn-call-nomic:enabled');
  await staticPage.click('#btn-call-nomic');
  await staticPage.waitForSelector('#sim-inject-input:enabled');
  assert.doesNotMatch(await staticPage.locator('#sim-selected-greeting').innerText(), /Selected greeting #1100\b/);
  await staticPage.click('#btn-call-hangup');
  await staticPage.waitForSelector('#btn-call-nomic:enabled');
  console.log('PASS Static greeting rotation persists across reload, serializes simultaneous tabs and avoids a boundary repeat');

  const rejectCatalog = (route) => route.fulfill({ status: 503, body: 'fixture unavailable' });
  await staticContext.route('**/greetings.json', rejectCatalog);
  const fallbackPage = await staticContext.newPage();
  fallbackPage.on('pageerror', (err) => pageErrors.push(String(err)));
  await fallbackPage.goto(`${staticBase}/index.html?tab=test`);
  await selectStaticCampaign(fallbackPage);
  await fallbackPage.waitForSelector('#btn-call-nomic:enabled');
  await fallbackPage.click('#btn-call-nomic');
  await fallbackPage.waitForSelector('#sim-inject-input:enabled');
  assert.match(await fallbackPage.locator('#sim-feed').innerText(), /Greeting library unavailable; the configured campaign opening will be used after the one-second listen/i);
  await fallbackPage.waitForFunction(() => window.__mockWs.openings.length === 1);
  assert.equal(await fallbackPage.evaluate(() => window.__mockWs.openings[0].message), composeOpening(staticAgent.greeting, '', false, '')
    .replace(/\{\{first_name\}\}/g, 'Robert').replace(/\{\{state\}\}/g, 'FL'));
  await fallbackPage.click('#btn-call-hangup');
  await fallbackPage.close();
  await staticContext.unroute('**/greetings.json', rejectCatalog);
  console.log('PASS Static site falls back to the configured opening if the catalog cannot load');

  const staticInitialAgent = await staticPage.locator('#sel-a').inputValue();
  assert.notEqual(staticInitialAgent, 'a_medicare');
  await staticPage.evaluate((initialAgent) => localStorage.setItem('vac_cloud_sim_logs_v1', JSON.stringify([
    { id: 'legacy-a', agentId: initialAgent, startedAt: '2020-01-01', durationMs: 1, turns: 0, transcript: [], functionCalls: [] },
    { id: 'legacy-b', agentId: 'a_medicare', startedAt: '2020-01-01', durationMs: 1, turns: 0, transcript: [], functionCalls: [] },
  ])), staticInitialAgent);
  const staticRecord = async (message) => {
    assert.equal(await staticPage.locator('#sim-record-audio').isChecked(), false);
    await staticPage.check('#sim-record-audio');
    await staticPage.click('#btn-call-nomic');
    await staticPage.waitForSelector('#sim-inject-input:enabled');
    await staticPage.fill('#sim-inject-input', message);
    await staticPage.click('#btn-sim-inject');
    await staticPage.waitForTimeout(850);
    await staticPage.click('#btn-call-hangup');
    await staticPage.waitForSelector('#btn-call-nomic:enabled', { timeout: 12000 });
    await staticPage.waitForSelector('[data-sim-audio-load]');
    assert.equal(await staticPage.locator('#sim-record-audio').isChecked(), false);
  };
  await staticRecord('static recorded audio');
  const recordedGreetingId = /Selected greeting #(\d+)/.exec(await staticPage.locator('#sim-selected-greeting').innerText())?.[1];
  assert(recordedGreetingId);
  assert.match(await staticPage.locator('#sim-logs-box').innerText(), new RegExp(`Selected greeting #${recordedGreetingId}\\b`));
  await staticPage.locator('[data-sim-audio-load]').first().click();
  await staticPage.waitForSelector('#sim-logs-box audio');
  const localDecoded = await staticPage.evaluate(async () => {
    const buf = await (await fetch(document.querySelector('#sim-logs-box audio').src)).arrayBuffer();
    const ctx = new AudioContext(); const audio = await ctx.decodeAudioData(buf);
    let energy = 0; const data = audio.getChannelData(0);
    for (const sample of data) energy += sample * sample;
    await ctx.close(); return { duration: audio.duration, rms: Math.sqrt(energy / data.length) };
  });
  assert(localDecoded.duration > 0.4 && localDecoded.rms > 0.003, JSON.stringify(localDecoded));
  await staticPage.reload();
  await staticPage.waitForSelector('[data-sim-audio-load]');
  await staticPage.locator('[data-sim-audio-load]').first().click();
  await staticPage.waitForSelector('#sim-logs-box audio');
  await staticPage.locator('#sim-logs-box .sim-history-transcript summary').first().click();
  assert.match(await staticPage.locator('#sim-logs-box').innerText(), /static recorded audio/);
  console.log('PASS Static recordings and transcripts survive reload in IndexedDB and play locally');

  await staticPage.selectOption('#sel-a', 'a_medicare');
  await staticPage.waitForSelector('#btn-call-nomic:enabled');
  await staticRecord('other agent recorded audio');
  await staticPage.selectOption('#sel-a', staticInitialAgent);
  await staticPage.waitForSelector('#sim-logs-box audio, [data-sim-audio-load]');
  staticPage.once('dialog', (dialog) => dialog.accept());
  await staticPage.click('#btn-clear-logs');
  await staticPage.waitForFunction(() => (document.querySelector('#sim-logs-box')?.textContent || '').includes('No locally recorded tests'));
  const legacy = await staticPage.evaluate(() => JSON.parse(localStorage.getItem('vac_cloud_sim_logs_v1')));
  assert.deepEqual(legacy.map((item) => item.id), ['legacy-b'], 'Clearing one agent must preserve another agent’s legacy logs');
  await staticPage.selectOption('#sel-a', 'a_medicare');
  await staticPage.waitForSelector('[data-sim-audio-load]');
  await staticPage.locator('#sim-logs-box .sim-history-transcript summary').first().click();
  assert.match(await staticPage.locator('#sim-logs-box').innerText(), /other agent recorded audio/);
  staticPage.once('dialog', (dialog) => dialog.accept());
  await staticPage.locator('[data-sim-audio-delete]').first().click();
  await staticPage.waitForFunction(() => (document.querySelector('#sim-logs-box')?.textContent || '').includes('Recording deleted.'));
  await staticPage.locator('#sim-logs-box .sim-history-transcript summary').first().click();
  assert.match(await staticPage.locator('#sim-logs-box').innerText(), /other agent recorded audio/, 'Audio deletion preserves local transcript');
  console.log('PASS Static clear and individual delete respect agent boundaries and preserve transcripts');

  // Seed older synthetic entries, then accelerate the 10-minute timer so the
  // retention cap and truncation behavior can be tested without a long call.
  await staticPage.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('vac-live-bot-recordings-v1');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result; const tx = db.transaction(['logs', 'audio'], 'readwrite');
      for (let i = 0; i < 20; i++) {
        const id = `synthetic-local-old-${i}`;
        tx.objectStore('logs').put({ id, agentId: 'a_medicare', startedAt: new Date(Date.UTC(2000, 0, 1, 0, 0, i)).toISOString(),
          durationMs: 1, turns: 0, transcript: [], functionCalls: [], recordingStatus: 'available', recordingBytes: 4, recordingMime: 'audio/webm' });
        tx.objectStore('audio').put({ id, blob: new Blob(['fake'], { type: 'audio/webm' }) });
      }
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = tx.onabort = () => reject(tx.error);
    };
  }));
  await staticPage.evaluate(() => {
    window.__realRecordingTimer = window.setTimeout;
    window.setTimeout = function (fn, delay, ...args) {
      // Allow at least one MediaRecorder timeslice before the synthetic limit.
      return window.__realRecordingTimer(fn, delay === 600000 ? 1800 : delay, ...args);
    };
  });
  await staticPage.check('#sim-record-audio');
  await staticPage.click('#btn-call-nomic');
  await staticPage.waitForSelector('#sim-inject-input:enabled');
  await staticPage.fill('#sim-inject-input', 'limited static recording');
  await staticPage.click('#btn-sim-inject');
  await staticPage.waitForFunction(() => /recording reached its 10-minute or size limit/i.test(document.querySelector('#sim-feed')?.textContent || ''), null, { timeout: 5000 });
  assert(await staticPage.locator('#sim-inject-input').isEnabled(), 'The test must continue after recording stops at the limit');
  await staticPage.click('#btn-call-hangup');
  await staticPage.waitForSelector('#btn-call-nomic:enabled', { timeout: 12000 });
  await staticPage.evaluate(() => { window.setTimeout = window.__realRecordingTimer; });
  try {
    await staticPage.waitForFunction(() => /truncated at recording limit/i.test(document.querySelector('#sim-logs-box')?.textContent || ''), null, { timeout: 8000 });
  } catch (err) {
    console.error('Recording-limit fixture diagnostics:', await staticPage.locator('#sim-logs-box').innerText(), await staticPage.locator('#sim-feed').innerText());
    throw err;
  }
  const retained = await staticPage.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('vac-live-bot-recordings-v1'); open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result, tx = db.transaction(['logs', 'audio']);
      const logs = tx.objectStore('logs').getAll(), keys = tx.objectStore('audio').getAllKeys();
      tx.oncomplete = () => { resolve({ logs: logs.result, keys: keys.result }); db.close(); };
      tx.onerror = tx.onabort = () => reject(tx.error);
    };
  }));
  assert.equal(retained.logs.length, 20);
  assert(!retained.keys.includes('synthetic-local-old-0'));
  assert(!retained.logs.some((item) => item.id === 'synthetic-local-old-0'));
  assert(retained.logs.some((item) => item.recordingTruncated === true));
  assert.equal(await staticPage.locator('#sim-logs-box .sim-history-transcript').count(), 6);
  await staticPage.locator('[data-sim-history-toggle]').click();
  assert.equal(await staticPage.locator('#sim-logs-box .sim-history-transcript').count(), 21, 'All retained tests including legacy entries must be discoverable');
  console.log('PASS Recording limit stops capture, marks truncation, and local retention deletes old audio; all history is discoverable');

  await staticPage.evaluate(() => Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined }));
  await staticPage.check('#sim-record-audio');
  await staticPage.click('#btn-call-nomic');
  await staticPage.waitForSelector('#sim-inject-input:enabled');
  assert.match(await staticPage.locator('#sim-feed').innerText(), /Greeting rotation storage is unavailable/i);
  assert.match(await staticPage.locator('#sim-selected-greeting').innerText(), /Selected greeting #\d+/);
  await staticPage.fill('#sim-inject-input', 'static fallback');
  await staticPage.click('#btn-sim-inject');
  await staticPage.waitForTimeout(700);
  await staticPage.click('#btn-call-hangup');
  await staticPage.waitForSelector('#btn-call-nomic:enabled', { timeout: 12000 });
  await staticPage.getByText('Audio was not saved or could not be confirmed in history.', { exact: true }).waitFor();
  assert.match(await staticPage.locator('a[download^="live-bot-"]').filter({ hasText: 'Download audio now' }).getAttribute('href'), /^blob:/);
  console.log('PASS Static storage failure exposes a temporary audio download');

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
