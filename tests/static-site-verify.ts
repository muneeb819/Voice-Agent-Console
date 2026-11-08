import assert from 'assert';
import childProcess from 'child_process';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const root = path.resolve(__dirname, '..');
const publicDir = path.join(root, 'public');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function compareMirrors(relative = ''): void {
  for (const entry of fs.readdirSync(path.join(publicDir, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) compareMirrors(child);
    else {
      assert(fs.existsSync(path.join(root, 'docs', child)), `Static mirror is missing ${child}; run npm run sync:static`);
      assert(fs.readFileSync(path.join(publicDir, child)).equals(fs.readFileSync(path.join(root, 'docs', child))),
        `Static mirror differs from public/${child}; run npm run sync:static`);
    }
  }
}

function element() {
  return {
    hidden: false, value: '', textContent: '', disabled: false, style: {}, dataset: {}, handlers: {} as Record<string, Function>,
    classList: { toggle() {}, remove() {} },
    setAttribute() {}, removeAttribute() {}, focus() {}, select() {}, querySelector() { return null; },
    addEventListener(event: string, handler: Function) { this.handlers[event] = handler; },
  };
}

function loginFixture(pathname: string, responses: Record<string, () => Response>) {
  const elements = new Map<string, ReturnType<typeof element>>();
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id)!;
  };
  const tabs = ['signin', 'signup', 'admin'].map((mode) => Object.assign(element(), { dataset: { mode } }));
  const requests: Array<{ url: string; init: any }> = [];
  const timers: Function[] = [];
  const storage = new Map<string, string>();
  const location = new URL(`https://console.example${pathname}`);
  const navigations: string[] = [];
  Object.defineProperty(location, 'replace', { value: (url: string) => navigations.push(url) });
  const document = {
    documentElement: { dataset: {} }, hidden: false,
    getElementById(id: string) { return id === 'login-brand-plaque' ? null : get(id); },
    querySelectorAll(selector: string) { return selector === '.tab' ? tabs : []; },
    addEventListener() {},
  };
  const window = {
    location, document, matchMedia: () => ({ matches: false }),
    setTimeout(callback: Function) { timers.push(callback); return timers.length; },
    requestAnimationFrame() {},
  };
  const context = vm.createContext({
    window, document, location, URL, URLSearchParams, console,
    history: { replaceState() {} },
    localStorage: {
      getItem: (key: string) => storage.get(key) || null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    fetch: async (url: string, init: any) => {
      requests.push({ url, init });
      const responder = responses[url];
      assert(responder, `Unexpected login request: ${url}`);
      return responder();
    },
  });
  vm.runInContext(read('public/login.js'), context, { filename: 'public/login.js' });
  return { get, requests, timers, storage, navigations };
}

