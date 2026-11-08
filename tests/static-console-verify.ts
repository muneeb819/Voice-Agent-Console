import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { JSDOM, VirtualConsole } from 'jsdom';

const root = path.resolve(__dirname, '..');
const publicDir = path.join(root, 'public');
const read = (file: string) => fs.readFileSync(path.join(publicDir, file), 'utf8');
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

async function fixture(options: { state?: any; storageFails?: boolean; tab?: string } = {}) {
  const html = read('index.html').replace(/<script[\s\S]*?<\/script>/g, '');
  const errors: string[] = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (error) => errors.push(error.message));
  const dom = new JSDOM(html, { url: `https://console.example/Voice-Agent-Console/?tab=${options.tab || 'agents'}`, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  (w as any).Response = Response;
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} } as any);
  w.localStorage.setItem('vac_cloud_session_v1', JSON.stringify({ user: { id: 'test', fullName: 'Test Operator', email: 'operator@example.test' } }));
  if (options.state) w.localStorage.setItem('vac_cloud_state_v1', JSON.stringify(options.state));
  if (options.storageFails) {
    const storageProto = Object.getPrototypeOf(w.localStorage);
    const original = storageProto.setItem;
    storageProto.setItem = function (key: string, value: string) { if (key === 'vac_cloud_state_v1') throw new w.DOMException('Quota exceeded', 'QuotaExceededError'); return original.call(this, key, value); };
  }
  const requests: string[] = [];
  w.fetch = (async (input: any) => {
    const url = String(input); requests.push(url);
    if (url.includes('/api/')) return new Response('<html>Not found</html>', { status: 404, headers: { 'content-type': 'text/html' } });
    const name = new URL(url, 'https://console.example/Voice-Agent-Console/').pathname.split('/').pop()!;
    if (['default-state.json', 'greetings.json', 'version.json'].includes(name)) return new Response(read(name), { headers: { 'content-type': 'application/json' } });
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  }) as any;
  (w as any).AudioContext = class { state = 'running'; destination = { stream: { getTracks: () => [] } }; resume() { return Promise.resolve(); } close() { return Promise.resolve(); } };
  (w as any).WebSocket = class { readyState = 0; send() {} close() {} };
  (w as any).indexedDB = undefined;
  w.eval(read('opening.js'));
  w.eval(read('app.js'));
  for (let i = 0; i < 30 && !w.document.getElementById('m')?.children.length; i++) await tick();
  assert.deepStrictEqual(errors, [], 'Console boot must not throw');
  assert(w.document.getElementById('m')?.children.length, 'Static console must finish loading');
  const change = (el: Element, event = 'change') => el.dispatchEvent(new w.Event(event, { bubbles: true }));
  const click = (el: Element) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const state = () => JSON.parse(w.localStorage.getItem('vac_cloud_state_v1') || 'null');
  return { w, d: w.document, requests, errors, change, click, state };
}

async function run() {
  const f = await fixture();
  const { d, w, change, click } = f;
  assert(!(d.getElementById('sv') as HTMLButtonElement).disabled, 'Save & Verify remains available after autosave');
  const name = d.querySelector('[data-p="a.name"]') as HTMLInputElement;
  name.value = 'Mobile edited bot'; change(name, 'input'); await tick();
  assert.equal(f.state().agents.find((a:any)=>a.id==='a_nova').name, 'Mobile edited bot', 'Mobile input events persist without blur');
  click(d.getElementById('sv')!); await tick();
  assert.match(d.getElementById('vr')!.textContent || '', /Saved in this browser.*Verification Report/s);
  assert.equal((d.getElementById('sv') as HTMLButtonElement).disabled, false);
  // Agent -> campaign assignment, then campaign -> multiple bots.
  const agentSelect = d.getElementById('sel-a') as HTMLSelectElement;
  agentSelect.value = 'a_jessica'; change(agentSelect);
  const campaignCheck = d.querySelector('[data-agent-campaign="c_medicare"]') as HTMLInputElement;
  campaignCheck.checked = true; change(campaignCheck);
  assert(f.state().campaigns.find((c: any) => c.id === 'c_medicare').agentIds.includes('a_jessica'));
  click(d.querySelector('[data-t="campaigns"]')!);
  const campaignSelect = d.getElementById('sel-c') as HTMLSelectElement;
  campaignSelect.value = 'c_medicare'; change(campaignSelect);
  const botCheck = d.querySelector('[data-campaign-agent="a_nova"]') as HTMLInputElement;
  botCheck.checked = true; change(botCheck);
  const campaign = f.state().campaigns.find((c: any) => c.id === 'c_medicare');
  assert(campaign.agentIds.includes('a_nova') && campaign.agentIds.includes('a_jessica'));
  assert.equal((d.getElementById('campaign-primary-agent') as HTMLSelectElement).value, 'a_medicare');
  click(d.getElementById('sv')!); await tick();
  // Shared campaign appears for a non-primary bot and retains explicit selection.
  click(d.querySelector('[data-t="test"]')!);
  (d.getElementById('sel-a') as HTMLSelectElement).value = 'a_nova'; change(d.getElementById('sel-a')!);
  const simCampaign = d.getElementById('sim-campaign') as HTMLSelectElement;
  assert([...simCampaign.options].some((o) => o.value === 'c_medicare'));
  simCampaign.value = 'c_medicare'; change(simCampaign);
  assert.match(d.getElementById('sim-call-setup')!.textContent || '', /Before starting|checks passed/);
  assert(!(d.getElementById('btn-call-mic') as HTMLButtonElement).disabled, 'Blocked setup explains requirements instead of a dead button');
  click(d.getElementById('btn-call-mic')!); await tick();
  assert.match(d.getElementById('m')!.textContent || '', /Live Call Error|Deepgram key needed|Campaign setup required/);
  assert.deepEqual(f.errors, []);
  w.close();

  const failed = await fixture({ storageFails: true });
  const input = failed.d.querySelector('[data-p="a.name"]') as HTMLInputElement;
  input.value = 'Do not lose me'; failed.change(input, 'input');
  failed.click(failed.d.getElementById('sv')!); await tick();
  assert.match(failed.d.getElementById('vr')!.textContent || '', /Save not confirmed.*Quota exceeded/s);
  assert.equal((failed.d.querySelector('[data-p="a.name"]') as HTMLInputElement).value, 'Do not lose me');
  assert.match(failed.d.getElementById('st')!.textContent || '', /Save pending/);
  assert.deepEqual(failed.errors, []);
  failed.w.close();

  const dashboard = await fixture({ tab: 'dashboard' });
  const text = dashboard.d.getElementById('m')!.textContent || '';
  assert.match(text, /Configuration Readiness/);
  assert.match(text, /no score is a 99\.999% reliability guarantee/);
  assert.match(text, /What still needs attention/);
  assert(!/GRADE D/.test(text), 'Valid shipped examples must not receive an arbitrary failing grade');
  dashboard.w.close();
  console.log('✓ Static console: mobile save, explicit verification, storage failure, bidirectional multi-bot assignment, simulator setup feedback and honest readiness');
}
run().catch((error) => { console.error(error); process.exit(1); });
