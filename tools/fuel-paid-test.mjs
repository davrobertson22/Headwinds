// Fuel operations Phase 2, the multiplayer half (FUEL_OPERATIONS_PLAN.md
// §5.4–5.5): the "avg fuel paid" a rival publishes, the quarter-end fuel
// standings row, and the two client renders of it.
//
// The privacy rule this must respect: Competition never shows a rival's
// loans, hedges or marketing. What it may show is the OUTCOME — the average
// price the airline actually paid per unit of fuel — because everyone in a
// world shares one fuel walk, so that number is apples to apples and reveals
// nothing about which contracts produced it.
//
// Verified failing on HEAD (2026-09-19): fuelPaidOf and fuelQuarterNewsRows
// do not exist; compose('fuel_quarter') falls through to the bare kind.
//
//   node --import ./tools/_register-loader.mjs tools/fuel-paid-test.mjs

import assert from 'node:assert/strict';
import { fuelPaidOf, FUEL_PAID_WEEKS, toHumanCompetitor } from '../apps/headwinds-server/src/lib/humanRivals.mjs';
import { fuelQuarterNewsRows, FUEL_QUARTER_WEEKS } from '../apps/headwinds-server/src/lib/newsService.mjs';

const store = new Map();
globalThis.window = globalThis.window ?? { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
const { compose } = await import('../src/components/News.jsx');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
const near = (a, b, eps) => Math.abs(a - b) <= eps;

const week = (fuelIndex, fuelMultiplier) => ({
  fuel: 1e6, fuelIndex, ...(fuelMultiplier != null ? { fuelMultiplier } : {}),
});

console.log('\nAvg fuel paid (server projection)\n');

test('an airline that has not flown publishes nothing', () => {
  assert.equal(fuelPaidOf({ financialHistory: [] }), null);
  assert.equal(fuelPaidOf({}), null);
});

test('a never-hedged airline reads exactly at market', () => {
  const s = { financialHistory: Array.from({ length: 20 }, (_, i) => week(1.0 + i * 0.01)) };
  const fp = fuelPaidOf(s);
  assert.equal(fp.weeks, FUEL_PAID_WEEKS);
  assert.equal(fp.vsMarket, 0);
  assert.equal(fp.avgPaid, fp.avgMarket);
});

test('a hedged week is read at the multiplier it was charged, not the index', () => {
  const s = { financialHistory: [week(1.4, 1.1), week(1.4, 1.1), week(1.4)] };
  const fp = fuelPaidOf(s);
  assert.equal(fp.weeks, 3);
  assert.ok(near(fp.avgMarket, 1.4, 1e-9));
  assert.ok(near(fp.avgPaid, (1.1 + 1.1 + 1.4) / 3, 1e-4));
  assert.ok(fp.vsMarket < 0, 'paid below market');
  assert.ok(near(fp.vsMarket, (fp.avgPaid - 1.4) / 1.4, 1e-4));
});

test('only the last 13 flown weeks count', () => {
  const s = { financialHistory: [...Array.from({ length: 10 }, () => week(1.0, 0.5)), ...Array.from({ length: 13 }, () => week(1.0))] };
  assert.equal(fuelPaidOf(s).vsMarket, 0, 'the cheap weeks fell out of the window');
});

test('junk entries are skipped, not averaged as zero', () => {
  const s = { financialHistory: [{ fuel: 1 }, week(NaN), week(1.2, 1.0), week(0)] };
  const fp = fuelPaidOf(s);
  assert.equal(fp.weeks, 1);
  assert.ok(near(fp.avgPaid, 1.0, 1e-9));
});

test('toHumanCompetitor carries fuelPaid and still no hedge contracts', () => {
  const row = {
    id: 'a1', name: 'Bob Airways', hub: 'JFK',
    state: {
      airlineName: 'Bob Airways', cash: 1, routes: [], fleet: [],
      financialHistory: Array.from({ length: 13 }, () => week(1.3, 1.0)),
      hedgeContracts: [{ id: 'secret', coverage: 0.5, lockedPrice: 1.0, expiryAbsWeek: 999 }],
    },
  };
  const c = toHumanCompetitor(row);
  assert.ok(c.fuelPaid && c.fuelPaid.vsMarket < 0);
  assert.ok(!('hedgeContracts' in c), 'the contracts must not leak');
  assert.ok(!JSON.stringify(c).includes('secret'), 'no contract id anywhere in the public view');
});

console.log('\nQuarter-end fuel standings (news row)\n');

const fp = (avgPaid, avgMarket, weeks = FUEL_QUARTER_WEEKS) => ({
  weeks, avgPaid, avgMarket, vsMarket: +((avgPaid - avgMarket) / avgMarket).toFixed(4),
});
const airlines = [
  { airlineId: 'a', name: 'Dear Air',  fuelPaid: fp(1.30, 1.20) },
  { airlineId: 'b', name: 'Bob Airways', fuelPaid: fp(1.05, 1.20) },
  { airlineId: 'c', name: 'Mid Air',   fuelPaid: fp(1.20, 1.20) },
];

test('nothing is written on a week that is not a quarter-end', () => {
  for (const w of [1, 12, 14, 25, 27]) assert.deepEqual(fuelQuarterNewsRows({ worldId: 'w', week: w, airlines }), []);
});

test('the cheapest airline headlines the quarter, with the table cheapest-first', () => {
  const rows = fuelQuarterNewsRows({ worldId: 'w', week: 26, airlines });
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.kind, 'fuel_quarter');
  assert.equal(r.week, 26);
  assert.equal(r.airlineId, 'b');
  assert.equal(r.payload.cheapest.name, 'Bob Airways');
  assert.equal(r.payload.dearest.name, 'Dear Air');
  assert.deepEqual(r.payload.table.map((t) => t.airlineId), ['b', 'c', 'a']);
  assert.ok(near(r.payload.avgMarket, 1.2, 1e-9));
  assert.ok(near(r.payload.worldAvgPaid, (1.30 + 1.05 + 1.20) / 3, 1e-3));
});

