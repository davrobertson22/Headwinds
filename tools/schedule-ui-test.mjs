// The schedule editor and what reads the timetable, through the real components.
//
//   · ScheduleTimeline (SSR): one row per flying tail, automatic flights dashed,
//     pinned ones solid, a tray of flights to drag in, hub-local times
//   · Operations offers it as a sub-tab
//   · the departure board prints your pinned departures at their local time
//
//   node --import ./tools/_register-loader.mjs tools/schedule-ui-test.mjs

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
const { default: ScheduleTimeline, weekLabel, SCHEDULE_ZONE_KEY } = await import('../src/components/ScheduleTimeline.jsx');
const { default: Departures } = await import('../src/components/Departures.jsx');
const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const { AIRCRAFT_TYPES } = await import('../src/data/aircraft.js');
const { buildDepartureBoard } = await import('../src/models/departureBoard.js');

const jet = AIRCRAFT_TYPES.find(t => !t.freighter && t.category === 'Narrow Body');
const save = (routes, extra = {}) => store.set('bbae_save_v2', JSON.stringify({
  ...freshState(),
  phase: 'playing', week: 20, year: 2, hub: 'SYD', cash: 20_000_000, scheduleTrimVersion: 1,
  hubs: { SYD: { tier: 2, tierSince: 0 } }, gates: { SYD: 16, MEL: 6, BNE: 6 },
  competitors: [],
  fleet: [
    { id: 'ac0', typeId: jet.id, tailNumber: 'VH-AAA', status: 'assigned', ageWeeks: 52, ownershipType: 'owned', config: { economy: jet.seats } },
    { id: 'ac1', typeId: jet.id, tailNumber: 'VH-BBB', status: 'assigned', ageWeeks: 52, ownershipType: 'owned', config: { economy: jet.seats } },
    { id: 'ac2', typeId: jet.id, tailNumber: 'VH-IDL', status: 'idle', ageWeeks: 52, ownershipType: 'owned', config: { economy: jet.seats } },
  ],
  routes,
  ...extra,
}));
const r0 = (schedule) => ({ id: 'r0', origin: 'SYD', destination: 'MEL', stops: ['SYD', 'MEL'], aircraftId: 'ac0',
  weeklyFrequency: 7, weeksOpen: 40, hub: 'SYD', cateringLevel: 'full', ...(schedule ? { schedule } : {}) });
const r1 = { id: 'r1', origin: 'SYD', destination: 'BNE', stops: ['SYD', 'BNE'], aircraftId: 'ac1',
  weeklyFrequency: 10, weeksOpen: 40, hub: 'SYD', cateringLevel: 'full' };
const strip = (h) => h.replaceAll('<!-- -->', '');
const render = (C, props = {}) => strip(renderToString(React.createElement(GameProvider, null, React.createElement(C, props))));
const count = (html, re) => (html.match(re) ?? []).length;

await test('Operations offers the Schedule sub-tab', () => {
  const s = src('../src/components/Operations.jsx');
  assert.match(s, /id: 'schedule',\s*label: 'Schedule'/);
  assert.match(s, /<ScheduleTimeline \/>/);
});

await test('one row per flying tail; an idle aircraft has no row', () => {
  save([r0(), r1]);
  const html = render(ScheduleTimeline);
  assert.match(html, /VH-AAA/);
  assert.match(html, /VH-BBB/);
  assert.doesNotMatch(html, /VH-IDL/);
  assert.match(html, />2 aircraft</);
});

