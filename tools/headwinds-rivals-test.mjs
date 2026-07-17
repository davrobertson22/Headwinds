// Humans-only competition test — no database, no network.
//
// Proves the multiplayer competition model end to end with the REAL engine:
//   • buildRivalViews derives competitor + per-pair offer views from other
//     players' states
//   • a human rival flying YOUR city pair takes a bite out of your revenue
//     (demand splits through the same channel encroachment uses)
//   • multiplayer ticks never run the AI: no competitor evolution, no AI
//     startups, no AI encroachment — competitors stay exactly as injected
//   • solo states are untouched: AI competitors still exist and evolve
//
//   node tools/headwinds-rivals-test.mjs

import assert from 'node:assert/strict';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import {
  buildRivalViews, withRivals, toHumanCompetitor, pairKeyOf,
  playerAllianceDef,
} from '../apps/headwinds-server/src/lib/humanRivals.mjs';
import { AIRCRAFT_TYPES } from '../packages/engine/src/data/aircraft.js';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; }
}

// Deterministic runs: the engine uses Math.random for fuel, events, jitter.
const realRandom = Math.random;
Math.random = () => 0.5;

// ── Fixtures: two airlines contesting JFK–BOS ─────────────────────────────────

// A short-haul type every starter fleet can fly JFK–BOS (~300 km) with.
const shortHaul = AIRCRAFT_TYPES.find((t) => !t.freighter && t.range > 800 && t.seats >= 50);
assert.ok(shortHaul, 'no suitable aircraft type found in engine data');

function makeAirline({ id, name, hub, dest, fare }) {
  let s = gameReducer(freshState(), { type: 'START_GAME', airlineName: name, hub, enableObjectives: false });
  s = { ...s, multiplayer: true, competitors: [], humanRivals: {}, encroachments: {} };
  s = gameReducer(s, { type: 'LEASE_AIRCRAFT', typeId: shortHaul.id });
  s = gameReducer(s, { type: 'ADD_GATE', airportCode: dest });
  const aircraftId = s.fleet[0]?.id;
  assert.ok(aircraftId, `${name}: lease failed`);
  s = gameReducer(s, {
    type: 'ADD_ROUTE', aircraftId, origin: hub, destination: dest, weeklyFrequency: 14,
  });
  assert.equal(s.routes.length, 1, `${name}: route not created (${s.error ?? 'no error'})`);
  if (fare) {
    s = gameReducer(s, { type: 'UPDATE_TICKET_PRICE', routeId: s.routes[0].id, ticketPrice: fare });
  }
  return { id, worldId: 'w1', name, hub, status: 'ACTIVE', state: s };
}

const alice = makeAirline({ id: 'a1', name: 'Alice Air', hub: 'JFK', dest: 'BOS' });
const bob = makeAirline({ id: 'a2', name: 'Bob Airways', hub: 'BOS', dest: 'JFK', fare: 120 });

console.log('\n── buildRivalViews ──────────────────────────────────────');

await test('each airline sees the other as its only (human) competitor', () => {
  const views = buildRivalViews([alice, bob]);
  const va = views.get('a1');
  assert.equal(va.competitors.length, 1);
  assert.equal(va.competitors[0].name, 'Bob Airways');
  assert.equal(va.competitors[0].human, true);
  assert.match(va.competitors[0].id, /^human:a2$/);
  const vb = views.get('a2');
  assert.equal(vb.competitors.length, 1);
  assert.equal(vb.competitors[0].name, 'Alice Air');
});

await test('the shared city pair appears in humanRivals with a priced offer', () => {
  const views = buildRivalViews([alice, bob]);
  const key = pairKeyOf('JFK', 'BOS');
  const specs = views.get('a1').humanRivals[key];
  assert.ok(specs?.length === 1, 'expected one rival spec on JFK-BOS');
  assert.equal(specs[0].competitorId, 'human:a2');
  assert.equal(specs[0].frequency, 14);
  assert.ok(specs[0].priceMultiplier > 0.1 && specs[0].priceMultiplier < 3, `sane priceMultiplier, got ${specs[0].priceMultiplier}`);
  assert.ok(specs[0].seatsPerFlight > 0);
});

await test('bankrupt/abandoned rivals are excluded from views', () => {
  const gone = { ...bob, status: 'BANKRUPT' };
  const views = buildRivalViews([alice, gone]);
  assert.equal(views.get('a1').competitors.length, 0);
  assert.deepEqual(views.get('a1').humanRivals, {});
});

console.log('\n── demand split on contested pairs ──────────────────────');

await test('a human rival on your route reduces your route revenue', () => {
  const views = buildRivalViews([alice, bob]);
  const solo = gameReducer(withRivals(alice.state, { competitors: [], humanRivals: {} }), { type: 'ADVANCE_WEEK' });
  const contested = gameReducer(withRivals(alice.state, views.get('a1')), { type: 'ADVANCE_WEEK' });
  const soloRev = solo.lastReport?.totalRevenue ?? 0;
  const contestedRev = contested.lastReport?.totalRevenue ?? 0;
  assert.ok(soloRev > 0, `solo revenue should be positive, got ${soloRev}`);
  assert.ok(contestedRev < soloRev,
    `contested revenue (${contestedRev}) should be below solo monopoly revenue (${soloRev})`);
});

