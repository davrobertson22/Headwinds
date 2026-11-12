// Rival views: an airline is derived again only when it has been written.
//
// The rows behind the rival views are re-read once a minute, and the first
// decision or poll after that derived every airline in the world again
// (rival-view-reuse-test covers the decisions in between). Measured on the two
// largest live worlds, 2026-11-11: 1.2–1.7 s for Scarce Assets and 0.4–0.6 s
// for Lunar Gateway, synchronous, once a minute, in the one API process that
// answers every world. In a typical minute one or two airlines were written.
//
// buildRivalViews now takes a memo (humanRivals.mjs rivalViewMemo) holding
// each airline's competitor entry and scored specs with a fingerprint of what
// they were derived from. What this pins:
//   • with a memo the views are EQUAL to a derivation from scratch, after any
//     sequence of writes (fares, routes opened and closed, a rename, a
//     retirement, an alliance, a rival's marketing)
//   • a fare change derives one airline, not the world
//   • a route opened re-scores only the airlines that fly where it lands
//     (2026-11-12: it used to re-score every airline in the world, 0.6 s in
//     Scarce Assets), and the signature that decides this agrees with the
//     engine's ad-spend rule
//   • the scoring reads nothing from the other airlines but where they
//     advertise — the fields the fingerprint covers
//   • a change of world settings, and the tick's own rows, never reuse anything
//
//   node tools/rival-view-incremental-test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import * as rivals from '../apps/headwinds-server/src/lib/humanRivals.mjs';
import { AIRCRAFT_TYPES } from '../packages/engine/src/data/aircraft.js';
import { competitorMarketingSpend } from '../packages/engine/src/models/competitorAI.js';
import { createHash } from 'node:crypto';

const { buildRivalViews, buildWorldRivalViews, toRivalSpecs, stripRivals } = rivals;
const MAX = rivals.RIVAL_ROWS_MAX_STALE_MS ?? 60_000;

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
const need = () => { if (typeof rivals.rivalViewMemo !== 'function') throw new Error('humanRivals.mjs has no rivalViewMemo'); };

const shortHaul = AIRCRAFT_TYPES.find((t) => t.id === 'a320neo') ?? AIRCRAFT_TYPES.find((t) => !t.freighter && !t.supersonic && t.range > 3500 && t.seats >= 120 && t.seats <= 220);
assert.ok(shortHaul, 'no narrowbody in the engine data');

function airline({ id, name, hub, dests, fare }) {
  let s = gameReducer(freshState(), { type: 'START_GAME', airlineName: name, hub, enableObjectives: false });
  s = { ...s, multiplayer: true, competitors: [], humanRivals: {}, encroachments: {}, cash: 5e9 };
  for (const dest of dests) {
    s = gameReducer(s, { type: 'LEASE_AIRCRAFT', typeId: shortHaul.id });
    s = gameReducer(s, { type: 'ADD_GATE', airportCode: dest });
    s = gameReducer(s, { type: 'ADD_ROUTE', aircraftId: s.fleet[s.fleet.length - 1].id, origin: hub, destination: dest, weeklyFrequency: 14 });
  }
  assert.equal(s.routes.length, dests.length, `${name}: routes not created (${s.error ?? 'no error'})`);
  for (const r of s.routes) s = gameReducer(s, { type: 'UPDATE_TICKET_PRICE', routeId: r.id, ticketPrice: fare });
  return { id, worldId: 'w', name, hub, status: 'ACTIVE', restarts: 0, version: 1, shares: 1_000_000,
           account: { isOG: false, isSupporter: false, email: null }, state: stripRivals(s) };
}
const roster = () => [
  airline({ id: 'a1', name: 'Alice Air', hub: 'JFK', dests: ['BOS', 'ORD', 'MIA'], fare: 170 }),
  airline({ id: 'a2', name: 'Bob Airways', hub: 'BOS', dests: ['JFK', 'ORD'], fare: 150 }),
  airline({ id: 'a3', name: 'Carol Connect', hub: 'JFK', dests: ['BOS', 'ATL'], fare: 160 }),
  airline({ id: 'a4', name: 'Dan Jet', hub: 'ORD', dests: ['JFK', 'ATL', 'MIA'], fare: 180 }),
  airline({ id: 'a5', name: 'Eve Express', hub: 'ATL', dests: ['MIA', 'ORD'], fare: 140 }),
];
// A write, as the server makes one: a new state and the next version.
const write = (row, type, extra) => {
  const before = { ...row.state, competitors: [], humanRivals: {}, encroachments: {} };
  const next = typeof type === 'function' ? type(before) : gameReducer(before, { type, ...extra });
  return { ...row, state: stripRivals(next), version: row.version + 1 };
};
const canon = (views) => JSON.stringify([...views], (k, x) => (typeof x === 'bigint' ? `${x}n` : x));
const freshMemo = (() => { let n = 0; return () => rivals.rivalViewMemo(`wInc${n++}`, 'k'); })();
const derivedBy = (memo, fn) => { const b = { ...memo.derived }; fn(); return { comps: memo.derived.comps - b.comps, specs: memo.derived.specs - b.specs }; };

