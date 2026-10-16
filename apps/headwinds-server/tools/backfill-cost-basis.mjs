// One-off backfill: stamp `costBasis` onto used-market frames bought BEFORE the
// engine started recording it.
//
//   node tools/backfill-cost-basis.mjs                       dry run, every world
//   node tools/backfill-cost-basis.mjs --world "heavy"       dry run, one world
//   node tools/backfill-cost-basis.mjs --airline qantas      dry run, one airline
//   node tools/backfill-cost-basis.mjs --verbose             list every match
//   node tools/backfill-cost-basis.mjs --write               apply (HIGH matches only)
//   node tools/backfill-cost-basis.mjs --write --medium      apply HIGH and MEDIUM
//
// Written 2026-10-15 alongside tools/used-cost-basis-test.mjs. The reducer now
// records what was paid on every BUY_USED_AIRCRAFT; this reaches back and does
// the same for frames already in fleets, so the cap on collateral, resale and
// write-off payouts applies to them too. Nothing else is touched: cash, loans,
// standings and the frames themselves are unchanged.
//
// ── Matching ─────────────────────────────────────────────────────────────────
// A delivered tail carries no listing id, so each SOLD listing with a buyerId
// is matched to one of that airline's owned, unstamped tails of the same type:
//   • name      — delivery copies the snapshot's name, so unless the player
//                 renamed it the tail is still called "Airbus A380 #25".
//   • config    — cabin layout, unless reconfigured since.
//   • engine / wingtips / wifi — fixed at build, never change.
//   • age       — the snapshot's age is frozen while listed; a tail must be at
//                 least that old, and at most that plus 1.25× the weeks since
//                 the sale (the tick ages a frame by max(0.5, 1 + (1 − maint
//                 budget) × 0.5) a week, so 1.25 is the floor-budget ceiling).
// Listings are walked latest-first (a frame bought, sold on and bought back
// matches the later, cheaper sale). HIGH = name + config + engine all agree
// inside the age window. MEDIUM = engine + config, or name alone, inside the
// window. Anything less is left unstamped and reported. Unmatched listings
// are expected — most are frames the airline has since sold on.
//
// Pending used orders (bought, not yet delivered) are stamped exactly from
// their own totalPrice; no matching needed.
//
// ── Writing ──────────────────────────────────────────────────────────────────
// Version-guarded: each blob write is `updateMany WHERE id AND version` with
// version incremented, exactly like a decision, so a tick or a player move
// landing first loses nothing — the airline is re-read and re-matched, up to
// three times. Only ACTIVE airlines are written; a failed or abandoned blob is
// never read again.
import { prisma } from '../src/db.mjs';
import { getAircraftType } from '@tailwinds/engine/data/aircraft.js';
import { airframeNAV } from '@tailwinds/engine/data/maintenance.js';

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const argAt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const WRITE    = flag('--write');
const MEDIUM   = flag('--medium');
const VERBOSE  = flag('--verbose');
const worldQ   = (argAt('--world') ?? '').toLowerCase();
const airlineQ = (argAt('--airline') ?? '').toLowerCase();

const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');
const yw    = (i) => `Y${Math.floor((i - 1) / 52) + 1}W${((i - 1) % 52) + 1}`;
const typeName = (id) => getAircraftType(id)?.name ?? id;
const sameConfig = (a, b) => {
  const ka = ['firstClass', 'businessClass', 'premiumEconomy', 'economy', 'seatQuality'];
  return ka.every((k) => (a?.[k] ?? null) === (b?.[k] ?? null));
};
const hasBasis = (a) => Number.isFinite(Number(a?.costBasis)) && Number(a.costBasis) >= 0;

/** Score one tail against one listing. Returns { grade, score } or null. */
function grade(tail, listing, weeksSinceSale) {
  const s = listing.snapshot ?? {};
  if (tail.typeId !== listing.typeId) return null;
  const ageDelta = Number(tail.ageWeeks ?? 0) - Number(s.ageWeeks ?? 0);
  // At least as old as when listed; aged no more than the fastest the tick can
  // age a frame (1.25/week on the minimum maintenance budget) since the sale.
  if (ageDelta < -0.01 || ageDelta > weeksSinceSale * 1.25 + 1.5) return null;
  const name   = !!s.name && tail.name === s.name;
  const config = sameConfig(tail.config, s.config);
  const engine = (tail.engineId ?? null) === (s.engineId ?? null)
              && !!tail.hasWingtips === !!s.hasWingtips
              && !!tail.hasWifi === !!s.hasWifi;
  if (!engine && !name) return null;
  const score = (name ? 4 : 0) + (config ? 2 : 0) + (engine ? 1 : 0)
              // Prefer the tail whose age is closest to "listed age + weeks flown".
              - Math.min(1, Math.abs(ageDelta - weeksSinceSale * 0.9) / Math.max(1, weeksSinceSale));
  const g = (name && config && engine) ? 'HIGH'
          : ((engine && config) || name) ? 'MEDIUM'
          : null;
  return g ? { grade: g, score } : null;
}

