// Era new-build pricing (ERA_MODE_PLAN.md §6, built 2026-09-02).
//
// Every catalogue purchasePrice/weeklyLease is a 2026 figure — for a closed line,
// the USED price. The 1950 capital sweep (2026-08-31) showed why that matters:
// a leased CV-240 at the used-frame rate earned ~$80K/wk on a monopoly trunk,
// so seed capital never bit. In an era world a type sells at
// ERA_NEW_BUILD_PREMIUM × catalogue while its line is open, sliding back to the
// catalogue figure over ERA_PRICE_DECAY_YEARS after it closes. Surplus types
// (C-47, DC-4) and lines still open in 2026 are untouched; classic worlds are
// byte-identical (calYear null → scale 1).
//
//   node --import ./tools/_register-loader.mjs tools/era-pricing-test.mjs

import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  AIRCRAFT_TYPES, getAircraftType, eraPriceScale, eraPurchasePrice, eraWeeklyLease,
  effectivePurchasePrice, setEraPriceYear, getEraPriceYear,
  ERA_NEW_BUILD_PREMIUM, ERA_PRICE_DECAY_YEARS,
} from '../packages/engine/src/data/aircraft.js';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';

const era = (startYear, cash = 500_000_000) =>
  ({ ...freshState(), phase: 'playing', cash, startYear, year: 1, week: 1, fleet: [], pendingOrders: [], routes: [] });
const classic = (cash = 500_000_000) =>
  ({ ...freshState(), phase: 'playing', cash, year: 1, week: 1, fleet: [], pendingOrders: [], routes: [] });

test('classic worlds are untouched — scale 1 for every type at calYear null', () => {
  setEraPriceYear(null);
  for (const t of AIRCRAFT_TYPES) {
    assert.equal(eraPriceScale(t, null), 1, t.id);
    assert.equal(eraPurchasePrice(t, null), t.purchasePrice, t.id);
    assert.equal(eraWeeklyLease(t, null), t.weeklyLease, t.id);
  }
  assert.equal(effectivePurchasePrice(getAircraftType('b737800'), 1), getAircraftType('b737800').purchasePrice);
});

test('a line still open sells at the full premium; it fades to catalogue after closure', () => {
  const cv = getAircraftType('cv240');           // oop 1954
  assert.equal(eraPriceScale(cv, 1950), ERA_NEW_BUILD_PREMIUM);
  assert.equal(eraPriceScale(cv, 1954), ERA_NEW_BUILD_PREMIUM, 'the closing year is still new-build');
  const mid = eraPriceScale(cv, 1954 + ERA_PRICE_DECAY_YEARS / 2);
  assert.ok(mid > 1 && mid < ERA_NEW_BUILD_PREMIUM, `halfway through the decay: ${mid}`);
  assert.equal(eraPriceScale(cv, 1954 + ERA_PRICE_DECAY_YEARS), 1, 'catalogue price once the used market settles');
  assert.equal(eraPriceScale(cv, 2000), 1);
});

test('the premium is not a propliner quirk — a 737-800 in 1998 is new metal too', () => {
  const t = getAircraftType('b737800');          // oop 2019, catalogue $28M is a used price
  assert.equal(eraPriceScale(t, 1998), ERA_NEW_BUILD_PREMIUM);
  assert.ok(eraPurchasePrice(t, 1998) > 2 * t.purchasePrice);
});

test('lines still open in 2026 already carry a new-build price — no premium', () => {
  const open = AIRCRAFT_TYPES.filter(t => t.oop == null || t.oop > 2026);
  assert.ok(open.length > 20, 'the in-production catalogue vanished');
  for (const t of open) assert.equal(eraPriceScale(t, 2020), 1, t.id);
});

test('war-surplus types are never priced as new metal', () => {
  for (const id of ['c47', 'dc4']) {
    const t = getAircraftType(id);
    assert.equal(t.surplus, true, `${id} must be flagged surplus`);
    assert.equal(eraPriceScale(t, 1950), 1, id);
  }
  // The point of the C-47: in 1950 it is the cheap way in, a new CV-240 is not.
  assert.ok(eraPurchasePrice(getAircraftType('c47'), 1950) * 3 < eraPurchasePrice(getAircraftType('cv240'), 1950));
});

