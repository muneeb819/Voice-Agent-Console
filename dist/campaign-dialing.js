"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCampaignDialing = getCampaignDialing;
exports.setCampaignDialingFlag = setCampaignDialingFlag;
exports.applyCampaignDialing = applyCampaignDialing;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const data_paths_1 = require("./data-paths");
const FILE_NAME = 'campaign-dialing.json';
const DEFAULT_STATUS = { off: false, since: null, by: '', pausedCampaigns: [], dialerErrors: [] };
let cached = null;
let cachedFor = '';
function filePath() {
    return path_1.default.join(data_paths_1.DATA_DIR, FILE_NAME);
}
function load() {
    const file = filePath();
    if (cached && cachedFor === file)
        return cached;
    let status = { ...DEFAULT_STATUS, pausedCampaigns: [], dialerErrors: [] };
    try {
        const p = JSON.parse(fs_1.default.readFileSync(file, 'utf8'));
        status = {
            off: p?.off === true,
            since: typeof p?.since === 'string' ? p.since : null,
            by: typeof p?.by === 'string' ? p.by.slice(0, 80) : '',
            pausedCampaigns: Array.isArray(p?.pausedCampaigns) ? p.pausedCampaigns.map(String).slice(0, 100) : [],
            dialerErrors: Array.isArray(p?.dialerErrors)
                ? p.dialerErrors.slice(0, 100).map((e) => ({ campaign: String(e?.campaign || ''), error: String(e?.error || '').slice(0, 200) }))
                : [],
        };
    }
    catch {
        // Missing or unreadable file means nothing is being held off.
    }
    cached = status;
    cachedFor = file;
    return status;
}
function persist(next) {
    fs_1.default.mkdirSync(data_paths_1.DATA_DIR, { recursive: true });
    const tmp = `${filePath()}.tmp`;
    fs_1.default.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
    fs_1.default.renameSync(tmp, filePath());
    cached = next;
    cachedFor = filePath();
    return getCampaignDialing();
}
function getCampaignDialing() {
    const s = load();
    return { ...s, pausedCampaigns: [...s.pausedCampaigns], dialerErrors: s.dialerErrors.map((e) => ({ ...e })) };
}
/** Records the new setting. The list of campaigns turned off is kept for the matching "on". */
function setCampaignDialingFlag(off, by = 'console') {
    const prev = load();
    return persist({ off, since: new Date().toISOString(), by: String(by || 'console').slice(0, 80), pausedCampaigns: prev.pausedCampaigns, dialerErrors: [] });
}
function recordOutcome(pausedCampaigns, dialerErrors) {
    persist({ ...load(), pausedCampaigns: [...new Set(pausedCampaigns)], dialerErrors });
}
/**
 * Makes VICIdial follow the switch. A failed "off" is not remembered as paused, so "on" will
 * not start it; a failed "on" stays listed so the next press retries only that campaign.
 */
async function applyCampaignDialing(off, consoleCampaigns, client) {
    const current = new Set(load().pausedCampaigns);
    const targets = off
        ? [...new Set(consoleCampaigns.map((c) => String(c.viciCampaign || '').trim()).filter(Boolean))]
        : [...current];
    if (!targets.length) {
        recordOutcome([...current], []);
        return { changed: [], failed: [], skipped: off ? 'No campaign has a VICIdial campaign id.' : '' };
    }
    const changed = [];
    const failed = [];
    for (const id of targets) {
        const r = await client.setCampaignActive(id, !off);
        if (r.ok) {
            changed.push(id);
            if (off)
                current.add(id);
            else
                current.delete(id);
        }
        else {
            failed.push({ campaign: id, error: r.text || 'No answer from VICIdial' });
        }
    }
    recordOutcome([...current], failed);
    return { changed, failed, skipped: '' };
}
