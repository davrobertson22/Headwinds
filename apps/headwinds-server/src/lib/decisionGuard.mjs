// Server-authoritative validation of player decision payloads.
//
// The shared engine reducer trusts economic values (loan terms, reconfigure cost,
// cabin layout) that the SOLO client computes and clamps in its own UI. In
// multiplayer the client is untrusted, so we re-derive / bound those values here
// before the reducer runs. This module is multiplayer-only (imported by
// routes/decisions.mjs); the solo game never touches it, so single-player
// behaviour is unchanged. Values mirror src/components/Finance.jsx and
// src/components/FleetConfig.jsx so a legitimate decision is never rejected.

import { getAircraftType } from '@tailwinds/engine/data/aircraft.js';
import {
  CLASS_SPACE_MULTIPLIERS,
  SEAT_QUALITY_FITTING_FEE,
  CABIN_INSTALL_FEE_PER_SEAT,
  defaultConfig,
} from '@tailwinds/engine/utils/simulation.js';

export class GuardError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 400;
  }
}

// ── Loans (mirror src/components/Finance.jsx) ────────────────────────────────
// Client rate floor is 0.03; the largest loan product is 52 weeks / 16× weekly
// revenue / $20M base. We bound generously (1.5× the largest multiple, 520-week
// ceiling) so a legitimate loan is NEVER rejected, while the
// {principal:1e12, interestRate:0, termWeeks:1e12} cash-mint exploit is impossible.
const LOAN_RATE_FLOOR      = 0.03;
const LOAN_MAX_TERM_WEEKS  = 520;
const LOAN_MAX_MULTIPLE    = 16;
const LOAN_MULTIPLE_BUFFER = 1.5;
const LOAN_BASE_MAX        = 20_000_000;

function recentWeeklyRevenue(state) {
  let max = 0;
  for (const h of (state.financialHistory ?? []).slice(-6)) {
    const rev = Number(h?.revenue) || 0;
    if (rev > max) max = rev;
  }
  return max;
}

function guardTakeLoan(payload, state) {
  const principal = Number(payload.principal);
  const rate      = Number(payload.interestRate);
  const term      = Number(payload.termWeeks);
  if (!(principal > 0) || !(term > 0) || !(rate >= 0)) {
    throw new GuardError('Invalid loan terms.');
  }
  if (rate < LOAN_RATE_FLOOR) {
    throw new GuardError('Loan interest rate is below the market floor.');
  }
  if (term > LOAN_MAX_TERM_WEEKS) {
    throw new GuardError('Loan term is too long.');
  }
  const cap = Math.max(
    LOAN_BASE_MAX,
    Math.floor(recentWeeklyRevenue(state) * LOAN_MAX_MULTIPLE * LOAN_MULTIPLE_BUFFER),
  );
  if (principal > cap) {
    throw new GuardError('Loan amount exceeds your borrowing capacity.');
  }
  return payload;
}

// ── Cabin layout (mirror src/components/FleetConfig.jsx) ──────────────────────
// The solo UI enforces that the floor space used by all cabins never exceeds the
// airframe's seat count, and computes the reconfigure cost. Re-derive both here:
// a layout that overflows the airframe is rejected, and the reconfigure cost is
// recomputed from the aircraft's CURRENT config so a client can't send reconfCost:0.
function floorUnits(config) {
  const f = Math.max(0, Math.round(Number(config?.firstClass)     || 0));
  const b = Math.max(0, Math.round(Number(config?.businessClass)  || 0));
  const p = Math.max(0, Math.round(Number(config?.premiumEconomy) || 0));
  const e = Math.max(0, Math.round(Number(config?.economy)        || 0));
  return f * CLASS_SPACE_MULTIPLIERS.firstClass
       + b * CLASS_SPACE_MULTIPLIERS.businessClass
       + p * CLASS_SPACE_MULTIPLIERS.premiumEconomy
       + e * CLASS_SPACE_MULTIPLIERS.economy;
}

