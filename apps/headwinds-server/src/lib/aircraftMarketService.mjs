// The used aircraft market — service layer.
// ----------------------------------------------------------------------------
// The game is the counterparty on BOTH sides (no direct player-to-player deal):
//   • A completed SELL_AIRCRAFT pays the seller NAV − 5% (in the reducer) and
//     lists that exact tail here at NAV (listSoldAircraftTx, called in the same
//     decision transaction). The 5% spread is the shop's cut — a cash sink, and
//     the only anti-abuse the design needs (every round trip loses 5%).
//   • Any airline can buy a listing at its frozen NAV (buyUsed, or several at once
//     with buyUsedBatch); the tail arrives on the NEXT weekly tick, rebuilt from
//     its snapshot (real age / cabin / engines / maintenance). A listing's age and price are frozen while it sits.
//   • A listing unsold for USED_SCRAP_WEEKS (2 game-years) is scrapped by the tick.
//
// Every listing is game-owned, so the world's inventory is one shared list. Race
// safety on a purchase comes from a conditional UPDATE (claim WHERE status='OPEN')
// inside the same transaction as the buyer's version-guarded blob write.
import { gameReducer } from '@tailwinds/engine/reducer';
import { getAircraftType } from '@tailwinds/engine/data/aircraft.js';
import { eventAircraftDenial } from '@tailwinds/engine/data/eventRules.js';
import { withTx } from './tx.mjs';

export class AircraftMarketError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'AircraftMarketError';
    this.statusCode = statusCode;
  }
}

// Weeks a listing may sit unsold before the tick scraps it (2 game-years).
export const USED_SCRAP_WEEKS = 104;

// The portable snapshot stored on a listing: the exact tail MINUS its identity
// (a fresh id / tail number / status are assigned to the buyer on delivery). Age,
// cabin config, engine mods and maintenance state all ride along in `rest`.
export function aircraftSnapshot(aircraft) {
  const { id, tailNumber, status, ...rest } = aircraft ?? {};
  return rest;
}

// Called INSIDE the decision transaction, right after a successful SELL_AIRCRAFT.
// `navPrice` is the exact NAV the sale was valued at (the reducer exposes it as
// state.lastSale.nav), so the listing price can never drift from what the seller
// was paid for.
export async function listSoldAircraftTx(tx, { worldId, sellerName, aircraft, navPrice, weekIdx, distressed = false }) {
  const price = Math.max(0, Math.round(Number(navPrice) || 0));
  if (!aircraft || !aircraft.typeId || price <= 0) return null;
  return tx.usedAircraftListing.create({
    data: {
      worldId,
      origin:     sellerName ?? null,
      typeId:     aircraft.typeId,
      snapshot:   aircraftSnapshot(aircraft),
      navPrice:   price,
      listedWeek: weekIdx,
      // An administrator's sale from a failed airline's estate. Priced below
      // book because the seller has no choice, and worth saying so on the
      // listing — a bargain nobody can explain looks like a bug.
      distressed,
    },
  });
}

// The client-facing view of a world's OPEN inventory (one shared list — every
// listing is game-owned). Cheapest first.
export async function buildUsedMarketView(prisma, worldId) {
  const rows = await prisma.usedAircraftListing.findMany({
    where: { worldId, status: 'OPEN' },
    orderBy: { navPrice: 'asc' },
  });
  const listings = rows.map((r) => {
    const snap = r.snapshot ?? {};
    const type = getAircraftType(r.typeId);
    return {
      id:          r.id,
      typeId:      r.typeId,
      typeName:    type?.name ?? r.typeId,
      category:    type?.category ?? null,
      name:        snap.name ?? type?.name ?? r.typeId,
      origin:      r.origin ?? null,
      ageWeeks:    snap.ageWeeks ?? 0,
      seats:       type?.seats ?? null,
      config:      snap.config ?? null,
      engineLabel: snap.engineLabel ?? null,
      price:       r.navPrice,
      listedWeek:  r.listedWeek,
    };
  });
  return { listings };
}

// The most listings one bulk purchase may name. "Tick a few and buy them at once"
// (VodkaOnFire, Discord 2026-10-25) — on a busy server each single buy is a full
// request plus a rebuild of every rival's view, so ten jets took minutes. Fifty is
// far more than anyone selects by hand and keeps the claims well inside TX_OPTS.
// The Used Market's checkboxes cap at the same number (src/components/UsedMarket.jsx).
export const USED_BATCH_MAX = 50;

const UNAVAILABLE = 'That aircraft is no longer available.';
const SNIPED      = 'That aircraft was just bought by someone else.';
const NO_CASH     = 'You cannot afford that aircraft.';

