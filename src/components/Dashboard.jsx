import { useMemo, useState } from 'react';
import { useGame } from '../store/GameContext.jsx';
import { formatMoney, formatPercent, simulateRoute, currentGameDate, maintenanceMultiplier, weeklyBlockHours, MAX_WEEKLY_BLOCK_HOURS, routeDistanceKm, weekToGameDate, formatGameDate, fleetAvgUtilization } from '../utils/simulation.js';
import { projectWeek } from '../utils/financeProjection.js';
import { getAircraftType } from '../data/aircraft.js';
import { getAirport } from '../data/airports.js';
import AirportLink from './AirportLink.jsx';
import { getSeasonalProfile } from '../models/demand.js';
import BoardObjectives from './BoardObjectives.jsx';
import InfoTip from './InfoTip.jsx';
import { AlertIcon, DotIcon, TrendDownIcon, PackageIcon, CloseIcon } from './Icons.jsx';

// localStorage key for which dashboard cards the player has collapsed.
const DASH_COLLAPSE_KEY = 'hw_dash_collapsed_v1';

// Small ▸/▾ toggle used in collapsible card headers.
function CollapseChevron({ collapsed, onClick, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={collapsed ? `Show ${label}` : `Hide ${label}`}
      aria-label={collapsed ? `Show ${label}` : `Hide ${label}`}
      aria-expanded={!collapsed}
      style={{
        background: 'none', border: 'none', padding: 0, cursor: 'pointer',
        color: 'var(--text-dim)', font: 'inherit', display: 'inline-flex', alignItems: 'center',
      }}
    >
      <span style={{ fontSize: 10, width: 10, display: 'inline-block' }}>{collapsed ? '▸' : '▾'}</span>
    </button>
  );
}

