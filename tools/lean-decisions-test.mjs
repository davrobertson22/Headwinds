// A decision is answered with what it changed.
//
// POST /decisions used to return the airline's whole state on every click:
// 19–22 MB of JSON for the largest live airlines (measured 2026-11-11: 111 ms
// to serialise and 202 ms to compress on the server, 76 ms to parse in the
// browser, 2 MB on the wire), of which `lastReport` is 12.6 MB and a fare
// change alters one route. A client that names the version of its airline it
// holds is now sent a patch (engine utils/statePatch.js, server
// lib/leanReply.mjs) and keeps a shadow of the server's copy to apply it to
// (web leanDecisions.js).
//
// What this pins:
//   • the patch is found by identity and applying it gives the state the whole
//     reply would have carried, after any sequence of actions, through the
//     same storage round trip the server makes (JSON, report and logo columns)
//   • it is small: a fare change on a 300-route airline is a few kB, not MBs
//   • the reply is only lean for the version the action was applied to
//   • a reply that does not follow from the shadow is refused, not guessed at
//   • a tab that does not ask still gets the whole state
//
//   node --import ./tools/_register-loader.mjs tools/lean-decisions-test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';

globalThis.window = globalThis.window ?? {};
globalThis.window.matchMedia = globalThis.window.matchMedia ?? (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
const mem = new Map();
globalThis.localStorage = globalThis.localStorage ?? { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
process.env.DATABASE_URL ??= 'postgresql://x:y@localhost:5432/z';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${String(e && e.stack || e).split('\n').slice(0, 4).join('\n      ')}`); }
}
function section(t) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 62 - t.length))}`); }
const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const json = (x) => JSON.parse(JSON.stringify(x));

const { gameReducer, freshState } = await import('../packages/engine/src/reducer.mjs');
const { getAircraftType } = await import('../packages/engine/src/data/aircraft.js');
const sim = await import('../packages/engine/src/utils/simulation.js');
const { AIRPORTS } = await import('../packages/engine/src/data/airports.js');
const patchMod = await import('../packages/engine/src/utils/statePatch.js').catch(() => null);
const lean = await import('../apps/headwinds-server/src/lib/leanReply.mjs').catch(() => null);
const client = await import('../apps/headwinds-web/src/leanDecisions.js').catch(() => null);
const { withRivals, stripRivals, rivalOverlay } = await import('../apps/headwinds-server/src/lib/humanRivals.mjs');
const { joinReport, splitReport } = await import('../apps/headwinds-server/src/lib/reportColumn.mjs');
const { injectLogo, splitLogo } = await import('../apps/headwinds-server/src/lib/logoColumn.mjs');
const { compareDecisionResult, RIVAL_OVERLAY_KEYS, sameJson } = await import('../apps/headwinds-web/src/decisionAdoption.js');
const need = () => { if (!patchMod || !lean || !client) throw new Error('statePatch.js, leanReply.mjs or leanDecisions.js does not exist'); };

function airline(n) {
  const hub = 'SIN', t = getAircraftType('a320neo');
  const dests = AIRPORTS.map(a => a.code).filter(c => c !== hub && sim.routeDistanceKm(hub, c) > 300 && sim.routeDistanceKm(hub, c) < 4200).slice(0, n);
  const fleet = dests.map((d, i) => ({ id: `p${i}`, typeId: t.id, status: 'assigned', ageWeeks: 30 + i, config: sim.defaultConfig(t.seats),
    ownershipType: 'owned', purchasePrice: 50e6, tailNumber: `9V-${1000 + i}`, name: `Probe ${1000 + i}` }));
  fleet.push({ id: 'spare', typeId: t.id, status: 'idle', ageWeeks: 10, config: sim.defaultConfig(t.seats), ownershipType: 'owned', purchasePrice: 50e6, tailNumber: '9V-SPARE', name: 'Spare' });
  const routes = dests.map((d, i) => ({ id: `r${i}`, origin: hub, destination: d, stops: [hub, d], aircraftId: `p${i}`, weeklyFrequency: 7, weeksOpen: 30, hub, ticketPrice: 300 }));
  let s = { ...freshState(), phase: 'playing', week: 20, year: 3, hub, airlineName: 'Probe Air', cash: 5e9, multiplayer: true,
    hubs: { [hub]: { tier: 3, tierSince: 0 } }, fleet, routes, cargoRoutes: [], gates: Object.fromEntries([[hub, 400], ...dests.map(d => [d, 2])]) };
  // A week, so there is a report in its own column and histories in the blob.
  s = gameReducer({ ...s, competitors: [], humanRivals: {}, encroachments: {} }, { type: 'ADVANCE_WEEK' });
  const { state: blob, logo, tail } = splitLogo(stripRivals(s));
  const { state, report } = splitReport(blob);
  return { id: 'a1', worldId: 'w', version: 7, state: json(state), report: json(report ?? null), customLogo: logo ?? 'data:image/png;base64,AAAA', customTail: tail ?? null };
}
const VIEW = { competitors: [{ id: 'h1', name: 'Rival', human: true, routes: {}, homeHub: 'BKK' }], humanRivals: {}, alliance: null };

