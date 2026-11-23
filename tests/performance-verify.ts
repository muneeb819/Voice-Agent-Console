// Smooth operation: gzip on large responses, smooth visual mode by default.
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import http from 'http';

let checks = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); checks++; };

function get(url: string, gzip: boolean): Promise<{ status: number; enc: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: gzip ? { 'Accept-Encoding': 'gzip' } : {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, enc: String(res.headers['content-encoding'] || ''), body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
  });
}

(async () => {
  const root = path.resolve(__dirname, '..');
  const css = fs.readFileSync(path.join(root, 'public/atelier.css'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
  ok(/html:not\(\.fx-full\) body::after \{\s*animation: none !important;/.test(css), 'watermark animation frozen in smooth mode');
  ok(css.includes('backdrop-filter: none !important') && css.includes('html:not(.fx-full) .hdr-waves i'), 'blur and decorative loops off in smooth mode');
  ok(html.includes("localStorage.getItem('vac_fx') === 'full'") && html.includes('id="btn-fx-toggle"'), 'effects choice applied before first paint, toggle in account menu');
  ok(js.includes("b.id === 'btn-fx-toggle'"), 'toggle handler present');

  const base = process.env.TEST_URL;
  if (base) {
    for (const p of ['/app.js', '/styles.css', '/api/state']) {
      const r = await get(base + p, true);
      ok(r.status === 200 && r.enc === 'gzip', `${p} is gzip-compressed`);
      const plain = zlib.gunzipSync(r.body);
      ok(plain.length > r.body.length * 2, `${p} shrinks (${plain.length} -> ${r.body.length} bytes)`);
    }
    const raw = await get(base + '/app.js', false);
    ok(raw.enc === '' && raw.body.length > 100000, 'clients without gzip still get plain files');
  }
  console.log(`✓ Smooth operation: ${checks} checks passed`);
})().catch((err) => { console.error(err); process.exit(1); });
