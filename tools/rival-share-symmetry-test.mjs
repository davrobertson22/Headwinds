// Two players on the same city pair must see the same split of it.
//
// Player report (Discord, 2026-11-07, Betterthanu / read2much): two airlines on
// the same pair each saw themselves holding the larger share — 59% on one
// screen, 53% on the other, 112% of one market — and one counted "leading in 3,
// even on 2" while the other counted "1 lead and 4 evens" over the same routes.
//
// Cause: each airline's tick (and its Rivals preview) scores ITSELF through
// buildPlayerPairOffer / the tick's pair pre-pass, but scores every other human
// through the spec the server builds in toRivalSpecs — and that spec was a
// coarser stand-in:
//
//   quality      own: route quality (cabin, catering, Wi-Fi, hub, per segment)
//                rival: the airline's reputation score, clamped to 95
//   campaigns    own: targeted campaign boost      rival: none
//   connectivity own: scaled by the hubs' real spokes  rival: flat legacy bonus
//   price shield own: reputation/loyalty sensitivity cut  rival: none
//   ad drag      own: brand dragged by rivals' advertising  rival: never dragged
//
// So the same airline was two different products depending on whose screen it
// was on, and the two ticks booked passengers from two different fights.
//
// The invariant: an airline as a RIVAL scores exactly what it scores as itself,
// so the viewers' own shares of a two-carrier pair sum to 100%. The rivals go
// through the production path — projected rows (projectRivalState) into
// buildRivalViews, each airline's own state through withRivals.
//
//   node --import ./tools/_register-loader.mjs tools/rival-share-symmetry-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { freshState } from '../packages/engine/src/reducer.mjs';
import { defaultConfig, defaultClassPrices, weeklyTick } from '../packages/engine/src/utils/simulation.js';
import { defaultAncillaries } from '../packages/engine/src/data/ancillaries.js';
import { getAircraftType } from '../packages/engine/src/data/aircraft.js';
import { referencePrice } from '../packages/engine/src/utils/market.js';
import { pairMarketShare, buildPlayerPairOffer } from '../packages/engine/src/models/pairShare.js';
import { buildEncroachmentOffer } from '../packages/engine/src/models/encroachment.js';
import { buildRivalViews, withRivals, projectRivalState } from '../apps/headwinds-server/src/lib/humanRivals.mjs';

// The battle card is SSR-rendered below; stub the browser globals the client
// modules touch at import time.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
  key: (i) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};
