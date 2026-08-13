// ─────────────────────────────────────────────────────────────────────────────
// COST BRIDGE — one place that answers "my routes make 52%, so why is the
// company on 28%?"
//
// WHY THIS EXISTS
// ---------------
// The Routes page shows a FULLY-LOADED route margin: revenue less direct flying
// costs, landing fees, and the aircraft's own lease + maintenance allocated by
// frequency. Because it says "incl. lease + maint" it reads as the whole story,
// so the ~24-point gap down to the company margin looks like an arithmetic error
// rather than a dozen corporate cost lines sitting below it.
//
// Dashboard already had a bridge, but its first row summed `routeResults.profit`
// — which EXCLUDES lease and maintenance — while labelling itself as the figure
// shown in the table beside it, which subtracts them. The arithmetic tied out
// (they came off again inside the collapsed "Fixed & overhead" block) but the
// opening number matched nothing on screen, which is precisely the number a
// player is trying to reconcile FROM.
//
// So: one module, one ladder, anchored on the number the player is actually
// looking at, and self-checking — `residual` is the amount the itemised rows
// fail to explain, and it is asserted to be zero in tools/pnl-bridge-test.mjs.
// If a future cost line is added to weeklyTick's totalCost and not to the
// OVERHEAD/BRAND/... buckets below, the residual row appears instead of the
// money silently vanishing.
//
// ── Partner revenue is not route revenue ────────────────────────────────────
// weeklyTick reports `totalRevenue` with partner and codeshare revenue ALREADY
// added in. The first row here is labelled "Route revenue" and the partner
// share gets a line of its own further down, so reading the report's total into
// that row counts the same money twice — the residual lands at exactly minus the
// partner revenue, and every player in an alliance or a codeshare saw a bogus
// "Other" row on the Finance page for it. The first row is the report total LESS
// partner revenue, which is what the label already claimed. Margins still divide
// by the all-in figure, because that is what the airline actually took in.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} BridgeRow
 * @property {string}  key
 * @property {string}  label
 * @property {string}  [tip]
 * @property {number}  value      signed: costs are negative, income positive
 * @property {'income'|'cost'|'subtotal'|'total'} kind
 * @property {number}  [margin]   on subtotal/total rows: value ÷ revenue
 */

/**
 * Build the ladder from route operating profit down to net profit.
 *
 * @param {object} proj   canonical projection (utils/financeProjection.js) — the
 *   SAME object the P&L, Forecast and Unit Economics views read, so this cannot
 *   disagree with them about the bottom line. Pass a `lastReport` wrapped as
 *   `{ report, ...lastReport }` (see bridgeInputsFromReport) to bridge a week
 *   that has already happened.
 * @param {object} state  game state, for the routeId → aircraftId map used to
 *   split fleet ownership into flying vs parked.
 * @returns {{rows: BridgeRow[], revenue: number, routeOperating: number,
 *   netProfit: number, routeMargin: number, netMargin: number, residual: number}}
 */
