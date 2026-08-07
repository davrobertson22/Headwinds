// ─────────────────────────────────────────────────────────────────────────────
// CODESHARES, MADE BILATERAL
//
// `SIGN_CODESHARE` was on the multiplayer allow-list. It created an agreement
// against a human rival's view with no consent and no notification: you paid a
// weekly fee and collected interline revenue computed off a real player's
// network, while they neither knew the deal existed nor saw a cent of it. The
// game's only "deal" verb was not a deal — it was a helping.
//
// It is now an offer and an acceptance, modelled on the alliance join/approve
// flow that already works: a row in `CodeshareOffer` IS a live offer, and
// resolving it deletes the row. Accepting writes the agreement into BOTH
// airlines' state blobs in one transaction, so both pay and both earn.
//
// The two-blob write follows `gateService.buyListing` exactly, including the
// id-sorted lock ordering — if A accepts B's offer at the same moment B accepts
// A's, a fixed order means they queue instead of deadlocking.
// ─────────────────────────────────────────────────────────────────────────────

import { gameReducer } from '@tailwinds/engine/reducer';
import { MAX_CODESHARE_AGREEMENTS } from '@tailwinds/engine/data/alliances.js';
import { withTx } from './tx.mjs';
import { rivalIdOf } from './humanRivals.mjs';
import { poolKeyOf } from './marketService.mjs';

export class CodeshareError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

/**
 * An unanswered offer goes stale. Without this the table accumulates proposals
 * to airlines that went bankrupt, left, or simply never looked — and a player
 * cannot re-offer, because the unique constraint still sees the old one.
 */
export const CODESHARE_OFFER_EXPIRY_WEEKS = 8;

/** Human rivals are all one tier to the engine (see humanRivals.toHumanCompetitor). */
const HUMAN_TIER = 'legacy';

// ── Which id is which ───────────────────────────────────────────────────────
// The database addresses an airline by its row id. Everything a player's client
// can see addresses the same airline as `human:<dbId>`, or `human:<dbId>~g2`
// once it has been re-founded — see humanRivals.rivalIdOf for why the generation
// is part of the identity. This module is the boundary: rival ids in and out,
// row ids only for queries.
//
// Every read below accepts BOTH forms. Nothing in production stores the raw one
// (the offer table did not exist until this shipped, so no offer was ever
// accepted), but a repair that only works after a data migration is a repair
// with a second bug in it.
const partnerMatches = (agreement, row) =>
  agreement?.competitorId === rivalIdOf(row) || agreement?.competitorId === row?.id;

/**
 * The airline behind a rival-facing id, or a refusal a player can act on.
 *
 * A stale generation is refused rather than silently retargeted: `human:x~g1`
 * after that airline has re-founded as `~g2` means the client is looking at a
 * company that no longer exists, and signing the new one in its place is
 * precisely the substitution the generation suffix exists to prevent.
 */
async function resolveRival(db, world, rivalId, { select } = {}) {
  const row = await db.airline.findUnique({
    where: { id: poolKeyOf(rivalId) },
    select: select ?? {
      id: true, worldId: true, name: true, status: true, state: true, restarts: true,
    },
  });
  if (!row || row.worldId !== world.id) {
    throw new CodeshareError('No such airline in this world.', 404);
  }
  // The raw form is accepted for server-internal callers; a client only ever
  // holds the rival form.
  if (rivalId !== rivalIdOf(row) && rivalId !== row.id) {
    throw new CodeshareError(
      `${row.name} has re-founded since — reload and try again.`, 409);
  }
  return row;
}

const partnerOf = (airline) => ({ id: rivalIdOf(airline), name: airline.name, tier: HUMAN_TIER });

const agreementsOf = (airline) => airline?.state?.codeshareAgreements ?? [];

/** Do these two already have a deal? Either side's blob is authoritative. */
export function alreadyPartnered(a, b) {
  return agreementsOf(a).some((x) => partnerMatches(x, b))
      || agreementsOf(b).some((x) => partnerMatches(x, a));
}

function assertCanSign(airline, label) {
  if (!airline || airline.status !== 'ACTIVE') {
    throw new CodeshareError(`${label} is no longer active.`, 409);
  }
  if (agreementsOf(airline).length >= MAX_CODESHARE_AGREEMENTS) {
    throw new CodeshareError(
      `${label} already has the maximum of ${MAX_CODESHARE_AGREEMENTS} codeshare agreements.`, 409);
  }
}

// ── Offers ───────────────────────────────────────────────────────────────────

/**
 * Propose a codeshare. Nothing changes in either airline's state until the
 * other side accepts — which is the entire point of the feature.
 */