export default function Dashboard({ onNavigate }) {
  const { state, remote } = useGame();
  const { cash, fleet, routes, cargoRoutes = [], financialHistory, lastReport, week, year, activeEvents = [], satisfaction } = state;
  const [selectedEvent, setSelectedEvent] = useState(null);

  // Jump to another tab when a KPI / row is clicked. No-op if the host app
  // hasn't wired onNavigate (e.g. a build where App doesn't pass it yet), so
  // the tiles simply stay non-clickable rather than breaking.
  const canNavigate = typeof onNavigate === 'function';
  const go = (tab) => { if (canNavigate) onNavigate(tab); };

  // How much financial history the chart shows ('all' | '12' | '26' | '52').
  const [chartRange, setChartRange] = useState('all');

  // Per-card collapse state, persisted so veterans keep their layout between
  // visits. localStorage is best-effort — never let a read/write throw.
  const [collapsed, setCollapsed] = useState(() => {
    try { return JSON.parse(localStorage.getItem(DASH_COLLAPSE_KEY) || '{}') || {}; }
    catch { return {}; }
  });
  const toggleCollapse = (key) => setCollapsed(prev => {
    const next = { ...prev, [key]: !prev[key] };
    try { localStorage.setItem(DASH_COLLAPSE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
    return next;
  });

  // ── Projections ──────────────────────────────────────────────────────────
  const weeklyLeaseCost = fleet.reduce((sum, a) => {
    return sum + (getAircraftType(a.typeId)?.weeklyLease ?? 0);
  }, 0);

  const gd = currentGameDate(state);

  // Canonical projection — the SAME single-source-of-truth used by the Finance page,
  // so the Dashboard's revenue/profit always agree with Finance. Runs the real engine
  // (so cargo, all fixed costs, loan interest and tax are included) rather than a
  // home-grown estimate.
  const proj = useMemo(() => projectWeek(state), [state]);

  // Per-route results read from the SAME engine projection the Routes and Finance
  // screens use — never a standalone re-simulation. A bare simulateRoute() here
  // ignored competitor encroachment, labor, the fuel-price multiplier and revenue
  // lifts, so the Dashboard's "Top Routes" profit/revenue/load disagreed with every
  // other screen and, because the memo only tracked state.week, froze (e.g. a load
  // factor stuck at its old value) when the player changed fares mid-week. Prefer the
  // engine's routeResult; fall back to a standalone sim only for routes the engine
  // skips (grounded / dormant-seasonal), using the same labor + fuel the engine used.
  const routeResults = useMemo(() => {
    const rrById = {};
    for (const rr of proj.report?.routeResults ?? []) rrById[rr.routeId] = rr;
    const avgUtil = fleetAvgUtilization(fleet, [...routes, ...(state.cargoRoutes ?? [])]);
    return routes.map(route => {
      const aircraft = fleet.find(a => a.id === route.aircraftId);
      const result = !aircraft ? null
        : (rrById[route.id] ?? simulateRoute(route, aircraft, gd, state.labor ?? null, proj.fuelMultiplier, null, [], avgUtil, state.satisfaction ?? null));
      return { route, result };
    });
  }, [routes, fleet, proj, gd, state.labor]);

  const projectedRevenue = proj.effectiveRevenue;   // all-in weekly revenue (incl. cargo)
  const projectedProfit  = proj.netCash;            // fully-loaded weekly cash bottom line

  // Cargo headline figures (from the same engine pass)
  const cargoRevenue = proj.report.totalCargoRevenue ?? 0;
  const cargoTonnes  = proj.report.totalCargoTonnes ?? 0;

  // Network-wide load factor & yield (passenger network, canonical projection).
  // passengers/configuredSeatsOneWay are per direction; revenue covers both
  // directions, so RPK = pax × 2 × distance and boarded pax/wk = pax × 2.
  const networkStats = useMemo(() => {
    let pax = 0, seats = 0, rpk = 0, rev = 0;
    for (const rr of proj.report?.routeResults ?? []) {
      pax   += rr.passengers ?? 0;
      seats += rr.configuredSeatsOneWay ?? 0;
      rpk   += (rr.passengers ?? 0) * 2 * (rr.distance ?? 0);
      rev   += rr.revenue ?? 0;
    }
    return {
      loadFactor:  seats > 0 ? pax / seats : null,
      boardedPax:  pax * 2,
      yieldPerPkm: rpk > 0 ? rev / rpk : null,   // $ per passenger-km
      revPerPax:   pax > 0 ? rev / (pax * 2) : null,
    };
  }, [proj]);

  // Fleet age & the maintenance premium it silently carries. Maintenance rises
  // with age via maintenanceMultiplier(); comparing the aged bill to a
  // brand-new-fleet baseline surfaces cost creep that utilisation alone hides.
  const fleetHealth = useMemo(() => {
    if (fleet.length === 0) return null;
    let baseMaint = 0, agedMaint = 0, ageWeeks = 0;
    for (const a of fleet) {
      const t    = getAircraftType(a.typeId);
      const base = t?.baseMaintenancePerWk ?? 0;
      baseMaint += base;
      agedMaint += base * maintenanceMultiplier(a.ageWeeks ?? 0);
      ageWeeks  += a.ageWeeks ?? 0;
    }
    return {
      avgAgeYears:  (ageWeeks / fleet.length) / 52,
      maintPremium: baseMaint > 0 ? agedMaint / baseMaint - 1 : 0,
    };
  }, [fleet]);

  // Passenger-satisfaction trend: points vs the prior completed week. The
  // satisfaction field is new to history entries, so the delta only appears
  // once two ticks have written it — guard for nulls.
  const satTrend = (() => {
    const a = financialHistory.at(-1)?.satisfaction;
    const b = financialHistory.at(-2)?.satisfaction;
    return a != null && b != null ? a - b : null;
  })();

  // Per-route operating cost — retained only for the cost-breakdown fallback below
  // (used when there's no lastReport yet). Now reads the real totalOpCost key.
  const projectedOpCost  = routeResults.reduce((s, { result }) => s + (result?.totalOpCost ?? 0), 0);
  // True cash runway: only meaningful when you're burning cash. Profitable (or
  // break-even) => cash grows, so runway is Infinity. Matches the Finance page.
  const weeksOfCash      = projectedProfit < 0 && cash > 0 ? Math.floor(cash / -projectedProfit) : Infinity;
  const idleAircraft     = fleet.filter(a => a.status === 'idle').length;

  // ── Cost breakdown ─────────────────────────────────────────────────────────
  // Prefer lastReport (has all buckets). Fall back to per-route projections for new games.
  const costBreakdown = useMemo(() => {
    if (lastReport && lastReport.totalCost > 0) {
      const fuel        = lastReport.totalFuel              ?? 0;
      const crew        = (lastReport.totalCrew             ?? 0) + (lastReport.totalLaborCosts ?? 0);
      const leases      = lastReport.totalLeases            ?? 0;
      const maintenance = lastReport.totalMaintenance       ?? 0;
      const gates       = (lastReport.totalGateFees         ?? 0) + (lastReport.totalLandingFees ?? 0);
      const service     = (lastReport.totalQuality          ?? 0) + (lastReport.totalCatering    ?? 0)
                        + (lastReport.totalGroundHandling   ?? 0) + (lastReport.totalLounge      ?? 0)
                        + (lastReport.totalLayover          ?? 0) + (lastReport.totalCompensation ?? 0);
      const overhead    = (lastReport.totalHQCost           ?? 0) + (lastReport.totalInsurance   ?? 0)
                        + (lastReport.totalFamilyBaseCosts  ?? 0) + (lastReport.totalDistributionCost ?? 0);
      const growth      = (lastReport.totalMarketingSpend   ?? 0) + (lastReport.totalLoyaltyCost ?? 0)
                        + (lastReport.totalHubInvestment    ?? 0) + (lastReport.totalPartnerFees ?? 0);
      const total       = fuel + crew + leases + maintenance + gates + service + overhead + growth;
      return { fuel, crew, leases, maintenance, gates, service, overhead, growth, total, fromReport: true };
    }
    // Projection fallback (missing gates/overhead/growth — new game, no report yet)
    const fuel        = routeResults.reduce((s, { result }) => s + (result?.fuelCost  ?? 0), 0);
    const crew        = routeResults.reduce((s, { result }) => s + (result?.crewCost  ?? 0), 0);
    const maintenance = fleet.reduce((s, a) => {
      const type = getAircraftType(a.typeId);
      return s + Math.round((type?.baseMaintenancePerWk ?? 0) * maintenanceMultiplier(a.ageWeeks ?? 0));
    }, 0);
    const service = Math.max(0, projectedOpCost - fuel - crew);
    const total   = fuel + crew + weeklyLeaseCost + maintenance + service;
    return { fuel, crew, leases: weeklyLeaseCost, maintenance, gates: 0, service, overhead: 0, growth: 0, total, fromReport: false };
  }, [lastReport, routeResults, fleet, weeklyLeaseCost, projectedOpCost]);

  const totalWeeklyCosts = costBreakdown.total;

  // ── Weekly P&L bridge (route profit → net profit), last week + projected ──
  // The Top Routes table shows per-route OPERATING profit (revenue − direct
  // route costs − landing fees). That deliberately excludes fleet fixed costs,
  // overhead, financing and tax — so the routes never "add up" to the bottom
  // line. This bridge makes the gap explicit, for BOTH what actually happened
  // last week (lastReport) and the coming week (the canonical projectWeek pass).
  //
  // Identities (mirror simulation.js weeklyTick + the reducer / projectWeek):
  //   routeOp  = Σ routeResults.profit + totalCargoProfit
  //            = (route+cargo revenue) − totalOpCost            [op cost incl. landing fees]
  //   fixed    = totalCost − totalOpCost                        [leases…distribution]
  //   EBITDA   = routeOp + partner/other revenue − fixed − strike loss
  //   net      = EBITDA − loan payments − one-time charges − corporate tax
  const pnl = useMemo(() => {
    const fromReport = (r) => {
      if (!r) return null;
      const routeOp  = (r.routeResults ?? []).reduce((s, rr) => s + (rr.profit ?? 0), 0)
                     + (r.totalCargoProfit ?? 0);
      const otherRev = (r.totalPartnerRevenue ?? 0) + (r.eventDemandAdj ?? 0);
      const fixed    = Math.max(0, (r.totalCost ?? 0) - (r.totalOpCost ?? 0));
      const strike   = r.strikeLoss ?? 0;
      const operating = routeOp + otherRev - fixed - strike;               // EBITDA
      const loans     = r.loanPayments ?? 0;
      const oneOff    = (r.leaseRedelivery ?? 0) + (r.seasonalReactivation ?? 0);
      const tax       = r.corporateTax ?? 0;
      return {
        routeOp, otherRev, fixed, strike, operating, loans, oneOff, tax,
        net: operating - loans - oneOff - tax,
        breakdown: {
          leases:       r.totalLeases ?? 0,
          maintenance:  r.totalMaintenance ?? 0,
          gates:        r.totalGateFees ?? 0,
          labor:        r.totalLaborCosts ?? 0,
          overhead:     (r.totalHQCost ?? 0) + (r.totalInsurance ?? 0) + (r.totalFamilyBaseCosts ?? 0),
          marketing:    (r.totalMarketingSpend ?? 0) + (r.totalLoyaltyCost ?? 0) + (r.totalHubInvestment ?? 0),
          distribution: (r.totalDistributionCost ?? 0) + (r.totalPartnerFees ?? 0),
        },
      };
    };
    const projected = fromReport(proj.report);
    if (projected) {
      // Below-the-line items come from the canonical projection so the card's
      // net EXACTLY equals the "Projected Profit / wk" KPI (proj.netCash).
      projected.operating = proj.ebitda;
      projected.loans     = proj.loanPayments;
      projected.oneOff    = proj.seasonalReactivation;
      projected.tax       = proj.corporateTax;
      projected.net       = proj.netCash;
    }
    const lastWeek = fromReport(lastReport);
    if (lastWeek && lastReport?.cashDelta != null) lastWeek.net = lastReport.cashDelta;
    return { projected, lastWeek };
  }, [proj, lastReport]);

  // ── Top Routes view toggle (projected vs what actually happened) ──────────
  const [routeView, setRouteView] = useState('projected');
  const lastWeekRRById = useMemo(() => {
    const m = {};
    for (const rr of lastReport?.routeResults ?? []) m[rr.routeId] = rr;
    return m;
  }, [lastReport]);
  const hasLastWeekRoutes = (lastReport?.routeResults?.length ?? 0) > 0;
  const showLastWeekRoutes = routeView === 'lastweek' && hasLastWeekRoutes;

  // "True profit" view: profit after each route also carries its SHARE of the
  // aircraft's weekly lease + maintenance. The engine's per-route trueProfit
  // charges the FULL aircraft cost to every route it flies, which double-counts
  // when one aircraft serves several routes — so apportion by block-hour share
  // (cargo routes included in the denominator so freighter time isn't billed
  // to passenger routes).
  const trueResults = useMemo(() => {
    const bhFor = (r) => {
      const ac = fleet.find(a => a.id === r.aircraftId);
      const t  = ac ? getAircraftType(ac.typeId) : null;
      return t ? weeklyBlockHours(routeDistanceKm(r.origin, r.destination), r.weeklyFrequency, t) : 0;
    };
    const bhByAircraft = {};
    for (const r of [...routes, ...cargoRoutes]) {
      bhByAircraft[r.aircraftId] = (bhByAircraft[r.aircraftId] ?? 0) + bhFor(r);
    }
    return routeResults.map(({ route, result }) => {
      if (!result) return { route, result };
      const totalBh = bhByAircraft[route.aircraftId] || 0;
      const share   = totalBh > 0 ? bhFor(route) / totalBh : 1;
      const fixedShare = Math.round(((result.weeklyLeaseCost ?? 0) + (result.weeklyMaintCost ?? 0)) * share);
      return { route, result: { ...result, profit: (result.profit ?? 0) - fixedShare, fixedShare } };
    });
  }, [routeResults, routes, cargoRoutes, fleet]);

  // The dataset the table actually renders. Last-week rows join the stored
  // engine report to current routes by id — routes opened this week show "—".
  const displayedResults = useMemo(() => (
    showLastWeekRoutes ? routes.map(route => ({ route, result: lastWeekRRById[route.id] ?? null }))
    : routeView === 'true' ? trueResults
    : routeResults
  ), [showLastWeekRoutes, routeView, routes, lastWeekRRById, trueResults, routeResults]);

  // ── Route profit normalization (for mini-bars) ─────────────────────────────
  const routeProfitMap = displayedResults.reduce((acc, { route, result }) => {
    const key = `${route.origin}→${route.destination}`;
    acc[key] = (acc[key] ?? 0) + (result?.profit ?? 0);
    return acc;
  }, {});
  const maxAbsRouteProfit = Math.max(1, ...Object.values(routeProfitMap).map(p => Math.abs(p)));
  const maxRouteRevenue   = Math.max(1, ...Object.values(
    displayedResults.reduce((acc, { route, result }) => {
      const key = `${route.origin}→${route.destination}`;
      acc[key] = (acc[key] ?? 0) + (result?.revenue ?? 0);
      return acc;
    }, {})
  ));

  // ── Trends (vs 2 weeks ago) ───────────────────────────────────────────────
  const hist    = financialHistory;
  const prevRev = hist.at(-2)?.revenue ?? null;
  const revTrend = prevRev != null && lastReport
    ? ((lastReport.totalRevenue - prevRev) / Math.max(1, prevRev)) * 100
    : null;
  const profTrend = hist.length >= 2
    ? hist.at(-1)?.profit - hist.at(-2)?.profit
    : null;

  // ── Unique airports and countries ────────────────────────────────────────
  const airportCodes = useMemo(() => {
    const codes = new Set([state.hub]);
    routes.forEach(r => { codes.add(r.origin); codes.add(r.destination); });
    return [...codes];
  }, [routes, state.hub]);
  const countries = useMemo(() => {
    const c = new Set(airportCodes.map(code => getAirport(code)?.country).filter(Boolean));
    return [...c];
  }, [airportCodes]);

  // ── Action alerts ────────────────────────────────────────────────────────
  const alerts = [];
  if (idleAircraft > 0)
    alerts.push({ color: 'var(--yellow)', icon: AlertIcon, text: `${idleAircraft} idle aircraft — paying lease with no revenue` });
  if (isFinite(weeksOfCash) && weeksOfCash < 4)
    alerts.push({ color: 'var(--red)', icon: DotIcon, text: `Only ${weeksOfCash} weeks of cash runway remaining` });
  // The silent killer: routes are in the black, but fixed costs, financing and
  // tax flip the bottom line negative. Invisible until cash dips — call it out.
  if (pnl.projected && pnl.projected.routeOp > 0 && pnl.projected.net < 0)
    alerts.push({
      color: 'var(--red)', icon: TrendDownIcon,
      text: `Routes earn +${formatMoney(pnl.projected.routeOp)}/wk, but fixed costs, financing & tax turn that into ${formatMoney(pnl.projected.net)}/wk — see Weekly P&L`,
    });
  const losingRoutes = routeResults.filter(({ result }) => result && result.profit < 0);
  if (losingRoutes.length > 0)
    alerts.push({ color: 'var(--red)', icon: TrendDownIcon, text: `${losingRoutes.length} loss-making route${losingRoutes.length !== 1 ? 's' : ''} — consider repricing` });
  if (activeEvents.length > 0) {
    const bad = activeEvents.filter(e =>
      (e.effects?.fuelMult ?? 1) > 1 ||
      (e.effects?.globalDemandMult ?? 1) < 1 ||
      (e.effects?.regionDemandMult ?? 1) < 1
    );
    if (bad.length > 0)
      alerts.push({ color: 'var(--yellow)', icon: bad[0].icon, text: `${bad[0].name} active — check Finance for impact` });
  }

  return (
    <div>
      {/* ── Active events banner ─────────────────────────────────────────── */}
      {activeEvents.length > 0 && (
        <div style={{
          display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14,
        }}>
          {activeEvents.map(ev => (
            <button
              key={ev.id}
              type="button"
              onClick={() => setSelectedEvent(ev)}
              title="Click for details"
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '4px 10px', borderRadius: 20,
                background: `${ev.color}18`, border: `1px solid ${ev.color}40`,
                fontSize: 11, color: ev.color, fontWeight: 600,
                cursor: 'pointer', font: 'inherit', lineHeight: 1.4,
              }}
            >
              <span>{ev.icon}</span>
              {ev.name}
              <span style={{ fontWeight: 400, color: 'var(--text-dim)' }}>{ev.weeksLeft}w</span>
              <span style={{ fontWeight: 400, color: ev.color, opacity: 0.7, marginLeft: 1 }}>ⓘ</span>
            </button>
          ))}
        </div>
      )}

      {/* ── Action alerts ────────────────────────────────────────────────── */}
      {alerts.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
          {alerts.map((a, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '8px 14px',
              background: 'var(--surface2)',
              borderLeft: `3px solid ${a.color}`,
              borderRadius: 'var(--radius)',
              fontSize: 13,
            }}>
              <span style={{ fontSize: 14, color: a.color, display: 'inline-flex', flexShrink: 0 }}>
                {typeof a.icon === 'function' ? (() => { const Ic = a.icon; return <Ic size={15} />; })() : a.icon}
              </span>
              <span style={{ color: 'var(--text)' }}>{a.text}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── KPI grid ─────────────────────────────────────────────────────── */}
      <div className="stat-grid" style={{ marginBottom: 16 }}>
        <KpiBox
          label="Cash Balance"
          value={formatMoney(cash)}
          color={cash >= 0 ? 'green' : 'red'}
          sub={isFinite(weeksOfCash) ? `${weeksOfCash} wks runway` : undefined}
          subColor={weeksOfCash < 4 ? 'var(--red)' : 'var(--text-dim)'}
          onClick={canNavigate ? () => go('finance') : undefined}
        />
        <KpiBox
          label="Projected Profit / wk"
          value={(projectedProfit >= 0 ? '+' : '') + formatMoney(projectedProfit)}
          color={projectedProfit >= 0 ? 'green' : 'red'}
          trend={profTrend}
          sub={projectedRevenue > 0 ? `${Math.round((projectedProfit / projectedRevenue) * 100)}% margin` : undefined}
          onClick={canNavigate ? () => go('finance') : undefined}
        />
        <KpiBox
          label="Revenue / wk"
          value={formatMoney(projectedRevenue)}
          color="green"
          trend={revTrend != null ? revTrend : undefined}
          trendIsPercent
          onClick={canNavigate ? () => go('finance') : undefined}
        />
        {cargoRoutes.length > 0 && (
          <KpiBox
            label="Cargo / wk"
            value={formatMoney(cargoRevenue)}
            color="green"
            sub={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><PackageIcon size={11} /> {Math.round(cargoTonnes).toLocaleString()} t/wk · {cargoRoutes.length} route{cargoRoutes.length !== 1 ? 's' : ''}</span>}
            subColor="var(--text-dim)"
            onClick={canNavigate ? () => go('routes') : undefined}
          />
        )}
        <KpiBox
          label="Fleet"
          value={`${fleet.length} aircraft`}
          color="blue"
          sub={idleAircraft > 0 ? `${idleAircraft} idle` : `${routes.length + cargoRoutes.length} routes`}
          subColor={idleAircraft > 0 ? 'var(--yellow)' : 'var(--text-dim)'}
          onClick={canNavigate ? () => go('fleet') : undefined}
        />
        {fleetHealth && (
          <KpiBox
            label="Fleet Age"
            value={`${fleetHealth.avgAgeYears.toFixed(1)} yrs`}
            color={fleetHealth.avgAgeYears < 8 ? 'green' : fleetHealth.avgAgeYears < 16 ? 'blue' : fleetHealth.avgAgeYears < 22 ? 'yellow' : 'red'}
            sub={fleetHealth.maintPremium > 0.005 ? `+${Math.round(fleetHealth.maintPremium * 100)}% upkeep vs new` : 'like-new upkeep'}
            subColor={fleetHealth.maintPremium > 0.25 ? 'var(--yellow)' : 'var(--text-dim)'}
            onClick={canNavigate ? () => go('fleet') : undefined}
          />
        )}
        <KpiBox
          label="Network"
          value={`${airportCodes.length} airports`}
          color="blue"
          sub={`${countries.length} ${countries.length === 1 ? 'country' : 'countries'}`}
          onClick={canNavigate ? () => go('map') : undefined}
        />
        {networkStats.loadFactor != null && (
          <KpiBox
            label="Load Factor"
            value={formatPercent(networkStats.loadFactor)}
            color={networkStats.loadFactor >= 0.75 ? 'green' : networkStats.loadFactor >= 0.5 ? 'blue' : 'yellow'}
            sub={`${Math.round(networkStats.boardedPax).toLocaleString()} pax/wk`}
            onClick={canNavigate ? () => go('routes') : undefined}
          />
        )}
        {networkStats.yieldPerPkm != null && (
          <KpiBox
            label="Yield"
            value={`${(networkStats.yieldPerPkm * 100).toFixed(1)}¢/pkm`}
            color="blue"
            sub={networkStats.revPerPax != null ? `${formatMoney(networkStats.revPerPax)} avg / pax` : undefined}
            onClick={canNavigate ? () => go('routes') : undefined}
          />
        )}
        {satisfaction != null && (
          <KpiBox
            label="Satisfaction"
            value={`${Math.round(satisfaction)}`}
            color={satisfaction >= 70 ? 'green' : satisfaction >= 50 ? 'blue' : satisfaction >= 30 ? 'yellow' : 'red'}
            trend={satTrend}
            trendUnit=" pt"
            sub={`${((satisfaction / 100) * 5).toFixed(1)}★ rating`}
            onClick={canNavigate ? () => go('reputation') : undefined}
          />
        )}
        <KpiBox
          label="Date"
          value={formatGameDate({ week, year })}
          valueStyle={{ fontSize: 13 }}
          sub={lastReport ? (lastReport.cashDelta >= 0 ? `+${formatMoney(lastReport.cashDelta)} last wk` : `${formatMoney(lastReport.cashDelta)} last wk`) : 'No data yet'}
          subColor={lastReport ? (lastReport.cashDelta >= 0 ? 'var(--green)' : 'var(--red)') : 'var(--text-dim)'}
        />
      </div>

      {/* ── Weekly P&L bridge (incl. cost-mix bar) ───────────────────────── */}
      {pnl.projected && (routes.length > 0 || cargoRoutes.length > 0 || pnl.lastWeek) && (
        <WeeklyPnL
          lastWeek={pnl.lastWeek}
          projected={pnl.projected}
          costBreakdown={totalWeeklyCosts > 0 ? costBreakdown : null}
          collapsed={!!collapsed.pnl}
          onToggleCollapse={() => toggleCollapse('pnl')}
        />
      )}

      {/* ── Board objectives ─────────────────────────────────────────────── */}
      <BoardObjectives />

      {/* ── Financial history chart ──────────────────────────────────────── */}
      {hist.length > 1 && (() => {
        const rangeN   = chartRange === 'all' ? hist.length : Number(chartRange);
        const chartHist = hist.slice(-rangeN);
        return (
          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: collapsed.chart ? 0 : 10 }}>
              <div className="card-title" style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: 4 }}>
                <CollapseChevron collapsed={!!collapsed.chart} onClick={() => toggleCollapse('chart')} label="financial history" />
                Financial History
              </div>
              {!collapsed.chart && hist.length > 12 && (
                <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
                  {[['12', '12w'], ['26', '26w'], ['52', '1y'], ['all', 'All']].map(([key, lbl]) => (
                    <button
                      key={key}
                      onClick={() => setChartRange(key)}
                      style={{
                        padding: '3px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer', border: 'none',
                        background: chartRange === key ? 'var(--accent)' : 'transparent',
                        color: chartRange === key ? '#fff' : 'var(--text-muted)',
                      }}
                    >
                      {lbl}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {!collapsed.chart && <FinancialChart history={chartHist} currentWeek={week} />}
          </div>
        );
      })()}

      {/* ── Fleet utilization ────────────────────────────────────────────── */}
      {fleet.length > 0 && (() => {
        const utilEntries = fleet.map(a => {
          const type = getAircraftType(a.typeId);
          const bh = routes.filter(r => r.aircraftId === a.id).reduce((s, r) =>
            s + (type ? weeklyBlockHours(routeDistanceKm(r.origin, r.destination), r.weeklyFrequency, type) : 0), 0);
          return { grounded: a.status === 'grounded', p: Math.min(1, bh / MAX_WEEKLY_BLOCK_HOURS) };
        });
        const utilData = utilEntries.map(e => e.p);
        const avgPct  = utilData.reduce((s, p) => s + p, 0) / utilData.length;
        // Grounded aircraft get their own bucket so "Idle" here matches the
        // idle-aircraft alert above (status === 'idle', i.e. no routes, airworthy).
        const flying  = utilEntries.filter(e => !e.grounded);
        const buckets = {
          idle:     flying.filter(e => e.p === 0).length,
          grounded: utilEntries.filter(e => e.grounded).length,
          low:      flying.filter(e => e.p > 0 && e.p < 0.5).length,
          good:     flying.filter(e => e.p >= 0.5 && e.p < 0.9).length,
          full:     flying.filter(e => e.p >= 0.9).length,
        };
        const avgColor = avgPct >= 0.75 ? 'var(--green)' : avgPct >= 0.4 ? 'var(--yellow)' : 'var(--red)';
        return (
          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: collapsed.fleet ? 0 : 10 }}>
              <div className="card-title" style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: 4 }}>
                <CollapseChevron collapsed={!!collapsed.fleet} onClick={() => toggleCollapse('fleet')} label="fleet utilisation" />
                Fleet Utilisation
              </div>
              <span style={{ fontSize: 13, fontWeight: 700, color: avgColor }}>{Math.round(avgPct * 100)}% avg</span>
            </div>
            {!collapsed.fleet && (<>
            {/* Aggregate bar */}
            <div style={{ height: 10, background: 'var(--surface3)', borderRadius: 5, overflow: 'hidden', marginBottom: 10 }}>
              <div style={{ height: '100%', width: `${avgPct * 100}%`, background: avgColor, borderRadius: 5, transition: 'width 0.3s' }} />
            </div>
            {/* Bucket summary */}
            <div style={{ display: 'flex', gap: 20, fontSize: 12 }}>
              {[
                { label: 'Idle',     count: buckets.idle,     color: 'var(--text-dim)' },
                { label: 'Grounded', count: buckets.grounded, color: '#e8833a'         },
                { label: '< 50%',    count: buckets.low,      color: 'var(--yellow)'   },
                { label: '50–90%',   count: buckets.good,     color: 'var(--green)'    },
                { label: 'Full',     count: buckets.full,     color: 'var(--red)'      },
              ].map(b => b.count > 0 && (
                <div key={b.label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <div style={{ width: 8, height: 8, borderRadius: 2, background: b.color, flexShrink: 0 }} />
                  <span style={{ color: 'var(--text-muted)' }}>{b.label}</span>
                  <span style={{ fontWeight: 700, color: b.color }}>{b.count}</span>
                </div>
              ))}
            </div>
            </>)}
          </div>
        );
      })()}

      {/* ── Route performance ────────────────────────────────────────────── */}
      {routes.length > 0 && (
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div className="card-title" style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: 4 }}>
                <CollapseChevron collapsed={!!collapsed.routes} onClick={() => toggleCollapse('routes')} label="top routes" />
                Top Routes
              </div>
              {!collapsed.routes && (<>
              <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
                {[
                  ['projected', 'Projected'],
                  ...(hasLastWeekRoutes ? [['lastweek', 'Last Week']] : []),
                  ['true', 'True Profit'],
                ].map(([key, lbl]) => (
                  <button
                    key={key}
                    onClick={() => setRouteView(key)}
                    style={{
                      padding: '3px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer',
                      border: 'none',
                      background: routeView === key ? 'var(--accent)' : 'transparent',
                      color: routeView === key ? '#fff' : 'var(--text-muted)',
                    }}
                  >
                    {lbl}
                  </button>
                ))}
              </div>
              {routeView === 'true' && (
                <InfoTip text="Profit after each route also carries its share of the aircraft's weekly lease + maintenance, split by block hours when one aircraft flies several routes. Shows which routes truly pay for their aircraft." />
              )}
              </>)}
            </div>
            {!collapsed.routes && (
              <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                {showLastWeekRoutes ? 'operating profit last week'
                  : routeView === 'true' ? 'incl. aircraft lease + maintenance'
                  : 'sorted by profit'} · Finance → By Route for full list
              </span>
            )}
          </div>
          {!collapsed.routes && (
          <table>
            <thead>
              <tr>
                <th>Route</th>
                <th>Aircraft</th>
                <th>Freq</th>
                <th>Load</th>
                <th>Revenue / wk</th>
                <th>{routeView === 'true' ? 'True profit / wk' : 'Profit / wk'}</th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                // Consolidate by origin→destination pair
                const grouped = {};
                displayedResults.forEach(({ route, result }) => {
                  const key = `${route.origin}→${route.destination}`;
                  if (!grouped[key]) grouped[key] = { route, entries: [] };
                  grouped[key].entries.push({ route, result });
                });
                // Sort by total profit descending, cap at 8
                const allGroups = Object.values(grouped).sort((a, b) => {
                  const pa = a.entries.reduce((s, { result }) => s + (result?.profit ?? 0), 0);
                  const pb = b.entries.reduce((s, { result }) => s + (result?.profit ?? 0), 0);
                  return pb - pa;
                });
                const shown  = allGroups.slice(0, 8);
                const hidden = allGroups.length - shown.length;

                const rows = shown.map(({ route: firstRoute, entries }) => {
                  const totalRevenue = entries.reduce((s, { result }) => s + (result?.revenue ?? 0), 0);
                  const totalProfit  = entries.reduce((s, { result }) => s + (result?.profit ?? 0), 0);
                  const totalFreq    = entries.reduce((s, { route }) => s + route.weeklyFrequency, 0);
                  const totalWeightedLF = entries.reduce((s, { route, result }) => s + (result?.loadFactor ?? 0) * route.weeklyFrequency, 0);
                  const avgLF = totalFreq > 0 ? totalWeightedLF / totalFreq : 0;
                  const hasResult = entries.some(e => e.result);

                  const aircraftNames = [...new Set(
                    entries.map(({ route: r }) => {
                      const ac = fleet.find(a => a.id === r.aircraftId);
                      return ac ? getAircraftType(ac.typeId)?.name : null;
                    }).filter(Boolean)
                  )];
                  const aircraftLabel = aircraftNames.length === 0 ? '—'
                    : aircraftNames.length === 1 && entries.length === 1 ? aircraftNames[0]
                    : aircraftNames.length === 1 ? `${aircraftNames[0]} ×${entries.length}`
                    : `${entries.length} aircraft`;

                  return (
                    <tr key={`${firstRoute.origin}-${firstRoute.destination}`}>
                      <td>
                        <strong><AirportLink code={firstRoute.origin} /> → <AirportLink code={firstRoute.destination} /></strong>
                        <SeasonalityBar route={firstRoute} week={week} />
                      </td>
                      <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>{aircraftLabel}</td>
                      <td>{totalFreq}×</td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ color: avgLF > .7 ? 'var(--green)' : avgLF > .4 ? 'var(--yellow)' : 'var(--red)', fontSize: 12 }}>
                            {formatPercent(avgLF)}
                          </span>
                          <div className="mini-bar" style={{ width: 50, flexShrink: 0 }}>
                            <div className="mini-bar-fill" style={{ width: `${avgLF * 100}%`, background: avgLF > .7 ? 'var(--green)' : avgLF > .4 ? 'var(--yellow)' : 'var(--red)' }} />
                          </div>
                        </div>
                      </td>
                      <td>
                        {hasResult ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ color: 'var(--green)', fontSize: 12, fontWeight: 500 }}>
                              {formatMoney(totalRevenue)}
                            </span>
                            <div className="mini-bar" style={{ width: 40, flexShrink: 0 }}>
                              <div className="mini-bar-fill" style={{ width: `${Math.min(100, (totalRevenue / maxRouteRevenue) * 100)}%`, background: 'var(--accent)' }} />
                            </div>
                          </div>
                        ) : '—'}
                      </td>
                      <td>
                        {hasResult ? (
                          <div>
                            <span style={{ fontWeight: 600, color: totalProfit >= 0 ? 'var(--green)' : 'var(--red)' }}>
                              {totalProfit >= 0 ? '+' : ''}{formatMoney(totalProfit)}
                            </span>
                            <div className="mini-bar" style={{ width: 56, marginTop: 2 }}>
                              <div className="mini-bar-fill" style={{ width: `${Math.min(100, (Math.abs(totalProfit) / maxAbsRouteProfit) * 100)}%`, background: totalProfit >= 0 ? 'var(--green)' : 'var(--red)' }} />
                            </div>
                          </div>
                        ) : '—'}
                      </td>
                    </tr>
                  );
                });

                if (hidden > 0) {
                  rows.push(
                    <tr key="__more__">
                      <td colSpan={6} style={{ textAlign: 'center', padding: '8px 16px', fontSize: 12, color: 'var(--text-dim)', borderTop: '1px solid var(--border)' }}>
                        +{hidden} more route{hidden !== 1 ? 's' : ''} — Finance → By Route for full list
                      </td>
                    </tr>
                  );
                }
                return rows;
              })()}
            </tbody>
          </table>
          )}
        </div>
      )}

      {/* ── Getting started ──────────────────────────────────────────────── */}
      {routes.length === 0 && fleet.length === 0 && (
        <div className="card">
          <div className="card-title">Getting Started</div>
          {remote ? (
            /* Multiplayer (Headwinds): there is no Next Week button — the server
               advances the world clock for everyone on this world's pace. */
            <ol style={{ paddingLeft: 20, lineHeight: 2.2, color: 'var(--text-muted)' }}>
              <li>Go to <strong style={{ color: 'var(--text)' }}>Market</strong> and lease an aircraft.</li>
              <li>Go to <strong style={{ color: 'var(--text)' }}>Routes</strong> and open your first route.</li>
              <li>The world clock <strong style={{ color: 'var(--accent)' }}>advances automatically</strong> — revenue lands every game-week, even while you're away.</li>
              <li>Watch the <strong style={{ color: 'var(--text)' }}>Rivals</strong> tab — every other airline here is a real player.</li>
            </ol>
          ) : (
            <ol style={{ paddingLeft: 20, lineHeight: 2.2, color: 'var(--text-muted)' }}>
              <li>Go to <strong style={{ color: 'var(--text)' }}>Market</strong> and lease an aircraft.</li>
              <li>Go to <strong style={{ color: 'var(--text)' }}>Routes</strong> and open your first route.</li>
              <li>Click <strong style={{ color: 'var(--accent)' }}>Next Week →</strong> to collect revenue.</li>
              <li>Keep expanding — but watch your cash!</li>
            </ol>
          )}
        </div>
      )}

      {selectedEvent && (
        <EventDetailModal event={selectedEvent} onClose={() => setSelectedEvent(null)} />
      )}
    </div>
  );
}

