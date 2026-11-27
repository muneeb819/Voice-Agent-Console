import { setDialerOutcome, getBotSleep, type BotSleepStatus } from './bot-sleep';

/** The slice of the VICIdial client this module needs (kept small so tests can fake it). */
export interface CampaignSwitch {
  setCampaignActive(campaignId: string, active: boolean): Promise<{ ok: boolean; text: string }>;
}

export interface DialerSleepResult {
  /** Campaigns switched in this call. */
  changed: string[];
  /** Campaigns that could not be switched, with the dialer's answer. */
  failed: { campaign: string; error: string }[];
  /** Why nothing was attempted, when that is the case. */
  skipped: string;
}

/**
 * Makes the dialer follow the sleep switch. Asleep: turn off every VICIdial campaign the
 * console uses so the dialer stops placing calls. Awake: turn on exactly the campaigns
 * that the sleep switch turned off. Failures are kept so the screen can show them and a
 * later press retries them; the bridge keeps turning calls away either way.
 */
export async function applyDialerSleep(
  sleeping: boolean,
  consoleCampaigns: { viciCampaign?: string }[],
  client: CampaignSwitch
): Promise<DialerSleepResult> {
  const before = getBotSleep();
  const current = new Set(before.pausedCampaigns);
  const targets = sleeping
    ? [...new Set(consoleCampaigns.map((c) => String(c.viciCampaign || '').trim()).filter(Boolean))]
    : [...current];
  if (!targets.length) {
    setDialerOutcome([...current], []);
    return { changed: [], failed: [], skipped: sleeping ? 'No campaign has a VICIdial campaign id.' : '' };
  }
  const changed: string[] = [];
  const failed: { campaign: string; error: string }[] = [];
  for (const id of targets) {
    const r = await client.setCampaignActive(id, !sleeping);
    if (r.ok) {
      changed.push(id);
      if (sleeping) current.add(id); else current.delete(id);
    } else {
      failed.push({ campaign: id, error: r.text || 'No answer from VICIdial' });
      // A failed wake stays on the list so the next wake retries it; a failed sleep was never turned off.
    }
  }
  setDialerOutcome([...current], failed);
  return { changed, failed, skipped: '' };
}

export type { BotSleepStatus };
