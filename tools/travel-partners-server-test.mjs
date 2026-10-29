// Travel partnerships — the Headwinds server half.
//
//   1. New worlds only (Dave, 2026-10-29): createWorld turns it ON unless the
//      creator passes false; worlds created before have no key and stay off.
//   2. Joining a partnership world stamps state.partnershipsWorld.
//   3. The decision guard passes only real partner ids; every rule beyond that
//      is the reducer's (canSignTravelPartner).
//   4. The four actions are on the world allow-list.
//   5. A human rival's partner lift reaches every other player's tick — the
//      rival spec carries it and buildEncroachmentOffer keeps it.
//   6. Walk-outs and refusals go on the world news feed.
//
//   node tools/travel-partners-server-test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWorld, seedAirlineState } from '../apps/headwinds-server/src/lib/worldService.mjs';
import { serializeWorld } from '../apps/headwinds-server/src/lib/worldConfig.mjs';
import { guardDecision } from '../apps/headwinds-server/src/lib/decisionGuard.mjs';
import { toRivalSpecs } from '../apps/headwinds-server/src/lib/humanRivals.mjs';
import { travelPartnerLostNewsRows } from '../apps/headwinds-server/src/lib/newsService.mjs';
import { buildEncroachmentOffer } from '../packages/engine/src/models/encroachment.js';
import { buildRouteMarket } from '../packages/engine/src/models/demand.js';
import { defaultConfig } from '../packages/engine/src/utils/simulation.js';
import { getAircraftType } from '../packages/engine/src/data/aircraft.js';
import { referencePrice } from '../packages/engine/src/utils/market.js';
import { makeTravelPartnerContract } from '../packages/engine/src/data/travelPartners.js';

let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
};
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

console.log('\nTravel partnerships — server\n');

const fakePrisma = () => {
  const calls = [];
  return { calls, world: { create: async ({ data }) => { calls.push(data); return { id: 'w1', ...data }; } } };
};
const BASE = { name: 'T', lengthYears: 50, weeksPerDay: 24, maxPlayers: 20 };
const tcOf = async (opts) => { const p = fakePrisma(); await createWorld(p, opts); return p.calls[0].tickConfig; };

await test('a new world has travel partnerships ON by default; false opts out', async () => {
  assert.equal((await tcOf({ ...BASE })).partnerships, true);
  assert.equal((await tcOf({ ...BASE, partnerships: true })).partnerships, true);
  assert.notEqual((await tcOf({ ...BASE, partnerships: false })).partnerships, true);
  await assert.rejects(tcOf({ ...BASE, partnerships: 'yes' }), /partnerships must be true or false/);
});

await test('worlds created before the feature stay without it', () => {
  const oldRow = {
    id: 'w0', name: 'Old', status: 'RUNNING', visibility: 'PUBLIC',
    lengthYears: 50, weeksPerDay: 24, currentYear: 3, currentWeek: 7,
    maxPlayers: 20, joinCode: null, tickConfig: { startingCapital: 15e6, demandMultiplier: 1 },
  };
  assert.equal(serializeWorld(oldRow).partnerships, false);
  assert.equal(serializeWorld({ ...oldRow, tickConfig: { ...oldRow.tickConfig, partnerships: true } }).partnerships, true);
});

await test('joining a partnership world stamps partnershipsWorld; other worlds get no key', () => {
  const world = (tc) => ({ id: 'w1', currentYear: 1, currentWeek: 1, maxPlayers: 20, tickConfig: { startingCapital: 15e6, demandMultiplier: 1, ...tc } });
  assert.equal(seedAirlineState(world({ partnerships: true }), { airlineName: 'A', hub: 'JFK' }).partnershipsWorld, true);
  assert.ok(!('partnershipsWorld' in seedAirlineState(world({}), { airlineName: 'A', hub: 'JFK' })));
});

await test('the create-world form sends an explicit boolean, defaulting on', () => {
  const src = read('../apps/headwinds-web/src/App.jsx');
  assert.ok(/const \[partnerships, setPartnerships\] = useState\(true\)/.test(src));
  assert.ok(/\n\s+partnerships,\n/.test(src), 'the server reads an absent key as ON');
});

