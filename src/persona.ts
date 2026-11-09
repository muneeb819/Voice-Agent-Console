// One implementation is shared with the static browser so a persona setting
// cannot be honored on the bridge and dropped in the browser (or vice versa).
// The release bundle includes public/persona.js.
interface ConversationMemory {
  addUserText(value: string): void;
  addAssistantText(value: string): void;
  facts(): { statedAge: string | null; medicareStatus: string | null; userTurns: number };
  sanitizeTransferArgs(args: Record<string, any>): { args: Record<string, any>; omitted: string[]; corrected: string[] };
  qualificationBlockers(campaign?: { complianceRules?: string } | null): string[];
}

interface PersonaApi {
  composeBehavioralPrompt(agent: any, campaign?: any): string;
  conversationIntegrityLines(): string[];
  migrateLegacyQualificationPrompt(value: string, currentStock: string): string;
  migrateLegacyCampaignRules(value: string, currentStock: string, campaignId: string): string;
  defaultSelfIntro(id: string, name: string): string;
  migrateLegacySelfIntro(value: string, id: string, name: string): string;
  createConversationMemory(): ConversationMemory;
  fingerprint(text: string): string;
  TONE_MAP: Record<string, string>;
  MAX_PROMPT_LENGTH: number;
  MAX_CAMPAIGN_RULES: number;
}

const api: PersonaApi = require('../public/persona.js');
export const {
  composeBehavioralPrompt,
  conversationIntegrityLines,
  migrateLegacyQualificationPrompt,
  migrateLegacyCampaignRules,
  defaultSelfIntro,
  migrateLegacySelfIntro,
  createConversationMemory,
  fingerprint,
  TONE_MAP,
  MAX_PROMPT_LENGTH,
  MAX_CAMPAIGN_RULES,
} = api;
