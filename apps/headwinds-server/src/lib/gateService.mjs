// Gate scarcity — the world-level gate ledger, auctions, and marketplace.
// ----------------------------------------------------------------------------
// Only worlds created with tickConfig.gateScarcity use any of this. The airline
// blobs keep their state.gates mirror (all engine slot math is unchanged); the
// WorldGate rows are the arbiter of AVAILABILITY: every mutation happens through
// a version compare-and-set so two airlines can never both take the last gate.
//
//   • Lease/remove ride INSIDE the decision transaction (applyGateDecisionTx).
//   • Rule-5 forfeitures are reconciled after each tick by diffing blobs
//     (reconcileForfeitures) — the engine is the source of truth for WHO
//     forfeits; the ledger follows.
//   • Auctions open at week 40 (openDueAuctions) and resolve at the year tick
//     (resolveDueAuctions) with seeded random tie-breaks.
//   • The marketplace (listings) transfers gates between airlines atomically.
import { gameReducer } from '@tailwinds/engine/reducer';
import {
  getAirport, gateCapacityOf, gateAirlineCapOf, gateAllianceCapOf,
  GATE_AIRLINE_CAP, GATE_ALLIANCE_CAP,
  GATE_FEE_BY_TIER, GATE_HUB_GUARANTEE, GATE_ANTI_FLIP_WEEKS,
  GATE_AUCTION_LOTS_BY_SIZE, GATE_AUCTION_OPEN_WEEK, GATE_AUCTION_TRIGGER,
  GATE_AUCTION_RESULT_WEEKS, GATE_BID_MAX_QTY, GATE_CAPACITY_GROWTH_CEILING,
  GATE_SURCHARGE_THRESHOLD, GATE_SURCHARGE_MULT, SLOT_POOL_MARKUP,
} from '@tailwinds/engine/data/airports.js';
import { SLOTS_PER_GATE, cargoSlotsUsedAt } from '@tailwinds/engine/utils/simulation.js';
import { withTx } from './tx.mjs';

export const isGateScarcity = (world) => world?.tickConfig?.gateScarcity === true;

export class GateError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

// Linear 1-based week index of a world's clock (duplicated from tickService to
// avoid an import cycle — tickService imports this module for its hooks).
const worldWeekIndex = (world) => (world.currentYear - 1) * 52 + world.currentWeek;

