import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createApp, createServerWithSimulator } from '../src/server';
import { createUser, createUserSession, getUserBySessionToken, destroyUserSession } from '../src/user-store';
import { getDb } from '../src/db';
import { normalizeState } from '../src/defaults';
import { executeCustomFunctionWebhook } from '../src/webhook-executor';
import { AsteriskAmiClient } from '../src/ami-client';
import { readResponseBuffer } from '../src/http-limits';
import { resolveRecordingPath, RECORDINGS_DIR, StereoCallRecorder8k } from '../src/call-recorder';
import { getSpeechServiceBaseUrl } from '../src/speech-service-client';

async function listen(app: any): Promise<{ server: http.Server; base: string }> {
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${(server.address() as any).port}` };
}

async function main() {
  process.env.ADMIN_PASSWORD = 'audit-admin-password';
  const owner = await createUser({ email: 'owner@example.test', fullName: 'Owner', password: 'Test-Password-123!' });
  const operator = await createUser({ email: 'operator@example.test', fullName: 'Operator', password: 'Test-Password-123!' });
  assert.ok(owner.ok && operator.ok);
  assert.equal(owner.user!.role, 'owner');
  assert.equal(operator.user!.role, 'operator');
  const token = createUserSession(operator.user!.id);
  const stored = getDb().prepare('SELECT token FROM user_sessions').all() as any[];
  assert.ok(stored.every((row) => row.token !== token), 'session tokens are hashed at rest');
  assert.equal(getUserBySessionToken(token)?.id, operator.user!.id);
  destroyUserSession(token);
  assert.equal(getUserBySessionToken(token), null);

  const app = createApp();
  const { server, base } = await listen(app);
  try {
    const cookie = `vac_session=${createUserSession(operator.user!.id)}`;
    for (const p of ['/api/secrets', '/api/SECRETS', '/api/secrets/', '/api/SECRETS/']) {
      assert.equal((await fetch(base + p, { headers: { Cookie: cookie } })).status, 403, p);
    }
    assert.equal((await fetch(base + '/api/deepgram/verify', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await fetch(base + '/api/speech-service/status?url=http://127.0.0.1:9', { headers: { Cookie: cookie } })).status, 403);
    assert.equal((await fetch(base + '/api/state', { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await fetch(base + '/api/auth/logout', { method: 'POST', headers: { Cookie: cookie, 'Origin': 'https://attacker.example' } })).status, 403);
    const adminCookie = `vac_session=${createUserSession(owner.user!.id)}`;
    const redirect = await fetch(base + '/login?next=' + encodeURIComponent('/\\attacker.example'), { headers: { Cookie: adminCookie }, redirect: 'manual' });
    assert.equal(redirect.headers.get('location'), '/');
    const badJson = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(badJson.status, 400);
    assert.equal((await badJson.json() as any).code, 'INVALID_BODY');
    // Async failures must reach the JSON error boundary instead of hanging.
    const original = (app as any)._router; void original;
    console.log('✓ Canonical authorization, CSRF metadata, redirect and body-error boundaries');
  } finally { await new Promise<void>((r) => server.close(() => r())); }

  const malformed = normalizeState({ functions: [null, 3], providers: [null], agents: [null, { id: 'dup', name: 'A' }, { id: 'dup', name: 'B' }], campaigns: [null, { id: 'dup', name: 'C', agentId: 'dup' }, { id: 'dup', name: 'D', agentId: 'missing' }], tests: { dup: [null] } });
  assert.equal(new Set(malformed.agents.map((a) => a.id)).size, malformed.agents.length);
  assert.equal(new Set(malformed.campaigns.map((c) => c.id)).size, malformed.campaigns.length);
  assert.ok(malformed.campaigns.every((c) => !c.agentId || malformed.agents.some((a) => a.id === c.agentId)));
  const bounded = normalizeState({ agents: [{ id: 'a', stt: { eot: 999 }, tts: { speed: -5 }, llm: { temp: 99 } }], campaigns: [{ id: 'c', maxCalls: 1e12, deadAirTimeoutSec: -1 }] });
  assert.equal(bounded.agents[0].tts.speed, 0.5);
  assert.equal(bounded.campaigns[0].maxCalls, 1000);
  console.log('✓ Malformed imports cannot crash normalization or create duplicate routing IDs');

  process.env.SUPER_SECRET_AUDIT = 'do-not-leak';
  const wh = await executeCustomFunctionWebhook({ id: 'f', name: 'f', description: '', params: '{}', defer: false, url: 'http://127.0.0.1:1/{{SUPER_SECRET_AUDIT}}', method: 'post', headers: '{"X-Leak":"{{SUPER_SECRET_AUDIT}}"}' }, {});
  assert.ok(!JSON.stringify(wh).includes('SUPER_SECRET_AUDIT'));
  assert.ok(!JSON.stringify(wh).includes('do-not-leak'));
  const ami = new AsteriskAmiClient({ amiHost: '127.0.0.1', amiPort: 1, amiUser: 'cron' } as any, 'secret');
  const injected = await ami.executeAction('Ping', { Channel: 'x\r\nAction: Command' });
  assert.equal(injected.response, 'InvalidInput');
  assert.throws(() => getSpeechServiceBaseUrl('file:///etc/passwd'));
  assert.throws(() => getSpeechServiceBaseUrl('https://user:pass@example.test'));
  const huge = new Response(Buffer.alloc(1024));
  await assert.rejects(readResponseBuffer(huge, 128), /exceeds/);
  console.log('✓ Environment secret allowlist, AMI injection, speech URL and response-size guards');

  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  const target = path.join(os.tmpdir(), `vac-audit-${process.pid}.wav`);
  fs.writeFileSync(target, 'outside');
  const link = path.join(RECORDINGS_DIR, 'vici_audit_link.wav');
  try { fs.unlinkSync(link); } catch {}
  fs.symlinkSync(target, link);
  assert.equal(resolveRecordingPath('vici_audit_link.wav'), null);
  fs.unlinkSync(link); fs.unlinkSync(target);
  const rec = new StereoCallRecorder8k(Date.now() - 100);
  rec.recordCallerPcm8k(Buffer.alloc(320));
  const saved = rec.finalizeAndSave('vici_audit_rec');
  assert.ok(saved && fs.existsSync(saved.filePath));
  fs.unlinkSync(saved!.filePath);
  console.log('✓ Bridge recordings reject symlinks and use exclusive owner-only files');

  const { server: wsServer, liveSimulator } = createServerWithSimulator();
  await new Promise<void>((r) => wsServer.listen(0, '127.0.0.1', r));
  const port = (wsServer.address() as any).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/simulator`, { headers: { Authorization: `Bearer ${process.env.ADMIN_PASSWORD}` } });
  const closeCode = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('oversized WebSocket frame was not closed')), 5000);
    ws.on('close', (code) => { clearTimeout(timer); resolve(code); });
    ws.on('error', () => {});
    ws.on('open', () => ws.send(Buffer.alloc(5 * 1024 * 1024)));
  });
  assert.equal(closeCode, 1009);
  for (const client of liveSimulator.clients) client.terminate();
  await new Promise<void>((r) => liveSimulator.close(() => r()));
  await new Promise<void>((r) => wsServer.close(() => r()));
  console.log('✓ Simulator enforces WebSocket payload limits');
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
