// Fuel in dollars: what the price level is costing this airline.
//
// The report (Heavy Landing, Sep 2026): a 408-aircraft airline watched its
// profit go from $99M/wk to $22M/wk over 40 game weeks with revenue flat and
// loads unchanged, read the P&L every week, and concluded the game was broken.
// It was fuel — the world index went 0.78 → 1.38 and the fuel line went
// $147M → $253M/wk — but every fuel figure on screen is an index multiplier,
// so nothing ever said "above-normal fuel is costing you $55M a week, which is
// 2.5x what you made".
//
// fuelImpact derives those dollars from the save; this suite pins the
// arithmetic. The dollar figures must come from the same history the P&L
// prints and the same effective multiplier the tick charged — a hedged
// airline's base bill is fuel / blended multiplier, not fuel / market index.
//
//   node tools/fuel-impact-test.mjs

import assert from 'node:assert/strict';
import {
  fuelImpact, decomposeWeek, hedgeQuoteDollars, fuelDigest, hedgesLiveAt,
} from '../packages/engine/src/utils/fuelImpact.js';
import {
  effectiveFuelMultiplier, hedgeLockedPrice, HEDGE_DURATIONS, absoluteWeek,
} from '../packages/engine/src/utils/fuel.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
const near = (a, b, eps = 1) => Math.abs(a - b) <= eps;

// A base (1.0x) fuel bill of $200M/wk, the index walking 0.80 → 1.30 over 30
// weeks, revenue flat at $820M and every other cost flat at $560M — the
// Heavy Landing shape, in round numbers, and no hedge.
const BASE = 200_000_000, OTHER = 560_000_000, REV = 820_000_000;
function weekEntry(i, index, effMult = index) {
  const fuel = Math.round(BASE * effMult);
  const week = ((i) % 52) + 1, year = 1 + Math.floor(i / 52);
  return { label: `W${week} Y${year}`, week, year, revenue: REV, fuel, fuelIndex: index,
           totalCost: fuel + OTHER, profit: REV - fuel - OTHER };
}
const walk = Array.from({ length: 30 }, (_, i) => +(0.80 + (0.50 * i) / 29).toFixed(3));
const unhedged = { financialHistory: walk.map((x, i) => weekEntry(i, x)), hedgeContracts: [],
                   fuelPrice: { index: 1.30, history: walk } };

console.log('\nfuelImpact — unhedged\n');

test('this week: bill, base bill and the excess the price level costs', () => {
  const r = fuelImpact(unhedged);
  assert.equal(r.index, 1.30);
  assert.equal(r.bill, 260_000_000);
  assert.equal(r.baseBill, 200_000_000);
  assert.equal(r.excess, 60_000_000);
  assert.equal(r.hedgeSaved, 0);
  assert.equal(r.hedged, false);
});

test('per-0.1 sensitivity is a tenth of the base bill', () => {
  assert.equal(fuelImpact(unhedged).perTenth, 20_000_000);
});

test('excess vs profit reads as a multiple: $60M excess on $0M profit is null, on $24M is 2.5x', () => {
  // profit this week = 820 − 260 − 560 = 0 → no multiple to quote
  assert.equal(fuelImpact(unhedged).excessVsProfit, null);
  const s = structuredClone(unhedged);
  s.financialHistory[29].profit = 24_000_000;
  assert.ok(near(fuelImpact(s).excessVsProfit, 2.5, 0.01));
});

test('lookbacks: 13 and 26 weeks ago, with deltas that tie to the history', () => {
  const r = fuelImpact(unhedged);
  assert.deepEqual(r.ago.map(a => a.weeks), [13, 26]);
  const a26 = r.ago[1];
  assert.equal(a26.index, walk[3]);
  assert.equal(a26.bill, Math.round(BASE * walk[3]));
  assert.equal(a26.dBill, r.bill - a26.bill);
  assert.equal(a26.dProfit, r.profit - a26.profit);
  // Revenue flat, so the profit lost is exactly the fuel added.
  assert.equal(a26.dProfit, -a26.dBill);
});

test('low/high anchors point at the cheapest and dearest weeks the save still holds', () => {
  const r = fuelImpact(unhedged);
  assert.equal(r.low.index, walk[0]);
  assert.equal(r.low.weeksAgo, 29);
  assert.equal(r.low.bill, Math.round(BASE * walk[0]));
  assert.equal(r.low.dBill, r.bill - r.low.bill);
  assert.equal(r.high.index, 1.30);
  assert.equal(r.high.weeksAgo, 0);
});

test('a lookback the history cannot reach is dropped, not zero-filled', () => {
  const short = { ...unhedged, financialHistory: unhedged.financialHistory.slice(-5) };
  assert.deepEqual(fuelImpact(short).ago, []);
  assert.deepEqual(fuelImpact(short, { lookbacks: [4] }).ago.map(a => a.weeks), [4]);
});

