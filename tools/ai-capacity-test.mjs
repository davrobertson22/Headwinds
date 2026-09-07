// ai-capacity-test.mjs — AI carriers right-size capacity to their loads.
// Run: node tools/ai-capacity-test.mjs
//
// HUB_CONNECTIVITY_PLAN.md "AI capacity realism". Before this, an AI carrier's
// capacity on a route was fixed at launch (a tier-sized type × 3–21 flights a
// week) for the life of the route. On a trunk lane it sat capacity-capped
// forever and its overflow flowed to whoever else served the pair — free
// passengers for the player. Now a carrier that is chronically full adds
// frequency (and up-gauges once the schedule is dense), and one flying empty
// trims before it exits.
//
// The AI reads its own P&L (computeCompetitorRoutePnL) — loadFactor 0.88 means
// "demand exceeded what we flew" — so these tests drive the AI tick alone with
// a carrier the tests construct by hand; no player, no other rivals.

import assert from 'node:assert/strict';
import { tickCompetitorAI } from '../packages/engine/src/models/competitorAI.js';
import {
  computeCompetitorRoutePnL, pickCompetitorAircraftType, pickLargerCompetitorAircraftType,
  tailsForRoute, makeCompetitorTail,
} from '../packages/engine/src/models/demand.js';
import { getAircraftType } from '../packages/engine/src/data/aircraft.js';
import { routeDistance } from '../packages/engine/src/utils/market.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

// Pin the dice: the AI's only randomness on these paths is archetype/fare-war
// rolls, none of which we want to see.
Math.random = () => 0.5;

function carrier(routes, extra = {}) {
  const c = {
    id: 'ai-cap', name: 'Cap Air', homeHub: 'JFK', tier: 'legacy', logoId: 'eagle',
    baseQualityScore: 60, cash: 80_000_000, profitHistory: [1_000_000, 1_000_000],
    _archetype: 'balanced', allianceId: null,
    routes: {}, fleet: [],
    ...extra,
  };
  for (const [key, cfg] of Object.entries(routes)) {
    const [a, b] = key.split('-');
    const dist = routeDistance(a, b);
    const type = cfg.aircraftType ? getAircraftType(cfg.aircraftType) : pickCompetitorAircraftType(dist, c.tier);
    const tails = cfg.tails ?? tailsForRoute(dist, cfg.frequency);
    c.routes[key] = { priceMultiplier: 1.0, ...cfg, aircraftType: type.id, tails };
    for (let i = 0; i < tails; i++) c.fleet.push(makeCompetitorTail(c.id, type.id, key, true));
  }
  return c;
}

/** Tick `weeks` weeks of AI with no player; returns the carrier + all events. */
function run(c, weeks, playerRoutes = []) {
  let comps = [c];
  const events = [];
  for (let wk = 1; wk <= weeks; wk++) {
    const month = Math.min(12, Math.ceil(((wk - 1) % 52 + 1) / 4.34));
    const r = tickCompetitorAI(comps, { weekNumber: wk, month, playerRoutes, playerHubs: [], playerMarketCap: 0 });
    comps = r.competitors;
    events.push(...r.events);
  }
  return { c: comps[0], events };
}

function fleetOn(c, key) { return (c.fleet ?? []).filter(t => t.routeKey === key); }

console.log('── AI capacity realism ──');

test('P&L exposes the demand behind the load factor', () => {
  const c = carrier({ 'JFK-LHR': { frequency: 3 } });
  const p = computeCompetitorRoutePnL(c, 'JFK-LHR', c.routes['JFK-LHR'], 6);
  assert.ok(p.demandOneWay > p.capOneWay, `demand ${p.demandOneWay} should exceed cap ${p.capOneWay}`);
  assert.equal(p.seats, getAircraftType(c.routes['JFK-LHR'].aircraftType).seats);
  assert.ok(p.loadFactor >= 0.85, `a demand-capped route reads the 88% cap (got ${p.loadFactor.toFixed(3)})`);
});

