// ─────────────────────────────────────────────────────────────────────────────
// Standings: what a world ranks on, and the live stats every player can see.
//
// ONE definition of "net profit" for the whole game. Before this module the
// Dashboard called the weekly CASH change "Net profit" while the Finance P&L
// called the accrual figure "Net income", so the same airline had two
// different profits depending on which screen you read. Net profit is now the
// accrual figure everywhere:
//
//   net profit = EBIT − loan interest − corporate tax
//              = cash change + loan principal repaid − depreciation
//                − lease deposits handed back
//
// Loan principal is financing, not a cost; depreciation is the cost of owning
// an aircraft spread over its life; a returned lease deposit is the airline's
// own money coming back, not income. The cash change is still shown — as
// "Net cash flow" — it just isn't called profit any more.
//
// THE RANKING. A world ranks every active airline on its average weekly net
// profit over the last 52 weeks (fewer while the world is younger than a
// year). When the world ends, that window is exactly the final 52 weeks, so
// the standings on the last tick ARE the result: highest average wins.
//
// Weeks an airline was not flying — it joined late, or was re-founded after a
// bankruptcy — count as $0. The divisor is the world's window, not the
// airline's history length, so a ten-week hot streak can't outscore a year.
//
// Pure functions of a save blob: the server tick, the backfill tool and every
// client screen call these, so they cannot disagree.
// ─────────────────────────────────────────────────────────────────────────────

import { getAircraftType, eraPurchasePrice } from '../data/aircraft.js';
import { DEPRECIATION_YEARS, tailBookValue } from '../data/overhead.js';
import { LEGACY_STARTING_CAPITAL } from '../data/credit.js';
import { outstandingLoanBalance } from './financeProjection.js';
import { regionOf, regionLabel } from './market.js';
import { getAirport } from '../data/airports.js';

export const RANKING_WINDOW_WEEKS = 52;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * Accrual net profit for one financialHistory entry.
 * Entries from before loan interest was recorded carry no split, so their
 * principal is unknown and taken as zero (the cash figure stands).
 */
export function netProfitOf(h) {
  if (!h) return 0;
  const cash = num(h.profit);
  const principal = h.loanInterest != null
    ? Math.max(0, num(h.loanPayments) - num(h.loanInterest))
    : 0;
  return Math.round(cash + principal - num(h.depreciation) - num(h.leaseDepositReturned));
}

/** The weekly cash change for one entry — "Net cash flow" in the UI. */
export function netCashFlowOf(h) {
  return Math.round(num(h?.profit));
}

/**
 * How many weeks the ranking averages over, given how many weeks the world
 * has flown so far. Never more than 52, never less than 1.
 */
export function rankingWindow(weeksFlown) {
  const w = Math.floor(num(weeksFlown));
  return Math.max(1, Math.min(RANKING_WINDOW_WEEKS, w));
}

/**
 * The ranking score: average weekly net profit over the window, in whole
 * dollars. Missing weeks are $0 (see the header).
 */
export function rankingScore(state, weeksFlown) {
  const window = rankingWindow(weeksFlown);
  const hist = Array.isArray(state?.financialHistory) ? state.financialHistory : [];
  const recent = hist.slice(-window);
  const total = recent.reduce((s, h) => s + netProfitOf(h), 0);
  return Math.round(total / window);
}

/** Book value of one airframe, as the Balance Sheet carries it. */
export function balanceSheetBookValue(aircraft, type = getAircraftType(aircraft?.typeId)) {
  if (aircraft?.ownershipType !== 'owned' || !type?.purchasePrice) return 0;
  // Straight line with no 10% floor; a converted tail adds its conversion.
  return Math.round(tailBookValue(aircraft, type, { floor: false }));
}

/**
 * The Balance Sheet, as numbers. Finance ▸ Balance Sheet renders exactly this,
 * and "Net assets" in the standings is its `equity`.
 */
