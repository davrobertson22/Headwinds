// Headwinds worker — the background service (separate from the API).
//
//   npm run -w @headwinds/server worker
//
// Two scheduled jobs, both here so a slow tick never blocks player requests:
//   1. The staggered world SPAWNER (Phase 1) — keeps fresh worlds joinable.
//   2. The authoritative weekly TICK (Phase 2) — advances every RUNNING world
//      on its pace schedule by running the shared engine reducer server-side.
import { env } from '../src/env.mjs';
import { prisma } from '../src/db.mjs';
import { ensureWorldPool } from './spawner.mjs';
import { runDueTicks } from '../src/lib/tickService.mjs';

const log = console;
const SPAWN_INTERVAL_MS = env.spawnIntervalMinutes * 60 * 1000;
const TICK_CHECK_MS = env.tickCheckSeconds * 1000;

// Simple in-process locks so overlapping runs can't double up.
let spawning = false;
let ticking = false;

async function spawnOnce() {
  if (spawning) return;
  spawning = true;
  try {
    await ensureWorldPool(prisma, {
      targetOpen: env.spawnTargetOpenWorlds,
      youngThresholdHours: env.spawnYoungThresholdHours,
      log,
    });
  } catch (err) {
    log.error('[worker] spawner error:', err);
  } finally {
    spawning = false;
  }
}

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
  `[worker] starting — spawner every ${env.spawnIntervalMinutes} min ` +
  `(target ${env.spawnTargetOpenWorlds} young worlds); ` +
  `tick check every ${env.tickCheckSeconds}s (catch-up cap ${env.tickMaxCatchUp})`
);

await spawnOnce(); // run immediately on boot
await tickOnce();
const spawnTimer = setInterval(spawnOnce, SPAWN_INTERVAL_MS);
const tickTimer = setInterval(tickOnce, TICK_CHECK_MS);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    clearInterval(spawnTimer);
    clearInterval(tickTimer);
    await prisma.$disconnect();
    process.exit(0);
  });
}