test('a chronically full route gains frequency', () => {
  const c0 = carrier({ 'JFK-LHR': { frequency: 3 } });
  const { c, events } = run(c0, 26);
  const cfg = c.routes['JFK-LHR'];
  assert.ok(cfg.frequency > 3, `frequency ${cfg.frequency} should have grown`);
  assert.equal(cfg.tails, tailsForRoute(routeDistance('JFK', 'LHR'), cfg.frequency), 'tails follow the schedule');
  assert.equal(fleetOn(c, 'JFK-LHR').length, cfg.tails, 'fleet inventory matches tails');
  assert.ok(c.cash < c0.cash, 'the added tails cost a deposit');
  assert.ok(events.some(e => e.type === 'boost' && e.routeKey === 'JFK-LHR'), 'growth is reported');
});

test('growth is gradual — no doubling in a single move', () => {
  const c0 = carrier({ 'JFK-LHR': { frequency: 8 } });
  let prev = 8;
  let comps = [c0];
  for (let wk = 1; wk <= 30; wk++) {
    comps = tickCompetitorAI(comps, { weekNumber: wk, month: 6, playerRoutes: [], playerHubs: [], playerMarketCap: 0 }).competitors;
    const f = comps[0].routes['JFK-LHR'].frequency;
    assert.ok(f <= Math.ceil(prev * 1.35), `week ${wk}: ${prev} → ${f} is too big a jump`);
    prev = f;
  }
});

test('growth is bounded by demand and the schedule cap', () => {
  // A thin long-haul pair (profitable at 3/wk, a money pit at 21/wk): a few
  // extra flights soak up the demand, then it stops.
  const c0 = carrier({ 'JFK-LOS': { frequency: 3 } });
  const { c } = run(c0, 156);
  const cfg = c.routes['JFK-LOS'];
  const p = computeCompetitorRoutePnL(c, 'JFK-LOS', cfg, 6);
  assert.ok(cfg.frequency <= 28, `frequency ${cfg.frequency} within the 28/wk cap`);
  assert.ok(cfg.frequency < 14, `a ~1,700 pax/wk pair does not justify ${cfg.frequency} flights of ${p.seats} seats`);
  // It stopped for a reason: either the demand is met, or one more flight
  // would earn less than the schedule it has (growth has to pay).
  const oneMore = computeCompetitorRoutePnL(c, 'JFK-LOS', { ...cfg, frequency: cfg.frequency + 1, tails: tailsForRoute(routeDistance('JFK', 'LOS'), cfg.frequency + 1) }, 6);
  assert.ok(p.loadFactor < 0.85 || oneMore.profit <= p.profit,
    `stopped at ${cfg.frequency}/wk with LF ${p.loadFactor.toFixed(2)} although +1 would earn ${oneMore.profit - p.profit} more`);
});

test('a dense full schedule up-gauges to a larger type', () => {
  const dist = routeDistance('JFK', 'LHR');
  const small = pickCompetitorAircraftType(dist, 'legacy');
  assert.ok(pickLargerCompetitorAircraftType(dist, small.seats * 1.15), 'a bigger capable type exists');
  const c0 = carrier({ 'JFK-LHR': { frequency: 24, aircraftType: small.id } });
  const { c, events } = run(c0, 52);
  const cfg = c.routes['JFK-LHR'];
  const type = getAircraftType(cfg.aircraftType);
  assert.ok(type.seats > small.seats, `${type.id} (${type.seats}) should out-seat ${small.id} (${small.seats})`);
  assert.ok(fleetOn(c, 'JFK-LHR').every(t => t.typeId === type.id), 'the whole route fleet is swapped');
  assert.equal(fleetOn(c, 'JFK-LHR').length, cfg.tails);
  assert.ok(events.some(e => e.type === 'boost' && /larger|up-gauged|bigger/i.test(e.description)), 'up-gauge is reported');
});

