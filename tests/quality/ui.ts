// Browser checks on every console section at desktop, laptop and phone widths:
// no script errors, every visible control has a label, every button has a name,
// no sideways scrolling.
import { acheck, assert, check, group } from './harness';

export async function runUi(base: string, adminPassword: string) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { chromium } = require('/opt/npm-tools/node_modules/playwright-core');
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const tabs = ['dashboard', 'agents', 'plugins', 'campaigns', 'voice', 'test', 'vici', 'wallboard', 'export'];
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
