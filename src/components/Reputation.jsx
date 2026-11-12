import { useMemo } from 'react';
import { useGame } from '../store/GameContext.jsx';
import { formatPercent, fleetAvgUtilization, stateLoyaltyReputationBonus } from '../utils/simulation.js';
import { calcPositioning, strategyLabel } from '../models/positioning.js';
import { calcReputation, reputationDemandMultiplier, reputationElasticityReduction } from '../models/reputation.js';
import { brandAppeal, qualityReasons } from '../models/brandAppeal.js';
import { awarenessDemandMultiplier } from '../data/overhead.js';
import MarketingPanel from './MarketingPanel.jsx';
import { Glyph } from './Icons.jsx';

// ─── The Brand page ───────────────────────────────────────────────────────────
//
// Once the Reputation tab (the id stays 'reputation' for saves and deep links).
// Three cards — business travellers, leisure travellers, quality — each a plain
// verdict with the two or three things helping or hurting most, and the full
// list one click away. The marketing controls sit underneath, beside the
// awareness they buy; reputation's own breakdown and the positioning map are
// folded away at the foot.
//
// The appeal cards read models/brandAppeal.js, which scores the same offers the
// weekly tick fights over (pairMarketShare) term by term (computeUtility), so
// "fewer flights than rivals" is the share fight's own reason, not a guess.
// calcReputation and positioning live in models/ for the same reason; the
// server runs the same positioning formula over each rival.

// __HW_POSITIONING_REAL_RIVALS__  (sync assert marker — see MULTIPLAYER_PATCHES)
// The positioning map plots the REAL rivals in the world (state.competitors,
// each carrying a server-computed `positioning` {x,y}) instead of fabricated
// benchmark brands. Dot colors cycle through this palette; the player is always
// drawn last, larger and on top.
const RIVAL_COLORS = ['#3ea6ff', '#ffb43d', '#a98bff', '#38d39f', '#f472b6', '#5eead4', '#fb923c', '#93a4ba'];

const VERDICT_COLOR = { 5: 'var(--green)', 4: 'var(--green)', 3: 'var(--yellow)', 2: 'var(--red)', 1: 'var(--red)' };

export default function Reputation() {
  const { state } = useGame();
  const { fleet, routes, airlineName, competitors } = state;

  const rep = useMemo(() => calcReputation(
    state,
    stateLoyaltyReputationBonus(state),
    fleetAvgUtilization(fleet ?? [], [...(routes ?? []), ...(state.cargoRoutes ?? [])]),
  ), [state]);  // eslint-disable-line
  const appeal = useMemo(() => brandAppeal(state), [state]);
  const quality = useMemo(() => qualityReasons(rep.qualityParts), [rep]);
  const pos = useMemo(() => calcPositioning(state), [state]);
  const strategy = strategyLabel(pos);

  if ((fleet ?? []).length === 0 && (routes ?? []).length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon"><Glyph e="⭐" /></div>
        <div className="empty-state-text">Lease aircraft and open routes to start building your brand.</div>
      </div>
    );
  }

  const demandMultiplier = reputationDemandMultiplier(rep.overall);
  const elasticityReduction = reputationElasticityReduction(rep.overall);
  const awareness = state.awareness ?? 5;
  const awarenessMultiplier = awarenessDemandMultiplier(awareness);
  const capped = appeal.capped;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
        How travellers see you compared with your rivals, and why.
        {capped && <> Based on your {appeal.totalPairs} busiest routes.</>}
      </div>

      <div data-brand-cards style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16 }}>
        <AppealCard title="Business travellers" seg={appeal.business} appeal={appeal} segment="business" />
        <AppealCard title="Leisure travellers" seg={appeal.leisure} appeal={appeal} segment="leisure" />
        <QualityCard score={rep.qualityDemandScore} quality={quality} satisfaction={state.satisfaction} />
      </div>

      <div id="marketing-budget">
        <MarketingPanel />
      </div>

      <details className="card" style={{ marginBottom: 0 }}>
        <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 14 }}>
          Reputation and market position
          <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: 8, fontSize: 13 }}>
            Reputation {Math.round(rep.overall)}/100 · awareness {Math.round(awareness)}/100
          </span>
        </summary>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 20, marginTop: 16 }}>
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.5 }}>
              Reputation is how much travellers trust you: demand{' '}
              <span style={{ color: demandMultiplier >= 1 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
                {demandMultiplier >= 1 ? '+' : ''}{formatPercent(demandMultiplier - 1)}
              </span>
              {' '}and price sensitivity{' '}
              <span style={{ color: elasticityReduction >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
                {elasticityReduction >= 0 ? '−' : '+'}{formatPercent(Math.abs(elasticityReduction))}
              </span>. Awareness reaches {formatPercent(awarenessMultiplier)} of {awarenessMultiplier > 1 ? 'baseline' : 'potential'} demand.
              Both feed the brand factor on the cards above.
            </div>
            <DriverRow label="Service quality" score={rep.service} detail="Cabin grade and cabin crew morale" />
            <DriverRow label="Fleet freshness" score={rep.fleet} detail={`Average passenger fleet age ${rep.avgAgeYears.toFixed(1)} years`} />
            <DriverRow label="Network reach" score={rep.network} detail="Airports, routes and routes from your hub" />
            <DriverRow label="Employee morale" score={rep.morale} detail="All staff groups, plus recent profits" />
            {rep.partners !== undefined && (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 10 }} data-rep-partners>
                <span style={{ fontWeight: 600 }}>Travel Partners</span>
                <span style={{ fontWeight: 700, color: rep.partners > 0 ? 'var(--green)' : rep.partners < 0 ? 'var(--red)' : 'var(--text-muted)' }}>
                  {rep.partners > 0 ? '+' : rep.partners < 0 ? '−' : ''}{Math.abs(rep.partners).toFixed(1)} pts
                </span>
              </div>
            )}
          </div>
          <div>
            <PositioningMatrix pos={pos} airlineName={airlineName} strategy={strategy} competitors={competitors} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
              <span style={{ display: 'inline-flex', color: strategy.color }}><Glyph e={strategy.emoji} size={16} /></span>
              <strong style={{ color: strategy.color, fontSize: 13 }}>{strategy.name}</strong>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5, marginTop: 4 }}>{strategy.description}</div>
          </div>
        </div>
      </details>
    </div>
  );
}

