import { useMemo } from 'react';
import { useGame } from '../store/GameContext.jsx';
import { formatMoney, formatPercent, referencePrice, loyaltyPenetration, loyaltyPaxBase, loyaltyEffectiveStrength, loyaltyReputationBonus, fleetAvgUtilization } from '../utils/simulation.js';
import { calcPositioning, strategyLabel } from '../models/positioning.js';
import { getAirport } from '../data/airports.js';
import { LABOR_GROUPS, laborEffects, moraleColor } from '../data/labor.js';
import { computeQualityScore } from '../models/demand.js';
import { calcReputation, reputationDemandMultiplier, reputationElasticityReduction } from '../models/reputation.js';
import { awarenessDemandMultiplier } from '../data/overhead.js';
import { Glyph } from './Icons.jsx';

// __HW_POSITIONING_REAL_RIVALS__  (sync assert marker — see MULTIPLAYER_PATCHES)
// Headwinds has NO AI airlines, so the positioning map plots the REAL human
// rivals in the world (state.competitors, each carrying a server-computed
// `positioning` {x,y}) instead of fabricated benchmark brands. Dot colors cycle
// through this palette; the player is always drawn last, larger and on top.
const RIVAL_COLORS = ['#3ea6ff', '#ffb43d', '#a98bff', '#38d39f', '#f472b6', '#5eead4', '#fb923c', '#93a4ba'];

// ─── Pure calculation functions ───────────────────────────────────────────────

// calcReputation now lives in models/reputation.js — shared with the engine,
// so the numbers this page shows are the ones weeklyTick actually applies.

// calcPositioning + strategyLabel now live in models/positioning.js — shared
// with the multiplayer server, which runs the identical formula over each human
// rival's state so the map below can plot real players (see PositioningMatrix).

// ─── Main component ───────────────────────────────────────────────────────────

