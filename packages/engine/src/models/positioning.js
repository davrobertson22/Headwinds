// ─────────────────────────────────────────────────────────────────────────────
// MARKET POSITIONING MODEL
//
// Pure positioning math, shared by the Reputation UI and the multiplayer
// server. Historically this lived in Reputation.jsx and only ever plotted the
// player against three FABRICATED competitor brands (ZoomJet / Global Air /
// Apex Air). In Headwinds there are no AI airlines, so those fake dots made no
// sense. The server now runs THIS SAME function over each human rival's state
// blob (see apps/headwinds-server/src/lib/humanRivals.mjs → toHumanCompetitor)
// and publishes the resulting { x, y } on each competitor, so the chart plots
// REAL players using the identical formula the player sees for themselves.
//
//   x — Leisure (0) ↔ Business (1)   cabin business/first mix + price premium
//   y — Budget  (0) ↔ Premium  (1)   cabin/service quality + price level
//
// Price is resolved the canonical way — routePricing[pair].economy (what SET_PRICE
// / UPDATE_CLASS_PRICES write) falling back to the route's launch ticketPrice —
// so repriced routes move the dot instead of sticking at the launch fare.
// ─────────────────────────────────────────────────────────────────────────────

import { getAircraftType } from '../data/aircraft.js';
import { referencePrice } from '../utils/market.js';

// Sorted O&D pair key — matches routePairKey()/routePricing keys without
// importing simulation.js (which would create a models→simulation cycle).
const pairKey = (a, b) => [a, b].sort().join('-');

// Current economy fare for a route: the per-pair economy price players actually
// set, falling back to the route's stored launch price.
function routeEconomyFare(state, route) {
  const key = pairKey(route.origin, route.destination);
  return state.routePricing?.[key]?.economy ?? route.ticketPrice ?? 0;
}

export function calcPositioning(state) {
  const { fleet, routes } = state;
  if (!routes || routes.length === 0) return { x: 0.5, y: 0.5, pricePremium: 0, bizCapRatio: 0 };

  let totalSeats     = 0;
  let bizFirstSeats  = 0;
  let pricePremSum   = 0;
  let qualitySum     = 0;
  let routeCount     = 0;

  for (const route of routes) {
    const aircraft = (fleet ?? []).find(a => a.id === route.aircraftId);
    const type     = aircraft ? getAircraftType(aircraft.typeId) : null;
    if (!aircraft || !type) continue;

    const cfg = aircraft.config ?? {};
    bizFirstSeats += (cfg.firstClass ?? 0) + (cfg.businessClass ?? 0);
    totalSeats    += type.seats;

    const refP          = referencePrice(route.origin, route.destination);
    const fare          = routeEconomyFare(state, route);
    const pricePremium  = (fare / Math.max(1, refP)) - 1;
    pricePremSum       += pricePremium;

    const seatQN  = { basic: 0, standard: 0.4, premium: 0.7, luxury: 1.0 }[cfg.seatQuality  ?? 'standard'] ?? 0.4;
    const servQN  = { basic: 0, standard: 0.4, premium: 0.7, luxury: 1.0 }[cfg.serviceQuality ?? 'standard'] ?? 0.4;
    qualitySum   += (seatQN + servQN) / 2;
    routeCount++;
  }

  if (routeCount === 0) return { x: 0.5, y: 0.5, pricePremium: 0, bizCapRatio: 0 };

  const bizCapRatio    = totalSeats > 0 ? bizFirstSeats / totalSeats : 0;
  const avgPricePrem   = pricePremSum / routeCount;
  const avgQuality     = qualitySum / routeCount;

  // X = Leisure (0) ↔ Business (1)
  // Business positioning driven by: cabin mix, premium pricing
  const bizFocus = Math.max(0, Math.min(1,
    bizCapRatio * 1.5 + (avgPricePrem > 0.2 ? 0.2 : avgPricePrem > 0 ? 0.1 : -0.05) + 0.15
  ));

  // Y = Budget (0) ↔ Premium (1)
  // Premium driven by: quality + price level
  const premiumLevel = Math.max(0, Math.min(1,
    avgQuality * 0.65 + Math.max(-0.2, Math.min(0.35, avgPricePrem + 0.3))
  ));

  return { x: bizFocus, y: premiumLevel, pricePremium: avgPricePrem, bizCapRatio };
}

export function strategyLabel(pos) {
  const { x, y } = pos;
  if (y >= 0.6 && x >= 0.55) return { name: 'Premium Full-Service', color: '#a98bff', emoji: '💎', description: 'Positioned for business and premium leisure travel. High revenue per seat, brand commands a price premium. Focus on service consistency and business-friendly routes.' };
  if (y >= 0.6 && x <  0.55) return { name: 'Luxury Leisure',       color: '#38d39f', emoji: '🌴', description: 'Upscale but leisure-oriented. Sells a premium holiday experience. Strong in resort routes and seasonal markets. Demand is highly seasonal.' };
  if (y <  0.4 && x >= 0.55) return { name: 'Budget Business',      color: '#3ea6ff', emoji: '💼', description: 'Affordable business travel — think no-frills but reliable on corporate corridors. Works on short-haul business routes with high frequency.' };
  if (y <  0.4 && x <  0.55) return { name: 'Low-Cost Carrier',     color: '#ffb43d', emoji: '✂️', description: 'Volume over margin. Fill planes at low prices, minimise costs everywhere. Works best with high frequency, large fleets, and dense leisure routes.' };
  return { name: 'Mid-Market',               color: '#93a4ba', emoji: '🔄', description: 'Sitting in the middle. Not strongly differentiated yet. Consider pushing toward Premium or Low-Cost — the middle is the hardest place to compete.' };
}
