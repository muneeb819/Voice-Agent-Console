"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.greetingLineList = exports.localizeGreeting = exports.timeOfDay = exports.wordCount = exports.createOpeningGate = exports.openingInstruction = exports.prepareDelayedOpening = exports.composeOpening = exports.migrateStockMedicarePrompt = exports.migrateStockOpening = exports.NO_TRANSCRIPT_FALLBACK_MS = exports.OPENING_DELAY_MS = void 0;
exports.openingOptionsFor = openingOptionsFor;
exports.openingGateOptionsFor = openingGateOptionsFor;
const api = require('../public/opening.js');
exports.OPENING_DELAY_MS = api.OPENING_DELAY_MS, exports.NO_TRANSCRIPT_FALLBACK_MS = api.NO_TRANSCRIPT_FALLBACK_MS, exports.migrateStockOpening = api.migrateStockOpening, exports.migrateStockMedicarePrompt = api.migrateStockMedicarePrompt, exports.composeOpening = api.composeOpening, exports.prepareDelayedOpening = api.prepareDelayedOpening, exports.openingInstruction = api.openingInstruction, exports.createOpeningGate = api.createOpeningGate, exports.wordCount = api.wordCount, exports.timeOfDay = api.timeOfDay, exports.localizeGreeting = api.localizeGreeting, exports.greetingLineList = api.greetingLineList;
/** The bot's front-end call-start settings, as the opening instruction needs them. */
function openingOptionsFor(agent) {
    const f = agent.flow || {};
    return { waitForCaller: f.waitForHello !== false, noAnswerText: Number(f.noAnswerRepeats ?? 2) > 0 ? String(f.noAnswerLine || '') : '' };
}
/** The same settings for the timing gate that holds the bot until the caller speaks. */
function openingGateOptionsFor(agent) {
    const f = agent.flow || {};
    return {
        waitForCaller: f.waitForHello !== false,
        waitForCallerMs: Math.round(Number(f.waitForHelloSec ?? 3) * 1000),
        noAnswerText: String(f.noAnswerLine || ''),
        noAnswerRepeats: Number(f.noAnswerRepeats ?? 2),
    };
}
