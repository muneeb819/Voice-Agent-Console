import assert from 'assert';
import fs from 'fs';
import path from 'path';

const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

// Every control built with F('label', 'path', ...) must have a short help entry.
const paths = new Set<string>();
for (const m of app.matchAll(/\bF\(\s*(?:'[^'\n]*'|"[^"\n]*"|`[^`\n]*`)\s*,\s*'([acv]\.[A-Za-z0-9_.]+)'/g)) paths.add(m[1]);
assert(paths.size > 60, `found the console controls (${paths.size})`);

const block = app.match(/const HELP = (\{[\s\S]*?\n  \});/);
assert(block, 'HELP map exists');
const HELP: Record<string, string> = JSON.parse(block![1]);
for (const p of paths) assert(HELP[p], `control ${p} has help text`);
for (const k of Object.keys(HELP)) {
  assert(paths.has(k), `help entry ${k} belongs to a real control`);
  assert(HELP[k].length >= 20 && HELP[k].length <= 200, `help for ${k} is short (${HELP[k].length} chars)`);
}

// Popover behaviour, run against the real click handler in a DOM.
const { JSDOM } = require('jsdom');
const start = app.indexOf('// One shared help popover');
const end = app.indexOf("document.addEventListener('click', (e) => {\n    const pop = document.getElementById('account-popover');");
assert(start > 0 && end > start, 'popover handler found');
const dom = new JSDOM('<body><div class="fld"><label>Name<button type="button" class="help-btn" data-help="a.name" aria-expanded="false">?</button></label></div><p id="x">out</p></body>');
const w = dom.window;
new Function('HELP', 'document', 'window', app.slice(start, end))({ 'a.name': HELP['a.name'] }, w.document, w);
const btn = w.document.querySelector('.help-btn');
btn.click();
const pop = w.document.getElementById('help-pop');
assert(pop && !pop.hidden && pop.textContent === HELP['a.name'], 'click opens the help text');
assert.strictEqual(btn.getAttribute('aria-expanded'), 'true');
btn.click();
assert(pop.hidden && btn.getAttribute('aria-expanded') === 'false', 'second click closes it');
btn.click();
w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape' }));
assert(pop.hidden, 'Escape closes it');
btn.click();
w.document.getElementById('x').click();
assert(pop.hidden, 'clicking elsewhere closes it');

console.log('help-popups-verify: all checks passed');
