import { useState, useMemo, Fragment, Component } from 'react';
import { useGame } from '../store/GameContext.jsx';
import {
  formatMoney, formatPercent,
  simulateRoute, maintenanceMultiplier, blockTimeHours,
  CLASS_FARE_MULTIPLIERS,
  weeklyBlockHours, routeDistanceKm, weekToGameDate, fleetAvgUtilization,
  buildEventDemandModel,
} from '../utils/simulation.js';
import { getAircraftType } from '../data/aircraft.js';
import { getAirport, gateMonthlyFee, totalGateMonthlyFee } from '../data/airports.js';
import { getSeasonalProfile } from '../models/demand.js';
import { LABOR_GROUPS, DEFAULT_LABOR_STATE, laborEffects } from '../data/labor.js';
import { FAMILY_INFO, AIRCRAFT_FAMILY, activeFamilies as getActiveFamilies,
         fleetComplexityMultiplier, COMPLEXITY_AFFECTED_GROUPS } from '../data/families.js';
import {
  fuelIndexStatus, fuelIndexDelta, absoluteWeek,
  HEDGE_DURATIONS, HEDGE_COVERAGES,
  effectiveFuelMultiplier, totalHedgedCoverage,
  FUEL_MIN_INDEX, FUEL_MAX_INDEX,
} from '../utils/fuel.js';
import {
  hqBracket,
  awarenessDemandMultiplier,
  weeklyCateringCost, weeklyLayoverCost, weeklyPassengerCompensation,
  GROUND_HANDLING_COST_PER_PAX,
  DISTRIBUTION_COST_PCT,
  HULL_INSURANCE_ANNUAL_RATE, LIABILITY_INSURANCE_WEEKLY_PER_AIRCRAFT, liabilityInsuranceWeekly,
  DEPRECIATION_YEARS,
} from '../data/overhead.js';
import { projectWeek } from '../utils/financeProjection.js';
import { CATERING_LEVELS, normalizeCateringLevel } from '../data/catering.js';
import { Glyph, GlyphLabel } from './Icons.jsx';

// ─── Error Boundary ───────────────────────────────────────────────────────────
class FinanceErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 32, color: 'var(--fg-muted)', fontFamily: 'monospace' }}>
          <div style={{ fontSize: 18, color: 'var(--red)', marginBottom: 12 }}><Glyph e="⚠" /> Finance page error</div>
          <pre style={{ background: 'var(--bg-card)', padding: 16, borderRadius: 8, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {this.state.error?.message ?? String(this.state.error)}
            {'\n\n'}
            {this.state.error?.stack}
          </pre>
          <button
            style={{ marginTop: 16, padding: '8px 16px', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}
            onClick={() => this.setState({ error: null })}
          >Retry</button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────
const STARTING_CAPITAL = 15_000_000;
const CLASS_LABELS = { firstClass: 'First', businessClass: 'Business', premiumEconomy: 'Prem-Eco', economy: 'Economy' };
const CLASS_COLORS = { firstClass: '#bc8cff', businessClass: '#ffb43d', premiumEconomy: '#3ea6ff', economy: '#38d39f' };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function currentGameDate(state) {
  // Must match the reducer's weekly tick (weekToGameDate) so detail re-simulations
  // use the SAME seasonality month as the canonical projection / actual result.
  // (Previously this used Math.ceil(week*12/52), which disagrees with the engine for
  // many weeks because game months are 4–5 weeks long, not an even 52/12.)
  const month = weekToGameDate(state.week).monthIndex;
  return { week: state.week, month };
}

function aircraftBookValue(aircraft, type) {
  if (aircraft?.ownershipType !== 'owned' || !type?.purchasePrice) return 0;
  const ageYears = (aircraft.ageWeeks ?? 0) / 52;
  const remaining = Math.max(0, 1 - ageYears / DEPRECIATION_YEARS);
  return Math.round(type.purchasePrice * remaining);
}

function ytd(history, key) {
  return history.reduce((s, h) => s + (h[key] ?? 0), 0);
}

/** Blended fare per seat = ticketPrice × weighted cabin multiplier */
function blendedFareMultiplier(config, type) {
  const total = type?.seats ?? 1;
  return (
    ((config?.firstClass     ?? 0) / total) * CLASS_FARE_MULTIPLIERS.firstClass     +
    ((config?.businessClass  ?? 0) / total) * CLASS_FARE_MULTIPLIERS.businessClass  +
    ((config?.premiumEconomy ?? 0) / total) * CLASS_FARE_MULTIPLIERS.premiumEconomy +
    ((config?.economy        ?? total) / total) * CLASS_FARE_MULTIPLIERS.economy
  );
}

/**
 * Unit economics for one route.
 * Returns ASK, RPK, RASK, CASKop, CASKfull, yield, break-even LF.
 * `allRoutes` is the full route array (needed to allocate fleet costs proportionally).
 */
function calcUnitEconomics(route, aircraft, type, result, fleet, routes) {
  const dist  = result.distance;
  const ASK   = type.seats * route.weeklyFrequency * 2 * dist;
  const RPK   = result.passengers * 2 * dist;  // passengers is one-way; ×2 to match ASK (both directions)
  const RASK  = ASK > 0 ? result.revenue    / ASK : 0;
  const CASKop= ASK > 0 ? result.totalOpCost / ASK : 0;

  // Allocate lease + maintenance pro-rata by block-hours on this aircraft
  const lease  = aircraft.ownershipType === 'owned' ? 0 : (type?.weeklyLease ?? 0);
  const maint  = Math.round((type?.baseMaintenancePerWk ?? 0) * maintenanceMultiplier(aircraft.ageWeeks));
  const totalFleetCost = lease + maint;

  const allAircraftRoutes = routes.filter(r => r.aircraftId === aircraft.id);
  const totalBH = allAircraftRoutes.reduce((s, r) => {
    const d = routeDistanceKm(r.origin, r.destination);
    return s + (type ? weeklyBlockHours(d, r.weeklyFrequency, type) : 0);
  }, 0);
  const routeBH = type ? weeklyBlockHours(dist, route.weeklyFrequency, type) : 0;
  const fleetShare = totalBH > 0 ? routeBH / totalBH : 1;
  const allocatedFleet = totalFleetCost * fleetShare;

  const CASKfull = ASK > 0 ? (result.totalOpCost + allocatedFleet) / ASK : 0;
  const yieldVal = RPK > 0 ? result.revenue / RPK : 0;

  // Break-even: what load factor covers all costs at current fare mix?
  const bfm = blendedFareMultiplier(aircraft.config, type);
  const fullRevenue = type.seats * route.weeklyFrequency * 2 * route.ticketPrice * bfm;
  const breakEvenLF = fullRevenue > 0
    ? (result.totalOpCost + allocatedFleet) / fullRevenue
    : 0;

  return { ASK, RPK, RASK, CASKop, CASKfull, yield: yieldVal, breakEvenLF, allocatedFleet };
}

/** Future month (1-12) from an absolute week offset from game start */
function futureMonth(currentAbsWeek, offsetWeeks) {
  const absWeek    = currentAbsWeek + offsetWeeks;
  const weekInYear = ((absWeek - 1) % 52) + 1;
  return weekToGameDate(weekInYear).monthIndex;
}

// ─── Main component ───────────────────────────────────────────────────────────

function FinanceInner() {
  const [view, setView] = useState('pl');
  const { state } = useGame();
  // Compute the canonical weekly projection ONCE and share it across tabs (runs a
  // full engine tick incl. network/connection enumeration, so we don't want each
  // tab recomputing it on every render / tab switch).
  const proj = useMemo(() => projectWeek(state), [state]);

  const VIEWS = [
    { id: 'pl',        label: '📋 P&L'           },
    { id: 'cashflow',  label: '💵 Cash Flow'      },
    { id: 'uniteco',   label: '📐 Unit Economics' },
    { id: 'forecast',  label: '🔭 Forecast'       },
    { id: 'trends',    label: '📈 Trends'         },
    { id: 'stats',     label: '📊 Statistics'     },
    { id: 'bs',        label: '⚖️ Balance Sheet'  },
    { id: 'loans',     label: '🏦 Loans'          },
    { id: 'fuel',      label: '⛽ Fuel'           },
    { id: 'routes',    label: '🗺️ By Route'       },
    { id: 'airports',  label: '🏢 By Airport'     },
  ];

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 20, flexWrap: 'wrap' }}>
        {VIEWS.map(v => (
          <button
            key={v.id}
            className={`btn ${view === v.id ? 'btn-primary' : 'btn-ghost'}`}
            style={{ fontSize: 13 }}
            onClick={() => setView(v.id)}
          >
            <GlyphLabel text={v.label} size={13} />
          </button>
        ))}
      </div>

      {view === 'pl'       && <PLStatement proj={proj} />}
      {view === 'cashflow' && <CashFlow proj={proj} />}
      {view === 'uniteco'  && <UnitEconomics proj={proj} />}
      {view === 'forecast' && <Forecast proj={proj} />}
      {view === 'trends'   && <Trends />}
      {view === 'stats'    && <Statistics />}
      {view === 'bs'       && <BalanceSheet />}
      {view === 'loans'    && <Loans proj={proj} />}
      {view === 'fuel'     && <FuelHedging />}
      {view === 'routes'   && <RouteBreakdown proj={proj} />}
      {view === 'airports' && <AirportBreakdown proj={proj} />}
    </div>
  );
}

export default function Finance() {
  return (
    <FinanceErrorBoundary>
      <FinanceInner />
    </FinanceErrorBoundary>
  );
}

// ─── Profit Waterfall ─────────────────────────────────────────────────────────
// Decomposes the week from revenue down to the actual cash change, so the player
// can see exactly which cost bucket is driving the outcome. Every figure comes
// from the canonical projection, so it ties out to the P&L bottom line.
function ProfitWaterfall({ proj, report }) {
  const r = report;
  const steps = [
    { label: 'Revenue (booked)', value: proj.effectiveRevenue, kind: 'start' },
    { label: 'Fuel & oil',                value: -(r.totalFuel), kind: 'neg' },
    { label: 'Flight ops (crew, landing, quality)', value: -((r.totalCrew) + (r.totalLandingFees) + (r.totalQuality)), kind: 'neg' },
    { label: 'Passenger services',        value: -((r.totalCatering) + (r.totalGroundHandling) + (r.totalLounge) + (r.totalLayover) + (r.totalCompensation)), kind: 'neg' },
    { label: 'Aircraft & fleet',          value: -((r.totalLeases) + (r.totalMaintenance) + (r.totalInsurance)), kind: 'neg' },
    { label: 'People & labour',           value: -((r.totalLaborCosts) + (r.totalFamilyBaseCosts)), kind: 'neg' },
    { label: 'Commercial (mktg + distrib)', value: -((r.totalMarketingSpend) + (r.totalDistributionCost)), kind: 'neg' },
    { label: 'G&A, gates & partners',     value: -((r.totalHQCost) + (r.totalHubInvestment) + (r.totalGateFees) + (r.totalLoyaltyCost) + (r.totalPartnerFees)), kind: 'neg' },
    { label: 'EBITDA',                    value: proj.ebitda, kind: 'subtotal' },
    { label: 'Interest',                  value: -(proj.interest), kind: 'neg' },
    { label: 'Corporate tax',             value: -(proj.corporateTax), kind: 'neg' },
    { label: 'Loan principal',            value: -(proj.principal), kind: 'neg' },
    { label: 'Δ Cash this week',          value: proj.netCash, kind: 'end' },
  ].filter(s => s.kind === 'start' || s.kind === 'subtotal' || s.kind === 'end' || Math.abs(s.value) >= 1);

  // Scale: largest absolute running value or step.
  let running = 0;
  const rows = steps.map(s => {
    if (s.kind === 'start' || s.kind === 'subtotal' || s.kind === 'end') {
      running = (s.kind === 'start') ? s.value : (s.kind === 'subtotal' ? proj.ebitda : proj.netCash);
      return { ...s, from: 0, to: running, total: true };
    }
    const from = running;
    running += s.value;
    return { ...s, from, to: running, total: false };
  });
  const maxAbs = Math.max(1, ...rows.flatMap(r => [Math.abs(r.from), Math.abs(r.to)]));

  const BarFor = ({ row }) => {
    const lo = Math.min(row.from, row.to), hi = Math.max(row.from, row.to);
    // Map [-maxAbs, maxAbs] → [0,100]%. Zero at the 50% midline.
    const pct = v => 50 + (v / maxAbs) * 50;
    const a = pct(lo), b = pct(hi);
    const color = row.total
      ? (row.to >= 0 ? 'var(--green)' : 'var(--red)')
      : (row.value >= 0 ? 'var(--green)' : 'var(--red)');
    return (
      <div style={{ position: 'relative', height: 14, background: 'rgba(255,255,255,.03)', borderRadius: 3 }}>
        <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: 'var(--border)' }} />
        <div style={{ position: 'absolute', left: `${a}%`, width: `${Math.max(0.6, b - a)}%`, top: 2, bottom: 2, background: color, borderRadius: 2, opacity: row.total ? 0.95 : 0.8 }} />
      </div>
    );
  };

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="card-title">Profit Waterfall — revenue to weekly cash</div>
      <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr 110px', gap: '4px 12px', alignItems: 'center', fontSize: 12 }}>
        {rows.map((row, i) => (
          <Fragment key={i}>
            <div style={{ color: row.total ? 'var(--text)' : 'var(--text-muted)', fontWeight: row.total ? 700 : 400 }}>{row.label}</div>
            <BarFor row={row} />
            <div style={{ textAlign: 'right', fontWeight: row.total ? 700 : 500,
              color: row.total ? ((row.to >= 0) ? 'var(--green)' : 'var(--red)') : (row.value >= 0 ? 'var(--green)' : 'var(--red)') }}>
              {row.total
                ? `${row.to >= 0 ? '' : ''}${formatMoney(row.to)}`
                : `${row.value >= 0 ? '+' : ''}${formatMoney(row.value)}`}
            </div>
          </Fragment>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 10, fontSize: 11, color: 'var(--text-muted)' }}>
        <span style={{ color: 'var(--text-dim)' }}>Revenue drivers:</span>
        <span>Awareness <strong>{(report.awarenessMultiplier ?? 1).toFixed(2)}×</strong></span>
        {(report.totalTargetedSpend ?? 0) > 0 && (
          <span>Campaign lift <strong>{formatMoney((report.routeResults ?? []).reduce((s, r) => s + (r.marketingLift ?? 0), 0))}</strong></span>
        )}
        <span>Loyalty <strong>{(report.loyaltyMultiplier ?? 1).toFixed(2)}×</strong></span>
        {proj.globalDemandMult !== 1 && <span>Events <strong>{proj.globalDemandMult.toFixed(2)}×</strong></span>}
        {(report.totalConnecting ?? 0) > 0 && <span>Connecting feed <strong>{formatMoney(report.totalConnecting)}</strong></span>}
        {(report.totalPartnerRevenue ?? 0) > 0 && <span>Partner O&amp;D <strong>{formatMoney(report.totalPartnerRevenue)}</strong></span>}
        {(report.totalCateringRevenue ?? 0) > 0 && <span>Catering ancillary <strong>{formatMoney(report.totalCateringRevenue)}</strong></span>}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 8 }}>
        Bars show the running balance; green/red = step adds/subtracts. Depreciation is non-cash and excluded from the cash result.
      </div>
    </div>
  );
}

// ─── P&L Statement ────────────────────────────────────────────────────────────

