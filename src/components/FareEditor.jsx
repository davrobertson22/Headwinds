import { useState, useEffect } from 'react';
import {
  referencePrice, maxClassPrice, CLASS_FARE_MULTIPLIERS,
} from '../utils/simulation.js';

// ─── Cabin-class metadata (single source for every pricing surface) ───────────

export const CLASS_ORDER = ['firstClass', 'businessClass', 'premiumEconomy', 'economy'];
export const CLASS_LABELS = {
  economy:        'Economy',
  premiumEconomy: 'Premium Eco',
  businessClass:  'Business',
  firstClass:     'First',
};
export const CLASS_COLORS = {
  economy:        'var(--text-muted)',
  premiumEconomy: 'var(--yellow)',
  businessClass:  'var(--accent)',
  firstClass:     'var(--purple)',
};

/** Reference fare per cabin for a route — economy ref × the engine's real multipliers. */
export function referenceClassPrices(origin, dest) {
  const refP = referencePrice(origin, dest);
  const out = {};
  for (const cls of CLASS_ORDER) out[cls] = Math.round(refP * (CLASS_FARE_MULTIPLIERS[cls] ?? 1));
  return out;
}

/**
 * FareEditor — the ONE fare-setting surface, used both when opening a route and
 * when editing it later. Shows a dollar input per cabin that actually has seats,
 * with the market reference fare, live % vs reference, and the fare cap.
 *
 * Props:
 *   origin, dest   route endpoints (drives reference fares + caps)
 *   config         seats per class ({ economy: 150, businessClass: 12, ... })
 *   fares          current fares ({ economy: 450, ... }); missing cabins fall back to reference
 *   onCommit(cls, value)   called with a clamped integer when a fare is committed (blur/Enter)
 *   showSeats      show "(N seats)" next to each cabin label (default true)
 */
export default function FareEditor({ origin, dest, config, fares, onCommit, showSeats = true }) {
  const refP      = referencePrice(origin, dest);
  const refPrices = referenceClassPrices(origin, dest);

  // Only cabins the aircraft actually has seats in.
  const activeClasses = CLASS_ORDER.filter(cls => (config?.[cls] ?? 0) > 0);

  const initialDraft = () => {
    const result = {};
    for (const cls of activeClasses) {
      result[cls] = String(Math.round(fares?.[cls] ?? refPrices[cls]));
    }
    return result;
  };
  const [draft, setDraft] = useState(initialDraft);

  // Re-seed the draft when the route or cabin set changes (e.g. the player picks a
  // different aircraft config in the planner) — keyed remounts also work, but this
  // keeps the component drop-in either way.
  const cabinKey = `${origin}-${dest}:${activeClasses.map(c => `${c}=${config?.[c]}`).join(',')}`;
  useEffect(() => { setDraft(initialDraft()); }, [cabinKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const maxPrices = {};
  for (const cls of activeClasses) maxPrices[cls] = maxClassPrice(refP, cls);

  function commit(cls) {
    const val = parseInt(draft[cls], 10);
    if (isNaN(val) || val <= 0) {
      // Invalid entry → snap the field back to the last committed / reference fare.
      setDraft(d => ({ ...d, [cls]: String(Math.round(fares?.[cls] ?? refPrices[cls])) }));
      return;
    }
    const clamped = Math.min(val, maxPrices[cls]);
    if (clamped !== val) setDraft(d => ({ ...d, [cls]: String(clamped) }));
    onCommit(cls, clamped);
  }

  function resetAll() {
    const next = {};
    for (const cls of activeClasses) {
      next[cls] = String(refPrices[cls]);
      onCommit(cls, refPrices[cls]);
    }
    setDraft(next);
  }

  const anyOffRef = activeClasses.some(cls =>
    (parseInt(draft[cls], 10) || refPrices[cls]) !== refPrices[cls]);

  return (
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
      {activeClasses.map(cls => {
        const current = parseInt(draft[cls], 10) || refPrices[cls];
        const pct     = Math.round((current / refPrices[cls] - 1) * 100);
        return (
          <div key={cls} style={{ minWidth: 110 }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: CLASS_COLORS[cls], textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>
              {CLASS_LABELS[cls]}
              {showSeats && (
                <span style={{ color: 'var(--text-dim)', fontWeight: 400, marginLeft: 4 }}>
                  ({config[cls]} seats)
                </span>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>$</span>
              <input
                className="form-input"
                type="number"
                min="1"
                max={maxPrices[cls]}
                title={`Max $${maxPrices[cls].toLocaleString()} (cap: 3× reference)`}
                style={{ width: 72, padding: '3px 6px', fontSize: 12 }}
                value={draft[cls]}
                onChange={e => setDraft(d => ({ ...d, [cls]: e.target.value }))}
                onBlur={() => commit(cls)}
                onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); }}
              />
            </div>
            <div style={{ fontSize: 10, color: pct > 0 ? 'var(--red)' : pct < 0 ? 'var(--green)' : 'var(--text-dim)', marginTop: 2 }}>
              ref ${refPrices[cls]} {pct !== 0 && `(${pct > 0 ? '+' : ''}${pct}%)`}
            </div>
          </div>
        );
      })}
      {anyOffRef && (
        <button
          type="button"
          className="btn btn-ghost"
          style={{ padding: '2px 8px', fontSize: 11, alignSelf: 'center' }}
          onClick={resetAll}
          title="Set every cabin back to its market reference fare"
        >
          Reset to ref
        </button>
      )}
    </div>
  );
}
