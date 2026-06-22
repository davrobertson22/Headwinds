// Staggered world spawner (HEADWINDS_MULTIPLAYER_PLAN.md §3a).
//
// Keeps a pool of recently-started PUBLIC worlds available so a new player always
// has a fresh world to join (the fix for "newcomers join hopelessly behind").
// Runs in the WORKER service, separate from the API — and in Phase 2 the weekly
// tick joins it here.
import {
  createWorld,
} from '../src/lib/worldService.mjs';
import { LENGTH_YEARS, WEEKS_PER_DAY } from '../src/lib/worldConfig.mjs';

// The tier mix new worlds are drawn from. Weighted toward faster/shorter worlds
// so casual players get quick seasons; tune freely (it's config, not logic).
const TIER_MIX = [
  { lengthYears: 50, weeksPerDay: 48, weight: 4 }, // blitz: ~8 weeks real-time
  { lengthYears: 50, weeksPerDay: 24, weight: 3 }, // fast:  ~15 weeks
  { lengthYears: 100, weeksPerDay: 24, weight: 2 }, // long:  ~31 weeks
  { lengthYears: 100, weeksPerDay: 12, weight: 1 }, // casual: ~62 weeks
];

function pickTier() {
  const total = TIER_MIX.reduce((s, t) => s + t.weight, 0);
  let r = Math.random() * total;
  for (const t of TIER_MIX) {
    r -= t.weight;
    if (r <= 0) return t;
  }
  return TIER_MIX[0];
}

// Ensure at least `targetOpen` PUBLIC worlds started within `youngThresholdHours`
// exist; create new ones to top up. Idempotent — safe to run on any schedule.
export async function ensureWorldPool(prisma, {
  targetOpen = 4,
  youngThresholdHours = 48,
  log = console,
} = {}) {
  const cutoff = new Date(Date.now() - youngThresholdHours * 60 * 60 * 1000);

  const youngCount = await prisma.world.count({
    where: {
      visibility: 'PUBLIC',
      status: 'RUNNING',
      startedAt: { gte: cutoff },
    },
  });

  const toCreate = Math.max(0, targetOpen - youngCount);
  if (toCreate === 0) {
    log.info?.(`[spawner] pool healthy: ${youngCount}/${targetOpen} young worlds`);
    return { created: 0, youngCount };
  }

  const created = [];
  for (let i = 0; i < toCreate; i++) {
    const tier = pickTier();
    const world = await createWorld(prisma, {
      lengthYears: tier.lengthYears,
      weeksPerDay: tier.weeksPerDay,
      visibility: 'PUBLIC',
    });
    created.push(world);
    log.info?.(
      `[spawner] created "${world.name}" (${world.lengthYears}yr · ${world.weeksPerDay} wk/day)`
    );
  }
  return { created: created.length, youngCount: youngCount + created.length };
}

// Re-export for convenience / testing.
export { LENGTH_YEARS, WEEKS_PER_DAY };
