/**
 * wifi.js — Onboard connectivity as a PER-AIRCRAFT capital upgrade.
 *
 * Wi-Fi used to be a pure policy switch: the airline-wide Ancillaries tab had a
 * `wifi` product, and flipping "offered" on gave every route in the network
 * connectivity for nothing but a per-passenger bandwidth charge. That is not how
 * connectivity works — it is an antenna, a radome, a modem and a certification
 * campaign, bought and fitted one airframe at a time.
 *
 * So the decision splits in two:
 *
 *   FLEET  (here)              which tails are EQUIPPED — capex per airframe at
 *                              order time or as a retrofit, plus a small weekly
 *                              running cost for every equipped tail.
 *   POLICY (ancillaries.js)    what you CHARGE for it — one airline-wide fee,
 *                              set on the Ancillaries tab exactly as before.
 *
 * A route's Wi-Fi therefore depends on the metal actually flying it. An
 * unequipped tail earns no Wi-Fi revenue, spends no bandwidth, and takes the
 * `absentQ` quality drag for an amenity the market now expects — regardless of
 * what the policy says. This is threaded through the ancillary model as a
 * `provisionCoverage` fraction (see `ancillaries.js`), so a route flown by one
 * unequipped jet reads 0, a route flown by one equipped jet reads 1, and a
 * demand-pooled pair flown by a mix reads the seat-weighted blend.
 *
 * ── Order-time vs retrofit ───────────────────────────────────────────────────
 * Line-fit at the factory is the cheap path — the harness goes in while the
 * aircraft is being built. A retrofit means a hangar slot, a fresh
 * supplemental type certificate and an aircraft out of revenue service, so it
 * carries a premium. The premium is the entire reason to decide at order time,
 * which is what makes the checkbox on the order form a real choice.
 *
 * ── Why the bandwidth charge came down ───────────────────────────────────────
 * The `wifi` product's per-passenger `provisionCost` used to bundle the
 * amortised cost of the hardware into the bandwidth line, because there was
 * nowhere else for it to live. The hardware is now explicit — capex here, plus
 * WIFI_WEEKLY_OPEX per equipped tail — so leaving the per-pax figure untouched
 * would charge for the same kit twice. See the note on `provisionCost` in
 * ancillaries.js.
 *
 * No Date.now(), no Math.random() — every function here is pure so the golden
 * master and the reducer can both call it.
 */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Line-fit connectivity capex, per airframe. Deliberately flat: the antenna,
 * modem and cabin wireless access points cost about the same whether they are
 * going into a regional jet or a double-decker, and a flat number keeps the
 * order form honest ("Wi-Fi: $X per aircraft") instead of hiding a formula.
 */
export const WIFI_INSTALL_COST = 750_000;

/**
 * Retrofit premium over the line-fit price — hangar slot, STC paperwork, and an
 * airframe earning nothing while the work is done.
 */
export const WIFI_RETROFIT_PREMIUM = 0.40;

/**
 * Weekly cost of keeping ONE equipped tail connected: satellite airtime
 * commitment, hardware support contract, portal hosting. Small against
 * maintenance and lease — connectivity is cheap to run and expensive to fit.
 * The traffic-driven part of the bill is separate and lives on the ancillary
 * product's per-passenger `provisionCost`.
 */
export const WIFI_WEEKLY_OPEX = 1_500;

/**
 * Weekly lease surcharge for a Wi-Fi-equipped leased aircraft, as a divisor of
 * the install cost. Matches the wingtip convention in the reducer (cost / 200),
 * so a lessor recovers the fit-out over roughly a four-year term.
 */
export const WIFI_LEASE_DIVISOR = 200;

/** Capex to fit Wi-Fi to an aircraft on the production line (at order time). */
export function wifiInstallCost() {
  return WIFI_INSTALL_COST;
}

/** Capex to fit Wi-Fi to an aircraft already in the fleet. */
export function wifiRetrofitCost() {
  return Math.round(WIFI_INSTALL_COST * (1 + WIFI_RETROFIT_PREMIUM));
}

/** Weekly lease surcharge for a leased tail ordered with Wi-Fi. */
export function wifiLeaseSurcharge() {
  return Math.round(WIFI_INSTALL_COST / WIFI_LEASE_DIVISOR);
}