// Atomic purchase of one or more listings, in the order given: each listing is
// claimed (first buyer wins — a racing buyer's UPDATE matches 0 rows), then the
// engine does the cash + one-week delivery math on a running state. ONE blob write
// at the end, version-guarded, all inside one transaction — so a failed buyer
// write rolls every claim back too.
//
// A listing that can't be had (gone, sniped, event-restricted, or more than the
// cash left after the ones before it) is SKIPPED with its reason rather than
// failing the batch: in a live market, one jet bought out from under you shouldn't
// cost you the other nine. If nothing at all could be bought, it throws exactly
// what the single buy always did.
export async function buyUsedBatch(prisma, { world, buyer, listingIds }) {
  const ids = [...new Set((Array.isArray(listingIds) ? listingIds : []).filter((id) => typeof id === 'string' && id))];
  if (ids.length === 0) throw new AircraftMarketError('Pick at least one aircraft to buy.');
  if (ids.length > USED_BATCH_MAX) {
    throw new AircraftMarketError(`You can buy at most ${USED_BATCH_MAX} used aircraft at once.`);
  }
  // withTx, not a bare $transaction: the claims + blob write can land while the
  // worker's tick holds locks on the buyer's Airline row, and Prisma's 5s default
  // budget turned that ordinary wait into a red toast. See lib/tx.mjs. withTx may
  // re-run this callback, so everything it accumulates is declared inside it.
  return withTx(prisma, async (tx) => {
    const rows = await tx.usedAircraftListing.findMany({ where: { id: { in: ids } } });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const eventRules = world.tickConfig?.event?.rules ?? null;
    let state = buyer.state;
    const bought = [];
    const skipped = [];

    for (const id of ids) {
      const listing = byId.get(id);
      const skip = (reason, status) => skipped.push({
        id, typeId: listing?.typeId ?? null, typeName: typeLabel(listing), reason, status,
      });
      if (!listing || listing.status !== 'OPEN' || listing.worldId !== world.id) { skip(UNAVAILABLE, 404); continue; }
      // Event worlds: a restricted fleet can't be dodged on the used market.
      const evDenial = eventRules ? eventAircraftDenial({ eventRules }, listing.snapshot?.typeId) : null;
      if (evDenial) { skip(evDenial.message, 400); continue; }
      const price = listing.navPrice;
      // Against the RUNNING cash: the jets ahead of this one in the batch are paid for.
      if (Number(state?.cash ?? 0) < price) { skip(NO_CASH, 400); continue; }
      const claimed = await tx.usedAircraftListing.updateMany({
        where: { id: listing.id, status: 'OPEN' },
        data: { status: 'SOLD', buyerId: buyer.id, soldAt: new Date() },
      });
      if (claimed.count === 0) { skip(SNIPED, 409); continue; }

      // Cash + delivery-queue math lives in the reducer (BUY_USED_AIRCRAFT debits the
      // price now and enqueues a one-week used delivery). buyer.state is the persisted
      // blob (already rival-stripped), so the result is safe to persist directly.
      const next = gameReducer(state, { type: 'BUY_USED_AIRCRAFT', snapshot: listing.snapshot, price });
      // The listing is already claimed: throwing rolls it (and the rest) back.
      if (next === state) throw new AircraftMarketError('Purchase could not be completed.', 409);
      state = next;
      bought.push({ id: listing.id, typeId: listing.typeId, typeName: typeLabel(listing), price, listing });
    }

    if (bought.length === 0) {
      const first = skipped[0];
      const message = ids.length === 1 ? first.reason : `None of those ${ids.length} aircraft could be bought — ${first.reason}`;
      throw new AircraftMarketError(message, first.status);
    }

    const wrote = await tx.airline.updateMany({
      where: { id: buyer.id, version: buyer.version },
      data: { state, cash: BigInt(Math.round(state.cash ?? 0)), version: { increment: 1 } },
    });
    if (wrote.count === 0) throw new AircraftMarketError('Your airline just changed — reload and try again.', 409);

    return { buyerState: state, bought, skipped };
  });
}

function typeLabel(listing) {
  if (!listing) return null;
  return getAircraftType(listing.typeId)?.name ?? listing.typeId;
}

// One listing: the batch of one. Same checks, same messages, same status codes.
export async function buyUsed(prisma, { world, buyer, listingId }) {
  const { buyerState, bought } = await buyUsedBatch(prisma, { world, buyer, listingIds: [listingId] });
  return { buyerState, listing: bought[0].listing };
}

// Weekly tick: scrap any listing that has sat unsold for USED_SCRAP_WEEKS. Age is
// frozen while listed, but time-on-market (listedWeek) is not — so this is a plain
// linear-week comparison. Returns the number scrapped.
export async function scrapStale(prisma, worldId, weekIdx) {
  const res = await prisma.usedAircraftListing.updateMany({
    where: { worldId, status: 'OPEN', listedWeek: { lte: weekIdx - USED_SCRAP_WEEKS } },
    data: { status: 'SCRAPPED' },
  });
  return res.count;
}
