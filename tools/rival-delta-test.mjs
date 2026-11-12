// Rival updates sent as what changed.
//
// Between ticks a poll that finds "a rival moved" was answered with the whole
// rival overlay — every other airline's competitor entry and every contested
// pair: 2.9 MB of JSON on the busiest world (measured 2026-11-12), for a move
// that usually changes one entry and a handful of pairs. A client that names
// the overlay it holds (`rbase`) now gets a patch (server lib/rivalDelta.mjs)
// and rebuilds the overlay (web rivalDelta.js).
//
// What this pins:
//   • the rebuilt overlay is the server's overlay, byte for byte as JSON (key
//     order included), after every kind of change: fares, routes opened and
//     closed, a rename, an airline retiring, one joining, keys appearing
//   • a fare change is a small fraction of the whole
//   • the patch is only sent against the overlay the client says it holds
//   • a patch that does not fit is refused, and the client asks again
//
//   node tools/rival-delta-test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import { AIRCRAFT_TYPES } from '../packages/engine/src/data/aircraft.js';
import { buildRivalViews, rivalOverlay, stripRivals } from '../apps/headwinds-server/src/lib/humanRivals.mjs';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const server = await import('../apps/headwinds-server/src/lib/rivalDelta.mjs').catch(() => null);
const client = await import('../apps/headwinds-web/src/rivalDelta.js').catch(() => null);
const need = () => { if (!server || !client) throw new Error('lib/rivalDelta.mjs or web rivalDelta.js does not exist'); };

const shortHaul = AIRCRAFT_TYPES.find((t) => t.id === 'a320neo');
function airline({ id, name, hub, dests, fare }) {
  let s = gameReducer(freshState(), { type: 'START_GAME', airlineName: name, hub, enableObjectives: false });
  s = { ...s, multiplayer: true, competitors: [], humanRivals: {}, encroachments: {}, cash: 5e9 };
  for (const dest of dests) {
    s = gameReducer(s, { type: 'LEASE_AIRCRAFT', typeId: shortHaul.id });
    s = gameReducer(s, { type: 'ADD_GATE', airportCode: dest });
    s = gameReducer(s, { type: 'ADD_ROUTE', aircraftId: s.fleet[s.fleet.length - 1].id, origin: hub, destination: dest, weeklyFrequency: 14 });
  }
  for (const r of s.routes) s = gameReducer(s, { type: 'UPDATE_TICKET_PRICE', routeId: r.id, ticketPrice: fare });
  return { id, worldId: 'w', name, hub, status: 'ACTIVE', restarts: 0, version: 1, shares: 1_000_000,
           account: { isOG: false, isSupporter: false, email: null }, state: stripRivals(s) };
}
const write = (row, fn) => ({ ...row, state: stripRivals(fn({ ...row.state, competitors: [], humanRivals: {}, encroachments: {} })), version: row.version + 1 });
const act = (row, type, extra) => write(row, (s) => gameReducer(s, { type, ...extra }));
const openRoute = (row, from, to) => write(row, (s) => {
  let n = gameReducer(s, { type: 'LEASE_AIRCRAFT', typeId: shortHaul.id });
  n = gameReducer(n, { type: 'ADD_GATE', airportCode: to });
  return gameReducer(n, { type: 'ADD_ROUTE', aircraftId: n.fleet[n.fleet.length - 1].id, origin: from, destination: to, weeklyFrequency: 7 });
});
const roster = () => [
  airline({ id: 'a1', name: 'Alice Air', hub: 'JFK', dests: ['BOS', 'ORD', 'MIA'], fare: 170 }),
  airline({ id: 'a2', name: 'Bob Airways', hub: 'BOS', dests: ['JFK', 'ORD'], fare: 150 }),
  airline({ id: 'a3', name: 'Carol Connect', hub: 'JFK', dests: ['BOS', 'ATL'], fare: 160 }),
  airline({ id: 'a4', name: 'Dan Jet', hub: 'ORD', dests: ['JFK', 'ATL', 'MIA'], fare: 180 }),
];
const overlayFor = (rows, me = 'a1', extra = {}) => ({ ...JSON.parse(JSON.stringify(rivalOverlay(buildRivalViews(rows, new Map()).get(me)))), ...extra });