export async function offerCodeshare(prisma, { world, from, toAirlineId, weekIndex }) {
  // `toAirlineId` is a RIVAL id off a competitor entry, not a row id.
  const to = await resolveRival(prisma, world, toAirlineId);
  if (from.id === to.id) throw new CodeshareError('You cannot codeshare with yourself.');
  if (to.status !== 'ACTIVE') throw new CodeshareError(`${to.name} is ${to.status.toLowerCase()}.`, 409);

  assertCanSign(from, 'You');
  // Checked at OFFER time as a courtesy so the sender learns immediately, and
  // again at ACCEPT time because both fleets move while an offer sits waiting.
  if (agreementsOf(to).length >= MAX_CODESHARE_AGREEMENTS) {
    throw new CodeshareError(`${to.name} already has the maximum number of codeshare agreements.`, 409);
  }
  if (alreadyPartnered(from, to)) {
    throw new CodeshareError(`You already have a codeshare with ${to.name}.`, 409);
  }

  // An offer already coming the OTHER way is not an error — it is agreement.
  // Two players who both pressed "offer" have plainly consented, and making one
  // of them withdraw and re-accept would be ceremony for its own sake.
  const inbound = await prisma.codeshareOffer.findUnique({
    where: {
      worldId_fromAirlineId_toAirlineId: {
        worldId: world.id, fromAirlineId: to.id, toAirlineId: from.id,
      },
    },
  });
  if (inbound) {
    const res = await acceptOffer(prisma, { world, offer: inbound, acceptor: from, weekIndex });
    return { ...res, mutual: true };
  }

  const offer = await prisma.codeshareOffer.upsert({
    where: {
      worldId_fromAirlineId_toAirlineId: {
        worldId: world.id, fromAirlineId: from.id, toAirlineId: to.id,
      },
    },
    update: { offeredWeek: weekIndex, createdAt: new Date() },   // re-offer refreshes the clock
    create: {
      worldId: world.id, fromAirlineId: from.id, toAirlineId: to.id, offeredWeek: weekIndex,
    },
  });
  return { offer, toName: to.name };
}

/** Take an offer off the table — the sender withdrawing or the recipient declining. */
export async function resolveOffer(prisma, { world, offerId, airlineId, decision }) {
  const offer = await prisma.codeshareOffer.findUnique({ where: { id: offerId } });
  if (!offer || offer.worldId !== world.id) throw new CodeshareError('That offer is no longer open.', 404);
  const isRecipient = offer.toAirlineId === airlineId;
  const isSender    = offer.fromAirlineId === airlineId;
  if (!isRecipient && !isSender) throw new CodeshareError('That offer is not yours.', 403);
  if (decision === 'accept' && !isRecipient) {
    throw new CodeshareError('Only the airline an offer was made to can accept it.', 403);
  }
  return offer;
}

/**
 * Accept: write the agreement into BOTH blobs, in one transaction.
 *
 * @returns {{ myState: object, partnerName: string }}
 */
export async function acceptOffer(prisma, { world, offer, acceptor, weekIndex }) {
  return withTx(prisma, async (tx) => {
    // Re-read both sides INSIDE the transaction. The versions we compare-and-set
    // against have to be the ones we reasoned about, and an offer can sit
    // pending for weeks while both airlines change underneath it.
    const [a, b] = await Promise.all([
      tx.airline.findUnique({ where: { id: offer.fromAirlineId } }),
      tx.airline.findUnique({ where: { id: offer.toAirlineId } }),
    ]);
    if (!a || !b) throw new CodeshareError('One of those airlines no longer exists.', 404);
    assertCanSign(a, a.name);
    assertCanSign(b, b.name);
    if (alreadyPartnered(a, b)) {
      throw new CodeshareError(`${a.name} and ${b.name} already have a codeshare.`, 409);
    }

    // The reducer normally finds the partner in `state.competitors`, which is
    // stripped before persistence — so a server-side dispatch reading the raw
    // blob would find nobody and silently no-op. Hand it the partner directly.
    //
    // The id stored on the agreement must be the one the ENGINE can resolve:
    // simulation.js does `competitors.find(c => c.id === partnerId)` and
    // network.js keys its partnership map the same way, and a human rival
    // appears in `state.competitors` as rivalIdOf(row). Storing the row id
    // instead would have charged the weekly fee, named no partner on screen,
    // and paid no interline revenue.
    const aNext = gameReducer(a.state, {
      type: 'SIGN_CODESHARE', competitorId: rivalIdOf(b), partner: partnerOf(b),
    });
    const bNext = gameReducer(b.state, {
      type: 'SIGN_CODESHARE', competitorId: rivalIdOf(a), partner: partnerOf(a),
    });
    // A reducer that declines returns the state it was given. Half a bilateral
    // agreement is worse than none, so refuse the whole thing.
    if (aNext === a.state || bNext === b.state) {
      throw new CodeshareError('That codeshare could not be signed by both sides.', 409);
    }

    // Deterministic lock order (see gateService.buyListing): two players
    // accepting each other's offers at the same instant must queue, not
    // deadlock.
    const sides = [
      { row: a, next: aNext },
      { row: b, next: bNext },
    ].sort((x, y) => (x.row.id < y.row.id ? -1 : x.row.id > y.row.id ? 1 : 0));

    for (const side of sides) {
      const wrote = await tx.airline.updateMany({
        where: { id: side.row.id, version: side.row.version },
        data: { state: side.next, version: { increment: 1 } },
      });
      if (wrote.count === 0) {
        throw new CodeshareError(`${side.row.name} changed while the deal was being signed — try again.`, 409);
      }
    }

    await tx.codeshareOffer.delete({ where: { id: offer.id } });

    const mine = acceptor.id === a.id ? aNext : bNext;
    const partner = acceptor.id === a.id ? b : a;
    return { myState: mine, partnerName: partner.name, partnerId: rivalIdOf(partner) };
  });
}