function PLStatement({ proj }) {
  const { state } = useGame();
  const fleet = state.fleet ?? [];
  const routes = state.routes ?? [];
  const financialHistory = state.financialHistory ?? [];
  const [expanded, setExpanded] = useState({});   // per-route row expansion
  const [sections, setSections] = useState(() => ({
    revenue:   (routes?.length ?? 0) <= 15,   // auto-collapse at scale
    direct:    true,
    fleet:     (fleet?.length ?? 0) <= 15,
    airports:  true,
    labor:     true,
    family:    true,
    hq:        true,
    insurance: (fleet?.length ?? 0) <= 10,
    marketing: true,
  }));
  const toggleSection = key => setSections(s => ({ ...s, [key]: !s[key] }));
  const gd = currentGameDate(state);

  const toggleRow = id => setExpanded(e => ({ ...e, [id]: !e[id] }));

  // ── Single source of truth ──────────────────────────────────────────────────
  // All headline totals come from the canonical engine projection (passed down
  // from FinanceInner) so the P&L agrees with Cash Flow, Forecast, Unit Economics
  // — and with what advancing the week actually produces.
  const report = proj.report;

  // Labor state and maintenance adjustments
  const labor             = state.labor ?? DEFAULT_LABOR_STATE;
  const maintenanceBudget = state.maintenanceBudget ?? 1.0;
  const { maintenanceCostMultiplier } = laborEffects(labor);

  // Route projections — simulate WITH the same labor + fuel multiplier the engine
  // used, so per-route operating-cost detail rows reconcile to the report totals.
  // Per-route REVENUE for display uses the engine's boosted figure (proj.revById),
  // which includes connecting feed + awareness/marketing/loyalty/alliance lifts.
  const avgUtilization = fleetAvgUtilization(fleet, [...routes, ...(state.cargoRoutes ?? [])]);
  const routeData = useMemo(() => {
    const evDemand = buildEventDemandModel(state.activeEvents);
    return routes.map(route => {
    const aircraft = fleet.find(a => a.id === route.aircraftId);
    if (!aircraft) return null;
    const result = simulateRoute(route, aircraft, gd, labor, proj.fuelMultiplier, null, [], avgUtilization, state.satisfaction ?? null,
      evDemand.multFor(route.origin, route.destination));
    if (!result) return null;
    const bookedRevenue = proj.revById[route.id] ?? result.revenue;
    return { route, aircraft, result, bookedRevenue };
  }).filter(Boolean); }, [routes, fleet, state.week, proj]);  // eslint-disable-line

  // Canonical cost buckets (from the engine report, not re-derived)
  const totFuel = report.totalFuel;
  const totCrew = report.totalCrew;
  const totQual = report.totalQuality;

  // Per-aircraft detail rows (totals come from the engine report below).
  const fleetData = fleet.map(a => {
    const type    = getAircraftType(a.typeId);
    const isOwned = a.ownershipType === 'owned';
    const lease   = isOwned ? 0 : (a.weeklyLease ?? type?.weeklyLease ?? 0);
    // Match what weeklyTick actually charges: budget × morale multiplier × per-tail mod
    const maint   = Math.round((type?.baseMaintenancePerWk ?? 0)
      * maintenanceMultiplier(a.ageWeeks) * maintenanceBudget * maintenanceCostMultiplier * (a.maintMod ?? 1.0));
    return { aircraft: a, type, lease, maint, isOwned };
  });
  // Canonical fleet costs from the engine.
  const totLeases = report.totalLeases;
  const totMaint  = report.totalMaintenance;
  const totFleet  = totLeases + totMaint;

  // Gate detail rows use the same bulk pricing / weekly proration the engine uses.
  const gatesData = Object.entries(state.gates ?? {}).map(([code, count]) => {
    const airport   = getAirport(code);
    const weeklyFee = airport ? Math.round(totalGateMonthlyFee(airport, count) / 4) : 0;
    return { code, airport, count, weeklyFee };
  });
  const totGates = report.totalGateFees;

  // Labor overhead + family MRO (canonical totals; per-group detail kept for display)
  const totalLaborWeekly = report.totalLaborCosts;
  const totalFamilyCosts = report.totalFamilyBaseCosts;
  const familySet   = getActiveFamilies(fleet);
  const familyCount = {};
  for (const a of fleet) {
    const fam = AIRCRAFT_FAMILY[a.typeId];
    if (fam) familyCount[fam] = (familyCount[fam] ?? 0) + 1;
  }

  // ── All cost lines (canonical from engine report) ───────────────────────────

  const activeLoans      = state.loans ?? [];
  const totInterestExpense    = proj.interest;
  const totPrincipalRepayment = proj.principal;

  const totLandingFees = report.totalLandingFees;
  const ytdLandingFees = ytd(financialHistory, 'landingFees');

  // HQ
  const totHQCost = report.totalHQCost;
  const hqInfo    = hqBracket(fleet.length);
  const ytdHQCost = ytd(financialHistory, 'hqCost');

  // Hub investment
  const hubs = state.hubs ?? {};
  const totHubInvestment = report.totalHubInvestment;

  // Insurance — total from engine; breakdown uses the REAL rates (0.8% p.a. hull,
  // $18k/wk liability) so the sub-lines reconcile to the total.
  const totInsurance  = report.totalInsurance;
  const totHullIns    = fleet.filter(a => a.ownershipType === 'owned').reduce((s, a) => {
    const t = getAircraftType(a.typeId);
    const ageYrs = (a.ageWeeks ?? 0) / 52;
    const bv = (t?.purchasePrice ?? 0) * Math.max(0.1, 1 - ageYrs / DEPRECIATION_YEARS);
    return s + Math.round(bv * HULL_INSURANCE_ANNUAL_RATE / 52);
  }, 0);
  const totLiabilityIns = fleet.reduce((s, a) => s + liabilityInsuranceWeekly(getAircraftType(a.typeId)), 0);
  const ytdInsurance  = ytd(financialHistory, 'insurance');

  // Marketing
  const marketingBudgetVal = report.totalMarketingSpend;
  const ytdMarketing  = ytd(financialHistory, 'marketing');

  // Revenue — canonical, including connecting feed + partner O&D + all demand lifts.
  const totRev          = proj.effectiveRevenue;
  const totPartnerRev   = report.totalPartnerRevenue ?? 0;
  // Cargo (freight) revenue — already inside totRev; broken out as its own line.
  const totCargoRev     = report.totalCargoRevenue ?? 0;
  const totCargoTonnes  = report.totalCargoTonnes ?? 0;
  const cargoResults    = report.cargoRouteResults ?? [];
  const ytdCargoRev     = ytd(financialHistory, 'cargoRevenue');
  const cargoRoutesState = state.cargoRoutes ?? [];

  // Catering / layover / compensation — canonical totals; per-route detail for display.
  const { onTimeRate } = laborEffects(labor, avgUtilization, state.satisfaction ?? null);
  const cateringByRoute = routeData.map(({ route, aircraft, result }) => {
    const type = getAircraftType(aircraft.typeId);
    const catering     = result.cateringCost     ?? weeklyCateringCost(result.classSummary ?? {});
    const cateringRev  = result.cateringRevenue   ?? 0;
    const cateringLevel = normalizeCateringLevel(route.cateringLevel);
    const dist         = result.distance ?? routeDistanceKm(route.origin, route.destination);
    const blockHrs     = type ? blockTimeHours(dist, type) : 0;
    const layover      = result.layoverCost      ?? weeklyLayoverCost(blockHrs, type?.seats ?? 150, type?.category ?? 'Narrow Body', route.weeklyFrequency);
    const compensation = result.compensationCost ?? weeklyPassengerCompensation(result.passengers * 2, onTimeRate, dist);
    return { route, aircraft, type, catering, cateringRev, cateringLevel, layover, compensation, dist, blockHrs };
  });
  const totCatering     = report.totalCatering;
  const totCateringRev  = report.totalCateringRevenue ?? 0;
  const ytdCateringRev  = ytd(financialHistory, 'cateringRevenue');
  const totLayover      = report.totalLayover;
  const totCompensation = report.totalCompensation;
  const ytdCatering     = ytd(financialHistory, 'catering');
  const ytdLayover      = ytd(financialHistory, 'layover');
  const ytdCompensation = ytd(financialHistory, 'compensation');

  const totGroundHandling = report.totalGroundHandling;
  const ytdGroundHandling = ytd(financialHistory, 'groundHandling');

  // Distribution: GDS fees, OTA commissions, credit-card processing
  const totDistribution = report.totalDistributionCost;
  const ytdDistribution = ytd(financialHistory, 'distribution');

  // Depreciation (non-cash, owned aircraft only)
  const totDepreciation = proj.depreciation;

  // ── Grouping for display ───────────────────────────────────────────────────
  const totFlightOps  = totCrew + totLandingFees + totQual;
  const totPassengerServices = totCatering + totGroundHandling;
  const totOtherCosts = totLayover + totCompensation;
  const totAircraftCosts = totFleet + totInsurance;
  const totPeopleLabor = totalLaborWeekly + totalFamilyCosts;
  const totGA = totHQCost + totHubInvestment;

  // Total opex == engine totalCost (so EBITDA reconciles exactly to the engine).
  const totOpex = report.totalCost;
  const ebitda  = proj.ebitda;        // effective revenue − totalCost
  const ebit    = proj.ebit;          // ebitda − depreciation
  const margin  = totRev > 0 ? ebit / totRev : 0;
  const corporateTax = proj.corporateTax;       // tax base matches the engine (EBT)
  const ytdCorporateTax = ytd(financialHistory, 'corporateTax');
  // Bottom line = the actual weekly cash change (matches the `profit` stored in
  // history): EBITDA − loan payments − tax. Depreciation is non-cash and shown
  // as a memo, NOT deducted (the engine never deducts it from cash).
  const netIncome = proj.netCash;
  const netIncomeAccrual = proj.netIncomeAccrual;

  // ── YTD ───────────────────────────────────────────────────────────────────
  const ytdRev    = ytd(financialHistory, 'revenue');
  const ytdFuel   = ytd(financialHistory, 'fuel');
  const ytdCrew   = ytd(financialHistory, 'crew');
  const ytdQual   = ytd(financialHistory, 'quality');
  const ytdLease  = ytd(financialHistory, 'leases');
  const ytdMaint  = ytd(financialHistory, 'maintenance');
  const ytdLabor  = ytd(financialHistory, 'labor');
  const ytdFamily = ytd(financialHistory, 'familyCosts');
  const ytdNet    = ytd(financialHistory, 'profit');
  const ytdWeeks  = financialHistory.length;

  // ── Weekly comparison data ────────────────────────────────────────────────
  // Build EBITDA from raw history fields (mirrors projected calc)
  const histEbitda = h =>
    (h.revenue ?? 0)
    - (h.fuel ?? 0) - (h.crew ?? 0) - (h.quality ?? 0) - (h.landingFees ?? 0)
    - (h.catering ?? 0) - (h.groundHandling ?? 0) - (h.layover ?? 0) - (h.compensation ?? 0)
    - (h.leases ?? 0) - (h.maintenance ?? 0) - (h.familyCosts ?? 0)
    - (h.insurance ?? 0) - (h.labor ?? 0) - (h.gates ?? 0)
    - (h.marketing ?? 0) - (h.distribution ?? 0) - (h.hqCost ?? 0) - (h.hubInvestment ?? 0);

  const recentWeeks = financialHistory.slice(-3);   // up to 3 actual weeks

  // Delta helper: value vs reference, formatted with colour
  const Delta = ({ val, base }) => {
    if (base == null) return null;
    const diff = val - base;
    if (Math.abs(diff) < 1) return null;
    const pct = base !== 0 ? Math.abs(diff / base) : 0;
    const up = diff > 0;
    return (
      <span style={{ fontSize: 10, marginLeft: 4, color: up ? 'var(--green)' : 'var(--red)' }}>
        {up ? '▲' : '▼'}{formatPercent(pct)}
      </span>
    );
  };

  // Number of data columns = history weeks shown + projected
  const compCols = recentWeeks.length + 1;

  return (
    <div>
      {/* KPIs */}
      <div className="stat-grid" style={{ marginBottom: 20 }}>
        <StatBox label="Revenue / wk"    value={formatMoney(totRev)}   color="green" />
        <StatBox label="EBITDA / wk"     value={(ebitda >= 0 ? '+' : '') + formatMoney(ebitda)} color={ebitda >= 0 ? 'green' : 'red'} />
        <StatBox label="EBIT / wk"       value={(ebit >= 0 ? '+' : '') + formatMoney(ebit)}   color={ebit >= 0 ? 'green' : 'red'} />
        <StatBox label="EBIT Margin"     value={formatPercent(margin)} color={margin >= 0 ? 'green' : 'red'} />
        {ytdWeeks > 0 && <StatBox label={`YTD Net (${ytdWeeks}wk)`} value={(ytdNet >= 0 ? '+' : '') + formatMoney(ytdNet)} color={ytdNet >= 0 ? 'green' : 'red'} />}
      </div>

      {/* ── Profit Waterfall — what drives this week's cash result ── */}
      <ProfitWaterfall proj={proj} report={report} />

      {/* ── Weekly P&L Comparison ── */}
      {recentWeeks.length > 0 && (() => {
        const rows = [
          {
            label: 'Revenue',
            vals: recentWeeks.map(h => h.revenue ?? 0),
            proj: totRev,
            color: 'var(--green)',
            sign: '+',
          },
          {
            label: 'Fuel & Oil',
            vals: recentWeeks.map(h => h.fuel ?? 0),
            proj: totFuel,
            color: 'var(--red)',
            sign: '-',
            cost: true,
          },
          {
            label: 'Flight Ops',
            vals: recentWeeks.map(h => (h.crew ?? 0) + (h.landingFees ?? 0) + (h.quality ?? 0)),
            proj: totFlightOps,
            color: 'var(--red)',
            sign: '-',
            cost: true,
          },
          {
            label: 'Pax Services',
            vals: recentWeeks.map(h => (h.catering ?? 0) + (h.groundHandling ?? 0) + (h.layover ?? 0) + (h.compensation ?? 0)),
            proj: totPassengerServices + totOtherCosts,
            color: 'var(--red)',
            sign: '-',
            cost: true,
          },
          {
            label: 'Fleet & Aircraft',
            vals: recentWeeks.map(h => (h.leases ?? 0) + (h.maintenance ?? 0) + (h.insurance ?? 0)),
            proj: totAircraftCosts,
            color: 'var(--red)',
            sign: '-',
            cost: true,
          },
          {
            label: 'Gates',
            vals: recentWeeks.map(h => h.gates ?? 0),
            proj: totGates,
            color: 'var(--red)',
            sign: '-',
            cost: true,
            hide: totGates === 0 && recentWeeks.every(h => !(h.gates ?? 0)),
          },
          {
            label: 'People & Labour',
            vals: recentWeeks.map(h => (h.labor ?? 0) + (h.familyCosts ?? 0)),
            proj: totPeopleLabor,
            color: 'var(--red)',
            sign: '-',
            cost: true,
          },
          {
            label: 'Commercial',
            vals: recentWeeks.map(h => (h.hqCost ?? 0) + (h.hubInvestment ?? 0) + (h.marketing ?? 0) + (h.distribution ?? 0)),
            proj: totGA + marketingBudgetVal + totDistribution,
            color: 'var(--red)',
            sign: '-',
            cost: true,
          },
          {
            label: 'EBITDA',
            vals: recentWeeks.map(h => histEbitda(h)),
            proj: ebitda,
            color: null, // dynamic
            sign: '',
            bold: true,
            separator: true,
          },
          {
            label: 'Corporate Tax (21%)',
            vals: recentWeeks.map(h => h.corporateTax ?? 0),
            proj: corporateTax,
            color: 'var(--red)',
            sign: '-',
            cost: true,
          },
          {
            label: 'Net Cash Δ',
            vals: recentWeeks.map(h => h.profit ?? 0),
            proj: netIncome,
            color: null,
            sign: '',
            bold: true,
          },
        ].filter(r => !r.hide);

        return (
          <div className="card" style={{ marginBottom: 20, padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '10px 16px 8px', borderBottom: '1px solid var(--border)', fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '.5px', textTransform: 'uppercase' }}>
              Weekly P&amp;L — Last {recentWeeks.length} Week{recentWeeks.length !== 1 ? 's' : ''} vs Projected
            </div>
            <table style={{ fontSize: 12 }}>
              <colgroup>
                <col style={{ width: '28%' }} />
                {recentWeeks.map((_, i) => <col key={i} style={{ width: `${60 / compCols}%` }} />)}
                <col style={{ width: `${60 / compCols}%` }} />
              </colgroup>
              <thead>
                <tr>
                  <th style={{ fontSize: 11 }}></th>
                  {recentWeeks.map(h => (
                    <th key={h.week} style={{ textAlign: 'right', fontSize: 11, color: 'var(--text-dim)', fontWeight: 600 }}>
                      Wk {h.week}
                    </th>
                  ))}
                  <th style={{ textAlign: 'right', fontSize: 11, color: 'var(--accent)', fontWeight: 700 }}>Projected</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, ri) => {
                  const lastHistVal = row.vals[row.vals.length - 1] ?? null;
                  return (
                    <tr key={ri} style={row.separator ? { borderTop: '2px solid var(--border)' } : {}}>
                      <td style={{ paddingLeft: row.bold ? 12 : 20, fontWeight: row.bold ? 700 : 400, color: row.bold ? 'var(--text)' : 'var(--text-muted)', fontSize: row.bold ? 12 : 11 }}>
                        {row.label}
                      </td>
                      {row.vals.map((v, i) => {
                        const dynColor = row.color ?? (v >= 0 ? 'var(--green)' : 'var(--red)');
                        return (
                          <td key={i} style={{ textAlign: 'right', color: dynColor, fontWeight: row.bold ? 600 : 400 }}>
                            {row.sign}{formatMoney(Math.abs(v))}
                          </td>
                        );
                      })}
                      {/* Projected column */}
                      {(() => {
                        const v = row.proj;
                        const dynColor = row.color ?? (v >= 0 ? 'var(--green)' : 'var(--red)');
                        return (
                          <td style={{ textAlign: 'right', color: dynColor, fontWeight: row.bold ? 700 : 500 }}>
                            {row.sign}{formatMoney(Math.abs(v))}
                            {lastHistVal != null && (
                              <Delta val={row.cost ? -v : v} base={row.cost ? -lastHistVal : lastHistVal} />
                            )}
                          </td>
                        );
                      })()}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })()}

      {/* P&L table */}
      {(() => {
        const pw = financialHistory.length > 0 ? financialHistory[financialHistory.length - 1] : null;
        const pwFlightOps = pw ? (pw.crew ?? 0) + (pw.landingFees ?? 0) + (pw.quality ?? 0) : null;
        const pwPaxServices = pw ? (pw.catering ?? 0) + (pw.groundHandling ?? 0) : null;
        const pwOtherCosts = pw ? (pw.layover ?? 0) + (pw.compensation ?? 0) : null;
        const pwAircraftCosts = pw ? (pw.leases ?? 0) + (pw.maintenance ?? 0) + (pw.insurance ?? 0) : null;
        const pwPeopleLabor = pw ? (pw.labor ?? 0) + (pw.familyCosts ?? 0) : null;
        const pwOpex = pw
          ? (pw.fuel ?? 0) + (pwFlightOps) + (pwPaxServices) + (pwOtherCosts)
            + (pwAircraftCosts) + (pw.gates ?? 0) + (pwPeopleLabor)
            + (pw.marketing ?? 0) + (pw.distribution ?? 0) + (pw.hqCost ?? 0)
          : null;
        const pwEbitda = pw ? (pw.revenue ?? 0) - pwOpex : null;
        const pwEbit   = pw && totDepreciation > 0 ? pwEbitda - totDepreciation : pwEbitda;
        const priorLabel = pw ? `Wk ${pw.week}` : null;
        return (
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <table>
              <colgroup>
                <col style={{ width: '44%' }} />
                {pw && <col style={{ width: '14%' }} />}
                <col style={{ width: pw ? '20%' : '24%' }} />
                <col style={{ width: pw ? '22%' : '24%' }} />
              </colgroup>
              <thead>
                <tr>
                  <th>Line Item</th>
                  {pw && <th style={{ textAlign: 'right', color: 'var(--text-dim)', fontWeight: 500 }}>{priorLabel}</th>}
                  <th style={{ textAlign: 'right' }}>Projected / wk</th>
                  <th style={{ textAlign: 'right' }}>YTD Total</th>
                </tr>
              </thead>
          <tbody>

            {/* ══ OPERATING REVENUE ══ */}
            <PLCategoryHeader label="Operating Revenue" />
            <CollapsibleSection
              label="Traffic Revenue"
              count={routeData.length + cargoResults.length}
              colSpan={pw ? 4 : 3}
              expanded={sections.revenue}
              onToggle={() => toggleSection('revenue')}
              summary={<TotalRow label="Traffic Revenue (collapsed)" prior={pw ? pw.revenue : undefined} weekly={totRev} ytd={ytdRev} positive />}
            >
              {routeData.length === 0 && cargoResults.length === 0
                ? <EmptyRow text="No active routes" colSpan={pw ? 4 : 3} />
                : (() => {
                    const pairGroups = {};
                    routeData.forEach(d => {
                      const key = `${d.route.origin}→${d.route.destination}`;
                      if (!pairGroups[key]) pairGroups[key] = { key, origin: d.route.origin, destination: d.route.destination, entries: [] };
                      pairGroups[key].entries.push(d);
                    });
                    return Object.values(pairGroups).map(({ key, origin, destination, entries }) => {
                      // Booked revenue per route (incl. connecting feed + demand lifts) from the engine
                      const groupRev  = entries.reduce((s, e) => s + (e.bookedRevenue ?? e.result.revenue), 0);
                      const groupPax  = entries.reduce((s, e) => s + e.result.passengers, 0);
                      const totalFreq = entries.reduce((s, e) => s + e.route.weeklyFrequency, 0);
                      // Prior week per-route revenue (stored in routeRevenues map since fix)
                      const pwGroupRev = pw?.routeRevenues
                        ? entries.reduce((s, e) => s + (pw.routeRevenues[e.route.id] ?? 0), 0)
                        : null;
                      const isExp = expanded[key];
                      const multi = entries.length > 1;
                      return (
                        <Fragment key={key}>
                          <tr style={{ cursor: 'pointer' }} onClick={() => toggleRow(key)}>
                            <td style={{ paddingLeft: 28 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <span style={{ fontSize: 10, color: 'var(--text-dim)', width: 10 }}>{isExp ? '▾' : '▸'}</span>
                                <span style={{ fontWeight: 500 }}>{origin} → {destination}</span>
                                <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                                  {multi ? `${entries.length} aircraft` : getAircraftType(entries[0].aircraft.typeId)?.name}
                                  {' · '}{totalFreq}×/wk
                                </span>
                              </div>
                              <div style={{ fontSize: 11, color: 'var(--text-muted)', paddingLeft: 18, marginTop: 1 }}>
                                {getAirport(origin)?.city} → {getAirport(destination)?.city}
                                {' · '}{groupPax.toLocaleString()} pax total
                              </div>
                            </td>
                            {pw && (
                              <td style={{ textAlign: 'right', color: 'var(--green)', fontSize: 12 }}>
                                {pwGroupRev != null && pwGroupRev > 0 ? `+${formatMoney(pwGroupRev)}` : '—'}
                              </td>
                            )}
                            <td style={{ textAlign: 'right', color: 'var(--green)', fontWeight: 500 }}>+{formatMoney(groupRev)}</td>
                            <td style={{ textAlign: 'right', color: 'var(--text-muted)', fontSize: 12 }}>—</td>
                          </tr>
                          {isExp && entries.map(({ route, aircraft, result, bookedRevenue }) => {
                            const type = getAircraftType(aircraft.typeId);
                            const projRouteRev = bookedRevenue ?? result.revenue;
                            // Scale per-class revenue so the class rows sum to the booked route revenue.
                            const boost = result.revenue > 0 ? projRouteRev / result.revenue : 1;
                            return (
                              <Fragment key={route.id}>
                                {multi && (
                                  <tr style={{ background: 'rgba(0,0,0,.1)' }}>
                                    <td colSpan={pw ? 4 : 3} style={{ paddingLeft: 48, fontSize: 11, color: 'var(--text-dim)', fontWeight: 600 }}>
                                      {aircraft.name} ({type?.name}) — {route.weeklyFrequency}×/wk · {result.passengers.toLocaleString()} pax · {formatPercent(result.loadFactor)} load
                                      <span style={{ float: 'right', color: 'var(--green)', marginRight: 8 }}>+{formatMoney(projRouteRev)}</span>
                                    </td>
                                  </tr>
                                )}
                                {Object.entries(result.classSummary ?? {}).map(([cls, data]) => {
                                  if (!data?.passengers) return null;
                                  const fare = route.classPrices?.[cls] ?? route.ticketPrice;
                                  return (
                                    <tr key={`${route.id}-${cls}`} style={{ background: 'rgba(0,0,0,.15)' }}>
                                      <td style={{ paddingLeft: multi ? 64 : 56, fontSize: 12, color: 'var(--text-muted)' }}>
                                        <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: CLASS_COLORS[cls], marginRight: 6 }} />
                                        {CLASS_LABELS[cls]}: {data.passengers.toLocaleString()} pax × {formatMoney(fare)}
                                        <span style={{ marginLeft: 8, color: 'var(--text-dim)' }}>({formatPercent(data.loadFactor)} load)</span>
                                      </td>
                                      {pw && <td style={{ textAlign: 'right', color: 'var(--text-dim)', fontSize: 11 }}>—</td>}
                                      <td style={{ textAlign: 'right', fontSize: 12, color: 'var(--green)' }}>+{formatMoney(Math.round(data.revenue * boost))}</td>
                                      <td />
                                    </tr>
                                  );
                                })}
                              </Fragment>
                            );
                          })}
                        </Fragment>
                      );
                    });
                  })()
              }
              {totPartnerRev > 0 && (
                <tr>
                  <td style={{ paddingLeft: 28, color: 'var(--text-muted)', fontSize: 13 }}>
                    Codeshare &amp; alliance partner revenue
                    <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-dim)' }}>O&amp;D mileage-prorated share of partner itineraries</span>
                  </td>
                  {pw && <td style={{ textAlign: 'right', color: 'var(--green)', fontSize: 12 }}>{pw.partnerRevenue ? '+' + formatMoney(pw.partnerRevenue) : '—'}</td>}
                  <td style={{ textAlign: 'right', color: 'var(--green)', fontWeight: 500 }}>+{formatMoney(totPartnerRev)}</td>
                  <td style={{ textAlign: 'right', color: 'var(--text-muted)', fontSize: 12 }}>—</td>
                </tr>
              )}
              {totCargoRev > 0 && (
                <Fragment>
                  <tr>
                    <td style={{ paddingLeft: 28, color: 'var(--text-muted)', fontSize: 13 }}>
                      <Glyph e="📦" /> Cargo revenue <span style={{ color: '#e8833a', fontWeight: 600 }}>(freight)</span>
                      <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-dim)' }}>
                        {cargoResults.length} freighter route{cargoResults.length !== 1 ? 's' : ''} · {totCargoTonnes.toLocaleString()} t/wk
                      </span>
                    </td>
                    {pw && <td style={{ textAlign: 'right', color: 'var(--green)', fontSize: 12 }}>{pw.cargoRevenue ? '+' + formatMoney(pw.cargoRevenue) : '—'}</td>}
                    <td style={{ textAlign: 'right', color: 'var(--green)', fontWeight: 500 }}>+{formatMoney(totCargoRev)}</td>
                    <td style={{ textAlign: 'right', color: 'var(--text-muted)', fontSize: 12 }}>{ytdCargoRev ? formatMoney(ytdCargoRev) : '—'}</td>
                  </tr>
                  {cargoResults.map(cr => {
                    const route = cargoRoutesState.find(r => r.id === cr.routeId);
                    if (!route) return null;
                    return (
                      <tr key={cr.routeId} style={{ background: 'rgba(0,0,0,.15)' }}>
                        <td style={{ paddingLeft: 56, fontSize: 12, color: 'var(--text-muted)' }}>
                          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: '#e8833a', marginRight: 6 }} />
                          {route.origin} → {route.destination}: {cr.tonnes.toLocaleString()} t × ${route.yieldPrice.toFixed(3)}/t-km
                          <span style={{ marginLeft: 8, color: 'var(--text-dim)' }}>({formatPercent(cr.loadFactor)} load)</span>
                        </td>
                        {pw && <td style={{ textAlign: 'right', color: 'var(--text-dim)', fontSize: 11 }}>—</td>}
                        <td style={{ textAlign: 'right', fontSize: 12, color: 'var(--green)' }}>+{formatMoney(cr.revenue)}</td>
                        <td />
                      </tr>
                    );
                  })}
                </Fragment>
              )}
              {totCateringRev > 0 && (
                <tr>
                  <td style={{ paddingLeft: 28, color: 'var(--text-dim)', fontSize: 12, fontStyle: 'italic' }}>
                    of which catering ancillary
                    <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-dim)' }}>buy-on-board &amp; upgrades (already in passenger revenue above)</span>
                  </td>
                  {pw && <td style={{ textAlign: 'right', color: 'var(--text-dim)', fontSize: 12 }}>{pw.cateringRevenue ? formatMoney(pw.cateringRevenue) : '—'}</td>}
                  <td style={{ textAlign: 'right', color: 'var(--text-dim)', fontSize: 12 }}>{formatMoney(totCateringRev)}</td>
                  <td style={{ textAlign: 'right', color: 'var(--text-dim)', fontSize: 12 }}>{ytdCateringRev ? formatMoney(ytdCateringRev) : '—'}</td>
                </tr>
              )}
              {Math.abs(proj.eventDemandAdj) >= 1 && (
                <tr>
                  <td style={{ paddingLeft: 28, color: 'var(--text-muted)', fontSize: 13 }}>
                    Active-event demand adjustment
                    <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-dim)' }}>{proj.globalDemandMult > 1 ? '+' : ''}{formatPercent(proj.globalDemandMult - 1)} from current events</span>
                  </td>
                  {pw && <td />}
                  <td style={{ textAlign: 'right', color: proj.eventDemandAdj >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 500 }}>{proj.eventDemandAdj >= 0 ? '+' : ''}{formatMoney(proj.eventDemandAdj)}</td>
                  <td style={{ textAlign: 'right', color: 'var(--text-muted)', fontSize: 12 }}>—</td>
                </tr>
              )}
              <TotalRow label="Total Revenue" prior={pw ? pw.revenue : undefined} weekly={totRev} ytd={ytdRev} positive />
            </CollapsibleSection>

            {/* ══ OPERATING EXPENSES ══ */}
            <PLCategoryHeader label="Operating Expenses" />

            {/* A. Fuel & Oil */}
            <tr>
              <td style={{ paddingLeft: 16, fontSize: 13, color: 'var(--text-muted)' }}>
                Fuel &amp; Oil
                <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-dim)' }}>
                  {routeData.length} route{routeData.length !== 1 ? 's' : ''} · {formatMoney(Math.round(totFuel / Math.max(routeData.length,1)))}/route avg
                </span>
              </td>
              {pw && <td style={{ textAlign: 'right', color: 'var(--red)', fontSize: 12 }}>{formatMoney(-(pw.fuel ?? 0))}</td>}
              <td style={{ textAlign: 'right', color: 'var(--red)', fontSize: 13, fontWeight: 500 }}>{formatMoney(-totFuel)}</td>
              <td style={{ textAlign: 'right', color: 'var(--text-dim)', fontSize: 12 }}>{ytdFuel > 0 ? formatMoney(-ytdFuel) : '—'}</td>
            </tr>

            {/* B. Flight Operations */}
            <CollapsibleSection
              label="Flight Operations"
              colSpan={pw ? 4 : 3}
              expanded={sections.flightOps ?? true}
              onToggle={() => toggleSection('flightOps')}
              summary={<TotalRow label="Flight Operations (collapsed)" prior={pw ? -pwFlightOps : undefined} weekly={-totFlightOps} ytd={-(ytdCrew + ytdLandingFees + ytdQual)} />}
            >
              <LineItem label="Flight crew — variable duty pay"     prior={pw ? -(pw.crew ?? 0) : undefined}         weekly={-totCrew}        ytd={-ytdCrew} />
              <LineItem label="Landing &amp; navigation charges"    prior={pw ? -(pw.landingFees ?? 0) : undefined}  weekly={-totLandingFees} ytd={-ytdLandingFees} />
              {totQual > 0 && <LineItem label="In-flight service upgrades (quality extras)" prior={pw ? -(pw.quality ?? 0) : undefined} weekly={-totQual} ytd={-ytdQual} />}
              <TotalRow label="Total Flight Operations" prior={pw ? -pwFlightOps : undefined} weekly={-totFlightOps} ytd={-(ytdCrew + ytdLandingFees + ytdQual)} />
            </CollapsibleSection>

            {/* C. Passenger Services — catering + ground handling */}
            {totPassengerServices > 0 && (
              <CollapsibleSection
                label="Passenger Services"
                colSpan={pw ? 4 : 3}
                expanded={sections.passengerServices ?? true}
                onToggle={() => toggleSection('passengerServices')}
                summary={<TotalRow label="Passenger Services (collapsed)" prior={pw ? -((pw.catering ?? 0) + (pw.groundHandling ?? 0)) : undefined} weekly={-totPassengerServices} ytd={-(ytdCatering + ytdGroundHandling)} />}
              >
                {(totCatering > 0 || totCateringRev > 0) && (
                  <>
                    <SubSectionHeader label="Catering" />
                    {cateringByRoute
                      .filter(r => r.catering > 0 || r.cateringRev > 0)
                      .sort((a, b) => (b.catering - b.cateringRev) - (a.catering - a.cateringRev))
                      .map(({ route, type, catering, cateringRev, cateringLevel }) => (
                        <tr key={`cat-${route.id}`}>
                          <td style={{ paddingLeft: 40, color: 'var(--text-muted)', fontSize: 12 }}>
                            {route.origin}–{route.destination}
                            <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--text-dim)' }}>
                              {type?.name ?? ''} · {CATERING_LEVELS[cateringLevel]?.short ?? cateringLevel}
                              {cateringRev > 0 && <span style={{ color: 'var(--green)' }}> · +{formatMoney(cateringRev)} ancillary</span>}
                            </span>
                          </td>
                          {pw && <td />}
                          <td style={{ textAlign: 'right', color: 'var(--red)', fontSize: 12 }}>{formatMoney(-catering)}</td>
                          <td />
                        </tr>
                      ))}
                    <LineItem label="  Total catering cost" prior={pw ? -(pw.catering ?? 0) : undefined} weekly={-totCatering} ytd={-ytdCatering} />
                  </>
                )}
                {totGroundHandling > 0 && (
                  <>
                    <SubSectionHeader label="Ground Handling" />
                    {Object.entries(GROUND_HANDLING_COST_PER_PAX).map(([cls, rate]) => {
                      const totalPax = routeData.reduce((s, { result }) => s + (result.classSummary?.[cls]?.passengers ?? 0), 0);
                      if (totalPax === 0) return null;
                      const clsLabel = { economy: 'Economy', premiumEconomy: 'Premium Economy', businessClass: 'Business', firstClass: 'First' }[cls];
                      return (
                        <tr key={`gh-${cls}`}>
                          <td style={{ paddingLeft: 40, color: 'var(--text-muted)', fontSize: 12 }}>
                            {clsLabel}
                            <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--text-dim)' }}>
                              {totalPax.toLocaleString()} pax/wk × ${rate}/pax — ramp, baggage, boarding
                            </span>
                          </td>
                          {pw && <td />}
                          <td style={{ textAlign: 'right', color: 'var(--red)', fontSize: 12 }}>{formatMoney(-totalPax * rate)}</td>
                          <td />
                        </tr>
                      );
                    })}
                    <LineItem label="  Total ground handling" prior={pw ? -(pw.groundHandling ?? 0) : undefined} weekly={-totGroundHandling} ytd={-ytdGroundHandling} />
                  </>
                )}
                <TotalRow label="Total Passenger Services" prior={pw ? -((pw.catering ?? 0) + (pw.groundHandling ?? 0)) : undefined} weekly={-totPassengerServices} ytd={-(ytdCatering + ytdGroundHandling)} />
              </CollapsibleSection>
            )}

            {/* D. Other Operating Costs — layover + compensation */}
            {totOtherCosts > 0 && (
              <CollapsibleSection
                label="Other Operating Costs"
                colSpan={pw ? 4 : 3}
                expanded={sections.otherCosts ?? true}
                onToggle={() => toggleSection('otherCosts')}
                summary={<TotalRow label="Other Operating Costs (collapsed)" prior={pw ? -pwOtherCosts : undefined} weekly={-totOtherCosts} ytd={-(ytdLayover + ytdCompensation)} />}
              >
                {totLayover > 0 && (
                  <>
                    <SubSectionHeader label="Crew Accommodation" />
                    {cateringByRoute.filter(r => r.layover > 0).map(({ route, type, layover, blockHrs }) => (
                      <tr key={route.id}>
                        <td style={{ paddingLeft: 40, color: 'var(--text-muted)', fontSize: 12 }}>
                          {route.origin} → {route.destination}
                          <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--text-dim)' }}>
                            {blockHrs.toFixed(1)}h block time · overnight layover required
                          </span>
                        </td>
                        {pw && <td />}
                        <td style={{ textAlign: 'right', color: 'var(--red)', fontSize: 12 }}>{formatMoney(-layover)}</td>
                        <td />
                      </tr>
                    ))}
                    <LineItem label="  Total crew accommodation" prior={pw ? -(pw.layover ?? 0) : undefined} weekly={-totLayover} ytd={-ytdLayover} />
                  </>
                )}
                {totCompensation > 0 && (
                  <>
                    <SubSectionHeader label="Passenger Compensation" />
                    <tr>
                      <td style={{ paddingLeft: 40, color: 'var(--text-muted)', fontSize: 12 }}>
                        Delay &amp; cancellation payouts
                        <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--text-dim)' }}>
                          OTP {(onTimeRate * 100).toFixed(0)}% · {((1 - onTimeRate) * 100).toFixed(1)}% delay rate · 10% escalate to compensation
                        </span>
                      </td>
                      {pw && <td style={{ textAlign: 'right', color: 'var(--red)', fontSize: 12 }}>{formatMoney(-(pw.compensation ?? 0))}</td>}
                      <td style={{ textAlign: 'right', color: 'var(--red)', fontSize: 12 }}>{formatMoney(-totCompensation)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--text-dim)', fontSize: 12 }}>{ytdCompensation > 0 ? formatMoney(-ytdCompensation) : '—'}</td>
                    </tr>
                    <LineItem label="  Total passenger compensation" prior={pw ? -(pw.compensation ?? 0) : undefined} weekly={-totCompensation} ytd={-ytdCompensation} />
                  </>
                )}
                <TotalRow label="Total Other Operating Costs" prior={pw ? -pwOtherCosts : undefined} weekly={-totOtherCosts} ytd={-(ytdLayover + ytdCompensation)} />
              </CollapsibleSection>
            )}

            {/* E. Aircraft & Fleet */}
            <CollapsibleSection
              label="Aircraft &amp; Fleet"
              count={fleet.length}
              colSpan={pw ? 4 : 3}
              expanded={sections.aircraft ?? fleet.length <= 12}
              onToggle={() => toggleSection('aircraft')}
              summary={<TotalRow label="Aircraft &amp; Fleet (collapsed)" prior={pw ? -pwAircraftCosts : undefined} weekly={-totAircraftCosts} ytd={-(ytdLease + ytdMaint + ytdInsurance)} />}
            >
              {totLeases > 0 && (
                <>
                  <SubSectionHeader label="Operating Leases" />
                  {fleetData.filter(f => !f.isOwned).map(({ aircraft, type, lease }) => (
                    <tr key={aircraft.id}>
                      <td style={{ paddingLeft: 40, color: 'var(--text-muted)', fontSize: 12 }}>
                        {aircraft.name}
                        <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--text-dim)' }}>{type?.name}</span>
                      </td>
                      {pw && <td />}
                      <td style={{ textAlign: 'right', color: 'var(--red)', fontSize: 12 }}>{formatMoney(-lease)}</td>
                      <td />
                    </tr>
                  ))}
                  <LineItem label="  Total operating leases" prior={pw ? -(pw.leases ?? 0) : undefined} weekly={-totLeases} ytd={-ytdLease} />
                </>
              )}
              <SubSectionHeader label="Maintenance" />
              {fleetData.map(({ aircraft, type, maint }) => (
                <tr key={aircraft.id}>
                  <td style={{ paddingLeft: 40, color: 'var(--text-muted)', fontSize: 12 }}>
                    {aircraft.name}
                    <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--text-dim)' }}>
                      {type?.name} · {((aircraft.ageWeeks ?? 0) / 52).toFixed(1)} yr old
                    </span>
                  </td>
                  {pw && <td />}
                  <td style={{ textAlign: 'right', color: 'var(--red)', fontSize: 12 }}>{formatMoney(-maint)}</td>
                  <td />
                </tr>
              ))}
              <LineItem label="  Total maintenance" prior={pw ? -(pw.maintenance ?? 0) : undefined} weekly={-totMaint} ytd={-ytdMaint} />
              {totInsurance > 0 && (
                <>
                  <SubSectionHeader label="Insurance" />
                  {totHullIns > 0 && (
                    <tr>
                      <td style={{ paddingLeft: 40, color: 'var(--text-muted)', fontSize: 12 }}>
                        Hull insurance
                        <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--text-dim)' }}>
                          {fleet.filter(a => a.ownershipType === 'owned').length} owned aircraft · {(HULL_INSURANCE_ANNUAL_RATE * 100).toFixed(1)}% p.a. of book value
                        </span>
                      </td>
                      {pw && <td />}
                      <td style={{ textAlign: 'right', color: 'var(--red)', fontSize: 12 }}>{formatMoney(-totHullIns)}</td>
                      <td />
                    </tr>
                  )}
                  <tr>
                    <td style={{ paddingLeft: 40, color: 'var(--text-muted)', fontSize: 12 }}>
                      Liability insurance
                      <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--text-dim)' }}>
                        {fleet.length} aircraft · rate by type ($6K–$24K/wk)
                      </span>
                    </td>
                    {pw && <td />}
                    <td style={{ textAlign: 'right', color: 'var(--red)', fontSize: 12 }}>{formatMoney(-totLiabilityIns)}</td>
                    <td />
                  </tr>
                  <LineItem label="  Total insurance" prior={pw ? -(pw.insurance ?? 0) : undefined} weekly={-totInsurance} ytd={-ytdInsurance} />
                </>
              )}
              <TotalRow label="Total Aircraft &amp; Fleet" prior={pw ? -pwAircraftCosts : undefined} weekly={-totAircraftCosts} ytd={-(ytdLease + ytdMaint + ytdInsurance)} />
            </CollapsibleSection>

            {/* D. Airports & Ground Handling */}
            {totGates > 0 && (
              <CollapsibleSection
                label="Airports &amp; Ground Handling"
                count={gatesData.length}
                colSpan={pw ? 4 : 3}
                expanded={sections.airports}
                onToggle={() => toggleSection('airports')}
                summary={<TotalRow label="Airports &amp; Ground (collapsed)" prior={pw ? -(pw.gates ?? 0) : undefined} weekly={-totGates} ytd={null} />}
              >
                {gatesData.map(g => (
                  <tr key={g.code}>
                    <td style={{ paddingLeft: 28, color: 'var(--text-muted)', fontSize: 13 }}>
                      {g.code} — {g.airport?.city} · {g.count} gate{g.count !== 1 ? 's' : ''}
                      <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-dim)' }}>{formatMoney(gateMonthlyFee(g.airport) * g.count)}/mo</span>
                    </td>
                    {pw && <td />}
                    <td style={{ textAlign: 'right', color: 'var(--red)', fontSize: 13 }}>{formatMoney(-g.weeklyFee)}</td>
                    <td />
                  </tr>
                ))}
                <TotalRow label="Total Airport Costs" prior={pw ? -(pw.gates ?? 0) : undefined} weekly={-totGates} ytd={null} />
              </CollapsibleSection>
            )}

            {/* E. People & Labor */}
            {totPeopleLabor > 0 && (
              <CollapsibleSection
                label="People &amp; Labour"
                colSpan={pw ? 4 : 3}
                expanded={sections.labor}
                onToggle={() => toggleSection('labor')}
                summary={<TotalRow label="People &amp; Labour (collapsed)" prior={pw ? -pwPeopleLabor : undefined} weekly={-totPeopleLabor} ytd={-(ytdLabor + ytdFamily)} />}
              >
                <SubSectionHeader label="Labor Overhead (fixed per aircraft)" />
                {LABOR_GROUPS.map(g => {
                  const gs       = labor[g.id] ?? { payMultiplier: 1.0, morale: 80 };
                  const complexityMult = fleetComplexityMultiplier(fleet);
                  const famMult  = COMPLEXITY_AFFECTED_GROUPS.includes(g.id) ? complexityMult : 1.0;
                  const cost = fleet.length > 0 ? Math.round(g.baseWeeklyPerAircraft * gs.payMultiplier * fleet.length * famMult) : 0;
                  return (
                    <tr key={g.id}>
                      <td style={{ paddingLeft: 40, color: 'var(--text-muted)', fontSize: 12 }}>
                        {g.emoji} {g.name}
                        <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--text-dim)' }}>
                          {gs.payMultiplier.toFixed(2)}× · morale {Math.round(gs.morale)}%
                          {famMult > 1.0 && (
                            <span style={{ color: 'var(--yellow)' }}> · +{Math.round((famMult - 1) * 100)}% fleet complexity</span>
                          )}
                        </span>
                      </td>
                      {pw && <td />}
                      <td style={{ textAlign: 'right', color: 'var(--red)', fontSize: 12 }}>{formatMoney(-cost)}</td>
                      <td />
                    </tr>
                  );
                })}
                <LineItem label="  Total labor overhead" prior={pw ? -(pw.labor ?? 0) : undefined} weekly={-totalLaborWeekly} ytd={-ytdLabor} />
                {totalFamilyCosts > 0 && (
                  <>
                    <SubSectionHeader label="Fleet Family MRO Base" />
                    <tr>
                      <td style={{ paddingLeft: 40, color: 'var(--text-muted)', fontSize: 12 }}>
                        Type-rating infrastructure ({familySet.size} family{familySet.size !== 1 ? 'ies' : ''})
                        <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--text-dim)' }}>
                          {[...familySet].map(id => FAMILY_INFO[id]?.name).filter(Boolean).join(', ')}
                        </span>
                      </td>
                      {pw && <td style={{ textAlign: 'right', color: 'var(--red)', fontSize: 12 }}>{formatMoney(-(pw.familyCosts ?? 0))}</td>}
                      <td style={{ textAlign: 'right', color: 'var(--red)', fontSize: 12 }}>{formatMoney(-totalFamilyCosts)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--text-dim)', fontSize: 12 }}>{ytdFamily > 0 ? formatMoney(-ytdFamily) : '—'}</td>
                    </tr>
                  </>
                )}
                <TotalRow label="Total People &amp; Labour" prior={pw ? -pwPeopleLabor : undefined} weekly={-totPeopleLabor} ytd={-(ytdLabor + ytdFamily)} />
              </CollapsibleSection>
            )}

            {/* F. Commercial (distribution always shown; marketing optional) */}
            {(marketingBudgetVal > 0 || totDistribution > 0) && (
              <CollapsibleSection
                label="Commercial &amp; Distribution"
                colSpan={pw ? 4 : 3}
                expanded={sections.marketing ?? true}
                onToggle={() => toggleSection('marketing')}
                summary={<TotalRow label="Commercial (collapsed)" prior={pw ? -((pw.marketing ?? 0) + (pw.distribution ?? 0)) : undefined} weekly={-(marketingBudgetVal + totDistribution)} ytd={-(ytdMarketing + ytdDistribution)} />}
              >
                {totDistribution > 0 && (
                  <tr>
                    <td style={{ paddingLeft: 28, color: 'var(--text-muted)', fontSize: 13 }}>
                      Distribution — GDS, OTA commissions &amp; card processing
                      <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-dim)' }}>
                        {(DISTRIBUTION_COST_PCT * 100).toFixed(1)}% of revenue
                      </span>
                    </td>
                    {pw && <td style={{ textAlign: 'right', color: 'var(--red)', fontSize: 12 }}>{formatMoney(-(pw.distribution ?? 0))}</td>}
                    <td style={{ textAlign: 'right', color: 'var(--red)', fontSize: 13 }}>{formatMoney(-totDistribution)}</td>
                    <td style={{ textAlign: 'right', color: 'var(--text-dim)', fontSize: 12 }}>{ytdDistribution > 0 ? formatMoney(-ytdDistribution) : '—'}</td>
                  </tr>
                )}
                {marketingBudgetVal > 0 && (
                  <tr>
                    <td style={{ paddingLeft: 28, color: 'var(--text-muted)', fontSize: 13 }}>
                      Marketing &amp; advertising
                      <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-dim)' }}>
                        builds brand awareness &amp; local campaigns — demand lift flows through awareness
                      </span>
                    </td>
                    {pw && <td style={{ textAlign: 'right', color: 'var(--red)', fontSize: 12 }}>{formatMoney(-(pw.marketing ?? 0))}</td>}
                    <td style={{ textAlign: 'right', color: 'var(--red)', fontSize: 13 }}>{formatMoney(-marketingBudgetVal)}</td>
                    <td style={{ textAlign: 'right', color: 'var(--text-dim)', fontSize: 12 }}>{ytdMarketing > 0 ? formatMoney(-ytdMarketing) : '—'}</td>
                  </tr>
                )}
                <TotalRow label="Total Commercial" prior={pw ? -((pw.marketing ?? 0) + (pw.distribution ?? 0)) : undefined} weekly={-(marketingBudgetVal + totDistribution)} ytd={-(ytdMarketing + ytdDistribution)} />
              </CollapsibleSection>
            )}

            {/* G. General & Administrative */}
            {totGA > 0 && (
              <CollapsibleSection
                label="General &amp; Administrative"
                colSpan={pw ? 4 : 3}
                expanded={sections.ga ?? true}
                onToggle={() => toggleSection('ga')}
                summary={<TotalRow label="G&amp;A (collapsed)" prior={pw ? -(pw.hqCost ?? 0) : undefined} weekly={-totGA} ytd={-(ytdHQCost)} />}
              >
                <tr>
                  <td style={{ paddingLeft: 28, color: 'var(--text-muted)', fontSize: 13 }}>
                    HQ &amp; corporate overhead
                    <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-dim)' }}>
                      {hqInfo.label} · {fleet.length} aircraft · scales continuously
                    </span>
                  </td>
                  {pw && <td style={{ textAlign: 'right', color: 'var(--red)', fontSize: 12 }}>{formatMoney(-(pw.hqCost ?? 0))}</td>}
                  <td style={{ textAlign: 'right', color: 'var(--red)', fontSize: 13 }}>{formatMoney(-totHQCost)}</td>
                  <td style={{ textAlign: 'right', color: 'var(--text-dim)', fontSize: 12 }}>{ytdHQCost > 0 ? formatMoney(-ytdHQCost) : '—'}</td>
                </tr>
                {totHubInvestment > 0 && (
                  <tr>
                    <td style={{ paddingLeft: 28, color: 'var(--text-muted)', fontSize: 13 }}>
                      Hub investment
                      <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-dim)' }}>
                        {Object.keys(hubs).length} hub{Object.keys(hubs).length !== 1 ? 's' : ''} · ongoing tier costs
                      </span>
                    </td>
                    {pw && <td style={{ textAlign: 'right', color: 'var(--text-dim)', fontSize: 12 }}>{pw.hubInvestment ? formatMoney(-(pw.hubInvestment)) : '—'}</td>}
                    <td style={{ textAlign: 'right', color: 'var(--red)', fontSize: 13 }}>{formatMoney(-totHubInvestment)}</td>
                    <td />
                  </tr>
                )}
                <TotalRow label="Total G&amp;A" prior={pw ? -((pw.hqCost ?? 0) + (pw.hubInvestment ?? 0)) : undefined} weekly={-totGA} ytd={-ytdHQCost} />
              </CollapsibleSection>
            )}

            {/* ── Total Operating Expenses + EBITDA ── */}
            <Spacer colSpan={pw ? 4 : 3} />
            <tr style={{ background: 'var(--surface2)', borderTop: '2px solid var(--border)' }}>
              <td style={{ padding: '10px 16px', fontWeight: 700, fontSize: 13 }}>TOTAL OPERATING EXPENSES</td>
              {pw && <td style={{ textAlign: 'right', padding: '10px 16px', fontWeight: 500, fontSize: 12, color: 'var(--red)' }}>{formatMoney(-pwOpex)}</td>}
              <td style={{ textAlign: 'right', padding: '10px 16px', fontWeight: 700, fontSize: 13, color: 'var(--red)' }}>{formatMoney(-totOpex)}</td>
              <td style={{ textAlign: 'right', padding: '10px 16px', fontSize: 12, color: 'var(--text-dim)' }}>—</td>
            </tr>
            <tr style={{ background: 'var(--surface2)' }}>
              <td style={{ padding: '10px 16px', fontWeight: 700, fontSize: 13 }}>
                EBITDA
                <span style={{ fontWeight: 400, fontSize: 11, color: 'var(--text-dim)', marginLeft: 8 }}>earnings before interest, tax, depreciation &amp; amortisation</span>
              </td>
              {pw && <td style={{ textAlign: 'right', padding: '10px 16px', fontWeight: 500, fontSize: 12, color: pwEbitda >= 0 ? 'var(--green)' : 'var(--red)' }}>{pwEbitda >= 0 ? '+' : ''}{formatMoney(pwEbitda)}</td>}
              <td style={{ textAlign: 'right', padding: '10px 16px', fontWeight: 700, fontSize: 13, color: ebitda >= 0 ? 'var(--green)' : 'var(--red)' }}>
                {ebitda >= 0 ? '+' : ''}{formatMoney(ebitda)}
              </td>
              <td style={{ textAlign: 'right', padding: '10px 16px', fontSize: 12, color: 'var(--text-dim)' }}>—</td>
            </tr>

            {/* Depreciation (non-cash) */}
            {totDepreciation > 0 && (
              <tr>
                <td style={{ paddingLeft: 28, color: 'var(--text-muted)', fontSize: 13 }}>
                  Depreciation — owned aircraft
                  <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-dim)' }}>
                    {fleet.filter(a => a.ownershipType === 'owned').length} aircraft · straight-line {DEPRECIATION_YEARS}yr · non-cash
                  </span>
                </td>
                {pw && <td style={{ textAlign: 'right', color: 'var(--red)', fontSize: 12 }}>{formatMoney(-totDepreciation)}</td>}
                <td style={{ textAlign: 'right', color: 'var(--red)', fontSize: 13 }}>{formatMoney(-totDepreciation)}</td>
                <td style={{ textAlign: 'right', color: 'var(--text-dim)', fontSize: 12 }}>—</td>
              </tr>
            )}

            <Spacer colSpan={pw ? 4 : 3} />
            <tr style={{ background: 'var(--surface2)', borderTop: '2px solid var(--border)' }}>
              <td style={{ padding: '10px 16px', fontWeight: 700, fontSize: 13 }}>EBIT — Operating Income</td>
              {pw && <td style={{ textAlign: 'right', padding: '10px 16px', fontWeight: 500, fontSize: 12, color: pwEbit >= 0 ? 'var(--green)' : 'var(--red)' }}>{pwEbit >= 0 ? '+' : ''}{formatMoney(pwEbit)}</td>}
              <td style={{ textAlign: 'right', padding: '10px 16px', fontWeight: 700, fontSize: 13, color: ebit >= 0 ? 'var(--green)' : 'var(--red)' }}>
                {ebit >= 0 ? '+' : ''}{formatMoney(ebit)}
              </td>
              <td style={{ textAlign: 'right', padding: '10px 16px', fontSize: 12, color: 'var(--text-dim)' }}>—</td>
            </tr>

            {/* Interest expense (the only financing item that hits the P&L; principal is
                a balance-sheet repayment, shown in the cash reconciliation below). */}
            {totInterestExpense > 0 && (
              <CollapsibleSection
                label="Interest expense"
                count={activeLoans.length}
                colSpan={pw ? 4 : 3}
                expanded={sections.debt ?? true}
                onToggle={() => toggleSection('debt')}
                summary={<TotalRow label="Interest expense (collapsed)" prior={pw ? -(pw.loanInterest ?? 0) : undefined} weekly={-totInterestExpense} ytd={null} />}
              >
                {activeLoans.map(loan => {
                  const r = loan.interestRate / 52;
                  const n = loan.weeksRemaining;
                  const bal = r > 0 ? Math.round(loan.weeklyPayment * (1 - Math.pow(1+r,-n)) / r) : loan.weeklyPayment * n;
                  const int = Math.round(bal * r);
                  return (
                    <tr key={loan.id} style={{ background: 'rgba(0,0,0,.1)' }}>
                      <td style={{ paddingLeft: 40, color: 'var(--text-dim)', fontSize: 11 }}>
                        {loan.label ? `${loan.label} · ` : ''}{loan.termWeeks}-wk loan · {loan.weeksRemaining} wks left · {(loan.interestRate*100).toFixed(1)}% APR
                        <span style={{ marginLeft: 8 }}>interest {formatMoney(int)} · principal {formatMoney(loan.weeklyPayment - int)} (in cash recon)</span>
                      </td>
                      {pw && <td />}
                      <td style={{ textAlign: 'right', color: 'var(--text-dim)', fontSize: 11 }}>{formatMoney(-int)}</td>
                      <td />
                    </tr>
                  );
                })}
                <TotalRow label="Total interest expense" prior={pw ? -(pw.loanInterest ?? 0) : undefined} weekly={-totInterestExpense} ytd={null} />
              </CollapsibleSection>
            )}

            {/* Corporate Tax — matches the engine's base (21% of positive pre-tax profit) */}
            {corporateTax > 0 && (
              <tr>
                <td style={{ paddingLeft: 28, color: 'var(--text-muted)', fontSize: 13 }}>
                  Corporate Tax (21%)
                  <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-dim)' }}>21% of positive pre-tax profit</span>
                </td>
                {pw && <td style={{ textAlign: 'right', color: 'var(--red)', fontSize: 12 }}>{formatMoney(-(pw.corporateTax ?? 0))}</td>}
                <td style={{ textAlign: 'right', color: 'var(--red)', fontSize: 13 }}>{formatMoney(-corporateTax)}</td>
                <td style={{ textAlign: 'right', color: 'var(--red)', fontSize: 12 }}>{ytdCorporateTax > 0 ? formatMoney(-ytdCorporateTax) : '—'}</td>
              </tr>
            )}

            {/* ── NET INCOME (accrual) ── */}
            <Spacer colSpan={pw ? 4 : 3} />
            <tr style={{ background: 'var(--surface2)', borderTop: '2px solid var(--border)' }}>
              <td style={{ padding: '12px 16px', fontWeight: 800, fontSize: 14, letterSpacing: '.3px' }}>
                NET INCOME <span style={{ fontWeight: 400, fontSize: 11, color: 'var(--text-dim)', marginLeft: 6 }}>accrual (EBIT − interest − tax)</span>
              </td>
              {pw && <td style={{ textAlign: 'right', padding: '12px 16px', fontSize: 12, color: 'var(--text-dim)' }}>—</td>}
              <td style={{ textAlign: 'right', padding: '12px 16px', fontWeight: 800, fontSize: 14, color: netIncomeAccrual >= 0 ? 'var(--green)' : 'var(--red)' }}>
                {netIncomeAccrual >= 0 ? '+' : ''}{formatMoney(netIncomeAccrual)}
              </td>
              <td style={{ textAlign: 'right', padding: '12px 16px', fontWeight: 700, fontSize: 13, color: ytdNet >= 0 ? 'var(--green)' : 'var(--red)' }}>
                {ytdWeeks > 0 ? (ytdNet >= 0 ? '+' : '') + formatMoney(ytdNet) : '—'}
              </td>
            </tr>

            {/* ── Reconciliation: accrual net income → actual weekly cash change ── */}
            <PLCategoryHeader label="Reconciliation to Cash" />
            <LineItem label="Net income (accrual)" weekly={netIncomeAccrual} ytd={null} prior={undefined} />
            {totDepreciation > 0 && (
              <LineItem label="+ Depreciation (non-cash add-back)" weekly={totDepreciation} ytd={null} prior={undefined} />
            )}
            {totPrincipalRepayment > 0 && (
              <LineItem label="− Loan principal repayment (financing)" weekly={-totPrincipalRepayment} ytd={null} prior={undefined} />
            )}
            <tr style={{ background: 'var(--surface2)', borderTop: '2px solid var(--border)' }}>
              <td style={{ padding: '14px 16px', fontWeight: 800, fontSize: 15, letterSpacing: '.3px' }}>
                Δ CASH THIS WEEK <span style={{ fontWeight: 400, fontSize: 11, color: 'var(--text-dim)', marginLeft: 6 }}>actual bank-balance change</span>
              </td>
              {pw && <td style={{ textAlign: 'right', padding: '14px 16px', fontWeight: 600, fontSize: 13, color: (pw.profit ?? 0) >= 0 ? 'var(--green)' : 'var(--red)' }}>{(pw.profit ?? 0) >= 0 ? '+' : ''}{formatMoney(pw.profit ?? 0)}</td>}
              <td style={{ textAlign: 'right', padding: '14px 16px', fontWeight: 800, fontSize: 15, color: netIncome >= 0 ? 'var(--green)' : 'var(--red)' }}>
                {netIncome >= 0 ? '+' : ''}{formatMoney(netIncome)}
              </td>
              <td style={{ textAlign: 'right', padding: '14px 16px', fontWeight: 700, fontSize: 13, color: ytdNet >= 0 ? 'var(--green)' : 'var(--red)' }}>
                {ytdWeeks > 0 ? (ytdNet >= 0 ? '+' : '') + formatMoney(ytdNet) : '—'}
              </td>
            </tr>
          </tbody>
            </table>
          </div>
        );
      })()}


      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 8, lineHeight: 1.6 }}>
        {financialHistory.length > 0 ? `Wk ${financialHistory[financialHistory.length - 1].week} = last completed week · ` : ''}Projected = current week estimate · YTD = sum of {ytdWeeks} actuals ·
        EBITDA excludes depreciation (non-cash) and financing ·
        Variable crew pay = flight-duty wages only; fixed crew overhead is in People &amp; Labour ·
        Revenue is the engine's booked figure: includes connecting feed, partner O&amp;D, and brand-awareness, marketing &amp; loyalty demand lifts ·
        "Δ Cash this week" matches the actual bank-balance change (last week shown for comparison)
      </div>
    </div>
  );
}