export function balanceSheetOf(state) {
  const fleet = Array.isArray(state?.fleet) ? state.fleet : [];
  const cash = num(state?.cash);
  const ownedFleet = fleet.filter((a) => a?.ownershipType === 'owned').map((a) => {
    const type = getAircraftType(a.typeId);
    return { aircraft: a, type, bookValue: balanceSheetBookValue(a, type) };
  });
  const fleetValue = ownedFleet.reduce((s, f) => s + f.bookValue, 0);
  const holdings = Object.values(state?.portfolio?.holdings ?? {}).filter((h) => h?.shares > 0);
  const investments = holdings.reduce((s, h) => s + Math.round(num(h.shares) * num(h.lastPrice)), 0);

  // Money the airline has paid out but still owns. Both used to vanish from the
  // sheet the moment they were paid, so Net Assets fell on every order and
  // jumped back on every return — Time Flies' all-leasing field read as broke
  // (Vodkair: +$12.7M earned, $9.4M shown, $12.4M sitting with lessors).
  //
  // • Lease deposits: the security deposit on every leased tail in service and
  //   every lease frame on order. It comes back on redelivery, on an early
  //   return, as a credit against a buy-out, and on cancellation — a receivable.
  // • Aircraft on order: the full price of a purchase order, paid at order time,
  //   that becomes the airframe's book value on delivery.
  // The LENDER does not count either (data/credit.js bookEquity): a bank does
  // not lend against cash a lessor or a manufacturer is holding.
  const pending = Array.isArray(state?.pendingOrders) ? state.pendingOrders : [];
  const leasedTails = fleet.filter((a) => a?.ownershipType === 'lease' && a.status !== 'retired' && num(a.leaseDeposit) > 0);
  const leaseOrders = pending.filter((o) => o?.ownershipType === 'lease' && num(o.leaseDeposit) > 0);
  const purchaseOrders = pending.filter((o) => o?.ownershipType === 'owned' && num(o.totalPrice) > 0);
  const leaseDeposits = leasedTails.reduce((s, a) => s + num(a.leaseDeposit), 0)
    + leaseOrders.reduce((s, o) => s + num(o.leaseDeposit), 0);
  const aircraftOnOrder = purchaseOrders.reduce((s, o) => s + num(o.totalPrice), 0);

  const totalAssets = cash + fleetValue + investments + leaseDeposits + aircraftOnOrder;
  const loans = (state?.loans ?? []).map((loan) => ({ loan, balance: outstandingLoanBalance(loan) }));
  const loanBalance = loans.reduce((s, l) => s + l.balance, 0);
  const totalLiabilities = loanBalance;
  const equity = totalAssets - totalLiabilities;
  const paidInCapital = state?.paidInCapital ?? LEGACY_STARTING_CAPITAL;
  return {
    cash, ownedFleet, fleetValue, holdings, investments,
    leasedTails, leaseOrders, leaseDeposits, purchaseOrders, aircraftOnOrder,
    totalAssets,
    loans, loanBalance, totalLiabilities, equity, paidInCapital,
    retainedEarnings: equity - paidInCapital,
  };
}

/** Net assets (= total equity on the Balance Sheet). */
export function netAssetsOf(state) {
  return Math.round(balanceSheetOf(state).equity);
}

/** Aircraft on the books (retired airframes don't count). */
export function fleetSizeOf(state) {
  return (state?.fleet ?? []).filter((a) => a && a.status !== 'retired').length;
}

/**
 * Everything the live player list shows for one airline, from its save blob.
 *   weeklyProfit   last week's net profit (accrual)
 *   netCashFlow    last week's cash change
 *   netAssets      Balance Sheet equity
 *   paxWeek        passengers carried last week (Statistics ▸ total)
 *   flightsWeek    weekly departures (Statistics ▸ Weekly departures)
 *   fleetSize      aircraft on the books
 *   rankScore      average weekly net profit over the ranking window
 */
export function liveStatsOf(state, { weeksFlown } = {}) {
  const hist = Array.isArray(state?.financialHistory) ? state.financialHistory : [];
  const last = hist[hist.length - 1] ?? null;
  const stats = Array.isArray(state?.statsHistory) ? state.statsHistory : [];
  const lastStat = stats[stats.length - 1] ?? null;
  return {
    weeklyProfit: last ? netProfitOf(last) : 0,
    netCashFlow: last ? netCashFlowOf(last) : 0,
    netAssets: netAssetsOf(state),
    paxWeek: lastStat
      ? Math.round(num(lastStat.paxOrganic) + num(lastStat.paxConnecting) + num(lastStat.paxInterline))
      : 0,
    flightsWeek: lastStat ? Math.round(num(lastStat.flights)) : 0,
    fleetSize: fleetSizeOf(state),
    rankScore: rankingScore(state, weeksFlown ?? hist.length),
  };
}

