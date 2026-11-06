// One implementation is shared with the static browser so call and test
// composition/timing cannot silently drift. The release bundle includes it.
export interface OpeningGate {
  start(): void;
  userStarted(): void;
  userTurn(): void;
  agentTurn(): void;
  audio(chunk: Buffer): void;
  afterRelease(callback: () => void): void;
  cancel(): void;
}

interface OpeningApi {
  OPENING_DELAY_MS: number;
  migrateStockOpening(value: string): string;
  migrateStockMedicarePrompt(value: string, correctedStockPrompt: string): string;
  composeOpening(saved: string, variation: string, includeDisclosure: boolean, disclosure: string): string;
  prepareDelayedOpening(settings: any): { settings: any; greeting: string };
  createOpeningGate(options: {
    greeting: string;
    sendOpening(greeting: string): void;
    playAudio(chunk: Buffer): void;
    onOverflow?(): void;
  }): OpeningGate;
}

const api: OpeningApi = require('../public/opening.js');
export const { OPENING_DELAY_MS, migrateStockOpening, migrateStockMedicarePrompt, composeOpening, prepareDelayedOpening, createOpeningGate } = api;
