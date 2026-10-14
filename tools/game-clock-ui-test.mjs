// Game clock and globe planes, wired into the real components.
//
//   · the server sends the pace the clock needs (worldClock.weeksPerDay)
//   · TickCountdown (SSR) leads with the in-game time when it has the pace
//   · tailFlightPlans: one plane per flying tail, honouring grounding,
//     seasons, the map's filters and the cargo toggle
//   · RouteMap (SSR) offers the Planes toggle on the globe only
//
//   node --import ./tools/_register-loader.mjs tools/game-clock-ui-test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
const src = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
const React = (await import('react')).default;
const { renderToString } = await import('react-dom/server');
const { default: TickCountdown } = await import('../apps/headwinds-web/src/TickCountdown.jsx');
const { default: RouteMap, MAP_VIEW_KEY, GLOBE_PLANES_KEY, tailFlightPlans, routeGroupColor } =
  await import('../src/components/RouteMap.jsx');
const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const { AIRCRAFT_TYPES } = await import('../src/data/aircraft.js');
const { getAirport } = await import('../src/data/airports.js');
const { tickIntervalMs } = await import('../src/components/gameClock.js');
const { planePosition } = await import('../src/components/flightsCore.js');

// ── Server ────────────────────────────────────────────────────────────────────
await test('worldClock carries the raw pace for the clock', () => {
  assert.match(src('../apps/headwinds-server/src/routes/decisions.mjs'), /weeksPerDay:\s*world\.weeksPerDay/);
});

await test('the game screen hands the clock to the countdown and (as data) to the globe', () => {
  const s = src('../apps/headwinds-web/src/GamePlayScreen.jsx');
  assert.match(s, /weeksPerDay=\{meta\?\.worldClock\?\.weeksPerDay/);
  assert.match(s, /gameClock:/);
});

// ── TickCountdown ─────────────────────────────────────────────────────────────
const strip = (h) => h.replaceAll('<!-- -->', '');
await test('with the pace, the countdown leads with the game time', () => {
  // Half the interval left at 1 week/day → Thursday noon.
  const next = new Date(Date.now() + tickIntervalMs(1) / 2).toISOString();
  const html = strip(renderToString(React.createElement(TickCountdown, { nextTickAt: next, weeksPerDay: 1 })));
  assert.match(html, /<strong>Thu 1[12]:\d\d<\/strong> · next week in/);
  assert.match(html, /title="[^"]*Game time Thu/);
});

await test('a late tick holds the clock at Sunday 23:59', () => {
  const html = strip(renderToString(React.createElement(TickCountdown, {
    nextTickAt: new Date(Date.now() - 5000).toISOString(), weeksPerDay: 6,
  })));
  assert.match(html, /Sun 23:59.*next week landing/);
});

