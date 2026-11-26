import type { AlertRecord } from './alerts';
import type { ConsoleState, ValidationItem } from './types';
import { validateAgent, validateCampaign } from './settings-builder';

export type DiagnosticStatus = 'ok' | 'warn' | 'fail' | 'skipped';

export interface DiagnosticFinding {
  id: string;
  area: 'Keys' | 'Bots' | 'Bridge' | 'Dialer' | 'Transfers' | 'Setup' | 'Server';
  title: string;
  status: DiagnosticStatus;
  /** What was found, in plain words. */
  detail: string;
  /** What to do about it. Empty when everything is fine. */
  suggestion: string;
}

export interface DiagnosticReport {
  ranAt: string;
  durationMs: number;
  overall: 'ok' | 'warn' | 'fail';
  counts: Record<DiagnosticStatus, number>;
  findings: DiagnosticFinding[];
}

export interface ProbeResult {
  ok: boolean;
  detail: string;
  /** Why a probe failed: the key was refused, or the service could not be reached. Drives the advice shown. */
  kind?: 'auth' | 'unreachable';
}

export interface DiskResult {
  writable: boolean;
  freeBytes: number | null;
}

/** Everything the scanner needs from the outside world; tests pass fakes. */
export interface DiagnosticInputs {
  state: ConsoleState;
  secrets: Record<string, { configured: boolean }>;
  bridge: null | {
    sipRegistration?: { status: string; lastError?: string | null };
    rejectedOverCapacityCount?: number;
    rejectedAsleepCount?: number;
    audioSocketListening?: boolean;
    sipRtpListening?: boolean;
    lastError?: string | null;
  };
  botSleep: { sleeping: boolean };
  alerts: AlertRecord[];
  probes: {
    deepgram(): Promise<ProbeResult>;
    viciApi(): Promise<ProbeResult>;
    ami(): Promise<ProbeResult>;
    disk(): Promise<DiskResult>;
  };
  /** True when the console runs its own voice engine (VOICE_ENGINE=own) instead of Deepgram's Voice Agent. */
  ownEngine?: boolean;
  /** Set when OWN_LLM_BASE_URL points the thinking step at your own server. */
  ownLlmUrl?: boolean;
  now?: () => number;
  /** How long any one probe may take before it counts as unanswered. */
  probeTimeoutMs?: number;
}

export const PROBE_TIMEOUT_MS = 6000;
const LOW_DISK_WARN = 500 * 1024 * 1024;
const LOW_DISK_FAIL = 100 * 1024 * 1024;

/**
 * Asks Deepgram whether it accepts the saved key, with its own request that is cancelled on timeout
 * (so a slow Deepgram never leaves work running after the scan finished).
 */