console.log('\n── the rebuilt overlay is the server\'s ─────────────────');

await test('after every kind of change the client rebuilds exactly what the server would have sent', () => {
  need();
  server.clearRivalDeltaRecords();
  let rows = roster();
  let stamp = 10;
  let sent = server.rivalsReply('a1', String(stamp), overlayFor(rows), null);
  assert.ok(sent.rivals, 'the first poll must get the whole overlay');
  let held = { served: String(stamp), overlay: JSON.parse(JSON.stringify(sent.rivals)) };
  const steps = [
    ['a rival\'s fare', (r) => r.map((x) => (x.id === 'a2' ? act(x, 'UPDATE_TICKET_PRICE', { routeId: x.state.routes[0].id, ticketPrice: 99 }) : x)), {}],
    ['a rival\'s frequency', (r) => r.map((x) => (x.id === 'a4' ? act(x, 'UPDATE_FREQUENCY', { routeId: x.state.routes[0].id, weeklyFrequency: 3 }) : x)), {}],
    ['a rival opens a contested pair', (r) => r.map((x) => (x.id === 'a3' ? openRoute(x, 'JFK', 'MIA') : x)), {}],
    ['a rival closes one', (r) => r.map((x) => (x.id === 'a4' ? act(x, 'CLOSE_ROUTE', { routeId: x.state.routes.find((q) => q.destination === 'MIA').id }) : x)), {}],
    ['a rename', (r) => r.map((x) => (x.id === 'a2' ? { ...x, name: 'Bob International' } : x)), {}],
    ['a key appears', (r) => r, { gateMarket: { JFK: { free: 3 } }, allianceSlotPool: {} }],
    ['it changes', (r) => r, { gateMarket: { JFK: { free: 2 } }, allianceSlotPool: {} }],
    ['it goes', (r) => r, {}],
    ['an airline retires', (r) => r.map((x) => (x.id === 'a3' ? { ...x, status: 'RETIRED', version: x.version + 1 } : x)), {}],
    ['an airline joins', (r) => [...r, airline({ id: 'a0', name: 'Zed Air', hub: 'ATL', dests: ['JFK', 'BOS'], fare: 140 })], {}],
    ['nothing at all', (r) => r, {}],
  ];
  let patched = 0;
  for (const [what, step, extra] of steps) {
    rows = step(rows);
    stamp++;
    const overlay = overlayFor(rows, 'a1', extra);
    const reply = JSON.parse(JSON.stringify(server.rivalsReply('a1', String(stamp), overlay, held.served)));
    const rebuilt = reply.rivalsPatch ? client.applyRivalsPatch(held.overlay, reply.rivalsPatch) : reply.rivals;
    if (reply.rivalsPatch) patched++;
    assert.equal(JSON.stringify(rebuilt), JSON.stringify(overlay), `after ${what}`);
    held = { served: String(stamp), overlay: rebuilt };
  }
  assert.equal(patched, steps.length, 'every step after the first should have been a patch');
});
await test('a rival\'s fare change is a small fraction of the whole overlay', () => {
  need();
  server.clearRivalDeltaRecords();
  // Twelve airlines on a shared network: a realistic share of pairs per entry.
  const hubs = ['JFK', 'BOS', 'ORD', 'ATL', 'MIA', 'DFW', 'LAX', 'SFO', 'SEA', 'DEN', 'IAH', 'PHX'];
  let rows = hubs.map((hub, i) => airline({ id: `b${i}`, name: `Air ${i}`, hub, dests: hubs.filter((x) => x !== hub).slice(0, 6), fare: 150 + i }));
  const whole = overlayFor(rows, 'b0');
  server.rivalsReply('b0', '1', whole, null);
  rows = rows.map((x) => (x.id === 'b5' ? act(x, 'UPDATE_TICKET_PRICE', { routeId: x.state.routes[0].id, ticketPrice: 99 }) : x));
  const overlay = overlayFor(rows, 'b0');
  const reply = server.rivalsReply('b0', '2', overlay, '1');
  assert.ok(reply.rivalsPatch);
  const size = JSON.stringify(reply.rivalsPatch).length, all = JSON.stringify(overlay).length;
  assert.ok(size < all * 0.25, `${size} bytes of ${all}`);
  assert.equal(reply.rivalsPatch.comps.order, null);
  assert.equal(reply.rivalsPatch.pairs.keys, null, 'no pair came or went: the order is not resent');
  assert.equal(JSON.stringify(client.applyRivalsPatch(JSON.parse(JSON.stringify(whole)), JSON.parse(JSON.stringify(reply.rivalsPatch)))), JSON.stringify(overlay));
});

