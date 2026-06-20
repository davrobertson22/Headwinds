import { useMemo } from 'react';
import { useGame } from '../store/GameContext.jsx';
import { formatMoney, formatPercent, referencePrice, loyaltyPenetration, loyaltyReputationBonus } from '../utils/simulation.js';
import { getAircraftType } from '../data/aircraft.js';
import { getAirport } from '../data/airports.js';
import { LABOR_GROUPS, laborEffects, moraleColor } from '../data/labor.js';
import { computeQualityScore } from '../models/demand.js';
import { Glyph } from './Icons.jsx';

// ─── Reputation scoring constants ────────────────────────────────────────────

const QUALITY_SCORE = { basic: 15, standard: 45, premium: 72, luxury: 100 };

// Competitor brand benchmarks (fixed reference points for positioning map)
const COMPETITOR_POSITIONS = [
  { id: 'zoomjet',  name: 'ZoomJet',   x: 0.28, y: 0.12, color: '#ffb43d' },
  { id: 'globalair',name: 'Global Air', x: 0.58, y: 0.55, color: '#3ea6ff' },
  { id: 'apexair',  name: 'Apex Air',   x: 0.82, y: 0.88, color: '#a98bff' },
];

// ─── Pure calculation functions ───────────────────────────────────────────────

function calcReputation(state) {
  const { fleet, routes, financialHistory, labor, loyalty } = state;
  const effects = laborEffects(labor);

  // ── Service score (35%) ────────────────────────────────────────────────────
  // Based on average cabin quality of assigned aircraft, filtered through morale
  const assignedFleet = fleet.filter(a => routes.some(r => r.aircraftId === a.id));
  const serviceBase = assignedFleet.length > 0
    ? assignedFleet.reduce((s, a) => {
        const seatQ = QUALITY_SCORE[a.config?.seatQuality  ?? 'standard'] ?? 45;
        const servQ = QUALITY_SCORE[a.config?.serviceQuality ?? 'standard'] ?? 45;
        return s + (seatQ + servQ) / 2;
      }, 0) / assignedFleet.length
    : 45;

  // Cabin crew morale boosts/hurts service delivery
  const cabinMorale = labor?.cabinCrew?.morale ?? 80;
  const serviceScore = Math.round(Math.min(100, serviceBase * (cabinMorale / 80)));

  // ── Fleet freshness score (20%) ────────────────────────────────────────────
  const avgAgeYears = fleet.length > 0
    ? fleet.reduce((s, a) => s + (a.ageWeeks ?? 0) / 52, 0) / fleet.length
    : 0;
  const fleetScore = Math.round(Math.max(0, 100 - avgAgeYears * 5));

  // ── Network score (20%) ────────────────────────────────────────────────────
  const airports  = new Set(routes.flatMap(r => [r.origin, r.destination]));
  const hubRoutes = routes.filter(r => r.origin === state.hub || r.destination === state.hub);
  const rawNet = airports.size * 4 + routes.length * 2 + hubRoutes.length * 3;
  const networkScore = Math.round(Math.min(100, rawNet));

  // ── Employee morale score (25%) ────────────────────────────────────────────
  const morales    = Object.values(labor ?? {}).map(g => g.morale ?? 80);
  const avgMorale  = morales.length > 0 ? morales.reduce((s, m) => s + m, 0) / morales.length : 80;
  // Financial health bonus/penalty
  const recentProfit = financialHistory.slice(-4).reduce((s, h) => s + (h.profit ?? 0), 0);
  const profitBump   = Math.max(-10, Math.min(10, recentProfit / 200000 * 10));
  const moraleScore  = Math.round(Math.min(100, Math.max(0, avgMorale + profitBump)));

  // Loyalty bonus: up to +8 reputation points for a deep, mature program.
  // Scales with member PENETRATION (share of your own flyers enrolled), so the
  // full +8 takes a sustained high-tier program at scale — not a quick win.
  const loyaltyMembers = loyalty?.members ?? 0;
  const loyaltyPax     = state.lastReport?.totalPassengers ?? 0;
  const loyaltyBonus   = loyaltyReputationBonus(loyaltyPenetration(loyaltyMembers, loyaltyPax));

  const overall = Math.min(100, Math.round(
    serviceScore * 0.35 +
    fleetScore   * 0.20 +
    networkScore * 0.20 +
    moraleScore  * 0.25 +
    loyaltyBonus
  ));

  // Quality score as fed into the demand model (mirrors computeQualityScore inputs)
  const qualityDemandScore = computeQualityScore({
    onTimeRate:     effects.onTimeRate,
    serviceLevel:   serviceBase >= 72 ? 'business' : serviceBase >= 60 ? 'premium' : 'economy',
    fleetAgeYears:  avgAgeYears,
    customerRating: effects.customerRating + effects.groundQualityBonus,
  });

  return { overall, service: serviceScore, fleet: fleetScore, network: networkScore, morale: moraleScore, qualityDemandScore, avgAgeYears, loyaltyBonus };
}

