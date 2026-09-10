// ─────────────────────────────────────────────────────────────────────────────
// ONE ROUTE, THREE QUOTES.
//
// Before a player opens a route the game quotes it twice — in the Route Finder's
// list and on the Route Planner's economics card — and then the weekly tick
// books it. Those are three code paths over the same maths, and every one of the
// preview↔tick bugs of the last two months was one of them quietly drifting from
// another: the map handing out the whole demand pool, the finder omitting the
// connecting revenue the tick credits, Unit Economics re-simulating a monopoly
// that did not exist, the fixed June gameDate, the missing brandReach.
//
// Each of those has its own suite now, written AFTER a player found it. This one
// is the systematic version: it builds one world through the real reducer, picks
// a route, and asks all three surfaces the same question —
//
//     finder   scoreCandidates()             → the row the Route Finder lists
//     planner  <RoutePlanner/> server-rendered → the card the player commits from
//     tick     ADVANCE_WEEK through gameReducer → what the airline actually banks
//
// — and prints the three answers side by side before asserting they agree, so a
// failure reads as a reconciliation, not a stack trace. The tick runs with every
// probability gate pinned shut and the probe route pre-aged to maturity, because
// both previews quote the MATURE week and the tick's maturity ramp is a property
// the previews describe on purpose (the planner shows the launch load factor
// beside it).
//
// Scenarios are chosen to exercise the inputs that have drifted before:
//   · a fresh spoke off a hub with feed        (connecting revenue)
//   · a second tail on a pair already flown    (lane pooling)
//   · a pair a human rival contests            (rival channel)
//   · a restricted (NWR) world                 (load ceiling)
//   · a world in its fourth year               (demand growth / absWeek)
//   · a leased frame at a signed rate          (which lease each screen charges)
//   · a point-to-point pair off the hub        (no feed at all)
//
// Compared per scenario, at the tolerance the display can actually show:
//   O&D passengers, load factor, O&D revenue, connecting revenue, and
//   route operating profit (after landing fees, before the aircraft lease) —
//   the number every screen calls "profit" once its own lease line is added back.
//
//   node --import ./tools/_register-loader.mjs tools/route-quote-reconciliation-test.mjs
// ─────────────────────────────────────────────────────────────────────────────
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import { getAircraftType } from '../packages/engine/src/data/aircraft.js';
import { getAirport } from '../packages/engine/src/data/airports.js';
import {
  defaultClassPrices, maxFrequency, routeDistanceKm, formatMoney,
} from '../packages/engine/src/utils/simulation.js';
import { referencePrice, NWR_LF_JITTER } from '../packages/engine/src/utils/market.js';
import { findCandidates, scoreCandidates } from '../packages/engine/src/models/routeFinder.js';
import { projectRouteAddition } from '../packages/engine/src/models/pairShare.js';