// Deterministic uniform [0,1) from a string seed + salt — same construction as
// the tick's shared-economy RNG, so a retried resolution reproduces identical
// tie-breaks and nobody can game the coin flip.
function seededRand(seedStr, salt) {
  let h = 2166136261 >>> 0;
  const s = `${seedStr}:${salt}`;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  h += 0x6d2b79f5;
  let t = h >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// Per-gate reserve price: ~6 months of the tier's base weekly rent.
export function auctionReserveOf(airport) {
  const monthly = GATE_FEE_BY_TIER[airport?.tier] ?? 50_000;
  return Math.round(monthly / 4) * 26;
}

const holdingsCount = (row, airlineId) => row?.holdings?.[airlineId]?.count ?? 0;

// ── Alliance slot pool ───────────────────────────────────────────────────────
// Members of one alliance can opt to SHARE the spare weekly departure slots on
// their gates at an airport (GateSlotShare rows); partners with at least one
// gate of their own there draw the extra frequency they need straight from the
// pool. Holdings never move — only usage — so the 60%/80% ownership caps are
// untouched. Borrowed usage is DERIVED here on every build (usage beyond an
// airline's own slot capacity IS its draw); there is no per-draw ledger to
// desync. The engine consumes the result as state.allianceSlotPool: `grant`
// extends its slot checks, `weeklyCost`/`weeklyEarnings` are booked into the
// week's gate fees, `lentOut` protects pooled gates from rule-5 forfeiture,
// and a grant that shrinks below current usage starts the engine's 4-week
// squeeze countdown.

/** Per-slot weekly price of a borrowed slot: the airport's BASE weekly gate
 *  fee pro-rata, surcharged like any gate when the airport is congested, times
 *  the pool markup. All of it goes to the owning member. */
export function slotPoolPerSlotFee(airport, surcharged = false) {
  const monthly = GATE_FEE_BY_TIER[airport?.tier] ?? 50_000;
  return ((monthly / 4) / SLOTS_PER_GATE)
    * (surcharged ? GATE_SURCHARGE_MULT : 1)
    * SLOT_POOL_MARKUP;
}

// Weekly departure slots an airline's blob uses at `code` — passenger routes
// (origin/destination/stops) + cargo, matching the marketplace's slotsUsedAt.
function usageMapOf(state) {
  const out = {};
  const add = (code, n) => { if (code) out[code] = (out[code] ?? 0) + n; };
  for (const r of state?.routes ?? []) {
    const freq = r.weeklyFrequency ?? 0;
    add(r.origin, freq); add(r.destination, freq);
    for (const s of r.stops ?? []) {
      if (s !== r.origin && s !== r.destination) add(s, freq);
    }
  }
  for (const r of state?.cargoRoutes ?? []) {
    const freq = r.weeklyFrequency ?? 0;
    add(r.origin, freq); add(r.destination, freq);
  }
  return out;
}

/**
 * Compute every airline's slot-pool view for a world.
 *
 * @param {object}   base        code → { capacity, taken, holdings, surcharge } (buildGateMarketViews' base map)
 * @param {Array}    airlines    airline rows; rows without `.state` contribute nothing and draw nothing
 * @param {Map}      allianceMap airlineId → { membership: { allianceId } } (ACTIVE members only)
 * @param {Array}    shares      GateSlotShare rows for the world
 * @param {number}   weekIdx     linear world week (rule-5 lockout checks)
 * @returns {Map<airlineId, { [code]: poolEntry }>}
 *
 * Deterministic on identical inputs: borrowers are served in airlineId order,
 * owner attribution is most-spare-first (ties on airlineId), so a retried tick
 * reproduces identical grants and identical money.
 */
export function computeSlotPools({ base, airlines, allianceMap, shares, weekIdx = 0 }) {
  const out = new Map();
  if (!allianceMap || allianceMap.size === 0) return out;

  const rowById = new Map(airlines.map((a) => [a.id, a]));
  const shareByKey = new Map((shares ?? []).map((s) => [`${s.airlineId}:${s.airportCode}`, s]));
  const usageById = new Map();
  const usageOf = (id) => {
    if (!usageById.has(id)) usageById.set(id, usageMapOf(rowById.get(id)?.state ?? null));
    return usageById.get(id);
  };
  const entryFor = (id, code) => {
    if (!out.has(id)) out.set(id, {});
    const byCode = out.get(id);
    if (!byCode[code]) {
      byCode[code] = {
        grant: 0, draw: 0, weeklyCost: 0,
        shared: 0, lentOut: 0, weeklyEarnings: 0,
        sharing: false, reserved: 0, perSlot: 0,
        lenders: [], borrowers: [],
      };
    }
    return byCode[code];
  };

  // Alliance rosters (ACTIVE members only — that's all loadAllianceMap holds).
  const rosters = new Map();
  for (const [airlineId, m] of allianceMap) {
    const aid = m.membership.allianceId;
    if (!rosters.has(aid)) rosters.set(aid, []);
    rosters.get(aid).push(airlineId);
  }

  for (const [code, b] of Object.entries(base)) {
    const airport = getAirport(code);
    const perSlot = slotPoolPerSlotFee(airport, b.surcharge === true);

    for (const roster of rosters.values()) {
      if (roster.length < 2) continue; // a pool needs someone to share WITH
      // Owners must hold gates here, but BORROWERS need none — launching a
      // route somewhere you hold nothing, on a partner's spare slots, is the
      // point of the pool. So every roster member is in the arithmetic.
      if (!roster.some((id) => (b.holdings?.[id]?.count ?? 0) > 0)) continue;

      // Per-member arithmetic. Guarantee hub gates never pool their slots; own
      // usage is assumed to fill those personal slots first, so an owner's
      // shareable spare is measured against the non-guaranteed remainder.
      const members = roster.map((id) => {
        const row = rowById.get(id);
        const state = row?.state ?? null;
        const count = b.holdings?.[id]?.count ?? 0;
        const ownCap = count * SLOTS_PER_GATE;
        const usage = usageOf(id)[code] ?? 0;
        const isHome = code === (row?.hub ?? state?.hub);
        const guaranteeSlots = (isHome ? Math.min(count, GATE_HUB_GUARANTEE) : 0) * SLOTS_PER_GATE;
        const share = shareByKey.get(`${id}:${code}`);
        const sharing = share?.sharing === true && state != null;
        const reserved = Math.max(0, Math.round(share?.reservedSlots ?? 0));
        const usageOnShareable = Math.max(0, usage - guaranteeSlots);
        const shareable = sharing
          ? Math.max(0, (ownCap - guaranteeSlots) - usageOnShareable - reserved)
          : 0;
        const lockedUntil = state?.gateLockouts?.[code] ?? 0;
        // No own gate needed to borrow — but a rule-5 lockout still bars you
        // (the pool must not be a lockout escape hatch).
        const canBorrow = state != null && !(lockedUntil > weekIdx);
        // Borrow ceiling: a gateless member may run up to ONE gate's worth of
        // slots on partners' gates; holding your own gates raises the ceiling
        // to match your own capacity (tunable — plan §8).
        const borrowCap = Math.max(ownCap, SLOTS_PER_GATE);
        return {
          id, name: row?.name ?? 'An airline', state, count, ownCap, usage,
          sharing, reserved, shareable, borrowCap,
          need: canBorrow ? Math.max(0, usage - ownCap) : 0,
          canBorrow,
          draw: 0, available: 0, lent: 0,
        };
      });

      const poolTotal = members.reduce((s, m) => s + m.shareable, 0);
      if (poolTotal <= 0 && !members.some((m) => m.sharing)) continue;

      // Draws: serve current borrowing (usage already past own capacity) in
      // airlineId order. A member draws only from OTHERS' shareable, and never
      // more than their borrow ceiling.
      let poolLeft = poolTotal;
      for (const m of [...members].sort((a, z) => a.id.localeCompare(z.id))) {
        if (!m.canBorrow || m.need <= 0) continue;
        const othersPool = poolTotal - m.shareable;
        m.draw = Math.max(0, Math.min(m.need, m.borrowCap, othersPool, poolLeft));
        poolLeft -= m.draw;
      }
      // Headroom: what each member could STILL draw for new frequency.
      for (const m of members) {
        if (!m.canBorrow) continue;
        const othersPool = poolTotal - m.shareable;
        m.available = Math.max(0, Math.min(m.borrowCap - m.draw, othersPool - m.draw, poolLeft));
      }

      // Owner attribution, most-spare-first (ties on airlineId): each
      // borrower's draw lands on named owners so the money is concrete.
      const owners = members.filter((m) => m.shareable > 0)
        .sort((a, z) => (z.shareable - a.shareable) || a.id.localeCompare(z.id))
        .map((m) => ({ m, left: m.shareable }));
      for (const b2 of members.filter((m) => m.draw > 0)) {
        let need = b2.draw;
        for (const o of owners) {
          if (need <= 0) break;
          if (o.m.id === b2.id) continue; // never fund your own draw
          const take = Math.min(need, o.left);
          if (take <= 0) continue;
          o.left -= take;
          o.m.lent += take;
          need -= take;
          entryFor(b2.id, code).lenders.push({ airlineId: o.m.id, name: o.m.name, slots: take });
          entryFor(o.m.id, code).borrowers.push({ airlineId: b2.id, name: b2.name, slots: take });
        }
      }

      for (const m of members) {
        const relevant = m.draw > 0 || m.available > 0 || m.shareable > 0
          || m.lent > 0 || m.sharing || shareByKey.has(`${m.id}:${code}`);
        if (!relevant) continue;
        const e = entryFor(m.id, code);
        e.grant = m.draw + m.available;
        e.draw = m.draw;
        e.weeklyCost = Math.round(m.draw * perSlot);
        e.shared = m.shareable;
        e.lentOut = m.lent;
        e.weeklyEarnings = Math.round(m.lent * perSlot);
        e.sharing = m.sharing;
        e.reserved = m.reserved;
        e.perSlot = Math.round(perSlot);
      }
    }
  }
  return out;
}

// ── The gate-market view (injected into state as state.gateMarket) ───────────
// One base map per world, personalized per airline (yours / allianceTaken /
// yourBid / listings ownership). Sparse: only airports with a ledger row, an
// open auction, or an open listing appear — the client derives capacity for
// untouched airports itself via gateCapacityOf.
// One resolved auction, from the point of view of a single airline: what sold,
// to whom, and — the part that was missing entirely — what became of YOUR bid.
// `outcomes` is null on auctions resolved before it was recorded; the view then
// falls back to what can still be derived from the winners list.
function lastAuctionView(auction, meId, nameOf) {
  const results = Array.isArray(auction.results) ? auction.results : [];
  const outcomes = Array.isArray(auction.outcomes) ? auction.outcomes : null;
  const myBid = (auction.bids ?? []).find((b) => b.airlineId === meId) ?? null;
  const won = results.find((r) => r.airlineId === meId) ?? null;

  let yours = null;
  if (outcomes) {
    const mine = outcomes.find((o) => o.airlineId === meId);
    if (mine) {
      yours = {
        reason: mine.reason, detail: mine.detail ?? null, gates: mine.gates ?? 0,
        amount: mine.amount ?? null, quantity: mine.quantity ?? null,
      };
    }
  } else if (won) {
    yours = { reason: 'WON', detail: null, gates: won.gates, amount: won.pricePerGate, quantity: won.gates };
  } else if (myBid) {
    yours = { reason: 'NOT_RECORDED', detail: null, gates: 0, amount: myBid.amount, quantity: myBid.quantity };
  }

  return {
    year: auction.year,
    lots: auction.lots,
    reserve: auction.reserve,
    resolvedWeek: auction.resolvesWeek,
    bidCount: (auction.bids ?? []).length,
    sold: results.reduce((n, r) => n + (r.gates ?? 0), 0),
    winners: results.map((r) => ({
      name: r.airline ?? nameOf.get(r.airlineId) ?? 'An airline',
      gates: r.gates,
      pricePerGate: r.pricePerGate,
      yours: r.airlineId === meId,
    })),
    yours,
  };
}

export async function buildGateMarketViews(prisma, worldId, { airlines, allianceMap = new Map(), world }) {
  // A resolved auction used to disappear from this view the moment it flipped
  // status, so the only trace left of a sealed auction you bid in was silence.
  // Recent results ride along and the client shows them for a few weeks.
  const nowWeek = world ? worldWeekIndex(world) : null;
  const [rows, auctions, resolved, listings, slotShares] = await Promise.all([
    prisma.worldGate.findMany({ where: { worldId } }),
    prisma.gateAuction.findMany({ where: { worldId, status: 'OPEN' }, include: { bids: true } }),
    prisma.gateAuction.findMany({
      where: {
        worldId,
        status: 'RESOLVED',
        ...(nowWeek === null ? {} : { resolvesWeek: { gte: nowWeek - GATE_AUCTION_RESULT_WEEKS } }),
      },
      include: { bids: true },
      orderBy: { resolvesWeek: 'desc' },
    }),
    prisma.gateListing.findMany({ where: { worldId, status: 'OPEN' } }),
    // Test doubles may predate the model — a missing delegate means no shares.
    prisma.gateSlotShare?.findMany?.({ where: { worldId } }) ?? [],
  ]);
  const nameOf = new Map(airlines.map((a) => [a.id, a.name]));

  // Alliance roster: allianceId → [airlineId] (ACTIVE members only).
  const allianceRoster = new Map();
  for (const [airlineId, m] of allianceMap) {
    const aid = m.membership.allianceId;
    if (!allianceRoster.has(aid)) allianceRoster.set(aid, []);
    allianceRoster.get(aid).push(airlineId);
  }

  const base = {};
  for (const row of rows) {
    base[row.airportCode] = {
      capacity:  row.capacity,
      baseSize:  row.baseSize,
      taken:     row.taken,
      maxYours:  gateAirlineCapOf(row.capacity),
      surcharge: row.taken > GATE_SURCHARGE_THRESHOLD * row.capacity,
      holdings:  row.holdings ?? {},
    };
  }
  const auctionsByCode = new Map(auctions.map((a) => [a.airportCode, a]));
  const resolvedByCode = new Map();
  for (const a of resolved) if (!resolvedByCode.has(a.airportCode)) resolvedByCode.set(a.airportCode, a);
  const listingsByCode = new Map();
  for (const l of listings) {
    if (!listingsByCode.has(l.airportCode)) listingsByCode.set(l.airportCode, []);
    listingsByCode.get(l.airportCode).push(l);
  }
  // Airports that only exist as an auction/listing still need a base entry.
  for (const code of [...auctionsByCode.keys(), ...resolvedByCode.keys(), ...listingsByCode.keys()]) {
    if (!base[code]) {
      const cap = gateCapacityOf(getAirport(code));
      base[code] = { capacity: cap, baseSize: cap, taken: 0, maxYours: gateAirlineCapOf(cap), surcharge: false, holdings: {} };
    }
  }

  // Slot pools: needs blob usage, so rows without state contribute/draw nothing
  // (callers that care — the tick, the airline read, the share endpoint — all
  // pass state-bearing rows; see gates.mjs's loadRivalRows switch).
  const slotPools = computeSlotPools({
    base, airlines, allianceMap, shares: slotShares, weekIdx: nowWeek ?? 0,
  });

  const views = new Map();
  for (const me of airlines) {
    const myAlliance = allianceMap.get(me.id);
    const roster = myAlliance ? (allianceRoster.get(myAlliance.membership.allianceId) ?? []) : null;
    const airports = {};
    for (const [code, b] of Object.entries(base)) {
      const auction = auctionsByCode.get(code);
      const myBid = auction?.bids.find((bd) => bd.airlineId === me.id);
      const past = resolvedByCode.get(code);
      const codeListings = (listingsByCode.get(code) ?? []).map((l) => ({
        id: l.id,
        airportCode: code,
        seller: nameOf.get(l.sellerId) ?? 'An airline',
        askPrice: l.askPrice,
        yours: l.sellerId === me.id,
      }));
      airports[code] = {
        capacity:  b.capacity,
        baseSize:  b.baseSize,
        taken:     b.taken,
        maxYours:  b.maxYours,
        surcharge: b.surcharge,
        yours:     holdingsCount({ holdings: b.holdings }, me.id),
        // Per-airline breakdown of who holds gates here (name + count),
        // busiest holder first. Powers the Airport Details gate table.
        holders: Object.entries(b.holdings ?? {})
          .map(([id, h]) => ({ name: nameOf.get(id) ?? 'An airline', count: h?.count ?? 0, yours: id === me.id }))
          .filter((h) => h.count > 0)
          .sort((x, y) => y.count - x.count || x.name.localeCompare(y.name)),
        cooldownUntilWeek: b.holdings?.[me.id]?.cooldownUntilWeek ?? null,
        allianceTaken: roster
          ? roster.reduce((s, id) => s + (b.holdings?.[id]?.count ?? 0), 0)
          : null,
        maxAlliance: roster ? gateAllianceCapOf(b.capacity) : null,
        auction: auction ? {
          id:          auction.id,
          lots:        auction.lots,
          reserve:     auction.reserve,
          opensWeek:   auction.opensWeek,
          closesWeek:  auction.resolvesWeek,
          yourBid:     myBid ? { amount: myBid.amount, quantity: myBid.quantity } : null,
          // How many gates could ACTUALLY be awarded to you once the caps are
          // applied. 0 means bidding here is pointless, and the form says so
          // instead of letting the bid die silently at the year tick.
          ...gateAuctionEligibility(
            { capacity: b.capacity, holdings: b.holdings }, me.id, allianceMap, auction.lots,
          ),
        } : null,
        lastAuction: past ? lastAuctionView(past, me.id, nameOf) : null,
        listings: codeListings,
      };
    }
    views.set(me.id, {
      week: world ? worldWeekIndex(world) : null,
      airports,
      // This airline's alliance slot pool, per airport — injected into state as
      // state.allianceSlotPool (see rivalOverlay) and read by the engine's slot
      // checks, weekly money, rule-5 attribution and squeeze countdown.
      slotPool: slotPools.get(me.id) ?? {},
    });
  }
  return views;
}

// ── Lease / remove inside the decision transaction ───────────────────────────
// Runs on the SAME prisma tx as the airline-blob write, guarded by the row's
// version. Throws GateError (400, friendly message) on a rule violation and
// GateConflict-shaped GateError (409) when the version CAS loses a race — the
// client just retries.
export async function applyGateDecisionTx(tx, {
  worldId, airportCode, type, airline, allianceMap = new Map(),
}) {
  let row = await tx.worldGate.findUnique({
    where: { worldId_airportCode: { worldId, airportCode } },
  });
  if (!row && type === 'ADD_GATE') {
    const ap = getAirport(airportCode);
    if (!ap) throw new GateError(`Unknown airport ${airportCode}.`);
    const cap = gateCapacityOf(ap);
    try {
      row = await tx.worldGate.create({
        data: { worldId, airportCode, baseSize: cap, capacity: cap, taken: 0, holdings: {} },
      });
    } catch (e) {
      if (e?.code === 'P2002') throw new GateError('The airport just changed — try again.', 409);
      throw e;
    }
  }
  if (!row) return; // REMOVE_GATE with no ledger row (shouldn't happen) — nothing to do

  const holdings = { ...(row.holdings ?? {}) };
  const mine = { ...(holdings[airline.id] ?? { count: 0 }) };

  if (type === 'ADD_GATE') {
    const isHome = airportCode === (airline.hub ?? airline.state?.hub);
    const hubGuarantee = isHome && mine.count < GATE_HUB_GUARANTEE;
    if (!hubGuarantee && row.taken >= row.capacity) {
      throw new GateError(`${airportCode} is at capacity (${row.taken}/${row.capacity} gates) — win one at auction or buy one from another airline.`);
    }
    if (mine.count + 1 > gateAirlineCapOf(row.capacity)) {
      throw new GateError(`No airline may hold more than 60% of ${airportCode}'s ${row.capacity} gates.`);
    }
    const myAlliance = allianceMap.get(airline.id);
    if (myAlliance) {
      const allianceId = myAlliance.membership.allianceId;
      let allianceTaken = 0;
      for (const [aid, m] of allianceMap) {
        if (m.membership.allianceId === allianceId) allianceTaken += holdings[aid]?.count ?? 0;
      }
      if (allianceTaken + 1 > gateAllianceCapOf(row.capacity)) {
        throw new GateError(`Your alliance may not hold more than 80% of ${airportCode}'s gates combined.`);
      }
    }
    mine.count += 1;
    holdings[airline.id] = mine;
    const updated = await tx.worldGate.updateMany({
      where: { id: row.id, version: row.version },
      data: { taken: row.taken + 1, holdings, version: { increment: 1 } },
    });
    if (updated.count === 0) throw new GateError('The airport just changed — try again.', 409);
    return;
  }

  if (type === 'REMOVE_GATE') {
    if (mine.count <= 0) return; // ledger already has nothing for us here
    mine.count -= 1;
    if (mine.count === 0) delete holdings[airline.id];
    else holdings[airline.id] = mine;
    const updated = await tx.worldGate.updateMany({
      where: { id: row.id, version: row.version },
      data: { taken: Math.max(0, row.taken - 1), holdings, version: { increment: 1 } },
    });
    if (updated.count === 0) throw new GateError('The airport just changed — try again.', 409);
  }
}

// ── CAS-retry mutation helper (used outside decision transactions) ───────────
async function mutateWorldGate(prisma, worldId, airportCode, mutate, { create = false, attempts = 5 } = {}) {
  for (let i = 0; i < attempts; i++) {
    let row = await prisma.worldGate.findUnique({
      where: { worldId_airportCode: { worldId, airportCode } },
    });
    if (!row) {
      if (!create) return { ok: true, missing: true };
      const ap = getAirport(airportCode);
      const cap = gateCapacityOf(ap);
      try {
        row = await prisma.worldGate.create({
          data: { worldId, airportCode, baseSize: cap, capacity: cap, taken: 0, holdings: {} },
        });
      } catch (e) {
        if (e?.code === 'P2002') continue; // lost the create race — reread
        throw e;
      }
    }
    const next = mutate(row);
    if (next == null) return { ok: true, noop: true };
    const updated = await prisma.worldGate.updateMany({
      where: { id: row.id, version: row.version },
      data: { ...next, version: { increment: 1 } },
    });
    if (updated.count > 0) return { ok: true };
  }
  return { ok: false };
}

// Join seed: the new airline's 1 starter hub gate (guarantee — bypasses capacity).
export async function seedHubGate(prisma, worldId, airportCode, airlineId, { log = console } = {}) {
  const res = await mutateWorldGate(prisma, worldId, airportCode, (row) => {
    const holdings = { ...(row.holdings ?? {}) };
    holdings[airlineId] = { ...(holdings[airlineId] ?? { count: 0 }) };
    holdings[airlineId].count += 1;
    return { taken: row.taken + 1, holdings };
  }, { create: true });
  if (!res.ok) log.error?.(`[gates] seedHubGate lost all races for ${airportCode} in ${worldId}`);
}

// Release EVERYTHING an airline holds in a world (bankruptcy / abandonment).
export async function releaseAllFor(prisma, worldId, airlineId, { log = console } = {}) {
  const rows = await prisma.worldGate.findMany({ where: { worldId } });
  for (const r of rows) {
    if (!r.holdings?.[airlineId]?.count) continue;
    const res = await mutateWorldGate(prisma, worldId, r.airportCode, (row) => {
      const mine = row.holdings?.[airlineId]?.count ?? 0;
      if (!mine) return null;
      const holdings = { ...(row.holdings ?? {}) };
      delete holdings[airlineId];
      return { taken: Math.max(0, row.taken - mine), holdings };
    });
    if (!res.ok) log.error?.(`[gates] releaseAllFor lost races at ${r.airportCode} for ${airlineId}`);
  }
  // Their open listings die with them.
  await prisma.gateListing.updateMany({
    where: { worldId, sellerId: airlineId, status: 'OPEN' },
    data: { status: 'WITHDRAWN' },
  });
}

// Post-tick reconcile: the engine's rule-5 forfeitures (gates removed from the
// blob during ADVANCE_WEEK) are mirrored into the ledger. `releases` =
// [{ airlineId, airportCode, count }] from diffing pre/post tick states.
export async function reconcileForfeitures(prisma, worldId, releases, { log = console } = {}) {
  for (const rel of releases) {
    const res = await mutateWorldGate(prisma, worldId, rel.airportCode, (row) => {
      const mine = row.holdings?.[rel.airlineId]?.count ?? 0;
      if (!mine) return null;
      const drop = Math.min(mine, rel.count);
      const holdings = { ...(row.holdings ?? {}) };
      if (mine - drop <= 0) delete holdings[rel.airlineId];
      else holdings[rel.airlineId] = { ...holdings[rel.airlineId], count: mine - drop };
      return { taken: Math.max(0, row.taken - drop), holdings };
    });
    if (!res.ok) log.error?.(`[gates] forfeiture reconcile lost races at ${rel.airportCode}`);
  }
}

// ── Auctions ─────────────────────────────────────────────────────────────────

// Week-40 scan: open an auction for every airport ≥95% full with growth
// headroom. Idempotent (unique [worldId, airportCode, year]).
export async function openDueAuctions(prisma, world, { log = console } = {}) {
  const weekIdx = worldWeekIndex(world);
  const year = world.currentYear + 1; // resolves into the NEW year
  const rows = await prisma.worldGate.findMany({ where: { worldId: world.id } });
  let opened = 0;
  for (const row of rows) {
    if (row.taken < Math.ceil(GATE_AUCTION_TRIGGER * row.capacity)) continue;
    const ceiling = GATE_CAPACITY_GROWTH_CEILING * row.baseSize;
    const lots = Math.min(GATE_AUCTION_LOTS_BY_SIZE[row.baseSize] ?? 2, ceiling - row.capacity);
    if (lots <= 0) continue;
    const ap = getAirport(row.airportCode);
    try {
      await prisma.gateAuction.create({
        data: {
          worldId: world.id,
          airportCode: row.airportCode,
          year,
          lots,
          reserve: auctionReserveOf(ap),
          opensWeek: weekIdx,
          resolvesWeek: weekIdx + (52 - GATE_AUCTION_OPEN_WEEK), // the year tick
        },
      });
      opened++;
    } catch (e) {
      if (e?.code !== 'P2002') throw e; // P2002 = already opened (idempotent)
    }
  }
  if (opened) log.info?.(`[gates] ${world.name}: opened ${opened} gate auction(s) for year ${year}`);
  return { opened };
}

// Year-tick resolution: rank sealed bids (amount desc, seeded random tie-break),
// award pay-as-bid, add won gates to BOTH capacity and the winner's holding.
// Winners must have the cash at resolution (bids are not escrowed) — a broke
// winner is voided and the next bidder moves up.
//
// EVERY bid ends with a recorded outcome (auction.outcomes) and every losing
// bidder is told, in game, why. Before that, a bid voided here — by the cash
// check, an ownership cap, a lockout, or a lost CAS race — vanished without a
// word: the auction flipped to RESOLVED, dropped out of the open-auction view,
// and the feed only ever carried winners. "Nobody won and nothing was added"
// was indistinguishable from "the auction never ran".
export async function resolveDueAuctions(prisma, world, { log = console } = {}) {
  const weekIdx = worldWeekIndex(world);
  const due = await prisma.gateAuction.findMany({
    where: { worldId: world.id, status: 'OPEN', resolvesWeek: { lte: weekIdx } },
    include: { bids: true },
  });
  // Dynamic import avoids a static cycle (humanRivals imports this module for
  // the gate-market views).
  let allianceMap = new Map();
  if (due.length > 0) {
    const { loadAllianceMap } = await import('./humanRivals.mjs');
    allianceMap = await loadAllianceMap(prisma, world.id);
  }

  for (const auction of due) {
    const seed = world.worldSeed ?? world.id;
    const qualifying = auction.bids.filter((b) => b.amount >= auction.reserve);
    const ranked = [...qualifying]
      .sort((a, b) => (b.amount - a.amount)
        || (seededRand(seed, `gatetie:${auction.id}:${b.airlineId}`)
          - seededRand(seed, `gatetie:${auction.id}:${a.airlineId}`)));

    let lotsLeft = auction.lots;
    const results = [];
    const outcomes = [];
    // placeBid refuses anything under the reserve, so these only exist if the
    // reserve moved after the fact — record them rather than drop them.
    for (const b of auction.bids) {
      if (b.amount < auction.reserve) {
        outcomes.push({
          airlineId: b.airlineId, airline: null, amount: b.amount, quantity: b.quantity,
          gates: 0, reason: 'BELOW_RESERVE', detail: null,
        });
      }
    }

    for (const bid of ranked) {
      const out = {
        airlineId: bid.airlineId, airline: null, amount: bid.amount,
        quantity: bid.quantity, gates: 0, reason: null, detail: null,
      };
      outcomes.push(out);

      if (lotsLeft <= 0) { out.reason = 'OUTBID'; continue; }

      // Re-read the airline fresh — cash and caps as of RIGHT NOW.
      let airline = await prisma.airline.findUnique({ where: { id: bid.airlineId } });
      out.airline = airline?.name ?? null;
      if (!airline || airline.status !== 'ACTIVE') { out.reason = 'AIRLINE_INACTIVE'; continue; }

      const row = await prisma.worldGate.findUnique({
        where: { worldId_airportCode: { worldId: world.id, airportCode: auction.airportCode } },
      });
      if (!row) { out.reason = 'NO_LEDGER_ROW'; continue; }

      // Clamp quantity to lots left and to the ownership caps AT THE GROWN
      // capacity (each awarded gate raises capacity by one as it lands).
      let q = Math.max(1, Math.min(GATE_BID_MAX_QTY, bid.quantity ?? 1));
      q = Math.min(q, lotsLeft);
      const mine = holdingsCount(row, bid.airlineId);
      let capBlock = null;
      while (q > 0 && mine + q > gateAirlineCapOf(row.capacity + q)) { q--; capBlock = 'OWNERSHIP_CAP'; }
      const myAlliance = allianceMap.get(bid.airlineId);
      if (myAlliance && q > 0) {
        const allianceId = myAlliance.membership.allianceId;
        let allianceTaken = 0;
        for (const [aid, m] of allianceMap) {
          if (m.membership.allianceId === allianceId) allianceTaken += row.holdings?.[aid]?.count ?? 0;
        }
        while (q > 0 && allianceTaken + q > gateAllianceCapOf(row.capacity + q)) { q--; capBlock = 'ALLIANCE_CAP'; }
      }
      if (q <= 0) {
        out.reason = capBlock ?? 'OWNERSHIP_CAP';
        out.detail = out.reason === 'ALLIANCE_CAP'
          ? `your alliance may hold at most ${gateAllianceCapOf(row.capacity + 1)} of ${row.capacity + 1} gates here`
          : `you may hold at most ${gateAirlineCapOf(row.capacity + 1)} of ${row.capacity + 1} gates here, and already hold ${mine}`;
        continue;
      }
      // Lockout check: an airline locked out of this airport cannot win here.
      const lockedUntil = airline.state?.gateLockouts?.[auction.airportCode] ?? 0;
      if (lockedUntil > weekIdx) {
        out.reason = 'LOCKED_OUT';
        out.detail = `locked out until week ${lockedUntil}`;
        continue;
      }
      // Cash check — no escrow; broke winners are voided.
      if ((airline.state?.cash ?? 0) < bid.amount * q) {
        out.reason = 'INSUFFICIENT_CASH';
        out.detail = `${q} gate${q > 1 ? 's' : ''} cost $${(bid.amount * q).toLocaleString()}, you held $${Math.round(airline.state?.cash ?? 0).toLocaleString()}`;
        continue;
      }

      // Apply through the engine (cash math stays in the reducer), CAS both
      // writes. A lost race means a player decision landed between the read and
      // the write — re-read once and try again rather than silently voiding a
      // bid that was good.
      let awarded = false;
      for (let attempt = 0; attempt < 2 && !awarded; attempt++) {
        const next = gameReducer(airline.state, {
          type: 'GATE_AWARDED', airportCode: auction.airportCode, gates: q, pricePerGate: bid.amount,
        });
        const wrote = await prisma.airline.updateMany({
          where: { id: airline.id, version: airline.version },
          data: {
            state: next,
            cash: BigInt(Math.round(next.cash ?? 0)),
            version: { increment: 1 },
          },
        });
        if (wrote.count > 0) { awarded = true; break; }
        const fresh = await prisma.airline.findUnique({ where: { id: bid.airlineId } });
        if (!fresh || fresh.status !== 'ACTIVE' || (fresh.state?.cash ?? 0) < bid.amount * q) break;
        airline = fresh;
      }
      if (!awarded) { out.reason = 'WRITE_CONFLICT'; continue; }

      const led = await mutateWorldGate(prisma, world.id, auction.airportCode, (r) => {
        const holdings = { ...(r.holdings ?? {}) };
        const entry = { ...(holdings[bid.airlineId] ?? { count: 0 }) };
        entry.count += q;
        entry.cooldownUntilWeek = weekIdx + GATE_ANTI_FLIP_WEEKS;
        holdings[bid.airlineId] = entry;
        return { capacity: r.capacity + q, taken: r.taken + q, holdings };
      });
      if (!led.ok) log.error?.(`[gates] award ledger update lost races at ${auction.airportCode}`);

      lotsLeft -= q;
      out.gates = q;
      out.reason = 'WON';
      if (q < (bid.quantity ?? 1)) out.detail = `you bid for ${bid.quantity}, ${q} could be awarded`;
      results.push({ airlineId: airline.id, airline: airline.name, gates: q, pricePerGate: bid.amount });
    }

    // Tell the losers. Winners already get their toast from GATE_AWARDED; a
    // losing bid used to produce nothing at all, which is the whole reason a
    // resolved auction felt like it had never happened.
    for (const out of outcomes) {
      if (out.reason === 'WON') continue;
      await notifyLosingBidder(prisma, {
        airportCode: auction.airportCode, worldId: world.id, outcome: out, log,
      });
    }

    await prisma.gateAuction.update({
      where: { id: auction.id },
      data: { status: 'RESOLVED', results, outcomes, resolvedAt: new Date() },
    });
    log.info?.(`[gates] ${world.name}: auction at ${auction.airportCode} resolved — ${results.length ? results.map((r) => `${r.airline}×${r.gates}@$${r.pricePerGate}`).join(', ') : 'no qualifying bids'}${outcomes.length ? ` (${outcomes.length} bid(s): ${outcomes.map((o) => o.reason).join(', ')})` : ''}`);
  }
  return { resolved: due.length };
}

// Best-effort toast into a losing bidder's blob. Never throws: a failure here
// must not stop the rest of the auction resolving, and the outcome is still
// recorded on the auction row either way.
async function notifyLosingBidder(prisma, { airportCode, worldId, outcome, log }) {
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const airline = await prisma.airline.findUnique({ where: { id: outcome.airlineId } });
      if (!airline || airline.worldId !== worldId || airline.status !== 'ACTIVE') return;
      if (!outcome.airline) outcome.airline = airline.name;
      const next = gameReducer(airline.state, {
        type: 'GATE_BID_LOST',
        airportCode,
        reason: outcome.reason,
        detail: outcome.detail,
        amount: outcome.amount,
        quantity: outcome.quantity,
      });
      const wrote = await prisma.airline.updateMany({
        where: { id: airline.id, version: airline.version },
        data: { state: next, version: { increment: 1 } },
      });
      if (wrote.count > 0) return;
    }
    log?.error?.(`[gates] could not deliver a losing-bid notice at ${airportCode}`);
  } catch (err) {
    log?.error?.(`[gates] losing-bid notice failed at ${airportCode}:`, err?.message ?? err);
  }
}


