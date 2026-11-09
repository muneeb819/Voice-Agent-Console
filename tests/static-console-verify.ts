import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { JSDOM, VirtualConsole } from 'jsdom';

const root = path.resolve(__dirname, '..');
const publicDir = path.join(root, 'public');
const read = (file: string) => fs.readFileSync(path.join(publicDir, file), 'utf8');
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

async function fixture(options: { state?: any; storageFails?: boolean; tab?: string; query?: string; draft?: any; historyState?: any } = {}) {
  const html = read('index.html').replace(/<script[\s\S]*?<\/script>/g, '');
  const errors: string[] = [];
  const vc = new VirtualConsole();
  // JSDOM cannot follow real anchor navigations; modified/middle clicks are
  // intentionally left to the browser, so ignore only that stub limitation.
  vc.on('jsdomError', (error) => { if (!/Not implemented: navigation/.test(error.message)) errors.push(error.message); });
  const search = options.query ?? `?tab=${options.tab || 'agents'}`;
  const dom = new JSDOM(html, { url: `https://console.example/Voice-Agent-Console/${search}`, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  (w as any).Response = Response;
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} } as any);
  w.localStorage.setItem('vac_cloud_session_v1', JSON.stringify({ user: { id: 'test', fullName: 'Test Operator', email: 'operator@example.test' } }));
  if (options.state) w.localStorage.setItem('vac_cloud_state_v1', JSON.stringify(options.state));
  if (options.draft) w.localStorage.setItem('vac_console_unsaved_draft_v1', JSON.stringify(options.draft));
  if (options.historyState) w.history.replaceState(options.historyState, '');
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
  w.eval(read('brand-logos.js'));
  w.eval(read('app.js'));
  for (let i = 0; i < 30 && !w.document.getElementById('m')?.children.length; i++) await tick();
  assert.deepStrictEqual(errors, [], 'Console boot must not throw');
  assert(w.document.getElementById('m')?.children.length, 'Static console must finish loading');
  const change = (el: Element, event = 'change') => el.dispatchEvent(new w.Event(event, { bubbles: true }));
  const click = (el: Element, init: MouseEventInit = {}) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init }));
  const state = () => JSON.parse(w.localStorage.getItem('vac_cloud_state_v1') || 'null');
  return { w, d: w.document, requests, errors, change, click, state };
}

