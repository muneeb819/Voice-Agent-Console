"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeCampaignAgents = normalizeCampaignAgents;
exports.campaignAgentIds = campaignAgentIds;
exports.campaignHasAgent = campaignHasAgent;
exports.primaryCampaignAgent = primaryCampaignAgent;
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
