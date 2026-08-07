// ─────────────────────────────────────────────────────────────────────────────
// ADMINISTRATION — what happens to an airline's estate when it dies
//
// Bankruptcy used to be a status flip and a single news row. The fleet froze
// inside a state blob nobody would read again, the orderbook stopped existing,
// and the gates went back to the pool in silence — and only on gate-scarcity
// worlds, because that was the one branch anybody had written. An airline could
// fail with forty aeroplanes and a dozen slots at Heathrow and leave the world
// exactly as it found it.
//
// That is a waste of the best thing a persistent world produces. A carrier
// going under should be an OPPORTUNITY for everyone still flying: metal on the
// used market at a price that reflects a forced seller, and gates at a
// contested airport suddenly available.
//
// ── Why nobody gets paid ────────────────────────────────────────────────────
// Every existing transfer path assumes a live counterparty who gets the money.
// `buyListing` refuses a seller whose status is not ACTIVE and dispatches
// GATE_SOLD into the seller's blob. Correct for a sale; impossible for an
// estate. So an estate listing is flagged `distressed` and buyListing skips the
// seller side entirely: the proceeds leave the world instead of being credited
// to a company that no longer exists. The listing still NAMES the failed
// airline, because the gate ledger has to debit somebody when it sells — and
// because "Nordic Air's slot at LHR" is the part worth reading.
// ─────────────────────────────────────────────────────────────────────────────

import { getAircraftType } from '@tailwinds/engine/data/aircraft.js';
import { valueRemaining } from '@tailwinds/engine/data/overhead.js';
import { listSoldAircraftTx } from './aircraftMarketService.mjs';
import { auctionReserveOf, isGateScarcity } from './gateService.mjs';
import { getAirport } from '@tailwinds/engine/data/airports.js';
import { withTx } from './tx.mjs';

/**
 * What a forced sale fetches, as a fraction of book value.
 *
 * An administrator sells into a market that knows it has to. This is the whole
 * appeal to the buyer — and, for anyone watching their own cash burn, the
 * clearest possible statement of what letting an airline fail costs.
 */
export const AIRCRAFT_DISTRESS_FACTOR = 0.65;

/** Gates go cheaper still: a slot pair nobody is flying earns nothing while it waits. */
export const GATE_DISTRESS_FACTOR = 0.55;

/** Reserve under which a gate is not worth the paperwork. */
export const GATE_MIN_ASK = 250_000;

const toNum = (v) => (typeof v === 'bigint' ? Number(v) : Number(v) || 0);

/**
 * Book value of one airframe, matching SELL_AIRCRAFT's NAV — minus the
 * maintenance multiplier, which needs the tick's absolute week and is not worth
 * threading here for an aeroplane whose logbook stopped.
 */
export function distressedNav(aircraft) {
  const type = getAircraftType(aircraft?.typeId);
  if (!type) return 0;
  const nav = (type.purchasePrice ?? 0) * valueRemaining(aircraft?.ageWeeks, type);
  return Math.max(0, Math.round(nav * AIRCRAFT_DISTRESS_FACTOR));
}

/**
 * List a failed airline's owned aircraft on the world's used market.
 *
 * Leased tails are the lessor's and simply go back; only what the airline
 * actually owned is part of the estate.
 *
 * @returns {Promise<number>} aircraft listed
 */
export async function fireSaleFleet(prisma, { world, airlineName, fleet, weekIndex, log = console }) {
  const owned = (fleet ?? []).filter((a) => a?.ownershipType === 'owned' && a?.status !== 'retired');
  if (owned.length === 0) return 0;

  let listed = 0;
  // One transaction per aircraft rather than one for the lot: this runs
  // post-commit on a tick that has just written every airline in the world, and
  // a forty-frame estate held open in a single transaction is exactly the kind
  // of long lock the tick's own budget notes warn about.
  for (const aircraft of owned) {
    const navPrice = distressedNav(aircraft);
    if (navPrice <= 0) continue;
    try {
      await withTx(prisma, async (tx) => {
        await listSoldAircraftTx(tx, {
          worldId: world.id,
          sellerName: airlineName,
          aircraft,
          navPrice,
          weekIdx: weekIndex,
          distressed: true,
        });
      }, { deadlineMs: null });
      listed += 1;
    } catch (err) {
      log.error?.(`[firesale] world ${world.id}: could not list ${aircraft.typeId} — ${err?.message ?? err}`);
    }
  }
  return listed;
}

/**
 * Put a failed airline's gates on the market as administrator's listings.
 *
 * Scarcity worlds only: elsewhere gates are bought freely from the airport and
 * a second-hand one is worth nothing to anybody.
 *
 * The holdings stay on the ledger under the dead airline's id until somebody
 * buys them. That is deliberate — releasing them would put the gates back in
 * the general pool at face value, which is the behaviour this replaces, and
 * would let the airport quietly re-sell capacity it has already committed.
 *
 * @returns {Promise<number>} gates listed
 */
export async function fireSaleGates(prisma, { world, airlineId, weekIndex, log = console }) {
  if (!isGateScarcity(world)) return 0;

  const rows = await prisma.worldGate.findMany({ where: { worldId: world.id } });
  let listed = 0;

  for (const row of rows) {
    const held = row.holdings?.[airlineId]?.count ?? 0;
    if (held <= 0) continue;
    // Priced off the airport's OWN auction reserve, so a Heathrow slot is not
    // valued like a regional one — the same figure the annual auction uses.
    const reserve = auctionReserveOf(getAirport(row.airportCode));
    const askPrice = Math.max(GATE_MIN_ASK, Math.round(reserve * GATE_DISTRESS_FACTOR));
    for (let i = 0; i < held; i++) {
      try {
        await prisma.gateListing.create({
          data: {
            worldId: world.id,
            airportCode: row.airportCode,
            // Still the failed airline: the ledger debits this id when the
            // gate sells. `distressed` is what says nobody gets paid.
            sellerId: airlineId,
            distressed: true,
            askPrice,
          },
        });
        listed += 1;
      } catch (err) {
        log.error?.(`[firesale] world ${world.id}: gate listing at ${row.airportCode} failed — ${err?.message ?? err}`);
      }
    }
  }
  return listed;
}

/**
 * The whole estate. Best-effort by construction: this runs after the week has
 * already committed, so anything that fails here leaves a bankruptcy that is
 * merely as uneventful as it used to be, never a rolled-back week.
 *
 * @returns {Promise<{aircraft:number, gates:number}>}
 */
export async function fireSaleAirline(prisma, { world, airline, weekIndex, log = console }) {
  const out = { aircraft: 0, gates: 0 };
  try {
    out.aircraft = await fireSaleFleet(prisma, {
      world, airlineName: airline.name, fleet: airline.fleet, weekIndex, log,
    });
  } catch (err) {
    log.error?.(`[firesale] world ${world.id} fleet sweep failed: ${err?.message ?? err}`);
  }
  try {
    out.gates = await fireSaleGates(prisma, { world, airlineId: airline.id, weekIndex, log });
  } catch (err) {
    log.error?.(`[firesale] world ${world.id} gate sweep failed: ${err?.message ?? err}`);
  }
  if (out.aircraft || out.gates) {
    log.info?.(`[firesale] ${airline.name} wound up — ${out.aircraft} aircraft, ${out.gates} gate(s) to market`);
  }
  return out;
}