await test('guard: only real partner ids; "all" only for auto-renew', () => {
  assert.deepEqual(guardDecision('SIGN_TRAVEL_PARTNER', { partnerId: 'zipway', fee: 1 }, {}), { partnerId: 'zipway' },
    'nothing but the id survives — the fee is the reducer’s');
  assert.throws(() => guardDecision('SIGN_TRAVEL_PARTNER', { partnerId: 'nope' }, {}), /Unknown travel partner/);
  assert.throws(() => guardDecision('BREAK_TRAVEL_PARTNER', { partnerId: 'all' }, {}), /Unknown travel partner/);
  assert.deepEqual(guardDecision('SET_TRAVEL_PARTNER_AUTORENEW', { partnerId: 'all', on: false }, {}), { partnerId: 'all', on: false });
});

await test('the four actions are on the world allow-list', () => {
  const src = read('../apps/headwinds-server/src/world.mjs');
  for (const a of ['SIGN_TRAVEL_PARTNER', 'RENEW_TRAVEL_PARTNER', 'BREAK_TRAVEL_PARTNER', 'SET_TRAVEL_PARTNER_AUTORENEW']) {
    assert.ok(src.includes(`'${a}'`), `${a} allowed`);
  }
});

// ── Rivals carry their partner lift ──────────────────────────────────────────
const O = 'MCO', D = 'PSG';
const KEY = [O, D].sort().join('-');
const RIVAL_TYPE = getAircraftType('a320neo');
const rivalRow = (travelPartners, week = 3) => ({
  id: 'r1', name: 'Rival Air', status: 'ACTIVE', hub: O,
  state: {
    airlineName: 'Rival Air', hub: O, hubs: {}, week, year: 3,
    fleet: [{ id: 'f1', typeId: RIVAL_TYPE.id, status: 'assigned', ageWeeks: 52,
              config: defaultConfig(RIVAL_TYPE.seats), ownershipType: 'leased' }],
    routes: [{ id: 'rr1', origin: O, destination: D, aircraftId: 'f1', weeklyFrequency: 7, weeksOpen: 40 }],
    cargoRoutes: [], routePricing: { [KEY]: { economy: Math.round(referencePrice(O, D)) } },
    loyalty: { members: 0, weeklyInvestment: 0, maturity: 0 }, awareness: 60,
    ...(travelPartners ? { travelPartners } : {}),
  },
});

await test('a human rival’s cruise partner rides on its spec and into the offer', () => {
  const ps = { azurehorizon: { ...makeTravelPartnerContract('azurehorizon', 100), happiness: 70 } };
  const spec = toRivalSpecs(rivalRow(ps, 3))[KEY];
  assert.equal(spec.travelLeisureAppeal, 1.07, 'January: in season');
  const market = buildRouteMarket(O, D, { month: 1, week: 3 }, 1, 1);
  assert.equal(buildEncroachmentOffer(spec, market).travelLeisureAppeal, 1.07);
  const summer = toRivalSpecs(rivalRow(ps, 30))[KEY];
  assert.ok(!('travelLeisureAppeal' in summer), 'July: out of season, no field');
  const none = toRivalSpecs(rivalRow(null))[KEY];
  assert.ok(!('travelLeisureAppeal' in none));
  assert.equal(buildEncroachmentOffer(none, market).travelLeisureAppeal, 1, 'parity without partners');
});

// ── News ─────────────────────────────────────────────────────────────────────
await test('walk-outs and refusals become world news, one row per airline and partner', () => {
  const rows = travelPartnerLostNewsRows({
    worldId: 'w1', week: 40, nameOf: new Map([['a1', 'Alpha Air']]),
    losses: [
      { airlineId: 'a1', partnerId: 'azurehorizon', partnerName: 'Azure Horizon Cruises', reason: 'walkout' },
      { airlineId: 'a1', partnerId: 'azurehorizon', partnerName: 'Azure Horizon Cruises', reason: 'walkout' },
      { airlineId: 'a1', partnerId: 'lodestar', partnerName: 'Lodestar Inns', reason: 'refused' },
    ],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].category, 'world');
  assert.equal(rows[0].kind, 'travel_partner_lost');
  assert.equal(rows[0].payload.name, 'Alpha Air');
  assert.equal(rows[1].payload.reason, 'refused');
});

await test('the tick writes them, and both news renderers know the kind', () => {
  const tick = read('../apps/headwinds-server/src/lib/tickService.mjs');
  assert.ok(tick.includes('travelPartnerLostNewsRows({'), 'tickService writes the rows');
  assert.ok(read('../apps/headwinds-web/src/Feed.jsx').includes("case 'travel_partner_lost'"));
  assert.ok(read('../src/components/News.jsx').includes("case 'travel_partner_lost'"));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