// ── Auction eligibility (the caps, applied BEFORE you bid) ──────────────────
// The ownership caps used to be checked only at lease time and again at
// resolution, with nothing in between. So a sealed bid could be accepted,
// held for twelve weeks, and voided at the year tick by a cap that was
// already unsatisfiable the moment it was placed — and the bidder was told
// none of it. This is that same arithmetic, exported so placeBid can refuse
// an unwinnable bid on the spot and the client can grey the form out.
//
// Returns { maxWinnable, reason, detail }: the largest number of gates this
// airline could actually be awarded here, and — when that is zero — which cap
// is responsible.
export function gateAuctionEligibility(row, airlineId, allianceMap, lots) {
  const capacity = row?.capacity ?? 0;
  const mine = holdingsCount(row, airlineId);
  const ceiling = Math.max(1, Math.min(GATE_BID_MAX_QTY, lots || 1));

  let q = ceiling;
  let reason = null;
  let detail = null;
  while (q > 0 && mine + q > gateAirlineCapOf(capacity + q)) {
    q--;
    reason = 'OWNERSHIP_CAP';
    detail = `no airline may hold more than ${Math.round(GATE_AIRLINE_CAP * 100)}% of an airport's gates — you already hold ${mine} of ${capacity} here`;
  }

  const myAlliance = allianceMap?.get?.(airlineId);
  if (myAlliance && q > 0) {
    const allianceId = myAlliance.membership.allianceId;
    let allianceTaken = 0;
    for (const [aid, m] of allianceMap) {
      if (m.membership.allianceId === allianceId) allianceTaken += row?.holdings?.[aid]?.count ?? 0;
    }
    while (q > 0 && allianceTaken + q > gateAllianceCapOf(capacity + q)) {
      q--;
      reason = 'ALLIANCE_CAP';
      detail = `your alliance already holds ${allianceTaken} of ${capacity} gates here, and may not hold more than ${Math.round(GATE_ALLIANCE_CAP * 100)}%`;
    }
  }

  return { maxWinnable: q, reason: q > 0 ? null : reason, detail: q > 0 ? null : detail };
}

