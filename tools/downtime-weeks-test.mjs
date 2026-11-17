// A check or grounding of k weeks costs k weeks of flying, and a stationed
// reserve flies every one of them.
//
// Discord (djak2103, VodkaOnFire, 2026-11-16): "Reserve aircraft should take
// over during C/D checks." The panel read "In C check — 1 week remaining" over
// "no reserve is dispatched". It was telling the truth about the old tick, which
// ran the downtime countdown BEFORE the week was flown: a tail on its last week
// came back and flew it, so every downtime cost one week less than it said. A
// 1-week C check was free, a reserve never had anything to cover, and "Grounded
// for 3 weeks" grounded you for 2.
//
// Now the countdown runs AFTER the week is flown, and the reserve pass runs again
// at the end of the tick, so routes hand back the moment a tail really returns
// and a breakdown or tick-started check is covered before its first lost week.
//
//   node --import ./tools/_register-loader.mjs tools/downtime-weeks-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';

let _rng = 0;
Math.random = () => 0.90 + ((_rng++ % 97) / 1000);

const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
  clear: () => store.clear(),
  key: i => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};

const { GameProvider, freshState, gameReducer } = await import('../src/store/GameContext.jsx');
const { AircraftDetail } = await import('../src/components/Fleet.jsx');
const { coverOutlookByAircraft } = await import('../packages/engine/src/utils/simulation.js');
const { absoluteWeek } = await import('../packages/engine/src/utils/fuel.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

const find = (s, id) => s.fleet.find(a => a.id === id);
const advance = (s) => gameReducer(s, { type: 'ADVANCE_WEEK' });
const rev = (s) => s.financialHistory.at(-1)?.routeRevenues?.[s.routes[0].id] ?? 0;

// Jet A flies JFK–ORD; jet B is idle, optionally stationed as a JFK reserve.
function rig({ reserve = true } = {}) {
  let s = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'RSV', hub: 'JFK', enableObjectives: false });
  s = { ...s, cash: 500_000_000 };
  s = gameReducer(s, { type: 'BUY_AIRCRAFT', typeId: 'crj200' }); const a = s.fleet.at(-1).id;
  s = gameReducer(s, { type: 'BUY_AIRCRAFT', typeId: 'crj200' }); const b = s.fleet.at(-1).id;
  s = gameReducer(s, { type: 'ADD_GATE', airportCode: 'ORD' });
  s = gameReducer(s, { type: 'ADD_ROUTE', aircraftId: a, origin: 'JFK', destination: 'ORD', weeklyFrequency: 7 });
  if (reserve) s = gameReducer(s, { type: 'SET_RESERVE', aircraftId: b, baseCode: 'JFK' });
  s = advance(s);
  return { s, a, b };
}

// Run the same airline with no downtime alongside, week for week: route revenue
// drifts, so "earned what it would have" means "earned what the control earned".
// `flew` records which tails actually flew each week, read from the block hours
// they accrued — the route table after a tick says who holds the route NEXT week.
function weeks(s, control, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const before = new Map(s.fleet.map(x => [x.id, x.hoursSinceC ?? 0]));
    s = advance(s); control = advance(control);
    const flew = new Set(s.fleet.filter(x => (x.hoursSinceC ?? 0) > (before.get(x.id) ?? 0)).map(x => x.id));
    out.push({ s, rev: rev(s), ctl: rev(control), by: s.routes[0].aircraftId, cover: s.routes[0].coverForAircraftId ?? null, flew });
  }
  return out;
}

const ground = (s, id, n) => ({ ...s, fleet: s.fleet.map(x => x.id === id
  ? { ...x, status: 'grounded', groundedWeeksLeft: n, groundedReason: 'failure' } : x) });

