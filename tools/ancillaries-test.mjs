import assert from 'node:assert/strict';
import {
  ANCILLARY_PRODUCTS, DEFAULT_ANCILLARIES, defaultAncillaries, isAncillariesActive,
  ancillaryTakeRate, ancillaryItemQuality, ancillaryQualityBonus, routeAncillaries,
  normalizeAncillaries, ANC_QUALITY_CAP, ANCILLARY_MAP, ancillaryHaulMult,
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
const PAX_BOTH = (500 + 60 + 30 + 10) * 2;

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

test('elasticity is per product: bag fees are inelastic, Wi-Fi is not', () => {
  const revMax = (p) => {
    let best = [0, 0];
    for (let price = 1; price <= p.maxPrice; price++) {
      const rev = ancillaryTakeRate(p, price) * price;
      if (rev > best[1]) best = [price, rev];
    }
    return best[0] / p.refPrice;
  };
  // Real airlines have pushed bag fees well above old norms and grown revenue:
  // the revenue-maximising bag fee must sit clearly ABOVE reference…
  assert.ok(revMax(ANCILLARY_MAP.bags) >= 1.25, `bags rev-max should be >=1.25x ref, got ${revMax(ANCILLARY_MAP.bags).toFixed(2)}x`);
  // …while elastic discretionary products peak at or below reference.
  assert.ok(revMax(ANCILLARY_MAP.wifi)   <= 1.0, 'wifi rev-max at/below ref');
  assert.ok(revMax(ANCILLARY_MAP.lounge) <= 1.0, 'lounge rev-max at/below ref');
  // And bags must be meaningfully less elastic than wifi.
  assert.ok((ANCILLARY_MAP.bags.elasticity ?? 0.9) < (ANCILLARY_MAP.wifi.elasticity ?? 0.9), 'bags less elastic than wifi');
});

test('quality: generous > standard(~neutral) > aggressive; capped', () => {
  const free = defaultAncillaries();
  for (const id of Object.keys(free)) free[id] = { offered: true, price: 0 };
  const generous = ancillaryQualityBonus(free);

  const standard = ancillaryQualityBonus(DEFAULT_ANCILLARIES); // all at ref
  assert.ok(generous > standard, 'free is better than market pricing');
  // Market pricing is what passengers EXPECT — near-neutral, not a big dent.
  assert.ok(standard <= 0 && standard >= -3, `market pricing ~neutral (0 to -3), got ${standard}`);
  assert.ok(generous >= 10, `all-free should be a big draw, got ${generous}`);

  const aggressive = defaultAncillaries();
  for (const p of ANCILLARY_PRODUCTS) aggressive[p.id] = { offered: !p.provisioned, price: p.maxPrice };
  const aggQ = ancillaryQualityBonus(aggressive);
  assert.ok(aggQ < standard - 4, 'nickel-and-diming + dropping amenities hurts');
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

test('per-passenger revenue sits in the real-world band', () => {
  // Traditional-carrier reality (IdeaWorks): roughly $20–35 per boarded pax.
  for (const dist of [800, 2500, 7000]) {
    const perPax = routeAncillaries(DEFAULT_ANCILLARIES, cs, dist).revenue / PAX_BOTH;
    assert.ok(perPax >= 14 && perPax <= 40, `rev/pax in band at ${dist}km, got $${perPax.toFixed(2)}`);
  }
});

test('haul scaling: long-haul buys more bags/wifi/legroom, short hops less', () => {
  const takeAt = (id, dist) => ancillaryTakeRate(ANCILLARY_MAP[id], ANCILLARY_MAP[id].refPrice, dist);
  for (const id of ['bags', 'wifi', 'legroom', 'lounge']) {
    assert.ok(takeAt(id, 8000) > takeAt(id, 2500), `${id}: long-haul take > mid`);
    assert.ok(takeAt(id, 500)  < takeAt(id, 2500), `${id}: short-haul take < mid`);
  }
  // Wi-Fi on a hop is nearly dead; on long-haul it's a big seller.
  assert.ok(takeAt('wifi', 500) < takeAt('wifi', 8000) * 0.4, 'wifi haul spread is wide');
  // Route revenue follows: same policy, same pax, longer route earns more.
  const short = routeAncillaries(DEFAULT_ANCILLARIES, cs, 500).revenue;
  const long  = routeAncillaries(DEFAULT_ANCILLARIES, cs, 8000).revenue;
  assert.ok(long > short * 1.25, `long-haul out-earns short-haul, ${short} vs ${long}`);
});

test('no distance (UI / airline-wide callers) means neutral mid-haul behaviour', () => {
  for (const p of ANCILLARY_PRODUCTS) {
    assert.equal(ancillaryHaulMult(p, 0), 1, `${p.id}: dist 0 neutral`);
    assert.equal(ancillaryTakeRate(p, p.refPrice, 0), ancillaryTakeRate(p, p.refPrice), `${p.id}: omitted dist = neutral`);
    assert.equal(ancillaryTakeRate(p, p.refPrice, 2500), ancillaryTakeRate(p, p.refPrice), `${p.id}: mid-haul = neutral`);
  }
  assert.equal(ancillaryQualityBonus(DEFAULT_ANCILLARIES, 0), ancillaryQualityBonus(DEFAULT_ANCILLARIES));
  // Take rate can never exceed 1 even with generous pricing on long-haul.
  for (const p of ANCILLARY_PRODUCTS) assert.ok(ancillaryTakeRate(p, 1, 9000) <= 1, `${p.id}: take <= 1`);
});

test('bag & change fees sting quality more on long-haul; free bags do not', () => {
  const charged = ancillaryQualityBonus(DEFAULT_ANCILLARIES, 9000);
  const midQ    = ancillaryQualityBonus(DEFAULT_ANCILLARIES, 2500);
  assert.ok(charged <= midQ, `long-haul fee sting, mid ${midQ} vs long ${charged}`);
  // The raw per-item value must actually deepen (the rounded sum may tie).
  const bagQLong = ancillaryItemQuality(ANCILLARY_MAP.bags, DEFAULT_ANCILLARIES, 9000);
  const bagQMid  = ancillaryItemQuality(ANCILLARY_MAP.bags, DEFAULT_ANCILLARIES, 2500);
  assert.ok(bagQLong < bagQMid, 'charged bags worse on long-haul');
  const freeBags = defaultAncillaries(); freeBags.bags = { offered: true, price: 0 };
  assert.equal(
    ancillaryItemQuality(ANCILLARY_MAP.bags, freeBags, 9000),
    ancillaryItemQuality(ANCILLARY_MAP.bags, freeBags, 2500),
    'free bags: no sting either way',
  );
});

test('premium cabins have bags/seats/priority/lounge/flex bundled into the fare', () => {
  const premiumOnly = {
    economy:        { passengers: 0 },
    premiumEconomy: { passengers: 0 },
    businessClass:  { passengers: 30 },
    firstClass:     { passengers: 10 },
  };
  const r = routeAncillaries(DEFAULT_ANCILLARIES, premiumOnly, 3000);
  for (const id of ['priority', 'lounge']) {
    assert.equal(r.byItem[id].buyers, 0, `${id}: no premium buyers at all`);
  }
  // Bags/seat/flex allow a sliver (paid extras beyond the allowance) but premium
  // cabins must contribute only a trickle vs the same pax count in economy.
  const econOnly = { ...premiumOnly, economy: { passengers: 40 }, businessClass: { passengers: 0 }, firstClass: { passengers: 0 } };
  const re = routeAncillaries(DEFAULT_ANCILLARIES, econOnly, 3000);
  for (const id of ['bags', 'seat', 'flex']) {
    assert.ok(r.byItem[id].revenue <= re.byItem[id].revenue * 0.35, `${id}: premium pays a fraction of economy (${r.byItem[id].revenue} vs ${re.byItem[id].revenue})`);
  }
});

test('free provisioned amenity earns nothing but still costs to run', () => {
  const freeWifi = defaultAncillaries();
  freeWifi.wifi = { offered: true, price: 0 };
  const r = routeAncillaries(freeWifi, cs, 3000);
  assert.equal(r.byItem.wifi.revenue, 0, 'free wifi = no revenue');
  assert.ok(r.byItem.wifi.cost > 0, 'free wifi still costs bandwidth');
});

test('provisioning cost scales with haul (bandwidth is bought by the hour)', () => {
  const freeWifi = defaultAncillaries();
  freeWifi.wifi = { offered: true, price: 0 };
  const shortCost = routeAncillaries(freeWifi, cs, 500).byItem.wifi.cost;
  const longCost  = routeAncillaries(freeWifi, cs, 8000).byItem.wifi.cost;
  assert.ok(longCost > shortCost, `long-haul wifi costs more to run, ${shortCost} vs ${longCost}`);
});

test('higher fee => more revenue per buyer but eventually diminishing', () => {
  const mk = (price) => { const p = defaultAncillaries(); for (const id of Object.keys(p)) p[id] = { offered: true, price: 0 }; p.bags = { offered: true, price }; return p; };
  const revAt = (price) => routeAncillaries(mk(price), cs).byItem.bags.revenue;
  assert.ok(revAt(35) > revAt(0), 'charging beats free for revenue');
  assert.ok(revAt(50) > 0);
  // The far end of the slider is punished: max-price bags earn less than the optimum.
  const bags = ANCILLARY_MAP.bags;
  assert.ok(revAt(bags.maxPrice) < revAt(Math.round(bags.refPrice * 1.4)), 'slider ceiling is past the revenue peak');
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
