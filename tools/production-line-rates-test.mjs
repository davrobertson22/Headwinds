// Production lines: per-world production rates. Whoever creates a world may set
// the frames-a-week for each size class and, below that, for any single line
// (A380, 737 MAX …). A blank keeps the default (class rate × the world's player
// scale). The rate set at creation is baked into every airline at join, rides
// the rival view, and the in-transaction race check uses the same numbers, so
// the market card, the checkout and the server never disagree.
//
//   node --import ./tools/_register-loader.mjs tools/production-line-rates-test.mjs

import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
globalThis.window ??= {
  localStorage: globalThis.localStorage,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
};

const { gameReducer, freshState } = await import('../packages/engine/src/reducer.mjs');
const { absoluteWeek } = await import('../packages/engine/src/utils/fuel.js');
const { getAircraftType } = await import('../packages/engine/src/data/aircraft.js');
const L = await import('../packages/engine/src/data/productionLines.js');
const { seedAirlineState, createWorld } = await import('../apps/headwinds-server/src/lib/worldService.mjs');
const { validateWorldConfig, serializeWorld } = await import('../apps/headwinds-server/src/lib/worldConfig.mjs');
const { buildRivalViews } = await import('../apps/headwinds-server/src/lib/humanRivals.mjs');
const svc = await import('../apps/headwinds-server/src/lib/productionLineService.mjs');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
const has = (name) => assert.equal(typeof L[name], 'function', `productionLines.js has no ${name}()`);
const cap = (typeId, o) => L.lineCapacity(L.lineOf(typeId), o);

await t('a class rate replaces the default and ignores the player scale', () => {
  const rates = { classes: { 'Wide Body': 2 } };
  assert.equal(cap('b7879', { rates }), 2);
  assert.equal(cap('b7879', { rates, scale: 1.5 }), 2, 'the creator typed 2, so 2 it is');
  assert.equal(cap('b737800', { rates }), 8, 'other classes keep their default');
  assert.equal(cap('b737800', { rates, scale: 1.5 }), 12);
});

await t('a line rate beats its class rate', () => {
  const rates = { classes: { 'Double Deck': 4 }, lines: { a380: 1 } };
  assert.equal(cap('a380', { rates }), 1);
  assert.equal(cap('b7478i', { rates }), 4, 'the 747-8 (Double Deck) takes the class rate');
  assert.equal(cap('b7879', { rates }), 5, 'other classes untouched');
});

await t('a custom line still ramps on backlog, to the class ceiling ratio', () => {
  const rates = { lines: { b787: 2 } };
  assert.equal(cap('b7879', { rates, backlogFrames: 2 * 26 }), 2);
  assert.equal(cap('b7879', { rates, backlogFrames: 2 * 27 }), 3);
  assert.equal(cap('b7879', { rates, backlogFrames: 2 * 500 }), 3, 'ceiling = round(2 × 8/5) = 3');
  assert.equal(cap('b7879', { rates: { lines: { b787: 20 } }, backlogFrames: 20 * 500 }), 32);
});

await t('no rates = exactly the old numbers', () => {
  for (const [id, n] of [['atr72', 10], ['b737800', 8], ['b7879', 5], ['a380', 3], ['b767200sf', 2]]) {
    assert.equal(cap(id, { rates: null }), n, id);
    assert.equal(cap(id, { rates: {} }), n, id);
  }
});

await t('normalizeLineRates keeps whole numbers in range and drops blanks; lineRatesProblem names the bad one', () => {
  has('normalizeLineRates'); has('lineRatesProblem');
  assert.deepEqual(
    L.normalizeLineRates({ classes: { 'Wide Body': '3', Turboprop: '', 'Narrow Body': null }, lines: { a380: 1, b787: '' } }),
    { classes: { 'Wide Body': 3 }, lines: { a380: 1 } });
  assert.equal(L.normalizeLineRates({ classes: {}, lines: {} }), null, 'nothing set → no key at all');
  assert.equal(L.normalizeLineRates(null), null);
  assert.equal(L.lineRatesProblem({ classes: { 'Wide Body': 3 }, lines: { a380: 1 } }), null);
  assert.match(L.lineRatesProblem({ classes: { 'Wide Body': 0 } }), /Wide Body/);
  assert.match(L.lineRatesProblem({ lines: { a380: L.MAX_LINE_RATE + 1 } }), /Airbus A380/);
  assert.match(L.lineRatesProblem({ lines: { a380: 1.5 } }), /whole number/);
  assert.match(L.lineRatesProblem({ lines: { nope: 2 } }), /nope/);
  assert.match(L.lineRatesProblem({ classes: { Blimp: 2 } }), /Blimp/);
  assert.match(L.lineRatesProblem('fast'), /object/);
});

