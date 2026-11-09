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
import { getHeapStatistics } from 'node:v8';
import { runDueTicks, TICK_TX_OPTS } from '../src/lib/tickService.mjs';
import { createTickGuard } from '../src/lib/tickGuard.mjs';
import { installProcessGuards } from '../src/lib/processGuard.mjs';

const log = console;
// Same Prisma tx-timer rejection that crashed the API 11 times on 2026-10-23
// (lib/processGuard.mjs). A crashed worker stops every world's clock.
installProcessGuards({ log, label: 'worker' });
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

// A pass stops picking new weeks after half the wedge budget, so a long but
// healthy catch-up ends on its own and the next pass starts straight away —
// rather than the watchdog killing it and the restart walking the same queue.
const PASS_BUDGET_MS = Math.max(60_000, Math.floor(env.tickWedgeMinutes * 60_000 / 2));

async function tickOnce() {
  if (ticking) return null;
  ticking = true;
  guard.beginPass();
  try {
    const res = await runDueTicks(prisma, { maxCatchUp: env.tickMaxCatchUp, log, budgetMs: PASS_BUDGET_MS });
    if (res.ticked > 0) log.info(`[worker] advanced ${res.ticked} world-week(s)`);
    return res;
  } catch (err) {
    log.error('[worker] tick error:', err);
    return null;
  } finally {
    guard.endPass();
    ticking = false;
  }
}

// Wake for the next week that comes due instead of polling every TICK_CHECK_MS:
// a world due at :00 used to wait up to a minute for the poll (players watch
// "next week landing…" the whole time). The poll interval stays the longest
// sleep, so worlds that failed or were capped are retried as before.
let tickTimer = null;
function scheduleNext(res) {
  let delay = TICK_CHECK_MS;
  if (res?.budgetExhausted) delay = 1_000;
  else if (res?.nextDueAt) {
    const until = new Date(res.nextDueAt).getTime() - Date.now() + 250;
    delay = Math.min(TICK_CHECK_MS, Math.max(1_000, until));
  }
  tickTimer = setTimeout(loop, delay);
}
async function loop() {
  scheduleNext(await tickOnce());
}

log.info(
  `[worker] starting — wakes at each due week (at most ${env.tickCheckSeconds}s apart, pass budget ${Math.round(PASS_BUDGET_MS / 1000)}s) ` +
  `(catch-up cap ${env.tickMaxCatchUp}); world creation is admin-only (no spawner)`
);
// So the logs show the limits this process actually runs under (TICK_TX_TIMEOUT_MS,
// NODE_OPTIONS=--max-old-space-size) — 2026-10-22's crash loop was both.
log.info(
  `[worker] week commit budget ${Math.round(TICK_TX_OPTS.timeout / 1000)}s; ` +
  `JS heap limit ${Math.round(getHeapStatistics().heap_size_limit / 1048576)} MB`
);

// The watchdog starts first so a boot pass that hangs is caught too.
const watchdogTimer = setInterval(() => guard.check(), 30_000);
await loop(); // run immediately on boot, then on the schedule above

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    clearTimeout(tickTimer);
    clearInterval(watchdogTimer);
    await prisma.$disconnect();
    process.exit(0);
  });
}
