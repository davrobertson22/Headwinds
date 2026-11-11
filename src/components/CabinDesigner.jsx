import { useEffect, useState } from 'react';
import { CABIN_COLORS } from './CabinFloorPlan.jsx';
import { formatMoney } from '../utils/simulation.js';
import { SEAT_PRODUCTS, productOf, productAvailability, productQualityPts, productFittingCost } from '../data/seatProducts.js';

// The shared pieces of the cabin designer: the brush row for painting on the
// floor plan (CabinFloorPlan) and the per-cabin product rows. Used by the
// refit modal (FleetConfig) and the order form (AircraftCheckout), so a cabin
// is designed the same way whether the aircraft is in the fleet or on order.

// The brushes for painting the cabin on the floor plan.
export const BRUSHES = [
  { key: 'firstClass',     label: 'First' },
  { key: 'businessClass',  label: 'Business' },
  { key: 'premiumEconomy', label: 'Prem eco' },
  { key: 'economy',        label: 'Economy' },
  { key: 'empty',          label: 'Empty floor' },
];

/** True while the viewport matches `query`. False during SSR and first paint. */
export function useMediaQuery(query) {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mq = window.matchMedia(query);
    const sync = () => setMatches(mq.matches);
    sync();
    mq.addEventListener?.('change', sync);
    return () => mq.removeEventListener?.('change', sync);
  }, [query]);
  return matches;
}

// Phones hold the fuselage vertically: the plan is taller than wide, so a
// stroke along it is a scroll-length drag rather than a thumb's width.
export function useNarrow(max = 640) {
  return useMediaQuery(`(max-width: ${max}px)`);
}

export function CabinBrushes({ brush, onBrush }) {
  return (
          <div className="cabin-brushes" role="radiogroup" aria-label="Cabin brush">
            {BRUSHES.map(b => (
              <button
                key={b.key}
                type="button"
                role="radio"
                aria-checked={brush === b.key}
                className={`cabin-brush${brush === b.key ? ' is-active' : ''}`}
                data-brush={b.key}
                onClick={() => onBrush(b.key)}
              >
                <span className="cabin-brush-swatch" style={b.key === 'empty' ? undefined : { background: CABIN_COLORS[b.key] }} />
                {b.label}
              </button>
            ))}
            <span className="cabin-brush-hint">Paint along the fuselage, or drag the dividers between cabins.</span>
          </div>
  );
}

// One cabin's products: the seat (tier) as a row of choices, the extras as
// toggles. Anything the era or the airframe refuses is shown but disabled,
// with the reason, so the player learns what a 787 or 1998 will give them.
// `currentConfig` is the cabin the aircraft has now (null for an order, where
// every product is new and nothing is "changed").
export function ProductRow({ cls, seats, products, currentConfig, calYear, type, onTier, onExtra, showChanged = true }) {
  const def = SEAT_PRODUCTS[cls];
  const mine = products[cls] ?? { tier: def.tiers[0].key, extras: [] };
  const was  = productOf(currentConfig ?? {}, cls);
  const cfg  = { [cls]: seats, products };
  const pts  = productQualityPts(cfg, cls);
  const tierDef = def.tiers.find(t => t.key === mine.tier) ?? def.tiers[0];
  const weekly = seats * tierDef.weekly + (mine.extras ?? []).reduce((s, k) => {
    const e = def.extras.find(x => x.key === k); return s + (e ? (e.perAircraft ? e.weekly : e.weekly * seats) : 0);
  }, 0);
  const fit = productFittingCost({ ...(currentConfig ?? {}), [cls]: currentConfig?.[cls] ?? 0 }, { ...cfg, products });
  const color = { firstClass: '#bc8cff', businessClass: '#ffb43d', premiumEconomy: '#3ea6ff', economy: '#38d39f' }[cls];
  const changed = tierDef.key !== was.tier.key || (mine.extras ?? []).length !== was.extras.length || (mine.extras ?? []).some(k => !was.extras.some(e => e.key === k));
  return (
    <div className="cabin-product-row" data-product-row={cls}>
      <div className="cabin-product-head">
        <span style={{ width: 10, height: 10, borderRadius: 2, background: color, display: 'inline-block' }} />
        <span style={{ fontSize: 13 }}>{def.label}</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>· {seats} seats</span>
        {showChanged && changed && <span style={{ color: 'var(--yellow)', fontSize: 10 }}>CHANGED</span>}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>
          {pts >= 0 ? '+' : ''}{pts} quality{weekly > 0 ? ` · ${formatMoney(weekly)}/route/wk` : ''}{fit > 0 ? ` · fit ${formatMoney(fit)}` : ''}
        </span>
      </div>
      <div className="cabin-product-tiers" role="radiogroup" aria-label={`${def.label} ${def.tierLabel.toLowerCase()}`}>
        {def.tiers.map(t => {
          const why = productAvailability(t, { calYear, type });
          return (
            <button
              key={t.key}
              type="button"
              role="radio"
              aria-checked={mine.tier === t.key}
              className={`cabin-product-tier${mine.tier === t.key ? ' is-active' : ''}`}
              data-tier={t.key}
              disabled={!!why}
              title={why ? why.message : `${t.desc ?? ''}${t.space !== 1 ? ` ${+(t.space).toFixed(2)}× floor.` : ''}${t.fee ? ` Fit ${formatMoney(t.fee)}/seat.` : ''}`}
              onClick={() => onTier(t.key)}
            >
              {t.label}
              {t.pts !== 0 && <span className="cabin-product-pts">{t.pts > 0 ? '+' : ''}{t.pts}</span>}
            </button>
          );
        })}
      </div>
      {def.extras.length > 0 && (
        <div className="cabin-product-extras">
          {def.extras.map(e => {
            const why = productAvailability(e, { calYear, type });
            const on = (mine.extras ?? []).includes(e.key);
            return (
              <label key={e.key} className={`cabin-product-extra${why ? ' is-off' : ''}`} title={why ? why.message : `${e.desc ?? ''}${e.fee ? ` Fit ${formatMoney(e.fee)}${e.perAircraft ? '' : '/seat'}.` : ''}`}>
                <input type="checkbox" checked={on} disabled={!!why} onChange={() => onExtra(e.key)} data-extra={e.key} />
                {e.label}
                <span className="cabin-product-pts">+{e.pts}</span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
