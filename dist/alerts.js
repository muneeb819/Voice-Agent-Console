"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEDUP_WINDOW_MS = void 0;
exports.cleanAlertText = cleanAlertText;
exports.raiseAlert = raiseAlert;
exports.listAlerts = listAlerts;
exports.acknowledgeAlerts = acknowledgeAlerts;
exports.classifyProviderError = classifyProviderError;
const crypto_1 = __importDefault(require("crypto"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const data_paths_1 = require("./data-paths");
const FILE_NAME = 'alerts.json';
const MAX_ALERTS = 100;
exports.DEDUP_WINDOW_MS = 10 * 60 * 1000;
let cache = null;
let cacheFor = '';
function filePath() {
    return path_1.default.join(data_paths_1.DATA_DIR, FILE_NAME);
}
function load() {
    const file = filePath();
    if (cache && cacheFor === file)
        return cache;
    let list = [];
    try {
        const parsed = JSON.parse(fs_1.default.readFileSync(file, 'utf8'));
        if (Array.isArray(parsed))
            list = parsed.filter((a) => a && typeof a.id === 'string' && typeof a.title === 'string');
    }
    catch {
        // No file yet.
    }
    cache = list;
    cacheFor = file;
    return list;
}
function save(list) {
    cache = list;
    cacheFor = filePath();
    try {
        fs_1.default.mkdirSync(data_paths_1.DATA_DIR, { recursive: true });
        const tmp = `${filePath()}.tmp`;
        fs_1.default.writeFileSync(tmp, JSON.stringify(list), { mode: 0o600 });
        fs_1.default.renameSync(tmp, filePath());
    }
    catch {
        // An alert must never break a call.
    }
}
/** Credentials and long bodies do not belong in an alert shown to every operator. */
function cleanAlertText(text, max = 300) {
    return String(text ?? '')
        // "Authorization: Token abc..." / "Bearer abc...": hide the credential that follows the scheme word.
        .replace(/\b(token|bearer|basic)\s+[A-Za-z0-9._~+\/=-]{8,}/gi, '$1 [hidden]')
        .replace(/(authorization|api[_-]?key|secret|password|pass|pwd)(["'\s:=]+)(?!\[hidden\])([^\s"'&,;]+)/gi, '$1$2[hidden]')
        .replace(/[\r\n\t]+/g, ' ')
        .slice(0, max)
        .trim();
}
function raiseAlert(input, now = Date.now()) {
    const list = load();
    const key = input.key || `${input.kind}:${input.title}`;
    const existing = list.find((a) => a.key === key && now - Date.parse(a.lastAt) < exports.DEDUP_WINDOW_MS);
    const iso = new Date(now).toISOString();
    if (existing) {
        existing.count += 1;
        existing.lastAt = iso;
        existing.detail = cleanAlertText(input.detail ?? existing.detail);
        existing.acknowledged = false;
        save(list);
        return { ...existing };
    }
    const record = {
        id: crypto_1.default.randomBytes(6).toString('hex'),
        kind: input.kind,
        severity: input.severity || 'warning',
        title: cleanAlertText(input.title, 120),
        detail: cleanAlertText(input.detail ?? ''),
        key,
        count: 1,
        firstAt: iso,
        lastAt: iso,
        acknowledged: false,
    };
    list.unshift(record);
    save(list.slice(0, MAX_ALERTS));
    return { ...record };
}
function listAlerts() {
    const list = load().map((a) => ({ ...a }));
    return { alerts: list, unacknowledged: list.filter((a) => !a.acknowledged).length };
}
/** Marks one alert, or all of them, as seen. Returns how many changed. */
function acknowledgeAlerts(id) {
    const list = load();
    let changed = 0;
    for (const a of list) {
        if ((!id || a.id === id) && !a.acknowledged) {
            a.acknowledged = true;
            changed += 1;
        }
    }
    if (changed)
        save(list);
    return changed;
}
/**
 * Sorts an error from the speech/AI provider into "overloaded, try again" or a
 * plain provider error, so overload shows up as its own alert.
 */
function classifyProviderError(text) {
    const t = String(text || '').toLowerCase();
    if (/rate.?limit|too many requests|\b429\b|overload|capacity|\b503\b|temporarily unavailable|quota|throttl|busy/.test(t)) {
        return 'llm_overload';
    }
    return 'provider_error';
}