export function costBridge(proj, state = {}) {
  const r = proj?.report ?? {};
  const n = (v) => Math.round(v ?? 0);

  // ── Which aircraft actually flew? ──────────────────────────────────────────
  // Fleet ownership on a FLYING aircraft is already inside the Routes page's
  // margin (allocated per route by frequency). Ownership on a parked one is not
  // — nothing allocates it, because there is no route to allocate it to. That is
  // a real cost of a real decision (an idle jet, a reserve on standby, a tail in
  // a D-check) and it belongs on its own line rather than buried in overhead.
  const flownRouteIds = new Set([
    ...(r.routeResults ?? []).map((x) => x.routeId),
    ...(r.cargoRouteResults ?? []).map((x) => x.routeId),
  ]);
  const flyingAircraft = new Set();
  for (const route of [...(state.routes ?? []), ...(state.cargoRoutes ?? [])]) {
    if (flownRouteIds.has(route.id) && route.aircraftId) flyingAircraft.add(route.aircraftId);
  }

  let ownFlying = 0, ownParked = 0;
  for (const fc of r.fleetCosts ?? []) {
    const own = (fc.lease ?? 0) + (fc.maintenance ?? 0);
    if (flyingAircraft.has(fc.aircraftId)) ownFlying += own;
    else ownParked += own;
    // Reserve standby parking is never allocated to a route, flying or not.
    ownParked += fc.reserveParking ?? 0;
  }

  const partnerRev   = n(r.totalPartnerRevenue);
  const revenue      = n(r.totalRevenue);          // all-in, the margin denominator
  const routeRevenue = revenue - partnerRev;       // what the flying itself earned
  const directCost   = n(r.totalOpCost);           // fuel, crew, service, landing fees
  const contribution = routeRevenue - directCost;
  const routeOperating = contribution - Math.round(ownFlying);

  const gates        = n(r.totalGateFees);          // congestion surcharge already inside
  const labour       = n(r.totalLaborCosts);
  // Facilities and fleet-wide equipment the airline runs whether or not any
  // particular route operates: head office, insurance, the outsourced family
  // maintenance contract, jet bases, onboard connectivity (one charge per
  // equipped tail) and the lounge network (rent, staff and free-access guests,
  // net of what alliance partners settle).
  const overhead     = n(r.totalHQCost) + n(r.totalInsurance)
                     + n(r.totalFamilyBaseCosts) + n(r.totalMroBaseCosts)
                     + n(r.totalWifiCosts) + n(r.totalLoungeCosts);
  const brand        = n(r.totalMarketingSpend) + n(r.totalLoyaltyCost) + n(r.totalHubInvestment);
  const distribution = n(r.totalDistributionCost) + n(r.totalPartnerFees);
  // A strike forfeits revenue but SAVES the variable cost of the flights it
  // cancelled, and the engine credits that saving back. Only the net number
  // reconciles — and only the net number is the truth about the damage.
  const strike       = n(r.strikeLoss) - n(r.strikeVariableSaved);

  const ebitda = n(proj?.ebitda);
  // Anything totalCost carries that the buckets above don't name. Should be 0.
  const residual = ebitda - (
    routeOperating - Math.round(ownParked) - gates - labour - overhead
    - brand - distribution + partnerRev - strike
  );

  const loans   = n(proj?.loanPayments);
  const oneOff  = n(proj?.seasonalReactivation) + n(proj?.leaseRedelivery);
  // Security deposits returned with the airframes they secured. A return of
  // capital, not income — untaxed, and never booked as a cost on the way out —
  // but real cash, so it needs a row of its own or netResidual would flag it.
  const deposits = n(proj?.leaseDepositReturned);
  // Heavy checks (C/D) and AOG repairs net of insurance. The engine charges
  // these below EBITDA and outside report.totalCost, so they are invisible to
  // everything upstream of this line. A projection cannot forecast them, so it
  // supplies nothing and this is 0 there.
  const unplanned = n(proj?.unplannedMaint);
  const tax     = n(proj?.corporateTax);
  const netProfit = n(proj?.netCash);
  // The residual above only guards revenue → EBITDA. This one guards EBITDA →
  // net, so the ladder is checked end to end: if the engine ever takes cash out
  // below EBITDA without a row here, it shows up instead of vanishing.
  const netResidual = netProfit - (ebitda - loans - oneOff - unplanned - tax + deposits);

  const rows = [];
  const push = (key, label, value, kind, tip) => rows.push({ key, label, value, kind, tip });

  push('revenue', 'Route revenue', routeRevenue, 'income',
    'Every passenger and cargo route, including catering, ancillaries and connecting feed.');
  push('direct', 'Direct flying costs', -directCost, 'cost',
    'Fuel, crew, cabin service, catering, ground handling, passenger compensation and landing fees — the costs of operating the flights themselves.');
  push('contribution', 'Route contribution', contribution, 'subtotal',
    'What the flying earns before anything is paid for the aircraft.');
  push('ownFlying', 'Leases & maintenance (flying fleet)', -Math.round(ownFlying), 'cost',
    'Weekly lease and maintenance on the aircraft that operated, allocated across their routes by frequency.');
  push('routeOperating', 'Route operating profit', routeOperating, 'subtotal',
    'THE FIGURE ON YOUR ROUTES PAGE. Every line below this is a cost no single route carries.');

  if (ownParked) push('ownParked', 'Leases & maintenance (parked fleet)', -Math.round(ownParked), 'cost',
    'Aircraft that flew nothing this week — idle, in a heavy check, or on reserve standby. They still owe lease and base maintenance, and no route absorbs it.');
  if (gates) push('gates', 'Gates & slots', -gates, 'cost',
    'Weekly gate rental at every airport you hold, including the congestion surcharge on gates above 90% utilisation'
    + ((n(r.totalSlotPoolCost) || n(r.totalSlotPoolEarnings))
      ? `, plus alliance slot-pool rent (paid $${n(r.totalSlotPoolCost).toLocaleString()}, received $${n(r.totalSlotPoolEarnings).toLocaleString()}).`
      : '.'));
  if (labour) push('labour', 'Staff & payroll', -labour, 'cost',
    'Pilots, cabin crew, engineers and ground staff — priced per aircraft, and surcharged for every extra aircraft family you operate.');
  if (overhead) push('overhead', 'HQ, insurance & bases', -overhead, 'cost',
    'Head office, hull and liability insurance, and fixed costs of your maintenance bases.');
  if (brand) push('brand', 'Marketing, loyalty & hubs', -brand, 'cost',
    'Brand and targeted advertising, the loyalty programme, and weekly hub investment. This is what buys the brand reach that lets you hold a higher fare on the routes above — it is a cost here and a benefit there.');
  if (distribution) push('distribution', 'Distribution & partner fees', -distribution, 'cost',
    'GDS, OTA and card fees at 2.5% of all revenue, plus alliance and codeshare membership fees.');
  if (partnerRev) push('partnerRev', 'Partner & codeshare revenue', partnerRev, 'income',
    'Your mileage-prorated share of itineraries flown partly on a partner’s metal.');
  if (strike) push('strike', 'Strike revenue loss', -strike, 'cost',
    'Revenue forfeited on flights cancelled by industrial action.');
  if (residual) push('residual', 'Other', residual, 'cost',
    'Costs the bridge could not attribute. This should always be zero — if you are seeing it, a cost line was added to the engine without being added to this breakdown.');

  push('ebitda', 'Operating profit (EBITDA)', ebitda, 'subtotal',
    'Everything the airline earns and spends in operation, before financing and tax.');
  if (loans)  push('loans',  'Loan payments',     -loans,  'cost', 'Weekly interest and principal on outstanding debt.');
  if (oneOff) push('oneOff', 'One-time charges',  -oneOff, 'cost', 'Lease redelivery on returned aircraft and seasonal route reactivation fees.');
  if (deposits) push('deposits', 'Lease deposits returned', deposits, 'income',
    'Security deposits refunded when leased aircraft went back to the lessor. You paid these up front when the aircraft was ordered; they are your money coming home, so no tax is charged on them.');
  if (unplanned) push('unplanned', 'Heavy checks & AOG', -unplanned, 'cost',
    'Scheduled heavy maintenance (C and D checks) that fell due this week, plus unplanned AOG repairs after a mechanical failure, net of any insurance recovery. Lumpy by nature — a D check lands in one week rather than spread across the year — so it is charged here rather than in your weekly fixed costs, and a projection cannot forecast it.');
  if (tax)    push('tax',    'Corporate tax',     -tax,    'cost', 'Charged on taxable profit — the base is EBITDA less depreciation, loan INTEREST (principal is not deductible), one-time charges and heavy-check/AOG spend. Depreciation is deducted for tax but costs no cash, so the charge usually reads as less than the headline rate against the operating profit above.');
  if (netResidual) push('netResidual', 'Other (below the line)', netResidual, 'cost',
    'Cash the engine moved between operating profit and the bottom line that no row above names. This should always be zero — if you are seeing it, a charge was added below EBITDA without being added to this breakdown.');
  push('net', 'Net profit', netProfit, 'total',
    'The actual change in your cash balance this week.');

  const margin = (v) => (revenue > 0 ? v / revenue : 0);
  for (const row of rows) {
    if (row.kind === 'subtotal' || row.kind === 'total') row.margin = margin(row.value);
  }

  return {
    rows, revenue, routeOperating, netProfit,
    routeMargin: margin(routeOperating),
    netMargin:   margin(netProfit),
    residual, netResidual,
  };
}