// ── SSR shims ────────────────────────────────────────────────────────────────
const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 6).join('\n      ')}`); failed++; }
}

// ── Determinism ──────────────────────────────────────────────────────────────
const realRandom = Math.random;
function seedRandom(seed) {
  let x = seed >>> 0;
  Math.random = () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };
}
/** Every `Math.random() < p` gate in ADVANCE_WEEK held shut: no events, no failures, no AI moves. */
function withNoRolls(fn) {
  const prev = Math.random;
  Math.random = () => 0.9999999;
  try { return fn(); } finally { Math.random = prev; }
}

// ── The world ────────────────────────────────────────────────────────────────
const HUB   = 'JFK';
const TYPE  = 'b737800';
const SPOKES = ['ORD', 'BOS', 'ATL', 'MIA', 'DFW', 'DTW'];
const PROBE_AIRPORTS = ['DEN', 'BTV', 'PWM']; // gated in advance so ADD_ROUTE never refuses a probe
const MATURE_WEEKS = 40;               // > the 16-week ramp: what both previews call "mature"

/**
 * A JFK carrier built through the reducer: hub tier 2, six 737 spokes, an aged
 * (i.e. established) fleet, awareness a real airline would have. Multiplayer
 * fields set the way the server injects them so the rival channel is the human
 * one. Tails are young so the planner's zero-age synthetic frame and the tick's
 * real airframe describe the same aeroplane.
 */
function world({ seed = 4242, year = 1, week = 20, restricted = false, incumbent = null } = {}) {
  seedRandom(seed);
  let s = gameReducer(freshState(),
    { type: 'START_GAME', airlineName: 'Reconcile Air', hub: HUB, enableObjectives: false });
  s = { ...s, cash: 5e9, multiplayer: true, competitors: [], humanRivals: {}, encroachments: {},
        ...(restricted ? { newWorldRestrictions: true } : {}) };
  for (let i = 0; i < 12; i++) s = gameReducer(s, { type: 'ADD_GATE', airportCode: HUB });
  for (const d of SPOKES) {
    s = gameReducer(s, { type: 'BUY_AIRCRAFT', typeId: TYPE });
    const ac = s.fleet[s.fleet.length - 1].id;
    s = gameReducer(s, { type: 'ADD_GATE', airportCode: d });
    s = gameReducer(s, { type: 'ADD_ROUTE', aircraftId: ac, origin: HUB, destination: d,
                         weeklyFrequency: 10, ticketPrice: Math.round(referencePrice(HUB, d)) });
    assert.ok(s.routes.some(r => r.destination === d), `fixture: ${HUB}-${d} did not open (${s.error ?? 'no error'})`);
  }
  for (const code of PROBE_AIRPORTS) {
    for (let i = 0; i < 4; i++) s = gameReducer(s, { type: 'ADD_GATE', airportCode: code });
  }
  // Optionally a tail already flying the probe pair, so the probe is an ADDED tail.
  if (incumbent) {
    s = gameReducer(s, { type: 'BUY_AIRCRAFT', typeId: TYPE });
    const ac = s.fleet[s.fleet.length - 1].id;
    s = gameReducer(s, { type: 'ADD_ROUTE', aircraftId: ac, origin: incumbent.origin, destination: incumbent.dest,
                         weeklyFrequency: incumbent.freq, ticketPrice: Math.round(referencePrice(incumbent.origin, incumbent.dest)) });
    assert.ok(s.routes.some(r => r.destination === incumbent.dest && r.aircraftId === ac),
      `fixture: incumbent ${incumbent.origin}-${incumbent.dest} did not open (${s.error ?? 'no error'})`);
  }
  // One spare, owned, to fly the probe route.
  s = gameReducer(s, { type: 'BUY_AIRCRAFT', typeId: TYPE });
  const spare = s.fleet[s.fleet.length - 1];
  Math.random = realRandom;
  return {
    state: {
      ...s, year, week, awareness: 70,
      hubs: { ...(s.hubs ?? {}), [HUB]: { tier: 2, tierSince: 0 } },
      fleet: s.fleet.map(a => ({ ...a, ageWeeks: 52, ownershipType: 'owned', status: a.id === spare.id ? 'idle' : a.status })),
      routes: s.routes.map(r => ({ ...r, weeksOpen: MATURE_WEEKS })),
    },
    spare,
  };
}

// ── Quote 1: the Route Finder row ────────────────────────────────────────────
function finderQuote(state, { origin, dest, frame, freq }) {
  const gameDate = uiGameDate(state);
  const rows = findCandidates(state, {
    origin, aircraftTypeId: frame.typeId, aircraft: frame, weeklyFrequency: freq,
    hideServedLanes: false, hideUnflyable: false, groupMetros: false,
  });
  const scored = scoreCandidates(state, rows, {
    aircraftTypeId: frame.typeId, aircraft: frame, weeklyFrequency: freq, gameDate,
    order: 'asGiven', limit: rows.length,
  });
  const row = scored.find(r => r.code === dest);
  assert.ok(row, `finder listed no ${origin}-${dest} row`);
  assert.ok(row.scored && row.projection, `finder did not forecast ${origin}-${dest}: ${row.block ?? 'unscored'}`);
  const p = row.projection;
  const lease = frame.ownershipType === 'owned' ? 0 : (frame.weeklyLease ?? getAircraftType(frame.typeId).weeklyLease);
  return {
    freq: p.weeklyFrequency,
    pax: p.passengers, lf: p.loadFactor, odRevenue: p.revenue,
    connecting: p.connectingRevenue,
    opProfit: p.netProfit + lease,          // the finder nets its lease; add it back
    leaseCharged: lease, opCost: null, landingFee: null,
  };
}
/** The {week, month} object both screens build for themselves (RouteFinder.jsx:50, RoutePlanner.jsx:455). */
function uiGameDate(state) {
  return { week: state.week, month: weekToMonthIndex(state.week) };
}
function weekToMonthIndex(week) {
  // Mirrors weekToGameDate(week).monthIndex without importing a UI helper the
  // engine also exports — 52 weeks over 12 months.
  return Math.min(12, Math.floor(((week - 1) % 52) / (52 / 12)) + 1);
}

// ── Quote 2: the Route Planner card, server-rendered ─────────────────────────
// The PRODUCTION provider: Headwinds hands the planner the server's state as
// is. GameProvider (the solo/local-save path) runs reconcileState on load, which
// seeds 25 AI airlines into any save whose `competitors` is empty — a world the
// server never simulates, and 9% off the tick's connecting figure here.
const { RemoteGameProvider } = await import('../src/store/GameContext.jsx');
const RoutePlanner    = (await import('../src/components/RoutePlanner.jsx')).default;

const RCD = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher;
assert.ok(RCD, 'React 18 hook dispatcher not reachable — this harness needs updating');
let hookSeed = null, lastSeed = null;
let rawDispatcher = RCD.current, liveDispatcher = null;
function wrapDispatcher(d) {
  if (!d) return d;
  const w = Object.create(Object.getPrototypeOf(d));
  Object.assign(w, d);
  w.useState = function (initial) {
    if (hookSeed) {
      const i = hookSeed.i++;
      if (i < hookSeed.slots.length) {
        hookSeed.seen[i] = typeof initial === 'function' ? initial() : initial;
        const slot = hookSeed.slots[i];
        if (slot) return d.useState(slot.value);
      }
      if (hookSeed.i >= hookSeed.slots.length) hookSeed = null;
    }
    return d.useState(initial);
  };
  return w;
}
Object.defineProperty(RCD, 'current', {
  configurable: true,
  get() { return liveDispatcher; },
  set(v) { rawDispatcher = v; liveDispatcher = wrapDispatcher(v); },
});
RCD.current = rawDispatcher;
function Seed({ slots, children }) { hookSeed = { i: 0, slots, seen: [] }; lastSeed = hookSeed; return children; }
const SLOT_NAMES = ['mode', 'origin', 'dest', 'selectedTypeId', 'frequency'];
const EXPECTED_INITIALS = ['passenger', '', '', '', 7];

function renderPlanner(state, { origin, dest, typeId, frequency }) {
  const slots = [null, { value: origin }, { value: dest }, { value: typeId }, { value: frequency }];
  return renderToString(
    React.createElement(RemoteGameProvider, { state, dispatch: () => {} },
      React.createElement(Seed, { slots },
        React.createElement(RoutePlanner)))).replace(/<!-- -->/g, '');
}
/** The value cell under an economics-grid label, as text. */
function cellText(html, label) {
  const re = new RegExp(`>${label.replace(/[/+&]/g, m => m === '&' ? '&amp;' : m)}</div><div[^>]*>([^<]*)</div>`);
  const m = html.match(re);
  return m ? m[1].trim() : null;
}
/** "$1.23M" / "$456.7K" / "$89" / "+$…" / "-$…" → number, and the half-unit the display rounds to. */
function money(text) {
  if (text == null) return null;
  const m = text.replace(/,/g, '').match(/^([+-]?)\$([\d.]+)([BMK]?)$/);
  assert.ok(m, `unparseable money "${text}"`);
  const unit = { B: 1e9, M: 1e6, K: 1e3, '': 1 }[m[3]];
  const decimals = (m[2].split('.')[1] ?? '').length;
  const v = Number(m[2]) * unit * (m[1] === '-' ? -1 : 1);
  return { v, half: 0.5 * unit / Math.pow(10, decimals) };
}
function plannerQuote(state, { origin, dest, frame, freq }) {
  const html = renderPlanner(state, { origin, dest, typeId: frame.typeId, frequency: freq });
  assert.ok(lastSeed, 'seed wrapper never ran');
  assert.deepEqual(lastSeed.seen.slice(0, SLOT_NAMES.length), EXPECTED_INITIALS,
    `RoutePlanner's leading useState block changed — expected [${SLOT_NAMES}] to start as ` +
    `${JSON.stringify(EXPECTED_INITIALS)} but saw ${JSON.stringify(lastSeed.seen.slice(0, 5))}`);
  assert.ok(cellText(html, 'Net Profit / wk'), 'planner rendered no economics card — is the route reachable/selected?');
  const pax  = Number(cellText(html, 'O&D Passengers').replace(/,/g, ''));
  const lf   = Number((cellText(html, 'Load Factor') ?? '').match(/([\d.]+)%\s*$/)?.[1]) / 100;
  const od   = money(cellText(html, 'O&D Revenue'));
  const conn = money(cellText(html, 'Connecting Rev'));
  const lease = money(cellText(html, 'Lease / wk'));
  const net  = money(cellText(html, 'Net Profit / wk'));
  const opc  = money(cellText(html, 'Op Cost / wk'));
  // The Op Cost cell's sub-line names the landing fees it includes.
  const feeM = html.match(/incl\. ([+-]?\$[\d.,]+[BMK]?) landing fees/);
  return {
    pax, lf, odRevenue: od.v, connecting: conn.v,
    opProfit: net.v + lease.v, leaseCharged: lease.v, opCost: opc.v, landingFee: feeM ? money(feeM[1]).v : 0,
    // display rounding: the widest half-unit among the cells that make up each figure
    tol: { odRevenue: od.half, connecting: conn.half, opProfit: net.half + lease.half, lf: 0.0005 },
  };
}

