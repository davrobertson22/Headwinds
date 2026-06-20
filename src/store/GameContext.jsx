import { createContext, useContext, useReducer, useEffect, useMemo } from 'react';
import {
  weeklyTick, defaultConfig,
  weeklyBlockHours, MAX_WEEKLY_BLOCK_HOURS, SLOTS_PER_GATE, routeDistanceKm,
  CLASS_FARE_MULTIPLIERS, maxFrequency, effectiveRangeKm, weekToGameDate,
  routePairKey, defaultClassPrices, clampClassPrice, hydrateRoute, normalizeRouteStops,
  routeStops, routeLegs, routeSegments, routeSegmentKey,
  routeMaxLegKm, routeBlockHours, referencePrice as routeReferencePrice,
  MAX_ROUTE_STOPS,
  loyaltyTier, loyaltyEnrollPull,
  isRouteActive, routeActiveMonths,
} from '../utils/simulation.js';
import { computeMarketCap, referencePrice as mktReferencePrice, TOTAL_SHARES, cargoReferenceYield } from '../utils/market.js';
import { fleetWeeklyDepreciation } from '../utils/financeProjection.js';
import { getAircraftType, effectivePurchasePrice, buyDiscount, AIRCRAFT_TYPES } from '../data/aircraft.js';
import { getAirport } from '../data/airports.js';
import { DEFAULT_LABOR_STATE, DEFAULT_MAINTENANCE_BUDGET, moraleTarget } from '../data/labor.js';
import { checkRouteRestrictions } from '../data/airportRestrictions.js';
import {
  COMPETITOR_AIRLINES,
  initializeCompetitorRoutes,
  sampleAndInitializeCompetitors,
  tickCompetitorGrowth,
  tickCompetitorPricing,
  computeCompetitorWeeklyStats,
  HUB_TIERS,
  HUB_MIN_GATES,
  HUB_TIER_COUNT,
} from '../models/demand.js';
import { rollEvents, tickEvents, rollMechanicalFailures } from '../data/events.js';
import { tickEncroachment } from '../models/encroachment.js';
import {
  tickFuelPrice,
  effectiveFuelMultiplier,
  hedgeLockedPrice,
  absoluteWeek,
  HEDGE_DURATIONS,
} from '../utils/fuel.js';
import {
  getAlliance,
  CODESHARE_WEEKLY_FEE_BY_TIER,
  CODESHARE_DURATION_WEEKS,
  MAX_CODESHARE_AGREEMENTS,
} from '../data/alliances.js';
import { routeLaunchCost, DEPRECIATION_YEARS } from '../data/overhead.js';
import { normalizeCateringLevel } from '../data/catering.js';
import { initialObjectives, initialObjectivesForState, checkObjectives, getObjective } from '../data/objectives.js';

// ─────────────────────────────────────────────
// STATE SHAPE
// ─────────────────────────────────────────────

const STARTING_CASH = 10_000_000;

function freshState() {
  return {
    airlineName: '',
    logoId: 'horizon',
    logoColor: '#f5a623',
    customLogo: null,   // data URL of a user-uploaded logo (overrides logoId when set)
    hub: '',
    homeCountry: '',  // ISO country code of starting hub — hubs restricted to this country
    cash: STARTING_CASH,
    activeEvents:  [],    // currently active random events
    showDebrief:   false, // show weekly debrief modal
    pendingToasts: [],    // toast configs waiting to be shown
    week: 1,
    year: 1,
    fleet: [],         // { id, typeId, name, status, ageWeeks, config, ownershipType, fuelMod, rangeMod, maintMod, engineId, engineLabel, hasWingtips }
    pendingOrders: [], // { id, typeId, ownershipType, name, engineId, engineLabel, hasWingtips, fuelMod, rangeMod, maintMod, deliverAbsWeek, totalPrice }
    routes: [],      // { id, origin, destination, stops:[origin,...,destination], aircraftId, weeklyFrequency, hub } — price lives in routePricing; stops carries intermediate tag-flight airports (single-leg routes have stops=[origin,destination])
    routePricing: {},// { [pairKey]: { economy, premiumEconomy, businessClass, firstClass } } — one price set per O&D pair
    routeCatering: {},// { [pairKey]: cateringLevel } — one catering level per O&D pair
    cargoRoutes: [], // { id, origin, destination, aircraftId, yieldPrice ($/tonne-km), weeklyFrequency, weeksOpen, hub, cargo:true }
    gates:             {},    // { [airportCode]: gateCount } — each gate = 50 slots/wk
    hubs:              {},    // { [airportCode]: { tier: 1|2|3 } } — designated hub airports
    labor:             DEFAULT_LABOR_STATE,
    maintenanceBudget: DEFAULT_MAINTENANCE_BUDGET,
    marketingBudget:   0,          // weekly marketing spend ($) — 0 = no active marketing
    defaultCateringLevel: 'full',  // catering service level applied to newly-opened routes
    loyalty: {
      weeklyInvestment: 0,   // weekly $ spend on loyalty program (the set budget)
      effInvestment: 0,      // ramped "effective" budget — eases toward weeklyInvestment
      members: 0,            // current active members
    },
    financialHistory: [],  // last 52 weeks of reports
    lastReport: null,
    fuelPrice: { index: 1.0, history: [] },  // fuel price index + 52-week history
    hedgeContracts: [],                       // active fuel hedge contracts
    loans: [],             // active loans: { id, principal, interestRate, termWeeks, weeklyPayment, weeksRemaining, totalInterestPaid, takenWeek }
    phase: 'setup',  // 'setup' | 'playing' | 'bankrupt'
    competitors: sampleAndInitializeCompetitors(15),
    encroachments: {},           // { [pairKey]: entrant } — AI carriers contesting player routes
    allianceMembership:   null,  // { allianceId, joinedWeek, weeklyFee } | null
    codeshareAgreements:  [],    // [{ id, competitorId, competitorName, competitorTier, weeklyFee, signedWeek, weeksRemaining }]
    awareness: 5,                // 0–100: how well-known the airline is; gates demand
    missedLoanPayments:       0,   // total weeks where loans were due and cash went negative
    consecutiveNegativeWeeks: 0,   // weeks in a row ending with negative cash (resets on recovery)
    bankruptcyReason:         null, // 'missed_loans' | 'consecutive_negative' | null
    marketCap:         STARTING_CASH * 1.5,  // player market cap ($), updated each week
    sharePrice:        STARTING_CASH * 1.5 / TOTAL_SHARES,  // player share price ($)
    objectives:        [],   // [{ id, completed, completedWeek, completedYear }]
    objectivesEnabled: true, // can be disabled at setup
  };
}

// ─────────────────────────────────────────────
// REDUCER
// ─────────────────────────────────────────────

// Use timestamp + random suffix so HMR (hot-reload resetting module scope)
// never produces an ID that collides with IDs already stored in localStorage.
function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// ─────────────────────────────────────────────
// TAIL NUMBER GENERATION
// ─────────────────────────────────────────────

/** ICAO-style registration prefix by country code. */
const COUNTRY_REG_PREFIX = {
  US: 'N',  CA: 'C',  MX: 'XA', PA: 'HP', BR: 'PP', AR: 'LV',
  CL: 'CC', CO: 'HK', PE: 'OB', GB: 'G',  FR: 'F',  DE: 'D',
  NL: 'PH', ES: 'EC', IT: 'I',  CH: 'HB', AT: 'OE', BE: 'OO',
  PT: 'CS', NO: 'LN', SE: 'SE', FI: 'OH', DK: 'OY', IE: 'EI',
  PL: 'SP', GR: 'SX', TR: 'TC', AE: 'A6', QA: 'A7', SA: 'HZ',
  IL: '4X', ZA: 'ZS', EG: 'SU', KE: '5Y', NG: '5N', MA: 'CN',
  ET: 'ET', SG: '9V', HK: 'B',  MY: '9M', TH: 'HS', ID: 'PK',
  PH: 'RP', IN: 'VT', LK: '4R', JP: 'JA', KR: 'HL', CN: 'B',
  TW: 'B',  AU: 'VH', NZ: 'ZK',
};

/** Derive a 3-letter ICAO-style airline code from the airline name. */
function airlineCode(name) {
  const words = name.toUpperCase().replace(/[^A-Z\s]/g, '').split(/\s+/).filter(Boolean);
  if (words.length === 0) return 'AIR';
  if (words.length >= 3)  return words.slice(0, 3).map(w => w[0]).join('');
  if (words.length === 2)  return (words[0].slice(0, 2) + words[1][0]).slice(0, 3);
  return words[0].slice(0, 3).padEnd(3, 'X').slice(0, 3);
}

/**
 * Generate a unique aircraft registration based on hub country and airline name.
 * US format:  N + code + seq    → e.g. NDAL01
 * All others: prefix + - + code + seq → e.g. G-BAW01, VH-QAN01
 */
function generateTailNumber(hubCode, airlineName, usedTails = []) {
  const airport = getAirport(hubCode);
  const country = airport?.country ?? 'US';
  const prefix  = COUNTRY_REG_PREFIX[country] ?? 'N';
  const code    = airlineCode(airlineName);

  let n = 1;
  let tail;
  do {
    const seq = String(n).padStart(2, '0');
    tail = prefix === 'N'
      ? `N${code}${seq}`
      : `${prefix}-${code}${seq}`;
    n++;
  } while (usedTails.includes(tail) && n < 9999);

  return tail;
}