// The server, as routes/decisions.mjs does it: reducer over the injected view,
// the same split into columns, the same reply. Returns the next row as it
// would be read back from Postgres.
function decide(row, action, query) {
  const injected = withRivals(joinReport(row.state, row.report), VIEW);
  const next = gameReducer(injected, action);
  const { state: blob, logo, tail } = splitLogo(stripRivals(next));
  const { state: persisted, report } = splitReport(blob);
  const full = { ok: true, state: injectLogo(next, row.customLogo, row.customTail), stamp: `${row.version + 1}:55.2` };
  const reply = lean.wantsLeanReply(query, row) ? { ok: true, ...lean.leanReply({ airline: row, injected, next, view: VIEW }) } : full;
  return {
    row: { ...row, state: json(persisted), report: json(report ?? null), customLogo: logo !== undefined ? logo : row.customLogo, customTail: tail !== undefined ? tail : row.customTail, version: row.version + 1 },
    reply: json(reply), whole: json(full.state), bytes: JSON.stringify(reply).length, wholeBytes: JSON.stringify(full).length,
  };
}
const get = (row) => json({ ...withRivals(injectLogo(joinReport(row.state, row.report), row.customLogo, row.customTail), null), ...rivalOverlay(VIEW) });
const own = (state) => { const o = { ...state }; for (const k of RIVAL_OVERLAY_KEYS) delete o[k]; return o; };
const q = (shadow) => ({ lean: '1', base: String(shadow.version) });

section('the patch');

