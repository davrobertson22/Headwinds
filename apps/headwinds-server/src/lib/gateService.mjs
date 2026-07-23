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
  GATE_FEE_BY_TIER, GATE_HUB_GUARANTEE, GATE_ANTI_FLIP_WEEKS,
  GATE_AUCTION_LOTS_BY_SIZE, GATE_AUCTION_OPEN_WEEK, GATE_AUCTION_TRIGGER,
  GATE_CAPACITY_GROWTH_CEILING, GATE_SURCHARGE_THRESHOLD,
} from '@tailwinds/engine/data/airports.js';
import { SLOTS_PER_GATE, cargoSlotsUsedAt } from '@tailwinds/engine/utils/simulation.js';

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

// ── The gate-market view (injected into state as state.gateMarket) ───────────
// One base map per world, personalized per airline (yours / allianceTaken /
// yourBid / listings ownership). Sparse: only airports with a ledger row, an
// open auction, or an open listing appear — the client derives capacity for
// untouched airports itself via gateCapacityOf.
export async function buildGateMarketViews(prisma, worldId, { airlines, allianceMap = new Map(), world }) {
  const [rows, auctions, listings] = await Promise.all([
    prisma.worldGate.findMany({ where: { worldId } }),
    prisma.gateAuction.findMany({ where: { worldId, status: 'OPEN' }, include: { bids: true } }),
    prisma.gateListing.findMany({ where: { worldId, status: 'OPEN' } }),
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
  const listingsByCode = new Map();
  for (const l of listings) {
    if (!listingsByCode.has(l.airportCode)) listingsByCode.set(l.airportCode, []);
    listingsByCode.get(l.airportCode).push(l);
  }
  // Airports that only exist as an auction/listing still need a base entry.
  for (const code of [...auctionsByCode.keys(), ...listingsByCode.keys()]) {
    if (!base[code]) {
      const cap = gateCapacityOf(getAirport(code));
      base[code] = { capacity: cap, baseSize: cap, taken: 0, maxYours: gateAirlineCapOf(cap), surcharge: false, holdings: {} };
    }
  }

  const views = new Map();
  for (const me of airlines) {
    const myAlliance = allianceMap.get(me.id);
    const roster = myAlliance ? (allianceRoster.get(myAlliance.membership.allianceId) ?? []) : null;
    const airports = {};
    for (const [code, b] of Object.entries(base)) {
      const auction = auctionsByCode.get(code);
      const myBid = auction?.bids.find((bd) => bd.airlineId === me.id);
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
        } : null,
        listings: codeListings,
      };
    }
    views.set(me.id, { week: world ? worldWeekIndex(world) : null, airports });
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
    const ranked = [...auction.bids]
      .filter((b) => b.amount >= auction.reserve)
      .sort((a, b) => (b.amount - a.amount)
        || (seededRand(seed, `gatetie:${auction.id}:${b.airlineId}`)
          - seededRand(seed, `gatetie:${auction.id}:${a.airlineId}`)));

    let lotsLeft = auction.lots;
    const results = [];
    for (const bid of ranked) {
      if (lotsLeft <= 0) break;
      // Re-read the airline fresh — cash and caps as of RIGHT NOW.
      const airline = await prisma.airline.findUnique({ where: { id: bid.airlineId } });
      if (!airline || airline.status !== 'ACTIVE') continue;

      const row = await prisma.worldGate.findUnique({
        where: { worldId_airportCode: { worldId: world.id, airportCode: auction.airportCode } },
      });
      if (!row) continue;

      // Clamp quantity to lots left and to the ownership caps AT THE GROWN
      // capacity (each awarded gate raises capacity by one as it lands).
      let q = Math.max(1, Math.min(3, bid.quantity ?? 1));
      q = Math.min(q, lotsLeft);
      const mine = holdingsCount(row, bid.airlineId);
      while (q > 0 && mine + q > gateAirlineCapOf(row.capacity + q)) q--;
      const myAlliance = allianceMap.get(bid.airlineId);
      if (myAlliance && q > 0) {
        const allianceId = myAlliance.membership.allianceId;
        let allianceTaken = 0;
        for (const [aid, m] of allianceMap) {
          if (m.membership.allianceId === allianceId) allianceTaken += row.holdings?.[aid]?.count ?? 0;
        }
        while (q > 0 && allianceTaken + q > gateAllianceCapOf(row.capacity + q)) q--;
      }
      if (q <= 0) continue;
      // Lockout check: an airline locked out of this airport cannot win here.
      const lockedUntil = airline.state?.gateLockouts?.[auction.airportCode] ?? 0;
      if (lockedUntil > weekIdx) continue;
      // Cash check — no escrow; broke winners are voided.
      if ((airline.state?.cash ?? 0) < bid.amount * q) continue;

      // Apply through the engine (cash math stays in the reducer), CAS both writes.
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
      if (wrote.count === 0) continue; // the airline moved under us — skip; bid stands unresolved

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
      results.push({ airlineId: airline.id, airline: airline.name, gates: q, pricePerGate: bid.amount });
    }

    await prisma.gateAuction.update({
      where: { id: auction.id },
      data: { status: 'RESOLVED', results, resolvedAt: new Date() },
    });
    log.info?.(`[gates] ${world.name}: auction at ${auction.airportCode} resolved — ${results.length ? results.map((r) => `${r.airline}×${r.gates}@$${r.pricePerGate}`).join(', ') : 'no qualifying bids'}`);
  }
  return { resolved: due.length };
}

