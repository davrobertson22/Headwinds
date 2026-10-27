// Used Market: tick several aircraft and buy them in one go (Headwinds only).
//
// Discord, 2026-10-25 (VodkaOnFire): "In the used aircraft market, please add
// checkboxes next to aircraft so you can tag a number and then bulk purchase. On
// a laggy(er) server, it takes minutes rather than seconds to buy aircraft."
//
// Why it was slow: every Buy used is its own request, its own transaction, its
// own blob write AND its own rebuild of every rival's view plus the whole market
// (routes/aircraftMarket.mjs). Ten jets = ten of all of that, back to back.
//
// Now POST /worlds/:id/used-aircraft/buy takes { listingIds } and does it once:
// one transaction, one version-guarded blob write, one re-render. A listing that
// can't be had (gone, bought out from under you, event-restricted, past the cash
// left after the ones before it) is skipped with its reason; the rest go through.
// The single buy is the batch of one — same checks, same messages, same codes.
//
// Verified failing on HEAD: buyUsedBatch / USED_BATCH_MAX don't exist; the old
// path (buyUsed once per jet, reproduced in a throwaway probe against HEAD's
// aircraftMarketService.mjs) costs 3 transactions and 3 blob writes for 3 jets;
// and HEAD's UsedMarket renders no checkboxes and no bulk bar.
//
//   node --import ./tools/_register-loader.mjs tools/used-market-bulk-buy-test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToString } from 'react-dom/server';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
globalThis.window ??= { localStorage: globalThis.localStorage, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), innerWidth: 1200 };
if (!globalThis.window.localStorage) globalThis.window.localStorage = globalThis.localStorage;
globalThis.window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });

const svc = await import('../apps/headwinds-server/src/lib/aircraftMarketService.mjs');
const { buyUsedBatch, buyUsed, USED_BATCH_MAX } = svc;
const { gameReducer, freshState } = await import('../packages/engine/src/reducer.mjs');
const { eventAircraftDenial } = await import('../packages/engine/src/data/eventRules.js');
const { RemoteGameProvider } = await import('../src/store/GameContext.jsx');
const UsedMarketMod = await import('../src/components/UsedMarket.jsx');
const UsedMarket = UsedMarketMod.default;

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}
const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// ── A stand-in database that can roll back ────────────────────────────────────

const snap = (typeId, over = {}) => ({ typeId, name: `${typeId} ex-Rival`, ageWeeks: 200, ownershipType: 'owned', ...over });
const listing = (id, typeId, navPrice, over = {}) => ({
  id, typeId, navPrice, worldId: 'w1', status: 'OPEN', snapshot: snap(typeId), listedWeek: 1, ...over,
});

function fakeDb(listings, { snipe = [] } = {}) {
  let rows = listings.map((r) => ({ ...r }));
  const sniped = new Set(snipe);
  let airline = { id: 'a1', version: 3, state: null };
  const calls = { tx: 0, airlineWrites: 0, claims: 0 };
  const api = {
    calls,
    rows: () => rows,
    airline: {
      updateMany: async ({ where, data }) => {
        calls.airlineWrites++;
        if (where.id !== airline.id || where.version !== airline.version) return { count: 0 };
        airline = { ...airline, state: data.state, version: airline.version + 1 };
        return { count: 1 };
      },
    },
    usedAircraftListing: {
      findMany: async ({ where }) => rows.filter((r) => where.id.in.includes(r.id)).map((r) => ({ ...r })),
      findUnique: async ({ where }) => { const r = rows.find((x) => x.id === where.id); return r ? { ...r } : null; },
      updateMany: async ({ where, data }) => {
        calls.claims++;
        // A rival's claim landed between our read and our UPDATE.
        if (sniped.has(where.id)) return { count: 0 };
        const r = rows.find((x) => x.id === where.id && x.status === where.status);
        if (!r) return { count: 0 };
        Object.assign(r, data);
        return { count: 1 };
      },
    },
    $transaction: async (fn) => {
      calls.tx++;
      const savedRows = rows.map((r) => ({ ...r }));
      const savedAirline = { ...airline };
      try { return await fn(api); }
      catch (e) { rows = savedRows; airline = savedAirline; throw e; }
    },
  };
  return api;
}

function buyerWith(cash, version = 3) {
  let s = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'Bulk', hub: 'JFK', enableObjectives: false });
  s = { ...s, cash, pendingOrders: [] };
  return { id: 'a1', version, state: s };
}
const WORLD = { id: 'w1', tickConfig: {} };
const M = 1_000_000;

// ── 1. One request buys several ──────────────────────────────────────────────

console.log('\n── 1. Several jets, one transaction ──');

