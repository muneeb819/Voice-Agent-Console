"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.QA_REVIEW_AGENT_ID = void 0;
exports.normalizeCampaignAgents = normalizeCampaignAgents;
exports.campaignAgentIds = campaignAgentIds;
exports.campaignHasAgent = campaignHasAgent;
exports.primaryCampaignAgent = primaryCampaignAgent;
exports.assignCampaignSlots = assignCampaignSlots;
exports.campaignExtension = campaignExtension;
exports.campaignSlot = campaignSlot;
exports.reconcileCampaignSlots = reconcileCampaignSlots;
exports.phoneBotPool = phoneBotPool;
exports.pickPhoneBot = pickPhoneBot;
exports.resetPhoneRotationForTests = resetPhoneRotationForTests;
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
function assignCampaignSlots(campaigns, highWater = 0) {
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
    let next = Math.max(used.size ? Math.max(...used) : 0, Number.isInteger(highWater) && highWater > 0 ? highWater : 0) + 1;
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
/**
 * Never hand a retired extension to another campaign. `campaignSlotSeq` is a
 * monotonic high-water mark of every slot ever issued, so deleting the
 * highest-numbered campaign cannot free its number for the next one. Compared
 * with the previously saved state, any campaign that now claims a slot that
 * belonged to a different (or deleted) campaign is moved to a fresh number.
 */
function reconcileCampaignSlots(prev, next) {
    const maxSlot = (list) => list.reduce((m, c) => Math.max(m, c.slot || 0), 0);
    let seq = Math.max(next.campaignSlotSeq || 0, prev?.campaignSlotSeq || 0, prev ? maxSlot(prev.campaigns) : 0, maxSlot(next.campaigns));
    if (prev) {
        const prevOwner = new Map(prev.campaigns.map((c) => [c.slot, c.id]));
        const prevSeq = Math.max(prev.campaignSlotSeq || 0, maxSlot(prev.campaigns));
        for (const c of next.campaigns) {
            const owner = prevOwner.get(c.slot);
            const retired = owner === undefined && c.slot <= prevSeq;
            if ((owner !== undefined && owner !== c.id) || retired) {
                seq += 1;
                c.slot = seq;
            }
        }
    }
    next.campaignSlotSeq = seq;
}
/** The shared QA reviewer bot never answers phone calls. */
exports.QA_REVIEW_AGENT_ID = 'a_qa';
/** Bots that answer this campaign's phone calls, primary first (the QA reviewer excluded). */
function phoneBotPool(state, campaign) {
    return campaignAgentIds(campaign)
        .filter((id) => id !== exports.QA_REVIEW_AGENT_ID)
        .map((id) => state.agents.find((agent) => agent.id === id))
        .filter((agent) => Boolean(agent));
}
const phoneRotation = new Map();
/**
 * Next bot for a phone call: every ready bot assigned to the campaign takes
 * calls in turn. Bots that are not ready are left out of the turn order, so the
 * ready ones share calls evenly.
 */
function pickPhoneBot(state, campaign, isReady = () => true) {
    const eligible = phoneBotPool(state, campaign).filter(isReady);
    if (eligible.length <= 1)
        return eligible[0];
    const key = String(campaign.id || '');
    const n = phoneRotation.get(key) || 0;
    phoneRotation.set(key, n + 1);
    return eligible[n % eligible.length];
}
/** Tests reset the rotation between cases. */
function resetPhoneRotationForTests() { phoneRotation.clear(); }
