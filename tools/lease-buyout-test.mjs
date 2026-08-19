// Lease buyout — the price you pay to own the jet must be the value the jet has.
//
// Discord (Lancelotbronner, 2026-08-18): "turning leased aircraft into aircraft
// you own (at full cost) — oh my god yes, I had a stressful 2 in-game years
// replacing end-of-lease with newly built planes as they were expiring."
// Headwinds already had the feature; going to look at it turned up the bug.
//
// THE BUG: leaseBuyoutPrice() rolled its own net asset value —
//
//     const remaining = Math.max(0.1, 1 - ageYears / depreciationYears);
//     const nav       = Math.round(type.purchasePrice * remaining);
//
// — while SELL_AIRCRAFT, the AOG write-off, collateral valuation and the used
// market all price the same airframe through valueRemaining()/airframeNAV(),
// which NORMALIZES for `type.deliveredAgeWeeks`. 109 aircraft types in the
// table arrive already-used (the An-225 at 10 years, the DC-10-30 at 16); their
// purchase price is a USED price, so discounting it again by total airframe age
// double-counts a discount already baked in. airframeNAV says so in its own
// docstring: "Mirrors the SELL_AIRCRAFT valuation exactly ... so a write-off can
// never be worth more than a sale." The buyout was the one valuation site that
// didn't mirror it.
//
// So the same aircraft had two prices in the same engine, and the cheap one was
// the one you bought at:
//
//     type       delivered   price    buyout    sell now
//     an225      10y         $170M    $120M     $162M
//     b747400f   12y          $55M     $35M      $52M
//
// Lease it, buy it out, sell it the same week, repeat. 108 of 164 types were
// profitable to launder this way, up to ~$42M a jet, in a live multiplayer
// world. The deposit is a red herring — it cancels out of the round trip (paid
// at order, credited at buyout), which is why the invariant below is written on
// NET CASH ACROSS THE WHOLE ROUND TRIP rather than on the quoted price.
//
// THE CONTRACT: buying a jet out of its lease and selling it immediately is
// always a loss. Concretely the buyout is priced off airframeNAV — the exact
// number SELL_AIRCRAFT pays out on, maintenance modifier and all — plus a
// premium, so the round trip can only ever shed the premium and the sale fee.
//
//   node tools/lease-buyout-test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import { AIRCRAFT_TYPES, getAircraftType, LEASE_BUYOUT_PREMIUM, LEASE_DEPOSIT_WEEKS }
  from '../packages/engine/src/data/aircraft.js';