await test('three listings: one transaction, one blob write, cash down by the sum, three used deliveries', async () => {
  const db = fakeDb([listing('l1', 'a320neo', 20 * M), listing('l2', 'b737800', 15 * M), listing('l3', 'a320neo', 18 * M)]);
  const buyer = buyerWith(100 * M);
  const r = await buyUsedBatch(db, { world: WORLD, buyer, listingIds: ['l1', 'l2', 'l3'] });
  assert.equal(db.calls.tx, 1, 'one transaction');
  assert.equal(db.calls.airlineWrites, 1, 'one version-guarded blob write, not one per jet');
  assert.deepEqual(r.bought.map((b) => b.id), ['l1', 'l2', 'l3']);
  assert.deepEqual(r.skipped, []);
  assert.equal(r.buyerState.cash, 100 * M - 53 * M);
  const used = r.buyerState.pendingOrders.filter((o) => o.used);
  assert.equal(used.length, 3);
  assert.deepEqual(used.map((o) => o.costBasis), [20 * M, 15 * M, 18 * M], 'each tail records what was paid for IT');
  for (const row of db.rows()) assert.equal(row.status, 'SOLD');
  for (const row of db.rows()) assert.equal(row.buyerId, 'a1');
});

await test('it is the same purchase as buying them one at a time', async () => {
  const lots = [listing('l1', 'a320neo', 20 * M), listing('l2', 'b737800', 15 * M)];
  const batch = await buyUsedBatch(fakeDb(lots), { world: WORLD, buyer: buyerWith(80 * M), listingIds: ['l1', 'l2'] });
  let s = buyerWith(80 * M).state;
  for (const l of lots) s = gameReducer(s, { type: 'BUY_USED_AIRCRAFT', snapshot: l.snapshot, price: l.navPrice });
  assert.equal(batch.buyerState.cash, s.cash);
  const strip = (o) => { const { id, ...rest } = o; return rest; };
  assert.deepEqual(batch.buyerState.pendingOrders.map(strip), s.pendingOrders.map(strip));
});

await test('a listing named twice is bought once', async () => {
  const db = fakeDb([listing('l1', 'a320neo', 20 * M)]);
  const r = await buyUsedBatch(db, { world: WORLD, buyer: buyerWith(100 * M), listingIds: ['l1', 'l1'] });
  assert.equal(r.bought.length, 1);
  assert.equal(r.buyerState.cash, 80 * M);
});

// ── 2. What can't be had is skipped, not fatal ───────────────────────────────

console.log('\n── 2. Skips ──');

await test('gone, sniped and other-world listings are skipped with reasons; the rest go through', async () => {
  const db = fakeDb([
    listing('ok1', 'a320neo', 10 * M),
    listing('gone', 'a320neo', 10 * M, { status: 'SOLD' }),
    listing('race', 'b737800', 10 * M),
    listing('other', 'a320neo', 10 * M, { worldId: 'w2' }),
    listing('ok2', 'b737800', 10 * M),
  ], { snipe: ['race'] });
  const r = await buyUsedBatch(db, { world: WORLD, buyer: buyerWith(100 * M), listingIds: ['ok1', 'gone', 'race', 'other', 'missing', 'ok2'] });
  assert.deepEqual(r.bought.map((b) => b.id), ['ok1', 'ok2']);
  const why = Object.fromEntries(r.skipped.map((k) => [k.id, k.reason]));
  assert.match(why.gone, /no longer available/);
  assert.match(why.other, /no longer available/);
  assert.match(why.missing, /no longer available/);
  assert.match(why.race, /just bought by someone else/);
  assert.equal(r.buyerState.cash, 80 * M, 'only the two bought are paid for');
  assert.equal(r.skipped.find((k) => k.id === 'race').typeName, 'Boeing 737-800', 'a skip names the aircraft, for the toast');
});

await test('cash runs out in the order shown: earlier jets bought, later ones skipped', async () => {
  const db = fakeDb([listing('l1', 'a320neo', 30 * M), listing('l2', 'a320neo', 30 * M), listing('l3', 'a320neo', 30 * M), listing('l4', 'a320neo', 5 * M)]);
  const r = await buyUsedBatch(db, { world: WORLD, buyer: buyerWith(70 * M), listingIds: ['l1', 'l2', 'l3', 'l4'] });
  assert.deepEqual(r.bought.map((b) => b.id), ['l1', 'l2', 'l4'], 'the cheap one after the miss still fits');
  assert.deepEqual(r.skipped.map((k) => [k.id, k.reason]), [['l3', 'You cannot afford that aircraft.']]);
  assert.equal(db.rows().find((x) => x.id === 'l3').status, 'OPEN', 'an unaffordable listing is never claimed');
  assert.equal(r.buyerState.cash, 5 * M);
});

