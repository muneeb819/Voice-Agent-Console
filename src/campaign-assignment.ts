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
export function assignCampaignSlots<T extends { slot?: unknown }>(campaigns: T[], highWater = 0): Array<T & { slot: number }> {
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
  let next = Math.max(used.size ? Math.max(...used) : 0, Number.isInteger(highWater) && highWater > 0 ? highWater : 0) + 1;
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

/**
 * Never hand a retired extension to another campaign. `campaignSlotSeq` is a
 * monotonic high-water mark of every slot ever issued, so deleting the
 * highest-numbered campaign cannot free its number for the next one. Compared
 * with the previously saved state, any campaign that now claims a slot that
 * belonged to a different (or deleted) campaign is moved to a fresh number.
 */
export function reconcileCampaignSlots(
  prev: { campaigns: Array<{ id: string; slot: number }>; campaignSlotSeq?: number } | null,
  next: { campaigns: Array<{ id: string; slot: number }>; campaignSlotSeq: number }
): void {
  const maxSlot = (list: Array<{ slot: number }>) => list.reduce((m, c) => Math.max(m, c.slot || 0), 0);
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
export const QA_REVIEW_AGENT_ID = 'a_qa';

/** Bots that answer this campaign's phone calls, primary first (the QA reviewer excluded). */
export function phoneBotPool(state: Pick<ConsoleState, 'agents'>, campaign: Partial<CampaignAssignment>): Agent[] {
  return campaignAgentIds(campaign)
    .filter((id) => id !== QA_REVIEW_AGENT_ID)
    .map((id) => state.agents.find((agent) => agent.id === id))
    .filter((agent): agent is Agent => Boolean(agent));
}

const phoneRotation = new Map<string, number>();

/**
 * Round-robin order for the next phone call: every assigned bot takes calls in
 * turn. Returns the pool rotated so the caller can skip a bot that is not ready.
 */
export function nextPhoneBotOrder(state: Pick<ConsoleState, 'agents'>, campaign: Partial<CampaignAssignment> & { id?: string }): Agent[] {
  const pool = phoneBotPool(state, campaign);
  if (pool.length <= 1) return pool;
  const key = String(campaign.id || '');
  const start = (phoneRotation.get(key) || 0) % pool.length;
  phoneRotation.set(key, start + 1);
  return [...pool.slice(start), ...pool.slice(0, start)];
}

/** Tests reset the rotation between cases. */
export function resetPhoneRotationForTests(): void { phoneRotation.clear(); }
