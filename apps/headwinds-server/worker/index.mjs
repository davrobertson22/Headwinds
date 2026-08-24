// Headwinds worker — the background service (separate from the API).
//
//   npm run -w @headwinds/server worker
//
// One scheduled job, here so a slow tick never blocks player requests:
// the authoritative weekly TICK — advances every RUNNING world on its pace
// schedule by running the shared engine reducer server-side.
//
// (The auto world spawner was removed 2026-07-19 — world supply is now
// admin-only, via the "+ Create a world" button / POST /worlds.)
import { env } from '../src/env.mjs';
import { prisma } from '../src/db.mjs';
import { runDueTicks } from '../src/lib/tickService.mjs';
import { createTickGuard } from '../src/lib/tickGuard.mjs';

const log = console;
const TICK_CHECK_MS = env.tickCheckSeconds * 1000;

// Simple in-process lock so overlapping runs can't double up.
let ticking = false;

// Watchdog: a pass that hangs forever (a query on a half-dead pooled connection
// never times out client-side) would leave `ticking` true and silence the worker
// for good — 2026-08-23 this cost 17.5h of ticks. If a pass overruns the wedge
// budget, exit(1) so the platform restarts a clean process; the in-flight week
// rolls back and re-runs (CAS-idempotent). Heartbeat keeps the log visibly alive.
const guard = createTickGuard({
  wedgeMs: env.tickWedgeMinutes * 60_000,
  onWedge: ({ elapsedMs }) => {
    log.error(
      `[worker] WEDGED: tick pass still running after ${Math.round(elapsedMs / 1000)}s ` +
      `(limit ${env.tickWedgeMinutes}m) — exiting for a platform restart; ` +
      'the in-flight week rolls back and is re-run.'
    );
    process.exit(1);
  },
  onHeartbeat: ({ running, elapsedMs, idleMs, passes }) => {
    log.info(
      '[worker] alive — ' +
      (running ? `pass running ${Math.round(elapsedMs / 1000)}s` : `idle ${Math.round(idleMs / 1000)}s since last pass`) +
      ` (${passes} pass(es) so far)`
    );
  },
});

async function tickOnce() {
  if (ticking) return;
  ticking = true;
  guard.beginPass();
  try {
    const { ticked } = await runDueTicks(prisma, { maxCatchUp: env.tickMaxCatchUp, log });
    if (ticked > 0) log.info(`[worker] advanced ${ticked} world-week(s)`);
  } catch (err) {
    log.error('[worker] tick error:', err);
  } finally {
    guard.endPass();
    ticking = false;
  }
}

log.info(
  `[worker] starting — tick check every ${env.tickCheckSeconds}s ` +
  `(catch-up cap ${env.tickMaxCatchUp}); world creation is admin-only (no spawner)`
);

await tickOnce(); // run immediately on boot
const tickTimer = setInterval(tickOnce, TICK_CHECK_MS);
const watchdogTimer = setInterval(() => guard.check(), 30_000);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    clearInterval(tickTimer);
    clearInterval(watchdogTimer);
    await prisma.$disconnect();
    process.exit(0);
  });
}