console.log('\n── with a memo the views are the views ──────────────────');

await test('equal to a derivation from scratch after every kind of write', () => {
  need();
  let rows = roster();
  const memo = freshMemo();
  const alliance = new Map();
  const steps = [
    ['nothing written', (r) => r],
    ['a fare', (r) => r.map((x) => (x.id === 'a2' ? write(x, 'UPDATE_TICKET_PRICE', { routeId: x.state.routes[0].id, ticketPrice: 99 }) : x))],
    ['a frequency', (r) => r.map((x) => (x.id === 'a4' ? write(x, 'UPDATE_FREQUENCY', { routeId: x.state.routes[1].id, weeklyFrequency: 7 }) : x))],
    ['a route closed', (r) => r.map((x) => (x.id === 'a1' ? write(x, 'CLOSE_ROUTE', { routeId: x.state.routes[2].id }) : x))],
    ['a route opened to a new airport', (r) => r.map((x) => (x.id === 'a5' ? write(x, (s) => {
      let n = gameReducer(s, { type: 'LEASE_AIRCRAFT', typeId: shortHaul.id });
      n = gameReducer(n, { type: 'ADD_GATE', airportCode: 'DFW' });
      return gameReducer(n, { type: 'ADD_ROUTE', aircraftId: n.fleet[n.fleet.length - 1].id, origin: 'ATL', destination: 'DFW', weeklyFrequency: 7 });
    }) : x))],
    ['marketing', (r) => r.map((x) => (x.id === 'a3' ? write(x, (s) => ({ ...s, marketingBudget: 2_000_000, targetedMarketing: { JFK: { spend: 500_000 } } })) : x))],
    ['a rename (no state write)', (r) => r.map((x) => (x.id === 'a2' ? { ...x, name: 'Bob International' } : x))],
    ['an alliance', (r) => { alliance.set('a4', { membership: { allianceId: 'hw:1' }, def: { name: 'Sky Circle' } }); return r; }],
    ['a retirement', (r) => r.map((x) => (x.id === 'a3' ? { ...x, status: 'RETIRED', version: x.version + 1 } : x))],
    ['two airlines in one minute', (r) => r.map((x) => (x.id === 'a1' || x.id === 'a5' ? write(x, 'UPDATE_TICKET_PRICE', { routeId: x.state.routes[0].id, ticketPrice: 201 }) : x))],
  ];
  for (const [what, step] of steps) {
    rows = [...step(rows)];
    const kept = buildRivalViews(rows, alliance, memo);
    const scratch = buildRivalViews(rows, alliance);
    assert.equal(canon(kept), canon(scratch), `after ${what}`);
  }
});

await test('a rival\'s view of an airline changes when that airline does', () => {
  need();
  let rows = roster();
  const memo = freshMemo();
  const a = buildRivalViews(rows, new Map(), memo);
  rows = rows.map((x) => (x.id === 'a2' ? write(x, 'UPDATE_TICKET_PRICE', { routeId: x.state.routes[0].id, ticketPrice: 99 }) : x));
  const b = buildRivalViews(rows, new Map(), memo);
  const bobOn = (views) => JSON.stringify(Object.values(views.get('a1').humanRivals).flat().filter((s) => JSON.stringify(s).includes('a2')));
  assert.notEqual(bobOn(a), bobOn(b), 'Alice still sees Bob\'s old fare');
  assert.ok(bobOn(b).includes('99'), 'the new fare is not in Alice\'s view');
});