function reducer(state, action) {
  switch (action.type) {

    case 'START_GAME': {
      // Startup capital: $10M of founders' EQUITY (see STARTING_CASH in freshState).
      // It is not a loan — there is no debt to service at launch, giving new airlines
      // breathing room to reach profitability. Players can borrow from the bank later.
      return {
        ...freshState(),
        airlineName: action.airlineName,
        logoId:      action.logoId    ?? 'horizon',
        logoColor:   action.logoColor ?? '#f5a623',
        customLogo:  action.customLogo ?? null,
        hub:         action.hub,
        homeCountry: getAirport(action.hub)?.country ?? '',
        gates:       { [action.hub]: 1 },
        hubs:        { [action.hub]: { tier: 1 } },
        loans:       [],
        phase:             'playing',
        objectives:        action.enableObjectives !== false ? initialObjectives() : [],
        objectivesEnabled: action.enableObjectives !== false,
      };
    }

    case 'LEASE_AIRCRAFT': {
      const type       = getAircraftType(action.typeId);
      const count      = state.fleet.filter(a => a.typeId === action.typeId).length + 1;
      const name       = action.name ?? `${type?.name ?? action.typeId} #${count}`;
      const usedTails  = state.fleet.map(a => a.tailNumber).filter(Boolean);
      const tailNumber = generateTailNumber(state.hub, state.airlineName, usedTails);
      // Default lease term by aircraft category
      const LEASE_TERM_BY_CATEGORY = {
        'Turboprop':    52,   // 1 year
        'Regional Jet': 78,   // 1.5 years
        'Narrow Body':  104,  // 2 years
        'Wide Body':    156,  // 3 years
      };
      const leaseTermWeeks = action.leaseTermWeeks ?? (LEASE_TERM_BY_CATEGORY[type?.category] ?? 104);
      const newAircraft = {
        id:                 uid(),
        typeId:             action.typeId,
        name,
        tailNumber,
        status:             'idle',
        ageWeeks:           0,
        config:             defaultConfig(type?.seats ?? 100),
        ownershipType:      'lease',
        leaseTermWeeks,
        leaseRemainingWeeks: leaseTermWeeks,
      };
      return { ...state, fleet: [...state.fleet, newAircraft] };
    }

    case 'BUY_AIRCRAFT': {
      const type         = getAircraftType(action.typeId);
      if (!type) return state;
      const alreadyOwned = state.fleet.filter(a => a.typeId === action.typeId).length;
      const price        = effectivePurchasePrice(type, alreadyOwned);
      if (state.cash < price) return state;  // can't afford — ignore silently
      const count      = alreadyOwned + 1;
      const name       = action.name ?? `${type.name} #${count}`;
      const usedTails  = state.fleet.map(a => a.tailNumber).filter(Boolean);
      const tailNumber = generateTailNumber(state.hub, state.airlineName, usedTails);
      const newAircraft = {
        id:            uid(),
        typeId:        action.typeId,
        name,
        tailNumber,
        status:        'idle',
        ageWeeks:      0,
        config:        defaultConfig(type.seats),
        ownershipType: 'owned',
      };
      return {
        ...state,
        cash:  state.cash - price,
        fleet: [...state.fleet, newAircraft],
      };
    }

    // ─── Ordered aircraft with staggered delivery ────────────────────────────────
    // Lead times by category (weeks). The FIRST delivery of a type takes 2× the lead.
    // Subsequent deliveries in the same queue stack at +lead intervals after the last.
    //   Wide Body    → first 8w, then every 4w
    //   Narrow Body  → first 6w, then every 3w
    //   Regional Jet → first 4w, then every 2w
    //   Turboprop    → first 2w, then every 1w
    case 'ORDER_AIRCRAFT': {
      const type = getAircraftType(action.typeId);
      if (!type) return state;

      const DELIVERY_LEAD = { 'Wide Body': 4, 'Narrow Body': 3, 'Regional Jet': 2, 'Turboprop': 1 };
      const lead     = DELIVERY_LEAD[type.category] ?? 2;
      const quantity = Math.max(1, Math.min(20, action.quantity ?? 1));

      const currentAbsWeek = absoluteWeek(state.year, state.week);

      // Resolve engine and wingtip modifiers (same for all aircraft in the batch)
      const engineOptions  = type.configOptions?.engines ?? [];
      const engineOpt      = engineOptions.find(e => e.id === action.engineId)
                          ?? engineOptions.find(e => e.default)
                          ?? engineOptions[0];
      const engineFuelMod  = engineOpt?.fuelMod  ?? 1.0;
      const enginePriceMod = engineOpt?.priceMod ?? 1.0;
      const engineMaintMod = engineOpt?.maintMod ?? 1.0;
      const wingtipDef     = type.configOptions?.wingtips;
      const wingtipFuelMod  = (action.hasWingtips && wingtipDef) ? (wingtipDef.fuelMod  ?? 1.0) : 1.0;
      const wingtipRangeMod = (action.hasWingtips && wingtipDef) ? (wingtipDef.rangeMod ?? 1.0) : 1.0;
      const wingtipCost     = (action.hasWingtips && wingtipDef) ? (wingtipDef.cost     ?? 0)   : 0;
      const fuelMod  = Math.round(engineFuelMod  * wingtipFuelMod  * 10000) / 10000;
      const rangeMod = Math.round(                  wingtipRangeMod * 10000) / 10000;
      const maintMod = Math.round(engineMaintMod                    * 10000) / 10000;

      // Build all N orders, updating the running pendingOrders list so each order
      // can see the previous ones when computing its staggered delivery week.
      let runningPending = [...(state.pendingOrders ?? [])];
      let cashBalance    = state.cash;
      const newOrders    = [];

      for (let i = 0; i < quantity; i++) {
        const pendingOfType = runningPending.filter(o => o.typeId === action.typeId);

        // First-ever order of this type takes 2× lead; subsequent stack at +lead
        const maxExistingDelivery = pendingOfType.length > 0
          ? Math.max(...pendingOfType.map(o => o.deliverAbsWeek))
          : null;
        const deliverAbsWeek = maxExistingDelivery === null
          ? currentAbsWeek + 2 * lead          // first in queue → 2× lead
          : maxExistingDelivery + lead;         // subsequent → +lead after last

        // Price (fleet discount counts fleet + already-queued units)
        const totalExisting  = state.fleet.filter(a => a.typeId === action.typeId).length
                             + pendingOfType.length;
        const unitBasePrice  = action.ownershipType === 'owned'
          ? effectivePurchasePrice(type, totalExisting)
          : 0;
        const unitTotalPrice = action.ownershipType === 'owned'
          ? Math.round(unitBasePrice * enginePriceMod) + wingtipCost
          : 0;

        // Lease: 3-month (12-week) upfront deposit required at order time
        const baseWeeklyLease   = type.weeklyLease ?? 0;
        const engineLeaseAdj    = Math.round(baseWeeklyLease * (enginePriceMod - 1));
        const wingtipLeaseAdj   = (action.hasWingtips && wingtipDef) ? Math.round((wingtipDef.cost ?? 0) / 200) : 0;
        const unitWeeklyLease   = baseWeeklyLease + engineLeaseAdj + wingtipLeaseAdj;
        const leaseDeposit      = action.ownershipType === 'lease' ? unitWeeklyLease * 12 : 0;

        // Stop if we can't afford this unit (buy price or lease deposit)
        const unitUpfrontCost = action.ownershipType === 'owned' ? unitTotalPrice : leaseDeposit;
        if (cashBalance < unitUpfrontCost) break;

        const serialNum = totalExisting + 1;
        const order = {
          id:            uid(),
          typeId:        action.typeId,
          ownershipType: action.ownershipType,
          name:          action.name ?? `${type.name} #${serialNum}`,
          engineId:      engineOpt?.id    ?? null,
          engineLabel:   engineOpt?.label ?? null,
          hasWingtips:   action.hasWingtips ?? false,
          fuelMod,
          rangeMod,
          maintMod,
          config:        action.config ?? null,  // cabin layout chosen at order time
          deliverAbsWeek,
          totalPrice:    unitTotalPrice,
          leaseDeposit:  leaseDeposit,
          weeklyLease:   action.ownershipType === 'lease' ? unitWeeklyLease : 0,
          orderedWeek:   state.week,
          orderedYear:   state.year,
        };

        newOrders.push(order);
        runningPending = [...runningPending, order];
        cashBalance   -= unitUpfrontCost;
      }

      if (newOrders.length === 0) return state;

      return {
        ...state,
        cash:          cashBalance,
        pendingOrders: runningPending,
      };
    }

    case 'CANCEL_ORDER': {
      const order = (state.pendingOrders ?? []).find(o => o.id === action.orderId);
      if (!order) return state;
      // Refund purchase price with a 5% cancellation fee; leases cost nothing to cancel
      const refund = order.ownershipType === 'owned'
        ? Math.round(order.totalPrice * 0.95)
        : 0;
      return {
        ...state,
        cash:          state.cash + refund,
        pendingOrders: (state.pendingOrders ?? []).filter(o => o.id !== action.orderId),
      };
    }

    case 'RETIRE_AIRCRAFT': {
      const aircraft      = state.fleet.find(a => a.id === action.aircraftId);
      const updatedRoutes = state.routes.filter(r => r.aircraftId !== action.aircraftId);
      const updatedCargo  = (state.cargoRoutes ?? []).filter(r => r.aircraftId !== action.aircraftId);
      const updatedFleet  = state.fleet.filter(a => a.id !== action.aircraftId);
      const routeAircraftIds = new Set([...updatedRoutes, ...updatedCargo].map(r => r.aircraftId));
      const reStatusFleet = updatedFleet.map(a => ({
        ...a,
        status: routeAircraftIds.has(a.id) ? 'assigned' : 'idle',
      }));
      // Early termination penalty: 50 % of remaining weekly lease × weeks left
      const type    = aircraft ? getAircraftType(aircraft.typeId) : null;
      const weeksLeft = aircraft?.leaseRemainingWeeks ?? 0;
      const penalty = (aircraft?.ownershipType === 'lease' && weeksLeft > 0)
        ? Math.round((type?.weeklyLease ?? 0) * weeksLeft * 0.5)
        : 0;
      return {
        ...state,
        cash:        state.cash - penalty,
        fleet:       reStatusFleet,
        routes:      updatedRoutes,
        cargoRoutes: updatedCargo,
      };
    }

    case 'SELL_AIRCRAFT': {
      // Sell an owned aircraft at NAV minus 5% selling & admin fee.
      const aircraft      = state.fleet.find(a => a.id === action.aircraftId);
      const type          = aircraft ? getAircraftType(aircraft.typeId) : null;
      const ageYears      = (aircraft?.ageWeeks ?? 0) / 52;
      const remaining     = Math.max(0.1, 1 - ageYears / DEPRECIATION_YEARS);
      const nav           = Math.round((type?.purchasePrice ?? 0) * remaining);
      const fee           = Math.round(nav * 0.05);
      const proceeds      = nav - fee;
      const updatedRoutes = state.routes.filter(r => r.aircraftId !== action.aircraftId);
      const updatedCargo  = (state.cargoRoutes ?? []).filter(r => r.aircraftId !== action.aircraftId);
      const updatedFleet  = state.fleet.filter(a => a.id !== action.aircraftId);
      const routeAircraftIds = new Set([...updatedRoutes, ...updatedCargo].map(r => r.aircraftId));
      const reStatusFleet = updatedFleet.map(a => ({
        ...a,
        status: routeAircraftIds.has(a.id) ? 'assigned' : 'idle',
      }));
      return {
        ...state,
        cash:        state.cash + proceeds,
        fleet:       reStatusFleet,
        routes:      updatedRoutes,
        cargoRoutes: updatedCargo,
      };
    }

    case 'CONFIGURE_AIRCRAFT': {
      // action: { aircraftId, config, reconfCost }
      const cost = action.reconfCost ?? 0;
      return {
        ...state,
        cash:  state.cash - cost,
        fleet: state.fleet.map(a =>
          a.id === action.aircraftId ? { ...a, config: action.config } : a
        ),
      };
    }

    case 'RENAME_AIRCRAFT': {
      return {
        ...state,
        fleet: state.fleet.map(a =>
          a.id === action.aircraftId ? { ...a, name: action.name } : a
        ),
      };
    }

    case 'SET_BRANDING': {
      // Update airline name / logo / accent colour mid-game. Only fields that
      // are provided are changed; customLogo may be explicitly set to null to
      // clear an uploaded image and fall back to the chosen preset.
      const next = { ...state };
      if (typeof action.airlineName === 'string' && action.airlineName.trim()) {
        next.airlineName = action.airlineName.trim();
      }
      if (typeof action.logoId === 'string')   next.logoId    = action.logoId;
      if (typeof action.logoColor === 'string') next.logoColor = action.logoColor;
      if ('customLogo' in action)              next.customLogo = action.customLogo ?? null;
      return next;
    }

    case 'ADD_ROUTE': {
      const aircraft = state.fleet.find(a => a.id === action.aircraftId);
      const type     = aircraft ? getAircraftType(aircraft.typeId) : null;
      if (!aircraft || !type) return state;
      // Freighters carry no passengers — they fly cargo routes (ADD_CARGO_ROUTE) only.
      if (type.freighter) return state;

      // Reject a same-airport route: distance 0 → ~zero cost but full gravity-model
      // demand, which would be an exploit. (The UI excludes this, but guard anyway.)
      if (action.origin === action.destination) return state;
      // Frequency must be a positive integer.
      const weeklyFrequency = Math.max(1, Math.round(Number(action.weeklyFrequency) || 0));

      const dist = routeDistanceKm(action.origin, action.destination);

      // ── Seasonal window ──────────────────────────────────────────────────────
      // action.season = { months:[1..12] } | null (year-round). Block-hour and slot
      // checks below run PER MONTH so a route that's dormant part of the year can
      // share an aircraft / gate slot with a counter-seasonal route.
      const newSeason = (Array.isArray(action.season?.months) && action.season.months.length > 0)
        ? { months: [...action.season.months].sort((a, b) => a - b) }
        : null;
      const newRouteLike = { origin: action.origin, destination: action.destination, season: newSeason };
      const newMonths = routeActiveMonths(newRouteLike);

      // ── Range check (engine/wingtip rangeMod + cabin-payload bonus) ─────────
      const effectiveRange = effectiveRangeKm(aircraft, type);
      if (dist > effectiveRange) return state;

      // ── Regulatory restriction check (perimeter rules, slot caps, aircraft size) ─
      // Pass the TOTAL proposed weekly frequency on this city-pair (existing + new) and
      // the player's routes, so perimeter exemption-slot and per-route frequency caps
      // (e.g. DCA's 5 beyond-perimeter slots, each ≤7/wk) can be evaluated.
      // Frequency caps bind per-week, so for a seasonal route only count existing
      // routes that operate in the SAME month(s) — use the worst (peak) month.
      const pairKey = [action.origin, action.destination].sort().join('-');
      const pairRoutes = state.routes
        .filter(r => [r.origin, r.destination].sort().join('-') === pairKey);
      const peakPairFreq = Math.max(0, ...newMonths.map(m =>
        pairRoutes.filter(r => isRouteActive(r, m)).reduce((s, r) => s + r.weeklyFrequency, 0)));
      const proposedPairFreq = peakPairFreq + weeklyFrequency;
      if (checkRouteRestrictions(action.origin, action.destination, dist, proposedPairFreq, type.category,
            { routes: state.routes, excludeKey: pairKey })) return state;

      // ── Block-hours check: per-month peak across routes on this aircraft ───────
      // Two routes that never share a month can both use the full block-hour budget.
      const acRoutes = state.routes.filter(r => r.aircraftId === action.aircraftId);
      const newBlockHrs = weeklyBlockHours(dist, weeklyFrequency, type);
      const peakBlockHrs = Math.max(0, ...newMonths.map(m =>
        newBlockHrs + acRoutes
          .filter(r => isRouteActive(r, m))
          .reduce((sum, r) => sum + weeklyBlockHours(routeDistanceKm(r.origin, r.destination), r.weeklyFrequency, type), 0)));
      if (peakBlockHrs > MAX_WEEKLY_BLOCK_HOURS) return state;

      // ── Network-connectivity check: a plane that has already flown can only ───
      // extend its network from airports it already serves — no teleporting.
      const aircraftRoutes = state.routes.filter(r => r.aircraftId === action.aircraftId);
      if (aircraftRoutes.length > 0) {
        const servedAirports = new Set(aircraftRoutes.flatMap(r => [r.origin, r.destination]));
        const connected = servedAirports.has(action.origin) || servedAirports.has(action.destination);
        if (!connected) return state;
      }

      // ── Gate checks ──────────────────────────────────────────────────────────
      const gates = state.gates ?? {};
      if (!(gates[action.origin] > 0))      return state;  // no gate at origin
      if (!(gates[action.destination] > 0)) return state;  // no gate at destination

      // Slot availability (each freq unit = 1 departure/wk at each endpoint), checked
      // per-month so a dormant route's slots are free for a counter-seasonal route.
      const peakSlotsAt = (code) => Math.max(0, ...newMonths.map(m => state.routes
        .filter(r => (r.origin === code || r.destination === code) && isRouteActive(r, m))
        .reduce((s, r) => s + r.weeklyFrequency, 0)));
      if (peakSlotsAt(action.origin)      + weeklyFrequency > gates[action.origin]      * SLOTS_PER_GATE) return state;
      if (peakSlotsAt(action.destination) + weeklyFrequency > gates[action.destination] * SLOTS_PER_GATE) return state;

      // ── Consolidate: merge only when the same aircraft flies the same O&D with
      // the SAME season window (different windows must stay separate routes). ──
      const sameSeason = (r) => {
        const a = routeActiveMonths(r), b = newMonths;
        return a.length === b.length && a.every((m, i) => m === b[i]);
      };
      const existingRoute = state.routes.find(r =>
        r.aircraftId === action.aircraftId && sameSeason(r) &&
        ((r.origin === action.origin && r.destination === action.destination) ||
         (r.origin === action.destination && r.destination === action.origin))
      );
      if (existingRoute) {
        return {
          ...state,
          routes: state.routes.map(r =>
            r.id === existingRoute.id
              ? { ...r, weeklyFrequency: r.weeklyFrequency + weeklyFrequency }
              : r
          ),
        };
      }

      // ── Route launch cost ──────────────────────────────────────────────────────
      const launchCost = routeLaunchCost(dist);
      if (state.cash < launchCost) return state;   // can't afford to open route

      const basePrice = Math.max(1, Math.round(Number(action.ticketPrice) || 0));
      const newRoute = {
        id:              uid(),
        origin:          action.origin,
        destination:     action.destination,
        stops:           [action.origin, action.destination],
        aircraftId:      action.aircraftId,
        weeklyFrequency: weeklyFrequency,
        weeksOpen:       0,
        launchCost,
        hub:             state.hub,
        // Seasonal flights: null = year-round. seasonState tracks dormant↔active so
        // ADVANCE_WEEK only charges the reactivation fee when a season resumes.
        season:          newSeason,
        seasonState:     newSeason
          ? (isRouteActive({ season: newSeason }, weekToGameDate(state.week).monthIndex) ? 'active' : 'dormant')
          : 'active',
      };
      const updatedFleet = state.fleet.map(a =>
        a.id === action.aircraftId ? { ...a, status: 'assigned' } : a
      );
      // Price and catering are per-route (O&D pair). The first aircraft on a pair sets
      // them; additional aircraft inherit whatever the route already uses.
      const routePricing = state.routePricing ?? {};
      const newRoutePricing = routePricing[pairKey]
        ? routePricing
        : { ...routePricing, [pairKey]: defaultClassPrices(basePrice) };
      const routeCatering = state.routeCatering ?? {};
      const newRouteCatering = routeCatering[pairKey]
        ? routeCatering
        : { ...routeCatering, [pairKey]: normalizeCateringLevel(action.cateringLevel ?? state.defaultCateringLevel) };
      return {
        ...state,
        cash:          state.cash - launchCost,
        routes:        [...state.routes, newRoute],
        routePricing:  newRoutePricing,
        routeCatering: newRouteCatering,
        fleet:         updatedFleet,
      };
    }

    // ─── Tag (multi-stop) passenger routes ──────────────────────────────────────
    // One aircraft flying A→B→C(→…). Mirrors ADD_ROUTE's guards but applies them
    // per LEG (range, restrictions, block hours) and per STOP (gates, slots), and
    // stores directional per-segment fares on the route (route.segmentPrices).
    case 'ADD_TAG_ROUTE': {
      const aircraft = state.fleet.find(a => a.id === action.aircraftId);
      const type     = aircraft ? getAircraftType(aircraft.typeId) : null;
      if (!aircraft || !type) return state;
      if (type.freighter) return state;   // freighters fly cargo routes only

      // Stop list: need 3–MAX_ROUTE_STOPS distinct airports (use ADD_ROUTE for a
      // single leg; the cap is the gameplay limit on intermediate stops).
      const stops = (Array.isArray(action.stops) ? action.stops : []).filter(Boolean);
      if (stops.length < 3 || stops.length > MAX_ROUTE_STOPS) return state;
      if (new Set(stops).size !== stops.length) return state;   // no repeated airports

      const proto = { stops, origin: stops[0], destination: stops[stops.length - 1] };
      const legs  = routeLegs(proto);
      for (const l of legs) {
        if (l.from === l.to) return state;
        if (!getAirport(l.from) || !getAirport(l.to)) return state;
      }

      const weeklyFrequency = Math.max(1, Math.round(Number(action.weeklyFrequency) || 0));

      // ── Range: the LONGEST leg must be reachable (a stop extends total reach) ──
      if (routeMaxLegKm(proto) > effectiveRangeKm(aircraft, type)) return state;

      // ── Regulatory restrictions: evaluate EACH leg independently ──
      const legPairFreq = (pk) => state.routes.reduce((s, r) =>
        routeLegs(r).some(rl => routePairKey(rl.from, rl.to) === pk) ? s + (r.weeklyFrequency ?? 0) : s, 0);
      for (const l of legs) {
        const pk = routePairKey(l.from, l.to);
        if (checkRouteRestrictions(l.from, l.to, routeDistanceKm(l.from, l.to),
              legPairFreq(pk) + weeklyFrequency, type.category,
              { routes: state.routes, excludeKey: pk })) return state;
      }

      // ── Block hours: cumulative across this aircraft's routes, legs-aware ──
      const existingBlockHrs = state.routes
        .filter(r => r.aircraftId === action.aircraftId)
        .reduce((s, r) => s + routeBlockHours(r, type, r.weeklyFrequency), 0);
      if (existingBlockHrs + routeBlockHours(proto, type, weeklyFrequency) > MAX_WEEKLY_BLOCK_HOURS) return state;

      // ── Connectivity: a plane already flying can only extend from a served stop ──
      const aircraftRoutes = state.routes.filter(r => r.aircraftId === action.aircraftId);
      if (aircraftRoutes.length > 0) {
        const served = new Set(aircraftRoutes.flatMap(r => routeStops(r)));
        if (!stops.some(c => served.has(c))) return state;
      }

      // ── Gates + slots at EVERY stop (interior stops see two departures/cycle) ──
      const gates = state.gates ?? {};
      const incidentCount = (r, code) =>
        routeLegs(r).reduce((n, l) => n + (l.from === code ? 1 : 0) + (l.to === code ? 1 : 0), 0);
      const slotsUsedAt = (code) =>
        state.routes.reduce((s, r) => s + incidentCount(r, code) * (r.weeklyFrequency ?? 0), 0);
      const addIncident = {};
      for (const l of legs) {
        addIncident[l.from] = (addIncident[l.from] ?? 0) + 1;
        addIncident[l.to]   = (addIncident[l.to]   ?? 0) + 1;
      }
      for (const code of stops) {
        if (!(gates[code] > 0)) return state;   // no gate at this stop
        if (slotsUsedAt(code) + addIncident[code] * weeklyFrequency > gates[code] * SLOTS_PER_GATE) return state;
      }

      // ── Launch cost (priced on total ground distance covered) ──
      const totalDist  = legs.reduce((s, l) => s + routeDistanceKm(l.from, l.to), 0);
      const launchCost = routeLaunchCost(totalDist);
      if (state.cash < launchCost) return state;

      // ── Default directional per-segment fares (player can edit via SET_SEGMENT_PRICE) ──
      const segmentPrices = {};
      for (const seg of routeSegments(proto)) {
        const key = routeSegmentKey(seg.from, seg.to);
        const eco = Math.max(1, Math.round(routeReferencePrice(seg.from, seg.to)));
        segmentPrices[key] = action.segmentPrices?.[key] ?? defaultClassPrices(eco);
      }

      const newRoute = {
        id:              uid(),
        origin:          stops[0],
        destination:     stops[stops.length - 1],
        stops:           [...stops],
        aircraftId:      action.aircraftId,
        weeklyFrequency,
        weeksOpen:       0,
        launchCost,
        hub:             state.hub,
        segmentPrices,
        cateringLevel:   normalizeCateringLevel(action.cateringLevel ?? state.defaultCateringLevel),
      };
      const updatedFleet = state.fleet.map(a =>
        a.id === action.aircraftId ? { ...a, status: 'assigned' } : a
      );
      return {
        ...state,
        cash:   state.cash - launchCost,
        routes: [...state.routes, newRoute],
        fleet:  updatedFleet,
      };
    }

    // Update one directional segment fare on a tag route.
    case 'SET_SEGMENT_PRICE': {
      const { routeId, from, to, classPrices } = action;
      const key = routeSegmentKey(from, to);
      return {
        ...state,
        routes: state.routes.map(r => {
          if (r.id !== routeId || !r.segmentPrices?.[key]) return r;
          const eco = Math.max(1, Math.round(Number(classPrices?.economy) || r.segmentPrices[key].economy || 1));
          return {
            ...r,
            segmentPrices: {
              ...r.segmentPrices,
              [key]: { ...r.segmentPrices[key], ...classPrices, economy: eco },
            },
          };
        }),
      };
    }

    case 'ADD_GATE': {
      const { airportCode } = action;
      const current = (state.gates ?? {})[airportCode] ?? 0;
      return {
        ...state,
        gates: { ...(state.gates ?? {}), [airportCode]: current + 1 },
      };
    }

    case 'REMOVE_GATE': {
      const { airportCode } = action;
      const gates   = state.gates ?? {};
      const current = gates[airportCode] ?? 0;
      if (current === 0) return state;
      // Prevent removal if existing routes need the capacity
      const usedSlots = state.routes
        .filter(r => r.origin === airportCode || r.destination === airportCode)
        .reduce((s, r) => s + r.weeklyFrequency, 0);
      if (usedSlots > (current - 1) * SLOTS_PER_GATE) return state;
      const newGates = { ...gates };
      if (current === 1) delete newGates[airportCode];
      else newGates[airportCode] = current - 1;
      return { ...state, gates: newGates };
    }

    case 'CLOSE_ROUTE': {
      const route = state.routes.find(r => r.id === action.routeId);
      const updatedRoutes = state.routes.filter(r => r.id !== action.routeId);
      const updatedFleet = state.fleet.map(a => {
        if (a.id !== route?.aircraftId) return a;
        // Only idle the aircraft if it has no remaining routes (passenger or cargo)
        const stillActive = updatedRoutes.some(r => r.aircraftId === a.id)
          || (state.cargoRoutes ?? []).some(r => r.aircraftId === a.id);
        return { ...a, status: stillActive ? 'assigned' : 'idle' };
      });
      return { ...state, routes: updatedRoutes, fleet: updatedFleet };
    }

    // ─── Cargo routes ───────────────────────────────────────────────────────────
    // Freighters fly a parallel cargo network. Mirrors ADD_ROUTE's guards (range,
    // gates, slots, block-hours, regulatory, connectivity) but with no cabins,
    // pricing in $/tonne-km yield instead of ticket fares, and no catering.
    case 'ADD_CARGO_ROUTE': {
      const aircraft = state.fleet.find(a => a.id === action.aircraftId);
      const type     = aircraft ? getAircraftType(aircraft.typeId) : null;
      if (!aircraft || !type) return state;
      // Cargo routes require a dedicated freighter.
      if (!type.freighter) return state;
      if (action.origin === action.destination) return state;

      const weeklyFrequency = Math.max(1, Math.round(Number(action.weeklyFrequency) || 0));
      const dist = routeDistanceKm(action.origin, action.destination);

      // Range (incl. engine/wingtip rangeMod)
      const effectiveRange = effectiveRangeKm(aircraft, type);
      if (dist > effectiveRange) return state;

      // Regulatory restrictions (perimeter rules etc. apply to freighters too).
      const pairKey = [action.origin, action.destination].sort().join('-');
      const allOps  = [...state.routes, ...(state.cargoRoutes ?? [])];
      const existingPairFreq = allOps
        .filter(r => [r.origin, r.destination].sort().join('-') === pairKey)
        .reduce((s, r) => s + r.weeklyFrequency, 0);
      if (checkRouteRestrictions(action.origin, action.destination, dist, existingPairFreq + weeklyFrequency,
            type.category, { routes: allOps, excludeKey: pairKey })) return state;

      // Block-hours across this freighter's existing cargo routes.
      const existingBlockHrs = (state.cargoRoutes ?? [])
        .filter(r => r.aircraftId === action.aircraftId)
        .reduce((sum, r) => sum + weeklyBlockHours(routeDistanceKm(r.origin, r.destination), r.weeklyFrequency, type), 0);
      if (existingBlockHrs + weeklyBlockHours(dist, weeklyFrequency, type) > MAX_WEEKLY_BLOCK_HOURS) return state;

      // Network connectivity: a freighter already flying can only extend from airports it serves.
      const acCargoRoutes = (state.cargoRoutes ?? []).filter(r => r.aircraftId === action.aircraftId);
      if (acCargoRoutes.length > 0) {
        const served = new Set(acCargoRoutes.flatMap(r => [r.origin, r.destination]));
        if (!served.has(action.origin) && !served.has(action.destination)) return state;
      }

      // Gates required at both endpoints; slots counted across passenger + cargo ops.
      const gates = state.gates ?? {};
      if (!(gates[action.origin] > 0))      return state;
      if (!(gates[action.destination] > 0)) return state;
      const slotsAt = (code) => allOps
        .filter(r => r.origin === code || r.destination === code)
        .reduce((s, r) => s + r.weeklyFrequency, 0);
      if (slotsAt(action.origin)      + weeklyFrequency > gates[action.origin]      * SLOTS_PER_GATE) return state;
      if (slotsAt(action.destination) + weeklyFrequency > gates[action.destination] * SLOTS_PER_GATE) return state;

      // Consolidate onto an existing identical cargo route for this freighter.
      const existingRoute = (state.cargoRoutes ?? []).find(r =>
        r.aircraftId === action.aircraftId &&
        ((r.origin === action.origin && r.destination === action.destination) ||
         (r.origin === action.destination && r.destination === action.origin))
      );
      if (existingRoute) {
        return {
          ...state,
          cargoRoutes: state.cargoRoutes.map(r =>
            r.id === existingRoute.id
              ? { ...r, weeklyFrequency: r.weeklyFrequency + weeklyFrequency }
              : r
          ),
        };
      }

      const launchCost = routeLaunchCost(dist);
      if (state.cash < launchCost) return state;

      const refYield   = cargoReferenceYield(action.origin, action.destination);
      const yieldPrice = action.yieldPrice != null
        ? Math.max(0.01, Number(action.yieldPrice))
        : refYield;

      const newRoute = {
        id:              uid(),
        origin:          action.origin,
        destination:     action.destination,
        aircraftId:      action.aircraftId,
        yieldPrice,
        weeklyFrequency,
        weeksOpen:       0,
        launchCost,
        hub:             state.hub,
        cargo:           true,
      };
      const updatedFleet = state.fleet.map(a =>
        a.id === action.aircraftId ? { ...a, status: 'assigned' } : a
      );
      return {
        ...state,
        cash:        state.cash - launchCost,
        cargoRoutes: [...(state.cargoRoutes ?? []), newRoute],
        fleet:       updatedFleet,
      };
    }

    case 'CLOSE_CARGO_ROUTE': {
      const route = (state.cargoRoutes ?? []).find(r => r.id === action.routeId);
      const updatedCargo = (state.cargoRoutes ?? []).filter(r => r.id !== action.routeId);
      const updatedFleet = state.fleet.map(a => {
        if (a.id !== route?.aircraftId) return a;
        const stillActive = updatedCargo.some(r => r.aircraftId === a.id)
          || state.routes.some(r => r.aircraftId === a.id);
        return { ...a, status: stillActive ? 'assigned' : 'idle' };
      });
      return { ...state, cargoRoutes: updatedCargo, fleet: updatedFleet };
    }

    case 'UPDATE_CARGO_FREQUENCY': {
      const targetRoute = (state.cargoRoutes ?? []).find(r => r.id === action.routeId);
      if (!targetRoute) return state;
      const ac   = state.fleet.find(a => a.id === targetRoute.aircraftId);
      const type = ac ? getAircraftType(ac.typeId) : null;
      const newFreq = Math.max(1, Math.round(Number(action.weeklyFrequency) || 0));

      if (type) {
        const otherBlockHrs = (state.cargoRoutes ?? [])
          .filter(r => r.aircraftId === targetRoute.aircraftId && r.id !== targetRoute.id)
          .reduce((s, r) => s + weeklyBlockHours(routeDistanceKm(r.origin, r.destination), r.weeklyFrequency, type), 0);
        if (otherBlockHrs + weeklyBlockHours(routeDistanceKm(targetRoute.origin, targetRoute.destination), newFreq, type) > MAX_WEEKLY_BLOCK_HOURS) return state;

        const gates = state.gates ?? {};
        const allOps = [...state.routes, ...(state.cargoRoutes ?? [])];
        const slotsAt = (code) => allOps
          .filter(r => r.id !== targetRoute.id && (r.origin === code || r.destination === code))
          .reduce((s, r) => s + r.weeklyFrequency, 0);
        if (slotsAt(targetRoute.origin)      + newFreq > (gates[targetRoute.origin]      ?? 0) * SLOTS_PER_GATE) return state;
        if (slotsAt(targetRoute.destination) + newFreq > (gates[targetRoute.destination] ?? 0) * SLOTS_PER_GATE) return state;
      }

      return {
        ...state,
        cargoRoutes: state.cargoRoutes.map(r =>
          r.id === action.routeId ? { ...r, weeklyFrequency: newFreq } : r
        ),
      };
    }

    case 'UPDATE_CARGO_YIELD': {
      // action: { routeId, yieldPrice } — $/tonne-km, clamped positive
      const yieldPrice = Math.max(0.01, Number(action.yieldPrice) || 0.01);
      return {
        ...state,
        cargoRoutes: (state.cargoRoutes ?? []).map(r =>
          r.id === action.routeId ? { ...r, yieldPrice } : r
        ),
      };
    }

    // ── Hub management ────────────────────────────────────────────────────────

    case 'DESIGNATE_HUB': {
      const gateCount = (state.gates ?? {})[action.airportCode] ?? 0;
      if (gateCount < HUB_MIN_GATES) return state;  // need 10 gates minimum
      if ((state.hubs ?? {})[action.airportCode]) return state;  // already a hub
      // Political restriction: hubs only permitted in home country
      const airportCountry = getAirport(action.airportCode)?.country;
      if (state.homeCountry && airportCountry !== state.homeCountry) return state;
      return {
        ...state,
        hubs: { ...(state.hubs ?? {}), [action.airportCode]: { tier: 1 } },
      };
    }

    case 'UPGRADE_HUB': {
      const hubs        = state.hubs ?? {};
      const hubInfo     = hubs[action.airportCode];
      if (!hubInfo || hubInfo.tier >= HUB_TIER_COUNT) return state;
      const newTier     = hubInfo.tier + 1;
      const tierDef     = HUB_TIERS[newTier];
      const gateCount   = (state.gates ?? {})[action.airportCode] ?? 0;
      if (gateCount < tierDef.minGates) return state;
      return {
        ...state,
        hubs: { ...hubs, [action.airportCode]: { tier: newTier } },
      };
    }

    case 'DOWNGRADE_HUB': {
      const hubs    = state.hubs ?? {};
      const hubInfo = hubs[action.airportCode];
      if (!hubInfo) return state;
      if (hubInfo.tier <= 1) {
        // Remove hub designation entirely
        const newHubs = { ...hubs };
        delete newHubs[action.airportCode];
        return { ...state, hubs: newHubs };
      }
      return {
        ...state,
        hubs: { ...hubs, [action.airportCode]: { tier: hubInfo.tier - 1 } },
      };
    }

    // ──────────────────────────────────────────────────────────────────────────

    case 'UPDATE_TICKET_PRICE': {
      // Legacy: update economy price only, keep other classes in sync.
      // Clamp to a sane positive fare: a 0 or negative price feeds the elasticity
      // model Math.pow(ref/price, …), producing Infinity/NaN that poisons the
      // whole weekly tick (revenue → cashDelta → cash all become NaN).
      // Price belongs to the O&D pair. Resolve the pair from the route, then update
      // its economy fare in routePricing — every aircraft on the pair shares it.
      const tpTarget = state.routes.find(r => r.id === action.routeId);
      if (!tpTarget) return state;
      // Clamp to [1, cap]: the upper bound (PRICE_CAP_MULTIPLE × reference) stops
      // players exploiting the demand curve's flat tail with absurd fares.
      const tpRefP = mktReferencePrice(tpTarget.origin, tpTarget.destination);
      const price  = clampClassPrice(action.ticketPrice, tpRefP, 'economy');
      const tpKey  = routePairKey(tpTarget.origin, tpTarget.destination);
      const tpPrev = state.routePricing?.[tpKey] ?? defaultClassPrices(price);
      return {
        ...state,
        routePricing: { ...state.routePricing, [tpKey]: { ...tpPrev, economy: price } },
      };
    }

    // Set individual class prices without touching others
    case 'UPDATE_CLASS_PRICES': {
      // action: { routeId, updates: { economy?, premiumEconomy?, businessClass?, firstClass? } }
      const cpTarget = state.routes.find(r => r.id === action.routeId);
      if (!cpTarget) return state;
      // Sanitize each provided fare to a positive integer and clamp to its
      // per-class ceiling (PRICE_CAP_MULTIPLE × that class's reference fare).
      const cpRefP = mktReferencePrice(cpTarget.origin, cpTarget.destination);
      const cleanUpdates = {};
      for (const [k, v] of Object.entries(action.updates ?? {})) {
        cleanUpdates[k] = clampClassPrice(v, cpRefP, k);
      }
      // Per-O&D-pair pricing: merge the class updates into the pair's price set.
      const cpKey  = routePairKey(cpTarget.origin, cpTarget.destination);
      const cpPrev = state.routePricing?.[cpKey]
        ?? defaultClassPrices(cleanUpdates.economy ?? mktReferencePrice(cpTarget.origin, cpTarget.destination));
      return {
        ...state,
        routePricing: { ...state.routePricing, [cpKey]: { ...cpPrev, ...cleanUpdates } },
      };
    }

    case 'UPDATE_FREQUENCY': {
      const targetRoute = state.routes.find(r => r.id === action.routeId);
      if (!targetRoute) return state;
      const freqAircraft = state.fleet.find(a => a.id === targetRoute.aircraftId);
      const freqType     = freqAircraft ? getAircraftType(freqAircraft.typeId) : null;
      const newFreq      = Math.max(1, Math.round(Number(action.weeklyFrequency) || 0));

      if (freqType) {
        // Block-hours: sum all other routes on this aircraft + this route at new freq
        const otherBlockHrs = state.routes
          .filter(r => r.aircraftId === targetRoute.aircraftId && r.id !== targetRoute.id)
          .reduce((s, r) => s + weeklyBlockHours(routeDistanceKm(r.origin, r.destination), r.weeklyFrequency, freqType), 0);
        const newBlockHrs = weeklyBlockHours(routeDistanceKm(targetRoute.origin, targetRoute.destination), newFreq, freqType);
        if (otherBlockHrs + newBlockHrs > MAX_WEEKLY_BLOCK_HOURS) return state;

        // Gate/slot check: slots used by all other routes at each endpoint + new freq
        const gates = state.gates ?? {};
        const slotsAt = (code) => state.routes
          .filter(r => r.id !== targetRoute.id && (r.origin === code || r.destination === code))
          .reduce((s, r) => s + r.weeklyFrequency, 0);
        if (slotsAt(targetRoute.origin)      + newFreq > (gates[targetRoute.origin]      ?? 0) * SLOTS_PER_GATE) return state;
        if (slotsAt(targetRoute.destination) + newFreq > (gates[targetRoute.destination] ?? 0) * SLOTS_PER_GATE) return state;
      }

      return {
        ...state,
        routes: state.routes.map(r =>
          r.id === action.routeId ? { ...r, weeklyFrequency: newFreq } : r
        ),
      };
    }

    // Set the catering service level on one route, or several at once
    // (e.g. all routes on a city-pair). action: { routeId? , routeIds?, level }
    case 'SET_ROUTE_CATERING': {
      const level = normalizeCateringLevel(action.level);
      const ids = new Set(action.routeIds ?? (action.routeId ? [action.routeId] : []));
      if (ids.size === 0) return state;
      // Catering belongs to the O&D pair. Resolve the affected pairs from the routes,
      // then set the level once per pair (covers every aircraft on it).
      const keys = new Set(
        state.routes.filter(r => ids.has(r.id)).map(r => routePairKey(r.origin, r.destination))
      );
      if (keys.size === 0) return state;
      const routeCatering = { ...(state.routeCatering ?? {}) };
      for (const k of keys) routeCatering[k] = level;
      return { ...state, routeCatering };
    }

    // Airline-wide default catering level applied to newly-opened routes.
    case 'SET_DEFAULT_CATERING': {
      return { ...state, defaultCateringLevel: normalizeCateringLevel(action.level) };
    }

    case 'SET_LABOR_PAY': {
      // action: { group: 'pilots' | 'cabinCrew' | 'groundStaff' | 'maintenanceTeam', payMultiplier: number }
      const current = state.labor ?? DEFAULT_LABOR_STATE;
      return {
        ...state,
        labor: {
          ...current,
          [action.group]: {
            ...(current[action.group] ?? { payMultiplier: 1.0, morale: 80 }),
            payMultiplier: Math.max(0.5, Math.min(2.0, action.payMultiplier)),
          },
        },
      };
    }

    case 'SET_MAINTENANCE_BUDGET': {
      return {
        ...state,
        maintenanceBudget: Math.max(0.5, Math.min(2.0, action.multiplier)),
      };
    }

    case 'SET_MARKETING_BUDGET': {
      // action: { amount } — weekly spend in dollars, 0 = no marketing
      return {
        ...state,
        marketingBudget: Math.max(0, Math.round(action.amount)),
      };
    }

    case 'RENEW_LEASE': {
      // action: { aircraftId } — reset lease countdown to full term (same rate)
      return {
        ...state,
        fleet: state.fleet.map(a =>
          a.id === action.aircraftId && a.ownershipType === 'lease'
            ? { ...a, leaseRemainingWeeks: a.leaseTermWeeks ?? 104 }
            : a
        ),
      };
    }

    case 'SET_LOYALTY_INVESTMENT': {
      // action: { amount } — weekly spend in dollars, 0 = no program
      return {
        ...state,
        loyalty: {
          ...(state.loyalty ?? { members: 0 }),
          weeklyInvestment: Math.max(0, Math.round(action.amount)),
        },
      };
    }

    // ─── Alliance & codeshare actions ───────────────────────────────────────

    case 'JOIN_ALLIANCE': {
      // action: { allianceId }
      const alliance = getAlliance(action.allianceId);
      if (!alliance) return state;
      if (state.cash < alliance.initiationFee) return state;
      if (state.allianceMembership) return state; // already in one
      return {
        ...state,
        cash: state.cash - alliance.initiationFee,
        allianceMembership: {
          allianceId: alliance.id,
          joinedWeek: state.week,
          weeklyFee:  alliance.weeklyFee,
        },
      };
    }

    case 'LEAVE_ALLIANCE': {
      return { ...state, allianceMembership: null };
    }

    case 'SIGN_CODESHARE': {
      // action: { competitorId }
      const activeAgreements = state.codeshareAgreements ?? [];
      if (activeAgreements.length >= MAX_CODESHARE_AGREEMENTS) return state;
      if (activeAgreements.some(a => a.competitorId === action.competitorId)) return state;

      const comp = (state.competitors ?? []).find(c => c.id === action.competitorId);
      if (!comp) return state;

      const weeklyFee = CODESHARE_WEEKLY_FEE_BY_TIER[comp.tier] ?? CODESHARE_WEEKLY_FEE_BY_TIER.legacy;
      const newAgreement = {
        id:              uid(),
        competitorId:    comp.id,
        competitorName:  comp.name,
        competitorTier:  comp.tier,
        weeklyFee,
        signedWeek:      state.week,
        signedYear:      state.year,
        weeksRemaining:  CODESHARE_DURATION_WEEKS,
      };
      return {
        ...state,
        codeshareAgreements: [...activeAgreements, newAgreement],
      };
    }

    case 'CANCEL_CODESHARE': {
      // action: { agreementId }
      return {
        ...state,
        codeshareAgreements: (state.codeshareAgreements ?? []).filter(a => a.id !== action.agreementId),
      };
    }

    case 'ACQUIRE_COMPETITOR': {
      // action: { competitorId }
      const target = (state.competitors ?? []).find(c => c.id === action.competitorId);
      if (!target) return state;

      // Value the target. marketCap is only populated after the first weekly tick;
      // fall back to a computed valuation so a fresh-game competitor can never be
      // acquired for $0 (which would also hand the player their cash for free).
      const targetValue = target.marketCap
        ?? computeMarketCap(target.profitHistory ?? [], target.cash ?? 0, target.baseQualityScore ?? 50).marketCap;
      const acquisitionCost = Math.round(targetValue * 1.25);
      if (state.cash < acquisitionCost) return state;  // can't afford — ignore

      // ── Inherit the competitor's REAL fleet ────────────────────────────────
      // Each competitor tail becomes an owned player aircraft (kept aged, flagged
      // `acquired`). We remember oldTailId → new player id so routes can be wired
      // to the correct airframe.
      const usedTails    = state.fleet.map(a => a.tailNumber).filter(Boolean);
      const tailIdMap    = {};        // competitor tail id → new player aircraft id
      const tailsByRoute = {};        // routeKey → [new player aircraft ids]
      const acquiredFleet = (target.fleet ?? []).map(tail => {
        const type       = getAircraftType(tail.typeId);
        const newId      = uid();
        const tailNumber = generateTailNumber(state.hub, state.airlineName, usedTails);
        usedTails.push(tailNumber);
        tailIdMap[tail.id] = newId;
        (tailsByRoute[tail.routeKey] ??= []).push(newId);
        return {
          id:            newId,
          typeId:        tail.typeId,
          name:          `${type?.name ?? tail.typeId} (ex-${target.name})`,
          tailNumber,
          status:        'idle',   // set to 'assigned' below if it takes a route
          ageWeeks:      tail.ageWeeks ?? 0,
          config:        defaultConfig(type?.seats ?? 150),
          ownershipType: 'owned',
          acquired:      true,
        };
      });

      // ── Inherit routes, assigning ONE tail each (player model = 1 aircraft/route).
      // Frequency is capped to what a single airframe can fly; surplus tails stay
      // idle in the fleet, ready to redeploy.
      const assignedIds    = new Set();
      const slotsByAirport = {};
      const inheritedRoutes = Object.entries(target.routes ?? {}).map(([key, cfg]) => {
        const [a, b] = key.split('-');
        const refP   = mktReferencePrice(a, b);
        const dist   = routeDistanceKm(a, b);

        // Take the first available inherited tail on this route as the operator.
        const poolIds   = tailsByRoute[key] ?? [];
        const opId      = poolIds.find(id => !assignedIds.has(id)) ?? null;
        const opType    = opId ? getAircraftType(acquiredFleet.find(f => f.id === opId)?.typeId) : null;
        if (opId) assignedIds.add(opId);

        // Cap frequency to a single tail's block-hour limit.
        const cap  = opType ? Math.max(1, maxFrequency(dist, opType)) : (cfg.frequency ?? 7);
        const freq = Math.min(cfg.frequency ?? 7, cap);

        slotsByAirport[a] = (slotsByAirport[a] ?? 0) + freq;
        slotsByAirport[b] = (slotsByAirport[b] ?? 0) + freq;

        const basePrice = Math.round(refP * (cfg.priceMultiplier ?? 1));
        return {
          id:              uid(),
          origin:          a,
          destination:     b,
          aircraftId:      opId,
          weeklyFrequency: freq,
          hub:             state.hub,
          weeksOpen:       0,
          inherited:       true,
          _basePrice:      basePrice,   // transient: folded into routePricing below
        };
      });

      // Price/cater the inherited pairs (one set per O&D). Don't clobber a pair the
      // player already operates — they keep their own settings on overlapping routes.
      const acquiredPricing  = { ...(state.routePricing  ?? {}) };
      const acquiredCatering = { ...(state.routeCatering ?? {}) };
      const inheritedCatering = normalizeCateringLevel(state.defaultCateringLevel);
      for (const r of inheritedRoutes) {
        const key = routePairKey(r.origin, r.destination);
        if (!acquiredPricing[key])  acquiredPricing[key]  = defaultClassPrices(r._basePrice);
        if (!acquiredCatering[key]) acquiredCatering[key] = inheritedCatering;
        delete r._basePrice;
      }

      // Mark assigned tails as such.
      const acquiredFleetFinal = acquiredFleet.map(f =>
        assignedIds.has(f.id) ? { ...f, status: 'assigned' } : f
      );

      // Grant gate slots at every airport the competitor served (plus home hub),
      // sized to cover inherited route slots, merged with existing gates.
      const newGates = { ...(state.gates ?? {}) };
      for (const [code, slots] of Object.entries(slotsByAirport)) {
        newGates[code] = (newGates[code] ?? 0) + Math.max(1, Math.ceil(slots / SLOTS_PER_GATE));
      }
      if (target.homeHub) {
        newGates[target.homeHub] = Math.max(newGates[target.homeHub] ?? 0, 2);
      }
      const gatesGained = Object.values(newGates).reduce((s, v) => s + v, 0)
                        - Object.values(state.gates ?? {}).reduce((s, v) => s + v, 0);

      // Cancel any codeshare with the acquired competitor.
      const cleanedCodeshares = (state.codeshareAgreements ?? [])
        .filter(a => a.competitorId !== target.id);

      const surplus = acquiredFleetFinal.length - assignedIds.size;

      // ── Win condition: the last rival has been absorbed ────────────────────
      const remainingCompetitors = (state.competitors ?? []).filter(c => c.id !== target.id);
      const finalFleet  = [...state.fleet, ...acquiredFleetFinal];
      const hasWon      = remainingCompetitors.length === 0 && !state.gameWon;
      const victoryStats = hasWon ? {
        marketCap:    state.marketCap ?? null,
        cash:         state.cash - acquisitionCost + (target.cash ?? 0),
        fleetCount:   finalFleet.filter(a => a.status !== 'retired').length,
        routeCount:   state.routes.length + inheritedRoutes.length,
        airports:     Object.values(newGates).filter(n => n > 0).length,
        weeksPlayed:  (state.year - 1) * 52 + state.week,
        year:         state.year,
        lastRival:    target.name,
      } : null;

      const acquireToasts = [
        {
          type: 'success',
          icon: '🤝',
          title: `Acquired ${target.name}`,
          message: `+${inheritedRoutes.length} routes · +${acquiredFleetFinal.length} aircraft`
                 + `${surplus > 0 ? ` (${surplus} spare)` : ''} · +${gatesGained} gates`,
          duration: 8000,
        },
      ];

      return {
        ...state,
        cash:                state.cash - acquisitionCost + (target.cash ?? 0),
        routes:              [...state.routes, ...inheritedRoutes],
        routePricing:        acquiredPricing,
        routeCatering:       acquiredCatering,
        fleet:               finalFleet,
        gates:               newGates,
        competitors:         remainingCompetitors,
        codeshareAgreements: cleanedCodeshares,
        gameWon:             state.gameWon || hasWon,
        victoryStats:        hasWon ? victoryStats : state.victoryStats,
        victoryAcknowledged: hasWon ? false : state.victoryAcknowledged,
        pendingToasts: [ ...(state.pendingToasts ?? []), ...acquireToasts ],
      };
    }

    case 'ACKNOWLEDGE_VICTORY':
      return { ...state, victoryAcknowledged: true };

    case 'ADVANCE_WEEK': { try {
      // ── Events: tick existing, roll for new ──────────────────────────────
      const { updated: survivingEvents, expired: expiredEvents } =
        tickEvents(state.activeEvents ?? []);
      const newEvents  = rollEvents(survivingEvents);
      const allEvents  = [...survivingEvents, ...newEvents];

      // ── Compute event effects on this week's finances ──────────────────
      let fuelMult         = 1.0;
      let globalDemandMult = 1.0;
      for (const ev of allEvents) {
        const fx = ev.effects ?? {};
        if (fx.fuelMult)         fuelMult         *= fx.fuelMult;
        if (fx.globalDemandMult) globalDemandMult *= fx.globalDemandMult;
      }

      // ── Fuel price + hedging ──────────────────────────────────────────
      const currentFuelIndex = state.fuelPrice?.index ?? 1.0;
      const nowAbsWeek       = absoluteWeek(state.year, state.week);
      const allHedges        = state.hedgeContracts ?? [];
      const activeHedges     = allHedges.filter(h => h.expiryAbsWeek > nowAbsWeek);
      // effectiveFuelMultiplier blends hedged (locked price) + unhedged (market index),
      // then scaled by any active event fuel multiplier so the event flows through simulation
      const fuelMultiplier   = effectiveFuelMultiplier(currentFuelIndex, activeHedges) * fuelMult;
      // Tick market price for NEXT week
      const nextFuelIndex    = tickFuelPrice(currentFuelIndex);
      const fuelPriceHistory = [...(state.fuelPrice?.history ?? []), currentFuelIndex].slice(-52);
      // Drop contracts that have now expired
      const liveHedges       = allHedges.filter(h => h.expiryAbsWeek > nowAbsWeek);

      // Age + mechanical tick must run BEFORE weeklyTick so that aircraft recovering
      // from grounding this week can actually fly and earn revenue.
      const mainBudgetPre = state.maintenanceBudget ?? 1.0;
      const agingRatePre  = Math.max(0.5, 1 + (1 - mainBudgetPre) * 0.5);

      // Tick down existing grounded aircraft (decrement groundedWeeksLeft) so any
      // aircraft returning from repair this week is 'assigned'/'idle' when passed to weeklyTick.
      const tickedFleetPre = state.fleet.map(a => {
        if (a.status !== 'grounded') return a;
        const weeksLeft = (a.groundedWeeksLeft ?? 1) - 1;
        if (weeksLeft <= 0) {
          const hasRoute = state.routes.some(r => r.aircraftId === a.id);
          return { ...a, status: hasRoute ? 'assigned' : 'idle', groundedWeeksLeft: 0 };
        }
        return { ...a, groundedWeeksLeft: weeksLeft };
      });

      // Current in-game month (1-12) drives seasonal demand. Must match the
      // weekToMonth() formula used by the RoutePlanner/RouteDetail previews so the
      // forecast the player sees agrees with the actual weekly result. Without this,
      // weeklyTick falls back to its { month: 6 } default and seasonality is inert.
      const gameMonth = weekToGameDate(state.week).monthIndex;
      const gameDate  = { week: state.week, month: gameMonth };

      // ── Seasonal flights: dormant↔active transitions ─────────────────────────
      // A seasonal route resuming service this month pays a reactivation fee of
      // 1/3 of its launch cost. Going dormant is free. seasonState is tracked per
      // route so the fee is charged once per season, not every week it operates.
      let seasonalReactivationCost = 0;
      const seasonalReactivations  = [];
      const seasonAdjustedRoutes = state.routes.map(r => {
        if (!r.season) return r;
        const shouldBeActive = isRouteActive(r, gameMonth);
        const prevState = r.seasonState ?? (shouldBeActive ? 'active' : 'dormant');
        if (shouldBeActive && prevState === 'dormant') {
          const fee = Math.round(routeLaunchCost(routeDistanceKm(r.origin, r.destination)) / 3);
          seasonalReactivationCost += fee;
          seasonalReactivations.push({ origin: r.origin, destination: r.destination, fee });
          return { ...r, seasonState: 'active' };
        }
        if (!shouldBeActive && prevState === 'active') {
          return { ...r, seasonState: 'dormant' };
        }
        return { ...r, seasonState: prevState };
      });

      // ── Route encroachment: AI carriers contest the player's fat routes ──────
      // Decided from the PRIOR week's outcome (load factor + fares), gated by airline
      // size, then injected into this week's demand model so they split passengers.
      const { encroachments: updatedEncroachments, events: encroachEvents } = tickEncroachment({
        // Dormant seasonal routes aren't in the market this month, so AI carriers
        // shouldn't contest them or count their (idle) frequency on the pair.
        routes:       state.routes
          .filter(r => isRouteActive(r, gameMonth))
          .map(r => hydrateRoute(r, state.routePricing, state.routeCatering)),
        routePricing: state.routePricing,
        lastReport:   state.lastReport,
        marketCap:    state.marketCap ?? 0,
        competitors:  state.competitors ?? [],
        encroachments: state.encroachments ?? {},
      });

      const report = weeklyTick({ ...state, fleet: tickedFleetPre, fuelMultiplier, loyalty: state.loyalty, gameDate, encroachments: updatedEncroachments });

      // ── Loyalty program: grow/decay member base ──────────────────────────
      // Penetration-based S-curve. Enrollment slows as the base approaches the
      // tier's penetration ceiling (you can't enrol people who already belong),
      // so reaching a deep, mature program takes sustained investment in a high
      // tier rather than being an instant win. A ramped "effective" budget gives
      // the dial inertia so changing it isn't a light switch.
      const currentLoyalty = state.loyalty ?? { weeklyInvestment: 0, members: 0, effInvestment: 0 };
      const targetInvestment = currentLoyalty.weeklyInvestment ?? 0;
      const prevEff          = currentLoyalty.effInvestment ?? targetInvestment;
      // Ease ~18%/week toward the set budget (≈63% of a change felt after 5 weeks).
      const effInvestment    = Math.round(prevEff + (targetInvestment - prevEff) * 0.18);

      const loyaltyWeeklyPax = report.totalPassengers ?? 0;
      let newLoyaltyMembers  = currentLoyalty.members ?? 0;
      if (effInvestment > 0 && loyaltyWeeklyPax > 0) {
        const tier      = loyaltyTier(effInvestment);
        const enrollPull = loyaltyEnrollPull(effInvestment);
        const ceiling   = tier.maxPenetration * loyaltyWeeklyPax * 4;   // max members this tier sustains
        const headroom  = ceiling > 0 ? Math.max(0, 1 - newLoyaltyMembers / ceiling) : 0;
        const newEnrollments = Math.round(loyaltyWeeklyPax * enrollPull * headroom);
        // 0.4% weekly churn when funded — real frequent-flyer accounts are sticky.
        newLoyaltyMembers = Math.round(newLoyaltyMembers * 0.996 + newEnrollments);
      } else {
        // Program unfunded: 1.2% weekly decay (gradual lapse, not a cliff).
        newLoyaltyMembers = Math.round(newLoyaltyMembers * 0.988);
      }
      const updatedLoyalty = { ...currentLoyalty, members: Math.max(0, newLoyaltyMembers), effInvestment };

      // ── Awareness: grows from operations + marketing, decays without activity ──
      // Organic: passengers flying builds word-of-mouth. Marketing accelerates growth.
      // Diminishing returns: harder to grow from 80→100 than 5→80.
      const currentAwareness = state.awareness ?? 5;
      const diminishingFactor = 1 - currentAwareness / 100;
      const organicGain   = Math.min(1.0, (report.totalPassengers ?? 0) / 1000) * diminishingFactor;
      const mktGain       = Math.min(2.0, (state.marketingBudget ?? 0) / 25000) * diminishingFactor;
      // Slow natural decay — stops at 5 (airline stays findable even without active marketing)
      const awarenessDecay = state.routes.length === 0 ? 0.5 : 0.05;
      const newAwareness   = Math.max(5, Math.min(100,
        currentAwareness + organicGain + mktGain - awarenessDecay
      ));

      // Apply event demand multiplier as a line-item adjustment to the report.
      // (fuelMult is already baked into fuelMultiplier above, so no separate fuel adj needed.)
      const eventDemandAdj  = report.totalRevenue ? report.totalRevenue * (globalDemandMult - 1.0) : 0;
      const adjustedCashDelta = report.cashDelta + eventDemandAdj;

      // agingRate and tickedFleet were computed before weeklyTick above.
      const mainBudget = mainBudgetPre;
      const agingRate  = agingRatePre;

      // ── Mechanical failures ──────────────────────────────────────────────
      // tickedFleet (grounded countdown tick) was already applied before weeklyTick.
      const tickedFleet = tickedFleetPre;

      // 2. Roll for new failures on non-grounded aircraft
      const newFailures = rollMechanicalFailures(tickedFleet, mainBudget);
      const failedIds   = new Set(newFailures.map(f => f.aircraftId));

      // 3. Apply failures + age + lease countdown
      let leaseRedeliveryCost = 0;
      const expiredLeaseIds   = new Set();
      const leaseWarningToasts = [];

      // ── Toast configs for new / expired events ─────────────────────────
      // NOTE: leaseWarningToasts is populated inside the agedFleet.map() below,
      // so it must be pushed in AFTER that loop (not spread here at construction time).
      const newToasts = [
        ...newEvents.map(ev => ({
          type: ev.type === 'fuel' || ev.type === 'disruption' || ev.type === 'economy'
            ? (ev.effects?.fuelMult > 1 || ev.effects?.globalDemandMult < 1 || ev.effects?.regionDemandMult < 1
                ? 'danger' : 'success')
            : (ev.effects?.globalDemandMult > 1 || ev.effects?.regionDemandMult > 1 ? 'success' : 'warning'),
          title: ev.name,
          message: ev.description,
          icon: ev.icon,
          eventColor: ev.color,
          duration: 7000,
        })),
        ...expiredEvents.map(ev => ({
          type: 'info',
          title: `${ev.name} — ended`,
          message: `The event has resolved after ${ev.totalDur} week${ev.totalDur !== 1 ? 's' : ''}.`,
          icon: ev.icon,
          duration: 4000,
        })),
      ];
      if (seasonalReactivations.length > 0) {
        const list = seasonalReactivations.map(r => `${r.origin}–${r.destination}`).join(', ');
        newToasts.push({
          type:    'info',
          title:   `🗓 Seasonal route${seasonalReactivations.length > 1 ? 's' : ''} resumed`,
          message: `${list} back in service. Reactivation fee: ${seasonalReactivationCost.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}.`,
          icon:    '🗓',
          duration: 7000,
        });
      }
      const agedFleet = tickedFleet.map(a => {
        const aged = { ...a, ageWeeks: (a.ageWeeks ?? 0) + agingRate };
        if (failedIds.has(a.id)) {
          const failure = newFailures.find(f => f.aircraftId === a.id);
          return { ...aged, status: 'grounded', groundedWeeksLeft: failure.weeksGrounded };
        }
        // Tick lease countdown for leased aircraft
        if (a.ownershipType === 'lease' && (a.leaseRemainingWeeks ?? 0) > 0) {
          const remaining = (a.leaseRemainingWeeks ?? 0) - 1;
          // Warn at 8 and 4 weeks remaining
          if (remaining === 8 || remaining === 4) {
            const type = getAircraftType(a.typeId);
            leaseWarningToasts.push({
              type:     'warning',
              title:    `⏳ Lease expiring — ${a.name}`,
              message:  `${remaining} weeks remaining on ${a.name}'s lease. Renew in Fleet or pay early-termination fees to return.`,
              duration: 8000,
            });
          }
          // Lease expired: charge redelivery fee (4 weeks of rent) and remove
          if (remaining <= 0) {
            const type = getAircraftType(a.typeId);
            leaseRedeliveryCost += (type?.weeklyLease ?? 0) * 4;
            expiredLeaseIds.add(a.id);
            leaseWarningToasts.push({
              type:     'danger',
              title:    `📋 Lease ended — ${a.name}`,
              message:  `${a.name}'s lease has expired. Aircraft returned; redelivery fee of ${((type?.weeklyLease ?? 0) * 4).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })} charged.`,
              duration: 10000,
            });
            return null; // mark for removal
          }
          return { ...aged, leaseRemainingWeeks: remaining };
        }
        return aged;
      }).filter(Boolean);

      // 4. Build failure toasts
      const failureToasts = newFailures.map(f => ({
        type:    'danger',
        title:   `${f.icon} Mechanical Failure — ${f.aircraftName}`,
        message: `${f.label} detected on ${f.tailNumber || f.aircraftName}. Grounded for ${f.weeksGrounded} week${f.weeksGrounded !== 1 ? 's' : ''}.`,
        icon:    f.icon,
        duration: 8000,
      }));

      // 5. Build recovery toasts (aircraft that just came back from grounding).
      //    Detect from the PRE-tick fleet (state.fleet): an aircraft recovers this
      //    week if it was grounded with ≤1 week left, since tickedFleetPre has
      //    already flipped it back to assigned/idle. Reading tickedFleet here would
      //    instead match aircraft that are STILL grounded for one more week.
      const recoveredAircraft = state.fleet
        .filter(a => a.status === 'grounded' && (a.groundedWeeksLeft ?? 1) <= 1)
        .filter(a => !failedIds.has(a.id)); // don't re-announce ones that just failed again
      const recoveryToasts = recoveredAircraft.map(a => ({
        type:    'success',
        title:   `✅ Back in Service — ${a.name}`,
        message: `${a.tailNumber || a.name} has completed repairs and returned to service.`,
        icon:    '✅',
        duration: 5000,
      }));

      // Merge lease warnings, failures, and recovery toasts in (after agedFleet is built)
      newToasts.push(...leaseWarningToasts, ...failureToasts, ...recoveryToasts);

      // Encroachment notifications — a rival entering or leaving one of your routes.
      for (const ev of encroachEvents ?? []) {
        if (ev.type === 'enter') {
          newToasts.push({
            type: 'warning', icon: '🪧',
            title: `${ev.name} entered ${ev.origin}–${ev.destination}`,
            message: `${ev.name} sees your fares on ${ev.origin}–${ev.destination} and has launched a competing service. Expect to lose some traffic unless you respond on price or frequency.`,
            duration: 9000,
          });
        } else if (ev.type === 'exit') {
          newToasts.push({
            type: 'success', icon: '🏳️',
            title: `Competitor withdrew from a route`,
            message: `A rival has pulled out of one of your routes — the lane is yours again.`,
            duration: 6000,
          });
        }
      }

      // Morale drifts toward target (based on pay) at 12% per week
      const currentLabor = state.labor ?? DEFAULT_LABOR_STATE;
      const updatedLabor = {};
      for (const [id, g] of Object.entries(currentLabor)) {
        const target   = moraleTarget(g.payMultiplier);
        const newMorale = g.morale + (target - g.morale) * 0.12;
        updatedLabor[id] = { ...g, morale: Math.max(5, Math.min(100, Math.round(newMorale * 10) / 10)) };
      }

      // ── Loan repayments ──────────────────────────────────────────────────
      const currentLoans = state.loans ?? [];
      let totalLoanPayments = 0;
      let totalLoanInterest = 0;
      const updatedLoans = currentLoans
        .map(loan => {
          if (loan.weeksRemaining <= 0) return null;
          const weeklyRate = loan.interestRate / 52;
          // Outstanding balance via present-value formula; weeklyRate=0 → flat principal
          const remainingBal = weeklyRate > 0
            ? Math.round(loan.weeklyPayment * (1 - Math.pow(1 + weeklyRate, -loan.weeksRemaining)) / weeklyRate)
            : loan.weeklyPayment * loan.weeksRemaining;
          const interestThisWeek = Math.round(remainingBal * weeklyRate);
          totalLoanPayments += loan.weeklyPayment;
          totalLoanInterest += interestThisWeek;
          return {
            ...loan,
            weeksRemaining:    loan.weeksRemaining - 1,
            totalInterestPaid: (loan.totalInterestPaid ?? 0) + interestThisWeek,
          };
        })
        .filter(Boolean)
        .filter(l => l.weeksRemaining > 0);

      // Corporate income tax — 21% on positive EBT (earnings before tax).
      // EBT = operating profit − depreciation − loan INTEREST. Loan principal is a
      // balance-sheet repayment, NOT a deductible expense, so it is excluded from the
      // tax base (previously the full loan payment was deducted, which under-taxed
      // leveraged airlines and turned debt into a tax shelter).
      const CORPORATE_TAX_RATE = 0.21;
      const weeklyDepreciation = fleetWeeklyDepreciation(state.fleet);
      // Seasonal reactivation fees are a deductible operating expense, treated like
      // lease redelivery: they reduce the tax base and flow through the weekly P&L
      // (so the debrief shows them as a cost line and cash reconciles exactly).
      const taxableIncome   = adjustedCashDelta - weeklyDepreciation - totalLoanInterest - leaseRedeliveryCost - seasonalReactivationCost;
      const corporateTax    = Math.round(Math.max(0, taxableIncome) * CORPORATE_TAX_RATE);
      // Cash movement: operating cash − full loan payment − reactivation fees − tax.
      const preTaxProfit    = adjustedCashDelta - totalLoanPayments - leaseRedeliveryCost - seasonalReactivationCost;
      const newCash = state.cash + preTaxProfit - corporateTax;
      let newWeek = state.week + 1;
      let newYear = state.year;
      if (newWeek > 52) { newWeek = 1; newYear++; }

      // Advance competitor networks (graceful fallback for old saves missing competitors)
      const currentCompetitors = state.competitors
        ?? sampleAndInitializeCompetitors(15);
      const weekNumber = (state.year - 1) * 52 + state.week;
      const { competitors: grownCompetitors, events: competitorEvents } =
        tickCompetitorGrowth(currentCompetitors, weekNumber);
      // Competitors react to player pricing on shared routes
      const reactedCompetitors = tickCompetitorPricing(grownCompetitors, state.routes);

      // Simulate competitor networks, accumulate cash, and track profit history for market cap
      const approxMonth = gameMonth;
      const updatedCompetitors = reactedCompetitors.map(c => {
        const stats            = computeCompetitorWeeklyStats(c, approxMonth);
        const newCompCash      = (c.cash ?? 0) + stats.weeklyProfit;
        const newProfitHistory = [...(c.profitHistory ?? []), stats.weeklyProfit].slice(-12);
        const { marketCap: compMarketCap, sharePrice: compSharePrice } =
          computeMarketCap(newProfitHistory, newCompCash, c.baseQualityScore);
        return {
          ...c,
          weeklyStats:   stats,
          cash:          newCompCash,
          profitHistory: newProfitHistory,
          marketCap:     compMarketCap,
          sharePrice:    compSharePrice,
        };
      });

      // ── Tick codeshare agreement durations (expire old ones) ─────────────
      const tickedCodeshares = (state.codeshareAgreements ?? [])
        .map(a => ({ ...a, weeksRemaining: a.weeksRemaining - 1 }))
        .filter(a => a.weeksRemaining > 0);

      // Notify about newly expired codeshares
      const expiredCodeshares = (state.codeshareAgreements ?? []).filter(a => a.weeksRemaining <= 1);
      for (const a of expiredCodeshares) {
        newToasts.push({
          type:    'info',
          title:   `Codeshare Expired — ${a.competitorName}`,
          message: `Your codeshare agreement with ${a.competitorName} has concluded after 1 year. Renew it in Alliances.`,
          icon:    '🤝',
          duration: 6000,
        });
      }

      // ── Bankruptcy condition tracking ─────────────────────────────────────
      // Condition 1: missed loan payment = week where loans were due AND cash went negative
      const missedThisWeek = totalLoanPayments > 0 && newCash < 0;
      const newMissedLoanPayments = (state.missedLoanPayments ?? 0) + (missedThisWeek ? 1 : 0);

      // Condition 2: consecutive negative weeks (resets on recovery)
      const newConsecutiveNegativeWeeks = newCash < 0
        ? (state.consecutiveNegativeWeeks ?? 0) + 1
        : 0;

      // Warning toasts
      if (missedThisWeek && newMissedLoanPayments === 1) {
        newToasts.push({ type: 'danger', title: '⚠️ Missed Loan Payment (1/3)', message: "You missed a loan payment. Miss 2 more and your airline will be declared bankrupt.", duration: 9000 });
      }
      if (missedThisWeek && newMissedLoanPayments === 2) {
        newToasts.push({ type: 'danger', title: '🚨 Missed Loan Payment (2/3)', message: "Critical: one more missed payment and bankruptcy will be triggered.", duration: 10000 });
      }
      if (newConsecutiveNegativeWeeks === 3) {
        newToasts.push({ type: 'warning', title: '⚠️ Cash Warning: 3 Weeks Negative', message: "Your cash has been negative for 3 consecutive weeks. 6 weeks triggers bankruptcy.", duration: 9000 });
      }
      if (newConsecutiveNegativeWeeks === 5) {
        newToasts.push({ type: 'danger', title: '🚨 Final Warning: 5 Weeks Negative', message: "One more week in the red and your airline will be declared bankrupt.", duration: 10000 });
      }

      // Determine bankruptcy and reason
      let newPhase = state.phase;
      let bankruptcyReason = state.bankruptcyReason ?? null;
      if (newMissedLoanPayments >= 3) {
        newPhase = 'bankrupt';
        bankruptcyReason = 'missed_loans';
      } else if (newConsecutiveNegativeWeeks >= 6) {
        newPhase = 'bankrupt';
        bankruptcyReason = 'consecutive_negative';
      }

      const historyEntry = {
        label:       (() => { const d = weekToGameDate(state.week); return `${d.monthName} W${d.weekInMonth} Y${state.year}`; })(),
        week:        state.week,
        year:        state.year,
        cash:        newCash,
        revenue:     report.totalRevenue,
        leases:      report.totalLeases,
        maintenance: report.totalMaintenance,
        fuel:        report.totalFuel,
        crew:        report.totalCrew,
        quality:     report.totalQuality,
        landingFees:     report.totalLandingFees    ?? 0,
        catering:        report.totalCatering          ?? 0,
        cateringRevenue: report.totalCateringRevenue   ?? 0,
        groundHandling:  report.totalGroundHandling    ?? 0,
        distribution:    report.totalDistributionCost  ?? 0,
        layover:         report.totalLayover           ?? 0,
        compensation:    report.totalCompensation   ?? 0,
        gates:           report.totalGateFees       ?? 0,
        labor:           report.totalLaborCosts     ?? 0,
        familyCosts:     report.totalFamilyBaseCosts ?? 0,
        hqCost:          report.totalHQCost         ?? 0,
        insurance:       report.totalInsurance      ?? 0,
        marketing:       report.totalMarketingSpend ?? 0,
        hubInvestment:   report.totalHubInvestment  ?? 0,
        loyalty:         report.totalLoyaltyCost    ?? 0,
        partnerRevenue:  report.totalPartnerRevenue ?? 0,
        partnerFees:     report.totalPartnerFees    ?? 0,
        cargoRevenue:    report.totalCargoRevenue   ?? 0,
        cargoProfit:     report.totalCargoProfit    ?? 0,
        cargoTonnes:     report.totalCargoTonnes    ?? 0,
        loanPayments:       totalLoanPayments,
        loanInterest:       totalLoanInterest,
        leaseRedelivery:    leaseRedeliveryCost,
        seasonalReactivation: seasonalReactivationCost,
        corporateTax:       corporateTax,
        depreciation:       weeklyDepreciation,
        totalCost:          report.totalCost + totalLoanPayments + leaseRedeliveryCost + seasonalReactivationCost,
        // profit = actual cash change this week (after tax, matches newCash delta)
        profit:             preTaxProfit - corporateTax,
        fuelIndex:          currentFuelIndex,
        // Per-route revenue breakdown for Finance page prior-week column
        routeRevenues:      Object.fromEntries(
          (report.routeResults ?? []).map(r => [r.routeId, r.revenue])
        ),
      };
      const newHistory = [...state.financialHistory, historyEntry].slice(-52);

      // ── Player market cap (trailing 12 weeks, using newHistory which includes this week) ──
      const playerProfitHistory = newHistory.slice(-12).map(h => h.profit);
      const { marketCap: newMarketCap, sharePrice: newSharePrice } =
        computeMarketCap(playerProfitHistory, newCash, state.awareness ?? 5);

      // ── Board objectives check ───────────────────────────────────────────────
      const objectivesEnabled = state.objectivesEnabled ?? true;

      const objectiveSnap = {
        routes:           state.routes,   // current routes (weeksOpen not yet incremented — fine for checks)
        fleet:            agedFleet,      // fleet after aging tick, before deliveries
        gates:            state.gates ?? {},
        financialHistory: newHistory,
        lastReport:       report,
        weekProfit:       preTaxProfit - corporateTax,
        cash:             newCash,
        marketCap:        newMarketCap,
        year:             newYear,
        week:             newWeek,
      };

      // For old saves that pre-date objectives: silently pre-mark already-met
      // objectives so the player only earns credit for future achievements.
      const currentObjectives = !objectivesEnabled
        ? []
        : state.objectives?.length
          ? state.objectives
          : initialObjectivesForState(objectiveSnap);

      let objectiveCashBonus = 0;
      let updatedObjectives = currentObjectives;

      if (objectivesEnabled && currentObjectives.length > 0) {
        const { newlyCompleted } = checkObjectives(currentObjectives, objectiveSnap);
        updatedObjectives = currentObjectives.map(obj => {
          if (!newlyCompleted.includes(obj.id)) return obj;
          const tmpl = getObjective(obj.id);
          objectiveCashBonus += tmpl?.reward ?? 0;
          newToasts.push({
            type:     'success',
            title:    `🏅 Objective Complete — ${tmpl?.title ?? obj.id}`,
            message:  `${tmpl?.desc ?? ''} · Board reward: +${(tmpl?.reward ?? 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}`,
            icon:     tmpl?.icon ?? '🏅',
            duration: 9000,
          });
          return { ...obj, completed: true, completedWeek: state.week, completedYear: state.year };
        });
      }

      // ── Deliver pending aircraft orders ──────────────────────────────────────
      const newAbsWeek      = absoluteWeek(newYear, newWeek);
      const allPending      = state.pendingOrders ?? [];
      const toDeliver       = allPending.filter(o => o.deliverAbsWeek <= newAbsWeek);
      const remainingOrders = allPending.filter(o => o.deliverAbsWeek >  newAbsWeek);

      // Build delivered aircraft, accumulating used tail numbers to avoid collisions
      const deliveredAircraft = [];
      for (const order of toDeliver) {
        const ordType    = getAircraftType(order.typeId);
        const usedTails  = [
          ...agedFleet.map(a => a.tailNumber),
          ...deliveredAircraft.map(a => a.tailNumber),
        ].filter(Boolean);
        const tailNumber = generateTailNumber(state.hub, state.airlineName, usedTails);
        const DELIVERY_LEASE_TERMS = { 'Turboprop': 52, 'Regional Jet': 78, 'Narrow Body': 104, 'Wide Body': 156 };
        const deliveredLeaseTerm = order.ownershipType === 'lease'
          ? (DELIVERY_LEASE_TERMS[ordType?.category] ?? 104)
          : undefined;
        deliveredAircraft.push({
          id:            uid(),
          typeId:        order.typeId,
          name:          order.name,
          tailNumber,
          status:        'idle',
          ageWeeks:      0,
          config:        order.config ?? defaultConfig(ordType?.seats ?? 100),
          ownershipType: order.ownershipType,
          weeklyLease:        order.weeklyLease ?? 0,
          leaseTermWeeks:     deliveredLeaseTerm,
          leaseRemainingWeeks: deliveredLeaseTerm,
          fuelMod:       order.fuelMod   ?? 1.0,
          rangeMod:      order.rangeMod  ?? 1.0,
          maintMod:      order.maintMod  ?? 1.0,
          engineId:      order.engineId  ?? null,
          engineLabel:   order.engineLabel ?? null,
          hasWingtips:   order.hasWingtips ?? false,
        });
        newToasts.push({
          type:     'success',
          title:    `✈ Aircraft Delivered — ${order.name}`,
          message:  `Your ${ordType?.name ?? order.name} (${tailNumber}) has arrived and is ready for service.`,
          icon:     '✈',
          duration: 7000,
        });
      }
      const finalFleet = [...agedFleet, ...deliveredAircraft];
      // Drop routes whose aircraft lease expired this week, and age weeksOpen on survivors
      const survivingRoutes = expiredLeaseIds.size > 0
        ? seasonAdjustedRoutes.filter(r => !expiredLeaseIds.has(r.aircraftId))
        : seasonAdjustedRoutes;
      const finalRoutes = survivingRoutes.map(r => ({
        ...r,
        weeksOpen: (r.weeksOpen ?? 0) + 1,
      }));
      // Same treatment for cargo routes: drop those whose freighter's lease expired,
      // age weeksOpen on survivors (drives the cargo maturity ramp).
      const survivingCargo = expiredLeaseIds.size > 0
        ? (state.cargoRoutes ?? []).filter(r => !expiredLeaseIds.has(r.aircraftId))
        : (state.cargoRoutes ?? []);
      const finalCargoRoutes = survivingCargo.map(r => ({
        ...r,
        weeksOpen: (r.weeksOpen ?? 0) + 1,
      }));

      return {
        ...state,
        cash:              newCash + objectiveCashBonus,
        week:              newWeek,
        year:              newYear,
        fleet:             finalFleet,
        routes:            finalRoutes,
        cargoRoutes:       finalCargoRoutes,
        pendingOrders:     remainingOrders,
        financialHistory:  newHistory,
        lastReport:        { ...report, cashDelta: preTaxProfit - corporateTax,
          // Effective revenue includes the world-event demand adjustment that the
          // headline net already reflects; "all-in" cost folds loan payments,
          // lease redelivery, seasonal reactivation fees and corporate tax on top of
          // operating cost so that (revenueEffective − totalCostAll) reconciles to cashDelta.
          revenueEffective: Math.round(report.totalRevenue + eventDemandAdj),
          totalCostAll: report.totalCost + totalLoanPayments + leaseRedeliveryCost + seasonalReactivationCost + corporateTax,
          loanPayments: totalLoanPayments, loanInterest: totalLoanInterest, leaseRedelivery: leaseRedeliveryCost, seasonalReactivation: seasonalReactivationCost, corporateTax, eventDemandAdj: Math.round(eventDemandAdj), competitorEvents, newEvents, expiredEvents, mechanicalFailures: newFailures, fuelIndex: currentFuelIndex, fuelMultiplier, loyaltyMemberDelta: updatedLoyalty.members - currentLoyalty.members, loyaltyMembersTotal: updatedLoyalty.members },
        competitors:       updatedCompetitors,
        encroachments:     updatedEncroachments,
        loans:             updatedLoans,
        labor:             updatedLabor,
        maintenanceBudget: mainBudget,
        activeEvents:      allEvents,
        fuelPrice:         { index: nextFuelIndex, history: fuelPriceHistory },
        hedgeContracts:      liveHedges,
        loyalty:             updatedLoyalty,
        codeshareAgreements: tickedCodeshares,
        awareness:           Math.round(newAwareness * 10) / 10,
        objectives:               updatedObjectives,
        objectivesEnabled,
        showDebrief:              true,
        pendingToasts:            newToasts,
        phase:                    newPhase,
        bankruptcyReason,
        missedLoanPayments:       newMissedLoanPayments,
        consecutiveNegativeWeeks: newConsecutiveNegativeWeeks,
        marketCap:                newMarketCap,
        sharePrice:               newSharePrice,
      };
    } catch (err) {
      console.error('[ADVANCE_WEEK] reducer threw:', err);
      return { ...state, advanceWeekError: err?.message ?? String(err) };
    } }

    case 'BUY_HEDGE': {
      // action: { durationId, coverage }
      // durationId: 'short' | 'medium' | 'long'
      // coverage: 0.25 | 0.50 | 0.75 — fraction of fleet fuel to hedge
      const opt = HEDGE_DURATIONS.find(o => o.id === action.durationId);
      if (!opt) return state;

      const marketIndex  = state.fuelPrice?.index ?? 1.0;
      const locked       = hedgeLockedPrice(marketIndex, opt);
      const startAbsWeek = absoluteWeek(state.year, state.week);
      const newContract  = {
        id:            uid(),
        durationId:    opt.id,
        durationLabel: opt.label,
        coverage:      action.coverage,
        lockedPrice:   locked,
        marketAtPurchase: marketIndex,
        startAbsWeek,
        expiryAbsWeek: startAbsWeek + opt.weeks,
        weeksTotal:    opt.weeks,
      };
      return {
        ...state,
        hedgeContracts: [...(state.hedgeContracts ?? []), newContract],
      };
    }

    case 'TAKE_LOAN': {
      // action: { principal, interestRate (annual), termWeeks }
      const { principal, interestRate, termWeeks } = action;
      // Reject degenerate loans regardless of UI path.
      if (!(principal > 0) || !(termWeeks > 0) || !(interestRate >= 0)) return state;
      const weeklyRate = interestRate / 52;
      // Amortized weekly payment: P * r * (1+r)^n / ((1+r)^n - 1)
      const weeklyPayment = weeklyRate > 0
        ? Math.round(principal * weeklyRate * Math.pow(1 + weeklyRate, termWeeks) / (Math.pow(1 + weeklyRate, termWeeks) - 1))
        : Math.round(principal / termWeeks);
      const newLoan = {
        id:                uid(),
        principal,
        interestRate,
        termWeeks,
        weeklyPayment,
        weeksRemaining:    termWeeks,
        totalInterestPaid: 0,
        takenWeek:         state.week,
        takenYear:         state.year,
      };
      return {
        ...state,
        cash:  state.cash + principal,
        loans: [...(state.loans ?? []), newLoan],
      };
    }

    case 'REPAY_LOAN': {
      // action: { loanId } — early repayment, 2% penalty on remaining principal
      const loan = (state.loans ?? []).find(l => l.id === action.loanId);
      if (!loan) return state;
      // Remaining balance ≈ outstanding principal (simplified: payment × weeks left minus future interest)
      // Use simplified outstanding balance formula
      const weeklyRate = loan.interestRate / 52;
      const n = loan.weeksRemaining;
      const remainingBalance = weeklyRate > 0
        ? Math.round(loan.weeklyPayment * (1 - Math.pow(1 + weeklyRate, -n)) / weeklyRate)
        : Math.round(loan.weeklyPayment * n);
      const penalty = Math.round(remainingBalance * 0.02);
      const totalRepay = remainingBalance + penalty;
      if (state.cash < totalRepay) return state;
      return {
        ...state,
        cash:  state.cash - totalRepay,
        loans: (state.loans ?? []).filter(l => l.id !== action.loanId),
      };
    }

    case 'DISMISS_DEBRIEF': {
      return { ...state, showDebrief: false };
    }

    case 'CLEAR_TOASTS': {
      return { ...state, pendingToasts: [] };
    }

    case 'CLEAR_ERROR': {
      return { ...state, advanceWeekError: null };
    }

    case 'RESET': {
      return freshState();
    }

    case 'LOAD_STATE': {
      return reconcileState(action.payload);
    }

    default:
      return state;
  }
}

