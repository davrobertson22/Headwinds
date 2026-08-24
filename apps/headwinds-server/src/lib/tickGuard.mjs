// Tick watchdog: detects a wedged tick pass — an await that never returns, e.g. a
// query hung on a connection whose server side the pooler silently dropped — and
// reports it so the worker can exit and be restarted by the platform.
//
// Why this exists: 2026-08-23 the worker logged one P2024 tick error at 00:22 PDT
// and then sat silent for 17.5 hours. A pass had hung inside runDueTicks without
// throwing, so the `ticking` re-entrancy guard stayed true and every later
// setInterval fire returned immediately at `if (ticking) return`. The process
// looked healthy to Railway — nothing restarted it, and no world ticked until a
// manual redeploy. A hung pass cannot be cancelled from the outside in JS; the
// only safe recovery is to exit the process and let the platform restart it
// (ticks are CAS-idempotent, so a pass killed mid-week just re-runs cleanly).
//
// Pure and DB-free so the test chain can drive it with a fake clock (importing
// worker/index.mjs would pull env.mjs and throw without DATABASE_URL — testable
// logic lives in lib/, per the house rule).

export function createTickGuard({
  wedgeMs,
  heartbeatMs = 5 * 60_000,
  onWedge,
  onHeartbeat,
  now = () => Date.now(),
} = {}) {
  if (!(wedgeMs > 0)) throw new Error('createTickGuard: wedgeMs must be > 0');
  let passStartedAt = null;    // ms epoch of the running pass, or null when idle
  let lastEndedAt = now();
  let lastHeartbeatAt = now();
  let wedgeReported = false;
  let passes = 0;

  return {
    beginPass() {
      passStartedAt = now();
      passes++;
    },
    endPass() {
      passStartedAt = null;
      lastEndedAt = now();
      wedgeReported = false;
    },
    // Called on a timer independent of the pass itself. Returns what it decided
    // so the test (and a curious reader) can see the state it acted on.
    check() {
      const t = now();
      const running = passStartedAt != null;
      const elapsedMs = running ? t - passStartedAt : 0;
      if (running && elapsedMs >= wedgeMs && !wedgeReported) {
        wedgeReported = true; // fire once — the handler is expected to exit
        onWedge?.({ elapsedMs, passes });
        return { wedged: true, elapsedMs };
      }
      if (t - lastHeartbeatAt >= heartbeatMs) {
        lastHeartbeatAt = t;
        onHeartbeat?.({
          running,
          elapsedMs,
          idleMs: running ? 0 : t - lastEndedAt,
          passes,
        });
        return { heartbeat: true, running };
      }
      return { ok: true };
    },
  };
}
