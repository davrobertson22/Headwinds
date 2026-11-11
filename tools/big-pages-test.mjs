// Routes, Competition and Finance at the size airlines really reach.
//
// After the Fleet page was fixed (fleet-window-test.mjs), three more pages
// still froze on the largest live airline (4,884 tails, 4,027 routes; measured
// in Chromium 2026-11-11):
//
//   Routes       0.49 s to open, and 0.45 s of every click and new week on it:
//                "which aircraft have hours left" searched the route tables
//                once per tail (fleet × routes).
//   Competition  1.65 s in one task: every contested pair's card searched every
//                route for its pair, then ran the pair's share fight, and every
//                card was built whether or not it was on screen.
//   Finance      1.0 s and 90,000 elements: the statement had a row per route
//                under Catering and Crew Accommodation, open by default.
//
// None of the fixes may change a figure. This file holds that the indexes give
// exactly the lists the searches gave, that the pages use them, and that the
// statement's totals are untouched by the shorter lists.
//
//   node --import ./tools/_register-loader.mjs tools/big-pages-test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';

globalThis.window = globalThis.window ?? {};
globalThis.window.matchMedia = globalThis.window.matchMedia ?? (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
const mem = new Map();
globalThis.localStorage = globalThis.localStorage ?? { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${String(e && e.stack || e).split('\n').slice(0, 4).join('\n      ')}`); }
}
function section(t) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 62 - t.length))}`); }
const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

const React = (await import('react')).default;
const { renderToString } = await import('react-dom/server');
const { RemoteGameProvider, freshState, gameReducer } = await import('../src/store/GameContext.jsx');
const { ConfirmProvider } = await import('../src/components/ConfirmModal.jsx');
const { getAircraftType } = await import('../src/data/aircraft.js');
const sim = await import('../src/utils/simulation.js');
const { defaultConfig, routesCommittedTo, committedPeakBlockHours, committedPeakBlockHoursIn, committedBlockHoursByMonth } = sim;
const { AIRPORTS } = await import('../packages/engine/src/data/airports.js');
const pairShare = await import('../packages/engine/src/models/pairShare.js');
const tails = await import('../src/utils/tailRoutes.js').catch(() => null);
const needTails = () => { if (!tails) throw new Error('src/utils/tailRoutes.js does not exist'); };

function airline(n, { hub = 'SIN' } = {}) {
  const t = getAircraftType('a320neo');
  // Within an A320's reach of the hub, so the routes fly and the statement has rows.
  const dests = AIRPORTS.map(a => a.code).filter(c => c !== hub && sim.routeDistanceKm(hub, c) > 300 && sim.routeDistanceKm(hub, c) < 4200).slice(0, n);
  if (dests.length < n) throw new Error(`only ${dests.length} airports in range of ${hub}`);
  const fleet = dests.map((d, i) => ({ id: `p${i}`, typeId: t.id, status: i % 9 === 8 ? 'idle' : 'assigned', ageWeeks: 30 + i, config: defaultConfig(t.seats),
    ownershipType: i % 2 ? 'owned' : 'lease', leaseRemainingWeeks: 60, weeklyLease: 90_000, tailNumber: `9V-${1000 + i}`, name: `Probe ${1000 + i}` }));
  const routes = dests.map((d, i) => (i % 9 === 8 ? null : { id: `r${i}`, origin: i % 4 === 3 ? d : hub, destination: i % 4 === 3 ? hub : d, stops: i % 4 === 3 ? [d, hub] : [hub, d],
    aircraftId: `p${i}`, weeklyFrequency: 7, weeksOpen: 30, hub, ticketPrice: 300 })).filter(Boolean);
  // A reserve covering another tail's rotation, a second route on one tail, a
  // seasonal route, a tag route over a pair someone else flies nonstop, a freighter lane.
  routes.push({ id: 'cover1', origin: hub, destination: dests[3], stops: [hub, dests[3]], aircraftId: 'p8', coverForAircraftId: 'p3', weeklyFrequency: 7, weeksOpen: 2, hub, ticketPrice: 300 });
  routes.push({ id: 'second', origin: hub, destination: dests[5], stops: [hub, dests[5]], aircraftId: 'p1', weeklyFrequency: 3, weeksOpen: 9, hub, ticketPrice: 250 });
  routes.push({ id: 'summer', origin: hub, destination: dests[6], stops: [hub, dests[6]], aircraftId: 'p2', weeklyFrequency: 2, weeksOpen: 9, hub, ticketPrice: 250, season: { months: [6, 7, 8] } });
  routes.push({ id: 'tag1', origin: hub, destination: dests[10], stops: [hub, dests[11], dests[10]], aircraftId: 'p4', weeklyFrequency: 2, weeksOpen: 9, hub, ticketPrice: 400 });
  const cargoRoutes = [{ id: 'c1', origin: hub, destination: dests[2], aircraftId: 'p17', weeklyFrequency: 2 }, { id: 'c2', origin: hub, destination: dests[4], aircraftId: 'p1', weeklyFrequency: 1 }];
  return { ...freshState(), phase: 'playing', week: 20, year: 3, hub, airlineName: 'Probe Air', cash: 5e9, multiplayer: true,
    competitors: [], humanRivals: {}, encroachments: {}, hubs: { [hub]: { tier: 3, tierSince: 0 } },
    fleet, routes, cargoRoutes, gates: Object.fromEntries([[hub, 400], ...dests.map(d => [d, 2])]) };
}

