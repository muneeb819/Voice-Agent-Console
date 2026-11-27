import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './data-paths';

/**
 * Bot sleep switch. While asleep the bridge turns every new call away before a
 * speech or AI service is opened, so no STT/LLM/TTS usage is spent.
 *
 * The flag lives in its own small file instead of the console state: the console
 * saves its whole state at once, so a stale open tab would otherwise flip it back.
 */

export interface BotSleepStatus {
  sleeping: boolean;
  /** ISO time the current setting was applied, or null if it was never changed. */
  since: string | null;
  /** Who or what applied it, for the audit trail. */
  by: string;
  /** VICIdial campaigns this switch turned off and must turn back on at wake. */
  pausedCampaigns: string[];
  /** Last dialer message per campaign that could not be changed (empty when all went well). */
  dialerErrors: { campaign: string; error: string }[];
}

const FILE_NAME = 'bot-sleep.json';
const DEFAULT_STATUS: BotSleepStatus = { sleeping: false, since: null, by: '', pausedCampaigns: [], dialerErrors: [] };

let cached: BotSleepStatus | null = null;
let cachedFor = '';

function filePath(): string {
  return path.join(DATA_DIR, FILE_NAME);
}

function load(): BotSleepStatus {
  const file = filePath();
  if (cached && cachedFor === file) return cached;
  let status = { ...DEFAULT_STATUS };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    status = {
      sleeping: parsed?.sleeping === true,
      since: typeof parsed?.since === 'string' ? parsed.since : null,
      by: typeof parsed?.by === 'string' ? parsed.by.slice(0, 80) : '',
      pausedCampaigns: Array.isArray(parsed?.pausedCampaigns) ? parsed.pausedCampaigns.map(String).slice(0, 100) : [],
      dialerErrors: Array.isArray(parsed?.dialerErrors)
        ? parsed.dialerErrors.slice(0, 100).map((e: any) => ({ campaign: String(e?.campaign || ''), error: String(e?.error || '').slice(0, 200) }))
        : [],
    };
  } catch {
    // Missing or unreadable file means the bots are awake.
  }
  cached = status;
  cachedFor = file;
  return status;
}

export function getBotSleep(): BotSleepStatus {
  const s = load();
  return { ...s, pausedCampaigns: [...s.pausedCampaigns], dialerErrors: s.dialerErrors.map((e) => ({ ...e })) };
}

export function isBotSleeping(): boolean {
  return load().sleeping;
}

export function setBotSleep(sleeping: boolean, by = 'console'): BotSleepStatus {
  const prev = load();
  // Keep the list of campaigns we turned off so a later wake can turn exactly those back on.
  return persist({ sleeping, since: new Date().toISOString(), by: String(by || 'console').slice(0, 80), pausedCampaigns: prev.pausedCampaigns, dialerErrors: [] });
}

/** Records what the dialer pause/resume did, without changing the sleep state itself. */
export function setDialerOutcome(pausedCampaigns: string[], dialerErrors: { campaign: string; error: string }[]): BotSleepStatus {
  const prev = load();
  return persist({ ...prev, pausedCampaigns: [...new Set(pausedCampaigns)], dialerErrors });
}

function persist(next: BotSleepStatus): BotSleepStatus {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${filePath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
  fs.renameSync(tmp, filePath());
  cached = next;
  cachedFor = filePath();
  return getBotSleep();
}