// ── P&L helper: non-collapsible category separator ───────────────────────────
function PLCategoryHeader({ label, colSpan = 4 }) {
  return (
    <tr>
      <td colSpan={colSpan} style={{
        padding: '10px 16px 4px',
        fontSize: 10, fontWeight: 800, letterSpacing: '1px', textTransform: 'uppercase',
        color: 'var(--accent)', background: 'rgba(56,139,253,.06)',
        borderTop: '1px solid rgba(56,139,253,.15)',
      }}>
        {label}
      </td>
    </tr>
  );
}

// ── P&L helper: sub-section label inside a group ─────────────────────────────
function SubSectionHeader({ label, colSpan = 4 }) {
  return (
    <tr>
      <td colSpan={colSpan} style={{
        paddingLeft: 28, paddingTop: 8, paddingBottom: 3,
        fontSize: 10, fontWeight: 700, letterSpacing: '.6px', textTransform: 'uppercase',
        color: 'var(--text-dim)',
      }}>
        {label}
      </td>
    </tr>
  );
}

// ─── Balance Sheet ────────────────────────────────────────────────────────────

function BalanceSheet() {
  const { state } = useGame();
  const { fleet, cash, financialHistory } = state;

  // Assets
  const ownedFleet = fleet.filter(a => a.ownershipType === 'owned').map(a => {
    const type = getAircraftType(a.typeId);
    return { aircraft: a, type, bookValue: aircraftBookValue(a, type) };
  });
  const totalFleetValue = ownedFleet.reduce((s, f) => s + f.bookValue, 0);
  const totalAssets = cash + totalFleetValue;

  // Loan liabilities — outstanding balance on each active loan
  const activeLoans = state.loans ?? [];
  const loanLiabilities = activeLoans.map(loan => {
    const weeklyRate = loan.interestRate / 52;
    const n = loan.weeksRemaining;
    const balance = weeklyRate > 0
      ? Math.round(loan.weeklyPayment * (1 - Math.pow(1 + weeklyRate, -n)) / weeklyRate)
      : loan.weeklyPayment * n;
    return { loan, balance };
  });
  const totalLoanLiabilities = loanLiabilities.reduce((s, l) => s + l.balance, 0);
  // Operating leases are an off-balance-sheet COMMITMENT (rent), not a borrowing —
  // shown as a footnote, not a liability. (Booking 52× rent as a liability with no
  // offsetting right-of-use asset is what previously made the sheet fail to balance.)
  const leasedFleet = fleet.filter(a => a.ownershipType !== 'owned').map(a => {
    const type = getAircraftType(a.typeId);
    return { aircraft: a, type, weekly: (a.weeklyLease ?? type?.weeklyLease ?? 0) };
  });
  const annualLeaseCommitment = leasedFleet.reduce((s, f) => s + f.weekly * 52, 0);

  const totalLiabilities = totalLoanLiabilities;

  // Equity = net assets (assets − liabilities). This balances by construction, and
  // because every cash flow is matched on the balance sheet (capex ↔ book value,
  // loan proceeds ↔ loan balance), the weekly change in equity equals accrual net
  // income. Retained earnings is therefore the accumulated accrual earnings.
  const totalEquity = totalAssets - totalLiabilities;
  const retainedEarnings = totalEquity - STARTING_CAPITAL;
  const totalLiabPlusEquity = totalLiabilities + totalEquity;

  // Key ratios — leverage uses loans + capitalised lease commitment for realism.
  const totalDebtForRatio = totalLoanLiabilities + annualLeaseCommitment;
  const currentRatio = totalDebtForRatio > 0 ? cash / totalDebtForRatio : Infinity;
  const debtToEquity = totalEquity > 0 ? totalDebtForRatio / totalEquity : 0;

  return (
    <div>
      {/* Key ratios */}
      <div className="stat-grid" style={{ marginBottom: 20 }}>
        <StatBox label="Total Assets"       value={formatMoney(totalAssets)}      color="blue" />
        <StatBox label="Total Liabilities"  value={formatMoney(totalLiabilities)} color="red"  />
        <StatBox label="Total Equity"       value={formatMoney(totalEquity)}       color={totalEquity >= 0 ? 'green' : 'red'} />
        <StatBox label="Current Ratio"      value={isFinite(currentRatio) ? currentRatio.toFixed(2) + '×' : '∞'} color={currentRatio > 1 ? 'green' : 'red'} />
        <StatBox label="Debt / Equity"      value={debtToEquity.toFixed(2) + '×'} color={debtToEquity < 2 ? 'green' : 'yellow'} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>

        {/* Assets */}
        <div>
          <BSHeader label="ASSETS" />
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <table>
              <tbody>
                <BSSectionHeader label="Current Assets" />
                <BSRow label="Cash and cash equivalents" value={cash} indent={1} bold />
                <BSTotalRow label="Total Current Assets" value={cash} />

                {ownedFleet.length > 0 && (
                  <>
                    <BSSectionHeader label="Non-Current Assets — Fleet" />
                    {ownedFleet.map(({ aircraft, type, bookValue }) => {
                      const ageYrs = (aircraft.ageWeeks ?? 0) / 52;
                      const depPct = ageYrs / DEPRECIATION_YEARS;
                      return (
                        <BSRow
                          key={aircraft.id}
                          label={aircraft.name}
                          sublabel={`${type?.name} · ${formatPercent(1 - depPct)} book value remaining`}
                          value={bookValue}
                          indent={1}
                        />
                      );
                    })}
                    <BSTotalRow label="Total Fixed Assets" value={totalFleetValue} />
                  </>
                )}

                <tr style={{ background: 'var(--surface2)', fontWeight: 700 }}>
                  <td style={{ padding: '12px 16px', fontSize: 13 }}>TOTAL ASSETS</td>
                  <td style={{ textAlign: 'right', padding: '12px 16px', fontSize: 13, color: 'var(--accent)' }}>{formatMoney(totalAssets)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* Liabilities + Equity */}
        <div>
          <BSHeader label="LIABILITIES & EQUITY" />
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <table>
              <tbody>

                <BSSectionHeader label="Liabilities — Loans (outstanding principal)" />
                {loanLiabilities.length === 0 && <EmptyRow text="No debt outstanding" />}
                {loanLiabilities.map(({ loan, balance }) => (
                  <BSRow
                    key={loan.id}
                    label={loan.label ?? `${loan.termWeeks}-week loan`}
                    sublabel={`${(loan.interestRate * 100).toFixed(1)}% APR · ${loan.weeksRemaining} wks remaining · ${formatMoney(loan.weeklyPayment)}/wk`}
                    value={balance}
                    indent={1}
                    negative
                  />
                ))}

                <BSTotalRow label="Total Liabilities" value={totalLiabilities} negative />

                <BSSectionHeader label="Equity" />
                <BSRow label="Paid-in capital"     value={STARTING_CAPITAL}  indent={1} />
                <BSRow
                  label="Retained earnings"
                  sublabel={`accumulated net income · ${financialHistory.length} weeks`}
                  value={retainedEarnings}
                  indent={1}
                  signed
                />
                <BSTotalRow label="Total Equity" value={totalEquity} signed />

                <tr style={{ background: 'var(--surface2)', fontWeight: 700 }}>
                  <td style={{ padding: '12px 16px', fontSize: 13 }}>TOTAL L + EQUITY</td>
                  <td style={{ textAlign: 'right', padding: '12px 16px', fontSize: 13, color: 'var(--accent)' }}>{formatMoney(totalLiabPlusEquity)}</td>
                </tr>

              </tbody>
            </table>
          </div>

          {/* Balance check — balances by construction (equity = net assets) */}
          <div style={{
            marginTop: 8, padding: '8px 12px', borderRadius: 6, fontSize: 12,
            background: Math.abs(totalAssets - totalLiabPlusEquity) < 1 ? 'rgba(63,185,80,.08)' : 'rgba(248,81,73,.08)',
            color: Math.abs(totalAssets - totalLiabPlusEquity) < 1 ? 'var(--green)' : 'var(--red)',
          }}>
            <GlyphLabel size={12} text={Math.abs(totalAssets - totalLiabPlusEquity) < 1
              ? '✓ Balance sheet balances'
              : `⚠ Imbalance of ${formatMoney(Math.abs(totalAssets - totalLiabPlusEquity))}`
            } />
          </div>

          {/* Off-balance-sheet commitments */}
          {annualLeaseCommitment > 0 && (
            <div style={{ marginTop: 8, padding: '8px 12px', borderRadius: 6, fontSize: 12, background: 'var(--surface2)', color: 'var(--text-muted)' }}>
              <strong>Lease commitments (off balance sheet):</strong> {leasedFleet.length} leased aircraft · {formatMoney(annualLeaseCommitment)}/yr in future rent. Counted as debt for the leverage ratio below.
            </div>
          )}

          {/* Ratio notes */}
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
            <strong>Current Ratio</strong> (cash ÷ loans + annual lease commitment): {isFinite(currentRatio) ? currentRatio.toFixed(2) : '∞'} — {currentRatio >= 1 ? 'solvent' : 'at risk'}<br />
            <strong>Equity</strong> = total assets − liabilities (net book value); <strong>retained earnings</strong> = equity − paid-in capital = accumulated net income.<br />
            <strong>Fleet book value</strong> = purchase price × remaining life (straight-line, {DEPRECIATION_YEARS}yr). Operating leases are rent (a commitment), not a balance-sheet liability.
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── By Route ─────────────────────────────────────────────────────────────────

function RouteBreakdown({ proj }) {
  const { state } = useGame();
  const { fleet, routes } = state;
  const [expanded, setExpanded]   = useState({});  // keyed by "ORG→DST"
  const [sections, setSections]   = useState({ profitable: true, losing: true });
  const toggleSection = key => setSections(s => ({ ...s, [key]: !s[key] }));
  // Use the engine's per-route results: BOOKED revenue (incl. connecting + lifts)
  // and ALL directly-attributable costs (operating cost + landing fees).
  const rrById = {};
  for (const rr of proj.report.routeResults ?? []) rrById[rr.routeId] = rr;

  const routeData = routes.map(route => {
    const aircraft = fleet.find(a => a.id === route.aircraftId);
    if (!aircraft) return null;
    const rr = rrById[route.id];
    if (!rr) return null;
    // rr spreads the full simulateRoute result + boosted revenue + landingFee.
    const result = { ...rr, directCost: (rr.totalOpCost ?? 0) + (rr.landingFee ?? 0) };
    return { route, aircraft, type: getAircraftType(aircraft.typeId), result };
  }).filter(Boolean);

  if (routeData.length === 0) {
    return <div className="empty-state"><div className="empty-state-icon"><Glyph e="🗺️" /></div><div className="empty-state-text">No active routes.</div></div>;
  }

  // Consolidate by origin→destination pair
  const groupMap = {};
  routeData.forEach(d => {
    const key = `${d.route.origin}→${d.route.destination}`;
    if (!groupMap[key]) groupMap[key] = { key, origin: d.route.origin, destination: d.route.destination, entries: [] };
    groupMap[key].entries.push(d);
  });
  const consolidated = Object.values(groupMap).map(g => {
    const totalRev  = g.entries.reduce((s, e) => s + e.result.revenue, 0);
    const totalCost = g.entries.reduce((s, e) => s + e.result.directCost, 0);
    const totalPax  = g.entries.reduce((s, e) => s + e.result.passengers, 0);
    const totalFreq = g.entries.reduce((s, e) => s + e.route.weeklyFrequency, 0);
    const wLF       = g.entries.reduce((s, e) => s + e.result.loadFactor * e.route.weeklyFrequency, 0);
    const avgLF     = totalFreq > 0 ? wLF / totalFreq : 0;
    const contribution = totalRev - totalCost;
    const margin       = totalRev > 0 ? contribution / totalRev : 0;
    return { ...g, totalRev, totalCost, totalPax, totalFreq, avgLF, contribution, margin };
  }).sort((a, b) => b.contribution - a.contribution);

  const profitable = consolidated.filter(g => g.contribution >= 0);
  const losing     = consolidated.filter(g => g.contribution <  0);
  const totRev     = consolidated.reduce((s, g) => s + g.totalRev, 0);
  const totCost    = consolidated.reduce((s, g) => s + g.totalCost, 0);

  const COLS = 8;

  const ConsolidatedRow = ({ group }) => {
    const { key, origin, destination, entries, totalRev, totalCost, totalPax, totalFreq, avgLF, contribution, margin } = group;
    const isExpanded = expanded[key];
    const multi = entries.length > 1;
    const firstResult = entries[0].result;

    // Aircraft label
    const typeNames = [...new Set(entries.map(e => e.type?.name).filter(Boolean))];
    const aircraftLabel = multi
      ? typeNames.length === 1 ? `${typeNames[0]} ×${entries.length}` : `${entries.length} aircraft`
      : entries[0].aircraft.name;

    return (
      <Fragment key={key}>
        <tr style={{ cursor: 'pointer' }} onClick={() => setExpanded(e => ({ ...e, [key]: !e[key] }))}>
          <td>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 10, color: 'var(--text-dim)', width: 10 }}>{isExpanded ? '▾' : '▸'}</span>
              <div>
                <strong>{origin} → {destination}</strong>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {getAirport(origin)?.city} → {getAirport(destination)?.city}
                  {' · '}{firstResult.distance.toLocaleString()} km
                  {firstResult.competitorCount > 0 && <span style={{ color: 'var(--yellow)' }}> · {firstResult.competitorCount} competitor{firstResult.competitorCount !== 1 ? 's' : ''}</span>}
                </div>
              </div>
            </div>
          </td>
          <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>
            {aircraftLabel}<br />
            <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{totalFreq}×/wk{!multi && ` · $${entries[0].route.ticketPrice} eco`}</span>
          </td>
          <td style={{ textAlign: 'right' }}>{totalPax.toLocaleString()}</td>
          <td style={{ textAlign: 'right' }}>
            <span style={{ color: avgLF > .75 ? 'var(--green)' : avgLF > .45 ? 'var(--yellow)' : 'var(--red)' }}>
              {formatPercent(avgLF)}
            </span>
          </td>
          <td style={{ textAlign: 'right', color: 'var(--green)' }}>{formatMoney(totalRev)}</td>
          <td style={{ textAlign: 'right', color: 'var(--red)' }}>{formatMoney(totalCost)}</td>
          <td style={{ textAlign: 'right', color: contribution >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
            {contribution >= 0 ? '+' : ''}{formatMoney(contribution)}
          </td>
          <td style={{ textAlign: 'right', color: margin > 0 ? 'var(--green)' : 'var(--red)' }}>
            {formatPercent(margin)}
          </td>
        </tr>
        {isExpanded && (
          <tr style={{ background: 'rgba(0,0,0,.15)' }}>
            <td colSpan={COLS} style={{ padding: '10px 24px 12px 40px' }}>
              {entries.map(({ route, aircraft, type, result }, i) => (
                <div key={route.id} style={{ marginBottom: multi && i < entries.length - 1 ? 16 : 0 }}>
                  {multi && (
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 8, paddingBottom: 4, borderBottom: '1px solid var(--border)' }}>
                      {aircraft.name} ({type?.name}) — {route.weeklyFrequency}×/wk · ${route.ticketPrice} eco · {result.passengers.toLocaleString()} pax · {formatPercent(result.loadFactor)} load
                    </div>
                  )}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
                    <div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 6 }}>Revenue by Class</div>
                      {Object.entries(result.classSummary ?? {}).map(([cls, data]) => {
                        if (!data?.seats) return null;
                        const fare = route.classPrices?.[cls] ?? route.ticketPrice;
                        return (
                          <div key={cls} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, fontSize: 12 }}>
                            <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: CLASS_COLORS[cls], flexShrink: 0 }} />
                            <span style={{ flex: 1, color: 'var(--text-muted)' }}>{CLASS_LABELS[cls]}</span>
                            <span>{data.passengers.toLocaleString()} pax × {formatMoney(fare)}</span>
                            <span style={{ color: 'var(--green)', fontWeight: 600 }}>{formatMoney(data.revenue)}</span>
                            <span style={{ color: 'var(--text-dim)' }}>({formatPercent(data.loadFactor)})</span>
                          </div>
                        );
                      })}
                    </div>
                    <div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 6 }}>Operating Costs</div>
                      <CostLine label="Fuel"  value={result.fuelCost} />
                      <CostLine label="Crew"  value={result.crewCost} />
                      {result.qualityCost > 0 && <CostLine label="Quality" value={result.qualityCost} />}
                      {result.landingFee > 0 && <CostLine label="Landing &amp; nav fees" value={result.landingFee} />}
                      <div style={{ borderTop: '1px solid var(--border)', marginTop: 4, paddingTop: 4, display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                        <strong>Total Direct Cost</strong><strong style={{ color: 'var(--red)' }}>{formatMoney(result.directCost)}</strong>
                      </div>
                    </div>
                    {(!multi || i === 0) && (
                      <div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 6 }}>Market Context</div>
                        <InfoLine label="Market demand" value={result.marketDemand?.toLocaleString() + ' pax/wk'} />
                        <InfoLine label="Seasonality"   value={result.seasonality ? formatPercent(result.seasonality - 1) + ' adj' : '—'} />
                        <InfoLine label="Competitors"   value={result.competitorCount + ' airlines'} />
                        <InfoLine label="At capacity"   value={<GlyphLabel size={12} text={result.capacityCapped ? '⚠ Yes' : '✓ No'} />} />
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </td>
          </tr>
        )}
      </Fragment>
    );
  };

  // Summary rows shown when a group is collapsed
  const GroupSummary = ({ groups, colSpan }) => {
    const rev  = groups.reduce((s, g) => s + g.totalRev, 0);
    const cost = groups.reduce((s, g) => s + g.totalCost, 0);
    return (
      <tr style={{ background: 'rgba(0,0,0,.1)' }}>
        <td colSpan={colSpan - 2} style={{ paddingLeft: 32, fontSize: 12, color: 'var(--text-dim)', fontStyle: 'italic' }}>
          {groups.length} route{groups.length !== 1 ? 's' : ''} hidden
        </td>
        <td style={{ textAlign: 'right', color: 'var(--green)', fontSize: 12 }}>{formatMoney(rev)}</td>
        <td style={{ textAlign: 'right', color: 'var(--red)', fontSize: 12 }}>{formatMoney(cost)}</td>
        <td style={{ textAlign: 'right', fontSize: 12, color: (rev - cost) >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
          {(rev - cost) >= 0 ? '+' : ''}{formatMoney(rev - cost)}
        </td>
        <td />
      </tr>
    );
  };

  return (
    <div>
      <div className="stat-grid" style={{ marginBottom: 16 }}>
        <StatBox label="Routes"            value={consolidated.length}           color="blue"  />
        <StatBox label="Total Revenue/wk"  value={formatMoney(totRev)}           color="green" />
        <StatBox label="Direct Cost/wk"    value={formatMoney(totCost)}          color="red"   />
        <StatBox label="Contribution/wk"   value={formatMoney(totRev - totCost)} color={(totRev - totCost) >= 0 ? 'green' : 'red'} />
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table>
          <thead>
            <tr>
              <th>Route</th>
              <th>Aircraft</th>
              <th style={{ textAlign: 'right' }}>Pax/wk</th>
              <th style={{ textAlign: 'right' }}>Load</th>
              <th style={{ textAlign: 'right' }}>Revenue</th>
              <th style={{ textAlign: 'right' }}>Direct Cost</th>
              <th style={{ textAlign: 'right' }}>Contribution</th>
              <th style={{ textAlign: 'right' }}>Margin</th>
            </tr>
          </thead>
          <tbody>
            {profitable.length > 0 && (
              <CollapsibleSection
                label="Profitable Routes"
                count={profitable.length}
                colSpan={COLS}
                expanded={sections.profitable}
                onToggle={() => toggleSection('profitable')}
                summary={<GroupSummary groups={profitable} colSpan={COLS} />}
              >
                {profitable.map(g => <ConsolidatedRow key={g.key} group={g} />)}
              </CollapsibleSection>
            )}
            {losing.length > 0 && (
              <>
                {profitable.length > 0 && <Spacer />}
                <CollapsibleSection
                  label="Loss-making Routes"
                  count={losing.length}
                  colSpan={COLS}
                  expanded={sections.losing}
                  onToggle={() => toggleSection('losing')}
                  summary={<GroupSummary groups={losing} colSpan={COLS} />}
                >
                  {losing.map(g => <ConsolidatedRow key={g.key} group={g} />)}
                </CollapsibleSection>
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── By Airport ───────────────────────────────────────────────────────────────

function AirportBreakdown({ proj }) {
  const { state } = useGame();
  const { fleet, routes } = state;
  const rrById = {};
  for (const rr of proj.report.routeResults ?? []) rrById[rr.routeId] = rr;

  const routeData = routes.map(route => {
    const aircraft = fleet.find(a => a.id === route.aircraftId);
    if (!aircraft) return null;
    const result = rrById[route.id];   // booked revenue (incl. connecting + lifts)
    return result ? { route, result } : null;
  }).filter(Boolean);

  // Aggregate by airport
  const airportMap = {};

  const ensure = code => {
    if (!airportMap[code]) {
      const airport = getAirport(code);
      airportMap[code] = { code, airport, routes: [], revenue: 0, pax: 0 };
    }
  };

  routeData.forEach(({ route, result }) => {
    ensure(route.origin);
    ensure(route.destination);
    // Each airport gets the route attributed to it; revenue split 50/50.
    // passengers is one-way, so each airport endpoint gets that count directly.
    const halfRev = Math.round(result.revenue / 2);
    const halfPax = result.passengers;  // already one-way; each airport attributed one direction
    airportMap[route.origin].routes.push(route);
    airportMap[route.origin].revenue += halfRev;
    airportMap[route.origin].pax     += halfPax;
    airportMap[route.destination].revenue += halfRev;
    airportMap[route.destination].pax     += halfPax;
  });

  const airports = Object.values(airportMap).sort((a, b) => b.revenue - a.revenue);

  if (airports.length === 0) {
    return <div className="empty-state"><div className="empty-state-icon"><Glyph e="🏢" /></div><div className="empty-state-text">No active routes.</div></div>;
  }

  const gates = state.gates ?? {};

  return (
    <div>
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table>
          <thead>
            <tr>
              <th>Airport</th>
              <th>Tier</th>
              <th style={{ textAlign: 'right' }}>Routes</th>
              <th style={{ textAlign: 'right' }}>Pax / wk</th>
              <th style={{ textAlign: 'right' }}>Revenue / wk</th>
              <th style={{ textAlign: 'right' }}>Gates Owned</th>
              <th style={{ textAlign: 'right' }}>Gate Fee / wk</th>
              <th style={{ textAlign: 'right' }}>Net Contribution</th>
            </tr>
          </thead>
          <tbody>
            {airports.map(({ code, airport, routes: aptRoutes, revenue, pax }) => {
              const gateCount  = gates[code] ?? 0;
              const monthlyFee = gateMonthlyFee(airport) * gateCount;
              const weeklyFee  = Math.round(monthlyFee / 4.33);
              const net        = revenue - weeklyFee;
              const tierColor  = { mega: '#a98bff', major: '#3ea6ff', regional: '#38d39f' }[airport?.tier] ?? 'var(--text-muted)';
              const routeList  = [...new Set(aptRoutes.map(r => r.origin === code ? r.destination : r.origin))];

              return (
                <tr key={code}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{code}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{airport?.city}, {airport?.country}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>
                      {routeList.map(dest => <span key={dest} style={{ marginRight: 4 }}>{dest}</span>)}
                    </div>
                  </td>
                  <td>
                    <span className="badge" style={{ background: `${tierColor}20`, color: tierColor, textTransform: 'capitalize' }}>
                      {airport?.tier ?? '—'}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right' }}>{aptRoutes.length}</td>
                  <td style={{ textAlign: 'right' }}>{pax.toLocaleString()}</td>
                  <td style={{ textAlign: 'right', color: 'var(--green)' }}>{formatMoney(revenue)}</td>
                  <td style={{ textAlign: 'right' }}>
                    {gateCount > 0
                      ? <span className="badge badge-blue">{gateCount}</span>
                      : <span style={{ color: 'var(--text-dim)' }}>—</span>}
                  </td>
                  <td style={{ textAlign: 'right', color: weeklyFee > 0 ? 'var(--red)' : 'var(--text-dim)' }}>
                    {weeklyFee > 0 ? formatMoney(-weeklyFee) : '—'}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 600, color: net >= 0 ? 'var(--green)' : 'var(--red)' }}>
                    {net >= 0 ? '+' : ''}{formatMoney(net)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6 }}>
        Revenue is split 50/50 between origin and destination airport. Net contribution = revenue − gate fees.
      </div>
    </div>
  );
}

// ─── Cash Flow Statement ─────────────────────────────────────────────────────

function CashFlow({ proj }) {
  const { state } = useGame();
  const { cash, financialHistory } = state;

  // Single source of truth (same figures as P&L / Forecast / Unit Economics).
  const report = proj.report;

  // Cost buckets, straight from the engine report (so the cost mix sums to total).
  const projOpCost       = report.totalOpCost;
  const projLeases       = report.totalLeases;
  const projMaint        = report.totalMaintenance;
  const projInsurance    = report.totalInsurance;
  const projGates        = report.totalGateFees;
  const projLandingFees  = report.totalLandingFees;
  const projDistribution = report.totalDistributionCost;
  const projMarketing    = report.totalMarketingSpend;
  const projHQ           = report.totalHQCost;
  const projHubInvest    = report.totalHubInvestment;
  const cfLabor          = report.totalLaborCosts;
  const cfFamily         = report.totalFamilyBaseCosts;
  const cfLoyalty        = report.totalLoyaltyCost;
  const cfPartnerFees    = report.totalPartnerFees;

  // Loan figures + depreciation from the canonical projection.
  const cfActiveLoans  = (state.loans ?? []).filter(l => (l.weeksRemaining ?? 0) > 0);
  const cfLoanPayments = proj.loanPayments;
  const cfLoanInterest = proj.interest;
  const cfPrincipal    = proj.principal;
  const projDepreciation = proj.depreciation;

  // Indirect method: start from accrual net income (interest + tax already in it),
  // add back non-cash depreciation → operating CF. Financing = principal only.
  const projNetIncome   = proj.netIncomeAccrual;
  const projOperatingCF = projNetIncome + projDepreciation;   // = EBITDA − interest − tax

  // Investing CF — estimated from cash reconciliation
  const ytdNet         = ytd(financialHistory, 'profit');
  const theoreticalCash = STARTING_CAPITAL + ytdNet;
  const investingOutflow = Math.max(0, theoreticalCash - cash);
  const ytdWeeks        = financialHistory.length;
  const avgWeeklyInvesting = ytdWeeks > 0 ? investingOutflow / ytdWeeks : 0;

  // Runway based on the true weekly cash burn (matches the engine).
  const runway = proj.netCash < 0 && cash > 0 ? Math.floor(cash / -proj.netCash) : Infinity;

  const totalCosts = projOpCost + projLeases + projMaint + projInsurance + projGates
    + projLandingFees + projDistribution + projMarketing + projHQ + projHubInvest
    + cfLabor + cfFamily + cfLoyalty + cfPartnerFees;

  return (
    <div>
      <div className="stat-grid" style={{ marginBottom: 20 }}>
        <StatBox label="Operating CF/wk" value={formatMoney(projOperatingCF)} color={projOperatingCF >= 0 ? 'green' : 'red'} />
        <StatBox label="Net Income/wk"   value={formatMoney(projNetIncome)}   color={projNetIncome >= 0 ? 'green' : 'red'}   />
        <StatBox label="Depreciation"    value={formatMoney(projDepreciation)} color="blue" />
        <StatBox label="Cash Runway"
          value={isFinite(runway) ? `${runway} wks` : '∞'}
          color={isFinite(runway) ? (runway < 8 ? 'red' : runway < 20 ? 'yellow' : 'green') : 'green'}
        />
        <StatBox label="Total Asset Spend" value={formatMoney(investingOutflow)} color={investingOutflow > 0 ? 'red' : 'blue'} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {/* Statement */}
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table>
            <thead><tr><th>Cash Flow Statement (Weekly)</th><th style={{ textAlign: 'right' }}>Amount</th></tr></thead>
            <tbody>
              <SectionHeader label="Operating Activities" />
              <CFRow label="Net income (accrual)"           value={projNetIncome}    />
              {cfLoanInterest > 0 && <CFRow label="  (incl. interest expense)" value={-cfLoanInterest} />}
              <CFRow label="+ Depreciation (non-cash)"      value={projDepreciation} positive />
              <CFTotalRow label="Net Operating Cash Flow"   value={projOperatingCF} />
              <Spacer />
              <SectionHeader label="Investing Activities" />
              <CFRow label="Aircraft/asset purchases (avg)" value={-Math.round(avgWeeklyInvesting)} />
              <CFTotalRow label="Net Investing Cash Flow"   value={-Math.round(avgWeeklyInvesting)} />
              <Spacer />
              <SectionHeader label="Financing Activities" />
              {cfLoanPayments > 0 ? (
                <>
                  <CFRow label="Loan principal repayment" value={-cfPrincipal} />
                  {cfActiveLoans.map(loan => {
                    const r = loan.interestRate / 52;
                    const n = loan.weeksRemaining;
                    const bal = r > 0 ? Math.round(loan.weeklyPayment * (1 - Math.pow(1+r,-n)) / r) : loan.weeklyPayment * n;
                    const int = Math.round(bal * r);
                    return (
                      <tr key={loan.id}>
                        <td style={{ paddingLeft: 40, color: 'var(--text-dim)', fontSize: 11 }}>
                          {loan.label ?? `${loan.termWeeks}-wk loan`} · {loan.weeksRemaining} wks left · {(loan.interestRate*100).toFixed(1)}% APR
                          <span style={{ marginLeft: 8 }}>principal {formatMoney(loan.weeklyPayment - int)} (interest {formatMoney(int)} in operating)</span>
                        </td>
                        <td style={{ textAlign: 'right', color: 'var(--text-dim)', fontSize: 11 }}>{formatMoney(-(loan.weeklyPayment - int))}</td>
                      </tr>
                    );
                  })}
                </>
              ) : (
                <tr><td style={{ paddingLeft: 28, color: 'var(--text-dim)', fontSize: 13 }}>No active loans</td><td style={{ textAlign: 'right', color: 'var(--text-dim)' }}>—</td></tr>
              )}
              <CFTotalRow label="Net Financing Cash Flow"   value={-cfPrincipal} />
              <Spacer />
              {(() => {
                const netChange = projOperatingCF - cfPrincipal;
                return (
                  <tr style={{ background: 'var(--surface2)', fontWeight: 700 }}>
                    <td style={{ padding: '12px 16px', fontSize: 14 }}>NET CHANGE IN CASH</td>
                    <td style={{ textAlign: 'right', padding: '12px 16px', fontSize: 14, color: netChange >= 0 ? 'var(--green)' : 'var(--red)' }}>
                      {netChange >= 0 ? '+' : ''}{formatMoney(netChange)}
                    </td>
                  </tr>
                );
              })()}
            </tbody>
          </table>
        </div>

        {/* Reconciliation + cost mix */}
        <div>
          <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 16 }}>
            <table>
              <thead><tr><th>Cash Reconciliation (Since Start)</th><th style={{ textAlign: 'right' }}>Amount</th></tr></thead>
              <tbody>
                <CFRow label="Starting capital"                    value={STARTING_CAPITAL} positive />
                <CFRow label={`Total operating CF (${ytdWeeks}wk)`} value={ytdNet} />
                <CFTotalRow label="Theoretical cash (ops only)"    value={theoreticalCash} />
                <Spacer />
                <CFRow label="One-off investing outflows"          value={-investingOutflow} />
                <CFTotalRow label="Actual cash balance"            value={cash} />
              </tbody>
            </table>
          </div>

          {totalCosts > 0 && (
            <div className="card">
              <div className="card-title">Cost Mix</div>
              <div style={{ display: 'flex', height: 16, borderRadius: 3, overflow: 'hidden', marginBottom: 10 }}>
                {[
                  { v: projLeases,      c: '#ff5d6c', l: 'Leases'       },
                  { v: projMaint,       c: '#ffb43d', l: 'Maint'        },
                  { v: projInsurance,   c: '#e07b39', l: 'Insurance'    },
                  { v: projOpCost,      c: '#3ea6ff', l: 'Op Costs'     },
                  { v: projLandingFees, c: '#1f7fc4', l: 'Landing Fees' },
                  { v: projGates,       c: '#38d39f', l: 'Gates'        },
                  { v: cfLabor,         c: '#a98bff', l: 'Labor'        },
                  { v: cfFamily,        c: '#4fc3f7', l: 'MRO Base'     },
                  { v: projMarketing,   c: '#ff7eb6', l: 'Marketing'    },
                  { v: projDistribution,c: '#bc8cff', l: 'Distribution' },
                  { v: projHQ + projHubInvest + cfLoyalty + cfPartnerFees, c: '#93a4ba', l: 'G&A & Other'  },
                ].map((s, i) => s.v > 0 && (
                  <div key={i} style={{ width: `${(s.v/totalCosts)*100}%`, background: s.c }} title={`${s.l}: ${formatMoney(s.v)}`} />
                ))}
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 12 }}>
                {[
                  { v: projLeases,      c: '#ff5d6c', l: 'Leases'       },
                  { v: projMaint,       c: '#ffb43d', l: 'Maint'        },
                  { v: projInsurance,   c: '#e07b39', l: 'Insurance'    },
                  { v: projOpCost,      c: '#3ea6ff', l: 'Op Costs'     },
                  { v: projLandingFees, c: '#1f7fc4', l: 'Landing Fees' },
                  { v: projGates,       c: '#38d39f', l: 'Gates'        },
                  { v: cfLabor,         c: '#a98bff', l: 'Labor'        },
                  { v: cfFamily,        c: '#4fc3f7', l: 'MRO Base'     },
                  { v: projMarketing,   c: '#ff7eb6', l: 'Marketing'    },
                  { v: projDistribution,c: '#bc8cff', l: 'Distribution' },
                  { v: projHQ + projHubInvest + cfLoyalty + cfPartnerFees, c: '#93a4ba', l: 'G&A & Other'  },
                ].filter(s => s.v > 0).map((s, i) => (
                  <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: s.c, display: 'inline-block' }} />
                    <span style={{ color: 'var(--text-muted)' }}>{s.l}</span>
                    <strong>{formatMoney(s.v)}</strong>
                    <span style={{ color: 'var(--text-dim)' }}>({formatPercent(s.v/totalCosts)})</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Unit Economics ───────────────────────────────────────────────────────────

const GRADE_CONFIG = [
  { min: 0.020, label: 'A', color: '#38d39f' },
  { min: 0.010, label: 'B', color: '#4fc3f7' },
  { min: 0.000, label: 'C', color: '#ffb43d' },
  { min: -Infinity, label: 'D', color: '#ff5d6c' },
];
function routeGrade(spread) {
  return GRADE_CONFIG.find(g => spread >= g.min) ?? GRADE_CONFIG[GRADE_CONFIG.length - 1];
}

function UnitEconomics({ proj }) {
  const { state } = useGame();
  const { fleet, routes } = state;
  const [sortKey, setSortKey] = useState('spread');
  const [sortDir, setSortDir] = useState(-1);
  const gd = currentGameDate(state);
  const labor = state.labor ?? DEFAULT_LABOR_STATE;

  const routeData = useMemo(() => {
    const avgUtil = fleetAvgUtilization(fleet, [...routes, ...(state.cargoRoutes ?? [])]);
    const evDemand = buildEventDemandModel(state.activeEvents);
    return routes.map(route => {
    const a    = fleet.find(x => x.id === route.aircraftId);
    const type = a ? getAircraftType(a.typeId) : null;
    if (!a || !type) return null;
    // Simulate with the engine's labor + fuel multiplier so costs match; use the
    // engine's BOOKED revenue (incl. connecting feed + demand lifts) for RASK/yield.
    const raw = simulateRoute(route, a, gd, labor, proj.fuelMultiplier, null, [], avgUtil, state.satisfaction ?? null,
      evDemand.multFor(route.origin, route.destination));
    if (!raw) return null;
    const result = { ...raw, revenue: proj.revById[route.id] ?? raw.revenue };
    const ue = calcUnitEconomics(route, a, type, result, fleet, routes);
    return { route, aircraft: a, type, result, ue };
  }).filter(Boolean); }, [routes, fleet, state.week, proj]);  // eslint-disable-line

  const totASK    = routeData.reduce((s, r) => s + r.ue.ASK, 0);
  const totRPK    = routeData.reduce((s, r) => s + r.ue.RPK, 0);
  const totRev    = routeData.reduce((s, r) => s + r.result.revenue, 0);
  const totCostFull = routeData.reduce((s, r) => s + r.result.totalOpCost + r.ue.allocatedFleet, 0);
  const fleetRASK = totASK > 0 ? totRev / totASK : 0;
  const fleetCASK = totASK > 0 ? totCostFull / totASK : 0;
  const fleetYield = totRPK > 0 ? totRev / totRPK : 0;
  const overallLF = totASK > 0 ? totRPK / totASK : 0;
  const opRatio   = totRev > 0 ? totCostFull / totRev : 0;

  const sortedRoutes = [...routeData].sort((a, b) => {
    const val = r => {
      switch(sortKey) {
        case 'spread': return r.ue.RASK - r.ue.CASKfull;
        case 'rask':   return r.ue.RASK;
        case 'cask':   return r.ue.CASKfull;
        case 'lf':     return r.result.loadFactor;
        case 'bep':    return r.ue.breakEvenLF;
        default:       return r.result.revenue;
      }
    };
    return sortDir * (val(a) - val(b));
  });

  function SortTH({ col, label }) {
    const active = sortKey === col;
    return (
      <th style={{ textAlign: 'right', cursor: 'pointer', userSelect: 'none',
        color: active ? 'var(--accent)' : undefined }}
        onClick={() => { setSortKey(col); setSortDir(d => sortKey === col ? -d : -1); }}>
        {label}{active ? (sortDir > 0 ? ' ↑' : ' ↓') : ''}
      </th>
    );
  }

  if (routeData.length === 0) {
    return <div className="empty-state"><div className="empty-state-icon"><Glyph e="📐" /></div><div className="empty-state-text">No active routes.</div></div>;
  }

  return (
    <div>
      <div className="stat-grid" style={{ marginBottom: 16 }}>
        <StatBox label="Fleet RASK"      value={`$${fleetRASK.toFixed(3)}/seat-km`} color="green" />
        <StatBox label="Fleet CASK"      value={`$${fleetCASK.toFixed(3)}/seat-km`} color="red"   />
        <StatBox label="RASK − CASK"     value={`$${(fleetRASK-fleetCASK).toFixed(3)}`} color={(fleetRASK-fleetCASK)>=0?'green':'red'} />
        <StatBox label="Yield"           value={`$${fleetYield.toFixed(3)}/pax-km`} color="blue"  />
        <StatBox label="System Load"     value={formatPercent(overallLF)} color={overallLF>.7?'green':overallLF>.45?'yellow':'red'} />
        <StatBox label="Operating Ratio" value={formatPercent(opRatio)}   color={opRatio<1?'green':'red'} />
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, display: 'flex', gap: 18, flexWrap: 'wrap' }}>
        <span><strong style={{ color: 'var(--text)' }}>RASK</strong> Revenue / Available Seat-km</span>
        <span><strong style={{ color: 'var(--text)' }}>CASK</strong> All-in Cost / Available Seat-km (incl. allocated fleet)</span>
        <span><strong style={{ color: 'var(--text)' }}>BEP</strong> Break-even Load Factor</span>
        <span><strong style={{ color: 'var(--text)' }}>Grade</strong> A≥+0.020 · B≥+0.010 · C≥0 · D=loss</span>
      </div>
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table>
          <thead>
            <tr>
              <th>Route</th>
              <th style={{ textAlign: 'right' }}>ASK/wk</th>
              <SortTH col="rask"   label="RASK" />
              <SortTH col="cask"   label="CASK" />
              <SortTH col="spread" label="Spread" />
              <SortTH col="lf"     label="Load%" />
              <SortTH col="bep"    label="BEP" />
              <th style={{ textAlign: 'right' }}>Status</th>
              <th style={{ textAlign: 'center' }}>Grade</th>
            </tr>
          </thead>
          <tbody>
            {sortedRoutes.map(({ route, type, result, ue }) => {
              const spread   = ue.RASK - ue.CASKfull;
              const grade    = routeGrade(spread);
              const aboveBEP = result.loadFactor >= ue.breakEvenLF;
              return (
                <tr key={route.id}>
                  <td>
                    <strong>{route.origin}→{route.destination}</strong>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{type?.name} · {route.weeklyFrequency}×/wk · {result.distance.toLocaleString()}km</div>
                  </td>
                  <td style={{ textAlign: 'right', fontSize: 12 }}>{(ue.ASK/1000).toFixed(0)}K</td>
                  <td style={{ textAlign: 'right', fontSize: 13, fontFamily: 'monospace', color: 'var(--green)' }}>${ue.RASK.toFixed(3)}</td>
                  <td style={{ textAlign: 'right', fontSize: 13, fontFamily: 'monospace', color: 'var(--red)'   }}>${ue.CASKfull.toFixed(3)}</td>
                  <td style={{ textAlign: 'right', fontSize: 13, fontFamily: 'monospace', fontWeight: 600,
                    color: spread > 0.01 ? 'var(--green)' : spread > 0 ? 'var(--yellow)' : 'var(--red)' }}>
                    {spread >= 0 ? '+' : ''}${spread.toFixed(3)}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <span style={{ color: result.loadFactor>.75?'var(--green)':result.loadFactor>.45?'var(--yellow)':'var(--red)' }}>
                      {formatPercent(result.loadFactor)}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right', color: 'var(--text-muted)', fontSize: 12 }}>{formatPercent(ue.breakEvenLF)}</td>
                  <td style={{ textAlign: 'right' }}>
                    <span className="badge" style={{ background: aboveBEP?'rgba(63,185,80,.12)':'rgba(248,81,73,.12)', color: aboveBEP?'var(--green)':'var(--red)' }}>
                      <GlyphLabel size={11} text={aboveBEP ? '✓ Above BEP' : '✗ Below BEP'} />
                    </span>
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    <span style={{ display: 'inline-block', width: 28, height: 28, borderRadius: 6, lineHeight: '28px', textAlign: 'center',
                      background: grade.color + '22', color: grade.color, fontWeight: 800, fontSize: 14, border: `1px solid ${grade.color}44` }}>
                      {grade.label}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── 12-Week Forecast ─────────────────────────────────────────────────────────

const MONTH_NAMES = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function Forecast({ proj }) {
  const { state } = useGame();
  const { fleet, routes, cash } = state;
  const gd = currentGameDate(state);

  // Demand multipliers shown in the "revenue multipliers applied" banner below.
  // (baseRevenue itself already bakes these in via the engine projection.)
  const awarenessMultiplier = awarenessDemandMultiplier(state.awareness ?? 5);
  const globalDemandMult = (state.activeEvents ?? []).reduce((m, ev) => {
    const fx = ev.effects ?? {};
    return fx.globalDemandMult ? m * fx.globalDemandMult : m;
  }, 1.0);

  // Current fuel multiplier (from fuel index + hedging)
  const fuelMultiplier = state.fuelMultiplier ?? 1.0;

  const fcLaborState  = state.labor ?? DEFAULT_LABOR_STATE;
  const fcAvgUtil     = fleetAvgUtilization(fleet, [...routes, ...(state.cargoRoutes ?? [])]);
  const routeData = routes.map(r => {
    const a = fleet.find(x => x.id === r.aircraftId);
    return a ? simulateRoute(r, a, gd, fcLaborState, fuelMultiplier, null, [], fcAvgUtil, state.satisfaction ?? null) : null;
  }).filter(Boolean);

  // ── Canonical current-week baseline (same engine the other tabs use) ───────
  // baseRevenue includes connecting feed + partner O&D + all demand lifts/events.
  // baseFixed = everything in the engine's weekly cost EXCEPT variable op-cost and
  // distribution (those are recomputed per forecast week so they scale with revenue).
  const fcReport    = proj.report;
  const baseRevenue = proj.effectiveRevenue;
  const baseOpCost  = fcReport.totalOpCost;
  const baseFixed   = fcReport.totalCost - fcReport.totalOpCost - fcReport.totalDistributionCost;

  // Revenue-weighted fleet seasonal factor for a given month.
  // Each route contributes its own seasonal profile, weighted by its current-month revenue.
  const fleetSeasonalAt = (month) => {
    if (routeData.length === 0) return 1;
    let totalW = 0, totalWS = 0;
    routes.forEach((r, idx) => {
      const rev = routeData[idx]?.revenue ?? 0;
      if (rev <= 0) return;
      const factor = getSeasonalProfile(r.origin, r.destination)[month] ?? 1;
      totalW  += rev;
      totalWS += rev * factor;
    });
    return totalW > 0 ? totalWS / totalW : 1;
  };

  const currentSeasonal = fleetSeasonalAt(gd.month);
  const absWeekBase     = (state.year - 1) * 52 + state.week;

  // Weekly loan payments (fixed schedule — decrement weeksRemaining each forecast week)
  const CORPORATE_TAX_RATE = 0.21;
  const activeLoansSnapshot = (state.loans ?? []).filter(l => l.weeksRemaining > 0);

  const fcDepreciation = proj.depreciation;   // non-cash, constant across the horizon
  let runningCash = cash;
  let runningLoans = activeLoansSnapshot.map(l => ({ ...l }));
  const forecastWeeks = Array.from({ length: 12 }, (_, i) => {
    const offset       = i + 1;
    const month        = futureMonth(absWeekBase, offset);
    const seasonal     = fleetSeasonalAt(month);
    const adjRev       = Math.round(baseRevenue * (seasonal / currentSeasonal));
    const adjOpCost    = Math.round(baseOpCost  * (seasonal / currentSeasonal));
    const distribution = Math.round(adjRev * DISTRIBUTION_COST_PCT);
    const totalCost    = adjOpCost + baseFixed + distribution;
    // Loan payments due this week, split into interest (deductible) vs principal.
    let loanPayments = 0, loanInterest = 0;
    for (const l of runningLoans) {
      if (l.weeksRemaining <= 0) continue;
      const r = l.interestRate / 52;
      const bal = r > 0 ? Math.round(l.weeklyPayment * (1 - Math.pow(1 + r, -l.weeksRemaining)) / r) : l.weeklyPayment * l.weeksRemaining;
      loanPayments += l.weeklyPayment;
      loanInterest += Math.round(bal * r);
    }
    runningLoans = runningLoans.map(l => ({ ...l, weeksRemaining: Math.max(0, l.weeksRemaining - 1) }));
    // Tax on EBT (− depreciation − interest); cash net subtracts the full payment.
    const taxBase      = adjRev - totalCost - fcDepreciation - loanInterest;
    const tax          = Math.round(Math.max(0, taxBase) * CORPORATE_TAX_RATE);
    const net          = adjRev - totalCost - loanPayments - tax;
    runningCash       += net;
    return { offset, month, seasonal, adjRev, totalCost, loanPayments, tax, net, cash: runningCash };
  });

  const firstNeg  = forecastWeeks.find(w => w.cash < 0);
  const bestWeek  = forecastWeeks.reduce((b, w) => w.adjRev > b.adjRev ? w : b, forecastWeeks[0]);
  const worstWeek = forecastWeeks.reduce((b, w) => w.adjRev < b.adjRev ? w : b, forecastWeeks[0]);

  const W = 560, H = 100, PAD = 6;
  const cashVals = [cash, ...forecastWeeks.map(w => w.cash)];
  const minV = Math.min(...cashVals), maxV = Math.max(...cashVals);
  const range = maxV - minV || 1;
  const toY = v => PAD + (H - PAD * 2) - ((v - minV) / range) * (H - PAD * 2);
  const toX = i => (i / (cashVals.length - 1)) * W;
  const cashPts = cashVals.map((v, i) => `${toX(i)},${toY(v)}`).join(' ');
  const zeroY = toY(0);

  return (
    <div>
      {firstNeg ? (
        <div style={{ padding: '10px 14px', borderRadius: 8, background: 'rgba(248,81,73,.1)', border: '1px solid rgba(248,81,73,.3)', marginBottom: 14, fontSize: 13, color: 'var(--red)' }}>
          <Glyph e="⚠" /> <strong>Cash Warning:</strong> At current trajectory, cash turns negative in Week +{firstNeg.offset} ({MONTH_NAMES[firstNeg.month]}).
        </div>
      ) : baseRevenue > 0 && (
        <div style={{ padding: '10px 14px', borderRadius: 8, background: 'rgba(63,185,80,.08)', border: '1px solid rgba(63,185,80,.2)', marginBottom: 14, fontSize: 13, color: 'var(--green)' }}>
          <Glyph e="✓" /> Cash stays positive across all 12 forecast weeks.
        </div>
      )}

      {(globalDemandMult !== 1 || awarenessMultiplier < 0.95) && (
        <div style={{ padding: '10px 14px', borderRadius: 8, background: 'rgba(210,153,34,.08)', border: '1px solid rgba(210,153,34,.25)', marginBottom: 14, fontSize: 12, color: 'var(--yellow)', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <span><Glyph e="⚡" /> Revenue multipliers applied to this forecast:</span>
          {globalDemandMult !== 1 && <span>Events {globalDemandMult > 1 ? '+' : ''}{formatPercent(globalDemandMult - 1)}</span>}
          {awarenessMultiplier < 0.95 && <span>Awareness {formatPercent(awarenessMultiplier)} of max</span>}
          {awarenessMultiplier > 1 && <span>Awareness +{formatPercent(awarenessMultiplier - 1)}</span>}
          <span style={{ color: 'var(--text-dim)' }}>Events end when they expire — future weeks may differ.</span>
        </div>
      )}

      <div className="stat-grid" style={{ marginBottom: 16 }}>
        <StatBox label="Cash Now"             value={formatMoney(cash)} color={cash>=0?'green':'red'} />
        <StatBox label="Projected Week +12"   value={formatMoney(forecastWeeks[11]?.cash ?? cash)} color={(forecastWeeks[11]?.cash??cash)>=0?'green':'red'} />
        <StatBox label="Peak Revenue"         value={`${MONTH_NAMES[bestWeek?.month]}  ${formatMoney(bestWeek?.adjRev)}`} color="blue" />
        <StatBox label="Trough Revenue"       value={`${MONTH_NAMES[worstWeek?.month]}  ${formatMoney(worstWeek?.adjRev)}`} color="yellow" />
      </div>

      <div className="card">
        <div className="card-title">Projected Cash Balance — Next 12 Weeks</div>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: H }}>
          {zeroY > PAD && zeroY < H - PAD && (
            <line x1={0} y1={zeroY} x2={W} y2={zeroY} stroke="var(--red)" strokeDasharray="3,3" strokeWidth="1" opacity="0.5" />
          )}
          <circle cx={toX(0)} cy={toY(cash)} r={4} fill="var(--accent)" />
          <polyline points={cashPts} fill="none" stroke={firstNeg ? 'var(--red)' : 'var(--green)'} strokeWidth="2" strokeLinejoin="round" />
          <circle cx={toX(cashVals.length-1)} cy={toY(cashVals[cashVals.length-1])} r={4} fill={firstNeg?'var(--red)':'var(--green)'} />
        </svg>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
          <span>Now · {formatMoney(cash)}</span>
          <span>+12wk · {formatMoney(forecastWeeks[11]?.cash ?? cash)}</span>
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table>
          <thead>
            <tr>
              <th>Week</th><th>Month</th>
              <th style={{ textAlign: 'right' }}>Seasonality</th>
              <th style={{ textAlign: 'right' }}>Revenue</th>
              <th style={{ textAlign: 'right' }}>Op Costs</th>
              {activeLoansSnapshot.length > 0 && <th style={{ textAlign: 'right' }}>Loans</th>}
              <th style={{ textAlign: 'right' }}>Tax</th>
              <th style={{ textAlign: 'right' }}>Net</th>
              <th style={{ textAlign: 'right' }}>Cash</th>
            </tr>
          </thead>
          <tbody>
            {forecastWeeks.map(w => (
              <tr key={w.offset} style={{ background: w.cash < 0 ? 'rgba(248,81,73,.06)' : undefined }}>
                <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>+{w.offset}</td>
                <td style={{ fontSize: 12 }}>{MONTH_NAMES[w.month]}</td>
                <td style={{ textAlign: 'right', fontSize: 12, color: w.seasonal>1.1?'var(--green)':w.seasonal<0.9?'var(--red)':'var(--text-muted)' }}>
                  {w.seasonal > 1 ? '+' : ''}{formatPercent(w.seasonal - 1)}
                </td>
                <td style={{ textAlign: 'right', color: 'var(--green)', fontSize: 13 }}>{formatMoney(w.adjRev)}</td>
                <td style={{ textAlign: 'right', color: 'var(--red)',   fontSize: 13 }}>{formatMoney(w.totalCost)}</td>
                {activeLoansSnapshot.length > 0 && (
                  <td style={{ textAlign: 'right', color: 'var(--red)', fontSize: 13 }}>{w.loanPayments > 0 ? formatMoney(w.loanPayments) : '—'}</td>
                )}
                <td style={{ textAlign: 'right', color: 'var(--red)', fontSize: 13 }}>{w.tax > 0 ? formatMoney(w.tax) : '—'}</td>
                <td style={{ textAlign: 'right', fontWeight: 600, fontSize: 13, color: w.net>=0?'var(--green)':'var(--red)' }}>
                  {w.net>=0?'+':''}{formatMoney(w.net)}
                </td>
                <td style={{ textAlign: 'right', fontSize: 13, color: w.cash>=0?'var(--text)':'var(--red)', fontWeight: w.cash<0?700:400 }}>
                  {formatMoney(w.cash)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6 }}>
        Revenue and op costs adjusted for seasonality. Fixed costs (leases, maintenance, gates) held constant.
      </div>
    </div>
  );
}

// ─── Trends ───────────────────────────────────────────────────────────────────

function MultiLineChart({ series, height = 100 }) {
  const W = 560, H = height, PAD = 6;
  const allVals = series.flatMap(s => s.values);
  const minV = Math.min(...allVals), maxV = Math.max(...allVals);
  const range = maxV - minV || 1;
  const toY = v => PAD + (H - PAD * 2) - ((v - minV) / range) * (H - PAD * 2);
  const toX = i => series[0]?.values.length > 1 ? (i / (series[0].values.length - 1)) * W : W/2;
  const zeroY = toY(0);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: H }}>
      {zeroY > PAD && zeroY < H - PAD && (
        <line x1={0} y1={zeroY} x2={W} y2={zeroY} stroke="var(--border)" strokeDasharray="3,3" strokeWidth="1" />
      )}
      {series.map(s => (
        <polyline key={s.label}
          points={s.values.map((v, i) => `${toX(i)},${toY(v)}`).join(' ')}
          fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" />
      ))}
    </svg>
  );
}

function Trends() {
  const { state } = useGame();
  const hist = state.financialHistory;

  if (hist.length < 2) {
    return <div className="empty-state"><div className="empty-state-icon"><Glyph e="📈" /></div><div className="empty-state-text">Trends appear once 2 weeks of history exist.</div></div>;
  }

  const last = hist[hist.length - 1];
  const prev = hist[hist.length - 2];
  const wow  = key => prev?.[key] ? (last[key] - prev[key]) / Math.abs(prev[key]) : 0;

  const displayN   = Math.min(hist.length, 20);
  const recent     = hist.slice(-displayN);

  // 4-week moving average for profit
  const profitMA = hist.map((_, i) => {
    const slice = hist.slice(Math.max(0, i - 3), i + 1);
    return slice.reduce((s, h) => s + (h.profit ?? 0), 0) / slice.length;
  }).slice(-displayN);

  // Trend alerts
  const last4Cash   = hist.slice(-4).map(h => h.cash ?? 0);
  const last4Profit = hist.slice(-4).map(h => h.profit ?? 0);
  const cashDecline   = last4Cash.length   >= 3 && last4Cash.every((v, i)   => i === 0 || v < last4Cash[i-1]);
  const profitDecline = last4Profit.length >= 3 && last4Profit.every((v, i) => i === 0 || v < last4Profit[i-1]);

  return (
    <div>
      {cashDecline && (
        <div style={{ padding: '10px 14px', borderRadius: 8, background: 'rgba(248,81,73,.1)', border: '1px solid rgba(248,81,73,.3)', marginBottom: 12, fontSize: 13, color: 'var(--red)' }}>
          <Glyph e="⚠" /> <strong>Cash declining</strong> for {last4Cash.length} consecutive weeks.
        </div>
      )}
      {profitDecline && !cashDecline && (
        <div style={{ padding: '10px 14px', borderRadius: 8, background: 'rgba(210,153,34,.1)', border: '1px solid rgba(210,153,34,.3)', marginBottom: 12, fontSize: 13, color: 'var(--yellow)' }}>
          <Glyph e="⚠" /> Profit trending downward for {last4Profit.length} weeks.
        </div>
      )}

      {/* WoW KPIs */}
      <div className="stat-grid" style={{ marginBottom: 20 }}>
        {[
          { label: 'Revenue', val: last.revenue, wk: wow('revenue'), c: 'green' },
          { label: 'Total Cost', val: last.totalCost, wk: wow('totalCost'), c: 'red' },
          { label: 'Net Income', val: last.profit,  wk: wow('profit'),  c: (last.profit??0)>=0?'green':'red' },
          { label: 'Cash',       val: last.cash,    wk: wow('cash'),    c: (last.cash??0)>=0?'green':'red'   },
        ].map(m => (
          <div className="stat-box" key={m.label}>
            <div className="stat-label">{m.label}</div>
            <div className={`stat-value ${m.c}`} style={{ fontSize: 18 }}>{formatMoney(m.val ?? 0)}</div>
            <div style={{ fontSize: 11, marginTop: 4, color: m.wk >= 0 ? 'var(--green)' : 'var(--red)' }}>
              {m.wk >= 0 ? '▲' : '▼'} {formatPercent(Math.abs(m.wk))} vs last week
            </div>
          </div>
        ))}
      </div>

      {/* Revenue / Cost / Profit chart */}
      <div className="card">
        <div className="card-title">Revenue, Costs & Net (last {displayN} weeks)</div>
        <MultiLineChart height={110} series={[
          { label: 'Revenue',    values: recent.map(h => h.revenue   ?? 0), color: 'var(--green)'  },
          { label: 'Total Cost', values: recent.map(h => h.totalCost ?? 0), color: 'var(--red)'    },
          { label: 'Net (MA)',   values: profitMA,                           color: 'var(--accent)' },
        ]} />
        <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 12 }}>
          {[['var(--green)', 'Revenue'], ['var(--red)', 'Total Cost'], ['var(--accent)', 'Net (4-wk MA)']].map(([c, l]) => (
            <span key={l} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 14, height: 2, background: c, display: 'inline-block' }} />
              <span style={{ color: 'var(--text-muted)' }}>{l}</span>
            </span>
          ))}
        </div>
      </div>

      {/* Cash chart */}
      <div className="card">
        <div className="card-title">Cash Balance (all time)</div>
        <MultiLineChart height={80} series={[
          { label: 'Cash', values: hist.map(h => h.cash ?? 0), color: (last.cash ?? 0) >= 0 ? 'var(--accent)' : 'var(--red)' },
        ]} />
      </div>

      {/* History table */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table>
          <thead>
            <tr>
              <th>Week</th>
              <th style={{ textAlign: 'right' }}>Revenue</th>
              <th style={{ textAlign: 'right' }}>Leases</th>
              <th style={{ textAlign: 'right' }}>Maint</th>
              <th style={{ textAlign: 'right' }}>Fuel+Crew</th>
              <th style={{ textAlign: 'right' }}>Net</th>
              <th style={{ textAlign: 'right' }}>Cash</th>
            </tr>
          </thead>
          <tbody>
            {recent.slice().reverse().map((h, i) => {
              const fc = (h.fuel ?? 0) + (h.crew ?? 0) + (h.quality ?? 0);
              return (
                <tr key={i}>
                  <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{h.label}</td>
                  <td style={{ textAlign: 'right', color: 'var(--green)',  fontSize: 13 }}>{formatMoney(h.revenue    ?? 0)}</td>
                  <td style={{ textAlign: 'right', color: 'var(--red)',    fontSize: 12 }}>{formatMoney(h.leases     ?? 0)}</td>
                  <td style={{ textAlign: 'right', color: 'var(--yellow)', fontSize: 12 }}>{formatMoney(h.maintenance ?? 0)}</td>
                  <td style={{ textAlign: 'right', color: 'var(--text-muted)', fontSize: 12 }}>{formatMoney(fc)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600, fontSize: 13, color: (h.profit??0)>=0?'var(--green)':'var(--red)' }}>
                    {(h.profit??0)>=0?'+':''}{formatMoney(h.profit ?? 0)}
                  </td>
                  <td style={{ textAlign: 'right', fontSize: 13, color: (h.cash??0)>=0?'var(--text)':'var(--red)' }}>
                    {formatMoney(h.cash ?? 0)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Statistics ─────────────────────────────────────────────────────────────
// Long-term KPI charts driven by state.statsHistory (a compact per-week series
// retained for up to 35 game years — see STATS_HISTORY_CAP in the engine).

const STAT_COLORS = {
  organic:   '#38d39f',   // direct O&D
  connecting:'#3ea6ff',   // own-hub connections
  interline: '#ffb43d',   // partner-fed (interline / codeshare)
  routes:    '#38d39f',
  flights:   '#3ea6ff',
  dests:     '#c792ea',
  fleet:     '#ffb43d',
  revenue:   '#38d39f',
  cost:      '#ff5d6c',
  profit:    '#3ea6ff',
  passRev:   '#38d39f',
  partnerRev:'#ffb43d',
  cargoRev:  '#c792ea',
  lf:        '#3ea6ff',
  yield:     '#38d39f',
  ask:       '#c792ea',
};

const STAT_PERIODS = [
  { id: '4',    label: '4 wks',  weeks: 4    },
  { id: '12',   label: '12 wks', weeks: 12   },
  { id: '26',   label: '6 mo',   weeks: 26   },
  { id: '52',   label: '12 mo',  weeks: 52   },
  { id: '156',  label: '3 yr',   weeks: 156  },
  { id: '260',  label: '5 yr',   weeks: 260  },
  { id: '520',  label: '10 yr',  weeks: 520  },
  { id: '1040', label: '20 yr',  weeks: 1040 },
  { id: '1560', label: '30 yr',  weeks: 1560 },
  { id: 'all',  label: 'All',    weeks: Infinity },
];

/** Bucket a long series down to <= maxPoints. Flows are averaged to per-week
 *  units (so the y-axis stays in per-week terms regardless of bucket width);
 *  stocks take the bucket's last value. */
function downsampleStats(rows, maxPoints = 150) {
  if (rows.length <= maxPoints) return rows.map(r => ({ ...r, _n: 1 }));
  const bucket = Math.ceil(rows.length / maxPoints);
  const out = [];
  for (let i = 0; i < rows.length; i += bucket) {
    const slice = rows.slice(i, i + bucket);
    const n = slice.length;
    const last = slice[n - 1];
    const avg = k => slice.reduce((s, r) => s + (r[k] ?? 0), 0) / n;
    out.push({
      label: last.label, week: last.week, year: last.year, absWeek: last.absWeek,
      // flows → per-week average
      paxOrganic: avg('paxOrganic'), paxConnecting: avg('paxConnecting'), paxInterline: avg('paxInterline'),
      flights: avg('flights'), revenue: avg('revenue'), partnerRevenue: avg('partnerRevenue'),
      cargoRevenue: avg('cargoRevenue'), cost: avg('cost'), profit: avg('profit'),
      // stocks → last in bucket
      routes: last.routes, destinations: last.destinations, fleet: last.fleet, cash: last.cash,
      // efficiency → average
      loadFactor: avg('loadFactor'), yield: avg('yield'), ask: avg('ask'),
      partial: slice.some(r => r.partial),
      _n: n,
    });
  }
  return out;
}

const fmtInt = v => Math.round(v).toLocaleString();

/** Flexible SVG chart: stacked areas and/or lines, zero baseline, x-axis ticks,
 *  and a hover crosshair + tooltip. `series` items: { key, label, color, kind }.
 *  kind 'area' entries stack; kind 'line' entries draw on top. */
function StatChart({ points, series, height = 150, yFrom0 = true, format = fmtInt, wideLabels = false }) {
  const [hover, setHover] = useState(null);
  const W = 660, H = height, PADL = 6, PADR = 6, PADT = 10, PADB = 18;
  const n = points.length;
  const areas = series.filter(s => s.kind === 'area');
  const lines = series.filter(s => s.kind !== 'area');

  if (n === 0) return null;

  let maxV = -Infinity, minV = Infinity;
  for (const p of points) {
    const stackTot = areas.reduce((s, se) => s + (p[se.key] ?? 0), 0);
    if (stackTot > maxV) maxV = stackTot;
    if (stackTot < minV) minV = stackTot;
    for (const se of lines) {
      const v = p[se.key] ?? 0;
      if (v > maxV) maxV = v;
      if (v < minV) minV = v;
    }
  }
  if (yFrom0) minV = Math.min(0, minV);
  if (!isFinite(maxV)) { maxV = 1; minV = 0; }
  if (maxV === minV) maxV = minV + 1;
  const range = maxV - minV;
  const plotH = H - PADT - PADB, plotW = W - PADL - PADR;
  const toY = v => PADT + plotH - ((v - minV) / range) * plotH;
  const toX = i => (n > 1 ? PADL + (i / (n - 1)) * plotW : PADL + plotW / 2);
  const zeroY = toY(0);

  // Stacked area paths (cumulative from the baseline up).
  const areaPaths = [];
  if (areas.length) {
    const cum = new Array(n).fill(0);
    for (const se of areas) {
      const pts = points.map((p, i) => {
        const base = cum[i];
        const top = base + (p[se.key] ?? 0);
        cum[i] = top;
        return { i, base, top };
      });
      const upper = pts.map(t => `${toX(t.i)},${toY(t.top)}`);
      const lower = pts.slice().reverse().map(t => `${toX(t.i)},${toY(t.base)}`);
      areaPaths.push({ se, d: `M ${upper.join(' L ')} L ${lower.join(' L ')} Z` });
    }
  }

  const tickIdx = n <= 1 ? [0] : Array.from(new Set([0, Math.floor((n - 1) / 3), Math.floor((2 * (n - 1)) / 3), n - 1]));

  const onMove = e => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const relX = ((e.clientX - rect.left) / rect.width) * W;
    let i = Math.round(((relX - PADL) / plotW) * (n - 1));
    i = Math.max(0, Math.min(n - 1, i));
    setHover({ i, px: e.clientX - rect.left, wpx: rect.width });
  };

  const hp = hover ? points[hover.i] : null;

  return (
    <div style={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: H, display: 'block' }}
        onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {zeroY > PADT && zeroY < H - PADB && (
          <line x1={PADL} y1={zeroY} x2={W - PADR} y2={zeroY} stroke="var(--border)" strokeDasharray="3,3" strokeWidth="1" />
        )}
        {areaPaths.map(a => (
          <path key={a.se.key} d={a.d} fill={a.se.color} opacity="0.82" stroke={a.se.color} strokeWidth="0.5" />
        ))}
        {lines.map(se => (
          <polyline key={se.key} fill="none" stroke={se.color} strokeWidth="2" strokeLinejoin="round"
            points={points.map((p, i) => `${toX(i)},${toY(p[se.key] ?? 0)}`).join(' ')} />
        ))}
        {hover && (
          <g>
            <line x1={toX(hover.i)} y1={PADT} x2={toX(hover.i)} y2={H - PADB} stroke="var(--text-muted)" strokeWidth="1" opacity="0.5" />
            {lines.map(se => (
              <circle key={se.key} cx={toX(hover.i)} cy={toY(hp[se.key] ?? 0)} r="3" fill={se.color} />
            ))}
          </g>
        )}
        {tickIdx.map(i => (
          <text key={i} x={Math.max(PADL + 10, Math.min(W - PADR - 10, toX(i)))} y={H - 5}
            fontSize="10" fill="var(--text-muted)"
            textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}>
            {wideLabels ? `Y${points[i].year}` : (points[i].label || `Y${points[i].year}`)}
          </text>
        ))}
      </svg>
      {hover && hp && (
        <div style={{
          position: 'absolute', top: 4,
          left: hover.px > hover.wpx / 2 ? undefined : Math.min(hover.px + 12, hover.wpx - 150),
          right: hover.px > hover.wpx / 2 ? Math.min(hover.wpx - hover.px + 12, hover.wpx - 150) : undefined,
          background: 'var(--panel, #1b1f27)', border: '1px solid var(--border)', borderRadius: 8,
          padding: '7px 9px', fontSize: 11, pointerEvents: 'none', zIndex: 5, minWidth: 120, boxShadow: '0 4px 14px rgba(0,0,0,.25)',
        }}>
          <div style={{ color: 'var(--text-muted)', marginBottom: 4, fontWeight: 600 }}>{hp.label || `Year ${hp.year}`}</div>
          {series.map(se => (
            <div key={se.key} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, lineHeight: 1.5 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 9, height: 9, borderRadius: 2, background: se.color, display: 'inline-block' }} />
                <span style={{ color: 'var(--text-muted)' }}>{se.label}</span>
              </span>
              <span style={{ fontWeight: 600 }}>{format(hp[se.key] ?? 0, se)}</span>
            </div>
          ))}
          {hp._n > 1 && <div style={{ color: 'var(--text-muted)', marginTop: 4, fontSize: 10 }}>avg of {hp._n} wks</div>}
        </div>
      )}
    </div>
  );
}

function StatLegend({ items }) {
  return (
    <div style={{ display: 'flex', gap: 16, marginTop: 8, flexWrap: 'wrap', fontSize: 12 }}>
      {items.map(([color, label]) => (
        <span key={label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 12, height: 12, borderRadius: 3, background: color, display: 'inline-block' }} />
          <span style={{ color: 'var(--text-muted)' }}>{label}</span>
        </span>
      ))}
    </div>
  );
}

function Statistics() {
  const { state } = useGame();
  const all = state.statsHistory ?? [];
  const [period, setPeriod] = useState('52');

  // Which period buttons to show: everything up to the first window that already
  // covers all data, plus "All".
  const visiblePeriods = useMemo(() => {
    const out = [];
    for (const p of STAT_PERIODS) {
      if (p.id === 'all') { out.push(p); break; }
      out.push(p);
      if (p.weeks >= all.length) break;
    }
    return out;
  }, [all.length]);

  const activeId = visiblePeriods.some(p => p.id === period)
    ? period
    : visiblePeriods[visiblePeriods.length - 2]?.id ?? 'all';
  const activeWeeks = STAT_PERIODS.find(p => p.id === activeId)?.weeks ?? Infinity;

  const windowed = useMemo(
    () => (activeWeeks === Infinity ? all : all.slice(-activeWeeks)),
    [all, activeWeeks],
  );

  // Financial + passenger charts use every windowed week (partial weeks carry
  // financials + total pax as organic). Network + efficiency need real tracked
  // data, so they drop pre-tracking (partial) weeks.
  const points = useMemo(() => downsampleStats(windowed).map(p => ({
    ...p,
    paxTotal: (p.paxOrganic ?? 0) + (p.paxConnecting ?? 0) + (p.paxInterline ?? 0),
    passengerRev: Math.max(0, (p.revenue ?? 0) - (p.partnerRevenue ?? 0) - (p.cargoRevenue ?? 0)),
    lfPct: (p.loadFactor ?? 0) * 100,
    yieldCents: (p.yield ?? 0) * 100,
  })), [windowed]);

  const trackedWindow = useMemo(() => windowed.filter(r => !r.partial), [windowed]);
  // trackedPoints must carry the SAME derived fields as `points` (lfPct/yieldCents):
  // the Operating-efficiency charts and the Load Factor KPI tile read those keys, so
  // without this map Load factor and Yield plotted as 0 even though loadFactor/yield
  // are recorded correctly. ASK reads the raw `ask` key so it was unaffected.
  const trackedPoints = useMemo(() => downsampleStats(trackedWindow).map(p => ({
    ...p,
    lfPct: (p.loadFactor ?? 0) * 100,
    yieldCents: (p.yield ?? 0) * 100,
  })), [trackedWindow]);
  const wide = activeWeeks > 130 || (activeWeeks === Infinity && all.length > 130);

  if (all.length < 2) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon"><Glyph e="📊" /></div>
        <div className="empty-state-text">Statistics appear once you have at least 2 weeks of history. Advance the week to start building your KPI charts.</div>
      </div>
    );
  }

  const firstTracked = all.find(r => !r.partial);
  const hasTracked = trackedWindow.length > 0;
  const latest = points[points.length - 1] ?? {};
  const latestTracked = trackedPoints[trackedPoints.length - 1] ?? {};
  const money = v => formatMoney(Math.round(v));

  return (
    <div>
      {/* Period selector */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: 'var(--text-muted)', marginRight: 2 }}>Period:</span>
        {visiblePeriods.map(p => (
          <button key={p.id}
            className={`btn ${activeId === p.id ? 'btn-primary' : 'btn-ghost'}`}
            style={{ fontSize: 12, padding: '4px 10px' }}
            onClick={() => setPeriod(p.id)}>
            {p.label}
          </button>
        ))}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 16 }}>
        Weekly figures shown per week; longer periods are bucket-averaged for readability. Passenger split, network and efficiency data are modeled estimates.
        {firstTracked && all[0]?.partial && (
          <> Detailed tracking (passenger split, routes, efficiency) began <strong>{firstTracked.label}</strong>; earlier weeks predate this feature.</>
        )}
      </div>

      {/* KPI tiles */}
      <div className="stat-grid" style={{ marginBottom: 20 }}>
        {[
          { label: 'Weekly Passengers', val: fmtInt(latest.paxTotal ?? 0), c: '' },
          { label: 'Weekly Revenue',    val: money(latest.revenue ?? 0), c: 'green' },
          { label: 'Net Profit / wk',   val: money(latest.profit ?? 0), c: (latest.profit ?? 0) >= 0 ? 'green' : 'red' },
          { label: 'Active Routes',     val: hasTracked ? fmtInt(latestTracked.routes ?? 0) : '—', c: '' },
          { label: 'Fleet',             val: hasTracked ? fmtInt(latestTracked.fleet ?? 0) : '—', c: '' },
          { label: 'Load Factor',       val: hasTracked ? `${(latestTracked.lfPct ?? 0).toFixed(1)}%` : '—', c: '' },
        ].map(m => (
          <div className="stat-box" key={m.label}>
            <div className="stat-label">{m.label}</div>
            <div className={`stat-value ${m.c}`} style={{ fontSize: 18 }}>{m.val}</div>
          </div>
        ))}
      </div>

      {/* ── Passengers (stacked) ── */}
      <div className="card">
        <div className="card-title">Passengers per week — by source</div>
        <StatChart points={points} wideLabels={wide} format={(v) => fmtInt(v)} series={[
          { key: 'paxOrganic',    label: 'Organic (direct)',        color: STAT_COLORS.organic,    kind: 'area' },
          { key: 'paxConnecting', label: 'Connecting (own hubs)',   color: STAT_COLORS.connecting, kind: 'area' },
          { key: 'paxInterline',  label: 'Interline / codeshare',   color: STAT_COLORS.interline,  kind: 'area' },
        ]} />
        <StatLegend items={[
          [STAT_COLORS.organic, 'Organic — direct O&D'],
          [STAT_COLORS.connecting, 'Connecting — own hubs'],
          [STAT_COLORS.interline, 'Interline / codeshare — partner-fed'],
        ]} />
      </div>

      {/* ── Revenue & profit ── */}
      <div className="card">
        <div className="card-title">Revenue, cost & net profit (per week)</div>
        <StatChart points={points} wideLabels={wide} yFrom0={false} format={(v) => money(v)} series={[
          { key: 'revenue', label: 'Revenue',    color: STAT_COLORS.revenue },
          { key: 'cost',    label: 'Total cost', color: STAT_COLORS.cost },
          { key: 'profit',  label: 'Net profit', color: STAT_COLORS.profit },
        ]} />
        <StatLegend items={[[STAT_COLORS.revenue, 'Revenue'], [STAT_COLORS.cost, 'Total cost'], [STAT_COLORS.profit, 'Net profit']]} />
      </div>

      <div className="card">
        <div className="card-title">Revenue mix (per week)</div>
        <StatChart points={points} wideLabels={wide} format={(v) => money(v)} series={[
          { key: 'passengerRev', label: 'Passenger',          color: STAT_COLORS.passRev,    kind: 'area' },
          { key: 'partnerRevenue', label: 'Partner (interline)', color: STAT_COLORS.partnerRev, kind: 'area' },
          { key: 'cargoRevenue', label: 'Cargo',              color: STAT_COLORS.cargoRev,   kind: 'area' },
        ]} />
        <StatLegend items={[[STAT_COLORS.passRev, 'Passenger'], [STAT_COLORS.partnerRev, 'Partner / interline'], [STAT_COLORS.cargoRev, 'Cargo']]} />
      </div>

      {/* ── Network size ── */}
      <div className="card">
        <div className="card-title">Network size</div>
        {hasTracked ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16 }}>
            {[
              { key: 'routes',       title: 'Active routes',       color: STAT_COLORS.routes },
              { key: 'flights',      title: 'Weekly departures',   color: STAT_COLORS.flights },
              { key: 'destinations', title: 'Destinations served', color: STAT_COLORS.dests },
              { key: 'fleet',        title: 'Fleet size',          color: STAT_COLORS.fleet },
            ].map(m => (
              <div key={m.key}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>{m.title}</div>
                <StatChart points={trackedPoints} height={110} wideLabels={wide} format={(v) => fmtInt(v)}
                  series={[{ key: m.key, label: m.title, color: m.color }]} />
              </div>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '8px 0' }}>
            Network-size tracking begins on your next advanced week — check back shortly.
          </div>
        )}
      </div>

      {/* ── Efficiency ── */}
      <div className="card">
        <div className="card-title">Operating efficiency</div>
        {hasTracked ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16 }}>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Load factor</div>
              <StatChart points={trackedPoints} height={110} wideLabels={wide} format={(v) => `${v.toFixed(1)}%`}
                series={[{ key: 'lfPct', label: 'Load factor', color: STAT_COLORS.lf }]} />
            </div>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Yield (¢ per pax-km)</div>
              <StatChart points={trackedPoints} height={110} wideLabels={wide} format={(v) => `${v.toFixed(2)}¢`}
                series={[{ key: 'yieldCents', label: 'Yield', color: STAT_COLORS.yield }]} />
            </div>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Capacity (weekly ASK)</div>
              <StatChart points={trackedPoints} height={110} wideLabels={wide} format={(v) => fmtInt(v)}
                series={[{ key: 'ask', label: 'ASK', color: STAT_COLORS.ask }]} />
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '8px 0' }}>
            Efficiency tracking begins on your next advanced week — check back shortly.
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Loans ────────────────────────────────────────────────────────────────────