await test('no pace (older server) or not started → the countdown alone', () => {
  const next = new Date(Date.now() + 3_600_000).toISOString();
  const plain = strip(renderToString(React.createElement(TickCountdown, { nextTickAt: next })));
  assert.doesNotMatch(plain, /(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d\d:\d\d/);
  const pre = strip(renderToString(React.createElement(TickCountdown, { nextTickAt: next, weeksPerDay: 4, preStart: true })));
  assert.match(pre, /first week in/);
  assert.doesNotMatch(pre, /(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d\d:\d\d/);
});

// ── tailFlightPlans ───────────────────────────────────────────────────────────
const jet = AIRCRAFT_TYPES.find(t => !t.freighter && t.category === 'Narrow Body');
const freighter = AIRCRAFT_TYPES.find(t => t.freighter);
const ap = (c) => getAirport(c);
const member = (id, codes, extra = {}) => ({
  r: { id, origin: codes[0], destination: codes.at(-1), stops: codes, aircraftId: `ac-${id}`, weeklyFrequency: 7, ...extra },
  chain: codes.map(ap), origin: ap(codes[0]), dest: ap(codes.at(-1)),
});
const fleetFor = (ids, status = {}) => ids.map(id => ({
  id: `ac-${id}`, typeId: (id.startsWith('c') ? freighter : jet).id, tailNumber: `VH-${id.toUpperCase()}`,
  status: status[id] ?? 'assigned',
}));

await test('one plan per flying tail, coloured like its line', () => {
  const g = { key: 'MEL~SYD', multi: false, hasResult: true, profit: 5, members: [member('a', ['SYD', 'MEL']), member('b', ['SYD', 'MEL'])] };
  const plans = tailFlightPlans({ groups: [g], fleet: fleetFor(['a', 'b']), month: 6, colorOf: routeGroupColor, cargoColor: '#fa0' });
  assert.equal(plans.length, 2);
  assert.ok(plans.every(p => p.group === 'MEL~SYD' && p.color === routeGroupColor(g)));
  assert.notEqual(plans[0].phase, plans[1].phase, 'two tails on one pair spread out');
});

await test('grounded, in-maintenance, dormant and zero-frequency tails stay on the ground', () => {
  const g = { key: 'k', members: [
    member('a', ['SYD', 'MEL']), member('b', ['SYD', 'MEL']), member('c1', ['SYD', 'MEL']),
    member('d', ['SYD', 'MEL'], { season: { months: [12, 1, 2] } }), member('e', ['SYD', 'MEL'], { weeklyFrequency: 0 }),
  ] };
  const plans = tailFlightPlans({
    groups: [g], fleet: fleetFor(['a', 'b', 'c1', 'd', 'e'], { a: 'grounded', b: 'maintenance' }),
    month: 6, colorOf: () => '#fff', cargoColor: '#fa0',
  });
  assert.deepEqual(plans.map(p => p.id), ['c1']);
  const winter = tailFlightPlans({ groups: [g], fleet: fleetFor(['d']), month: 1, colorOf: () => '#fff' });
  assert.deepEqual(winter.map(p => p.id), ['d'], 'a seasonal route flies in its season');
});

await test('cargo planes are tagged as cargo (tooltip only, no focus) and take the cargo colour', () => {
  const g = { key: 'HKG~LAX', members: [member('c9', ['HKG', 'LAX'])] };
  const [p] = tailFlightPlans({ cargoGroups: [g], fleet: fleetFor(['c9']), month: 3, colorOf: () => '#fff', cargoColor: '#fa0' });
  assert.equal(p.group, 'cargo:HKG~LAX');
  assert.equal(p.color, '#fa0');
});

await test('a rotation flies through every stop', () => {
  const g = { key: 'tag:x', multi: true, members: [member('t', ['MCI', 'JFK', 'ORY'])] };
  const [p] = tailFlightPlans({ groups: [g], fleet: fleetFor(['t']), month: 3, colorOf: routeGroupColor });
  assert.deepEqual(p.legs.map(l => l.from.code), ['MCI', 'JFK', 'ORY', 'JFK']);
  assert.ok(planePosition(p, p.phase + 0.5), 'airborne half an hour after departure');
});

await test('a player-named aircraft cannot inject HTML into the tooltip', () => {
  const g = { key: 'k', members: [member('x', ['SYD', 'MEL'])] };
  const fleet = [{ id: 'ac-x', typeId: jet.id, name: '<img src=x onerror=alert(1)>', status: 'assigned' }];
  const [p] = tailFlightPlans({ groups: [g], fleet, month: 3, colorOf: () => '#fff' });
  assert.ok(!p.tip.includes('<img'), p.tip);
  assert.ok(p.tip.includes('&lt;img'));
});

// ── RouteMap (SSR) ────────────────────────────────────────────────────────────
store.set('bbae_save_v2', JSON.stringify({
  ...freshState(),
  phase: 'playing', week: 20, year: 2, hub: 'DXB', cash: 20_000_000, scheduleTrimVersion: 1,
  hubs: { DXB: { tier: 2, tierSince: 0 } },
  gates: { DXB: 16, LHR: 6 },
  fleet: [{ id: 'ac0', typeId: jet.id, name: 'Test 0', tailNumber: 'A6TEST', status: 'assigned',
            ageWeeks: 52, ownershipType: 'owned', config: { economy: jet.seats } }],
  routes: [{ id: 'r0', origin: 'DXB', destination: 'LHR', stops: ['DXB', 'LHR'], aircraftId: 'ac0',
             weeklyFrequency: 14, weeksOpen: 40, hub: 'DXB', cateringLevel: 'full' }],
}));
const render = () => strip(renderToString(React.createElement(GameProvider, null, React.createElement(RouteMap))));

await test('the Planes toggle shows on the globe only, on by default, and remembers "off"', () => {
  assert.doesNotMatch(render(), />Planes</, 'flat map: no planes toggle');
  store.set(MAP_VIEW_KEY, 'globe');
  assert.match(render(), /aria-pressed="true"[^>]*>(<[^>]+>)*[^<]*(<\/[^>]+>)*\s*Planes/);
  store.set(GLOBE_PLANES_KEY, 'off');
  assert.match(render(), /aria-pressed="false"[^>]*>(<[^>]+>)*[^<]*(<\/[^>]+>)*\s*Planes/);
  store.delete(GLOBE_PLANES_KEY);
  store.delete(MAP_VIEW_KEY);
});

console.log(`\ngame-clock-ui-test: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
