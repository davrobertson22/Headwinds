import { useState, useEffect } from 'react';
import { useGame } from '../store/GameContext.jsx';
import { formatMoney } from '../utils/simulation.js';
import {
  ANCILLARY_PRODUCTS, isAncillariesActive, defaultAncillaries, resolveItem,
  ancillaryTakeRate, ancillaryItemQuality, ancillaryQualityBonus, routeAncillaries,
} from '../data/ancillaries.js';
import { Glyph } from './Icons.jsx';

// Sum the airline's boarded pax by cabin from last week's per-route results, so
// the projected ancillary revenue uses the SAME function the engine runs.
function aggregateClassSummary(report) {
  const agg = {
    economy:        { passengers: 0 },
    premiumEconomy: { passengers: 0 },
    businessClass:  { passengers: 0 },
    firstClass:     { passengers: 0 },
  };
  for (const r of report?.routeResults ?? []) {
    const cs = r.classSummary ?? {};
    for (const cls of Object.keys(agg)) agg[cls].passengers += cs[cls]?.passengers ?? 0;
  }
  return agg;
}

// Price control: preset chips + a free-text field that keeps its own text while
// focused so typing a value that passes through empty never resets the field.
function PriceInput({ value, max, presets, onCommit }) {
  const [text, setText] = useState(String(value ?? 0));
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setText(String(value ?? 0)); }, [value, focused]);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      {presets.map(p => (
        <button
          key={p}
          type="button"
          onClick={() => onCommit(p)}
          className={`btn ${value === p ? 'btn-primary' : 'btn-ghost'}`}
          style={{ fontSize: 11, padding: '3px 9px' }}
        >
          {p === 0 ? 'Free' : `$${p}`}
        </button>
      ))}
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
        <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>$</span>
        <input
          type="number"
          className="input"
          min="0"
          max={max}
          step="1"
          value={text}
          onFocus={() => setFocused(true)}
          onChange={e => {
            const raw = e.target.value;
            setText(raw);
            const n = parseInt(raw, 10);
            if (Number.isFinite(n)) onCommit(Math.max(0, Math.min(max, n)));
          }}
          onBlur={() => {
            setFocused(false);
            const n = parseInt(text, 10);
            if (!Number.isFinite(n)) setText(String(value ?? 0));
          }}
          style={{ width: 62, fontSize: 12, padding: '3px 6px' }}
        />
      </span>
    </div>
  );
}

function qualityColor(q) {
  return q > 0.3 ? 'var(--green)' : q < -0.3 ? 'var(--red)' : 'var(--text-dim)';
}

