#!/usr/bin/env node
// routes-gates-finder-perf-probe.mjs — @not-a-test: a measurement, not a pass/fail suite.
//
// What the Routes tab, the Gates (Airports) tab and the Route Finder cost to
// render on a big Headwinds airline, split into the engine projection (paid once
// per state snapshot) and the component's own render (paid on EVERY re-render —
// a keystroke in a search box, a rival-overlay poll, the topbar clock). Built for
// Barca's "routes tab is very laggy" / "similarly for gates" report (Discord,
// 2026-10-16) and the matching route-finder reports, and kept so the next "is
// this slow?" is answered with a number.
//
//   node --import ./tools/_register-loader.mjs tools/routes-gates-finder-perf-probe.mjs
//
// Read it as SHAPE, not as milliseconds: SSR in Node on a dev machine skips the
// DOM entirely; a browser on a mid-range laptop runs several times slower and
// pays layout on top. Compare rows against each other.
import { performance } from 'node:perf_hooks';
import React from 'react';
import { renderToString } from 'react-dom/server';

const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
globalThis.matchMedia = globalThis.window.matchMedia;
globalThis.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k), clear: () => store.clear() };
globalThis.document = globalThis.document ?? { addEventListener() {}, removeEventListener() {}, querySelector() { return null; } };

Math.random = (() => { let s = 424242; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; })();

const { RemoteGameProvider, freshState } = await import('../src/store/GameContext.jsx');
const Routes = (await import('../src/components/Routes.jsx')).default;
const Airports = (await import('../src/components/Airports.jsx')).default;
const RouteFinder = (await import('../src/components/RouteFinder.jsx')).default;
const { rememberFinder, finderMemoryKey, clearFinderMemory } = await import('../src/utils/finderMemory.js');
const { projectWeek } = await import('../packages/engine/src/utils/financeProjection.js');
const { getAircraftType } = await import('../packages/engine/src/data/aircraft.js');
const { AIRPORTS, getAirport } = await import('../packages/engine/src/data/airports.js');
const { defaultConfig, defaultClassPrices, distanceKm, referencePrice } = await import('../packages/engine/src/utils/simulation.js');
const { pairKeyOf } = await import('../packages/engine/src/models/pairShare.js');

const BIG = [...AIRPORTS].sort((a, b) => b.population - a.population).slice(0, 400);