console.log('\n── only what was written is derived ─────────────────────');

await test('nothing written: nothing derived', () => {
  need();
  const rows = roster();
  const memo = freshMemo();
  assert.deepEqual(derivedBy(memo, () => buildRivalViews(rows, new Map(), memo)), { comps: 5, specs: 5 });
  assert.deepEqual(derivedBy(memo, () => buildRivalViews([...rows], new Map(), memo)), { comps: 0, specs: 0 }, 'a new load of the same rows derived airlines again');
  // New row OBJECTS with the same contents, as a fresh query returns.
  assert.deepEqual(derivedBy(memo, () => buildRivalViews(rows.map((r) => ({ ...r })), new Map(), memo)), { comps: 0, specs: 0 });
});
await test('a fare change derives that airline and nobody else', () => {
  need();
  let rows = roster();
  const memo = freshMemo();
  buildRivalViews(rows, new Map(), memo);
  rows = rows.map((x) => (x.id === 'a2' ? write(x, 'UPDATE_TICKET_PRICE', { routeId: x.state.routes[0].id, ticketPrice: 99 }) : x));
  assert.deepEqual(derivedBy(memo, () => buildRivalViews(rows, new Map(), memo)), { comps: 1, specs: 1 });
});
await test('a route to an airport nobody else flies re-scores only the airline that opened it', () => {
  need();
  let rows = roster();
  const memo = freshMemo();
  buildRivalViews(rows, new Map(), memo);
  rows = rows.map((x) => (x.id === 'a5' ? write(x, (s) => {
    let n = gameReducer(s, { type: 'LEASE_AIRCRAFT', typeId: shortHaul.id });
    n = gameReducer(n, { type: 'ADD_GATE', airportCode: 'DFW' });
    return gameReducer(n, { type: 'ADD_ROUTE', aircraftId: n.fleet[n.fleet.length - 1].id, origin: 'ATL', destination: 'DFW', weeklyFrequency: 7 });
  }) : x));
  assert.ok(rows.find((x) => x.id === 'a5').state.routes.some((r) => r.destination === 'DFW'), 'the route was not opened');
  const d = derivedBy(memo, () => buildRivalViews(rows, new Map(), memo));
  assert.deepEqual(d, { comps: 1, specs: 1 }, 'until 2026-11-12 every airline in the world was scored again here');
  assert.equal(canon(buildRivalViews(rows, new Map(), freshMemo())), canon(buildRivalViews(rows, new Map())));
});
await test('a route to an airport others fly re-scores them too, and nobody else', () => {
  need();
  let rows = roster();
  const memo = freshMemo();
  buildRivalViews(rows, new Map(), memo);
  // Eve (ATL) starts flying to Boston: Alice, Bob and Carol fly Boston; Dan does not.
  rows = rows.map((x) => (x.id === 'a5' ? write(x, (s) => {
    let n = gameReducer(s, { type: 'LEASE_AIRCRAFT', typeId: shortHaul.id });
    n = gameReducer(n, { type: 'ADD_GATE', airportCode: 'BOS' });
    return gameReducer(n, { type: 'ADD_ROUTE', aircraftId: n.fleet[n.fleet.length - 1].id, origin: 'ATL', destination: 'BOS', weeklyFrequency: 7 });
  }) : x));
  const before = new Map([...memo.specs].map(([id, e]) => [id, e.value]));
  const views = buildRivalViews(rows, new Map(), memo);
  const rescored = [...memo.specs].filter(([id, e]) => e.value !== before.get(id)).map(([id]) => id).sort();
  assert.deepEqual(rescored, ['a1', 'a2', 'a3', 'a5']);
  assert.equal(canon(views), canon(buildRivalViews(rows, new Map())));
});
await test('two entries that add the same at an airport by signature add the same amount there', () => {
  need();
  // Property check of voiceSignatures against the engine itself, over entries
  // that differ in every field the spend reads.
  const base = buildRivalViews(roster(), new Map()).get('a1').competitors;
  let seed = 3; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const variants = [];
  for (const c of base) {
    for (let k = 0; k < 12; k++) {
      const routes = { ...c.routes };
      if (rnd() < 0.5) routes[`${c.homeHub}-DFW`] = {};
      if (rnd() < 0.3) routes['BOS-MIA'] = {};
      variants.push({ ...c, routes, tier: rnd() < 0.3 ? 'major' : c.tier, fireSale: rnd() < 0.15, _distressWeeks: rnd() < 0.2 ? 5 : 0,
        secondaryHub: rnd() < 0.3 ? 'MIA' : c.secondaryHub, _mktBlitz: rnd() < 0.3 ? { BOS: { spend: 400_000 } } : c._mktBlitz });
    }
  }
  const lead = base[0];
  let compared = 0;
  for (const x of variants) for (const y of variants) {
    const sx = rivals.voiceSignatures(x), sy = rivals.voiceSignatures(y);
    for (const [code, sig] of sx) {
      if (sy.get(code) !== sig) continue;
      assert.equal(competitorMarketingSpend([lead, x])[code], competitorMarketingSpend([lead, y])[code], `${code}: ${sig}`);
      compared++;
    }
    for (const code of Object.keys(competitorMarketingSpend([x]))) assert.ok(sx.has(code), `${code} gets spend but has no signature`);
  }
  assert.ok(compared > 1000, `only ${compared} comparisons`);
});
await test('competitorMarketingSpend is the one voiceSignatures was written against', () => {
  // If this fails, the engine's ad-spend rule changed: re-read voiceSignatures
  // in humanRivals.mjs (and the check above), then update the hash.
  const h = createHash('sha1').update(competitorMarketingSpend.toString()).digest('hex').slice(0, 16);
  assert.equal(h, '146f23a418d38949');
});
await test('an alliance change derives that airline\'s entry; a retired airline is forgotten', () => {
  need();
  let rows = roster();
  const memo = freshMemo();
  buildRivalViews(rows, new Map(), memo);
  const alliance = new Map([['a4', { membership: { allianceId: 'hw:1' }, def: { name: 'Sky Circle' } }]]);
  assert.equal(derivedBy(memo, () => buildRivalViews(rows, alliance, memo)).comps, 1);
  rows = rows.map((x) => (x.id === 'a3' ? { ...x, status: 'RETIRED', version: x.version + 1 } : x));
  buildRivalViews(rows, alliance, memo);
  assert.ok(!memo.comps.has('a3') && !memo.specs.has('a3'));
});