// ── Quote 3: the tick ────────────────────────────────────────────────────────
function tickQuote(state, { origin, dest, frame, freq }) {
  const fare = Math.round(referencePrice(origin, dest));
  let s = gameReducer(state, { type: 'ADD_ROUTE', aircraftId: frame.id, origin, destination: dest,
                               weeklyFrequency: freq, ticketPrice: fare, classPrices: defaultClassPrices(fare) });
  const probe = s.routes.find(r => r.aircraftId === frame.id && r.destination === dest);
  assert.ok(probe, `ADD_ROUTE refused ${origin}-${dest}: ${s.error ?? 'no error'}`);
  // Both previews quote the mature week; give the tick the same week.
  s = { ...s, routes: s.routes.map(r => r.id === probe.id ? { ...r, weeksOpen: MATURE_WEEKS } : r) };
  const next = withNoRolls(() => gameReducer(s, { type: 'ADVANCE_WEEK' }));
  const rr = next.lastReport?.routeResults?.find(r => r.routeId === probe.id);
  assert.ok(rr, 'tick produced no result for the probe route');
  const connecting = rr.connecting?.totalRevenue ?? 0;
  return {
    freq: probe.weeklyFrequency,
    pax: rr.passengers, lf: rr.loadFactor,
    odRevenue: rr.revenue - connecting,
    connecting,
    opProfit: rr.profit,                     // routeRevenue − opCost − landing fee
    leaseCharged: rr.weeklyLeaseCost ?? 0,
    opCost: rr.totalOpCost, landingFee: rr.landingFee,
  };
}

