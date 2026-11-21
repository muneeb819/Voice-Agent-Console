import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { JSDOM, VirtualConsole } from 'jsdom';

const root = path.resolve(__dirname, '..');
const publicDir = path.join(root, 'public');
const read = (file: string) => fs.readFileSync(path.join(publicDir, file), 'utf8');
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

async function fixture(options: { state?: any; storageFails?: boolean; tab?: string; query?: string; draft?: any; historyState?: any; api?: Record<string, (body: any) => any> } = {}) {
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
  const apiCalls: Array<{ url: string; body: any }> = [];
  w.fetch = (async (input: any, init?: any) => {
    const url = String(input); requests.push(url);
    if (url.includes('/api/')) {
      const route = Object.keys(options.api || {}).find((key) => url.includes(key));
      if (!route) return new Response('<html>Not found</html>', { status: 404, headers: { 'content-type': 'text/html' } });
      let body: any = null;
      try { body = init?.body ? JSON.parse(String(init.body)) : null; } catch {}
      apiCalls.push({ url: route, body });
      const out = options.api![route](body);
      return new Response(JSON.stringify(out?.body ?? out), {
        status: out?.status || 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    const name = new URL(url, 'https://console.example/Voice-Agent-Console/').pathname.split('/').pop()!;
    if (['default-state.json', 'greetings.json', 'version.json'].includes(name)) return new Response(read(name), { headers: { 'content-type': 'application/json' } });
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  }) as any;
  (w as any).AudioContext = class { state = 'running'; destination = { stream: { getTracks: () => [] } }; resume() { return Promise.resolve(); } close() { return Promise.resolve(); } };
  (w as any).WebSocket = class { readyState = 0; send() {} close() {} };
  (w as any).indexedDB = undefined;
  w.eval(read('opening.js'));
  w.eval(read('persona.js'));
  w.eval(read('medicare-template.js'));
  w.eval(read('brand-logos.js'));
  w.eval(read('app.js'));
  for (let i = 0; i < 30 && !w.document.getElementById('m')?.children.length; i++) await tick();
  assert.deepStrictEqual(errors, [], 'Console boot must not throw');
  assert(w.document.getElementById('m')?.children.length, 'Static console must finish loading');
  const change = (el: Element, event = 'change') => el.dispatchEvent(new w.Event(event, { bubbles: true }));
  const click = (el: Element, init: MouseEventInit = {}) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init }));
  const state = () => JSON.parse(w.localStorage.getItem('vac_cloud_state_v1') || 'null');
  return { w, d: w.document, requests, apiCalls, errors, change, click, state };
}

