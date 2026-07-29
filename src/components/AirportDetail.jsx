import { useMemo } from 'react';
import { useGame } from '../store/GameContext.jsx';
import { AIRPORTS, getAirport, gateCapacityOf } from '../data/airports.js';
import {
  baseCityPairDemand, referencePrice, formatMoney, formatPercent, SLOTS_PER_GATE,
  cargoSlotsUsedAt,
} from '../utils/simulation.js';
import {
  AIRPORT_GATEWAY_SCORES, HUB_TIERS,
} from '../models/demand.js';
import { pairMarketShare } from '../../packages/engine/src/models/pairShare.js';
import { getAirportRestrictions } from '../data/airportRestrictions.js';
import { Glyph } from './Icons.jsx';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function weekToMonth(week) {
  return Math.min(12, Math.max(1, Math.ceil(week * 12 / 52)));
}

const TIER_COLOR = { budget: 'var(--yellow)', legacy: 'var(--accent)', premium: 'var(--purple)' };

function Stat({ label, value, sub, color }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 3 }}>{label}</div>
      <div style={{ fontWeight: 700, fontSize: 15, color: color ?? 'var(--text)' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function AirportDetail({ code, onBack }) {
  const { state } = useGame();
  const airport   = getAirport(code);
  const gates     = state.gates ?? {};
  const hubs      = state.hubs  ?? (state.hub ? { [state.hub]: { tier: 1 } } : {});
  const myGates   = gates[code] ?? 0;
  const hubInfo   = hubs[code];
  const hubTier   = hubInfo ? HUB_TIERS[hubInfo.tier] : null;

  const restrictions = getAirportRestrictions(code); // array, may be empty

  const slotCap  = myGates * SLOTS_PER_GATE;
  const slotsUsed = state.routes
    .filter(r => r.origin === code || r.destination === code)
    .reduce((s, r) => s + r.weeklyFrequency, 0)
    + cargoSlotsUsedAt(code, state.cargoRoutes);

  const gwScore = AIRPORT_GATEWAY_SCORES[code] ?? 0.20;

  // ── Gate situation (scarcity worlds only) ────────────────────────────────
  // In gate-scarcity worlds the server injects a live per-airport view with
  // capacity, how many gates are taken, and who holds them. Untouched airports
  // have no entry, so we fall back to the derived capacity and (at least) our
  // own holdings.
  const scarcity   = !!state.gateScarcityWorld;
  const gateMkt    = state.gateMarket?.airports?.[code] ?? null;
  const gateCap    = scarcity ? (gateMkt?.capacity ?? gateCapacityOf(airport)) : 0;
  const gateTaken  = gateMkt?.taken ?? myGates;
  const gateAvail  = Math.max(0, gateCap - gateTaken);
  // The ownership caps are silent until they bite. You can sit at exactly 60%
  // of an airport, or be in an alliance that between you holds all of it, and
  // nothing tells you — until an auction bid you placed months earlier is
  // voided at the year tick. State it here, where you'd go to look.
  const capNote = (() => {
    if (!scarcity || !gateMkt) return null;
    const { allianceTaken, maxAlliance, maxYours } = gateMkt;
    if (allianceTaken != null && maxAlliance != null && allianceTaken >= maxAlliance) {
      return {
        over: allianceTaken > maxAlliance,
        text: `Your alliance holds ${allianceTaken} of ${gateCap} gates here — at or over the ${maxAlliance}-gate combined cap. `
          + 'No member can lease, buy or win another gate at this airport until the alliance is back under it.',
      };
    }
    if (maxYours != null && myGates >= maxYours) {
      return {
        over: myGates > maxYours,
        text: `You hold ${myGates} of ${gateCap} gates here — at the ${maxYours}-gate single-airline cap. `
          + 'You cannot lease, buy or win another gate at this airport.',
      };
    }
    return null;
  })();

  const gateHolders = (gateMkt?.holders && gateMkt.holders.length > 0)
    ? gateMkt.holders
    : (myGates > 0 ? [{ name: state.airlineName, count: myGates, yours: true }] : []);

  // My routes at this airport
  const myRoutes = state.routes.filter(r => r.origin === code || r.destination === code);
  const myTotalFreq = myRoutes.reduce((s, r) => s + r.weeklyFrequency, 0);
  // Group deployments into distinct city pairs (multiple aircraft on the same
  // pair = one route), matching how the competitor rows below are counted.
  // Every route here touches `code`, so the other endpoint identifies the pair.
  const myPairs = Object.values(
    myRoutes.reduce((m, r) => {
      const other = r.origin === code ? r.destination : r.origin;
      if (!m[other]) m[other] = { other, frequency: 0 };
      m[other].frequency += r.weeklyFrequency;
      return m;
    }, {})
  );
  const myRouteCount = myPairs.length;

  // Top 15 city pairs involving this airport, by O&D demand
  const topPairs = useMemo(() => {
    return AIRPORTS
      .filter(a => a.code !== code)
      .map(a => ({
        code:   a.code,
        city:   a.city,
        demand: baseCityPairDemand(code, a.code),
        refP:   referencePrice(code, a.code),
      }))
      .sort((a, b) => b.demand - a.demand)
      .slice(0, 15);
  }, [code]);

  const totalAirportDemand = useMemo(
    () => topPairs.reduce((s, p) => s + p.demand, 0),
    [topPairs]
  );

  // Which competitors serve each pair
  const compRouteMap = useMemo(() => {
    const map = {};
    for (const comp of state.competitors ?? []) {
      for (const [key] of Object.entries(comp.routes ?? {})) {
        const [a, b] = key.split('-');
        const other  = a === code ? b : b === code ? a : null;
        if (!other) continue;
        if (!map[other]) map[other] = [];
        map[other].push(comp);
      }
    }
    return map;
  }, [code, state.competitors]);

  // Do I serve each pair?
  const myRouteSet = useMemo(() => {
    const s = new Set();
    for (const r of myRoutes) {
      s.add(r.origin === code ? r.destination : r.origin);
    }
    return s;
  }, [myRoutes, code]);

  // REAL passenger market share per pair, straight from the demand model.
  //
  // This column used to be `myFrequency / (myFrequency + rivalFrequency)` — a
  // count of departures wearing the label "Your Share". A player flying 35× a
  // week against a rival's 31× was told they held 53% of the market while
  // undercutting that rival by 26%, carrying 2.5× the seats, scoring higher on
  // quality and outspending them on advertising: none of those inputs appear
  // anywhere in a ratio of two flight counts. The demand model put the same
  // player at ~68%. Ask the model.
  const pairShares = useMemo(() => {
    const map = {};
    for (const pair of topPairs) {
      if (!myRouteSet.has(pair.code)) continue;   // only pairs you actually fly
      try {
        const { playerShare, contested } = pairMarketShare(state, code, pair.code);
        if (playerShare != null) map[pair.code] = { share: playerShare, contested };
      } catch {
        // A malformed route/fleet entry must never take down the airport page —
        // the cell falls back to "—" when its pair is missing from the map.
      }
    }
    return map;
  }, [topPairs, myRouteSet, state, code]);

  // All airlines present at this airport (for the presence summary)
  const airlinePresence = useMemo(() => {
    const result = [];

    // Player
    if (myRoutes.length > 0) {
      result.push({
        id:        'player',
        name:      state.airlineName,
        tier:      null,
        routes:    myRouteCount,
        frequency: myTotalFreq,
        isPlayer:  true,
      });
    }

    // Competitors
    const compsSeen = new Set();
    for (const [, comps] of Object.entries(compRouteMap)) {
      for (const c of comps) {
        if (!compsSeen.has(c.id)) {
          compsSeen.add(c.id);
          const compRoutes = Object.keys(c.routes ?? {}).filter(key => {
            const [a, b] = key.split('-');
            return a === code || b === code;
          });
          result.push({
            id:        c.id,
            name:      c.name,
            tier:      c.tier,
            routes:    compRoutes.length,
            frequency: compRoutes.reduce((s, key) => s + (c.routes[key]?.frequency ?? 0), 0),
            isPlayer:  false,
          });
        }
      }
    }

    return result.sort((a, b) => b.frequency - a.frequency);
  }, [myRoutes, compRouteMap, state.airlineName, myTotalFreq]);

  // Total weekly frequency across all carriers here → share of DEPARTURES per
  // airline. This is a schedule-presence measure, not a passenger measure — see
  // the note on pairShares below for why the two must not be confused.
  const totalPresenceFreq = useMemo(
    () => airlinePresence.reduce((s, a) => s + a.frequency, 0),
    [airlinePresence]
  );

  // ── Transit flows over this airport (real A→hub→C itineraries) ────────────────
  // The weekly network tick enumerates the actual connecting passengers you carry
  // over each of your hubs and saves the top itineraries onto lastReport. Filter to
  // the airport being viewed → an honest "who's connecting here, from where to
  // where" list. Only populated for YOUR designated hubs, after the first tick.
  const lastReport = state.lastReport;
  const transitFlows = useMemo(() => {
    return (lastReport?.ownMetalOD?.entries ?? [])
      .filter(e => e.hub === code)
      .map(e => {
        const [from, to] = String(e.od ?? '').split('→');
        return { ...e, from, to };
      })
      .filter(e => e.from && e.to)
      .sort((a, b) => b.pax - a.pax);
  }, [lastReport, code]);
  const hubTransit = lastReport?.ownMetalOD?.byHub?.[code] ?? null;
  const partnerTransitPax = useMemo(() => {
    return (lastReport?.partnerODRevenue?.entries ?? [])
      .filter(e => e.hub === code)
      .reduce((s, e) => s + (e.pax ?? 0), 0);
  }, [lastReport, code]);
  const maxTransitPax = transitFlows[0]?.pax ?? 1;

  return (
    <div>
      {/* Back + header */}
      <button className="btn btn-ghost" style={{ fontSize: 13, marginBottom: 14 }} onClick={onBack}>
        ← Back to Airports
      </button>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 26, letterSpacing: -0.5 }}>{code}</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 14, marginTop: 2 }}>
            {airport?.name} · {airport?.city}, {airport?.country}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {hubTier && (
            <span style={{
              background: hubTier.color + '22', color: hubTier.color,
              border: `1px solid ${hubTier.color}55`,
              borderRadius: 4, padding: '5px 12px', fontSize: 12, fontWeight: 700,
            }}>
              {hubTier.name}
            </span>
          )}
          {myGates > 0 && (
            <span style={{ background: 'rgba(56,139,253,0.12)', color: 'var(--accent)', border: '1px solid rgba(56,139,253,0.3)', borderRadius: 4, padding: '5px 12px', fontSize: 12, fontWeight: 600 }}>
              {myGates} {myGates === 1 ? 'gate' : 'gates'}
            </span>
          )}
          {airport?.runwayFt && (
            <span title="Longest runway — aircraft that need more runway than this cannot operate here" style={{ background: 'var(--surface2)', color: 'var(--text-secondary)', border: '1px solid var(--border)', borderRadius: 4, padding: '5px 12px', fontSize: 12, fontWeight: 600, cursor: 'help' }}>
              <Glyph e="🛬" /> {airport.runwayFt.toLocaleString()} ft runway
            </span>
          )}
          {restrictions.map((r, i) => (
            <span key={i} style={{ background: 'rgba(220,53,69,0.12)', color: 'var(--red)', border: '1px solid rgba(220,53,69,0.35)', borderRadius: 4, padding: '5px 12px', fontSize: 12, fontWeight: 600 }}>
              <Glyph e="🚫" /> {r.shortLabel}
            </span>
          ))}
        </div>
      </div>

      {restrictions.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
          {restrictions.map((r, i) => (
            <div key={i} style={{
              background: 'rgba(220,53,69,0.07)',
              border: '1px solid rgba(220,53,69,0.25)',
              borderRadius: 'var(--radius)',
              padding: '10px 14px',
              fontSize: 13,
              color: 'var(--text-secondary)',
              lineHeight: 1.5,
            }}>
              <strong style={{ color: 'var(--red)' }}>{r.label}:</strong>{' '}
              {r.description}
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 }}>

        {/* GATE_SITUATION_CARD — who holds the gates here (scarcity worlds) */}
        {scarcity && (
          <div className="card">
            <div style={{ fontWeight: 600, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span>Gate Availability</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: gateAvail === 0 ? 'var(--red)' : gateTaken >= 0.9 * gateCap ? 'var(--yellow)' : 'var(--green)', background: gateAvail === 0 ? 'rgba(248,81,73,0.12)' : gateTaken >= 0.9 * gateCap ? 'rgba(210,153,34,0.12)' : 'rgba(63,185,80,0.12)', border: '1px solid var(--border)', borderRadius: 4, padding: '2px 8px' }}>
                {gateAvail === 0 ? 'FULL' : `${gateAvail} open`}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 14 }}>
              <Stat label="Total Gates" value={gateCap} sub="airport capacity" />
              <Stat label="Taken" value={gateTaken} color={gateTaken >= 0.9 * gateCap ? 'var(--yellow)' : 'var(--text)'} />
              <Stat label="Available" value={gateAvail} color={gateAvail === 0 ? 'var(--red)' : 'var(--green)'} />
              {myGates > 0 && <Stat label="Yours" value={myGates} color="var(--accent)" />}
            </div>
            {/* Capacity bar */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ height: 8, background: 'var(--surface3)', borderRadius: 4, overflow: 'hidden', display: 'flex' }}>
                {gateCap > 0 && (
                  <div style={{ width: `${Math.min(100, Math.round(myGates / gateCap * 100))}%`, height: '100%', background: 'var(--accent)' }} />
                )}
                {gateCap > 0 && (
                  <div style={{ width: `${Math.min(100, Math.round(Math.max(0, gateTaken - myGates) / gateCap * 100))}%`, height: '100%', background: 'var(--text-dim)', opacity: 0.6 }} />
                )}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 5 }}>
                <span style={{ color: 'var(--accent)' }}>■</span> your gates · <span style={{ color: 'var(--text-dim)' }}>■</span> other airlines · empty = available
              </div>
            </div>
            {capNote && (
              <div style={{
                fontSize: 12, lineHeight: 1.5, marginBottom: 14, padding: '8px 12px',
                borderRadius: 'var(--radius)',
                border: `1px solid ${capNote.over ? 'rgba(248,81,73,0.35)' : 'var(--border)'}`,
                background: capNote.over ? 'rgba(248,81,73,0.08)' : 'var(--surface2)',
                color: 'var(--text-muted)',
              }}>
                <strong style={{ color: capNote.over ? 'var(--red)' : 'var(--text)' }}>Ownership cap · </strong>
                {capNote.text}
              </div>
            )}

            {/* Who holds gates here */}
            {gateHolders.length > 0 ? (
              <div style={{ borderRadius: 'var(--radius)', overflow: 'hidden', border: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', padding: '6px 12px', background: 'var(--surface2)', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  <span style={{ flex: 1 }}>Gate holder</span>
                  <span>Gates</span>
                </div>
                {gateHolders.map((h, i) => {
                  const pct = gateCap > 0 ? Math.round(h.count / gateCap * 100) : 0;
                  return (
                    <div key={h.name + i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderTop: '1px solid var(--border-subtle)', background: h.yours ? 'rgba(56,139,253,0.06)' : 'transparent' }}>
                      <span style={{ flex: 1, fontWeight: h.yours ? 700 : 400, color: h.yours ? 'var(--accent)' : 'var(--text)', fontSize: 13 }}>
                        {h.yours && '▶ '}{h.name}
                      </span>
                      <div style={{ width: 80, height: 5, background: 'var(--surface3)', borderRadius: 3, overflow: 'hidden' }}>
                        <div style={{ width: `${pct}%`, height: '100%', background: h.yours ? 'var(--accent)' : 'var(--text-dim)', opacity: h.yours ? 0.9 : 0.6, borderRadius: 3 }} />
                      </div>
                      <span style={{ minWidth: 28, textAlign: 'right', fontWeight: 600, fontSize: 13 }}>{h.count}</span>
                    </div>
                  );
                })}
                {gateAvail > 0 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderTop: '1px solid var(--border-subtle)' }}>
                    <span style={{ flex: 1, fontSize: 13, color: 'var(--green)', fontWeight: 600 }}>Unclaimed / available</span>
                    <div style={{ width: 80, height: 5, background: 'var(--surface3)', borderRadius: 3, overflow: 'hidden' }}>
                      <div style={{ width: `${gateCap > 0 ? Math.round(gateAvail / gateCap * 100) : 0}%`, height: '100%', background: 'var(--green)', opacity: 0.5, borderRadius: 3 }} />
                    </div>
                    <span style={{ minWidth: 28, textAlign: 'right', fontWeight: 600, fontSize: 13, color: 'var(--green)' }}>{gateAvail}</span>
                  </div>
                )}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                No airline holds a gate here yet — all {gateCap} are available.
              </div>
            )}
          </div>
        )}

        {/* Your presence */}
        <div className="card">
          <div style={{ fontWeight: 600, marginBottom: 12 }}>Your Presence</div>
          {myGates === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
              You don't have any gates here yet.
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 14 }}>
                <Stat label="Gates"         value={myGates} />
                <Stat label="Slot Usage"    value={`${slotsUsed} / ${slotCap}`} sub="departures / wk" color={slotsUsed / slotCap > 0.8 ? 'var(--yellow)' : 'var(--text)'} />
                <Stat label="Routes"        value={myRouteCount} />
                <Stat label="Flights/wk"   value={myTotalFreq + '×'} />
              </div>
              {/* Slot utilisation bar */}
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Slot utilisation</div>
                <div style={{ height: 6, background: 'var(--surface3)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{
                    width: `${Math.min(100, slotsUsed / slotCap * 100)}%`,
                    height: '100%',
                    background: slotsUsed / slotCap > 0.9 ? 'var(--red)' : slotsUsed / slotCap > 0.7 ? 'var(--yellow)' : 'var(--green)',
                    borderRadius: 3,
                  }} />
                </div>
              </div>
              {/* My routes list */}
              {myRoutes.length > 0 && (
                <div style={{ borderRadius: 'var(--radius)', overflow: 'hidden', border: '1px solid var(--border)' }}>
                  {myPairs.map((p, i) => {
                    const otherAp = getAirport(p.other);
                    return (
                      <div key={p.other} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', borderTop: i > 0 ? '1px solid var(--border-subtle)' : 'none' }}>
                        <div style={{ flex: 1 }}>
                          <span style={{ fontWeight: 700, fontSize: 14 }}>{code} ⇄ {p.other}</span>
                          <span style={{ color: 'var(--text-muted)', fontSize: 12, marginLeft: 8 }}>{otherAp?.city}</span>
                        </div>
                        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{p.frequency}× / wk</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
          {hubTier && (
            <div style={{ marginTop: 12, padding: '10px 12px', background: 'var(--surface2)', borderRadius: 'var(--radius)', fontSize: 12, borderLeft: `3px solid ${hubTier.color}` }}>
              <span style={{ color: hubTier.color, fontWeight: 700 }}>{hubTier.name}</span>
              <span style={{ color: 'var(--text-muted)', marginLeft: 8 }}>
                {Math.round(hubTier.captureRate * 100)}% connecting capture · +{hubTier.qualityBonus} quality pts on hub routes
              </span>
            </div>
          )}
        </div>

        {/* Gateway / connecting pool */}
        <div className="card">
          <div style={{ fontWeight: 600, marginBottom: 12 }}>Transit & Connectivity</div>
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 14 }}>
            <Stat label="Gateway Score"    value={`${Math.round(gwScore * 100)}%`} sub="of traffic is transit" color={gwScore >= 0.65 ? 'var(--purple)' : gwScore >= 0.45 ? 'var(--accent)' : 'var(--text-muted)'} />
            <Stat label="Transit Pool"     value={Math.round(gwScore * 800).toLocaleString()} sub="weekly connecting pax available" />
          </div>
          <div style={{ height: 6, background: 'var(--surface3)', borderRadius: 3, overflow: 'hidden', marginBottom: 8 }}>
            <div style={{ width: `${Math.round(gwScore * 100)}%`, height: '100%', background: 'var(--purple)', borderRadius: 3 }} />
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 12 }}>
            {gwScore >= 0.65 ? 'Major international transit hub, high connecting traffic available' :
             gwScore >= 0.45 ? 'Significant gateway airport, moderate connecting traffic' :
             'Primary O&D airport, connecting traffic limited'}
          </div>
          {hubTier ? (
            <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              At <span style={{ color: hubTier.color, fontWeight: 600 }}>{hubTier.name}</span> tier, you capture ~
              <span style={{ color: 'var(--green)', fontWeight: 700 }}> {Math.round(gwScore * 800 * hubTier.captureRate)} pax/wk</span> from this pool per route.
            </div>
          ) : myGates > 0 ? (
            <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              Designate this as a hub (requires 10 gates) to start capturing connecting traffic.
            </div>
          ) : (
            <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              Buy gates here, then designate as a hub to unlock connecting traffic.
            </div>
          )}
          {transitFlows.length > 0 ? (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
                Connecting itineraries over {code}
                {hubTransit && <span style={{ textTransform: 'none', letterSpacing: 0, color: 'var(--text-dim)' }}> — {hubTransit.pax.toLocaleString()} pax · {formatMoney(hubTransit.revenue)}/wk across {hubTransit.markets} {hubTransit.markets === 1 ? 'market' : 'markets'}</span>}
              </div>
              <div style={{ borderRadius: 'var(--radius)', overflow: 'hidden', border: '1px solid var(--border)' }}>
                {transitFlows.slice(0, 12).map((e, i) => {
                  const barPct = Math.round(e.pax / maxTransitPax * 100);
                  const fromAp = getAirport(e.from);
                  const toAp   = getAirport(e.to);
                  return (
                    <div key={`${e.od}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 12px', borderTop: i > 0 ? '1px solid var(--border-subtle)' : 'none' }}>
                      <span style={{ fontWeight: 700, fontSize: 13, minWidth: 108 }} title={`${fromAp?.city ?? e.from} → ${toAp?.city ?? e.to}`}>{e.from} → {e.to}</span>
                      <div style={{ flex: 1, height: 5, background: 'var(--surface3)', borderRadius: 3, overflow: 'hidden', minWidth: 24 }}>
                        <div style={{ width: `${barPct}%`, height: '100%', background: 'var(--purple)', borderRadius: 3, opacity: 0.85 }} />
                      </div>
                      <span style={{ fontSize: 12, fontWeight: 600, minWidth: 62, textAlign: 'right' }}>{e.pax.toLocaleString()} pax</span>
                      <span style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 54, textAlign: 'right' }}>{formatMoney(e.revenue)}</span>
                    </div>
                  );
                })}
              </div>
              {partnerTransitPax > 0 && (
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6 }}>
                  +{partnerTransitPax.toLocaleString()} pax/wk via partner-fed connections
                </div>
              )}
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6 }}>
                Real connecting passengers you carried over {code} last week, by origin → destination.
              </div>
            </div>
          ) : (
            <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-dim)' }}>
              {hubTier
                ? <>No passengers connected over {code} last week — add spoke routes feeding both into and out of this hub so itineraries can form here.</>
                : <>No connecting itineraries over {code} yet — this fills in each week once {code} is a designated hub with spoke routes feeding through it.</>}
            </div>
          )}
        </div>

        {/* Airlines at this airport */}
        <div className="card">
          <div style={{ fontWeight: 600, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span>Airlines at {code}</span>
            <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-muted)' }}>
              {airlinePresence.length} {airlinePresence.length === 1 ? 'carrier' : 'carriers'}
            </span>
            {(() => {
              const me = airlinePresence.find(a => a.isPlayer);
              if (!me || totalPresenceFreq <= 0) return null;
              const pct = me.frequency / totalPresenceFreq * 100;
              return (
                <span
                  title={`Your share of scheduled departures at ${code} — a measure of schedule presence, not of passengers carried. For passenger share on a specific route, see Your Share in Passenger Flows below.`}
                  style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, color: 'var(--green)', background: 'rgba(63,185,80,0.12)', border: '1px solid rgba(63,185,80,0.3)', borderRadius: 4, padding: '2px 8px' }}>
                  Your departures {pct >= 10 ? Math.round(pct) : pct.toFixed(1)}%
                </span>
              );
            })()}
          </div>
          {airlinePresence.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No airline data available.</div>
          ) : (
            <div style={{ borderRadius: 'var(--radius)', overflow: 'hidden', border: '1px solid var(--border)' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: 'var(--surface2)' }}>
                    {/* "Departure share", NOT market share: this is each carrier's
                        slice of the flights scheduled here, which says nothing
                        about how many passengers they carry. Passenger share is
                        per-route and lives in the Passenger Flows table below. */}
                    {['Airline', 'Type', 'Routes', 'Flights/wk', 'Departure share'].map(h => (
                      <th key={h} style={{ padding: '6px 12px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {airlinePresence.map((a, i) => {
                    const share = totalPresenceFreq > 0 ? a.frequency / totalPresenceFreq : 0;
                    const sharePct = share * 100;
                    return (
                    <tr key={a.id} style={{ borderTop: i > 0 ? '1px solid var(--border-subtle)' : 'none', background: a.isPlayer ? 'rgba(63,185,80,0.05)' : 'transparent' }}>
                      <td style={{ padding: '7px 12px', fontWeight: a.isPlayer ? 700 : 400, color: a.isPlayer ? 'var(--green)' : 'var(--text)' }}>
                        {a.isPlayer && '▶ '}{a.name}
                      </td>
                      <td style={{ padding: '7px 12px' }}>
                        {a.tier ? (
                          <span style={{ color: TIER_COLOR[a.tier] ?? 'var(--text-muted)', fontSize: 11, fontWeight: 700, textTransform: 'capitalize' }}>{a.tier}</span>
                        ) : <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>your airline</span>}
                      </td>
                      <td style={{ padding: '7px 12px', color: 'var(--text-muted)' }}>{a.routes}</td>
                      <td style={{ padding: '7px 12px', fontWeight: 600 }}>{a.frequency * 2}×</td>
                      <td style={{ padding: '7px 12px', minWidth: 120 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div style={{ flex: 1, height: 6, background: 'var(--surface3)', borderRadius: 3, overflow: 'hidden', minWidth: 48 }}>
                            <div style={{
                              width: `${Math.round(sharePct)}%`, height: '100%', borderRadius: 3,
                              background: a.isPlayer ? 'var(--green)' : 'var(--accent)', opacity: a.isPlayer ? 0.9 : 0.5,
                            }} />
                          </div>
                          <span style={{ fontSize: 12, fontWeight: 600, color: a.isPlayer ? 'var(--green)' : 'var(--text-muted)', minWidth: 34, textAlign: 'right' }}>
                            {sharePct >= 10 ? Math.round(sharePct) : sharePct.toFixed(1)}%
                          </span>
                        </div>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Passenger flows — top pairs */}
        <div className="card" style={{ gridColumn: 'span 2' }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            Passenger Flows
            <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-muted)', marginLeft: 8 }}>
              top destinations by O&D demand
            </span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 12 }}>
            Total demand across top 15 pairs: {totalAirportDemand.toLocaleString()} pax/wk
          </div>
          <div style={{ overflowX: 'auto', borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'var(--surface2)' }}>
                  {['Destination', 'O&D Demand', 'Ref Price', 'You', 'Competitors', 'Your Share', 'Demand Bar'].map(h => (
                    <th key={h}
                      title={h === 'Your Share'
                        ? 'Share of passengers on this city pair, from the same demand model the weekly tick runs: fare, quality, frequency, seats, hub feed and advertising all count.'
                        : undefined}
                      style={{ padding: '7px 12px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {topPairs.map((pair, i) => {
                  const iServe    = myRouteSet.has(pair.code);
                  const comps     = compRouteMap[pair.code] ?? [];
                  const maxDemand = topPairs[0]?.demand ?? 1;
                  const barPct    = Math.round(pair.demand / maxDemand * 100);
                  const shareInfo = pairShares[pair.code] ?? null;
                  const myShare   = shareInfo ? shareInfo.share * 100 : null;
                  return (
                    <tr key={pair.code} style={{ borderTop: i > 0 ? '1px solid var(--border-subtle)' : 'none' }}>
                      <td style={{ padding: '7px 12px' }}>
                        <span style={{ fontWeight: 700 }}>{pair.code}</span>
                        <span style={{ color: 'var(--text-muted)', fontSize: 12, marginLeft: 6 }}>{pair.city}</span>
                      </td>
                      <td style={{ padding: '7px 12px', fontWeight: 600 }}>{pair.demand.toLocaleString()}</td>
                      <td style={{ padding: '7px 12px', color: 'var(--text-muted)' }}>${pair.refP}</td>
                      <td style={{ padding: '7px 12px' }}>
                        {iServe
                          ? <span style={{ color: 'var(--green)', fontSize: 12, fontWeight: 600 }}><Glyph e="✓" /> Serving</span>
                          : <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>—</span>
                        }
                      </td>
                      <td style={{ padding: '7px 12px' }}>
                        {comps.length > 0
                          ? <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{comps.map(c => c.name).join(', ')}</span>
                          : <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>—</span>
                        }
                      </td>
                      <td style={{ padding: '7px 12px', minWidth: 110 }}>
                        {myShare === null ? (
                          <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>—</span>
                        ) : (
                          <div
                            title={shareInfo?.contested
                              ? `${myShare.toFixed(1)}% of passengers on ${code}–${pair.code}, split against ${comps.length > 0 ? comps.map(c => c.name).join(', ') : 'your rivals'} on fare, quality, frequency, seats and advertising.`
                              : `You are the only carrier on ${code}–${pair.code} — you carry everyone who flies.`}
                            style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <div style={{ flex: 1, height: 5, background: 'var(--surface3)', borderRadius: 3, overflow: 'hidden', minWidth: 40 }}>
                              <div style={{
                                width: `${Math.round(myShare)}%`, height: '100%', borderRadius: 3,
                                background: iServe ? 'var(--green)' : 'var(--text-dim)', opacity: iServe ? 0.9 : 0.5,
                              }} />
                            </div>
                            <span style={{ fontSize: 12, fontWeight: 600, color: iServe ? 'var(--green)' : 'var(--text-muted)', minWidth: 34, textAlign: 'right' }}>
                              {myShare >= 10 ? Math.round(myShare) : myShare.toFixed(1)}%
                            </span>
                          </div>
                        )}
                      </td>
                      <td style={{ padding: '7px 12px', minWidth: 100 }}>
                        <div style={{ height: 5, background: 'var(--surface3)', borderRadius: 3, overflow: 'hidden' }}>
                          <div style={{
                            width: `${barPct}%`, height: '100%', borderRadius: 3,
                            background: iServe ? 'var(--green)' : 'var(--accent)', opacity: iServe ? 0.9 : 0.4,
                          }} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