const LOAN_PRODUCTS = [
  {
    id: 'short',
    name: 'Short-term Loan',
    termWeeks: 13,
    baseRate: 0.08,
    maxMultiple: 4,            // max = 4× weekly revenue …
    baseMax: 5_000_000,        // … or $5M, whichever is higher (available from launch)
    description: '13-week term · up to $5M · lowest total interest',
    color: '#38d39f',
  },
  {
    id: 'medium',
    name: 'Medium-term Loan',
    termWeeks: 26,
    baseRate: 0.10,
    maxMultiple: 8,
    baseMax: 10_000_000,       // up to $10M
    description: '26-week term · up to $10M · balanced payments',
    color: '#3ea6ff',
  },
  {
    id: 'long',
    name: 'Long-term Loan',
    termWeeks: 52,
    baseRate: 0.13,
    maxMultiple: 16,
    baseMax: 20_000_000,       // up to $20M
    description: '52-week term · up to $20M · largest amounts available',
    color: '#ffb43d',
  },
];

/** Compute credit rating A–F based on financial health */
function creditRating(state, weeklyRevenue, weeklyNetIncome) {
  const loans = state.loans ?? [];
  const leasedFleet = (state.fleet ?? []).filter(a => a.ownershipType !== 'owned');
  const annualLease = leasedFleet.reduce((s, a) => {
    const t = getAircraftType(a.typeId);
    return s + (t?.weeklyLease ?? 0) * 52;
  }, 0);
  const totalLoanBalance = loans.reduce((s, l) => {
    const r = l.interestRate / 52;
    const n = l.weeksRemaining;
    return s + (r > 0 ? Math.round(l.weeklyPayment * (1 - Math.pow(1 + r, -n)) / r) : l.weeklyPayment * n);
  }, 0);
  const totalDebt = annualLease + totalLoanBalance;
  const equity    = STARTING_CAPITAL + ytd(state.financialHistory, 'profit');

  const debtToEquity = equity > 0 ? totalDebt / Math.max(equity, 1) : 99;
  const runway       = weeklyNetIncome < 0 && state.cash > 0 ? state.cash / -weeklyNetIncome : Infinity;
  const weeksOps     = state.financialHistory.length;

  let score = 100;
  if (debtToEquity > 4)   score -= 40;
  else if (debtToEquity > 2) score -= 20;
  else if (debtToEquity > 1) score -= 10;

  if (weeklyNetIncome < 0) score -= 25;
  else if (weeklyNetIncome < weeklyRevenue * 0.05) score -= 10;

  if (isFinite(runway) && runway < 4)  score -= 30;
  else if (isFinite(runway) && runway < 12) score -= 15;

  if (weeksOps < 4)  score -= 15;
  else if (weeksOps < 12) score -= 5;

  if      (score >= 85) return { grade: 'A', label: 'Excellent',  color: '#38d39f', rateBonus: -0.02 };
  else if (score >= 70) return { grade: 'B', label: 'Good',       color: '#4fc3f7', rateBonus: -0.01 };
  else if (score >= 55) return { grade: 'C', label: 'Fair',       color: '#ffb43d', rateBonus:  0.00 };
  else if (score >= 40) return { grade: 'D', label: 'Poor',       color: '#f0883e', rateBonus:  0.02 };
  else                  return { grade: 'F', label: 'High Risk',  color: '#ff5d6c', rateBonus:  0.05 };
}