console.log('\n── multiplayer ticks never run the AI ───────────────────');

await test('injected human competitors pass through the tick untouched', () => {
  const views = buildRivalViews([alice, bob]);
  const before = views.get('a1').competitors;
  const after = gameReducer(withRivals(alice.state, views.get('a1')), { type: 'ADVANCE_WEEK' });
  assert.equal(after.competitors.length, before.length, 'no AI startups spawned');
  assert.equal(after.competitors[0].id, 'human:a2');
  assert.deepEqual(Object.keys(after.competitors[0].routes), Object.keys(before[0].routes),
    'the AI never opens/cuts a human rival\'s routes');
  assert.deepEqual(after.encroachments ?? {}, {}, 'no AI encroachment in multiplayer');
  assert.equal((after.lastReport?.competitorEvents ?? []).length, 0, 'no AI market events');
});

await test('a lone player in a world faces zero competitors (and no AI backfill)', () => {
  const after = gameReducer(withRivals(alice.state, { competitors: [], humanRivals: {} }), { type: 'ADVANCE_WEEK' });
  assert.equal(after.competitors.length, 0);
  assert.equal(after.phase !== 'victory', true, 'no phantom last-rival-standing victory');
});

console.log('\n── solo game regression ─────────────────────────────────');

await test('solo states still get evolving AI competitors', () => {
  let s = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'Solo Air', hub: 'JFK', enableObjectives: false });
  assert.ok((s.competitors?.length ?? 0) > 0, 'solo game starts with AI competitors');
  const after = gameReducer(s, { type: 'ADVANCE_WEEK' });
  assert.ok((after.competitors?.length ?? 0) > 0, 'AI competitors survive the tick');
  assert.equal(after.multiplayer, undefined, 'solo state never becomes multiplayer');
});

console.log('\n── human competitor shape (Rivals tab contract) ─────────');

await test('toHumanCompetitor carries every field the Competition tab reads', () => {
  const c = toHumanCompetitor(bob);
  for (const field of ['id', 'name', 'logoId', 'homeHub', 'tier', 'cash', 'marketCap', 'baseQualityScore', 'routes']) {
    assert.ok(c[field] !== undefined, `missing ${field}`);
  }
  const key = pairKeyOf('JFK', 'BOS');
  assert.ok(c.routes[key], 'route map keyed by sorted pair');
  assert.ok(c.routes[key].frequency > 0 && c.routes[key].priceMultiplier > 0);
});

console.log('\n── OG veteran badge ──────────────────────────────────────');

await test('an OG account\'s airline carries og=true into rival views; others default false', () => {
  const ogBob = { ...bob, account: { isOG: true } };
  const views = buildRivalViews([alice, ogBob]);
  assert.equal(views.get('a1').competitors[0].og, true, 'OG rival flagged');
  assert.equal(views.get('a2').competitors[0].og, false, 'non-OG rival defaults false');
});

await test('withRivals injects the player\'s OWN badge as state.accountOG (set AND cleared)', () => {
  const ogAlice = { ...alice, account: { isOG: true } };
  const views = buildRivalViews([ogAlice, bob]);
  assert.equal(withRivals(ogAlice.state, views.get('a1')).accountOG, true);
  // Revoked badge clears on the next injection — never lingers from the blob.
  const stale = { ...alice.state, accountOG: true };
  assert.equal(withRivals(stale, buildRivalViews([alice, bob]).get('a1')).accountOG, false);
});

await test('og survives the weekly tick on injected competitors', () => {
  const ogBob = { ...bob, account: { isOG: true } };
  const views = buildRivalViews([alice, ogBob]);
  const after = gameReducer(withRivals(alice.state, views.get('a1')), { type: 'ADVANCE_WEEK' });
  assert.equal(after.competitors[0].og, true);
});

await test('the reserved-tag name pattern blocks OG/DEV look-alikes but not honest names', async () => {
  const { OG_NAME_PATTERN } = await import('../apps/headwinds-server/src/lib/worldService.mjs');
  for (const bad of ['Sky [OG]', '[og] Air', 'Air (OG)', '{0G} Jets', 'Sky [ O.G ]', 'Air <og>',
                     '[DEV] Air', 'Sky (dev)', '{D3V} Jets', 'Air <DEV>', '[ d.e.v ] Air']) {
    assert.ok(OG_NAME_PATTERN.test(bad), `should reject: ${bad}`);
  }
  for (const good of ['Skyline Atlantic', 'LOGAN Air', 'Golden Wings', 'OG-less Air', 'Origins Global',
                      'Devon Airways', 'Delta Victor Air', 'Developer Express']) {
    assert.ok(!OG_NAME_PATTERN.test(good), `should allow: ${good}`);
  }
});

console.log('\n── DEV badge (ADMIN_EMAILS-derived) ─────────────────────');

