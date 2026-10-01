// The fare cliff warning must tell the truth about the tick.
//
//   Dunno23  "it warns when prices are over the cliff, but the projected load
//            of routes stays the same, and the expected profit is still higher
//            than if the prices are brought back below the cliff"
//   Fr3nzi   "all my routes are above the fare cliff but still have a 90%+
//            projected load? … does fare cliff apply to non economy passengers"
//                                                        (Discord, 2026-09-24)
//
// Three lies, all measured on the real projection before this fix:
//   1. Premium cabins. The warning fired on premium economy, business and first,
//      but the cliff never reached them: raising any premium fare to 1.5×
//      reference changed no passenger counts and only added revenue.
//   2. Where the cliff starts. The engine's economy cliff sits at 1.10–1.25×
//      reference by route quality, ×0.95/0.90 on contested pairs; the warning
//      always used 1.10×.
//   3. Full routes. A cliff cuts DEMAND; a route with many times more demand
//      than seats loses most of its market and still fills every seat. The
//      banner called that "almost no passengers".
//
// So: premium cabins now meet a real cliff, the warning places the cliff where
// the engine does, and every flagged cabin says whether it is actually COSTING
// passengers this week — from the same projection the planner shows.
//
//   node --import ./tools/_register-loader.mjs tools/fare-cliff-agreement-test.mjs
import assert from 'node:assert/strict';

const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear(),
};

const { freshState } = await import('../src/store/GameContext.jsx');
const { projectWeek } = await import('../packages/engine/src/utils/financeProjection.js');
const { getAircraftType } = await import('../src/data/aircraft.js');
const { routePairKey, defaultClassPrices, referencePrice } = await import('../src/utils/simulation.js');
const { networkFareCliff, faresOverCliff, cliffFaresFor, pairFareCompression } = await import('../src/models/fareCliff.js');
const { setNwrYieldChoke, nwrYieldChokeFactor } = await import('../src/utils/market.js');

let passed = 0, failed = 0;
const test = (name, fn) => { try { fn(); console.log(`  ✓ ${name}`); passed++; } catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; } };

const NB = getAircraftType('b737800');
const CFG = { firstClass: 8, businessClass: 16, premiumEconomy: 24, economy: 100 };
const CABINS = ['firstClass', 'businessClass', 'premiumEconomy', 'economy'];

// Deterministic: no AI field (freshState samples one at random), so the only
// carrier on the pair is the player unless a test adds a rival.
function stateWith(o, d, fares, { nwr = true, competitors = [] } = {}) {
  return { ...freshState(), phase: 'playing', week: 20, year: 2, hub: o, cash: 4e8, newWorldRestrictions: nwr,
    gates: { [o]: 8, [d]: 4 }, competitors,
    fleet: [{ id: 'a1', typeId: NB.id, status: 'assigned', ageWeeks: 52, ownershipType: 'owned', config: CFG }],
    routes: [{ id: 'r1', origin: o, destination: d, aircraftId: 'a1', weeklyFrequency: 14, active: true }],
    routePricing: { [routePairKey(o, d)]: fares } };
}
const run = (st) => projectWeek(st).report.routeResults[0];
const flagged = (st) => {
  const results = projectWeek(st).report.routeResults;
  setNwrYieldChoke(st.newWorldRestrictions === true);   // the projection leaves it set from the last state
  return networkFareCliff(st, { routeResults: results })[0] ?? null;
};
const refFor = (o, d) => defaultClassPrices(referencePrice(o, d));
const with_ = (ref, cls, fare) => ({ ...ref, [cls]: fare });

// A dense pair (JFK–ORD: ~36,000 a week for 2,000 seats) and a thin one
// (DEN–GJT: ~1,500 a week) — the two regimes the banner has to tell apart.
const DENSE = ['JFK', 'ORD'], THIN = ['DEN', 'GJT'];

console.log('\n── Premium cabins have a real cliff ────────────────────');
{
  const ref = refFor(...DENSE);
  const base = run(stateWith(...DENSE, ref));
  for (const cls of ['premiumEconomy', 'businessClass', 'firstClass']) {
    test(`${cls} at 1.5× reference earns less than at reference`, () => {
      const r = run(stateWith(...DENSE, with_(ref, cls, Math.round(ref[cls] * 1.5))));
      assert.ok(r.classSummary[cls].revenue < base.classSummary[cls].revenue,
        `${cls} revenue ${r.classSummary[cls].revenue} vs ${base.classSummary[cls].revenue} at reference`);
      assert.ok(r.revenue < base.revenue, `route revenue ${r.revenue} vs ${base.revenue}`);
    });
  }
  test('a classic world is untouched — premium fares still carry the same passengers', () => {
    const a = run(stateWith(...DENSE, ref, { nwr: false }));
    const b = run(stateWith(...DENSE, with_(ref, 'firstClass', Math.round(ref.firstClass * 1.5)), { nwr: false }));
    assert.equal(b.classSummary.firstClass.passengers, a.classSummary.firstClass.passengers);
    assert.ok(!('cliffLostPax' in b.classSummary.firstClass));
  });
}