/** Amortized weekly payment */
function calcWeeklyPayment(principal, annualRate, termWeeks) {
  const r = annualRate / 52;
  if (r <= 0) return Math.round(principal / termWeeks);
  return Math.round(principal * r * Math.pow(1 + r, termWeeks) / (Math.pow(1 + r, termWeeks) - 1));
}

/** Outstanding principal balance */
function outstandingBalance(loan) {
  const r = loan.interestRate / 52;
  const n = loan.weeksRemaining;
  return r > 0
    ? Math.round(loan.weeklyPayment * (1 - Math.pow(1 + r, -n)) / r)
    : loan.weeklyPayment * n;
}

function Loans({ proj }) {
  const { state, dispatch } = useGame();
  const { cash } = state;
  const activeLoans = state.loans ?? [];

  // Credit scoring uses the canonical projection so revenue and net income reflect
  // ALL costs (labor, gates, HQ, insurance, distribution, loyalty, partner fees …),
  // not just leases + maintenance + op-cost as before.
  const weeklyRevenue   = proj.effectiveRevenue;
  const weeklyNetIncome = proj.netCash;   // after all costs, loans and tax
  const weeklyLoanPayments = proj.loanPayments;

  const credit = creditRating(state, weeklyRevenue, weeklyNetIncome);

  // Loan form state
  const [selectedProduct, setSelectedProduct] = useState('medium');
  const [loanAmount, setLoanAmount] = useState('');
  const [showConfirm, setShowConfirm] = useState(false);

  const product = LOAN_PRODUCTS.find(p => p.id === selectedProduct);
  const effectiveRate = product ? Math.max(0.03, product.baseRate + credit.rateBonus) : 0;
  // Each product offers a guaranteed headline amount (baseMax: $5M/$10M/$20M) that's
  // available even to a brand-new airline with no revenue yet; higher weekly revenue
  // can unlock more (revenue × multiple).
  const revenueMax = weeklyRevenue > 0 ? Math.floor(weeklyRevenue * product.maxMultiple / 1000) * 1000 : 0;
  const maxAmount = Math.max(product.baseMax ?? 500_000, revenueMax);
  const parsedAmount = parseInt(loanAmount.replace(/[^0-9]/g, ''), 10) || 0;
  const weeklyPayment = parsedAmount > 0 ? calcWeeklyPayment(parsedAmount, effectiveRate, product.termWeeks) : 0;
  const totalInterest = weeklyPayment > 0 ? weeklyPayment * product.termWeeks - parsedAmount : 0;
  const totalLoanDebt = activeLoans.reduce((s, l) => s + outstandingBalance(l), 0);
  const canBorrow = parsedAmount >= 10_000 && parsedAmount <= maxAmount && parsedAmount <= maxAmount;

  function handleTakeLoan() {
    dispatch({ type: 'TAKE_LOAN', principal: parsedAmount, interestRate: effectiveRate, termWeeks: product.termWeeks });
    setLoanAmount('');
    setShowConfirm(false);
  }

  return (
    <div>
      {/* Credit summary */}
      <div className="stat-grid" style={{ marginBottom: 20 }}>
        <div className="stat-box">
          <div className="stat-label">Credit Rating</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
            <span style={{
              display: 'inline-block', width: 42, height: 42, borderRadius: 8, lineHeight: '42px',
              textAlign: 'center', fontWeight: 800, fontSize: 22,
              background: credit.color + '22', color: credit.color, border: `1px solid ${credit.color}44`
            }}>{credit.grade}</span>
            <span style={{ color: credit.color, fontWeight: 600 }}>{credit.label}</span>
          </div>
        </div>
        <StatBox label="Active Loans"       value={activeLoans.length}              color="blue" />
        <StatBox label="Total Debt (loans)" value={formatMoney(totalLoanDebt)}      color={totalLoanDebt > 0 ? 'red' : 'green'} />
        <StatBox label="Weekly Repayments"  value={formatMoney(weeklyLoanPayments)} color={weeklyLoanPayments > 0 ? 'red' : 'green'} />
      </div>

      {/* Active loans */}
      {activeLoans.length > 0 && (
        <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 20 }}>
          <table>
            <thead>
              <tr>
                <th>Loan</th>
                <th style={{ textAlign: 'right' }}>Original</th>
                <th style={{ textAlign: 'right' }}>Balance</th>
                <th style={{ textAlign: 'right' }}>Rate</th>
                <th style={{ textAlign: 'right' }}>Wkly Payment</th>
                <th style={{ textAlign: 'right' }}>Weeks Left</th>
                <th style={{ textAlign: 'right' }}>Interest Paid</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {activeLoans.map(loan => {
                const balance = outstandingBalance(loan);
                const penalty = Math.round(balance * 0.02);
                const earlyTotal = balance + penalty;
                const progress = 1 - loan.weeksRemaining / loan.termWeeks;
                const canRepayEarly = cash >= earlyTotal;
                return (
                  <tr key={loan.id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>
                        {loan.termWeeks}-week loan
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                        Taken W{loan.takenWeek}/{loan.takenYear}
                      </div>
                      <div style={{ marginTop: 4, height: 4, borderRadius: 2, background: 'var(--surface2)', overflow: 'hidden', width: 100 }}>
                        <div style={{ height: '100%', borderRadius: 2, background: 'var(--accent)', width: `${progress * 100}%` }} />
                      </div>
                    </td>
                    <td style={{ textAlign: 'right' }}>{formatMoney(loan.principal)}</td>
                    <td style={{ textAlign: 'right', color: 'var(--red)', fontWeight: 600 }}>{formatMoney(balance)}</td>
                    <td style={{ textAlign: 'right' }}>{(loan.interestRate * 100).toFixed(1)}% p.a.</td>
                    <td style={{ textAlign: 'right', color: 'var(--red)' }}>{formatMoney(loan.weeklyPayment)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <span style={{ color: loan.weeksRemaining <= 4 ? 'var(--yellow)' : 'var(--text-muted)' }}>
                        {loan.weeksRemaining}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right', color: 'var(--text-muted)', fontSize: 12 }}>
                      {formatMoney(loan.totalInterestPaid ?? 0)}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        className="btn btn-ghost"
                        style={{ fontSize: 11, padding: '3px 8px', color: canRepayEarly ? 'var(--red)' : 'var(--text-dim)' }}
                        disabled={!canRepayEarly}
                        onClick={() => {
                          if (window.confirm(`Repay early? You'll pay ${formatMoney(earlyTotal)} (balance ${formatMoney(balance)} + 2% penalty ${formatMoney(penalty)}).`)) {
                            dispatch({ type: 'REPAY_LOAN', loanId: loan.id });
                          }
                        }}
                        title={canRepayEarly ? `Early repayment: ${formatMoney(earlyTotal)}` : 'Not enough cash'}
                      >
                        Repay early
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {activeLoans.length === 0 && (
        <div style={{ padding: '12px 16px', borderRadius: 8, background: 'rgba(63,185,80,.06)', border: '1px solid rgba(63,185,80,.15)', marginBottom: 20, fontSize: 13, color: 'var(--green)' }}>
          <Glyph e="✓" /> No active loans — your balance sheet is debt-free.
        </div>
      )}

      {/* New loan */}
      <div className="card">
        <div className="card-title">Take a New Loan</div>

        {/* Product picker */}
        <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
          {LOAN_PRODUCTS.map(p => {
            const rate = Math.max(0.03, p.baseRate + credit.rateBonus);
            const isSelected = selectedProduct === p.id;
            return (
              <div
                key={p.id}
                onClick={() => { setSelectedProduct(p.id); setShowConfirm(false); }}
                style={{
                  flex: 1, padding: '12px 14px', borderRadius: 8, cursor: 'pointer',
                  border: `1px solid ${isSelected ? p.color : 'var(--border)'}`,
                  background: isSelected ? p.color + '15' : 'var(--surface)',
                  transition: 'all .15s',
                }}
              >
                <div style={{ fontWeight: 600, fontSize: 13, color: isSelected ? p.color : 'var(--text)' }}>{p.name}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>{p.description}</div>
                <div style={{ fontSize: 12, marginTop: 6, color: p.color, fontWeight: 600 }}>
                  {(rate * 100).toFixed(1)}% APR
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>
                  Max {formatMoney(weeklyRevenue > 0 ? Math.floor(weeklyRevenue * p.maxMultiple / 1000) * 1000 : 500_000)}
                </div>
              </div>
            );
          })}
        </div>

        {/* Amount input */}
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginBottom: 16 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
              Loan Amount <span style={{ color: 'var(--text-dim)' }}>(min $10,000 · max {formatMoney(maxAmount)})</span>
            </div>
            <input
              type="text"
              className="input"
              placeholder="e.g. 500000"
              value={loanAmount}
              onChange={e => { setLoanAmount(e.target.value); setShowConfirm(false); }}
              style={{ width: '100%' }}
            />
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {[250_000, 500_000, 1_000_000, 2_000_000].filter(v => v <= maxAmount).map(v => (
              <button key={v} className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => { setLoanAmount(String(v)); setShowConfirm(false); }}>
                {v >= 1_000_000 ? `$${v/1_000_000}M` : `$${v/1000}k`}
              </button>
            ))}
          </div>
        </div>

        {/* Preview */}
        {parsedAmount > 0 && product && (
          <div style={{ padding: '12px 14px', borderRadius: 8, background: 'var(--surface2)', marginBottom: 14, fontSize: 13 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 3 }}>You receive</div>
                <strong style={{ color: 'var(--green)' }}>{formatMoney(parsedAmount)}</strong>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 3 }}>Weekly payment</div>
                <strong style={{ color: 'var(--red)' }}>{formatMoney(weeklyPayment)}</strong>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 3 }}>Total interest</div>
                <strong style={{ color: 'var(--yellow)' }}>{formatMoney(Math.max(0, totalInterest))}</strong>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 3 }}>Total repaid</div>
                <strong>{formatMoney(weeklyPayment * product.termWeeks)}</strong>
              </div>
            </div>
            {parsedAmount > maxAmount && (
              <div style={{ marginTop: 10, color: 'var(--red)', fontSize: 12 }}>
                <Glyph e="⚠" /> Exceeds maximum for this product ({formatMoney(maxAmount)}).
              </div>
            )}
            {parsedAmount < 10_000 && parsedAmount > 0 && (
              <div style={{ marginTop: 10, color: 'var(--yellow)', fontSize: 12 }}>
                <Glyph e="⚠" /> Minimum loan amount is $10,000.
              </div>
            )}
          </div>
        )}

        {!showConfirm ? (
          <button
            className="btn btn-primary"
            disabled={!canBorrow}
            onClick={() => setShowConfirm(true)}
          >
            Review loan offer
          </button>
        ) : (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '12px 14px', borderRadius: 8, background: 'rgba(248,81,73,.08)', border: '1px solid rgba(248,81,73,.25)' }}>
            <span style={{ flex: 1, fontSize: 13 }}>
              Confirm: borrow <strong style={{ color: 'var(--green)' }}>{formatMoney(parsedAmount)}</strong> at <strong>{(effectiveRate * 100).toFixed(1)}% APR</strong> over <strong>{product.termWeeks} weeks</strong> — {formatMoney(weeklyPayment)}/wk.
            </span>
            <button className="btn btn-primary" onClick={handleTakeLoan}>Confirm</button>
            <button className="btn btn-ghost" onClick={() => setShowConfirm(false)}>Cancel</button>
          </div>
        )}
      </div>

      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 8, lineHeight: 1.6 }}>
        Interest rates reflect your credit rating. Early repayment incurs a 2% penalty on remaining principal.
        Loan payments are deducted automatically each week before cash is updated.
        Each loan offers a guaranteed amount ($5M / $10M / $20M) available from day one; higher weekly revenue can unlock even more (revenue × product multiplier).
      </div>
    </div>
  );
}