await test('an event world: a restricted type is skipped, the allowed ones bought', async () => {
  const rules = { aircraft: { families: ['boeing_737'] } };
  assert.ok(eventAircraftDenial({ eventRules: rules }, 'a320neo'), 'fixture: the A320neo is barred under these rules');
  const db = fakeDb([listing('bus', 'a320neo', 10 * M), listing('boe', 'b737800', 10 * M)]);
  const r = await buyUsedBatch(db, { world: { id: 'w1', tickConfig: { event: { rules } } }, buyer: buyerWith(100 * M), listingIds: ['bus', 'boe'] });
  assert.deepEqual(r.bought.map((b) => b.id), ['boe']);
  assert.match(r.skipped[0].reason, /737/);
});

// ── 3. Failure is what it always was ─────────────────────────────────────────

console.log('\n── 3. Nothing bought ──');

await test('a single buy keeps its messages and status codes', async () => {
  const cases = [
    [[listing('l1', 'a320neo', 10 * M, { status: 'SOLD' })], [], 100 * M, 404, 'That aircraft is no longer available.'],
    [[listing('l1', 'a320neo', 10 * M)], ['l1'], 100 * M, 409, 'That aircraft was just bought by someone else.'],
    [[listing('l1', 'a320neo', 50 * M)], [], 10 * M, 400, 'You cannot afford that aircraft.'],
  ];
  for (const [rows, snipe, cash, status, message] of cases) {
    await assert.rejects(buyUsed(fakeDb(rows, { snipe }), { world: WORLD, buyer: buyerWith(cash), listingId: 'l1' }),
      (e) => e.statusCode === status && e.message === message, message);
  }
  const ok = await buyUsed(fakeDb([listing('l1', 'a320neo', 10 * M)]), { world: WORLD, buyer: buyerWith(100 * M), listingId: 'l1' });
  assert.equal(ok.listing.id, 'l1');
  assert.equal(ok.buyerState.cash, 90 * M);
});

await test('a batch where nothing can be bought fails, and says why', async () => {
  const db = fakeDb([listing('l1', 'a320neo', 10 * M, { status: 'SOLD' }), listing('l2', 'a320neo', 10 * M, { status: 'SOLD' })]);
  await assert.rejects(buyUsedBatch(db, { world: WORLD, buyer: buyerWith(100 * M), listingIds: ['l1', 'l2'] }),
    (e) => e.statusCode === 404 && /None of those 2 aircraft could be bought — That aircraft is no longer available/.test(e.message));
  assert.equal(db.calls.airlineWrites, 0);
});

await test('the airline changed mid-purchase: 409, and every claim rolls back', async () => {
  const db = fakeDb([listing('l1', 'a320neo', 10 * M), listing('l2', 'a320neo', 10 * M)]);
  await assert.rejects(buyUsedBatch(db, { world: WORLD, buyer: buyerWith(100 * M, 2), listingIds: ['l1', 'l2'] }),
    (e) => e.statusCode === 409 && /reload/.test(e.message));
  for (const row of db.rows()) assert.equal(row.status, 'OPEN', `${row.id} stayed claimed after the rollback`);
});

await test('empty and over-cap batches are refused before touching the database', async () => {
  const db = fakeDb([]);
  await assert.rejects(buyUsedBatch(db, { world: WORLD, buyer: buyerWith(M), listingIds: [] }), /at least one/);
  const many = Array.from({ length: USED_BATCH_MAX + 1 }, (_, i) => `l${i}`);
  await assert.rejects(buyUsedBatch(db, { world: WORLD, buyer: buyerWith(M), listingIds: many }), new RegExp(`at most ${USED_BATCH_MAX}`));
  assert.equal(db.calls.tx, 0);
});

// ── 4. Wiring ────────────────────────────────────────────────────────────────

console.log('\n── 4. Route and client ──');

