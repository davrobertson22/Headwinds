import { useGame } from '../store/GameContext.jsx';
import { economyCycleWorld, economyPhase, cycleLeaseMult } from '../models/economyCycle.js';
import InfoTip from './InfoTip.jsx';

// The world business cycle (demand model v4 worlds, models/economyCycle.js):
// where the economy is, how hard it is moving, and what it is doing to demand
// and to the rate a new lease signs at. The momentum is the leading indicator —
// an economy that has started slowing keeps slowing for a while, which is the
// moment to stop ordering, not the moment demand falls. Renders nothing in any
// other world.

const PHASE_COPY = {
  expanding:   { label: 'Expanding',   color: 'var(--green, #38d39f)', hint: 'Above trend and still rising. Lease rates are climbing with it.' },
  slowing:     { label: 'Slowing',     color: 'var(--gold, #ffcf4d)',  hint: 'Above trend but past the peak. Orders placed now deliver into a softer market.' },
  contracting: { label: 'Contracting', color: 'var(--red, #ff5d6c)',   hint: 'Below trend and still falling. Cheap leases, thin loads.' },
  recovering:  { label: 'Recovering',  color: 'var(--accent, #38e1ff)', hint: 'Below trend but turning up — the classic time to lock cheap lift.' },
};

function Spark({ history }) {
  const h = (history ?? []).slice(-104);
  if (h.length < 2) return null;
  const W = 120, H = 24, lo = -0.15, hi = 0.12;
  const y = (v) => H - ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * H;
  const pts = h.map((v, i) => `${((i / (h.length - 1)) * W).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true" style={{ verticalAlign: 'middle' }}>
      <line x1="0" x2={W} y1={y(0)} y2={y(0)} stroke="rgba(255,255,255,.18)" strokeDasharray="2 3" />
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export default function EconomyIndicator() {
  const { state } = useGame();
  if (!economyCycleWorld(state) || !state.economyCycle) return null;
  const p = economyPhase(state.economyCycle);
  if (!p) return null;
  const copy = PHASE_COPY[p.phase];
  const demand = Math.max(-15, Math.min(12, p.demandPct));
  const lease = Math.round((cycleLeaseMult(state) - 1) * 1000) / 10;
  const sign = (v) => (v > 0 ? '+' : '') + v.toFixed(1) + '%';
  return (
    <div className="card economy-indicator" data-economy-phase={p.phase} style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
      <div style={{ minWidth: 160 }}>
        <div className="card-title" style={{ marginBottom: 2, display: 'flex', alignItems: 'center', gap: 4 }}>
          World economy
          <InfoTip text="One business cycle for the whole world, a few game years peak to peak. It scales every route's demand and the rate a new lease is signed at (existing leases keep their rate). The 8-week momentum is the early warning: a turning economy keeps turning for a while." />
        </div>
        <span style={{ color: copy.color, fontWeight: 600 }}>{copy.label}</span>
        <span className="muted small" style={{ marginLeft: 8 }}>momentum {sign(p.momentumPct)} / 8 wks</span>
      </div>
      <span style={{ color: copy.color }}><Spark history={state.economyCycle.history} /></span>
      <div className="small" style={{ display: 'flex', gap: 16 }}>
        <span>Demand <strong>{sign(demand)}</strong></span>
        <span>New lease rates <strong>{sign(lease)}</strong></span>
      </div>
      <div className="muted small" style={{ flexBasis: '100%' }}>{copy.hint}</div>
    </div>
  );
}