test('no history → null, never a fabricated readout', () => {
  assert.equal(fuelImpact({ financialHistory: [] }), null);
  assert.equal(fuelImpact({}), null);
});

console.log('\nfuelImpact — hedged\n');

// 50% locked at 1.00 from week 10 for 26 weeks. The tick charges the blended
// multiplier, so the recorded fuel line is lower than market would be.
const contract = { id: 'h1', coverage: 0.5, lockedPrice: 1.0,
                   startAbsWeek: absoluteWeek(1, 10), expiryAbsWeek: absoluteWeek(1, 10) + 26, weeksTotal: 26 };
const hedged = {
  financialHistory: walk.map((x, i) => {
    const abs = absoluteWeek(1, i + 1);
    const eff = effectiveFuelMultiplier(x, hedgesLiveAt([contract], abs));
    return weekEntry(i, x, eff);
  }),
  hedgeContracts: [contract],
  fuelPrice: { index: 1.30, history: walk },
};

test('base bill divides by the multiplier the tick actually charged, not the market index', () => {
  const r = fuelImpact(hedged);
  const eff = effectiveFuelMultiplier(1.30, [contract]);   // 0.5×1.30 + 0.5×1.00 = 1.15
  assert.equal(eff, 1.15);
  assert.equal(r.effMult, eff);
  assert.equal(r.bill, Math.round(BASE * 1.15));
  assert.equal(r.baseBill, BASE);                          // exact, not 230/1.30 = 177
  assert.equal(r.excess, 30_000_000);
  assert.equal(r.hedgeSaved, 30_000_000);                   // 200 × (1.30 − 1.15)
  assert.equal(r.hedged, true);
});

test('weeks before the contract started decompose as unhedged', () => {
  const r = fuelImpact(hedged);
  const w5 = r.series[4];
  assert.equal(w5.effMult, walk[4]);
  assert.equal(w5.hedgeSaved, 0);
  assert.equal(w5.baseBill, BASE);
});

test('lastReport with the exact blended multiplier is preferred when it is the same tick', () => {
  const s = structuredClone(hedged);
  s.lastReport = { totalFuel: s.financialHistory[29].fuel, fuelMultiplier: 1.15 };
  assert.equal(fuelImpact(s).baseBill, BASE);
  // A stale report (different totalFuel) must not be trusted over the rebuild.
  s.lastReport = { totalFuel: 1, fuelMultiplier: 9 };
  assert.equal(fuelImpact(s).baseBill, BASE);
});

test('decomposeWeek tolerates an entry with no fuelIndex (pre-fuelPrice saves)', () => {
  const d = decomposeWeek({ fuel: 1000, revenue: 1, profit: 1 });
  assert.equal(d.index, 1.0);
  assert.equal(d.baseBill, 1000);
  assert.equal(d.excess, 0);
});

console.log('\nhedgeQuoteDollars\n');

test('quotes the price BUY_HEDGE stores, in dollars of this week\'s base bill', () => {
  const opt = HEDGE_DURATIONS.find(o => o.id === 'short');
  const q = hedgeQuoteDollars(unhedged, opt, 0.25);
  assert.equal(q.locked, hedgeLockedPrice(1.30, opt));
  assert.equal(q.baseBillCovered, 50_000_000);
  assert.equal(q.billCovered, Math.round(50_000_000 * q.locked));
  assert.equal(q.vsSpot, Math.round(50_000_000 * (1.30 - q.locked)));
  assert.equal(q.vsSpotTerm, q.vsSpot * opt.weeks);
  assert.equal(q.breakevenIndex, q.locked);
  assert.equal(q.perTenth, 5_000_000);
});

test('above the mean the lock is below spot, so the quote shows a saving if the market holds', () => {
  const opt = HEDGE_DURATIONS.find(o => o.id === 'long');
  const q = hedgeQuoteDollars(unhedged, opt, 0.5);
  assert.ok(q.locked < 1.30, `locked ${q.locked} should sit below a 1.30 spot`);
  assert.ok(q.vsSpot > 0);
});

console.log('\nfuelDigest\n');

test('a 26-week move of +0.45 is reported with the bill it added', () => {
  const d = fuelDigest(unhedged, 26);
  assert.ok(d);
  assert.equal(d.to, 1.30);
  assert.equal(d.from, walk[3]);
  assert.equal(d.dBill, Math.round(BASE * 1.30) - Math.round(BASE * walk[3]));
});

test('a move under the threshold is silence, not a zero line', () => {
  const flat = { financialHistory: Array.from({ length: 10 }, (_, i) => weekEntry(i, 1.02)), hedgeContracts: [] };
  assert.equal(fuelDigest(flat, 8), null);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