// ── World-event detail modal ──────────────────────────────────────────────────

// ISO country codes → readable names, covering every code used by event templates.
const EVENT_COUNTRY_NAMES = {
  AR: 'Argentina', AT: 'Austria', AU: 'Australia', BE: 'Belgium', BR: 'Brazil',
  CA: 'Canada', CH: 'Switzerland', CL: 'Chile', CN: 'China', CO: 'Colombia',
  DE: 'Germany', DK: 'Denmark', EG: 'Egypt', ES: 'Spain', ET: 'Ethiopia',
  FR: 'France', GB: 'United Kingdom', GR: 'Greece', HK: 'Hong Kong', ID: 'Indonesia',
  IN: 'India', IS: 'Iceland', IT: 'Italy', JP: 'Japan', KE: 'Kenya',
  KR: 'South Korea', MA: 'Morocco', MX: 'Mexico', MY: 'Malaysia', NG: 'Nigeria',
  NL: 'Netherlands', NO: 'Norway', NZ: 'New Zealand', PE: 'Peru', PH: 'Philippines',
  PT: 'Portugal', SE: 'Sweden', SG: 'Singapore', TH: 'Thailand', TR: 'Turkey',
  US: 'United States', ZA: 'South Africa',
};

const EVENT_TYPE_LABELS = {
  fuel: 'Fuel', demand: 'Demand', disruption: 'Disruption',
  competition: 'Competition', economy: 'Economy',
};

