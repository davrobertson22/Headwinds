// Screen guide — where every page is, for the airline briefing (src/screenGuide.js).
//
// vrt1ty (Discord, 2026-11-09): an AI reading the briefing "doesn't always know
// where to find something; for example, fuel, which is in the finance section".
// The briefing now ends with every page's location in BOTH layouts, and every
// Advisor tip names its exact sub-page and filter. A guide that sends an AI to
// a page that has moved is worse than none, so this pins every path to the
// real navigation:
//   - every classic tab (navPath.js, itself pinned to App.jsx) has an entry
//   - every map-view page has a path, and each one matches MapShell's own
//     group + page labels
//   - the sub-tab names it quotes exist in Operations.jsx / Finance.jsx, and
//     the Routes filter names in Routes.jsx
//   - every Advisor action resolves to a full path
//
// Verified failing on HEAD (2026-11-09): src/screenGuide.js did not exist, and
// the briefing named only top-level tabs ("In game: Finance" for fuel).
//
//   node --import ./tools/_register-loader.mjs tools/screen-guide-test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = globalThis.window ?? { addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } };
const mem = new Map();
globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };

let x = 7;
Math.random = () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };

const { SCREEN_GUIDE, MAP_VIEW_PATHS, screenGuide, actionPaths, actionPathText } = await import('../src/screenGuide.js');
const { TAB_LABELS, NAV_SEP } = await import('../src/navPath.js');
const { MAP_GROUPS, MAP_PAGES, MAP_CHROME_PAGES } = await import('../src/components/MapShell.jsx');
const { gameReducer, freshState } = await import('../packages/engine/src/reducer.mjs');
const { airlineAdvice } = await import('../packages/engine/src/models/advisor.js');
const { airlineBriefing } = await import('../packages/engine/src/models/briefing.js');

const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const S = ` ${NAV_SEP} `;
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}

console.log('\nScreen guide (where every page is)\n');

test('every classic tab has an entry, so a new tab cannot be left out of the guide', () => {
  const covered = new Set(SCREEN_GUIDE.map(e => e.tab).filter(Boolean));
  for (const tab of Object.keys(TAB_LABELS)) assert.ok(covered.has(tab), `no guide entry for the "${tab}" tab`);
});

test('every map-view page has a path, matching MapShell\'s own group and page labels', () => {
  for (const g of MAP_GROUPS) {
    for (const page of g.pages) {
      const label = MAP_PAGES[page].label ?? TAB_LABELS[MAP_PAGES[page].tab];
      assert.equal(MAP_VIEW_PATHS[page], `${g.label}${S}${label}`, `map path for ${page}`);
    }
  }
  for (const p of MAP_CHROME_PAGES) assert.ok(MAP_VIEW_PATHS[p], `chrome page ${p} needs a description`);
  for (const e of SCREEN_GUIDE) if (e.map) assert.ok(MAP_VIEW_PATHS[e.map] && MAP_PAGES[e.map], `${e.key} → unknown map page ${e.map}`);
});

test('the sub-tab names quoted are the ones the pages show', () => {
  const ops = src('src/components/Operations.jsx');
  for (const l of ['Labour & Costs', 'Departure Board', 'Schedule']) assert.ok(ops.includes(`label: '${l}'`), `Operations sub-tab ${l}`);
  // the map view's Departures page keeps the Schedule tab (only Labour & Costs is dropped)
  assert.match(ops, /section === 'board' \? SUB_TABS\.filter\(t => t\.id !== 'labor'\)/);
  const fin = src('src/components/Finance.jsx');
  for (const l of ['Statements', 'Planning', 'Analysis', 'Breakdown']) assert.ok(fin.includes(`label: '${l}'`), `Finance group ${l}`);
  assert.match(fin, /id: 'planning',\s+label: 'Planning',\s+views: \[[^\]]*'fuel'/);
  for (const v of ['Loans', 'Forecast', 'Fuel']) assert.ok(new RegExp(`label: '[^']*${v}'`).test(fin), `Finance view ${v}`);
  const routes = src('src/components/Routes.jsx');
  for (const l of ['Profit', 'Losing', 'Low Load']) assert.ok(new RegExp(`label: '[^']*${l}'`).test(routes), `Routes filter ${l}`);
});