const htmlResponse = () => new Response('<!doctype html><title>Not found</title>', { status: 404, headers: { 'Content-Type': 'text/html' } });
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function run() {
  compareMirrors();
  assert.strictEqual(read('docs/.nojekyll'), '');
  const version = JSON.parse(read('public/version.json')).build;
  for (const file of ['index.html', 'login.html']) {
    const html = read(`public/${file}`);
    for (const match of html.matchAll(/(?:src|href)="\.\/[^"?]+\?v=([^"]+)"/g)) {
      assert.strictEqual(match[1], version, `${file} has a stale asset version`);
    }
    assert(!html.includes("setItem('vac_auth_token'"), `${file} must not persist browser session tokens`);
  }
  for (const file of ['app.js', 'login.js', 'opening.js']) {
    childProcess.execFileSync(process.execPath, ['--check', path.join(publicDir, file)]);
    assert(!/saveAuthToken|vacReadAuthToken|Bearer \$\{tok\}/.test(read(`public/${file}`)), `${file} retains a legacy bearer handoff`);
  }
  const workflow = read('.github/workflows/jekyll-gh-pages.yml');
  assert(workflow.includes('path: ./public'), 'Pages must upload only the public browser assets');
  assert(!workflow.includes('source: ./\n'), 'Pages must not publish the repository root');
  console.log('✓ Static mirrors, asset versions, JavaScript syntax and publication boundary');

  const staticLogin = loginFixture('/Voice-Agent-Console/login.html', {
    '/Voice-Agent-Console/api/auth/status': htmlResponse,
    '/Voice-Agent-Console/api/auth/signup': htmlResponse,
  });
  await flush();
  assert(staticLogin.get('auth-security-note').textContent.includes('Static demo only'), 'Static initialization must identify the browser-only demo');
  assert.strictEqual(staticLogin.get('signup-form').hidden, false, 'Static first visit must offer account creation');
  staticLogin.get('signup-name').value = 'Demo User';
  staticLogin.get('signup-email').value = 'demo@example.test';
  staticLogin.get('signup-password').value = 'Synthetic-Password-123';
  await staticLogin.get('signup-form').handlers.submit({ preventDefault() {} });
  await flush();
  staticLogin.timers.forEach((callback) => callback());
  assert.deepStrictEqual(staticLogin.navigations, ['/Voice-Agent-Console/'], 'Static signup must return to the project base path');
  assert(!staticLogin.storage.has('vac_auth_token'), 'Static signup must not create a server-session token');
  console.log('✓ GitHub Pages project-path login initialization and browser-local signup');

  const serverLogin = loginFixture('/login', {
    '/api/auth/status': () => jsonResponse({ ok: true, authenticated: false, signupOpen: true, hasUsers: true, adminPasswordConfigured: false }),
    // A legacy or compromised response field must still never reach browser storage or URLs.
    '/api/auth/signup': () => jsonResponse({ ok: true, authenticated: true, token: 'must-not-be-stored', user: { fullName: 'Test User' } }, 201),
  });
  await flush();
  serverLogin.get('signup-name').value = 'Test User';
  serverLogin.get('signup-email').value = 'test@example.test';
  serverLogin.get('signup-password').value = 'Synthetic-Password-123';
  await serverLogin.get('signup-form').handlers.submit({ preventDefault() {} });
  await flush();
  serverLogin.timers.forEach((callback) => callback());
  assert.deepStrictEqual(serverLogin.navigations, ['/'], 'Cookie-only signup must navigate home');
  assert(!serverLogin.storage.has('vac_auth_token'), 'Signup must ignore a JSON session token');
  assert(serverLogin.requests.every((request) => request.init.credentials === 'same-origin' && !request.init.headers?.Authorization), 'Browser requests must use cookies, not bearer handoffs');
  console.log('✓ Cookie-only backend signup without token persistence or URL handoff');

  const storage = new Map([['vac_auth_token', 'legacy-secret']]);
  const location = new URL('https://console.example/?vac_token=legacy-secret&token=another-secret&tab=agents');
  const replacements: string[] = [];
  const browserStorage = {
    getItem: (key: string) => storage.get(key) || null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  };
  const history = { replaceState(_state: unknown, _title: string, url: string) { replacements.push(url); } };
  const window = { location, history, sessionStorage: browserStorage, localStorage: browserStorage };
  vm.runInNewContext(read('public/index.html').match(/<script>([\s\S]*?)<\/script>/)![1], {
    window, URLSearchParams, Date,
    sessionStorage: browserStorage, localStorage: browserStorage, history,
    fetch: () => Promise.resolve(jsonResponse({ build: version })),
  });
  await flush();
  assert(!storage.has('vac_auth_token'), 'Console boot must remove legacy stored tokens');
  assert.deepStrictEqual(replacements, ['/?tab=agents'], 'Console boot must strip URL credentials without losing navigation');
  console.log('✓ Legacy browser token cleanup');
  console.log('ALL STATIC SITE REGRESSION CHECKS PASSED');
}

run().catch((error) => { console.error('Static site verification FAILED:', error); process.exitCode = 1; });