/** Match every sold listing this airline bought to its tails. Pure. */
function matchAirline(airline, listings, weekOf, nowWeek) {
  const state  = airline.state ?? {};
  const fleet  = (state.fleet ?? []).filter((a) => a.ownershipType === 'owned' && a.status !== 'retired' && !hasBasis(a));
  const taken  = new Set();
  const matches = [];
  const unmatched = [];
  // Latest sale first: a frame bought, sold on and bought back takes the later basis.
  const sorted = [...listings].sort((x, y) => (y.soldAt?.getTime() ?? 0) - (x.soldAt?.getTime() ?? 0));
  // Two passes so a looser match can never steal a tail from an exact one:
  // every listing gets its best HIGH candidate first, then the leftovers are
  // offered MEDIUM candidates among the tails still free.
  const placed = new Set();
  for (const want of ['HIGH', 'MEDIUM']) {
    for (const l of sorted) {
      if (placed.has(l.id)) continue;
      const soldWeek = l.soldAt ? weekOf(l.soldAt) : null;
      const weeksSince = soldWeek == null ? nowWeek - (l.listedWeek ?? nowWeek) : nowWeek - soldWeek;
      let best = null;
      for (const t of fleet) {
        if (taken.has(t.id)) continue;
        const g = grade(t, l, weeksSince);
        if (g && g.grade === want && (!best || g.score > best.score)) best = { ...g, tail: t };
      }
      if (best) {
        taken.add(best.tail.id); placed.add(l.id);
        matches.push({ listing: l, tail: best.tail, grade: best.grade, soldWeek });
      }
    }
  }
  for (const l of sorted) {
    if (!placed.has(l.id)) unmatched.push({ listing: l, soldWeek: l.soldAt ? weekOf(l.soldAt) : null });
  }
  const pending = (state.pendingOrders ?? []).filter((o) => o.used && !hasBasis(o) && Number.isFinite(Number(o.totalPrice)));
  return { matches, unmatched, pending, unstampedUsedTypes: fleet.filter((t) => !taken.has(t.id)) };
}

function applyMatches(state, matches, pending, grades) {
  const basisById = new Map(matches.filter((m) => grades.has(m.grade)).map((m) => [m.tail.id, m.listing.navPrice]));
  const pendIds   = new Set(pending.map((o) => o.id));
  return {
    ...state,
    fleet: (state.fleet ?? []).map((a) => basisById.has(a.id) ? { ...a, costBasis: basisById.get(a.id) } : a),
    pendingOrders: (state.pendingOrders ?? []).map((o) => pendIds.has(o.id) ? { ...o, costBasis: Math.round(Number(o.totalPrice)) } : o),
  };
}

// ── Run ──────────────────────────────────────────────────────────────────────
const worlds = (await prisma.world.findMany()).filter((w) => !worldQ || w.name.toLowerCase().includes(worldQ));
const grades = new Set(MEDIUM ? ['HIGH', 'MEDIUM'] : ['HIGH']);
console.log(`${WRITE ? 'WRITE' : 'DRY RUN'} — stamping ${[...grades].join(' + ')} matches${WRITE ? '' : ' (nothing is written)'}`);
let totals = { airlines: 0, high: 0, medium: 0, unmatched: 0, pending: 0, navMatched: 0, basisMatched: 0, written: 0, bites: 0 };

