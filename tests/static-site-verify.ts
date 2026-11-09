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

function loginFixture(pathname: string, responses: Record<string, () => Response>, initialStorage: Array<[string, string]> = []) {
  const elements = new Map<string, ReturnType<typeof element>>();
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id)!;
  };
  const tabs = ['signin', 'signup', 'admin'].map((mode) => Object.assign(element(), { dataset: { mode } }));
  const requests: Array<{ url: string; init: any }> = [];
  const timers: Function[] = [];
  const storage = new Map<string, string>(initialStorage);
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
  vm.runInContext(read('public/brand-logos.js'), context, { filename: 'public/brand-logos.js' });
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
  for (const file of ['app.js', 'login.js', 'opening.js', 'persona.js', 'brand-logos.js']) {
    childProcess.execFileSync(process.execPath, ['--check', path.join(publicDir, file)]);
    assert(!/saveAuthToken|vacReadAuthToken|Bearer \$\{tok\}/.test(read(`public/${file}`)), `${file} retains a legacy bearer handoff`);
  }
  const workflow = read('.github/workflows/jekyll-gh-pages.yml');
  assert(workflow.includes('path: ./public'), 'Pages must upload only the public browser assets');
  assert(!workflow.includes('source: ./\n'), 'Pages must not publish the repository root');
  assert(workflow.includes('assets/brand/mma-gold-ember.webp'), 'Pages smoke check must request the transparent full banner');
  assert(!workflow.includes('assets/brand/mma-gold-ember.jpg'), 'Pages must not depend on the retired full-banner JPEG');
  const brandCss = read('public/brand-logos.css');
  assert(/\.mma-brand-icon\s*\{[^}]*width:\s*36px[^}]*height:\s*36px/s.test(brandCss), 'Brand icon needs explicit dimensions');
  const brandJs = read('public/brand-logos.js').replace(/\/\*[\s\S]*?\*\//g, '');
  assert(!/sheen|logo-plate|exposure/i.test(brandJs), 'Transparent logo renderer must not restore plate/sheen overlays');
  // The baked-in waveform is masked out and replaced with live CSS bars.
  assert(/mma-wave-l/.test(brandJs) && /mma-wave-r/.test(brandJs), 'Banner must render both live wave flanks');
  assert(/WAVE_BARS\s*=\s*12/.test(brandJs), 'Live wave bar count is pinned');
  assert(!/requestAnimationFrame|setInterval/.test(brandJs), 'Live waves must be CSS-driven, not a JS animation loop');
  const brandCssLive = read('public/brand-logos.css');
  assert(/@keyframes mmaLiveWave/.test(brandCssLive), 'Live wave keyframes must exist');
  assert(/animation-name: mmaLiveWave/.test(brandCssLive), 'Bars must use the live wave animation');
  assert(/transform: scaleY/.test(brandCssLive), 'Waves must animate transform (compositor), not height (layout)');
  assert(/prefers-reduced-motion: reduce/.test(brandCssLive), 'Reduced motion must be honored');
  const motionBlock = brandCssLive.slice(brandCssLive.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert(/\.mma-wave\s*\{\s*display: none/.test(motionBlock), 'Reduced motion hides the live bars');
  assert(/mask-image: none/.test(motionBlock), 'Reduced motion restores the original baked-in artwork');
  assert(/data-energy="speaking"/.test(brandCssLive) && /data-energy="listening"/.test(brandCssLive), 'Call state must drive wave amplitude');
  // The wave strip must stay inside the banner.
  const band = (name: string) => Number(brandCssLive.match(new RegExp('--mma-wave-' + name + ':\\s*([\\d.]+)%'))?.[1]);
  assert(band('top') + band('height') <= 100, 'Wave strip must fit inside the banner');
  // Regression guard: a mask layer sized to a fraction of the box cannot be
  // placed with a plain percentage (CSS resolves it against box - layer), which
  // silently erased a strip of the wordmark. Both layers must be full-size.
  const maskBlock = brandCssLive.slice(brandCssLive.indexOf('.mma-brand-logo .mma-logo-art {'), brandCssLive.indexOf('.mma-brand-icon {'));
  assert(/mask-image: var\(--mma-wave-vband\), var\(--mma-wave-hband\)/.test(maskBlock), 'Mask must union a vertical and a horizontal band');
  assert(/mask-size: 100% 100%/.test(maskBlock), 'Mask layers must be full-size so percentage positioning cannot misplace them');
  assert(!/mask-size:[^;]*var\(--mma-wave-(top|height|tail)\)/.test(maskBlock), 'Mask layers must not be sized from band fractions');
  assert(/mask-composite: add/.test(maskBlock), 'Mask layers must be unioned, not intersected');
  // The one banner with an opaque waveform panel must repaint it, or the masked
  // window shows the page through the logo on light themes.
  assert(/--mma-wave-panel-r: rgb\(13, 7, 1\)/.test(brandCssLive), 'Opaque crimson panel must be repainted behind the live bars');
  assert(/data-theme="crimson"[\s\S]{0,120}data-theme="sakura"/.test(brandCssLive), 'Both themes mapped to mma-gold-crimson need the panel fill');
  for (const theme of ['mma-cyan-signal', 'mma-blue-ultraviolet', 'mma-cyan-field', 'mma-gold-ember', 'mma-ice-obsidian', 'mma-cyan-emerald', 'mma-cyan-aurora', 'mma-gold-crimson']) {
    assert(fs.existsSync(path.join(publicDir, 'assets', 'brand', `${theme}.webp`)), `Missing transparent banner ${theme}`);
    assert(!fs.existsSync(path.join(publicDir, 'assets', 'brand', `${theme}.jpg`)), `Full-banner JPEG master must stay out of public/: ${theme}`);
    assert(!fs.existsSync(path.join(root, 'docs', 'assets', 'brand', `${theme}.jpg`)), `Full-banner JPEG master must stay out of docs/: ${theme}`);
    assert(fs.existsSync(path.join(root, 'brand-source', `${theme}.jpg`)), `Missing brand source master ${theme}`);
  }
  console.log('✓ Static mirrors, asset versions, JavaScript syntax, transparent brand assets and publication boundary');

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

  // Regression: the console and login page must share the same browser-local
  // session key. A missing/undefined key made app.js discard a valid demo
  // session, redirect to login.html, and login.js immediately redirect back.
  const appSource = read('public/app.js');
  const loginSource = read('public/login.js');
  const appSessionKey = appSource.match(/const VAC_CLOUD_SESSION_KEY = '([^']+)'/);
  const loginSessionKey = loginSource.match(/var CLOUD_SESSION_KEY = '([^']+)'/);
  assert(appSessionKey, 'app.js must define VAC_CLOUD_SESSION_KEY before reading the static demo session');
  assert(loginSessionKey, 'login.js must define CLOUD_SESSION_KEY');
  assert.strictEqual(appSessionKey![1], loginSessionKey![1], 'Static demo session keys must match');
  assert(appSource.indexOf('const VAC_CLOUD_SESSION_KEY') < appSource.indexOf('getItem(VAC_CLOUD_SESSION_KEY)'), 'Session key must be declared before use');
  assert(appSource.includes("fetch('./api/auth/status'") && appSource.includes("fetch('./api/state')"), 'Static-host probes must stay inside the GitHub Pages project path');

  const existingSession = JSON.stringify({ user: { id: 'usr_demo', fullName: 'Demo User', email: 'demo@example.test' }, signedInAt: new Date().toISOString() });
  const prefilledNext = '/Voice-Agent-Console/?tab=agents';
  const returningLogin = loginFixture('/Voice-Agent-Console/login.html?next=' + encodeURIComponent(prefilledNext), {
    '/Voice-Agent-Console/api/auth/status': htmlResponse,
  }, [[loginSessionKey![1], existingSession]]);
  await flush();
  assert.deepStrictEqual(returningLogin.navigations, [prefilledNext], 'A valid static session must return to the project path once, without double-prefixing next');
  console.log('✓ Static demo session key parity and redirect-loop regression');

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