// Airports where making `memberIds` one alliance would breach the combined cap.
// Every path that ACQUIRES a gate enforces this cap; nothing enforced it on the
// transaction that actually creates a monopoly — forming or joining an alliance.
// Two carriers each legally under the 60% single-airline cap could merge into a
// 100% holder of an airport, and the cap then became a one-way ratchet: they
// kept every gate and simply could never win another.
export async function allianceGateCapBreaches(prisma, { world, memberIds }) {
  if (!isGateScarcity(world) || memberIds.length < 2) return [];
  const rows = await prisma.worldGate.findMany({ where: { worldId: world.id } });
  const breaches = [];
  for (const row of rows) {
    const combined = memberIds.reduce((n, id) => n + (row.holdings?.[id]?.count ?? 0), 0);
    const cap = gateAllianceCapOf(row.capacity);
    if (combined > cap) {
      breaches.push({ airportCode: row.airportCode, combined, cap, capacity: row.capacity });
    }
  }
  return breaches.sort((a, b) => (b.combined - b.cap) - (a.combined - a.cap));
}

// One sentence a player can act on, for the 409 that refuses the join.
export function describeGateCapBreaches(breaches) {
  const list = breaches
    .map((b) => `${b.airportCode} (${b.combined} of ${b.capacity} gates, cap ${b.cap})`)
    .join(', ');
  return `That would put the alliance over the ${Math.round(GATE_ALLIANCE_CAP * 100)}% gate cap at ${list}. `
    + 'Sell or release gates there first — the cap applies to alliances the same way it applies to a single airline.';
}