test('found by identity: untouched keys and rows are not in it', () => {
  need();
  const before = { a: { x: 1 }, b: [1, 2], rows: Array.from({ length: 40 }, (_, i) => ({ id: i })), gone: 1, same: 'x' };
  const after = { ...before, a: { x: 2 }, rows: before.rows.map((r, i) => (i === 7 ? { ...r, fare: 9 } : r)), fresh: true };
  delete after.gone;
  const p = patchMod.diffState(before, after);
  assert.deepEqual(Object.keys(p.set).sort(), ['a', 'fresh']);
  assert.deepEqual(p.drop, ['gone']);
  assert.deepEqual(p.rows, { rows: { len: 40, at: [[7, { id: 7, fare: 9 }]] } });
  assert.deepEqual(p.maps, {});
  const applied = patchMod.applyStatePatch(json(before), json(p));
  assert.deepEqual(applied, json(after));
  assert.ok(patchMod.isEmptyPatch(patchMod.diffState(before, before)));
});
test('rows appended ride along; a table that lost or reordered rows is sent whole', () => {
  need();
  const rows = Array.from({ length: 40 }, (_, i) => ({ id: i }));
  const grown = patchMod.diffState({ rows }, { rows: [...rows, { id: 40 }, { id: 41 }] });
  assert.deepEqual(grown.rows.rows, { len: 42, at: [[40, { id: 40 }], [41, { id: 41 }]] });
  assert.deepEqual(patchMod.applyStatePatch({ rows: json(rows) }, json(grown)).rows.map(r => r.id), [...Array(42).keys()]);
  const shrunk = patchMod.diffState({ rows }, { rows: rows.filter(r => r.id !== 3) });
  assert.ok(shrunk.set.rows && !shrunk.rows.rows, 'a removal must not be patched by position');
  const rebuilt = patchMod.diffState({ rows }, { rows: rows.map(r => ({ ...r })) });
  assert.ok(rebuilt.set.rows, 'every row replaced: send the table');
  const short = patchMod.diffState({ rows: rows.slice(0, 5) }, { rows: rows.slice(0, 5).map((r, i) => (i ? r : { id: 'x' })) });
  assert.ok(short.set.rows, 'short tables are sent whole');
});
test('a large keyed table sends the entries that changed and the keys that went', () => {
  need();
  const fares = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`P${i}`, { economy: 100 + i }]));
  const after = { ...fares, P5: { economy: 999 }, NEW: { economy: 1 } };
  delete after.P9;
  const p = patchMod.diffState({ fares }, { fares: after });
  assert.deepEqual(p.maps.fares, { put: { P5: { economy: 999 }, NEW: { economy: 1 } }, del: ['P9'] });
  const applied = patchMod.applyStatePatch({ fares: json(fares) }, json(p));
  assert.deepEqual(applied.fares, json(after));
  assert.equal(patchMod.diffState({ fares: { a: {} } }, { fares: { a: { x: 1 } } }).set.fares.a.x, 1, 'a small table is sent whole');
  assert.throws(() => patchMod.applyStatePatch({ fares: [1] }, p), /no keyed table/);
});
test('a patch that cannot belong to the state is refused', () => {
  need();
  const p = { set: {}, drop: [], rows: { rows: { len: 40, at: [[7, { id: 7 }]] } } };
  assert.throws(() => patchMod.applyStatePatch({ rows: [{ id: 0 }] }, p), /shorter here/);
  assert.throws(() => patchMod.applyStatePatch({}, p), /no table/);
  assert.throws(() => patchMod.applyStatePatch({ rows: Array(40).fill({}) }, { rows: { rows: { len: 40, at: [[41, {}]] } } }), /outside/);
});
test('what is applied shares everything the patch does not mention', () => {
  need();
  const before = { big: { report: 1 }, rows: Array.from({ length: 40 }, (_, i) => ({ id: i })) };
  const out = patchMod.applyStatePatch(before, { set: {}, drop: [], rows: { rows: { len: 40, at: [[3, { id: 'n' }]] } } });
  assert.equal(out.big, before.big);
  assert.equal(out.rows[2], before.rows[2]);
  assert.notEqual(out.rows, before.rows);
  assert.equal(before.rows[3].id, 3, 'the state it was applied to is untouched');
});

section('server and client, action by action');

