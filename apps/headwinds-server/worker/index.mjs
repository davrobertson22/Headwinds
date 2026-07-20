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

const log = console;
const TICK_CHECK_MS = env.tickCheckSeconds * 1000;

// Simple in-process lock so overlapping runs can't double up.
let ticking = false;

async function tickOnce() {
  if (ticking) return;
  ticking = true;
  try {
    const { ticked } = await runDueTicks(prisma, { maxCatchUp: env.tickMaxCatchUp, log });
    if (ticked > 0) log.info(`[worker] advanced ${ticked} world-week(s)`);
  } catch (err) {
    log.error('[worker] tick error:', err);
  } finally {
    ticking = false;
  }
}

log.info(
  `[worker] starting — tick check every ${env.tickCheckSeconds}s ` +
  `(catch-up cap ${env.tickMaxCatchUp}); world creation is admin-only (no spawner)`
);

await tickOnce(); // run immediately on boot
const tickTimer = setInterval(tickOnce, TICK_CHECK_MS);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    clearInterval(tickTimer);
    await prisma.$disconnect();
    process.exit(0);
  });
}
