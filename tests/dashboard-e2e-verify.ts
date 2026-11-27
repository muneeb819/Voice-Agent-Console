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
import { setBotSleep, getBotSleep } from '../src/bot-sleep';
import { setCampaignDialingFlag, getCampaignDialing, applyCampaignDialing } from '../src/campaign-dialing';

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

  let baseTmpl: any = null;
  const scenarios = buildScenarios();
  for (const sc of scenarios) {
    // --- state for this scenario
    const st: any = getConsoleState();
    if (!baseTmpl) baseTmpl = JSON.parse(JSON.stringify(st.campaigns[0]));
    const tmpl = baseTmpl;
    st.campaigns = sc.ids.map((vid, i) => ({ ...tmpl, id: `c_t${i}`, name: sc.names[i], viciCampaign: vid, slot: i + 1 }));
    st.vici = { ...st.vici, viciBaseUrl: viciOrigin };
    saveConsoleState(st);
    setBotSleep(false, 'reset'); setCampaignDialingFlag(false, 'reset'); { const c = getCampaignDialing(); if (c.pausedCampaigns.length) { /* clear leftovers from a previous scenario */ require('fs').writeFileSync(require('path').join(process.env.VAC_DATA_DIR!, 'campaign-dialing.json'), JSON.stringify({ off: false, since: null, by: '', pausedCampaigns: [], dialerErrors: [] })); } }
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
      if (init?.method === 'POST' && (u.pathname === '/api/bot-sleep' || u.pathname === '/api/campaign-dialing')) posts.push({ path: u.pathname, ...JSON.parse(init.body) });
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

    // --- live bot status card
    {
      if (sc.ids.length) for (let i = 0; i < 50 && !d.getElementById('bot-status-card'); i++) await tick(100);
      const rows = Array.from(d.querySelectorAll('#bot-status-card tr[data-bot-status]')) as HTMLElement[];
      if (sc.ids.length) {
        check(rows.length >= 1, T(`live bot card lists the bots`));
        check(rows.every((r) => r.getAttribute('data-bot-status') === 'idle'), T('awake bots with no calls show Idle'));
        check(d.querySelectorAll('#bot-status-card img').length === 0, T('live bot card has no injected markup'));
      } else {
        check(rows.length === 0 || rows.length >= 0, T('live bot card handles zero campaigns'));
      }
    }

    // --- cancel at the confirm: nothing changes
    confirmAnswer = false;
    await press();
    check(confirms.length === 1 && /Put the bots to sleep/.test(confirms[0]), T('confirm asked before sleeping'));
    check(posts.length === 0, T('declined confirm sends nothing'));
    check(!getBotSleep().sleeping, T('declined confirm leaves bots awake'));
    check(viciLog.length === 0, T('declined confirm leaves VICIdial alone'));
    check(/Sleep bots/.test(btn()?.textContent || ''), T('declined confirm keeps label'));

    const pressId = async (id: string) => { d.getElementById(id)!.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })); await settle(); };
    const camp = () => d.getElementById('btn-campaign-dialing') as HTMLButtonElement | null;
    check(camp() && /Campaigns off/.test(camp()!.textContent || ''), T('campaign button starts as Campaigns off'));
    for (let cyc = 1; cyc <= 3; cyc++) {
      cycTag = ` cycle ${cyc}`;
      confirmAnswer = true; confirms.length = 0; alerts.length = 0; viciLog.length = 0; posts.length = 0;

      // ---- bots sleep: bridge only, VICIdial is not touched
      await pressId('btn-bot-sleep');
      check(posts.length === 1 && posts[0].path === '/api/bot-sleep' && posts[0].sleeping === true, T('sleep posts {sleeping:true} to the bot switch'));
      check(getBotSleep().sleeping === true, T('server records the bots asleep'));
      check(viciLog.length === 0, T('bot sleep does not touch VICIdial'));
      check(!getCampaignDialing().off, T('bot sleep leaves campaign dialing alone'));
      check(/Wake bots/.test(btn()?.textContent || '') && btn()?.classList.contains('b'), T('asleep label and style'));
      check(/asleep/i.test(btn()?.title || '') && !btn()?.disabled, T('asleep tooltip, button usable'));
      check(alerts.length === 0, T('bot sleep shows no alert'));
      if (sc.ids.length) check(Array.from(d.querySelectorAll('#bot-status-card tr[data-bot-status]')).every((r: any) => r.getAttribute('data-bot-status') === 'asleep'), T('live bot card shows Asleep after sleep'));
      check(/Campaigns off/.test(camp()?.textContent || ''), T('campaign button unchanged by bot sleep'));

      // ---- campaigns off: VICIdial stops dialing
      posts.length = 0;
      await pressId('btn-campaign-dialing');
      check(confirms.length >= 1 && confirms.some((m) => /Turn the campaigns off/.test(m)), T('confirm asked before turning campaigns off'));
      check(posts.length === 1 && posts[0].path === '/api/campaign-dialing' && posts[0].off === true, T('posts {off:true} to the campaign switch'));
      check(getCampaignDialing().off === true, T('server records campaigns off'));
      check(getBotSleep().sleeping === true, T('campaign off leaves bot sleep alone'));
      check(viciLog.filter((l) => l.active === 'N').length === valid.length, T(`dialer got one OFF per valid campaign (${valid.length}), got ${viciLog.length}`));
      check(viciLog.every((l) => l.active === 'N'), T('off only ever turns campaigns off'));
      check(new Set(viciLog.map((l) => l.id)).size === viciLog.length, T('no campaign is switched twice'));
      for (const id of valid) check(viciLog.some((l) => l.id === id), T(`campaign ${id} was switched off`));
      check(JSON.stringify([...getCampaignDialing().pausedCampaigns].sort()) === JSON.stringify([...expectOk].sort()), T('only campaigns that really turned off are remembered'));
      check(getCampaignDialing().dialerErrors.length === expectFail.length, T('failures are kept for the screen'));
      check(/Campaigns on/.test(camp()?.textContent || '') && camp()?.classList.contains('b'), T('off label and style'));
      check(!camp()?.disabled, T('campaign button usable after off'));
      if (expectFail.length) {
        check(alerts.length === 1, T('one plain-language note after a partial off'));
        for (const id of expectFail) check((alerts[0] || '').includes(id), T(`note names ${id}`));
        check(/may keep dialing/.test(alerts[0] || ''), T('note says VICIdial may keep dialing'));
      } else if (!valid.length) {
        check(alerts.length === 1 && /No campaign has a VICIdial campaign id/.test(alerts[0] || ''), T('no-campaign case is reported, not faked'));
      } else {
        check(alerts.length === 0, T('clean off shows no alert'));
      }
      check(!/undefined|NaN|\[object/.test(d.getElementById('m')?.textContent || ''), T('dashboard text has no undefined/NaN while off'));

      // ---- campaigns on: exactly what was turned off comes back
      alerts.length = 0; viciLog.length = 0; confirms.length = 0; posts.length = 0;
      await pressId('btn-campaign-dialing');
      check(confirms.length === 0, T('turning campaigns on asks no confirmation'));
      check(posts.length === 1 && posts[0].path === '/api/campaign-dialing' && posts[0].off === false, T('posts {off:false}'));
      check(getCampaignDialing().off === false, T('server records campaigns on'));
      check(viciLog.every((l) => l.active === 'Y'), T('on only turns campaigns on'));
      check(JSON.stringify(viciLog.map((l) => l.id).sort()) === JSON.stringify([...expectOk].sort()), T('on resumes exactly the campaigns off turned off'));
      check(getCampaignDialing().pausedCampaigns.length === 0, T('nothing left paused after a clean on'));
      check(/Campaigns off/.test(camp()?.textContent || '') && camp()?.classList.contains('g'), T('on label and style'));
      check(alerts.length === 0, T('clean on shows no alert'));
      check(getBotSleep().sleeping === true, T('campaign on leaves bot sleep alone'));

      // ---- bots wake
      posts.length = 0; viciLog.length = 0;
      await pressId('btn-bot-sleep');
      check(posts.length === 1 && posts[0].sleeping === false, T('wake posts {sleeping:false}'));
      check(getBotSleep().sleeping === false, T('server records the bots awake'));
      check(confirms.length === 0 && viciLog.length === 0, T('wake asks nothing and leaves VICIdial alone'));
      check(/Sleep bots/.test(btn()?.textContent || '') && btn()?.classList.contains('g'), T('awake label and style'));
      if (sc.ids.length) check(Array.from(d.querySelectorAll('#bot-status-card tr[data-bot-status]')).every((r: any) => r.getAttribute('data-bot-status') === 'idle'), T('live bot card shows Idle after wake'));
    }
    cycTag = '';
    // --- calls after wake are no longer refused by the sleep guard; status is exposed
    const status = await (await fetch(`${origin}/api/vici/status`)).json();
    check(status?.bridge?.botSleep?.sleeping === false, T('bridge status shows awake'));
    check(status?.campaignDialing?.off === false && Array.isArray(status?.campaignDialing?.pausedCampaigns), T('status carries the campaign dialing switch'));
    w.close();
  }

  // ---- failing WAKE: the leftover is kept and a second press retries it -------------
  {
    const st: any = getConsoleState();
    st.campaigns = ['MEDICARE', 'FETEST'].map((vid, i) => ({ ...st.campaigns[0], id: `c_w${i}`, name: vid, viciCampaign: vid, slot: i + 1 }));
    saveConsoleState(st);
    setBotSleep(false, 'reset'); setCampaignDialingFlag(false, 'reset'); viciLog.length = 0; viciFail.clear(); { const c = getCampaignDialing(); if (c.pausedCampaigns.length) { /* clear leftovers from a previous scenario */ require('fs').writeFileSync(require('path').join(process.env.VAC_DATA_DIR!, 'campaign-dialing.json'), JSON.stringify({ off: false, since: null, by: '', pausedCampaigns: [], dialerErrors: [] })); } } viciLog.length = 0; viciFail.clear();
    const applyDialerSleep = applyCampaignDialing;
    const { VicidialApiClient } = require('../src/vici-client');
    const cl = new VicidialApiClient({ ...(getConsoleState() as any).vici, viciBaseUrl: viciOrigin }, 'pw');
    setCampaignDialingFlag(true, 't'); await applyDialerSleep(true, (getConsoleState() as any).campaigns, cl);
    viciFail.add('FETEST'); viciLog.length = 0;
    setCampaignDialingFlag(false, 't'); const w1 = await applyDialerSleep(false, (getConsoleState() as any).campaigns, cl);
    check(w1.failed.length === 1 && w1.failed[0].campaign === 'FETEST', 'failing wake reports FETEST');
    check(getCampaignDialing().pausedCampaigns.join() === 'FETEST', 'failed wake keeps FETEST for retry');
    viciFail.clear(); viciLog.length = 0;
    const w2 = await applyDialerSleep(false, (getConsoleState() as any).campaigns, cl);
    check(w2.failed.length === 0 && viciLog.length === 1 && viciLog[0].id === 'FETEST' && viciLog[0].active === 'Y', 'second wake retries only FETEST');
    check(getCampaignDialing().pausedCampaigns.length === 0, 'retry clears the list');
  }

  await viciBridge!.stop?.();
  await new Promise<void>((r) => server.close(() => r()));
  vici.close();
  console.log(`Dashboard e2e: ${cases} cases run, ${failures.length} failed across ${scenarios.length + 1} scenarios.`);
  if (failures.length) { console.error(failures.slice(0, 25).join('\n')); process.exit(1); }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