// ─── Cards ────────────────────────────────────────────────────────────────────

function CardShell({ title, children }) {
  return (
    <div className="card" style={{ marginBottom: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="card-title" style={{ marginBottom: 0 }}>{title}</div>
      {children}
    </div>
  );
}

function Meter({ level, color }) {
  return (
    <div role="img" aria-label={`${level} of 5`} style={{ display: 'flex', gap: 4 }}>
      {[1, 2, 3, 4, 5].map(i => (
        <div key={i} style={{ flex: 1, height: 6, borderRadius: 3, background: i <= level ? color : 'var(--surface3)' }} />
      ))}
    </div>
  );
}

function Reasons({ helping, hurting }) {
  if (helping.length === 0 && hurting.length === 0) {
    return <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Nothing stands out either way.</div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }} data-brand-reasons>
      {helping.map(r => (
        <div key={`+${r.reason}`} style={{ display: 'flex', gap: 8 }}>
          <span style={{ color: 'var(--green)', fontWeight: 700, width: 12 }}>+</span><span>{r.reason}</span>
        </div>
      ))}
      {hurting.map(r => (
        <div key={`-${r.reason}`} style={{ display: 'flex', gap: 8 }}>
          <span style={{ color: 'var(--red)', fontWeight: 700, width: 12 }}>−</span><span>{r.reason}</span>
        </div>
      ))}
    </div>
  );
}