function assertConfigFitsAirframe(config, type) {
  const maxSeats = type?.seats ?? 0;
  // +0.001 tolerance for the fractional space multipliers.
  if (floorUnits(config) > maxSeats + 0.001) {
    throw new GuardError('Cabin layout exceeds the aircraft capacity.');
  }
}

function calcReconfCost(current, next) {
  const seatChanges =
    Math.abs((next.firstClass     ?? 0) - (current.firstClass     ?? 0)) +
    Math.abs((next.businessClass  ?? 0) - (current.businessClass  ?? 0)) +
    Math.abs((next.premiumEconomy ?? 0) - (current.premiumEconomy ?? 0));
  const fitUpgrade = Math.max(
    0,
    (SEAT_QUALITY_FITTING_FEE[next.seatQuality    ?? 'basic'] ?? 0) -
    (SEAT_QUALITY_FITTING_FEE[current.seatQuality ?? 'basic'] ?? 0),
  );
  const premInstall =
    Math.max(0, (next.firstClass     ?? 0) - (current.firstClass     ?? 0)) * CABIN_INSTALL_FEE_PER_SEAT.firstClass +
    Math.max(0, (next.businessClass  ?? 0) - (current.businessClass  ?? 0)) * CABIN_INSTALL_FEE_PER_SEAT.businessClass +
    Math.max(0, (next.premiumEconomy ?? 0) - (current.premiumEconomy ?? 0)) * CABIN_INSTALL_FEE_PER_SEAT.premiumEconomy;
  if (seatChanges === 0 && fitUpgrade === 0 && premInstall === 0) return 0;
  return Math.max(10_000, seatChanges * 2_500 + premInstall + fitUpgrade);
}

function guardConfigureAircraft(payload, state) {
  const target = (state.fleet ?? []).find(a => a.id === payload.aircraftId);
  if (!target) throw new GuardError('Unknown aircraft.');
  const type = getAircraftType(target.typeId);
  const nextConfig = payload.config;
  if (!nextConfig || typeof nextConfig !== 'object') {
    throw new GuardError('Invalid cabin configuration.');
  }
  assertConfigFitsAirframe(nextConfig, type);
  const current = target.config ?? defaultConfig(type?.seats ?? 100);
  // Re-derive the cost server-side; never trust the client's number.
  payload.reconfCost = calcReconfCost(current, nextConfig);
  return payload;
}

function guardOrderAircraft(payload) {
  // Orders may carry an initial cabin layout; bound it to the airframe.
  if (payload.config && typeof payload.config === 'object') {
    assertConfigFitsAirframe(payload.config, getAircraftType(payload.typeId));
  }
  return payload;
}

// Dispatch. Mutates/returns the payload; throws GuardError (400) on violation.
// ── Stock trades ─────────────────────────────────────────────────────────────
// The economics are already server-authoritative: the reducer prices every
// trade from the server-injected rival view and ignores any price field in the
// payload. The guard's job is shape hygiene — sane ids, integer share counts —
// and stripping fields a crafted client might add hoping a future reducer
// version trusts them.
const STOCK_MAX_SHARES = 100_000_000; // TOTAL_SHARES — one full float

function guardStockTrade(payload) {
  const targetId = payload.targetId;
  if (typeof targetId !== 'string' || targetId.length === 0 || targetId.length > 80) {
    throw new GuardError('Invalid trade target.');
  }
  const shares = Number(payload.shares);
  if (!Number.isFinite(shares) || !Number.isInteger(shares) || shares <= 0 || shares > STOCK_MAX_SHARES) {
    throw new GuardError('Invalid share count.');
  }
  // Whitelist the payload — anything else (pricePerShare, spread overrides,
  // ...) is dropped before the reducer ever sees it.
  return { targetId, shares };
}

export function guardDecision(type, payload, state) {
  switch (type) {
    case 'TAKE_LOAN':          return guardTakeLoan(payload, state);
    case 'CONFIGURE_AIRCRAFT': return guardConfigureAircraft(payload, state);
    case 'ORDER_AIRCRAFT':     return guardOrderAircraft(payload);
    case 'BUY_STOCK':
    case 'SELL_STOCK':         return guardStockTrade(payload);
    default:                   return payload;
  }
}