// ── Sealed bids ──────────────────────────────────────────────────────────────

export async function placeBid(prisma, { world, airline, airportCode, amount, quantity = 1, allianceMap = new Map() }) {
  const auction = await prisma.gateAuction.findFirst({
    where: { worldId: world.id, airportCode, status: 'OPEN' },
  });
  if (!auction) throw new GateError(`No open gate auction at ${airportCode}.`, 404);
  const amt = Math.round(Number(amount));
  const q = Math.round(Number(quantity));
  if (!Number.isFinite(amt) || amt < auction.reserve) {
    throw new GateError(`Bids at ${airportCode} start at $${auction.reserve.toLocaleString()} per gate.`);
  }
  if (amt > 1e10) throw new GateError('Bid is implausibly large.');
  // Nobody can win more gates than are on offer, so don't let anyone bid for
  // more: the cap is the anti-monopoly limit or the lot count, whichever bites.
  const weekIdx = worldWeekIndex(world);
  const lockedUntil = airline.state?.gateLockouts?.[airportCode] ?? 0;
  if (lockedUntil > weekIdx) {
    throw new GateError(`You are locked out of ${airportCode} — you cannot bid there right now.`);
  }
  // The ownership caps decide this too, not just the lot count — and they are
  // applied at RESOLUTION, so a bid that cannot clear them is dead on arrival.
  // Refuse it now, with the reason, instead of holding it for twelve weeks and
  // voiding it at the year tick.
  const row = await prisma.worldGate.findUnique({
    where: { worldId_airportCode: { worldId: world.id, airportCode } },
  }) ?? { capacity: gateCapacityOf(getAirport(airportCode)), holdings: {} };
  const eligible = gateAuctionEligibility(row, airline.id, allianceMap, auction.lots);
  if (eligible.maxWinnable < 1) {
    throw new GateError(`You cannot win a gate at ${airportCode}: ${eligible.detail}.`);
  }
  const maxQ = eligible.maxWinnable;
  // Two different reasons produce a cap of 1, and they want different wording:
  // a one-lot auction, versus an ownership cap that leaves you room for one.
  const capLimited = maxQ < Math.min(GATE_BID_MAX_QTY, auction.lots);
  if (!Number.isInteger(q) || q < 1 || q > maxQ) {
    if (maxQ === 1) {
      throw new GateError(capLimited
        ? `You can bid for 1 gate at ${airportCode} — the ownership caps mean a second could not be awarded to you.`
        : `Only 1 gate is on offer at ${airportCode} — you can bid for 1.`);
    }
    throw new GateError(`You may bid for 1–${maxQ} gates at ${airportCode}`
      + (capLimited ? ' — the ownership caps allow you no more.' : ` (${auction.lots} on offer).`));
  }
  await prisma.gateBid.upsert({
    where: { auctionId_airlineId: { auctionId: auction.id, airlineId: airline.id } },
    create: { auctionId: auction.id, airlineId: airline.id, amount: amt, quantity: q },
    update: { amount: amt, quantity: q },
  });
}

