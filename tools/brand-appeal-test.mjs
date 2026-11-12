// The Brand page explains WHY travellers pick you, term by term.
//
// Business and leisure appeal come from computeUtility's own terms, on the same
// offers pairMarketShare builds for the weekly share fight. These tests pin:
//
//   1. the parts are computeUtility's parts — they add up, in the same order,
//      to exactly the score the softmax uses (so the page cannot describe a
//      different sum from the one that books passengers), and asking for them
//      leaves the score itself untouched;
//   2. the appeal model reads the right direction off a real share fight — out-
//      flying a rival shows as a help, overpricing it as a hurt;
//   3. a pair you fly alone has no rival to compare with and is counted apart;
//   4. the Brand page renders: verdicts, reasons, the marketing card, and no
//      separate Marketing page left in the map view.
//
//   node --import ./tools/_register-loader.mjs tools/brand-appeal-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
  key: (i) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};
globalThis.window ??= {
  localStorage: globalThis.localStorage,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
};
if (!globalThis.window.localStorage) globalThis.window.localStorage = globalThis.localStorage;

const { computeUtility, computeUtilityParts, UTILITY_PARTS } = await import('../src/models/demand.js');
const { brandAppeal, appealVerdict, qualityReasons } = await import('../src/models/brandAppeal.js');
const { referencePrice } = await import('../src/utils/market.js');
const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const { MAP_PAGES, MAP_GROUPS } = await import('../src/components/MapShell.jsx');
const Reputation = (await import('../src/components/Reputation.jsx')).default;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
const text = (html) => html.replace(/<!-- -->/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&')
  .replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

// ── 1. The parts are computeUtility's parts ─────────────────────────────────

console.log('\n── computeUtility, term by term ─────────────────────────');

let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const market = { referencePrice: 300, distanceKm: 1800, origin: 'SFO', destination: 'ORD' };
const offers = Array.from({ length: 60 }, (_, i) => ({
  airlineId: i % 3 ? `r${i}` : 'player',
  economyPrice: 150 + rnd() * 400,
  businessPrice: i % 4 ? 600 + rnd() * 900 : null,
  qualityScore: rnd() * 100,
  qualityScoreBusiness: rnd() * 100,
  weeklyFrequency: Math.floor(rnd() * 30),
  connectivityBonus: rnd() * 0.27,
  marketingBoost: i % 5 ? 0 : rnd() * 0.15,
  brandReach: 0.3 + rnd(),
  loungeAppeal: i % 6 ? 1 : 1 + rnd() * 0.2,
  travelLeisureAppeal: i % 7 ? 1 : 1.05,
  travelBusinessAppeal: i % 8 ? 1 : 1.04,
  loyaltyAppeal: 1 + rnd() * 0.1,
  priceSensitivityReduction: rnd() * 0.2 - 0.1,
  jetAgeAppeal: i % 9 ? 1 : 0.7,
}));

test('the parts sum, in order, to exactly the score the share fight uses', () => {
  for (const o of offers) for (const seg of ['leisure', 'business']) {
    const p = computeUtilityParts(o, market, seg);
    const sum = UTILITY_PARTS.reduce((s, k) => s + p[k], 0);
    assert.equal(p.total, computeUtility(o, market, seg));
    assert.equal(sum, p.total, `${seg}: parts ${sum} vs total ${p.total}`);
  }
});

test('asking for the parts does not change the score', () => {
  for (const o of offers) {
    const plain = computeUtility(o, market, 'leisure');
    const withOut = computeUtility(o, market, 'leisure', {});
    assert.equal(withOut, plain);
  }
});

test('every named part is filled', () => {
  const p = computeUtilityParts(offers[0], market, 'business');
  for (const k of UTILITY_PARTS) assert.ok(Number.isFinite(p[k]), `${k} = ${p[k]}`);
});

// ── 2/3. The appeal model on a real share fight ─────────────────────────────

console.log('\n── Appeal against rivals ────────────────────────────────');

const PAIRS = [['SFO', 'ORD'], ['SFO', 'JFK'], ['SFO', 'DEN']];
const pairKey = (a, b) => [a, b].sort().join('-');
const baseState = (over = {}) => ({
  ...freshState(), phase: 'playing', week: 20, year: 2, hub: 'SFO', cash: 20_000_000, awareness: 65,
  fleet: PAIRS.map((_, i) => ({
    id: `ac${i}`, typeId: 'a320ceo', tailNumber: `N${i}TEST`, status: 'assigned', ageWeeks: 52, ownershipType: 'owned',
    config: { economy: 186, seatQuality: 'standard', serviceQuality: 'standard' },
  })),
  routes: PAIRS.map(([o, d], i) => ({
    id: `r${i}`, origin: o, destination: d, aircraftId: `ac${i}`,
    weeklyFrequency: 21, weeksOpen: 40, ticketPrice: Math.round(referencePrice(o, d)),
  })),
  routePricing: {},
  competitors: [],
  ...over,
});
const rival = (routes) => ({ id: 'c1', name: 'Contest Air', tier: 'legacy', homeHub: 'ORD', baseQualityScore: 65, routes });

test('out-flying a rival is a reason travellers pick you', () => {
  const a = brandAppeal(baseState({ competitors: [rival({ [pairKey('SFO', 'ORD')]: { frequency: 3, priceMultiplier: 1.0 } })] }));
  const freq = a.leisure.terms.find((t) => t.key === 'frequency');
  assert.ok(freq.multiplier > 1.05, `frequency ×${freq.multiplier}`);
  assert.equal(freq.ahead, 1);
  assert.ok(a.leisure.helping.some((h) => h.reason === 'More flights than rivals'), JSON.stringify(a.leisure.helping));
});

test('pricing above a cheaper rival is a reason they do not', () => {
  const pricey = baseState({
    competitors: [rival({ [pairKey('SFO', 'ORD')]: { frequency: 21, priceMultiplier: 0.7 } })],
  });
  const a = brandAppeal(pricey);
  const price = a.leisure.terms.find((t) => t.key === 'price');
  assert.ok(price.multiplier < 0.95, `price ×${price.multiplier}`);
  assert.ok(a.leisure.hurting.some((h) => h.reason === 'Fares higher than rivals'), JSON.stringify(a.leisure.hurting));
});

test('the total is the sum of the terms, and the verdict follows it', () => {
  const a = brandAppeal(baseState({ competitors: [rival({ [pairKey('SFO', 'ORD')]: { frequency: 7, priceMultiplier: 0.9 } })] }));
  const sum = a.leisure.terms.reduce((s, t) => s + t.delta, 0);
  assert.ok(Math.abs(sum - a.leisure.total) < 1e-12);
  assert.deepEqual(a.leisure.verdict, appealVerdict(a.leisure.total));
});

test('pairs you fly alone are counted apart, not compared with nothing', () => {
  const a = brandAppeal(baseState({ competitors: [rival({ [pairKey('SFO', 'ORD')]: { frequency: 7, priceMultiplier: 1 } })] }));
  assert.equal(a.pairsScored, 3);
  assert.equal(a.soloPairs, 2);
  assert.equal(a.leisure.contestedPairs, 1);
  const alone = brandAppeal(baseState());
  assert.equal(alone.soloPairs, 3);
  assert.equal(alone.leisure.verdict, null);
  assert.equal(alone.business.verdict, null);
});

test('verdict bands are symmetric about the average rival', () => {
  assert.equal(appealVerdict(0).label, 'Average');
  assert.equal(appealVerdict(0.3).label, 'Strong');
  assert.equal(appealVerdict(-0.3).label, 'Below average');
  assert.equal(appealVerdict(0.9).label, 'Excellent');
  assert.equal(appealVerdict(-0.9).label, 'Weak');
});

test('quality reasons name the biggest gap', () => {
  const q = qualityReasons({ onTime: 15, onTimeRate: 0.5, cabin: 0, age: 19, rating: 25, customerRating: 4.5, designAge: 0, ground: 0 });
  assert.ok(q.hurting.some((r) => r.reason === 'Too many delays'));
  assert.ok(q.helping.some((r) => r.reason === 'Young fleet'));
  assert.ok(q.helping.length + q.hurting.length <= 3);
});

// ── 4. The page ─────────────────────────────────────────────────────────────

console.log('\n── The Brand page ───────────────────────────────────────');

const render = (s) => {
  store.clear();
  store.set('bbae_save_v2', JSON.stringify(s));
  return renderToString(React.createElement(GameProvider, null, React.createElement(Reputation)));
};

test('cards, reasons and the marketing card', () => {
  const html = render(baseState({ competitors: [rival({ [pairKey('SFO', 'ORD')]: { frequency: 3, priceMultiplier: 1 } })] }));
  const t = text(html);
  for (const s of ['Business travellers', 'Leisure travellers', 'Quality', 'See all factors', 'See breakdown', 'Brand Marketing', 'Targeted Campaigns']) {
    assert.ok(t.includes(s), `missing "${s}"`);
  }
  assert.ok(html.includes('data-brand-verdict="leisure"'), 'a leisure verdict');
  assert.ok(html.includes('id="marketing-budget"'), 'the Dashboard and Advisor deep link target');
  assert.ok(t.includes('More flights than rivals'));
});

test('a segment with no rival to compare says so instead of a verdict', () => {
  // The loaded game samples its own rival field, so the economy-only fixture
  // still meets rivals in leisure; nobody sells business against it.
  const t = text(render(baseState()));
  assert.ok(t.includes('No rivals yet'));
  assert.ok(t.includes('No route has a rival business cabin up against one of yours'));
});

test('the map view has no separate Marketing page any more', () => {
  assert.equal(MAP_PAGES.marketing, undefined);
  const service = MAP_GROUPS.find((g) => g.id === 'service');
  assert.ok(service.pages.includes('reputation') && !service.pages.includes('marketing'));
  assert.equal(MAP_PAGES.reputation.label, 'Brand');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
