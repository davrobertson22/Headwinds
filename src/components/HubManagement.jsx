import { Glyph } from './Icons.jsx';
import { useMemo } from 'react';
import { useGame } from '../store/GameContext.jsx';
import { getAirport } from '../data/airports.js';
import AirportLink from './AirportLink.jsx';
import { formatMoney } from '../utils/simulation.js';
import {
  HUB_TIERS, HUB_MIN_GATES, HUB_TIER_COUNT,
  AIRPORT_GATEWAY_SCORES, computeConnectingDemand,
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

// ─── Hub card ─────────────────────────────────────────────────────────────────

function HubCard({ code, hubData, gateCount, routeCount, connectingEst }) {
  const { dispatch } = useGame();
  const airport = getAirport(code);
  const tier    = hubData.tier;
  const tierDef = HUB_TIERS[tier];

  function upgrade() { dispatch({ type: 'UPGRADE_HUB', airportCode: code }); }
  function downgrade() {
    const label = tier === 1 ? 'Remove hub designation' : 'Downgrade to ' + HUB_TIERS[tier - 1]?.name;
    if (window.confirm(`${label} at ${code}? You will lose the hub benefits.`)) {
      dispatch({ type: 'DOWNGRADE_HUB', airportCode: code });
    }
  }

  const canUpgrade   = tier < HUB_TIER_COUNT;
  const nextTier     = HUB_TIERS[tier + 1];
  const needsGates   = canUpgrade && nextTier && gateCount < nextTier.minGates;

  return (
    <div className="card" style={{ marginBottom: 12, borderLeft: `3px solid ${tierDef.color}` }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <AirportLink code={code} style={{ fontWeight: 700, fontSize: 22, letterSpacing: -0.5 }} />
            <TierPill tier={tier} />
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
          {tier === 1 ? 'Remove Hub' : '↓ Downgrade'}
        </button>
      </div>

      {/* Stats */}
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 16 }}>
        <Stat label="Gates"             value={gateCount}                           sub="at this airport" />
        <Stat label="Routes"            value={routeCount}                          sub="through hub" />
        <Stat label="Est. Connecting"   value={connectingEst.toLocaleString()}      sub="pax / wk" color="var(--accent)" />
        <Stat label="Quality Boost"     value={`+${tierDef.qualityBonus} pts`}      sub="on hub routes" color={tierDef.color} />
        <Stat label="Hub Investment"    value={tierDef.weeklyInvestment > 0 ? formatMoney(tierDef.weeklyInvestment) + '/wk' : 'Free'}
                                        sub={tier === 1 ? 'included with gates' : 'weekly overhead'} />
      </div>

      {/* Tier progression */}
      <div style={{ display: 'flex', gap: 2, marginBottom: 14 }}>
        {[1, 2, 3].map(t => {
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
                {t === tier && '● '}{td.name}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-dim)', lineHeight: 1.5 }}>
                {Math.round(td.captureRate * 100)}% capture rate<br />
                +{td.qualityBonus} quality pts<br />
                {td.weeklyInvestment > 0 ? formatMoney(td.weeklyInvestment) + '/wk' : 'No investment'}
              </div>
              {t > 1 && <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4 }}>
                Min. {td.minGates} gates
              </div>}
            </div>
          );
        })}
      </div>

      {/* Upgrade CTA */}
      {canUpgrade && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            className="btn btn-primary"
            style={{ fontSize: 13 }}
            onClick={upgrade}
            disabled={needsGates}
          >
            Upgrade to {nextTier?.name}
          </button>
          {needsGates && (
            <span style={{ fontSize: 12, color: 'var(--yellow)' }}>
              <Glyph e="⚠" /> Need {nextTier.minGates - gateCount} more gates first
            </span>
          )}
          {!needsGates && (
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              +{formatMoney((nextTier?.weeklyInvestment ?? 0) - tierDef.weeklyInvestment)}/wk · +{Math.round((nextTier?.captureRate - tierDef.captureRate) * 100)}% connecting traffic ·+{(nextTier?.qualityBonus ?? 0) - tierDef.qualityBonus} quality
            </span>
          )}
        </div>
      )}
      {!canUpgrade && (
        <div style={{ fontSize: 12, color: tierDef.color, fontWeight: 600 }}>
          <Glyph e="✓" /> Maximum hub tier reached
        </div>
      )}
    </div>
  );
}

// ─── Designatable airport card ────────────────────────────────────────────────