function calcPositioning(state) {
  const { fleet, routes } = state;
  if (routes.length === 0) return { x: 0.5, y: 0.5, pricePremium: 0, bizCapRatio: 0 };

  let totalSeats     = 0;
  let bizFirstSeats  = 0;
  let pricePremSum   = 0;
  let qualitySum     = 0;
  let routeCount     = 0;

  for (const route of routes) {
    const aircraft = fleet.find(a => a.id === route.aircraftId);
    const type     = aircraft ? getAircraftType(aircraft.typeId) : null;
    if (!aircraft || !type) continue;

    const cfg = aircraft.config ?? {};
    bizFirstSeats += (cfg.firstClass ?? 0) + (cfg.businessClass ?? 0);
    totalSeats    += type.seats;

    const refP          = referencePrice(route.origin, route.destination);
    const pricePremium  = (route.ticketPrice / Math.max(1, refP)) - 1;
    pricePremSum       += pricePremium;

    const seatQN  = { basic: 0, standard: 0.4, premium: 0.7, luxury: 1.0 }[cfg.seatQuality  ?? 'standard'] ?? 0.4;
    const servQN  = { basic: 0, standard: 0.4, premium: 0.7, luxury: 1.0 }[cfg.serviceQuality ?? 'standard'] ?? 0.4;
    qualitySum   += (seatQN + servQN) / 2;
    routeCount++;
  }

  if (routeCount === 0) return { x: 0.5, y: 0.5, pricePremium: 0, bizCapRatio: 0 };

  const bizCapRatio    = totalSeats > 0 ? bizFirstSeats / totalSeats : 0;
  const avgPricePrem   = pricePremSum / routeCount;
  const avgQuality     = qualitySum / routeCount;

  // X = Leisure (0) ↔ Business (1)
  // Business positioning driven by: cabin mix, premium pricing
  const bizFocus = Math.max(0, Math.min(1,
    bizCapRatio * 1.5 + (avgPricePrem > 0.2 ? 0.2 : avgPricePrem > 0 ? 0.1 : -0.05) + 0.15
  ));

  // Y = Budget (0) ↔ Premium (1)
  // Premium driven by: quality + price level
  const premiumLevel = Math.max(0, Math.min(1,
    avgQuality * 0.65 + Math.max(-0.2, Math.min(0.35, avgPricePrem + 0.3))
  ));

  return { x: bizFocus, y: premiumLevel, pricePremium: avgPricePrem, bizCapRatio };
}

