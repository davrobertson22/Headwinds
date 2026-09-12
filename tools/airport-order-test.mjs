// Airport pickers put the player's own part of the world first.
//
//   "Would it be possible to chose which airports come up first? I am mostly
//    flying Asian routes but I have to go all the way down to select them."
//    (Barca, Discord 2026-09-10)
//
// The fixed REGIONS order listed Asia sixth of seven, so an Asian carrier
// scrolled past five continents to reach its own network in every airport
// dropdown in the game. These tests lock in the three things that changed:
// regions sort by where the airline actually is, the last few picks get their
// own group, and the compact search pickers open on your network instead of
// whatever eight airports happen to be first in the data file.
//
//   node tools/airport-order-test.mjs

import assert from 'node:assert/strict';
import { AIRPORTS, getRegion } from '../src/data/airports.js';
import {
  groupAirports, networkAirports, rankByNetwork,
  regionPresence, orderRegionsByPresence,
  RECENT_GROUP_LABEL, NETWORK_GROUP_LABEL,
} from '../src/utils/airportGroups.js';
import {
  recentAirports, rememberAirport, clearRecentAirports, RECENT_AIRPORT_LIMIT,
} from '../src/utils/airportRecents.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

const labels = (gs) => gs.map(g => g.label);
const codes  = (gs, label) => (gs.find(g => g.label === label)?.airports ?? []).map(a => a.code);
const regionLabelsOf = (gs) => labels(gs).filter(l => !gs.find(g => g.label === l).pinned);

// Barca's airline: a Singapore-hubbed Asian carrier with a token European and
// North American presence, which under the old fixed order put Asia LAST.
const ASIAN = {
  gates: { SIN: 10, NRT: 4, HKG: 3, BKK: 2, ICN: 2, LHR: 1, LAX: 1 },
  hubs:  { SIN: { tier: 3 } },
};

console.log('\nAirport picker ordering\n');

// ── 1. Regions sort by the player's own presence ─────────────────────────────

test('an Asian carrier gets Asia first, not sixth', () => {
  const g = groupAirports(ASIAN);
  assert.equal(regionLabelsOf(g)[0], 'Asia', `got: ${regionLabelsOf(g).join(' | ')}`);
});

test('a US carrier still gets North America first', () => {
  const g = groupAirports({ gates: { ORD: 9, JFK: 5, LAX: 4, LHR: 1 }, hubs: { ORD: { tier: 3 } } });
  assert.equal(regionLabelsOf(g)[0], 'North America');
});

test('gates held at a pinned hub still count towards its region', () => {
  // SIN is pinned out of the Asia group entirely, but ten gates there are the
  // single clearest statement of where this airline lives.
  const presence = regionPresence(ASIAN);
  assert.equal(presence.get('Asia').gates, 21);
  assert.equal(presence.get('Europe').gates, 1);
});

test('gate count outranks airport count', () => {
  // One 12-gate Asian hub beats four scattered one-gate European outstations.
  const presence = regionPresence({
    gates: { NRT: 12, LHR: 1, CDG: 1, FRA: 1, AMS: 1 }, hubs: {},
  });
  assert.deepEqual(orderRegionsByPresence(presence).slice(0, 2), ['Asia', 'Europe']);
});

test('an airline with no gates anywhere keeps the canonical order', () => {
  const g = groupAirports({ gates: {}, hubs: {}, requireGate: false });
  assert.deepEqual(regionLabelsOf(g).slice(0, 3), ['North America', 'South America', 'Europe']);
});

test('regions the player is absent from keep their relative order behind the rest', () => {
  const order = orderRegionsByPresence(regionPresence({ gates: { NRT: 5 }, hubs: {} }));
  assert.equal(order[0], 'Asia');
  assert.deepEqual(order.slice(1), ['North America', 'South America', 'Europe', 'Middle East', 'Africa', 'Oceania']);
});

// ── 2. Recently used ─────────────────────────────────────────────────────────

test('recent picks get their own group, above the regions', () => {
  const g = groupAirports({ ...ASIAN, recent: ['BKK', 'HKG'] });
  const i = labels(g).indexOf(RECENT_GROUP_LABEL);
  assert.ok(i >= 0, `no recent group: ${labels(g).join(' | ')}`);
  assert.ok(i < labels(g).indexOf('Asia'), 'recent group must sit above the regions');
  assert.deepEqual(codes(g, RECENT_GROUP_LABEL), ['BKK', 'HKG']);
});

test('the recent group is in recency order, not alphabetical', () => {
  const g = groupAirports({ ...ASIAN, recent: ['NRT', 'BKK', 'HKG'] });
  assert.deepEqual(codes(g, RECENT_GROUP_LABEL), ['NRT', 'BKK', 'HKG']);
});

test('a recent airport is not repeated in its region group', () => {
  const g = groupAirports({ ...ASIAN, recent: ['BKK'] });
  assert.ok(!codes(g, 'Asia').includes('BKK'));
  const all = g.flatMap(x => x.airports.map(a => a.code));
  assert.equal(all.length, new Set(all).size, 'an airport appeared twice');
});

test('a recent pick that is already a hub is not listed twice', () => {
  const g = groupAirports({ ...ASIAN, recent: ['SIN'] });
  assert.ok(!labels(g).includes(RECENT_GROUP_LABEL), 'SIN is already pinned as the hub');
});

test('recent airports outside the pool are ignored', () => {
  const g = groupAirports({ ...ASIAN, recent: ['CDG', 'BKK'] });  // no gate at CDG
  assert.deepEqual(codes(g, RECENT_GROUP_LABEL), ['BKK']);
});

