// Peak hours and layovers on screen — the Schedule page's flight panel (the
// hold control, the band each flight leaves and lands in, the route against
// the automatic timetable), the header shading, the setup tick box and Help.
// Peak-hour games only; an older game's panel is unchanged.
//
//   node --import ./tools/_register-loader.mjs tools/peak-hours-ui-test.mjs

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
const { default: ScheduleTimeline } = await import('../src/components/ScheduleTimeline.jsx');
const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const { getAircraftType } = await import('../packages/engine/src/data/aircraft.js');

const wide = getAircraftType('b7879');
const save = (routes, extra = {}) => store.set('bbae_save_v2', JSON.stringify({
  ...freshState(),
  phase: 'playing', week: 20, year: 2, hub: 'SYD', cash: 20_000_000, scheduleTrimVersion: 2,
  hubs: { SYD: { tier: 2, tierSince: 0 } }, gates: { SYD: 16, SIN: 6 }, competitors: [],
  fleet: [{ id: 'ac0', typeId: wide.id, tailNumber: 'VH-WID', status: 'assigned', ageWeeks: 52, ownershipType: 'owned', config: { economy: wide.seats } }],
  routes,
  ...extra,
}));
const sin = (schedule) => ({ id: 'r0', origin: 'SYD', destination: 'SIN', stops: ['SYD', 'SIN'], aircraftId: 'ac0',
  weeklyFrequency: 4, weeksOpen: 40, hub: 'SYD', cateringLevel: 'full', ...(schedule ? { schedule } : {}) });
const strip = (h) => h.replaceAll('<!-- -->', '');
const open = () => strip(renderToString(React.createElement(GameProvider, null,
  React.createElement(ScheduleTimeline, { initialSelection: { acId: 'ac0', routeId: 'r0', start: 0 } }))));

await test('a peak-hour world: the panel offers a hold at the far end and compares the route with the automatic timetable', () => {
  save([sin()], { peakHours: true });
  const html = open();
  assert.match(html, /Every flight: wait at SIN and leave at/);
  assert.match(html, /No hold: the aircraft leaves SIN after its minimum turnaround/);
  assert.match(html, /This route against the automatic timetable: business travellers ×1\.00, leisure ×1\.00,\s*landing fees as automatic/);
  assert.match(html, /leaves in the [a-z ]+(, lands in the (peak|day|evening|night) slot price)?/);
  assert.match(html, /class="sched-band is-peak"/, 'the header shades the peaks at the origin');
  assert.match(html, /nights are cheap but empty/);
});

await test('with a hold set: the time shows, it can be cleared, and the panel says how long the aircraft sits', () => {
  save([sin({ hold: 21 * 60 })], { peakHours: true });
  const html = open();
  assert.match(html, /id="sched-hold-SIN"[^>]*value="21:00"|value="21:00"[^>]*id="sched-hold-SIN"/);
  assert.match(html, />No hold</);
  assert.match(html, /On the ground at SIN for \d+h\d\d on this flight/);
  assert.match(html, /parking \$[\d,.KM]+ a week/);
  assert.match(html, /Reset all to automatic/, 'a hold counts as timing the route');
});

await test('an older world: no hold control, no comparison, no shading', () => {
  save([sin()]);
  const html = open();
  assert.doesNotMatch(html, /wait at SIN and leave at/);
  assert.doesNotMatch(html, /against the automatic timetable/);
  assert.doesNotMatch(html, /sched-band/);
  assert.match(html, /it doesn&#x27;t change demand or costs|it doesn't change demand or costs/);
});

await test('the world form has a Peak hours tick box, on by default, always sent, in the presets, with a lobby chip', () => {
  const s = src('../apps/headwinds-web/src/App.jsx');
  assert.match(s, /\[peakHours, setPeakHours\] = useState\(true\)/);
  assert.match(s, /\n\s+peakHours,\n/);                        // sent explicitly: absent means ON
  assert.match(s, />Peak hours\n/);
  assert.match(s, /key: 'peakhours',\s+on: \(w\) => w\.peakHours === true/);
  assert.equal((s.match(/peakHours: true, catering/g) ?? []).length, 3);   // standard, hardcore, sandbox
  assert.match(s, /hubBanks: false, peakHours: false, catering: false/);  // classic
});

await test('Help explains peak hours, holds and parking', () => {
  const s = src('../src/components/Wiki.jsx');
  assert.match(s, /\*\*Peak hours\*\* \(worlds tagged \*\*Peak hours\*\*\)/);
  assert.match(s, /\*\*hold\*\* its aircraft at the route/);
  assert.match(s, /parking by the hour/);
  assert.match(s, /rivals are scored on their own timetables/);
});

console.log(`\npeak-hours-ui-test: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