for (const world of worlds) {
  const listings = await prisma.usedAircraftListing.findMany({ where: { worldId: world.id, status: 'SOLD', buyerId: { not: null } } });
  if (!listings.length) continue;
  const nowWeek = (world.currentYear - 1) * 52 + world.currentWeek;
  const minWeek = Math.min(...listings.map((l) => l.listedWeek ?? nowWeek));
  const ticks = await prisma.tickLog.findMany({
    where: { worldId: world.id, status: 'ok', week: { gte: minWeek - 1 } },
    orderBy: { week: 'asc' }, select: { week: true, finishedAt: true },
  });
  const weekOf = (t) => { const tk = ticks.find((x) => x.finishedAt && x.finishedAt > t); return tk ? tk.week : (ticks.at(-1)?.week ?? nowWeek); };
  const byBuyer = new Map();
  for (const l of listings) { if (!byBuyer.has(l.buyerId)) byBuyer.set(l.buyerId, []); byBuyer.get(l.buyerId).push(l); }

  const airlines = (await prisma.airline.findMany({
    where: { id: { in: [...byBuyer.keys()] } },
    include: { account: { select: { email: true } } },
  })).filter((a) => !airlineQ || `${a.name} ${a.account?.email ?? ''}`.toLowerCase().includes(airlineQ));
  if (!airlines.length) continue;

  console.log('\n' + '='.repeat(96));
  console.log(`world "${world.name}"  ${world.status}  now ${yw(nowWeek)}  —  ${listings.length} sold listings with a buyer`);

  for (const a0 of airlines) {
    let a = a0;
    let res = matchAirline(a, byBuyer.get(a.id) ?? [], weekOf, nowWeek);
    const high = res.matches.filter((m) => m.grade === 'HIGH'), med = res.matches.filter((m) => m.grade === 'MEDIUM');
    const stamping = res.matches.filter((m) => grades.has(m.grade));
    // Only the frames the cap actually bites on (bought below today's book —
    // in practice the estate buys). A frame bought at NAV has since depreciated
    // below its basis and is unaffected; it is stamped for consistency but not
    // counted here.
    const bites = stamping.filter((m) => m.listing.navPrice < airframeNAV(m.tail, getAircraftType(m.tail.typeId), nowWeek));
    const nav   = bites.reduce((s, m) => s + airframeNAV(m.tail, getAircraftType(m.tail.typeId), nowWeek), 0);
    const basis = bites.reduce((s, m) => s + m.listing.navPrice, 0);
    totals.airlines++; totals.high += high.length; totals.medium += med.length; totals.unmatched += res.unmatched.length;
    totals.pending += res.pending.length;

    totals.navMatched += nav; totals.basisMatched += basis; totals.bites += bites.length;
    console.log(`\n  ${a.name}  (${a.status}, ${a.account?.email ?? '?'})  bought ${(byBuyer.get(a.id) ?? []).length} used frames`);
    console.log(`    matched HIGH ${high.length}   MEDIUM ${med.length}   unmatched listings ${res.unmatched.length} (sold on / scrapped / pre-restart)   pending used orders ${res.pending.length}`);
    console.log(`    stamping ${stamping.length}; cap bites on ${bites.length}: book today ${money(nav)} → basis ${money(basis)}   (removes ${money((nav - basis) * 0.95)} of resale proceeds)`);
    // Unstamped tails of a type this airline bought used. Expect these to be
    // its factory deliveries of that type (tails − (ordered − pending)); anything
    // else is an estate frame the matcher could not place.
    const listedTypes = new Set((byBuyer.get(a.id) ?? []).map((l) => l.typeId));
    const leftover = res.unstampedUsedTypes.filter((t) => listedTypes.has(t.typeId));
    if (leftover.length) {
      const byType = new Map();
      for (const t of leftover) byType.set(t.typeId, (byType.get(t.typeId) ?? 0) + 1);
      console.log(`    unstamped tails of used-bought types (should equal factory deliveries): ${[...byType.entries()].map(([k, n]) => `${n}× ${typeName(k)}`).join(', ')}`);
    }
    if (VERBOSE) {
      for (const m of res.matches) {
        const s = m.listing.snapshot ?? {};
        console.log(`      ${m.grade.padEnd(6)} ${typeName(m.tail.typeId).padEnd(22)} "${m.tail.name}" age ${Number(m.tail.ageWeeks).toFixed(1).padStart(7)} ← listed "${s.name}" age ${Number(s.ageWeeks ?? 0).toFixed(1).padStart(7)} sold ${m.soldWeek ? yw(m.soldWeek) : '?'} from ${m.listing.origin ?? '?'}${m.listing.distressed ? ' (estate)' : ''}  basis ${money(m.listing.navPrice)}`);
      }
      for (const u of res.unmatched) {
        const s = u.listing.snapshot ?? {};
        console.log(`      ----   ${typeName(u.listing.typeId).padEnd(22)} "${s.name}" age ${Number(s.ageWeeks ?? 0).toFixed(1).padStart(7)} sold ${u.soldWeek ? yw(u.soldWeek) : '?'} from ${u.listing.origin ?? '?'}  ${money(u.listing.navPrice)}  — no tail`);
      }
    }

    if (!WRITE || a.status !== 'ACTIVE' || (stamping.length === 0 && res.pending.length === 0)) {
      if (WRITE && a.status !== 'ACTIVE') console.log(`    skipped: ${a.status}`);
      continue;
    }
    for (let attempt = 1; attempt <= 3; attempt++) {
      const next = applyMatches(a.state, res.matches, res.pending, grades);
      const r = await prisma.airline.updateMany({
        where: { id: a.id, version: a.version },
        data:  { state: next, version: { increment: 1 } },
      });
      if (r.count === 1) { totals.written++; console.log(`    written (version ${a.version} → ${a.version + 1})`); break; }
      a = await prisma.airline.findUnique({ where: { id: a.id }, include: { account: { select: { email: true } } } });
      res = matchAirline(a, byBuyer.get(a.id) ?? [], weekOf, nowWeek);
      console.log(`    version moved under us, re-matched (attempt ${attempt})`);
      if (attempt === 3) console.log('    GAVE UP on this airline — run again.');
    }
  }
}

console.log('\n' + '='.repeat(96));
console.log(`${totals.airlines} airlines   HIGH ${totals.high}   MEDIUM ${totals.medium}   unmatched listings ${totals.unmatched}   pending ${totals.pending}`);
console.log(`cap bites on ${totals.bites} frames: book ${money(totals.navMatched)} → basis ${money(totals.basisMatched)}, removing ${money((totals.navMatched - totals.basisMatched) * 0.95)} of resale proceeds${WRITE ? `   written ${totals.written} airlines` : ''}`);
await prisma.$disconnect();
