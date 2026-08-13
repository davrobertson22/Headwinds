// Multiplayer server hardening — six audited defects, one suite.
//
//   1. every human rival was scored at a hardcoded quality of 62, because
//      qualityOf() read two shapes the engine never writes;
//   3. a no-op decision was still journalled, and lib/publicDecisions.mjs passed
//      airportCode / typeId / origin / destination / allianceId through RAW —
//      together, an arbitrary-text broadcast into every player's news feed;
//   4. ADD_CARGO_ROUTE stored Math.max(0.01, Number(action.yieldPrice)), which
//      NaN sails straight through, putting NaN into the blob and wiping the
//      airline's cash on the next tick;
//   5. EXTEND_LEASE had no guard case and no reducer ceiling — a forged
//      addWeeks of 10,000,000 was applied verbatim;
//   6. the per-world READ endpoints never checked visibility: anybody with a
//      world id could read a PRIVATE world's standings, news, gates and rivals;
//   7. GET /worlds/:id/rivals/:airlineId pulled the whole ~523 kB state blob to
//      serve a few kB of public network data.
//
// No database and no HTTP: every fix is exercised through the pure function the
// route calls, with fixture rows standing in for Prisma.
//
//   node tools/server-hardening-test.mjs

import assert from 'node:assert/strict';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import { AIRCRAFT_TYPES, getAircraftType } from '../packages/engine/src/data/aircraft.js';
import { checkRouteRestrictions } from '../packages/engine/src/data/airportRestrictions.js';
import { toHumanCompetitor, toRivalSpecs, pairKeyOf } from '../apps/headwinds-server/src/lib/humanRivals.mjs';
import { guardDecision, GuardError } from '../apps/headwinds-server/src/lib/decisionGuard.mjs';
import * as pub from '../apps/headwinds-server/src/lib/publicDecisions.mjs';

const opt = async (spec) => { try { return await import(spec); } catch (e) { return { __err: e }; } };
const access = await opt('../apps/headwinds-server/src/lib/access.mjs');
const rivalProfile = await opt('../apps/headwinds-server/src/lib/rivalProfile.mjs');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

// Deterministic: the engine uses Math.random for fuel, events and jitter.
const realRandom = Math.random;
Math.random = () => 0.5;

// ═════════════════════════════════════════════════════════════════════════════
// 1. Rival quality must come from what the engine actually writes
// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 1. qualityOf reads lastReport.reputationScore ────────\n');

const shortHaul = AIRCRAFT_TYPES.find((t) =>
  !t.freighter && t.range > 800 && t.seats >= 50
  && !checkRouteRestrictions('JFK', 'BOS', 300, 14, t.category, { routes: [], aircraftType: t }));
assert.ok(shortHaul, 'no aircraft type can legally fly JFK–BOS');

function flownAirline() {
  let s = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'Quality Air', hub: 'JFK', enableObjectives: false });
  s = { ...s, multiplayer: true, competitors: [], humanRivals: {}, encroachments: {} };
  s = gameReducer(s, { type: 'LEASE_AIRCRAFT', typeId: shortHaul.id });
  s = gameReducer(s, { type: 'ADD_GATE', airportCode: 'BOS' });
  const aircraftId = s.fleet[0]?.id;
  s = gameReducer(s, { type: 'ADD_ROUTE', aircraftId, origin: 'JFK', destination: 'BOS', weeklyFrequency: 14, ticketPrice: 170 });
  assert.equal(s.routes.length, 1, 'fixture route did not open');
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  return { id: 'a1', worldId: 'w1', name: 'Quality Air', hub: 'JFK', status: 'ACTIVE', state: s };
}

const flown = flownAirline();

await test('the engine writes lastReport.reputationScore (and neither shape qualityOf used to read)', () => {
  assert.equal(typeof flown.state.lastReport?.reputationScore, 'number',
    'fixture precondition: the tick must produce a reputationScore');
  assert.equal(flown.state.lastReport?.reputation, undefined,
    'fixture precondition: lastReport.reputation is NOT written by this engine');
  assert.equal(flown.state.reputation?.overall, undefined,
    'fixture precondition: state.reputation.overall is NOT written by this engine');
});

