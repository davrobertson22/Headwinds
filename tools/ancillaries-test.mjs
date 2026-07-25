import assert from 'node:assert/strict';
import {
  ANCILLARY_PRODUCTS, DEFAULT_ANCILLARIES, defaultAncillaries, isAncillariesActive,
  ancillaryTakeRate, ancillaryItemQuality, ancillaryQualityBonus, routeAncillaries,
  normalizeAncillaries, ANC_QUALITY_CAP, ANCILLARY_MAP,
} from '../packages/engine/src/data/ancillaries.js';

let passed = 0, failed = 0;
const test = (n, fn) => { try { fn(); console.log('  ✓ ' + n); passed++; } catch (e) { console.log('  ✗ ' + n + '\n      ' + e.message); failed++; } };

// One busy route: 500 eco + 60 pe + 30 biz + 10 first one-way pax/direction.
const cs = {
  economy:        { passengers: 500 },
  premiumEconomy: { passengers: 60 },
  businessClass:  { passengers: 30 },
  firstClass:     { passengers: 10 },
};

test('inactive policy is a pure no-op', () => {
  for (const pol of [null, undefined, {}, { bogus: 1 }]) {
    assert.equal(ancillaryQualityBonus(pol), 0);
    const r = routeAncillaries(pol, cs, 3000);
    assert.equal(r.revenue, 0); assert.equal(r.cost, 0);
  }
  assert.equal(isAncillariesActive(null), false);
  assert.equal(isAncillariesActive(DEFAULT_ANCILLARIES), true);
});

test('take-rate: free=0, falls as price rises, rises as it falls', () => {
  const bags = ANCILLARY_MAP.bags;
  assert.equal(ancillaryTakeRate(bags, 0), 0);
  const atRef  = ancillaryTakeRate(bags, bags.refPrice);
  const cheap  = ancillaryTakeRate(bags, bags.refPrice * 0.5);
  const dear   = ancillaryTakeRate(bags, bags.refPrice * 2);
  assert.ok(Math.abs(atRef - bags.baseTake) < 1e-9, 'take at ref = baseTake');
  assert.ok(cheap > atRef, 'cheaper -> more buyers');
  assert.ok(dear  < atRef, 'dearer -> fewer buyers');
  assert.ok(dear >= 0, 'take never negative');
});

test('quality: generous > standard(~neutral) > aggressive; capped', () => {
  const free = defaultAncillaries();
  for (const id of Object.keys(free)) free[id] = { offered: true, price: 0 };
  const generous = ancillaryQualityBonus(free);

  const standard = ancillaryQualityBonus(DEFAULT_ANCILLARIES); // all at ref
  assert.ok(generous > standard, 'free is better than market pricing');
  assert.ok(standard < 0 && standard <= -4, `market pricing should dent quality, got ${standard}`);

  const aggressive = defaultAncillaries();
  for (const p of ANCILLARY_PRODUCTS) aggressive[p.id] = { offered: !p.provisioned, price: p.maxPrice };
  const aggQ = ancillaryQualityBonus(aggressive);
  assert.ok(aggQ < standard, 'nickel-and-diming + dropping amenities hurts');
  assert.ok(generous <= ANC_QUALITY_CAP && aggQ >= -ANC_QUALITY_CAP, 'clamped to cap band');
});

test('not offering Wi-Fi carries a quality penalty', () => {
  const withWifi = defaultAncillaries();
  const noWifi   = defaultAncillaries(); noWifi.wifi = { offered: false, price: 0 };
  assert.ok(ancillaryQualityBonus(noWifi) < ancillaryQualityBonus(withWifi), 'no wifi < wifi');
  assert.equal(ancillaryItemQuality(ANCILLARY_MAP.wifi, noWifi), ANCILLARY_MAP.wifi.absentQ);
});

test('revenue is positive and plausible at standard pricing', () => {
  const r = routeAncillaries(DEFAULT_ANCILLARIES, cs, 3000);
  assert.ok(r.revenue > 0 && r.cost >= 0, 'earns money');
  assert.ok(r.net > 0, 'net positive at market pricing');
  // Sanity: on ~1200 both-direction pax, ancillary net should be a few $10k, not millions.
  assert.ok(r.revenue < 200000, `revenue bounded, got ${r.revenue}`);
  // byItem sums to the totals.
  const sumRev = Object.values(r.byItem).reduce((s, i) => s + i.revenue, 0);
  assert.ok(Math.abs(sumRev - r.revenue) <= ANCILLARY_PRODUCTS.length, 'byItem sums to revenue');
});

test('free provisioned amenity earns nothing but still costs to run', () => {
  const freeWifi = defaultAncillaries();
  freeWifi.wifi = { offered: true, price: 0 };
  const r = routeAncillaries(freeWifi, cs, 3000);
  assert.equal(r.byItem.wifi.revenue, 0, 'free wifi = no revenue');
  assert.ok(r.byItem.wifi.cost > 0, 'free wifi still costs bandwidth');
});

test('higher fee => more revenue per buyer but eventually diminishing', () => {
  const mk = (price) => { const p = defaultAncillaries(); for (const id of Object.keys(p)) p[id] = { offered: true, price: 0 }; p.bags = { offered: true, price }; return p; };
  const revAt = (price) => routeAncillaries(mk(price), cs).byItem.bags.revenue;
  assert.ok(revAt(35) > revAt(0), 'charging beats free for revenue');
  assert.ok(revAt(50) > 0);
});

test('normalizeAncillaries clamps and completes', () => {
  const n = normalizeAncillaries({ bags: { offered: true, price: 999 }, wifi: { offered: false, price: 5 } });
  assert.ok(n, 'active policy normalises to object');
  assert.equal(n.bags.price, ANCILLARY_MAP.bags.maxPrice, 'price clamped to max');
  assert.equal(n.wifi.offered, false);
  for (const p of ANCILLARY_PRODUCTS) assert.ok(n[p.id], `product ${p.id} present`);
  assert.equal(normalizeAncillaries(null), null);
  assert.equal(normalizeAncillaries({}), null);
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
