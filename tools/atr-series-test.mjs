// The ATR 42 and 72 by series (Discord, Zwe Min Khant, 2026-11-14: "More
// aircraft & its variants" — the 42-300/-500/-600, 72-200/-500/-600, the
// 72-600 with the PW127XT, and the ATR 42/72 freighters). The catalogue had
// only the current -600s and the factory 72-600F. Added, in Headwinds and
// Tailwinds:
//   passenger  ATR 42-300, 42-500, 72-200, 72-500, 72-600 (PW127XT)
//   freighter  ATR 42-300F, 72-200F, 72-500F (conversions, also convertible
//              from a player's own 42-300 / 72-200 / 72-500)
// Not added, because no such aircraft exists or flies in numbers: an ATR
// 42-600F or 42-500F (no freighter conversion of either is in service) and
// the 42-400 (two civil frames built).
//
// Kept identical in both repos (it finds the engine either way).
//
//   node --import ./tools/_register-loader.mjs tools/atr-series-test.mjs

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const ENGINE = existsSync(new URL('../packages/engine/src/data/aircraft.js', import.meta.url)) ? '../packages/engine/src/' : '../src/';
const { AIRCRAFT_TYPES, getAircraftType, payloadRangeMod, aircraftAvailability } = await import(`${ENGINE}data/aircraft.js`);
const { aircraftFamily } = await import(`${ENGINE}data/families.js`);
const { lineOf, PRODUCTION_LINES } = await import(`${ENGINE}data/productionLines.js`);
const { realBuilt } = await import(`${ENGINE}data/realBuilds.js`);
const { conversionFor } = await import(`${ENGINE}data/conversions.js`);
const { pickCompetitorAircraftType, pickLargerCompetitorAircraftType } = await import(`${ENGINE}models/demand.js`);
const { setEraCalendarYear, getEraCalendarYear } = await import(`${ENGINE}utils/market.js`);
const { PLANFORMS, planformFor } = await import('../src/utils/planform.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}
const T = (id) => { const t = getAircraftType(id); assert.ok(t, `aircraft id '${id}' is not in the catalogue`); return t; };

const PAX = ['atr42300', 'atr42500', 'atr72200', 'atr72500', 'atr72xt'];
const FRT = ['atr42300f', 'atr72200f', 'atr72500f'];
const NEW = [...PAX, ...FRT];

console.log('\nATR 42 / 72 by series\n');

test('all eight are in the catalogue, complete, and wired like their siblings', () => {
  for (const id of NEW) {
    const t = T(id);
    for (const k of ['name', 'eis', 'range', 'runwayFt', 'weeklyLease', 'purchasePrice', 'fuelBurnPer100km', 'crewCostPerKm', 'baseMaintenancePerWk', 'description', 'image']) {
      assert.ok(t[k] != null && t[k] !== '', `${id}.${k}`);
    }
    assert.equal(t.manufacturer, 'ATR', id);
    assert.ok(/^https:\/\/(upload|commons)\.wikimedia\.org\//.test(t.image), `${id} image is a Commons photo`);
    assert.equal(aircraftFamily(id), 'atr', `${id} maintenance family`);
    assert.ok(realBuilt(id) > 0, `${id} build count`);
    // A passenger series has its own outline; a freighter draws as the
    // airframe it was converted from (planform.js FREIGHTER_PARENT).
    if (PAX.includes(id)) assert.ok(PLANFORMS[id], `${id} cabin outline`);
    assert.equal(t.aiSkip, true, `${id} is player-only, like every added type`);
  }
  for (const [f, from] of [['atr42300f', 'atr42300'], ['atr72200f', 'atr72200'], ['atr72500f', 'atr72500']]) {
    const [a, b] = [planformFor(T(f)), planformFor(T(from))];
    for (const k of ['L', 'S', 'D', 'eng', 'tail', 'high']) assert.deepEqual(a[k], b[k], `${f} draws as the ${T(from).name} (${k})`);
  }
  // Every ATR freighter draws with its two propellers. The outlines carried no
  // propeller token, so a freighter borrowing one was guessed a regional jet
  // and drawn with rear-mounted jets (the 72-600F had been since it arrived).
  for (const id of ['atr72f', ...FRT]) assert.equal(planformFor(T(id)).eng, 'p2', `${id} has propellers`);
  for (const id of PAX) assert.equal(lineOf(T(id)), 'atr', `${id} comes off the ATR line`);
  for (const id of FRT) assert.equal(lineOf(T(id)), 'conv_atr', `${id} comes off the ATR conversion line`);
  assert.equal(PRODUCTION_LINES.atr.types[0], 'atr72', 'the line still leads with the 72-600');
  assert.equal(AIRCRAFT_TYPES.filter(t => t.manufacturer === 'ATR').length, 11);
});

test('each series is cheaper to buy and dearer to run than the one after it', () => {
  for (const chain of [['atr42300', 'atr42500', 'atr42'], ['atr72200', 'atr72500', 'atr72', 'atr72xt']]) {
    for (let i = 1; i < chain.length; i++) {
      const [a, b] = [T(chain[i - 1]), T(chain[i])];
      assert.ok(a.purchasePrice < b.purchasePrice, `${a.name} costs less than ${b.name}`);
      assert.ok(a.fuelBurnPer100km > b.fuelBurnPer100km, `${a.name} burns more than ${b.name}`);
      assert.ok(a.eis < b.eis, `${a.name} came first`);
    }
  }
  // Same fuselage within a family: the seat limits match.
  for (const id of ['atr42300', 'atr42500']) assert.equal(T(id).seats, T('atr42').seats);
});

test('the PW127XT -600 is the -600 with 3% less fuel and cheaper engines, from 2025', () => {
  const m = T('atr72'), xt = T('atr72xt');
  assert.equal(xt.eis, 2025);
  for (const k of ['seats', 'typicalSeats', 'range', 'runwayFt', 'crewCostPerKm']) assert.equal(xt[k], m[k], k);
  assert.ok(Math.abs(xt.fuelBurnPer100km / m.fuelBurnPer100km - 0.97) < 0.001, 'ATR: at least 3% block fuel');
  assert.ok(xt.baseMaintenancePerWk < m.baseMaintenancePerWk, 'cheaper maintenance');
  assert.ok(xt.purchasePrice > m.purchasePrice && xt.purchasePrice < m.purchasePrice * 1.1, 'a small premium');
});

test("published ranges: the 72-200 and -500 at ATR's own seat counts", () => {
  assert.equal(T('atr72200').range, 1_596);   // 862 nmi with 66 passengers
  assert.equal(T('atr72200').typicalSeats, 66);
  assert.equal(T('atr72500').range, 1_430);   // 772 nmi with 68 passengers
  assert.equal(T('atr72500').typicalSeats, 68);
  // A full 74-seat cabin trades range away, as on the -600.
  for (const id of ['atr72200', 'atr72500']) assert.ok(payloadRangeMod(T(id).seats, T(id)) < 1, id);
});

test('era worlds: each arrives in its year and leaves the factory when its line closed', () => {
  const at = (id, y) => aircraftAvailability(T(id), y);
  assert.equal(at('atr42300', 1984), 'future');
  assert.equal(at('atr42300', 1986), 'new');
  assert.equal(at('atr42300', 2000), 'used');
  assert.equal(at('atr72200', 1990), 'new');
  assert.equal(at('atr72200', 1998), 'used');
  assert.equal(at('atr72500', 2005), 'new');
  assert.equal(at('atr72500', 2015), 'used');
  assert.equal(at('atr42500', 2010), 'new');
  assert.equal(at('atr72xt', 2024), 'future');
  assert.equal(at('atr72xt', 2026), 'new');
  // Conversions only exist once the type has flown long enough to be cheap.
  assert.equal(at('atr42300f', 1999), 'future');
  assert.equal(at('atr72200f', 2003), 'new');
  assert.equal(at('atr72500f', 2018), 'future');
});

test("a player's own 42-300, 72-200 or 72-500 converts to its freighter", () => {
  for (const [from, to] of [['atr42300', 'atr42300f'], ['atr72200', 'atr72200f'], ['atr72500', 'atr72500f']]) {
    const c = conversionFor(from);
    assert.ok(c, `${from} converts`);
    assert.equal(c.toType.id, to);
    assert.equal(c.lineId, 'conv_atr');
    assert.ok(c.toType.eis > c.fromType.eis, 'conversions come later');
    assert.ok(c.toType.payloadTonnes < T('atr72f').payloadTonnes || from === 'atr42300', 'a factory -600F carries more');
  }
  assert.equal(conversionFor('atr42500'), null, 'no ATR 42-500 freighter is flying');
});

test('AI carriers never pick one, in any year (no AI fleet moves in a live world)', () => {
  const was = getEraCalendarYear();
  const picked = new Set();
  try {
    for (const year of [null, 1986, 1990, 1998, 2005, 2015, 2026]) {
      setEraCalendarYear(year);
      for (const tier of ['budget', 'legacy', 'premium']) {
        for (let km = 200; km <= 2000; km += 50) {
          const t = pickCompetitorAircraftType(km, tier);
          if (NEW.includes(t?.id)) picked.add(`${t.id} (${tier}, ${km} km, ${year ?? 'classic'})`);
          const up = pickLargerCompetitorAircraftType(km, 40);
          if (NEW.includes(up?.id)) picked.add(`${up.id} (up-gauge, ${km} km, ${year ?? 'classic'})`);
        }
      }
    }
  } finally { setEraCalendarYear(was); }
  assert.deepEqual([...picked].slice(0, 6), []);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