test('BUY_AIRCRAFT in 1950 charges the era price, and the same buy in classic charges the catalogue', () => {
  const cv = getAircraftType('cv240');
  const e = gameReducer(era(1950), { type: 'BUY_AIRCRAFT', typeId: 'cv240' });
  assert.equal(e.fleet.length, 1);
  assert.equal(500_000_000 - e.cash, eraPurchasePrice(cv, 1950));
  assert.ok(500_000_000 - e.cash > 2 * cv.purchasePrice, 'a new CV-240 in 1950 went for the used-frame price');
  const c = gameReducer(classic(), { type: 'BUY_AIRCRAFT', typeId: 'cv240' });
  assert.equal(500_000_000 - c.cash, cv.purchasePrice, 'classic parity');
});

test('LEASE_AIRCRAFT in 1950 stamps the era rate on the tail — locked for the term', () => {
  const cv = getAircraftType('cv240');
  const e = gameReducer(era(1950), { type: 'LEASE_AIRCRAFT', typeId: 'cv240' });
  assert.equal(e.fleet[0].weeklyLease, eraWeeklyLease(cv, 1950));
  assert.ok(e.fleet[0].weeklyLease > 2 * cv.weeklyLease);
  // Classic parity on a non-vintage type — the CV-240 (line closed 1954) is
  // buy-only in a 2026 world under the vintage rule (era-availability-test).
  const f27 = getAircraftType('f27');
  const c = gameReducer(classic(), { type: 'LEASE_AIRCRAFT', typeId: 'f27' });
  assert.equal(c.fleet[0].weeklyLease, f27.weeklyLease, 'classic parity');
  assert.equal(gameReducer(classic(), { type: 'LEASE_AIRCRAFT', typeId: 'cv240' }).fleet.length, 0, 'vintage: no lease in classic');
});

test('ORDER_AIRCRAFT prices owned and leased orders at the era figure', () => {
  const cv = getAircraftType('cv240');
  const owned = gameReducer(era(1950), { type: 'ORDER_AIRCRAFT', typeId: 'cv240', quantity: 1, ownershipType: 'owned' });
  const order = owned.pendingOrders[0];
  assert.ok(order, 'no order placed');
  const unit = order.unitPrice ?? order.totalPrice ?? order.price ?? order.unitTotalPrice;
  assert.ok(unit >= eraPurchasePrice(cv, 1950), `order priced at ${unit}, era price ${eraPurchasePrice(cv, 1950)}`);
  const leased = gameReducer(era(1950), { type: 'ORDER_AIRCRAFT', typeId: 'cv240', quantity: 1, ownershipType: 'lease' });
  assert.ok(leased.pendingOrders[0].weeklyLease >= eraWeeklyLease(cv, 1950) * 0.8,
    `lease order rate ${leased.pendingOrders[0].weeklyLease} vs era ${eraWeeklyLease(cv, 1950)}`);
});

test('buy then sell in the same week returns most of the money — NAV reads the same era price the buy charged', () => {
  const bought = gameReducer(era(1950), { type: 'BUY_AIRCRAFT', typeId: 'cv240' });
  const paid = 500_000_000 - bought.cash;
  const sold = gameReducer(bought, { type: 'SELL_AIRCRAFT', aircraftId: bought.fleet[0].id });
  const back = sold.cash - bought.cash;
  assert.ok(back > paid * 0.85, `paid ${paid}, got ${back} back — NAV is still on the catalogue price`);
  assert.ok(back < paid, 'the selling fee must still bite');
});

test('the reducer sets the module price year from the state on every action', () => {
  gameReducer(era(1950), { type: 'NOOP_FOR_TEST' });
  assert.equal(getEraPriceYear(), 1950);
  gameReducer(classic(), { type: 'NOOP_FOR_TEST' });
  assert.equal(getEraPriceYear(), null);
});