/**
 * Standings order: higher average weekly net profit first; ties go to the
 * larger net assets, then to name so the order is stable.
 * Works on any objects carrying { rankScore, netAssets, name }.
 */
export function compareStandings(a, b) {
  const s = num(b?.rankScore) - num(a?.rankScore);
  if (s !== 0) return s;
  const n = num(b?.netAssets) - num(a?.netAssets);
  if (n !== 0) return n;
  return String(a?.name ?? '').localeCompare(String(b?.name ?? ''));
}

/**
 * Where a world is in its season: whether the final 52 weeks — the ones that
 * decide the title — have begun, and how many weeks are left.
 *   totalWeeks   the world's length in weeks (lengthYears × 52)
 *   weeksFlown   weeks completed so far
 */
export function finalStretchOf({ totalWeeks, weeksFlown }) {
  const total = Math.max(0, Math.floor(num(totalWeeks)));
  const flown = Math.max(0, Math.floor(num(weeksFlown)));
  const startsAfter = Math.max(0, total - RANKING_WINDOW_WEEKS); // weeks flown when it begins
  const weeksLeft = Math.max(0, total - flown);
  return {
    inFinalStretch: total > 0 && flown >= startsAfter && weeksLeft > 0,
    weeksLeft,
    weeksUntilFinalStretch: Math.max(0, startsAfter - flown),
    ended: total > 0 && flown >= total,
  };
}


// ─── Live races (docs/game-audit-2026-11-06.md F2) ──────────────────────────
//
// The title is one race, and most of a world is not in it. These are the side
// races a player outside the top five can win while the season runs, built
// only from the public standings rows the world page already serves (so no
// new data and nothing private): the best NEWCOMER (joined after the first
// half-year, scored per week actually flown, since the title average counts a
// late joiner's missing weeks as $0), the champion of each REGION (by the home
// hub's region, where at least two airlines are based), and the busiest airline
// this week. The season awards honour the same spirit at the end.
export const RACES = { newcomerAfterWeek: 26, minRegionAirlines: 2, maxRegions: 6 };

/**
 * Side races from standings rows ({ id, name, hub, joinedWeek, avgProfit, paxWeek }).
 * Returns [{ key, title, leader: { id, name, value }, runnerUp|null, unit }].
 */
export function liveRaces(rows, { weeksFlown = 0 } = {}) {
  const live = (rows ?? []).filter(r => r && r.avgProfit != null);
  const out = [];
  const top2 = (arr, val) => {
    const s = arr.map(r => ({ r, v: val(r) })).filter(x => Number.isFinite(x.v)).sort((a, b) => b.v - a.v);
    return s.length ? { leader: { id: s[0].r.id, name: s[0].r.name, value: s[0].v },
      runnerUp: s[1] ? { id: s[1].r.id, name: s[1].r.name, value: s[1].v } : null } : null;
  };
  const window = rankingWindow(weeksFlown);
  const newcomers = live.filter(r => Number(r.joinedWeek) > RACES.newcomerAfterWeek);
  if (newcomers.length > 0) {
    const t = top2(newcomers, r => {
      const flying = Math.max(1, Math.min(window, weeksFlown - Number(r.joinedWeek) + 1));
      return (r.avgProfit * window) / flying;
    });
    if (t) out.push({ key: 'newcomer', title: 'Best newcomer', unit: 'perWeek', ...t });
  }
  const byRegion = new Map();
  for (const r of live) {
    const reg = regionOf(getAirport(r.hub)?.country ?? null);
    if (!reg) continue;
    if (!byRegion.has(reg)) byRegion.set(reg, []);
    byRegion.get(reg).push(r);
  }
  const regions = [...byRegion.entries()]
    .filter(([, rs]) => rs.length >= RACES.minRegionAirlines)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, RACES.maxRegions);
  for (const [reg, rs] of regions) {
    const t = top2(rs, r => r.avgProfit);
    if (t) out.push({ key: `region:${reg}`, title: `${regionLabel(reg)} champion`, unit: 'perWeek', ...t });
  }
  const busiest = top2(live, r => Number(r.paxWeek));
  if (busiest && busiest.leader.value > 0) out.push({ key: 'busiest', title: 'Busiest this week', unit: 'pax', ...busiest });
  return out;
}
