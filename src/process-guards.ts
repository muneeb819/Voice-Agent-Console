/**
 * Process-level safety net for a long-running phone server.
 *
 * Node terminates the whole process on an unhandled promise rejection or an
 * uncaught exception, which would drop every live call because one call's
 * handler failed. An isolated fault is logged and survived; a burst of faults
 * (a real crash loop) exits so systemd restarts the service cleanly.
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
  const handle = (kind: string) => (err: unknown) => {
    log(`[VoiceAgentConsole] ${kind} (call handler fault; process kept alive)`, err);
    if (!budget.record()) {
      log(`[VoiceAgentConsole] Too many ${kind} events in one minute; exiting so the service manager restarts cleanly.`);
      process.exit(1);
    }
  };
  process.on('unhandledRejection', handle('unhandledRejection'));
  process.on('uncaughtException', handle('uncaughtException'));
}