console.log('\n── what the fingerprint stands on ───────────────────────');

await test('scoring an airline reads nothing from the others but where they advertise', () => {
  need();
  const rows = roster();
  const views = buildRivalViews(rows, new Map());
  const read = new Set();
  const others = views.get('a1').competitors.map((c) => new Proxy(c, {
    get(t, k, r) { if (typeof k === 'string') read.add(k); return Reflect.get(t, k, r); },
    ownKeys(t) { read.add('<every key>'); return Reflect.ownKeys(t); },
  }));
  const spec = toRivalSpecs(rows[0], { competitors: others });
  assert.ok(Object.keys(spec).length > 0);
  const outside = [...read].filter((k) => !rivals.AD_VOICE_FIELDS.includes(k));
  assert.deepEqual(outside, [], `toRivalSpecs read ${outside.join(', ')} from another airline: add it to adVoiceDigest and AD_VOICE_FIELDS in humanRivals.mjs, or kept specs go stale`);
  assert.ok(read.has('routes') && read.has('homeHub'), 'the probe saw no reads at all');
});
await test('every state write in the server moves the version the fingerprint reads', () => {
  // The fingerprint takes `version` to stand for the state blob. A write of
  // `state` that left the version alone would leave rivals looking at the old
  // airline (and the client's world stamp, which sums versions, would not move).
  const dir = new URL('../apps/headwinds-server/src/', import.meta.url);
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const u = new URL(e.name + (e.isDirectory() ? '/' : ''), d); if (e.isDirectory()) walk(u); else if (e.name.endsWith('.mjs')) files.push(u); } };
  walk(dir);
  // The whole call, to its matching bracket.
  const callAt = (src, at) => { let depth = 0; for (let k = src.indexOf('(', at); k < src.length; k++) { if (src[k] === '(') depth++; else if (src[k] === ')' && --depth === 0) return src.slice(at, k + 1); } return src.slice(at); };
  const bad = []; let stateWrites = 0;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const name = f.pathname.split('/src/')[1];
    for (const m of src.matchAll(/airline\.update(?:Many)?\(/g)) {
      const call = callAt(src, m.index);
      if (!/\bdata:\s*\{[\s\S]*?(?:^|[\s{,])state\b\s*[:,}]/m.test(call)) continue;
      stateWrites++;
      if (/version:\s*\{\s*increment:\s*1\s*\}/.test(call)) continue;
      // A dead airline's blob is cut down in place (tombstone.mjs). It is not
      // ACTIVE, so no view is derived from it, and the guard below keeps it so.
      if (name === 'lib/tombstone.mjs' && /if \(row\.status === 'ACTIVE'\) return/.test(src)) continue;
      bad.push(`${name}: ${call.slice(0, 100).replace(/\s+/g, ' ')}`);
    }
  }
  assert.ok(stateWrites >= 5, `only ${stateWrites} state writes found: the search has stopped seeing them`);
  assert.equal(bad.length, 0, 'state written without a version increment:\n' + bad.join('\n'));
});

