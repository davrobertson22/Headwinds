// Route Finders: how much of a market is already flown, and freight parity.
//
// Two Discord asks, same player (VodkaOnFire, 2026-10-21):
//
//   "Add a %-full on the route finder — Simple; next to estimated load (or
//    market), add a 0-x% digit to tell you how much of the demand is satisfied
//    already. Saves you having to check every individual route and recalculate
//    every time you do."
//
//   "Freight route finder gets same features as PAX route finder —
//      · When in route selection, can't see which planes you have idle.
//      · When in route finder, can't see/toggle routes already flown.
//      · Add the same 0-x% demand satisfied as requested on PAX route finder."
//
// This suite pins:
//   1. laneServed IS the tick's share fight (pairMarketShare), divided by the
//      market — not a seat count — run from your own pair so a metro lane you
//      fly from the sibling airport counts, and read at maturity.
//   2. "Most demand left" (rankByDemandLeft) ranks exactly like pricing every
//      row would, while pricing only as many as the page needs.
//   3. cargoLaneServed is the freight table's own tonnage (cargoLaneAllocations
//      + simulateCargoRoute), and a rival's published freighter capacity counts.
//   4. SSR: the passenger finder shows a Served column and the new sort.
//   5. SSR: the freight finder lists YOUR freighters first with idle counts,
//      can show lanes you already fly, and has the Served column.
//   6. SSR: the freight planner's picker puts your freighters first, says how
//      many are idle, and defaults to one you own rather than the catalogue's
//      first entry.
//
// Verified failing on HEAD: laneServed / cargoLaneServed / rankByDemandLeft do
// not exist there (sections 1-3 cannot import), and the HEAD components were
// rendered against these fixtures in a throwaway copy — no "Served" header in
// either finder, no "In your fleet" group or idle count in the freight finder
// or the freight planner, no "Show lanes I already serve", and the planner
// defaulted to the catalogue's first reachable freighter.
//
// Ported from Tailwinds. Headwinds' freight finder also hides lanes the chosen
// freighter cannot legally fly (laneBlockFor) — untouched here.
//
//   node --import ./tools/_register-loader.mjs tools/route-finder-served-test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import React from 'react';
import { renderToString } from 'react-dom/server';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (f) => readFileSync(join(ROOT, 'src', f), 'utf8');

