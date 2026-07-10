import { Glyph } from './Icons.jsx';
import { useMemo } from 'react';
import { useGame } from '../store/GameContext.jsx';
import { getAirport } from '../data/airports.js';
import AirportLink from './AirportLink.jsx';
import { formatMoney } from '../utils/simulation.js';
import { absoluteWeek } from '../utils/fuel.js';
import {
  HUB_TIERS, HUB_MIN_GATES, HUB_TIER_COUNT, FOCUS_MIN_GATES,
  AIRPORT_GATEWAY_SCORES, hubUpgradeChecklist, hubCongestionFactor,
  playerRoutesAtAirport,
} from '../models/demand.js';

// ─── Tier pill ────────────────────────────────────────────────────────────────

function TierPill({ tier }) {
  const def = HUB_TIERS[tier];
  if (!def) return null;
  return (
    <span style={{
      background: def.color + '22',
      color: def.color,
      border: `1px solid ${def.color}55`,
      borderRadius: 4,
      padding: '2px 9px',
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: 0.2,
    }}>
      {def.name}
    </span>
  );
}

// ─── Stat tile ────────────────────────────────────────────────────────────────

function Stat({ label, value, sub, color }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 3 }}>{label}</div>
      <div style={{ fontWeight: 700, fontSize: 15, color: color ?? 'var(--text)' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

// ─── Prerequisite checklist ───────────────────────────────────────────────────

function PrereqChecklist({ checks }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
      {checks.map(c => (
        <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
          <span style={{ color: c.met ? 'var(--green, #4cc38a)' : 'var(--yellow)', fontWeight: 700, width: 14 }}>
            {c.met ? '✓' : '✗'}
          </span>
          <span style={{ color: c.met ? 'var(--text-muted)' : 'var(--text)' }}>
            {c.label}
            {typeof c.current === 'number' && typeof c.required === 'number' && !c.met && (
              <span style={{ color: 'var(--text-dim)' }}> — {c.current.toLocaleString()} / {c.required.toLocaleString()}</span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── Contest bar (hub competition) ────────────────────────────────────────────

function ContestBar({ contest, tier }) {
  if (!contest) return null;
  const share    = Math.round((contest.playerShare ?? 1) * 100);
  const fortress = tier === 3 && (contest.playerShare ?? 0) > 0.6;
  const rivals   = (contest.rivals ?? []).slice(0, 3);
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
        <span>
          Hub dominance — you {share}%
          {rivals.length > 0 && <span style={{ color: 'var(--text-dim)' }}> · {rivals.map(r => r.name).join(', ')}</span>}
        </span>
        {fortress && (
          <span style={{ color: 'var(--purple, #a98bff)', fontWeight: 700 }}>
            🏰 Fortress hub — +2 quality, pricing power
          </span>
        )}
        {!fortress && tier === 3 && share <= 60 && (
          <span style={{ color: 'var(--text-dim)' }}>60%+ share unlocks fortress bonus</span>
        )}
      </div>
      <div style={{ height: 6, background: 'var(--surface3)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{
          width: `${share}%`, height: '100%', borderRadius: 3,
          background: fortress ? 'var(--purple, #a98bff)' : 'var(--accent)',
        }} />
      </div>
    </div>
  );
}

// ─── Congestion meter ─────────────────────────────────────────────────────────

function CongestionMeter({ routesAt, gatesAt, tier }) {
  const threshold = HUB_TIERS[tier]?.gateRatioThreshold ?? 1.5;
  const factor    = hubCongestionFactor(routesAt, gatesAt, tier);
  const congested = factor < 1.0;
  if (!gatesAt) return null;
  return (
    <div style={{ fontSize: 12, marginBottom: 12, color: congested ? 'var(--yellow)' : 'var(--text-muted)' }}>
      {congested ? <><Glyph e="⚠" /> Congested</> : <><Glyph e="✓" /> Uncongested</>}
      {' — '}{routesAt} routes on {gatesAt} gates
      <span style={{ color: 'var(--text-dim)' }}>
        {' '}(handles {(threshold).toFixed(1)} routes/gate{congested
          ? ` · connecting traffic at ${Math.round(factor * 100)}% — buy gates to relieve`
          : ''})
      </span>
    </div>
  );
}

// ─── Hub card ─────────────────────────────────────────────────────────────────

function HubCard({ code, hubData, gateCount, routeCount, snap, lastReport }) {
  const { dispatch, state } = useGame();
  const airport = getAirport(code);
  const tier    = hubData.tier;
  const tierDef = HUB_TIERS[tier];

  const construction = (state.hubConstruction ?? {})[code];
  const contest      = lastReport?.hubContestMap?.[code];
  const throughput   = lastReport?.hubThroughput?.[code];
  const hubMarkets   = (lastReport?.ownMetalOD?.entries ?? []).filter(e => e.hub === code).slice(0, 5);
  const ownMetalHub  = lastReport?.ownMetalOD?.byHub?.[code];

  const isForeign = snap.homeCountry && airport?.country !== snap.homeCountry;
  const canUpgrade = tier < HUB_TIER_COUNT && !construction && !(tier === 0 && isForeign);
  const nextTier   = HUB_TIERS[tier + 1];
  const checklist  = canUpgrade ? hubUpgradeChecklist(snap, code, tier + 1) : null;

  function upgrade() { dispatch({ type: 'UPGRADE_HUB', airportCode: code }); }
  function downgrade() {
    const label = construction
      ? `Cancel construction (50% refund: ${formatMoney(Math.round((construction.capex ?? 0) * 0.5))})`
      : tier === 0 ? 'Remove focus city designation'
      : `Downgrade to ${HUB_TIERS[tier - 1]?.name}`;
    if (window.confirm(`${label} at ${code}?`)) {
      dispatch({ type: 'DOWNGRADE_HUB', airportCode: code });
    }
  }

  return (
    <div className="card" style={{ marginBottom: 12, borderLeft: `3px solid ${tierDef.color}` }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <AirportLink code={code} style={{ fontWeight: 700, fontSize: 22, letterSpacing: -0.5 }} />
            <TierPill tier={tier} />
            {tier === 0 && isForeign && (
              <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                <Glyph e="🌍" /> Foreign focus city — max designation abroad
              </span>
            )}
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            {airport?.name} · {airport?.city}, {airport?.country}
          </div>
        </div>
        <button
          className="btn btn-ghost"
          style={{ fontSize: 12, padding: '4px 10px', color: 'var(--text-dim)' }}
          onClick={downgrade}
        >
          {construction ? 'Cancel Construction' : tier === 0 ? 'Remove' : '↓ Downgrade'}
        </button>
      </div>

      {/* Construction banner */}
      {construction && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14,
          padding: '10px 14px', background: 'var(--surface2)',
          border: `1px dashed ${HUB_TIERS[construction.targetTier]?.color ?? 'var(--border)'}`,
          borderRadius: 'var(--radius)',
        }}>
          <span style={{ fontSize: 18 }}><Glyph e="🏗️" /></span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>
              Building {HUB_TIERS[construction.targetTier]?.name} — {construction.weeksLeft} {construction.weeksLeft === 1 ? 'week' : 'weeks'} to go
            </div>
            <div style={{ height: 5, background: 'var(--surface3)', borderRadius: 3, marginTop: 6, overflow: 'hidden' }}>
              <div style={{
                width: `${Math.round((1 - construction.weeksLeft / (HUB_TIERS[construction.targetTier]?.buildWeeks || 1)) * 100)}%`,
                height: '100%', background: HUB_TIERS[construction.targetTier]?.color ?? 'var(--accent)', borderRadius: 3,
              }} />
            </div>
          </div>
        </div>
      )}

      {/* Stats */}
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 14 }}>
        <Stat label="Gates"           value={gateCount}   sub="at this airport" />
        <Stat label="Routes"          value={routeCount}  sub="through hub" />
        <Stat label="Connecting"      value={(throughput ?? 0).toLocaleString()}
                                      sub={throughput != null ? 'pax/wk (last week)' : 'no data yet — advance a week'}
                                      color="var(--accent)" />
        <Stat label="Quality Boost"   value={`+${tierDef.qualityBonus} pts`} sub="on hub routes" color={tierDef.color} />
        <Stat label="Cost Efficiency" value={`−${Math.round(tierDef.stationDiscount * 100)}% / −${Math.round(tierDef.layoverDiscount * 100)}%`}
                                      sub="station / crew layover costs" />
        <Stat label="Investment"      value={formatMoney(tierDef.weeklyInvestment) + '/wk'} sub="weekly overhead" />
      </div>

      {/* Congestion + contest */}
      <CongestionMeter routesAt={routeCount} gatesAt={gateCount} tier={tier} />
      <ContestBar contest={contest} tier={tier} />

      {/* Top connecting markets over this hub */}
      {hubMarkets.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
            Top connecting markets over {code}
            {ownMetalHub && (
              <span style={{ textTransform: 'none', letterSpacing: 0 }}>
                {' '}— {ownMetalHub.pax.toLocaleString()} pax · {formatMoney(ownMetalHub.revenue)}/wk across {ownMetalHub.markets} markets
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {hubMarkets.map((m, i) => (
              <div key={i} style={{
                padding: '5px 10px', background: 'var(--surface2)', borderRadius: 'var(--radius)',
                border: '1px solid var(--border)', fontSize: 12,
              }}>
                <span style={{ fontWeight: 700 }}>{m.od}</span>
                <span style={{ color: 'var(--text-muted)' }}> · {m.pax} pax · {formatMoney(m.revenue)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tier progression */}
      <div style={{ display: 'flex', gap: 2, marginBottom: 14 }}>
        {[0, 1, 2, 3].map(t => {
          const td      = HUB_TIERS[t];
          const active  = t === tier;
          const reached = t <= tier;
          return (
            <div key={t} style={{
              flex: 1, padding: '8px 12px',
              background: active ? td.color + '22' : reached ? 'var(--surface2)' : 'var(--surface3)',
              border: `1px solid ${active ? td.color : 'var(--border)'}`,
              borderRadius: 'var(--radius)',
              opacity: reached ? 1 : 0.5,
            }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: active ? td.color : 'var(--text-muted)', marginBottom: 4 }}>
                {active && '● '}{td.name}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-dim)', lineHeight: 1.5 }}>
                {formatMoney(td.capex)} + {td.buildWeeks > 0 ? `${td.buildWeeks} wks` : 'instant'}<br />
                +{td.qualityBonus} quality · −{Math.round(td.stationDiscount * 100)}% station cost<br />
                {td.routesRequired > 0 ? `${td.routesRequired}+ routes` : `${td.minGates}+ gates`}
                {td.intlRequired > 0 && ` · ${td.intlRequired} int'l`}
              </div>
            </div>
          );
        })}
      </div>

      {/* Upgrade CTA with checklist */}
      {construction ? null : tier >= HUB_TIER_COUNT ? (
        <div style={{ fontSize: 12, color: tierDef.color, fontWeight: 600 }}>
          <Glyph e="✓" /> Maximum hub tier reached
        </div>
      ) : tier === 0 && isForeign ? (
        <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
          <Glyph e="🔒" /> Full hubs are restricted to {snap.homeCountry} — this focus city cannot be upgraded.
        </div>
      ) : (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button
              className="btn btn-primary"
              style={{ fontSize: 13 }}
              onClick={upgrade}
              disabled={!checklist?.ok}
            >
              {tier === 0 ? 'Promote to Hub' : `Upgrade to ${nextTier?.name}`}
              {' '}· {formatMoney(nextTier?.capex ?? 0)}{nextTier?.buildWeeks > 0 ? ` · ${nextTier.buildWeeks} wks` : ''}
            </button>
            {checklist?.ok && (
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                +{formatMoney((nextTier?.weeklyInvestment ?? 0) - tierDef.weeklyInvestment)}/wk overhead once complete
              </span>
            )}
          </div>
          {!checklist?.ok && checklist && <PrereqChecklist checks={checklist.checks} />}
        </div>
      )}
    </div>
  );
}

// ─── Designatable airport card ────────────────────────────────────────────────

function DesignatableCard({ code, gateCount, snap }) {
  const { dispatch } = useGame();
  const airport = getAirport(code);
  const gwScore = AIRPORT_GATEWAY_SCORES[code] ?? 0.20;
  const isForeign = snap.homeCountry && airport?.country !== snap.homeCountry;

  const focusCheck = hubUpgradeChecklist(snap, code, 0);
  const hubCheck   = hubUpgradeChecklist(snap, code, 1);
  const firstUnmet = (chk) => chk.checks.find(c => !c.met)?.label;

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 16, padding: '12px 16px',
      background: 'var(--surface2)', borderRadius: 'var(--radius)',
      border: '1px solid var(--border)', marginBottom: 8, flexWrap: 'wrap',
    }}>
      <div style={{ flex: 1, minWidth: 220 }}>
        <AirportLink code={code} style={{ fontWeight: 700, fontSize: 15, marginRight: 8 }} />
        <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{airport?.city}</span>
        {gwScore >= 0.50 && (
          <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--accent)' }}>
            <Glyph e="★" /> Major gateway
          </span>
        )}
        {isForeign && (
          <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--yellow)' }}>
            <Glyph e="🌍" /> Foreign — focus city only
          </span>
        )}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-muted)', minWidth: 70 }}>
        {gateCount} {gateCount === 1 ? 'gate' : 'gates'}
      </div>
      <button
        className="btn"
        style={{ fontSize: 12 }}
        onClick={() => dispatch({ type: 'DESIGNATE_FOCUS_CITY', airportCode: code })}
        disabled={!focusCheck.ok}
        title={focusCheck.ok ? `One-time cost ${formatMoney(HUB_TIERS[0].capex)}` : firstUnmet(focusCheck)}
      >
        Focus City · {formatMoney(HUB_TIERS[0].capex)}
      </button>
      <button
        className="btn btn-primary"
        style={{ fontSize: 12 }}
        onClick={() => dispatch({ type: 'DESIGNATE_HUB', airportCode: code })}
        disabled={!hubCheck.ok}
        title={hubCheck.ok
          ? `${formatMoney(HUB_TIERS[1].capex)} + ${HUB_TIERS[1].buildWeeks} weeks construction`
          : firstUnmet(hubCheck)}
      >
        Hub · {formatMoney(HUB_TIERS[1].capex)} · {HUB_TIERS[1].buildWeeks} wks
      </button>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function HubManagement() {
  const { state } = useGame();
  const hubs         = state.hubs  ?? (state.hub ? { [state.hub]: { tier: 1 } } : {});
  const construction = state.hubConstruction ?? {};
  const gates        = state.gates ?? {};
  const homeCountry  = state.homeCountry ?? null;
  const lastReport   = state.lastReport ?? null;

  // Snapshot for the shared prerequisite checklist (same inputs the reducer uses)
  const snap = useMemo(() => ({
    routes: state.routes, gates, homeCountry,
    hubs, hubThroughput: state.hubThroughput ?? {},
    cash: state.cash, absWeek: absoluteWeek(state.year, state.week),
  }), [state.routes, gates, homeCountry, hubs, state.hubThroughput, state.cash, state.year, state.week]);

  // Routes per airport (tag stops included)
  const routeCountByAirport = useMemo(() => {
    const map = {};
    const codes = new Set([...Object.keys(hubs), ...Object.keys(gates)]);
    for (const code of codes) map[code] = playerRoutesAtAirport(state.routes, code);
    return map;
  }, [state.routes, hubs, gates]);

  const hubCodes    = Object.keys(hubs);
  const totalConn   = hubCodes.reduce((s, c) => s + (lastReport?.hubThroughput?.[c] ?? 0), 0);
  const totalInvest = hubCodes.reduce((s, c) => s + (HUB_TIERS[hubs[c]?.tier]?.weeklyInvestment ?? 0), 0);
  const costSavings = lastReport?.totalHubCostSavings ?? 0;

  // Airports with 5+ gates, not designated, not under construction
  const designatable = Object.entries(gates)
    .filter(([code, count]) => count >= FOCUS_MIN_GATES && !hubs[code] && !construction[code])
    .sort(([, a], [, b]) => b - a);

  // Airports with 1–4 gates (working toward focus city status)
  const building = Object.entries(gates)
    .filter(([code, count]) => count > 0 && count < FOCUS_MIN_GATES && !hubs[code])
    .sort(([, a], [, b]) => b - a);

  return (
    <div>

      {/* ── Overview ── */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap', alignItems: 'center' }}>
          <Stat label="Designations"    value={hubCodes.length}
                                        sub={`${hubCodes.filter(c => hubs[c]?.tier >= 1).length} hubs · ${hubCodes.filter(c => hubs[c]?.tier === 0).length} focus cities`} />
          <Stat label="Connecting Pax"  value={totalConn.toLocaleString()}  sub="pax/wk across all hubs (last week)" color="var(--accent)" />
          <Stat label="Hub Investment"  value={totalInvest > 0 ? formatMoney(totalInvest) + '/wk' : 'None'} sub="ongoing overhead" />
          <Stat label="Cost Savings"    value={costSavings > 0 ? formatMoney(costSavings) + '/wk' : '—'}
                                        sub="station, catering & crew efficiencies" color="var(--green, #4cc38a)" />
        </div>
        <div style={{ marginTop: 12, padding: '10px 14px', background: 'var(--surface2)', borderRadius: 'var(--radius)', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
          <strong style={{ color: 'var(--text)' }}>How hubs work: </strong>
          Designations unlock connecting traffic between your routes — real one-stop itineraries sold over the hub — plus quality bonuses and operating-cost savings from your own ground staff, kitchens and crew bases.
          <strong style={{ color: 'var(--text)' }}> Focus cities</strong> ({FOCUS_MIN_GATES}+ gates) are cheap starter bases, allowed anywhere (max 1 per foreign country).
          <strong style={{ color: 'var(--text)' }}> Hubs</strong> ({HUB_MIN_GATES}+ gates) capture far more feed but cost real capex, take weeks to build, and demand a network to match — 20 routes for a Major Hub, 50 for an International Gateway.
          Watch congestion: each tier handles a set routes-per-gate ratio before connections suffer.
          {homeCountry && (
            <span> <Glyph e="🔒" /> Full hubs may only be built in your home country (<strong style={{ color: 'var(--text)' }}>{homeCountry}</strong>).</span>
          )}
        </div>
      </div>

      {/* ── Under construction (fresh designations without a hubs entry) ── */}
      {Object.entries(construction).filter(([code]) => !hubs[code]).map(([code, c]) => (
        <div key={code} className="card" style={{ marginBottom: 12, borderLeft: `3px solid ${HUB_TIERS[c.targetTier]?.color}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 20 }}><Glyph e="🏗️" /></span>
            <div style={{ flex: 1 }}>
              <AirportLink code={code} style={{ fontWeight: 700, fontSize: 16, marginRight: 8 }} />
              <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                Building {HUB_TIERS[c.targetTier]?.name} — {c.weeksLeft} {c.weeksLeft === 1 ? 'week' : 'weeks'} remaining
              </span>
              <div style={{ height: 5, background: 'var(--surface3)', borderRadius: 3, marginTop: 8, overflow: 'hidden' }}>
                <div style={{
                  width: `${Math.round((1 - c.weeksLeft / (HUB_TIERS[c.targetTier]?.buildWeeks || 1)) * 100)}%`,
                  height: '100%', background: HUB_TIERS[c.targetTier]?.color ?? 'var(--accent)', borderRadius: 3,
                }} />
              </div>
            </div>
          </div>
        </div>
      ))}

      {/* ── Your hubs & focus cities ── */}
      {hubCodes.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Your Hubs & Focus Cities
          </div>
          {hubCodes
            .sort((a, b) => (hubs[b]?.tier ?? 0) - (hubs[a]?.tier ?? 0))
            .map(code => (
              <HubCard
                key={code}
                code={code}
                hubData={hubs[code]}
                gateCount={gates[code] ?? 0}
                routeCount={routeCountByAirport[code] ?? 0}
                snap={snap}
                lastReport={lastReport}
              />
            ))
          }
        </div>
      )}

      {/* ── Ready to designate ── */}
      {designatable.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Ready to Designate
          </div>
          {designatable.map(([code, count]) => (
            <DesignatableCard key={code} code={code} gateCount={count} snap={snap} />
          ))}
        </div>
      )}

      {/* ── Building toward focus city status ── */}
      {building.length > 0 && (
        <div>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Building Toward Focus City Status
          </div>
          <div style={{ background: 'var(--surface2)', borderRadius: 'var(--radius)', border: '1px solid var(--border)', overflow: 'hidden' }}>
            {building.map(([code, count], i) => {
              const airport = getAirport(code);
              const pct     = Math.round(count / FOCUS_MIN_GATES * 100);
              return (
                <div key={code} style={{
                  display: 'flex', alignItems: 'center', gap: 16, padding: '10px 16px',
                  borderTop: i > 0 ? '1px solid var(--border-subtle)' : 'none',
                }}>
                  <div style={{ flex: 1 }}>
                    <AirportLink code={code} style={{ fontWeight: 700, marginRight: 8 }} />
                    <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>{airport?.city}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ width: 100, height: 5, background: 'var(--surface3)', borderRadius: 3, overflow: 'hidden' }}>
                      <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)', borderRadius: 3 }} />
                    </div>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 70 }}>
                      {count} / {FOCUS_MIN_GATES} gates
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Empty state */}
      {hubCodes.length === 0 && designatable.length === 0 && building.length === 0 && Object.keys(construction).length === 0 && (
        <div className="empty-state" style={{ marginTop: 32 }}>
          <div className="empty-state-icon"><Glyph e="🏢" /></div>
          <div className="empty-state-text">No airports yet</div>
          <div style={{ marginTop: 8, fontSize: 13, color: 'var(--text-muted)' }}>
            Buy gates from the Gates tab to get started. You need {FOCUS_MIN_GATES} gates at an airport to designate a focus city, {HUB_MIN_GATES} for a full hub.
          </div>
        </div>
      )}
    </div>
  );
}
