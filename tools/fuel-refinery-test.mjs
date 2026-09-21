// Fuel operations Phase 6 (FUEL_OPERATIONS_PLAN.md §9): the refinery — the
// endgame tier, and the one that is not a discount. A slice of the fuel bill
// moves off the jet index and onto crude plus a refining cost, so the airline
// wins when the crack spread is wide and LOSES when it collapses.
//
// The three properties every assertion here defends:
//   1. it can lose money — at a crack of 1.00 the refinery pays over market;
//   2. it cannot be hedged — hedges cover only the share it does not;
//   3. it does not scale — capacity is fixed in litres at purchase.
//
// Verified failing on HEAD (2026-09-20) via a probe on HEAD's own APIs:
// BUY_REFINERY / SELL_REFINERY return state unchanged and the tick prices
// the same fuel multiplier whatever state.refinery says.
//
//   node tools/fuel-refinery-test.mjs

import assert from 'node:assert/strict';
import {
  CRACK_BASE_INDEX, CRACK_MIN_INDEX, CRACK_MAX_INDEX, REFINING_COST,
  REFINERY_CAPEX, REFINERY_BUILD_WEEKS, REFINERY_WEEKLY_OPEX, REFINERY_CAPACITY_SHARE,
  REFINERY_SALE_FRACTION, REFINERY_MIN_WEEKLY_BILL, REFINERY_OUTAGE_PROB,
  tickCrackIndex, clampCrackIndex, refineryPriceIndex, refineryStatus, canBuyRefinery,
  makeRefinery, refinerySaleValue, weeklyLitresOf, weeklyBaseBillOf, rollRefineryOutage,
  isCommissioned, isOnOutage, refinerySavingsFromReport,
} from '../packages/engine/src/data/refinery.js';
import { FUEL_PRICE_PER_LITRE, HEDGE_DURATIONS, hedgeLockedPrice } from '../packages/engine/src/utils/fuel.js';
import { resolveFuelForWeek } from '../packages/engine/src/utils/fuelOps.js';
import { FUEL_OPS_VERSION } from '../packages/engine/src/data/fuelStations.js';
import { gameReducer } from '../packages/engine/index.mjs';
import { runScenario, makeRng } from './golden-master/harness.mjs';
import { guardDecision } from '../apps/headwinds-server/src/lib/decisionGuard.mjs';
import { worldCrackIndex } from '../apps/headwinds-server/src/lib/worldEconomy.mjs';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
const near = (a, b, eps) => Math.abs(a - b) <= eps;

console.log('\nThe crack walk\n');

test('the walk mean-reverts to 1.12 and stays inside its band', () => {
  assert.equal(CRACK_BASE_INDEX, 1.12);
  let idx = CRACK_MIN_INDEX, lo = 9, hi = 0, sum = 0;
  const rng = makeRng(0xC7AC1);
  for (let i = 0; i < 20000; i++) {
    idx = tickCrackIndex(idx, rng());
    lo = Math.min(lo, idx); hi = Math.max(hi, idx); sum += idx;
    assert.ok(idx >= CRACK_MIN_INDEX && idx <= CRACK_MAX_INDEX, `walked out of band: ${idx}`);
  }
  assert.ok(near(sum / 20000, CRACK_BASE_INDEX, 0.03), `long-run mean ${(sum / 20000).toFixed(3)}`);
  assert.ok(lo < 1.0 && hi > 1.3, `the walk should visit both ends (${lo}–${hi})`);
  assert.equal(clampCrackIndex(2), CRACK_MAX_INDEX);
  assert.equal(clampCrackIndex(0), CRACK_MIN_INDEX);
});