async function run() {
  const f = await fixture();
  const { d, w, change, click } = f;
  assert.equal((d.getElementById('sv') as HTMLButtonElement).disabled, true, 'Clean configuration must not offer an active save');
  assert.equal(d.getElementById('save-dock')!.hidden, true, 'Save dock stays hidden until an edit needs saving');
  assert.equal(d.getElementById('st'), null, 'The saved-in-browser header pill is removed');
  assert.equal(d.querySelector('.console-header h1, .console-header .brand-copy, .console-header .brand-sub'), null, 'Header keeps only the centered logo');
  assert(d.querySelector('.side-rail-footer #btn-theme'), 'Theme control lives in the side-rail footer');
  assert(d.querySelector('.side-rail-footer #btn-keys') && d.querySelector('.side-rail-footer #btn-account-menu'), 'Keys and account controls live in the side-rail footer');
  click(d.getElementById('btn-account-menu')!);
  assert.equal(d.getElementById('account-popover')!.hidden, false, 'Account links open from the rail footer');
  assert.notEqual((d.getElementById('btn-logout') as HTMLElement).style.display, 'none');
  click(d.getElementById('btn-account-menu')!);
  assert.equal(d.getElementById('account-popover')!.hidden, true);
  const savedBeforeEdit = JSON.stringify(f.state());
  const name = d.querySelector('[data-p="a.name"]') as HTMLInputElement;
  name.value = 'Mobile edited bot'; change(name, 'input'); await tick();
  assert.equal(JSON.stringify(f.state()), savedBeforeEdit, 'Typing must not auto-commit the saved browser state');
  assert.equal(d.getElementById('save-dock')!.hidden, false);
  assert.equal((d.getElementById('sv') as HTMLButtonElement).disabled, false);
  const draft = JSON.parse(w.localStorage.getItem('vac_console_unsaved_draft_v1') || 'null');
  assert.equal(draft.state.agents.find((a:any)=>a.id==='a_nova').name, 'Mobile edited bot', 'Unsaved edits are recoverable as a draft');
  // Section navigation must not force a save or discard the dirty draft.
  click(d.querySelector('[data-t="campaigns"]')!);
  click(d.querySelector('[data-t="agents"]')!);
  assert.equal((d.querySelector('[data-p="a.name"]') as HTMLInputElement).value, 'Mobile edited bot');
  assert.equal(d.getElementById('save-dock')!.hidden, false);

  // Navigation entries are real anchors with project-relative section URLs.
  const navLinks = [...d.querySelectorAll('#nav a.nav-item')] as HTMLAnchorElement[];
  assert.equal(navLinks.length, 9, 'Every side-rail section is a link');
  for (const link of navLinks) {
    const href = link.getAttribute('href') || '';
    assert(href.startsWith('/Voice-Agent-Console/?tab='), `Link keeps the GitHub Pages subpath: ${href}`);
    assert.equal(link.target, '', 'Links stay in the tab unless the browser opens a new one');
    assert(!link.hasAttribute('download'), 'Section links are not downloads');
  }
  // The browser context menu must remain native; nothing may cancel contextmenu.
  const contextEvent = new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
  navLinks[1].dispatchEvent(contextEvent);
  assert.equal(contextEvent.defaultPrevented, false, 'Right-click keeps the native Open link in new tab menu');
  // Modified and middle clicks are left to the browser instead of SPA navigation.
  const currentTab = d.querySelector('#nav a.nav-item.on')?.getAttribute('data-t');
  for (const init of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
    const evt = new w.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
    d.querySelector('#nav a[data-t="campaigns"]')!.dispatchEvent(evt);
    assert.equal(evt.defaultPrevented, false, 'Modified/middle click must not be intercepted');
    assert.equal(d.querySelector('#nav a.nav-item.on')?.getAttribute('data-t'), currentTab, 'Modified/middle click must not switch the current tab');
  }
  // Plain left click still navigates in-app and preserves the dirty draft.
  const plainEvt = new w.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  d.querySelector('#nav a[data-t="campaigns"]')!.dispatchEvent(plainEvt);
  assert.equal(plainEvt.defaultPrevented, true, 'Plain left click stays in-app');
  assert.equal(d.querySelector('#nav a.nav-item.on')?.getAttribute('data-t'), 'campaigns');
  assert.equal(new URL(w.location.href).searchParams.get('tab'), 'campaigns', 'Address bar reflects the active section');
  click(d.querySelector('#nav a[data-t="agents"]')!);
  assert.equal((d.querySelector('[data-p="a.name"]') as HTMLInputElement).value, 'Mobile edited bot');

  // A newly opened link reads the last saved state, not another tab's draft.
  const savedState = f.state();
  const sharedDraft = JSON.parse(w.localStorage.getItem('vac_console_unsaved_draft_v1') || 'null');
  assert(sharedDraft?.owner, 'Draft records its owning tab');
  const newTab = await fixture({ state: savedState, draft: sharedDraft, query: '?tab=agents&agent=a_nova' });
  assert.equal((newTab.d.querySelector('[data-p="a.name"]') as HTMLInputElement).value, savedState.agents.find((a:any)=>a.id==='a_nova').name, 'New tab shows saved configuration');
  assert.equal(newTab.d.getElementById('save-dock')!.hidden, true, 'New tab does not adopt the other tab’s unsaved dock');
  assert(newTab.w.localStorage.getItem('vac_console_unsaved_draft_v1'), 'New tab leaves the original draft intact');
  newTab.w.close();
  // The original tab can still recover its draft after a reload.
  const reloaded = await fixture({ draft: sharedDraft, query: '?tab=agents', historyState: { vacDraftOwner: sharedDraft.owner } });
  assert.equal((reloaded.d.querySelector('[data-p="a.name"]') as HTMLInputElement).value, 'Mobile edited bot', 'Same-tab reload recovers its own draft');
  assert.equal(reloaded.d.getElementById('save-dock')!.hidden, false);
  reloaded.w.close();

  click(d.getElementById('sv')!); await tick();
  assert.match(d.getElementById('vr')!.textContent || '', /Saved in this browser.*Verification Report/s);
  assert.equal(f.state().agents.find((a:any)=>a.id==='a_nova').name, 'Mobile edited bot', 'Explicit Save & Verify commits the edit');
  assert.equal(d.getElementById('save-dock')!.hidden, true, 'Successful save closes the dock');
  assert.equal((d.getElementById('sv') as HTMLButtonElement).disabled, true);
  // Agent -> campaign assignment, then campaign -> multiple bots.
  const agentSelect = d.getElementById('sel-a') as HTMLSelectElement;
  agentSelect.value = 'a_jessica'; change(agentSelect);
  const campaignCheck = d.querySelector('[data-agent-campaign="c_medicare"]') as HTMLInputElement;
  campaignCheck.checked = true; change(campaignCheck);
  assert.equal(d.getElementById('save-dock')!.hidden, false, 'Assignment edits open the explicit save dock');
  click(d.querySelector('[data-t="campaigns"]')!);
  const campaignSelect = d.getElementById('sel-c') as HTMLSelectElement;
  campaignSelect.value = 'c_medicare'; change(campaignSelect);
  const botCheck = d.querySelector('[data-campaign-agent="a_nova"]') as HTMLInputElement;
  botCheck.checked = true; change(botCheck);
  assert.equal((d.getElementById('campaign-primary-agent') as HTMLSelectElement).value, 'a_medicare');
  click(d.getElementById('sv')!); await tick();
  const campaign = f.state().campaigns.find((c: any) => c.id === 'c_medicare');
  assert(campaign.agentIds.includes('a_nova') && campaign.agentIds.includes('a_jessica'));
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
  // Theme Studio must swap the supplied banner logo, favicon and loader preview.
  click(d.getElementById('btn-theme')!);
  const initialLogo = (d.querySelector('#brand-mark img') as HTMLImageElement).getAttribute('src');
  assert.match(initialLogo || '', /mma-cyan-signal\.jpg/);
  assert.doesNotMatch(initialLogo || '', /-icon\.jpg/, 'Header shows the full landscape banner, not the square icon');
  click(d.querySelector('[data-pick-theme="ember_pulse"]')!);
  assert.match((d.querySelector('#brand-mark img') as HTMLImageElement).getAttribute('src') || '', /mma-gold-ember\.jpg/);
  assert.doesNotMatch((d.querySelector('#brand-mark img') as HTMLImageElement).getAttribute('src') || '', /-icon\.jpg/);
  assert.match((d.querySelector('link[rel="icon"]') as HTMLLinkElement).href, /mma-gold-ember-icon\.jpg/);
  assert.match((d.querySelector('#theme-loader-logo img') as HTMLImageElement).getAttribute('src') || '', /mma-gold-ember\.jpg/);
  assert(d.querySelectorAll('#theme-swatch-grid .theme-preview-logo img').length >= 10);
  assert.deepEqual(f.errors, []);
  w.close();

  const failed = await fixture({ storageFails: true });
  const input = failed.d.querySelector('[data-p="a.name"]') as HTMLInputElement;
  input.value = 'Do not lose me'; failed.change(input, 'input');
  failed.click(failed.d.getElementById('sv')!); await tick();
  assert.match(failed.d.getElementById('vr')!.textContent || '', /Save not confirmed.*Quota exceeded/s);
  assert.equal((failed.d.querySelector('[data-p="a.name"]') as HTMLInputElement).value, 'Do not lose me');
  assert.equal(failed.d.getElementById('save-dock')!.hidden, false, 'Failed save keeps the retry dock visible');
  assert.match(failed.d.getElementById('save-dock-lbl')!.textContent || '', /Save failed/);
  assert.equal((failed.d.getElementById('sv') as HTMLButtonElement).disabled, false);
  assert.deepEqual(failed.errors, []);
  failed.w.close();

  const dashboard = await fixture({ tab: 'dashboard' });
  const text = dashboard.d.getElementById('m')!.textContent || '';
  assert.match(text, /Configuration Readiness/);
  assert.match(text, /no score is a 99\.999% reliability guarantee/);
  assert.match(text, /What still needs attention|All configuration checks passed/);
  assert(!/GRADE D/.test(text), 'Valid shipped examples must not receive an arbitrary failing grade');
  for (const shortcut of [...dashboard.d.querySelectorAll('[data-cmd-tab], [data-fleet-campaign]')]) {
    assert.equal(shortcut.tagName, 'A', 'Dashboard and Fleet shortcuts are real links');
    assert((shortcut.getAttribute('href') || '').startsWith('/Voice-Agent-Console/?tab='), 'Shortcut URL keeps the Pages subpath');
  }
  const fleetButtons = [...dashboard.d.querySelectorAll('[data-fleet-campaign]')];
  assert(fleetButtons.length >= 1, 'Fleet Matrix first layer lists campaigns');
  assert.equal(dashboard.d.querySelector('[data-cmd-agent], [data-cmd-campaign], .fleet-detail'), null, 'First layer must not mix in bot chips or campaign detail');
  for (const button of fleetButtons) assert.match(button.textContent || '', /\S/);
  dashboard.click(fleetButtons[0]); await tick();
  assert(dashboard.d.getElementById('fleet-activity-badge'), 'Campaign click opens the second layer');
  assert.match(dashboard.d.getElementById('fleet-activity-badge')!.textContent || '', /Status unavailable/, 'Static demo must not invent live Active/Inactive status');
  assert.match(dashboard.d.getElementById('m')!.textContent || '', /Assigned bots/);
  assert.match(dashboard.d.getElementById('m')!.textContent || '', /Campaign analytics/);
  assert.match(dashboard.d.getElementById('m')!.textContent || '', /static demo has no server call history/i);
  assert.equal(dashboard.d.getElementById('btn-fleet-back')!.tagName, 'A', 'Fleet back control is a link');
  assert.equal(dashboard.d.querySelector('[data-cmd-campaign]')!.tagName, 'A', 'Campaign setup shortcut is a link');
  assert.equal(dashboard.d.querySelector('[data-fleet-agent]')!.tagName, 'A', 'Assigned bot shortcut is a link');
  dashboard.click(dashboard.d.getElementById('btn-fleet-back')!);
  assert.equal(dashboard.d.querySelector('.fleet-detail'), null, 'Back returns to the campaign-name layer');
  assert.equal(new URL(dashboard.w.location.href).searchParams.has('fleetCampaign'), false, 'Back clears the Fleet detail URL');
  assert.deepEqual(dashboard.errors, []);
  dashboard.w.close();
  const deepLink = await fixture({ query: '?tab=agents&agent=a_jessica' });
  assert.equal((deepLink.d.getElementById('sel-a') as HTMLSelectElement).value, 'a_jessica', 'Section links can select a saved bot');
  assert.equal(deepLink.d.querySelector('#nav a.nav-item.on')?.getAttribute('data-t'), 'agents');
  deepLink.w.close();
  const fleetLink = await fixture({ query: '?tab=dashboard&fleetCampaign=c_medicare' });
  assert(fleetLink.d.getElementById('fleet-activity-badge'), 'Fleet detail links open the second layer directly');
  assert.equal(new URL(fleetLink.w.location.href).searchParams.get('fleetCampaign'), 'c_medicare');
  fleetLink.w.close();
  const legacyState = JSON.parse(read('default-state.json'));
  legacyState.campaigns[0].presenceCheckText = 'Old presence prompt';
  legacyState.campaigns[0].deadAirTimeoutSec = 3;
  legacyState.campaigns[0].deadAirDisposition = 'DAIR';
  legacyState.campaigns[0].deadAirDispositionVerified = false;
  const retired = await fixture({ state: legacyState, tab: 'campaigns' });
  const migratedCampaign = retired.state().campaigns[0];
  for (const key of ['presenceCheckText', 'deadAirTimeoutSec', 'deadAirDisposition', 'deadAirDispositionVerified']) {
    assert.equal(Object.prototype.hasOwnProperty.call(migratedCampaign, key), false, `Static migration removes ${key}`);
  }
  assert.equal(retired.d.querySelector('[data-p="c.presenceCheckText"], [data-p="c.deadAirTimeoutSec"], [data-p="c.deadAirDisposition"], [data-p="c.deadAirDispositionVerified"]'), null);
  assert.doesNotMatch(retired.d.getElementById('m')!.textContent || '', /dead-air|presence-check/i);
  assert.deepEqual(retired.errors, []);
  retired.w.close();

  console.log('✓ Static console: full landscape header logo, native right-click/new-tab links, rail utilities, explicit save dock, free section navigation, per-tab draft recovery, two-layer Fleet Matrix, storage failure, multi-bot assignment, simulator setup feedback and honest readiness');
}
run().catch((error) => { console.error(error); process.exit(1); });
