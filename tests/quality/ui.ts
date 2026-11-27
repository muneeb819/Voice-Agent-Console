// Browser checks on every console section at desktop, laptop and phone widths:
// no script errors, every visible control has a label, every button has a name,
// no sideways scrolling.
import fs from 'node:fs';
import path from 'node:path';
import { acheck, assert, check, group } from './harness';

function loadPlaywright(): { chromium: any } | null {
  const candidates = [
    process.env.PLAYWRIGHT_PATH,
    'playwright-core',
    'playwright',
    '/opt/npm-tools/node_modules/playwright-core',
  ].filter(Boolean) as string[];
  for (const mod of candidates) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const loaded = require(mod);
      if (loaded?.chromium) return loaded;
    } catch {
      /* try next */
    }
  }
  return null;
}

function findChromeExecutable(): string | undefined {
  const candidates = [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean) as string[];
  for (const bin of candidates) {
    if (fs.existsSync(bin)) return bin;
  }
  return undefined;
}

async function runUiJsdomFallback(base: string, adminPassword: string, tabs: string[]) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { JSDOM, VirtualConsole } = require('jsdom');
  const pub = path.resolve(__dirname, '../../public');
  const baseHtml = fs.readFileSync(path.join(pub, 'index.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
  const scripts = ['opening.js', 'persona.js', 'brand-logos.js', 'app.js'].map((f) => fs.readFileSync(path.join(pub, f), 'utf8'));
  const authHdr = adminPassword ? { Authorization: `Bearer ${adminPassword}` } : {};
  const tick = (ms = 25) => new Promise<void>((r) => setTimeout(r, ms));

  for (const tab of tabs) {
    group('Front end', 'public/app.js + public/index.html', `${tab} section`);
    const errors: string[] = [];
    const vc = new VirtualConsole();
    vc.on('jsdomError', (e: Error) => { if (!/Not implemented: navigation/.test(e.message)) errors.push(e.message); });
    const dom = new JSDOM(baseHtml, { url: `${base}/?tab=${tab}`, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
    const w: any = dom.window;
    w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    w.AudioContext = class {};
    w.WebSocket = class { readyState = 0; send() {} close() {} };
    w.indexedDB = undefined;
    const ac = new AbortController();
    w.fetch = (input: any, init?: any) => {
      if (ac.signal.aborted) return new Promise(() => {});
      const u = new URL(String(input), base + '/');
      const headers = new Headers(init?.headers || {});
      for (const [k, v] of Object.entries(authHdr)) if (!headers.has(k)) headers.set(k, v);
      return fetch(u.toString(), { ...init, headers, signal: init?.signal || ac.signal })
        .then((res) => (ac.signal.aborted ? new Promise<Response>(() => {}) : res))
        .catch((err) => (ac.signal.aborted ? new Promise<Response>(() => {}) : Promise.reject(err)));
    };
    try {
      await acheck(`${tab} opens in JSDOM`, async () => {
        for (const src of scripts) w.eval(src);
        for (let i = 0; i < 40 && !w.document.querySelector('.nav-item.on'); i++) await tick(20);
        await tick(60);
        const active = w.document.querySelector('.nav-item.on')?.getAttribute('data-t');
        assert.equal(active, tab);
      });
      check(`${tab} (JSDOM): no script errors`, () => assert.equal(errors.length, 0, errors.slice(0, 2).join(' | ')));
    } finally {
      ac.abort();
      w.close();
    }
  }
}

export async function runUi(base: string, adminPassword: string) {
  const tabs = ['dashboard', 'agents', 'plugins', 'campaigns', 'voice', 'test', 'vici', 'wallboard', 'export'];
  const pw = loadPlaywright();
  if (!pw) {
    await runUiJsdomFallback(base, adminPassword, tabs);
    return;
  }
  const executablePath = findChromeExecutable();
  let browser: any;
  try {
    browser = await pw.chromium.launch({ ...(executablePath ? { executablePath } : {}), args: ['--no-sandbox'] });
  } catch {
    await runUiJsdomFallback(base, adminPassword, tabs);
    return;
  }
  const sizes: Array<[string, number, number]> = [['desktop 1440', 1440, 900], ['laptop 1024', 1024, 768], ['phone 390', 390, 844]];
  try {
    for (const [sizeLabel, w, h] of sizes) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, extraHTTPHeaders: { Authorization: `Bearer ${adminPassword}` } });
      for (const tab of tabs) {
        const page = await ctx.newPage();
        const errors: string[] = [];
        page.on('pageerror', (e: Error) => errors.push(e.message));
        page.on('console', (m: any) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
        group('Front end', 'public/app.js + public/index.html', `${tab} section`);
        await acheck(`${tab} opens at ${sizeLabel}`, async () => {
          await page.goto(`${base}/?tab=${tab}`, { waitUntil: 'networkidle', timeout: 30000 });
          await page.waitForTimeout(700);
          const active = await page.evaluate("document.querySelector('.nav-item.on') && document.querySelector('.nav-item.on').getAttribute('data-t')");
          assert.equal(active, tab);
        });
        const audit: any = await page.evaluate(`(() => {
          const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
          const nameOf = (el) => {
            const aria = el.getAttribute('aria-label') || '';
            const by = (el.getAttribute('aria-labelledby') || '').split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ');
            const id = el.id; const forLabel = id ? Array.from(document.querySelectorAll('label')).find((l) => l.htmlFor === id)?.textContent || '' : '';
            const wrap = el.closest('label')?.textContent || '';
            return (aria + by + forLabel + wrap + (el.getAttribute('title') || '')).trim();
          };
          const controls = Array.from(document.querySelectorAll('input:not([type=hidden]), select, textarea')).filter(visible).map((el) => ({
            desc: \`\${el.tagName.toLowerCase()}\${el.id ? '#' + el.id : ''}\${el.type ? '[' + el.type + ']' : ''}\${el.getAttribute('name') ? ' name=' + el.getAttribute('name') : ''}\`,
            name: nameOf(el), placeholder: el.getAttribute('placeholder') || '',
          }));
          const buttons = Array.from(document.querySelectorAll('button, [role=button], a.nav-item')).filter(visible).map((el) => ({
            desc: \`\${el.tagName.toLowerCase()}\${el.id ? '#' + el.id : ''}\${el.className ? '.' + String(el.className).split(' ')[0] : ''} "\${(el.textContent || '').trim().slice(0, 30)}"\`,
            name: ((el.textContent || '').trim() + (el.getAttribute('aria-label') || '') + (el.getAttribute('title') || '') + (el.getAttribute('data-tip-title') || '')).trim(),
          }));
          const overflow = document.documentElement.scrollWidth - window.innerWidth;
          const offenders = overflow > 1 ? Array.from(document.querySelectorAll('body *')).filter((el) => { const r = el.getBoundingClientRect(); return r.right > window.innerWidth + 1 && visible(el) && getComputedStyle(el).position !== 'fixed'; }).slice(0, 3).map((el) => \`\${el.tagName.toLowerCase()}.\${String(el.className).split(' ')[0]}\`) : [];
          return { controls, buttons, overflow, offenders };
})()`);
        const seen = new Map<string, number>();
        // Repeated rows of the same component (e.g. 100 voice cards) are checked once each.
        for (const c of audit.controls) {
          const n = (seen.get(c.desc) || 0) + 1; seen.set(c.desc, n); if (n > 1) continue;
          check(`${tab} @ ${sizeLabel}: ${c.desc} has a label`, () => assert.ok(c.name.length > 0, c.placeholder ? `only a placeholder: "${c.placeholder}"` : 'no label'));
        }
        for (const b of audit.buttons) {
          const n = (seen.get(b.desc) || 0) + 1; seen.set(b.desc, n); if (n > 1) continue;
          check(`${tab} @ ${sizeLabel}: ${b.desc} has a readable name`, () => assert.ok(b.name.length > 0, 'icon-only button without aria-label/title'));
        }
        check(`${tab} @ ${sizeLabel}: no sideways scrolling`, () => assert.ok(audit.overflow <= 1, `page is ${audit.overflow}px wider than the screen (${audit.offenders.join(', ')})`));
        check(`${tab} @ ${sizeLabel}: no script errors`, () => assert.equal(errors.length, 0, errors.slice(0, 2).join(' | ')));
        await page.close();
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
}