await test('the route exists, is capped by the schema, and answers with bought + skipped', async () => {
  const route = src('apps/headwinds-server/src/routes/aircraftMarket.mjs');
  assert.match(route, /fastify\.post\('\/worlds\/:id\/used-aircraft\/buy',/);
  assert.match(route, /maxItems: USED_BATCH_MAX/);
  assert.match(route, /buyUsedBatch\(prisma,/);
  assert.match(route, /bought:\s+bought\.map/);
  assert.match(route, /skipped: skipped\.map/);
  // The raw listing row (snapshot and all) stays on the server.
  assert.doesNotMatch(route, /bought:\s+bought[,\s]/);
});

await test('the web client calls it and adopts the returned state like a single buy', async () => {
  const gp = src('apps/headwinds-web/src/GamePlayScreen.jsx');
  assert.match(gp, /buyUsedAircraftBatch: \(listingIds\) =>\s+authedApi\(`\/worlds\/\$\{worldId\}\/used-aircraft\/buy`, \{ method: 'POST', token, body: \{ listingIds \} \}\)\s+\.then\(\(res\) => adoptUsedPurchase\(setState, res\)\)/);
});

await test('the screen caps a selection at the server\'s limit', () => {
  assert.equal(UsedMarketMod.USED_BATCH_MAX, USED_BATCH_MAX);
});

// ── 5. The screen (server-rendered, the real component) ─────────────────────

console.log('\n── 5. Fleet ▸ Used Market ──');

const clean = (html) => html.replace(/<!-- -->/g, '').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
const LISTINGS = [
  { id: 'l1', typeId: 'a320neo',  typeName: 'Airbus A320neo',  category: 'Narrow Body', ageWeeks: 260, seats: 180, price: 20 * M },
  { id: 'l2', typeId: 'b737800',  typeName: 'Boeing 737-800',  category: 'Narrow Body', ageWeeks: 520, seats: 189, price: 15 * M },
  { id: 'l3', typeId: 'a350-900', typeName: 'Airbus A350-900', category: 'Wide Body',   ageWeeks: 100, seats: 315, price: 90 * M },
  { id: 'l4', typeId: 'b737800',  typeName: 'Boeing 737-800',  category: 'Narrow Body', ageWeeks: 1300, seats: 189, price: 8 * M },
];
const API = { fetchUsedAircraft: async () => ({ listings: LISTINGS }), buyUsedAircraft: async () => ({}), buyUsedAircraftBatch: async () => ({}) };
function render({ cash = 40 * M, selected = null, api = API, filters = null } = {}) {
  store.clear();
  if (filters) store.set('hw_used_market_filters', JSON.stringify(filters));
  const state = { ...freshState(), phase: 'playing', week: 1, year: 1, cash, hub: 'JFK', airlineName: 'T', fleet: [], pendingOrders: [] };
  return clean(renderToString(React.createElement(RemoteGameProvider, { state, dispatch() {}, remoteApi: api },
    React.createElement(UsedMarket, { initialListings: LISTINGS, initialSelected: selected }))));
}
const box = (html, id) => (html.match(new RegExp(`<input[^>]*data-used-select="${id}"[^>]*>`)) ?? [null])[0];

await test('every listing has a checkbox, and the header selects all', () => {
  const html = render();
  for (const l of LISTINGS) assert.ok(box(html, l.id), `no checkbox for ${l.id}`);
  assert.match(html, /data-used-select-all=""/);
  assert.doesNotMatch(html, /data-used-bulk-bar/, 'no bar until something is ticked');
});

await test('a jet you can\'t afford can\'t be ticked; one you can, can', () => {
  const html = render({ cash: 40 * M });
  assert.match(box(html, 'l3'), /disabled=""/, 'the $90M A350 on $40M cash');
  assert.doesNotMatch(box(html, 'l1'), /disabled=""/);
});

await test('ticked jets show a bar: count, total, and one Buy button', () => {
  const html = render({ selected: ['l1', 'l2'] });
  assert.match(box(html, 'l1'), /checked=""/);
  assert.match(html, /data-used-bulk-bar=""/);
  assert.match(html, /2 selected/);
  assert.match(html, /\$35(\.0+)?M/);
  const buy = html.match(/<button[^>]*data-used-bulk-buy=""[^>]*>[^<]*<\/button>/)[0];
  assert.match(buy, />Buy 2 used</);
  assert.doesNotMatch(buy, /disabled=""/);
  assert.doesNotMatch(html, /data-used-bulk-short/);
});

await test('more than you can pay for: the shortfall shows and Buy is off', () => {
  const html = render({ cash: 30 * M, selected: ['l1', 'l2'] });
  assert.match(html, /data-used-bulk-short=""[^>]*>— \$5(\.0+)?M more than your cash/);
  assert.match(html.match(/<button[^>]*data-used-bulk-buy=""[^>]*>/)[0], /disabled=""/);
});

await test('a ticked jet the filters now hide is not counted (nor bought)', () => {
  const html = render({ selected: ['l1', 'l4'], filters: { maxAge: 10 } });
  assert.equal(box(html, 'l4'), null, 'fixture: the 25-year-old 737 is filtered out');
  assert.match(html, /1 selected/);
  assert.match(html, />Buy 1 used</);
});

await test('without the batch endpoint (an old client API) there are no checkboxes', () => {
  const { buyUsedAircraftBatch, ...old } = API;
  const html = render({ api: old });
  assert.equal(box(html, 'l1'), null);
  assert.doesNotMatch(html, /data-used-select-all/);
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
