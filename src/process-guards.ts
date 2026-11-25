/**
 * Process-level safety net for a long-running phone server.
 *
 * Node terminates the whole process on an unhandled promise rejection, which
 * would drop every live call because one call's handler failed. An isolated
 * rejection is logged and survived; a burst of them exits so systemd restarts
 * cleanly. Synchronous uncaught exceptions stay fatal (state may be inconsistent).
 */
export interface ErrorBudget {
  record(now?: number): boolean; // true = still within budget, false = give up and exit
}

export function createErrorBudget(maxErrors = 8, windowMs = 60_000): ErrorBudget {
  const stamps: number[] = [];
  return {
    record(now = Date.now()) {
      stamps.push(now);
      while (stamps.length && now - stamps[0] > windowMs) stamps.shift();
      return stamps.length <= maxErrors;
    },
  };
}

export function installProcessGuards(log: (msg: string, err?: unknown) => void = (m, e) => console.error(m, e)): void {
  const budget = createErrorBudget();
  // A rejected promise belongs to one call's async work and cannot corrupt shared
  // state mid-update, so it is logged and survived (bursts still restart cleanly).
  process.on('unhandledRejection', (err: unknown) => {
    log('[VoiceAgentConsole] unhandledRejection (call handler fault; process kept alive)', err);
    if (!budget.record()) {
      log('[VoiceAgentConsole] Too many unhandled rejections in one minute; exiting so the service manager restarts cleanly.');
      process.exit(1);
    }
  });
  // A synchronous uncaught exception can interrupt arbitrary shared-state updates
  // with no rollback, so it is fatal: log, then exit and let systemd restart (3s).
  process.on('uncaughtException', (err: unknown) => {
    log('[VoiceAgentConsole] uncaughtException (fatal; exiting for a clean restart)', err);
    setTimeout(() => process.exit(1), 100).unref();
  });
}
