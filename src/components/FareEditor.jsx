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
 * Two modes, because the two callers want opposite things:
 *
 *   LIVE (onCommit)      every blur commits that cabin. What the route-planner
 *                        form wants: the fare is local state until the route is
 *                        opened, so committing early costs nothing.
 *   REVIEW (onCommitMany) edits stay in the draft until the player hits Apply,
 *                        which commits every changed cabin in ONE action. What
 *                        an existing route wants: each blur used to be its own
 *                        authoritative server write, so repricing three cabins
 *                        was three round-trips and three chances to collide with
 *                        a tick commit — and the player saw no number between
 *                        typing a fare and living with it.
 *
 * `project` turns the draft into a forecast. The caller supplies it (this
 * component has no game state) and MUST route it through the shared projection
 * helpers rather than a bare simulateRoute — see CLAUDE.md.
 *
 * Props:
 *   origin, dest   route endpoints (drives reference fares + caps)
 *   config         seats per class ({ economy: 150, businessClass: 12, ... })
 *   fares          current fares ({ economy: 450, ... }); missing cabins fall back to reference
 *   onCommit(cls, value)      live mode: commit one cabin
 *   onCommitMany(updates)     review mode: commit every changed cabin at once
 *   project(fares)            optional; returns { loadFactor, breakEven, profit, basisLabel }
 *   showSeats      show "(N seats)" next to each cabin label (default true)
 */
export default function FareEditor({ origin, dest, config, fares, onCommit, onCommitMany, project, showSeats = true }) {
  const batched = typeof onCommitMany === 'function';
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
    // In review mode the clamp still lands in the draft — it just waits for Apply.
    if (!batched) onCommit(cls, clamped);
  }

  /** Draft as numbers, for the projection and for Apply. */
  const draftFares = {};
  for (const cls of activeClasses) {
    const v = parseInt(draft[cls], 10);
    draftFares[cls] = Math.min(isNaN(v) || v <= 0 ? (fares?.[cls] ?? refPrices[cls]) : v, maxPrices[cls]);
  }

  // Which cabins the player has actually moved. Committing untouched cabins too
  // would overwrite a fare a different screen changed since this panel mounted.
  const dirtyClasses = activeClasses.filter(
    cls => draftFares[cls] !== Math.round(fares?.[cls] ?? refPrices[cls]));

  function applyAll() {
    if (!batched || dirtyClasses.length === 0) return;
    const updates = {};
    for (const cls of dirtyClasses) updates[cls] = draftFares[cls];
    onCommitMany(updates);
  }

  function resetAll() {
    const next = {};
    for (const cls of activeClasses) next[cls] = String(refPrices[cls]);
    setDraft(next);
    if (batched) {
      const updates = {};
      for (const cls of activeClasses) updates[cls] = refPrices[cls];
      onCommitMany(updates);
    } else {
      for (const cls of activeClasses) onCommit(cls, refPrices[cls]);
    }
  }

  // What these fares would actually do. Computed on the DRAFT, so the player
  // sees the consequence before paying for it rather than a week later.
  const forecast = typeof project === 'function' ? project(draftFares) : null;

  const anyOffRef = activeClasses.some(cls =>
    (parseInt(draft[cls], 10) || refPrices[cls]) !== refPrices[cls]);

  const pct1 = (v) => `${Math.round((v ?? 0) * 1000) / 10}%`;

  return (
    <div>
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
      {batched && (
        <button
          type="button"
          className={dirtyClasses.length > 0 ? 'btn btn-primary' : 'btn btn-ghost'}
          style={{ padding: '2px 10px', fontSize: 11, alignSelf: 'center' }}
          onClick={applyAll}
          disabled={dirtyClasses.length === 0}
          title={dirtyClasses.length > 0
            ? `Apply ${dirtyClasses.length} changed fare${dirtyClasses.length !== 1 ? 's' : ''} in one go`
            : 'No fare changes to apply'}
        >
          {dirtyClasses.length > 0 ? `Apply ${dirtyClasses.length} change${dirtyClasses.length !== 1 ? 's' : ''}` : 'Applied'}
        </button>
      )}
    </div>

    {/* What these fares do — before you commit to them, not a week after. */}
    {forecast && (
      <div style={{
        display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'baseline',
        marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)',
        fontSize: 11.5, color: 'var(--text-muted)',
      }}>
        <span style={{ color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '.05em', fontSize: 10 }}>
          {dirtyClasses.length > 0 ? 'At these fares' : 'At current fares'}
        </span>
        {forecast.loadFactor != null && (
          <span>
            projected load{' '}
            <strong style={{
              color: forecast.breakEven != null && forecast.loadFactor >= forecast.breakEven
                ? 'var(--green)' : 'var(--yellow)',
            }}>{pct1(forecast.loadFactor)}</strong>
          </span>
        )}
        {forecast.breakEven != null && (
          <span title="Load factor at which this route covers its costs on the profit basis shown on the Routes tab.">
            break-even <strong>{pct1(forecast.breakEven)}</strong>
            {forecast.basisLabel ? ` (${forecast.basisLabel.toLowerCase()})` : ''}
          </span>
        )}
        {forecast.profit != null && (
          <span>
            → <strong style={{ color: forecast.profit >= 0 ? 'var(--green)' : 'var(--red)' }}>
              {forecast.profit >= 0 ? '+' : ''}{forecast.profitLabel ?? forecast.profit}
            </strong>/wk
          </span>
        )}
        {forecast.note && <span style={{ color: 'var(--text-dim)' }}>{forecast.note}</span>}
      </div>
    )}
    </div>
  );
}