test('the refinery price is crude plus a refining cost — and it can be WORSE than market', () => {
  // At the long-run crack it runs under market...
  const good = refineryPriceIndex(1.0, CRACK_BASE_INDEX);
  assert.ok(near(good, 1 / 1.12 + REFINING_COST, 1e-4));
  assert.ok(good < 1.0, `${good} should beat a 1.0 market`);
  assert.ok(near(1 - good, 0.067, 0.005), `~6.7% under market, got ${((1 - good) * 100).toFixed(1)}%`);
  // ...at a collapsed spread it runs OVER. This is the whole design.
  const bad = refineryPriceIndex(1.0, 1.0);
  assert.ok(bad > 1.0, `at a crack of 1.00 the refinery must cost more than market, got ${bad}`);
  assert.ok(near(bad, 1.04, 1e-9));
  // ...and at a wide spread it prints.
  const wide = refineryPriceIndex(1.0, CRACK_MAX_INDEX);
  assert.ok(near(1 - wide, 0.27, 0.01), `~27% under at a 1.45 crack, got ${((1 - wide) * 100).toFixed(1)}%`);
  // It scales with the jet price: the saving is proportional, not absolute.
  assert.ok(near(refineryPriceIndex(1.4, 1.12) / refineryPriceIndex(1.0, 1.12), 1.4, 0.02));
});

test('the world crack walk is seeded, replayable and its own stream', () => {
  const a = worldCrackIndex('seed-a', 40), b = worldCrackIndex('seed-a', 40);
  assert.equal(a, b, 'same seed and week → same index');
  assert.notEqual(worldCrackIndex('seed-b', 40), a, 'a different world walks differently');
  assert.equal(worldCrackIndex('seed-a', 0), CRACK_BASE_INDEX, 'week 0 is the seed value');
  for (const w of [1, 7, 40, 200]) {
    const v = worldCrackIndex('seed-c', w);
    assert.ok(v >= CRACK_MIN_INDEX && v <= CRACK_MAX_INDEX, `week ${w}: ${v}`);
  }
});

console.log('\nBuying one\n');

// The golden scenario is one aircraft on one route — far too small for a
// refinery, which is the point of the size gate. A big airline is the same
// state with a fuel bill the desk will sell against.
const s60 = runScenario({ weeks: 60 });
const BIG = {
  ...s60, cash: 5_000_000_000,
  lastReport: { ...s60.lastReport, totalFuel: 250_000_000, fuelMultiplier: 1.0 },
};

test('the desk sizes it off what you actually burn, and refuses a small airline', () => {
  assert.equal(weeklyBaseBillOf(BIG), 250_000_000);
  assert.ok(near(weeklyLitresOf(BIG), 250_000_000 / FUEL_PRICE_PER_LITRE, 1));
  const ok = canBuyRefinery(BIG);
  assert.ok(ok.ok, ok.reasons.join(' | '));
  assert.equal(ok.capex, REFINERY_CAPEX);
  assert.ok(near(ok.capacityLitres, weeklyLitresOf(BIG) * REFINERY_CAPACITY_SHARE, 1));
  // LtFrosty-sized, $62M/wk: refused, and for the right reason — at that bill
  // the refinery's share of the spread is ~$1.7M/wk against $2M/wk of opex,
  // i.e. it loses money even in a good crack year.
  const small = { ...BIG, lastReport: { ...BIG.lastReport, totalFuel: 62_000_000 } };
  const no = canBuyRefinery(small);
  assert.equal(no.ok, false);
  assert.match(no.reasons[0], /\$150M\+ of fuel a week/);
  // The gate must sit ABOVE the break-even bill, or the desk is selling a
  // guaranteed loss: opex / (capacityShare × edge at the long-run crack).
  const edge = 1 - refineryPriceIndex(1.0, CRACK_BASE_INDEX);
  const breakEven = REFINERY_WEEKLY_OPEX / (REFINERY_CAPACITY_SHARE * edge);
  assert.ok(REFINERY_MIN_WEEKLY_BILL > breakEven,
    `gate ${REFINERY_MIN_WEEKLY_BILL} must clear break-even ${Math.round(breakEven)}`);
  // And an airline just under the gate is still refused.
  assert.equal(canBuyRefinery({ ...BIG, lastReport: { ...BIG.lastReport, totalFuel: REFINERY_MIN_WEEKLY_BILL - 1 } }).ok, false);
});

