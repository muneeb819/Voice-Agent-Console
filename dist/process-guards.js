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
    // A rejected promise belongs to one call's async work and cannot corrupt shared
    // state mid-update, so it is logged and survived (bursts still restart cleanly).
    process.on('unhandledRejection', (err) => {
        log('[VoiceAgentConsole] unhandledRejection (call handler fault; process kept alive)', err);
        if (!budget.record()) {
            log('[VoiceAgentConsole] Too many unhandled rejections in one minute; exiting so the service manager restarts cleanly.');
            process.exit(1);
        }
    });
    // A synchronous uncaught exception can interrupt arbitrary shared-state updates
    // with no rollback, so it is fatal: log, then exit and let systemd restart (3s).
    process.on('uncaughtException', (err) => {
        log('[VoiceAgentConsole] uncaughtException (fatal; exiting for a clean restart)', err);
        setTimeout(() => process.exit(1), 100).unref();
    });
}