function AppealCard({ title, seg, appeal, segment }) {
  if (!seg.verdict) {
    const alone = appeal.pairsScored > 0 && appeal.soloPairs === appeal.pairsScored;
    return (
      <CardShell title={title}>
        <span style={{ fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 700, lineHeight: 1 }}>No rivals yet</span>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          {alone
            ? 'You fly alone on every route, so travellers decide whether to fly, not who with. Your price, quality, schedule and brand still decide how many of them go.'
            : segment === 'business'
              ? 'No route has a rival business cabin up against one of yours, so there is no one to compare with yet.'
              : 'None of your routes has a rival yet, so there is no one to compare with.'}
        </div>
      </CardShell>
    );
  }
  const color = VERDICT_COLOR[seg.verdict.level];
  const shown = seg.terms.filter(t => Math.abs(t.multiplier - 1) >= 0.005);
  const flat = seg.terms.filter(t => Math.abs(t.multiplier - 1) < 0.005);
  const maxAbs = Math.max(0.05, ...shown.map(t => Math.abs(t.multiplier - 1)));
  return (
    <CardShell title={title}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-brand-verdict={segment}>
        <span style={{ fontFamily: 'var(--font-display)', fontSize: 32, fontWeight: 700, color, lineHeight: 1 }}>{seg.verdict.label}</span>
        <Meter level={seg.verdict.level} color={color} />
        <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>{seg.verdict.line}</span>
      </div>
      <Reasons helping={seg.helping} hurting={seg.hurting} />
      <details>
        <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--accent-bright)' }}>See all factors</summary>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', margin: '10px 0 8px', lineHeight: 1.5 }}>
          How much each factor changes the odds a traveller picks you over the average rival, across your{' '}
          {seg.contestedPairs} route{seg.contestedPairs === 1 ? '' : 's'} with rivals. Together: {seg.multiplier.toFixed(2)}× as likely.
        </div>
        {shown.map(t => (
          <FactorRow key={t.key} t={t} maxAbs={maxAbs} of={seg.contestedPairs} />
        ))}
        {flat.length > 0 && (
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
            No difference: {flat.map(t => t.name).join(', ')}.
          </div>
        )}
      </details>
    </CardShell>
  );
}

function FactorRow({ t, maxAbs, of }) {
  const pct = t.multiplier - 1;
  const w = `${Math.min(100, Math.abs(pct) / maxAbs * 100)}%`;
  const good = pct > 0;
  const color = good ? 'var(--green)' : 'var(--red)';
  const count = good ? t.ahead : t.behind;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.3fr) minmax(0, 1fr) 48px', gap: 8, alignItems: 'center', padding: '5px 0' }}>
      <div>
        <div style={{ fontSize: 12, fontWeight: 600 }}>{t.name}</div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {good ? 'Ahead' : 'Behind'} on {count} of {of}
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', height: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end', borderRight: '1px solid var(--border-strong)' }}>
          {!good && <div style={{ width: w, background: color, borderRadius: '3px 0 0 3px' }} />}
        </div>
        <div style={{ display: 'flex' }}>
          {good && <div style={{ width: w, background: color, borderRadius: '0 3px 3px 0' }} />}
        </div>
      </div>
      <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', textAlign: 'right', color }}>
        {good ? '+' : '−'}{Math.round(Math.abs(pct) * 100)}%
      </span>
    </div>
  );
}

function QualityCard({ score, quality, satisfaction }) {
  const s = Math.round(score);
  const color = scoreColor(s);
  return (
    <CardShell title="Quality">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: 32, fontWeight: 700, color, lineHeight: 1 }}>{s}</span>
          <span style={{ fontSize: 14, color: 'var(--text-muted)' }}>/ 100</span>
        </div>
        <div style={{ height: 6, borderRadius: 3, background: 'var(--surface3)' }}>
          <div style={{ width: `${Math.max(0, Math.min(100, s))}%`, height: 6, borderRadius: 3, background: color }} />
        </div>
        <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Matters most to business travellers.</span>
      </div>
      <Reasons helping={quality.helping} hurting={quality.hurting} />
      <details>
        <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--accent-bright)' }}>See breakdown</summary>
        <div style={{ marginTop: 10 }}>
          {quality.parts.map(p => (
            <div key={p.key} style={{ padding: '5px 0' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                <span style={{ fontWeight: 600 }}>{p.name}</span>
                <span style={{ fontFamily: 'var(--font-mono)' }}>
                  {p.max ? `${Math.round(p.points)} / ${p.max}` : `${p.points >= 0 ? '+' : '−'}${Math.abs(Math.round(p.points))}`}
                </span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{p.detail}</div>
            </div>
          ))}
          {satisfaction != null && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
              The customer rating comes from earned satisfaction ({Math.round(satisfaction)}). Each route's own score is on its route page.
            </div>
          )}
        </div>
      </details>
    </CardShell>
  );
}

function DriverRow({ label, score, detail }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
        <span style={{ fontWeight: 600 }}>{label}</span>
        <span style={{ fontWeight: 700, color: scoreColor(score) }}>{score}</span>
      </div>
      <div style={{ height: 4, borderRadius: 2, background: 'var(--surface3)', marginTop: 4 }}>
        <div style={{ width: `${score}%`, height: 4, borderRadius: 2, background: scoreColor(score) }} />
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>{detail}</div>
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

function scoreColor(score) {
  if (score >= 70) return 'var(--green)';
  if (score >= 45) return 'var(--yellow)';
  return 'var(--red)';
}