// Exported for headless simulation/testing harnesses (no React required to use it).
export { reducer as gameReducer, freshState, reconcileState };

// ─────────────────────────────────────────────
// CONTEXT + PROVIDER
// ─────────────────────────────────────────────

const GameContext = createContext(null);
const SAVE_KEY = 'bbae_save_v2'; // bump version to avoid old-format conflicts

/**
 * Reconcile a loaded save to fix any ID-collision corruption.
 *
 * Specifically guards against the HMR bug where the module-level counter
 * reset to 1, causing a newly-bought aircraft to share an ID with an
 * existing aircraft already assigned to a route.
 *
 * Rules applied:
 *  1. De-duplicate fleet by ID — keep the LAST entry (most recent purchase).
 *  2. Remove routes whose aircraftId no longer matches any fleet aircraft.
 *  3. Re-derive aircraft.status from the cleaned route list.
 *  4. Migrate missing competitors field.
 */
function reconcileState(parsed) {
  if (!parsed) return freshState();

  // 1. De-duplicate fleet: if two aircraft share an ID, keep the last one.
  const seenIds = new Map();
  for (const a of (parsed.fleet ?? [])) seenIds.set(a.id, a);
  const fleet = [...seenIds.values()];

  // 2. Remove routes (passenger + cargo) pointing at aircraft that no longer exist.
  const fleetIds    = new Set(fleet.map(a => a.id));
  const routes      = (parsed.routes ?? []).filter(r => fleetIds.has(r.aircraftId));
  const cargoRoutes = (parsed.cargoRoutes ?? []).filter(r => fleetIds.has(r.aircraftId));

  // 3. Re-derive status from the cleaned routes (passenger AND cargo — a freighter
  //    flying only cargo routes must still come back 'assigned', not 'idle').
  //    Preserve 'grounded' so aircraft mid-repair survive a save/reload cycle.
  const assignedIds = new Set([...routes, ...cargoRoutes].map(r => r.aircraftId));
  const cleanFleet  = fleet.map(a => ({
    ...a,
    status: a.status === 'grounded'
      ? 'grounded'
      : (assignedIds.has(a.id) ? 'assigned' : 'idle'),
  }));

  // 4. Migrate missing competitors.
  const competitors = (parsed.competitors?.length > 0)
    ? parsed.competitors
    : sampleAndInitializeCompetitors(15);

  // 5. Carry through pendingOrders (default to empty array for old saves).
  const pendingOrders = parsed.pendingOrders ?? [];

  // 6. Reprice existing routes that are still using the old (too-high) fare multipliers.
  //    Old multipliers: business=3.5×, PE=1.7×, first=8.0×
  //    New multipliers: business=2.5×, PE=1.4×, first=5.0×
  //    Detection: check if businessClass price = economyPrice × 3.5 (within ±1).
  const migratedRoutes = routes.map(rIn => {
    // Old saves predate per-route catering — default them to Full Service, which
    // matches the engine's prior "everyone fed" behaviour exactly.
    const r = rIn.cateringLevel ? rIn : { ...rIn, cateringLevel: 'full' };
    const eco = r.classPrices?.economy ?? r.ticketPrice;
    if (!eco || !r.classPrices) return r;
    const bizRatio = (r.classPrices.businessClass ?? 0) / eco;
    const peRatio  = (r.classPrices.premiumEconomy ?? 0) / eco;
    // Reprice if using the old 3.5× / 1.7× defaults (allow ±5% rounding tolerance)
    const usingOldMultipliers =
      Math.abs(bizRatio - 3.5) < 0.18 &&
      Math.abs(peRatio  - 1.7) < 0.09;
    if (!usingOldMultipliers) return r;
    return {
      ...r,
      classPrices: {
        economy:        eco,
        premiumEconomy: Math.round(eco * CLASS_FARE_MULTIPLIERS.premiumEconomy),
        businessClass:  Math.round(eco * CLASS_FARE_MULTIPLIERS.businessClass),
        firstClass:     Math.round(eco * CLASS_FARE_MULTIPLIERS.firstClass),
      },
    };
  });

  // 7. Migrate to per-O&D-pair pricing (state.routePricing is the single source of
  //    truth). New saves already carry routePricing; old saves carried price on each
  //    route object — fold the (now repriced) per-route fares into the pair map, then
  //    strip price fields off the stored route objects.
  const routePricing  = { ...(parsed.routePricing  ?? {}) };
  const routeCatering = { ...(parsed.routeCatering ?? {}) };
  for (const r of migratedRoutes) {
    const key = routePairKey(r.origin, r.destination);
    if (!routePricing[key]) {
      const eco = r.classPrices?.economy ?? r.ticketPrice;
      if (eco) routePricing[key] = r.classPrices ?? defaultClassPrices(eco);
    }
    if (!routeCatering[key] && r.cateringLevel) {
      routeCatering[key] = normalizeCateringLevel(r.cateringLevel);
    }
  }
  const normalizedRoutes = migratedRoutes.map((rIn) => {
    // Strip legacy price/catering fields (single-leg routes keep these in
    // routePricing/routeCatering by pair) and guarantee a well-formed stops[].
    // Tag routes price per-segment on the route itself, so they retain their own
    // segmentPrices (in ...rest) AND their per-route cateringLevel.
    const { ticketPrice, classPrices, cateringLevel, ...rest } = rIn;
    const base = rest.segmentPrices ? { ...rest, cateringLevel } : rest;
    return normalizeRouteStops(base);
  });

  return {
    ...parsed,
    fleet:            cleanFleet,
    routes:           normalizedRoutes,
    routePricing,
    routeCatering,
    cargoRoutes,
    competitors,
    pendingOrders,
    // Guarantee fields added in later versions exist even on old saves
    financialHistory: parsed.financialHistory ?? [],
    lastReport:       parsed.lastReport       ?? null,
    hubs:             parsed.hubs             ?? {},
    gates:            parsed.gates            ?? {},
    loans:            parsed.loans            ?? [],
    hedgeContracts:   parsed.hedgeContracts   ?? [],
    loyalty:          parsed.loyalty
      ? { effInvestment: parsed.loyalty.weeklyInvestment ?? 0, ...parsed.loyalty }
      : { weeklyInvestment: 0, effInvestment: 0, members: 0 },
    fuelPrice:        parsed.fuelPrice        ?? { index: 1.0, history: [] },
    allianceMembership:       parsed.allianceMembership       ?? null,
    codeshareAgreements:      parsed.codeshareAgreements      ?? [],
    marketingBudget:          parsed.marketingBudget          ?? 0,
    defaultCateringLevel:     normalizeCateringLevel(parsed.defaultCateringLevel),
    awareness:                parsed.awareness                ?? 5,
    missedLoanPayments:       parsed.missedLoanPayments       ?? 0,
    consecutiveNegativeWeeks: parsed.consecutiveNegativeWeeks ?? 0,
    bankruptcyReason:         parsed.bankruptcyReason         ?? null,
    // Market cap — compute on load if missing (old saves)
    marketCap:   parsed.marketCap   ?? (() => {
      const ph = (parsed.financialHistory ?? []).slice(-12).map(h => h.profit);
      return computeMarketCap(ph, parsed.cash ?? 0, parsed.awareness ?? 5).marketCap;
    })(),
    sharePrice:  parsed.sharePrice  ?? (() => {
      const ph = (parsed.financialHistory ?? []).slice(-12).map(h => h.profit);
      return computeMarketCap(ph, parsed.cash ?? 0, parsed.awareness ?? 5).sharePrice;
    })(),
  };
}

export function GameProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, null, () => {
    try {
      const saved = localStorage.getItem(SAVE_KEY);
      if (saved) return reconcileState(JSON.parse(saved));
    } catch (_) { /* ignore */ }
    return freshState();
  });

  useEffect(() => {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(state)); } catch (_) { /* ignore */ }
  }, [state]);

  // Expose routes already hydrated with their per-pair price, so every consumer can
  // keep reading route.classPrices / route.ticketPrice unchanged. The reducer stores
  // (and persists) the normalized form — price only in state.routePricing.
  const value = useMemo(() => ({
    state: {
      ...state,
      routes: (state.routes ?? []).map(r => hydrateRoute(r, state.routePricing, state.routeCatering)),
    },
    dispatch,
  }), [state]);

  return (
    <GameContext.Provider value={value}>
      {children}
    </GameContext.Provider>
  );
}

export function useGame() {
  const ctx = useContext(GameContext);
  if (!ctx) throw new Error('useGame must be used inside <GameProvider>');
  return ctx;
}
