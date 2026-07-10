import { useMemo } from 'react';
import { useGame } from '../store/GameContext.jsx';
import { getAirport } from '../data/airports.js';
import AirportLink from './AirportLink.jsx';
import { getAircraftType } from '../data/aircraft.js';
import {
  buildRouteMarket, computeMarketShare, buildCompetitorOffer,
  computeQualityScore, computeConnectingDemand, HUB_TIERS,
} from '../models/demand.js';
import { getAlliance } from '../data/alliances.js';
import {
  simulateRoute, referencePrice, distanceKm, formatMoney, formatPercent, weekToGameDate,
  isRouteActive, routeActiveMonths, routeQualityBreakdown, fleetAvgUtilization,
} from '../utils/simulation.js';
import { weeklyLandingFee } from '../data/overhead.js';
import { normalizeCateringLevel } from '../data/catering.js';
import CateringSelector from './CateringSelector.jsx';
import { Glyph, GlyphLabel } from './Icons.jsx';

// ─── Small helpers ────────────────────────────────────────────────────────────

function weekToMonth(week) {
  return weekToGameDate(week).monthIndex;
}

const TIER_COLOR = { budget: 'var(--yellow)', legacy: 'var(--accent)', premium: 'var(--purple)' };

function TierBadge({ tier }) {
  return (
    <span style={{
      color: TIER_COLOR[tier] ?? 'var(--text-muted)',
      background: (TIER_COLOR[tier] ?? 'var(--text-muted)') + '22',
      border: `1px solid ${(TIER_COLOR[tier] ?? 'var(--text-muted)')}55`,
      borderRadius: 4, padding: '1px 7px', fontSize: 11, fontWeight: 700,
      textTransform: 'capitalize',
    }}>
      {tier}
    </span>
  );
}

function Stat({ label, value, sub, color }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 3 }}>{label}</div>
      <div style={{ fontWeight: 700, fontSize: 15, color: color ?? 'var(--text)' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

/** Where this route's quality score comes from — mirrors the engine exactly
 *  via routeQualityBreakdown, so players can see (and pull) every lever. */
function QualityBreakdownPanel({ route, aircraft, state }) {
  const bd = routeQualityBreakdown(route, aircraft, state);
  if (!bd) return null;
  const fmt = (v) => `${v >= 0 ? '+' : ''}${Math.round(v * 10) / 10}`;
  const rows = [
    { label: 'On-time performance', pts: bd.onTimePts,   sub: `${Math.round(bd.onTimeRate * 100)}% on time · morale + fleet utilization` },
    { label: 'Customer rating',     pts: bd.ratingPts,   sub: bd.satisfaction != null
        ? `${bd.customerRating.toFixed(1)}★ · earned satisfaction ${Math.round(bd.satisfaction)}/100`
        : `${bd.customerRating.toFixed(1)}★ · from cabin crew morale` },
    { label: 'Cabin product',       pts: bd.cabinPts,    sub: 'seat + service quality settings' },
    { label: 'Fleet age',           pts: bd.agePts,      sub: 'newer aircraft score higher' },
    { label: 'Cabin space',         pts: bd.spacePts,    sub: 'floor left unfilled = more room' },
    { label: 'Catering',            pts: bd.cateringPts, sub: 'matters more on long flights' },
    { label: 'Ground staff',        pts: bd.groundPts,   sub: 'morale bonus / penalty' },
    { label: 'Hub investment',      pts: bd.hubPts,      sub: 'from hub tier at endpoints' },
  ].filter(r => r.pts !== 0 || ['On-time performance', 'Customer rating', 'Cabin product', 'Fleet age'].includes(r.label));
  return (
    <div style={{ padding: '10px 12px', background: 'var(--surface2)', borderRadius: 'var(--radius)', marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
        <span style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Quality score breakdown</span>
        <span style={{ fontWeight: 700, fontSize: 16, color: bd.total >= 70 ? 'var(--green)' : bd.total >= 45 ? 'var(--yellow)' : 'var(--red)' }}>
          {Math.round(bd.total)} / 100
        </span>
      </div>
      {rows.map(r => (
        <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 12, marginBottom: 3 }}>
          <span>
            {r.label}
            <span style={{ color: 'var(--text-dim)', fontSize: 11, marginLeft: 6 }}>{r.sub}</span>
          </span>
          <span style={{ fontWeight: 600, color: r.pts >= 0 ? 'var(--text)' : 'var(--red)', whiteSpace: 'nowrap', marginLeft: 10 }}>
            {fmt(r.pts)} pts
          </span>
        </div>
      ))}
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6 }}>
        Quality drives your share of passengers against competitors — business travelers weigh it heavily.
      </div>
    </div>
  );
}

