import { finalStretchOf, RANKING_WINDOW_WEEKS } from '../utils/standings.js';

// Where the season is: a thin bar of weeks flown out of the world's length,
// with the final 52 weeks — the ones that decide the title — marked at its
// end. The lobby shows it full width over the standings; the game's top bar
// shows a compact one ("38/104") beside the clock. Numbers only from the
// server (weeks flown, total weeks); the rule is engine utils/standings.js
// finalStretchOf, the same one the standings header sentence uses.

export function seasonLine({ weeksFlown, totalWeeks }) {
  const s = finalStretchOf({ totalWeeks, weeksFlown });
  const week = Math.min(totalWeeks, weeksFlown + 1);
  if (s.ended) return `Season over · ${totalWeeks} weeks flown`;
  if (s.inFinalStretch) return `Week ${week} of ${totalWeeks} · final stretch, ${s.weeksLeft} week${s.weeksLeft === 1 ? '' : 's'} left`;
  return `Week ${week} of ${totalWeeks} · final stretch in ${s.weeksUntilFinalStretch} week${s.weeksUntilFinalStretch === 1 ? '' : 's'}`;
}

export default function SeasonProgress({ weeksFlown, totalWeeks, compact = false }) {
  const total = Math.floor(Number(totalWeeks));
  const flown = Math.max(0, Math.floor(Number(weeksFlown)));
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(flown)) return null;
  const s = finalStretchOf({ totalWeeks: total, weeksFlown: flown });
  const pct = Math.min(100, (flown / total) * 100);
  const stretchPct = Math.min(100, (Math.min(RANKING_WINDOW_WEEKS, total) / total) * 100);
  const line = seasonLine({ weeksFlown: flown, totalWeeks: total });
  const fill = s.inFinalStretch ? 'var(--gold, #ffcf4d)' : 'var(--accent, #38e1ff)';
  const bar = (h, w) => (
    <span style={{ position: 'relative', display: 'inline-block', width: w, height: h, borderRadius: h, background: 'rgba(255,255,255,.08)', overflow: 'hidden', verticalAlign: 'middle' }}>
      {/* The final stretch: the last 52 weeks of the season, tinted. */}
      <span style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: `${stretchPct}%`, background: 'rgba(255,207,77,.18)' }} />
      <span data-season-fill={Math.round(pct)} style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${pct}%`, background: fill, borderRadius: h }} />
    </span>
  );
  if (compact) {
    return (
      <span className="season-progress compact" title={line}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
        {bar(4, 44)}
        <span style={{ fontFamily: 'var(--font-mono, monospace)' }}>{Math.min(total, flown + 1)}/{total}</span>
      </span>
    );
  }
  return (
    <div className="season-progress" style={{ margin: '6px 0 10px' }}>
      {bar(6, '100%')}
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>
        <span>{line}</span>
        <span style={{ color: 'var(--text-dim)' }}>final 52 weeks shaded</span>
      </div>
    </div>
  );
}
