"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createErrorBudget = createErrorBudget;
exports.installProcessGuards = installProcessGuards;
function createErrorBudget(maxErrors = 8, windowMs = 60_000) {
    const stamps = [];
    return {
        record(now = Date.now()) {
            stamps.push(now);
            while (stamps.length && now - stamps[0] > windowMs)
                stamps.shift();
            return stamps.length <= maxErrors;
        },
    };
}
function installProcessGuards(log = (m, e) => console.error(m, e)) {
    const budget = createErrorBudget();
    const handle = (kind) => (err) => {
        log(`[VoiceAgentConsole] ${kind} (call handler fault; process kept alive)`, err);
        if (!budget.record()) {
            log(`[VoiceAgentConsole] Too many ${kind} events in one minute; exiting so the service manager restarts cleanly.`);
            process.exit(1);
        }
    };
    process.on('unhandledRejection', handle('unhandledRejection'));
    process.on('uncaughtException', handle('uncaughtException'));
}
