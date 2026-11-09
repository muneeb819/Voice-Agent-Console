#!/usr/bin/env node
/*
 * Isolated, offline browser smoke/inventory. This script is deliberately not part
 * of npm test: it needs an independently installed playwright-core and Chromium.
 * See audit/README.md for setup, scope and limitations.
 */
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');

const root = path.resolve(__dirname, '..');
const resultPath = path.join(__dirname, 'browser-results.json');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vac-browser-audit-'));
const results = { checks: [], inventories: [], mobile: [], pageErrors: [], blockedExternalRequests: 0 };
let child;
let browser;
let staticServer;
let childLog = '';

function flush() {
  // One record per line keeps this detailed inventory reviewable in a PR.
  const lines = (items) => items.map((item) => `    ${JSON.stringify(item)}`).join(',\n');
  const json = `{
  "checks": [\n${lines(results.checks)}\n  ],
  "inventories": [\n${lines(results.inventories)}\n  ],
  "mobile": [\n${lines(results.mobile)}\n  ],
  "pageErrors": ${JSON.stringify(results.pageErrors)},
  "blockedExternalRequests": ${results.blockedExternalRequests}
}\n`;
  fs.writeFileSync(resultPath, json);
}
async function check(name, action) {
  try {
    await action();
    results.checks.push({ name, status: 'PASS' });
    console.log('PASS', name);
  } catch (error) {
    results.checks.push({ name, status: 'FAIL', details: String(error.message || error) });
    console.error('FAIL', name, error.message || error);
    flush();
    throw error;
  }
  flush();
}
async function inventory(page, view) {
  const controls = await page.evaluate((viewName) => {
    const shown = (el) => {
      const rect = el.getBoundingClientRect();
      const css = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && css.display !== 'none' && css.visibility !== 'hidden';
    };
    return [...document.querySelectorAll('button,a,input,textarea,select,summary')].filter(shown).map((el, index) => {
      const isField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
      const labels = [...(el.labels || [])].map((label) => label.innerText.replace(/\s+/g, ' ').trim());
      return {
        view: viewName,
        index: index + 1,
        tag: el.tagName.toLowerCase(),
        id: el.id || '',
        type: el.getAttribute('type') || '',
        text: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 140),
        labels,
        name: el.getAttribute('name') || '',
        data: [...el.attributes].filter((a) => a.name.startsWith('data-')).map((a) => `${a.name}=${a.value.slice(0, 100)}`).join(';'),
        disabled: Boolean(el.disabled),
        labelled: isField ? Boolean(labels.length || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title')) : null,
        ...(el.tagName === 'SELECT' ? { options: [...el.options].map((option) => ({ value: option.value, text: option.text, disabled: option.disabled, selected: option.selected })) } : {}),
      };
    });
  }, view);
  results.inventories.push(...controls);
  console.log('INVENTORY', view, controls.length, 'controls;', controls.filter((c) => c.labelled === false).length, 'unlabelled fields');
  flush();
}
async function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
async function waitHealthy(base) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Fixture server exited: ${childLog}`);
    try { if ((await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) })).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`Fixture server did not become healthy: ${childLog}`);
}
async function blockExternal(context) {
  await context.route('**/*', (route) => {
    const hostname = new URL(route.request().url()).hostname;
    if (hostname === '127.0.0.1' || hostname === 'localhost') return route.continue();
    results.blockedExternalRequests += 1;
    return route.abort();
  });
}
async function run() {
  const probe = http.createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    HOST: '127.0.0.1', PORT: String(port), VAC_DATA_DIR: temp, VAC_ENV_FILE: path.join(temp, '.env'),
    BRIDGE_BIND_HOST: '127.0.0.1', AUDIOSOCKET_PORT: '0', BRIDGE_SIP_PORT: '0', BRIDGE_ALLOWED_IPS: '127.0.0.1',
    ADMIN_PASSWORD: 'dummy-browser-admin', TRUST_PROXY: '',
    DEEPGRAM_API_KEY: '', SPEECH_SERVICE_URL: '', SPEECH_SERVICE_API_KEY: '', ELEVENLABS_API_KEY: '',
    CARTESIA_API_KEY: '', OPENAI_API_KEY: '', GROQ_API_KEY: '', VICI_API_PASS: '', AMI_SECRET: '', CUSTOM_WEBHOOK_SECRET: '',
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${JSON.stringify(path.join(root, 'tests/offline-fetch.cjs'))}`.trim(),
  };
  child = cp.spawn(process.execPath, ['dist/server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (buf) => { childLog = (childLog + buf.toString()).slice(-5000); });
  child.stderr.on('data', (buf) => { childLog = (childLog + buf.toString()).slice(-5000); });
  await waitHealthy(base);

  browser = await chromium.launch({
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}),
    headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await blockExternal(context);
  const page = await context.newPage();
  page.on('pageerror', (error) => results.pageErrors.push(String(error)));

  await check('Anonymous visitor is redirected to sign-in; public signup is closed', async () => {
    await page.goto(`${base}/`);
    await page.waitForURL('**/login');
    await page.waitForFunction(() => document.querySelector('#tab-signup')?.hidden === true);
    assert(await page.locator('#signin-form').isVisible());
    await inventory(page, 'sign-in');
  });
  await check('Login validates required fields and password reveal', async () => {
    await page.click('#signin-submit');
    assert.equal(await page.locator('#signin-email').getAttribute('aria-invalid'), 'true');
    await page.click('[data-target="signin-password"]');
    assert.equal(await page.locator('#signin-password').getAttribute('type'), 'text');
    await page.click('[data-target="signin-password"]');
  });
  await check('Admin login and authenticated account creation', async () => {
    await page.click('#admin-toggle');
    await inventory(page, 'admin-login');
    await page.fill('#admin-password', 'dummy-browser-admin');
    await page.click('#admin-submit');
    await page.evaluate(() => { const pop = document.getElementById('account-popover'); if (pop?.hidden) document.getElementById('btn-account-menu')?.click(); });
    await page.waitForSelector('#btn-create-account:visible');
    await page.click('#btn-create-account');
    await page.waitForSelector('#signup-form:not([hidden])');
    await inventory(page, 'operator-signup');
    await page.fill('#signup-name', 'Browser Test Operator');
    await page.fill('#signup-email', 'operator@example.test');
    await page.fill('#signup-password', 'dummy-browser-password-123');
    await page.click('#signup-submit');
    await page.evaluate(() => { const pop = document.getElementById('account-popover'); if (pop?.hidden) document.getElementById('btn-account-menu')?.click(); });
    await page.waitForSelector('#btn-logout:visible');
    await page.waitForTimeout(500);
  });
  await check('User logout and email sign-in', async () => {
    await page.click('#btn-logout');
    await page.waitForURL('**/login');
    await page.waitForSelector('#signin-form:not([hidden])');
    await page.waitForTimeout(300);
    await page.fill('#signin-email', 'operator@example.test');
    await page.fill('#signin-password', 'dummy-browser-password-123');
    await page.click('#signin-submit');
    await page.evaluate(() => { const pop = document.getElementById('account-popover'); if (pop?.hidden) document.getElementById('btn-account-menu')?.click(); });
    await page.waitForSelector('#btn-logout:visible');
    await page.waitForTimeout(500);
    assert.equal(new URL(page.url()).searchParams.has('vac_token'), false, 'handoff token should be removed from the address bar');
  });
  await check('Dashboard is the first, dedicated default page and its cards navigate', async () => {
    assert.equal(await page.locator('#nav a.nav-item').count(), 9, 'Side-rail sections are real links');
    assert.equal(await page.locator('#nav [data-t]').first().getAttribute('data-t'), 'dashboard');
    assert.equal(await page.locator('#nav [data-t="dashboard"]').getAttribute('aria-current'), 'page');
    assert(await page.locator('main #cmd-deck').isVisible());
    const dashboard = await page.locator('#cmd-deck').innerText();
    assert.match(dashboard, /configuration estimate/i);
    assert.match(dashboard, /configured agents?/i);
    assert.doesNotMatch(dashboard, /active bots|deepgram live|<15ms/i);
    await page.locator('[data-cmd-tab="agents"]').first().click();
    assert.equal(await page.locator('#cmd-deck').count(), 0);
    assert.equal(await page.locator('#nav [data-t="agents"]').getAttribute('aria-current'), 'page');
    await page.locator('#nav [data-t="dashboard"]').click();
    await page.click('#btn-cmd-compact');
    assert(await page.locator('.cmd-compact-ribbon').isVisible());
    await page.click('#btn-cmd-compact');
  });
  await check('Existing tab deep links still open the requested page', async () => {
    await page.goto(`${base}/?tab=test`);
    await page.waitForSelector('#sim-state-pill');
    assert.equal(await page.locator('#cmd-deck').count(), 0);
    assert.equal(await page.locator('#nav [data-t="test"]').getAttribute('aria-current'), 'page');
    await page.goto(`${base}/?tab=agents`);
    await page.waitForSelector('[data-p="a.name"]');
  });
  await check('Navigation links keep the native right-click/new-tab behavior', async () => {
    const link = page.locator('#nav a[data-t="campaigns"]');
    assert.equal(await link.getAttribute('target'), null, 'Links do not force a target');
    const href = await link.getAttribute('href');
    assert(href && href.includes('?tab=campaigns'), 'Section link has a real URL');
    const prevented = await link.evaluate((el) => {
      const evt = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
      el.dispatchEvent(evt);
      return evt.defaultPrevented;
    });
    assert.equal(prevented, false, 'Context menu is not blocked');
    const before = await page.locator('#nav a.nav-item.on').getAttribute('data-t');
    await link.evaluate((el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: true })));
    assert.equal(await page.locator('#nav a.nav-item.on').getAttribute('data-t'), before, 'Ctrl+click is left to the browser');
  });
  await check('Agent field is labelled, navigation keeps drafts, and discard restores saved state', async () => {
    const field = page.locator('[data-p="a.name"]').first();
    const original = await field.inputValue();
    assert(await field.evaluate((el) => Boolean(el.labels?.length)));
    assert.equal(await page.locator('#save-dock').isVisible(), false, 'Clean state hides the save dock');
    await field.fill('Browser discarded agent');
    assert.equal(await page.locator('#save-dock').isVisible(), true, 'Dirty state opens the bottom-right save dock');
    await page.locator('#nav [data-t="campaigns"]').click();
    await page.locator('#nav [data-t="agents"]').click();
    assert.equal(await field.inputValue(), 'Browser discarded agent', 'Section navigation preserves unsaved edits without a save prompt');
    await page.click('#dc');
    await page.waitForFunction((value) => document.querySelector('[data-p="a.name"]')?.value === value, original);
    assert.equal(await page.locator('#save-dock').isVisible(), false);
  });
  await check('Save and reload an isolated agent edit', async () => {
    await page.locator('[data-p="a.name"]').first().fill('Browser saved agent');
    await page.click('#sv');
    await page.waitForFunction(() => document.querySelector('#vr')?.textContent?.includes('Saved to Server'));
    await page.reload();
    await page.waitForFunction(() => document.querySelector('[data-p="a.name"]')?.value === 'Browser saved agent');
  });
  await check('Greeting library is searchable and enabled per bot, with a saved opt-out', async () => {
    await page.waitForFunction(() => /1,100 imported greetings/.test(document.querySelector('#greeting-catalog-panel')?.textContent || ''));
    const agentIds = await page.locator('#sel-a option').evaluateAll((items) => items.map((item) => item.value));
    for (const id of agentIds) {
      await page.selectOption('#sel-a', id);
      assert.equal(await page.locator('[data-p="a.randomGreetingEnabled"]').isChecked(), true, `Rotation should default on for ${id}`);
    }
    await page.locator('#greeting-catalog-panel summary').click();
    assert.match(await page.locator('#greeting-results').innerText(), /#1\b/);
    await page.locator('[data-greeting-page="next"]').click();
    assert.match(await page.locator('#greeting-results').innerText(), /#21\b/);
    await page.fill('#greeting-search', '1100');
    assert.match(await page.locator('#greeting-results').innerText(), /#1100\b/);
    assert.match(await page.locator('#greeting-results').innerText(), /Executive Welcome/);
    await page.selectOption('#sel-a', agentIds[0]);
    await page.uncheck('[data-p="a.randomGreetingEnabled"]');
    await Promise.all([page.waitForResponse((r) => r.url().endsWith('/api/state') && r.request().method() === 'PUT' && r.ok()), page.click('#sv')]);
    await page.reload();
    await page.waitForSelector('[data-p="a.randomGreetingEnabled"]');
    await page.selectOption('#sel-a', agentIds[0]);
    assert.equal(await page.locator('[data-p="a.randomGreetingEnabled"]').isChecked(), false);
    await page.click('#new-a');
    assert.equal(await page.locator('[data-p="a.randomGreetingEnabled"]').isChecked(), true, 'A new bot defaults to enabled even when the template is opted out');
    await page.click('#del-a');
    await page.selectOption('#sel-a', agentIds[0]);
    await page.check('[data-p="a.randomGreetingEnabled"]');
    await Promise.all([page.waitForResponse((r) => r.url().endsWith('/api/state') && r.request().method() === 'PUT' && r.ok()), page.click('#sv')]);
  });
  await check('Recording notice is optional, easy to change from Live Bot, and persists per agent', async () => {
    await page.locator('#nav [data-t="test"]').click();
    await page.waitForSelector('#sim-disclosure');
    const editedAgentId = await page.locator('#sel-a').inputValue();
    const otherAgentId = await page.locator('#sel-a option').evaluateAll((items, id) => items.find((item) => item.value !== id).value, editedAgentId);
    assert.equal(await page.locator('#sim-disclosure').isChecked(), false, 'New/default agents omit the stock notice');
    assert.match(await page.locator('main').innerText(), /does not disable recording/i);
    await page.check('#sim-disclosure');
    await Promise.all([page.waitForResponse((r) => r.url().endsWith('/api/state') && r.request().method() === 'PUT' && r.ok()), page.click('#sv')]);
    // Section URLs now carry the selected agent, but reopen the saved setting
    // explicitly so this check does not depend on the current draft selection.
    await page.goto(`${base}/?tab=test`);
    await page.waitForSelector('#sim-disclosure');
    await page.selectOption('#sel-a', editedAgentId);
    assert.equal(await page.locator('#sim-disclosure').isChecked(), true, 'Explicit opt-in survives reload');
    await page.selectOption('#sel-a', otherAgentId);
    assert.equal(await page.locator('#sim-disclosure').isChecked(), false, 'Another agent remains unchanged');
    await page.selectOption('#sel-a', editedAgentId);
    await page.uncheck('#sim-disclosure');
    await Promise.all([page.waitForResponse((r) => r.url().endsWith('/api/state') && r.request().method() === 'PUT' && r.ok()), page.click('#sv')]);
    await page.goto(`${base}/?tab=test`);
    await page.waitForSelector('#sim-disclosure');
    await page.selectOption('#sel-a', editedAgentId);
    assert.equal(await page.locator('#sim-disclosure').isChecked(), false, 'Opt-out survives reload');
  });
  await check('Theme, exposure and API-key modals', async () => {
    await page.click('#btn-theme');
    await page.waitForSelector('#theme-modal:not([hidden])');
    await inventory(page, 'theme-modal');
    const secondTheme = page.locator('#theme-swatch-grid [data-pick-theme]').nth(1);
    const theme = await secondTheme.getAttribute('data-pick-theme');
    await secondTheme.click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
    await page.click('#exposure-seg [data-exp="minimal"]');
    assert.equal(await page.locator('html').getAttribute('data-exposure'), 'minimal');
    await page.click('#theme-close');
    await page.click('#btn-keys');
    await page.waitForSelector('#keys-modal:not([hidden])');
    await inventory(page, 'api-keys-modal');
    assert.equal(await page.locator('#keys-form input').count(), 10);
    await page.click('#keys-close');
  });

  const views = ['dashboard', 'agents', 'plugins', 'campaigns', 'voice', 'test', 'vici', 'wallboard', 'export'];
  for (const view of views) {
    await check(`Navigate ${view} view`, async () => {
      await page.locator(`#nav [data-t="${view}"]`).click();
      await page.waitForFunction((v) => document.querySelector(`#nav [data-t="${v}"]`)?.getAttribute('aria-current') === 'page', view);
      assert.equal(await page.locator('#cmd-deck').count(), view === 'dashboard' ? 1 : 0);
      if (view === 'plugins') await page.locator('main details').evaluateAll((nodes) => nodes.forEach((node) => { node.open = true; }));
      if (view === 'voice') await page.waitForSelector('[data-vsample]', { timeout: 15000 });
      await inventory(page, view);
    });
  }
  await check('Rendered form fields have an associated label, aria-label or title', async () => {
    const missing = results.inventories.filter((c) => c.labelled === false);
    assert.deepEqual(missing.map((c) => `${c.view}:${c.id || c.data}`), []);
  });
  await check('Offline voice sample reports failure instead of fabricated audio', async () => {
    await page.locator('#nav [data-t="voice"]').click();
    await page.locator('[data-vsample]').first().click();
    await page.waitForFunction(() => /unavailable/i.test(document.querySelector('#vs')?.textContent || ''), null, { timeout: 10000 });
  });
  await check('Unconfigured simulator reports an actionable failure', async () => {
    await page.locator('#nav [data-t="test"]').click();
    assert.match(await page.locator('main').innerText(), /not a telephone call/i);
    assert.match(await page.locator('main').innerText(), /not executed/i);
    assert.equal(await page.locator('#sim-allow-webhooks').isChecked(), false);
    assert.equal(await page.locator('#sim-mode').count(), 0, 'No scripted sandbox mode should be offered');
    await page.locator('#btn-call-nomic').click();
    await page.waitForFunction(() => /error|failed|need setup|unavailable/i.test(document.querySelector('#sim-state-pill')?.textContent || ''), null, { timeout: 12000 });
    assert.doesNotMatch(await page.locator('#sim-feed').innerText(), /connecting you to our licensed specialist/i);
  });
  await check('Wallboard identifies the retained analytics window', async () => {
    await page.locator('#nav [data-t="wallboard"]').click();
    assert.match(await page.locator('main').innerText(), /retained logs only/i);
  });
  await check('Mobile navigation works without horizontal document overflow', async () => {
    for (const width of [320, 390, 768]) {
      await page.setViewportSize({ width, height: 844 });
      for (const view of views) {
        await page.click('#btn-sidebar-toggle');
        await page.locator(`#nav [data-t="${view}"]`).click();
        await page.waitForTimeout(120);
        const size = await page.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth }));
        const row = { width, view, ...size, overflow: Math.max(0, size.scroll - size.viewport) };
        results.mobile.push(row);
        flush();
        assert.equal(row.overflow, 0, `${width}px ${view} overflowed by ${row.overflow}px`);
      }
    }
  });
  await check('No uncaught browser page errors', async () => assert.deepEqual(results.pageErrors, []));

  await check('Server auth failures cannot create a silent browser-local account', async () => {
    const authContext = await browser.newContext();
    await blockExternal(authContext);
    await authContext.route('**/api/auth/status', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ authenticated: false, signupOpen: true, hasUsers: false }) }));
    await authContext.route('**/api/auth/signup', (route) => route.fulfill({ status: 404, body: 'Unavailable' }));
    const authPage = await authContext.newPage();
    await authPage.goto(`${base}/login.html?mode=signup`);
    await authPage.waitForSelector('#signup-form:not([hidden])');
    await authPage.fill('#signup-name', 'Synthetic');
    await authPage.fill('#signup-email', 'synthetic@example.test');
    await authPage.fill('#signup-password', 'synthetic-password-123');
    await authPage.click('#signup-submit');
    await authPage.waitForFunction(() => /Could not create the account/i.test(document.querySelector('#signup-msg')?.textContent || ''));
    assert.equal(await authPage.evaluate(() => localStorage.getItem('vac_cloud_users_v1')), null);
    assert.doesNotMatch(await authPage.locator('#auth-security-note').innerText(), /Static demo only/i);
    await authContext.unroute('**/api/auth/status');
    await authContext.route('**/api/auth/status', (route) => route.fulfill({ status: 503, body: 'Unavailable' }));
    await authPage.goto(`${base}/signup`);
    await authPage.waitForFunction(() => /Authentication service is unavailable/i.test(document.querySelector('#signup-msg')?.textContent || ''));
    assert(await authPage.locator('#signup-msg').isVisible(), 'Service errors must appear on the active signup pane');
    await authContext.close();
  });

  // Serve docs as a static site without an API and verify the honest disclaimer.
  const docs = path.join(root, 'docs');
  staticServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/')) { res.writeHead(404); res.end('Not found'); return; }
    const file = path.resolve(docs, `.${url.pathname === '/' ? '/login.html' : url.pathname}`);
    if (!file.startsWith(docs + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('Not found'); return; }
    res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'image/svg+xml');
    fs.createReadStream(file).pipe(res);
  });
  const staticPort = await listen(staticServer);
  const staticContext = await browser.newContext();
  await blockExternal(staticContext);
  await check('Static-only login warns that local accounts do not secure a server', async () => {
    const staticPage = await staticContext.newPage();
    await staticPage.goto(`http://127.0.0.1:${staticPort}/login.html`);
    await staticPage.waitForFunction(() => document.querySelector('#auth-security-note')?.textContent?.includes('Static demo only'));
    assert.match(await staticPage.locator('#auth-security-note').innerText(), /do not secure a server/i);
  });
  flush();
  console.log(`RESULT ${results.checks.length} checks; ${results.inventories.length} rendered control instances; ${results.mobile.length} mobile layouts`);
}

run().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
}).finally(async () => {
  if (staticServer) { staticServer.closeAllConnections(); staticServer.close(); }
  if (child && child.exitCode === null) child.kill();
  if (browser) await Promise.race([browser.close().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 5000))]);
  fs.rmSync(temp, { recursive: true, force: true });
  flush();
  process.exit(process.exitCode || 0);
});