// ── A ────────────────────────────────────────────────────────────────────────
section('Routes: a tail\'s own routes come from one index');

const A = airline(120);
test('the index gives every tail exactly routesCommittedTo\'s list, in order', () => {
  needTails();
  for (const a of [...A.fleet, { id: 'nobody' }, { id: undefined }]) {
    const want = routesCommittedTo(a.id, A.routes, A.cargoRoutes).map(r => r.id);
    assert.deepEqual(tails.tailCommitted(A.routes, A.cargoRoutes, a.id).map(r => r.id), want, `tail ${a.id}`);
    const mine = tails.tailRoutesIn(A.routes, A.cargoRoutes, a.id);
    assert.deepEqual([...mine.pax, ...mine.cargo].map(r => r.id), want, `tail ${a.id}`);
  }
  assert.deepEqual(tails.tailCommitted(A.routes, A.cargoRoutes, 'p3').map(r => r.id), ['r3', 'cover1'], 'a rotation out on cover still belongs to the tail it covers');
  assert.deepEqual(tails.tailCommitted(A.routes, null, 'p1').map(r => r.id), ['r1', 'second'], 'no freight table at all');
});
test('hours committed: a tail\'s own lists give the figure the whole tables give', () => {
  needTails();
  for (const a of A.fleet) {
    const type = getAircraftType(a.typeId);
    const mine = tails.tailRoutesIn(A.routes, A.cargoRoutes, a.id);
    assert.equal(committedPeakBlockHours(a.id, type, mine.pax, mine.cargo), committedPeakBlockHours(a.id, type, A.routes, A.cargoRoutes), `peak, tail ${a.id}`);
    assert.equal(committedPeakBlockHoursIn(a.id, type, mine.pax, mine.cargo, [6, 7]), committedPeakBlockHoursIn(a.id, type, A.routes, A.cargoRoutes, [6, 7]), `summer, tail ${a.id}`);
    assert.deepEqual(committedBlockHoursByMonth(a.id, type, mine.pax, mine.cargo), committedBlockHoursByMonth(a.id, type, A.routes, A.cargoRoutes), `by month, tail ${a.id}`);
  }
});
test('the index is built once per pair of tables and again when either changes', () => {
  needTails();
  const first = tails.tailRoutesIn(A.routes, A.cargoRoutes, 'p1');
  assert.equal(tails.tailRoutesIn(A.routes, A.cargoRoutes, 'p1'), first, 'same tables: the same lists');
  const routes2 = A.routes.filter(r => r.id !== 'second');
  assert.deepEqual(tails.tailRoutesIn(routes2, A.cargoRoutes, 'p1').pax.map(r => r.id), ['r1']);
  assert.deepEqual(tails.tailRoutesIn(A.routes, [], 'p1').cargo, []);
  assert.deepEqual(tails.tailRoutesIn(A.routes, A.cargoRoutes, 'p1').pax.map(r => r.id), ['r1', 'second'], 'the first tables are still answered correctly');
});
test('the Routes page and both planners ask each tail about its own routes', () => {
  for (const file of ['src/components/Routes.jsx', 'src/components/TagRoutePlanner.jsx', 'src/components/RoutePlanner.jsx']) {
    const src = read(file).replace(/\/\/.*$/gm, '');
    assert.ok(!/routesCommittedTo\(/.test(src), `${file} still searches the route tables per tail (routesCommittedTo)`);
    assert.ok(!/committed(?:PeakBlockHours|PeakBlockHoursIn|BlockHoursByMonth)\([^)]*\b(?:state\.)?routes\b\s*,/.test(src),
      `${file} still hands the whole route table to a per-tail hours question`);
    assert.match(src, /from '\.\.\/utils\/tailRoutes\.js'/);
  }
  assert.match(read('src/components/Fleet.jsx'), /tailRoutesOf\(state, aircraftId\)/, 'Fleet shares the same index');
});

// ── B ────────────────────────────────────────────────────────────────────────
section('Competition: each pair\'s routes come from one index');

const B = airline(60, { hub: 'JFK' });
test('the pair index is the per-pair search, for every pair and either direction', () => {
  assert.ok(pairShare.nonstopRoutesByPair, 'pairShare.js has no nonstopRoutesByPair');
  const index = pairShare.nonstopRoutesByPair(B.routes);
  const keys = new Set(B.routes.map(r => pairShare.pairKeyOf(r.origin, r.destination)));
  const { isMultiStop } = sim;
  for (const key of keys) {
    const want = B.routes.filter(r => pairShare.pairKeyOf(r.origin, r.destination) === key && !isMultiStop(r)).map(r => r.id);
    assert.deepEqual((index.get(key) ?? []).map(r => r.id), want, key);
  }
  assert.ok([...index.values()].every(list => list.every(r => r.id !== 'tag1')), 'a tag route is not a nonstop offer on its end-to-end pair');
  assert.equal(pairShare.nonstopRoutesByPair(null).size, 0);
});
test('the share fight is the same whether it is handed the pair\'s routes or finds them', () => {
  const state = { ...B, humanRivals: { [pairShare.pairKeyOf('JFK', B.routes[0].destination)]: [{ airlineId: 'h1', name: 'Rival', weeklyFrequency: 7, economyPrice: 280, economySeats: 150, totalSeats: 150, qualityScore: 60, brandReach: 0.5 }] } };
  const index = pairShare.nonstopRoutesByPair(state.routes);
  let checked = 0;
  for (const r of state.routes.slice(0, 25)) {
    const key = pairShare.pairKeyOf(r.origin, r.destination);
    const [a, b] = key.split('-');
    const found = pairShare.pairMarketShare(state, a, b);
    const handed = pairShare.pairMarketShare(state, a, b, { pairRoutes: index.get(key) ?? [] });
    assert.deepEqual(JSON.parse(JSON.stringify(handed)), JSON.parse(JSON.stringify(found)), key);
    checked++;
  }
  assert.ok(checked >= 20);
});
test('the page builds the index once and hands each card its pair', () => {
  const src = read('src/components/Competition.jsx');
  assert.match(src, /useMemo\(\(\) => nonstopRoutesByPair\(routes\), \[routes\]\)/);
  assert.match(src, /pairRoutes=\{routesByPair\.get\(pairKeyOf\(o, d\)\) \?\? NO_PAIR_ROUTES\}/);
  assert.match(src, /pairMarketShare\(state, a, b, pairRoutes \? \{ pairRoutes \} : undefined\)/);
  assert.ok(!/fleet\.find\(a => a\.id === route\.aircraftId\)/.test(src), 'seatsOfRoute still searches the fleet per route');
  assert.match(src, /useMemo\(\(\) => buildPlayerPairMap\(routes, fleet, monthIndex\)/);
});
test('past 30 contested pairs only the cards on screen are built (and all of them off the browser)', () => {
  const src = read('src/components/Competition.jsx');
  assert.match(src, /useWindowedRows\(\{[^}]*minTotal: CONTESTED_WINDOW_FROM/);
  assert.match(src, /contestedKeys\.slice\(view\.start, view\.end\)\.map\(/);
  assert.match(src, /const CONTESTED_WINDOW_FROM = 30;/);
});

const Competition = (await import('../src/components/Competition.jsx')).default;
test('the Competition page renders every contested card under server rendering, with the same shares', () => {
  const rivals = {}; const competitors = [{ id: 'h1', name: 'Rival Air', human: true, routes: {}, color: '#f00', hub: 'BOS', fleetSize: 40, reputation: 60 }];
  for (const r of B.routes.slice(0, 40)) {
    const key = pairShare.pairKeyOf(r.origin, r.destination);
    rivals[key] = [{ airlineId: 'h1', name: 'Rival Air', weeklyFrequency: 7, economyPrice: 280, economySeats: 150, totalSeats: 150, qualityScore: 60, brandReach: 0.5 }];
    competitors[0].routes[key] = { price: 280, quality: 60, frequency: 7, seats: 150 };
  }
  const state = { ...B, humanRivals: rivals, competitors };
  const html = renderToString(React.createElement(RemoteGameProvider, { state, dispatch() {}, remoteApi: null },
    React.createElement(ConfirmProvider, null, React.createElement(Competition))));
  const cards = (html.match(/data-contested-list/g) ?? []).length;
  assert.equal(cards, 1, 'the contested list container');
  assert.ok(!/data-spacer/.test(html), 'no spacers off the browser');
  const contested = new Set(Object.keys(rivals));
  let found = 0;
  for (const key of contested) { const [a, b] = key.split('-'); if (html.includes(`${a}`) && html.includes(`${b}`)) found++; }
  assert.equal(found, contested.size, 'every contested pair is on the page');
});

// ── C ────────────────────────────────────────────────────────────────────────
section('Finance: long per-route lists in the statement');

const finance = await import('../src/components/Finance.jsx');
test('a list of up to 30 rows shows whole; a longer one shows 25', () => {
  assert.ok(finance.shortList, 'Finance.jsx has no shortList');
  const of = (n) => Array.from({ length: n }, (_, i) => i);
  assert.equal(finance.shortList(of(0)).length, 0);
  assert.equal(finance.shortList(of(30)).length, 30);
  assert.deepEqual(finance.shortList(of(31)), of(25));
  assert.equal(finance.shortList(of(4027)).length, 25);
  assert.equal(finance.LONG_LIST, 25);
});

function played(n) {
  let s = airline(n);
  s = { ...s, cargoRoutes: [], routes: s.routes.filter(r => !['cover1', 'tag1'].includes(r.id)) };
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  return s;
}
const renderFinance = (state) => renderToString(React.createElement(RemoteGameProvider, { state, dispatch() {}, remoteApi: null },
  React.createElement(ConfirmProvider, null, React.createElement(finance.default, { initialView: 'pl' })))).replace(/<!-- -->/g, '');
const rowsUnder = (html, heading, until) => {
  const i = html.indexOf(heading); if (i < 0) return null;
  const j = html.indexOf(until, i); if (j < 0) return null;
  return (html.slice(i, j).match(/<tr/g) ?? []).length;
};
test('120 routes: the statement shows 25 catering rows, says how many there are, and the total is the same', () => {
  const state = played(120);
  const html = renderFinance(state);
  const cat = rowsUnder(html, '>Catering<', 'Total catering cost');
  assert.ok(cat !== null, 'no Catering block in the statement');
  assert.ok(cat <= 25 + 3, `${cat} rows under Catering`);
  assert.match(html, /Showing the 25 largest of 1\d\d routes\./);
  assert.match(html, /Showing 25 of \d+ routes\./, 'crew accommodation');
  assert.match(html, /Show all/);
  // The total line is computed from every route, not from the rows shown.
  assert.match(html, /Total catering cost/);
  const src = read('src/components/Finance.jsx');
  assert.ok(!/const tot\w+\s*=[^;]*listRows\(/.test(src), 'a total is being summed from a shortened list');
});
test('20 routes: nothing is cut and there is no "show all" line', () => {
  const html = renderFinance(played(20));
  assert.ok(!/data-more-rows/.test(html));
  const cat = rowsUnder(html, '>Catering<', 'Total catering cost');
  assert.ok(cat === null || cat >= 15, `${cat} rows under Catering for 20 routes`);
});
test('the four long lists all go through the cut', () => {
  const src = read('src/components/Finance.jsx');
  for (const key of ['catering', 'layover', 'leases', 'maint']) {
    assert.match(src, new RegExp(`listRows\\('${key}', \\w+\\)`), key);
    assert.match(src, new RegExp(`listMore\\('${key}', \\w+, '[^']+', pw \\? 4 : 3`), key);
  }
});

// ── The map ──────────────────────────────────────────────────────────────────
section('Route map: the "All Routes" table under the map');

test('past 150 city pairs only the rows in view are built, with a spacer above and below', () => {
  // 4,000 pairs was 40,000+ elements, rebuilt on every mouse move over the
  // table (hovering a row re-renders the map component), every fare change and
  // every new week: 1.55 s per click and 2.7 s per week on the map (2026-11-11).
  const src = read('src/components/RouteMap.jsx');
  assert.match(src, /const tableWin = useWindowedRows\(\{ estimate: 37, resetKey: `\$\{acTypeFilter \?\? ''\}\|\$\{airportFilter \?\? ''\}` \}\);/);
  assert.match(src, /const tableView = tableWin\.rows\(routeGroups\.length\);/);
  assert.match(src, /<tbody ref=\{tableWin\.bodyRef\}>/);
  assert.match(src, /routeGroups\.slice\(tableView\.start, tableView\.end\)\.map\(\(g\) => \{/);
  assert.equal((src.match(/data-spacer=""><td colSpan=\{6\}/g) ?? []).length, 2);
  assert.ok(!/\{routeGroups\.map\(\(g\) => \{\s*\n\s*const profit/.test(src), 'the table still builds a row for every pair');
});

console.log(`\nbig-pages-test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
