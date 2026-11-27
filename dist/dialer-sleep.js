"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyDialerSleep = applyDialerSleep;
const bot_sleep_1 = require("./bot-sleep");
/**
 * Makes the dialer follow the sleep switch. Asleep: turn off every VICIdial campaign the
 * console uses so the dialer stops placing calls. Awake: turn on exactly the campaigns
 * that the sleep switch turned off. Failures are kept so the screen can show them and a
 * later press retries them; the bridge keeps turning calls away either way.
 */
async function applyDialerSleep(sleeping, consoleCampaigns, client) {
    const before = (0, bot_sleep_1.getBotSleep)();
    const current = new Set(before.pausedCampaigns);
    const targets = sleeping
        ? [...new Set(consoleCampaigns.map((c) => String(c.viciCampaign || '').trim()).filter(Boolean))]
        : [...current];
    if (!targets.length) {
        (0, bot_sleep_1.setDialerOutcome)([...current], []);
        return { changed: [], failed: [], skipped: sleeping ? 'No campaign has a VICIdial campaign id.' : '' };
    }
    const changed = [];
    const failed = [];
    for (const id of targets) {
        const r = await client.setCampaignActive(id, !sleeping);
        if (r.ok) {
            changed.push(id);
            if (sleeping)
                current.add(id);
            else
                current.delete(id);
        }
        else {
            failed.push({ campaign: id, error: r.text || 'No answer from VICIdial' });
            // A failed wake stays on the list so the next wake retries it; a failed sleep was never turned off.
        }
    }
    (0, bot_sleep_1.setDialerOutcome)([...current], failed);
    return { changed, failed, skipped: '' };
}