// Turn a multiplier into a "+12%" / "−8%" string relative to normal.
function pctDelta(mult) {
  const delta = Math.round((mult - 1) * 100);
  return `${delta >= 0 ? '+' : '−'}${Math.abs(delta)}%`;
}

// Build a plain-language list of an event's mechanical effects.
function describeEventEffects(effects = {}) {
  const rows = [];
  if (effects.fuelMult != null && effects.fuelMult !== 1) {
    const up = effects.fuelMult > 1;
    rows.push({
      label: 'Fuel costs',
      value: pctDelta(effects.fuelMult),
      good: !up,
      note: up ? 'Every route is more expensive to operate.' : 'Cheaper to fly — a good week to add frequency.',
    });
  }
  if (effects.globalDemandMult != null && effects.globalDemandMult !== 1) {
    const up = effects.globalDemandMult > 1;
    rows.push({
      label: 'Demand — all routes',
      value: pctDelta(effects.globalDemandMult),
      good: up,
      note: up ? 'More passengers than normal across your whole network.' : 'Fewer passengers everywhere — watch load factors.',
    });
  }
  if (effects.regionDemandMult != null && effects.regionDemandMult !== 1) {
    const up = effects.regionDemandMult > 1;
    const codes = effects.regionCodes ?? [];
    const names = codes.map(c => EVENT_COUNTRY_NAMES[c] ?? c);
    rows.push({
      label: 'Demand — affected region',
      value: pctDelta(effects.regionDemandMult),
      good: up,
      note: names.length
        ? `Applies to routes touching: ${names.join(', ')}.`
        : 'Applies to the affected region only.',
    });
  }
  if (effects.competitorMult != null && effects.competitorMult !== 1) {
    const up = effects.competitorMult > 1;
    rows.push({
      label: 'Competitor pressure',
      value: `×${effects.competitorMult.toFixed(2)}`,
      good: !up,
      note: up ? 'Rivals are pricing more aggressively — expect share pressure.' : 'Rivals have eased off on pricing.',
    });
  }
  if (effects.satisfactionShock != null && effects.satisfactionShock !== 0) {
    const up = effects.satisfactionShock > 0;
    rows.push({
      label: 'Passenger satisfaction',
      value: `${up ? '+' : '−'}${Math.abs(effects.satisfactionShock)} pts`,
      good: up,
      note: 'One-time change to your satisfaction score.',
    });
  }
  return rows;
}

