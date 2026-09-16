/**
 * fuelImpact.js — what the fuel price is costing this airline, in dollars.
 *
 * Every screen that mentions fuel today speaks in index multipliers ("1.28×",
 * "+28%", "lock at 1.31×"). Nothing says what that IS in money, so a player
 * whose margin has been eaten by a 30-week high-fuel stretch reads the P&L
 * week by week, sees each fuel line move a few percent, and concludes
 * "fuel is stable — something else is broken" (Heavy Landing, Sep 2026:
 * fuel bill $147M → $253M/wk over 40 weeks, revenue flat, profit $99M → $22M).
 *
 * This module derives, from data the save already carries, the numbers that
 * answer the question:
 *   - the fuel bill this week, and what it would be at a normal (1.0×) price;
 *   - the difference — what above- (or below-) normal fuel is costing per week;
 *   - how much profit moves per 0.1 on the index;
 *   - the same bill/index/profit N weeks ago, so a slow burn reads as a slope;
 *   - what a hedge quote means in dollars.
 *
 * Pure derivation. Reads financialHistory (fuel, fuelIndex, revenue, profit),
 * hedgeContracts and lastReport; writes nothing, changes no tick output.
 *
 * The bill in each history entry is at the EFFECTIVE multiplier that week
 * (hedges blended in). The entry stores the market index only, so the
 * effective multiplier is rebuilt from the contracts that were live that
 * week — the same filter tickPrep applies — which makes the base bill exact
 * rather than "fuel / index", which over-states the base for a hedged airline.
 */

import { effectiveFuelMultiplier, absoluteWeek, hedgeLockedPrice, fuelIndexStatus,
         FUEL_BASE_INDEX } from './fuel.js';

/** Hedges live at absolute week `abs` under tickPrep's rule (bought on or before, not yet expired). */
export function hedgesLiveAt(contracts, abs) {
  return (contracts ?? []).filter(h =>
    Number.isFinite(h?.expiryAbsWeek) && h.expiryAbsWeek > abs
    && (!Number.isFinite(h?.startAbsWeek) || h.startAbsWeek <= abs));
}

/**
 * One history entry, decomposed.
 *   bill      fuel paid that week (at the effective multiplier)
 *   index     market index that week
 *   effMult   effective multiplier (market blended with live hedges)
 *   baseBill  what the same flying would have cost at 1.0×
 *   excess    bill − baseBill: what the price level cost (negative = cheap fuel saved money)
 *   hedgeSaved  what the live hedges saved vs paying market (0 when unhedged)
 */
export function decomposeWeek(entry, contracts = [], { effMult: effOverride = null } = {}) {
  if (!entry) return null;
  const bill  = Number(entry.fuel) || 0;
  const index = Number.isFinite(entry.fuelIndex) ? entry.fuelIndex : FUEL_BASE_INDEX;
  let effMult = effOverride;
  if (!Number.isFinite(effMult) || effMult <= 0) {
    const abs = Number.isFinite(entry.year) && Number.isFinite(entry.week)
      ? absoluteWeek(entry.year, entry.week) : null;
    effMult = abs != null ? effectiveFuelMultiplier(index, hedgesLiveAt(contracts, abs)) : index;
  }
  if (!(effMult > 0)) effMult = FUEL_BASE_INDEX;
  const baseBill   = bill / effMult;
  const marketBill = baseBill * index;
  return {
    label:      entry.label ?? null,
    week:       entry.week ?? null,
    year:       entry.year ?? null,
    bill:       Math.round(bill),
    index,
    effMult,
    baseBill:   Math.round(baseBill),
    excess:     Math.round(bill - baseBill),
    hedgeSaved: Math.round(marketBill - bill),
    revenue:    Number(entry.revenue) || 0,
    profit:     Number(entry.profit)  || 0,
  };
}

/**
 * The full readout for a state.
 *
 * @param {object} state
 * @param {object} [opts]
 * @param {number[]} [opts.lookbacks=[13,26]]  weeks back to compare against
 * @returns {object|null}  null when the airline has not yet flown a week
 */