await test('toHumanCompetitor carries the real reputation score, not the 62 default', () => {
  const expected = Math.max(30, Math.min(95, Math.round(flown.state.lastReport.reputationScore)));
  const c = toHumanCompetitor(flown);
  assert.equal(c.baseQualityScore, expected,
    `every human rival is being scored at the hardcoded default instead of ${expected}`);
});

await test('toRivalSpecs carries the real reputation score too', () => {
  const key = pairKeyOf('JFK', 'BOS');
  const expected = Math.max(30, Math.min(95, Math.round(flown.state.lastReport.reputationScore)));
  const spec = toRivalSpecs(flown)[key];
  assert.ok(spec, 'expected a spec on JFK-BOS');
  assert.equal(spec.qualityScore, expected,
    'the demand model scores every human rival at the hardcoded default');
  // And it must actually MOVE with the score, not coincidentally match.
  const withScore = (n) => toRivalSpecs({
    ...flown, state: { ...flown.state, lastReport: { ...flown.state.lastReport, reputationScore: n } },
  })[key].qualityScore;
  assert.equal(withScore(31), 31);
  assert.equal(withScore(94), 94);
});

await test('an airline with NO lastReport still falls back to the 62 default', () => {
  const fresh = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'New Air', hub: 'JFK', enableObjectives: false });
  const row = { id: 'a9', worldId: 'w1', name: 'New Air', hub: 'JFK', status: 'ACTIVE', state: { ...fresh, lastReport: undefined } };
  assert.equal(toHumanCompetitor(row).baseQualityScore, 62);
});