await test('an ADMIN_EMAILS account carries dev=true into views; everyone else false', () => {
  const prev = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = 'Dave@Example.com, other@ops.dev';
  try {
    const devBob = { ...bob, account: { isOG: false, email: 'dave@example.com' } };
    const plainAlice = { ...alice, account: { isOG: false, email: 'alice@example.com' } };
    const views = buildRivalViews([plainAlice, devBob]);
    assert.equal(views.get('a1').competitors[0].dev, true, 'dev rival flagged (case-insensitive)');
    assert.equal(views.get('a1').competitors[0].og, false, 'dev is independent of og');
    assert.equal(views.get('a2').competitors[0].dev, false, 'non-dev rival stays false');
    // Own badge flows through withRivals as accountDev — set AND cleared.
    assert.equal(withRivals(devBob.state, views.get('a2')).accountDev, true);
    const stale = { ...plainAlice.state, accountDev: true };
    assert.equal(withRivals(stale, views.get('a1')).accountDev, false);
  } finally {
    if (prev === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = prev;
  }
});

await test('with no ADMIN_EMAILS set, nobody is a dev (and payloads never carry emails)', () => {
  const prev = process.env.ADMIN_EMAILS;
  delete process.env.ADMIN_EMAILS;
  try {
    const views = buildRivalViews([
      { ...alice, account: { isOG: false, email: 'alice@example.com' } },
      { ...bob, account: { isOG: true, email: 'bob@example.com' } },
    ]);
    const rival = views.get('a1').competitors[0];
    assert.equal(rival.dev, false);
    assert.ok(!('email' in rival) && !('account' in rival), 'competitor payload must never leak the email/account');
  } finally {
    if (prev !== undefined) process.env.ADMIN_EMAILS = prev;
  }
});

console.log('\n── player alliances (engine benefits) ───────────────────');

// Alice and Bob found "Test Pact": both ACTIVE members via the alliance map.
const pactDef = playerAllianceDef({ id: 'pact1', name: 'Test Pact' }, 2);
const allianceMap = new Map([
  ['a1', { membership: { allianceId: pactDef.id, weeklyFee: pactDef.weeklyFee, role: 'FOUNDER' }, def: pactDef }],
  ['a2', { membership: { allianceId: pactDef.id, weeklyFee: pactDef.weeklyFee, role: 'MEMBER' }, def: pactDef }],
]);

await test('alliance map flows into views: rivals carry allianceId, own view carries membership + def', () => {
  const views = buildRivalViews([alice, bob], allianceMap);
  const va = views.get('a1');
  assert.equal(va.competitors[0].allianceId, 'hw:pact1');
  assert.equal(va.alliance.membership.allianceId, 'hw:pact1');
  assert.equal(va.alliance.def.name, 'Test Pact');
  const injected = withRivals(alice.state, va);
  assert.equal(injected.allianceMembership.allianceId, 'hw:pact1');
  assert.equal(injected.allianceDef.id, 'hw:pact1');
});

await test('leaving an alliance clears membership on the next injection (DB is authoritative)', () => {
  const views = buildRivalViews([alice, bob]); // no alliance map — nobody is allied
  const stale = { ...alice.state, allianceMembership: { allianceId: 'hw:pact1', weeklyFee: 60000 }, allianceDef: pactDef };
  const injected = withRivals(stale, views.get('a1'));
  assert.equal(injected.allianceMembership, null);
  assert.equal(injected.allianceDef, null);
});

await test('the weekly alliance fee is charged through the injected def', () => {
  const views = buildRivalViews([alice, bob], allianceMap);
  const after = gameReducer(withRivals(alice.state, views.get('a1')), { type: 'ADVANCE_WEEK' });
  assert.equal(after.lastReport?.totalAllianceFee, pactDef.weeklyFee,
    `expected weekly fee ${pactDef.weeklyFee}, got ${after.lastReport?.totalAllianceFee}`);
});

await test('an allied rival on your pair hurts less than a hostile one (demand boost applies)', () => {
  const hostileViews = buildRivalViews([alice, bob]);
  const alliedViews = buildRivalViews([alice, bob], allianceMap);
  const hostile = gameReducer(withRivals(alice.state, hostileViews.get('a1')), { type: 'ADVANCE_WEEK' });
  const allied = gameReducer(withRivals(alice.state, alliedViews.get('a1')), { type: 'ADVANCE_WEEK' });
  const hostileRev = hostile.lastReport?.totalRevenue ?? 0;
  const alliedRev = allied.lastReport?.totalRevenue ?? 0;
  assert.ok(alliedRev > hostileRev,
    `allied route revenue (${alliedRev}) should beat hostile (${hostileRev}) via the +${pactDef.demandBoostPct * 100}% partner boost`);
});

await test('solo alliances unaffected: static defs still resolve without state.allianceDef', () => {
  let s = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'Solo Air', hub: 'LHR', enableObjectives: false });
  s = gameReducer(s, { type: 'JOIN_ALLIANCE', allianceId: 'skybridge' });
  assert.equal(s.allianceMembership?.allianceId, 'skybridge');
  const after = gameReducer(s, { type: 'ADVANCE_WEEK' });
  assert.ok((after.lastReport?.totalAllianceFee ?? 0) > 0, 'static alliance weekly fee still charged');
});

Math.random = realRandom;
console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