test('cash, a second refinery and a classic save all refuse', () => {
  assert.match(canBuyRefinery({ ...BIG, cash: 1e6 }).reasons[0], /Not enough cash/);
  assert.match(canBuyRefinery({ ...BIG, refinery: makeRefinery(1, 1e6) }).reasons[0], /one per airline/);
  const { fuelOpsV: _v, ...classic } = BIG;
  assert.match(canBuyRefinery(classic).reasons[0], /not on/);
});

test('BUY_REFINERY pays, seeds the crack walk, and commissions a year out', () => {
  const after = gameReducer(BIG, { type: 'BUY_REFINERY' });
  assert.equal(after.cash, BIG.cash - REFINERY_CAPEX);
  assert.equal(after.refinery.onlineAbsWeek - after.refinery.orderedAbsWeek, REFINERY_BUILD_WEEKS);
  assert.ok(near(after.refinery.capacityLitres, weeklyLitresOf(BIG) * REFINERY_CAPACITY_SHARE, 1));
  assert.equal(after.fuelPrice.crack, CRACK_BASE_INDEX, 'the crack walk is seeded on purchase');
  assert.ok(!('crack' in (BIG.fuelPrice ?? {})), 'and did not exist before');
  // A second purchase is refused, and costs nothing.
  const again = gameReducer(after, { type: 'BUY_REFINERY' });
  assert.equal(again.cash, after.cash);
});

test('SELL_REFINERY recovers 40% and puts the whole bill back on the market', () => {
  const owned = gameReducer(BIG, { type: 'BUY_REFINERY' });
  const sold = gameReducer(owned, { type: 'SELL_REFINERY' });
  assert.equal(sold.cash, owned.cash + Math.round(REFINERY_CAPEX * REFINERY_SALE_FRACTION));
  assert.ok(!('refinery' in sold));
  assert.equal(refinerySaleValue(owned.refinery), 1_000_000_000);
  assert.equal(gameReducer(BIG, { type: 'SELL_REFINERY' }), BIG, 'selling nothing is a no-op');
});

console.log('\nWhat it does to the price\n');

const online = (state, over = {}) => ({
  ...state,
  refinery: { orderedAbsWeek: 1, onlineAbsWeek: 2, capacityLitres: weeklyLitresOf(state) * 0.4, capex: REFINERY_CAPEX, ...over },
  fuelPrice: { ...(state.fuelPrice ?? {}), crack: CRACK_BASE_INDEX },
});

test('a commissioned refinery covers its share and prices it off crude', () => {
  const st = online({ ...BIG, year: 2, week: 9 });
  const r = resolveFuelForWeek(st, {});
  assert.ok(near(r.refinery.share, 0.4, 0.001), `share ${r.refinery.share}`);
  assert.equal(r.crackIndex, CRACK_BASE_INDEX);
  const jet = r.currentFuelIndex;
  const refPrice = refineryPriceIndex(jet, CRACK_BASE_INDEX);
  assert.ok(near(r.fuelMultiplier, 0.4 * refPrice + 0.6 * r.hedgedMarketMultiplier, 1e-4),
    `blend ${r.fuelMultiplier}`);
  assert.ok(r.fuelMultiplier < r.hedgedMarketMultiplier, 'at the long-run crack it is cheaper');
  assert.ok(near(r.hedgeableShare, 0.6, 0.001));
});

test('a collapsed crack spread makes the refinery the expensive option', () => {
  const st = { ...online({ ...BIG, year: 2, week: 9 }), fuelPrice: { index: 1.0, history: [], crack: 1.0 } };
  const r = resolveFuelForWeek(st, {});
  assert.ok(r.fuelMultiplier > r.hedgedMarketMultiplier,
    `at a 1.00 crack the owner must pay MORE (${r.fuelMultiplier} vs ${r.hedgedMarketMultiplier})`);
  assert.ok(r.refinery.edge < 0, 'and the edge is negative');
});

