// Dashboard end-to-end matrix. A real console server, the real dashboard page (jsdom) and a
// fake VICIdial run together; every scenario presses Sleep and Wake and every assertion is a
// counted case. Nothing here is generated and left unrun.
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
process.env.VAC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vac-dash-'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { JSDOM, VirtualConsole } = require('jsdom');
import { createServerWithSimulator } from '../src/server';
import { getConsoleState, saveConsoleState } from '../src/db';
import { setBotSleep, setDialerOutcome, getBotSleep } from '../src/bot-sleep';

const pub = path.resolve(__dirname, '..', 'public');
const read = (f: string) => fs.readFileSync(path.join(pub, f), 'utf8');
const tick = (ms = 25) => new Promise<void>((r) => setTimeout(r, ms));

let cases = 0;
const failures: string[] = [];
function check(cond: unknown, label: string) {
  cases++;
  if (!cond) failures.push(label);
}

// ---- fake VICIdial -------------------------------------------------------------
const viciLog: { id: string; active: string }[] = [];
const viciFail = new Set<string>();
const vici = http.createServer((req, res) => {
  const q = new URL(req.url || '/', 'http://x').searchParams;
  if (q.get('function') === 'update_campaign') {
    const id = q.get('campaign_id') || '';
    viciLog.push({ id, active: q.get('active') || '' });
    res.end(viciFail.has(id) ? 'ERROR: update_campaign USER DOES NOT HAVE PERMISSION TO UPDATE CAMPAIGNS' : `SUCCESS: update_campaign - ${id}`);
    return;
  }
  res.end('ERROR: unsupported');
});

// ---- scenarios -----------------------------------------------------------------
interface Scenario { name: string; ids: string[]; fail: string[]; names: string[] }
const NAMES = ['Medicare', 'Final <b>Expense</b>', 'Q"uote\'s', 'Ünïcödé ✓', 'x'.repeat(80), '<img src=x onerror=alert(1)>', 'Plain'];
function buildScenarios(): Scenario[] {
  const out: Scenario[] = [];
  const idPool = ['MEDICARE', 'FETEST', 'NOVACONC', 'A_B-1', 'Q4', 'BUILTIN'];
  const failSets = (ids: string[]) => {
    const u = [...new Set(ids.filter((i) => /^[A-Za-z0-9_-]{1,20}$/.test(i)))];
    const sets: string[][] = [[]];
    if (u.length) sets.push([u[0]]);
    if (u.length > 1) sets.push([u[u.length - 1]], u);
    return sets;
  };
  for (let n = 0; n <= 6; n++) {
    const ids = idPool.slice(0, n);
    for (const fail of failSets(ids)) out.push({ name: `${n} campaigns, fail=[${fail}]`, ids, fail, names: ids.map((_, i) => NAMES[i % NAMES.length]) });
  }
  out.push({ name: 'duplicate ids', ids: ['MEDICARE', 'MEDICARE', 'FETEST'], fail: [], names: ['A', 'B', 'C'] });
  out.push({ name: 'duplicate ids one failing', ids: ['MEDICARE', 'MEDICARE', 'FETEST'], fail: ['MEDICARE'], names: ['A', 'B', 'C'] });
  out.push({ name: 'empty id among real', ids: ['MEDICARE', '', 'FETEST'], fail: [], names: ['A', 'B', 'C'] });
  out.push({ name: 'only empty ids', ids: ['', ''], fail: [], names: ['A', 'B'] });
  out.push({ name: 'invalid id chars', ids: ['MEDICARE', 'BAD ID', 'X&Y'], fail: [], names: ['A', 'B', 'C'] });
  out.push({ name: 'hostile names', ids: ['MEDICARE', 'FETEST'], fail: [], names: [NAMES[5], NAMES[1]] });
  // Name styles x id counts, to vary what the dashboard has to render and escape.
  NAMES.forEach((nm, i) => out.push({ name: `name style ${i}`, ids: ['MEDICARE', 'FETEST', 'NOVACONC'], fail: i % 2 ? ['FETEST'] : [], names: [nm, nm, nm] }));
  return out;
}