function EventDetailModal({ event, onClose }) {
  const rows = describeEventEffects(event.effects);
  const total = event.totalDur ?? event.weeksLeft;
  const elapsed = Math.max(0, total - event.weeksLeft);
  const pctElapsed = total > 0 ? Math.min(100, Math.round((elapsed / total) * 100)) : 0;
  const typeLabel = EVENT_TYPE_LABELS[event.type] ?? event.type;

  return (
    <div className="saveload-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="saveload-modal" style={{ width: 'min(460px, 94vw)' }}>
        <div className="saveload-header" style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
            <span style={{
              fontSize: 26, lineHeight: 1, flexShrink: 0,
              filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.3))',
            }}>{event.icon}</span>
            <div style={{ minWidth: 0 }}>
              <h3 className="saveload-title" style={{ color: event.color }}>{event.name}</h3>
              <div style={{
                display: 'inline-block', marginTop: 4, padding: '2px 8px', borderRadius: 20,
                background: `${event.color}18`, border: `1px solid ${event.color}40`,
                fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase',
                color: event.color,
              }}>{typeLabel}</div>
            </div>
          </div>
          <button className="saveload-close btn btn-ghost" onClick={onClose}><CloseIcon size={15} /></button>
        </div>

        <p style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text)', margin: '0 0 18px' }}>
          {event.description}
        </p>

        {/* Duration */}
        <div style={{ marginBottom: rows.length ? 18 : 4 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.3, textTransform: 'uppercase', color: 'var(--text-dim)' }}>Duration</span>
            <span style={{ fontSize: 12, color: 'var(--text)' }}>
              <strong style={{ color: event.color }}>{event.weeksLeft} week{event.weeksLeft !== 1 ? 's' : ''}</strong> remaining
              <span style={{ color: 'var(--text-dim)' }}> · {total}w total</span>
            </span>
          </div>
          <div style={{ height: 6, borderRadius: 3, background: 'var(--surface3)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${pctElapsed}%`, background: event.color, opacity: 0.85 }} />
          </div>
        </div>

        {/* Effects */}
        {rows.length > 0 ? (
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.3, textTransform: 'uppercase', color: 'var(--text-dim)', marginBottom: 8 }}>
              Impact
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {rows.map((r, i) => (
                <div key={i} style={{
                  padding: '10px 12px', borderRadius: 'var(--radius)',
                  background: 'var(--surface2)',
                  borderLeft: `3px solid ${r.good ? 'var(--green)' : 'var(--red)'}`,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>{r.label}</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: r.good ? 'var(--green)' : 'var(--red)', whiteSpace: 'nowrap' }}>{r.value}</span>
                  </div>
                  {r.note && (
                    <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginTop: 3, lineHeight: 1.45 }}>{r.note}</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--text-dim)', fontStyle: 'italic' }}>
            No direct financial impact — this event is informational.
          </div>
        )}
      </div>
    </div>
  );
}