test('vrt1ty\'s example: fuel is Finance ▸ Planning ▸ Fuel, and Operations ▸ Fuel in the map view', () => {
  const fuel = screenGuide(null).find(e => e.key === 'fuel');
  assert.equal(fuel.classic, `Finance${S}Planning${S}Fuel`);
  assert.equal(fuel.map, `Operations${S}Fuel`);
  assert.match(fuel.what, /hedge/);
});

test('Advisor actions resolve to the exact sub-page and filter, not just the tab', () => {
  assert.equal(actionPathText({ to: 'finance', filter: { view: 'fuel' } }), `Finance${S}Planning${S}Fuel (map view: Operations${S}Fuel)`);
  assert.equal(actionPaths({ to: 'finance', filter: { view: 'loans' } }).classic, `Finance${S}Planning${S}Loans / Forecast`);
  const mk = actionPaths({ to: 'operations', filter: { section: 'marketing' } });
  assert.equal(mk.classic, `Company${S}Operations${S}Labour & Costs`);
  assert.equal(mk.map, `Service${S}Marketing`);
  assert.match(actionPathText({ to: 'routes', filter: { filterTab: 'unprofitable' } }), /Network ▸ Routes \(the Losing filter\)/);
  assert.equal(actionPathText({ to: 'finder', filter: { typeId: 'b737800' } }), `Network${S}Route Finder (map view: Search${S}Route Finder)`);
  assert.equal(actionPaths({ to: 'nowhere' }), null);
});

test('every action the Advisor can produce has a path', () => {
  // Every destination advisor.js can send a player to (its `to:` targets) must
  // resolve; the filtered variants (fuel, loans, marketing, route filters) are
  // pinned one by one in the test above.
  const adv = src('packages/engine/src/models/advisor.js');
  const targets = new Set([...adv.matchAll(/\bto: '([a-z]+)'/g)].map(m => m[1]));
  assert.ok(targets.size >= 8, `found only ${targets.size} targets: ${[...targets]}`);
  assert.ok(targets.has('finder'), 'the Route Finder deep link should be among them');
  for (const to of targets) assert.ok(actionPaths({ to }), `no path for ${to}`);
});

test('the guide follows the airline: News only in multiplayer, Partnerships only in partnership worlds, Rivals by name', () => {
  assert.ok(!screenGuide(null).some(e => e.key === 'news'));
  assert.ok(screenGuide(null, { remote: true }).some(e => e.key === 'news'));
  assert.ok(!screenGuide({}, { remote: true }).some(e => e.key === 'partners'));
  assert.ok(screenGuide({ partnershipsWorld: true }, { remote: true }).some(e => e.key === 'partners'));
  const rivals = screenGuide(null, { remote: true }).find(e => e.key === 'competition');
  assert.equal(rivals.classic, `Company${S}Rivals`);
  assert.equal(rivals.map, `World${S}Rivals`);
});

test('the briefing carries the guide and exact paths on every tip', () => {
  let s = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'Guide Air', hub: 'JFK', enableObjectives: false });
  s = gameReducer({ ...s, cash: 5e8 }, { type: 'BUY_AIRCRAFT', typeId: 'b737800' });
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  s = { ...s, awareness: 5, routes: [] };
  const advice = airlineAdvice(s, s.lastReport);
  const b = airlineBriefing(s, {
    advice, screens: screenGuide(s), actionPath: (a) => actionPathText(a),
  });
  assert.match(b, /## Where things are in the game/);
  assert.match(b, /\| Finance ▸ Planning ▸ Fuel \| Operations ▸ Fuel \|/);
  assert.match(b, /tell the player exactly where to click/);
  for (const a of advice.filter(a => a.action)) assert.ok(b.includes(`(Where: ${actionPathText(a.action)})`), a.id);
  // without a guide (an old caller) it still names the tab
  assert.ok(!airlineBriefing(s, { advice }).includes('## Where things are'));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