console.log('\n── when nothing is reused ───────────────────────────────');

await test('a change of world settings starts a new memo', () => {
  need();
  const a = rivals.rivalViewMemo('wKnobs', 'fare 1');
  assert.equal(rivals.rivalViewMemo('wKnobs', 'fare 1'), a);
  const b = rivals.rivalViewMemo('wKnobs', 'fare 1.2');
  assert.notEqual(b, a);
  assert.equal(b.comps.size, 0);
});
await test('the decision path reuses across row loads; the tick\'s own rows reuse nothing', async () => {
  need();
  rivals.clearRivalViewMemos();
  const rows = roster();
  let load = rows;
  const db = {
    airline: { findMany: async () => load },
    alliance: { findMany: async () => [] },
    world: { findUnique: async () => ({ id: 'wPath', tickConfig: {} }) },
    worldMarket: { findUnique: async () => null },
  };
  for (const r of rows) r.worldId = 'wPath';
  await buildWorldRivalViews(db, 'wPath', { stamp: '1.1', rowsMaxStaleMs: MAX, forAirlineId: 'a1' });
  const memo = rivals.peekRivalViewMemo('wPath');
  assert.ok(memo && memo.derived.comps >= 5, 'the decision path did not use the memo');
  // A minute later: a new load of the rows, one airline written since.
  load = rows.map((x) => (x.id === 'a2' ? write(x, 'UPDATE_TICKET_PRICE', { routeId: x.state.routes[0].id, ticketPrice: 99 }) : { ...x }));
  const realNow = Date.now; Date.now = () => realNow() + MAX + 1000;
  try {
    const d = { ...memo.derived };
    await buildWorldRivalViews(db, 'wPath', { stamp: '2.1', rowsMaxStaleMs: MAX, forAirlineId: 'a1' });
    assert.equal(rivals.peekRivalViewMemo('wPath'), memo, 'the memo was thrown away between loads');
    assert.deepEqual({ comps: memo.derived.comps - d.comps, specs: memo.derived.specs - d.specs }, { comps: 1, specs: 1 }, 'a new row load derived more than the airline that was written');
  } finally { Date.now = realNow; }
  // The tick hands in whole airlines: derived fresh, and the memo is not touched.
  const before = { ...memo.derived };
  await buildWorldRivalViews(db, 'wPath', { airlines: rows.map((r) => ({ ...r })), world: { id: 'wPath', tickConfig: {} } });
  assert.deepEqual(memo.derived, before);
  assert.match(fs.readFileSync(new URL('../apps/headwinds-server/src/lib/humanRivals.mjs', import.meta.url), 'utf8'), /priced\(airlines, allianceMap, \{ keep: false \}\)/);
});

console.log(`\nrival-view-incremental-test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
