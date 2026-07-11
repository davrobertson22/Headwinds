import { useMemo } from 'react';
import { useGame } from '../store/GameContext.jsx';
import { formatMoney, formatPercent, simulateRoute, currentGameDate, maintenanceMultiplier, weeklyBlockHours, MAX_WEEKLY_BLOCK_HOURS, routeDistanceKm, weekToGameDate, formatGameDate, fleetAvgUtilization } from '../utils/simulation.js';
import { projectWeek } from '../utils/financeProjection.js';
import { getAircraftType } from '../data/aircraft.js';
import { getAirport } from '../data/airports.js';
import AirportLink from './AirportLink.jsx';
import { getSeasonalProfile } from '../models/demand.js';
import BoardObjectives from './BoardObjectives.jsx';
import { AlertIcon, DotIcon, TrendDownIcon, PackageIcon } from './Icons.jsx';

export default function Dashboard() {
  const { state, remote } = useGame();
  const { cash, fleet, routes, cargoRoutes = [], financialHistory, lastReport, week, year, activeEvents = [] } = state;

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

  // ── Route profit normalization (for mini-bars) ─────────────────────────────
  const routeProfitMap = routeResults.reduce((acc, { route, result }) => {
    const key = `${route.origin}→${route.destination}`;
    acc[key] = (acc[key] ?? 0) + (result?.profit ?? 0);
    return acc;
  }, {});
  const maxAbsRouteProfit = Math.max(1, ...Object.values(routeProfitMap).map(p => Math.abs(p)));
  const maxRouteRevenue   = Math.max(1, ...Object.values(
    routeResults.reduce((acc, { route, result }) => {
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
            <div key={ev.id} style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '4px 10px', borderRadius: 20,
              background: `${ev.color}18`, border: `1px solid ${ev.color}40`,
              fontSize: 11, color: ev.color, fontWeight: 600,
            }}>
              <span>{ev.icon}</span>
              {ev.name}
              <span style={{ fontWeight: 400, color: 'var(--text-dim)' }}>{ev.weeksLeft}w</span>
            </div>
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
        />
        <KpiBox
          label="Projected Profit / wk"
          value={(projectedProfit >= 0 ? '+' : '') + formatMoney(projectedProfit)}
          color={projectedProfit >= 0 ? 'green' : 'red'}
          trend={profTrend}
          sub={projectedRevenue > 0 ? `${Math.round((projectedProfit / projectedRevenue) * 100)}% margin` : undefined}
        />
        <KpiBox
          label="Revenue / wk"
          value={formatMoney(projectedRevenue)}
          color="green"
          trend={revTrend != null ? revTrend : undefined}
          trendIsPercent
        />
        {cargoRoutes.length > 0 && (
          <KpiBox
            label="Cargo / wk"
            value={formatMoney(cargoRevenue)}
            color="green"
            sub={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><PackageIcon size={11} /> {Math.round(cargoTonnes).toLocaleString()} t/wk · {cargoRoutes.length} route{cargoRoutes.length !== 1 ? 's' : ''}</span>}
            subColor="var(--text-dim)"
          />
        )}
        <KpiBox
          label="Fleet"
          value={`${fleet.length} aircraft`}
          color="blue"
          sub={idleAircraft > 0 ? `${idleAircraft} idle` : `${routes.length + cargoRoutes.length} routes`}
          subColor={idleAircraft > 0 ? 'var(--yellow)' : 'var(--text-dim)'}
        />
        <KpiBox
          label="Network"
          value={`${airportCodes.length} airports`}
          color="blue"
          sub={`${countries.length} countries`}
        />
        <KpiBox
          label="Date"
          value={formatGameDate({ week, year })}
          valueStyle={{ fontSize: 13 }}
          sub={lastReport ? (lastReport.cashDelta >= 0 ? `+${formatMoney(lastReport.cashDelta)} last wk` : `${formatMoney(lastReport.cashDelta)} last wk`) : 'No data yet'}
          subColor={lastReport ? (lastReport.cashDelta >= 0 ? 'var(--green)' : 'var(--red)') : 'var(--text-dim)'}
        />
      </div>

      {/* ── Board objectives ─────────────────────────────────────────────── */}
      <BoardObjectives />

      {/* ── Cost breakdown ───────────────────────────────────────────────── */}
      {totalWeeklyCosts > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
            <div className="card-title" style={{ marginBottom: 0 }}>Weekly Cost Breakdown</div>
            <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{formatMoney(totalWeeklyCosts)} total</span>
          </div>
          <CostBreakdownChart breakdown={costBreakdown} />
        </div>
      )}

      {/* ── Financial history chart ──────────────────────────────────────── */}
      {hist.length > 1 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-title">Financial History</div>
          <FinancialChart history={hist} currentWeek={week} />
        </div>
      )}

      {/* ── Fleet utilization ────────────────────────────────────────────── */}
      {fleet.length > 0 && (() => {
        const utilData = fleet.map(a => {
          const type = getAircraftType(a.typeId);
          const bh = routes.filter(r => r.aircraftId === a.id).reduce((s, r) =>
            s + (type ? weeklyBlockHours(routeDistanceKm(r.origin, r.destination), r.weeklyFrequency, type) : 0), 0);
          return Math.min(1, bh / MAX_WEEKLY_BLOCK_HOURS);
        });
        const avgPct  = utilData.reduce((s, p) => s + p, 0) / utilData.length;
        const buckets = {
          idle:  utilData.filter(p => p === 0).length,
          low:   utilData.filter(p => p > 0 && p < 0.5).length,
          good:  utilData.filter(p => p >= 0.5 && p < 0.9).length,
          full:  utilData.filter(p => p >= 0.9).length,
        };
        const avgColor = avgPct >= 0.75 ? 'var(--green)' : avgPct >= 0.4 ? 'var(--yellow)' : 'var(--red)';
        return (
          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10 }}>
              <div className="card-title" style={{ marginBottom: 0 }}>Fleet Utilisation</div>
              <span style={{ fontSize: 13, fontWeight: 700, color: avgColor }}>{Math.round(avgPct * 100)}% avg</span>
            </div>
            {/* Aggregate bar */}
            <div style={{ height: 10, background: 'var(--surface3)', borderRadius: 5, overflow: 'hidden', marginBottom: 10 }}>
              <div style={{ height: '100%', width: `${avgPct * 100}%`, background: avgColor, borderRadius: 5, transition: 'width 0.3s' }} />
            </div>
            {/* Bucket summary */}
            <div style={{ display: 'flex', gap: 20, fontSize: 12 }}>
              {[
                { label: 'Idle',    count: buckets.idle,  color: 'var(--text-dim)' },
                { label: '< 50%',   count: buckets.low,   color: 'var(--yellow)'   },
                { label: '50–90%',  count: buckets.good,  color: 'var(--green)'    },
                { label: 'Full',    count: buckets.full,  color: 'var(--red)'      },
              ].map(b => b.count > 0 && (
                <div key={b.label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <div style={{ width: 8, height: 8, borderRadius: 2, background: b.color, flexShrink: 0 }} />
                  <span style={{ color: 'var(--text-muted)' }}>{b.label}</span>
                  <span style={{ fontWeight: 700, color: b.color }}>{b.count}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {/* ── Route performance ────────────────────────────────────────────── */}
      {routes.length > 0 && (
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
            <div className="card-title" style={{ marginBottom: 0 }}>Top Routes (Projected)</div>
            <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>sorted by profit · Finance → By Route for full list</span>
          </div>
          <table>
            <thead>
              <tr>
                <th>Route</th>
                <th>Aircraft</th>
                <th>Freq</th>
                <th>Load</th>
                <th>Revenue / wk</th>
                <th>Profit / wk</th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                // Consolidate by origin→destination pair
                const grouped = {};
                routeResults.forEach(({ route, result }) => {
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
    </div>
  );
}

// ── KPI box with trend indicator ──────────────────────────────────────────────

function KpiBox({ label, value, color, trend, trendIsPercent, sub, subColor }) {
  return (
    <div className="stat-box">
      <div className="stat-label">{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <div className={`stat-value ${color}`}>{value}</div>
        {trend != null && (
          <TrendBadge value={trend} isPercent={trendIsPercent} />
        )}
      </div>
      {sub && (
        <div style={{ fontSize: 11, color: subColor ?? 'var(--text-dim)', marginTop: 2 }}>{sub}</div>
      )}
    </div>
  );
}

function TrendBadge({ value, isPercent }) {
  const up    = value >= 0;
  const color = up ? 'var(--green)' : 'var(--red)';
  const label = isPercent
    ? `${up ? '↑' : '↓'} ${Math.abs(value).toFixed(1)}%`
    : `${up ? '↑' : '↓'} ${formatMoney(Math.abs(value))}`;
  return (
    <span style={{ fontSize: 11, color, fontWeight: 600 }}>{label}</span>
  );
}

// ── Multi-line financial chart (enhanced) ────────────────────────────────────

function FinancialChart({ history, currentWeek }) {
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

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: H, display: 'block' }}>
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

        {/* End dots */}
        <circle cx={px(n-1).toFixed(1)} cy={py(revenues[n-1]).toFixed(1)} r="3.5" fill="#3ea6ff" />
        <circle cx={px(n-1).toFixed(1)} cy={py(costs[n-1]).toFixed(1)}    r="3.5" fill="#ff5d6c" />
        <circle cx={px(n-1).toFixed(1)} cy={py(profits[n-1]).toFixed(1)}  r="3.5" fill="#38d39f" />
      </svg>
      <div style={{ display: 'flex', gap: 16, fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
        <span><span style={{ color: '#3ea6ff' }}>—</span> Revenue</span>
        <span><span style={{ color: '#ff5d6c' }}>- -</span> Costs</span>
        <span><span style={{ color: '#38d39f' }}>—</span> Profit</span>
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