test('exclude still wins over a recent pick', () => {
  const g = groupAirports({ ...ASIAN, recent: ['BKK'], exclude: 'BKK' });
  assert.ok(!g.flatMap(x => x.airports.map(a => a.code)).includes('BKK'));
});

// ── 3. "Your Airports" on a whole-world picker ───────────────────────────────

test('a world-wide picker pulls your gated airports out of the region list', () => {
  const g = groupAirports({ ...ASIAN, requireGate: false });
  assert.deepEqual(codes(g, NETWORK_GROUP_LABEL).sort(), ['BKK', 'HKG', 'ICN', 'LAX', 'LHR', 'NRT']);
  assert.ok(!codes(g, 'Asia').includes('NRT'));
  assert.ok(!codes(g, 'Europe').includes('LHR'));
});

test('a world-wide picker still offers every airport exactly once', () => {
  const g = groupAirports({ ...ASIAN, requireGate: false });
  const all = g.flatMap(x => x.airports.map(a => a.code));
  assert.equal(all.length, AIRPORTS.length);
  assert.equal(all.length, new Set(all).size);
});

test('a gate-only picker gets no "Your Airports" group — they all are', () => {
  const g = groupAirports(ASIAN);
  assert.ok(!labels(g).includes(NETWORK_GROUP_LABEL));
});

// ── 4. The compact search pickers (Route Finder / Cargo Route Finder) ────────

test('the finder opens on your network, not the first eight rows of the data', () => {
  const list = networkAirports({ ...ASIAN, limit: 8 }).map(x => x.airport.code);
  assert.equal(list[0], 'SIN', `got: ${list.join(', ')}`);
  for (const code of ['NRT', 'HKG', 'BKK', 'ICN']) {
    assert.ok(list.includes(code), `${code} missing from ${list.join(', ')}`);
  }
});

test('recent picks lead the finder list, ahead of the hub', () => {
  const list = networkAirports({ ...ASIAN, recent: ['BKK'], limit: 8 }).map(x => x.airport.code);
  assert.deepEqual(list.slice(0, 2), ['BKK', 'SIN']);
});

test('each finder row carries why it is there', () => {
  const rows = networkAirports({ ...ASIAN, recent: ['BKK'], limit: 4 });
  assert.equal(rows[0].why, 'recent');
  assert.equal(rows[1].why, 'hub');
  assert.equal(rows.find(r => r.airport.code === 'NRT').why, 'gates');
});

test('gate count orders the rest of the finder list', () => {
  const list = networkAirports({ ...ASIAN, limit: 8 }).map(x => x.airport.code);
  assert.deepEqual(list.slice(0, 4), ['SIN', 'NRT', 'HKG', 'BKK']);   // 10, 4, 3, 2
});

test('a brand new airline still gets a list rather than nothing', () => {
  const list = networkAirports({ gates: {}, hubs: {}, limit: 8 });
  assert.equal(list.length, 8);
  assert.ok(list.every(x => x.why === null));
});

test('the finder never offers the airport at the other end', () => {
  const list = networkAirports({ ...ASIAN, exclude: 'SIN', limit: 8 }).map(x => x.airport.code);
  assert.ok(!list.includes('SIN'));
  assert.equal(list[0], 'NRT');
});

test('search matches rank your own airports first', () => {
  const matches = AIRPORTS.filter(a => ['LHR', 'LGW', 'LTN', 'STN'].includes(a.code));
  const ranked = rankByNetwork(matches, ASIAN).map(a => a.code);
  assert.equal(ranked[0], 'LHR', `got: ${ranked.join(', ')}`);
});

test('ranking is stable for airports you have no relationship with', () => {
  const matches = AIRPORTS.filter(a => ['LGW', 'LTN', 'STN'].includes(a.code));
  assert.deepEqual(
    rankByNetwork(matches, ASIAN).map(a => a.code),
    matches.map(a => a.code),
  );
});

test('a recent pick outranks a hub in search results', () => {
  const matches = AIRPORTS.filter(a => ['SIN', 'NRT'].includes(a.code));
  const ranked = rankByNetwork(matches, { ...ASIAN, recent: ['NRT'] }).map(a => a.code);
  assert.deepEqual(ranked, ['NRT', 'SIN']);
});

// ── 5. The recents store itself ──────────────────────────────────────────────

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

test('a pick goes to the front and is not duplicated', () => {
  const s = fakeStorage();
  clearRecentAirports(s);
  rememberAirport('BKK', s);
  rememberAirport('HKG', s);
  rememberAirport('BKK', s);
  assert.deepEqual(recentAirports(s), ['BKK', 'HKG']);
});

test('the list is capped', () => {
  const s = fakeStorage();
  clearRecentAirports(s);
  for (const c of ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF', 'GGG', 'HHH']) rememberAirport(c, s);
  assert.equal(recentAirports(s).length, RECENT_AIRPORT_LIMIT);
  assert.equal(recentAirports(s)[0], 'HHH');
});

test('a placeholder <select> firing onChange with "" records nothing', () => {
  const s = fakeStorage();
  clearRecentAirports(s);
  rememberAirport('BKK', s);
  rememberAirport('', s);
  rememberAirport(null, s);
  assert.deepEqual(recentAirports(s), ['BKK']);
});

test('a storage that throws does not take the picker down with it', () => {
  const angry = {
    getItem() { throw new Error('private mode'); },
    setItem() { throw new Error('private mode'); },
    removeItem() { throw new Error('private mode'); },
  };
  clearRecentAirports(angry);
  assert.deepEqual(recentAirports(angry), []);
  rememberAirport('BKK', angry);
  assert.deepEqual(recentAirports(angry), ['BKK']);   // in-memory for this session
  clearRecentAirports(fakeStorage());
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
