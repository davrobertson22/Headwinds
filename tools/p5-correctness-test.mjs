// P5 correctness fixes — engine-level (no DB, no network).
//   node tools/p5-correctness-test.mjs
//   • line-maintenance hub discount is best-of-routes, not last-route-wins
//   • finance forecast returns the lease security deposit on a lease's final week
import assert from 'node:assert/strict';
import { weeklyTick, aircraftHubMaintFactor, defaultConfig, defaultClassPrices } from '../packages/engine/src/utils/simulation.js';
import { projectWeek } from '../packages/engine/src/utils/financeProjection.js';
import { getAircraftType } from '../packages/engine/src/data/aircraft.js';
import { referencePrice } from '../packages/engine/src/utils/market.js';
import { DEFAULT_LABOR_STATE } from '../packages/engine/src/data/labor.js';

Math.random = () => 0.5; // pin RNG so events/failures never perturb totals

const NB = getAircraftType('b737800');
const pk = (a, b) => [a, b].sort().join('-');
let passed = 0, failed = 0;
const t = (name, fn) => { try { fn(); console.log('  ok  ' + name); passed++; } catch (e) { console.log('  FAIL ' + name + '\n       ' + (e.message || e)); failed++; } };

// ── Line-maintenance: an aircraft flying a hub route AND a non-hub spoke keeps
//    the hub discount regardless of route order (HEAD: last route in the array
//    wins, so the spoke resets the discount). ──────────────────────────────────
function maintState(order) {
  const hub   = { id: 'rHub',   origin: 'SFO', destination: 'ORD', aircraftId: 'a0', weeklyFrequency: 14, weeksOpen: 40 };
  const spoke = { id: 'rSpoke', origin: 'SFO', destination: 'LAX', aircraftId: 'a0', weeklyFrequency: 14, weeksOpen: 40 };
  return {
    fleet: [{ id: 'a0', typeId: NB.id, status: 'assigned', ageWeeks: 150, config: defaultConfig(NB.seats),
              ownershipType: 'lease', weeklyLease: NB.weeklyLease, leaseRemainingWeeks: 200 }],
    routes: order === 'hubfirst' ? [hub, spoke] : [spoke, hub],
    cargoRoutes: [], week: 20, year: 1, cash: 5e7,
    gates: { SFO: 40, ORD: 8, LAX: 8 },
    hubs: { ORD: { tier: 3, tierSince: 0 } }, // Intl Gateway → maintFactor 0.92
    routePricing: { [pk('SFO','ORD')]: defaultClassPrices(Math.round(referencePrice('SFO','ORD'))),
                    [pk('SFO','LAX')]: defaultClassPrices(Math.round(referencePrice('SFO','LAX'))) },
    routeCatering: {}, competitors: [], labor: DEFAULT_LABOR_STATE, awareness: 52, activeEvents: [],
  };
}
t('hub-maintenance discount is route-order independent', () => {
  const hubFirst   = weeklyTick(maintState('hubfirst')).totalMaintenance;
  const spokeFirst = weeklyTick(maintState('spokefirst')).totalMaintenance;
  assert.equal(hubFirst, spokeFirst, `order-dependent: ${hubFirst} vs ${spokeFirst}`);
});
t('the discount actually lowers maintenance vs no hub', () => {
  const withHub = weeklyTick(maintState('hubfirst')).totalMaintenance;
  const noHubState = maintState('hubfirst'); noHubState.hubs = {};
  const withoutHub = weeklyTick(noHubState).totalMaintenance;
  assert.ok(withHub < withoutHub, `expected discount (${withHub}) < undiscounted (${withoutHub})`);
});
t('oracle: aircraftHubMaintFactor is the best (min) factor across routes', () => {
  const s = maintState('spokefirst');
  assert.equal(aircraftHubMaintFactor('a0', s.routes, [], s.hubs), 0.92);
});

// ── Lease deposit refund on a lease's final projected week ────────────────────
function leaseState(rem, deposit) {
  return {
    fleet: [{ id: 'a0', typeId: NB.id, status: 'assigned', ageWeeks: 150, config: defaultConfig(NB.seats),
              ownershipType: 'lease', weeklyLease: NB.weeklyLease, leaseRemainingWeeks: rem, leaseDeposit: deposit }],
    routes: [{ id: 'r0', origin: 'SFO', destination: 'LAX', aircraftId: 'a0', weeklyFrequency: 14, weeksOpen: 40 }],
    cargoRoutes: [], week: 20, year: 1, cash: 5e7,
    gates: { SFO: 40, LAX: 8 }, hubs: {},
    routePricing: { [pk('SFO','LAX')]: defaultClassPrices(Math.round(referencePrice('SFO','LAX'))) },
    routeCatering: {}, competitors: [], labor: DEFAULT_LABOR_STATE, awareness: 52, activeEvents: [],
  };
}
const D = NB.weeklyLease * 12;
t('deposit refunded on the final week; nothing when not ending', () => {
  assert.equal(projectWeek(leaseState(1, D)).leaseDepositRefund, D);
  assert.equal(projectWeek(leaseState(5, D)).leaseDepositRefund, 0);
  assert.equal(projectWeek(leaseState(1, D)).leaseRedelivery, NB.weeklyLease * 4);
});
t('refund flows to cash but is not taxed', () => {
  const withDep = projectWeek(leaseState(1, D));
  const noDep   = projectWeek(leaseState(1, 0));
  assert.equal(withDep.corporateTax, noDep.corporateTax, 'deposit refund must not be taxed');
  assert.equal(withDep.preTaxProfit - noDep.preTaxProfit, D, 'refund adds to pre-tax cash');
  assert.equal(withDep.netCash - noDep.netCash, D, 'refund adds to net cash');
});

console.log(`\np5-correctness: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