function ProductCard({ product, policy, active, byItem, dispatch }) {
  const { offered, price } = resolveItem(product, policy);
  const q       = ancillaryItemQuality(product, policy);
  const take    = ancillaryTakeRate(product, price);
  const proj    = byItem?.[product.id];
  const isOff   = product.provisioned && !offered;

  const setPrice   = (p) => dispatch({ type: 'SET_ANCILLARY', id: product.id, price: p });
  const setOffered = (o) => dispatch({ type: 'SET_ANCILLARY', id: product.id, offered: o });

  return (
    <div className="card" style={{ padding: '13px 16px', marginBottom: 10, opacity: active ? 1 : 0.72 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <div style={{ fontWeight: 700, fontSize: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 17, display: 'inline-flex' }}><Glyph e={product.icon} size={17} /></span>
            {product.name}
            {product.provisioned && (
              <span style={{
                fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3,
                textTransform: 'uppercase', letterSpacing: '0.05em',
                background: 'var(--surface3)', color: 'var(--text-muted)', border: '1px solid var(--border)',
              }}>
                Amenity
              </span>
            )}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 3, maxWidth: 460, lineHeight: 1.45 }}>
            {product.blurb}
          </div>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: isOff ? 'var(--text-dim)' : (proj?.revenue > 0 ? 'var(--green)' : 'var(--text-muted)') }}>
            {isOff ? 'Not offered' : proj ? `+${formatMoney(proj.revenue)}/wk` : (price === 0 ? 'Free' : '—')}
          </div>
          {!isOff && proj && (proj.cost > 0) && (
            <div style={{ fontSize: 10.5, color: 'var(--red)', marginTop: 1 }}>−{formatMoney(proj.cost)}/wk to run</div>
          )}
        </div>
      </div>

      {/* Provisioned amenities can be switched off entirely */}
      {product.provisioned && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
          <button
            type="button"
            onClick={() => setOffered(!offered)}
            className={`btn ${offered ? 'btn-primary' : 'btn-ghost'}`}
            style={{ fontSize: 11, padding: '3px 10px' }}
          >
            {offered ? 'Offered ✓' : 'Not offered'}
          </button>
          <span style={{ fontSize: 11, color: qualityColor(q) }}>
            {offered
              ? (q >= 0 ? `quality +${q.toFixed(1)}` : `quality ${q.toFixed(1)}`)
              : `not offering: quality ${(product.absentQ ?? 0).toFixed(1)}`}
          </span>
        </div>
      )}

      {!isOff && (
        <div style={{ marginTop: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <PriceInput value={price} max={product.maxPrice} presets={product.presets} onCommit={setPrice} />
          <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
            {price > 0 && (
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>take rate</div>
                <div style={{ fontSize: 12, fontWeight: 600 }}>{Math.round(take * 100)}%{proj ? ` · ${proj.buyers.toLocaleString()}/wk` : ''}</div>
              </div>
            )}
            {!product.provisioned && (
              <div style={{ textAlign: 'right', minWidth: 74 }}>
                <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>quality</div>
                <div style={{ fontSize: 12, fontWeight: 600, color: qualityColor(q) }}>
                  {q >= 0 ? '+' : ''}{q.toFixed(1)}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function Ancillaries() {
  const { state, dispatch } = useGame();
  const active = isAncillariesActive(state.ancillaries);
  // When inactive, show the recommended baseline as an editable preview; any edit
  // auto-activates (the reducer seeds the baseline on first touch).
  const policy = active ? state.ancillaries : defaultAncillaries();

  const agg      = aggregateClassSummary(state.lastReport);
  const hasPax   = Object.values(agg).some(c => c.passengers > 0);
  const econ     = routeAncillaries(policy, agg);
  const qBonus   = ancillaryQualityBonus(policy);

  return (
    <div>
      {/* Intro + status */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', maxWidth: 720, lineHeight: 1.5 }}>
          Set your airline-wide à la carte products. For each one, decide whether to offer it and what to charge.
          Giving extras away free (or offering an expected amenity like Wi-Fi) lifts perceived <strong>quality</strong> and
          demand; charging market rates earns <strong>ancillary revenue</strong> but a little goodwill; steep fees and dropped
          amenities drag quality down. Not every passenger buys — cheaper fees mean more buyers, pricier fees mean fewer.
          Changes take effect next week and apply to every route.
        </div>
      </div>

      {/* Summary bar */}
      <div className="card" style={{ padding: '13px 18px', marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 26, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Status</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: active ? 'var(--green)' : 'var(--text-muted)' }}>
              {active ? 'Active' : 'Not active'}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              {active ? 'Ancillary revenue' : 'Projected revenue'}
            </div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--green)' }}>
              {hasPax ? `+${formatMoney(econ.revenue)}/wk` : '—'}
              {hasPax && econ.cost > 0 && (
                <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 500 }}> (net {formatMoney(econ.net)})</span>
              )}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Net quality effect</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: qualityColor(qBonus) }}>
              {qBonus >= 0 ? '+' : ''}{qBonus} pts
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {active ? (
            <>
              <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => dispatch({ type: 'SET_ANCILLARIES', active: true })}>
                Reset to recommended
              </button>
              <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => dispatch({ type: 'SET_ANCILLARIES', active: false })}>
                Turn off
              </button>
            </>
          ) : (
            <button className="btn btn-primary" style={{ fontSize: 13 }} onClick={() => dispatch({ type: 'SET_ANCILLARIES', active: true })}>
              Activate recommended pricing
            </button>
          )}
        </div>
      </div>

      {!active && (
        <div style={{
          fontSize: 12, color: 'var(--text-muted)', background: 'var(--surface2)',
          borderRadius: 6, padding: '9px 13px', marginBottom: 14, borderLeft: '3px solid var(--yellow)',
        }}>
          Ancillaries aren't earning yet. The values below are the recommended starting point — activate them, or just
          change any product and it turns on automatically.
        </div>
      )}

      {!hasPax && (
        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 12, fontStyle: 'italic' }}>
          Projected weekly revenue appears once you've flown a week with passengers.
        </div>
      )}

      {ANCILLARY_PRODUCTS.map(product => (
        <ProductCard
          key={product.id}
          product={product}
          policy={policy}
          active={active}
          byItem={hasPax ? econ.byItem : null}
          dispatch={dispatch}
        />
      ))}

      <div style={{ marginTop: 14, fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.6 }}>
        Quality points here stack with cabin product and per-route catering into each route's quality score (capped at ±15).
        Per-passenger ancillary income is not amplified by marketing or loyalty — it scales only with how many passengers
        actually fly. Amenities marked <em>Amenity</em> (Wi-Fi, extra legroom, lounges) cost money to run whenever offered,
        even for free.
      </div>
    </div>
  );
}