globalThis.window ??= {
  localStorage: globalThis.localStorage,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
};
if (!globalThis.window.localStorage) globalThis.window.localStorage = globalThis.localStorage;
const { RemoteGameProvider, hydrateState } = await import('../src/store/GameContext.jsx');
const { buildPlayerPairMap, ContestedRouteRow, headToHead } = await import('../src/components/Competition.jsx');
const { weekToGameDate } = await import('../packages/engine/src/utils/simulation.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

console.log('\nTwo players see the same split of a shared pair\n');

const TYPE = getAircraftType('b777300er');
assert.ok(TYPE, 'fixture aircraft type resolves');
const O = 'JFK', D = 'LHR', KEY = [O, D].sort().join('-');
const REF = Math.round(referencePrice(O, D));

function airlineState(name, { hubs, rep, awareness, campaign = {}, wifi = false, catering = null, fareMult = 1, freq = 28 }) {
  const base = freshState();
  const fleet = Array.from({ length: 2 }, (_, i) => ({
    id: `${name}${i}`, typeId: TYPE.id, status: 'assigned', ageWeeks: 30 + i * 40,
    config: defaultConfig(TYPE.seats), ownershipType: 'owned', hasWifi: wifi && i === 0,
  }));
  const hubCodes = Object.keys(hubs);
  return {
    ...base, phase: 'playing', week: 40, year: 1,
    hub: hubCodes[0] ?? null, hubs,
    airlineName: name, fleet, cargoRoutes: [], competitors: [],
    routes: fleet.map((a, i) => ({
      // Stamped with the hub the airline had when it opened the route, as
      // ADD_ROUTE does — the tick credits connecting feed through THAT hub.
      id: `r${name}${i}`, origin: O, destination: D, aircraftId: a.id, hub: hubCodes[0] ?? null,
      weeklyFrequency: freq / 2, weeksOpen: 60,
      ...(catering ? { cateringLevel: catering } : {}),
    })),
    routePricing: { [KEY]: defaultClassPrices(Math.round(REF * fareMult)) },
    ancillaries: defaultAncillaries(),
    awareness, lastReport: { reputationScore: rep },
    campaignStrength: campaign, targetedMarketing: campaign,
  };
}

// Production shape: the rival path only ever sees the PROJECTED blob.
const row = (id, state) => ({ id, name: state.airlineName, hub: state.hub, status: 'ACTIVE',
  restarts: 0, state: projectRivalState(state), account: {} });

function world(A, B) {
  const views = buildRivalViews([row('A', A), row('B', B)]);
  // What each client holds: its own save with the rival overlay, hydrated
  // (routes carry their pair's fares) exactly as GameContext serves it.
  return { a: hydrateState(withRivals(A, views.get('A'))), b: hydrateState(withRivals(B, views.get('B'))) };
}

const SCORE_FIELDS = ['qualityScore', 'qualityScoreLeisure', 'qualityScoreBusiness',
  'connectivityBonus', 'priceSensitivityReduction', 'marketingBoost', 'brandReach'];

function compareOffers(self, asRival, who) {
  for (const f of SCORE_FIELDS) {
    const s = self[f] ?? (f.startsWith('qualityScore') ? self.qualityScore : 0);
    const r = asRival[f] ?? (f.startsWith('qualityScore') ? asRival.qualityScore : (f === 'brandReach' ? 1 : 0));
    assert.ok(Math.abs(s - r) < 1e-6,
      `${who}.${f}: ${s} on its own screen, ${r} on its rival's`);
  }
}

// Deliberately lopsided airlines, so every term above differs between them.
const A0 = airlineState('A', { hubs: { JFK: { tier: 2 } }, rep: 62, awareness: 70,
  campaign: { JFK: 60 }, wifi: true, catering: 'premium', fareMult: 1.35, freq: 84 });
// B's primary hub is CDG; LHR is a secondary hub, so the pair touches a hub the
// routes were not opened under (the tick pays no connecting feed for it).
const B0 = airlineState('B', { hubs: { CDG: { tier: 2 }, LHR: { tier: 1 } }, rep: 88, awareness: 45,
  fareMult: 1.45, freq: 70 });

test('the fixture is contested from both sides', () => {
  const { a, b } = world(A0, B0);
  assert.equal(a.humanRivals?.[KEY]?.length, 1, 'A must see B on the pair');
  assert.equal(b.humanRivals?.[KEY]?.length, 1, 'B must see A on the pair');
});

test('each airline scores the same as a rival as it does as itself', () => {
  const { a, b } = world(A0, B0);
  const aSelf = buildPlayerPairOffer(a, a.routes);
  const bSelf = buildPlayerPairOffer(b, b.routes);
  const mkt = pairMarketShare(a, O, D).market;
  const aAsRival = buildEncroachmentOffer(b.humanRivals[KEY][0], mkt);
  const bAsRival = buildEncroachmentOffer(a.humanRivals[KEY][0], mkt);
  compareOffers(aSelf, aAsRival, 'A');
  compareOffers(bSelf, bAsRival, 'B');
});

// Seats to spare on both sides, or the split is just the seat ratio and the
// demand model never gets a say — that would pass whatever the offers said.
function assertNotCapacityBound(share, who) {
  share.results.forEach((r, i) => {
    const seats = share.offers[i].totalSeats * 2;
    assert.ok((r.totalPax ?? 0) < seats * 0.97,
      `${who}: offer ${i} is full (${r.totalPax} of ${seats} seats) — the fixture needs spare capacity`);
  });
}

test("the two players' own shares of the pair sum to 100%", () => {
  const { a, b } = world(A0, B0);
  const pa = pairMarketShare(a, O, D), pb = pairMarketShare(b, O, D);
  assertNotCapacityBound(pa, "A's screen");
  assertNotCapacityBound(pb, "B's screen");
  const sa = pa.playerShare, sb = pb.playerShare;
  assert.ok(Math.abs(sa + sb - 1) < 0.001,
    `A sees itself at ${(sa * 100).toFixed(1)}%, B sees itself at ${(sb * 100).toFixed(1)}% `
    + `— ${((sa + sb) * 100).toFixed(1)}% of one market`);
});

test('mirror-image airlines running the same campaign see an even split', () => {
  const mk = (n, hub) => airlineState(n, { hubs: { [hub]: { tier: 2 } }, rep: 60, awareness: 60,
    campaign: { JFK: 50 }, freq: 56 });
  const { a, b } = world(mk('A', 'JFK'), mk('B', 'LHR'));
  const pa = pairMarketShare(a, O, D), pb = pairMarketShare(b, O, D);
  assertNotCapacityBound(pa, "A's screen");
  const sa = pa.playerShare, sb = pb.playerShare;
  assert.ok(Math.abs(sa - 0.5) < 0.001 && Math.abs(sb - 0.5) < 0.001,
    `identical airlines: A sees ${(sa * 100).toFixed(1)}%, B sees ${(sb * 100).toFixed(1)}%`);
});

// The share the screens show is the share the ticks book: each airline's own
// tick carries what the OTHER player's screen says it carries.
test("each airline's tick books what its rival's screen says it books", () => {
  const { a, b } = world(A0, B0);
  const pax = (st) => weeklyTick(st).routeResults
    .filter((r) => st.routes.some((x) => x.id === r.routeId))
    .reduce((s, r) => s + (r.passengers ?? 0), 0);
  const aTick = pax(a), bTick = pax(b);
  const onB = pairMarketShare(b, O, D), onA = pairMarketShare(a, O, D);
  const aOnB = onB.results[1]?.totalPax, bOnA = onA.results[1]?.totalPax;
  assert.ok(aTick > 0 && bTick > 0, 'both ticks must carry passengers');
  assert.ok(Math.abs(aTick - aOnB) <= 2, `A's tick booked ${aTick}; B's screen says ${aOnB}`);
  assert.ok(Math.abs(bTick - bOnA) <= 2, `B's tick booked ${bTick}; A's screen says ${bOnA}`);
});

// ── What the screens print ───────────────────────────────────────────────────

const pairOf = (st) => buildPlayerPairMap(st.routes, st.fleet, weekToGameDate(st.week).monthIndex)[KEY];
const rivalIn = (st) => st.competitors.find((c) => c.routes?.[KEY]);

test("the head-to-head card is a mirror image on the two players' screens", () => {
  const { a, b } = world(A0, B0);
  const onA = headToHead(a, rivalIn(a), KEY, pairOf(a), a.fleet);
  const onB = headToHead(b, rivalIn(b), KEY, pairOf(b), b.fleet);
  for (const lever of ['Fare', 'Qual', 'Freq', 'SeatsWk']) {
    assert.equal(onA[`your${lever}`], onB[`their${lever}`], `${lever}: A shows itself ${onA[`your${lever}`]}, B shows A ${onB[`their${lever}`]}`);
    assert.equal(onA[`their${lever}`], onB[`your${lever}`], `${lever}: B shows itself ${onB[`your${lever}`]}, A shows B ${onA[`their${lever}`]}`);
  }
  const flip = { you: 'them', them: 'you', even: 'even' };
  assert.equal(onB.verdict, flip[onA.verdict],
    `A's card says "${onA.verdict}", B's says "${onB.verdict}" — one of them has to be leading`);
});

// Rendered under RemoteGameProvider — the multiplayer client's provider, which
// serves the server's state (rival overlay included) rather than a solo save.
function battleCard(st) {
  return renderToString(React.createElement(RemoteGameProvider, { state: st, dispatch: () => {} },
    React.createElement(ContestedRouteRow, {
      routeKey: KEY, playerRoute: pairOf(st), competitors: [rivalIn(st)], fleet: st.fleet,
    }))).replace(/<!-- -->/g, '');
}

test("the battle card shows the rival's own quality and share, not blanks or reputation", () => {
  const { a, b } = world(A0, B0);
  const html = battleCard(a);
  const at = html.indexOf('Quality score');
  assert.ok(at >= 0, 'battle card renders a Quality score row');
  const q = [...html.slice(at).matchAll(/font-weight:700[^>]*>(\d+)<\/span>/g)].slice(0, 2).map((m) => Number(m[1]));
  const bOwn = buildPlayerPairOffer(b, b.routes).qualityScore;
  assert.equal(q[1], bOwn, `A's card shows B at quality ${q[1]}; B's own screen says ${bOwn}`);
  const rivalShare = html.match(/data-share="(\d+)" data-carrier="rival"/);
  assert.ok(rivalShare, "the rival's projected-share cell is blank");
  const bOnOwn = Math.round(pairMarketShare(b, O, D).playerShare * 100);
  assert.ok(Math.abs(Number(rivalShare[1]) - bOnOwn) <= 1,
    `A's card shows B at ${rivalShare[1]}%; B's own screen says ${bOnOwn}%`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
