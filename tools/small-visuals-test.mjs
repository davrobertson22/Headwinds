// Small visual touches (2026-11-05, Dave's picks 1, 2, 6, 7, 8):
//
//   1. Rankings: ▲/▼ beside each rank — the move since last week's Standing
//      snapshot (prevRank from the world payload)
//   2. Network map: "Colour: Profit / Load factor" — passenger lines by their
//      load-factor band, a key, remembered per browser, both views + map-first
//   6. Season progress: weeks flown of the world's length, the final 52 weeks
//      shaded — over the lobby standings and, compact, in the game's top bar
//   7. Fleet → On Order: each order's place on its production line
//   8. Dashboard: week-on-week arrows on Load Factor, passengers, Yield, Fleet
//
//   node --import ./tools/_register-loader.mjs tools/small-visuals-test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToString } from 'react-dom/server';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const strip = (h) => h.replaceAll('<!-- -->', '');
const store = new Map();
globalThis.window = globalThis.window ?? {};
window.dispatchEvent = () => true; window.addEventListener = () => {}; window.removeEventListener = () => {};
window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
globalThis.matchMedia = window.matchMedia;
globalThis.CustomEvent = globalThis.CustomEvent ?? class { constructor(t, i) { this.type = t; this.detail = i?.detail; } };
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear() };
window.localStorage = globalThis.localStorage;
let x = 4242;
Math.random = () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };

// ── 1. Rank arrows ───────────────────────────────────────────────────────────
console.log('\n── 1. Rank moves ───────────────────────────────────────────────');
const StandingsMod = await import('../apps/headwinds-web/src/StandingsTable.jsx');
const StandingsTable = StandingsMod.default;
const rows = [
  { rank: 1, id: 'a', name: 'Up Air', hub: 'JFK', status: 'ACTIVE', prevRank: 3 },
  { rank: 2, id: 'b', name: 'Down Air', hub: 'LHR', status: 'ACTIVE', prevRank: 1 },
  { rank: 3, id: 'c', name: 'Held Air', hub: 'SYD', status: 'ACTIVE', prevRank: 3 },
  { rank: 4, id: 'd', name: 'New Air', hub: 'DXB', status: 'ACTIVE', prevRank: null },
];
const standingsHtml = (ranking = null, status = 'RUNNING') => strip(renderToString(React.createElement(StandingsTable, {
  world: { id: 'w', status }, standings: rows, ranking, fallen: 0, mineId: null,
  sort: { key: 'avgProfit', dir: 'desc' }, onSort() {}, openRivalId: null, onToggleRival() {}, idleOf: () => null,
})));
const rowOf = (html, id) => { const i = html.indexOf(`data-airline-id="${id}"`); return html.slice(i, html.indexOf('</tr>', i)); };