// ── Reconcile ────────────────────────────────────────────────────────────────
const pct = (a, b) => (b === 0 ? (a === 0 ? 0 : Infinity) : Math.abs(a - b) / Math.abs(b));
const fmt$ = v => (v < 0 ? '-' : '') + '$' + Math.abs(Math.round(v)).toLocaleString();
const fmtLF = v => (v * 100).toFixed(1) + '%';

function table(f, p, t) {
  const row = (label, a, b, c) => `      ${label.padEnd(14)} ${String(a).padStart(14)} ${String(b).padStart(14)} ${String(c).padStart(14)}`;
  return [
    row('', 'finder', 'planner', 'tick'),
    row('O&D pax', f.pax, p.pax, t.pax),
    row('load factor', fmtLF(f.lf), fmtLF(p.lf), fmtLF(t.lf)),
    row('O&D revenue', fmt$(f.odRevenue), fmt$(p.odRevenue), fmt$(t.odRevenue)),
    row('connecting', fmt$(f.connecting), fmt$(p.connecting), fmt$(t.connecting)),
    row('op cost+fees', '·', fmt$(p.opCost), fmt$(t.opCost + t.landingFee)),
    row('  landing fee', '·', fmt$(p.landingFee ?? NaN), fmt$(t.landingFee)),
    row('op profit', fmt$(f.opProfit), fmt$(p.opProfit), fmt$(t.opProfit)),
    row('lease line', fmt$(f.leaseCharged), fmt$(p.leaseCharged), fmt$(t.leaseCharged)),
  ].join('\n');
}

/**
 * Engine-level tolerance is tight — the finder is pure maths and should match
 * the tick to rounding. The planner is read back off the rendered card, so its
 * tolerance is whatever formatMoney rounded away, plus the same 1%.
 */
const ENGINE_PCT = 0.01;
/**
 * The lowest frequency at which the probe is NOT capacity-capped. JFK's pool is
 * deep enough that one 737 fills to 100% on every domestic pair at 7/wk, and a
 * capped route cannot show a demand-side disagreement (rivals, growth, the NWR
 * ceiling all move the pool without moving a carried passenger).
 */