export function buildWorld({ routes: nRoutes = 250, rivals = 25, rivalRoutes = 30, gateAirports = 120, scarcity = true } = {}) {
  const wide = getAircraftType('b7879'), narrow = getAircraftType('a320neo');
  const HUBS = ['JFK', 'ORD', 'LAX', 'LHR', 'DFW'];
  let n = 0;
  const fleet = [], routes = [], routePricing = {}, gates = {};
  outer: for (let k = 0; k < BIG.length; k++) for (const h of HUBS) {
    const s = BIG[k].code;
    if (h === s) continue;
    const a1 = getAirport(h), a2 = getAirport(s);
    const t = distanceKm(a1, a2) > 4000 ? wide : narrow;
    if (distanceKm(a1, a2) > 12000) continue;
    const ac = { id: `p${n++}`, typeId: t.id, status: 'assigned', ageWeeks: 52, config: defaultConfig(t.seats), ownershipType: 'owned', tailNumber: `N${n}HW`, name: t.name };
    fleet.push(ac);
    routes.push({ id: `r${routes.length}`, origin: h, destination: s, stops: [h, s], aircraftId: ac.id, weeklyFrequency: 7, weeksOpen: 30, hub: h, ticketPrice: Math.round(referencePrice(h, s)), cateringLevel: 'full' });
    routePricing[pairKeyOf(h, s)] = defaultClassPrices(Math.round(referencePrice(h, s)));
    gates[h] = (gates[h] ?? 0) + 1; gates[s] = (gates[s] ?? 0) + 1;
    if (routes.length >= nRoutes) break outer;
  }
  for (const a of BIG.slice(0, gateAirports)) gates[a.code] = Math.max(gates[a.code] ?? 0, 1);
  for (const h of HUBS) gates[h] = Math.max(gates[h], 30);

  const competitors = [], humanRivals = {};
  for (let p = 0; p < rivals; p++) {
    const hub = BIG[(p * 7) % BIG.length].code;
    const rroutes = {};
    for (let k = 0; k < rivalRoutes; k++) {
      const dst = BIG[(p * 13 + k * 3 + 1) % BIG.length].code;
      if (dst === hub) continue;
      const key = pairKeyOf(hub, dst);
      const ref = referencePrice(hub, dst) || 200;
      rroutes[key] = { frequency: 14, priceMultiplier: 1, economyFare: Math.round(ref), seatsPerWeek: 180 * 14, seats: 180, businessSeatsPerWeek: 20 * 14, businessFare: Math.round(ref * 2.5), aircraftTypes: ['a320neo'], aircraftType: 'a320neo' };
      (humanRivals[key] ??= []).push({ competitorId: `human:${p}`, name: `Rival ${p}`, origin: hub, destination: dst, frequency: 14, weeklyFrequency: 14, economyFare: Math.round(ref), businessFare: Math.round(ref * 2.5), seatsPerWeek: 180 * 14, seats: 180, businessSeatsPerWeek: 20 * 14, qualityScore: 62, priceMultiplier: 1, aircraftType: 'a320neo' });
    }
    competitors.push({ id: `human:${p}`, human: true, name: `Rival ${p}`, homeHub: hub, hubs: { [hub]: { tier: 1 } }, tier: 'legacy', routes: rroutes, baseQualityScore: 62, marketShare: 0.02, cash: 5e8 });
  }

  const gateMarket = scarcity ? {
    week: 150,
    airports: Object.fromEntries(AIRPORTS.map(a => [a.code, { capacity: 40, taken: Math.floor(Math.random() * 40), allianceTaken: 5, listings: [] }])),
    slotPool: {},
  } : undefined;

  return {
    ...freshState(), phase: 'playing', week: 20, year: 3, hub: 'JFK', airlineName: 'Probe Air', cash: 5e9,
    fleet, routes, routePricing, gates, competitors, humanRivals, encroachments: {},
    hubs: Object.fromEntries(HUBS.map(h => [h, { tier: 2, tierSince: 0 }])),
    multiplayer: true,
    gateScarcityWorld: scarcity, gateMarket, allianceMembership: scarcity ? { allianceId: 'a1' } : undefined,
  };
}

const remoteApi = { setGateSlotShare: async () => {}, placeGateBid: async () => {} };
const render = (state, el) => renderToString(React.createElement(RemoteGameProvider, { state, dispatch: () => {}, remoteApi }, el));

function time(label, fn, iters = 3) {
  fn();
  const t0 = performance.now();
  let out;
  for (let i = 0; i < iters; i++) out = fn();
  const ms = (performance.now() - t0) / iters;
  const kb = typeof out === 'string' ? ` · ${Math.round(out.length / 1024)} KB` : '';
  console.log(`  ${label.padEnd(58)} ${ms.toFixed(1).padStart(7)} ms${kb}`);
  return ms;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  for (const cfg of [{ routes: 120 }, { routes: 250 }, { routes: 450, gateAirports: 200 }]) {
    const st = buildWorld(cfg);
    console.log(`\n=== ${st.routes.length} routes · ${Object.keys(st.gates).length} gate airports · ${st.competitors.length} rivals ===`);
    time('projectWeek (cold, fresh snapshot each pass)', () => projectWeek({ ...st }), 2);
    projectWeek(st);
    time('Routes tab render (projection warm)', () => render(st, React.createElement(Routes)));
    time('Gates tab render', () => render(st, React.createElement(Airports)));
    clearFinderMemory();
    time('Route Finder render, sort=demand (default)', () => render(st, React.createElement(RouteFinder, { standalone: true })));
    rememberFinder(finderMemoryKey(st, 'passenger'), { sortBy: 'profit' });
    time('Route Finder render, sort=profit (forecast sort)', () => render(st, React.createElement(RouteFinder, { standalone: true })), 1);
    clearFinderMemory();
  }
}
