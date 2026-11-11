// The Fleet list builds only the rows on screen once the fleet is large.
//
// The list used to end with every aircraft on the page (built a slice per
// frame, but all of it), and each row walked the whole route table several
// times. On a live airline of 4,884 tails and 4,027 routes that was 150,000
// elements, 56 seconds to open the page and 8–17 seconds for any click made on
// it (measured 2026-11-10). Two changes:
//   • past 150 rows the table is windowed (src/utils/useWindowedRows.js);
//   • a tail's routes come from an index built once per route table
//     (Fleet.jsx tailRoutes), not from a scan per row.
//
// What this pins: the window covers what is on screen and nothing is lost
// (the spacers add up to the rows left out); off the browser the whole list is
// rendered, as the SSR suites rely on; and the indexed routes are exactly the
// routes the scan found, so utilisation on the page still equals the tick's.
//
//   node --import ./tools/_register-loader.mjs tools/fleet-window-test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';

globalThis.window = globalThis.window ?? {};
globalThis.window.matchMedia = globalThis.window.matchMedia
  ?? (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
const lsMem = new Map();
globalThis.localStorage = globalThis.localStorage
  ?? { getItem: (k) => (lsMem.has(k) ? lsMem.get(k) : null), setItem: (k, v) => lsMem.set(k, String(v)), removeItem: (k) => lsMem.delete(k) };

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}
function section(t) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 62 - t.length))}`); }
const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

const win = await import('../src/utils/useWindowedRows.js').catch(() => null);
const need = () => { if (!win) throw new Error('src/utils/useWindowedRows.js does not exist'); };

section('which rows are in the window');

const flat = (h) => () => h;
test('a view in the middle: the rows it touches, plus the margin', () => {
  need();
  const s = win.windowSlice(1000, flat(50), 10_000, 10_800, 0);
  assert.deepEqual([s.start, s.end], [200, 216]);
  assert.equal(s.padTop, 200 * 50);
  assert.equal(s.padBottom, (1000 - 216) * 50);
  const m = win.windowSlice(1000, flat(50), 10_000, 10_800, 500);
  assert.deepEqual([m.start, m.end], [190, 226]);
});
test('the spacers plus the built rows are always the whole list', () => {
  need();
  const h = (i) => 40 + (i * 37) % 55;       // uneven rows, as the real ones are
  let total = 0; for (let i = 0; i < 777; i++) total += h(i);
  for (const [top, bottom, margin] of [[0, 900, 0], [0, 900, 400], [5000, 5900, 600], [total - 300, total + 600, 200], [-2000, -1000, 0], [total + 500, total + 1400, 0]]) {
    const s = win.windowSlice(777, h, top, bottom, margin);
    let built = 0; for (let i = s.start; i < s.end; i++) built += h(i);
    assert.ok(Math.abs(s.padTop + built + s.padBottom - total) < 1e-6, `view ${top}..${bottom}: heights do not add up`);
    assert.ok(s.start >= 0 && s.end <= 777 && s.start <= s.end);
  }
});
test('every row that intersects the view is built', () => {
  need();
  const h = (i) => 30 + (i % 7) * 12;
  const tops = []; let y = 0; for (let i = 0; i < 400; i++) { tops.push(y); y += h(i); }
  for (const top of [0, 137, 4021, 9000]) {
    const bottom = top + 820;
    const s = win.windowSlice(400, h, top, bottom, 0);
    for (let i = 0; i < 400; i++) {
      const onScreen = tops[i] + h(i) > top && tops[i] < bottom;
      if (onScreen) assert.ok(i >= s.start && i < s.end, `row ${i} is on screen at ${top} but was not built`);
    }
    assert.ok(s.end - s.start < 60, 'the window should be a screenful, not the list');
  }
});
test('at the top, at the bottom, and scrolled clean past the list', () => {
  need();
  const top = win.windowSlice(500, flat(50), 0, 800, 0);
  assert.deepEqual([top.start, top.padTop], [0, 0]);
  const end = win.windowSlice(500, flat(50), 500 * 50 - 800, 500 * 50, 0);
  assert.deepEqual([end.end, end.padBottom], [500, 0]);
  const past = win.windowSlice(500, flat(50), 500 * 50 + 4000, 500 * 50 + 4800, 0);
  assert.ok(past.end === 500 && past.start < 500, 'something must stay built to measure against');
  const above = win.windowSlice(500, flat(50), -5000, -4200, 0);
  assert.equal(above.start, 0);
  assert.deepEqual(win.windowSlice(0, flat(50), 0, 800, 0).padTop, 0);
});

section('off the browser the whole list is rendered');

const React = (await import('react')).default;
const { renderToString } = await import('react-dom/server');
test('the hook windows nothing under server rendering', () => {
  need();
  let seen = null;
  function Probe() {
    const w = win.useWindowedRows({ minTotal: 150, resetKey: 'k' });
    seen = w.rows(5000);
    return React.createElement('div', null, 'x');
  }
  renderToString(React.createElement(Probe));
  assert.deepEqual({ start: seen.start, end: seen.end, padTop: seen.padTop, padBottom: seen.padBottom, windowed: seen.windowed },
    { start: 0, end: 5000, padTop: 0, padBottom: 0, windowed: false });
});

const { GameProvider, RemoteGameProvider, freshState } = await import('../src/store/GameContext.jsx');
const { ConfirmProvider } = await import('../src/components/ConfirmModal.jsx');
const fleetMod = await import('../src/components/Fleet.jsx');
const Fleet = fleetMod.default;
const { getAircraftType } = await import('../src/data/aircraft.js');
const { defaultConfig, aircraftUtilization, routesCommittedTo } = await import('../src/utils/simulation.js');
const { AIRPORTS } = await import('../packages/engine/src/data/airports.js');

function bigAirline(n) {
  const t = getAircraftType('a320neo');
  const dests = AIRPORTS.map(a => a.code).filter(c => c !== 'SIN').slice(0, n);
  const fleet = dests.map((d, i) => ({ id: `p${i}`, typeId: t.id, status: i % 9 === 8 ? 'idle' : 'assigned', ageWeeks: 30 + i, config: defaultConfig(t.seats),
    ownershipType: i % 2 ? 'owned' : 'lease', leaseRemainingWeeks: 60, weeklyLease: 90_000, tailNumber: `9V-${1000 + i}`, name: `Probe ${1000 + i}` }));
  const routes = dests.map((d, i) => (i % 9 === 8 ? null : { id: `r${i}`, origin: 'SIN', destination: d, stops: ['SIN', d], aircraftId: `p${i}`, weeklyFrequency: 7, weeksOpen: 30, hub: 'SIN', ticketPrice: 300 })).filter(Boolean);
  // A reserve covering another tail's route, and a second route on one tail.
  routes.push({ id: 'cover1', origin: 'SIN', destination: dests[3], stops: ['SIN', dests[3]], aircraftId: 'p8', coverForAircraftId: 'p3', weeklyFrequency: 7, weeksOpen: 2, hub: 'SIN', ticketPrice: 300 });
  routes.push({ id: 'second', origin: 'SIN', destination: dests[5], stops: ['SIN', dests[5]], aircraftId: 'p1', weeklyFrequency: 3, weeksOpen: 9, hub: 'SIN', ticketPrice: 250 });
  const cargoRoutes = [{ id: 'c1', origin: 'SIN', destination: dests[2], aircraftId: 'p17', weeklyFrequency: 2 }];
  return { ...freshState(), phase: 'playing', week: 20, year: 3, hub: 'SIN', airlineName: 'Probe Air', cash: 5e9, multiplayer: true,
    competitors: [], humanRivals: {}, encroachments: {}, hubs: { SIN: { tier: 3, tierSince: 0 } },
    fleet, routes, cargoRoutes, gates: Object.fromEntries([['SIN', 400], ...dests.map(d => [d, 2])]) };
}

test('Fleet renders every one of 400 aircraft when rendered on the server', () => {
  const state = bigAirline(400);
  const html = renderToString(React.createElement(RemoteGameProvider, { state, dispatch() {}, remoteApi: null },
    React.createElement(ConfirmProvider, null, React.createElement(Fleet))));
  const tails = new Set(html.match(/9V-1\d{3}/g) ?? []);
  assert.equal(tails.size, 400, `${tails.size} of 400 tails were rendered`);
  assert.equal((html.match(/data-spacer/g) ?? []).length, 0, 'spacer rows have no business in a full render');
});

section('a tail\'s routes from the index === the scan');

test('tailRoutes hands every tail exactly the routes routesCommittedTo keeps, in order', () => {
  if (typeof fleetMod.tailRoutes !== 'function') throw new Error('Fleet.jsx does not export tailRoutes');
  const state = bigAirline(120);
  for (const a of [...state.fleet, { id: 'nobody' }]) {
    const mine = fleetMod.tailRoutes(state, a.id);
    const want = routesCommittedTo(a.id, state.routes, state.cargoRoutes).map(r => r.id);
    assert.deepEqual([...mine.pax, ...mine.cargo].map(r => r.id), want, `tail ${a.id}`);
  }
  assert.ok(fleetMod.tailRoutes(state, 'p3').pax.some(r => r.id === 'cover1'), 'a covered route belongs to the tail it covers for');
  assert.ok(fleetMod.tailRoutes(state, 'p8').pax.some(r => r.id === 'cover1'), '…and to the reserve flying it');
  assert.equal(fleetMod.tailRoutes(state, 'p1').pax.length, 2);
  assert.equal(fleetMod.tailRoutes(state, 'p17').cargo.length, 1);
});

test('utilisation from a tail\'s own routes equals utilisation from the whole tables', () => {
  if (typeof fleetMod.tailRoutes !== 'function') throw new Error('Fleet.jsx does not export tailRoutes');
  const state = bigAirline(120);
  for (const a of state.fleet) {
    const type = getAircraftType(a.typeId);
    const whole = aircraftUtilization({ aircraft: a, type, routes: state.routes, cargoRoutes: state.cargoRoutes, month: 6 });
    const mine = fleetMod.tailRoutes(state, a.id);
    const own = aircraftUtilization({ aircraft: a, type, routes: mine.pax, cargoRoutes: mine.cargo, month: 6 });
    assert.deepEqual(own, whole, `tail ${a.id}`);
  }
});

test('a new route table is a new index (nothing stale after an edit)', () => {
  if (typeof fleetMod.tailRoutes !== 'function') throw new Error('Fleet.jsx does not export tailRoutes');
  const state = bigAirline(40);
  assert.equal(fleetMod.tailRoutes(state, 'p0').pax.length, 1);
  const edited = { ...state, routes: state.routes.filter(r => r.aircraftId !== 'p0') };
  assert.equal(fleetMod.tailRoutes(edited, 'p0').pax.length, 0);
  assert.equal(fleetMod.tailRoutes(state, 'p0').pax.length, 1);
});

section('Fleet.jsx');

const src = read('src/components/Fleet.jsx');
test('the list is windowed, with spacers above and below, and falls back to the progressive list', () => {
  assert.match(src, /const rowWindowing = useWindowedRows\(\{[^}]*minTotal: 150/);
  assert.match(src, /const rowWindow = rowWindowing\.rows\(sortedFleet\.length\);/);
  assert.match(src, /<tbody ref=\{rowWindowing\.bodyRef\}>/);
  assert.match(src, /rowWindow\.windowed \? sortedFleet\.slice\(rowWindow\.start, rowWindow\.end\) : sortedFleet\.slice\(0, shownRows\)/);
  assert.equal((src.match(/data-spacer=""/g) ?? []).length, 2, 'one spacer above, one below');
  assert.match(src, /height: rowWindow\.padTop/);
  assert.match(src, /height: rowWindow\.padBottom/);
});
test('a row no longer scans the route tables', () => {
  const a = src.indexOf('rowWindow.windowed ? sortedFleet.slice(');
  const row = src.slice(a, src.indexOf('data-spacer=""', a));
  assert.ok(a > 0 && row.length > 2000, 'the row body was not found');
  assert.doesNotMatch(row, /\b(?:routes|cargoRoutes)\.(?:find|filter)\(/, 'the row still walks a whole route table');
  assert.match(row, /const mine\s+= tailRoutes\(state, aircraft\.id\);/);
});
test('the windowing hook sits above the empty-fleet early return', () => {
  const hook = src.indexOf('const rowWindowing = useWindowedRows(');
  const early = src.indexOf('if (fleet.length === 0 && pendingOrders.length === 0) {');
  assert.ok(hook > 0 && early > 0 && hook < early);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
