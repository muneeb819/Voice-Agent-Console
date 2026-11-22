// One implementation is shared with the static browser so call and test
// composition/timing cannot silently drift. The release bundle includes it.
export interface OpeningGate {
  start(): void;
  userStarted(): void;
  userTurn(): void;
  audio(chunk: Buffer): void;
  afterRelease(callback: () => void): void;
  cancel(): void;
}

/** Front-end "call start" settings that change how the opening is spoken. */
export interface OpeningOptions {
  waitForCaller?: boolean;
  noAnswerText?: string;
}

interface OpeningApi {
  OPENING_DELAY_MS: number;
  NO_TRANSCRIPT_FALLBACK_MS: number;
  migrateStockOpening(value: string): string;
  migrateStockMedicarePrompt(value: string, correctedStockPrompt: string): string;
  composeOpening(saved: string, variation: string, includeDisclosure: boolean, disclosure: string): string;
  prepareDelayedOpening(settings: any, options?: OpeningOptions): { settings: any; greeting: string };
  openingInstruction(greeting: string, options?: OpeningOptions): string;
  wordCount(text: string): number;
  timeOfDay(timeZone?: string, now?: Date): 'morning' | 'afternoon' | 'evening';
  localizeGreeting(line: string, timeZone?: string, now?: Date): string;
  greetingLineList(text: string, maxWords?: number): string[];
  createOpeningGate(options: {
    greeting: string;
    waitForCaller?: boolean;
    waitForCallerMs?: number;
    noAnswerText?: string;
    noAnswerRepeats?: number;
    sendOpening(text: string): void;
    playAudio(chunk: Buffer): void;
    onSendError?(error: unknown): void;
    onOverflow?(): void;
  }): OpeningGate;
}

const api: OpeningApi = require('../public/opening.js');
export const {
  OPENING_DELAY_MS,
  NO_TRANSCRIPT_FALLBACK_MS,
  migrateStockOpening,
  migrateStockMedicarePrompt,
  composeOpening,
  prepareDelayedOpening,
  openingInstruction,
  createOpeningGate,
  wordCount,
  timeOfDay,
  localizeGreeting,
  greetingLineList,
} = api;

/** The bot's front-end call-start settings, as the opening instruction needs them. */
export function openingOptionsFor(agent: { flow?: { waitForHello?: boolean; noAnswerLine?: string; noAnswerRepeats?: number } }): OpeningOptions {
  const f = agent.flow || {};
  return { waitForCaller: f.waitForHello !== false, noAnswerText: Number(f.noAnswerRepeats ?? 2) > 0 ? String(f.noAnswerLine || '') : '' };
}

/** The same settings for the timing gate that holds the bot until the caller speaks. */
export function openingGateOptionsFor(agent: { flow?: { waitForHello?: boolean; waitForHelloSec?: number; noAnswerLine?: string; noAnswerRepeats?: number } }) {
  const f = agent.flow || {};
  return {
    waitForCaller: f.waitForHello !== false,
    waitForCallerMs: Math.round(Number(f.waitForHelloSec ?? 3) * 1000),
    noAnswerText: String(f.noAnswerLine || ''),
    noAnswerRepeats: Number(f.noAnswerRepeats ?? 2),
  };
}