test('a world where nobody hedges has no standings to report', () => {
  const flat = airlines.map((a) => ({ ...a, fuelPaid: fp(1.2, 1.2) }));
  assert.deepEqual(fuelQuarterNewsRows({ worldId: 'w', week: 13, airlines: flat }), []);
});

test('airlines without a full quarter of flying are left out, and one airline is no contest', () => {
  const young = [airlines[1], { ...airlines[0], fuelPaid: fp(1.3, 1.2, 4) }];
  assert.deepEqual(fuelQuarterNewsRows({ worldId: 'w', week: 13, airlines: young }), []);
  const sparse = [airlines[1], { airlineId: 'z', name: 'Z', fuelPaid: null }];
  assert.deepEqual(fuelQuarterNewsRows({ worldId: 'w', week: 13, airlines: sparse }), []);
});

test('the payload never names a contract', () => {
  const [r] = fuelQuarterNewsRows({ worldId: 'w', week: 52, airlines });
  const text = JSON.stringify(r.payload).toLowerCase();
  for (const word of ['hedge', 'contract', 'locked', 'coverage']) assert.ok(!text.includes(word), `payload mentions "${word}"`);
});

console.log('\nNews composition\n');

test('compose renders the fuel_quarter row as a standalone headline', () => {
  const [r] = fuelQuarterNewsRows({ worldId: 'w', week: 13, airlines });
  const item = { kind: r.kind, airline: null, data: r.payload };
  const c = compose(item);
  assert.equal(c.subject, 'Bob Airways');
  assert.ok(c.standalone);
  assert.ok(c.headline.includes('1.05×'), c.headline);
  assert.ok(c.headline.includes('below market'), c.headline);
  assert.ok(c.sub.includes('1.20×'), c.sub);
  assert.ok(c.sub.includes('Dear Air'), c.sub);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
