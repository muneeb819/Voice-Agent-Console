// Runs the full quality pass: in-process module checks, the HTTP API against a
// live server, the browser UI, then saved-state fuzzing sized so the total is
// exactly TARGET executed checks. Writes results.json for the report.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { results } from './harness';
import { runUnit, runStateFuzz } from './unit';
import { discoverRoutes, runApi } from './api';
import { runUi } from './ui';

const TARGET = Number(process.env.QA_TARGET || 10100);
const root = path.resolve(__dirname, '../..');

async function main() {
  const t0 = Date.now();
  await runUnit();
  const unitCount = results.length;

  const port = 5600 + Math.floor(Math.random() * 300);
  const base = `http://127.0.0.1:${port}`;
  const srv = spawn(process.execPath, ['dist/server.js'], {
    cwd: root,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), AUDIOSOCKET_PORT: '0', BRIDGE_SIP_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; srv.stdout.on('data', (d) => (log += d)); srv.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/health/live')).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 250)); }
  const routes = discoverRoutes(fs.readFileSync(path.join(root, 'src/server.ts'), 'utf8'));
  try {
    await runApi(base, process.env.ADMIN_PASSWORD!, routes);
    const apiCount = results.length - unitCount;
    await runUi(base, process.env.ADMIN_PASSWORD!);
    const uiCount = results.length - unitCount - apiCount;
    const fuzz = TARGET - results.length;
    if (fuzz < 0) {
      const by: Record<string, number> = {};
      for (const r of results) by[`${r.area} | ${r.family}`] = (by[`${r.area} | ${r.family}`] || 0) + 1;
      console.log(JSON.stringify(by, null, 1), { unitCount, apiCount, uiCount, failed: results.filter((r) => !r.ok).length });
      fs.writeFileSync('/tmp/qa-over.json', JSON.stringify(results.filter((r) => !r.ok)));
      throw new Error(`already ${results.length} checks, over target`);
    }
    runStateFuzz(fuzz);
    const passed = results.filter((r) => r.ok).length;
    const out = { target: TARGET, total: results.length, passed, failed: results.length - passed, seconds: Math.round((Date.now() - t0) / 1000), routes: routes.length, counts: { unit: unitCount, api: apiCount, ui: uiCount, stateFuzz: fuzz }, results };
    fs.writeFileSync(process.env.QA_OUT || '/tmp/qa-results.json', JSON.stringify(out));
    fs.writeFileSync('/tmp/qa-server.log', log);
    console.log(`TOTAL ${out.total}  PASSED ${passed}  FAILED ${out.failed}  in ${out.seconds}s  (unit ${unitCount}, api ${apiCount}, ui ${uiCount}, state fuzz ${fuzz})`);
    if (out.failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    srv.kill();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
