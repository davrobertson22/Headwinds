// @not-a-test — prints a report.
// Peak hours: how the automatic timetable scores by the tables in
// models/peakHours.js, for tuning them. (The game measures every timetable
// against the automatic one, so these figures are never charged; they show
// how much room the tables leave a player to beat it.) Generates a few hundred
// airlines of different shapes (hub and spoke with and without banks,
// regional, short haul, long haul), builds their automatic weeks in a
// peak-hour game and averages the tables over every flight and landing.
// Also exports genAirline for tools/peak-hours-test.mjs.
//
//   node tools/peak-hours-calibrate.mjs [airlines=300]

const { AIRPORTS } = await import('../packages/engine/src/data/airports.js');
const { getAircraftType } = await import('../packages/engine/src/data/aircraft.js');
const { airlineWeeks } = await import('../packages/engine/src/models/schedule.js');
const { distanceKm, maxFrequency } = await import('../packages/engine/src/utils/simulation.js');
const PH = await import('../packages/engine/src/models/peakHours.js');

export const SHAPES = [
  { name: 'regional',   types: ['atr72', 'e175'],               km: [250, 1200] },
  { name: 'short haul', types: ['a320neo', 'b737800'],          km: [400, 2500] },
  { name: 'medium',     types: ['a321neo', 'b737800'],          km: [1500, 4500] },
  { name: 'long haul',  types: ['b7879', 'a350900'],            km: [5000, 12000] },
];
const HUBS = AIRPORTS.filter(a => a.tier === 'mega').map(a => a.code);

/** Seeded generator (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** One generated airline in a peak-hour game. */
export function genAirline(seed, { banks = true, cap = 100 } = {}) {
  const r = rng(seed);
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const hub = pick(HUBS);
  const H = AIRPORTS.find(a => a.code === hub);
  const fleet = [], routes = [];
  const nTails = 3 + Math.floor(r() * 10);
  for (let i = 0; i < nTails; i++) {
    const shape = pick(SHAPES);
    const type = getAircraftType(pick(shape.types));
    const cands = AIRPORTS.filter(a => a.code !== hub && a.tier !== undefined && (() => {
      const d = distanceKm(H, a); return d >= shape.km[0] && d <= shape.km[1];
    })());
    if (!cands.length || !type) continue;
    const acId = `ac${i}`;
    fleet.push({ id: acId, typeId: type.id, status: 'assigned', config: { economy: type.seats } });
    // One to three routes on the tail, sharing its block hours.
    const nR = 1 + Math.floor(r() * 3);
    let left = cap * 0.95;
    for (let j = 0; j < nR; j++) {
      const dest = pick(cands);
      const km = distanceKm(H, dest);
      const fmax = Math.floor(maxFrequency(km, type, left));
      if (fmax < 1) break;
      const f = Math.max(1, Math.min(fmax, Math.round((0.5 + r() * 0.5) * fmax / (nR - j))));
      const blk = (km / (type.cruiseKmh ?? 800) + 1.2) * 2 * f;
      left -= blk;
      routes.push({ id: `r${i}-${j}`, origin: hub, destination: dest.code, stops: [hub, dest.code],
        aircraftId: acId, weeklyFrequency: f });
    }
  }
  return {
    fleet, routes, cargoRoutes: [], charters: [], peakHours: true,
    ...(banks ? { hubBanksWorld: true, hubs: { [hub]: { tier: 1 + Math.floor(r() * 3) } } } : { hubs: { [hub]: { tier: 2 } } }),
  };
}

import { fileURLToPath } from 'node:url';
const isMain = fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const N = Number(process.argv[2]) || 300;
  const acc = { b: 0, l: 0, n: 0, slot: { mega: [0, 0], major: [0, 0] } };
  const byShape = {};
  for (let s = 1; s <= N; s++) {
    const st = genAirline(s, { banks: s % 10 < 7 });
    const weeks = airlineWeeks(st, 6);
    for (const [acId, w] of weeks) {
      const type = getAircraftType(st.fleet.find(a => a.id === acId).typeId);
      for (const b of w.blocks) {
        let t = b.start;
        for (const l of b.legs) {
          const dep = PH.localTod(l.from, t), arr = PH.localTod(l.to, t + l.flightMin);
          const ap = PH.flightAppeal(dep, arr, l.flightMin);
          acc.b += ap.business; acc.l += ap.leisure; acc.n++;
          const k = type.category;
          (byShape[k] ??= { b: 0, l: 0, n: 0 });
          byShape[k].b += ap.business; byShape[k].l += ap.leisure; byShape[k].n++;
          const tier = AIRPORTS.find(a => a.code === l.to)?.tier;
          if (acc.slot[tier]) { acc.slot[tier][0] += PH.slotBand(tier, arr); acc.slot[tier][1]++; }
          t += l.flightMin + l.turnMin;
        }
      }
    }
  }
  const f = (x) => x.toFixed(4);
  console.log(`flights ${acc.n}`);
  console.log(`raw business ${f(acc.b / acc.n)}  leisure ${f(acc.l / acc.n)}`);
  for (const [k, v] of Object.entries(byShape)) console.log(`  ${k.padEnd(14)} business ${f(v.b / v.n)}  leisure ${f(v.l / v.n)}  (${v.n})`);
  for (const t of ['mega', 'major']) console.log(`slot ${t} ${f(acc.slot[t][0] / acc.slot[t][1])} (${acc.slot[t][1]})`);
}
