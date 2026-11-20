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
export function assignCampaignSlots<T extends { slot?: unknown }>(campaigns: T[]): Array<T & { slot: number }> {
  const valid = (value: unknown): number | null => {
    const n = Number(value);
    return Number.isInteger(n) && n >= 1 && n <= 9999 ? n : null;
  };
  const anyStored = campaigns.some((c) => valid(c?.slot) !== null);
  const used = new Set<number>();
  const slots: Array<number | null> = campaigns.map((c, idx) => {
    const wanted = anyStored ? valid(c?.slot) : idx + 1;
    if (wanted === null || used.has(wanted)) return null;
    used.add(wanted);
    return wanted;
  });
  let next = used.size ? Math.max(...used) + 1 : 1;
  return campaigns.map((c, idx) => {
    let slot = slots[idx];
    if (slot === null) {
      while (used.has(next)) next += 1;
      slot = next;
      used.add(slot);
    }
    return { ...c, slot };
  });
}

/** Dialed extension for a campaign; falls back to position only for unsaved data. */
export function campaignExtension(aiExten: string, campaign: { slot?: number }, index: number): string {
  const slot = Number.isInteger(campaign?.slot) && (campaign.slot as number) > 0 ? campaign.slot as number : index + 1;
  return `${String(aiExten || '8800').trim()}${slot}`;
}

export function campaignSlot(campaign: { slot?: number }, index: number): number {
  return Number.isInteger(campaign?.slot) && (campaign.slot as number) > 0 ? campaign.slot as number : index + 1;
}