// ── Sealed bids ──────────────────────────────────────────────────────────────

export async function placeBid(prisma, { world, airline, airportCode, amount, quantity = 1 }) {
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
  if (!Number.isInteger(q) || q < 1 || q > 3) throw new GateError('You may bid for 1–3 gates.');
  const weekIdx = worldWeekIndex(world);
  const lockedUntil = airline.state?.gateLockouts?.[airportCode] ?? 0;
  if (lockedUntil > weekIdx) {
    throw new GateError(`You are locked out of ${airportCode} — you cannot bid there right now.`);
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
  return prisma.$transaction(async (tx) => {
    const listing = await tx.gateListing.findUnique({ where: { id: listingId } });
    if (!listing || listing.status !== 'OPEN' || listing.worldId !== world.id) {
      throw new GateError('That listing is no longer open.', 404);
    }
    if (listing.sellerId === buyer.id) throw new GateError('You cannot buy your own listing.');
    const code = listing.airportCode;

    const seller = await tx.airline.findUnique({ where: { id: listing.sellerId } });
    if (!seller || seller.status !== 'ACTIVE') throw new GateError('The seller is no longer active.', 409);
    const sellerCount = seller.state?.gates?.[code] ?? 0;
    if (sellerCount <= 0) throw new GateError('The seller no longer holds that gate.', 409);
    if (slotsUsedAt(seller.state, code) > (sellerCount - 1) * SLOTS_PER_GATE) {
      throw new GateError('The seller can no longer spare that gate (their routes are using it).', 409);
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

    // Engine applies both sides (cash math lives in the reducer).
    const buyerNext = gameReducer(buyer.state, { type: 'GATE_PURCHASED', airportCode: code, price: listing.askPrice });
    const sellerNext = gameReducer(seller.state, { type: 'GATE_SOLD', airportCode: code, proceeds: listing.askPrice });

    const wroteBuyer = await tx.airline.updateMany({
      where: { id: buyer.id, version: buyer.version },
      data: { state: buyerNext, cash: BigInt(Math.round(buyerNext.cash ?? 0)), version: { increment: 1 } },
    });
    if (wroteBuyer.count === 0) throw new GateError('Your airline just changed — reload and try again.', 409);
    const wroteSeller = await tx.airline.updateMany({
      where: { id: seller.id, version: seller.version },
      data: { state: sellerNext, cash: BigInt(Math.round(sellerNext.cash ?? 0)), version: { increment: 1 } },
    });
    if (wroteSeller.count === 0) throw new GateError('The seller just changed — try again.', 409);

    // Holdings move; the buyer inherits an anti-flip cooldown.
    const holdings = { ...(row.holdings ?? {}) };
    const sellerEntry = { ...(holdings[seller.id] ?? { count: 0 }) };
    sellerEntry.count = Math.max(0, sellerEntry.count - 1);
    if (sellerEntry.count === 0) delete holdings[seller.id];
    else holdings[seller.id] = sellerEntry;
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