test('while it is building, and while it is down, it does nothing at all', () => {
  const base = { ...BIG, year: 2, week: 9 };
  const abs = 61;
  const building = online(base, { onlineAbsWeek: abs + 10 });
  const rb = resolveFuelForWeek(building, {});
  assert.equal(rb.refinery.share, 0);
  assert.equal(rb.refinery.building, true);
  assert.equal(rb.fuelMultiplier, rb.hedgedMarketMultiplier, 'no discount before it commissions');
  assert.equal(rb.refinery.weeksLeft, 10);
  const down = online(base, { outageUntilAbsWeek: abs + 4 });
  const rd = resolveFuelForWeek(down, {});
  assert.equal(rd.refinery.share, 0);
  assert.equal(rd.refinery.outage, true);
  assert.equal(rd.fuelMultiplier, rd.hedgedMarketMultiplier, 'an outage reverts to market');
  assert.ok(isOnOutage(down.refinery, abs) && !isOnOutage(down.refinery, abs + 5));
  assert.ok(isCommissioned(down.refinery, abs) && !isCommissioned(building.refinery, abs));
});

test('capacity is fixed in litres, so growth dilutes it', () => {
  const st = online({ ...BIG, year: 2, week: 9 });
  assert.ok(near(resolveFuelForWeek(st, {}).refinery.share, 0.40, 0.001));
  // The airline doubles its flying; the refinery still refines what it refines.
  const grown = { ...st, lastReport: { ...st.lastReport, totalFuel: 500_000_000 } };
  assert.ok(near(resolveFuelForWeek(grown, {}).refinery.share, 0.20, 0.001), 'share halves');
  // And it never covers more than everything, however small the airline gets.
  const shrunk = { ...st, lastReport: { ...st.lastReport, totalFuel: 10_000_000 } };
  assert.equal(resolveFuelForWeek(shrunk, {}).refinery.share, 1);
});

test('a save with no refinery is untouched by any of this', () => {
  const r = resolveFuelForWeek({ ...BIG, year: 2, week: 9 }, {});
  assert.equal(r.refinery.owned, false);
  assert.equal(r.refinery.share, 0);
  assert.equal(r.hedgeableShare, 1);
  assert.equal(r.fuelMultiplier, r.hedgedMarketMultiplier);
});

console.log('\nYou cannot hedge the crack away\n');

test('hedges are credited against the unrefined share only', () => {
  const orig = Math.random;
  Math.random = makeRng(0xBEE7);
  try {
    const opt = HEDGE_DURATIONS.find(o => o.id === 'long');
    const hedged = gameReducer({ ...BIG, fuelPrice: { index: 1.40, history: [] } },
      { type: 'BUY_HEDGE', durationId: opt.id, coverage: 0.5 });
    const contract = hedged.hedgeContracts[0];

    const tick = (state, seed) => {
      const o = Math.random; Math.random = makeRng(seed);
      try { return gameReducer(state, { type: 'ADVANCE_WEEK' }); } finally { Math.random = o; }
    };
    const bare = tick(hedged, 0x5EED);
    const withRef = tick(online(hedged), 0x5EED);

    const bareSaved = bare.hedgeContracts[0].realizedSavings;
    const refSaved  = withRef.hedgeContracts[0].realizedSavings;
    assert.ok(Number.isFinite(bareSaved) && Number.isFinite(refSaved));
    // The refinery takes 40% of the litres off the jet market, so the hedge
    // can only be credited on the remaining 60%.
    assert.ok(near(refSaved / bareSaved, 0.6, 0.08),
      `hedge credited ${refSaved} vs ${bareSaved} — should be ~60% of it`);
  } finally { Math.random = orig; }
});

console.log('\nThrough the tick\n');

function tickWith(state, seed, extra = {}) {
  const orig = Math.random;
  Math.random = makeRng(seed);
  try { return gameReducer(state, { type: 'ADVANCE_WEEK', ...extra }); } finally { Math.random = orig; }
}