await test('untouched: every flight automatic (dashed), all in the tray, nothing to reset', () => {
  save([r0(), r1]);
  const html = render(ScheduleTimeline);
  assert.equal(count(html, /class="sched-block is-auto/g), 17, '7 + 10 rotations');
  assert.equal(count(html, /class="sched-block is-pinned/g), 0);
  assert.match(html, /MEL ×7/);
  assert.match(html, /BNE ×10/);
  assert.doesNotMatch(html, /Reset all to automatic/);
});

await test('a pinned flight is solid, leaves the tray, and offers reset', () => {
  save([r0({ starts: [9960] }), r1]);
  const html = render(ScheduleTimeline);
  assert.equal(count(html, /class="sched-block is-pinned/g), 1);
  assert.equal(count(html, /class="sched-block is-auto/g), 16);
  assert.match(html, /MEL ×6/);
  assert.match(html, /Reset all to automatic/);
  // 9960 = Sun 22:00 UTC = Mon 08:00 in Sydney (UTC+10), the default zone.
  assert.match(html, /leaves Mon 08:00, set by you/);
});

await test('one keyboard tab stop per aircraft, not one per flight', () => {
  save([r0(), r1]);
  const html = render(ScheduleTimeline);
  assert.equal(count(html, /class="sched-block[^"]*"[^>]*tabindex="0"/g), 2);
  assert.ok(count(html, /tabindex="-1"/g) >= 15);
});

await test('a fully set route stays in the tray as a solid legend chip', () => {
  save([r0({ starts: [0, 1440, 2880, 4320, 5760, 7200, 8640] })]);
  const html = render(ScheduleTimeline);
  assert.match(html, /class="sched-chip is-set"/);
  assert.match(html, /all 7 flights set by you/);
});

await test('times in hub local by default, UTC on request', () => {
  save([r0({ starts: [9960] })]);
  assert.match(render(ScheduleTimeline), /SYD time \(UTC\+10\)/);
  store.set(SCHEDULE_ZONE_KEY, 'utc');
  assert.match(render(ScheduleTimeline), /leaves Sun 22:00, set by you/);
  store.delete(SCHEDULE_ZONE_KEY);
});

await test('no routes → an empty state, not an empty grid', () => {
  save([]);
  assert.match(render(ScheduleTimeline), /No flights to schedule yet/);
});

await test('weekLabel wraps the week', () => {
  assert.equal(weekLabel(0), 'Mon 00:00');
  assert.equal(weekLabel(10080 + 65), 'Mon 01:05');
  assert.equal(weekLabel(-60), 'Sun 23:00');
});

// ── Departure board ───────────────────────────────────────────────────────────
await test('board: a timetabled leg prints at exactly its times, on its days only', () => {
  const rows = (day) => buildDepartureBoard({ airport: 'SYD', day, worldSeed: 'w', carriers: [{
    id: 'p', name: 'Test Air', isPlayer: true, onTimeRate: 1,
    legs: [{ to: 'MEL', weeklyFrequency: 2, typeId: jet.id, typeName: jet.name, times: [{ day: 0, min: 480 }, { day: 3, min: 1065 }] }],
  }] });
  assert.deepEqual(rows(0).map(r => r.timeLabel), ['08:00']);
  assert.deepEqual(rows(3).map(r => r.timeLabel), ['17:45']);
  assert.deepEqual(rows(1), []);
});

await test('board: moving one timetabled flight keeps the other flights’ numbers', () => {
  const board = (t2) => buildDepartureBoard({ airport: 'SYD', day: 0, worldSeed: 'w', carriers: [{
    id: 'p', name: 'Test Air', isPlayer: true, onTimeRate: 0.9,
    legs: [{ to: 'MEL', weeklyFrequency: 3, typeId: jet.id, typeName: jet.name,
      times: [{ day: 0, min: 420, key: 'a|0' }, { day: 0, min: t2, key: 'a|1' }, { day: 0, min: 1080, key: 'a|2' }] }],
  }] });
  const num = (rows, t) => rows.find(r => r.time === t)?.flightNo;
  const b1 = board(600), b2 = board(300);
  assert.equal(num(b1, 420), num(b2, 420));
  assert.equal(num(b1, 1080), num(b2, 1080));
});

await test('board: your pinned departure shows at its local time', () => {
  save([r0({ starts: [9960] })]);
  const html = render(Departures, { initialAirport: 'SYD' });
  assert.match(html, /08:00/, 'Mon 08:00 Sydney');
});

console.log(`\nschedule-ui-test: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
