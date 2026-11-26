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
}

const FILE_NAME = 'bot-sleep.json';
const DEFAULT_STATUS: BotSleepStatus = { sleeping: false, since: null, by: '' };

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
    };
  } catch {
    // Missing or unreadable file means the bots are awake.
  }
  cached = status;
  cachedFor = file;
  return status;
}

export function getBotSleep(): BotSleepStatus {
  return { ...load() };
}

export function isBotSleeping(): boolean {
  return load().sleeping;
}

export function setBotSleep(sleeping: boolean, by = 'console'): BotSleepStatus {
  const next: BotSleepStatus = { sleeping, since: new Date().toISOString(), by: String(by || 'console').slice(0, 80) };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${filePath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
  fs.renameSync(tmp, filePath());
  cached = next;
  cachedFor = filePath();
  return { ...next };
}
