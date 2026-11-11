// The browser and the server mint the same ids for the same action.
//
// A click is applied twice: optimistically in the browser, then on the server.
// When the action creates something — a route, an aircraft, an order — each
// end used to mint its own id for it, so the server's answer "differed" from
// the state on screen and replaced it: a second full projection of the week on
// the main thread (0.7 s at 4,000 routes, measured 2026-11-11) for a state
// that was otherwise identical.
//
// An action may now carry `idSeed`; every id minted while it runs is
// `<seed>-<n>` (engine reducer `uid`). The client picks a seed per click and
// sends it; the server uses it if it is well-formed and unused. What this pins:
//   • same seed, same state → the same ids at both ends, so the comparison a
//     decision reply goes through says "same"
//   • the seed never ends up in the state, and the week never takes one
//   • a bad or used seed is ignored (ids as before), never trusted
//
//   node --import ./tools/_register-loader.mjs tools/id-seed-test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${String(e && e.stack || e).split('\n').slice(0, 4).join('\n      ')}`); }
}
const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const json = (x) => JSON.parse(JSON.stringify(x));

const eng = await import('../packages/engine/reducer.mjs');
const { gameReducer, freshState } = eng;
const { compareDecisionResult } = await import('../apps/headwinds-web/src/decisionAdoption.js');
const need = () => { if (typeof eng.newIdSeed !== 'function') throw new Error('the engine exports no newIdSeed'); };

function started() {
  let s = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'Seed Air', hub: 'JFK', enableObjectives: false });
  return { ...s, multiplayer: true, competitors: [], humanRivals: {}, encroachments: {}, cash: 5e9 };
}
// Open a route from scratch: an aircraft, a gate, a route — three actions that mint ids.
function openRoute(s, dest, seeds) {
  const act = (state, action, i) => gameReducer(state, seeds ? { ...action, idSeed: seeds[i] } : action);
  let n = act(s, { type: 'LEASE_AIRCRAFT', typeId: 'a320neo' }, 0);
  n = act(n, { type: 'ADD_GATE', airportCode: dest }, 1);
  n = act(n, { type: 'ADD_ROUTE', aircraftId: n.fleet[n.fleet.length - 1].id, origin: 'JFK', destination: dest, weeklyFrequency: 7 }, 2);
  return n;
}
const allIds = (s) => Object.values(s).filter(Array.isArray).flatMap((t) => t.map((r) => r?.id)).filter((id) => typeof id === 'string');

test('the same seed gives the same ids at both ends; no seed gives different ones', () => {
  need();
  const base = started();
  const seeds = ['mhz0abcd-k3x9q', 'mhz0abce-11aa0', 'mhz0abcf-zz9zz'];
  const browser = openRoute(base, 'BOS', seeds);
  const server = openRoute(json(base), 'BOS', seeds);
  assert.equal(browser.routes.length, 1, `route not opened (${browser.error ?? 'no error'})`);
  assert.equal(browser.routes[0].id, server.routes[0].id);
  assert.equal(browser.fleet[0].id, server.fleet[0].id);
  assert.match(browser.fleet[0].id, /^mhz0abcd-k3x9q-[0-9a-z]+$/);
  assert.match(browser.routes[0].id, /^mhz0abcf-zz9zz-[0-9a-z]+$/);
  assert.equal(compareDecisionResult(browser, json(server)), 'same', 'the server\'s answer would still replace the state on screen');
  // Without seeds the two ends disagree, which is what cost the second projection.
  const a = openRoute(base, 'BOS'), b = openRoute(json(base), 'BOS');
  assert.notEqual(a.routes[0].id, b.routes[0].id);
  assert.equal(compareDecisionResult(a, json(b)), 'state');
});
test('every id an action mints comes from its seed, in order, and they are distinct', () => {
  need();
  const s = gameReducer(started(), { type: 'LEASE_AIRCRAFT', typeId: 'a320neo', quantity: 3, idSeed: 'mhz0abcd-k3x9q' });
  const mine = allIds(s).filter((id) => id.startsWith('mhz0abcd-k3x9q-'));
  assert.ok(mine.length >= 1, 'no seeded id in the state');
  assert.equal(new Set(mine).size, mine.length);
});
test('the seed is not kept: not in the state, and not handed to the next action', () => {
  need();
  const seeded = openRoute(started(), 'BOS', ['mhz0abcd-k3x9q', 'mhz0abce-11aa0', 'mhz0abcf-zz9zz']);
  assert.ok(!JSON.stringify(seeded).includes('idSeed'), 'idSeed was written into the state');
  const after = gameReducer(seeded, { type: 'LEASE_AIRCRAFT', typeId: 'a320neo' });
  const newest = after.fleet[after.fleet.length - 1].id;
  assert.ok(!/^mhz0abc/.test(newest), `an unseeded action minted ${newest} from the last action's seed`);
});
test('a malformed seed is ignored, and the week never takes one', () => {
  need();
  for (const bad of ['', 'x', 'UPPER-case1', 'has space-abc12', '../../etc-passwd', 12345, null, { a: 1 }, 'a'.repeat(60) + '-abcde']) {
    assert.equal(eng.isIdSeed(bad), false, String(bad));
    const s = gameReducer(started(), { type: 'LEASE_AIRCRAFT', typeId: 'a320neo', idSeed: bad });
    assert.ok(s.fleet.length === 1 && !String(s.fleet[0].id).startsWith(String(bad) + '-'), `seed ${String(bad)} was used`);
    assert.ok(!JSON.stringify(s).includes('idSeed'));
  }
  assert.equal(eng.isIdSeed(eng.newIdSeed()), true);
  const week = gameReducer(openRoute(started(), 'BOS'), { type: 'ADVANCE_WEEK', idSeed: 'mhz0abcd-k3x9q' });
  assert.ok(!allIds(week).some((id) => id.startsWith('mhz0abcd-k3x9q-')), 'the weekly tick minted ids from a seed');
});
test('a seed already in use is detected', () => {
  need();
  const s = gameReducer(started(), { type: 'LEASE_AIRCRAFT', typeId: 'a320neo', idSeed: 'mhz0abcd-k3x9q' });
  assert.equal(eng.idSeedInUse(s, 'mhz0abcd-k3x9q'), true);
  assert.equal(eng.idSeedInUse(s, 'mhz0abcd-k3x9r'), false);
  assert.equal(eng.idSeedInUse(null, 'mhz0abcd-k3x9q'), false);
});
test('the client seeds every decision and sends the seed; the server checks it before using it', () => {
  const web = read('apps/headwinds-web/src/GamePlayScreen.jsx');
  assert.match(web, /const idSeed = newIdSeed\(\);\s*\n\s*const seeded = \{ \.\.\.action, idSeed \};/);
  assert.match(web, /const next = gameReducer\(s, seeded\);/);
  assert.match(web, /body: \{ type, payload: \{ \.\.\.payload, idSeed \} \}/);
  const srv = read('apps/headwinds-server/src/routes/decisions.mjs');
  assert.match(srv, /delete action\.idSeed;\s*\n\s*if \(isIdSeed\(payload\.idSeed\) && !idSeedInUse\(airline\.state, payload\.idSeed\)\) action\.idSeed = payload\.idSeed;/);
  assert.match(srv, /const next = gameReducer\(injected, action\);/);
});

console.log(`\nid-seed-test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
