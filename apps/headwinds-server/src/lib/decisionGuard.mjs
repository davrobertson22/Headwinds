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
import {
  LOAN_MIN_PRINCIPAL, getLoanProduct, loanProductForTerm,
  borrowingCapacity, unencumberedOwnedFleet,
} from '@tailwinds/engine/data/credit.js';
import { MRO_MAX_CERTS_PER_BASE } from '@tailwinds/engine/data/mroBase.js';
import { HEDGE_DURATIONS, HEDGE_COVERAGES } from '@tailwinds/engine/utils/fuel.js';

export class GuardError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 400;
  }
}

// ── Loans ────────────────────────────────────────────────────────────────────
// This guard used to re-derive its own loan bounds from constants copied out of
// Finance.jsx, and could only ever police the SHAPE of a payload — it had no way
// to know what rate the borrower deserved, so it settled for "at least 3%". The
// engine now prices loans itself (packages/engine/src/data/credit.js) and
// ignores whatever rate the client sends, which means there is nothing left here
// to bound generously: the guard's only job is to fail a bad decision loudly at
// the API boundary instead of silently inside the reducer.

function guardTakeLoan(payload, state) {
  const product = getLoanProduct(payload.productId)
    ?? (payload.termWeeks != null ? loanProductForTerm(payload.termWeeks) : null);
  if (!product) {
    throw new GuardError('That loan product is not on offer.');
  }
  const principal = Math.floor(Number(payload.principal) || 0);
  if (!(principal >= LOAN_MIN_PRINCIPAL)) {
    throw new GuardError('Invalid loan amount.');
  }
  if (product.secured && unencumberedOwnedFleet(state).length === 0) {
    throw new GuardError('You have no unpledged aircraft to secure this against.');
  }
  if (principal > borrowingCapacity(state, product.id)) {
    throw new GuardError('Loan amount exceeds your borrowing capacity.');
  }
  // Only the product and the amount survive. The rate and term are the engine's
  // to decide, so forwarding the client's would be theatre at best.
  return { productId: product.id, principal };
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
  // Bound the order size (the reducer also clamps to 100) — reject absurd values early.
  if (payload.quantity != null) {
    const q = Number(payload.quantity);
    if (!Number.isFinite(q) || q < 1) throw new GuardError('Invalid order quantity.');
    payload.quantity = Math.min(100, Math.floor(q));
  }
  // Orders may carry an initial cabin layout; bound it to the airframe.
  if (payload.config && typeof payload.config === 'object') {
    assertConfigFitsAirframe(payload.config, getAircraftType(payload.typeId));
  }
  // Line-fit Wi-Fi is a flag, not a price: the reducer adds wifiInstallCost()
  // itself. Coerce to a real boolean so nothing truthy-but-odd reaches the blob.
  if (payload.hasWifi !== undefined) payload.hasWifi = payload.hasWifi === true;
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

// ── Capital actions ──────────────────────────────────────────────────────────
// Shape hygiene only. The price of an issue or a buyback is derived by the reducer
// from the airline's own server-computed share price, and the settlement is
// re-checked against the world float pool inside the decision transaction, so the
// only thing a client may state is HOW MANY shares.
function guardShareCount(payload) {
  const shares = Number(payload.shares);
  if (!Number.isFinite(shares) || !Number.isInteger(shares) || shares <= 0 || shares > STOCK_MAX_SHARES) {
    throw new GuardError('Invalid share count.');
  }
  return { shares };
}

// An IPO carries TWO share counts: newly issued shares and existing founder
// shares sold alongside them. Either may legitimately be zero — a pure sell-down
// issues nothing, a plain listing sells nothing — so this cannot reuse
// guardShareCount, which insists on a positive count. The reducer owns every
// other rule (the 10-35% band on the combined float, whether the founder block
// is big enough, what the pool can absorb); this is shape hygiene only.
function guardIpo(payload) {
  const ok = (n) => Number.isFinite(n) && Number.isInteger(n) && n >= 0 && n <= STOCK_MAX_SHARES;
  const shares          = Number(payload.shares ?? 0);
  const secondaryShares = Number(payload.secondaryShares ?? 0);
  if (!ok(shares) || !ok(secondaryShares) || shares + secondaryShares <= 0) {
    throw new GuardError('Invalid share count.');
  }
  return { shares, secondaryShares };
}

// A payout ratio is a fraction of trailing profit; the reducer clamps it to
// CAPITAL.DIVIDEND_MAX_PAYOUT. Reject nonsense outright so the UI gets a message
// rather than a silent no-op.
function guardDividendPolicy(payload) {
  const payoutRatio = Number(payload.payoutRatio);
  if (!Number.isFinite(payoutRatio) || payoutRatio < 0 || payoutRatio > 1) {
    throw new GuardError('Payout ratio must be between 0 and 1.');
  }
  return { payoutRatio };
}

// ── Gates ────────────────────────────────────────────────────────────────────
// Shape hygiene only: the airport code is the sole legitimate field. The real
// scarcity rules (capacity, 60%/80% caps, lockouts) are enforced against the
// WorldGate ledger inside the decision transaction (see routes/decisions.mjs).
function guardGate(payload) {
  const code = payload.airportCode;
  if (typeof code !== 'string' || code.length < 3 || code.length > 4) {
    throw new GuardError('Invalid airport code.');
  }
  return { airportCode: code.toUpperCase() };
}

function guardScheduleCheck(payload, state) {
  return guardScheduleCheckInner(payload, state);
}

/**
 * A batch's aircraft id list. Bounded because the reducer folds one full pass
 * per id and the whole decision runs inside the write transaction — an
 * unbounded list is a cheap way to hold row locks for a very long time.
 */
function guardAircraftIds(payload, state) {
  const ids = Array.isArray(payload.aircraftIds) ? payload.aircraftIds : [];
  if (ids.length === 0) throw new GuardError('No aircraft selected.');
  if (ids.length > 200) throw new GuardError('Too many aircraft in one batch.');
  const own = new Set((state.fleet ?? []).map((a) => a.id));
  const clean = [...new Set(ids.map(String))].filter((id) => own.has(id));
  if (clean.length === 0) throw new GuardError('Unknown aircraft.');
  return clean;
}

function guardScheduleCheckInner(payload, state) {
  const a = (state.fleet ?? []).find((x) => x.id === payload.aircraftId);
  if (!a) throw new GuardError('Unknown aircraft.');
  const checkType = payload.checkType === 'D' ? 'D' : 'C';
  const out = { aircraftId: payload.aircraftId, checkType };
  if (payload.startNow) {
    out.startNow = true;
  } else if (payload.startWeek != null) {
    const w = Number(payload.startWeek);
    if (!Number.isFinite(w) || w < 0) throw new GuardError('Invalid check start week.');
    out.startWeek = Math.floor(w);
  }
  return out;
}

// ── Reserve aircraft (mirror src/components/Fleet.jsx station picker) ────────
// The reducer re-validates idle/in-service and hub ownership; the guard's job
// is payload hygiene: the aircraft must be the airline's own, the base one of
// its own hubs/focus cities, and the payload sanitized to exactly two fields
// (costs are computed server-side from type data — nothing here is priceable).
function guardSetReserve(payload, state) {
  const a = (state.fleet ?? []).find((x) => x.id === payload.aircraftId);
  if (!a) throw new GuardError('Unknown aircraft.');
  const code = String(payload.baseCode ?? '');
  if ((state.hubs ?? {})[code] == null) throw new GuardError('Reserve base must be one of your hubs or focus cities.');
  return { aircraftId: payload.aircraftId, baseCode: code };
}

// ── Jet bases (mirror src/components/Maintenance.jsx build form) ────────────
// The reducer re-validates gates, cash, level progression and certification
// capacity. The guard's job is payload hygiene: a plausible airport code, a
// legal level, and a families array of sane strings — nothing here is priceable
// by the client.
function guardMroBase(payload, { needLevel = false, needFamilies = false } = {}) {
  const code = String(payload.code ?? '').toUpperCase();
  if (code.length < 3 || code.length > 4) throw new GuardError('Invalid airport code.');
  const out = { code };
  if (needLevel) {
    const lvl = Number(payload.level);
    if (!Number.isInteger(lvl) || lvl < 1 || lvl > 3) throw new GuardError('Invalid base level.');
    out.level = lvl;
  }
  if (needFamilies) {
    const fams = Array.isArray(payload.families) ? payload.families : [];
    const clean = [...new Set(fams.filter((f) => typeof f === 'string' && f.length > 0 && f.length <= 40))];
    if (clean.length === 0) throw new GuardError('Certify at least one aircraft family.');
    // The ceiling comes from the engine, not a literal: the build form can now
    // legitimately buy every certification a base can hold, so a guard that
    // drifted below MRO_MAX_CERTS_PER_BASE would reject a legal build.
    if (clean.length > MRO_MAX_CERTS_PER_BASE) throw new GuardError('Too many certifications.');
    out.families = clean;
  }
  return out;
}

// ── Lounges (mirror src/components/Airports.jsx build form) ────────────────
// Nothing here is priceable by the client: LOUNGE_BUILD_COST, the gate
// requirement and the refund all live in the engine and are re-checked by the
// reducer. This is payload hygiene — a plausible airport code and two booleans.
function guardLounge(payload) {
  const code = String(payload.code ?? payload.airportCode ?? '').toUpperCase();
  if (code.length < 3 || code.length > 4) throw new GuardError('Invalid airport code.');
  // Both spellings go through: the reducer reads `code`, and the public news
  // scrubber reads `airportCode` for the feed line.
  return { code, airportCode: code };
}

function guardLoungePolicy(payload) {
  const out = {};
  if (payload.loyaltyAccess  !== undefined) out.loyaltyAccess  = !!payload.loyaltyAccess;
  if (payload.allianceAccess !== undefined) out.allianceAccess = !!payload.allianceAccess;
  if (Object.keys(out).length === 0) throw new GuardError('Nothing to change.');
  return out;
}

function guardBaseCertification(payload) {
  const out = guardMroBase(payload);
  const fam = String(payload.familyId ?? '');
  if (!fam || fam.length > 40) throw new GuardError('Invalid aircraft family.');
  out.familyId = fam;
  return out;
}

function guardPartsPool(payload) {
  const out = guardMroBase(payload);
  const pool = Number(payload.pool);
  if (!Number.isFinite(pool)) throw new GuardError('Invalid parts pool.');
  out.pool = pool;   // the reducer clamps to the legal band
  return out;
}

// ── Fuel hedging ─────────────────────────────────────────────────────────────
// A hedge costs no cash, so the only thing standing between a forged payload and
// the airline's fuel bill is this guard and the reducer's own bounds check. Both
// exist: coverage is a fraction of the fuel bill and a negative one used to make
// the whole bill negative (see the note in utils/fuel.js).
function guardBuyHedge(payload) {
  const opt = HEDGE_DURATIONS.find(o => o.id === payload?.durationId);
  if (!opt) throw new GuardError('That hedge term is not on offer.');
  const coverage = Number(payload?.coverage);
  if (!HEDGE_COVERAGES.includes(coverage)) {
    throw new GuardError('That hedge coverage is not on offer.');
  }
  return { durationId: opt.id, coverage };
}

// ── Freight rates ────────────────────────────────────────────────────────────
// The cargo yield is a $/tonne-km price the client states, and the reducer used
// to store `Math.max(0.01, Number(action.yieldPrice))` — which NaN sails
// straight through, because Math.max(0.01, NaN) is NaN. A yieldPrice of 'abc'
// therefore put NaN on the lane, and the first weekly tick multiplied it through
// revenue and left the airline's cash at NaN: a one-request bank wipe, and
// (since NaN spreads) an unrecoverable blob. The reducer now refuses a
// non-numeric rate outright; this is the boundary half, so a malformed request
// gets a 400 with a sentence instead of a silent refusal.
//
// The frequency gets the same treatment where it is present: the reducer floors
// it at 1, so a forged 1e9 would otherwise be accepted and then clamped by slot
// and block-hour maths that were never meant to police a hostile input.
const CARGO_YIELD_MAX = 1_000;      // $/tonne-km; reference yields are < $1
const CARGO_FREQ_MAX  = 1_000;      // departures/wk; slot caps bite far below this

function assertCargoYield(v) {
  const y = Number(v);
  if (!Number.isFinite(y) || y <= 0 || y > CARGO_YIELD_MAX) {
    throw new GuardError('Freight rate must be a positive $/tonne-km figure.');
  }
  return y;
}

function guardAddCargoRoute(payload) {
  const out = { ...payload };
  // The rate is OPTIONAL — omitted, the reducer prices the lane at its reference
  // yield, which is the documented contract for the field. Supplied, it must be
  // a real price.
  if (payload.yieldPrice !== undefined) out.yieldPrice = assertCargoYield(payload.yieldPrice);
  if (payload.weeklyFrequency !== undefined) {
    const f = Number(payload.weeklyFrequency);
    if (!Number.isFinite(f) || f <= 0 || f > CARGO_FREQ_MAX) {
      throw new GuardError('Invalid weekly frequency.');
    }
    out.weeklyFrequency = Math.floor(f);
  }
  return out;
}

function guardUpdateCargoYield(payload) {
  return {
    routeId: String(payload.routeId ?? ''),
    yieldPrice: assertCargoYield(payload.yieldPrice),
  };
}

// ── Branding ────────────────────────────────────────────────────────────────
// The solo client downscales every uploaded logo to a 128×128 PNG data URL
// (src/utils/logoImage.js) — a few tens of kB. The multiplayer client is
// untrusted, and until this guard existed anything up to Fastify's 1 MB body
// limit could be smuggled in as `customLogo`. Since 2026-08-24 the logo lands
// in its own Airline column (lib/logoColumn.mjs) rather than being re-written
// with the blob every tick, but a megabyte of forged "logo" is still a
// megabyte on every full state read — bound it here at the API boundary.
// 192 kB of data-URL is ~144 kB of image: several times the largest legitimate
// 128×128 PNG, so a real upload is never rejected.
const LOGO_DATAURL_MAX_CHARS = 196_608;
function guardBranding(payload) {
  const out = {};
  if (typeof payload.airlineName === 'string') out.airlineName = payload.airlineName;
  if (typeof payload.logoId === 'string')      out.logoId = payload.logoId.slice(0, 40);
  if (typeof payload.logoColor === 'string')   out.logoColor = payload.logoColor.slice(0, 32);
  // `'customLogo' in action` is the reducer's contract: only forward the key
  // when the client sent one, so a name-only rebrand never touches the logo.
  if ('customLogo' in payload) {
    const logo = payload.customLogo;
    if (logo == null) {
      out.customLogo = null;
    } else {
      if (typeof logo !== 'string' || !logo.startsWith('data:image/')) {
        throw new GuardError('The uploaded logo could not be used — please re-upload it.');
      }
      if (logo.length > LOGO_DATAURL_MAX_CHARS) {
        throw new GuardError('That logo image is too large — please re-upload it.');
      }
      out.customLogo = logo;
    }
  }
  return out;
}

export function guardDecision(type, payload, state) {
  switch (type) {
    case 'BUY_HEDGE':          return guardBuyHedge(payload);
    case 'ADD_CARGO_ROUTE':    return guardAddCargoRoute(payload);
    case 'UPDATE_CARGO_YIELD': return guardUpdateCargoYield(payload);
    // Single-aircraft lease extension. EXTEND_LEASES (the batch) has been
    // clamped to 1..520 weeks since it was written; this — the one the Fleet
    // page actually dispatches — had no case at all, so a forged
    // `addWeeks: 10_000_000` reached a reducer that only floored it at 0. The
    // reducer now carries the same 520-week ceiling; this is the boundary half.
    case 'EXTEND_LEASE':       return {
      aircraftId: payload.aircraftId,
      addWeeks: Math.max(1, Math.min(520, Math.round(Number(payload.addWeeks) || 52))),
    };
    case 'SCHEDULE_CHECK':     return guardScheduleCheck(payload, state);
    case 'SELL_AIRCRAFT_BULK':
    case 'BUY_OUT_LEASES':
    case 'RETIRE_AIRCRAFT_BULK': return { aircraftIds: guardAircraftIds(payload, state) };
    case 'SCHEDULE_CHECKS':    return {
      aircraftIds: guardAircraftIds(payload, state),
      checkType: payload.checkType === 'D' ? 'D' : 'C',
      startNow: true,
    };
    case 'EXTEND_LEASES':      return {
      aircraftIds: guardAircraftIds(payload, state),
      // The reducer clamps, but keep a forged 10,000-year lease out of the blob.
      addWeeks: Math.max(1, Math.min(520, Math.round(Number(payload.addWeeks) || 52))),
    };
    case 'REASSIGN_ROUTE':     return {
      routeId: String(payload.routeId ?? ''),
      toAircraftId: String(payload.toAircraftId ?? ''),
    };
    case 'CANCEL_SCHEDULED_CHECK': return { aircraftId: payload.aircraftId };
    case 'SET_RESERVE':        return guardSetReserve(payload, state);
    case 'BUILD_MRO_BASE':     return guardMroBase(payload, { needLevel: true, needFamilies: true });
    case 'UPGRADE_MRO_BASE':   return guardMroBase(payload, { needLevel: true });
    case 'ADD_BASE_CERTIFICATION': return guardBaseCertification(payload);
    case 'SET_BASE_PARTS_POOL': return guardPartsPool(payload);
    case 'CLOSE_MRO_BASE':     return guardMroBase(payload);
    case 'INSTALL_WIFI':       return { aircraftIds: guardAircraftIds(payload, state) };
    case 'BUILD_LOUNGE':
    case 'CLOSE_LOUNGE':       return guardLounge(payload);
    case 'SET_LOUNGE_POLICY':  return guardLoungePolicy(payload);
    case 'CLEAR_RESERVE':      return { aircraftId: payload.aircraftId };
    case 'TAKE_LOAN':          return guardTakeLoan(payload, state);
    case 'CONFIGURE_AIRCRAFT': return guardConfigureAircraft(payload, state);
    case 'ORDER_AIRCRAFT':     return guardOrderAircraft(payload);
    case 'BUY_STOCK':
    case 'SELL_STOCK':         return guardStockTrade(payload);
    case 'GO_PUBLIC':          return guardIpo(payload);
    case 'ISSUE_SHARES':
    case 'BUY_BACK_SHARES':    return guardShareCount(payload);
    case 'SET_DIVIDEND_POLICY': return guardDividendPolicy(payload);
    case 'ADD_GATE':
    case 'REMOVE_GATE':        return guardGate(payload);
    case 'SET_BRANDING':       return guardBranding(payload);
    default:                   return payload;
  }
}