export async function probeDeepgramKey(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5000
): Promise<ProbeResult> {
  try {
    const res = await fetchImpl('https://api.deepgram.com/v1/models', {
      headers: { Authorization: `Token ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401) return { ok: false, kind: 'auth', detail: 'Deepgram refused the saved key (401 Unauthorized).' };
    if (res.status === 403) return { ok: true, detail: 'Deepgram accepted the key (it is limited in scope, which is fine for calls).' };
    if (res.ok) return { ok: true, detail: 'Deepgram accepted the key.' };
    return { ok: false, kind: 'unreachable', detail: `Deepgram answered with status ${res.status}, so the key could not be checked just now.` };
  } catch (err: any) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { ok: false, kind: 'unreachable', detail: timedOut ? 'Deepgram did not answer in time.' : `Could not reach Deepgram: ${String(err?.message || err).slice(0, 120)}` };
  }
}

function deepgramAdvice(kind: ProbeResult['kind']): string {
  if (kind === 'auth') return 'Paste a current Deepgram key in Settings and check the Deepgram account has credit, then scan again.';
  if (kind === 'unreachable') return 'Deepgram could not be reached just now. The key may be fine: check the server\'s internet connection and scan again.';
  return 'Scan again. If it keeps failing, check the key in Settings and the server\'s connection to Deepgram.';
}

async function bounded<T>(work: () => Promise<T>, fallback: T, ms = PROBE_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } catch (err: any) {
    return { ...(fallback as any), detail: String(err?.message || err).slice(0, 200) } as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function worst(items: ValidationItem[]): { fails: ValidationItem[]; warns: ValidationItem[] } {
  return {
    fails: items.filter((i) => i.level === 'er'),
    warns: items.filter((i) => i.level === 'wn'),
  };
}

function firstFew(items: ValidationItem[], n = 3): string {
  return items.slice(0, n).map((i) => `${i.scope}: ${i.message}`).join(' · ');
}

export async function runDiagnostics(input: DiagnosticInputs): Promise<DiagnosticReport> {
  const now = input.now || Date.now;
  const limit = input.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const started = now();
  const { state, secrets, bridge, botSleep, alerts, probes } = input;
  const findings: DiagnosticFinding[] = [];
  const add = (f: DiagnosticFinding) => findings.push(f);

  const own = Boolean(input.ownEngine);
  const hasDeepgramKey = Boolean(secrets.DEEPGRAM_API_KEY?.configured);
  const viciUrl = String(state.vici?.viciBaseUrl || '').trim();
  const amiConfigured = Boolean(String(state.vici?.amiHost || '').trim() && String(state.vici?.amiUser || '').trim());

  // Slow checks run side by side so the whole scan takes as long as the slowest one, not the sum.
  const [dg, api, ami, disk] = await Promise.all([
    hasDeepgramKey && !own ? bounded(probes.deepgram, { ok: false, detail: 'No answer from Deepgram within 6 seconds' }, limit) : Promise.resolve(null),
    viciUrl ? bounded(probes.viciApi, { ok: false, detail: 'No answer from the dialer web server within 6 seconds' }, limit) : Promise.resolve(null),
    amiConfigured ? bounded(probes.ami, { ok: false, detail: 'No answer on the AMI port within 6 seconds' }, limit) : Promise.resolve(null),
    bounded(probes.disk, { writable: false, freeBytes: null } as DiskResult, limit),
  ]);

  if (own) {
    const svc = state.services;
    const provOf = (kind: 'stt' | 'tts' | 'llm', id?: string) => state.providers.find((p) => p.kind === kind && p.id === id);
    const stt = provOf('stt', svc?.stt?.providerId);
    const tts = provOf('tts', svc?.tts?.providerId);
    const llm = provOf('llm', svc?.llm?.providerId);
    const problems: string[] = [];
    if (!stt || stt.type !== 'speech_service') problems.push('listening is not set to your speech service');
    if (!tts || tts.type !== 'speech_service') problems.push('the voice is not a self-hosted voice');
    if (!input.ownLlmUrl) {
      const key = llm?.type === 'groq' ? 'GROQ_API_KEY' : llm?.type === 'open_ai' ? 'OPENAI_API_KEY' : '';
      if (!key) problems.push('the thinking model must be OpenAI or Groq (or set OWN_LLM_BASE_URL)');
      else if (!secrets[key]?.configured) problems.push(`${key} is not saved`);
    }
    add(
      problems.length
        ? { id: 'engine.own', area: 'Setup', title: 'Own voice engine is ready', status: 'fail', detail: `The console runs its own voice engine, but ${problems.join('; ')}. Calls would end at once.`, suggestion: 'Fix these in Plug-ins and API Keys, or remove VOICE_ENGINE=own to go back to Deepgram.' }
        : { id: 'engine.own', area: 'Setup', title: 'Own voice engine is ready', status: 'ok', detail: 'Calls use your speech service and your language model. Deepgram is not used.', suggestion: '' }
    );
  }

  // Keys
  if (own) {
    add({ id: 'keys.deepgram', area: 'Keys', title: 'Deepgram key saved', status: 'skipped', detail: 'Not needed: the own voice engine is on.', suggestion: '' });
    add({ id: 'keys.deepgram_live', area: 'Keys', title: 'Deepgram accepts the key', status: 'skipped', detail: 'Not needed: the own voice engine is on.', suggestion: '' });
  } else {
  add(
    hasDeepgramKey
      ? { id: 'keys.deepgram', area: 'Keys', title: 'Deepgram key saved', status: 'ok', detail: 'A Deepgram key is configured.', suggestion: '' }
      : { id: 'keys.deepgram', area: 'Keys', title: 'Deepgram key saved', status: 'fail', detail: 'No Deepgram key is saved, so no bot can speak or listen.', suggestion: 'Open Settings, paste the Deepgram key and save.' }
  );
  if (dg) {
    add(
      dg.ok
        ? { id: 'keys.deepgram_live', area: 'Keys', title: 'Deepgram accepts the key', status: 'ok', detail: dg.detail || 'Deepgram answered.', suggestion: '' }
        : { id: 'keys.deepgram_live', area: 'Keys', title: 'Deepgram accepts the key', status: 'fail', detail: dg.detail || 'Deepgram did not accept the request.', suggestion: deepgramAdvice(dg.kind) }
    );
  } else {
    add({ id: 'keys.deepgram_live', area: 'Keys', title: 'Deepgram accepts the key', status: 'skipped', detail: 'Skipped because no key is saved.', suggestion: '' });
  }
  }

  // Bots
  add(
    botSleep.sleeping
      ? { id: 'bots.sleep', area: 'Bots', title: 'Bots are awake', status: 'warn', detail: 'Bots are asleep. The dialer is refused every call with a busy answer.', suggestion: 'Press Wake on the Command deck when you want bots to take calls again.' }
      : { id: 'bots.sleep', area: 'Bots', title: 'Bots are awake', status: 'ok', detail: 'Bots will answer calls.', suggestion: '' }
  );

  // Bridge
  if (!bridge) {
    add({ id: 'bridge.running', area: 'Bridge', title: 'Call bridge is running', status: 'fail', detail: 'The call bridge is not running, so calls cannot reach any bot.', suggestion: 'Restart the console service and scan again.' });
  } else {
    // The bridge object exists even when it failed to start, so the listener itself must be checked.
    const viaSip = state.vici?.transport !== 'audiosocket';
    const listening = viaSip ? Boolean(bridge.sipRtpListening) : Boolean(bridge.audioSocketListening);
    add(
      listening
        ? { id: 'bridge.running', area: 'Bridge', title: 'Call bridge is running', status: 'ok', detail: `The call bridge is listening for ${viaSip ? 'SIP calls' : 'AudioSocket calls'}.`, suggestion: '' }
        : { id: 'bridge.running', area: 'Bridge', title: 'Call bridge is running', status: 'fail', detail: `The call bridge is not listening for ${viaSip ? 'SIP calls' : 'AudioSocket calls'}, so no call can reach a bot. ${bridge.lastError || ''}`.trim(), suggestion: 'Check the bridge port is free and the bind address is right, then restart the console service and scan again.' }
    );
    const mode = state.vici?.sipConnectionMode;
    const usesRegistration = state.vici?.transport === 'sip_trunk' && (mode === 'registration' || mode === 'hybrid');
    const reg = bridge.sipRegistration;
    if (usesRegistration && reg) {
      if (reg.status === 'registered') {
        add({ id: 'bridge.sip', area: 'Bridge', title: 'Dialer sees the bridge (SIP registration)', status: 'ok', detail: 'The bridge is registered with the dialer.', suggestion: '' });
      } else if (reg.status === 'registering') {
        add({ id: 'bridge.sip', area: 'Bridge', title: 'Dialer sees the bridge (SIP registration)', status: 'warn', detail: 'Registration with the dialer is still in progress.', suggestion: 'Wait a few seconds and scan again.' });
      } else {
        add({ id: 'bridge.sip', area: 'Bridge', title: 'Dialer sees the bridge (SIP registration)', status: 'fail', detail: `Not registered (${reg.status}). ${reg.lastError || ''}`.trim(), suggestion: 'Check the registrar host, SIP username and SIP password, and that the dialer allows this server on its SIP port.' });
      }
    } else {
      add({ id: 'bridge.sip', area: 'Bridge', title: 'Dialer sees the bridge (SIP registration)', status: 'skipped', detail: 'Registration is not used in the current connection mode.', suggestion: '' });
    }
    const turnedAway = Number(bridge.rejectedOverCapacityCount || 0);
    add(
      turnedAway > 0
        ? { id: 'bridge.capacity', area: 'Bridge', title: 'No calls turned away for capacity', status: 'warn', detail: `${turnedAway} call(s) were refused because a campaign was full.`, suggestion: 'Raise the campaign\'s max calls, or lower the dialer\'s dial level.' }
        : { id: 'bridge.capacity', area: 'Bridge', title: 'No calls turned away for capacity', status: 'ok', detail: 'No call was refused for capacity.', suggestion: '' }
    );
  }

  // Dialer
  if (api) {
    add(
      api.ok
        ? { id: 'dialer.api', area: 'Dialer', title: 'Dialer web API answers', status: 'ok', detail: api.detail || 'The dialer answered.', suggestion: '' }
        : { id: 'dialer.api', area: 'Dialer', title: 'Dialer web API answers', status: 'fail', detail: api.detail || 'The dialer did not answer.', suggestion: 'Check the dialer address, that port 443/80 is open to this server, and the API user and password.' }
    );
  } else {
    add({ id: 'dialer.api', area: 'Dialer', title: 'Dialer web API answers', status: 'skipped', detail: 'No dialer address is saved.', suggestion: 'Enter the dialer address in the VICIdial settings.' });
  }
  if (ami) {
    add(
      ami.ok
        ? { id: 'dialer.ami', area: 'Dialer', title: 'Dialer AMI port answers', status: 'ok', detail: ami.detail || 'AMI answered.', suggestion: '' }
        : { id: 'dialer.ami', area: 'Dialer', title: 'Dialer AMI port answers', status: 'warn', detail: ami.detail || 'AMI did not answer.', suggestion: 'Ask the dialer admin to open TCP 5038 for this server and create the bridge AMI user. Transfers still work through the API and SIP REFER meanwhile.' }
    );
  } else {
    add({ id: 'dialer.ami', area: 'Dialer', title: 'Dialer AMI port answers', status: 'skipped', detail: 'AMI is not set up.', suggestion: '' });
  }

  // Transfers and alerts
  const unread = alerts.filter((a) => !a.acknowledged);
  const failedTransfers = unread.filter((a) => a.kind === 'transfer_failed');
  add(
    failedTransfers.length
      ? { id: 'transfers.recent', area: 'Transfers', title: 'No recent failed transfers', status: 'fail', detail: `${failedTransfers.reduce((n, a) => n + a.count, 0)} transfer failure(s) not yet acknowledged. Latest: ${failedTransfers[0].detail || failedTransfers[0].title}`, suggestion: 'Check the transfer target extension and that the dialer allows transfers; the AMI and SIP REFER rows above show which routes work.' }
      : { id: 'transfers.recent', area: 'Transfers', title: 'No recent failed transfers', status: 'ok', detail: 'No unacknowledged transfer failures.', suggestion: '' }
  );
  const otherCritical = unread.filter((a) => a.severity === 'critical' && a.kind !== 'transfer_failed');
  add(
    otherCritical.length
      ? { id: 'alerts.critical', area: 'Transfers', title: 'No critical alerts waiting', status: 'warn', detail: `${otherCritical.length} critical alert(s) are unread: ${otherCritical.slice(0, 2).map((a) => a.title).join(' · ')}`, suggestion: 'Open the Alerts card on the Command deck, fix the cause, then acknowledge.' }
      : { id: 'alerts.critical', area: 'Transfers', title: 'No critical alerts waiting', status: 'ok', detail: 'No unread critical alerts.', suggestion: '' }
  );

  // Setup checks reuse the console's own pre-flight rules.
  const campaignItems = state.campaigns.flatMap((c) => validateCampaign(state, c));
  const agentItems = state.agents.flatMap((a) => validateAgent(state, a));
  for (const [id, title, items] of [
    ['setup.campaigns', 'Campaigns are complete', campaignItems],
    ['setup.bots', 'Bots are complete', agentItems],
  ] as const) {
    const { fails, warns } = worst(items);
    if (fails.length) {
      add({ id, area: 'Setup', title, status: 'fail', detail: `${fails.length} problem(s). ${firstFew(fails)}`, suggestion: 'Open the Pre-flight checks and fix the red items.' });
    } else if (warns.length) {
      add({ id, area: 'Setup', title, status: 'warn', detail: `${warns.length} item(s) to review. ${firstFew(warns)}`, suggestion: 'Open the Pre-flight checks and review the amber items.' });
    } else {
      add({ id, area: 'Setup', title, status: 'ok', detail: 'All pre-flight checks pass.', suggestion: '' });
    }
  }

  // Server
  if (!disk.writable) {
    add({ id: 'server.disk', area: 'Server', title: 'Server can save its data', status: 'fail', detail: 'The data folder is not writable.', suggestion: 'Fix the folder permissions or free the disk, then scan again.' });
  } else if (disk.freeBytes !== null && disk.freeBytes < LOW_DISK_FAIL) {
    add({ id: 'server.disk', area: 'Server', title: 'Server can save its data', status: 'fail', detail: `Only ${Math.round(disk.freeBytes / 1048576)} MB of disk is free.`, suggestion: 'Free disk space now; recordings and logs will stop saving.' });
  } else if (disk.freeBytes !== null && disk.freeBytes < LOW_DISK_WARN) {
    add({ id: 'server.disk', area: 'Server', title: 'Server can save its data', status: 'warn', detail: `${Math.round(disk.freeBytes / 1048576)} MB of disk is free.`, suggestion: 'Clear old recordings or grow the disk soon.' });
  } else {
    add({ id: 'server.disk', area: 'Server', title: 'Server can save its data', status: 'ok', detail: disk.freeBytes === null ? 'The data folder is writable.' : `The data folder is writable and ${Math.round(disk.freeBytes / 1048576)} MB is free.`, suggestion: '' });
  }

  const counts: Record<DiagnosticStatus, number> = { ok: 0, warn: 0, fail: 0, skipped: 0 };
  for (const f of findings) counts[f.status] += 1;
  return {
    ranAt: new Date(now()).toISOString(),
    durationMs: now() - started,
    overall: counts.fail ? 'fail' : counts.warn ? 'warn' : 'ok',
    counts,
    findings,
  };
}