console.log('\n── only against what the client holds ───────────────────');

await test('the patch is cut against the overlay the client names, and nothing else', () => {
  need();
  server.clearRivalDeltaRecords();
  const rows = roster();
  const o1 = overlayFor(rows);
  assert.ok(server.rivalsReply('a1', '1', o1, null).rivals, 'no rbase: whole');
  assert.ok(server.rivalsReply('a1', '2', o1, '1').rivalsPatch, 'rbase is what was sent: patch');
  assert.ok(server.rivalsReply('a1', '3', o1, '1').rivals, 'rbase is an older overlay: whole');
  assert.ok(server.rivalsReply('a2', '3', overlayFor(rows, 'a2'), '3').rivals, 'another airline\'s record is not ours');
  assert.equal(server.rivalDeltaRecordCount(), 2);
  // An overlay whose competitors cannot be told apart by id is sent whole.
  const dup = { ...o1, competitors: [...o1.competitors, o1.competitors[0]] };
  server.rivalsReply('a1', '4', dup, null);
  assert.ok(server.rivalsReply('a1', '5', dup, '4').rivals);
});
await test('a patch that does not fit what the client holds is refused', () => {
  need();
  const held = { competitors: [{ id: 'x' }], humanRivals: { 'A-B': [1] }, stockPool: null };
  assert.throws(() => client.applyRivalsPatch(held, { keys: null, top: { set: {}, drop: [] }, comps: { order: ['x', 'y'], put: [] }, pairs: { keys: null, put: {} } }), /no competitor y/);
  assert.throws(() => client.applyRivalsPatch(held, { keys: null, top: { set: {}, drop: [] }, comps: { order: null, put: [] }, pairs: { keys: ['A-B', 'C-D'], put: {} } }), /no pair C-D/);
  assert.throws(() => client.applyRivalsPatch(held, { keys: ['stockPool', 'gateMarket', 'competitors', 'humanRivals'], top: { set: {}, drop: [] }, comps: { order: null, put: [] }, pairs: { keys: null, put: {} } }), /gateMarket/);
  assert.throws(() => client.applyRivalsPatch(null, {}), /nothing to apply/);
  assert.equal(client.worldHalfOf('12:340.7'), '340.7');
  assert.equal(client.worldHalfOf(null), null);
});

console.log('\n── the wiring ───────────────────────────────────────────');

await test('both poll branches that send rivals go through rivalsReply; rbase is in the schema', () => {
  const src = read('apps/headwinds-server/src/routes/decisions.mjs');
  assert.equal((src.match(/\.\.\.rivalsReply\(slim\.id, served, rivalOverlay\(view\), request\.query\.rbase\)/g) ?? []).length, 2);
  assert.match(src, /rbase: \{ type: 'string', maxLength: 40 \}/);
});
await test('the client names what it holds, rebuilds from it, and on a misfit drops the reply without its stamp', () => {
  const src = read('apps/headwinds-web/src/GamePlayScreen.jsx');
  assert.match(src, /\$\{held \? `&rbase=\$\{encodeURIComponent\(held\.served\)\}` : ''\}/);
  assert.match(src, /rebuilt = applyRivalsPatch\(held\.overlay, d\.rivalsPatch\);/);
  assert.match(src, /if \(!rebuilt\) \{ rivalShadow\.current = null; return; \}/);
  assert.match(src, /if \(d\.rivals\) rivalShadow\.current = \{ served: worldHalfOf\(d\.stamp\), overlay: d\.rivals \};/);
  const i = src.indexOf('if (d.rivalsPatch) {'), j = src.indexOf('if (d.stamp) stampRef.current = d.stamp;');
  assert.ok(i > 0 && j > i, 'the patch must be settled before the reply\'s stamp is taken');
});

console.log(`\nrival-delta-test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
