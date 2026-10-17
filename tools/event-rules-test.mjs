// Event rules — the "weird rules" an event world can switch on.
//
//   node --import ./tools/_register-loader.mjs tools/event-rules-test.mjs
//
// Dave, 2026-10-17 (claude/event-worlds.md): restricted fleet (a 737-only
// world), no leases, hub rules (none / regional only / set cities), domestic or
// international only, X random double-profit airports a year, and alliances
// ranked instead of airlines. Each rule is asserted where it is ENFORCED — the
// shared reducer and its guards (so the client's buttons and the server agree)
// — plus the server paths that stamp the rules and the screens that show them.
//
// Verified failing on HEAD: there is no data/eventRules.js on HEAD, so the
// import-error is NOT the evidence. tools/_probe-event-rules-head.mjs (run
// against a `git archive HEAD` copy, then deleted) drove the same scenarios
// through HEAD's reducer with `state.eventRules` set: an A320neo order in a
// "737-only" world went through, a lease went through in a "no leases" world,
// DESIGNATE_HUB went through in a "no hubs" world, LHR–CDG opened in a
// "domestic only" world, and createWorld threw away `event.rules`.

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';

globalThis.window = globalThis.window ?? {};
window.location = window.location ?? { hash: '', origin: 'http://localhost:5173' };
window.addEventListener = window.addEventListener ?? (() => {});
window.removeEventListener = window.removeEventListener ?? (() => {});
globalThis.fetch = globalThis.fetch ?? (() => Promise.reject(new Error('no network in SSR')));

const opt = async (spec) => { try { return await import(spec); } catch (e) { return { __err: e }; } };
const ev = await opt('../packages/engine/src/data/eventRules.js');
const R = await opt('../packages/engine/src/reducer.mjs');
const sim = await opt('../packages/engine/src/utils/simulation.js');
const dem = await opt('../packages/engine/src/models/demand.js');
const svc = await opt('../apps/headwinds-server/src/lib/worldService.mjs');
const cfg = await opt('../apps/headwinds-server/src/lib/worldConfig.mjs');
const ui = await opt('../apps/headwinds-web/src/EventRules.jsx');
const trophyUi = await opt('../apps/headwinds-web/src/Trophies.jsx');
const { readFileSync } = await import('node:fs');
const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
const rejects = async (fn, status, re) => {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  assert.ok(err, `expected a ${status}, got no error`);
  assert.equal(err.statusCode, status, `expected ${status}, got ${err.statusCode}: ${err.message}`);
  if (re) assert.match(err.message, re);
};

const rules = (r) => ev.normalizeEventRules(r, { seed: 'test-seed' });
// A fresh airline at Heathrow with `eventRules` stamped, plenty of cash.
function airline(eventRules, { hub = 'LHR' } = {}) {
  const s = R.gameReducer(R.freshState(), { type: 'START_GAME', airlineName: 'Test Air', hub });
  return { ...s, cash: 5e9, multiplayer: true, ...(eventRules ? { eventRules } : {}) };
}
function withAircraft(state, typeId, id = 'ac1') {
  const type = (sim.getAircraftType ?? (() => null))(typeId);
  return { ...state, fleet: [...state.fleet, { id, typeId, name: typeId, tailNumber: `G-${id}`, status: 'idle', ageWeeks: 0, ownershipType: 'owned', config: sim.newAircraftConfig(type ?? { seats: 180 }) }], gates: { ...(state.gates ?? {}), LHR: 5, MAN: 5, CDG: 5, EDI: 5, JFK: 5 } };
}
const lastToast = (s) => (s.pendingToasts ?? []).at(-1);

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 0. the rules object ──────────────────────────────────\n');