await t('lineRateDefaults: what a blank shows in the form, per class and per line', () => {
  has('lineRateDefaults');
  const d = L.lineRateDefaults({ scale: 1.5, rates: { classes: { 'Wide Body': 2 } } });
  assert.equal(d.classes['Wide Body'], 8, 'class placeholder = scaled default, not the override');
  assert.equal(d.lines.b787, 2, 'line placeholder = its class value, override included');
  assert.equal(d.lines.a380, 5);
  assert.equal(Object.keys(d.lines).length, Object.keys(L.PRODUCTION_LINES).length);
});

const nowAbs = (s) => absoluteWeek(s.year, s.week);
const linesWorld = (extra = {}) => ({ ...freshState(), hub: 'JFK', cash: 50_000_000_000, productionLinesWorld: true, productionLineScale: 1, ...extra });
const order = (st, typeId) => gameReducer(st, { type: 'ORDER_AIRCRAFT', typeId, quantity: 1, ownershipType: 'owned' });

await t('the reducer books against the world rate (state.productionLineRates)', () => {
  const base = linesWorld();
  const standard = L.makeSlotAllocator(base, getAircraftType('b7879'), { absWeek: nowAbs(base) }).standard;
  const rival = { scale: 1, bookings: { b787: { [standard]: 1 } } };
  const dflt = order({ ...base, lineBook: rival }, 'b7879');
  assert.equal(dflt.pendingOrders.at(-1).deliverAbsWeek, standard, 'default 5/wk: room alongside the rival');
  const tight = order({ ...base, productionLineRates: { lines: { b787: 1 } }, lineBook: rival }, 'b7879');
  assert.equal(tight.pendingOrders.at(-1).deliverAbsWeek, standard + 1, '1/wk: the rival has the week');
  const viaBook = order({ ...base, lineBook: { ...rival, rates: { lines: { b787: 1 } } } }, 'b7879');
  assert.equal(viaBook.pendingOrders.at(-1).deliverAbsWeek, standard + 1, 'the rival view carries the rates too');
});

await t('lineStatus (market card) shows the world rate', () => {
  const st = linesWorld({ productionLineRates: { classes: { 'Wide Body': 2 } } });
  assert.equal(L.lineStatus(st, 'b7879', nowAbs(st)).capacity, 2);
});

await t('lineConflicts (race check) uses the world rate', () => {
  const pending = [{ id: 'n', typeId: 'b7879', lineId: 'b787', deliverAbsWeek: 50 }];
  const args = { othersBookings: { b787: { 50: 1 } }, pendingOrders: pending, newOrderIds: ['n'], absWeek: 10 };
  assert.deepEqual(L.lineConflicts(args), []);
  assert.equal(L.lineConflicts({ ...args, rates: { lines: { b787: 1 } } }).length, 1);
});

const world = (tickConfig = {}) => ({ id: 'w', currentYear: 1, currentWeek: 1, maxPlayers: 50, tickConfig });

await t('validateWorldConfig refuses bad rates', () => {
  const ok = { lengthYears: 50, weeksPerDay: 24 };
  assert.doesNotThrow(() => validateWorldConfig({ ...ok, productionLineRates: { classes: { 'Wide Body': 3 } } }));
  assert.throws(() => validateWorldConfig({ ...ok, productionLineRates: { classes: { 'Wide Body': 0 } } }), /Wide Body/);
  assert.throws(() => validateWorldConfig({ ...ok, productionLineRates: { lines: { zzz: 2 } } }), /zzz/);
  assert.throws(() => validateWorldConfig({ ...ok, productionLines: false, productionLineRates: { lines: { a380: 2 } } }), /production lines/i);
});

await t('createWorld stores the rates (only when set), join bakes them in, the lobby can see them', async () => {
  const made = [];
  const prisma = { world: { create: async ({ data }) => { made.push(data); return data; } } };
  await createWorld(prisma, { lengthYears: 50, weeksPerDay: 24, productionLineRates: { classes: { 'Wide Body': '2', Turboprop: '' }, lines: { a380: 1 } } });
  await createWorld(prisma, { lengthYears: 50, weeksPerDay: 24, productionLineRates: { classes: { Turboprop: '' } } });
  assert.deepEqual(made[0].tickConfig.productionLineRates, { classes: { 'Wide Body': 2 }, lines: { a380: 1 } });
  assert.equal('productionLineRates' in made[1].tickConfig, false, 'all blank = no key');
  const s = seedAirlineState(world(made[0].tickConfig), { airlineName: 'A', hub: 'JFK' });
  assert.deepEqual(s.productionLineRates, { classes: { 'Wide Body': 2 }, lines: { a380: 1 } });
  const plain = seedAirlineState(world(made[1].tickConfig), { airlineName: 'B', hub: 'JFK' });
  assert.equal('productionLineRates' in plain, false);
  assert.deepEqual(serializeWorld({ ...world(made[0].tickConfig), name: 'x', status: 'OPEN' }, { playerCount: 0 }).productionLineRates,
    { classes: { 'Wide Body': 2 }, lines: { a380: 1 } });
});

