// Headwinds end-to-end demo — proves the multiplayer thesis with zero infra.
//
//   node apps/headwinds-server/demo.mjs
//
// Two human players share ONE world. Each builds a small airline. The SERVER then
// runs the authoritative weekly tick over the whole world in lockstep, using the
// exact same engine the solo game uses. No browser, no database, no network — just
// the shared engine running as a server-side authority.
import { createWorld, joinWorld, applyPlayerAction, tickWorld, standings } from './src/world.mjs';

const log = (...a) => console.log(...a);
const money = (n) => '$' + (Math.round(n) / 1e6).toFixed(2) + 'M';

log('── Create a world (a "season") ───────────────────────────────');
const world = createWorld({ name: 'Atlantic League — Season 1', pace: 'hour', seasonEndYear: 3 });
log(`world ${world.id} · status=${world.status}`);

log('\n── Two players join ──────────────────────────────────────────');
joinWorld(world, { accountId: 'alice', airlineName: 'Aurora Air', hub: 'JFK' });
joinWorld(world, { accountId: 'bob',   airlineName: 'Borealis',   hub: 'LAX' });
log('players:', [...world.airlines.keys()].join(', '));

log('\n── Players act (server validates every action) ───────────────');
// Alice: JFK → LAX
applyPlayerAction(world, 'alice', { type: 'LEASE_AIRCRAFT', typeId: 'a320ceo' });
const alicePlane = world.airlines.get('alice').fleet[0].id;
applyPlayerAction(world, 'alice', { type: 'ADD_GATE', airportCode: 'LAX' });
applyPlayerAction(world, 'alice', { type: 'ADD_ROUTE', aircraftId: alicePlane, origin: 'JFK', destination: 'LAX', weeklyFrequency: 5 });
// Bob: LAX → ORD
applyPlayerAction(world, 'bob', { type: 'LEASE_AIRCRAFT', typeId: 'a320ceo' });
const bobPlane = world.airlines.get('bob').fleet[0].id;
applyPlayerAction(world, 'bob', { type: 'ADD_GATE', airportCode: 'ORD' });
applyPlayerAction(world, 'bob', { type: 'ADD_ROUTE', aircraftId: bobPlane, origin: 'LAX', destination: 'ORD', weeklyFrequency: 5 });
log('Aurora Air routes:', world.airlines.get('alice').routes.length, '· Borealis routes:', world.airlines.get('bob').routes.length);

log('\n── Anti-cheat: client cannot tick time or edit its own state ──');
try { applyPlayerAction(world, 'alice', { type: 'ADVANCE_WEEK' }); }
catch (e) { log('  rejected ADVANCE_WEEK from client →', e.message); }
try { applyPlayerAction(world, 'alice', { type: 'SET_CASH', amount: 9e12 }); }
catch (e) { log('  rejected SET_CASH from client →', e.message); }

log('\n── Server runs the authoritative weekly tick (×8) ────────────');
for (let i = 0; i < 8; i++) {
  const r = tickWorld(world);
  log(`  tick → Y${r.year} W${r.week} [${r.status}] ` +
      r.results.map((x) => `${x.accountId}=${money(x.cash)}(${x.phase})`).join('  '));
}

log('\n── Standings ─────────────────────────────────────────────────');
for (const [i, s] of standings(world).entries()) {
  log(`  ${i + 1}. ${s.airline.padEnd(12)} ${s.hub}  cap=${money(s.marketCap)} cash=${money(s.cash)} routes=${s.routes} (${s.phase})`);
}
log('\n✓ Demo complete — one shared world, two human airlines, server-run lockstep tick.');