const ACTIONS = (row) => {
  const r = (i) => row.state.routes[i]?.id;
  return [
    ['a fare', { type: 'UPDATE_TICKET_PRICE', routeId: r(5), ticketPrice: 333 }],
    ['a frequency', { type: 'UPDATE_FREQUENCY', routeId: r(9), weeklyFrequency: 5 }],
    ['a route closed', { type: 'CLOSE_ROUTE', routeId: r(2) }],
    ['a gate and a route opened', { type: 'ADD_ROUTE', aircraftId: 'spare', origin: 'SIN', destination: row.state.routes[0].destination, weeklyFrequency: 3 }],
    ['marketing', { type: 'SET_MARKETING_BUDGET', budget: 250_000 }],
    ['an aircraft leased', { type: 'LEASE_AIRCRAFT', typeId: 'a320neo' }],
    ['an action the engine refuses', { type: 'UPDATE_TICKET_PRICE', routeId: 'no-such-route', ticketPrice: 100 }],
    ['another fare', { type: 'UPDATE_TICKET_PRICE', routeId: r(11), ticketPrice: 222 }],
  ];
};
test('the shadow, patched, is the state the whole reply would have carried — every time', () => {
  need();
  let row = airline(300);
  let shadow = { state: get(row), version: row.version };
  for (const [what, action] of ACTIONS(row)) {
    const d = decide(row, action, q(shadow));
    assert.ok(d.reply.patch, `${what}: the reply was not lean`);
    const moved = client.advanceShadow(shadow, d.reply, patchMod.applyStatePatch);
    assert.ok(moved.applied && !moved.lost, `${what}: the patch did not apply`);
    assert.ok(sameJson(own(moved.shadow.state), own(d.whole)), `${what}: the patched shadow is not the server's state`);
    assert.equal(moved.shadow.version, d.row.version);
    shadow = moved.shadow; row = d.row;
    // …and it is what a fresh load of the row would give.
    assert.ok(sameJson(own(shadow.state), own(get(row))), `${what}: the shadow has drifted from the stored row`);
  }
});
test('a fare change on 300 routes is a few kB, and the report never travels', () => {
  need();
  let row = airline(300);
  // An airline that has priced its routes: fares sit in a table keyed by pair.
  for (let i = 20; i < 70; i++) row = decide(row, { type: 'UPDATE_TICKET_PRICE', routeId: row.state.routes[i].id, ticketPrice: 250 + i }).row;
  const shadow = { state: get(row), version: row.version };
  const d = decide(row, { type: 'UPDATE_TICKET_PRICE', routeId: row.state.routes[5].id, ticketPrice: 333 }, q(shadow));
  assert.ok(d.wholeBytes > 400_000, `the whole reply is only ${d.wholeBytes} bytes: the fixture is too small to mean anything`);
  assert.ok(d.bytes < 6_000, `a fare change sent ${d.bytes} bytes`);
  assert.ok(!('lastReport' in d.reply.patch.set));
  // Fares live in a table keyed by city pair: one entry of it travels.
  assert.deepEqual(Object.keys(d.reply.patch.set), []);
  assert.deepEqual(Object.keys(d.reply.patch.maps), ['routePricing']);
  assert.equal(Object.keys(d.reply.patch.maps.routePricing.put).length, 1);
  // A frequency is on the route: one row of the route table travels.
  const f = decide(row, { type: 'UPDATE_FREQUENCY', routeId: row.state.routes[9].id, weeklyFrequency: 5 }, q(shadow));
  assert.equal(f.reply.patch.rows.routes?.at.length, 1);
  assert.ok(f.bytes < 6_000, `a frequency change sent ${f.bytes} bytes`);
  for (const k of RIVAL_OVERLAY_KEYS) assert.ok(!(k in d.reply.patch.set), `${k} was sent though the reducer did not touch it`);
  assert.ok(!('customLogo' in d.reply.patch.set), 'the logo was sent again');
});
test('the newest decision is judged against everything that landed, as the whole state was', () => {
  need();
  let row = airline(60);
  const loaded = get(row);
  let shadow = { state: loaded, version: row.version };
  let local = loaded;
  // Three quick edits: only the last reply is compared, and it must see all three.
  const edits = [
    { type: 'UPDATE_TICKET_PRICE', routeId: row.state.routes[1].id, ticketPrice: 111 },
    { type: 'UPDATE_FREQUENCY', routeId: row.state.routes[2].id, weeklyFrequency: 4 },
    { type: 'UPDATE_TICKET_PRICE', routeId: row.state.routes[3].id, ticketPrice: 444 },
  ];
  for (const a of edits) local = gameReducer(local, a);
  for (const a of edits) {
    const d = decide(row, a, q(shadow));
    shadow = client.advanceShadow(shadow, d.reply, patchMod.applyStatePatch).shadow; row = d.row;
  }
  assert.equal(compareDecisionResult(local, { ...shadow.state }), 'same');
  // Had the server refused the second one, the comparison says so.
  const refused = { ...shadow.state, routes: shadow.state.routes.map((r, i) => (i === 2 ? { ...r, weeklyFrequency: 7 } : r)) };
  assert.equal(compareDecisionResult(local, refused), 'state');
  // And it reads only what was touched: the untouched rows are the same objects.
  assert.equal(shadow.state.lastReport, loaded.lastReport);
  assert.equal(shadow.state.routes[10], loaded.routes[10]);
});

