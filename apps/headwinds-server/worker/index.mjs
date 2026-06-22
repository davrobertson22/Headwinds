// Headwinds worker — the background service (separate from the API).
//
//   npm run -w @headwinds/server worker
//
// Phase 1: runs the staggered world spawner on an interval so there's always a
// fresh world to join. Phase 2: the authoritative per-world weekly tick is added
// here too — keeping all scheduled work in one service, separate from the API
// (so a slow tick never blocks player requests).
import { env } from '../src/env.mjs';
import { prisma } from '../src/db.mjs';
import { ensureWorldPool } from './spawner.mjs';

const log = console;
const INTERVAL_MS = env.spawnIntervalMinutes * 60 * 1000;

let running = false; // simple in-process lock so overlapping runs can't double up

async function runOnce() {
  if (running) return;
  running = true;
  try {
    await ensureWorldPool(prisma, {
      targetOpen: env.spawnTargetOpenWorlds,
      youngThresholdHours: env.spawnYoungThresholdHours,
      log,
    });
  } catch (err) {
    log.error('[worker] spawner error:', err);
  } finally {
    running = false;
  }
}

log.info(
  `[worker] starting — spawner every ${env.spawnIntervalMinutes} min, ` +
  `target ${env.spawnTargetOpenWorlds} young worlds`
);

await runOnce(); // run immediately on boot
const timer = setInterval(runOnce, INTERVAL_MS);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    clearInterval(timer);
    await prisma.$disconnect();
    process.exit(0);
  });
}