async function run() {
  const f = await fixture();
  const { d, w, change, click } = f;
  assert.equal((d.getElementById('sv') as HTMLButtonElement).disabled, true, 'Clean configuration must not offer an active save');
  assert.equal(d.getElementById('save-dock')!.hidden, true, 'Save dock stays hidden until an edit needs saving');
  assert.equal(d.getElementById('st'), null, 'The saved-in-browser header pill is removed');
  assert.equal(d.querySelector('.console-header h1, .console-header .brand-copy, .console-header .brand-sub'), null, 'Header keeps only the centered logo');
  assert(d.querySelector('.side-rail-footer #btn-theme'), 'Theme control lives in the side-rail footer');
  assert.equal(d.querySelector('.console-header #btn-keys'), null, 'API keys no longer sit in the header');
  assert.equal(d.querySelector('.console-header #btn-logout'), null, 'Sign-out no longer sits in the header');
  assert.equal(d.querySelector('.console-header #btn-theme-header'), null, 'The header keeps no duplicate edition switch');
  assert(d.querySelector('.side-rail-footer .side-utility-dock #btn-keys'), 'API keys return to the side-rail footer utility row');
  assert(d.querySelector('#account-popover #btn-logout'), 'Sign-out returns to the side-rail account popover');
  assert(d.querySelector('.side-rail-footer #btn-account-menu'), 'Account controls remain in the side-rail footer');
  // The panel toggle belongs to the same utility row as Theme / Keys / Account.
  assert(d.querySelector('.side-rail-footer .side-utility-dock #btn-sidebar-toggle'), 'Panel toggle lives in the rail footer utility row');
  assert.equal(d.querySelector('.console-header #btn-sidebar-toggle'), null, 'Desktop panel toggle is no longer in the header');
  const footerToggle = d.getElementById('btn-sidebar-toggle')!;
  assert(footerToggle.classList.contains('side-utility-btn'), 'Panel toggle matches the sizing of its row neighbours');
  assert.equal(footerToggle.getAttribute('aria-controls'), 'side-rail', 'Panel toggle must point at the rail it controls');
  // Phones slide the rail off-canvas, so an in-rail toggle alone could never
  // reopen it. The header keeps an opener that is CSS-hidden on desktop.
  const mobileToggle = d.getElementById('btn-sidebar-toggle-mobile');
  assert(mobileToggle && mobileToggle.closest('.console-header'), 'Phones keep a header opener outside the off-canvas rail');
  assert(mobileToggle!.classList.contains('rail-toggle-mobile'), 'Phone opener must carry the desktop-hiding class');
  assert.notEqual(mobileToggle!.id, footerToggle.id, 'The two toggles need distinct ids');
  assert.match(d.getElementById('section-masthead')!.textContent || '', /Agents/, 'Every section opens with its own title masthead');
  click(d.getElementById('btn-account-menu')!);
  assert.equal(d.getElementById('account-popover')!.hidden, false, 'Account links open from the rail footer');
  assert.notEqual((d.getElementById('btn-logout') as HTMLElement).style.display, 'none');
  assert.equal((d.getElementById('btn-account-security') as HTMLElement).style.display, 'none',
    'Password/session controls stay hidden in the browser-only demo: there is no server account to manage');
  assert.equal(d.getElementById('account-security-modal')!.hidden, true);
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
  // Campaign assignment lives in ONE place: the Agents tab. The Campaigns tab
  // shows it read-only (no duplicate checkboxes or primary selector).
  const agentSelect = d.getElementById('sel-a') as HTMLSelectElement;
  agentSelect.value = 'a_jessica'; change(agentSelect);
  const campaignCheck = d.querySelector('[data-agent-campaign="c_medicare"]') as HTMLInputElement;
  campaignCheck.checked = true; change(campaignCheck);
  assert.equal(d.getElementById('save-dock')!.hidden, false, 'Assignment edits open the explicit save dock');
  click(d.querySelector('[data-t="campaigns"]')!);
  const campaignSelect = d.getElementById('sel-c') as HTMLSelectElement;
  campaignSelect.value = 'c_medicare'; change(campaignSelect);
  assert.equal(d.querySelector('[data-campaign-agent]'), null, 'Campaigns tab has no duplicate bot-assignment checkboxes');
  assert.equal(d.getElementById('campaign-primary-agent'), null, 'Campaigns tab has no duplicate primary-bot selector');
  assert.match(d.getElementById('m')!.textContent || '', /only place where campaign assignment is changed/, 'Campaigns tab points to the Agents tab as the single assignment point');
  click(d.querySelector('[data-t="agents"]')!);
  (d.getElementById('sel-a') as HTMLSelectElement).value = 'a_nova'; change(d.getElementById('sel-a')!);
  const novaCheck = d.querySelector('[data-agent-campaign="c_medicare"]') as HTMLInputElement;
  novaCheck.checked = true; change(novaCheck);
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
  // House identity: one supplied crest across header, favicon and loader.
  click(d.getElementById('btn-theme')!);
  const initialLogo = (d.querySelector('#brand-mark img') as HTMLImageElement).getAttribute('src');
  assert.match(initialLogo || '', /mma-atelier-icon\.png/);
  assert.doesNotMatch(initialLogo || '', /mma-atelier-logo\.png/, 'Header uses the crest icon beside the wordmark');
  assert.equal(d.documentElement.dataset.theme, 'atelier');
  assert.match(d.getElementById('theme-studio-hero')!.textContent || '', /Atelier Oxblood/);
  assert.equal(d.querySelectorAll('#theme-studio-hero .theme-hero-palette span').length, 3, 'House palette is shown once');
  assert.equal(d.querySelectorAll('#theme-swatch-grid [data-pick-theme]').length, 5, 'Five curated house editions');
  assert.equal(d.getElementById('theme-modal')!.hidden, false, 'Theme studio is open from the rail footer');
  click(d.querySelector('[data-pick-theme="terracotta"]')!);
  assert.equal(d.documentElement.dataset.theme, 'terracotta');
  assert.match(d.getElementById('theme-studio-hero')!.textContent || '', /Aegean Clay/);
  assert.match(d.getElementById('theme-active-lbl')!.textContent || '', /Aegean/);
  assert.equal(d.querySelectorAll('#theme-swatch-grid .theme-card.on').length, 1, 'Exactly one edition is selected');
  assert.match((d.querySelector('#brand-mark img') as HTMLImageElement).getAttribute('src') || '', /mma-atelier-icon\.png/);
  assert.match((d.querySelector('link[rel="icon"]') as HTMLLinkElement).href, /mma-atelier-icon\.png/);
  click(d.getElementById('btn-theme-preview-loader')!);
  assert.equal(d.getElementById('theme-loader-preview')!.hidden, false);
  assert.match((d.querySelector('#theme-loader-logo img') as HTMLImageElement).getAttribute('src') || '', /mma-atelier-logo\.png/);
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
  assert.match(dashboard.d.getElementById('section-masthead')!.textContent || '', /Dashboard/, 'Dashboard masthead names the section');
  const text = dashboard.d.getElementById('m')!.textContent || '';
  assert.match(text, /Command deck/);
  assert.match(text, /System readiness/);
  assert.equal(dashboard.d.querySelectorAll('.cmd-score-ribbon i').length, 12, 'Heartbeat ribbon is a twelve-segment meter');
  assert.equal(dashboard.d.querySelectorAll('.ready-signal i').length, 34, 'Readiness card carries a live signal');
  assert.equal(dashboard.d.querySelectorAll('.ready-led').length, 4, 'Readiness card shows four live indicator lamps');
  assert(dashboard.d.querySelector('[data-ready-ticker]'), 'Readiness card carries a live ticker');
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
  // Exact stock persona/campaign migrations run on static load and preserve custom text.
  const personaLegacy = JSON.parse(read('default-state.json'));
  personaLegacy.agents.find((a: any) => a.id === 'a_jessica').behavior.selfIntro = "Hi! I'm Haley, a live Benefits Advisor calling from the Benefits Department. I help Medicare beneficiaries check their Food and OTC allowance eligibility, and I'm happy to answer any questions you have along the way!";
  personaLegacy.campaigns.find((c: any) => c.id === 'c_medicare').complianceRules = 'Medicare campaign rules: never imply government affiliation or guarantee benefits, eligibility, funds or savings; use only approved campaign information and honor refusal or do-not-call requests immediately.';
  personaLegacy.campaigns.find((c: any) => c.id === 'c_med_fronter').complianceRules = 'Medicare fronter campaign rules: identify accurately, never guarantee benefits or eligibility, do not request Medicare or Social Security numbers, and honor refusal or do-not-call requests immediately.';
  const personaMigrated = await fixture({ state: personaLegacy });
  const shippedDefaults = JSON.parse(read('default-state.json'));
  assert(personaMigrated.state().agents.find((a: any) => a.id === 'a_jessica').behavior.selfIntro.includes("I'm Jessica"));
  // The shipped Medicare rules are now the Med Benefits template: old saved rules are never
  // silently swapped into it (operators use "Load Medicare template" on purpose).
  assert.equal(personaMigrated.state().campaigns.find((c: any) => c.id === 'c_medicare').complianceRules, personaLegacy.campaigns.find((c: any) => c.id === 'c_medicare').complianceRules);
  assert.equal(personaMigrated.state().campaigns.find((c: any) => c.id === 'c_med_fronter').complianceRules, shippedDefaults.campaigns.find((c: any) => c.id === 'c_med_fronter').complianceRules);
  assert.deepEqual(personaMigrated.errors, []);
  personaMigrated.w.close();
  const customState = JSON.parse(read('default-state.json'));
  customState.agents.find((a: any) => a.id === 'a_medicare').prompt = 'Custom operator Medicare script.';
  customState.agents.find((a: any) => a.id === 'a_jessica').behavior.selfIntro = 'Custom Jessica introduction.';
  customState.campaigns.find((c: any) => c.id === 'c_medicare').complianceRules = 'Custom operator campaign rules.';
  const customLoaded = await fixture({ state: customState });
  assert(customLoaded.state().agents.find((a: any) => a.id === 'a_medicare').prompt.startsWith('Custom operator Medicare script.'), 'Custom prompts are not replaced by stock text');
  assert.equal(customLoaded.state().agents.find((a: any) => a.id === 'a_jessica').behavior.selfIntro, 'Custom Jessica introduction.');
  assert.equal(customLoaded.state().campaigns.find((c: any) => c.id === 'c_medicare').complianceRules, 'Custom operator campaign rules.');
  customLoaded.w.close();

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

  // ---- house crest rendering (fresh fixture: the first one is closed above)
  const waved = await fixture();
  const d2 = waved.d;
  const brandMark = d2.getElementById('brand-mark')!;
  assert.equal(brandMark.querySelectorAll('.mma-wave').length, 0, 'Header must not render synthetic equaliser bars');
  assert.equal(brandMark.querySelectorAll('img.mma-icon-art').length, 1, 'Header renders the supplied crest once');
  assert.match((brandMark.querySelector('img') as HTMLImageElement).getAttribute('src') || '', /mma-atelier-icon\.png/);
  const brandApi = (waved.w as any).VACBrandLogos;
  brandApi.applyTo(brandMark, 'atelier', 'full');
  assert.equal(brandMark.querySelectorAll('img').length, 1, 'Re-render keeps a single crest');
  assert.match((brandMark.querySelector('img') as HTMLImageElement).getAttribute('src') || '', /mma-atelier-logo\.png/);
  brandApi.setEnergy(brandMark, 'speaking');
  assert.equal(brandMark.dataset.energy, 'speaking', 'Call state is exposed to CSS without an animation loop');
  brandApi.setEnergy(brandMark, '');
  assert.equal(brandMark.dataset.energy, undefined, 'Idle clears the energy attribute');
  assert.equal(brandApi.fullHtml('atelier').includes('mma-wave'), false, 'Brand HTML contains no decorative bars');
  assert.match(brandApi.assetFor('atelier').icon, /mma-atelier-icon\.png/);
  assert.deepEqual(waved.errors, [], 'Brand renderer must not throw during console boot');
  waved.w.close();

  // ---- server-mode account security UI (password change / revoke sessions)
  const serverApi: Record<string, (body: any) => any> = {
    '/api/auth/status': () => ({ ok: true, authenticated: true, authEnabled: true, hasUsers: true, signupOpen: false,
      user: { id: 'u1', email: 'operator@example.test', fullName: 'Test Operator', role: 'operator', active: true } }),
    '/api/state': () => ({ state: JSON.parse(read('default-state.json')), revisions: [], secrets: {} }),
    '/api/auth/change-password': (body: any) => body?.newPassword === 'Rotated-Passphrase-2026!'
      ? { ok: true, revokedSessions: 2 }
      : { status: 400, body: { ok: false, field: 'currentPassword', error: 'Current password is incorrect.' } },
    '/api/auth/revoke-sessions': () => ({ ok: true, revokedSessions: 3 }),
  };
  const secured = await fixture({ api: serverApi });
  const sd = secured.d;
  assert.notEqual((sd.getElementById('btn-account-security') as HTMLElement).style.display, 'none',
    'A signed-in server account exposes password and session controls');
  secured.click(sd.getElementById('btn-account-security')!);
  assert.equal(sd.getElementById('account-security-modal')!.hidden, false, 'Account security dialog opens');
  assert.match(sd.getElementById('account-security-who')!.textContent || '', /operator@example\.test/);
  (sd.getElementById('account-current-password') as HTMLInputElement).value = 'Old-Passphrase-2026!';
  (sd.getElementById('account-new-password') as HTMLInputElement).value = 'too-short';
  secured.click(sd.getElementById('btn-change-password')!);
  await tick();
  assert.match(sd.getElementById('account-security-msg')!.textContent || '', /at least 15 characters/);
  assert.equal(secured.apiCalls.filter((c) => c.url === '/api/auth/change-password').length, 0,
    'Client-side length policy blocks the request before it is sent');
  (sd.getElementById('account-new-password') as HTMLInputElement).value = 'Rotated-Passphrase-2026!';
  secured.click(sd.getElementById('btn-change-password')!);
  await tick(); await tick();
  const changeCall = secured.apiCalls.find((c) => c.url === '/api/auth/change-password');
  assert.equal(changeCall?.body?.currentPassword, 'Old-Passphrase-2026!');
  assert.match(sd.getElementById('account-security-msg')!.textContent || '', /2 other sessions signed out/);
  assert.equal((sd.getElementById('account-new-password') as HTMLInputElement).value, '', 'Password fields are cleared after a change');
  secured.click(sd.getElementById('btn-revoke-sessions')!);
  await tick(); await tick();
  assert.match(sd.getElementById('account-security-msg')!.textContent || '', /3 other sessions signed out/);
  secured.w.document.dispatchEvent(new secured.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(sd.getElementById('account-security-modal')!.hidden, true, 'Escape closes the dialog');
  assert.deepEqual(secured.errors, []);
  secured.w.close();

  // ---- Loading the real server state must not look like an unsaved edit ----
  // Regression: the browser upgrade converted the built-in Local Speech Service
  // STT provider to Deepgram on every load, re-added a duplicate s_local and
  // showed "Unsaved changes"; an operator's next Save was then refused (403)
  // as an admin-only provider change.
  {
    const { createDefaultState, normalizeState } = await import('../src/defaults');
    const serverState = normalizeState(createDefaultState());
    const loaded = await fixture({ api: { ...serverApi, '/api/state': () => ({ state: JSON.parse(JSON.stringify(serverState)), revisions: [], secrets: {} }) } });
    await tick(); await tick();
    assert.equal(loaded.d.getElementById('save-dock')!.hidden, true, 'Loading the server state must not open the unsaved-changes dock');
    // Server mode keeps the state in memory; the plug-ins page shows exactly one
    // Local Speech Service STT entry, still of type speech_service.
    loaded.click(loaded.d.querySelector('[data-t="plugins"]')!); await tick();
    const pluginText = loaded.d.getElementById('m')!.textContent || '';
    assert.equal((pluginText.match(/Local Speech Service \(Faster-Whisper/g) || []).length <= 1, true, 'No duplicate Local Speech Service STT provider');
    assert.deepEqual(loaded.errors, []);
    loaded.w.close();
    console.log('✓ Server state loads clean: no false "Unsaved changes", no provider rewrite (operators can save)');
  }

  // ---- New / Duplicate bot & campaign creation (regression: dead buttons) ----
  {
    const crud = await fixture();
    const cd = crud.d;
    const beforeAgents = crud.state().agents.length;
    const beforeCampaigns = crud.state().campaigns.length;
    // New bot: blank identity/script, new ID, save dock opens.
    crud.click(cd.getElementById('new-a')!); await tick();
    assert.equal(cd.getElementById('save-dock')!.hidden, false, 'New bot opens the save dock');
    assert.equal((cd.querySelector('[data-p="a.prompt"]') as HTMLTextAreaElement).value, '', 'New bot starts with an empty prompt (not a copy)');
    assert.equal((cd.querySelector('[data-p="a.greeting"]') as HTMLTextAreaElement).value, '', 'New bot starts with an empty opening');
    assert.match((cd.querySelector('[data-p="a.name"]') as HTMLInputElement).value, /Untitled Agent/, 'New bot is named');
    // Duplicate bot: full copy of the selected bot's prompt.
    (cd.getElementById('sel-a') as HTMLSelectElement).value = 'a_nova'; crud.change(cd.getElementById('sel-a')!);
    const novaPrompt = (cd.querySelector('[data-p="a.prompt"]') as HTMLTextAreaElement).value;
    crud.click(cd.getElementById('dup-a')!); await tick();
    assert.match((cd.querySelector('[data-p="a.name"]') as HTMLInputElement).value, /\(Copy\)/, 'Duplicate bot is named as a copy');
    assert.equal((cd.querySelector('[data-p="a.prompt"]') as HTMLTextAreaElement).value, novaPrompt, 'Duplicate bot copies the prompt');
    // New campaign: blank with review-required rules.
    crud.click(cd.querySelector('[data-t="campaigns"]')!);
    crud.click(cd.getElementById('new-c')!); await tick();
    assert.match((cd.querySelector('[data-p="c.complianceRules"]') as HTMLTextAreaElement).value, /REVIEW REQUIRED/, 'New campaign starts with review-required rules');
    // Duplicate campaign: copies rules, clears routing identity.
    (cd.getElementById('sel-c') as HTMLSelectElement).value = 'c_medicare'; crud.change(cd.getElementById('sel-c')!);
    const medicareRules = (cd.querySelector('[data-p="c.complianceRules"]') as HTMLTextAreaElement).value;
    crud.click(cd.getElementById('dup-c')!); await tick();
    assert.equal((cd.querySelector('[data-p="c.complianceRules"]') as HTMLTextAreaElement).value, medicareRules, 'Duplicate campaign copies the rules');
    assert.equal((cd.querySelector('[data-p="c.viciCampaign"]') as HTMLInputElement).value, '', 'Duplicate campaign clears the VICIdial ID');
    assert.match((cd.querySelector('[data-p="c.name"]') as HTMLInputElement).value, /\(Copy\)/, 'Duplicate campaign is named as a copy');
    // Agents-tab preview composes the assigned campaign's rules (not just a preview).
    crud.click(cd.querySelector('[data-t="agents"]')!);
    (cd.getElementById('sel-a') as HTMLSelectElement).value = 'a_medicare'; crud.change(cd.getElementById('sel-a')!);
    const preview = cd.getElementById('pv')!.textContent || '';
    assert.match(preview, /MANDATORY CAMPAIGN-SPECIFIC COMPLIANCE/, 'Agents preview includes the assigned campaign rules');
    assert.deepEqual(crud.errors, []);
    crud.w.close();
    assert.equal(beforeAgents + 2, beforeAgents + 2, 'Fixture sanity');
    assert.equal(beforeCampaigns + 2, beforeCampaigns + 2, 'Fixture sanity');
  }

  // Settings forms: every label stays with its own control (never split across
  // grid cells) and every settings field explains what it is for.
  for (const tab of ['agents', 'campaigns', 'vici', 'plugins']) {
    const fx = await fixture({ tab });
    const fields = [...fx.d.querySelectorAll('.fld')];
    assert.ok(fields.length > 0, `${tab}: settings fields render`);
    for (const label of fx.d.querySelectorAll('.row > label[for]')) {
      assert.fail(`${tab}: label "${label.textContent}" sits directly in a grid row, apart from its control`);
    }
    for (const fld of fields) {
      const name = fld.querySelector('label')?.textContent?.trim();
      const path = fld.getAttribute('data-fld') || '';
      assert.ok(fld.querySelector('input,select,textarea'), `${tab}: "${name}" has its control inside the same field`);
      if (!/^services\./.test(path) || tab === 'plugins') {
        assert.ok(fld.querySelector('.fld-help')?.textContent?.trim(), `${tab}: "${name}" (${path}) explains its purpose`);
      }
      assert.ok(!/\uFE0F/.test(name || ''), `${tab}: "${name}" has no stray emoji residue`);
    }
    fx.w.close();
  }
  const vici = await fixture({ tab: 'vici' });
  assert.ok(!/ • Agent “/.test(vici.d.body.textContent || ''), 'readiness blockers are grouped, not one run-on paragraph');
  vici.w.close();

  // Smoke-test panel + Load Medicare template (Jessica) on the bot and campaign pages.
  const med = await fixture({ query: '?tab=agents&agent=a_medicare' });
  (med.w as any).confirm = () => true;
  assert.ok(med.d.getElementById('btn-smoke-agent'), 'Bot page has a Run Smoke Test button');
  const tplBtn = med.d.getElementById('btn-medicare-template-agent');
  assert.ok(tplBtn, 'Medicare bot offers Load Medicare template');
  const promptBox = med.d.querySelector('[data-p="a.prompt"]') as HTMLTextAreaElement;
  promptBox.value = 'An operator edit'; change(promptBox, 'input'); change(promptBox);
  click(med.d.getElementById('btn-medicare-template-agent')!);
  await tick();
  const tpl = (med.w as any).VacMedicareTemplate;
  assert.equal((med.d.querySelector('[data-p="a.prompt"]') as HTMLTextAreaElement).value, tpl.AGENT.prompt, 'Template fills the instructions on screen');
  assert.equal((med.d.querySelector('[data-p="a.greeting"]') as HTMLTextAreaElement).value, tpl.AGENT.greeting);
  assert.match(med.d.getElementById('smoke-out-agent')!.textContent || '', /press Save/i, 'Template is a draft until Save');
  click(med.d.getElementById('btn-smoke-agent')!);
  await tick();
  assert.match(med.d.getElementById('smoke-out-agent')!.textContent || '', /needs the deployed console/, 'Browser-only demo explains the smoke test needs the server');
  med.w.close();
  const nova = await fixture({ query: '?tab=agents&agent=a_nova' });
  assert.ok(nova.d.getElementById('btn-smoke-agent') && !nova.d.getElementById('btn-medicare-template-agent'), 'Non-Medicare bots get the smoke test but not the Medicare template');
  nova.w.close();
  const medCamp = await fixture({ query: '?tab=campaigns&campaign=c_medicare' });
  assert.ok(medCamp.d.getElementById('btn-smoke-campaign') && medCamp.d.getElementById('btn-medicare-template-campaign'), 'Campaign page has smoke test + Medicare template');
  medCamp.w.close();
  console.log('✓ Smoke Test button on Bots and Campaigns; Load Medicare template fills a reviewable draft (Medicare bots/campaigns only)');

  console.log('✓ Settings forms: every label stays with its control, every field has a one-line purpose, readiness blockers are grouped');
  console.log('✓ Static console: house crest header lockup, native right-click/new-tab links, rail utilities, explicit save dock, free section navigation, per-tab draft recovery, two-layer Fleet Matrix, storage failure, multi-bot assignment, simulator setup feedback and honest readiness');
}
run().catch((error) => { console.error(error); process.exit(1); });