function panel(s, id) {
  store.set('bbae_save_v2', JSON.stringify(s));
  const noop = () => {};
  return renderToString(React.createElement(GameProvider, null,
    React.createElement(AircraftDetail, { aircraft: find(s, id), onClose: noop, onConfigure: noop, onRetire: noop, onSell: noop })))
    .replace(/<!-- -->/g, '').replace(/&#x27;/g, "'");
}

console.log('\n── Lost flying matches the downtime ───────────────────');

test('a 1-week C check with no reserve misses exactly one week', () => {
  let { s, a } = rig({ reserve: false });
  const control = rig({ reserve: false }).s;
  s = gameReducer(s, { type: 'SCHEDULE_CHECK', aircraftId: a, checkType: 'C', startNow: true });
  assert.equal(find(s, a).checkWeeksLeft, 1, 'rig assumes a 1-week CRJ C check');
  const w = weeks(s, control, 2);
  assert.equal(w[0].rev, 0, `the check week earned ${w[0].rev}; a 1-week C check must cost a week of flying`);
  assert.equal(find(w[0].s, a).status, 'assigned', 'and the jet is back in service as soon as that week is flown');
  assert.equal(w[1].rev, w[1].ctl, 'the week after is flown in full');
});

test('a 3-week D check with no reserve misses exactly three weeks', () => {
  let { s, a } = rig({ reserve: false });
  const control = rig({ reserve: false }).s;
  s = gameReducer(s, { type: 'SCHEDULE_CHECK', aircraftId: a, checkType: 'D', startNow: true });
  assert.equal(find(s, a).checkWeeksLeft, 3, 'rig assumes a 3-week CRJ D check');
  const w = weeks(s, control, 4);
  assert.deepEqual(w.map(x => x.rev === 0), [true, true, true, false], `revenue by week: ${w.map(x => x.rev).join(', ')}`);
  assert.equal(w[3].rev, w[3].ctl);
});

test('"grounded for 2 weeks" grounds it for 2 weeks', () => {
  let { s, a } = rig({ reserve: false });
  const control = rig({ reserve: false }).s;
  s = ground(s, a, 2);
  const w = weeks(s, control, 3);
  assert.deepEqual(w.map(x => x.rev === 0), [true, true, false], `revenue by week: ${w.map(x => x.rev).join(', ')}`);
});

console.log('\n── Reserves fly every lost week ───────────────────────');

test('a reserve flies a 1-week C check, then hands the route straight back', () => {
  let { s, a, b } = rig();
  const control = rig().s;
  s = gameReducer(s, { type: 'SCHEDULE_CHECK', aircraftId: a, checkType: 'C', startNow: true });
  const w = weeks(s, control, 2);
  assert.equal(w[0].rev, w[0].ctl, `check week earned ${w[0].rev} vs ${w[0].ctl}: the reserve should have flown it`);
  assert.ok(w[0].flew.has(b) && !w[0].flew.has(a), 'the reserve flew the check week, not the jet in the shop');
  assert.equal(w[0].by, a, 'after the check week the route is back with its own jet, not still on the reserve');
  assert.equal(w[0].cover, null);
  assert.equal(find(w[0].s, b).status, 'idle', 'and the reserve is back on standby');
  assert.equal(w[1].rev, w[1].ctl);
});

test('the reserve covers all three weeks of a D check', () => {
  let { s, a, b } = rig();
  const control = rig().s;
  s = gameReducer(s, { type: 'SCHEDULE_CHECK', aircraftId: a, checkType: 'D', startNow: true });
  const w = weeks(s, control, 4);
  for (let i = 0; i < 4; i++) assert.equal(w[i].rev, w[i].ctl, `week ${i + 1}: earned ${w[i].rev} vs ${w[i].ctl}`);
  assert.deepEqual(w.map(x => x.flew.has(b)), [true, true, true, false], 'the reserve flies all three check weeks');
  assert.deepEqual(w.map(x => x.flew.has(a)), [false, false, false, true], 'and the jet flies none of them');
  assert.equal(w[2].by, a, 'handed back the moment the check ends');
});

test('a check the tick starts is covered before its first lost week', () => {
  let { s, a, b } = rig();
  s = gameReducer(s, { type: 'SCHEDULE_CHECK', aircraftId: a, checkType: 'C', startWeek: absoluteWeek(s.year, s.week) });
  s = advance(s);   // flies this week, starts the check at the end of the tick
  assert.equal(find(s, a).status, 'maintenance', 'the booked check started');
  assert.equal(s.routes[0].aircraftId, b, 'the reserve is already on the route, not "steps in next week"');
  assert.equal(s.routes[0].coverForAircraftId, a);
  const html = panel(s, a);
  assert.ok(html.includes('covered by'), 'the panel shows the cover in place');
});

test('a grounding is covered for every grounded week', () => {
  let { s, a, b } = rig();
  const control = rig().s;
  s = ground(s, a, 2);
  const w = weeks(s, control, 3);
  for (let i = 0; i < 3; i++) assert.equal(w[i].rev, w[i].ctl, `week ${i + 1}: earned ${w[i].rev} vs ${w[i].ctl}`);
  assert.deepEqual(w.map(x => x.flew.has(b)), [true, true, false], 'the reserve flies both grounded weeks');
});

console.log('\n── Forecast and panel agree with the tick ─────────────');

test('the cover forecast names the reserve for a 1-week check, and the tick does it', () => {
  let { s, a, b } = rig();
  s = gameReducer(s, { type: 'SCHEDULE_CHECK', aircraftId: a, checkType: 'C', startNow: true });
  const ol = coverOutlookByAircraft({ fleet: s.fleet, routes: s.routes, cargoRoutes: s.cargoRoutes ?? [],
    hubs: s.hubs ?? {}, absWeek: absoluteWeek(s.year, s.week),
    routeRevenues: s.financialHistory.at(-1)?.routeRevenues ?? {} })[a];
  assert.equal(ol.coversNext, 1, 'forecast: the reserve flies its one route next week');
  assert.deepEqual(ol.reserves, [find(s, b).name]);
  const html = panel(s, a);
  assert.ok(html.includes('1 week remaining'), 'the panel counts the week honestly');
  assert.ok(!html.includes('no reserve is dispatched'), 'and no longer says the reserve sits it out');
  assert.ok(html.includes(find(s, b).name), 'it names the reserve that will fly it');
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