// ── KPI box with trend indicator ──────────────────────────────────────────────

function KpiBox({ label, value, color, trend, trendIsPercent, trendUnit, sub, subColor, onClick }) {
  const clickable = typeof onClick === 'function';
  return (
    <div
      className="stat-box"
      onClick={onClick}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      title={clickable ? 'Open details →' : undefined}
      style={clickable ? { cursor: 'pointer' } : undefined}
    >
      <div className="stat-label">{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <div className={`stat-value ${color}`}>{value}</div>
        {trend != null && (
          <TrendBadge value={trend} isPercent={trendIsPercent} unit={trendUnit} />
        )}
      </div>
      {sub && (
        <div style={{ fontSize: 11, color: subColor ?? 'var(--text-dim)', marginTop: 2 }}>{sub}</div>
      )}
    </div>
  );
}

function TrendBadge({ value, isPercent, unit }) {
  const up    = value >= 0;
  const color = up ? 'var(--green)' : 'var(--red)';
  const mag   = isPercent ? `${Math.abs(value).toFixed(1)}%`
              : unit      ? `${Math.abs(value).toFixed(1)}${unit}`
              :             formatMoney(Math.abs(value));
  return (
    <span style={{ fontSize: 11, color, fontWeight: 600 }}>{`${up ? '↑' : '↓'} ${mag}`}</span>
  );
}

// ── Weekly P&L bridge card ────────────────────────────────────────────────────
// Reconciles per-route operating profit (the Top Routes table) down to the real
// bottom line, side by side for last week (actual) and this week (projected).

function WeeklyPnL({ lastWeek, projected, costBreakdown, collapsed, onToggleCollapse }) {
  const [showFixed, setShowFixed] = useState(false);
  const two = !!lastWeek;

  const FIXED_DETAIL = [
    ['leases',       'Aircraft leases'],
    ['maintenance',  'Maintenance'],
    ['gates',        'Gates & slots'],
    ['labor',        'Staff & labor'],
    ['overhead',     'HQ, insurance & admin'],
    ['marketing',    'Marketing, loyalty & hubs'],
    ['distribution', 'Distribution & partner fees'],
  ];

  const signed = (v, { forceSign = true } = {}) =>
    v == null ? '—' : (v > 0 && forceSign ? '+' : '') + formatMoney(v);

  const rows = [];
  rows.push({
    label: 'Route operating profit',
    tip: 'Sum of every route’s revenue minus its direct flying costs (fuel, crew, service, landing fees) — passenger and cargo. This is the profit shown in the Top Routes table.',
    lw: lastWeek?.routeOp, pj: projected.routeOp,
  });
  if ((lastWeek?.otherRev ?? 0) !== 0 || projected.otherRev !== 0) rows.push({
    label: 'Partner & other revenue',
    tip: 'Alliance and codeshare revenue not tied to a single route.',
    lw: lastWeek?.otherRev, pj: projected.otherRev,
  });
  rows.push({
    label: 'Fixed & overhead costs',
    tip: 'Costs you pay regardless of how full the planes are: aircraft leases, maintenance, gates, staff, HQ, insurance, marketing, loyalty and distribution.',
    lw: lastWeek ? -lastWeek.fixed : null, pj: -projected.fixed,
    expandable: true,
  });
  if (showFixed) {
    for (const [key, label] of FIXED_DETAIL) {
      const lwv = lastWeek?.breakdown?.[key] ?? 0;
      const pjv = projected.breakdown?.[key] ?? 0;
      if (lwv === 0 && pjv === 0) continue;
      rows.push({ label, lw: lastWeek ? -lwv : null, pj: -pjv, detail: true });
    }
  }
  if ((lastWeek?.strike ?? 0) !== 0) rows.push({
    label: 'Strike revenue loss',
    tip: 'Revenue forfeited to flights cancelled by industrial action.',
    lw: -lastWeek.strike, pj: 0,
  });
  rows.push({
    label: 'Operating profit',
    tip: 'Revenue minus ALL operating and fixed costs (EBITDA) — before financing and tax.',
    lw: lastWeek?.operating, pj: projected.operating,
    subtotal: true,
  });
  if ((lastWeek?.loans ?? 0) !== 0 || projected.loans !== 0) rows.push({
    label: 'Loan payments',
    tip: 'Weekly interest + principal on outstanding loans.',
    lw: lastWeek ? -lastWeek.loans : null, pj: -projected.loans,
  });
  if ((lastWeek?.oneOff ?? 0) !== 0 || projected.oneOff !== 0) rows.push({
    label: 'One-time charges',
    tip: 'Lease redelivery and seasonal route reactivation fees.',
    lw: lastWeek ? -lastWeek.oneOff : null, pj: -projected.oneOff,
  });
  if ((lastWeek?.tax ?? 0) !== 0 || projected.tax !== 0) rows.push({
    label: 'Corporate tax',
    tip: '21% of taxable profit.',
    lw: lastWeek ? -lastWeek.tax : null, pj: -projected.tax,
  });
  rows.push({
    label: 'Net profit',
    tip: 'The actual change in your cash balance for the week.',
    lw: lastWeek?.net, pj: projected.net,
    total: true,
  });

  const colStyle = { textAlign: 'right', fontFamily: 'monospace', fontSize: 12, whiteSpace: 'nowrap' };
  const valColor = (v, strong) =>
    v == null ? 'var(--text-dim)'
    : strong ? (v >= 0 ? 'var(--green)' : 'var(--red)')
    : 'var(--text)';

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: collapsed ? 0 : 10 }}>
        <div className="card-title" style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
          {onToggleCollapse && <CollapseChevron collapsed={collapsed} onClick={onToggleCollapse} label="weekly P&L" />}
          Weekly P&amp;L
          <InfoTip text="Why route profit doesn't add up to total profit: routes only carry their direct flying costs. Fixed costs, financing and tax sit below the line — this bridge reconciles the two." />
        </div>
        {!two && !collapsed && <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>last-week actuals appear after your first full week</span>}
      </div>
      {!collapsed && (<>

      <div style={{
        display: 'grid',
        gridTemplateColumns: two ? 'minmax(0,1fr) auto auto' : 'minmax(0,1fr) auto',
        columnGap: 18, rowGap: 0, maxWidth: 560,
      }}>
        {/* Column headers */}
        <span />
        {two && <span style={{ ...colStyle, fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '.06em', paddingBottom: 4 }}>Last Week</span>}
        <span style={{ ...colStyle, fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '.06em', paddingBottom: 4 }}>This Week (proj.)</span>

        {rows.map((r, i) => {
          const strong = r.subtotal || r.total;
          const rowPad = strong ? '6px 0' : r.detail ? '2px 0' : '4px 0';
          const border = strong ? '1px solid var(--border)' : 'none';
          return [
            <span key={`l${i}`} style={{
              padding: rowPad, borderTop: border,
              paddingLeft: r.detail ? 16 : 0,
              fontSize: r.detail ? 11 : 12.5,
              fontWeight: strong ? 700 : r.detail ? 400 : 500,
              color: r.detail ? 'var(--text-dim)' : strong ? 'var(--text)' : 'var(--text-muted)',
              display: 'flex', alignItems: 'center', gap: 5,
            }}>
              {r.expandable ? (
                <button
                  onClick={() => setShowFixed(s => !s)}
                  style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'inherit', font: 'inherit', display: 'flex', alignItems: 'center', gap: 5 }}
                  title={showFixed ? 'Hide breakdown' : 'Show breakdown'}
                >
                  <span style={{ fontSize: 9, width: 10, display: 'inline-block' }}>{showFixed ? '▾' : '▸'}</span>
                  {r.label}
                </button>
              ) : r.label}
              {r.tip && !r.detail && <InfoTip text={r.tip} />}
            </span>,
            ...(two ? [
              <span key={`w${i}`} style={{ ...colStyle, padding: rowPad, borderTop: border, fontWeight: strong ? 700 : 400, fontSize: r.detail ? 11 : strong ? 13 : 12, color: valColor(r.lw, strong) }}>
                {signed(r.lw)}
              </span>,
            ] : []),
            <span key={`p${i}`} style={{ ...colStyle, padding: rowPad, borderTop: border, fontWeight: strong ? 700 : 400, fontSize: r.detail ? 11 : strong ? 13 : 12, color: valColor(r.pj, strong) }}>
              {signed(r.pj)}
            </span>,
          ];
        })}
      </div>

      {/* Cost mix — the full weekly cost stack (variable + fixed), absorbed from
          the old standalone "Weekly Cost Breakdown" card. */}
      {costBreakdown && (
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.06em' }}>
              Cost Mix {costBreakdown.fromReport ? '· last week' : '· projected'}
            </span>
            <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{formatMoney(costBreakdown.total)} total</span>
          </div>
          <CostBreakdownChart breakdown={costBreakdown} />
        </div>
      )}
      </>)}
    </div>
  );
}