function uncappedFreq(state, { origin, dest, frame }, maxLF = 0.9) {
  for (const freq of [7, 14, 21, 28, 35, 42]) {
    const fare = Math.round(referencePrice(origin, dest));
    const p = projectRouteAddition(state, { origin, destination: dest, aircraft: frame, weeklyFrequency: freq,
                                            ticketPrice: fare, classPrices: defaultClassPrices(fare) });
    if (p?.mature && p.mature.loadFactor <= maxLF) return freq;
  }
  assert.fail(`no frequency ≤42/wk leaves ${origin}-${dest} below ${maxLF * 100}% load — pick a thinner probe`);
}

function reconcile(name, state, spec) {
  if (spec.freq === 'uncapped') spec = { ...spec, freq: uncappedFreq(state, spec) };
  // Restricted worlds: the tick rolls a deterministic ±NWR_LF_JITTER wobble on
  // the load ceiling, keyed on pair + week; the previews quote the EXPECTED week
  // (jitter = 1) on purpose (pairShare.js, nwrFields). Demand-side agreement is
  // therefore "within the wobble"; the cost side stays exact.
  const demandPct = state.newWorldRestrictions ? ENGINE_PCT + NWR_LF_JITTER : ENGINE_PCT;
  const f = finderQuote(state, spec);
  const p = plannerQuote(state, spec);
  const t = tickQuote(state, spec);
  console.log(`\n  ${name}  (${spec.origin}-${spec.dest}, ${spec.frame.typeId} ×${spec.freq}/wk)\n${table(f, p, t)}`);
  assert.equal(f.freq, t.freq, 'finder clamped the frequency — pick a shorter probe');

  const checks = [];
  // `scale` is what a percentage is OF. Profit is a thin residual of revenue, so
  // a profit error is judged against revenue: on a $550k route clearing $90k,
  // a 0.7% revenue miss is a 4% profit miss and means the same thing.
  const push = (who, field, got, want, tolAbs, tolPct = ENGINE_PCT, scale = Math.abs(want)) => {
    const off = Math.abs(got - want);
    const ok  = off <= Math.max(tolAbs, scale * tolPct);
    if (!ok) checks.push(`${who}.${field} ${typeof got === 'number' && Math.abs(want) > 5 ? fmt$(got) + ' vs tick ' + fmt$(want) : got + ' vs tick ' + want}`
      + ` (off ${(pct(got, want) * 100).toFixed(1)}%${scale !== Math.abs(want) ? ', ' + (off / scale * 100).toFixed(2) + '% of revenue' : ''})`);
  };
  const rev = t.odRevenue + t.connecting;
  push('finder',  'pax',        f.pax,        t.pax,        1,   demandPct);
  push('finder',  'loadFactor', f.lf,         t.lf,         0.0005, demandPct);
  push('finder',  'odRevenue',  f.odRevenue,  t.odRevenue,  50,  demandPct);
  push('finder',  'connecting', f.connecting, t.connecting, 100, demandPct);
  push('finder',  'opProfit',   f.opProfit,   t.opProfit,   100, demandPct, rev);
  push('planner', 'pax',        p.pax,        t.pax,        1,   demandPct);
  push('planner', 'loadFactor', p.lf,         t.lf,         p.tol.lf + 0.0005, demandPct);
  push('planner', 'odRevenue',  p.odRevenue,  t.odRevenue,  p.tol.odRevenue + 50,  demandPct);
  push('planner', 'connecting', p.connecting, t.connecting, p.tol.connecting + 100, demandPct);
  push('planner', 'opProfit',   p.opProfit,   t.opProfit,   p.tol.opProfit + 100,   demandPct, rev);
  push('planner', 'landingFee', p.landingFee, t.landingFee, 100, 0.005);
  // The lease each screen nets is the one the tick will charge the tail the
  // Open Route button assigns: nothing for an owned tail, the signed rate for a
  // leased one. (The planner's cell reads it off the rendered card.)
  push('finder',  'lease',      f.leaseCharged, t.leaseCharged, 1, 0);
  push('planner', 'lease',      p.leaseCharged, t.leaseCharged, p.tol.opProfit, 0.005);
  return { f, p, t, checks };
}

console.log('\nRoute quote reconciliation — Route Finder ↔ Route Planner ↔ weekly tick');

const PROBE = 'BTV';   // the one JFK pair a 737 can outrun at ≤42/wk
const fail = (checks) => assert.equal(checks.length, 0, '\n      ' + checks.join('\n      '));