// ─── Shared sub-components ────────────────────────────────────────────────────

function StatBox({ label, value, color }) {
  return (
    <div className="stat-box">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${color}`}>{value}</div>
    </div>
  );
}

/** Non-collapsible header (Balance Sheet) */
function SectionHeader({ label }) {
  return (
    <tr>
      <td colSpan={3} style={{ padding: '12px 16px 4px', fontSize: 11, fontWeight: 700, letterSpacing: '.8px', color: 'var(--text-muted)', textTransform: 'uppercase', background: 'var(--surface2)' }}>
        {label}
      </td>
    </tr>
  );
}

/**
 * Collapsible section: clickable header row + conditionally-rendered children.
 * Works inside any <tbody>. Children must be <tr> elements.
 *   colSpan — match the table's column count
 *   count   — shown in parentheses next to the label
 *   summary — always-visible summary row rendered when collapsed (optional <tr>)
 */
function CollapsibleSection({ label, count, colSpan = 3, expanded, onToggle, children, summary }) {
  return (
    <>
      <tr style={{ cursor: 'pointer', userSelect: 'none' }} onClick={onToggle}>
        <td colSpan={colSpan} style={{ padding: 0, background: 'var(--surface2)' }}>
          <div style={{
            padding: '9px 16px 7px',
            display: 'flex', alignItems: 'center', gap: 7,
            fontSize: 11, fontWeight: 700, letterSpacing: '.7px',
            color: 'var(--text-muted)', textTransform: 'uppercase',
          }}>
            <span style={{ fontSize: 9, width: 10, flexShrink: 0, opacity: 0.7 }}>
              {expanded ? '▾' : '▸'}
            </span>
            {label}
            {count != null && (
              <span style={{ fontWeight: 500, color: 'var(--text-dim)', textTransform: 'none', letterSpacing: 0 }}>
                ({count})
              </span>
            )}
            <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-dim)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
              {expanded ? 'collapse ↑' : 'expand ↓'}
            </span>
          </div>
        </td>
      </tr>
      {expanded ? children : summary}
    </>
  );
}

function Spacer({ colSpan = 3 }) {
  return <tr><td colSpan={colSpan} style={{ height: 6, padding: 0, background: 'var(--surface2)' }} /></tr>;
}

function EmptyRow({ text, colSpan = 3 }) {
  return (
    <tr><td colSpan={colSpan} style={{ padding: '10px 28px', color: 'var(--text-dim)', fontSize: 13 }}>{text}</td></tr>
  );
}

function LineItem({ label, weekly, prior, ytd: ytdVal }) {
  const color = weekly < 0 ? 'var(--red)' : 'var(--green)';
  const priorColor = prior == null ? 'var(--text-dim)' : prior < 0 ? 'var(--red)' : 'var(--green)';
  const hasPrior = prior !== undefined;
  return (
    <tr>
      <td style={{ paddingLeft: 28, color: 'var(--text-muted)', fontSize: 13 }}>{label}</td>
      {hasPrior && (
        <td style={{ textAlign: 'right', fontSize: 12, color: prior == null ? 'var(--text-dim)' : priorColor }}>
          {prior == null ? '—' : (prior >= 0 ? '+' : '') + formatMoney(prior)}
        </td>
      )}
      <td style={{ textAlign: 'right', fontSize: 13, color }}>{weekly >= 0 ? '+' : ''}{formatMoney(weekly)}</td>
      <td style={{ textAlign: 'right', fontSize: 12, color: 'var(--text-dim)' }}>
        {ytdVal != null ? (ytdVal >= 0 ? '+' : '') + formatMoney(ytdVal) : '—'}
      </td>
    </tr>
  );
}

function TotalRow({ label, weekly, prior, ytd: ytdVal, positive }) {
  const wColor = positive ? 'var(--green)' : weekly >= 0 ? 'var(--green)' : 'var(--red)';
  const yColor = ytdVal != null ? (positive ? 'var(--green)' : ytdVal >= 0 ? 'var(--green)' : 'var(--red)') : 'var(--text-dim)';
  const pColor = prior == null ? 'var(--text-dim)' : (positive ? 'var(--green)' : prior >= 0 ? 'var(--green)' : 'var(--red)');
  const hasPrior = prior !== undefined;
  return (
    <tr style={{ borderTop: '1px solid var(--border)' }}>
      <td style={{ padding: '8px 16px', fontWeight: 600, fontSize: 13 }}>{label}</td>
      {hasPrior && (
        <td style={{ textAlign: 'right', padding: '8px 16px', fontWeight: 500, fontSize: 12, color: pColor }}>
          {prior == null ? '—' : (positive ? '+' : prior >= 0 ? '+' : '') + formatMoney(prior)}
        </td>
      )}
      <td style={{ textAlign: 'right', padding: '8px 16px', fontWeight: 600, fontSize: 13, color: wColor }}>
        {positive ? '+' : weekly >= 0 ? '+' : ''}{formatMoney(weekly)}
      </td>
      <td style={{ textAlign: 'right', padding: '8px 16px', fontSize: 12, color: yColor }}>
        {ytdVal != null ? (ytdVal >= 0 ? '+' : '') + formatMoney(ytdVal) : '—'}
      </td>
    </tr>
  );
}

function BSHeader({ label }) {
  return <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.5px', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 8 }}>{label}</div>;
}

function BSSectionHeader({ label }) {
  return (
    <tr>
      <td colSpan={2} style={{ padding: '10px 16px 4px', fontSize: 11, fontWeight: 600, letterSpacing: '.6px', color: 'var(--text-muted)', textTransform: 'uppercase', background: 'var(--surface2)' }}>
        {label}
      </td>
    </tr>
  );
}

function BSRow({ label, sublabel, value, indent = 0, bold, negative, signed }) {
  const color = negative ? 'var(--red)' : signed ? (value >= 0 ? 'var(--green)' : 'var(--red)') : 'var(--text)';
  return (
    <tr>
      <td style={{ paddingLeft: 16 + indent * 16, fontSize: 13, fontWeight: bold ? 600 : 400 }}>
        {label}
        {sublabel && <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{sublabel}</div>}
      </td>
      <td style={{ textAlign: 'right', padding: '8px 16px', fontSize: 13, color, fontWeight: bold ? 600 : 400 }}>
        {negative ? '(' : signed && value >= 0 ? '+' : ''}{formatMoney(negative ? -value : value)}{negative ? ')' : ''}
      </td>
    </tr>
  );
}

function BSTotalRow({ label, value, negative, signed }) {
  const color = negative ? 'var(--red)' : signed ? (value >= 0 ? 'var(--green)' : 'var(--red)') : 'var(--accent)';
  return (
    <tr style={{ borderTop: '1px solid var(--border)', fontWeight: 700 }}>
      <td style={{ padding: '8px 16px', fontSize: 13 }}>{label}</td>
      <td style={{ textAlign: 'right', padding: '8px 16px', fontSize: 13, color }}>
        {negative ? '(' : ''}{formatMoney(negative ? -value : value)}{negative ? ')' : ''}
      </td>
    </tr>
  );
}

function CostLine({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ color: 'var(--red)' }}>{formatMoney(value)}</span>
    </div>
  );
}

function InfoLine({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

function CFRow({ label, value, positive }) {
  const color = positive ? 'var(--green)' : value >= 0 ? 'var(--green)' : 'var(--red)';
  return (
    <tr>
      <td style={{ paddingLeft: 28, color: 'var(--text-muted)', fontSize: 13 }}>{label}</td>
      <td style={{ textAlign: 'right', fontSize: 13, color }}>
        {positive ? '+' : value >= 0 ? '+' : ''}{formatMoney(value)}
      </td>
    </tr>
  );
}

function CFTotalRow({ label, value }) {
  const color = value >= 0 ? 'var(--green)' : 'var(--red)';
  return (
    <tr style={{ borderTop: '1px solid var(--border)', fontWeight: 600 }}>
      <td style={{ padding: '8px 16px', fontSize: 13 }}>{label}</td>
      <td style={{ textAlign: 'right', padding: '8px 16px', fontSize: 13, color }}>
        {value >= 0 ? '+' : ''}{formatMoney(value)}
      </td>
    </tr>
  );
}

// ─── Fuel & Hedging ───────────────────────────────────────────────────────────

function FuelHedging() {
  const { state, dispatch } = useGame();
  const [selDuration, setSelDuration] = useState('short');
  const [selCoverage, setSelCoverage] = useState(0.25);

  const fuelIndex    = state.fuelPrice?.index ?? 1.0;
  const history      = state.fuelPrice?.history ?? [];
  const nowAbsWeek   = absoluteWeek(state.year, state.week);
  const allContracts = state.hedgeContracts ?? [];
  const active       = allContracts.filter(h => h.expiryAbsWeek > nowAbsWeek);
  const expired      = allContracts.filter(h => h.expiryAbsWeek <= nowAbsWeek).slice(-5);

  const status      = fuelIndexStatus(fuelIndex);
  const deltaLabel  = fuelIndexDelta(fuelIndex);
  const hedgedPct   = Math.round(totalHedgedCoverage(active) * 100);
  const effMult     = effectiveFuelMultiplier(fuelIndex, active);

  // Gauge position: map [MIN, MAX] → [0, 100]
  const gaugeRange  = FUEL_MAX_INDEX - FUEL_MIN_INDEX;
  const gaugePos    = Math.round(((fuelIndex - FUEL_MIN_INDEX) / gaugeRange) * 100);

  // Preview for selected option
  const selOpt        = HEDGE_DURATIONS.find(o => o.id === selDuration);
  const lockedPreview = selOpt ? parseFloat((fuelIndex * (1 + selOpt.premium)).toFixed(3)) : fuelIndex;
  const canBuy        = hedgedPct + selCoverage * 100 <= 100;

  // History chart
  const chartW = 360, chartH = 80;
  const pts    = [...history, fuelIndex].slice(-13);
  const yMin   = FUEL_MIN_INDEX, yMax = FUEL_MAX_INDEX;
  const toSVGPt = (val, i, n) => ({
    x: n > 1 ? (i / (n - 1)) * chartW : chartW / 2,
    y: chartH - ((val - yMin) / (yMax - yMin)) * chartH,
  });
  const pathD  = pts.map((v, i) => {
    const { x, y } = toSVGPt(v, i, pts.length);
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const lastPt = pts.length > 0 ? toSVGPt(pts[pts.length - 1], pts.length - 1, pts.length) : null;
  const baseline = chartH - ((1.0 - yMin) / (yMax - yMin)) * chartH;

  function handleBuy() {
    if (!canBuy) return;
    dispatch({ type: 'BUY_HEDGE', durationId: selDuration, coverage: selCoverage });
  }

  const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 16 };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* ── Gauge + history ──────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>

        <div style={card}>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>JET FUEL PRICE INDEX</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12 }}>
            <span style={{ fontSize: 32, fontWeight: 700, color: status.color }}>{fuelIndex.toFixed(3)}</span>
            <span style={{ fontSize: 14, color: status.color, fontWeight: 600 }}>{deltaLabel}</span>
            <span style={{
              fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 12,
              background: status.bg, color: status.color,
            }}>{status.label}</span>
          </div>

          {/* Gradient bar */}
          <div style={{ position: 'relative', height: 8, borderRadius: 4, marginBottom: 6,
            background: 'linear-gradient(to right, #38d39f, #ffb43d, #ff5d6c)' }}>
            <div style={{
              position: 'absolute', top: -3, width: 14, height: 14, borderRadius: '50%',
              background: status.color, border: '2px solid var(--bg)',
              left: `calc(${Math.min(98, Math.max(2, gaugePos))}% - 7px)`,
              boxShadow: '0 0 6px ' + status.color,
            }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--muted)' }}>
            <span>{FUEL_MIN_INDEX}</span><span>1.0 (normal)</span><span>{FUEL_MAX_INDEX}</span>
          </div>

          <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)', fontSize: 12 }}>
            {[
              ['Market index', `${fuelIndex.toFixed(3)}×`],
              ['Coverage hedged', `${hedgedPct}%`],
              ['Effective multiplier', `${effMult.toFixed(3)}×`],
            ].map(([k, v]) => (
              <div key={k} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ color: 'var(--muted)' }}>{k}</span>
                <span style={{
                  fontWeight: k === 'Effective multiplier' ? 600 : 400,
                  color: k === 'Coverage hedged' && hedgedPct > 0 ? 'var(--green)'
                       : k === 'Effective multiplier' && effMult < fuelIndex ? 'var(--green)'
                       : 'inherit',
                }}>{v}</span>
              </div>
            ))}
          </div>
        </div>

        <div style={card}>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
            PRICE HISTORY ({pts.length} weeks)
          </div>
          {pts.length < 2 ? (
            <div style={{ color: 'var(--muted)', fontSize: 12, padding: '20px 0', textAlign: 'center' }}>
              History builds week by week
            </div>
          ) : (
            <svg width="100%" viewBox={`0 0 ${chartW} ${chartH + 4}`} style={{ overflow: 'visible' }}>
              <line x1="0" y1={baseline} x2={chartW} y2={baseline}
                stroke="var(--border)" strokeWidth="1" strokeDasharray="4 4" />
              <path d={`${pathD} L${chartW},${chartH} L0,${chartH} Z`}
                fill={status.color} fillOpacity="0.08" />
              <path d={pathD} fill="none" stroke={status.color} strokeWidth="2" strokeLinejoin="round" />
              {lastPt && <circle cx={lastPt.x} cy={lastPt.y} r="4" fill={status.color} />}
            </svg>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--muted)', marginTop: 4 }}>
            <span>← past</span><span>─── normal (1.0) ───</span><span>now →</span>
          </div>
        </div>
      </div>

      {/* ── Buy hedge ────────────────────────────────────────────────── */}
      <div style={card}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Buy Fuel Hedge</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 16, lineHeight: 1.6 }}>
          Lock in today's fuel price for a portion of your fleet's fuel bill. A small premium is baked into
          the locked rate. If the market rises above your rate, you save. If it falls, you pay a little
          over market — the cost of certainty. Contracts stack up to 100% total coverage.
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8 }}>DURATION</div>
            {HEDGE_DURATIONS.map(opt => {
              const locked = parseFloat((fuelIndex * (1 + opt.premium)).toFixed(3));
              const isSel  = selDuration === opt.id;
              return (
                <button key={opt.id} onClick={() => setSelDuration(opt.id)} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  width: '100%', marginBottom: 6, padding: '8px 12px', borderRadius: 6,
                  cursor: 'pointer', fontSize: 12,
                  background: isSel ? 'rgba(56,139,253,0.15)' : 'var(--surface-raised)',
                  border: isSel ? '1px solid var(--accent)' : '1px solid var(--border)',
                  color: 'inherit',
                }}>
                  <span style={{ fontWeight: isSel ? 600 : 400 }}>{opt.label}</span>
                  <span style={{ color: 'var(--muted)', fontSize: 11 }}>
                    +{Math.round(opt.premium * 100)}% → {locked.toFixed(3)}×
                  </span>
                </button>
              );
            })}
          </div>

          <div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8 }}>COVERAGE</div>
            {HEDGE_COVERAGES.map(cov => {
              const isSel       = selCoverage === cov;
              const wouldExceed = hedgedPct + cov * 100 > 100;
              return (
                <button key={cov} onClick={() => !wouldExceed && setSelCoverage(cov)} disabled={wouldExceed} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  width: '100%', marginBottom: 6, padding: '8px 12px', borderRadius: 6,
                  cursor: wouldExceed ? 'not-allowed' : 'pointer', fontSize: 12,
                  opacity: wouldExceed ? 0.4 : 1,
                  background: isSel ? 'rgba(56,139,253,0.15)' : 'var(--surface-raised)',
                  border: isSel ? '1px solid var(--accent)' : '1px solid var(--border)',
                  color: 'inherit',
                }}>
                  <span style={{ fontWeight: isSel ? 600 : 400 }}>{Math.round(cov * 100)}% of fuel</span>
                  {wouldExceed && <span style={{ color: 'var(--red)', fontSize: 10 }}>exceeds 100%</span>}
                </button>
              );
            })}
          </div>
        </div>

        {/* Contract preview */}
        <div style={{
          background: 'var(--surface-raised)', borderRadius: 6, padding: '12px 14px',
          border: '1px solid var(--border)', marginBottom: 14, fontSize: 12,
        }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Contract Preview</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 0' }}>
            {[
              ['Duration', selOpt?.label ?? '—'],
              ['Coverage', `${Math.round(selCoverage * 100)}% of fleet fuel`],
              ['Market index now', `${fuelIndex.toFixed(3)}×`],
              ['Locked price', `${lockedPreview.toFixed(3)}×`],
              ['Expires', `W${Math.min(52, state.week + (selOpt?.weeks ?? 0))}, ${state.year + (state.week + (selOpt?.weeks ?? 0) > 52 ? 1 : 0)}`],
            ].map(([k, v]) => (
              <>
                <span key={k + '_k'} style={{ color: 'var(--muted)' }}>{k}</span>
                <span key={k + '_v'} style={{
                  fontWeight: k === 'Locked price' ? 600 : 400,
                  color: k === 'Locked price' && lockedPreview > fuelIndex ? 'var(--yellow)' : 'inherit',
                }}>{v}</span>
              </>
            ))}
          </div>
        </div>

        <button className="btn btn-primary" onClick={handleBuy} disabled={!canBuy} style={{ fontSize: 13 }}>
          {canBuy
            ? `Lock in ${lockedPreview.toFixed(3)}× for ${selOpt?.label}`
            : 'Coverage limit reached (100%)'}
        </button>
      </div>

      {/* ── Active contracts ──────────────────────────────────────────── */}
      <div style={card}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Active Contracts ({active.length})</div>
        {active.length === 0 ? (
          <div style={{ color: 'var(--muted)', fontSize: 12 }}>No active hedge contracts.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {['Duration', 'Coverage', 'Locked', 'vs Market', 'Weeks Left'].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '6px 10px', color: 'var(--muted)', fontWeight: 500 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {active.map(h => {
                const weeksLeft = h.expiryAbsWeek - nowAbsWeek;
                const saving    = fuelIndex - h.lockedPrice;  // positive = saving, negative = overpaying
                return (
                  <tr key={h.id} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '8px 10px' }}>{h.durationLabel}</td>
                    <td style={{ padding: '8px 10px' }}>{Math.round(h.coverage * 100)}%</td>
                    <td style={{ padding: '8px 10px', fontWeight: 600 }}>{h.lockedPrice.toFixed(3)}×</td>
                    <td style={{ padding: '8px 10px',
                      color: saving > 0.005 ? 'var(--green)' : saving < -0.005 ? 'var(--red)' : 'var(--muted)' }}>
                      {saving > 0.005 ? `▼ ${(saving * 100).toFixed(1)}% below market`
                       : saving < -0.005 ? `▲ ${(Math.abs(saving) * 100).toFixed(1)}% over market`
                       : '≈ at market'}
                    </td>
                    <td style={{ padding: '8px 10px' }}>{weeksLeft}w</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Recently expired ─────────────────────────────────────────── */}
      {expired.length > 0 && (
        <div style={{ ...card, opacity: 0.7 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Recently Expired</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <tbody>
              {expired.map(h => (
                <tr key={h.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '6px 10px' }}>{h.durationLabel}</td>
                  <td style={{ padding: '6px 10px' }}>{Math.round(h.coverage * 100)}%</td>
                  <td style={{ padding: '6px 10px' }}>{h.lockedPrice.toFixed(3)}× locked</td>
                  <td style={{ padding: '6px 10px', color: 'var(--muted)' }}>expired</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