export async function withdrawBid(prisma, { world, airline, airportCode }) {
  const auction = await prisma.gateAuction.findFirst({
    where: { worldId: world.id, airportCode, status: 'OPEN' },
  });
  if (!auction) throw new GateError(`No open gate auction at ${airportCode}.`, 404);
  await prisma.gateBid.deleteMany({ where: { auctionId: auction.id, airlineId: airline.id } });
}

// ── Marketplace (player-to-player, listings at ask price) ────────────────────

function slotsUsedAt(state, code) {
  const pax = (state.routes ?? [])
    .filter((r) => r.origin === code || r.destination === code || (r.stops ?? []).includes(code))
    .reduce((s, r) => s + (r.weeklyFrequency ?? 0), 0);
  return pax + cargoSlotsUsedAt(code, state.cargoRoutes ?? []);
}

export async function createListing(prisma, { world, airline, airportCode, askPrice }) {
  const price = Math.round(Number(askPrice));
  if (!Number.isFinite(price) || price <= 0 || price > 1e10) throw new GateError('Invalid asking price.');
  const count = airline.state?.gates?.[airportCode] ?? 0;
  if (count <= 0) throw new GateError(`You hold no gates at ${airportCode}.`);

  // Home-hub guarantee gates (the first N at your hub) can never be sold.
  const isHome = airportCode === (airline.hub ?? airline.state?.hub);
  const sellable = isHome ? Math.max(0, count - GATE_HUB_GUARANTEE) : count;
  const openListings = await prisma.gateListing.count({
    where: { worldId: world.id, sellerId: airline.id, airportCode, status: 'OPEN' },
  });
  if (openListings + 1 > sellable) {
    throw new GateError(isHome
      ? `Your first ${GATE_HUB_GUARANTEE} home-hub gates are guaranteed and cannot be sold.`
      : `You have no unlisted gate left to sell at ${airportCode}.`);
  }
  // Your routes must still fit on one fewer gate.
  if (slotsUsedAt(airline.state, airportCode) > (count - (openListings + 1)) * SLOTS_PER_GATE) {
    throw new GateError(`Your routes are using that gate's slots — close or move frequency off ${airportCode} first.`);
  }
  // Anti-flip: gates won at auction / bought stay unsellable for a while.
  const row = await prisma.worldGate.findUnique({
    where: { worldId_airportCode: { worldId: world.id, airportCode } },
  });
  const cooldown = row?.holdings?.[airline.id]?.cooldownUntilWeek ?? 0;
  const weekIdx = worldWeekIndex(world);
  if (cooldown > weekIdx) {
    throw new GateError(`Recently acquired gates at ${airportCode} cannot be re-listed for ${cooldown - weekIdx} more week(s).`);
  }

  const listing = await prisma.gateListing.create({
    data: { worldId: world.id, airportCode, sellerId: airline.id, askPrice: price },
  });
  // Bump the seller's version so every player's world stamp moves and the new
  // listing shows up on their next poll.
  await prisma.airline.update({ where: { id: airline.id }, data: { version: { increment: 1 } } });
  return listing;
}

