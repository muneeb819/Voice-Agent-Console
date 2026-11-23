"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.screeningEnabled = exports.parseNativeAmdHeader = exports.loadScreeningConfig = exports.runScreeningVerification = exports.lastTestRun = exports.screeningCounts = exports.recentScreeningResults = exports.screeningSettingsRow = exports.setScreeningEnabled = exports.isScreeningEnabled = void 0;
exports.setScreeningTestHooks = setScreeningTestHooks;
exports.startCallScreening = startCallScreening;
exports.recordScreeningDecision = recordScreeningDecision;
exports.sendScreeningDisposition = sendScreeningDisposition;
// Call screening module: the bridge's only entry points.
const asr_1 = require("./asr");
const config_1 = require("./config");
const disposition_1 = require("./disposition");
const session_1 = require("./session");
const store_1 = require("./store");
Object.defineProperty(exports, "screeningEnabled", { enumerable: true, get: function () { return store_1.isScreeningEnabled; } });
__exportStar(require("./types"), exports);
var store_2 = require("./store");
Object.defineProperty(exports, "isScreeningEnabled", { enumerable: true, get: function () { return store_2.isScreeningEnabled; } });
Object.defineProperty(exports, "setScreeningEnabled", { enumerable: true, get: function () { return store_2.setScreeningEnabled; } });
Object.defineProperty(exports, "screeningSettingsRow", { enumerable: true, get: function () { return store_2.screeningSettingsRow; } });
Object.defineProperty(exports, "recentScreeningResults", { enumerable: true, get: function () { return store_2.recentScreeningResults; } });
Object.defineProperty(exports, "screeningCounts", { enumerable: true, get: function () { return store_2.screeningCounts; } });
Object.defineProperty(exports, "lastTestRun", { enumerable: true, get: function () { return store_2.lastTestRun; } });
var verify_1 = require("./verify");
Object.defineProperty(exports, "runScreeningVerification", { enumerable: true, get: function () { return verify_1.runScreeningVerification; } });
var config_2 = require("./config");
Object.defineProperty(exports, "loadScreeningConfig", { enumerable: true, get: function () { return config_2.loadScreeningConfig; } });
Object.defineProperty(exports, "parseNativeAmdHeader", { enumerable: true, get: function () { return config_2.parseNativeAmdHeader; } });
let testHooks = null;
/** Test-only: replace live speech recognition and the probe voice for bridge integration tests. */
function setScreeningTestHooks(hooks) { testHooks = hooks; }
function startCallScreening(input) {
    const cfg = (0, config_1.loadScreeningConfig)();
    const nativeAmd = (0, config_1.parseNativeAmdHeader)(input.amdHeader, input.amdSignature, input.callerCode, cfg.eventSecret);
    const phone = (0, config_1.normalisePhone)(input.phone);
    const label = phone ? cfg.testEndpoints.get(phone) : undefined;
    if (nativeAmd.status !== 'NONE') {
        input.log(`Native AMD: ${nativeAmd.status}${nativeAmd.cause ? ` (${nativeAmd.cause})` : ''}${nativeAmd.authenticated ? '' : ', signature not valid, ignored'}`);
    }
    const session = new session_1.ScreeningSession({
        thresholds: cfg.thresholds,
        nativeAmd,
        testEndpoint: { matched: Boolean(label), label },
        asrFactory: input.asrFactory || testHooks?.asrFactory || (0, asr_1.createDeepgramAsr)(cfg.asrModel),
        probe: { enabled: cfg.probeEnabled, always: cfg.alwaysProbe, loadAudio: input.probeLoader || testHooks?.probeLoader || (() => (0, asr_1.deepgramProbeAudio)(cfg.probeText, cfg.probeVoice)) },
        playAudio: input.playAudio,
        onLog: input.log,
    });
    session.start();
    return { session, nativeAmd };
}
/** Saves the decision once and returns the VICIdial status to set ('' for a confirmed person). */
function recordScreeningDecision(input, log, statusOverride) {
    const cfg = (0, config_1.loadScreeningConfig)();
    const status = statusOverride !== undefined ? statusOverride : input.decision.outcome === 'HUMAN_CONFIRMED' ? '' : cfg.dispositions[input.decision.outcome];
    try {
        const first = (0, store_1.recordScreeningResult)({
            callId: input.callId,
            campaignId: input.campaignId,
            leadId: input.leadId,
            callerCode: input.callerCode,
            phone: input.phone,
            nativeAmd: input.nativeAmd.status,
            decision: input.decision,
            disposition: status,
        });
        if (!first)
            log('Screening result was already recorded for this call (duplicate ignored)');
    }
    catch (err) {
        log(`Screening result not saved: ${err?.message || 'database error'}`);
    }
    return status;
}
async function sendScreeningDisposition(input, log) {
    return (0, disposition_1.applyScreeningDisposition)({
        callId: input.callId,
        callerCode: input.callerCode,
        remoteAgentUser: input.remoteAgentUser,
        leadId: input.leadId,
        campaignViciId: input.campaignViciId,
        status: input.status,
        client: input.client,
        log,
    });
}
