// "Testing & Verification" for the console button: runs every recorded
// scenario through the real screening engine, then checks the live pieces
// (Deepgram, VICIdial API, Asterisk AMD dialplan, recent dispositions).
import { AsteriskAmiClient } from '../ami-client';
import { getConsoleState } from '../db';
import { getSecret } from '../env-store';
import { VicidialApiClient } from '../vici-client';
import { createDeepgramAsr, deepgramProbeAudio } from './asr';
import { loadScreeningConfig } from './config';
import { runScenario, SCENARIOS } from './scenarios';
import { dispositionStateCounts, isScreeningEnabled, saveTestRun, screeningCounts } from './store';

export interface CheckItem { group: string; label: string; status: 'pass' | 'fail' | 'warn' | 'skip'; detail: string }

export interface VerifyOptions { live?: boolean; by?: string }

async function amiCommand(ami: AsteriskAmiClient, command: string): Promise<{ ok: boolean; text: string }> {
  const r = await ami.executeAction('Command', { Command: command }, 4000);
  const ok = r.ok || /follows/i.test(r.response);
  return { ok, text: `${r.message}\n${r.raw}` };
}

export async function runScreeningVerification(opts: VerifyOptions = {}): Promise<{ passed: number; failed: number; warnings: number; items: CheckItem[]; ranAt: string }> {
  const items: CheckItem[] = [];
  const add = (group: string, label: string, status: CheckItem['status'], detail: string) => items.push({ group, label, status, detail });
  const cfg = loadScreeningConfig();

  // 1. Engine: every scenario must reach its expected decision.
  for (const sc of SCENARIOS) {
    try {
      const r = await runScenario(sc, cfg.thresholds);
      add('Detection', r.label, r.pass ? 'pass' : 'fail', r.pass ? `${r.got} in ${(r.decidedAtMs / 1000).toFixed(1)}s` : `Expected ${r.expect}, got ${r.got}: ${r.reason}`);
    } catch (err: any) {
      add('Detection', sc.label, 'fail', err?.message || 'error');
    }
  }

  // 2. Configuration.
  add('Configuration', 'Screening switch', isScreeningEnabled() ? 'pass' : 'warn', isScreeningEnabled() ? 'On: every bridge call is screened before the bot speaks' : 'Off: calls go straight to the bot');
  add('Configuration', 'Deepgram key for screening', getSecret('DEEPGRAM_API_KEY') ? 'pass' : 'fail', getSecret('DEEPGRAM_API_KEY') ? 'Configured' : 'DEEPGRAM_API_KEY is missing; no person can be confirmed');
  add('Configuration', 'Dispositions', 'pass', Object.entries(cfg.dispositions).map(([k, v]) => `${k}=${v}`).join(', '));
  add('Configuration', 'Signed native AMD results', cfg.eventSecret ? 'pass' : 'warn', cfg.eventSecret ? 'SCREENING_EVENT_SECRET set; unsigned AMD headers are ignored' : 'No SCREENING_EVENT_SECRET: AMD headers are trusted only because SIP comes from allow-listed dialer IPs');
  add('Configuration', 'Authorised test numbers', 'pass', `${cfg.testEndpoints.size} number(s) on the list`);

  if (opts.live !== false) {
    // 3. Deepgram streaming recognition and probe voice.
    if (getSecret('DEEPGRAM_API_KEY')) {
      const asrResult = await new Promise<{ ok: boolean; detail: string }>((resolve) => {
        const timer = setTimeout(() => { s.close(); resolve({ ok: false, detail: 'No connection within 5 s' }); }, 5000);
        const s = createDeepgramAsr(cfg.asrModel, 4500)({
          onReady: () => { clearTimeout(timer); s.close(); resolve({ ok: true, detail: `Connected (model ${cfg.asrModel})` }); },
          onTranscript: () => {},
          onError: (m) => { clearTimeout(timer); s.close(); resolve({ ok: false, detail: m }); },
        });
      });
      add('Live services', 'Deepgram streaming recognition', asrResult.ok ? 'pass' : 'fail', asrResult.detail);
      if (cfg.probeEnabled) {
        const probe = await deepgramProbeAudio(cfg.probeText, cfg.probeVoice);
        add('Live services', 'Probe voice', probe ? 'pass' : 'warn', probe ? `"${cfg.probeText}" ready (${(probe.length / 16000).toFixed(1)} s, ${cfg.probeVoice})` : 'Could not synthesise the probe; screening still runs without it');
      }
    } else {
      add('Live services', 'Deepgram streaming recognition', 'skip', 'No Deepgram key');
    }

    // 4. VICIdial API (dispositions go through ra_call_control).
    const state = getConsoleState();
    if (state.vici?.viciBaseUrl) {
      const v = await new VicidialApiClient(state.vici).checkVersion().catch(() => ({ ok: false, versionText: 'request failed' }));
      add('VICIdial', 'Non-Agent API reachable', v.ok ? 'pass' : 'fail', v.ok ? v.versionText.slice(0, 120) : v.versionText.slice(0, 160));
    } else {
      add('VICIdial', 'Non-Agent API reachable', 'skip', 'VICIdial server address not set in Vici Bridge');
    }

    // 5. Asterisk native AMD (read-only AMI commands).
    if (getSecret('AMI_SECRET') && state.vici) {
      const ami = new AsteriskAmiClient(state.vici);
      const ver = await amiCommand(ami, 'core show version');
      add('Asterisk AMD', 'Asterisk version', ver.ok ? 'pass' : 'fail', ver.ok ? (/(Asterisk [^\s]+)/.exec(ver.text)?.[1] || 'read') : ver.text.slice(0, 160));
      const app = await amiCommand(ami, 'core show application AMD');
      add('Asterisk AMD', 'AMD application loaded', app.ok && /AMD/i.test(app.text) && !/not registered|no such/i.test(app.text) ? 'pass' : 'fail', app.ok ? 'app_amd available' : app.text.slice(0, 160));
      const ctx = String(process.env.SCREENING_AMD_CONTEXT || 'default').replace(/[^A-Za-z0-9_-]/g, '');
      const stock = await amiCommand(ami, `dialplan show 8369@${ctx}`);
      add('Asterisk AMD', 'Stock VICIdial AMD extension 8369', stock.ok && /AMD\(/i.test(stock.text) ? 'pass' : 'warn', stock.ok && /AMD\(/i.test(stock.text) ? `Present in [${ctx}] (left unchanged)` : 'Not found; run deploy/vicidial-amd/inspect-amd.sh on the dialer');
      const mma = await amiCommand(ami, `dialplan show 8370@${ctx}`);
      const mmaOk = mma.ok && /X-MMA-AMD/i.test(mma.text);
      add('Asterisk AMD', 'MMA AMD extension 8370', mmaOk ? 'pass' : 'warn', mmaOk ? 'Installed; passes the AMD result to the bridge' : 'Not installed; AI screening still runs on every call, without the native AMD result');
    } else {
      add('Asterisk AMD', 'Native AMD checks', 'skip', 'AMI is not configured (AMI_SECRET); run deploy/vicidial-amd/inspect-amd.sh on the dialer instead');
    }
  }

  // 6. Production: what screening decided and whether VICIdial confirmed the statuses.
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const counts = screeningCounts(since);
  add('Last 24 hours', 'Screened calls', counts.total ? 'pass' : 'skip', counts.total ? `${counts.total} calls: ${counts.HUMAN_CONFIRMED} person, ${counts.VOICEMAIL} voicemail, ${counts.IVR} IVR, ${counts.PRERECORDED_AUDIO} recording, ${counts.KNOWN_TEST_ENDPOINT} test, ${counts.UNCERTAIN} uncertain` : 'No screened calls yet');
  const ds = dispositionStateCounts(since);
  const bad = (ds.mismatch || 0) + (ds.failed || 0);
  const totalD = Object.values(ds).reduce((a, b) => a + b, 0);
  add('Last 24 hours', 'Dispositions confirmed in VICIdial', !totalD ? 'skip' : bad ? 'fail' : (ds.unverifiable ? 'warn' : 'pass'),
    totalD ? `${ds.verified || 0} confirmed, ${ds.unverifiable || 0} could not be read back, ${ds.mismatch || 0} wrong status, ${ds.failed || 0} not accepted` : 'No dispositions sent yet');

  const passed = items.filter((i) => i.status === 'pass').length;
  const failed = items.filter((i) => i.status === 'fail').length;
  const warnings = items.filter((i) => i.status === 'warn').length;
  const ranAt = new Date().toISOString();
  try { saveTestRun(opts.by || 'console', passed, failed, warnings, { items }); } catch {}
  return { passed, failed, warnings, items, ranAt };
}
