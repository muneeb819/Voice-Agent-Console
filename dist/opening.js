"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createOpeningGate = exports.prepareDelayedOpening = exports.composeOpening = exports.migrateStockMedicarePrompt = exports.migrateStockOpening = exports.NO_TRANSCRIPT_FALLBACK_MS = exports.OPENING_DELAY_MS = void 0;
const api = require('../public/opening.js');
exports.OPENING_DELAY_MS = api.OPENING_DELAY_MS, exports.NO_TRANSCRIPT_FALLBACK_MS = api.NO_TRANSCRIPT_FALLBACK_MS, exports.migrateStockOpening = api.migrateStockOpening, exports.migrateStockMedicarePrompt = api.migrateStockMedicarePrompt, exports.composeOpening = api.composeOpening, exports.prepareDelayedOpening = api.prepareDelayedOpening, exports.createOpeningGate = api.createOpeningGate;