export async function withdrawListing(prisma, { airline, listingId }) {
  const updated = await prisma.gateListing.updateMany({
    where: { id: listingId, sellerId: airline.id, status: 'OPEN' },
    data: { status: 'WITHDRAWN' },
  });
  if (updated.count === 0) throw new GateError('That listing is no longer open.', 404);
  await prisma.airline.update({ where: { id: airline.id }, data: { version: { increment: 1 } } });
}

// Atomic gate transfer: buyer pays ask, seller gets proceeds, holdings move,
// listing closes — all in one transaction, CAS-guarded on every row touched.
export async function buyListing(prisma, { world, buyer, listingId, allianceMap = new Map() }) {
  const weekIdx = worldWeekIndex(world);
  // withTx, not a bare $transaction: this touches TWO airline rows plus the gate
  // ledger, so it is both the slowest player write and the one most likely to sit
  // behind the tick's locks. Prisma's 5s default budget surfaced that as a raw
  // "Transaction already closed" toast. See lib/tx.mjs.
  return withTx(prisma, async (tx) => {
    const listing = await tx.gateListing.findUnique({ where: { id: listingId } });
    if (!listing || listing.status !== 'OPEN' || listing.worldId !== world.id) {
      throw new GateError('That listing is no longer open.', 404);
    }
    if (listing.sellerId === buyer.id) throw new GateError('You cannot buy your own listing.');
    const code = listing.airportCode;

    // An estate listing has no counterparty to protect: the airline named on it
    // is gone. Every seller-side check below exists for a live seller — but
    // every BUYER-side check still applies, which is why those live after this
    // branch rather than inside it.
    const estate = listing.distressed === true;
    let seller = null;
    if (!estate) {
      seller = await tx.airline.findUnique({ where: { id: listing.sellerId } });
      if (!seller || seller.status !== 'ACTIVE') throw new GateError('The seller is no longer active.', 409);
      const sellerCount = seller.state?.gates?.[code] ?? 0;
      if (sellerCount <= 0) throw new GateError('The seller no longer holds that gate.', 409);
      if (slotsUsedAt(seller.state, code) > (sellerCount - 1) * SLOTS_PER_GATE) {
        throw new GateError('The seller can no longer spare that gate (their routes are using it).', 409);
      }
    }

    // Buyer-side checks: cash, lockout, 60% cap, 80% alliance cap.
    if ((buyer.state?.cash ?? 0) < listing.askPrice) throw new GateError('You cannot afford that gate.');
    const lockedUntil = buyer.state?.gateLockouts?.[code] ?? 0;
    if (lockedUntil > weekIdx) throw new GateError(`You are locked out of ${code} right now.`);
    const row = await tx.worldGate.findUnique({
      where: { worldId_airportCode: { worldId: world.id, airportCode: code } },
    });
    if (!row) throw new GateError('Gate ledger is missing for that airport.', 409);
    const buyerHeld = holdingsCount(row, buyer.id);
    if (buyerHeld + 1 > gateAirlineCapOf(row.capacity)) {
      throw new GateError(`No airline may hold more than 60% of ${code}'s gates.`);
    }
    const myAlliance = allianceMap.get(buyer.id);
    if (myAlliance) {
      const allianceId = myAlliance.membership.allianceId;
      let allianceTaken = 0;
      for (const [aid, m] of allianceMap) {
        if (m.membership.allianceId === allianceId) allianceTaken += row.holdings?.[aid]?.count ?? 0;
      }
      if (allianceTaken + 1 > gateAllianceCapOf(row.capacity)) {
        throw new GateError(`Your alliance may not hold more than 80% of ${code}'s gates combined.`);
      }
    }

    // Engine applies both sides (cash math lives in the reducer). On an estate
    // sale the money simply leaves the world: crediting a bankrupt airline's
    // blob would be paying a company that no longer exists, and it would put
    // cash back into a world that has already written it off.
    const buyerNext = gameReducer(buyer.state, { type: 'GATE_PURCHASED', airportCode: code, price: listing.askPrice });
    const sellerNext = estate ? null
      : gameReducer(seller.state, { type: 'GATE_SOLD', airportCode: code, proceeds: listing.askPrice });

    // Both sides are written in a deterministic order (by airline id), NOT
    // buyer-then-seller. If A is buying a gate from B at the same moment B is
    // buying one from A, a buyer-first order has each transaction holding the row
    // the other needs — a textbook deadlock, which Postgres resolves by killing
    // one of them (Prisma P2034). Sorting by id means every transaction in this
    // world grabs the two rows in the same sequence, so they queue instead.
    const sides = [
      {
        id: buyer.id, version: buyer.version, next: buyerNext,
        conflict: 'Your airline just changed — reload and try again.',
      },
      // No second side on an estate sale — one row, so nothing to order.
      ...(estate ? [] : [{
        id: seller.id, version: seller.version, next: sellerNext,
        conflict: 'The seller just changed — try again.',
      }]),
    ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    for (const side of sides) {
      const wrote = await tx.airline.updateMany({
        where: { id: side.id, version: side.version },
        data: { state: side.next, cash: BigInt(Math.round(side.next.cash ?? 0)), version: { increment: 1 } },
      });
      if (wrote.count === 0) throw new GateError(side.conflict, 409);
    }

    // Holdings move; the buyer inherits an anti-flip cooldown. On an estate
    // sale the gate is still on the ledger under the DEAD airline's id — it was
    // deliberately not released, so the airport could not quietly re-sell
    // capacity it had already committed. This is where it finally moves.
    const holdings = { ...(row.holdings ?? {}) };
    const fromId = listing.sellerId;
    if (fromId && holdings[fromId]) {
      const sellerEntry = { ...holdings[fromId] };
      sellerEntry.count = Math.max(0, (sellerEntry.count ?? 0) - 1);
      if (sellerEntry.count === 0) delete holdings[fromId];
      else holdings[fromId] = sellerEntry;
    }
    const buyerEntry = { ...(holdings[buyer.id] ?? { count: 0 }) };
    buyerEntry.count += 1;
    buyerEntry.cooldownUntilWeek = weekIdx + GATE_ANTI_FLIP_WEEKS;
    holdings[buyer.id] = buyerEntry;
    const wroteRow = await tx.worldGate.updateMany({
      where: { id: row.id, version: row.version },
      data: { holdings, version: { increment: 1 } }, // taken unchanged — the gate changed hands
    });
    if (wroteRow.count === 0) throw new GateError('The airport just changed — try again.', 409);

    await tx.gateListing.update({
      where: { id: listing.id },
      data: { status: 'SOLD', buyerId: buyer.id, soldAt: new Date() },
    });
    return { buyerState: buyerNext };
  });
}

// Public per-world availability summary (lobby + hub picker).
export async function gateWorldSummary(prisma, worldId) {
  const [rows, auctions] = await Promise.all([
    prisma.worldGate.findMany({ where: { worldId } }),
    prisma.gateAuction.findMany({ where: { worldId, status: 'OPEN' } }),
  ]);
  const auctionByCode = new Map(auctions.map((a) => [a.airportCode, a]));
  return rows.map((r) => ({
    airportCode: r.airportCode,
    capacity: r.capacity,
    taken: r.taken,
    surcharge: r.taken > GATE_SURCHARGE_THRESHOLD * r.capacity,
    auction: auctionByCode.has(r.airportCode)
      ? { lots: auctionByCode.get(r.airportCode).lots, reserve: auctionByCode.get(r.airportCode).reserve, closesWeek: auctionByCode.get(r.airportCode).resolvesWeek }
      : null,
  }));
}