await test('the LEGACY shapes still win when a blob carries one', () => {
  const legacy = { id: 'a8', worldId: 'w1', name: 'Old Air', hub: 'JFK', status: 'ACTIVE',
    state: { fleet: [], routes: [], lastReport: { reputation: { overall: 77 } } } };
  assert.equal(toHumanCompetitor(legacy).baseQualityScore, 77);
  const legacy2 = { ...legacy, state: { fleet: [], routes: [], reputation: { overall: 41 } } };
  assert.equal(toHumanCompetitor(legacy2).baseQualityScore, 41);
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. No-op decisions must not broadcast, and public payloads must be scrubbed
// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 3a. a decision that changed nothing is not news ──────\n');

await test('publicDecisions exposes the no-op journalling rule', () => {
  assert.equal(typeof pub.journalledPayload, 'function',
    'no journalledPayload() — decisions.mjs still journals refused actions verbatim');
  assert.equal(typeof pub.isPublicDecision, 'function',
    'no isPublicDecision() — the feed cannot tell a refusal from a real move');
});

await test('a decision the reducer refused is journalled WITHOUT its payload', () => {
  const evil = { airportCode: 'BUY GOLD AT scam.example NOW '.repeat(9), origin: 'x'.repeat(300) };
  const row = pub.journalledPayload(evil, { changed: false });
  assert.deepEqual(row, { noop: true }, 'the refused payload is still on the journal row');
  assert.equal(pub.isPublicDecision({ type: 'UPGRADE_HUB', payload: row }), false,
    'a refused decision is still treated as a public move');
});

await test('a decision that DID change state journals its payload untouched', () => {
  const real = { airportCode: 'JFK', level: 2 };
  assert.equal(pub.journalledPayload(real, { changed: true }), real);
  assert.equal(pub.isPublicDecision({ type: 'UPGRADE_HUB', payload: real }), true);
});

await test('isPublicDecision still refuses a type that is not public at all', () => {
  assert.equal(pub.isPublicDecision({ type: 'TAKE_LOAN', payload: { principal: 1 } }), false);
  assert.equal(pub.isPublicDecision({ type: 'SET_LOUNGE_POLICY', payload: {} }), false);
});

console.log('\n── 3b. every public payload field is capped + charset-bound ──\n');

const LONG = 'A'.repeat(200);

await test('a 200-char airportCode never reaches the public payload', () => {
  const p = pub.publicPayload({ payload: { airportCode: LONG } });
  assert.ok((p.airportCode ?? '').length <= 4,
    `airportCode passed through at ${(p.airportCode ?? '').length} chars`);
});

await test('free text in airportCode / origin / destination is rejected outright', () => {
  const p = pub.publicPayload({ payload: {
    airportCode: 'BUY GOLD NOW', origin: '<script>x</script>', destination: 'JFK; DROP TABLE',
  } });
  assert.equal(p.airportCode, undefined, `airportCode leaked: ${p.airportCode}`);
  assert.equal(p.origin, undefined, `origin leaked: ${p.origin}`);
  assert.equal(p.destination, undefined, `destination leaked: ${p.destination}`);
});

await test('typeId and allianceId are capped and charset-bound', () => {
  const p = pub.publicPayload({ payload: {
    typeId: 'b738 — CLICK http://evil.example ' + LONG,
    allianceId: LONG + ' spam',
  } });
  assert.ok(p.typeId == null || (p.typeId.length <= 24 && /^[A-Za-z0-9_-]+$/.test(p.typeId)),
    `typeId leaked: ${JSON.stringify(p.typeId)}`);
  assert.ok(p.allianceId == null || (p.allianceId.length <= 40 && /^[A-Za-z0-9:_-]+$/.test(p.allianceId)),
    `allianceId leaked: ${JSON.stringify(p.allianceId)}`);
});

await test('the stops list on a tag route is charset-bound too', () => {
  const p = pub.publicPayload({ payload: { stops: ['JFK', 'BUY GOLD NOW', 'BOS'] } });
  assert.deepEqual(p.stops, ['JFK', 'BOS']);
});

await test('a LEGITIMATE payload is passed through unchanged', () => {
  const legit = {
    origin: 'JFK', destination: 'LHR', typeId: 'b737max8', airportCode: 'AMS',
    code: 'CDG', allianceId: 'hw:clz1234abcd', quantity: 4,
    stops: ['JFK', 'BOS', 'YYZ'], routes: [{ origin: 'JFK', destination: 'BOS' }], count: 1,
  };
  const p = pub.publicPayload({ payload: legit });
  assert.equal(p.origin, 'JFK');
  assert.equal(p.destination, 'LHR');
  assert.equal(p.typeId, 'b737max8');
  assert.equal(p.airportCode, 'AMS');
  assert.equal(p.code, 'CDG');
  assert.equal(p.allianceId, 'hw:clz1234abcd');
  assert.equal(p.quantity, 4);
  assert.deepEqual(p.stops, ['JFK', 'BOS', 'YYZ']);
  assert.deepEqual(p.routes, [{ origin: 'JFK', destination: 'BOS' }]);
});

await test('the stock tape is untouched by the new scrubbing', () => {
  const p = pub.publicPayload({ payload: {
    targetId: 'human:abc', targetName: 'Bob Airways', shares: 1200,
    pricePerShare: 34, value: 40800, stakePct: 6.2, stakePctBefore: 1.1,
  } });
  assert.equal(p.targetId, 'human:abc');
  assert.equal(p.targetName, 'Bob Airways');
  assert.equal(p.shares, 1200);
  assert.equal(p.stakePct, 6.2);
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. ADD_CARGO_ROUTE must not accept a NaN yield
// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 4. NaN cargo yield cannot reach the blob ────────────\n');

const FREIGHTER = getAircraftType('b737800bcf');
function cargoBase() {
  return {
    week: 1, year: 1, cash: 50_000_000, hub: 'AMS', hubs: { AMS: { tier: 1 } },
    airlineName: 'Freight Air',
    fleet: [{ id: 'f1', typeId: FREIGHTER.id, tailNumber: 'PH-CGO', status: 'idle', ageWeeks: 0, reserveBase: null }],
    routes: [], cargoRoutes: [], gates: { AMS: 2, LHR: 2 },
    routePricing: {}, routeCatering: {}, competitors: [], activeEvents: [],
  };
}
const cargoAction = (yieldPrice) => ({
  type: 'ADD_CARGO_ROUTE', origin: 'AMS', destination: 'LHR', aircraftId: 'f1',
  weeklyFrequency: 4, ...(yieldPrice === undefined ? {} : { yieldPrice }),
});

for (const bad of ['abc', NaN, Infinity, -Infinity, '1e999']) {
  await test(`ADD_CARGO_ROUTE refuses yieldPrice ${JSON.stringify(String(bad))}`, () => {
    const s = cargoBase();
    const n = gameReducer(s, cargoAction(bad));
    const stored = (n.cargoRoutes ?? [])[0]?.yieldPrice;
    assert.ok(stored === undefined || Number.isFinite(stored),
      `stored a non-finite yieldPrice: ${stored}`);
    assert.equal(n.cargoRoutes?.length ?? 0, 0, 'a route was created from a malformed yield');
    assert.ok(Number.isFinite(n.cash), 'cash went non-finite');
  });
}

await test('a NaN yield can no longer wipe the bank through a tick', () => {
  // A REAL seeded airline, so ADVANCE_WEEK runs the whole week rather than
  // bailing on a hand-rolled fixture.
  let s = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'Freight Air', hub: 'AMS', enableObjectives: false });
  s = { ...s, multiplayer: true, competitors: [], humanRivals: {}, encroachments: {}, cash: 60_000_000 };
  s = gameReducer(s, { type: 'BUY_AIRCRAFT', typeId: FREIGHTER.id });
  const f = (s.fleet ?? []).find((a) => getAircraftType(a.typeId)?.freighter);
  assert.ok(f, 'fixture precondition: a freighter must be in the fleet');
  s = gameReducer(s, { type: 'ADD_GATE', airportCode: 'LHR' });
  const withLane = gameReducer(s, {
    type: 'ADD_CARGO_ROUTE', origin: 'AMS', destination: 'LHR', aircraftId: f.id,
    weeklyFrequency: 4, yieldPrice: 'abc',
  });
  const ticked = gameReducer(withLane, { type: 'ADVANCE_WEEK' });
  assert.ok(Number.isFinite(ticked.cash),
    `cash is ${ticked.cash} after one tick — a malformed yield wiped the bank`);
  assert.ok(Number.isFinite(ticked.lastReport?.totalRevenue ?? 0),
    'the weekly report went non-finite');
});

await test('the legitimate cargo path is unchanged', () => {
  const s = cargoBase();
  const n = gameReducer(s, cargoAction(0.42));
  assert.equal(n.cargoRoutes.length, 1);
  assert.equal(n.cargoRoutes[0].yieldPrice, 0.42);
  // Omitted entirely → the reference yield, exactly as before.
  const d = gameReducer(s, cargoAction(undefined));
  assert.equal(d.cargoRoutes.length, 1);
  assert.ok(Number.isFinite(d.cargoRoutes[0].yieldPrice) && d.cargoRoutes[0].yieldPrice > 0);
  // A non-positive number still CLAMPS (unchanged behaviour), it does not refuse.
  const z = gameReducer(s, cargoAction(0));
  assert.equal(z.cargoRoutes.length, 1);
  assert.equal(z.cargoRoutes[0].yieldPrice, 0.01);
});

await test('the guard rejects a malformed ADD_CARGO_ROUTE at the API boundary', () => {
  for (const bad of ['abc', null, {}, [], -0.5, 0]) {
    assert.throws(() => guardDecision('ADD_CARGO_ROUTE', {
      origin: 'AMS', destination: 'LHR', aircraftId: 'f1', weeklyFrequency: 4, yieldPrice: bad,
    }, cargoBase()), GuardError, `accepted yieldPrice ${JSON.stringify(bad)}`);
  }
  for (const bad of ['abc', 0, -3, 1e9]) {
    assert.throws(() => guardDecision('ADD_CARGO_ROUTE', {
      origin: 'AMS', destination: 'LHR', aircraftId: 'f1', weeklyFrequency: bad, yieldPrice: 0.4,
    }, cargoBase()), GuardError, `accepted weeklyFrequency ${JSON.stringify(bad)}`);
  }
});

await test('the guard rejects a malformed UPDATE_CARGO_YIELD', () => {
  for (const bad of ['abc', null, 0, -1, {}]) {
    assert.throws(() => guardDecision('UPDATE_CARGO_YIELD', { routeId: 'r1', yieldPrice: bad }, cargoBase()),
      GuardError, `accepted yieldPrice ${JSON.stringify(bad)}`);
  }
});

await test('the guard passes a legitimate cargo payload through', () => {
  const g = guardDecision('ADD_CARGO_ROUTE', {
    origin: 'AMS', destination: 'LHR', aircraftId: 'f1', weeklyFrequency: 4, yieldPrice: 0.42,
  }, cargoBase());
  assert.equal(g.yieldPrice, 0.42);
  assert.equal(g.weeklyFrequency, 4);
  assert.equal(g.origin, 'AMS');
  const u = guardDecision('UPDATE_CARGO_YIELD', { routeId: 'r1', yieldPrice: 0.9 }, cargoBase());
  assert.equal(u.yieldPrice, 0.9);
  assert.equal(u.routeId, 'r1');
  // yieldPrice may still be OMITTED — the reducer defaults it to the lane's
  // reference yield, which is the documented contract for the field.
  const noYield = guardDecision('ADD_CARGO_ROUTE', {
    origin: 'AMS', destination: 'LHR', aircraftId: 'f1', weeklyFrequency: 4,
  }, cargoBase());
  assert.ok(noYield);
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. EXTEND_LEASE must be bounded at BOTH layers
// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 5. EXTEND_LEASE is clamped, guard and reducer ───────\n');

function leaseState() {
  return {
    week: 1, cash: 1_000_000, hub: 'AMS', hubs: {}, routes: [], cargoRoutes: [], gates: {},
    fleet: [{
      id: 'ac1', typeId: 'a320neo', ownershipType: 'lease', status: 'idle',
      leaseTermWeeks: 260, leaseRemainingWeeks: 100, weeklyLease: 90_000,
    }],
  };
}

await test('the guard clamps a forged EXTEND_LEASE to 520 weeks', () => {
  const g = guardDecision('EXTEND_LEASE', { aircraftId: 'ac1', addWeeks: 10_000_000 }, leaseState());
  assert.equal(g.addWeeks, 520, 'EXTEND_LEASE has no guard case — addWeeks passes through');
  assert.equal(g.aircraftId, 'ac1');
});

await test('the guard floors a zero / negative / junk extension at 1 week', () => {
  assert.equal(guardDecision('EXTEND_LEASE', { aircraftId: 'ac1', addWeeks: -5 }, leaseState()).addWeeks, 1);
  assert.equal(guardDecision('EXTEND_LEASE', { aircraftId: 'ac1', addWeeks: 'abc' }, leaseState()).addWeeks, 52);
});

await test('the guard drops everything but the two fields it owns', () => {
  const g = guardDecision('EXTEND_LEASE', { aircraftId: 'ac1', addWeeks: 52, weeklyLease: 0 }, leaseState());
  assert.deepEqual(Object.keys(g).sort(), ['addWeeks', 'aircraftId']);
});

await test('the REDUCER refuses an unbounded extension even without the guard', () => {
  const s = leaseState();
  const n = gameReducer(s, { type: 'EXTEND_LEASE', aircraftId: 'ac1', addWeeks: 10_000_000 });
  const ac = n.fleet[0];
  assert.ok(ac.leaseRemainingWeeks <= 100 + 520,
    `reducer applied ${ac.leaseRemainingWeeks} weeks — a 190,000-year lease`);
  assert.ok(ac.leaseTermWeeks <= 100 + 520);
});

await test('a legitimate extension is unchanged at both layers', () => {
  const g = guardDecision('EXTEND_LEASE', { aircraftId: 'ac1', addWeeks: 52 }, leaseState());
  assert.equal(g.addWeeks, 52);
  const n = gameReducer(leaseState(), { type: 'EXTEND_LEASE', aircraftId: 'ac1', addWeeks: 52 });
  assert.equal(n.fleet[0].leaseRemainingWeeks, 152);
  assert.equal(n.fleet[0].leaseTermWeeks, 260);
  // Zero is still a no-op, as before.
  const s = leaseState();
  assert.equal(gameReducer(s, { type: 'EXTEND_LEASE', aircraftId: 'ac1', addWeeks: 0 }), s);
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. PRIVATE worlds are readable by members only
// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 6. private worlds need an authenticated member ──────\n');

const PUBLIC_WORLD  = { id: 'w-pub', visibility: 'PUBLIC',  status: 'RUNNING' };
const PRIVATE_WORLD = { id: 'w-prv', visibility: 'PRIVATE', status: 'RUNNING' };
const ACCOUNT = { id: 'acc1', email: 'a@example.com' };

await test('lib/access.mjs exists and exports the shared gate', () => {
  assert.equal(access.__err, undefined, `import failed: ${access.__err?.message}`);
  assert.equal(typeof access.mayReadWorld, 'function');
  assert.equal(typeof access.isWorldMember, 'function');
  assert.equal(typeof access.assertWorldReadable, 'function');
});

await test('a PUBLIC world is readable by an anonymous caller', () => {
  assert.equal(access.mayReadWorld(PUBLIC_WORLD, { account: null, isMember: false }), true);
  assert.equal(access.mayReadWorld(PUBLIC_WORLD, { account: ACCOUNT, isMember: false }), true);
});

await test('a PRIVATE world is NOT readable by an anonymous caller', () => {
  assert.equal(access.mayReadWorld(PRIVATE_WORLD, { account: null, isMember: false }), false,
    'anyone holding the world id can read a private world');
});

await test('a PRIVATE world is NOT readable by a signed-in NON-member', () => {
  assert.equal(access.mayReadWorld(PRIVATE_WORLD, { account: ACCOUNT, isMember: false }), false);
});

await test('a PRIVATE world IS readable by a member', () => {
  assert.equal(access.mayReadWorld(PRIVATE_WORLD, { account: ACCOUNT, isMember: true }), true);
});

await test('membership counts ANY airline row, whatever its status', async () => {
  const rows = { 'w-prv|acc1': { id: 'air1', status: 'BANKRUPT' } };
  const fakePrisma = {
    airline: {
      findUnique: async ({ where }) =>
        rows[`${where.worldId_accountId.worldId}|${where.worldId_accountId.accountId}`] ?? null,
    },
  };
  assert.equal(await access.isWorldMember(fakePrisma, 'w-prv', 'acc1'), true,
    'a bankrupt/abandoned member was locked out of their own world');
  assert.equal(await access.isWorldMember(fakePrisma, 'w-prv', 'acc2'), false);
  assert.equal(await access.isWorldMember(fakePrisma, 'w-prv', null), false);
});

await test('assertWorldReadable throws a 404 for a private world you are not in', async () => {
  const fakePrisma = { airline: { findUnique: async () => null } };
  await assert.rejects(
    () => access.assertWorldReadable(fakePrisma, PRIVATE_WORLD, ACCOUNT),
    (e) => e.statusCode === 404,
    'a private world confirmed its own existence to a stranger',
  );
  await assert.rejects(
    () => access.assertWorldReadable(fakePrisma, PRIVATE_WORLD, null),
    (e) => e.statusCode === 404,
  );
});

await test('assertWorldReadable lets a member and any public reader through', async () => {
  const member = { airline: { findUnique: async () => ({ id: 'air1' }) } };
  const stranger = { airline: { findUnique: async () => null } };
  await access.assertWorldReadable(member, PRIVATE_WORLD, ACCOUNT);
  await access.assertWorldReadable(stranger, PUBLIC_WORLD, null);
});

await test('a private world never costs a membership query for a public one', async () => {
  let queries = 0;
  const counting = { airline: { findUnique: async () => { queries++; return null; } } };
  await access.assertWorldReadable(counting, PUBLIC_WORLD, ACCOUNT);
  assert.equal(queries, 0);
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. The rival profile must not drag the whole save blob out of Postgres
// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 7. rival profile reads only what it serves ──────────\n');

await test('lib/rivalProfile.mjs exists and exports the projection', () => {
  assert.equal(rivalProfile.__err, undefined, `import failed: ${rivalProfile.__err?.message}`);
  assert.equal(typeof rivalProfile.projectRivalProfileState, 'function');
  assert.ok(rivalProfile.RIVAL_PROFILE_SELECT, 'no explicit Prisma select for the rival profile');
});

await test('the Prisma select never asks for the state blob', () => {
  const sel = rivalProfile.RIVAL_PROFILE_SELECT;
  assert.equal(sel.state, undefined, 'the ~523 kB state column is still selected wholesale');
  // Everything serializeAirline() + the handler read must be there, or the
  // response silently loses fields.
  for (const f of ['id', 'worldId', 'name', 'hub', 'cash', 'marketCap', 'week', 'status',
                   'joinedWeek', 'restarts', 'restartedWeek']) {
    assert.equal(sel[f], true, `missing column ${f}`);
  }
  assert.ok(sel.account?.select?.isOG === true && sel.account?.select?.email === true);
  // The visibility gate (#6) needs the world's visibility on the same read.
  assert.ok(sel.world?.select?.visibility === true, 'the world visibility is not fetched');
});

await test('the state projection keeps exactly what the response renders', () => {
  const blob = {
    routes: [{ id: 'r1', origin: 'JFK', destination: 'BOS', weeklyFrequency: 14, ticketPrice: 170, launchCost: 9 }],
    routePricing: { 'BOS-JFK': { economy: 170 } },
    cargoRoutes: [{ id: 'c1', origin: 'AMS', destination: 'LHR', weeklyFrequency: 4, yieldPrice: 0.4 }],
    hubs: { JFK: { tier: 2 } },
    fleet: [{ id: 'ac1', typeId: 'b738', config: { economy: 180 }, ageWeeks: 40 }],
    // Everything below is PRIVATE or simply unread by this endpoint.
    cash: 12_345_678, loans: [{ principal: 1 }], hedgeContracts: [{ coverage: 0.5 }],
    financialHistory: [{ profit: 1 }], marketingBudget: 99, customLogo: 'data:...',
  };
  const p = rivalProfile.projectRivalProfileState(blob);
  assert.deepEqual(p.routes, blob.routes);
  assert.deepEqual(p.routePricing, blob.routePricing);
  assert.deepEqual(p.cargoRoutes, blob.cargoRoutes);
  assert.deepEqual(p.hubs, blob.hubs);
  assert.equal(p.fleet.length, 1);
  assert.equal(p.fleet[0].typeId, 'b738');
  for (const k of ['cash', 'loans', 'hedgeContracts', 'financialHistory', 'marketingBudget', 'customLogo']) {
    assert.equal(p[k], undefined, `${k} is still being shipped to rivals`);
  }
});

await test('the projection tolerates a missing / malformed blob', () => {
  for (const blob of [null, undefined, {}, { routes: 'nope', fleet: 3 }]) {
    const p = rivalProfile.projectRivalProfileState(blob);
    assert.ok(Array.isArray(p.routes) && Array.isArray(p.cargoRoutes) && Array.isArray(p.fleet));
    assert.equal(typeof p.hubs, 'object');
  }
});

Math.random = realRandom;
console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
