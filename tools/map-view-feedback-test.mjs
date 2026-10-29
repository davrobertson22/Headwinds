// Map view rework from Barca's Discord feedback (2026-10-29).
//
//   node --import ./tools/_register-loader.mjs tools/map-view-feedback-test.mjs
//
//   0. The dark-screen bug: clicking a route on the globe flew the HIDDEN flat
//      map, whose never-measured size gave Leaflet a NaN centre; the throw in a
//      React effect unmounted the game. A hidden map must not fly — and must fly
//      once it is shown.
//   1. Airport focus: a click on an airport lights every route touching it.
//   2–9. The shell: one row for cash · last week · date · clock; Guide, Tutorial,
//      Discord top right; a big crest top left; alerts down the right edge with
//      the Dashboard's own texts; Map ⇄ Dashboard bottom left; the seven dock
//      groups, each one click, each page in exactly one, with the group's pages
//      as tabs in the panel header; classic deep links land on the right page.
//   Lag: the flat map's route glow has no CSS filter and the map view's floating
//      controls no backdrop blur.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}

const store = new Map();
globalThis.window = globalThis.window ?? {};
window.dispatchEvent = () => true;
window.addEventListener = () => {};
window.removeEventListener = () => {};
window.matchMedia = window.matchMedia ?? (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
globalThis.matchMedia = window.matchMedia;
globalThis.CustomEvent = globalThis.CustomEvent ?? class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

console.log('\nMap view feedback (Barca, 2026-10-29)\n');

const { claimRouteFly, routeKeysAtAirport } = await import('../src/components/RouteMap.jsx');

await test('0. a hidden flat map neither flies nor claims the focus; it flies once shown', () => {
  const ref = { current: null };
  assert.equal(claimRouteFly(ref, 'JFK~LHR', false), false, 'hidden under the globe: no fly');
  assert.equal(ref.current, null, 'and the focus is still unclaimed');
  assert.equal(claimRouteFly(ref, 'JFK~LHR', true), true, 'shown again: fly now');
  assert.equal(claimRouteFly(ref, 'JFK~LHR', true), false, 'once');
  assert.equal(claimRouteFly(ref, null, false), false);
  assert.equal(ref.current, null, 'clearing the focus works hidden too');
});

await test('1. an airport focus lights every route touching it, stops included', () => {
  const ap = (code) => ({ code });
  const groups = [
    { key: 'JFK~LHR', origin: ap('JFK'), dest: ap('LHR') },
    { key: 'LHR~DXB', origin: ap('LHR'), dest: ap('DXB') },
    { key: 'MCI~JFK~ORY', origin: ap('MCI'), dest: ap('ORY'), chain: [ap('MCI'), ap('JFK'), ap('ORY')] },
    { key: 'SFO~NRT', origin: ap('SFO'), dest: ap('NRT') },
  ];
  assert.deepEqual(routeKeysAtAirport(groups, 'JFK'), ['JFK~LHR', 'MCI~JFK~ORY']);
  assert.deepEqual(routeKeysAtAirport(groups, 'LHR'), ['JFK~LHR', 'LHR~DXB']);
  assert.deepEqual(routeKeysAtAirport(groups, 'BOS'), []);
  assert.deepEqual(routeKeysAtAirport(groups, null), []);
});

const React = (await import('react')).default;
const { renderToString } = await import('react-dom/server');
const { default: App } = await import('../src/App.jsx');
const { GameProvider, RemoteGameProvider, freshState } = await import('../src/store/GameContext.jsx');
const MapShellMod = await import('../src/components/MapShell.jsx');
const { default: MapShell, LAYOUT_KEY, MAP_GROUPS, MAP_PAGES, MAP_CHROME_PAGES, MAP_TAB, resolveMapPage } = MapShellMod;
const { requestNav, consumeNavFilter } = await import('../src/utils/navIntent.js');
const { requestDepartureBoard, takeDepartureBoardRequest } = await import('../src/components/Departures.jsx');
const { airlineAlerts, projectWeekShared } = await import('../src/utils/airlineAlerts.js');
const { default: Dashboard } = await import('../src/components/Dashboard.jsx');
const { default: Operations } = await import('../src/components/Operations.jsx');
const { default: Finance, FINANCE_GROUP_VIEWS } = await import('../src/components/Finance.jsx');
const { getAircraftType } = await import('../src/data/aircraft.js');
const { defaultConfig } = await import('../src/utils/simulation.js');

const t = getAircraftType('a320neo');
const idleTail = (i) => ({ id: `idle${i}`, typeId: 'a320neo', status: 'idle', ageWeeks: 10, ownershipType: 'owned', tailNumber: `N${i}ID`, name: t.name, config: defaultConfig(t.seats) });
const base = {
  ...freshState(),
  phase: 'playing', week: 5, year: 1, hub: 'SFO', cash: 12_345_678, airlineName: 'Pacific Gold',
  hubs: { SFO: { tier: 1, tierSince: 0 } }, gates: { SFO: 4 },
  fleet: [idleTail(1), idleTail(2)],
  lastReport: { ...(freshState().lastReport ?? {}), cashDelta: -1_250_000, routeResults: [] },
  activeEvents: [{ id: 'ev1', name: 'Fuel price spike', icon: '⛽', color: '#f59e0b', weeksLeft: 3, description: 'Jet fuel is up 20%.', effects: { fuelMult: 1.2 } }],
};
const strip = (h) => h.replaceAll('<!-- -->', '');
const renderApp = (state) => {
  store.set('bbae_save_v2', JSON.stringify(state));
  store.set('bbae_tour_seen_v3', '1');
  store.set(LAYOUT_KEY, 'map');
  store.set('headwinds.mapHintSeen', '1');
  return strip(renderToString(React.createElement(GameProvider, null, React.createElement(App))));
};
const inProvider = (state, el) => strip(renderToString(
  React.createElement(RemoteGameProvider, { state, dispatch: () => {}, remoteApi: {} }, el)));

await test('2/7. one status row: cash, last week\'s result, date, Next week', () => {
  const html = renderApp(base);
  const row = html.match(/<div class="ms-status[^"]*"[\s\S]*?<\/div>/)?.[0] ?? '';
  assert.ok(row.includes('$12.35M'), 'cash');
  assert.ok(/class="ms-delta down"[^>]*>−\$1\.25M/.test(row), 'last week, signed');
  assert.ok(row.includes('class="ms-date"'), 'date in the same row');
  assert.ok(/class="ms-next"[^>]*>Next week/.test(row), 'Next week in the same row');
  assert.ok(!html.includes('ms-rail'), 'no side rails left');
});

await test('2. no last-week chip before the first tick', () => {
  const html = renderApp({ ...base, lastReport: null });
  assert.ok(!html.includes('ms-delta'));
});

await test('8/9. Guide, Tutorial and Discord top right; a big crest top left', () => {
  const html = renderApp(base);
  const right = html.slice(html.indexOf('class="ms-top-right"'));
  for (const c of ['wiki', 'tutorial', 'discord', 'settings']) assert.ok(right.includes(`data-shell="${c}"`), c);
  assert.ok(/class="ms-crest"[\s\S]*?class="ms-crest-logo"[\s\S]*?Pacific Gold/.test(html), 'crest with the airline name');
});

await test('10. alerts down the right edge carry the Dashboard\'s own texts, and events', () => {
  const html = renderApp(base);
  const rail = html.slice(html.indexOf('class="ms-alerts"'), html.indexOf('data-shell="dashboard"'));
  assert.ok(rail.includes('data-alert="idle"'), 'idle aircraft alert');
  assert.ok(rail.includes('data-event="ev1"') && rail.includes('Fuel price spike'), 'the world event');
  assert.ok(/class="ms-alert-tip"/.test(rail), 'hover tooltip');
  const proj = projectWeekShared(JSON.parse(store.get('bbae_save_v2')));
  const dash = inProvider(base, React.createElement(Dashboard, { onNavigate: () => {} }));
  const texts = airlineAlerts(base, projectWeekShared(base)).map(a => a.text);
  assert.ok(texts.length >= 2, `expected several alerts, got ${texts.length}`);
  const esc = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#x27;');
  for (const x of texts) {
    assert.ok(dash.includes(esc(x)), `Dashboard shows: ${x}`);
    assert.ok(rail.includes(esc(x)), `map shows: ${x}`);
  }
  void proj;
});

await test('11. bottom left switches between the map and the Dashboard', () => {
  const html = renderApp(base);
  assert.ok(/data-shell="dashboard"[^>]*class="ms-home"|class="ms-home"[^>]*data-shell="dashboard"/.test(html));
  assert.ok(/class="ms-home"[\s\S]{0,400}<span>Dashboard<\/span>/.test(html));
});

await test('3/5. Barca\'s groups, each page in exactly one', () => {
  const got = Object.fromEntries(MAP_GROUPS.map(g => [g.label, g.pages]));
  assert.deepEqual(got, {
    Search:     ['finder', 'planner'],
    Network:    ['routes', 'airports', 'hubs', 'departures'],
    Fleet:      ['fleet', 'market', 'used'],
    World:      ['competition', 'alliances', 'stocks', 'news'],
    Operations: ['operations', 'maintenance', 'fuel'],
    Service:    ['marketing', 'catering', 'ancillaries', 'reputation', 'loyalty', 'partners'],
    Finance:    ['fin-statements', 'fin-planning', 'fin-analysis', 'fin-breakdown'],
  });
  const all = MAP_GROUPS.flatMap(g => g.pages);
  assert.equal(new Set(all).size, all.length, 'no page has two buttons');
  for (const p of Object.keys(MAP_PAGES)) assert.ok(all.includes(p) || MAP_CHROME_PAGES.includes(p), `${p} has a way in`);
});

await test('4. a group is one click and its pages are tabs in the panel header', () => {
  const pages = Object.fromEntries(Object.keys(MAP_PAGES).map(p => [p, React.createElement('div', { id: `page-${p}` })]));
  const shell = (activeTab, remote = false) => inProvider(base, React.createElement(MapShell, {
    state: base, remote, remoteChrome: null, tabs: {}, tabLabel: (id) => ({ finder: 'Route Finder', planner: 'Route Planner' }[id] ?? id),
    activeTab, navigate: () => {}, pages, footer: null, onAdvance() {}, countdown: '1m', onBranding() {}, onTour() {},
    onSave() {}, onLoad() {}, onNewGame() {}, onClassic() {}, discordHref: 'https://example.test',
  }));
  const html = shell('planner');
  assert.ok(html.includes('id="page-planner"'), 'the page');
  const tabs = html.match(/<div class="ms-tabs"[\s\S]*?<\/div>/)?.[0] ?? '';
  assert.ok(/aria-selected="false"[^>]*>Route Finder<|data-page="finder"[^>]*aria-selected="false"/.test(tabs), 'Route Finder tab');
  assert.ok(/data-page="planner"[^>]*aria-selected="true"/.test(tabs), 'Route Planner tab, selected');
  assert.ok(/data-shell="group:search"[^>]*aria-pressed="true"/.test(html), 'Search lit in the dock');
  assert.ok(!shell('competition').includes('data-page="news"'), 'News tab only in multiplayer');
  assert.ok(shell('competition', true).includes('data-page="news"'));
  assert.ok(!shell('marketing').includes('data-page="partners"'), 'Partnerships only in a partnerships world');
  assert.ok(!shell(MAP_TAB).includes('class="ms-panel"'), 'map only: no panel');
});

await test('deep links in classic tab ids land on the right map page', () => {
  assert.equal(resolveMapPage('map'), MAP_TAB);
  assert.equal(resolveMapPage('finance'), 'fin-statements');
  requestNav('finance', { filter: { view: 'fuel' } });
  assert.equal(resolveMapPage('finance'), 'fuel', 'the Dashboard fuel tile');
  assert.equal(consumeNavFilter('finance')?.view, 'fuel', 'peeked, not taken');
  requestNav('finance', { filter: { view: 'loans' } });
  assert.equal(resolveMapPage('finance'), 'fin-planning');
  consumeNavFilter('finance');
  assert.equal(resolveMapPage('operations'), 'operations', 'Crew');
  requestDepartureBoard('SFO');
  assert.equal(resolveMapPage('operations'), 'departures', 'an airport\'s departure board');
  assert.equal(takeDepartureBoardRequest(), 'SFO', 'peeked, not taken');
  for (const id of ['routes', 'fleet', 'market', 'airports', 'hubs', 'competition', 'dashboard', 'wiki']) assert.equal(resolveMapPage(id), id);
});

await test('Operations splits into Crew, Departures, Marketing and Catering; classic unchanged', () => {
  const ops = (section) => inProvider(base, React.createElement(Operations, section ? { section } : {}));
  const classic = ops(null);
  for (const s of ['Labor Groups', 'Marketing Budget', 'Catering Contracts', 'Departure Board']) assert.ok(classic.includes(s), `classic: ${s}`);
  const crew = ops('crew');
  assert.ok(crew.includes('Labor Groups') && !crew.includes('Marketing Budget') && !crew.includes('Catering Contracts') && !crew.includes('Departure Board'));
  const mk = ops('marketing');
  assert.ok(mk.includes('Brand Marketing') && !mk.includes('Labor Groups'));
  const ct = ops('catering');
  assert.ok(ct.includes('Catering Contracts') && !ct.includes('Labor Groups') && !ct.includes('Brand Marketing'));
  const board = ops('board');
  assert.ok(board.includes('Departure Board') && board.includes('Schedule') && !board.includes('Labour &amp; Costs'));
});

await test('Finance splits by group; Fuel stands alone', () => {
  const fin = (group) => inProvider(base, React.createElement(Finance, group ? { group } : {}));
  const planning = fin('planning');
  assert.ok(planning.includes('Forecast') && planning.includes('Loans') && !planning.includes('fin-group-tabs'));
  assert.deepEqual(FINANCE_GROUP_VIEWS.planning, ['forecast', 'loans'], 'Fuel is under Operations');
  assert.deepEqual(FINANCE_GROUP_VIEWS.fuel, ['fuel']);
  assert.ok(fin(null).includes('fin-group-tabs'), 'classic keeps its group bar');
});

await test('lag: no blur filter on route glows, no backdrop blur on map-view controls', () => {
  const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
  const glow = css.match(/\.route-glow\s*\{[^}]*\}/)?.[0] ?? '';
  assert.ok(!/filter/.test(glow), glow);
  const start = css.indexOf('/* Glass used by every floating control');
  const end = css.indexOf('/* ── Map-first opt-in');
  const ms = css.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/backdrop-filter:\s*blur/.test(ms), 'map view CSS blurs nothing behind its controls');
});

console.log(`\nmap-view-feedback-test: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