const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.window.matchMedia = globalThis.window.matchMedia ?? (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
globalThis.matchMedia = globalThis.window.matchMedia;
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
globalThis.document = globalThis.document ?? { addEventListener() {}, removeEventListener() {}, querySelector() { return null; } };

const { AIRCRAFT_TYPES, getAircraftType } = await import('../src/data/aircraft.js');
const { AIRPORTS, getAirport } = await import('../src/data/airports.js');
const { referencePrice, simulateCargoRoute, cargoLaneAllocations, currentGameDate } = await import('../src/utils/simulation.js');
const { cargoCityPairDemand, cargoReferenceYield } = await import('../src/utils/market.js');
const { pairMarketShare } = await import('../src/models/pairShare.js');
const {
  findCandidates, laneServed, cargoLaneServed, rankByDemandLeft, demandLeftOf, SORTS,
} = await import('../src/models/routeFinder.js');
const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const RouteFinder       = (await import('../src/components/RouteFinder.jsx')).default;
const CargoRouteFinder  = (await import('../src/components/CargoRouteFinder.jsx')).default;
const CargoRoutePlanner = (await import('../src/components/CargoRoutePlanner.jsx')).default;
const { rememberFinder, finderMemoryKey, clearFinderMemory } = await import('../src/utils/finderMemory.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}

console.log('\nRoute Finders — how much of a market is already flown, and freight parity\n');

// ── Fixtures ─────────────────────────────────────────────────────────────────
const HUB = 'JFK';
const jet = AIRCRAFT_TYPES
  .filter((t) => !t.freighter && t.range >= 6000 && t.seats >= 250 && (t.ticketPremium ?? 1) === 1)
  .sort((a, b) => b.range - a.range)[0];
assert.ok(jet, 'fixture needs a long-haul widebody');
// Two freighter types, so "owned first" is distinguishable from catalogue order.
const freighters = AIRCRAFT_TYPES.filter((t) => t.freighter && t.range >= 7000);
const catalogueFirst = freighters[0];
const ownedFreighter = freighters[freighters.length - 1];
assert.ok(catalogueFirst && ownedFreighter && catalogueFirst.id !== ownedFreighter.id, 'fixture needs two long-range freighter types');
const CARGO_DEST = 'FRA';
assert.ok(getAirport(CARGO_DEST) && cargoCityPairDemand(HUB, CARGO_DEST, 6) > 0, 'fixture cargo lane has no demand');

const mkAc = (id, typeId, extra = {}) => ({
  id, typeId, name: id, tailNumber: id.toUpperCase(), status: 'idle', ownershipType: 'owned',
  ageWeeks: 40, config: getAircraftType(typeId).freighter ? undefined : { economy: getAircraftType(typeId).seats }, ...extra,
});
const mkRoute = (id, o, d, aircraftId, freq = 7, weeksOpen = 60) => ({
  id, origin: o, destination: d, stops: [o, d], aircraftId, weeklyFrequency: freq, weeksOpen,
  hub: HUB, ticketPrice: Math.round(referencePrice(o, d)),
  classPrices: { economy: Math.round(referencePrice(o, d)) },
});
const rival = (routes) => ({
  id: 'rv', name: 'Rival Air', tier: 'legacy', baseQualityScore: 62, homeHub: 'LHR', routes,
});

function world({ routes = [], competitors = [], fleet = [mkAc('spare', jet.id)], cargoRoutes = [] } = {}) {
  const gates = {};
  for (const a of AIRPORTS) gates[a.code] = 20;
  return {
    week: 60, absWeek: 60, year: 2, hub: HUB, hubs: {}, cash: 5e8,
    fleet, routes, cargoRoutes, competitors, humanRivals: {}, encroachments: {},
    gates, routePricing: {}, gameDate: { week: 60, month: 6, absWeek: 60 },
  };
}
const GD = { week: 60, month: 6, absWeek: 60 };
const rowFor = (state, code, opts = {}) =>
  findCandidates(state, { origin: HUB, hideServedLanes: false, hideUnflyable: false, ...opts })
    .find((r) => r.code === code || r.altCodes.includes(code));

// ── 1. laneServed ────────────────────────────────────────────────────────────
console.log('── 1. "how much of the demand is satisfied already" ─────────');

test('an unflown lane is 0% served, with the market as its pool', () => {
  const st = world();
  const r = rowFor(st, 'LHR');
  const s = laneServed(st, r, { gameDate: GD });
  assert.ok(s && s.pool > 0, 'no pool');
  assert.equal(s.pax, 0);
  assert.equal(s.share, 0);
});

test("a rival's lane is the tick's share fight, divided by the market", () => {
  const st = world({ competitors: [rival({ 'JFK-LHR': { frequency: 14, aircraftType: jet.id, priceMultiplier: 1 } })] });
  const r = rowFor(st, 'LHR');
  const s = laneServed(st, r, { gameDate: GD });
  const ms = pairMarketShare(st, r.origin, r.code, { gameDate: GD, weeksOpen: 52 });
  const pool = ms.market.leisureDemand + ms.market.businessDemand;
  assert.equal(s.pax, Math.round(ms.totalPax));
  assert.equal(s.pool, pool);
  assert.ok(s.share > 0.05, `rival carries almost nothing: ${s.share}`);
  assert.equal(s.yourPax, 0);
  assert.equal(s.rivalPax, s.pax);
});

test('it is not a seat count: a half-empty rival is not "full"', () => {
  // 14 widebody flights a week is far more seats than this lane's market, yet
  // the share fight hands the rival only the travellers who choose it.
  const st = world({ competitors: [rival({ 'JFK-LHR': { frequency: 70, aircraftType: jet.id, priceMultiplier: 1.6 } })] });
  const r = rowFor(st, 'LHR');
  const s = laneServed(st, r, { gameDate: GD });
  const seats = 70 * jet.seats;
  assert.ok(seats > s.pool, 'fixture rival must offer more seats than the market');
  assert.ok(s.share < 0.95, `a pricey half-empty rival read as ${Math.round(s.share * 100)}% served`);
});

test('your own service from the sibling airport counts on the metro lane', () => {
  // You fly JFK-LHR; the finder row for the New York-London market sits at the
  // field the market prefers. Run from an empty sibling pair, the fight would
  // miss you entirely — so laneServed runs it from YOUR pair.
  const st = world({ fleet: [mkAc('ac0', jet.id, { status: 'assigned' })], routes: [mkRoute('r0', HUB, 'LHR', 'ac0')] });
  const r = { ...rowFor(st, 'LHR'), origin: 'EWR', code: 'LHR', yourLanePairs: ['JFK-LHR'] };
  const s = laneServed(st, r, { gameDate: GD });
  assert.ok(s.yourPax > 0 && s.yourShare > 0, 'your own JFK service is missing from the lane');
  const naive = laneServed(st, { ...r, yourLanePairs: [] }, { gameDate: GD });
  assert.equal(naive.yourPax, 0, 'fixture: from the empty sibling pair the fight does not see you');
});

test('read at maturity: a lane you opened last month is not "half served"', () => {
  const mk = (weeksOpen) => world({ fleet: [mkAc('ac0', jet.id, { status: 'assigned' })], routes: [mkRoute('r0', HUB, 'LHR', 'ac0', 7, weeksOpen)] });
  const young = mk(2), old = mk(80);
  const a = laneServed(young, rowFor(young, 'LHR'), { gameDate: GD });
  const b = laneServed(old, rowFor(old, 'LHR'), { gameDate: GD });
  assert.equal(a.pax, b.pax);
  assert.equal(a.pool, b.pool);
});

// ── 2. "Most demand left" ────────────────────────────────────────────────────
console.log('\n── 2. "Most demand left" prices only what the page needs ──');

{
  // Rivals on the three biggest lanes out of JFK.
  const base = world();
  const big = findCandidates(base, { origin: HUB }).sort((x, y) => y.demand - x.demand).slice(0, 3);
  const routes = Object.fromEntries(big.map((r) => [[r.origin, r.code].sort().join('-'), { frequency: 42, aircraftType: jet.id, priceMultiplier: 0.8 }]));
  const st = world({ competitors: [rival(routes)] });
  const rows = findCandidates(st, { origin: HUB });

  test('the ranking matches pricing every row and sorting', () => {
    const brute = rows.map((r) => ({ r, left: demandLeftOf(r, laneServed(st, r, { gameDate: GD })) }))
      .sort((x, y) => y.left - x.left || y.r.demand - x.r.demand)
      .slice(0, 25).map((x) => x.r.code);
    const fast = rankByDemandLeft(rows, (r) => laneServed(st, r, { gameDate: GD }), 25).slice(0, 25).map((r) => r.code);
    assert.deepEqual(fast, brute);
  });

  test('it prices a page, not the world', () => {
    let calls = 0;
    rankByDemandLeft(rows, (r) => { calls++; return laneServed(st, r, { gameDate: GD }); }, 25);
    assert.ok(rows.length > 500, 'fixture: expected a full search');
    assert.ok(calls < 60, `priced ${calls} of ${rows.length} rows for a 25-row page`);
  });

  test('a lane rivals already carry falls below a smaller one nobody flies', () => {
    const ranked = rankByDemandLeft(rows, (r) => laneServed(st, r, { gameDate: GD }), 25);
    const top = big[0].code;
    const at = ranked.findIndex((r) => r.code === top);
    assert.ok(at > 0, `the biggest (rival-flown) lane still ranks first by demand left`);
    assert.ok(ranked[at].demandLeft < ranked[at].demand);
  });

  test('the sort is offered', () => {
    assert.equal(SORTS.room?.label, 'Most demand left');
  });
}

// ── 3. cargoLaneServed ───────────────────────────────────────────────────────
console.log('\n── 3. Freight: the freight table\'s own tonnage ──────────────');

test('an unflown freight lane is 0% served', () => {
  const s = cargoLaneServed(world(), HUB, CARGO_DEST, { gameDate: GD });
  assert.ok(s.pool > 0);
  assert.equal(s.tonnes, 0);
  assert.equal(s.share, 0);
});

test('your freighter counts at exactly the freight table\'s figure', () => {
  const f = mkAc('fx', ownedFreighter.id, { status: 'assigned' });
  const cr = { id: 'c0', origin: HUB, destination: CARGO_DEST, aircraftId: 'fx', weeklyFrequency: 3, weeksOpen: 60, cargo: true, yieldPrice: cargoReferenceYield(HUB, CARGO_DEST) };
  const st = world({ fleet: [f], cargoRoutes: [cr] });
  const s = cargoLaneServed(st, HUB, CARGO_DEST, { gameDate: GD });
  const alloc = cargoLaneAllocations([{ ...cr, weeksOpen: null }], st.fleet, 1.0, { gameDate: GD, competitors: [] });
  const sim = simulateCargoRoute({ ...cr, weeksOpen: null }, f, GD, null, 1.0, 1.0, alloc.get('c0') ?? null);
  assert.ok(sim.tonnes > 0, 'fixture freighter carries nothing');
  assert.equal(s.yourTonnes, sim.tonnes);
  assert.equal(s.share, s.tonnes / s.pool);
});

test("a rival's published freighter capacity counts, never more than it lifts", () => {
  const st = world({ competitors: [{ id: 'cx', name: 'Cargo Rival', routes: {}, cargoRoutes: { [[HUB, CARGO_DEST].sort().join('-')]: { tonnesPerWeek: 300, yieldPrice: cargoReferenceYield(HUB, CARGO_DEST) } } }] });
  const s = cargoLaneServed(st, HUB, CARGO_DEST, { gameDate: GD });
  assert.ok(s.rivalTonnes > 0 && s.rivalTonnes <= 300, `rival tonnes ${s.rivalTonnes}`);
  assert.equal(s.yourTonnes, 0);
});

// ── 4-6. Rendered ────────────────────────────────────────────────────────────
console.log('\n── 4. The passenger finder shows it ─────────────────────────');

const SAVE = {
  ...freshState(),
  phase: 'playing', week: 60, year: 2, hub: HUB, cash: 500_000_000,
  hubs: { [HUB]: { tier: 2, tierSince: 1 } },
  gates: { JFK: 20, LHR: 20, FRA: 20 },
  competitors: [rival({ 'JFK-LHR': { frequency: 14, aircraftType: jet.id, priceMultiplier: 1 } })],
  encroachments: {},
  fleet: [
    mkAc('spare', jet.id),
    mkAc('fx1', ownedFreighter.id, { status: 'assigned' }),
    mkAc('fx2', ownedFreighter.id),
  ],
  routes: [],
  cargoRoutes: [{ id: 'c0', origin: HUB, destination: CARGO_DEST, aircraftId: 'fx1', weeklyFrequency: 3, weeksOpen: 60, cargo: true, hub: HUB, yieldPrice: cargoReferenceYield(HUB, CARGO_DEST) }],
};
const render = (el) => {
  store.set('bbae_save_v2', JSON.stringify(SAVE));
  return renderToString(React.createElement(GameProvider, null, el)).replace(/<!-- -->/g, '');
};

{
  clearFinderMemory();
  const html = render(React.createElement(RouteFinder, { standalone: true }));
  test('a Served column sits next to the market', () => {
    const iMarket = html.indexOf('>Market<');
    const iServed = html.indexOf('>Served<');
    const iFare   = html.indexOf('>Ref fare<');
    assert.ok(iMarket > 0 && iServed > iMarket && iFare > iServed, 'Served is missing or out of place');
  });
  test('rows carry a figure, and the rival lane reads above zero', () => {
    const cells = [...html.matchAll(/data-served="(\d+)"/g)].map((m) => Number(m[1]));
    assert.ok(cells.length >= 10, `only ${cells.length} served cells`);
    assert.ok(cells.some((v) => v > 0), 'no lane reads as flown — the rival on JFK-LHR is missing');
  });
  test('"Most demand left" is in the sort list', () => {
    assert.ok(html.includes('Most demand left'));
  });
}

console.log('\n── 5. The freight finder catches up ─────────────────────────');

{
  clearFinderMemory();
  const html = render(React.createElement(CargoRouteFinder, { standalone: true }));
  const select = html.slice(html.indexOf('Any freighter'), html.indexOf('</select>', html.indexOf('Any freighter')));
  test('your freighters come first, with how many are idle', () => {
    const iFleet = select.indexOf('label="In your fleet"');
    const iCat   = select.indexOf('label="Not in your fleet"');
    assert.ok(iFleet >= 0 && iCat > iFleet, 'no "In your fleet" group above the catalogue');
    assert.match(select, new RegExp(`${ownedFreighter.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} — 2 owned · 1 idle`));
  });
  test('a Served column and the new sort', () => {
    assert.ok(html.includes('>Served<'), 'no Served column');
    assert.ok(html.includes('Most demand left'));
  });
  test('lanes you fly are hidden by default, behind a toggle', () => {
    assert.ok(html.includes('Show lanes I already serve'), 'no toggle');
    assert.ok(!html.includes(`you fly ${HUB}–${CARGO_DEST}`), 'a flown lane showed with the toggle off');
  });
  test('…and shown, tagged and counted, with it on', () => {
    clearFinderMemory();
    rememberFinder(finderMemoryKey(SAVE, 'freight'), { showServed: true, minDist: '5000', maxDist: '7000' });
    const on = render(React.createElement(CargoRouteFinder, { standalone: true }));
    assert.ok(on.includes(`you fly ${HUB}–${CARGO_DEST}`), 'the flown lane is not tagged');
    const row = on.slice(on.indexOf(`you fly ${HUB}–${CARGO_DEST}`));
    const pct = Number(row.match(/data-served="(\d+)"/)?.[1]);
    assert.ok(pct > 0, 'your own freighter is not counted on its lane');
    clearFinderMemory();
  });
  test('the freighter rides along to the planner', () => {
    assert.ok(src('components/CargoRouteFinder.jsx').includes('onPick(origin, a.code, rangeTypeId || undefined)'));
    assert.ok(/if \(nav\.typeId\)[^\n]*setSelectedTypeId\(nav\.typeId\)/.test(src('components/CargoRoutePlanner.jsx')));
  });
}

console.log('\n── 6. The freight planner lists your freighters first ───────');

{
  const html = render(React.createElement(CargoRoutePlanner, { initialOrigin: HUB, initialDest: CARGO_DEST }));
  const sel = html.slice(html.indexOf('Freighter type'), html.indexOf('</select>', html.indexOf('Freighter type')));
  test('"In your fleet" before the catalogue, with the idle count', () => {
    const iFleet = sel.indexOf('label="In your fleet"');
    const iCat   = sel.indexOf('label="Not in your fleet"');
    assert.ok(iFleet >= 0 && iCat > iFleet, 'no fleet group above the catalogue');
    assert.match(sel, /· 1 idle/);
    assert.match(sel, /lease required/);
  });
  test('the default is a freighter you own, not the catalogue\'s first', () => {
    const picked = sel.match(/<option[^>]*value="([^"]+)"[^>]*selected/)?.[1];
    assert.equal(picked, ownedFreighter.id);
  });
}

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