function MarketSharePie({ slices }) {
  // slices: [{ label, pax, color, isPlayer, isUnmet }]
  const total = slices.reduce((s, sl) => s + sl.pax, 0);
  if (total === 0) return null;

  const cx = 60, cy = 60, r = 52;
  let angle = -Math.PI / 2;

  const paths = slices.map((sl, i) => {
    const sweep = (sl.pax / total) * 2 * Math.PI;
    if (sweep < 0.001) return null;
    const x1 = cx + r * Math.cos(angle);
    const y1 = cy + r * Math.sin(angle);
    angle += sweep;
    const x2 = cx + r * Math.cos(angle);
    const y2 = cy + r * Math.sin(angle);
    const large = sweep > Math.PI ? 1 : 0;
    return (
      <path
        key={i}
        d={`M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2} Z`}
        fill={sl.color}
        opacity={sl.isUnmet ? 0.25 : sl.isPlayer ? 1 : 0.65}
      />
    );
  });

  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
      <svg viewBox="0 0 120 120" style={{ width: 110, height: 110, flexShrink: 0 }}>
        {paths}
      </svg>
      <div style={{ flex: 1, minWidth: 120 }}>
        {slices.map((sl, i) => {
          const pct = Math.round(sl.pax / total * 100);
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5, fontSize: 12 }}>
              <div style={{
                width: 10, height: 10, borderRadius: 2, flexShrink: 0,
                background: sl.color,
                opacity: sl.isUnmet ? 0.35 : 1,
              }} />
              <span style={{
                flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                color: sl.isUnmet ? 'var(--text-dim)' : sl.isPlayer ? 'var(--text)' : 'var(--text-muted)',
                fontWeight: sl.isPlayer ? 700 : 400,
                fontStyle: sl.isUnmet ? 'italic' : 'normal',
              }}>
                {sl.isPlayer && <span style={{ color: 'var(--green)', marginRight: 4 }}>▶</span>}
                {sl.label}
              </span>
              <span style={{ flexShrink: 0, color: sl.isUnmet ? 'var(--text-dim)' : sl.isPlayer ? 'var(--green)' : 'var(--text-muted)' }}>
                {sl.pax.toLocaleString()} · {pct}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function RouteDetail({ origin, dest, rrById = {}, onBack }) {
  const { state, dispatch } = useGame();
  const gameDate  = { week: state.week, month: weekToMonth(state.week) };
  const hubs      = state.hubs ?? (state.hub ? { [state.hub]: { tier: 1 } } : {});

  const originAirport = getAirport(origin);
  const destAirport   = getAirport(dest);
  const dist          = Math.round(distanceKm(originAirport, destAirport));
  const refP          = referencePrice(origin, dest);
  const routeKey      = [origin, dest].sort().join('-');

  // Market
  const market      = useMemo(() => buildRouteMarket(origin, dest, gameDate), [origin, dest, gameDate.month]);
  const totalDemand = market.leisureDemand + market.businessDemand;

  // Player routes on this pair (either direction)
  const playerRoutes = state.routes.filter(r =>
    (r.origin === origin && r.destination === dest) ||
    (r.origin === dest   && r.destination === origin)
  );

  // Seasonal dormancy: true when every player route on this pair carries a season
  // window and none of them operates in the current month. The forecast figures
  // below are the in-season projection, so we surface a banner to avoid confusion.
  const seasonalRoutes = playerRoutes.filter(r => r.season);
  const isDormantNow = playerRoutes.length > 0 && seasonalRoutes.length === playerRoutes.length &&
    playerRoutes.every(r => !isRouteActive(r, gameDate.month));
  const MONTH_NAMES = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const resumeMonth = (() => {
    if (!isDormantNow) return null;
    const months = routeActiveMonths(playerRoutes[0]);
    for (let i = 0; i < 12; i++) {
      const m = ((gameDate.month - 1 + i) % 12) + 1;
      if (months.includes(m)) return m;
    }
    return months[0];
  })();

  // Competitors on this route
  const competitorsOnRoute = (state.competitors ?? []).filter(c => c.routes?.[routeKey]);

  // Build market share
  const { shareResults } = useMemo(() => {
    const hubBonus = (code) => {
      const tier = hubs[code]?.tier;   // tier 0 (Focus City) is valid — check != null
      return tier != null ? (HUB_TIERS[tier]?.qualityBonus ?? 0) : 0;
    };
    const maxHubBonus = Math.max(hubBonus(origin), hubBonus(dest));

    let playerOffer = null;
    if (playerRoutes.length > 0) {
      const route    = playerRoutes[0];
      const aircraft = state.fleet.find(a => a.id === route.aircraftId);
      const type     = aircraft ? getAircraftType(aircraft.typeId) : null;
      if (type) {
        const totalFreq = playerRoutes.reduce((s, r) => s + r.weeklyFrequency, 0);
        playerOffer = {
          airlineId:         'player',
          origin, destination: dest,
          economyPrice:      route.classPrices?.economy ?? route.ticketPrice,
          businessPrice:     route.classPrices?.businessClass ?? null,
          weeklyFrequency:   totalFreq,
          seatsPerFlight:    type.seats,
          economySeats:      (aircraft.config?.economy ?? type.seats) * totalFreq,
          businessSeats:     (aircraft.config?.businessClass ?? 0) * totalFreq,
          totalSeats:        ((aircraft.config?.economy ?? type.seats) + (aircraft.config?.businessClass ?? 0) + (aircraft.config?.premiumEconomy ?? 0) + (aircraft.config?.firstClass ?? 0)) * totalFreq,
          // Same quality the engine computes for this route (morale, utilization,
          // satisfaction, cabin product), incl. the hub bonus via the breakdown.
          qualityScore:      routeQualityBreakdown(route, aircraft, state)?.total
            ?? Math.min(100, computeQualityScore({ onTimeRate: 0.85, serviceLevel: 'economy', fleetAgeYears: (aircraft.ageWeeks ?? 0) / 52, customerRating: 3.5 }) + maxHubBonus),
          connectivityBonus: (origin === state.hub || dest === state.hub) ? 0.20 : 0,
        };
      }
    }

    const compOffers = competitorsOnRoute.map(c => buildCompetitorOffer(c, market)).filter(Boolean);
    const allOffers  = [...(playerOffer ? [playerOffer] : []), ...compOffers];
    const results    = computeMarketShare(market, allOffers);
    return { shareResults: results };
  }, [playerRoutes, competitorsOnRoute, market, origin, dest, state.hub, hubs]);

  // Live simulate each player aircraft.
  // When multiple aircraft share this O&D we pre-compute combined demand and
  // distribute it proportionally so each aircraft doesn't overcount the market.
  const playerSims = useMemo(() => {
    if (playerRoutes.length === 0) return [];

    // Build combined demand allocation when there are multiple aircraft
    const demandAllocations = new Map(); // aircraftId → demandOverride
    if (playerRoutes.length > 1) {
      let totalEcoSeats = 0, totalBizSeats = 0, totalSeatsAll = 0, totalFreq = 0;
      let hasBusinessCabin = false;
      const validSims = [];
      for (const route of playerRoutes) {
        const aircraft = state.fleet.find(a => a.id === route.aircraftId);
        if (!aircraft) continue;
        const type = getAircraftType(aircraft.typeId);
        if (!type) continue;
        const cfg  = aircraft.config ?? { economy: type.seats };
        const freq = route.weeklyFrequency ?? 7;
        const eco  = (cfg.economy ?? type.seats) * freq;
        const biz  = (cfg.businessClass ?? 0) * freq;
        totalEcoSeats += eco;
        totalBizSeats += biz;
        totalSeatsAll += ((cfg.economy ?? type.seats) + (cfg.businessClass ?? 0) + (cfg.premiumEconomy ?? 0) + (cfg.firstClass ?? 0)) * freq;
        totalFreq     += freq;
        if (biz > 0) hasBusinessCabin = true;
        validSims.push({ route, aircraft, type, cfg, freq, eco, biz });
      }
      if (validSims.length > 1 && totalFreq > 0) {
        const r0   = validSims[0].route;
        const cp0  = r0.classPrices ?? {};
        const ecoP = Math.max(1, cp0.economy ?? r0.ticketPrice ?? 1);
        const bizP = hasBusinessCabin && cp0.businessClass != null
          ? Math.max(1, cp0.businessClass) : hasBusinessCabin ? ecoP * 3.5 : null;
        const combinedOffer = {
          airlineId: 'player', origin, destination: dest,
          economyPrice: ecoP, businessPrice: bizP,
          weeklyFrequency: totalFreq,
          seatsPerFlight: Math.round((totalEcoSeats + totalBizSeats) / totalFreq),
          economySeats: totalEcoSeats, businessSeats: totalBizSeats,
          totalSeats: totalSeatsAll,
          qualityScore: shareResults.find(r => r.airlineId === 'player') ? 70 : 70,
          connectivityBonus: (origin === state.hub || dest === state.hub) ? 0.20 : 0,
        };
        const compOffers = competitorsOnRoute.map(c => buildCompetitorOffer(c, market)).filter(Boolean);
        const [combined] = computeMarketShare(market, [combinedOffer, ...compOffers]);
        for (const { aircraft, eco, biz } of validSims) {
          const ecoFrac = totalEcoSeats > 0 ? eco / totalEcoSeats : 1 / validSims.length;
          const bizFrac = totalBizSeats > 0 ? biz / totalBizSeats : 1 / validSims.length;
          demandAllocations.set(aircraft.id, {
            leisurePax:      Math.round(combined.leisurePax  * ecoFrac),
            businessPax:     Math.round(combined.businessPax * bizFrac),
            economyRevenue:  Math.round(combined.economyRevenue  * ecoFrac),
            businessRevenue: Math.round(combined.businessRevenue * bizFrac),
            totalPax:        Math.round(combined.totalPax * ((ecoFrac + bizFrac) / 2)),
            leisureShare:    combined.leisureShare,
            businessShare:   combined.businessShare,
            capacityCapped:  combined.capacityCapped,
          });
        }
      }
    }

    return playerRoutes.flatMap(route => {
      const aircraft = state.fleet.find(a => a.id === route.aircraftId);
      if (!aircraft) return [];
      const type = getAircraftType(aircraft.typeId);
      // Prefer the canonical engine result (same source as the Finance tab):
      // it already accounts for competitor encroachment, marketing/loyalty lifts
      // and landing fees, and carries weeklyLeaseCost / weeklyMaintCost / profit.
      const rr = rrById[route.id];
      if (rr) return [{ route, aircraft, type, result: rr }];
      // Fallback for routes the engine skipped (grounded / dormant-seasonal) —
      // same labor / utilization / satisfaction inputs the engine uses.
      const result = simulateRoute(route, aircraft, gameDate, state.labor ?? null, 1.0,
        demandAllocations.get(aircraft.id) ?? null, [],
        fleetAvgUtilization(state.fleet ?? [], [...(state.routes ?? []), ...(state.cargoRoutes ?? [])]),
        state.satisfaction ?? null);
      if (!result) return [];
      const weeklyLeaseCost = aircraft.ownershipType === 'owned' ? 0
        : (aircraft.weeklyLease ?? type?.weeklyLease ?? 0);
      const weeklyMaintCost = type?.baseMaintenancePerWk ?? 0; // approximate (no maint mult here)
      return [{ route, aircraft, type, result: { ...result, weeklyLeaseCost, weeklyMaintCost,
        trueProfit: result.revenue - (result.totalOpCost ?? 0) - weeklyLeaseCost - weeklyMaintCost } }];
    });
  }, [playerRoutes, state.fleet, gameDate, competitorsOnRoute, market, origin, dest, state.hub, shareResults, rrById]);

  // result.passengers is one-way (per direction) — directly comparable to market demand.
  const totalPax     = playerSims.reduce((s, {result}) => s + result.passengers, 0);
  const totalRev     = playerSims.reduce((s, {result}) => s + result.revenue, 0);
  const totalOpCost  = playerSims.reduce((s, { route, aircraft, type: aType, result }) => {
    const originAp = getAirport(route.origin);
    const destAp   = getAirport(route.destination);
    // Use the engine's landing fee when available so this reconciles with Finance;
    // otherwise recompute it (fallback path for grounded/dormant routes).
    const lf = result.landingFee ?? weeklyLandingFee(
      aType?.category ?? 'Narrow Body',
      route.weeklyFrequency,
      originAp?.tier ?? 'major',
      destAp?.tier   ?? 'major',
    );
    return s + result.totalOpCost + lf;
  }, 0);
  const avgLoad      = playerSims.length ? playerSims.reduce((s, {result}) => s + result.loadFactor, 0) / playerSims.length : 0;

  // Capacity-limited: aircraft are essentially full yet real demand is still being
  // turned away. On such routes load won't rise by cutting fares (you're seat-bound,
  // not demand-bound) — the levers are more frequency/aircraft, or higher fares for
  // yield. Surfaced as a badge so a "stuck" load reads as physically full, not a bug.
  const servedPaxAll    = shareResults.reduce((s, r) => s + (r.totalPax ?? 0), 0);
  const unmetDemandAll  = Math.max(0, totalDemand - servedPaxAll);
  const capacityLimited = playerRoutes.length > 0 && !isDormantNow && avgLoad >= 0.97 && unmetDemandAll > 0;

  // Catering — per-route setting, edited here for the whole pair
  const catRev    = playerSims.reduce((s, { result }) => s + (result.cateringRevenue ?? 0), 0);
  const catCost   = playerSims.reduce((s, { result }) => s + (result.cateringCost    ?? 0), 0);
  const catLevels = [...new Set(playerRoutes.map(r => normalizeCateringLevel(r.cateringLevel)))];
  const catLevel  = catLevels.length === 1 ? catLevels[0] : null;
  const setRouteCatering = (level) =>
    dispatch({ type: 'SET_ROUTE_CATERING', routeIds: playerRoutes.map(r => r.id), level });

  // Aggregate class summary across all player sims
  const CABIN_ORDER = ['firstClass', 'businessClass', 'premiumEconomy', 'economy'];
  const CLASS_LABELS = { firstClass: 'First', businessClass: 'Business', premiumEconomy: 'Prem Eco', economy: 'Economy' };
  const CLASS_COLORS = { firstClass: 'var(--purple)', businessClass: 'var(--accent)', premiumEconomy: 'var(--yellow)', economy: 'var(--green)' };
  const aggregateClasses = CABIN_ORDER.reduce((acc, cls) => {
    let totalSeats = 0, totalPaxCls = 0;
    for (const { route, result } of playerSims) {
      const cs = result.classSummary?.[cls];
      if (!cs) continue;
      // cs.passengers is one-way (per direction); seats is per-direction per-flight
      totalSeats  += cs.seats * (route.weeklyFrequency ?? 0); // one-way capacity
      totalPaxCls += cs.passengers; // one-way pax
    }
    if (totalSeats > 0) acc[cls] = { seats: totalSeats, pax: totalPaxCls, loadFactor: totalPaxCls / totalSeats };
    return acc;
  }, {});
  const activeClasses = CABIN_ORDER.filter(cls => aggregateClasses[cls]);

  // Connecting
  const rcOrigin = state.routes.filter(r => r.origin === origin || r.destination === origin).length;
  const rcDest   = state.routes.filter(r => r.origin === dest   || r.destination === dest).length;

  const connecting = useMemo(() => {
    // Build alliance/codeshare partner hub codes for external feed boost
    const allianceDef        = state.allianceMembership ? getAlliance(state.allianceMembership.allianceId) : null;
    const alliancePartnerIds = allianceDef?.memberIds ?? [];
    const codeshareIds       = (state.codeshareAgreements ?? []).map(a => a.competitorId);
    const allPartnerIds      = new Set([...alliancePartnerIds, ...codeshareIds]);
    const partnerHubCodes    = (state.competitors ?? [])
      .filter(c => allPartnerIds.has(c.id) && c.homeHub)
      .map(c => c.homeHub);

    // Use total frequency across all player sub-routes on this pair
    const weeklyFrequency = playerRoutes.reduce((s, r) => s + (r.weeklyFrequency ?? 0), 0) || 7;

    return computeConnectingDemand(origin, dest, hubs, rcOrigin, rcDest, refP,
      { weeklyFrequency, partnerHubCodes, gates: state.gates ?? {} }
    );
  }, [origin, dest, hubs, rcOrigin, rcDest, refP, playerRoutes,
      state.allianceMembership, state.codeshareAgreements, state.competitors, state.gates]);

  // Actual connecting result from the last weekly tick (includes own-metal
  // itinerary feed with per-O&D breakdown), if this route flew last week.
  const lastConn = useMemo(() => {
    const rr  = state.lastReport?.routeResults ?? [];
    const ids = new Set(playerRoutes.map(r => r.id));
    const match = rr.find(r => ids.has(r.routeId) && r.connecting);
    return match?.connecting ?? null;
  }, [state.lastReport, playerRoutes]);

  return (
    <div>
      {/* Back + header */}
      <button className="btn btn-ghost" style={{ fontSize: 13, marginBottom: 14 }} onClick={onBack}>
        ← Back to Routes
      </button>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 22, letterSpacing: -0.5 }}>
            <AirportLink code={origin} style={{ fontSize: 22, fontWeight: 700 }} />
            {' → '}
            <AirportLink code={dest} style={{ fontSize: 22, fontWeight: 700 }} />
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 2 }}>
            {originAirport?.city} → {destAirport?.city} · {dist.toLocaleString()} km
          </div>
        </div>
        {playerRoutes.length > 0 && (
          isDormantNow ? (
            <div style={{ background: 'rgba(139,148,158,0.12)', border: '1px solid rgba(139,148,158,0.3)', borderRadius: 'var(--radius)', padding: '6px 14px', fontSize: 13, fontWeight: 600, color: 'var(--text-muted)', flexShrink: 0 }}>
              <Glyph e="🗓" /> Dormant · resumes {MONTH_NAMES[resumeMonth]}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flexShrink: 0 }}>
              <div style={{ background: 'rgba(63,185,80,0.12)', border: '1px solid rgba(63,185,80,0.3)', borderRadius: 'var(--radius)', padding: '6px 14px', fontSize: 13, fontWeight: 600, color: 'var(--green)' }}>
                <Glyph e="✈" /> Operating · {playerRoutes.reduce((s, r) => s + r.weeklyFrequency, 0)}× / wk
              </div>
              {capacityLimited && (
                <div
                  title={`Aircraft are essentially full and ~${unmetDemandAll.toLocaleString()} pax/wk can't get a seat. Add frequency/aircraft or raise fares — cutting price won't lift load.`}
                  style={{ background: 'rgba(210,153,34,0.12)', border: '1px solid rgba(210,153,34,0.35)', borderRadius: 'var(--radius)', padding: '6px 14px', fontSize: 13, fontWeight: 600, color: 'var(--yellow)' }}
                >
                  <Glyph e="⚠" /> Capacity-limited · {unmetDemandAll.toLocaleString()} unserved/wk
                </div>
              )}
            </div>
          )
        )}
      </div>

      {isDormantNow && (
        <div style={{ background: 'rgba(139,148,158,0.1)', border: '1px solid rgba(139,148,158,0.3)', borderRadius: 'var(--radius)', padding: '10px 14px', marginBottom: 14, fontSize: 13, color: 'var(--text-muted)' }}>
          <Glyph e="🗓" /> <strong>Out of season.</strong> This route is dormant until {MONTH_NAMES[resumeMonth]} — it earns no revenue and incurs no operating cost this month. The figures below are the in-season forecast for when it resumes.
        </div>
      )}

      {capacityLimited && (
        <div style={{ background: 'rgba(210,153,34,0.1)', border: '1px solid rgba(210,153,34,0.3)', borderRadius: 'var(--radius)', padding: '10px 14px', marginBottom: 14, fontSize: 13, color: 'var(--text-muted)' }}>
          <Glyph e="⚠" /> <strong style={{ color: 'var(--yellow)' }}>Capacity-limited.</strong> Your aircraft are essentially full and ~{unmetDemandAll.toLocaleString()} pax/wk can't get a seat. Cutting fares won't lift load here — you're seat-bound, not demand-bound. To carry more, add frequency or aircraft; to earn more on the seats you have, raise fares toward the point where load starts to dip.
        </div>
      )}

      {/* Row 1: Market overview + Market share side by side */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12, marginBottom: 12 }}>

        <div className="card">
          <div style={{ fontWeight: 600, marginBottom: 12 }}>Market</div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 14 }}>
            <Stat label="Total Demand" value={totalDemand.toLocaleString()} sub="pax / wk one-way" color="var(--accent)" />
            <Stat label="Leisure"      value={market.leisureDemand.toLocaleString()} />
            <Stat label="Business"     value={market.businessDemand.toLocaleString()} />
            <Stat label="Ref Price"    value={`$${refP}`} />
            <Stat label="Seasonality"  value={`×${market.seasonalityFactor.toFixed(2)}`} sub={`month ${gameDate.month}`} />
          </div>
          {(() => {
            const leisurePct  = totalDemand > 0 ? Math.round(market.leisureDemand  / totalDemand * 100) : 85;
            const businessPct = totalDemand > 0 ? Math.round(market.businessDemand / totalDemand * 100) : 15;
            return (
              <>
                <div style={{ height: 6, background: 'var(--surface3)', borderRadius: 3, overflow: 'hidden', display: 'flex' }}>
                  <div style={{ flex: leisurePct,  background: 'var(--accent)', opacity: 0.6 }} />
                  <div style={{ flex: businessPct, background: 'var(--purple)' }} />
                </div>
                <div style={{ display: 'flex', gap: 14, marginTop: 4, fontSize: 11, color: 'var(--text-dim)' }}>
                  <span><span style={{ color: 'var(--accent)' }}>■</span> Leisure {leisurePct}%</span>
                  <span><span style={{ color: 'var(--purple)' }}>■</span> Business {businessPct}%</span>
                </div>
              </>
            );
          })()}
        </div>

        <div className="card">
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Market Share</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
            {shareResults.length} {shareResults.length === 1 ? 'airline' : 'airlines'} · {totalDemand.toLocaleString()} base demand one-way
          </div>
          {shareResults.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No airlines on this route yet.</div>
          ) : (() => {
            const servedPax = shareResults.reduce((s, r) => s + r.totalPax, 0);
            const unmet = Math.max(0, totalDemand - servedPax);
            const pieSlices = [
              ...shareResults.map(s => {
                const isPlayer = s.airlineId === 'player';
                const comp = (state.competitors ?? []).find(c => c.id === s.airlineId);
                return {
                  label:    isPlayer ? state.airlineName : (comp?.name ?? s.airlineId),
                  pax:      s.totalPax,
                  color:    isPlayer ? 'var(--green)'
                            : comp?.tier === 'premium' ? 'var(--purple)'
                            : comp?.tier === 'budget'  ? 'var(--yellow)'
                            : 'var(--accent)',
                  isPlayer,
                  isUnmet:  false,
                };
              }),
              ...(unmet > 0 ? [{ label: 'Unmet demand', pax: unmet, color: 'var(--text-dim)', isPlayer: false, isUnmet: true }] : []),
            ];
            return (
              <>
                <MarketSharePie slices={pieSlices} />
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 8 }}>
                  Based on price · quality · frequency
                  {servedPax > totalDemand && (
                    <span style={{ color: 'var(--green)', marginLeft: 6 }}>
                      · market expanded to {servedPax.toLocaleString()} via low fares
                    </span>
                  )}
                </div>
              </>
            );
          })()}
        </div>
      </div>

      {/* Row 2: Your performance — full width */}
      {playerSims.length > 0 && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 12 }}>Your Performance</div>
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 14 }}>
            <Stat label="Weekly Pax"   value={totalPax.toLocaleString()} sub="pax / wk one-way" />
            <Stat label="Avg Load"     value={formatPercent(avgLoad)} color={avgLoad >= 0.75 ? 'var(--green)' : avgLoad >= 0.45 ? 'var(--yellow)' : 'var(--red)'} />
            <Stat label="Revenue/wk"   value={formatMoney(totalRev)} color="var(--green)" />
            <Stat label="Op Cost/wk"   value={formatMoney(totalOpCost)} color="var(--red)" />
            <Stat label="Op Profit/wk" value={(totalRev - totalOpCost >= 0 ? '+' : '') + formatMoney(totalRev - totalOpCost)} color={totalRev - totalOpCost >= 0 ? 'var(--green)' : 'var(--red)'}
              sub="variable costs only" />
            <Stat
              label="Catering net/wk"
              value={(catRev - catCost >= 0 ? '+' : '') + formatMoney(catRev - catCost)}
              sub={`+${formatMoney(catRev)} rev · −${formatMoney(catCost)} cost`}
              color={catRev - catCost >= 0 ? 'var(--green)' : 'var(--red)'}
            />
          </div>
          {/* Fixed cost indicator */}
          {(() => {
            const totalLease = playerSims.reduce((s, { result }) => s + (result.weeklyLeaseCost ?? 0), 0);
            const totalMaint = playerSims.reduce((s, { result }) => s + (result.weeklyMaintCost ?? 0), 0);
            const totalFixed = totalLease + totalMaint;
            const trueProfit = totalRev - totalOpCost - totalFixed;
            if (totalFixed === 0) return null;
            const trueProfitColor = trueProfit >= 0 ? 'var(--green)' : 'var(--red)';
            return (
              <div style={{
                padding: '10px 14px', marginBottom: 14,
                background: 'var(--surface2)', borderRadius: 'var(--radius)',
                borderLeft: `3px solid ${trueProfitColor}`,
                fontSize: 13,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                  <span style={{ color: 'var(--text-muted)' }}>Fixed costs (lease + maint)</span>
                  <span style={{ color: 'var(--red)', fontWeight: 600 }}>−{formatMoney(totalFixed)}/wk</span>
                </div>
                {totalLease > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-dim)', marginBottom: 2 }}>
                    <span>Lease</span><span>−{formatMoney(totalLease)}</span>
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-dim)', marginBottom: 6 }}>
                  <span>Maintenance</span><span>−{formatMoney(totalMaint)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', borderTop: '1px solid var(--border)', paddingTop: 6 }}>
                  <span style={{ fontWeight: 600 }}>True profit/wk</span>
                  <span style={{ fontWeight: 700, color: trueProfitColor }}>
                    {trueProfit >= 0 ? '+' : ''}{formatMoney(trueProfit)}
                  </span>
                </div>
              </div>
            );
          })()}
          {/* Catering service level */}
          <div style={{ padding: '10px 12px', background: 'var(--surface2)', borderRadius: 'var(--radius)', marginBottom: 14 }}>
            <CateringSelector
              value={catLevel ?? 'full'}
              onChange={setRouteCatering}
              distKm={dist}
              label={catLevel ? 'Catering service' : 'Catering service · mixed across aircraft'}
            />
          </div>
          {/* Quality score breakdown — engine-accurate per-source points */}
          {(() => {
            const r0 = playerRoutes[0];
            const ac = r0 ? state.fleet.find(a => a.id === r0.aircraftId) : null;
            return ac ? <QualityBreakdownPanel route={r0} aircraft={ac} state={state} /> : null;
          })()}
          {/* Load factor by class */}
          {activeClasses.length > 0 && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: playerSims.length > 1 ? 14 : 0 }}>
              {activeClasses.map(cls => {
                const { loadFactor, pax, seats } = aggregateClasses[cls];
                const lf = loadFactor;
                const color = lf >= 0.75 ? 'var(--green)' : lf >= 0.45 ? 'var(--yellow)' : 'var(--red)';
                return (
                  <div key={cls} style={{
                    flex: '1 1 120px', background: 'var(--surface2)', borderRadius: 'var(--radius)',
                    padding: '10px 12px', borderTop: `3px solid ${CLASS_COLORS[cls]}`,
                  }}>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>{CLASS_LABELS[cls]}</div>
                    <div style={{ fontWeight: 700, fontSize: 18, color }}>{formatPercent(lf)}</div>
                    <div style={{ height: 4, background: 'var(--surface3)', borderRadius: 2, overflow: 'hidden', margin: '5px 0' }}>
                      <div style={{ width: `${Math.round(lf * 100)}%`, height: '100%', background: color, transition: 'width 0.3s' }} />
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{Math.round(pax).toLocaleString()} / {seats.toLocaleString()} seats one-way/wk</div>
                  </div>
                );
              })}
            </div>
          )}
          {playerSims.length > 1 && (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, minWidth: 480 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    {['Aircraft', 'Freq', 'Pax (each way)', 'Load', ...activeClasses.map(c => CLASS_LABELS[c]), 'Revenue', 'Op Profit'].map(h => (
                      <th key={h} style={{ padding: '5px 10px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {playerSims.map(({ route, aircraft, result }) => (
                    <tr key={route.id} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                      <td style={{ padding: '7px 10px', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{aircraft.name}</td>
                      <td style={{ padding: '7px 10px', whiteSpace: 'nowrap' }}>{route.weeklyFrequency}×</td>
                      <td style={{ padding: '7px 10px', fontWeight: 600, whiteSpace: 'nowrap' }}>{result.passengers.toLocaleString()}</td>
                      <td style={{ padding: '7px 10px', fontWeight: 600, whiteSpace: 'nowrap', color: result.loadFactor >= 0.75 ? 'var(--green)' : result.loadFactor >= 0.45 ? 'var(--yellow)' : 'var(--red)' }}>{formatPercent(result.loadFactor)}</td>
                      {activeClasses.map(cls => {
                        const cs = result.classSummary?.[cls];
                        if (!cs) return <td key={cls} style={{ padding: '7px 10px', color: 'var(--text-dim)' }}>—</td>;
                        const lf = cs.loadFactor;
                        return (
                          <td key={cls} style={{ padding: '7px 10px', whiteSpace: 'nowrap', color: lf >= 0.75 ? 'var(--green)' : lf >= 0.45 ? 'var(--yellow)' : 'var(--red)', fontWeight: 600 }}>
                            {formatPercent(lf)}
                          </td>
                        );
                      })}
                      <td style={{ padding: '7px 10px', color: 'var(--green)', whiteSpace: 'nowrap' }}>{formatMoney(result.revenue)}</td>
                      <td style={{ padding: '7px 10px', whiteSpace: 'nowrap', color: result.profit >= 0 ? 'var(--green)' : 'var(--red)' }}>{result.profit >= 0 ? '+' : ''}{formatMoney(result.profit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Row 3: Competitors — full width */}
      {competitorsOnRoute.length > 0 && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 12 }}>Competitors</div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 560 }}>
              <thead>
                <tr style={{ background: 'var(--surface2)' }}>
                  {['Airline', 'Tier', 'Aircraft', 'Freq/wk', 'Seats/wk (one-way)', 'Est. Price', 'Quality', 'Est. Pax (one-way)'].map(h => (
                    <th key={h} style={{ padding: '7px 12px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {competitorsOnRoute.map(c => {
                  const cfg       = c.routes[routeKey];
                  const offer     = buildCompetitorOffer(c, market);
                  const estPrice  = offer?.economyPrice ?? Math.round(refP * cfg.priceMultiplier);
                  const estSeats  = offer?.economySeats ?? 150 * cfg.frequency;
                  const priceDiff = Math.round((estPrice / refP - 1) * 100);
                  const share     = shareResults.find(s => s.airlineId === c.id);
                  return (
                    <tr key={c.id} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                      <td style={{ padding: '8px 12px', fontWeight: 600, whiteSpace: 'nowrap' }}>{c.name}</td>
                      <td style={{ padding: '8px 12px' }}><TierBadge tier={c.tier} /></td>
                      <td style={{ padding: '8px 12px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                        {cfg.aircraftType
                          ? `${cfg.tails ?? 1}× ${getAircraftType(cfg.aircraftType)?.name ?? cfg.aircraftType}`
                          : '—'}
                      </td>
                      <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>{cfg.frequency}× each way</td>
                      <td style={{ padding: '8px 12px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{estSeats.toLocaleString()}</td>
                      <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>
                        ${estPrice}
                        <span style={{ fontSize: 11, marginLeft: 5, color: priceDiff > 0 ? 'var(--red)' : 'var(--green)' }}>
                          ({priceDiff >= 0 ? '+' : ''}{priceDiff}%)
                        </span>
                      </td>
                      <td style={{ padding: '8px 12px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <div style={{ width: 48, height: 5, background: 'var(--surface3)', borderRadius: 3, overflow: 'hidden', flexShrink: 0 }}>
                            <div style={{ width: `${c.baseQualityScore}%`, height: '100%', background: TIER_COLOR[c.tier] ?? 'var(--accent)' }} />
                          </div>
                          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{c.baseQualityScore}</span>
                        </div>
                      </td>
                      <td style={{ padding: '8px 12px', fontWeight: 600, whiteSpace: 'nowrap' }}>
                        {share ? share.totalPax.toLocaleString() : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Row 4: Connecting passengers — full width */}
      {(connecting.totalPax > 0 || (lastConn?.totalPax ?? 0) > 0) && (
        <div className="card">
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Connecting Passengers</div>
          <div style={{ fontSize: 12, color: 'var(--accent)', marginBottom: 12 }}>
            {lastConn
              ? <>+{lastConn.totalPax} pax · {formatMoney(lastConn.totalRevenue)}/wk last week
                  {lastConn.itineraryPax > 0 && <span style={{ color: 'var(--text-muted)' }}> ({lastConn.itineraryPax} via hub itineraries, {lastConn.externalPax} gateway feed)</span>}
                  {lastConn.capacityScale < 1 && <span style={{ color: 'var(--yellow)' }}> · seat-limited ×{lastConn.capacityScale}</span>}
                </>
              : <>+{connecting.totalPax} pax · {formatMoney(connecting.totalRevenue)}/wk (gateway feed estimate)</>}
          </div>
          {/* Own-metal itinerary feed: real O&D markets connecting over your hubs */}
          {(lastConn?.feeds?.length ?? 0) > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
                Feeding markets (via your hubs)
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {lastConn.feeds.slice(0, 6).map((f, i) => (
                  <div key={i} style={{
                    padding: '4px 10px', background: 'var(--surface2)', borderRadius: 'var(--radius)',
                    border: '1px solid var(--border)', fontSize: 12,
                  }}>
                    <span style={{ fontWeight: 700 }}>{f.od}</span>
                    <span style={{ color: 'var(--text-muted)' }}> via {f.viaHub} · {f.pax} pax · {formatMoney(f.revenue)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {[{ label: origin, side: connecting.origin }, { label: dest, side: connecting.destination }].map(({ label, side }) =>
              side.pax > 0 && (
                <div key={label} style={{
                  flex: '1 1 180px', background: 'var(--surface2)', borderRadius: 'var(--radius)',
                  padding: '12px 14px', borderLeft: `3px solid ${side.source === 'own-hub' ? 'var(--green)' : 'var(--accent)'}`,
                }}>
                  <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}><AirportLink code={label} style={{ fontSize: 15, fontWeight: 700 }} /></div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: side.source === 'own-hub' ? 'var(--green)' : 'var(--accent)' }}>
                    +{side.pax} <span style={{ fontSize: 12, fontWeight: 400 }}>pax/wk</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                    <GlyphLabel size={12} text={side.source === 'own-hub' ? '✓ Own hub · 100% yield' : side.source === 'partner-hub' ? 'Partner hub · 80% yield' : 'Gateway · 80% yield'} />
                  </div>
                  {/* Breakdown for own-hub endpoints */}
                  {side.source === 'own-hub' && (
                    <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 5, display: 'flex', flexWrap: 'wrap', gap: '2px 10px' }}>
                      {side.externalPax > 0 && <span>Ext {side.externalPax}</span>}
                      {side.internalPax > 0 && <span>Int {side.internalPax}</span>}
                      {side.freqMult != null && side.freqMult !== 1 && (
                        <span style={{ color: side.freqMult > 1 ? 'var(--green)' : 'var(--red)' }}>
                          Freq ×{side.freqMult.toFixed(1)}
                        </span>
                      )}
                      {side.distBonus > 0.02 && (
                        <span style={{ color: 'var(--accent)' }}>
                          Long-haul +{Math.round(side.distBonus * 100)}%
                        </span>
                      )}
                      {side.partnerBoost > 0 && (
                        <span style={{ color: 'var(--purple)' }}>
                          Partners +{Math.round(side.partnerBoost * 100)}%
                        </span>
                      )}
                      {side.congestion < 0.99 && (
                        <span style={{ color: 'var(--yellow)' }}>
                          Congestion ×{side.congestion.toFixed(2)}
                        </span>
                      )}
                    </div>
                  )}
                  <div style={{ fontSize: 12, color: 'var(--green)', marginTop: 4 }}>{formatMoney(side.revenue)}/wk</div>
                </div>
              )
            )}
          </div>
        </div>
      )}
    </div>
  );
}
