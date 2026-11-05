// Freight connections — at any airport where the player flies ≥2 freighter
// routes, freight between the outer cities connects (docs/cargo-connections-design.md).
// Before this, HKG–ANC plus ANC–ORD earned nothing from Hong Kong–Chicago freight.
//
//   node tools/cargo-connections-test.mjs
import assert from 'node:assert/strict';
import * as sim from '../src/utils/simulation.js';
import { cargoReferenceYield as cy, cargoCityPairDemand } from '../src/utils/market.js';

const { weeklyTick, simulateCargoRoute } = sim;
const simulateCargoNetwork = sim.simulateCargoNetwork;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}
const freighter = (id, typeId = 'b777f') => ({ id, typeId, status: 'assigned', ageWeeks: 52, ownershipType: 'owned' });
const cRoute = (o, d, ac, opts = {}) => ({
  id: opts.id ?? `c-${o}${d}`, origin: o, destination: d, aircraftId: ac,
  yieldPrice: opts.yieldPrice ?? cy(o, d), weeklyFrequency: opts.freq ?? 7,
  weeksOpen: opts.weeksOpen ?? 60, cargo: true,
});
const GD = { month: 6 };
const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);

// Anchorage transit hub: Hong Kong and Chicago both on 777Fs through ANC, flown
// twice daily so the legs have payload to spare once local freight is loaded.
const hubRoutes = [cRoute('HKG', 'ANC', 'f1', { freq: 14 }), cRoute('ANC', 'ORD', 'f2', { freq: 14 })];
const hubFleet  = [freighter('f1'), freighter('f2')];

console.log('\nFreight connections\n');

test('weekly tick: an Anchorage hub carries Hong Kong–Chicago freight (fails on HEAD)', () => {
  const state = {
    week: 30, year: 1, cash: 5e7, fleet: hubFleet, routes: [], cargoRoutes: hubRoutes,
    gates: { HKG: 8, ANC: 6, ORD: 6 }, gameDate: { week: 30, month: 6 }, hub: 'ANC', hubs: {},
    competitors: [], financialHistory: [], awareness: 60, loans: [], activeEvents: [],
    fuelPrice: { index: 1, history: [] },
  };
  const rep = weeklyTick(state);
  const conn = sum(rep.cargoRouteResults, r => r.connectingTonnes ?? 0);
  assert.ok(conn > 0, `connecting tonnes on the legs: ${conn} (HEAD: none — freight was point-to-point)`);
  const feed = rep.cargoRouteResults.flatMap(r => r.feeds ?? []).find(f => f.od === 'HKG-ORD');
  assert.ok(feed && feed.via === 'ANC', 'HKG–ORD freight connects via ANC');
  assert.equal(rep.totalCargoRevenue, Math.round(sum(rep.cargoRouteResults, r => r.revenue)),
    'cargo revenue total includes the connecting freight booked on the legs');
});

