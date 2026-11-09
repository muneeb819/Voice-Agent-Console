import assert from 'assert';
import childProcess from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import WebSocket, { WebSocketServer } from 'ws';
import {
  exportBridgeLogsCsv, getConsoleState, getDb, getSimulatorCallLog, listBridgeCallLogs,
  listGreetingLibrary, saveConsoleState, selectGreetingForAgent,
} from '../src/db';
import { createDefaultState, normalizeState } from '../src/defaults';
import { loadBundledGreetings } from '../src/greetings';
import { composeOpening } from '../src/opening';
import { createServerWithSimulator } from '../src/server';
import { buildDeepgramSettings } from '../src/settings-builder';
import { runSimulatedViciBridgeCall } from '../src/vici-loopback-tester';

const root = path.resolve(__dirname, '..');
const sha256 = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function runWorker(script: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, ['-e', script, path.join(root, 'dist/db.js')], {
      cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) reject(new Error(`Greeting worker exited ${code}: ${stderr}`));
      else {
        try { resolve(JSON.parse(stdout)); } catch (err) { reject(err); }
      }
    });
  });
}

async function waitFor(events: any[], predicate: (event: any) => boolean, label: string): Promise<any> {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    const found = events.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(events)}`);
}

async function main() {
  // Exact attachment provenance plus all five fields/rows in both deployed copies.
  assert.equal(sha256(path.join(root, 'datasets/Greetings-Dataset.csv')), '505e33d80c9b4f3361feea73e484f7b0ad0deb508da21174c23596040ab2e4c0');
  assert.equal(sha256(path.join(root, 'public/greetings.json')), '09b991b2bacaabaa3f46c32db9aa9e782e3d904e874db3b384fd796e980d9003');
  assert.equal(sha256(path.join(root, 'docs/greetings.json')), sha256(path.join(root, 'public/greetings.json')));
  const rows = loadBundledGreetings();
  assert.equal(rows.length, 1100);
  assert.equal(new Set(rows.map((row) => row.greeting_id)).size, 1100);
  assert.deepEqual(JSON.parse(JSON.stringify(listGreetingLibrary())), rows);
  assert.equal(rows.filter((row) => row.context === 'Customer Service Call').length, 208);
  assert.ok(rows.some((row) => row.context === 'Team Meeting Start'));
  assert.deepEqual(rows[0], { greeting_id: '1', persona: 'Warm Hospitality', context: 'Customer Service Call',
    greeting_text: "Good afternoon! What exciting things are you working on? Let's get things rolling on a positive note!", tone: 'Upbeat' });
  console.log('✓ Exact 1,100-row CSV seed, metadata, SQLite import and static catalog parity');

  const defaults = createDefaultState();
  assert.ok(defaults.agents.every((agent) => agent.randomGreetingEnabled));
  const oldState: any = structuredClone(defaults);
  for (const agent of oldState.agents) delete agent.randomGreetingEnabled;
  oldState.agents.push({ ...structuredClone(oldState.agents[0]), id: 'new-bot', name: 'New Bot' });
  const migrated = normalizeState(oldState);
  assert.ok(migrated.agents.every((agent) => agent.randomGreetingEnabled));
  migrated.agents[0].randomGreetingEnabled = false;
  assert.equal(normalizeState(migrated).agents[0].randomGreetingEnabled, false);
  const agent = defaults.agents[0], campaign = defaults.campaigns.find((c) => c.agentId === agent.id)!;
  assert.equal(agent.injectCampaignDisclosure, false, 'New agents do not force a recording notice');
  const preview = buildDeepgramSettings(defaults, agent, campaign);
  const withVariation = buildDeepgramSettings(defaults, agent, campaign, { greetingText: rows[0].greeting_text });
  assert.equal(preview.agent.greeting, agent.greeting);
  assert.equal(withVariation.agent.greeting, composeOpening(agent.greeting, rows[0].greeting_text, false, campaign.disclosure));
  assert.ok(!withVariation.agent.greeting.includes(rows[0].greeting_text), 'Never append a complete extra greeting');
  assert.equal(buildDeepgramSettings(defaults, { ...agent, randomGreetingEnabled: false }, campaign,
    { greetingText: rows[0].greeting_text }).agent.greeting, preview.agent.greeting);
  const optedIn = { ...agent, injectCampaignDisclosure: true };
  assert.equal(buildDeepgramSettings(defaults, optedIn, campaign, { greetingText: rows[0].greeting_text }).agent.greeting,
    `${campaign.disclosure} ${withVariation.agent.greeting}`);
  const alreadyDisclosed = { ...agent, injectCampaignDisclosure: true, greeting: `${campaign.disclosure} ${agent.greeting}` };
  assert.equal(buildDeepgramSettings(defaults, alreadyDisclosed, campaign).agent.greeting,
    `${campaign.disclosure} ${agent.greeting}`);
  console.log('✓ Default rotation, saved-opening fallback and optional notice without a second greeting');

  // A draw is uniformly random among remaining entries, with an independent
  // persistent cursor per bot and no repeat even across the cycle boundary.
  const selected = Array.from({ length: 1100 }, () => selectGreetingForAgent('cycle-test')!.greeting_id);
  assert.equal(new Set(selected).size, 1100);
  const next = selectGreetingForAgent('cycle-test')!.greeting_id;
  assert.notEqual(next, selected[selected.length - 1]);
  assert.equal(selectGreetingForAgent('independent-bot') !== null, true);
  const count = getDb().prepare('SELECT COUNT(*) AS n FROM greeting_rotation_used WHERE agent_id = ?').get('independent-bot');
  assert.equal(Number(count.n), 1);
  const workerScript = `const db=require(process.argv[1]); const ids=[]; for(let i=0;i<25;i++) ids.push(db.selectGreetingForAgent('concurrent-bot').greeting_id); console.log(JSON.stringify(ids));`;
  const workerResults = await Promise.all([runWorker(workerScript), runWorker(workerScript), runWorker(workerScript)]);
  const concurrent = workerResults.flat();
  assert.equal(concurrent.length, 75);
  assert.equal(new Set(concurrent).size, 75, 'Concurrent processes must not select an already-used greeting');
  assert.equal(listGreetingLibrary().length, 1100, 'Repeated process startup must not duplicate the import');
  console.log('✓ Complete no-repeat cycle, boundary, independent bots, restarts and concurrent SQLite selectors');

  // Distinct IDs can map to identical short openings. Prefer the different
  // wording without consuming the matching row or breaking the no-repeat cycle.
  const exampleOpening = 'Hi, this is Jessi from Example. How are you doing?';
  const wording = (row: typeof rows[number]) => composeOpening(exampleOpening, row.greeting_text, false, '');
  const firstRow = rows[0];
  const sameRow = rows.find((row) => row.greeting_id !== firstRow.greeting_id && wording(row) === wording(firstRow))!;
  const differentRow = rows.find((row) => wording(row) !== wording(firstRow))!;
  assert.ok(sameRow && differentRow);
  const rotationDb = getDb();
  rotationDb.transaction(() => {
    rotationDb.prepare(`INSERT INTO greeting_rotation_used (agent_id, greeting_id)
      SELECT ?, greeting_id FROM greeting_library WHERE greeting_id NOT IN (?, ?)`)
      .run('wording-test', sameRow.greeting_id, differentRow.greeting_id);
    rotationDb.prepare('INSERT INTO greeting_rotation_state (agent_id, last_greeting_id) VALUES (?, ?)')
      .run('wording-test', firstRow.greeting_id);
  })();
  assert.equal(selectGreetingForAgent('wording-test', exampleOpening)!.greeting_id, differentRow.greeting_id);
  assert.equal(selectGreetingForAgent('wording-test', exampleOpening)!.greeting_id, sameRow.greeting_id, 'Do not discard the matching ID');
  rotationDb.prepare(`INSERT INTO greeting_rotation_used (agent_id, greeting_id)
    SELECT ?, greeting_id FROM greeting_library WHERE greeting_id <> ?`).run('forced-repeat', sameRow.greeting_id);
  rotationDb.prepare('INSERT INTO greeting_rotation_state (agent_id, last_greeting_id) VALUES (?, ?)')
    .run('forced-repeat', firstRow.greeting_id);
  assert.equal(selectGreetingForAgent('forced-repeat', exampleOpening)!.greeting_id, sameRow.greeting_id,
    'If no other wording remains, finish the ID cycle rather than inventing text or losing rows');
  console.log('✓ Rotation prefers different wording where possible and preserves every ID when repeats are unavoidable');

  const state = getConsoleState();
  const sttProvider = state.providers.find((provider) => provider.kind === 'stt')!;
  const llmProvider = state.providers.find((provider) => provider.kind === 'llm' && provider.type === 'open_ai')!;
  const ttsProvider = state.providers.find((provider) => provider.kind === 'tts' && provider.type === 'deepgram')!;
  state.services = {
    stt: { providerId: sttProvider.id, model: 'nova-3' },
    llm: { providerId: llmProvider.id, model: 'gpt-4o-mini' },
    tts: { providerId: ttsProvider.id, model: 'aura-2-thalia-en' },
  };
  const a1 = state.agents.find((a) => a.id === 'a1')!;
  const liveCampaign = state.campaigns.find((entry) => entry.agentId === a1.id) || state.campaigns[0];
  assert.ok(liveCampaign, 'Greeting integration fixture requires an explicit campaign');
  liveCampaign.agentId = a1.id;
  liveCampaign.complianceRules = 'Reviewed greeting fixture rules: identify accurately, avoid unsupported claims, and honor do-not-call requests immediately.';
  for (const fixtureCampaign of state.campaigns) {
    fixtureCampaign.complianceRules = fixtureCampaign.complianceRules || liveCampaign.complianceRules;
    if (String(fixtureCampaign.complianceRules).trim().length < 20 || /^REVIEW REQUIRED\b/i.test(fixtureCampaign.complianceRules)) fixtureCampaign.complianceRules = liveCampaign.complianceRules;
  }
  a1.greeting = 'Hello {{first_name}}, from the example team.';
  a1.randomGreetingEnabled = true;
  a1.injectCampaignDisclosure = true;
  saveConsoleState(state, 'Greeting integration fixture');
  const savedState = getConsoleState();
  const disclosure = savedState.campaigns.find((c) => c.agentId === 'a1')!.disclosure;

  const settingsReceived: any[] = [];
  const provider = http.createServer();
  const providerWss = new WebSocketServer({ server: provider, path: '/agent' });
  providerWss.on('connection', (ws) => {
    let received: any;
    ws.send(JSON.stringify({ type: 'Welcome' }));
    ws.on('message', (data, binary) => {
      if (!binary) {
        const message = JSON.parse(data.toString());
        if (message.type === 'Settings') {
          const prompt = String(message.agent?.think?.prompt || '');
          const marker = 'The assigned opening is: ';
          const markerAt = prompt.indexOf(marker);
          let delayedGreeting = '';
          if (markerAt >= 0) {
            const raw = prompt.slice(markerAt + marker.length).split('. Honor requests to stop')[0];
            try { delayedGreeting = JSON.parse(raw); } catch {}
          }
          received = { settings: message, delayedGreeting, appliedAt: Date.now(), openings: [] };
          settingsReceived.push(received);
          ws.send(JSON.stringify({ type: 'SettingsApplied' }));
        } else if (message.type === 'InjectAgentMessage') {
          received.openings.push({ message: message.message, at: Date.now() });
          ws.send(JSON.stringify({ type: 'AgentStartedSpeaking' }));
          ws.send(JSON.stringify({ type: 'ConversationText', role: 'assistant', content: message.message }));
          ws.send(JSON.stringify({ type: 'AgentAudioDone' }));
        } else if (message.type === 'InjectUserMessage') {
          ws.send(JSON.stringify({ type: 'UserStartedSpeaking' }));
          ws.send(JSON.stringify({ type: 'ConversationText', role: 'user', content: message.content }));
          ws.send(JSON.stringify({ type: 'AgentThinking' }));
          ws.send(JSON.stringify({ type: 'AgentStartedSpeaking' }));
          ws.send(JSON.stringify({ type: 'ConversationText', role: 'assistant', content: received.delayedGreeting || 'Hello, how can I help?' }));
          ws.send(JSON.stringify({ type: 'AgentAudioDone' }));
        }
      }
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const oldEnv = { key: process.env.DEEPGRAM_API_KEY, url: process.env.DEEPGRAM_AGENT_URL, allowed: process.env.BRIDGE_ALLOWED_IPS };
  process.env.DEEPGRAM_API_KEY = 'synthetic-greetings-key';
  process.env.DEEPGRAM_AGENT_URL = `ws://127.0.0.1:${(provider.address() as any).port}/agent`;
  process.env.BRIDGE_ALLOWED_IPS = '*';
  const { server, viciBridge } = createServerWithSimulator({ enableBridge: true, host: 'localhost', audioSocketPort: 0, sipPort: 0 });
  await viciBridge!.start();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;

  async function session(agentId = 'a1') {
    const events: any[] = [];
    const index = settingsReceived.length;
    const sessionCampaign = getConsoleState().campaigns.find((entry) => entry.agentId === agentId)!;
    assert.ok(sessionCampaign, `No explicitly assigned campaign for ${agentId}`);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/simulator`);
    ws.on('message', (data, binary) => { if (!binary) events.push(JSON.parse(data.toString())); });
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.send(JSON.stringify({ type: 'start', agentId, campaignId: sessionCampaign.id, upstreamMode: 'deepgram',
      lead: { first_name: 'Example', state: 'TX', lead_id: '123' } }));
    const started = await waitFor(events, (event) => event.type === 'session_started', 'session start');
    const received = settingsReceived[index];
    const wire = received.settings;
    assert.equal(wire.agent.greeting, undefined, 'Do not allow the provider to speak its automatic greeting');
    const opening = await waitFor(received.openings, () => true, 'configured opening after silence');
    assert.equal(opening.message, started.settings.agent.greeting);
    assert.ok(opening.at - received.appliedAt >= 990, 'The configured opening waits a full second after readiness');
    assert.equal(received.openings.length, 1);
    assert.equal(received.delayedGreeting, started.settings.agent.greeting, 'Provider prompt and display use the same selected campaign opening');
    const reply = await waitFor(events, (event) => event.type === 'transcript' && event.role === 'assistant' &&
      event.content === started.settings.agent.greeting, 'configured opening spoken to a silent caller');
    ws.send(JSON.stringify({ type: 'stop' }));
    const ended = await waitFor(events, (event) => event.type === 'call_ended', 'session end');
    assert.equal(ended.logSaved, true);
    const log = getSimulatorCallLog(started.callId)!;
    assert.equal(log.greetingId, started.greeting?.greeting_id || null);
    return { started, ended, wire, opening: reply.content as string, injectedOpening: opening.message as string, log, events };
  }

  try {
    const api = await (await fetch(`http://127.0.0.1:${port}/api/greetings`)).json() as any;
    assert.equal(api.count, 1100);
    assert.equal(api.greetings[0].greeting_id, '1');
    const first = await session();
    const second = await session();
    assert.notEqual(first.started.greeting.greeting_id, second.started.greeting.greeting_id);
    assert.notEqual(first.opening, second.opening, 'Consecutive sessions prefer different wording');
    for (const call of [first, second]) {
      assert.equal(call.opening, composeOpening(a1.greeting, call.started.greeting.greeting_text, true, disclosure)
        .replace('{{first_name}}', 'Example'));
      assert.ok(!call.opening.includes(call.started.greeting.greeting_text));
    }
    const nova = await session('a_nova');
    assert.ok(nova.started.greeting?.greeting_id, 'All bots should select from the shared catalog');
    const logs = await (await fetch(`http://127.0.0.1:${port}/api/simulator/logs?agentId=a1`)).json() as any;
    assert.ok(logs.logs.some((log: any) => log.id === first.started.callId && log.greetingId === first.started.greeting.greeting_id));
    console.log('✓ Mock Live Bot sessions select once, hydrate the lead, retain intro/disclosure and log distinct IDs');

    // The selected library text is not appended; the saved intro is hydrated.
    const conn = getDb();
    conn.prepare('INSERT INTO greeting_library VALUES (?, ?, ?, ?, ?)')
      .run('fixture-lead', 'Fixture', 'Fixture', 'Extra hello {{first_name}} in {{state}}.', 'Warm');
    const forceFixture = () => {
      conn.prepare('DELETE FROM greeting_rotation_used WHERE agent_id = ?').run('a1');
      conn.prepare(`INSERT INTO greeting_rotation_used (agent_id, greeting_id)
        SELECT ?, greeting_id FROM greeting_library WHERE greeting_id <> ?`).run('a1', 'fixture-lead');
    };
    forceFixture();
    const hydrated = await session();
    assert.equal(hydrated.started.greeting.greeting_id, 'fixture-lead');
    assert.equal(hydrated.opening, composeOpening(a1.greeting, 'Extra hello {{first_name}} in {{state}}.', true, disclosure)
      .replace('{{first_name}}', 'Example'));
    assert.ok(!hydrated.opening.includes('Extra hello'));

    forceFixture();
    const bridgeCall = await runSimulatedViciBridgeCall(viciBridge!, {
      transport: 'audiosocket', scenario: 'dnc_request', upstream: 'mock_ai', campaignId: liveCampaign.id,
    });
    assert.equal(bridgeCall.cdr.greetingId, 'fixture-lead');
    const bridgeOpening = bridgeCall.cdr.transcript.find((entry) => entry.role === 'assistant')?.content || '';
    assert.match(bridgeOpening, /Hello|Hi|Hey/, 'Silent bridge calls receive the selected opening before the synthetic caller reply');
    assert.equal(bridgeCall.cdr.disposition, 'DNC', 'Only the explicit caller request changes disposition');
    assert.equal(listBridgeCallLogs(10).find((log) => log.id === bridgeCall.cdr.id)?.greetingId, 'fixture-lead');
    assert.match(exportBridgeLogsCsv(), /greeting_id/);
    assert.match(exportBridgeLogsCsv(), /fixture-lead/);
    console.log('✓ Mock VICIdial bridge sends the same selected greeting with hydrated lead data and persists/export its ID');

    const disabledState = getConsoleState();
    disabledState.agents.find((a) => a.id === 'a1')!.randomGreetingEnabled = false;
    saveConsoleState(disabledState, 'Opt out fixture');
    const usedBefore = Number(conn.prepare('SELECT COUNT(*) AS n FROM greeting_rotation_used WHERE agent_id = ?').get('a1').n);
    const disabled = await session();
    assert.equal(disabled.started.greeting, null);
    assert.equal(disabled.opening, `${disclosure} Hello Example, from the example team.`);
    assert.equal(Number(conn.prepare('SELECT COUNT(*) AS n FROM greeting_rotation_used WHERE agent_id = ?').get('a1').n), usedBefore);

    disabledState.agents.find((a) => a.id === 'a1')!.randomGreetingEnabled = true;
    saveConsoleState(disabledState, 'Restore rotation fixture');
    conn.exec("CREATE TRIGGER greeting_test_failure BEFORE INSERT ON greeting_rotation_used BEGIN SELECT RAISE(ABORT, 'synthetic rotation error'); END");
    try {
      const fallback = await session();
      assert.equal(fallback.started.greeting, null);
      assert.ok(fallback.events.some((event) => event.type === 'warning' && event.code === 'GREETING_LIBRARY_UNAVAILABLE'));
      assert.equal(fallback.opening, `${disclosure} Hello Example, from the example team.`);
      assert.equal(fallback.log.greetingId, null);
    } finally { conn.exec('DROP TRIGGER greeting_test_failure'); }
    console.log('✓ Opt-out and rotation failure fall back to the configured opening without consuming a selection');
  } finally {
    providerWss.clients.forEach((client) => client.terminate());
    providerWss.close();
    provider.close();
    await viciBridge!.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const [name, value] of Object.entries({ DEEPGRAM_API_KEY: oldEnv.key, DEEPGRAM_AGENT_URL: oldEnv.url, BRIDGE_ALLOWED_IPS: oldEnv.allowed })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