async function main() {
  await new Promise<void>((r) => vici.listen(0, '127.0.0.1', r));
  const viciOrigin = `http://127.0.0.1:${(vici.address() as any).port}`;
  const { server, viciBridge } = createServerWithSimulator({ enableBridge: true, host: '127.0.0.1', audioSocketPort: 0, sipPort: 0 } as any);
  await viciBridge!.start();
  await new Promise<void>((r) => (server as http.Server).listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const baseHtml = read('index.html').replace(/<script[\s\S]*?<\/script>/g, '');

  const scenarios = buildScenarios();
  for (const sc of scenarios) {
    // --- state for this scenario
    const st: any = getConsoleState();
    const tmpl = st.campaigns[0];
    st.campaigns = sc.ids.map((vid, i) => ({ ...tmpl, id: `c_t${i}`, name: sc.names[i], viciCampaign: vid, slot: i + 1 }));
    st.vici = { ...st.vici, viciBaseUrl: viciOrigin };
    saveConsoleState(st);
    setBotSleep(false, 'reset'); setDialerOutcome([], []);
    viciLog.length = 0; viciFail.clear(); sc.fail.forEach((f) => viciFail.add(f));
    const distinct = [...new Set(sc.ids.map((i) => i.trim()).filter(Boolean))];
    const valid = distinct.filter((i) => /^[A-Za-z0-9_-]{1,20}$/.test(i));
    const invalid = distinct.filter((i) => !valid.includes(i));
    const expectOk = valid.filter((i) => !viciFail.has(i));
    const expectFail = [...valid.filter((i) => viciFail.has(i)), ...invalid];

    // --- boot the dashboard
    const errors: string[] = [];
    const vc = new VirtualConsole();
    vc.on('jsdomError', (e: any) => { if (!/Not implemented: navigation/.test(e.message)) errors.push(e.message); });
    const dom = new JSDOM(baseHtml, { url: `${origin}/?tab=dashboard`, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
    const w: any = dom.window;
    const posts: any[] = []; let inflight = 0;
    w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    w.fetch = async (input: any, init?: any) => {
      const u = new URL(String(input), origin + '/');
      if (u.pathname.endsWith('/api/auth/status')) return new Response(JSON.stringify({ ok: true, authenticated: true, user: { fullName: 'Test', email: 't@x.test' } }), { headers: { 'content-type': 'application/json' } });
      if (init?.method === 'POST' && u.pathname === '/api/bot-sleep') posts.push(JSON.parse(init.body));
      inflight++;
      try { return await fetch(u.toString(), init); } finally { inflight--; }
    };
    w.AudioContext = class {}; w.WebSocket = class { readyState = 0; send() {} close() {} }; w.indexedDB = undefined;
    const alerts: string[] = []; const confirms: string[] = []; let confirmAnswer = true;
    w.alert = (m: string) => { alerts.push(String(m)); };
    w.confirm = (m: string) => { confirms.push(String(m)); return confirmAnswer; };
    w.eval(read('opening.js')); w.eval(read('persona.js')); w.eval(read('brand-logos.js')); w.eval(read('app.js'));
    for (let i = 0; i < 80 && !w.document.getElementById('btn-bot-sleep'); i++) await tick();
    const d = w.document;
    const btn = () => d.getElementById('btn-bot-sleep') as HTMLButtonElement | null;
    const settle = async () => { await tick(60); for (let i = 0; i < 120 && inflight > 0; i++) await tick(25); await tick(120); };
    const press = async () => { btn()!.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })); await settle(); };
    let cycTag = '';
    const T = (m: string) => `[${sc.name}${cycTag}] ${m}`;
    await settle();

    // --- awake render
    const text = d.getElementById('m')?.textContent || '';
    check(btn(), T('Sleep button is on the dashboard'));
    check(/Sleep bots/.test(btn()?.textContent || ''), T('awake label says Sleep bots'));
    check(btn()?.classList.contains('g') && !btn()?.classList.contains('b'), T('awake button uses the calm style'));
    check(/Put the bots to sleep/.test(btn()?.title || ''), T('awake tooltip explains sleep'));
    check(!btn()?.disabled, T('awake button is enabled'));
    check(!/undefined|NaN|\[object/.test(text), T('dashboard text has no undefined/NaN/[object]'));
    check(errors.length === 0, T(`no script errors on load: ${errors[0] || ''}`));
    check(d.querySelectorAll('img[src="x"]').length === 0, T('hostile campaign names are escaped, no injected image'));
    check(d.querySelectorAll('script:not([src])').length === 0, T('no injected script element'));

    // --- cancel at the confirm: nothing changes
    confirmAnswer = false;
    await press();
    check(confirms.length === 1 && /Put the bots to sleep/.test(confirms[0]), T('confirm asked before sleeping'));
    check(posts.length === 0, T('declined confirm sends nothing'));
    check(!getBotSleep().sleeping, T('declined confirm leaves bots awake'));
    check(viciLog.length === 0, T('declined confirm leaves VICIdial alone'));
    check(/Sleep bots/.test(btn()?.textContent || ''), T('declined confirm keeps label'));

    for (let cyc = 1; cyc <= 3; cyc++) {
      // --- sleep
      cycTag = ` cycle ${cyc}`;
      confirmAnswer = true; confirms.length = 0; alerts.length = 0; viciLog.length = 0; posts.length = 0;
      await press();
      check(confirms.length === 1, T('confirm asked once for sleep'));
      check(posts.length === 1 && posts[0].sleeping === true, T('sleep posts {sleeping:true}'));
      check(getBotSleep().sleeping === true, T('server records the bots asleep'));
      check(viciLog.filter((l) => l.active === 'N').length === valid.length, T(`dialer got one OFF per valid campaign (${valid.length}), got ${viciLog.length}`));
      check(viciLog.every((l) => l.active === 'N'), T('sleep only ever turns campaigns off'));
      check(new Set(viciLog.map((l) => l.id)).size === viciLog.length, T('no campaign is switched twice'));
      for (const id of valid) check(viciLog.some((l) => l.id === id), T(`campaign ${id} was switched off`));
      check(JSON.stringify([...getBotSleep().pausedCampaigns].sort()) === JSON.stringify([...expectOk].sort()), T('only campaigns that really turned off are remembered'));
      check(getBotSleep().dialerErrors.length === expectFail.length, T('failures are kept for the screen'));
      check(/Wake bots/.test(btn()?.textContent || ''), T('asleep label says Wake bots'));
      check(btn()?.classList.contains('b') && !btn()?.classList.contains('g'), T('asleep button uses the highlighted style'));
      check(/asleep/i.test(btn()?.title || ''), T('asleep tooltip says asleep'));
      check(!btn()?.disabled, T('button is usable again after sleep'));
      if (expectFail.length) {
        check(alerts.length === 1, T('one plain-language note after a partial sleep'));
        for (const id of expectFail) check((alerts[0] || '').includes(id), T(`note names ${id}`));
        check(/still turned away/.test(alerts[0] || ''), T('note says calls are still refused'));
      } else if (!valid.length) {
        check(alerts.length === 1 && /No campaign has a VICIdial campaign id/.test(alerts[0] || ''), T('no-campaign case is reported, not faked'));
      } else {
        check(alerts.length === 0, T('clean sleep shows no alert'));
      }
      check(!/undefined|NaN|\[object/.test(d.getElementById('m')?.textContent || ''), T('asleep dashboard has no undefined/NaN'));

      // --- wake (with the dialer still failing for the same campaigns)
      alerts.length = 0; viciLog.length = 0; confirms.length = 0; posts.length = 0;
      await press();
      check(confirms.length === 0, T('wake asks no confirmation'));
      check(posts.length === 1 && posts[0].sleeping === false, T('wake posts {sleeping:false}'));
      check(getBotSleep().sleeping === false, T('server records the bots awake'));
      check(viciLog.every((l) => l.active === 'Y'), T('wake only turns campaigns on'));
      check(JSON.stringify(viciLog.map((l) => l.id).sort()) === JSON.stringify([...expectOk].sort()), T('wake resumes exactly the campaigns sleep turned off'));
      const stillFailing = expectOk.filter((i) => viciFail.has(i));
      check(stillFailing.length === 0, T('(setup) failing campaigns were never remembered'));
      check(/Sleep bots/.test(btn()?.textContent || ''), T('awake label is back'));
      check(btn()?.classList.contains('g'), T('awake style is back'));
      check(getBotSleep().pausedCampaigns.length === 0, T('nothing left paused after a clean wake'));
      check(alerts.length === 0, T('clean wake shows no alert'));


    }
    cycTag = '';
    // --- calls after wake are no longer refused by the sleep guard; status is exposed
    const status = await (await fetch(`${origin}/api/vici/status`)).json();
    check(status?.bridge?.botSleep?.sleeping === false, T('bridge status shows awake'));
    check(Array.isArray(status?.bridge?.botSleep?.pausedCampaigns), T('bridge status carries the paused list'));
    w.close();
  }

  // ---- failing WAKE: the leftover is kept and a second press retries it -------------
  {
    const st: any = getConsoleState();
    st.campaigns = ['MEDICARE', 'FETEST'].map((vid, i) => ({ ...st.campaigns[0], id: `c_w${i}`, name: vid, viciCampaign: vid, slot: i + 1 }));
    saveConsoleState(st);
    setBotSleep(false, 'reset'); setDialerOutcome([], []); viciLog.length = 0; viciFail.clear();
    const { applyDialerSleep } = require('../src/dialer-sleep');
    const { VicidialApiClient } = require('../src/vici-client');
    const cl = new VicidialApiClient({ ...(getConsoleState() as any).vici, viciBaseUrl: viciOrigin }, 'pw');
    setBotSleep(true, 't'); await applyDialerSleep(true, (getConsoleState() as any).campaigns, cl);
    viciFail.add('FETEST'); viciLog.length = 0;
    setBotSleep(false, 't'); const w1 = await applyDialerSleep(false, (getConsoleState() as any).campaigns, cl);
    check(w1.failed.length === 1 && w1.failed[0].campaign === 'FETEST', 'failing wake reports FETEST');
    check(getBotSleep().pausedCampaigns.join() === 'FETEST', 'failed wake keeps FETEST for retry');
    viciFail.clear(); viciLog.length = 0;
    const w2 = await applyDialerSleep(false, (getConsoleState() as any).campaigns, cl);
    check(w2.failed.length === 0 && viciLog.length === 1 && viciLog[0].id === 'FETEST' && viciLog[0].active === 'Y', 'second wake retries only FETEST');
    check(getBotSleep().pausedCampaigns.length === 0, 'retry clears the list');
  }

  await viciBridge!.stop?.();
  await new Promise<void>((r) => server.close(() => r()));
  vici.close();
  console.log(`Dashboard e2e: ${cases} cases run, ${failures.length} failed across ${scenarios.length + 1} scenarios.`);
  if (failures.length) { console.error(failures.slice(0, 25).join('\n')); process.exit(1); }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
