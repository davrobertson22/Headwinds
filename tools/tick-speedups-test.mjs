// Two passes the weekly tick runs over the whole fleet, made cheaper without
// changing an answer (2026-11-12):
//
//   • jet bases: each tail used to walk every base the airline owns (78 bases ×
//     4,900 tails on one live airline). mroBaseCandidates indexes the open bases
//     once a week and resolveBaseFor looks up only the airports the tail flies;
//   • positioning: calcPositioning searched the fleet for every route; it now
//     indexes the fleet once (the first record per id, as find returned).
//
// Both are held here to the old code, on random fleets built to hit the ties
// (same level, same efficiency), reserves stationed at a base, bases still
// being built, odd opening weeks and duplicate fleet ids. The whole projection
// is held to byte-identity by the golden masters.
//
//   node tools/tick-speedups-test.mjs

import assert from 'node:assert/strict';
import {
  resolveBaseFor, mroBaseCandidates, networkAirportsIndex, isBaseOpen, baseCovers, baseEfficiency, mroLevelDef,
} from '../packages/engine/src/data/mroBase.js';
import { aircraftFamily } from '../packages/engine/src/data/families.js';
import { AIRCRAFT_TYPES, getAircraftType } from '../packages/engine/src/data/aircraft.js';
import { AIRPORTS } from '../packages/engine/src/data/airports.js';
import { calcPositioning } from '../packages/engine/src/models/positioning.js';
import { referencePrice } from '../packages/engine/src/utils/market.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 6).join('\n      ')}`); failed++; }
}

let seed = 424242;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const any = (xs) => xs[Math.floor(rand() * xs.length)];
const CODES = [...AIRPORTS].sort((a, b) => b.population - a.population).slice(0, 60).map(a => a.code);
const TYPES = AIRCRAFT_TYPES.filter(t => aircraftFamily(t.id)).map(t => t.id);
const FAMILIES = [...new Set(TYPES.map(aircraftFamily))];

// The resolver as it stood before the index (HEAD before 2026-11-12), copied.
function resolveBaseForOld(aircraft, bases = {}, routes = [], cargoRoutes = [], absWeek = 0, networkIndex = null) {
  const familyId = aircraftFamily(aircraft?.typeId);
  if (!familyId) return null;
  const network = new Set(networkIndex.get(aircraft?.id) ?? []);
  if (aircraft?.reserveBase) network.add(aircraft.reserveBase);
  let best = null;
  for (const [code, base] of Object.entries(bases ?? {})) {
    if (!network.has(code)) continue;
    if (!isBaseOpen(base)) continue;
    if (!baseCovers(base, familyId)) continue;
    const eff = baseEfficiency(base, absWeek);
    if (!best || base.level > best.level || (base.level === best.level && eff > best.eff)) {
      best = { code, base, level: base.level, eff, def: mroLevelDef(base.level) };
    }
  }
  return best;
}

function world(nBases, nTails) {
  const bases = {};
  const weeks = [100, 100, 120, 150, undefined, Number.NaN];
  for (const code of CODES.slice(0, nBases)) {
    const fams = FAMILIES.filter(() => rand() < 0.35);
    bases[code] = {
      code, level: any([1, 2, 2, 3, 3, 3]), families: rand() < 0.1 ? undefined : fams,
      openedWeek: any(weeks), buildWeeksLeft: rand() < 0.15 ? 3 : 0,
    };
  }
  const fleet = [], routes = [];
  for (let k = 0; k < nTails; k++) {
    const a = { id: `a${k}`, typeId: rand() < 0.03 ? 'no-such-type' : any(TYPES) };
    if (rand() < 0.1) a.reserveBase = any(CODES);
    fleet.push(a);
    const legs = Math.floor(rand() * 4);
    for (let j = 0; j < legs; j++) {
      const o = any(CODES), d = any(CODES);
      if (o !== d) routes.push({ id: `r${k}-${j}`, aircraftId: a.id, origin: o, destination: d,
        ...(rand() < 0.1 ? { stops: [o, any(CODES), d] } : {}) });
    }
  }
  return { bases, fleet, routes };
}

console.log('\n── weekly tick: fleet passes, indexed ──────────────────────────');

test('jet bases: the indexed resolver picks the same base as the walk, ties and reserves included', () => {
  let resolved = 0, ties = 0;
  for (let w = 0; w < 25; w++) {
    const { bases, fleet, routes } = world(10 + Math.floor(rand() * 70), 300);
    const absWeek = 150;
    const net = networkAirportsIndex(routes, []);
    const cand = mroBaseCandidates(bases, absWeek);
    for (const a of fleet) {
      const want = resolveBaseForOld(a, bases, routes, [], absWeek, net);
      const got  = resolveBaseFor(a, bases, routes, [], absWeek, net, cand);
      assert.deepEqual(got, want, `tail ${a.id}`);
      if (want) {
        resolved++;
        const reach = [...(net.get(a.id) ?? []), a.reserveBase].filter(c => bases[c] && isBaseOpen(bases[c]) && baseCovers(bases[c], aircraftFamily(a.typeId)));
        if (reach.filter(c => bases[c].level === want.level).length > 1) ties++;
      }
    }
  }
  assert.ok(resolved > 1000 && ties > 50, `fixture too thin (${resolved} resolved, ${ties} ties)`);
});

