import type { Agent, Campaign, ConsoleState } from './types';

type CampaignAssignment = Pick<Campaign, 'agentId' | 'agentIds'>;

/** Legacy state has one agentId; newer state also has an explicit pool.
 * Never invent an assignment when both fields are empty. The primary remains
 * deterministic for a telephone extension, which cannot carry a browser-style
 * agent selector. Additional pool members are available to explicit test calls.
 */
export function normalizeCampaignAgents(campaign: Partial<CampaignAssignment>, validIds?: Set<string>): { agentId: string; agentIds: string[] } {
  const legacy = typeof campaign.agentId === 'string' ? campaign.agentId.trim() : '';
  const requested = Array.isArray(campaign.agentIds) ? campaign.agentIds : [];
  const ids = [...new Set([legacy, ...requested].filter((id): id is string => typeof id === 'string' && Boolean(id.trim())).map((id) => id.trim()))]
    .filter((id) => !validIds || validIds.has(id));
  const agentId = ids.includes(legacy) ? legacy : ids[0] || '';
  return { agentId, agentIds: agentId ? [agentId, ...ids.filter((id) => id !== agentId)] : ids };
}

export function campaignAgentIds(campaign: Partial<CampaignAssignment>): string[] {
  return normalizeCampaignAgents(campaign).agentIds;
}

export function campaignHasAgent(campaign: Partial<CampaignAssignment>, agentId: string): boolean {
  return campaignAgentIds(campaign).includes(agentId);
}

export function primaryCampaignAgent(state: Pick<ConsoleState, 'agents'>, campaign: Partial<CampaignAssignment>): Agent | undefined {
  const { agentId } = normalizeCampaignAgents(campaign);
  return state.agents.find((agent) => agent.id === agentId);
}