if (typeof simulateCargoNetwork !== 'function') {
  console.log('  ✗ simulateCargoNetwork is not exported');
  failed++;
} else {
  const net = simulateCargoNetwork(hubRoutes, hubFleet, { gameDate: GD });

  test('local freight is untouched and loads first', () => {
    for (const r of hubRoutes) {
      const solo = simulateCargoRoute(r, hubFleet.find(a => a.id === r.aircraftId), GD);
      const res  = net.results.get(r.id);
      assert.equal(res.localTonnes, solo.tonnes, `${r.id} local tonnes unchanged`);
      assert.equal(res.localRevenue, solo.revenue, `${r.id} local revenue unchanged`);
      assert.ok(res.connectingTonnes > 0);
    }
  });

  test('no leg carries more than its payload', () => {
    for (const res of net.results.values()) {
      assert.ok(res.tonnes <= res.capacityTonnes + 1, `${res.tonnes} > ${res.capacityTonnes}`);
      assert.ok(res.loadFactor <= 1.0001);
    }
  });

  test('connecting tonnes ride BOTH legs; revenue is split between them, not doubled', () => {
    const flow = net.flows.find(f => f.od === 'HKG-ORD');
    assert.ok(flow);
    const [a, b] = hubRoutes.map(r => net.results.get(r.id));
    assert.ok(Math.abs(a.connectingTonnes - flow.tonnes) <= 1 && Math.abs(b.connectingTonnes - flow.tonnes) <= 1);
    assert.ok(Math.abs(a.connectingRevenue + b.connectingRevenue - flow.revenue) <= 2);
    assert.ok(a.connectingRevenue > b.connectingRevenue, 'the longer HKG–ANC leg takes the bigger share');
  });

  test('profit and costs stay consistent on a leg with connecting freight', () => {
    for (const res of net.results.values()) {
      assert.equal(res.profit, res.revenue - res.totalOpCost);
      assert.ok(res.connectingHandling > 0);
    }
  });

  test('a big detour does not connect (HKG–NRT never routes via Dubai)', () => {
    const rs = [cRoute('DXB', 'HKG', 'f1'), cRoute('DXB', 'NRT', 'f2')];
    for (const r of rs) assert.ok(simulateCargoRoute(r, freighter('f1'), GD), `${r.id} must be flyable`);
    const n = simulateCargoNetwork(rs, hubFleet, { gameDate: GD });
    assert.equal(n.flows.length, 0);
    for (const r of rs) assert.equal(n.results.get(r.id).connectingTonnes, undefined);
  });

  test('a network with no connections is byte-identical to point-to-point', () => {
    const rs = [cRoute('HKG', 'FRA', 'f1')];
    const n = simulateCargoNetwork(rs, [freighter('f1')], { gameDate: GD });
    assert.deepEqual(n.results.get(rs[0].id), simulateCargoRoute(rs[0], freighter('f1'), GD));
    const off = simulateCargoNetwork(hubRoutes, hubFleet, { gameDate: GD, connections: false });
    for (const r of hubRoutes)
      assert.deepEqual(off.results.get(r.id), simulateCargoRoute(r, hubFleet.find(a => a.id === r.aircraftId), GD));
  });

  test('one pool: an own nonstop leaves less for the connection, never more than the pool', () => {
    // Legs with payload to spare, so the connection is set by demand, not space.
    const legs = [cRoute('LAX', 'ANC', 'f1', { freq: 28 }), cRoute('ANC', 'NRT', 'f2', { freq: 28 })];
    const direct = cRoute('LAX', 'NRT', 'f3', { id: 'direct' });
    const fl = ['f1', 'f2', 'f3'].map(id => freighter(id));
    const without = simulateCargoNetwork(legs, fl, { gameDate: GD });
    const withD   = simulateCargoNetwork([...legs, direct], fl, { gameDate: GD });
    const d = withD.results.get('direct');
    assert.ok(d, 'a 777F must fly LAX–NRT nonstop for this test');
    const a = without.flows.find(f => f.od === 'LAX-NRT')?.tonnes ?? 0;
    const b = withD.flows.find(f => f.od === 'LAX-NRT')?.tonnes ?? 0;
    assert.ok(a > 0, 'LAX–NRT connects via ANC');
    assert.ok(b < a, `connection ${b} should shrink below ${a} next to an own nonstop`);
    assert.ok(d.tonnes + b <= cargoCityPairDemand('LAX', 'NRT', GD.month) + 1);
  });

  test('a rival nonstop on the lane dilutes connecting freight', () => {
    const rival = { cargoRoutes: { 'HKG-ORD': { tonnesPerWeek: 1500, yieldPrice: cy('HKG', 'ORD') } } };
    const n = simulateCargoNetwork(hubRoutes, hubFleet, { gameDate: GD, competitors: [rival] });
    const a = n.flows.find(f => f.od === 'HKG-ORD')?.tonnes ?? 0;
    const b = net.flows.find(f => f.od === 'HKG-ORD').tonnes;
    assert.ok(a < b, `${a} should be below ${b}`);
  });

  test('pricing the legs above the market wins less connecting freight', () => {
    // Payload to spare on both legs, so tonnage is set by demand, not space
    // (when legs are full, pricing up sheds LOCAL freight and makes room instead).
    const roomy  = hubRoutes.map(r => ({ ...r, weeklyFrequency: 28 }));
    const pricey = roomy.map(r => ({ ...r, yieldPrice: r.yieldPrice * 1.4 }));
    const a = simulateCargoNetwork(pricey, hubFleet, { gameDate: GD }).flows.find(f => f.od === 'HKG-ORD')?.tonnes ?? 0;
    const b = simulateCargoNetwork(roomy,  hubFleet, { gameDate: GD }).flows.find(f => f.od === 'HKG-ORD')?.tonnes ?? 0;
    assert.ok(a < b);
  });

  test('a grounded leg breaks the connection', () => {
    const n = simulateCargoNetwork(hubRoutes, hubFleet, { gameDate: GD, groundedIds: ['f2'] });
    assert.equal(n.flows.length, 0);
    assert.equal(n.results.has(hubRoutes[1].id), false);
  });

  test('two hubs offering one market split ONE pool', () => {
    // HKG–LAX via ANC and via NRT: both legs short-ish, circuity under the cap.
    const rs = [cRoute('HKG', 'ANC', 'f1', { freq: 28 }), cRoute('ANC', 'LAX', 'f2', { freq: 28 }),
                cRoute('HKG', 'NRT', 'f3', { freq: 28 }), cRoute('NRT', 'LAX', 'f4', { freq: 28 })];
    const fl = ['f1', 'f2', 'f3', 'f4'].map(id => freighter(id));
    const n  = simulateCargoNetwork(rs, fl, { gameDate: GD });
    const via = n.flows.filter(f => f.od === 'HKG-LAX');
    assert.equal(via.length, 2, 'both hubs carry some of it');
    assert.ok(sum(via, f => f.tonnes) <= cargoCityPairDemand('HKG', 'LAX', GD.month) * 0.6 + 1,
      'all connections on a market together stay within the capture share of its pool');
  });
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