const row = (id, pending = [], rates = { lines: { b787: 1 } }) => ({
  id, name: id, hub: 'JFK', status: 'ACTIVE', restarts: 0,
  account: { isOG: false, isSupporter: false, email: `${id}@x.test` },
  state: { productionLinesWorld: true, productionLineScale: 1, productionLineRates: rates,
    hub: 'JFK', routes: [], cargoRoutes: [], fleet: [], pendingOrders: pending, financialHistory: [], statsHistory: [] },
});
const o787 = (id, w) => ({ id, typeId: 'b7879', lineId: 'b787', deliverAbsWeek: w, ownershipType: 'owned' });

await t('the rival view carries the rates', () => {
  const views = buildRivalViews([row('me'), row('b', [o787('b1', 40)])]);
  assert.deepEqual(views.get('me').lineBook.rates, { lines: { b787: 1 } });
});

await t('the in-transaction re-check holds a 1-a-week line to one frame a week', async () => {
  const tx = { airline: { findMany: async () => [row('me'), row('r', [o787('r1', 50)])] } };
  const mine = [o787('n1', 50)];
  await svc.assertLineSlotsTx(tx, { worldId: 'w', airlineId: 'me', pendingOrders: mine, newOrders: mine, absWeek: 10 });
  await assert.rejects(
    svc.assertLineSlotsTx(tx, { worldId: 'w', airlineId: 'me', pendingOrders: mine, newOrders: mine, absWeek: 10, rates: { lines: { b787: 1 } } }),
    svc.LineSlotConflict);
});

await t('the create-world form (SSR): class boxes, per-family boxes, placeholders follow the scale and the class you typed', async () => {
  const React = (await import('react')).default;
  const { renderToString } = await import('react-dom/server');
  const ProductionRates = (await import('../apps/headwinds-web/src/ProductionRates.jsx')).default;
  const html = renderToString(React.createElement(ProductionRates, {
    rates: { classes: { 'Wide Body': '2' }, lines: { a380: '1' } }, onChange() {}, maxPlayers: 75,
  })).replace(/<!-- -->/g, '');
  const box = (label) => {
    const m = html.match(new RegExp(`<input[^>]*aria-label="${label} frames a week"[^>]*>`));
    assert.ok(m, `no box for ${label}`);
    return { value: m[0].match(/value="([^"]*)"/)?.[1], placeholder: m[0].match(/placeholder="([^"]*)"/)?.[1] };
  };
  assert.deepEqual(box('Widebodies'), { value: '2', placeholder: '8' }, '5 × 1.5 players-scale default');
  assert.deepEqual(box('Turboprops'), { value: '', placeholder: '15' });
  assert.equal(box('Boeing 787').placeholder, '2', 'a blank family shows its class rate as typed');
  assert.deepEqual(box('Airbus A380'), { value: '1', placeholder: '5' });
  assert.match(html, /1 set/);
  assert.match(html, /Reset to defaults/);
  assert.match(html, /default for 75 players/);
  assert.equal((html.match(/frames a week"/g) ?? []).length, Object.keys(L.PRODUCTION_LINES).length + L.linesByClass().length);
});

await t('the real create-world form shows the rates under Production lines (20 players: 0.6× defaults)', async () => {
  const React = (await import('react')).default;
  const { renderToString } = await import('react-dom/server');
  const app = await import('../apps/headwinds-web/src/App.jsx');
  const html = renderToString(React.createElement(app.CreateWorld, {
    token: 't', me: { account: { id: 'admin', isAdmin: true } }, initialOpen: true,
  })).replace(/<!-- -->/g, '');
  assert.match(html, /Production rates/);
  assert.match(html, /default for 20 players/);
  assert.match(html, /aria-label="Widebodies frames a week"[^>]*placeholder="3"|placeholder="3"[^>]*aria-label="Widebodies frames a week"/);
  assert.ok(html.indexOf('Production rates') > html.indexOf('shared delivery slots'), 'sits under the Production lines switch');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