/** Is this tail fitted? Undefined/legacy tails read as NOT equipped. */
export function isWifiEquipped(aircraft) {
  return !!aircraft?.hasWifi;
}

/**
 * Weekly connectivity running cost across a fleet — one charge per equipped
 * tail, including tails that are parked, on reserve or in a check. The airtime
 * commitment and the support contract are paid by the airframe, not by the
 * flight, which is exactly why an over-fitted fleet quietly costs money.
 * Retired aircraft have left the fleet and pay nothing.
 */
export function fleetWifiWeeklyCost(fleet = []) {
  let n = 0;
  for (const a of fleet ?? []) {
    if (!isWifiEquipped(a)) continue;
    if (a.status === 'retired') continue;
    n++;
  }
  return n * WIFI_WEEKLY_OPEX;
}

/** How many tails in the fleet are fitted (excluding retired). */
export function wifiEquippedCount(fleet = []) {
  return (fleet ?? []).filter(a => isWifiEquipped(a) && a.status !== 'retired').length;
}

/**
 * Airline-wide Wi-Fi coverage, 0–1 — the share of the fleet a passenger is
 * likely to meet. Weighted by SEATS rather than by airframe count, because the
 * question the reputation model is asking is "what fraction of our passengers
 * find Wi-Fi on board", and a fitted widebody serves far more of them than a
 * fitted turboprop.
 *
 * @param {object[]} fleet
 * @param {(a: object) => number} seatsOf  seat count for one tail (caller
 *   supplies it so this module never has to import the aircraft catalogue)
 */
export function fleetWifiCoverage(fleet = [], seatsOf = () => 1) {
  let fitted = 0, total = 0;
  for (const a of fleet ?? []) {
    if (a.status === 'retired') continue;
    const seats = Math.max(0, seatsOf(a) || 0);
    total += seats;
    if (isWifiEquipped(a)) fitted += seats;
  }
  if (!(total > 0)) return 0;
  return clamp(fitted / total, 0, 1);
}

/**
 * Seat-weighted coverage across the group of tails flying ONE pooled O&D pair.
 * The demand-pooling pre-pass in weeklyTick scores the pair with a single
 * combined offer, so it needs one connectivity number for the whole group; a
 * pair flown by an equipped widebody and an unequipped regional is genuinely
 * "mostly connected" to the market.
 *
 * @param {Array<{aircraft: object, seats: number}>} entries
 */
export function groupWifiCoverage(entries = []) {
  let fitted = 0, total = 0;
  for (const { aircraft, seats } of entries ?? []) {
    const s = Math.max(0, seats || 0);
    total += s;
    if (isWifiEquipped(aircraft)) fitted += s;
  }
  if (!(total > 0)) return 0;
  return clamp(fitted / total, 0, 1);
}

/**
 * The `provisionCoverage` map for ONE route, given the tail that flies it.
 * Handed straight to routeAncillaries / ancillaryQualityBonus.
 */
export function wifiCoverageFor(aircraft) {
  return isWifiEquipped(aircraft) ? 1 : 0;
}

/**
 * Can this aircraft be retrofitted right now, and what does it cost?
 * Shared by the reducer (enforcement) and the Fleet page (display), so the
 * player is quoted exactly the number the reducer will charge — the same
 * convention canBuildBase follows for jet bases.
 *
 * @param {object[]} aircraftList  the tails the player selected
 * @param {number}   cash
 * @returns {{ ok, reasons: string[], eligible: object[], unitCost, capex }}
 */
export function canRetrofitWifi(aircraftList = [], cash = 0) {
  const unitCost = wifiRetrofitCost();
  const eligible = (aircraftList ?? []).filter(
    a => a && !isWifiEquipped(a) && a.status !== 'retired');
  const capex    = eligible.length * unitCost;
  const reasons  = [];
  if (eligible.length === 0) reasons.push('Every aircraft selected is already fitted with Wi-Fi.');
  else if (cash < capex)     reasons.push('Not enough cash to fit Wi-Fi to this many aircraft.');
  return { ok: reasons.length === 0, reasons, eligible, unitCost, capex };
}
