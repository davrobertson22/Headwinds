// The used aircraft market — service layer.
// ----------------------------------------------------------------------------
// The game is the counterparty on BOTH sides (no direct player-to-player deal):
//   • A completed SELL_AIRCRAFT pays the seller NAV − 5% (in the reducer) and
//     lists that exact tail here at NAV (listSoldAircraftTx, called in the same
//     decision transaction). The 5% spread is the shop's cut — a cash sink, and
//     the only anti-abuse the design needs (every round trip loses 5%).
//   • Any airline can buy a listing at its frozen NAV (buyUsed); the tail arrives
//     on the NEXT weekly tick, rebuilt from its snapshot (real age / cabin /
//     engines / maintenance). A listing's age and price are frozen while it sits.
//   • A listing unsold for USED_SCRAP_WEEKS (2 game-years) is scrapped by the tick.
//
// Every listing is game-owned, so the world's inventory is one shared list. Race
// safety on a purchase comes from a conditional UPDATE (claim WHERE status='OPEN')
// inside the same transaction as the buyer's version-guarded blob write.
import { gameReducer } from '@tailwinds/engine/reducer';
import { getAircraftType } from '@tailwinds/engine/data/aircraft.js';

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
export async function listSoldAircraftTx(tx, { worldId, sellerName, aircraft, navPrice, weekIdx }) {
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

// Atomic purchase: claim the listing (first buyer wins — a racing buyer's UPDATE
// matches 0 rows and 409s), then let the engine do the cash + one-week delivery
// math. All in one transaction, so a failed buyer write rolls the claim back too.
export async function buyUsed(prisma, { world, buyer, listingId }) {
  return prisma.$transaction(async (tx) => {
    const listing = await tx.usedAircraftListing.findUnique({ where: { id: listingId } });
    if (!listing || listing.status !== 'OPEN' || listing.worldId !== world.id) {
      throw new AircraftMarketError('That aircraft is no longer available.', 404);
    }
    const price = listing.navPrice;
    if (Number(buyer.state?.cash ?? 0) < price) {
      throw new AircraftMarketError('You cannot afford that aircraft.');
    }
    const claimed = await tx.usedAircraftListing.updateMany({
      where: { id: listing.id, status: 'OPEN' },
      data: { status: 'SOLD', buyerId: buyer.id, soldAt: new Date() },
    });
    if (claimed.count === 0) throw new AircraftMarketError('That aircraft was just bought by someone else.', 409);

    // Cash + delivery-queue math lives in the reducer (BUY_USED_AIRCRAFT debits the
    // price now and enqueues a one-week used delivery). buyer.state is the persisted
    // blob (already rival-stripped), so buyerNext is safe to persist directly.
    const buyerNext = gameReducer(buyer.state, { type: 'BUY_USED_AIRCRAFT', snapshot: listing.snapshot, price });
    if (buyerNext === buyer.state) throw new AircraftMarketError('Purchase could not be completed.', 409);

    const wrote = await tx.airline.updateMany({
      where: { id: buyer.id, version: buyer.version },
      data: { state: buyerNext, cash: BigInt(Math.round(buyerNext.cash ?? 0)), version: { increment: 1 } },
    });
    if (wrote.count === 0) throw new AircraftMarketError('Your airline just changed — reload and try again.', 409);

    return { buyerState: buyerNext, listing };
  });
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
