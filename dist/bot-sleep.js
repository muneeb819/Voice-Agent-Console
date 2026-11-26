"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getBotSleep = getBotSleep;
exports.isBotSleeping = isBotSleeping;
exports.setBotSleep = setBotSleep;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const data_paths_1 = require("./data-paths");
const FILE_NAME = 'bot-sleep.json';
const DEFAULT_STATUS = { sleeping: false, since: null, by: '' };
let cached = null;
let cachedFor = '';
function filePath() {
    return path_1.default.join(data_paths_1.DATA_DIR, FILE_NAME);
}
function load() {
    const file = filePath();
    if (cached && cachedFor === file)
        return cached;
    let status = { ...DEFAULT_STATUS };
    try {
        const parsed = JSON.parse(fs_1.default.readFileSync(file, 'utf8'));
        status = {
            sleeping: parsed?.sleeping === true,
            since: typeof parsed?.since === 'string' ? parsed.since : null,
            by: typeof parsed?.by === 'string' ? parsed.by.slice(0, 80) : '',
        };
    }
    catch {
        // Missing or unreadable file means the bots are awake.
    }
    cached = status;
    cachedFor = file;
    return status;
}
function getBotSleep() {
    return { ...load() };
}
function isBotSleeping() {
    return load().sleeping;
}
function setBotSleep(sleeping, by = 'console') {
    const next = { sleeping, since: new Date().toISOString(), by: String(by || 'console').slice(0, 80) };
    fs_1.default.mkdirSync(data_paths_1.DATA_DIR, { recursive: true });
    const tmp = `${filePath()}.tmp`;
    fs_1.default.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
    fs_1.default.renameSync(tmp, filePath());
    cached = next;
    cachedFor = filePath();
    return { ...next };
}
