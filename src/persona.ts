// One implementation is shared with the static browser so a persona setting
// cannot be honored on the bridge and dropped in the browser (or vice versa).
// The release bundle includes public/persona.js.
interface ConversationMemory {
  addUserText(value: string): void;
  addAssistantText(value: string): void;
  facts(): { statedAge: string | null; medicareStatus: string | null; userTurns: number };
  sanitizeTransferArgs(args: Record<string, any>): { args: Record<string, any>; omitted: string[]; corrected: string[] };
  qualificationBlockers(campaign?: { complianceRules?: string } | null): string[];
  lastUserText(): string;
}

interface PersonaApi {
  composeBehavioralPrompt(agent: any, campaign?: any): string;
  conversationIntegrityLines(): string[];
  callEndingLines(): string[];
  callTimeLimitLines(maxCallSec: number): string[];
  migrateLegacyQualificationPrompt(value: string, currentStock: string): string;
  migrateLegacyCampaignRules(value: string, currentStock: string, campaignId: string): string;
  defaultSelfIntro(id: string, name: string): string;
  migrateLegacySelfIntro(value: string, id: string, name: string): string;
  createConversationMemory(): ConversationMemory;
  fingerprint(text: string): string;
  TONE_MAP: Record<string, string>;
  FLOW_DEFAULTS: {
    speakingStyle: string; greetingLines: string; repeatLine: string; noAnswerLine: string;
    waitForHello: boolean; waitForHelloSec: number; noAnswerRepeats: number; greetingMaxWords: number;
    introLine: string; transferOnYes: boolean;
    voiceDeliveryEnabled: boolean; voiceDelivery: string; defaultSkillsEnabled: boolean;
  };
  MAX_PROMPT_LENGTH: number;
  MAX_CAMPAIGN_RULES: number;
  DEFAULT_SKILLS_HEADER: string;
  DEFAULT_SKILLS_TEXT: string;
  callPromptReport(agent: any, campaign: any, openingChars?: number): {
    instructionsChars: number; instructionsCutChars: number; instructionsLines: number; cutLines: string[];
    rulesChars: number; rulesCutChars: number; rulesLimit: number; callChars: number; phoneChars: number;
    phoneLimit: number; phoneRoom: number; callWillFail: boolean; builtInChars: number; voiceDeliveryOmitted: boolean; defaultSkillsOmitted: boolean;
  };
}

const api: PersonaApi = require('../public/persona.js');
export const {
  composeBehavioralPrompt,
  conversationIntegrityLines,
  callEndingLines,
  callTimeLimitLines,
  migrateLegacyQualificationPrompt,
  migrateLegacyCampaignRules,
  defaultSelfIntro,
  migrateLegacySelfIntro,
  createConversationMemory,
  fingerprint,
  TONE_MAP,
  FLOW_DEFAULTS,
  MAX_PROMPT_LENGTH,
  MAX_CAMPAIGN_RULES,
  callPromptReport,
  DEFAULT_SKILLS_HEADER,
  DEFAULT_SKILLS_TEXT,
} = api;