export function fuelImpact(state, { lookbacks = [13, 26] } = {}) {
  const history   = state?.financialHistory ?? [];
  const contracts = state?.hedgeContracts ?? [];
  if (!history.length) return null;

  const latest = history[history.length - 1];
  // lastReport is the same tick as the newest history entry and carries the
  // exact blended multiplier; prefer it when the two line up.
  const rep = state?.lastReport;
  const repMatches = rep && Number.isFinite(rep.fuelMultiplier) && rep.fuelMultiplier > 0
    && Number.isFinite(rep.totalFuel) && Math.round(rep.totalFuel) === Math.round(latest.fuel);
  const now = decomposeWeek(latest, contracts, { effMult: repMatches ? rep.fuelMultiplier : null });

  const series = history.map(h => decomposeWeek(h, contracts));

  const ago = lookbacks
    .map(weeks => {
      const i = history.length - 1 - weeks;
      if (i < 0) return null;
      const then = series[i];
      return {
        weeks,
        label:    then.label,
        index:    then.index,
        bill:     then.bill,
        baseBill: then.baseBill,
        excess:   then.excess,
        revenue:  then.revenue,
        profit:   then.profit,
        dIndex:   +(now.index - then.index).toFixed(3),
        dBill:    now.bill    - then.bill,
        dExcess:  now.excess  - then.excess,
        dRevenue: now.revenue - then.revenue,
        dProfit:  now.profit  - then.profit,
      };
    })
    .filter(Boolean);

  // The cheapest and dearest weeks in the window the save keeps (≤ 52), so a
  // slow burn that started before any fixed lookback still has an anchor:
  // "at the year's low of 0.78x this bill was $147M".
  const pick = (better) => series.reduce((b, w) => (b == null || better(w, b) ? w : b), null);
  const lowW  = pick((w, b) => w.index < b.index);
  const highW = pick((w, b) => w.index > b.index);
  const anchor = (w) => w ? {
    label: w.label, index: w.index, bill: w.bill, profit: w.profit, revenue: w.revenue,
    weeksAgo: series.length - 1 - series.indexOf(w),
    dIndex: +(now.index - w.index).toFixed(3), dBill: now.bill - w.bill, dProfit: now.profit - w.profit,
  } : null;

  const perTenth = Math.round(now.baseBill * 0.1);
  const revenue  = now.revenue;
  const totalCost = Number(latest.totalCost) || 0;

  return {
    index:      now.index,
    status:     fuelIndexStatus(now.index),
    effMult:    now.effMult,
    hedged:     now.effMult !== now.index,
    bill:       now.bill,
    baseBill:   now.baseBill,
    excess:     now.excess,
    hedgeSaved: now.hedgeSaved,
    perTenth,
    profit:     now.profit,
    revenue,
    shareOfRevenue: revenue   > 0 ? now.bill / revenue   : null,
    shareOfCost:    totalCost > 0 ? now.bill / totalCost : null,
    // How many times over the above-normal fuel cost covers this week's profit.
    // 2.5 reads "fuel above normal is costing you 2.5× what you made".
    excessVsProfit: now.profit > 0 ? now.excess / now.profit : null,
    ago,
    low:  anchor(lowW),
    high: anchor(highW),
    series,
  };
}

/**
 * A hedge quote in dollars, for the buy card.
 *
 *   billCovered   the part of this week's fuel bill the contract would cover,
 *                 at the locked price (so the number the player is committing to)
 *   vsSpot        per-week saving (+) or cost (−) if the market stays where it is
 *   breakevenIndex  the market index above which the hedge pays for itself
 *
 * Uses the same pricing call BUY_HEDGE stores, so the card cannot drift from
 * the contract it sells (the exact bug Fuel economy v2 fixed once already).
 */
export function hedgeQuoteDollars(state, durationOpt, coverage) {
  const impact = fuelImpact(state, { lookbacks: [] });
  const marketIndex = state?.fuelPrice?.index ?? FUEL_BASE_INDEX;
  const locked = hedgeLockedPrice(marketIndex, durationOpt);
  const cov = Math.max(0, Math.min(1, Number(coverage) || 0));
  const baseBill = impact?.baseBill ?? 0;
  const billCovered = Math.round(baseBill * cov * locked);
  const vsSpot      = Math.round(baseBill * cov * (marketIndex - locked));
  return {
    locked,
    marketIndex,
    coverage: cov,
    weeks: durationOpt?.weeks ?? 0,
    baseBillCovered: Math.round(baseBill * cov),
    billCovered,
    vsSpot,
    vsSpotTerm: vsSpot * (durationOpt?.weeks ?? 0),
    breakevenIndex: locked,
    perTenth: Math.round(baseBill * cov * 0.1),
  };
}

/**
 * The one-line digest for "while you were away" / the weekly debrief:
 * null when fuel did not move enough to mention.
 */
export function fuelDigest(state, weeksBack, { minMove = 0.05 } = {}) {
  const impact = fuelImpact(state, { lookbacks: [weeksBack] });
  const ago = impact?.ago?.[0];
  if (!impact || !ago) return null;
  if (Math.abs(ago.dIndex) < minMove) return null;
  return {
    from: ago.index, to: impact.index, dIndex: ago.dIndex,
    dBill: ago.dBill, dExcess: ago.dExcess, excess: impact.excess,
    perTenth: impact.perTenth, weeks: weeksBack,
  };
}