test('the report charges the opex and records what the refinery made', () => {
  const bare = tickWith({ ...BIG, year: 2, week: 9 }, 0xF00D);
  const owned = tickWith(online({ ...BIG, year: 2, week: 9 }), 0xF00D);
  assert.equal(owned.lastReport.totalRefineryCosts, REFINERY_WEEKLY_OPEX);
  assert.ok(!('totalRefineryCosts' in bare.lastReport), 'no refinery, no keys');
  assert.ok(!('refineryShare' in bare.lastReport));
  assert.ok(near(owned.lastReport.refineryShare, 0.4, 0.001));
  assert.ok(owned.lastReport.refineryEdge > 0, 'the long-run crack is with the owner');
  assert.equal(owned.lastReport.crackIndex, CRACK_BASE_INDEX);
  assert.equal(refinerySavingsFromReport(owned.lastReport), owned.lastReport.refinerySavings);
  assert.ok(owned.lastReport.refinerySavings > 0);
  // The actual fuel bill is lower than the same week without the refinery.
  assert.ok(owned.lastReport.totalFuel < bare.lastReport.totalFuel);
  assert.equal(refinerySavingsFromReport({}), 0);
});

test('the crack walks forward every week the airline owns one, and only then', () => {
  const owned = tickWith(online({ ...BIG, year: 2, week: 9 }), 0xAAA1);
  assert.ok(Number.isFinite(owned.fuelPrice.crack));
  assert.notEqual(owned.fuelPrice.crack, CRACK_BASE_INDEX, 'it moved');
  assert.ok(owned.fuelPrice.crack >= CRACK_MIN_INDEX && owned.fuelPrice.crack <= CRACK_MAX_INDEX);
  const bare = tickWith({ ...BIG, year: 2, week: 9 }, 0xAAA1);
  assert.ok(!('crack' in bare.fuelPrice), 'a save without one carries no crack index');
});

test('multiplayer takes the world crack, not its own walk', () => {
  const mp = { ...online({ ...BIG, year: 2, week: 9 }), multiplayer: true, competitors: [], humanRivals: {} };
  const r = resolveFuelForWeek(mp, { worldCrackIndex: 1.40 });
  assert.equal(r.crackIndex, 1.40);
  assert.ok(near(r.refinery.price, refineryPriceIndex(r.currentFuelIndex, 1.40), 1e-4));
  // A solo save ignores it entirely.
  const solo = resolveFuelForWeek(online({ ...BIG, year: 2, week: 9 }), { worldCrackIndex: 1.40 });
  assert.equal(solo.crackIndex, CRACK_BASE_INDEX);
});

test('outages are only rolled while it is running', () => {
  // Never fires at a draw above the probability; always fires at 0.
  assert.equal(rollRefineryOutage(0.9), 0);
  assert.ok(rollRefineryOutage(0) >= 3 && rollRefineryOutage(0) <= 6);
  assert.equal(rollRefineryOutage(REFINERY_OUTAGE_PROB + 1e-9), 0);
  // A building refinery draws nothing, so the week is bit-identical to one
  // with no refinery at all except for the opex.
  const abs = 61;
  const building = online({ ...BIG, year: 2, week: 9 }, { onlineAbsWeek: abs + 20 });
  const a = tickWith(building, 0xB111);
  const b = tickWith({ ...BIG, year: 2, week: 9 }, 0xB111);
  assert.equal(a.lastReport.totalFuel, b.lastReport.totalFuel, 'no price effect while building');
  assert.equal(a.lastReport.totalCost - b.lastReport.totalCost, REFINERY_WEEKLY_OPEX);
});

console.log('\nServer\n');

test('the guard accepts no client payload at all', () => {
  assert.deepEqual(guardDecision('BUY_REFINERY', { capex: 1, capacityLitres: 1e12 }, {}), {});
  assert.deepEqual(guardDecision('SELL_REFINERY', { proceeds: 1e12 }, {}), {});
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
