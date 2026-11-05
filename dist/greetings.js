"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadBundledGreetings = loadBundledGreetings;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
/** Validate the entire bundled seed before importing any of it into SQLite. */
function loadBundledGreetings() {
    const file = path_1.default.resolve(__dirname, '..', 'public', 'greetings.json');
    const parsed = JSON.parse(fs_1.default.readFileSync(file, 'utf8'));
    const rows = parsed?.greetings;
    if (!Array.isArray(rows) || rows.length === 0)
        throw new Error('Greeting catalog is empty or invalid');
    const ids = new Set();
    const fields = ['greeting_id', 'persona', 'context', 'greeting_text', 'tone'];
    return rows.map((raw) => {
        if (!raw || typeof raw !== 'object' || fields.some((field) => typeof raw[field] !== 'string' || !raw[field].trim()))
            throw new Error('Greeting catalog contains an invalid row');
        const row = Object.fromEntries(fields.map((field) => [field, raw[field]]));
        if (ids.has(row.greeting_id))
            throw new Error(`Duplicate greeting ID: ${row.greeting_id}`);
        ids.add(row.greeting_id);
        return row;
    });
}
