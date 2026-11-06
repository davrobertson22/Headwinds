import { useMemo, useState } from 'react';
import { formatMoney, formatPercent } from '../utils/simulation.js';

// Bar labels: two or three significant figures and a real minus sign, so seven
// of them fit across a phone ("−$2.4M", not "-$2.40M"). The hover text keeps
// the full formatMoney figure.
export function shortMoney(n) {
  const v = Number(n) || 0, a = Math.abs(v), sign = v < 0 ? '\u2212' : '';
  const fmt = (x, unit) => `${sign}$${x >= 100 ? Math.round(x) : x >= 10 ? Math.round(x) : x.toFixed(1).replace(/\.0$/, '')}${unit}`;
  if (a >= 1e9) return fmt(a / 1e9, 'B');
  if (a >= 1e6) return fmt(a / 1e6, 'M');
  if (a >= 1e3) return fmt(a / 1e3, 'K');
  return `${sign}$${Math.round(a)}`;
}
import { projectedWaterfall, lastWeekWaterfall } from '../utils/compactBridge.js';

// ── Dashboard: where the week's money went ───────────────────────────────────
// A compact waterfall of the week: route revenue, the cost buckets eating into
// it, and the net cash that's left. The bars are Finance's Cost Bridge folded
// into seven buckets (utils/compactBridge.js), so the two always agree; the
// full ladder is one click away in Finance.
//
// Last week (what happened) when there is one, else this week's projection —
// with a switch between the two.

const H = 112;   // bar area height, px

function Column({ step, lo, hi, last }) {
  const range = Math.max(1, hi - lo);
  const y = (v) => ((hi - v) / range) * 100;            // % from the top
  const top = y(Math.max(step.from, step.to));
  const bottom = y(Math.min(step.from, step.to));
  const total = step.kind !== 'step';
  const up = total ? step.to >= 0 : step.value >= 0;
  const color = up ? 'var(--green)' : 'var(--red)';
  const valueText = total ? shortMoney(step.to) : `${step.value >= 0 ? '+' : ''}${shortMoney(step.value)}`;
  const tip = [`${step.label}: ${formatMoney(total ? step.to : step.value)}`, step.tip, ...step.parts.map(p => `${p.label}: ${formatMoney(p.value)}`)].filter(Boolean).join('\n');
  return (
    <div className="cwf-col" data-cwf-step={step.key} data-cwf-value={Math.round(step.value)} title={tip}
      style={{ minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'stretch' }}>
      <div style={{ position: 'relative', height: H }}>
        {/* Value sits just above its bar. */}
        <div style={{
          position: 'absolute', left: -6, right: -6, top: `calc(${top}% - 16px)`,
          textAlign: 'center', fontSize: 10.5, fontFamily: 'var(--font-mono, monospace)',
          fontWeight: total ? 700 : 500, color: total ? color : 'var(--text-muted)', whiteSpace: 'nowrap',
        }}>{valueText}</div>
        <div style={{
          position: 'absolute', left: '14%', right: '14%', top: `${top}%`,
          height: `max(2px, ${bottom - top}%)`, background: color,
          opacity: total ? 0.95 : 0.75, borderRadius: 3,
        }} />
        {/* Connector to the next bar, at the level this one ends on. */}
        {!last && (
          <div aria-hidden="true" style={{
            position: 'absolute', left: '86%', width: 'calc(28% + 6px)', top: `${y(step.to)}%`,
            borderTop: '1px dashed var(--border)',
          }} />
        )}
      </div>
      <div style={{
        marginTop: 6, textAlign: 'center', fontSize: 11, lineHeight: 1.25,
        color: total ? 'var(--text)' : 'var(--text-muted)', fontWeight: total ? 600 : 400,
      }}>{step.label}</div>
    </div>
  );
}

export default function CompactWaterfall({ proj, state, collapsed = false, onToggleCollapse = null, onOpenFinance = null, Chevron = null }) {
  const last = useMemo(() => lastWeekWaterfall(state), [state]);
  const projected = useMemo(() => projectedWaterfall(proj, state), [proj, state]);
  const [which, setWhich] = useState(null);           // null = default
  const mode = which ?? (last ? 'last' : 'proj');
  const wf = mode === 'last' && last ? last : projected;

  const levels = wf.steps.flatMap(s => [s.from, s.to]);
  const hi = Math.max(0, ...levels);
  const lo = Math.min(0, ...levels);
  const zeroTop = ((hi - 0) / Math.max(1, hi - lo)) * 100;

  const chip = (on) => ({
    padding: '2px 9px', borderRadius: 999, fontSize: 11, cursor: 'pointer',
    border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
    background: on ? 'color-mix(in srgb, var(--accent) 16%, transparent)' : 'transparent',
    color: on ? 'var(--accent)' : 'var(--text-muted)',
  });

  return (
    <div className="card compact-waterfall" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: collapsed ? 0 : 12 }}>
        <div className="card-title" style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
          {Chevron && onToggleCollapse && <Chevron collapsed={collapsed} onClick={onToggleCollapse} label="where the money went" />}
          Where the money went
        </div>
        {!collapsed && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {last && (
              <>
                <button type="button" style={chip(mode === 'last')} aria-pressed={mode === 'last'} onClick={() => setWhich('last')}>Last week</button>
                <button type="button" style={chip(mode === 'proj')} aria-pressed={mode === 'proj'} onClick={() => setWhich('proj')}>This week (proj.)</button>
              </>
            )}
            {!last && <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>This week (projected)</span>}
          </div>
        )}
      </div>
      {!collapsed && (
        <>
          <div style={{ position: 'relative', paddingTop: 16 }}>
            {/* The zero line, when the walk dips below it. */}
            {lo < 0 && (
              <div aria-hidden="true" style={{
                position: 'absolute', left: 0, right: 0, top: `calc(16px + ${zeroTop / 100 * H}px)`,
                borderTop: '1px solid var(--border)',
              }} />
            )}
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${wf.steps.length}, minmax(0, 1fr))`, gap: 6 }}>
              {wf.steps.map((s, i) => (
                <Column key={s.key} step={s} lo={lo} hi={hi} last={i === wf.steps.length - 1} />
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginTop: 10, fontSize: 11.5, color: 'var(--text-muted)' }}>
            <span>
              Net margin <strong style={{ color: wf.net >= 0 ? 'var(--green)' : 'var(--red)' }}>{formatPercent(wf.netMargin)}</strong>
              {' '}· hover a bar for what's in it
            </span>
            {onOpenFinance && (
              <button type="button" onClick={onOpenFinance}
                style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--accent)', fontSize: 11.5 }}>
                Full cost bridge in Finance →
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