await test('normalizeEventRules keeps what is valid, rejects nonsense with a sentence', () => {
  assert.ok(!ev.__err, ev.__err?.message);
  const r = rules({ aircraft: { families: ['boeing_737'] }, noLeases: true, hubs: { mode: 'assigned', airports: ['lhr', ' cdg '] },
    routes: 'domestic', bonusAirports: { count: 3 }, allianceRanking: {} , junk: 1 });
  assert.deepEqual(r, {
    aircraft: { families: ['boeing_737'] }, noLeases: true, hubs: { mode: 'assigned', airports: ['LHR', 'CDG'] },
    routes: 'domestic', bonusAirports: { count: 3, seed: 'test-seed' }, allianceRanking: { score: 'sum' },
  });
  assert.equal(rules({}), null, 'nothing switched on = a normal world');
  assert.throws(() => rules({ hubs: { mode: 'assigned', airports: ['ZZZ'] } }), /Unknown airport/);
  assert.throws(() => rules({ hubs: { mode: 'assigned', airports: [] } }), /at least one/);
  assert.throws(() => rules({ routes: 'sideways' }), /Route rule/);
  assert.throws(() => rules({ bonusAirports: { count: 99 } }), /1–20/);
  assert.throws(() => rules({ aircraft: { families: ['no_such'] } }), /exist/);
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 1. restricted fleet (a 737-only world) ───────────────\n');

const only737 = rules({ aircraft: { families: ['boeing_737'] } });

await test('an A320neo order is refused with the rule; a 737-800 order goes through', () => {
  assert.ok(!R.__err, R.__err?.message);
  const s = airline(only737);
  const refused = R.gameReducer(s, { type: 'ORDER_AIRCRAFT', typeId: 'a320neo', ownershipType: 'owned', quantity: 1 });
  assert.equal(refused.fleet.length, 0);
  assert.equal(refused.cash, s.cash);
  assert.match(lastToast(refused)?.message ?? '', /only the Boeing 737 family/);
  const ok = R.gameReducer(s, { type: 'ORDER_AIRCRAFT', typeId: 'b737800', ownershipType: 'owned', quantity: 1 });
  assert.ok(ok.fleet.length + (ok.pendingOrders?.length ?? 0) > 0, 'the 737 was ordered');
  assert.ok(ok.cash < s.cash);
});

await test('orderDenial / leaseDenial carry the event code, so every screen that asks them agrees', () => {
  const s = airline(only737);
  assert.equal(R.orderDenial(s, 'a320neo')?.code, 'event_aircraft');
  assert.equal(R.orderDenial(s, 'b737800'), null);
  assert.equal(R.leaseDenial(s, 'a320neo')?.code, 'event_aircraft');
  assert.equal(R.orderDenial(airline(null), 'a320neo'), null, 'a normal world is untouched');
});

await test('the used market cannot be used to dodge it', () => {
  const s = airline(only737);
  assert.match(ev.eventActionDenial(s, { type: 'BUY_USED_AIRCRAFT', snapshot: { typeId: 'a320neo' } }) ?? '', /737/);
  assert.match(src('apps/headwinds-server/src/lib/aircraftMarketService.mjs'), /eventAircraftDenial\(\{ eventRules \}, listing\.snapshot\?\.typeId\)/);
});

await test('categories and exact types work too', () => {
  const wide = rules({ aircraft: { categories: ['Wide Body'] } });
  assert.equal(ev.aircraftAllowedByRules(wide, 'a320neo'), false);
  assert.equal(ev.aircraftAllowedByRules(wide, 'b787-9') || ev.aircraftAllowedByRules(wide, 'a350900') || ev.aircraftAllowedByRules(wide, 'a330300'), true);
  const exact = rules({ aircraft: { types: ['a320neo'] } });
  assert.equal(ev.aircraftAllowedByRules(exact, 'a320neo'), true);
  assert.equal(ev.aircraftAllowedByRules(exact, 'a321neo'), false);
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 2. no leases ─────────────────────────────────────────\n');

await test('a lease order is refused; buying is fine', () => {
  const s = airline(rules({ noLeases: true }));
  const leased = R.gameReducer(s, { type: 'ORDER_AIRCRAFT', typeId: 'a320neo', ownershipType: 'lease', quantity: 1 });
  assert.equal(leased.fleet.length + (leased.pendingOrders?.length ?? 0), 0);
  assert.match(lastToast(leased)?.message ?? '', /no leasing/);
  assert.equal(R.leaseDenial(s, 'a320neo')?.code, 'event_no_leases');
  const bought = R.gameReducer(s, { type: 'ORDER_AIRCRAFT', typeId: 'a320neo', ownershipType: 'owned', quantity: 1 });
  assert.ok(bought.fleet.length + (bought.pendingOrders?.length ?? 0) > 0);
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 3. hubs ──────────────────────────────────────────────\n');

await test('no hubs: designating a hub or a focus city is refused, the base is just a base', () => {
  const s = airline(rules({ hubs: { mode: 'none' } }));
  for (const type of ['DESIGNATE_HUB', 'DESIGNATE_FOCUS_CITY']) {
    const n = R.gameReducer(s, { type, airportCode: 'MAN' });
    assert.deepEqual(n.hubs, s.hubs, type);
    assert.match(lastToast(n)?.message ?? '', /no hubs/);
  }
  assert.equal(ev.foundingHubAllowed(rules({ hubs: { mode: 'none' } }), 'LHR'), true, 'you can still be based anywhere');
});

await test('regional only: Heathrow is refused as a base, Birmingham is fine; the hub checklist says why', () => {
  const reg = rules({ hubs: { mode: 'regional' } });
  assert.equal(ev.foundingHubAllowed(reg, 'LHR'), false);
  assert.equal(ev.foundingHubAllowed(reg, 'BHX'), true);
  const chk = dem.hubUpgradeChecklist({ eventRules: reg, gates: { MAN: 10 }, cash: 1e12 }, 'MAN', 1);
  assert.equal(chk.ok, false);
  assert.match(chk.checks.find((c) => c.id === 'event')?.label ?? '', /regional airports/);
});

await test('set cities: only the listed airports', () => {
  const set = rules({ hubs: { mode: 'assigned', airports: ['MAN', 'EDI'] } });
  assert.equal(ev.foundingHubAllowed(set, 'MAN'), true);
  assert.equal(ev.foundingHubAllowed(set, 'LHR'), false);
  assert.match(ev.eventHubDenial(set, 'LHR') ?? '', /MAN, EDI/);
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 4. domestic / international ──────────────────────────\n');

await test('domestic only: LHR–CDG is refused by the shared route guard, LHR–MAN is not', () => {
  const s = withAircraft(airline(rules({ routes: 'domestic' })), 'a320neo');
  assert.match(R.addRouteBlockReason(s, { aircraftId: 'ac1', origin: 'LHR', destination: 'CDG', weeklyFrequency: 7 }) ?? '', /domestic flights only/);
  const man = R.addRouteBlockReason(s, { aircraftId: 'ac1', origin: 'LHR', destination: 'MAN', weeklyFrequency: 7 });
  assert.ok(!/Event rules/.test(man ?? ''), `LHR–MAN should pass the event rule, got: ${man}`);
});

await test('international only: every leg of a multi-stop must cross a border', () => {
  const s = withAircraft(airline(rules({ routes: 'international' })), 'a320neo');
  assert.match(R.addTagRouteBlockReason(s, { aircraftId: 'ac1', stops: ['MAN', 'LHR', 'CDG'], weeklyFrequency: 7 }) ?? '', /MAN–LHR stays inside/);
  assert.equal(ev.eventRouteDenial(s, ['LHR', 'CDG', 'JFK']), null);
});

await test('the route finder never offers a lane the rule would refuse', () => {
  const rf = src('packages/engine/src/models/routeFinder.js');
  assert.match(rf, /state\.eventRules\?\.routes && eventRouteDenial\(state, \[origin, a\.code\]\)\) continue;/);
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 5. double-profit airports ────────────────────────────\n');

await test('the yearly draw is deterministic, the same for everyone, and changes year to year', async () => {
  const b = rules({ bonusAirports: { count: 5 } });
  const y1 = ev.bonusAirportsFor(b, 1);
  assert.equal(y1.length, 5);
  assert.deepEqual(ev.bonusAirportsFor(b, 1), y1, 'same seed + year = same airports');
  assert.notDeepEqual(ev.bonusAirportsFor(b, 2), y1);
  const { AIRPORTS } = await import('../packages/engine/src/data/airports.js');
  for (const c of y1) assert.ok(['major', 'mega'].includes(AIRPORTS.find((a) => a.code === c)?.tier), `${c} is a major airport`);
});

await test('a route touching a bonus airport earns double its profit inside simulateRoute (so previews agree with the tick); a loss is not doubled', () => {
  const type = sim.getAircraftType ? sim.getAircraftType('a320neo') : null;
  ev.setEventBonusAirports(['JFK']);
  try {
    const plain = { revenue: 1000, totalOpCost: 600, profit: 400 };
    assert.deepEqual(ev.withEventBonus(plain, ['JFK', 'LHR']), { revenue: 1400, totalOpCost: 600, profit: 800, eventBonus: 400 });
    assert.equal(ev.withEventBonus(plain, ['LHR', 'CDG']), plain, 'untouched route: same object');
    const loss = { revenue: 500, totalOpCost: 600, profit: -100 };
    assert.equal(ev.withEventBonus(loss, ['JFK']), loss);
  } finally { ev.setEventBonusAirports(null); }
  const simSrc = src('packages/engine/src/utils/simulation.js');
  assert.equal((simSrc.match(/return withEventBonus\(\{/g) ?? []).length, 3, 'simulateRoute, simulateTagRoute and simulateCargoRoute');
  assert.match(simSrc, /pinEventBonusFrom\(state\);/, 'weeklyTick pins the knob from its own state');
  void type;
});

await test('end to end: in the weekly tick a profitable route through a bonus airport earns its operating profit twice', () => {
  // Find a seed whose year-1 draw includes LHR, so the test survives airport-table edits.
  let r = null;
  for (let i = 0; i < 5000 && !r; i++) {
    const c = ev.normalizeEventRules({ bonusAirports: { count: 20 } }, { seed: `s${i}` });
    if (ev.bonusAirportsFor(c, 1).includes('LHR')) r = c;
  }
  assert.ok(r, 'a seed with LHR');
  let s = airline(null);
  s = R.gameReducer(s, { type: 'ORDER_AIRCRAFT', typeId: 'a320neo', ownershipType: 'owned', quantity: 1 });
  s = { ...s, gates: { ...s.gates, LHR: 5, MAN: 5 } };
  s = R.gameReducer(s, { type: 'ADD_ROUTE', aircraftId: s.fleet[0].id, origin: 'LHR', destination: 'MAN', weeklyFrequency: 14 });
  s = R.gameReducer(s, { type: 'UPDATE_TICKET_PRICE', routeId: s.routes[0].id, ticketPrice: 120 });
  const plain = sim.weeklyTick({ ...s });
  const bonus = sim.weeklyTick({ ...s, eventRules: r });
  const a = plain.routeResults[0], b = bonus.routeResults[0];
  const opProfit = a.revenue - a.totalOpCost;
  assert.ok(opProfit > 0, `fixture route should be profitable, got ${opProfit}`);
  assert.equal(b.eventBonus, opProfit);
  assert.equal(b.revenue - a.revenue, opProfit);
  assert.equal(bonus.totalEventBonus, opProfit, 'the weekly report says how much was bonus');
  assert.equal(bonus.totalRevenue - plain.totalRevenue, opProfit);
  assert.equal('totalEventBonus' in plain, false, 'no key in a normal world');
  ev.setEventBonusAirports(null);
});

await test('a normal world leaves the knob empty (golden-master parity)', () => {
  ev.pinEventBonusFrom(airline(null));
  assert.deepEqual(ev.getEventBonusAirports(), []);
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 6. alliances ranked ──────────────────────────────────\n');

await test('teams by combined (or average) profit; no alliance = a team of one', () => {
  const rows = [
    { id: 'a', name: 'A Air', alliance: 'Star', avgProfit: 100 },
    { id: 'b', name: 'B Air', alliance: 'Star', avgProfit: 60 },
    { id: 'c', name: 'C Air', alliance: null, avgProfit: 150 },
    { id: 'd', name: 'D Air', alliance: 'One', avgProfit: 120 },
  ];
  const sum = ev.allianceStandings(rows, { score: 'sum' });
  assert.deepEqual(sum.map((t) => [t.rank, t.name, t.score]), [[1, 'Star', 160], [2, 'C Air', 150], [3, 'One', 120]]);
  assert.equal(sum[1].alliance, false);
  const avg = ev.allianceStandings(rows, { score: 'average' });
  assert.deepEqual(avg.map((t) => t.name), ['C Air', 'One', 'Star']);
});

await test('the world page serves alliance standings when the rule is on', () => {
  const w = src('apps/headwinds-server/src/routes/worlds.mjs');
  assert.match(w, /evRules\?\.allianceRanking\s*\? allianceStandings\(/);
  assert.match(w, /\.\.\.\(allianceTable \? \{ allianceStandings: allianceTable \} : \{\}\)/);
});

await test('the admin results panel ranks the teams and awards a whole team at once', () => {
  assert.ok(!trophyUi.__err, trophyUi.__err?.message);
  const html = renderToString(React.createElement(trophyUi.EventRankingPanel, {
    world: { id: 'w', name: 'Cup', status: 'ENDED', event: { name: 'Cup' } }, token: 't',
    standings: [{ id: 'a', rank: 1, accountId: 'x', name: 'A Air', hub: 'LHR', avgProfit: 100 }],
    allianceStandings: ev.allianceStandings([{ id: 'a', accountId: 'x', name: 'A Air', alliance: 'Star', avgProfit: 100 }]),
  }));
  assert.match(html, /Alliance ranking/);
  assert.match(html, /Star/);
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 7. the server stamps the rules ───────────────────────\n');

function worldPrisma() {
  const created = { worlds: [], airlines: [] };
  return {
    created,
    world: {
      count: async () => 0,
      create: async ({ data }) => { const w = { id: 'w-new', ...data }; created.worlds.push(w); return w; },
      updateMany: async () => ({ count: 1 }),
    },
    airline: {
      findUnique: async () => null,
      count: async () => 0,
      create: async ({ data }) => { const a = { id: 'a-new', ...data }; created.airlines.push(a); return a; },
    },
  };
}

await test('createWorld stores the rules normalised, seeded from the world seed', async () => {
  assert.ok(!svc.__err, svc.__err?.message);
  const w = await svc.createWorld(worldPrisma(), {
    lengthYears: 2, weeksPerDay: 96, visibility: 'PRIVATE', password: 'cup2026',
    event: { name: 'Cup', rules: { aircraft: { families: ['boeing_737'] }, bonusAirports: { count: 4 } } },
  });
  assert.deepEqual(w.tickConfig.event.rules.aircraft, { families: ['boeing_737'] });
  assert.equal(w.tickConfig.event.rules.bonusAirports.seed, w.worldSeed);
  await rejects(() => svc.createWorld(worldPrisma(), { lengthYears: 2, weeksPerDay: 96, event: { rules: { routes: 'up' } } }), 400, /Route rule/);
});

const eventWorld = (r) => ({
  id: 'w-ev', name: 'Cup', status: 'RUNNING', visibility: 'PRIVATE', joinCode: 'cup', ownerAccountId: null,
  lengthYears: 2, weeksPerDay: 96, currentWeek: 2, currentYear: 1, maxPlayers: 30, worldSeed: 'seed', startedAt: new Date(),
  tickConfig: { event: { name: 'Cup', rules: r } },
});

await test('a joining airline is stamped with the rules; "no hubs" takes the base\'s hub status away', () => {
  const s = svc.seedAirlineState(eventWorld(rules({ hubs: { mode: 'none' }, noLeases: true })), { airlineName: 'X', hub: 'LHR' });
  assert.equal(s.eventRules.noLeases, true);
  assert.deepEqual(s.hubs, {});
  const plain = svc.seedAirlineState({ ...eventWorld(null), tickConfig: {} }, { airlineName: 'X', hub: 'LHR' });
  assert.equal(plain.eventRules, undefined);
  assert.deepEqual(plain.hubs, { LHR: { tier: 1 } });
});

await test('joining at a base the hub rule forbids is a 400 with the reason', async () => {
  const w = eventWorld(rules({ hubs: { mode: 'regional' } }));
  await rejects(() => svc.joinWorld(worldPrisma(), { account: { id: 'acc' }, world: w, airlineName: 'X', hub: 'LHR', joinCode: 'cup' }), 400, /regional airport/);
  const a = await svc.joinWorld(worldPrisma(), { account: { id: 'acc' }, world: w, airlineName: 'X', hub: 'BHX', joinCode: 'cup' });
  assert.equal(a.hub, 'BHX');
});

await test('decisions take the rules from the WORLD and answer a 400; the tick re-stamps them; restart checks the base', () => {
  const d = src('apps/headwinds-server/src/routes/decisions.mjs');
  assert.match(d, /injected\.eventRules = eventRules;\s+const why = eventActionDenial\(injected, \{ type, \.\.\.guarded \}\);\s+if \(why\) throw httpError\(400, why\);/);
  assert.match(src('apps/headwinds-server/src/lib/tickService.mjs'), /eventRulesOfWorld\(world\.tickConfig\) \? \{ eventRules: eventRulesOfWorld\(world\.tickConfig\) \}/);
  assert.match(src('apps/headwinds-server/src/lib/restartService.mjs'), /assertFoundingHubAllowed\(world, hub\);/);
});

await test('serializeWorld describes the rules for players, with this year\'s bonus airports', () => {
  const w = eventWorld(rules({ routes: 'international', bonusAirports: { count: 2 } }));
  const out = cfg.serializeWorld(w);
  const titles = out.event.rulesSummary.map((d) => d.title);
  assert.deepEqual(titles, ['International only', 'Double-profit airports']);
  assert.equal(out.event.rulesSummary[1].airports.length, 2);
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 8. the screens ───────────────────────────────────────\n');

await test('the world page card lists the rules; an admin can edit them only while the world is in its lobby', () => {
  assert.ok(!ui.__err, ui.__err?.message);
  const r = rules({ aircraft: { families: ['boeing_737'] }, noLeases: true });
  const world = { id: 'w', status: 'LOBBY', progress: { year: 1 }, event: { name: 'Cup', rules: r, rulesSummary: ev.describeEventRules(r) } };
  const admin = renderToString(React.createElement(ui.EventRulesCard, { world, token: 't', isAdmin: true }));
  assert.match(admin, /Restricted fleet/);
  assert.match(admin, /Boeing 737 family/);
  assert.match(admin, /Edit rules/);
  const player = renderToString(React.createElement(ui.EventRulesCard, { world: { ...world, status: 'RUNNING' }, token: 't', isAdmin: true }));
  assert.doesNotMatch(player, /Edit rules/, 'locked once running');
});

await test('the editor renders every switch', () => {
  const html = renderToString(React.createElement(ui.EventRulesEditor, { value: null, onChange: () => {} }));
  for (const s of ['Aircraft allowed', 'No leases', 'Hubs', 'Routes', 'Double-profit airports', 'Rank alliances, not airlines']) assert.match(html, new RegExp(s));
});

await test('the join form only offers bases the hub rule allows', () => {
  const airports = [{ code: 'LHR' }, { code: 'BHX' }, { code: 'MAN' }];
  const w = { event: { rules: rules({ hubs: { mode: 'regional' } }) } };
  assert.deepEqual(ui.foundingHubOptions(w, airports).map((a) => a.code), ['BHX']);
  assert.equal(ui.foundingHubOptions({}, airports).length, 3);
  assert.match(ui.foundingHubNote(w), /regional airport/);
});

await test('the in-game banner names the rules and this year\'s bonus airports', () => {
  const r = rules({ bonusAirports: { count: 3 }, routes: 'domestic' });
  const html = renderToString(React.createElement(ui.EventRulesBanner, { rules: r, year: 1 }));
  assert.match(html, /Domestic only/);
  for (const c of ev.bonusAirportsFor(r, 1)) assert.match(html, new RegExp(c));
});

await test('the market hides types the rules forbid and says why leasing is off', () => {
  const m = src('src/components/Marketplace.jsx');
  assert.match(m, /aircraftAllowedByRules\(state\.eventRules, t\.id\) &&/);
  assert.match(m, /if \(state\.eventRules\?\.noLeases\) return 'Event rules: no leasing/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