console.log('\n── The warning starts where the engine\'s cliff starts ─');
{
  setNwrYieldChoke(true);
  const st = stateWith(...DENSE, refFor(...DENSE));
  const cliff = cliffFaresFor(st, ...DENSE);
  const ref = refFor(...DENSE);
  test('a good airline gets more than the 10% floor', () => {
    assert.ok(cliff.economy > Math.round(ref.economy * 1.10), `economy cliff $${cliff.economy} vs ref $${ref.economy}`);
  });
  for (const cls of CABINS) {
    test(`${cls}: at the cliff fare nothing is lost; a few dollars over, the engine's factor bites`, () => {
      assert.equal(flaggedAt(cls, cliff[cls]), false, `flagged at $${cliff[cls]}`);
      assert.equal(flaggedAt(cls, cliff[cls] + Math.max(3, Math.round(cliff[cls] * 0.02))), true, 'not flagged 2% past');
    });
  }
  function flaggedAt(cls, fare) {
    const s = stateWith(...DENSE, with_(ref, cls, fare));
    return (flagged(s)?.cabins ?? []).some(c => c.cls === cls);
  }
}

console.log('\n── Past the cliff ≠ losing passengers ──────────────────');
{
  const ref = refFor(...DENSE);
  test('dense pair, economy 1.3×: flagged, but NOT costing — the plane is still full', () => {
    const st = stateWith(...DENSE, with_(ref, 'economy', Math.round(ref.economy * 1.3)));
    const f = flagged(st);
    assert.ok(f, 'should be flagged past the cliff');
    assert.equal(f.cabins.find(c => c.cls === 'economy').costing, false);
    // Within a few percent of what it carried at reference — the class mix and
    // the spill model shift a little as demand shrinks, the plane stays full.
    const at = run(st).passengers, was = run(stateWith(...DENSE, ref)).passengers;
    assert.ok(at >= was * 0.95, `carries ${at} vs ${was} at reference`);
  });
  const thin = refFor(...THIN);
  test('thin pair, economy 1.3×: flagged AND costing — and it really does carry fewer', () => {
    const st = stateWith(...THIN, with_(thin, 'economy', Math.round(thin.economy * 1.3)));
    const f = flagged(st);
    assert.equal(f?.cabins.find(c => c.cls === 'economy')?.costing, true);
    assert.equal(f.costing, true);
    assert.ok(run(st).passengers < run(stateWith(...THIN, thin)).passengers);
  });
  test('first class 1.5× on a pair where first is not full: costing', () => {
    const st = stateWith(...DENSE, with_(ref, 'firstClass', Math.round(ref.firstClass * 1.5)));
    assert.equal(flagged(st)?.cabins.find(c => c.cls === 'firstClass')?.costing, true);
  });
}

console.log('\n── Contested pairs ─────────────────────────────────────');
test('each rival on the pair brings the economy cliff 5% closer (floor 90%)', () => {
  const k = routePairKey(...DENSE);
  const rival = (id) => ({ id, name: id, routes: { [k]: { frequency: 7 } } });
  const st0 = stateWith(...DENSE, refFor(...DENSE));
  assert.equal(pairFareCompression(st0, ...DENSE), 1);
  assert.equal(pairFareCompression({ ...st0, competitors: [rival('a')] }, ...DENSE), 0.95);
  assert.equal(pairFareCompression({ ...st0, competitors: [rival('a'), rival('b'), rival('c')] }, ...DENSE), 0.90);
});

test('a fare set to exactly +10% is not flagged by rounding', () => {
  setNwrYieldChoke(true);
  const ref = refFor(...DENSE);
  for (const cls of CABINS) {
    assert.equal(faresOverCliff({ [cls]: Math.round(ref[cls] * 1.10) }, ...DENSE, { classes: [cls], quality: 0 }).length, 0, cls);
  }
});

test('classic worlds flag nothing', () => {
  const ref = refFor(...DENSE);
  assert.equal(flagged(stateWith(...DENSE, with_(ref, 'economy', Math.round(ref.economy * 1.5)), { nwr: false })), null);
});

void nwrYieldChokeFactor;
setNwrYieldChoke(false);
console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
