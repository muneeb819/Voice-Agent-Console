import assert from 'assert';
import childProcess from 'child_process';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import dotenv from 'dotenv';
import WebSocket from 'ws';
import { createServerWithSimulator } from '../src/server';
import { isBridgePeerIpAllowed, isLoopbackIp } from '../src/auth-guard';
import { updateSecrets } from '../src/env-store';
import { createReleaseBundle } from '../src/release-bundle';
import { createDefaultState, normalizeState } from '../src/defaults';
import { getConsoleState, saveConsoleState } from '../src/db';
import { generateViciConfig } from '../src/settings-builder';
import { resolveSdpAdvertisedHost, VicidialBridgeService } from '../src/vici-bridge';
import { getSpeechServiceBaseUrl } from '../src/speech-service-client';
import { isTunnelProxyReady } from '../src/demo-tunnel';

const root = path.resolve(__dirname, '..');
const json = { 'Content-Type': 'application/json' };
const account = (email: string) => JSON.stringify({ email, fullName: 'Test User', password: 'Test-Password-123!' });

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as net.AddressInfo).port;
}
async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
async function waitHealthy(url: string, proc: childProcess.ChildProcess): Promise<void> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`Fixture server exited ${proc.exitCode}`);
    try { if ((await fetch(`${url}/api/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Fixture server did not become ready');
}
async function waitExit(proc: childProcess.ChildProcess): Promise<number | null> {
  if (proc.exitCode !== null) return proc.exitCode;
  return new Promise((resolve) => proc.once('exit', resolve));
}
async function requestStatus(url: string, method: string, headers: Record<string, string>, body = ''): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => { res.resume(); resolve(res.statusCode || 0); });
    req.once('error', reject);
    req.end(body);
  });
}
async function rawHttpOnBridge(host: string, port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    const socket = net.createConnection({ host, port });
    socket.setTimeout(3000, () => socket.destroy(new Error('Timed out contacting AudioSocket fixture')));
    socket.on('connect', () => socket.write(request));
    socket.on('data', (chunk) => { data += chunk.toString(); });
    socket.on('end', () => resolve(data));
    socket.on('close', () => resolve(data));
    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNRESET' || err.code === 'EPIPE') resolve(data); else reject(err);
    });
  });
}

async function websocketStatus(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once('open', () => { ws.terminate(); resolve(101); });
    ws.once('unexpected-response', (_request, response) => {
      response.resume();
      ws.terminate();
      resolve(response.statusCode || 0);
    });
    ws.once('error', reject);
  });
}

async function run() {
  assert(process.env.VAC_DATA_DIR && process.env.VAC_ENV_FILE, 'Run through the isolated test runner');
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vac-security-fixture-'));
  const { server } = createServerWithSimulator();
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  try {
    assert(isLoopbackIp('127.0.0.1'));
    assert(isLoopbackIp('::ffff:127.0.0.1'));
    assert(!isLoopbackIp('115.186.137.240'));
    process.env.BRIDGE_ALLOWED_IPS = '';
    assert(isBridgePeerIpAllowed('127.0.0.1'));
    assert(!isBridgePeerIpAllowed('115.186.137.240'));
    const configured = createDefaultState();
    configured.vici.viciBaseUrl = 'http://127.0.0.1:9876';
    configured.vici.bridgeHost = '127.0.0.1';
    configured.vici.amiHost = '127.0.0.1';
    configured.vici.sipPort = 5060;
    const normalized = normalizeState(configured);
    assert.strictEqual(normalized.vici.viciBaseUrl, 'http://127.0.0.1:9876');
    assert.strictEqual(normalized.vici.bridgeHost, '127.0.0.1');
    assert.strictEqual(normalized.vici.amiHost, '127.0.0.1');
    assert.strictEqual(normalized.vici.sipPort, 5060);
    assert.match(generateViciConfig(normalized), /(?:^|\n)port=5060(?:\n|$)/);
    const priorState = getConsoleState();
    const priorSipPort = process.env.BRIDGE_SIP_PORT;
    try {
      saveConsoleState(normalized, 'Synthetic SIP port fixture');
      delete process.env.BRIDGE_SIP_PORT;
      assert.strictEqual(new VicidialBridgeService().getStatus().sipPort, 5060, 'Saved SIP port must match the listener when no env override exists');
      process.env.BRIDGE_SIP_PORT = '5070';
      assert.strictEqual(new VicidialBridgeService().getStatus().sipPort, 5070, 'Explicit env override must retain precedence');
    } finally {
      saveConsoleState(priorState, 'Restore synthetic SIP port fixture');
      if (priorSipPort === undefined) delete process.env.BRIDGE_SIP_PORT; else process.env.BRIDGE_SIP_PORT = priorSipPort;
    }
    assert.strictEqual(resolveSdpAdvertisedHost('127.0.0.1', '192.0.2.40', '192.0.2.41'), '127.0.0.1');
    assert.strictEqual(resolveSdpAdvertisedHost('192.0.2.10', '192.0.2.40', '192.0.2.41'), '192.0.2.40');
    assert.strictEqual(resolveSdpAdvertisedHost('192.0.2.10', '127.0.0.1', '192.0.2.41'), '192.0.2.41');
    assert.strictEqual(resolveSdpAdvertisedHost('192.0.2.10', '127.0.0.1', '0.0.0.0'), '127.0.0.1');
    assert.strictEqual(getSpeechServiceBaseUrl(), 'http://127.0.0.1:8000');
    const preloadDir = path.join(testDir, process.platform === 'win32' ? 'preload with space' : 'preload\\with\\backslashes');
    fs.mkdirSync(preloadDir);
    const preloadPath = path.join(preloadDir, 'fixture.cjs');
    fs.writeFileSync(preloadPath, "process.env.VAC_PRELOAD_FIXTURE = 'loaded';");
    const preload = childProcess.spawnSync(process.execPath, ['-p', 'process.env.VAC_PRELOAD_FIXTURE'], {
      env: { ...process.env, NODE_OPTIONS: `--require=${JSON.stringify(preloadPath)}` }, encoding: 'utf8',
    });
    assert.strictEqual(preload.status, 0, preload.stderr);
    assert.strictEqual(preload.stdout.trim(), 'loaded', 'Quoted NODE_OPTIONS paths must preserve backslashes');
    console.log('✓ 1. Loopback classification, safe defaults and preservation of explicit host/port settings');

    const oldConsolePort = process.env.PORT;
    process.env.PORT = String(port);
    process.env.BRIDGE_ALLOWED_IPS = '*';
    const bridge = new VicidialBridgeService({ host: '0.0.0.0', audioSocketPort: 0, sipPort: 0 });
    try {
      await bridge.start();
      const bridgePort = bridge.getStatus().audioSocketPort;
      const local = await rawHttpOnBridge('127.0.0.1', bridgePort, 'GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
      assert.match(local, /^HTTP\/1\.1 200/, 'Loopback HTTP forwarding remains available');
      const remote = Object.values(os.networkInterfaces()).flat().find((item) => item && item.family === 'IPv4' && !item.internal)?.address;
      if (remote) {
        const body = account('remote-forward@example.test');
        const response = await rawHttpOnBridge(remote, bridgePort, `POST /api/auth/signup HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
        assert(!/^HTTP\//.test(response), 'Remote AudioSocket HTTP must not inherit loopback bootstrap access');
      } else {
        console.log('  SKIP non-loopback AudioSocket probe: no local network interface available');
      }
    } finally {
      await bridge.stop();
      if (oldConsolePort === undefined) delete process.env.PORT; else process.env.PORT = oldConsolePort;
      process.env.BRIDGE_ALLOWED_IPS = '';
    }

    const spoofed = { ...json, 'X-Forwarded-For': '198.51.100.12' };
    const remoteSignup = await fetch(`${base}/api/auth/signup`, { method: 'POST', headers: spoofed, body: account('remote@example.test') });
    assert.strictEqual(remoteSignup.status, 403, 'Proxied bootstrap must be denied');
    assert.strictEqual((await fetch(`${base}/api/state`, { headers: spoofed })).status, 401);
    const rebound = { ...json, Host: 'attacker.example' };
    assert.strictEqual(await requestStatus(`${base}/api/auth/signup`, 'POST', rebound, account('rebound@example.test')), 403, 'A non-loopback Host must not bootstrap through DNS rebinding');
    assert.strictEqual(await requestStatus(`${base}/api/state`, 'GET', rebound), 401);
    assert.strictEqual((await fetch(`${base}/api/demo-tunnel/start`, { method: 'POST' })).status, 403);
    const first = await fetch(`${base}/api/auth/signup`, { method: 'POST', headers: json, body: account('first@example.test') });
    assert.strictEqual(first.status, 201, 'Direct loopback bootstrap must still work');
    const firstToken = (await first.json() as any).token;
    assert.strictEqual((await fetch(`${base}/api/auth/signup`, { method: 'POST', headers: json, body: account('anonymous@example.test') })).status, 403);
    const second = await fetch(`${base}/api/auth/signup`, { method: 'POST', headers: { ...json, Authorization: `Bearer ${firstToken}` }, body: account('second@example.test') });
    assert.strictEqual(second.status, 201, 'An authenticated operator can add an account');
    const signupPage = await fetch(`${base}/signup`, { headers: { Authorization: `Bearer ${firstToken}` }, redirect: 'manual' });
    assert.strictEqual(signupPage.status, 200);
    assert.strictEqual((await fetch(`${base}/api/vici/register-call`)).status, 503, 'Direct local PBX hook reaches handler');
    assert.strictEqual((await fetch(`${base}/api/vici/register-call`, { headers: spoofed })).status, 401, 'Proxied PBX hook must not inherit loopback exemption');
    assert.strictEqual(await requestStatus(`${base}/api/vici/register-call`, 'GET', { Host: 'attacker.example' }), 401, 'Rebound host must not inherit the local PBX exemption');
    assert.strictEqual((await fetch(`${base}/api/vici/register-call`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403, 'Cross-site image/navigation cannot invoke a pre-call GET');
    await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${firstToken}` } });
    assert.strictEqual((await fetch(`${base}/api/state`, { headers: { Authorization: `Bearer ${firstToken}` } })).status, 401);
    console.log('✓ 2. Bootstrap, privileged signup, proxy and local-PBX boundary');

    process.env.ADMIN_PASSWORD = 'dummy-admin-password';
    const adminLogin = () => fetch(`${base}/api/auth/login`, { method: 'POST', headers: { ...json, 'X-Forwarded-Proto': 'https' }, body: JSON.stringify({ password: 'dummy-admin-password' }) });
    const firstLogin = await adminLogin();
    assert.strictEqual(firstLogin.status, 200);
    assert.strictEqual(firstLogin.headers.get('referrer-policy'), 'no-referrer', 'URLs containing handoff tokens must not become referrers');
    assert(!/; Secure/i.test(firstLogin.headers.get('set-cookie') || ''), 'Untrusted forwarded proto must not set Secure cookie');
    const adminToken1 = (await firstLogin.json() as any).token;
    const adminToken2 = (await (await adminLogin()).json() as any).token;
    assert.notStrictEqual(adminToken1, adminToken2, 'Concurrent logins need distinct tokens');
    const cookie = `vac_session=${encodeURIComponent(adminToken2)}`;
    const foreignOrigin = { Cookie: cookie, Origin: 'https://attacker.example' };
    assert.strictEqual((await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: foreignOrigin })).status, 403, 'Cross-origin cookie logout must be rejected');
    assert.strictEqual((await fetch(`${base}/api/state`, { headers: { Cookie: cookie } })).status, 200, 'Rejected logout must not revoke the session');
    assert.strictEqual((await fetch(`${base}/api/state`, { headers: { ...foreignOrigin, 'X-Forwarded-Host': 'attacker.example', 'X-Forwarded-Proto': 'https' } })).status, 403, 'Untrusted forwarding headers cannot spoof the request origin');
    assert.strictEqual((await fetch(`${base}/api/state`, { headers: { Cookie: cookie, Origin: base } })).status, 200, 'Same-origin cookie requests remain supported');
    assert.strictEqual((await fetch(`${base}/api/state`, { headers: { Cookie: cookie, Origin: 'null' } })).status, 403);
    const wsUrl = `ws://127.0.0.1:${port}/ws/simulator`;
    assert.strictEqual(await websocketStatus(wsUrl, foreignOrigin), 403, 'Cross-origin cookie WebSocket must be rejected');
    assert.strictEqual(await websocketStatus(wsUrl, { Cookie: cookie, Origin: base }), 101, 'Same-origin cookie WebSocket remains supported');
    assert.strictEqual(await isTunnelProxyReady(port), false, 'An untrusted local proxy must not be advertised as tunnel-ready');
    const oldPort = process.env.PORT;
    process.env.PORT = String(port);
    try {
      assert.strictEqual((await fetch(`${base}/api/demo-tunnel/start`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken2}` } })).status, 409, 'Tunnel start explains missing proxy trust');
    } finally { process.env.PORT = oldPort; }
    await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken1}` } });
    assert.strictEqual((await fetch(`${base}/api/state`, { headers: { Authorization: `Bearer ${adminToken1}` } })).status, 401);
    assert.strictEqual((await fetch(`${base}/api/state`, { headers: { Authorization: `Bearer ${adminToken2}` } })).status, 200);
    const freshProcess = childProcess.spawnSync(process.execPath, ['-e', "process.stdout.write(String(require('./dist/auth-guard').verifySessionToken(process.env.TEST_SESSION)))"], {
      cwd: root, env: { ...process.env, TEST_SESSION: adminToken1 }, encoding: 'utf8', timeout: 10000,
    });
    assert.strictEqual(freshProcess.status, 0, freshProcess.stderr);
    assert.strictEqual(freshProcess.stdout, 'false', 'Revocation must survive a fresh process');
    for (let i = 0; i < 5; i++) {
      const failed = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: json, body: JSON.stringify({ password: 'incorrect' }) });
      assert.strictEqual(failed.status, 401);
    }
    const bypass = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: spoofed, body: JSON.stringify({ password: 'incorrect' }) });
    assert.strictEqual(bypass.status, 429, 'Spoofed forwarding headers must not reset rate limit');
    console.log('✓ 3. Admin logout revocation, untrusted proxy and spoof-resistant throttling');

    process.env.TRUST_PROXY = 'loopback';
    const trusted = createServerWithSimulator().server;
    const trustedPort = await listen(trusted);
    try {
      const response = await fetch(`http://127.0.0.1:${trustedPort}/api/auth/login`, { method: 'POST', headers: { ...json, 'X-Forwarded-Proto': 'https' }, body: JSON.stringify({ password: 'dummy-admin-password' }) });
      assert.strictEqual(response.status, 200);
      assert(/; Secure/i.test(response.headers.get('set-cookie') || ''), 'Trusted TLS proxy must set secure cookie');
      assert.strictEqual(await isTunnelProxyReady(trustedPort), true, 'The local tunnel probe recognizes configured proxy trust');
      const forwarded = { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'console.example', Cookie: cookie };
      assert.strictEqual((await fetch(`http://127.0.0.1:${trustedPort}/api/state`, { headers: { ...forwarded, Origin: 'https://console.example' } })).status, 200, 'Trusted proxy may convey the external origin');
      assert.strictEqual((await fetch(`http://127.0.0.1:${trustedPort}/api/state`, { headers: { ...forwarded, Origin: 'https://attacker.example' } })).status, 403);
    } finally { await close(trusted); delete process.env.TRUST_PROXY; }
    console.log('✓ 4. Trusted proxy origin, HTTPS cookies and cross-origin HTTP/WebSocket defenses');

    const envFile = process.env.VAC_ENV_FILE!;
    fs.writeFileSync(envFile, 'CUSTOM_WEBHOOK_SECRET=old\nexport CUSTOM_WEBHOOK_SECRET=later\n');
    updateSecrets({ CUSTOM_WEBHOOK_SECRET: "test' # quoted-value" });
    assert.strictEqual(dotenv.parse(fs.readFileSync(envFile)).CUSTOM_WEBHOOK_SECRET, "test' # quoted-value");
    assert.strictEqual((fs.readFileSync(envFile, 'utf8').match(/CUSTOM_WEBHOOK_SECRET=/g) || []).length, 1);
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(envFile).mode & 0o777, 0o600);
    const before = fs.readFileSync(envFile, 'utf8');
    const oldAdmin = process.env.ADMIN_PASSWORD;
    assert.throws(() => updateSecrets({ ADMIN_PASSWORD: 'injected\nBRIDGE_ALLOWED_IPS=*' }), /newlines/);
    assert.strictEqual(fs.readFileSync(envFile, 'utf8'), before);
    assert.strictEqual(process.env.ADMIN_PASSWORD, oldAdmin);
    console.log('✓ 5. Atomic mode-0600 environment updates, duplicate cleanup and injection rejection');

    // Every shipped source/build/UI/deploy file must be explicitly listed, so
    // adding a required module cannot silently yield an incomplete archive.
    const manifest = new Set<string>(JSON.parse(fs.readFileSync(path.join(root, 'tools/release-manifest.json'), 'utf8')));
    const checkManifest = (relative: string): void => {
      for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
        const name = path.posix.join(relative, entry.name);
        if (entry.isDirectory()) checkManifest(name);
        else if (entry.isFile()) assert(manifest.has(name), `Release manifest omits ${name}`);
      }
    };
    for (const dir of ['src', 'dist', 'public', 'deploy']) checkManifest(dir);

    // Exercise the actual download endpoint from a disposable checkout, with
    // the output data dir outside it and only synthetic secret files inside.
    const fixture = path.join(testDir, 'arbitrary-checkout-name');
    fs.mkdirSync(path.join(fixture, 'tools'), { recursive: true });
    for (const dir of ['dist', 'src', 'public', 'deploy']) {
      fs.cpSync(path.join(root, dir), path.join(fixture, dir), { recursive: true });
    }
    for (const file of ['.env.example', 'package.json', 'package-lock.json', 'tsconfig.json']) {
      fs.copyFileSync(path.join(root, file), path.join(fixture, file));
    }
    fs.copyFileSync(path.join(root, 'tools/release-manifest.json'), path.join(fixture, 'tools/release-manifest.json'));
    fs.copyFileSync(path.join(root, 'tools/start-demo.js'), path.join(fixture, 'tools/start-demo.js'));
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(fixture, 'node_modules'), 'dir');
    fs.mkdirSync(path.join(fixture, 'speech-service'), { recursive: true });
    fs.writeFileSync(path.join(fixture, '.env.production'), 'SYNTHETIC_SECRET=never-package\n');
    fs.writeFileSync(path.join(fixture, 'speech-service/.env.local'), 'SYNTHETIC_SECRET=never-package\n');
    fs.writeFileSync(path.join(fixture, 'public/private-key.pem'), 'SYNTHETIC_PRIVATE_KEY');
    fs.mkdirSync(path.join(fixture, 'data/simulator-recordings'), { recursive: true });
    fs.writeFileSync(path.join(fixture, 'data/simulator-recordings/sim_test_abcdef.webm'), 'SYNTHETIC_PRIVATE_AUDIO');
    fs.symlinkSync(path.join(fixture, '.env.production'), path.join(fixture, 'public/private-link'));
    const outDir = path.join(testDir, 'external-data');
    fs.mkdirSync(outDir);
    const directArchive = path.join(outDir, 'direct.tar.gz');
    createReleaseBundle(fixture, directArchive);
    let entries = childProcess.execFileSync('tar', ['-tzf', directArchive], { encoding: 'utf8' });
    assert(entries.includes('arbitrary-checkout-name/public/app.js'));
    assert(!/\.env\.production|\.env\.local|private-key|private-link|simulator-recordings\/|\.webm/.test(entries));
    const requiredSource = path.join(fixture, 'src/request-origin.ts');
    fs.renameSync(requiredSource, `${requiredSource}.bak`);
    assert.throws(() => createReleaseBundle(fixture, directArchive), /missing required files:.*src\/request-origin\.ts/);
    fs.renameSync(`${requiredSource}.bak`, requiredSource);
    const probe = http.createServer();
    const fixturePort = await listen(probe);
    await close(probe);
    const child = childProcess.spawn(process.execPath, [path.join(fixture, 'dist/server.js')], {
      cwd: fixture,
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(fixturePort), BRIDGE_BIND_HOST: '127.0.0.1', AUDIOSOCKET_PORT: '0', BRIDGE_SIP_PORT: '0', VAC_DATA_DIR: outDir, VAC_ENV_FILE: path.join(outDir, '.env'), ADMIN_PASSWORD: 'fixture-admin', TRUST_PROXY: '' },
      stdio: 'ignore',
    });
    try {
      const url = `http://127.0.0.1:${fixturePort}`;
      await waitHealthy(url, child);
      const download = await fetch(`${url}/api/vici/release-bundle`, { headers: { Authorization: 'Bearer fixture-admin' } });
      assert.strictEqual(download.status, 409, 'An unreviewed default campaign must not produce a deployable archive');
      const blocked = await download.json() as any;
      assert.strictEqual(blocked.ok, false);
      assert.ok(blocked.blockers.some((message: string) => /Operator confirmed this code exists/i.test(message)), 'The readiness response identifies unverified campaign status codes');
      assert.strictEqual(fs.existsSync(path.join(outDir, 'voice-agent-vicibox-release.tar.gz')), false, 'Readiness failure must not create an archive');
    } finally { child.kill(); await waitExit(child); }
    console.log('✓ 6. Real archive download excludes synthetic secrets and unlisted files');

    const mockHealth = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, service: 'voice-agent-console', authEnabled: false })); });
    const mockPort = await listen(mockHealth);
    try {
      const demo = childProcess.spawn(process.execPath, [path.join(fixture, 'tools/start-demo.js')], { cwd: fixture, env: { ...process.env, PORT: String(mockPort) }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      demo.stderr!.on('data', (data) => { stderr += String(data); });
      const code = await waitExit(demo);
      assert.strictEqual(code, 1);
      assert(stderr.includes('before starting a public demo tunnel'));
    } finally { await close(mockHealth); }
    const untrustedDemo = childProcess.spawn(process.execPath, [path.join(fixture, 'tools/start-demo.js')], {
      cwd: fixture, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', TRUST_PROXY: '' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let demoErr = '';
    untrustedDemo.stderr!.on('data', (data) => { demoErr += String(data); });
    assert.strictEqual(await waitExit(untrustedDemo), 1);
    assert(demoErr.includes('Configure TRUST_PROXY'), 'The launcher must refuse a broken/untrusted HTTPS tunnel');
    console.log('✓ 7. Public demo launcher requires authentication and a trusted local proxy');
  } finally {
    await close(server);
    fs.rmSync(testDir, { recursive: true, force: true });
  }
  console.log('ALL 7 SECURITY REGRESSION GROUPS PASSED');
}

run().catch((err) => { console.error(err); process.exitCode = 1; });