// 1. A capacity-capped spoke: the everyday JFK case. Demand is not in play, so
//    this isolates the cost side — landing fees, connecting seats, lease lines.
test('capacity-capped spoke off a fed hub: three quotes agree', () => {
  const { state, spare } = world();
  fail(reconcile('capped hub spoke', state, { origin: HUB, dest: 'DEN', frame: spare, freq: 7 }).checks);
});

// 2. The same hub, on a pair thin enough that demand decides the load factor.
test('demand-limited spoke off a fed hub: three quotes agree', () => {
  const { state, spare } = world();
  fail(reconcile('uncapped hub spoke', state, { origin: HUB, dest: PROBE, frame: spare, freq: 'uncapped' }).checks);
});

// 3. A second tail on a pair the airline already flies: the previews must pool
//    with the incumbent tail, not preview a fresh market.
test('second tail on a pair already flown: three quotes agree', () => {
  const { state, spare } = world({ incumbent: { origin: HUB, dest: PROBE, freq: 21 } });
  const r = reconcile('added tail', state, { origin: HUB, dest: PROBE, frame: spare, freq: 21 });
  assert.ok(r.t.lf < 0.9, `fixture: the pair is still capped at ${fmtLF(r.t.lf)} — pooling is invisible`);
  fail(r.checks);
});

// 4. A human rival on the pair, in the shape the server injects.
test('pair contested by a human rival: three quotes agree', () => {
  const { state: base, spare } = world();
  const freq = uncappedFreq(base, { origin: HUB, dest: PROBE, frame: spare });
  const state = {
    ...base,
    humanRivals: {
      [[HUB, PROBE].sort().join('-')]: [{
        competitorId: 'human:otter', name: 'Otter Air', tier: 'legacy', qualityScore: 62,
        homeHub: PROBE, frequency: 21, seatsPerFlight: 160, priceMultiplier: 1,
        economyFare: Math.round(referencePrice(HUB, PROBE) * 0.95), businessSeatsPerWeek: 0, businessFare: null,
      }],
    },
  };
  const r    = reconcile('human rival', state, { origin: HUB, dest: PROBE, frame: spare, freq });
  const solo = tickQuote(base, { origin: HUB, dest: PROBE, frame: spare, freq });
  assert.ok(r.t.pax < solo.pax, `fixture: the rival did not bite (${r.t.pax} pax contested vs ${solo.pax} solo)`);
  fail(r.checks);
});

// 5. Restricted world: the achievable-load ceiling has to reach every preview.
test('restricted (NWR) world: three quotes agree', () => {
  const { state, spare } = world({ restricted: true });
  fail(reconcile('NWR world', state, { origin: HUB, dest: PROBE, frame: spare, freq: 'uncapped' }).checks);
});

// 6. Year four. Demand has compounded for three years; a preview that builds its
//    market off a bare {week, month} gameDate is still quoting year one.
test('a world in its fourth year: three quotes agree', () => {
  const { state, spare } = world({ year: 4, week: 20 });
  fail(reconcile('year 4', state, { origin: HUB, dest: PROBE, frame: spare, freq: 'uncapped' }).checks);
});

// 7. Point-to-point off the hub: no feed at either end, the simplest case.
test('point-to-point pair off the hub: three quotes agree', () => {
  const { state, spare } = world();
  fail(reconcile('point-to-point', state, { origin: 'BOS', dest: 'PWM', frame: spare, freq: 'uncapped' }).checks);
});

// 8. Lease treatment. The tick charges the tail's SIGNED rate, not the catalogue
//    rate; both screens must net the lease of the tail that will fly the route.
test('leased frame at a signed rate: both screens net the signed lease', () => {
  const { state: base, spare } = world();
  const list   = getAircraftType(TYPE).weeklyLease;
  const signed = Math.round(list * 0.83);
  const leased = { ...spare, ownershipType: 'leased', weeklyLease: signed, leaseWeeksLeft: 200 };
  const state  = { ...base, fleet: base.fleet.map(a => a.id === spare.id ? leased : a) };
  const { checks, t } = reconcile('signed lease', state, { origin: HUB, dest: PROBE, frame: leased, freq: 'uncapped' });
  assert.equal(t.leaseCharged, signed, `fixture: tick charged ${fmt$(t.leaseCharged)}, expected the signed ${fmt$(signed)}`);
  fail(checks);
});

Math.random = realRandom;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