function strategyLabel(pos) {
  const { x, y } = pos;
  if (y >= 0.6 && x >= 0.55) return { name: 'Premium Full-Service', color: '#a98bff', emoji: '💎', description: 'Positioned for business and premium leisure travel. High revenue per seat, brand commands a price premium. Focus on service consistency and business-friendly routes.' };
  if (y >= 0.6 && x <  0.55) return { name: 'Luxury Leisure',       color: '#38d39f', emoji: '🌴', description: 'Upscale but leisure-oriented. Sells a premium holiday experience. Strong in resort routes and seasonal markets. Demand is highly seasonal.' };
  if (y <  0.4 && x >= 0.55) return { name: 'Budget Business',      color: '#3ea6ff', emoji: '💼', description: 'Affordable business travel — think no-frills but reliable on corporate corridors. Works on short-haul business routes with high frequency.' };
  if (y <  0.4 && x <  0.55) return { name: 'Low-Cost Carrier',     color: '#ffb43d', emoji: '✂️', description: 'Volume over margin. Fill planes at low prices, minimise costs everywhere. Works best with high frequency, large fleets, and dense leisure routes.' };
  return { name: 'Mid-Market',               color: '#93a4ba', emoji: '🔄', description: 'Sitting in the middle. Not strongly differentiated yet. Consider pushing toward Premium or Low-Cost — the middle is the hardest place to compete.' };
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function Reputation() {
  const { state } = useGame();
  const { fleet, routes, airlineName, labor } = state;

  const rep = useMemo(() => calcReputation(state), [state]);
  const pos = useMemo(() => calcPositioning(state), [state]);
  const strategy = strategyLabel(pos);

  // Demand multiplier from reputation (centered at 50)
  const demandMultiplier = 1 + (rep.overall - 50) / 100 * 0.15;
  const elasticityReduction = (rep.overall - 50) / 100 * 0.20;

  // Awareness
  const awareness = state.awareness ?? 5;
  const awarenessMultiplier = 0.4 + (awareness / 100) * 0.6;

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

      {/* ── Brand health KPIs ── */}
      <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', marginBottom: 20 }}>
        <div className="stat-box" style={{ gridColumn: 'span 1' }}>
          <div className="stat-label">Overall Brand Score</div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, marginTop: 4 }}>
            <span style={{ fontSize: 32, fontWeight: 800, color: scoreColor(rep.overall) }}>{rep.overall}</span>
            <span style={{ fontSize: 14, color: 'var(--text-muted)', paddingBottom: 4 }}>/100</span>
          </div>
          <ScoreBar value={rep.overall} color={scoreColor(rep.overall)} />
        </div>
        <div className="stat-box">
          <div className="stat-label">Demand Bonus</div>
          <div style={{ fontWeight: 700, fontSize: 20, marginTop: 4, color: demandMultiplier > 1 ? 'var(--green)' : demandMultiplier < 1 ? 'var(--red)' : 'var(--text-muted)' }}>
            {demandMultiplier > 1 ? '+' : ''}{formatPercent(demandMultiplier - 1)}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>vs neutral airline</div>
        </div>
        <div className="stat-box">
          <div className="stat-label">Price Sensitivity</div>
          <div style={{ fontWeight: 700, fontSize: 20, marginTop: 4, color: elasticityReduction > 0 ? 'var(--green)' : elasticityReduction < 0 ? 'var(--red)' : 'var(--text-muted)' }}>
            {elasticityReduction >= 0 ? '−' : '+'}{formatPercent(Math.abs(elasticityReduction))}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>passengers less price-sensitive</div>
        </div>
        <div className="stat-box">
          <div className="stat-label">Quality Score (demand)</div>
          <div style={{ fontWeight: 700, fontSize: 20, marginTop: 4, color: scoreColor(rep.qualityDemandScore) }}>
            {Math.round(rep.qualityDemandScore)}<span style={{ fontSize: 13, fontWeight: 400, color: 'var(--text-muted)' }}>/100</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>as seen in demand model</div>
        </div>
        <div className="stat-box">
          <div className="stat-label">Brand Awareness</div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, marginTop: 4 }}>
            <span style={{ fontSize: 28, fontWeight: 800, color: scoreColor(awareness) }}>{Math.round(awareness)}</span>
            <span style={{ fontSize: 14, color: 'var(--text-muted)', paddingBottom: 4 }}>/100</span>
          </div>
          <ScoreBar value={awareness} color={scoreColor(awareness)} />
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
            Demand reach: <span style={{ color: scoreColor(awareness), fontWeight: 600 }}>{formatPercent(awarenessMultiplier - 1 + 1)}</span> of potential
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 16, marginBottom: 16 }}>

        {/* ── Positioning matrix ── */}
        <div className="card" style={{ marginBottom: 0 }}>
          <div className="card-title">Market Positioning</div>
          <PositioningMatrix pos={pos} airlineName={airlineName} strategy={strategy} />
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
          <div className="card-title">Brand Drivers</div>
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
            label="Brand Awareness"
            score={Math.round(awareness)}
            icon="📣"
            detail={`${formatPercent(awarenessMultiplier)} of potential demand reached. Grows via passengers flown + marketing spend.`}
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

function PositioningMatrix({ pos, airlineName, strategy }) {
  const W = 320, H = 220, PAD = 36;
  const plotW = W - PAD * 2;
  const plotH = H - PAD * 2;

  // Convert 0–1 to SVG coords
  const toSX = x => PAD + x * plotW;
  const toSY = y => PAD + (1 - y) * plotH; // flip Y

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

      {/* Competitor dots */}
      {COMPETITOR_POSITIONS.map(c => (
        <g key={c.id}>
          <circle cx={toSX(c.x)} cy={toSY(c.y)} r={6} fill={c.color + '44'} stroke={c.color} strokeWidth="1.5" />
          <text x={toSX(c.x) + 8} y={toSY(c.y) + 4} fontSize="9" fill={c.color}>{c.name}</text>
        </g>
      ))}

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
