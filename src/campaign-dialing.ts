import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './data-paths';

/**
 * Campaign dialing switch, separate from the bot sleep switch.
 *
 * Off: every VICIdial campaign the console uses is turned off, so the dialer stops
 * placing calls. On: exactly the campaigns this switch turned off are turned on again.
 * Calls already in progress are never touched. The list of campaigns it turned off is
 * kept in its own small file so a wake never starts a campaign this switch did not stop.
 */

export interface CampaignDialingStatus {
  /** True while the console is holding campaigns off. */
  off: boolean;
  since: string | null;
  by: string;
  /** VICIdial campaigns this switch turned off and must turn back on. */
  pausedCampaigns: string[];
  /** Campaigns VICIdial refused to change, with its answer (empty when all went well). */
  dialerErrors: { campaign: string; error: string }[];
}

/** The slice of the VICIdial client this module needs (kept small so tests can fake it). */
export interface CampaignSwitch {
  setCampaignActive(campaignId: string, active: boolean): Promise<{ ok: boolean; text: string }>;
}

export interface CampaignDialingResult {
  changed: string[];
  failed: { campaign: string; error: string }[];
  skipped: string;
}

const FILE_NAME = 'campaign-dialing.json';
const DEFAULT_STATUS: CampaignDialingStatus = { off: false, since: null, by: '', pausedCampaigns: [], dialerErrors: [] };
let cached: CampaignDialingStatus | null = null;
let cachedFor = '';

function filePath(): string {
  return path.join(DATA_DIR, FILE_NAME);
}

function load(): CampaignDialingStatus {
  const file = filePath();
  if (cached && cachedFor === file) return cached;
  let status: CampaignDialingStatus = { ...DEFAULT_STATUS, pausedCampaigns: [], dialerErrors: [] };
  try {
    const p = JSON.parse(fs.readFileSync(file, 'utf8'));
    status = {
      off: p?.off === true,
      since: typeof p?.since === 'string' ? p.since : null,
      by: typeof p?.by === 'string' ? p.by.slice(0, 80) : '',
      pausedCampaigns: Array.isArray(p?.pausedCampaigns) ? p.pausedCampaigns.map(String).slice(0, 100) : [],
      dialerErrors: Array.isArray(p?.dialerErrors)
        ? p.dialerErrors.slice(0, 100).map((e: any) => ({ campaign: String(e?.campaign || ''), error: String(e?.error || '').slice(0, 200) }))
        : [],
    };
  } catch {
    // Missing or unreadable file means nothing is being held off.
  }
  cached = status;
  cachedFor = file;
  return status;
}

function persist(next: CampaignDialingStatus): CampaignDialingStatus {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${filePath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
  fs.renameSync(tmp, filePath());
  cached = next;
  cachedFor = filePath();
  return getCampaignDialing();
}

export function getCampaignDialing(): CampaignDialingStatus {
  const s = load();
  return { ...s, pausedCampaigns: [...s.pausedCampaigns], dialerErrors: s.dialerErrors.map((e) => ({ ...e })) };
}

/** Records the new setting. The list of campaigns turned off is kept for the matching "on". */
export function setCampaignDialingFlag(off: boolean, by = 'console'): CampaignDialingStatus {
  const prev = load();
  return persist({ off, since: new Date().toISOString(), by: String(by || 'console').slice(0, 80), pausedCampaigns: prev.pausedCampaigns, dialerErrors: [] });
}

function recordOutcome(pausedCampaigns: string[], dialerErrors: { campaign: string; error: string }[]): void {
  persist({ ...load(), pausedCampaigns: [...new Set(pausedCampaigns)], dialerErrors });
}

/**
 * Makes VICIdial follow the switch. A failed "off" is not remembered as paused, so "on" will
 * not start it; a failed "on" stays listed so the next press retries only that campaign.
 */
export async function applyCampaignDialing(
  off: boolean,
  consoleCampaigns: { viciCampaign?: string }[],
  client: CampaignSwitch
): Promise<CampaignDialingResult> {
  const current = new Set(load().pausedCampaigns);
  const targets = off
    ? [...new Set(consoleCampaigns.map((c) => String(c.viciCampaign || '').trim()).filter(Boolean))]
    : [...current];
  if (!targets.length) {
    recordOutcome([...current], []);
    return { changed: [], failed: [], skipped: off ? 'No campaign has a VICIdial campaign id.' : '' };
  }
  const changed: string[] = [];
  const failed: { campaign: string; error: string }[] = [];
  for (const id of targets) {
    const r = await client.setCampaignActive(id, !off);
    if (r.ok) {
      changed.push(id);
      if (off) current.add(id); else current.delete(id);
    } else {
      failed.push({ campaign: id, error: r.text || 'No answer from VICIdial' });
    }
  }
  recordOutcome([...current], failed);
  return { changed, failed, skipped: '' };
}