export default function Reputation() {
  const { state } = useGame();
  const { fleet, routes, airlineName, labor, competitors } = state;

  const rep = useMemo(() => calcReputation(
    state,
    loyaltyReputationBonus(loyaltyEffectiveStrength(
      loyaltyPenetration(state.loyalty?.members ?? 0, loyaltyPaxBase(state) || (state.lastReport?.totalPassengers ?? 0)),
      state.loyalty?.maturity ?? 0,
    )),
    fleetAvgUtilization(fleet ?? [], [...(routes ?? []), ...(state.cargoRoutes ?? [])]),
  ), [state]);  // eslint-disable-line
  const pos = useMemo(() => calcPositioning(state), [state]);
  const strategy = strategyLabel(pos);

  // Same functions the engine applies in weeklyTick (demand multiplier on route
  // revenue; elasticity reduction on the player offer's price sensitivity).
  const demandMultiplier = reputationDemandMultiplier(rep.overall);
  const elasticityReduction = reputationElasticityReduction(rep.overall);

  // Awareness
  const awareness = state.awareness ?? 5;
  const awarenessMultiplier = awarenessDemandMultiplier(awareness);

  if (fleet.length === 0 && routes.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon"><Glyph e="⭐" /></div>
        <div className="empty-state-text">Lease aircraft and open routes to start building your brand.</div>
      </div>
    );
  }

  return (
    <div>

      {/* ── The three scores: Quality · Reputation · Awareness ── */}
      <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', marginBottom: 20 }}>
        <div className="stat-box">
          <div className="stat-label">Quality</div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, marginTop: 4 }}>
            <span style={{ fontSize: 32, fontWeight: 800, color: scoreColor(rep.qualityDemandScore) }}>{Math.round(rep.qualityDemandScore)}</span>
            <span style={{ fontSize: 14, color: 'var(--text-muted)', paddingBottom: 4 }}>/100</span>
          </div>
          <ScoreBar value={rep.qualityDemandScore} color={scoreColor(rep.qualityDemandScore)} />
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
            How good the product is — wins market share &amp; business travelers.
            {state.satisfaction != null && (
              <> Includes earned satisfaction <span style={{ color: scoreColor(state.satisfaction), fontWeight: 600 }}>{Math.round(state.satisfaction)}</span> → rating {((state.satisfaction / 100) * 5).toFixed(1)}★.</>
            )}
            {' '}Per-route detail on each route's page.
          </div>
        </div>
        <div className="stat-box">
          <div className="stat-label">Reputation</div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, marginTop: 4 }}>
            <span style={{ fontSize: 32, fontWeight: 800, color: scoreColor(rep.overall) }}>{rep.overall}</span>
            <span style={{ fontSize: 14, color: 'var(--text-muted)', paddingBottom: 4 }}>/100</span>
          </div>
          <ScoreBar value={rep.overall} color={scoreColor(rep.overall)} />
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
            How much travelers trust the brand — demand{' '}
            <span style={{ color: demandMultiplier >= 1 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
              {demandMultiplier >= 1 ? '+' : ''}{formatPercent(demandMultiplier - 1)}
            </span>
            {' '}· price sensitivity{' '}
            <span style={{ color: elasticityReduction >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
              {elasticityReduction >= 0 ? '−' : '+'}{formatPercent(Math.abs(elasticityReduction))}
            </span>
          </div>
        </div>
        <div className="stat-box">
          <div className="stat-label">Awareness</div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, marginTop: 4 }}>
            <span style={{ fontSize: 32, fontWeight: 800, color: scoreColor(awareness) }}>{Math.round(awareness)}</span>
            <span style={{ fontSize: 14, color: 'var(--text-muted)', paddingBottom: 4 }}>/100</span>
          </div>
          <ScoreBar value={awareness} color={scoreColor(awareness)} />
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
            How many travelers know you exist.{' '}
            {awarenessMultiplier > 1 ? 'Strong branding amplifies demand to' : 'Reaching'}{' '}
            <span style={{ color: scoreColor(awareness), fontWeight: 600 }}>{formatPercent(awarenessMultiplier)}</span>
            {' '}of {awarenessMultiplier > 1 ? 'baseline' : 'potential demand'}. Built by marketing &amp; flying.
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 16, marginBottom: 16 }}>

        {/* ── Positioning matrix ── */}
        <div className="card" style={{ marginBottom: 0 }}>
          <div className="card-title">Market Positioning</div>
          <PositioningMatrix pos={pos} airlineName={airlineName} strategy={strategy} competitors={competitors} />
          <div style={{ marginTop: 12, padding: '10px 14px', borderRadius: 8,
            background: strategy.color + '14', border: `1px solid ${strategy.color}33` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span style={{ display: 'inline-flex', color: strategy.color }}><Glyph e={strategy.emoji} size={18} /></span>
              <strong style={{ color: strategy.color }}>{strategy.name}</strong>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
              {strategy.description}
            </div>
          </div>
        </div>

        {/* ── Score breakdown ── */}
        <div className="card" style={{ marginBottom: 0 }}>
          <div className="card-title">Reputation Drivers</div>
          <DimensionRow
            label="Service Quality"
            score={rep.service}
            icon="🎯"
            detail={`Cabin quality + crew morale. Cabin crew at ${labor?.cabinCrew?.morale ?? 80}% morale.`}
            tip={rep.service < 60 ? 'Upgrade seat/service quality in Fleet → Configure' : undefined}
          />
          <DimensionRow
            label="Fleet Freshness"
            score={rep.fleet}
            icon="✈️"
            detail={`Avg fleet age: ${rep.avgAgeYears.toFixed(1)} years. Newer aircraft = higher score.`}
            tip={rep.avgAgeYears > 10 ? 'Retire older aircraft and lease newer ones' : undefined}
          />
          <DimensionRow
            label="Network Reach"
            score={rep.network}
            icon="🌐"
            detail={`${new Set(routes.flatMap(r => [r.origin, r.destination])).size} airports, ${routes.length} routes, ${routes.filter(r => r.origin === state.hub || r.destination === state.hub).length} hub routes.`}
            tip={rep.network < 40 ? 'Expand your route network to build brand presence' : undefined}
          />
          <DimensionRow
            label="Employee Morale"
            score={rep.morale}
            icon="👥"
            detail={laborSummary(labor)}
            tip={rep.morale < 60 ? 'Raise pay multipliers for struggling groups' : undefined}
          />
          <DimensionRow
            label="Awareness"
            score={Math.round(awareness)}
            icon="📣"
            detail={`${formatPercent(awarenessMultiplier)} of ${awarenessMultiplier > 1 ? 'baseline demand (strong branding amplifies reach past 100%)' : 'potential demand'} reached. Grows via passengers flown + brand marketing (with a lag); fades slowly without upkeep.`}
            tip={awareness < 40 ? 'Increase marketing budget or fly more passengers to build awareness' : undefined}
          />
        </div>
      </div>

      {/* ── Labor morale breakdown ── */}
      <div className="card">
        <div className="card-title">Staff Morale</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          {LABOR_GROUPS.map(group => {
            const groupState = labor?.[group.id] ?? { payMultiplier: 1.0, morale: 80 };
            const morale = groupState.morale ?? 80;
            const pay    = groupState.payMultiplier ?? 1.0;
            return (
              <div key={group.id} style={{ background: 'var(--surface2)', borderRadius: 8, padding: '12px 14px', border: `1px solid var(--border)` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ display: 'inline-flex' }}><Glyph e={group.emoji} size={16} /></span>
                    <span style={{ fontWeight: 600, fontSize: 13 }}>{group.name}</span>
                  </div>
                  <span style={{ fontWeight: 700, fontSize: 16, color: moraleColor(morale) }}>{morale}</span>
                </div>
                <ScoreBar value={morale} color={moraleColor(morale)} height={4} />
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                  {group.effectDescription(morale)}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 3 }}>
                  Pay: {(pay * 100).toFixed(0)}% of market rate
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-muted)' }}>
          Manage pay multipliers and conditions in the <strong>Labor</strong> tab to improve morale.
          Higher morale → better quality score → more demand.
        </div>
      </div>

      {/* ── Demand impact per route ── */}
      {routes.length > 0 && (
        <div className="card">
          <div className="card-title">How Reputation Affects Your Routes</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
            {routes.slice(0, 6).map(route => {
              const aircraft = fleet.find(a => a.id === route.aircraftId);
              const origin = getAirport(route.origin);
              const dest   = getAirport(route.destination);
              const refP   = referencePrice(route.origin, route.destination);
              const priceRatio = route.ticketPrice / Math.max(1, refP);
              const positioning = priceRatio > 1.1 ? 'premium' : priceRatio < 0.9 ? 'budget' : 'mid';
              const posColor = { premium: 'var(--green)', budget: 'var(--yellow)', mid: 'var(--text-muted)' }[positioning];
              return (
                <div key={route.id} style={{ background: 'var(--surface2)', borderRadius: 8, padding: '10px 12px', border: '1px solid var(--border)' }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{route.origin} → {route.destination}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
                    {origin?.city} → {dest?.city}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                    <span style={{ color: 'var(--text-muted)' }}>Price vs ref</span>
                    <span style={{ color: posColor, fontWeight: 600 }}>
                      {priceRatio >= 1 ? '+' : ''}{formatPercent(priceRatio - 1)}
                      {' '}
                      <span style={{ color: posColor, fontSize: 10 }}>({positioning})</span>
                    </span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginTop: 2 }}>
                    <span style={{ color: 'var(--text-muted)' }}>Demand boost</span>
                    <span style={{ color: demandMultiplier > 1 ? 'var(--green)' : 'var(--text-muted)', fontWeight: 600 }}>
                      {demandMultiplier > 1 ? '+' : ''}{formatPercent(demandMultiplier - 1)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
          {routes.length > 6 && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
              + {routes.length - 6} more routes (all benefit equally from brand reputation).
            </div>
          )}
        </div>
      )}

      {/* ── Strategy guide ── */}
      <div className="card">
        <div className="card-title">Strategy Playbook</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <StrategyCard
            emoji="✂️" name="Low-Cost Carrier"
            active={strategy.name === 'Low-Cost Carrier'}
            color="#ffb43d"
            howTo={[
              'Price 15–25% below reference on all routes',
              'Keep all cabins as economy (no premium classes)',
              'Maximise frequency and seat density',
              'Focus on leisure-heavy routes (holiday destinations, domestic)',
              'Keep fleet modern to minimise maintenance costs',
            ]}
            payoff="High volume, thin margins. Profitable at high load factors (>80%)."
          />
          <StrategyCard
            emoji="💎" name="Premium Full-Service"
            active={strategy.name === 'Premium Full-Service'}
            color="#a98bff"
            howTo={[
              'Price 10–30% above reference',
              'Invest in business class and premium economy cabins',
              'Set service quality to Premium or Luxury',
              'Pay staff above market rate (1.2–1.3× multiplier)',
              'Focus on business hubs and long-haul routes',
            ]}
            payoff="High revenue per seat, lower volume. Profitable even at 55–65% load."
          />
        </div>
      </div>
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────────

function ScoreBar({ value, color, height = 6 }) {
  return (
    <div style={{ height, background: 'var(--surface3)', borderRadius: height / 2, overflow: 'hidden', marginTop: 6 }}>
      <div style={{ height: '100%', width: `${value}%`, background: color, borderRadius: height / 2, transition: 'width .3s' }} />
    </div>
  );
}

function DimensionRow({ label, score, icon, detail, tip }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ display: 'inline-flex' }}><Glyph e={icon} size={14} /></span>
          <span style={{ fontWeight: 600, fontSize: 13 }}>{label}</span>
        </div>
        <span style={{ fontWeight: 700, fontSize: 15, color: scoreColor(score) }}>{score}</span>
      </div>
      <ScoreBar value={score} color={scoreColor(score)} />
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>{detail}</div>
      {tip && <div style={{ fontSize: 11, color: 'var(--yellow)', marginTop: 2 }}>→ {tip}</div>}
    </div>
  );
}

function StrategyCard({ emoji, name, active, color, howTo, payoff }) {
  return (
    <div style={{
      borderRadius: 8, padding: '14px 16px',
      background: active ? `${color}10` : 'var(--surface2)',
      border: `1px solid ${active ? color + '44' : 'var(--border)'}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ display: 'inline-flex', color }}><Glyph e={emoji} size={20} /></span>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14, color: active ? color : 'var(--text)' }}>{name}</div>
          {active && <span style={{ fontSize: 10, color, textTransform: 'uppercase', letterSpacing: '.5px', fontWeight: 600 }}>Your current positioning</span>}
        </div>
      </div>
      <div style={{ fontSize: 12, marginBottom: 8 }}>
        {howTo.map((h, i) => (
          <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 3, color: 'var(--text-muted)' }}>
            <span style={{ color: active ? color : 'var(--text-dim)' }}>•</span>
            <span>{h}</span>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 11, color: active ? color : 'var(--text-dim)', fontStyle: 'italic' }}>{payoff}</div>
    </div>
  );
}

function PositioningMatrix({ pos, airlineName, strategy, competitors }) {
  const W = 320, H = 220, PAD = 36;
  const plotW = W - PAD * 2;
  const plotH = H - PAD * 2;

  // Convert 0–1 to SVG coords
  const toSX = x => PAD + x * plotW;
  const toSY = y => PAD + (1 - y) * plotH; // flip Y

  // Real human rivals carrying a server-computed positioning coordinate.
  const rivals = (competitors ?? []).filter(
    c => c && c.human && c.positioning &&
      Number.isFinite(c.positioning.x) && Number.isFinite(c.positioning.y),
  );

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: H }}>
      {/* Background quadrants */}
      {[
        { x: PAD,         y: PAD,         w: plotW/2, h: plotH/2, label: 'Premium\nLeisure',  color: '#38d39f08' },
        { x: PAD+plotW/2, y: PAD,         w: plotW/2, h: plotH/2, label: 'Premium\nBusiness', color: '#a98bff08' },
        { x: PAD,         y: PAD+plotH/2, w: plotW/2, h: plotH/2, label: 'Budget\nLeisure',   color: '#ffb43d08' },
        { x: PAD+plotW/2, y: PAD+plotH/2, w: plotW/2, h: plotH/2, label: 'Budget\nBusiness',  color: '#3ea6ff08' },
      ].map((q, i) => (
        <rect key={i} x={q.x} y={q.y} width={q.w} height={q.h} fill={q.color} />
      ))}

      {/* Grid lines */}
      <line x1={PAD} y1={PAD + plotH/2} x2={PAD + plotW} y2={PAD + plotH/2}
        stroke="var(--border)" strokeDasharray="4,4" strokeWidth="1" />
      <line x1={PAD + plotW/2} y1={PAD} x2={PAD + plotW/2} y2={PAD + plotH}
        stroke="var(--border)" strokeDasharray="4,4" strokeWidth="1" />

      {/* Axis labels */}
      <text x={W/2} y={H - 4}  textAnchor="middle" fontSize="10" fill="var(--text-muted)">LEISURE ←→ BUSINESS</text>
      <text x={6}   y={H/2}    textAnchor="middle" fontSize="10" fill="var(--text-muted)"
        transform={`rotate(-90, 6, ${H/2})`}>BUDGET ↑ PREMIUM</text>

      {/* Quadrant labels */}
      <text x={PAD + 4}               y={PAD + 12}         fontSize="8.5" fill="var(--text-dim)">Premium Leisure</text>
      <text x={PAD + plotW/2 + 4}     y={PAD + 12}         fontSize="8.5" fill="var(--text-dim)">Premium Business</text>
      <text x={PAD + 4}               y={PAD + plotH - 4}  fontSize="8.5" fill="var(--text-dim)">Budget Leisure</text>
      <text x={PAD + plotW/2 + 4}     y={PAD + plotH - 4}  fontSize="8.5" fill="var(--text-dim)">Budget Business</text>

      {/* Real human rivals — server-computed positioning (open book) */}
      {rivals.map((c, i) => {
        const color = RIVAL_COLORS[i % RIVAL_COLORS.length];
        const cx = toSX(c.positioning.x);
        const cy = toSY(c.positioning.y);
        const labelLeft = cx > PAD + plotW * 0.62;
        const short = c.name && c.name.length > 9 ? c.name.slice(0, 9) + '…' : (c.name ?? 'Rival');
        return (
          <g key={c.id}>
            <circle cx={cx} cy={cy} r={5} fill={color + '33'} stroke={color} strokeWidth="1.5" />
            <text
              x={labelLeft ? cx - 7 : cx + 7}
              y={cy + 3.5}
              textAnchor={labelLeft ? 'end' : 'start'}
              fontSize="8.5" fill={color}>{short}</text>
          </g>
        );
      })}

      {/* Player position */}
      <circle cx={toSX(pos.x)} cy={toSY(pos.y)} r={9} fill={strategy.color + '33'} stroke={strategy.color} strokeWidth="2.5" />
      <text x={toSX(pos.x)} y={toSY(pos.y) + 4} textAnchor="middle" fontSize="10" fill={strategy.color} fontWeight="700">✈</text>
      {/* Name label — clamp to bounds */}
      <text
        x={Math.min(W - 4, Math.max(PAD, toSX(pos.x)))}
        y={Math.max(14, toSY(pos.y) - 12)}
        textAnchor="middle" fontSize="9.5" fill={strategy.color} fontWeight="600">
        {airlineName?.length > 12 ? airlineName.slice(0, 12) + '…' : airlineName}
      </text>
    </svg>
  );
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function scoreColor(score) {
  if (score >= 70) return 'var(--green)';
  if (score >= 45) return 'var(--yellow)';
  return 'var(--red)';
}

function laborSummary(labor) {
  if (!labor) return 'No labor data yet.';
  const morales = Object.entries(labor).map(([k, v]) => {
    const names = { pilots: 'Pilots', cabinCrew: 'Cabin', groundStaff: 'Ground', maintenanceTeam: 'Maint' };
    return `${names[k] ?? k}: ${v.morale ?? 80}`;
  });
  return morales.join(' · ');
}
