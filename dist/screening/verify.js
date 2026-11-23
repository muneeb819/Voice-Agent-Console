"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runScreeningVerification = runScreeningVerification;
// "Testing & Verification" for the console button: runs every recorded
// scenario through the real screening engine, then checks the live pieces
// (Deepgram, VICIdial API, Asterisk AMD dialplan, recent dispositions).
const ami_client_1 = require("../ami-client");
const db_1 = require("../db");
const env_store_1 = require("../env-store");
const vici_client_1 = require("../vici-client");
const asr_1 = require("./asr");
const config_1 = require("./config");
const scenarios_1 = require("./scenarios");
const store_1 = require("./store");
async function amiCommand(ami, command) {
    const r = await ami.executeAction('Command', { Command: command }, 4000);
    const ok = r.ok || /follows/i.test(r.response);
    return { ok, text: `${r.message}\n${r.raw}` };
}
async function runScreeningVerification(opts = {}) {
    const items = [];
    const add = (group, label, status, detail) => items.push({ group, label, status, detail });
    const cfg = (0, config_1.loadScreeningConfig)();
    // 1. Engine: every scenario must reach its expected decision.
    for (const sc of scenarios_1.SCENARIOS) {
        try {
            const r = await (0, scenarios_1.runScenario)(sc, cfg.thresholds);
            add('Detection', r.label, r.pass ? 'pass' : 'fail', r.pass ? `${r.got} in ${(r.decidedAtMs / 1000).toFixed(1)}s` : `Expected ${r.expect}, got ${r.got}: ${r.reason}`);
        }
        catch (err) {
            add('Detection', sc.label, 'fail', err?.message || 'error');
        }
    }
    // 2. Configuration.
    add('Configuration', 'Screening switch', (0, store_1.isScreeningEnabled)() ? 'pass' : 'warn', (0, store_1.isScreeningEnabled)() ? 'On: every bridge call is screened before the bot speaks' : 'Off: calls go straight to the bot');
    add('Configuration', 'Deepgram key for screening', (0, env_store_1.getSecret)('DEEPGRAM_API_KEY') ? 'pass' : 'fail', (0, env_store_1.getSecret)('DEEPGRAM_API_KEY') ? 'Configured' : 'DEEPGRAM_API_KEY is missing; no person can be confirmed');
    add('Configuration', 'Dispositions', 'pass', Object.entries(cfg.dispositions).map(([k, v]) => `${k}=${v}`).join(', '));
    add('Configuration', 'Signed native AMD results', cfg.eventSecret ? 'pass' : 'warn', cfg.eventSecret ? 'SCREENING_EVENT_SECRET set; unsigned AMD headers are ignored' : 'No SCREENING_EVENT_SECRET: AMD headers are trusted only because SIP comes from allow-listed dialer IPs');
    add('Configuration', 'Authorised test numbers', 'pass', `${cfg.testEndpoints.size} number(s) on the list`);
    if (opts.live !== false) {
        // 3. Deepgram streaming recognition and probe voice.
        if ((0, env_store_1.getSecret)('DEEPGRAM_API_KEY')) {
            const asrResult = await new Promise((resolve) => {
                const timer = setTimeout(() => { s.close(); resolve({ ok: false, detail: 'No connection within 5 s' }); }, 5000);
                const s = (0, asr_1.createDeepgramAsr)(cfg.asrModel, 4500)({
                    onReady: () => { clearTimeout(timer); s.close(); resolve({ ok: true, detail: `Connected (model ${cfg.asrModel})` }); },
                    onTranscript: () => { },
                    onError: (m) => { clearTimeout(timer); s.close(); resolve({ ok: false, detail: m }); },
                });
            });
            add('Live services', 'Deepgram streaming recognition', asrResult.ok ? 'pass' : 'fail', asrResult.detail);
            if (cfg.probeEnabled) {
                const probe = await (0, asr_1.deepgramProbeAudio)(cfg.probeText, cfg.probeVoice);
                add('Live services', 'Probe voice', probe ? 'pass' : 'warn', probe ? `"${cfg.probeText}" ready (${(probe.length / 16000).toFixed(1)} s, ${cfg.probeVoice})` : 'Could not synthesise the probe; screening still runs without it');
            }
        }
        else {
            add('Live services', 'Deepgram streaming recognition', 'skip', 'No Deepgram key');
        }
        // 4. VICIdial API (dispositions go through ra_call_control).
        const state = (0, db_1.getConsoleState)();
        if (state.vici?.viciBaseUrl) {
            const v = await new vici_client_1.VicidialApiClient(state.vici).checkVersion().catch(() => ({ ok: false, versionText: 'request failed' }));
            add('VICIdial', 'Non-Agent API reachable', v.ok ? 'pass' : 'fail', v.ok ? v.versionText.slice(0, 120) : v.versionText.slice(0, 160));
        }
        else {
            add('VICIdial', 'Non-Agent API reachable', 'skip', 'VICIdial server address not set in Vici Bridge');
        }
        // 5. Asterisk native AMD (read-only AMI commands).
        if ((0, env_store_1.getSecret)('AMI_SECRET') && state.vici) {
            const ami = new ami_client_1.AsteriskAmiClient(state.vici);
            const ver = await amiCommand(ami, 'core show version');
            // AMI is optional (backup transfer path + native AMD checks). Hosted
            // VICIdial usually keeps port 5038 closed; that is not a fault.
            if (!ver.ok && /AMI TCP error|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND|timed? ?out/i.test(ver.text)) {
                add('Asterisk AMD', 'Native AMD checks', 'skip', `AMI not reachable at ${state.vici.amiHost || '(no host)'}:${state.vici.amiPort || 5038} (optional). Calls, transfers and AI screening use the VICIdial API instead.`);
            }
            else {
                add('Asterisk AMD', 'Asterisk version', ver.ok ? 'pass' : 'fail', ver.ok ? (/(Asterisk [^\s]+)/.exec(ver.text)?.[1] || 'read') : ver.text.slice(0, 160));
                const app = await amiCommand(ami, 'core show application AMD');
                add('Asterisk AMD', 'AMD application loaded', app.ok && /AMD/i.test(app.text) && !/not registered|no such/i.test(app.text) ? 'pass' : 'fail', app.ok ? 'app_amd available' : app.text.slice(0, 160));
                const ctx = String(process.env.SCREENING_AMD_CONTEXT || 'default').replace(/[^A-Za-z0-9_-]/g, '');
                const stock = await amiCommand(ami, `dialplan show 8369@${ctx}`);
                add('Asterisk AMD', 'Stock VICIdial AMD extension 8369', stock.ok && /AMD\(/i.test(stock.text) ? 'pass' : 'warn', stock.ok && /AMD\(/i.test(stock.text) ? `Present in [${ctx}] (left unchanged)` : 'Not found; run deploy/vicidial-amd/inspect-amd.sh on the dialer');
                const mma = await amiCommand(ami, `dialplan show 8370@${ctx}`);
                const mmaOk = mma.ok && /X-MMA-AMD/i.test(mma.text);
                add('Asterisk AMD', 'MMA AMD extension 8370', mmaOk ? 'pass' : 'warn', mmaOk ? 'Installed; passes the AMD result to the bridge' : 'Not installed; AI screening still runs on every call, without the native AMD result');
            }
        }
        else {
            add('Asterisk AMD', 'Native AMD checks', 'skip', 'AMI is not configured (AMI_SECRET); run deploy/vicidial-amd/inspect-amd.sh on the dialer instead');
        }
    }
    // 6. Production: what screening decided and whether VICIdial confirmed the statuses.
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const counts = (0, store_1.screeningCounts)(since);
    add('Last 24 hours', 'Screened calls', counts.total ? 'pass' : 'skip', counts.total ? `${counts.total} calls: ${counts.HUMAN_CONFIRMED} person, ${counts.VOICEMAIL} voicemail, ${counts.IVR} IVR, ${counts.PRERECORDED_AUDIO} recording, ${counts.KNOWN_TEST_ENDPOINT} test, ${counts.UNCERTAIN} uncertain` : 'No screened calls yet');
    const ds = (0, store_1.dispositionStateCounts)(since);
    const bad = (ds.mismatch || 0) + (ds.failed || 0);
    const totalD = Object.values(ds).reduce((a, b) => a + b, 0);
    add('Last 24 hours', 'Dispositions confirmed in VICIdial', !totalD ? 'skip' : bad ? 'fail' : (ds.unverifiable ? 'warn' : 'pass'), totalD ? `${ds.verified || 0} confirmed, ${ds.unverifiable || 0} could not be read back, ${ds.mismatch || 0} wrong status, ${ds.failed || 0} not accepted` : 'No dispositions sent yet');
    const passed = items.filter((i) => i.status === 'pass').length;
    const failed = items.filter((i) => i.status === 'fail').length;
    const warnings = items.filter((i) => i.status === 'warn').length;
    const ranAt = new Date().toISOString();
    try {
        (0, store_1.saveTestRun)(opts.by || 'console', passed, failed, warnings, { items });
    }
    catch { }
    return { passed, failed, warnings, items, ranAt };
}