await test('▲ for a climb, ▼ for a fall, nothing when it held or there is no last week', () => {
  const html = standingsHtml();
  assert.match(rowOf(html, 'a'), /class="rank-move up"[^>]*>▲2</);
  assert.match(rowOf(html, 'b'), /class="rank-move down"[^>]*>▼1</);
  assert.doesNotMatch(rowOf(html, 'c'), /rank-move/);
  assert.doesNotMatch(rowOf(html, 'd'), /rank-move/);
});
await test('the server sends last week\'s rank, from the Standing snapshot one week back', () => {
  const src = read('../apps/headwinds-server/src/routes/worlds.mjs');
  assert.match(src, /const thisWeek = \(world\.currentYear - 1\) \* 52 \+ world\.currentWeek;/);
  assert.match(src, /prisma\.standing\.findMany\(\{\s*where: \{ worldId: world\.id, week: prevWeek \}/);
  assert.match(src, /prevRank: prevRankById\.get\(a\.id\) \?\? null,/);
  // Matches the tick: it snapshots standings at the week it lands on.
  const tick = read('../apps/headwinds-server/src/lib/tickService.mjs');
  assert.match(tick, /week: toIndex,\s*rank: i \+ 1,/);
  assert.match(tick, /export const weekIndex = \(world\) =>\s*\(world\.currentYear - 1\) \* WEEKS_PER_YEAR \+ world\.currentWeek;/);
});

// ── 6. Season progress ───────────────────────────────────────────────────────
console.log('\n── 6. Season progress ──────────────────────────────────────────');
const { default: SeasonProgress, seasonLine } = await import('../src/components/SeasonProgress.jsx');
await test('the line matches the standings rule: final stretch is the last 52 weeks', () => {
  assert.equal(seasonLine({ weeksFlown: 37, totalWeeks: 104 }), 'Week 38 of 104 · final stretch in 15 weeks');
  assert.equal(seasonLine({ weeksFlown: 60, totalWeeks: 104 }), 'Week 61 of 104 · final stretch, 44 weeks left');
  assert.equal(seasonLine({ weeksFlown: 104, totalWeeks: 104 }), 'Season over · 104 weeks flown');
});
await test('the bar fills to the weeks flown; compact reads N/total', () => {
  const full = strip(renderToString(React.createElement(SeasonProgress, { weeksFlown: 26, totalWeeks: 104 })));
  assert.match(full, /data-season-fill="25"/);
  assert.match(full, /Week 27 of 104/);
  const compact = strip(renderToString(React.createElement(SeasonProgress, { weeksFlown: 26, totalWeeks: 104, compact: true })));
  assert.match(compact, />27\/104</);
  assert.equal(strip(renderToString(React.createElement(SeasonProgress, { weeksFlown: 3, totalWeeks: 0 }))), '');
});
await test('lobby: shown over a RUNNING world\'s standings; game bar: beside the clock', () => {
  assert.match(standingsHtml({ totalWeeks: 104, weeksFlown: 50, weeksUntilFinalStretch: 2 }), /class="season-progress"/);
  assert.doesNotMatch(standingsHtml({ totalWeeks: 104, weeksFlown: 104 }, 'ENDED'), /class="season-progress"/);
  assert.match(read('../apps/headwinds-server/src/routes/worlds.mjs'), /totalWeeks: worldTotalWeeks\(world\),\s*weeksFlown: weeksFlownOf\(world\),/);
  assert.match(read('../apps/headwinds-server/src/routes/decisions.mjs'), /totalWeeks: worldTotalWeeks\(world\),\s*\},\s*stamp,/);
  assert.match(read('../apps/headwinds-web/src/GamePlayScreen.jsx'), /<SeasonProgress compact totalWeeks=\{meta\.worldClock\.totalWeeks\}/);
});

// ── 2. Load-factor colours ───────────────────────────────────────────────────
console.log('\n── 2. Colour routes by load factor ─────────────────────────────');
const C = await import('../src/utils/routeColour.js');
const RM = await import('../src/components/RouteMap.jsx');
const { PROFIT_COLOR, LOSS_COLOR, TAG_COLOR, CARGO_COLOR, CONTESTED_COLOR } = await import('../src/components/mapCore.js');
await test('bands run cool to hot, with no profit green, loss red or freight amber', () => {
  assert.equal(C.loadFactorColor(0.3), C.LF_BANDS[0].color);
  assert.equal(C.loadFactorColor(0.5), C.LF_BANDS[1].color, '50% is the second band');
  assert.equal(C.loadFactorColor(0.79), C.LF_BANDS[2].color);
  assert.equal(C.loadFactorColor(0.95), C.LF_BANDS[4].color);
  assert.equal(C.loadFactorColor(NaN), C.LF_BANDS[0].color);
  for (const b of C.LF_BANDS) assert.ok(![PROFIT_COLOR, LOSS_COLOR, CARGO_COLOR, CONTESTED_COLOR, TAG_COLOR].includes(b.color), b.color);
  assert.equal(C.normalizeColourMode('lf'), 'lf');
  assert.equal(C.normalizeColourMode('nonsense'), 'profit');
});
await test('routeGroupColor: profit by default, the band in lf mode, multi-stop always purple', () => {
  const g = { hasResult: true, profit: -5, loadFactor: 0.92 };
  assert.equal(RM.routeGroupColor(g), LOSS_COLOR);
  assert.equal(RM.routeGroupColor(g, 'lf'), C.loadFactorColor(0.92));
  assert.equal(RM.routeGroupColor({ ...g, multi: true }, 'lf'), TAG_COLOR);
  assert.equal(RM.routeGroupColor({ hasResult: false, loadFactor: 0 }, 'lf'), C.LF_BANDS[0].color);
});
await test('every map draw goes through the mode: flat lines, recolour, globe, planes', () => {
  const src = read('../src/components/RouteMap.jsx');
  assert.equal((src.match(/routeGroupColor\(g, colorModeRef\.current\)/g) ?? []).length, 2, 'flat draw + in-place recolour');
  assert.match(src, /color: routeGroupColor\(g, colorMode\),/);
  assert.match(src, /colorOf: \(g\) => routeGroupColor\(g, colorMode\)/);
});
const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const { AIRCRAFT_TYPES } = await import('../src/data/aircraft.js');
const jet = AIRCRAFT_TYPES.find(t => !t.freighter && t.category === 'Narrow Body');
const mapSave = { ...freshState(), phase: 'playing', week: 20, year: 2, hub: 'DXB', cash: 2e7, scheduleTrimVersion: 1,
  hubs: { DXB: { tier: 2, tierSince: 0 } }, gates: { DXB: 16, LHR: 6 },
  fleet: [{ id: 'ac0', typeId: jet.id, name: 'T0', tailNumber: 'A6T', status: 'assigned', ageWeeks: 52, ownershipType: 'owned', config: { economy: jet.seats } }],
  routes: [{ id: 'r0', origin: 'DXB', destination: 'LHR', stops: ['DXB', 'LHR'], aircraftId: 'ac0', weeklyFrequency: 14, weeksOpen: 40, hub: 'DXB', cateringLevel: 'full' }] };
const renderMap = (props = {}) => { store.set('bbae_save_v2', JSON.stringify(mapSave)); return strip(renderToString(React.createElement(GameProvider, null, React.createElement(RM.default, props)))); };
const colourTag = (html) => (html.match(/<button[^>]*data-map-colour-toggle[^>]*>/) ?? [null])[0];
for (const view of ['flat', 'globe']) {
  await test(`${view}: the switch is offered, profit by default with its key`, () => {
    store.set(RM.MAP_VIEW_KEY, view); store.delete(C.ROUTE_COLOUR_KEY);
    const html = renderMap();
    assert.match(colourTag(html), /aria-pressed="false"/);
    assert.match(html, />Profitable</);
    assert.doesNotMatch(html, /data-map-lf-key/);
  });
  await test(`${view}: remembered load-factor mode shows the band key instead`, () => {
    store.set(RM.MAP_VIEW_KEY, view); store.set(C.ROUTE_COLOUR_KEY, 'lf');
    const html = renderMap();
    assert.match(colourTag(html), /aria-pressed="true"/);
    assert.match(html, /data-map-lf-key/);
    for (const b of C.LF_BANDS) assert.ok(html.includes(b.color));
    assert.doesNotMatch(html, />Profitable</);
  });
}
await test('map-first layout: a Load chip, and a compact key when it is on', () => {
  store.set(RM.MAP_VIEW_KEY, 'globe'); store.set(C.ROUTE_COLOUR_KEY, 'lf');
  const html = renderMap({ fullBleed: true });
  assert.match(colourTag(html), /map-bleed-chip on/);
  assert.match(html, /data-map-lf-key/);
  store.delete(C.ROUTE_COLOUR_KEY);
});

// ── 7. Production-line place ─────────────────────────────────────────────────
console.log('\n── 7. Orders: place on the production line ─────────────────────');
const { orderLinePlace } = await import('../src/utils/lineQueue.js');
const { lineOf, lineInfo } = await import('../packages/engine/src/data/productionLines.js');
const LinePlace = (await import('../src/components/LinePlace.jsx')).default;
const line = lineOf('b737800');
const mine = { id: 'o2', typeId: 'b737800', deliverAbsWeek: 120 };
const lineState = {
  productionLinesWorld: true,
  lineBook: { bookings: { [line]: { 101: 2, 110: 3, 120: 1, 130: 4 } } },
  pendingOrders: [{ id: 'o1', typeId: 'b737800', deliverAbsWeek: 115 }, mine, { id: 'o3', typeId: 'a380', deliverAbsWeek: 105 }],
  fleet: [],
};
await test('frames ahead: every airline\'s bookings on the line before yours, yours counted too', () => {
  const p = orderLinePlace(lineState, mine, 100);
  assert.equal(p.lineId, line);
  assert.equal(p.lineName, lineInfo(line).name);
  assert.equal(p.ahead, 2 + 3 + 1, 'rivals 101 + 110, your own 115; the A380 is another line');
  assert.equal(p.yoursAhead, 1);
  assert.equal(p.alongside, 1, 'one rival frame in your own week');
  assert.equal(p.weeksOut, 20);
});
await test('nothing outside production-line worlds, or for a used aircraft', () => {
  assert.equal(orderLinePlace({ ...lineState, productionLinesWorld: false }, mine, 100), null);
  assert.equal(orderLinePlace(lineState, { ...mine, used: true }, 100), null);
});
await test('the strip: a cell per frame ahead (capped), yours last, and the words', () => {
  const html = strip(renderToString(React.createElement(LinePlace, { place: orderLinePlace(lineState, mine, 100) })));
  assert.match(html, /data-line-ahead="6"/);
  assert.match(html, /6 frames ahead \(1 yours\) on the /);
  const many = strip(renderToString(React.createElement(LinePlace, { place: { ahead: 40, yoursAhead: 0, alongside: 0, lineName: 'X', weeksOut: 9 } })));
  assert.match(many, />\+29</);
  assert.match(strip(renderToString(React.createElement(LinePlace, { place: { ahead: 0, yoursAhead: 0, alongside: 0, lineName: 'X', weeksOut: 1 } }))), /Next off the X line/);
  assert.match(read('../src/components/Fleet.jsx'), /<LinePlace place=\{orderLinePlace\(state, order, currentAbsWeek\)\} \/>/);
});

// ── 8. Dashboard week-on-week ────────────────────────────────────────────────
console.log('\n── 8. Dashboard: week-on-week arrows ───────────────────────────');
const { gameReducer } = await import('../packages/engine/src/reducer.mjs');
const { projectWeek } = await import('../packages/engine/src/utils/financeProjection.js');
const { defaultClassPrices } = await import('../packages/engine/src/utils/simulation.js');
const { referencePrice } = await import('../packages/engine/src/utils/market.js');
const { getAircraftType } = await import('../src/data/aircraft.js');
const Dash = await import('../src/components/Dashboard.jsx');
function airline() {
  let s = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'Probe Air', hub: 'JFK', enableObjectives: false });
  s = { ...s, cash: 5e9 };
  for (let i = 0; i < 6; i++) s = gameReducer(s, { type: 'ADD_GATE', airportCode: 'JFK' });
  for (const d of ['ORD', 'LAX', 'MIA']) {
    s = gameReducer(s, { type: 'BUY_AIRCRAFT', typeId: 'b737800' });
    s = gameReducer(s, { type: 'ADD_GATE', airportCode: d });
    s = gameReducer(s, { type: 'ADD_ROUTE', aircraftId: s.fleet.at(-1).id, origin: 'JFK', destination: d, weeklyFrequency: 21 });
  }
  const rp = { ...s.routePricing };
  for (const d of ['ORD', 'LAX', 'MIA']) rp[['JFK', d].sort().join('-')] = defaultClassPrices(Math.round(referencePrice('JFK', d) * 1.1));
  return { ...s, routePricing: rp, fleet: s.fleet.map(a => ({ ...a, config: { ...a.config, economy: getAircraftType(a.typeId).seats } })) };
}
let st = airline();
for (let i = 0; i < 3; i++) st = gameReducer(st, { type: 'ADVANCE_WEEK' });
// Change something so this week differs from last: a fare cut on one pair.
st = { ...st, routePricing: { ...st.routePricing, 'JFK-ORD': defaultClassPrices(Math.round(referencePrice('JFK', 'ORD') * 0.8)) } };
const dashHtml = (s) => { store.set('bbae_save_v2', JSON.stringify(s)); return strip(renderToString(React.createElement(GameProvider, null, React.createElement(Dash.default)))); };
const tile = (html, key) => { const i = html.indexOf(`data-kpi="${key}"`); return i < 0 ? null : html.slice(i, html.indexOf('class="stat-box"', i + 10) > 0 ? html.indexOf('class="stat-box"', i + 10) : i + 1500); };
await test('the arithmetic: this week (projected) against last week, same formula both sides', () => {
  const now = Dash.networkStatsOf(projectWeek(st).report);
  const last = Dash.networkStatsOf(st.lastReport);
  const w = Dash.weekOnWeek(now, last);
  assert.ok(Math.abs(w.loadFactorPt - (now.loadFactor - last.loadFactor) * 100) < 1e-9);
  assert.ok(Math.abs(w.paxPct - ((now.boardedPax - last.boardedPax) / last.boardedPax) * 100) < 1e-9);
  assert.deepEqual(Dash.weekOnWeek(now, null), { loadFactorPt: null, paxPct: null, yieldPct: null });
});
await test('Dashboard (SSR): Load Factor and Yield tiles carry the arrows the arithmetic gives', () => {
  const html = dashHtml(st);
  const w = Dash.weekOnWeek(Dash.networkStatsOf(projectWeek(st).report), Dash.networkStatsOf(st.lastReport));
  const lf = tile(html, 'load-factor');
  assert.ok(lf, 'load factor tile');
  if (Math.abs(w.loadFactorPt) >= 0.05) {
    assert.match(lf, new RegExp(`data-trend="${w.loadFactorPt}"`));
    assert.match(lf, new RegExp(`${w.loadFactorPt >= 0 ? '↑' : '↓'} ${Math.abs(w.loadFactorPt).toFixed(1)}pt`));
  }
  assert.ok(Math.abs(w.yieldPct) >= 0.05, 'fixture: the fare cut moves yield');
  assert.match(tile(html, 'yield'), new RegExp(`data-trend="${w.yieldPct}"`));
});
await test('Dashboard (SSR): Fleet shows aircraft added since last week; none before the first week', () => {
  let s2 = gameReducer(st, { type: 'BUY_AIRCRAFT', typeId: 'b737800' });
  s2 = gameReducer(s2, { type: 'BUY_AIRCRAFT', typeId: 'b737800' });
  const added = s2.fleet.length - s2.statsHistory.at(-1).fleet;
  assert.ok(added > 0, 'fixture: bought aircraft arrive at once');
  assert.match(tile(dashHtml(s2), 'fleet'), new RegExp(`data-trend="${added}"[^>]*>↑ ${added}<`));
  assert.doesNotMatch(tile(dashHtml(airline()), 'load-factor') ?? '', /data-trend/, 'no last week → no arrow');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