function DesignatableCard({ code, gateCount, homeCountry }) {
  const { dispatch } = useGame();
  const airport = getAirport(code);
  const gwScore = AIRPORT_GATEWAY_SCORES[code] ?? 0.20;
  const isForeign = homeCountry && airport?.country !== homeCountry;

  function designate() {
    dispatch({ type: 'DESIGNATE_HUB', airportCode: code });
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 16, padding: '12px 16px',
      background: 'var(--surface2)', borderRadius: 'var(--radius)',
      border: '1px solid var(--border)', marginBottom: 8,
      opacity: isForeign ? 0.6 : 1,
    }}>
      <div style={{ flex: 1 }}>
        <AirportLink code={code} style={{ fontWeight: 700, fontSize: 15, marginRight: 8 }} />
        <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{airport?.city}</span>
        {gwScore >= 0.50 && (
          <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--accent)' }}>
            <Glyph e="★" /> Major gateway
          </span>
        )}
        {isForeign && (
          <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--yellow)' }}>
            <Glyph e="🔒" /> Foreign airport — hubs restricted to {homeCountry}
          </span>
        )}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-muted)', minWidth: 70 }}>
        {gateCount} {gateCount === 1 ? 'gate' : 'gates'}
      </div>
      <button
        className="btn btn-primary"
        style={{ fontSize: 12 }}
        onClick={designate}
        disabled={isForeign}
        title={isForeign ? `Hubs can only be built in ${homeCountry}` : undefined}
      >
        Designate Hub
      </button>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function HubManagement() {
  const { state } = useGame();
  const hubs        = state.hubs  ?? (state.hub ? { [state.hub]: { tier: 1 } } : {});
  const gates       = state.gates ?? {};
  const homeCountry = state.homeCountry ?? null;

  // Routes per airport for connecting estimate
  const routeCountByAirport = useMemo(() => {
    const map = {};
    for (const r of state.routes) {
      map[r.origin]      = (map[r.origin]      ?? 0) + 1;
      map[r.destination] = (map[r.destination] ?? 0) + 1;
    }
    return map;
  }, [state.routes]);

  // Estimated total connecting pax/wk (sum over all hub airports, using a sample $400 ticket)
  function estConnectingAtHub(code) {
    const gwScore = AIRPORT_GATEWAY_SCORES[code] ?? 0.20;
    const pool    = gwScore * 800;
    const tier    = hubs[code]?.tier ?? 1;
    const tierDef = HUB_TIERS[tier] ?? HUB_TIERS[1];
    const routes  = routeCountByAirport[code] ?? 1;
    const netMult = Math.min(2.0, 1 + (routes - 1) * 0.10);
    return Math.round(pool * tierDef.captureRate * netMult);
  }

  const hubCodes     = Object.keys(hubs);
  const totalConnEst = hubCodes.reduce((s, c) => s + estConnectingAtHub(c), 0);
  const totalInvest  = hubCodes.reduce((s, c) => {
    const tier = hubs[c]?.tier ?? 1;
    return s + (HUB_TIERS[tier]?.weeklyInvestment ?? 0);
  }, 0);

  // Airports with 10+ gates but not yet designated as hubs
  const designatable = Object.entries(gates)
    .filter(([code, count]) => count >= HUB_MIN_GATES && !hubs[code])
    .sort(([, a], [, b]) => b - a);

  // Airports with 1–9 gates (working toward hub status)
  const building = Object.entries(gates)
    .filter(([code, count]) => count > 0 && count < HUB_MIN_GATES && !hubs[code])
    .sort(([, a], [, b]) => b - a);

  return (
    <div>

      {/* ── Overview ── */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap', alignItems: 'center' }}>
          <Stat label="Active Hubs"        value={hubCodes.length}                    />
          <Stat label="Est. Connecting Pax" value={totalConnEst.toLocaleString()}     sub="pax / wk across all hubs" color="var(--accent)" />
          <Stat label="Hub Investment"      value={totalInvest > 0 ? formatMoney(totalInvest) + '/wk' : 'None'}
                                            sub="ongoing overhead" />
        </div>
        <div style={{ marginTop: 12, padding: '10px 14px', background: 'var(--surface2)', borderRadius: 'var(--radius)', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
          <strong style={{ color: 'var(--text)' }}>How hubs work: </strong>
          Designating an airport as a hub unlocks connecting passenger traffic — passengers feeding in from other routes boost your load factors and revenue.
          Upgrade to higher tiers to capture more of this traffic and improve your reputation on all routes through that hub.
          You need at least <strong style={{ color: 'var(--text)' }}>10 gates</strong> to designate any hub, and <strong style={{ color: 'var(--text)' }}>20 gates</strong> for an International Gateway.
          {homeCountry && (
            <span> <Glyph e="🔒" /> <strong style={{ color: 'var(--text)' }}>Political restriction:</strong> hubs may only be built in your home country (<strong style={{ color: 'var(--text)' }}>{homeCountry}</strong>).</span>
          )}
        </div>
      </div>

      {/* ── Your hubs ── */}
      {hubCodes.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Your Hubs
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
                connectingEst={estConnectingAtHub(code)}
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
            <DesignatableCard key={code} code={code} gateCount={count} homeCountry={homeCountry} />
          ))}
        </div>
      )}

      {/* ── Building toward hubs ── */}
      {building.length > 0 && (
        <div>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Building Toward Hub Status
          </div>
          <div style={{ background: 'var(--surface2)', borderRadius: 'var(--radius)', border: '1px solid var(--border)', overflow: 'hidden' }}>
            {building.map(([code, count], i) => {
              const airport = getAirport(code);
              const pct     = Math.round(count / HUB_MIN_GATES * 100);
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
                      {count} / {HUB_MIN_GATES} gates
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Empty state */}
      {hubCodes.length === 0 && designatable.length === 0 && building.length === 0 && (
        <div className="empty-state" style={{ marginTop: 32 }}>
          <div className="empty-state-icon"><Glyph e="🏢" /></div>
          <div className="empty-state-text">No airports yet</div>
          <div style={{ marginTop: 8, fontSize: 13, color: 'var(--text-muted)' }}>
            Buy gates from the Gates tab to get started. You need 10 gates at an airport to designate it as a hub.
          </div>
        </div>
      )}
    </div>
  );
}