import { airframeNAV, C_HOURS_DUE, D_HOURS_DUE } from '../packages/engine/src/data/maintenance.js';
import { leaseBuyoutQuote, leaseBuyoutPrice } from '../packages/engine/src/models/leaseBuyout.js';
import { absoluteWeek } from '../packages/engine/src/utils/fuel.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
function section(t) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 66 - t.length))}`); }

// uid() is time-seeded; two id-minting reducer calls inside one millisecond
// collide. Same guard as tools/lease-deposit-test.mjs.
function tick() { const t = Date.now(); while (Date.now() === t) { /* spin */ } }

const money = v => (v < 0 ? '-' : '') + '$' + (Math.abs(v) / 1e6).toFixed(1) + 'M';
const base  = () => ({ ...freshState(), cash: 5_000_000_000, hub: 'JFK' });

/** Lease `typeId`, buy it out, sell it — the full round trip, through the reducer. */
function roundTrip(typeId, mutate = a => a) {
  tick();
  let st = gameReducer(base(), { type: 'LEASE_AIRCRAFT', typeId });
  const tail = st.fleet.at(-1);
  if (!tail) return null;
  st = { ...st, fleet: st.fleet.map(a => (a.id === tail.id ? mutate({ ...a }) : a)) };
  const leased  = st.fleet.find(a => a.id === tail.id);
  const cashIn  = st.cash;
  const quote   = leaseBuyoutQuote(st, leased);
  const bought  = gameReducer(st, { type: 'BUY_OUT_LEASE', aircraftId: tail.id });
  const owned   = bought.fleet.find(a => a.id === tail.id);
  const sold    = gameReducer(bought, { type: 'SELL_AIRCRAFT', aircraftId: tail.id });
  return { leased, owned, quote, cashIn, cashAfterBuy: bought.cash, cashOut: sold.cash,
           net: sold.cash - cashIn, st, bought, sold };
}

console.log('\nLease buyout pricing\n');

// ── 1. The money printer ─────────────────────────────────────────────────────
section('1. Buy out, sell immediately — never a profit');

const printers = [];
for (const t of AIRCRAFT_TYPES) {
  const r = roundTrip(t.id);
  if (!r || !r.owned) continue;          // type refused to lease — not this test's business
  if (r.net > 0) printers.push({ id: t.id, delivered: (t.deliveredAgeWeeks ?? 0) / 52, net: r.net });
}
printers.sort((a, b) => b.net - a.net);

test(`no aircraft type profits from lease → buy out → sell (${AIRCRAFT_TYPES.length} types)`, () => {
  const worst = printers.slice(0, 6)
    .map(p => `        ${p.id.padEnd(12)} delivered ${String(p.delivered)}y   net ${money(p.net)}`)
    .join('\n');
  assert.equal(printers.length, 0,
    `${printers.length} of ${AIRCRAFT_TYPES.length} types print money on a same-week round trip:\n${worst}`);
});

test('the round trip loses at least the buyout premium on a new-build type', () => {
  const t = AIRCRAFT_TYPES.find(x => !(x.deliveredAgeWeeks > 0) && (x.purchasePrice ?? 0) > 0);
  const r = roundTrip(t.id);
  assert.ok(r.net < 0, `${t.id} round trip netted ${money(r.net)} — expected a loss`);
  assert.ok(Math.abs(r.net) >= r.quote.nav * LEASE_BUYOUT_PREMIUM * 0.99,
    `${t.id} lost only ${money(-r.net)}; the ${Math.round(LEASE_BUYOUT_PREMIUM * 100)}% premium alone is `
    + `${money(r.quote.nav * LEASE_BUYOUT_PREMIUM)}`);
});

test('the used-delivery types are no better a deal than the new ones', () => {
  // The regression that started this: an already-used type must not be cheaper
  // to buy out, as a fraction of what it sells for, than a new-build one.
  const used = AIRCRAFT_TYPES.filter(t => (t.deliveredAgeWeeks ?? 0) > 0).slice(0, 25);
  for (const t of used) {
    const r = roundTrip(t.id);
    if (!r?.owned) continue;
    assert.ok(r.net < 0,
      `${t.id} (delivered ${(t.deliveredAgeWeeks / 52)}y old) netted ${money(r.net)} on a same-week round trip`);
  }
});

// ── 2. One valuation, not two ────────────────────────────────────────────────
section('2. The buyout prices off the NAV the sale pays out on');

test('quote.nav === airframeNAV(), the SELL_AIRCRAFT valuation', () => {
  for (const id of ['b737800', 'a320neo', 'an225', 'b747400f', 'dc1030']) {
    const t = getAircraftType(id);
    if (!t) continue;
    const r = roundTrip(id);
    if (!r?.owned) continue;
    const absWeek = absoluteWeek(r.st.year, r.st.week);
    assert.equal(r.quote.nav, airframeNAV(r.leased, t, absWeek),
      `${id}: the buyout valued the airframe at ${money(r.quote.nav)}, the sale at `
      + `${money(airframeNAV(r.leased, t, absWeek))} — the same jet, two prices`);
  }
});

test('the sale proceeds are 95% of the very NAV the buyout charged on', () => {
  const r = roundTrip('b737800');
  const proceeds = r.cashOut - r.cashAfterBuy;
  assert.equal(proceeds, r.quote.nav - Math.round(r.quote.nav * 0.05),
    `sold for ${money(proceeds)} an airframe the buyout called ${money(r.quote.nav)}`);
});

// ── 3. Maintenance moves both prices, or neither ─────────────────────────────
section('3. A worn airframe is cheaper to buy out AND cheaper to sell');

test('a jet with a D check overdue quotes below an identical fresh one', () => {
  const fresh = roundTrip('b737800');
  const worn  = roundTrip('b737800', a => ({ ...a, hoursSinceD: D_HOURS_DUE + 1, hoursSinceC: C_HOURS_DUE + 1 }));
  assert.ok(worn.quote.nav < fresh.quote.nav,
    `an overdue airframe was valued at ${money(worn.quote.nav)} vs ${money(fresh.quote.nav)} fresh — `
    + 'the buyout ignored the maintenance modifier the sale applies');
  assert.ok(worn.quote.price < fresh.quote.price,
    'the overdue jet costs the same or more to buy out than the fresh one');
  assert.ok(worn.net < 0, `the worn round trip netted ${money(worn.net)}`);
});

// ── 4. The deposit is credited, not confiscated ──────────────────────────────
section('4. The security deposit');

test('a deposit on file comes off the buyout price, dollar for dollar', () => {
  const t = getAircraftType('b737800');
  const withNone = roundTrip('b737800', a => ({ ...a, leaseDeposit: 0 }));
  const deposit  = Math.round((t.weeklyLease ?? 0) * LEASE_DEPOSIT_WEEKS);
  const withDep  = roundTrip('b737800', a => ({ ...a, leaseDeposit: deposit }));
  assert.equal(withNone.quote.price - withDep.quote.price, deposit,
    `a ${money(deposit)} deposit moved the price by `
    + `${money(withNone.quote.price - withDep.quote.price)}`);
});

test('crediting the deposit does not turn the round trip into a profit', () => {
  // The deposit cancels across the round trip in real play (paid at order,
  // credited at buyout), so a large one must not tip the net positive.
  for (const t of AIRCRAFT_TYPES.slice(0, 40)) {
    const huge = Math.round((t.weeklyLease ?? 0) * LEASE_DEPOSIT_WEEKS);
    const r = roundTrip(t.id, a => ({ ...a, leaseDeposit: huge }));
    if (!r?.owned) continue;
    const netOfDepositPaid = r.net - huge;   // the deposit was real money, paid earlier
    assert.ok(netOfDepositPaid < 0,
      `${t.id} netted ${money(netOfDepositPaid)} once the ${money(huge)} deposit it paid is counted`);
  }
});

test('the price never goes negative, however large the deposit', () => {
  const r = roundTrip('l410', a => ({ ...a, leaseDeposit: 999_000_000 }));
  assert.ok(r.quote.price >= 0, `quoted ${money(r.quote.price)}`);
});

// ── 5. The rest of the contract, unchanged ───────────────────────────────────
section('5. What the buyout does to the tail');

test('the tail converts to owned with no rent and no deposit left on file', () => {
  const r = roundTrip('b737800');
  assert.equal(r.owned.ownershipType, 'owned');
  assert.equal(r.owned.weeklyLease, 0);
  assert.equal(r.owned.leaseDeposit, 0);
  assert.equal(r.owned.leaseRemainingWeeks, undefined);
});

test('cash falls by exactly the quoted price', () => {
  const r = roundTrip('b737800');
  assert.equal(r.cashIn - r.cashAfterBuy, r.quote.price,
    `quoted ${money(r.quote.price)}, charged ${money(r.cashIn - r.cashAfterBuy)} — `
    + 'the confirm dialog and the reducer disagree');
});

test('an owned tail cannot be bought out again', () => {
  const r = roundTrip('b737800');
  const again = gameReducer(r.bought, { type: 'BUY_OUT_LEASE', aircraftId: r.owned.id });
  assert.equal(again.cash, r.bought.cash, 'buying out an owned aircraft charged the player again');
});

test('a buyout the player cannot afford is refused, not part-charged', () => {
  tick();
  let st = gameReducer({ ...freshState(), cash: 1_000, hub: 'JFK' },
                       { type: 'LEASE_AIRCRAFT', typeId: 'b737800' });
  const tail = st.fleet.at(-1);
  const after = gameReducer(st, { type: 'BUY_OUT_LEASE', aircraftId: tail.id });
  assert.equal(after.cash, st.cash);
  assert.equal(after.fleet.find(a => a.id === tail.id).ownershipType, 'lease');
});

// ── 6. Buying out a whole batch ──────────────────────────────────────────────
section('6. BUY_OUT_LEASES');

function fleetOf(n) {
  let st = { ...freshState(), cash: 5_000_000_000, hub: 'JFK' };
  for (let i = 0; i < n; i++) { tick(); st = gameReducer(st, { type: 'LEASE_AIRCRAFT', typeId: 'b737800' }); }
  return st;
}

test('folds the single case — every selected lease converts, cash falls by the sum', () => {
  const st  = fleetOf(4);
  const ids = st.fleet.map(a => a.id);
  const due = st.fleet.reduce((s2, a) => s2 + leaseBuyoutPrice(st, a), 0);
  const after = gameReducer(st, { type: 'BUY_OUT_LEASES', aircraftIds: ids });
  assert.equal(after.fleet.filter(a => a.ownershipType === 'owned').length, 4);
  assert.equal(st.cash - after.cash, due, 'the batch charged something other than the sum of its quotes');
  assert.equal(after.bulkResult.applied, 4);
});

test('a batch the player can only half-afford buys what it can and says so', () => {
  const st  = fleetOf(4);
  const one = leaseBuyoutPrice(st, st.fleet[0]);
  const poor = { ...st, cash: Math.round(one * 2.5) };
  const after = gameReducer(poor, { type: 'BUY_OUT_LEASES', aircraftIds: st.fleet.map(a => a.id) });
  assert.equal(after.bulkResult.applied, 2);
  assert.equal(after.bulkResult.skipped, 2);
  assert.ok(after.cash >= 0, 'the batch spent past zero');
});

test('duplicate ids in the payload are not charged twice', () => {
  const st  = fleetOf(1);
  const id  = st.fleet[0].id;
  const due = leaseBuyoutPrice(st, st.fleet[0]);
  const after = gameReducer(st, { type: 'BUY_OUT_LEASES', aircraftIds: [id, id, id] });
  assert.equal(st.cash - after.cash, due);
});

test('owned tails in the selection are skipped, not charged', () => {
  const st = fleetOf(2);
  const bought = gameReducer(st, { type: 'BUY_OUT_LEASES', aircraftIds: [st.fleet[0].id] });
  const again  = gameReducer(bought, { type: 'BUY_OUT_LEASES', aircraftIds: bought.fleet.map(a => a.id) });
  assert.equal(again.bulkResult.applied, 1, 'an already-owned tail was bought a second time');
});

// ── 7. The player has to be able to FIND it ──────────────────────────────────
section('7. The expiry surfaces name the buyout');

const readSrc = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');

test('the 8/4-week expiry toast offers all three ways out', () => {
  const src = readSrc('packages/engine/src/reducer.mjs');
  const at = src.indexOf('⏳ Lease expiring');
  const toast = src.slice(at - 700, at + 700);
  assert.match(toast, /buy the aircraft outright/,
    'the toast that fires 8 and 4 weeks out still only mentions renewing and returning');
  assert.match(toast, /leaseBuyoutQuote/,
    'the toast quotes a price that does not come from the shared helper');
});

test('the Dashboard lease alert names it', () => {
  assert.match(readSrc('src/components/Dashboard.jsx'), /expiring within[\s\S]{0,200}buy out/,
    'the Dashboard alert sends the player to Fleet without saying buying out is an option');
});

test('the weekly debrief names it', () => {
  assert.match(readSrc('src/components/WeeklyDebrief.jsx'), /Leases Expiring[\s\S]{0,1800}buy the aircraft outright/,
    'the debrief lists expiring leases with no way out offered');
});

test('the Fleet bulk bar batches the buyout instead of looping dispatches', () => {
  const src = readSrc('src/components/Fleet.jsx');
  assert.match(src, /type: 'BUY_OUT_LEASES', aircraftIds:/,
    'the bulk buyout is not dispatched as one batched action');
  assert.ok(!/\.forEach\([^)]*dispatch\(\{ type: 'BUY_OUT_LEASE'/.test(src),
    'the bulk buyout loops one dispatch per aircraft');
});

test('no screen prices an airframe by hand any more', () => {
  // The buyout, the sell dialog and the bulk-sell total each rolled their own
  // `1 - ageYears / DEPRECIATION_YEARS`, which is how the two valuations drifted
  // apart in the first place. There is one NAV in the engine; use it.
  const src = readSrc('src/components/Fleet.jsx');
  assert.ok(!/1 - ageYears \/ DEPRECIATION_YEARS/.test(src),
    'Fleet.jsx still computes a net asset value by hand instead of calling airframeNAV');
});

console.log(`\n${failed === 0 ? '✅' : '❌'}  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