/**
 * Wrap a STORED weekly report (state.lastReport) in the shape costBridge wants.
 *
 * The projection carries its below-the-line items as top-level fields; a stored
 * report carries them on the report itself, and its `cashDelta` has already had
 * tax taken off. EBITDA is rebuilt from the report's own identity — revenue less
 * the NET strike impact less total cost — rather than being handed in, so the
 * residual stays a real check on last week rather than an arithmetic tautology.
 *
 * `unplannedMaint` is the term that made the Dashboard's weekly P&L card fail to
 * add up: the engine charges heavy checks and AOG repairs (net of insurance)
 * below EBITDA and OUTSIDE report.totalCost, so nothing that reads totalCost can
 * see them. They are real cash and they need their own row.
 *
 * @param {object} report  state.lastReport
 */
export function bridgeInputsFromReport(report) {
  const n = (v) => Math.round(Number(v) || 0);
  const r = report ?? {};
  return {
    report: r,
    ebitda:               n(r.totalRevenue) - n(r.strikeLoss) + n(r.strikeVariableSaved) - n(r.totalCost),
    loanPayments:         n(r.loanPayments),
    seasonalReactivation: n(r.seasonalReactivation),
    leaseRedelivery:      n(r.leaseRedelivery),
    leaseDepositReturned: n(r.leaseDepositReturned),
    unplannedMaint:       n(r.maintenanceChecks?.spend) + n(r.mro?.aogSpend) - n(r.mro?.aogInsurance),
    corporateTax:         n(r.corporateTax),
    netCash:              n(r.cashDelta),
  };
}