/**
 * Cancel a live agreement — on BOTH sides.
 *
 * Cancelling only your own half would leave the other player paying a weekly
 * fee for a partner who no longer carries their passengers, which is a worse
 * asymmetry than the one this whole package exists to remove.
 */
export async function cancelCodeshare(prisma, { world, airline, partnerId }) {
  return withTx(prisma, async (tx) => {
    // A re-founded or vanished partner must not block a cancellation, so the
    // partner row is looked up leniently — by row id, without asserting the
    // generation. Our OWN agreement is what authorises the teardown.
    const [a, b] = await Promise.all([
      tx.airline.findUnique({ where: { id: airline.id } }),
      tx.airline.findUnique({ where: { id: poolKeyOf(partnerId) } }),
    ]);
    if (!a) throw new CodeshareError('Your airline is missing.', 404);
    // Match on whichever form the agreement was stored under, and then cancel
    // using that same stored id so the reducer's filter cannot miss it.
    const mine = agreementsOf(a).find((x) => x.competitorId === partnerId
      || (b && partnerMatches(x, b)));
    if (!mine) {
      throw new CodeshareError('You have no codeshare with that airline.', 404);
    }

    const aNext = gameReducer(a.state, { type: 'CANCEL_CODESHARE', competitorId: mine.competitorId });
    const sides = [{ row: a, next: aNext }];
    // The partner may have gone bankrupt or been re-founded since — in which
    // case their side of the deal is already gone and only ours needs tearing
    // down. Cancelling must still work; a dead partner cannot be a hostage.
    const theirs = b ? agreementsOf(b).find((x) => partnerMatches(x, a)) : null;
    if (b && theirs) {
      sides.push({ row: b, next: gameReducer(b.state, { type: 'CANCEL_CODESHARE', competitorId: theirs.competitorId }) });
    }
    sides.sort((x, y) => (x.row.id < y.row.id ? -1 : x.row.id > y.row.id ? 1 : 0));

    for (const side of sides) {
      const wrote = await tx.airline.updateMany({
        where: { id: side.row.id, version: side.row.version },
        data: { state: side.next, version: { increment: 1 } },
      });
      if (wrote.count === 0) {
        throw new CodeshareError(`${side.row.name} changed while cancelling — try again.`, 409);
      }
    }
    return { myState: aNext, partnerName: b?.name ?? null };
  });
}

// ── Views & housekeeping ─────────────────────────────────────────────────────

/** Offers in and out, for the Alliances tab. */
export async function buildOfferView(prisma, { worldId, airlineId }) {
  const rows = await prisma.codeshareOffer.findMany({
    where: { worldId, OR: [{ fromAirlineId: airlineId }, { toAirlineId: airlineId }] },
    orderBy: { createdAt: 'desc' },
  });
  if (rows.length === 0) return { incoming: [], outgoing: [] };

  const ids = [...new Set(rows.flatMap((r) => [r.fromAirlineId, r.toAirlineId]))];
  const names = new Map(
    (await prisma.airline.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, hub: true, status: true, restarts: true },
    })).map((a) => [a.id, a]),
  );
  // `airlineId` goes out in RIVAL form: the client matches it against
  // state.competitors to show who the offer is with. The offer's own `id` is
  // what accept/reject act on, so it stays a plain row id.
  const shape = (r, otherId) => ({
    id: r.id,
    airlineId: names.has(otherId) ? rivalIdOf(names.get(otherId)) : otherId,
    name: names.get(otherId)?.name ?? 'Unknown airline',
    hub: names.get(otherId)?.hub ?? null,
    status: names.get(otherId)?.status ?? null,
    offeredWeek: r.offeredWeek,
    expiresWeek: r.offeredWeek + CODESHARE_OFFER_EXPIRY_WEEKS,
  });
  return {
    incoming: rows.filter((r) => r.toAirlineId === airlineId).map((r) => shape(r, r.fromAirlineId)),
    outgoing: rows.filter((r) => r.fromAirlineId === airlineId).map((r) => shape(r, r.toAirlineId)),
  };
}

/**
 * Sweep offers nobody answered. Runs post-commit in the tick, beside the news
 * retention sweep, for the same reason: an unbounded table of dead rows also
 * blocks the unique constraint that stops duplicate offers.
 */
export async function expireStaleOffers(prisma, worldId, weekIndex) {
  const { count } = await prisma.codeshareOffer.deleteMany({
    where: { worldId, offeredWeek: { lt: weekIndex - CODESHARE_OFFER_EXPIRY_WEEKS } },
  });
  return count;
}
