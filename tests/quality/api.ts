// HTTP API checks against a real running console (built dist/server.js) with
// authentication on: access control, roles, cross-site protection, malformed
// input, path traversal, security headers and state fuzzing.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { acheck, assert, fuzzString, group, rng } from './harness';

const R = rng(7_7_2026);

export interface Route { method: string; path: string }

export function discoverRoutes(serverSource: string): Route[] {
  const out: Route[] = [];
  const re = /app\.(get|post|put|delete|patch)\(\s*'(\/api\/[^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(serverSource))) out.push({ method: m[1].toUpperCase(), path: m[2] });
  const seen = new Set<string>();
  return out.filter((r) => { const k = `${r.method} ${r.path}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

const concrete = (p: string) => p.replace(/:([A-Za-z]+)/g, (_m, name) => (name === 'provider' ? 'elevenlabs' : name === 'file' ? 'none.wav' : 'qa-missing-id'));

// Endpoints that would leave this machine, spawn processes, or wipe the session
// the remaining checks rely on are left out of the malformed-input family only.
const SIDE_EFFECT = new Set(['POST /api/demo-tunnel/start', 'POST /api/state/reset', 'POST /api/auth/logout-all', 'POST /api/auth/revoke-sessions', 'POST /api/auth/logout']);
const PUBLIC = (r: Route) => r.path === '/api/health' || r.path.startsWith('/api/auth/') || r.path === '/api/vici/register-call' || r.path === '/api/vici/precall';
const ADMIN_ONLY = (r: Route) => /^\/api\/(secrets|users|state\/reset|demo-tunnel\/(start|stop)|vici\/deploy-script|vici\/release-bundle|functions\/test-webhook|speech-service\/(activate|test)|vici\/verify|deepgram\/verify)$/.test(r.path) || /^\/api\/users\/:id\//.test(r.path) || /^\/api\/vici\/calls\/:callId\/(hangup|transfer)$/.test(r.path);

export async function runApi(base: string, adminPassword: string, routes: Route[]) {
  const admin = { Authorization: `Bearer ${adminPassword}` };
  const call = async (method: string, p: string, opts: { headers?: Record<string, string>; body?: string | Buffer; json?: unknown } = {}) => {
    const headers: Record<string, string> = { ...(opts.headers || {}) };
    let body: any = opts.body;
    if (opts.json !== undefined) { body = JSON.stringify(opts.json); headers['Content-Type'] = 'application/json'; }
    const res = await fetch(base + p, { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : body, redirect: 'manual' });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text };
  };
  const alive = async () => (await call('GET', '/health/live')).status === 200;

  // ── accounts for role checks
  const mkUser = async (role: string) => {
    const email = `qa-${role}-${R.str(6).toLowerCase()}@example.com`; const password = `Qa-${role}-Password-${R.str(10)}`;
    const s = await call('POST', '/api/auth/signup', { headers: admin, json: { email, fullName: `QA ${role}`, password } });
    const user = JSON.parse(s.text).user;
    if (!user) throw new Error(`could not create ${role} account: ${s.status} ${s.text.slice(0, 200)}`);
    await call('POST', `/api/users/${user.id}/role`, { headers: admin, json: { role } });
    const l = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const cookie = (l.headers.get('set-cookie') || '').split(';')[0];
    return { cookie, id: user.id };
  };
  // The first account on a fresh install becomes the owner and the last owner
  // cannot be demoted, so create that owner first.
  await mkUser('owner');
  const viewer = await mkUser('viewer');
  const operator = await mkUser('operator');

  group('Security', 'src/server.ts + src/auth-guard.ts', 'sign-in required on every API');
  const protectedRoutes = routes.filter((r) => !PUBLIC(r));
  for (const r of protectedRoutes) {
    for (const [label, p] of [['as written', concrete(r.path)], ['UPPER-CASE path', concrete(r.path).toUpperCase().replace('/API/', '/api/')], ['trailing slash', concrete(r.path) + '/'], ['double slash', concrete(r.path).replace('/api/', '/api//')]] as const) {
      await acheck(`${r.method} ${r.path} (${label}) without sign-in is refused`, async () => {
        const res = await call(r.method, p, { json: r.method === 'GET' ? undefined : {} });
        assert.ok([401, 403, 404].includes(res.status), `status ${res.status}`);
        assert.ok(!/"ok":\s*true/.test(res.text), 'no data returned');
      });
    }
    for (const [label, h] of [['wrong password', { Authorization: 'Bearer wrong-password-123456' }], ['forged cookie', { Cookie: 'vac_session=forged.token.value' }], ['empty bearer', { Authorization: 'Bearer ' }], ['basic with wrong password', { Authorization: 'Basic ' + Buffer.from('admin:nope').toString('base64') }]] as const) {
      await acheck(`${r.method} ${r.path} with ${label} is refused`, async () => {
        const res = await call(r.method, concrete(r.path), { headers: h as any, json: r.method === 'GET' ? undefined : {} });
        assert.equal(res.status, 401, `status ${res.status}`);
      });
    }
  }

  group('Security', 'src/auth-guard.ts', 'roles');
  for (const r of protectedRoutes) {
    if (r.method !== 'GET' && !SIDE_EFFECT.has(`${r.method} ${r.path}`)) {
      await acheck(`viewer cannot ${r.method} ${r.path}`, async () => { const res = await call(r.method, concrete(r.path), { headers: { Cookie: viewer.cookie }, json: {} }); assert.equal(res.status, 403, `status ${res.status}`); });
    }
    if (ADMIN_ONLY(r) && !SIDE_EFFECT.has(`${r.method} ${r.path}`)) {
      await acheck(`operator cannot ${r.method} ${r.path} (admin only)`, async () => { const res = await call(r.method, concrete(r.path), { headers: { Cookie: operator.cookie }, json: r.method === 'GET' ? undefined : {} }); assert.equal(res.status, 403, `status ${res.status}`); });
    }
    if (r.method === 'GET' && !ADMIN_ONLY(r) && !r.path.includes(':')) {
      await acheck(`viewer can read ${r.path}`, async () => { const res = await call('GET', r.path, { headers: { Cookie: viewer.cookie } }); assert.notEqual(res.status, 401); assert.notEqual(res.status, 403); });
    }
  }
  await acheck('operator cannot change where credentials are sent (VICIdial host) via state save', async () => {
    const st = JSON.parse((await call('GET', '/api/state', { headers: admin })).text).state;
    st.vici.viciBaseUrl = 'https://attacker.example';
    const res = await call('PUT', '/api/state', { headers: { Cookie: operator.cookie }, json: { state: st } });
    assert.equal(res.status, 403);
  });

  group('Security', 'src/request-origin.ts', 'cross-site request protection');
  const evilOrigins = ['https://evil.example', 'null', 'http://127.0.0.1.evil.com', 'http://evil.com:80', 'https://localhost.evil.com', 'http://a.com, http://b.com', 'file://', 'http://user:pass@127.0.0.1', 'chrome-extension://abc', 'http://127.0.0.1:1'];
  for (const r of protectedRoutes.filter((x) => !SIDE_EFFECT.has(`${x.method} ${x.path}`))) {
    for (const o of evilOrigins) {
      await acheck(`${r.method} ${r.path} from origin ${o} is blocked`, async () => { const res = await call(r.method, concrete(r.path), { headers: { ...admin, Origin: o }, json: r.method === 'GET' ? undefined : {} }); assert.equal(res.status, 403, `status ${res.status}`); });
    }
    await acheck(`${r.method} ${r.path} from its own origin is not blocked as cross-site`, async () => {
      const res = await call(r.method, concrete(r.path), { headers: { ...admin, Origin: base }, json: r.method === 'GET' ? undefined : {} });
      assert.ok(!/Cross-origin/.test(res.text), `status ${res.status}`);
    });
  }

  group('Robustness', 'src/server.ts', 'malformed input never crashes the server');
  const payloads: Array<[string, { body?: string | Buffer; headers?: Record<string, string> }]> = [
    ['broken JSON', { body: '{"state":', headers: { 'Content-Type': 'application/json' } }],
    ['JSON array', { body: '[1,2,3]', headers: { 'Content-Type': 'application/json' } }],
    ['JSON null', { body: 'null', headers: { 'Content-Type': 'application/json' } }],
    ['JSON number', { body: '42', headers: { 'Content-Type': 'application/json' } }],
    ['wrong types', { body: JSON.stringify({ id: 5, name: {}, state: 'x', role: [], text: 123, email: null, password: {} }), headers: { 'Content-Type': 'application/json' } }],
    ['prototype pollution', { body: '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}', headers: { 'Content-Type': 'application/json' } }],
    ['deep nesting', { body: '['.repeat(5000) + ']'.repeat(5000), headers: { 'Content-Type': 'application/json' } }],
    ['5 MB body', { body: '{"x":"' + 'a'.repeat(5 * 1024 * 1024) + '"}', headers: { 'Content-Type': 'application/json' } }],
    ['form-encoded', { body: 'a=1&b=2', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }],
    ['binary', { body: R.bytes(2048), headers: { 'Content-Type': 'application/octet-stream' } }],
    ['empty', { body: '', headers: { 'Content-Type': 'application/json' } }],
    ['unicode garbage', { body: JSON.stringify({ text: fuzzString(R, 500), name: fuzzString(R, 500) }), headers: { 'Content-Type': 'application/json' } }],
  ];
  for (const r of routes.filter((x) => x.method !== 'GET' && !SIDE_EFFECT.has(`${x.method} ${x.path}`))) {
    for (const [label, p] of payloads) {
      await acheck(`${r.method} ${r.path} with ${label} is handled (no 500, server stays up)`, async () => {
        const res = await call(r.method, concrete(r.path), { headers: { ...admin, ...(p.headers || {}) }, body: p.body });
        assert.notEqual(res.status, 500, res.text.slice(0, 200));
        assert.ok(await alive(), 'server still answering');
        assert.equal(({} as any).polluted, undefined);
      });
    }
  }

  group('Security', 'src/call-recorder.ts + src/simulator-recordings.ts', 'path traversal');
  // fetch() would tidy "../" away before sending; send the path exactly as an attacker would.
  const rawGet = (p: string, headers: Record<string, string>) => new Promise<{ status: number; text: string }>((resolve, reject) => {
    const u = new URL(base);
    const req = http.request({ host: u.hostname, port: u.port, path: p, method: 'GET', headers }, (res) => {
      let text = ''; res.setEncoding('latin1'); res.on('data', (d) => (text += d)); res.on('end', () => resolve({ status: res.statusCode || 0, text }));
    });
    req.on('error', reject); req.end();
  });
  const traversal = ['../../../../etc/passwd', '..%2F..%2F..%2Fetc%2Fpasswd', '%2e%2e%2f%2e%2e%2fetc%2fpasswd', '....//....//etc/passwd', '..\\..\\windows\\win.ini', '/etc/passwd', '%00.wav', 'a/../../.env', '..%252f..%252f.env', '.env',
    'console.db', '../console.db', '../../data/console.db', 'x.wav/../../.env', '%2fetc%2fshadow', '..;/..;/etc/passwd', 'recording.wav%00.txt', '\u002e\u002e/\u002e\u002e/.env', '....\\\\....\\\\.env', 'C:\\Windows\\win.ini'];
  for (const route of ['/api/vici/recordings/', '/api/simulator/recordings/']) {
    for (const t of traversal) {
      for (const enc of [t, encodeURIComponent(t)]) {
        await acheck(`GET ${route}${enc.slice(0, 40)} cannot read files outside recordings`, async () => {
          const res = await rawGet(route + enc, admin);
          assert.ok(res.status >= 400, `status ${res.status}`);
          assert.ok(!/root:x:|ADMIN_PASSWORD|SQLite format|\[fonts\]/.test(res.text), 'no file contents leaked');
        });
      }
    }
  }

  group('Security', 'src/server.ts', 'security headers');
  const pages = ['/', '/login', '/index.html', '/login.html', '/health/live', '/health/ready', '/api/health', ...routes.filter((r) => r.method === 'GET' && !r.path.includes(':')).map((r) => r.path)];
  for (const p of pages) {
    const want: Array<[string, RegExp]> = [['x-content-type-options', /^nosniff$/], ['x-frame-options', /^DENY$/], ['referrer-policy', /no-referrer/], ['content-security-policy', /default-src/], ['permissions-policy', /camera=\(\)/]];
    for (const [h, re] of want) {
      await acheck(`${p} sends ${h}`, async () => { const res = await call('GET', p, { headers: admin }); assert.match(res.headers.get(h) || '', re); });
    }
    if (p.startsWith('/api/')) await acheck(`${p} is not cached`, async () => { const res = await call('GET', p, { headers: admin }); assert.match(res.headers.get('cache-control') || '', /no-store/); });
  }
  await acheck('server banner (X-Powered-By) is hidden', async () => { const res = await call('GET', '/', {}); assert.equal(res.headers.get('x-powered-by'), null); });

  group('Saved state', 'src/server.ts + src/db.ts', 'state save fuzz over HTTP');
  const original = JSON.parse((await call('GET', '/api/state', { headers: admin })).text).state;
  for (let i = 0; i < 150; i++) {
    const st = JSON.parse(JSON.stringify(original));
    const a = st.agents[R.int(0, st.agents.length - 1)]; const c = st.campaigns[R.int(0, st.campaigns.length - 1)];
    const roll = R.int(0, 9);
    if (roll === 0) a.prompt = fuzzString(R, 2000);
    else if (roll === 1) c.maxCallSec = R.pick([-5, 0, 10, 99999, 'abc', null]);
    else if (roll === 2) a.behavior.bargeInSensitivityPct = R.pick([-10, 500, 'x', null]);
    else if (roll === 3) st.campaigns.push(JSON.parse(JSON.stringify(c)));
    else if (roll === 4) delete st.agents;
    else if (roll === 5) a.name = fuzzString(R, 300);
    else if (roll === 6) c.complianceRules = 'Rule.\n'.repeat(R.int(1, 4000));
    else if (roll === 7) st.vici.aiExten = fuzzString(R, 20);
    else if (roll === 8) a.greeting = '<img src=x onerror=alert(1)>' + fuzzString(R, 50);
    else st.providers = R.pick([[], null, 'x']);
    await acheck(`state save fuzz #${i + 1} (mutation ${roll}) is accepted or refused cleanly and the saved state stays valid`, async () => {
      const res = await call('PUT', '/api/state', { headers: admin, json: { state: st } });
      assert.ok(res.status < 500, `status ${res.status}: ${res.text.slice(0, 150)}`);
      const now = JSON.parse((await call('GET', '/api/state', { headers: admin })).text).state;
      assert.ok(Array.isArray(now.agents) && now.agents.length > 0 && Array.isArray(now.campaigns));
      assert.equal(new Set(now.campaigns.map((x: any) => x.slot)).size, now.campaigns.length);
      for (const x of now.campaigns) assert.ok(x.maxCallSec === 0 || (x.maxCallSec >= 30 && x.maxCallSec <= 900));
    });
  }
  await call('PUT', '/api/state', { headers: admin, json: { state: original } });

  group('Front end', 'public/*', 'static files');
  const pub = path.resolve(__dirname, '../../public');
  const files = fs.readdirSync(pub).filter((f) => fs.statSync(path.join(pub, f)).isFile());
  const types: Record<string, RegExp> = { '.js': /javascript/, '.css': /text\/css/, '.html': /text\/html/, '.json': /json/ };
  for (const f of files) {
    const ext = path.extname(f);
    await acheck(`/${f} is served with the right content type`, async () => {
      const res = await call('GET', '/' + f, { headers: admin });
      // The sign-in page sends an already signed-in user on to the console.
      if (f === 'login.html' && res.status === 302) return;
      assert.equal(res.status, 200, `status ${res.status}`);
      if (types[ext]) assert.match(res.headers.get('content-type') || '', types[ext]);
    });
  }
  for (const f of files.filter((x) => x.endsWith('.json'))) await acheck(`/${f} is valid JSON`, async () => { JSON.parse(fs.readFileSync(path.join(pub, f), 'utf8')); });

  return { viewer, operator };
}