test('jet bases: candidates for another table or another week are not used', () => {
  const { bases, fleet, routes } = world(30, 200);
  const net = networkAirportsIndex(routes, []);
  const stale = mroBaseCandidates(bases, 120);
  const other = mroBaseCandidates({ ...bases }, 150);
  for (const a of fleet) {
    const want = resolveBaseForOld(a, bases, routes, [], 150, net);
    assert.deepEqual(resolveBaseFor(a, bases, routes, [], 150, net, stale), want);
    assert.deepEqual(resolveBaseFor(a, bases, routes, [], 150, net, other), want);
  }
});

// calcPositioning as it stood before the fleet index, copied.
function calcPositioningOld(state) {
  const { fleet, routes } = state;
  if (!routes || routes.length === 0) return { x: 0.5, y: 0.5, pricePremium: 0, bizCapRatio: 0 };
  let totalSeats = 0, bizFirstSeats = 0, pricePremSum = 0, qualitySum = 0, routeCount = 0;
  for (const route of routes) {
    const aircraft = (fleet ?? []).find(a => a.id === route.aircraftId);
    const type     = aircraft ? getAircraftType(aircraft.typeId) : null;
    if (!aircraft || !type) continue;
    const cfg = aircraft.config ?? {};
    bizFirstSeats += (cfg.firstClass ?? 0) + (cfg.businessClass ?? 0);
    totalSeats    += type.seats;
    const refP = referencePrice(route.origin, route.destination);
    const key = [route.origin, route.destination].sort().join('-');
    const fare = state.routePricing?.[key]?.economy ?? route.ticketPrice ?? 0;
    pricePremSum += (fare / Math.max(1, refP)) - 1;
    const seatQN = { basic: 0, standard: 0.4, premium: 0.7, luxury: 1.0 }[cfg.seatQuality ?? 'standard'] ?? 0.4;
    const servQN = { basic: 0, standard: 0.4, premium: 0.7, luxury: 1.0 }[cfg.serviceQuality ?? 'standard'] ?? 0.4;
    qualitySum += (seatQN + servQN) / 2;
    routeCount++;
  }
  if (routeCount === 0) return { x: 0.5, y: 0.5, pricePremium: 0, bizCapRatio: 0 };
  const bizCapRatio  = totalSeats > 0 ? bizFirstSeats / totalSeats : 0;
  const avgPricePrem = pricePremSum / routeCount;
  const avgQuality   = qualitySum / routeCount;
  const bizFocus = Math.max(0, Math.min(1, bizCapRatio * 1.5 + (avgPricePrem > 0.2 ? 0.2 : avgPricePrem > 0 ? 0.1 : -0.05) + 0.15));
  const premiumLevel = Math.max(0, Math.min(1, avgQuality * 0.65 + Math.max(-0.2, Math.min(0.35, avgPricePrem + 0.3))));
  return { x: bizFocus, y: premiumLevel, pricePremium: avgPricePrem, bizCapRatio };
}

test('positioning: the fleet index gives the same position, duplicate ids and missing tails included', () => {
  const quals = ['basic', 'standard', 'premium', 'luxury', undefined, 'odd'];
  for (let w = 0; w < 20; w++) {
    const fleet = [], routes = [];
    for (let k = 0; k < 150; k++) {
      fleet.push({ id: `a${Math.floor(k * 0.9)}`, typeId: rand() < 0.05 ? 'no-such-type' : any(TYPES),
        config: { firstClass: Math.floor(rand() * 8), businessClass: Math.floor(rand() * 30), seatQuality: any(quals), serviceQuality: any(quals) } });
    }
    for (let k = 0; k < 400; k++) {
      const o = any(CODES), d = any(CODES);
      routes.push({ id: `r${k}`, aircraftId: rand() < 0.05 ? 'gone' : `a${Math.floor(rand() * 140)}`, origin: o, destination: d,
        ticketPrice: rand() < 0.1 ? undefined : 100 + Math.floor(rand() * 900) });
    }
    const routePricing = {};
    for (const r of routes.slice(0, 50)) routePricing[[r.origin, r.destination].sort().join('-')] = { economy: 200 + Math.floor(rand() * 400) };
    const state = { fleet, routes, routePricing };
    assert.deepEqual(calcPositioning(state), calcPositioningOld(state));
  }
  assert.deepEqual(calcPositioning({ fleet: [], routes: [] }), calcPositioningOld({ fleet: [], routes: [] }));
  assert.deepEqual(calcPositioning({ fleet: undefined, routes: [{ id: 'x', aircraftId: 'a' }] }), calcPositioningOld({ fleet: undefined, routes: [{ id: 'x', aircraftId: 'a' }] }));
});

console.log(`\n${'─'.repeat(56)}`);
console.log(`  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
