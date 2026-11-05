// Hub banks in the schedule editor, through the real components (SSR).
//
//   · a hub-bank world shows a card per designated hub: its bank setting,
//     the connections the timetable makes and what the waves cost
//   · elsewhere there is no panel and the intro still says "for show"
//   · a flight the player moved off a wave is marked, and the card offers to
//     snap it back
//   · the departure board prints the banked week (the same week the editor
//     and the tick use)
//
//   node --import ./tools/_register-loader.mjs tools/hub-banks-ui-test.mjs

import assert from 'node:assert/strict';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
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
const { default: ScheduleTimeline } = await import('../src/components/ScheduleTimeline.jsx');
const { default: Departures } = await import('../src/components/Departures.jsx');
const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const { AIRCRAFT_TYPES } = await import('../src/data/aircraft.js');
const { airlineWeeks, scheduleInputsOf, pinsAfterMove, blockHubEvents, bankContextOf } = await import('../src/models/schedule.js');

const jet = AIRCRAFT_TYPES.find(t => !t.freighter && t.category === 'Narrow Body');
const ac = (id, tail) => ({ id, typeId: jet.id, tailNumber: tail, status: 'assigned', ageWeeks: 52, ownershipType: 'owned', config: { economy: jet.seats } });
const route = (id, dest, acId, f, schedule) => ({ id, origin: 'SYD', destination: dest, stops: ['SYD', dest], aircraftId: acId,
  weeklyFrequency: f, weeksOpen: 40, hub: 'SYD', cateringLevel: 'full', ...(schedule ? { schedule } : {}) });
const baseState = (extra = {}) => ({
  ...freshState(),
  phase: 'playing', week: 20, year: 2, hub: 'SYD', cash: 20_000_000, scheduleTrimVersion: 1,
  hubs: { SYD: { tier: 2, tierSince: 0 } }, gates: { SYD: 16, MEL: 6, BNE: 6, PER: 6 },
  competitors: [],
  fleet: [ac('ac0', 'VH-AAA'), ac('ac1', 'VH-BBB'), ac('ac2', 'VH-CCC')],
  routes: [route('r0', 'MEL', 'ac0', 14), route('r1', 'BNE', 'ac1', 14), route('r2', 'PER', 'ac2', 7)],
  ...extra,
});
const save = (st) => store.set('bbae_save_v2', JSON.stringify(st));
const strip = (h) => h.replaceAll('<!-- -->', '');
const render = (C) => strip(renderToString(React.createElement(GameProvider, null, React.createElement(C))));

await test('a hub-bank world shows a card per hub with its connections and its setting', () => {
  save(baseState({ hubBanksWorld: true }));
  const html = render(ScheduleTimeline);
  assert.match(html, /class="hubbanks"/);
  assert.match(html, /Automatic \(4 banks a day\)/);
  const n = Number((html.match(/<strong>([\d,]+)<\/strong> connections a week/) ?? [])[1]?.replace(/,/g, ''));
  assert.ok(n > 0, `connections a week: ${n}`);
  assert.match(html, /decides who can connect/);
  assert.doesNotMatch(html, /is-offbank/, 'the automatic week makes every bank');
});

await test('Rolling: the card says so, and no aircraft wait for banks', () => {
  save(baseState({ hubBanksWorld: true, hubBanks: { SYD: { mode: 'rolling' } } }));
  const html = render(ScheduleTimeline);
  assert.match(html, /<option value="rolling" selected="">/);
  assert.match(html, /Rolling: flights leave whenever/);
  assert.doesNotMatch(html, /a day for banks/);
});

await test('outside a hub-bank world: no panel, and the timetable is for show', () => {
  save(baseState());
  const html = render(ScheduleTimeline);
  assert.doesNotMatch(html, /hubbank/);
  assert.match(html, /doesn&#x27;t change demand or costs/);
});

await test('a flight moved off its wave is marked and the card offers to snap it back', () => {
  const st = baseState({ hubBanksWorld: true });
  const w = airlineWeeks(scheduleInputsOf(st), 6).get('ac2');
  const pins = pinsAfterMove(w, 'r2', w.blocks[0], w.blocks[0].start + 95);
  const moved = { ...st, routes: st.routes.map(r => (r.id === 'r2' ? { ...r, schedule: { starts: pins } } : r)) };
  const w2 = airlineWeeks(scheduleInputsOf(moved), 6).get('ac2');
  assert.ok(w2.blocks.some(b => blockHubEvents(b, bankContextOf(moved)).some(e => !e.made)), 'fixture: one misses');
  save(moved);
  const html = render(ScheduleTimeline);
  assert.match(html, /is-offbank/);
  assert.match(html, /misses a bank at SYD/);
  assert.match(html, /you moved miss(es)? a bank here/);
  assert.match(html, /Snap (it|all) to the nearest bank/);
});

await test('the departure board reads the banked week', () => {
  const st = baseState({ hubBanksWorld: true });
  save(st);
  const html = render(Departures);
  // Banked SYD departures leave 30–70 min after a 07/11/15/19 bank.
  const times = [...html.matchAll(/>(\d\d):(\d\d)</g)].map(m => Number(m[1]) * 60 + Number(m[2]));
  assert.ok(times.length > 0, 'the board lists flights');
  const banks = [7, 11, 15, 19].map(h => h * 60);
  const onWave = times.filter(t => banks.some(b => t - b >= 25 && t - b <= 95));
  assert.ok(onWave.length > 0, `some departures on a wave: ${times.slice(0, 12).join(',')}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
