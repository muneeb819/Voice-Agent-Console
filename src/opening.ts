// One implementation is shared with the static browser so call and test
// composition/timing cannot silently drift. The release bundle includes it.
export interface OpeningGate {
  start(): void;
  userStarted(): void;
  userTurn(): void;
  agentTurn(): void;
  agentAudioDone(): void;
  audio(chunk: Buffer): void;
  afterRelease(callback: () => void): void;
  cancel(): void;
}

interface OpeningApi {
  OPENING_DELAY_MS: number;
  NO_TRANSCRIPT_FALLBACK_MS: number;
  PRESENCE_PROMPT_TIMEOUT_MS: number;
  DEFAULT_PRESENCE_CHECK_TEXT: string;
  migrateStockOpening(value: string): string;
  migrateStockMedicarePrompt(value: string, correctedStockPrompt: string): string;
  composeOpening(saved: string, variation: string, includeDisclosure: boolean, disclosure: string): string;
  prepareDelayedOpening(settings: any): { settings: any; greeting: string };
  createOpeningGate(options: {
    presenceCheck: string;
    responseTimeoutMs?: number;
    presencePromptTimeoutMs?: number;
    sendPresenceCheck(text: string): void;
    playAudio(chunk: Buffer): void;
    onDeadAir?(): void;
    onOverflow?(): void;
  }): OpeningGate;
}

const api: OpeningApi = require('../public/opening.js');
export const {
  OPENING_DELAY_MS,
  NO_TRANSCRIPT_FALLBACK_MS,
  PRESENCE_PROMPT_TIMEOUT_MS,
  DEFAULT_PRESENCE_CHECK_TEXT,
  migrateStockOpening,
  migrateStockMedicarePrompt,
  composeOpening,
  prepareDelayedOpening,
  createOpeningGate,
} = api;
