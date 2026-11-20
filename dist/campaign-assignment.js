"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeCampaignAgents = normalizeCampaignAgents;
exports.campaignAgentIds = campaignAgentIds;
exports.campaignHasAgent = campaignHasAgent;
exports.primaryCampaignAgent = primaryCampaignAgent;
exports.assignCampaignSlots = assignCampaignSlots;
exports.campaignExtension = campaignExtension;
exports.campaignSlot = campaignSlot;
/** Legacy state has one agentId; newer state also has an explicit pool.
 * Never invent an assignment when both fields are empty. The primary remains
 * deterministic for a telephone extension, which cannot carry a browser-style
 * agent selector. Additional pool members are available to explicit test calls.
 */
function normalizeCampaignAgents(campaign, validIds) {
    const legacy = typeof campaign.agentId === 'string' ? campaign.agentId.trim() : '';
    const requested = Array.isArray(campaign.agentIds) ? campaign.agentIds : [];
    const ids = [...new Set([legacy, ...requested].filter((id) => typeof id === 'string' && Boolean(id.trim())).map((id) => id.trim()))]
        .filter((id) => !validIds || validIds.has(id));
    const agentId = ids.includes(legacy) ? legacy : ids[0] || '';
    return { agentId, agentIds: agentId ? [agentId, ...ids.filter((id) => id !== agentId)] : ids };
}
function campaignAgentIds(campaign) {
    return normalizeCampaignAgents(campaign).agentIds;
}
function campaignHasAgent(campaign, agentId) {
    return campaignAgentIds(campaign).includes(agentId);
}
function primaryCampaignAgent(state, campaign) {
    const { agentId } = normalizeCampaignAgents(campaign);
    return state.agents.find((agent) => agent.id === agentId);
}
/**
 * Stable telephone slot per campaign: the dialed extension is `${aiExten}${slot}`
 * and the VICIdial remote agent user is `remoteAgentUser + slot - 1`.
 *
 * Earlier releases derived both from the campaign's array position, so deleting
 * or reordering a campaign silently re-routed every later campaign's live calls
 * to a different bot. Slots are now stored with the campaign:
 *  - Legacy state with no slots keeps its existing numbering (slot = position).
 *  - A campaign added later gets max(slot) + 1, so a deleted campaign's
 *    extension is never handed to another campaign.
 *  - A duplicated slot (e.g. a copied campaign) keeps the first holder and moves
 *    the later one to a new number.
 */
function assignCampaignSlots(campaigns) {
    const valid = (value) => {
        const n = Number(value);
        return Number.isInteger(n) && n >= 1 && n <= 9999 ? n : null;
    };
    const anyStored = campaigns.some((c) => valid(c?.slot) !== null);
    const used = new Set();
    const slots = campaigns.map((c, idx) => {
        const wanted = anyStored ? valid(c?.slot) : idx + 1;
        if (wanted === null || used.has(wanted))
            return null;
        used.add(wanted);
        return wanted;
    });
    let next = used.size ? Math.max(...used) + 1 : 1;
    return campaigns.map((c, idx) => {
        let slot = slots[idx];
        if (slot === null) {
            while (used.has(next))
                next += 1;
            slot = next;
            used.add(slot);
        }
        return { ...c, slot };
    });
}
/** Dialed extension for a campaign; falls back to position only for unsaved data. */
function campaignExtension(aiExten, campaign, index) {
    const slot = Number.isInteger(campaign?.slot) && campaign.slot > 0 ? campaign.slot : index + 1;
    return `${String(aiExten || '8800').trim()}${slot}`;
}
function campaignSlot(campaign, index) {
    return Number.isInteger(campaign?.slot) && campaign.slot > 0 ? campaign.slot : index + 1;
}
