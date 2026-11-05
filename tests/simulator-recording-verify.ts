import assert from 'assert';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import childProcess from 'child_process';
import WebSocket, { WebSocketServer } from 'ws';
import { createSessionToken } from '../src/auth-guard';
import { getConsoleState, getDb, getSimulatorCallLog, listSimulatorCallLogs, saveConsoleState, saveSimulatorCallLog } from '../src/db';
import { createServerWithSimulator } from '../src/server';
import { isSupportedRecording, removeSimulatorRecording, SIMULATOR_RECORDINGS_DIR, writeSimulatorRecording } from '../src/simulator-recordings';

const audio = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86]);

async function waitFor(queue: any[], type: string): Promise<any> {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const event = queue.find((item) => item.type === type);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${type}`);
}

async function main() {
  // Open a real pre-recording schema in a separate process/data directory.
  const migrationDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vac-recording-migration-'));
  try {
    const script = `
      const assert = require('node:assert/strict');
      const file = require('node:path').join(process.env.VAC_DATA_DIR, 'console.sqlite');
      let db;
      try { const Better = require('better-sqlite3'); db = new Better(file); }
      catch { const { DatabaseSync } = require('node:sqlite'); db = new DatabaseSync(file); }
      db.exec(\`CREATE TABLE simulator_calls (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, agent_name TEXT NOT NULL,
        campaign_id TEXT, upstream_mode TEXT NOT NULL, sample_rate_in INTEGER NOT NULL,
        sample_rate_out INTEGER NOT NULL, started_at TEXT NOT NULL, ended_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL, turns INTEGER NOT NULL, avg_ttfb_ms INTEGER,
        disposition TEXT, transferred_to TEXT, transcript_json TEXT NOT NULL, functions_json TEXT NOT NULL
      );
      INSERT INTO simulator_calls VALUES ('legacy', 'a1', 'Legacy', NULL, 'deepgram', 16000, 24000,
        '2020-01-01', '2020-01-01', 1, 1, NULL, NULL, NULL,
        '[{"ts":"2020-01-01","role":"user","content":"original transcript"}]', '[]');\`);
      db.close();
      const migrated = require(process.argv[1]).getSimulatorCallLog('legacy');
      assert.equal(migrated.recordingRequested, false);
      assert.equal(migrated.recordingStatus, 'not_requested');
      assert.equal(migrated.transcript[0].content, 'original transcript');
    `;
    childProcess.execFileSync(process.execPath, ['-e', script, path.resolve(__dirname, '../dist/db.js')], {
      cwd: path.resolve(__dirname, '..'), env: { ...process.env, VAC_DATA_DIR: migrationDir }, stdio: 'pipe',
    });
    console.log('✓ Legacy SQLite history migrates without inventing audio or losing transcripts');
  } finally { fs.rmSync(migrationDir, { recursive: true, force: true }); }
  const old = {
    key: process.env.DEEPGRAM_API_KEY, url: process.env.DEEPGRAM_AGENT_URL,
    admin: process.env.ADMIN_PASSWORD,
  };
  const state = getConsoleState();
  state.services = {
    stt: { providerId: 's1', model: 'nova-3' },
    llm: { providerId: 'l1', model: 'gpt-4o-mini' },
    tts: { providerId: 't1', model: 'aura-2-thalia-en' },
  };
  saveConsoleState(state, 'Recording fixture');
  const mock = http.createServer();
  const wss = new WebSocketServer({ server: mock, path: '/agent' });
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'Welcome' }));
    ws.on('message', (raw, binary) => {
      if (!binary && JSON.parse(raw.toString()).type === 'Settings') {
        ws.send(JSON.stringify({ type: 'SettingsApplied' }));
        ws.send(JSON.stringify({ type: 'ConversationText', role: 'assistant', content: 'Synthetic provider transcript.' }));
      }
    });
  });
  await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
  process.env.DEEPGRAM_AGENT_URL = `ws://127.0.0.1:${(mock.address() as any).port}/agent`;
  process.env.DEEPGRAM_API_KEY = 'synthetic-test-key';
  process.env.ADMIN_PASSWORD = 'synthetic-recording-admin';
  const token = createSessionToken();
  const { server } = createServerWithSimulator();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const auth = { Authorization: `Bearer ${token}` };
  const uploadHeaders = { ...auth, 'Content-Type': 'application/octet-stream', 'X-Recording-Type': 'audio/webm', 'X-Recording-Truncated': '1' };

  async function session(recordAudio: boolean | undefined, agentId = 'a1'): Promise<string> {
    const events: any[] = [];
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws/simulator', { headers: auth });
    ws.on('message', (raw, binary) => { if (!binary) events.push(JSON.parse(raw.toString())); });
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.send(JSON.stringify({ type: 'start', agentId, upstreamMode: 'deepgram', ...(recordAudio === undefined ? {} : { recordAudio }) }));
    const started = await waitFor(events, 'session_started');
    await waitFor(events, 'transcript');
    ws.send(JSON.stringify({ type: 'stop' }));
    const ended = await waitFor(events, 'call_ended');
    assert.strictEqual(ended.logSaved, true);
    assert.strictEqual(started.recordingRequested, recordAudio === true);
    return started.callId;
  }

  async function upload(id: string, body = audio, headers: Record<string, string> = uploadHeaders) {
    return fetch(`${base}/api/simulator/recordings/${id}`, { method: 'PUT', headers, body });
  }

  try {
    assert.strictEqual(isSupportedRecording(audio, 'audio/webm'), true);
    assert.strictEqual(isSupportedRecording(Buffer.from('OggSfixture'), 'audio/ogg'), true);
    assert.strictEqual(isSupportedRecording(Buffer.from([0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0]), 'audio/mp4'), true);
    assert.strictEqual(isSupportedRecording(audio, 'audio/mp4'), false);
    assert.throws(() => removeSimulatorRecording('../private.webm'), /Invalid browser recording filename/);
    const off = await session(undefined);
    assert.strictEqual(getSimulatorCallLog(off)?.recordingStatus, 'not_requested');
    assert.strictEqual((await upload(off)).status, 409);
    assert.strictEqual(fs.existsSync(SIMULATOR_RECORDINGS_DIR), false, 'No recording directory is created without opt-in');
    console.log('✓ Recording defaults off and non-opted-in logs reject audio uploads');

    const id = await session(true);
    assert.strictEqual(getSimulatorCallLog(id)?.recordingStatus, 'pending');
    assert.strictEqual((await upload(id, Buffer.alloc(20 * 1024 * 1024 + 1))).status, 413, 'The server must enforce the 20 MiB limit');
    assert.strictEqual((await upload(id, Buffer.from('<html>not audio</html>'))).status, 400);
    assert.strictEqual((await upload(id, audio, { ...uploadHeaders, Origin: 'https://attacker.example' })).status, 403);
    assert.strictEqual((await fetch(`${base}/api/simulator/recordings/${id}`)).status, 401);
    getDb().exec("CREATE TRIGGER test_record_attach_failure BEFORE UPDATE OF recording_status ON simulator_calls WHEN NEW.recording_status = 'available' BEGIN SELECT RAISE(ABORT, 'test'); END");
    try {
      assert.strictEqual((await upload(id)).status, 500);
      assert.strictEqual(fs.readdirSync(SIMULATOR_RECORDINGS_DIR).length, 0, 'A failed DB attach must remove the newly written file');
      assert.strictEqual(getSimulatorCallLog(id)?.recordingStatus, 'pending');
    } finally { getDb().exec('DROP TRIGGER test_record_attach_failure'); }
    const saved = await upload(id);
    assert.strictEqual(saved.status, 201);
    const log = getSimulatorCallLog(id)!;
    assert.strictEqual(log.recordingStatus, 'available');
    assert.strictEqual(log.recordingTruncated, true);
    assert.strictEqual(log.recordingBytes, audio.length);
    const file = path.join(SIMULATOR_RECORDINGS_DIR, log.recordingFile!);
    assert.deepStrictEqual(fs.readFileSync(file), audio);
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(SIMULATOR_RECORDINGS_DIR).mode & 0o777, 0o700);
      assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    }
    assert.strictEqual((await upload(id)).status, 409, 'An existing recording cannot be overwritten');
    const response = await fetch(`${base}/api/simulator/recordings/${id}`, { headers: auth });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers.get('content-type'), 'audio/webm');
    assert.match(response.headers.get('cache-control') || '', /no-store/);
    assert.deepStrictEqual(Buffer.from(await response.arrayBuffer()), audio);
    const range = await fetch(`${base}/api/simulator/recordings/${id}`, { headers: { ...auth, Range: 'bytes=0-3' } });
    assert.strictEqual(range.status, 206);
    assert.deepStrictEqual(Buffer.from(await range.arrayBuffer()), audio.subarray(0, 4));
    if (process.platform !== 'win32') {
      const heldDir = `${SIMULATOR_RECORDINGS_DIR}-test-held`;
      fs.renameSync(SIMULATOR_RECORDINGS_DIR, heldDir);
      fs.symlinkSync(heldDir, SIMULATOR_RECORDINGS_DIR, 'dir');
      try {
        assert.strictEqual((await fetch(`${base}/api/simulator/recordings/${id}`, { headers: auth })).status, 500);
        assert.strictEqual((await fetch(`${base}/api/simulator/recordings/${id}`, { method: 'DELETE', headers: auth })).status, 500);
        assert.strictEqual(fs.existsSync(path.join(heldDir, log.recordingFile!)), true);
      } finally {
        fs.unlinkSync(SIMULATOR_RECORDINGS_DIR);
        fs.renameSync(heldDir, SIMULATOR_RECORDINGS_DIR);
      }
    }
    console.log('✓ Opt-in upload, authorization, private storage, safe failures, and audio playback endpoint');

    const temporarilyHeld = `${file}.test-held`;
    fs.renameSync(file, temporarilyHeld);
    fs.mkdirSync(file); // A directory at the file path makes unlink fail without using real operator data.
    try {
      assert.strictEqual((await fetch(`${base}/api/simulator/recordings/${id}`, { method: 'DELETE', headers: auth })).status, 500);
      assert.strictEqual(getSimulatorCallLog(id)?.recordingStatus, 'available', 'Failed deletion must not claim success');
    } finally {
      fs.rmdirSync(file);
      fs.renameSync(temporarilyHeld, file);
    }
    assert.strictEqual((await fetch(`${base}/api/simulator/recordings/${id}`, { method: 'DELETE', headers: auth })).status, 200);
    assert.strictEqual(fs.existsSync(file), false);
    assert.strictEqual(getSimulatorCallLog(id)?.recordingStatus, 'deleted');
    assert.ok(getSimulatorCallLog(id)?.transcript.length, 'Deleting audio must preserve the transcript');
    assert.strictEqual((await fetch(`${base}/api/simulator/recordings/${id}`, { headers: auth })).status, 404);
    assert.strictEqual((await upload(id)).status, 409, 'Deleted audio cannot be silently recreated');
    console.log('✓ Individual recording deletion preserves transcript and prevents replacement');

    const a = await session(true, 'a1');
    const b = await session(true, 'a_nova');
    assert.strictEqual((await upload(a)).status, 201);
    assert.strictEqual((await upload(b)).status, 201);
    const pathA = path.join(SIMULATOR_RECORDINGS_DIR, getSimulatorCallLog(a)!.recordingFile!);
    const pathB = path.join(SIMULATOR_RECORDINGS_DIR, getSimulatorCallLog(b)!.recordingFile!);
    fs.renameSync(pathA, `${pathA}.test-held`);
    fs.mkdirSync(pathA);
    try {
      const failure = await fetch(`${base}/api/simulator/logs?agentId=a1`, { method: 'DELETE', headers: auth });
      assert.strictEqual(failure.status, 500);
      assert.match((await failure.json() as any).error, /some audio may already have been removed/);
      assert.ok(getSimulatorCallLog(a), 'Failed clear must preserve the database history');
      assert.strictEqual(fs.existsSync(pathB), true);
    } finally {
      fs.rmdirSync(pathA);
      fs.renameSync(`${pathA}.test-held`, pathA);
    }
    assert.strictEqual((await fetch(`${base}/api/simulator/logs?agentId=a1`, { method: 'DELETE', headers: auth })).status, 200);
    assert.strictEqual(fs.existsSync(pathA), false);
    assert.strictEqual(fs.existsSync(pathB), true);
    assert.ok(getSimulatorCallLog(b), 'Clearing one agent must not remove another agent’s history');
    console.log('✓ Clearing an agent’s history deletes only its own attached audio');

    const oldId = 'sim_old_abcdef';
    const oldFile = writeSimulatorRecording(oldId, audio, 'audio/webm');
    const record = {
      id: oldId, agentId: 'old', agentName: 'Old', campaignId: null, upstreamMode: 'deepgram' as const,
      sampleRateIn: 16000, sampleRateOut: 24000, startedAt: '2000-01-01T00:00:00.000Z', endedAt: '2000-01-01T00:00:01.000Z',
      durationMs: 1000, turns: 0, avgTtfbMs: null, disposition: null, transferredTo: null,
      recordingRequested: true, recordingStatus: 'available' as const, recordingFile: oldFile, recordingMime: 'audio/webm',
      recordingBytes: audio.length, transcript: [], functionCalls: [],
    };
    saveSimulatorCallLog(record);
    for (let i = 0; i < 100; i++) {
      saveSimulatorCallLog({ ...record, id: `filler-${i}`, startedAt: new Date(Date.now() + i * 1000).toISOString(),
        recordingRequested: false, recordingStatus: 'not_requested', recordingFile: null, recordingMime: null, recordingBytes: 0 });
    }
    assert.strictEqual(getSimulatorCallLog(oldId), null);
    assert.strictEqual(fs.existsSync(path.join(SIMULATOR_RECORDINGS_DIR, oldFile)), false);
    assert.strictEqual(listSimulatorCallLogs(undefined, 200).length, 100);
    const defaultHistory = await fetch(`${base}/api/simulator/logs?agentId=old`, { headers: auth });
    assert.match(defaultHistory.headers.get('cache-control') || '', /no-store/);
    assert.strictEqual((await defaultHistory.json() as any).count, 20);
    assert.strictEqual((await (await fetch(`${base}/api/simulator/logs?agentId=old&limit=100`, { headers: auth })).json() as any).count, 100);
    assert.strictEqual((await (await fetch(`${base}/api/simulator/logs?agentId=old&limit=999999`, { headers: auth })).json() as any).count, 100);
    console.log('✓ History retention removes audio for evicted test logs and exposes at most 100 retained entries');
  } finally {
    if (old.key === undefined) delete process.env.DEEPGRAM_API_KEY; else process.env.DEEPGRAM_API_KEY = old.key;
    if (old.url === undefined) delete process.env.DEEPGRAM_AGENT_URL; else process.env.DEEPGRAM_AGENT_URL = old.url;
    if (old.admin === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = old.admin;
    wss.clients.forEach((ws) => ws.terminate());
    wss.close();
    server.close();
    mock.close();
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