section('when the reply is not lean, or not usable');

test('lean only for the version the action was applied to; whole otherwise', () => {
  need();
  const row = airline(40);
  const action = { type: 'UPDATE_TICKET_PRICE', routeId: row.state.routes[1].id, ticketPrice: 111 };
  assert.ok(decide(row, action, { lean: '1', base: String(row.version) }).reply.patch);
  assert.ok(decide(row, action, { lean: '1', base: String(row.version - 1) }).reply.state, 'a client behind the server must get the whole state');
  assert.ok(decide(row, action, { base: String(row.version) }).reply.state, 'a client that did not ask must get the whole state');
  assert.ok(decide(row, action, {}).reply.state);
  assert.ok(decide(row, action, undefined).reply.state);
});
test('the shadow moves only on the reply that follows it', () => {
  need();
  const apply = patchMod.applyStatePatch;
  const shadow = { state: { a: 1 }, version: 9 };
  const reply = (base) => ({ base, version: base + 1, patch: { set: { a: 2 }, drop: [], rows: {}, maps: {} } });
  assert.deepEqual(client.advanceShadow(shadow, reply(9), apply), { shadow: { state: { a: 2 }, version: 10 }, applied: true, lost: false });
  // Older than the shadow (a load overtook it): ignored, nothing lost.
  assert.deepEqual(client.advanceShadow(shadow, reply(8), apply), { shadow, applied: false, lost: false });
  // Ahead of the shadow: a write we never saw. The shadow is gone.
  assert.deepEqual(client.advanceShadow(shadow, reply(11), apply), { shadow: null, applied: false, lost: true });
  assert.equal(client.advanceShadow(null, reply(9), apply).lost, true);
  assert.equal(client.advanceShadow(shadow, { base: 9, patch: { rows: { t: { len: 3, at: [] } } } }, apply).lost, true, 'a patch that does not fit');
});
test('our half of the stamp follows the write; the world half is kept', () => {
  need();
  assert.equal(client.selfVersionOf('12:340.7'), 12);
  assert.equal(client.selfVersionOf(null), null);
  assert.equal(client.withSelfVersion('12:340.7', 13), '13:340.7');
  assert.equal(client.withSelfVersion('14:340.7', 13), '14:340.7', 'never backwards');
  assert.equal(client.withSelfVersion(null, 13), null);
});

section('the wiring');

test('the route answers lean through leanReply, after the write, and whole otherwise', () => {
  const src = read('apps/headwinds-server/src/routes/decisions.mjs');
  assert.match(src, /const isLean = wantsLeanReply\(request\.query, airline\);/);
  assert.match(src, /if \(isLean\) \{\s*\n\s*return reply\.code\(201\)\.send\(\{ ok: true, \.\.\.leanReply\(\{ airline, injected, next, view \}\), error: newError \}\);/);
  assert.match(src, /lean: \{ type: 'string', maxLength: 1 \}/);
  assert.ok(src.indexOf('const isLean = wantsLeanReply(request.query, airline)') > src.indexOf('invalidateWorldStamp(airline.worldId);'), 'the lean reply must come after the write');
  assert.match(src, /state: fullState,/);
});
test('the client names its version, moves the shadow on every reply, and compares as before', () => {
  const src = read('apps/headwinds-web/src/GamePlayScreen.jsx');
  assert.match(src, /decisions\$\{shadow\.current \? `\?lean=1&base=\$\{shadow\.current\.version\}` : ''\}/);
  assert.match(src, /const moved = advanceShadow\(shadow\.current, res, applyStatePatch\);/);
  assert.match(src, /if \(moved\.lost\) \{[\s\S]{0,200}load\(\{ full: true \}\)/, 'a patch that does not fit must fetch the whole airline');
  assert.match(src, /serverState = \{ \.\.\.patched, \.\.\.overlayOf\(stateRef\.current\) \};/);
  assert.match(src, /shadow\.current = v != null \? \{ state: next, version: v \} : null;/, 'a load must start the shadow');
  assert.match(src, /settleDecision\(serverState, seq\);/);
});

console.log(`\nlean-decisions-test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