test('a chronically empty route is trimmed before it is cut', () => {
  const c0 = carrier({ 'JFK-LOS': { frequency: 21 } });
  const p0 = computeCompetitorRoutePnL(c0, 'JFK-LOS', c0.routes['JFK-LOS'], 6);
  assert.ok(p0.loadFactor < 0.5, `starts half-empty (LF ${p0.loadFactor.toFixed(2)})`);
  const { c, events } = run(c0, 52);
  const cfg = c.routes['JFK-LOS'];
  assert.ok(cfg, 'the route survives (right-sized, not withdrawn)');
  assert.ok(cfg.frequency < 21 && cfg.frequency >= 3, `frequency ${cfg.frequency} trimmed`);
  assert.equal(cfg.tails, tailsForRoute(routeDistance('JFK', 'LOS'), cfg.frequency));
  assert.equal(fleetOn(c, 'JFK-LOS').length, cfg.tails, 'surplus tails leave the fleet');
  assert.ok(events.some(e => e.type === 'trim' && e.routeKey === 'JFK-LOS'), 'the trim is reported');
  const p1 = computeCompetitorRoutePnL(c, 'JFK-LOS', cfg, 6);
  assert.ok(p1.loadFactor > p0.loadFactor, 'loads recover');
});

test('a route in a fare war is not trimmed (the losses are deliberate)', () => {
  // A war only lives while the player is on the pair (fare-war upkeep).
  const c0 = carrier({ 'HEL-OUL': { frequency: 21 } }, { _fareWars: { 'HEL-OUL': { weeksLeft: 99, prevMult: 1.0 } } });
  const { c } = run(c0, 20, [{ origin: 'HEL', destination: 'OUL', ticketPrice: 120, weeklyFrequency: 21 }]);
  assert.equal(c.routes['HEL-OUL'].frequency, 21);
});

test('no growth without the cash for it', () => {
  const c0 = carrier({ 'JFK-LHR': { frequency: 3 } }, { cash: 1_000_000, profitHistory: [-500_000] });
  const { c } = run(c0, 26);
  assert.equal(c.routes['JFK-LHR'].frequency, 3, 'a broke carrier cannot add tails');
});

test('at most two capacity moves per action week', () => {
  const c0 = carrier({
    'JFK-LHR': { frequency: 3 }, 'JFK-LAX': { frequency: 3 }, 'JFK-MIA': { frequency: 3 },
    'JFK-BOS': { frequency: 3 }, 'JFK-ORD': { frequency: 3 },
  });
  // Balanced acts every 5 weeks; find the first action week that moves anything.
  let comps = [c0];
  for (let wk = 1; wk <= 20; wk++) {
    const r = tickCompetitorAI(comps, { weekNumber: wk, month: 6, playerRoutes: [], playerHubs: [], playerMarketCap: 0 });
    comps = r.competitors;
    const moves = r.events.filter(e => e.type === 'boost' || e.type === 'trim').length;
    assert.ok(moves <= 2, `week ${wk}: ${moves} capacity moves`);
  }
});

test('state stays well-formed over a long run', () => {
  const c0 = carrier({ 'JFK-LHR': { frequency: 3 }, 'HEL-OUL': { frequency: 21 }, 'JFK-LAX': { frequency: 7 } });
  const { c } = run(c0, 260);
  for (const [key, cfg] of Object.entries(c.routes)) {
    assert.ok(Number.isInteger(cfg.frequency) && cfg.frequency >= 1 && cfg.frequency <= 28, `${key} freq ${cfg.frequency}`);
    assert.ok(Number.isInteger(cfg.tails) && cfg.tails >= 1, `${key} tails ${cfg.tails}`);
    assert.equal(fleetOn(c, key).length, cfg.tails, `${key} fleet/tails`);
    assert.ok(getAircraftType(cfg.aircraftType), `${key} type ${cfg.aircraftType}`);
  }
  assert.ok(Number.isFinite(c.cash));
  assert.equal(c.fleet.length, Object.values(c.routes).reduce((s, r) => s + r.tails, 0), 'no orphan tails');
});

console.log(`\n${passed} passed${process.exitCode ? ', FAILURES above' : ''}`);