// ── Multi-line financial chart (enhanced) ────────────────────────────────────

function FinancialChart({ history, currentWeek }) {
  const [hover, setHover] = useState(null);
  const PAD_L = 58, PAD_R = 12, PAD_T = 10, PAD_B = 22;
  const W = 600, H = 180;
  const dW = W - PAD_L - PAD_R;
  const dH = H - PAD_T - PAD_B;

  const n = history.length;
  if (n < 2) return null;

  // The three series must reconcile so the chart reads profit = revenue − cost.
  // Profit is the true after-tax cash delta, which folds in two things the raw
  // revenue/cost fields exclude: active-event demand swings (added to revenue)
  // and corporate tax (a cost). Fold them back in here so the lines add up.
  const revenues = history.map(h => (h.revenue ?? 0) + (h.eventDemandAdj ?? 0) - (h.strikeLoss ?? 0));
  const costs    = history.map(h => {
    const base = h.totalCost ?? ((h.leases ?? 0) + (h.maintenance ?? 0) + (h.fuel ?? 0) + (h.crew ?? 0) + (h.quality ?? 0) + (h.gates ?? 0));
    return (base ?? 0) + (h.corporateTax ?? 0);
  });
  const profits  = history.map(h => h.profit ?? 0);

  const allVals = [...revenues, ...costs, ...profits];
  const minV = Math.min(0, ...allVals);
  const maxV = Math.max(...allVals);
  const range = maxV - minV || 1;

  const py = v => PAD_T + dH - ((v - minV) / range) * dH;
  const px = i => PAD_L + (i / (n - 1)) * dW;

  const line = (arr, color, dash = '') => {
    const pts = arr.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ');
    return (
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2"
        strokeLinejoin="round" strokeLinecap="round"
        strokeDasharray={dash} opacity=".9" />
    );
  };

  // Area fill under profit curve
  const profitAreaPts =
    profits.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ');
  const profitArea = `M${px(0).toFixed(1)},${py(profits[0]).toFixed(1)} L${profitAreaPts} L${px(n-1).toFixed(1)},${(PAD_T + dH).toFixed(1)} L${px(0).toFixed(1)},${(PAD_T + dH).toFixed(1)} Z`;

  // Y-axis grid lines
  const gridCount = 4;
  const gridLines = Array.from({ length: gridCount + 1 }, (_, i) => {
    const v   = minV + (range * i / gridCount);
    const y   = py(v);
    const abs = Math.abs(v);
    const lbl = abs >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M`
              : abs >= 1_000     ? `${(v / 1_000).toFixed(0)}K`
              :                    `${v.toFixed(0)}`;
    return { y, v, lbl };
  });

  // X-axis labels — up to 6 evenly spaced, showing approx game week
  const startWeek = (currentWeek ?? n) - n + 1;
  const xStep = Math.max(1, Math.ceil(n / 6));
  const xLabels = [];
  for (let i = 0; i < n; i += xStep) {
    xLabels.push({ i, x: px(i), lbl: `W${startWeek + i}` });
  }

  const lastPct = profits[n - 1] > 0 && revenues[n - 1] > 0
    ? `${Math.round((profits[n - 1] / revenues[n - 1]) * 100)}% margin`
    : '';

  const hasEventWeeks = history.some(h => (h.events?.length ?? 0) > 0);

  // Map mouse x → nearest history index (viewBox coordinates).
  const handleMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (!rect.width) return;
    const xPx = ((e.clientX - rect.left) / rect.width) * W;
    setHover(Math.max(0, Math.min(n - 1, Math.round(((xPx - PAD_L) / dW) * (n - 1)))));
  };

  return (
    <div style={{ position: 'relative' }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100%', height: H, display: 'block', cursor: 'crosshair' }}
        onMouseMove={handleMove}
        onMouseLeave={() => setHover(null)}
      >
        {/* Grid lines + y-axis labels */}
        {gridLines.map(({ y, v, lbl }, idx) => (
          <g key={idx}>
            <line
              x1={PAD_L} y1={y.toFixed(1)} x2={W - PAD_R} y2={y.toFixed(1)}
              stroke={v === 0 ? 'var(--border)' : 'var(--border-subtle)'}
              strokeWidth={v === 0 ? 1.2 : 0.7}
              strokeDasharray={v === 0 ? '' : '3 4'}
            />
            <text x={PAD_L - 5} y={(y + 4).toFixed(1)}
              textAnchor="end" fontSize="9" fill="var(--text-dim)"
              fontFamily="monospace">
              {lbl}
            </text>
          </g>
        ))}

        {/* X-axis labels */}
        {xLabels.map(({ x, lbl }) => (
          <text key={lbl} x={x.toFixed(1)} y={H - 6}
            textAnchor="middle" fontSize="9" fill="var(--text-dim)"
            fontFamily="monospace">
            {lbl}
          </text>
        ))}

        {/* Profit area fill */}
        <path d={profitArea} fill="#38d39f" opacity="0.07" />

        {/* Lines */}
        {line(revenues, '#3ea6ff')}
        {line(costs,    '#ff5d6c', '5 3')}
        {line(profits,  '#38d39f')}

        {/* World-event week markers */}
        {history.map((h, i) => (h.events?.length ?? 0) > 0 && (
          <circle key={`ev${i}`} cx={px(i).toFixed(1)} cy={PAD_T + 3} r="2.5"
            fill={h.events[0]?.color ?? 'var(--yellow)'} opacity=".9" />
        ))}

        {/* Hover guide + markers */}
        {hover != null && (
          <g pointerEvents="none">
            <line x1={px(hover).toFixed(1)} x2={px(hover).toFixed(1)} y1={PAD_T} y2={PAD_T + dH}
              stroke="var(--text-dim)" strokeWidth="0.8" strokeDasharray="2 3" />
            <circle cx={px(hover).toFixed(1)} cy={py(revenues[hover]).toFixed(1)} r="3" fill="#3ea6ff" />
            <circle cx={px(hover).toFixed(1)} cy={py(costs[hover]).toFixed(1)}    r="3" fill="#ff5d6c" />
            <circle cx={px(hover).toFixed(1)} cy={py(profits[hover]).toFixed(1)}  r="3" fill="#38d39f" />
          </g>
        )}

        {/* End dots */}
        <circle cx={px(n-1).toFixed(1)} cy={py(revenues[n-1]).toFixed(1)} r="3.5" fill="#3ea6ff" />
        <circle cx={px(n-1).toFixed(1)} cy={py(costs[n-1]).toFixed(1)}    r="3.5" fill="#ff5d6c" />
        <circle cx={px(n-1).toFixed(1)} cy={py(profits[n-1]).toFixed(1)}  r="3.5" fill="#38d39f" />
      </svg>

      {/* Hover tooltip */}
      {hover != null && (() => {
        const h = history[hover];
        const leftPct = (px(hover) / W) * 100;
        const flip = leftPct > 62;
        return (
          <div style={{
            position: 'absolute', top: 2, left: `${leftPct}%`,
            transform: flip ? 'translateX(calc(-100% - 10px))' : 'translateX(10px)',
            background: 'var(--surface2)', border: '1px solid var(--border)',
            borderRadius: 6, padding: '6px 10px', fontSize: 11,
            pointerEvents: 'none', zIndex: 5, whiteSpace: 'nowrap',
            boxShadow: 'var(--shadow-sm)',
          }}>
            <div style={{ fontWeight: 700, marginBottom: 3, color: 'var(--text)' }}>
              {h.label ?? `W${h.week ?? hover + 1}`}
            </div>
            <div style={{ color: '#3ea6ff' }}>Revenue&nbsp; {formatMoney(revenues[hover])}</div>
            <div style={{ color: '#ff5d6c' }}>Costs&nbsp;&nbsp;&nbsp;&nbsp; {formatMoney(costs[hover])}</div>
            <div style={{ color: '#38d39f', fontWeight: 600 }}>Profit&nbsp;&nbsp;&nbsp; {(profits[hover] >= 0 ? '+' : '') + formatMoney(profits[hover])}</div>
            {(h.events?.length ?? 0) > 0 && (
              <div style={{ marginTop: 4, paddingTop: 4, borderTop: '1px solid var(--border)' }}>
                {h.events.map((ev, j) => (
                  <div key={ev.id ?? j} style={{ color: ev.color ?? 'var(--yellow)' }}>
                    {ev.icon ? `${ev.icon} ` : ''}{ev.name}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      <div style={{ display: 'flex', gap: 16, fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
        <span><span style={{ color: '#3ea6ff' }}>—</span> Revenue</span>
        <span><span style={{ color: '#ff5d6c' }}>- -</span> Costs</span>
        <span><span style={{ color: '#38d39f' }}>—</span> Profit</span>
        {hasEventWeeks && <span><span style={{ color: 'var(--yellow)' }}>●</span> world event</span>}
        {lastPct && <span style={{ marginLeft: 'auto', color: 'var(--green)' }}>{lastPct}</span>}
      </div>
    </div>
  );
}

// ── Cost breakdown stacked bar ────────────────────────────────────────────────

function CostBreakdownChart({ breakdown }) {
  const { fuel, crew, leases, maintenance, gates, service, overhead, growth, total, fromReport } = breakdown;
  if (total === 0) return null;

  const segments = [
    { label: 'Fuel',         value: fuel,        color: '#f0883e' },
    { label: 'Crew',         value: crew,        color: '#3ea6ff' },
    { label: 'Leases',       value: leases,      color: '#ff5d6c' },
    { label: 'Maintenance',  value: maintenance, color: '#a98bff' },
    { label: 'Gates & Fees', value: gates,       color: '#d2a679' },
    { label: 'Service',      value: service,     color: '#79c0ff' },
    { label: 'Overhead',     value: overhead,    color: '#93a4ba' },
    { label: 'Growth',       value: growth,      color: '#56d364' },
  ].filter(s => s.value > 0);

  return (
    <div>
      {/* Stacked bar */}
      <div style={{ display: 'flex', height: 22, borderRadius: 4, overflow: 'hidden', marginBottom: 10, gap: 1 }}>
        {segments.map(s => (
          <div
            key={s.label}
            style={{ width: `${(s.value / total) * 100}%`, background: s.color, flexShrink: 0, minWidth: 2 }}
            title={`${s.label}: ${formatMoney(s.value)} (${Math.round((s.value / total) * 100)}%)`}
          />
        ))}
      </div>
      {/* Legend */}
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 11 }}>
        {segments.map(s => (
          <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <div style={{ width: 8, height: 8, borderRadius: 2, background: s.color, flexShrink: 0 }} />
            <span style={{ color: 'var(--text-muted)' }}>{s.label}</span>
            <span style={{ color: 'var(--text-dim)', fontFamily: 'monospace' }}>
              {Math.round((s.value / total) * 100)}%
            </span>
            <span style={{ color: 'var(--text)' }}>{formatMoney(s.value)}</span>
          </div>
        ))}
      </div>
      {!fromReport && (
        <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 6 }}>
          Projected — gates, overhead &amp; growth costs will appear after week 1
        </div>
      )}
    </div>
  );
}

// ── Seasonality mini-chart inline in route table ──────────────────────────────
// Shows a 12-bar sparkline of relative demand per month for this specific route.

function SeasonalityBar({ route, week }) {
  // getSeasonalProfile returns [null, Jan, Feb, ..., Dec] (1-indexed)
  const profile     = getSeasonalProfile(route.origin, route.destination);
  const values      = profile.slice(1);  // [Jan..Dec], length 12
  const currentMonth = weekToGameDate(week).monthIndex - 1; // 0-indexed
  const currentVal  = values[currentMonth] ?? 1;
  const label       = currentVal >= 1.1 ? 'peak' : currentVal <= 0.85 ? 'off-peak' : '';
  return (
    <div style={{ display: 'flex', gap: 1.5, marginTop: 3, height: 14, alignItems: 'flex-end' }}>
      {values.map((v, i) => {
        const isCurrent = i === currentMonth;
        const h = Math.round(v * 10);
        return (
          <div key={i} style={{
            width: 5,
            height: h,
            borderRadius: 1,
            background: isCurrent ? 'var(--accent)' : v >= 1.1 ? 'var(--green)' : v <= 0.85 ? 'var(--red)' : 'var(--surface3)',
            opacity: isCurrent ? 1 : 0.65,
            flexShrink: 0,
          }} />
        );
      })}
      {label && (
        <span style={{ fontSize: 9, color: 'var(--text-dim)', marginLeft: 3, lineHeight: '14px' }}>
          {label}
        </span>
      )}
    </div>
  );
}
