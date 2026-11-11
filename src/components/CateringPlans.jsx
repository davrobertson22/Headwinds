import { useMemo, useState } from 'react';
import { useGame } from '../store/GameContext.jsx';
import { useConfirm } from './ConfirmModal.jsx';
import {
  formatMoney, routeDistanceKm, routeStops, stateCateringFields, routePairKey,
} from '../utils/simulation.js';
import { getAirport, getRegion } from '../data/airports.js';
import { CABIN_CLASSES, CATERING_LEVELS, CATERING_LEVEL_ORDER, cateringQualityBonus, cateringDistanceFactor } from '../data/catering.js';
import {
  CATERING_ITEMS, CATERING_TIERS, CATERING_TIER_ORDER, CABIN_LABELS, MAX_CATERING_PLANS,
  CATERING_PLAN_NAME_MAX, CATERING_SCORE_NONE, CATERING_SCORE_FULL, CATERING_SCORE_CEILING,
  itemCost, itemMaxPrice, cabinMenuEconomics, planQualityBonus, planBlendedScore,
  classicTemplateCabins, sanitizeCateringPlan, cateringPlanSaveError, cateringPlanUsage,
  planRef, cateringRefName, cateringRefSummary, routeCateringEconomics, routeCateringQuality,
  normalizeCateringRef,
} from '../data/cateringPlans.js';

/**
 * Service plans — the airline's own catering menus.
 *
 * A plan says, cabin by cabin, what is served, how good it is, and whether it
 * is free or sold and for how much. Every figure on this card comes from
 * data/cateringPlans.js, the functions the weekly tick charges and scores
 * with, so the editor never shows a number the game will not use. Money is per
 * passenger on board. No price is ever suggested: the player sees what an item
 * costs and what their own price does.
 */

const LAYOUTS = [
  { id: 'narrow', name: 'Narrow body · 150 economy, 12 business', config: { economy: 150, businessClass: 12 } },
  { id: 'wide',   name: 'Wide body · 200 / 28 / 40 / 8',          config: { economy: 200, premiumEconomy: 28, businessClass: 40, firstClass: 8 } },
  { id: 'eco',    name: 'All economy · 180 seats',                config: { economy: 180 } },
];
const DIST_PRESETS = [{ km: 800, name: 'Short' }, { km: 2500, name: 'Medium' }, { km: 8000, name: 'Long' }];

const money2 = (n) => `${n < -0.004 ? '−' : ''}$${Math.abs(n).toFixed(2)}`;
const signed = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n)}`;
const netColor = (n) => (n > 0.004 ? 'var(--green)' : n < -0.004 ? 'var(--red)' : 'var(--text-muted)');
const qColor = (q) => (q > 0 ? 'var(--green)' : q < 0 ? 'var(--red)' : 'var(--text-muted)');
const newPlanId = () => `p${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const sectionLabel = { fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' };
const th = { textAlign: 'right', padding: '4px 8px', fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' };
const td = { textAlign: 'right', padding: '6px 8px', fontSize: 12, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' };

/**
 * A cabin or route quality score on a fixed scale, drawn from the zero line:
 * green to the right, red to the left, with labelled ticks.
 */
export function QualityScaleBar({ value, min, max, ticks = [], height = 10, label = null }) {
  const span = max - min;
  const pos = (v) => `${Math.max(0, Math.min(100, ((v - min) / span) * 100))}%`;
  // A label at either end hangs inward so it is never clipped by the card.
  const edge = (v) => { const p = ((v - min) / span) * 100; return p <= 4 ? 'start' : p >= 96 ? 'end' : 'mid'; };
  const zero = ((0 - min) / span) * 100;
  const at = Math.max(0, Math.min(100, ((value - min) / span) * 100));
  const left = Math.min(zero, at), width = Math.abs(at - zero);
  return (
    <div role="img" aria-label={label ?? `Quality ${value.toFixed(1)}`} style={{ position: 'relative', paddingBottom: ticks.length ? 14 : 0 }}>
      <div style={{ position: 'relative', height, borderRadius: height / 2, background: 'var(--surface3)', border: '1px solid var(--border)' }}>
        <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${left}%`, width: `${width}%`,
          background: value >= 0 ? 'var(--green)' : 'var(--red)', borderRadius: height / 2, opacity: 0.85 }} />
        <div style={{ position: 'absolute', top: -2, bottom: -2, left: `${zero}%`, width: 1, background: 'var(--text-muted)' }} />
      </div>
      {ticks.map(t => (
        <div key={t.label} style={{ position: 'absolute', top: height + 2, left: pos(t.value),
          transform: `translateX(${edge(t.value) === 'start' ? '0' : edge(t.value) === 'end' ? '-100%' : '-50%'})`,
          fontSize: 9, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
          <span style={{ display: 'block', width: 1, height: 3, background: 'var(--text-dim)',
            margin: edge(t.value) === 'start' ? '0 auto 0 0' : edge(t.value) === 'end' ? '0 0 0 auto' : '0 auto' }} />
          {t.label}
        </div>
      ))}
    </div>
  );
}

/** One item's contribution: filled to what it adds now, with a marker where it would sit if free. */
function ItemQualityBar({ points, pointsIfFree, max }) {
  const pct = (v) => `${Math.max(0, Math.min(100, (v / max) * 100))}%`;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 130 }}
      title={pointsIfFree > points + 0.05
        ? `Adds ${points.toFixed(1)} quality points. Free, it would add ${pointsIfFree.toFixed(1)}.`
        : `Adds ${points.toFixed(1)} quality points.`}>
      <div style={{ position: 'relative', flex: 1, height: 8, borderRadius: 4, background: 'var(--surface3)', border: '1px solid var(--border)' }}>
        <div style={{ position: 'absolute', inset: 0, right: 'auto', width: pct(points), background: 'var(--green)', borderRadius: 4, opacity: 0.85 }} />
        {pointsIfFree > points + 0.05 && (
          <div style={{ position: 'absolute', top: -3, bottom: -3, left: pct(pointsIfFree), width: 2, background: 'var(--text-muted)' }} />
        )}
      </div>
      <span style={{ fontSize: 11, width: 34, textAlign: 'right', color: points > 0.05 ? 'var(--green)' : 'var(--text-dim)', fontVariantNumeric: 'tabular-nums' }}>
        +{points.toFixed(1)}
      </span>
    </div>
  );
}

function DistanceAndLayout({ distKm, setDistKm, layoutId, setLayoutId, slider = false }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', fontSize: 12 }}>
      <span style={{ color: 'var(--text-muted)' }}>Figures for a</span>
      <span style={{ display: 'flex', gap: 4 }}>
        {DIST_PRESETS.map(p => (
          <button key={p.km} type="button" className="btn btn-ghost"
            style={{ fontSize: 11, padding: '3px 9px', ...(distKm === p.km ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}) }}
            onClick={() => setDistKm(p.km)}>
            {p.name}
          </button>
        ))}
      </span>
      {slider && (
        <input type="range" min={300} max={14000} step={100} value={distKm} aria-label="Flight length"
          onChange={e => setDistKm(Number(e.target.value))} style={{ flex: '1 1 160px', maxWidth: 260 }} />
      )}
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{distKm.toLocaleString()} km flight</span>
      <select className="form-select" value={layoutId} onChange={e => setLayoutId(e.target.value)} aria-label="Cabin layout"
        style={{ width: 'auto', fontSize: 12, padding: '4px 6px' }}>
        {LAYOUTS.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
      </select>
    </div>
  );
}

// ─── The editor ──────────────────────────────────────────────────────────────

export function PlanEditor({ draft, setDraft, plans, usage, distKm, setDistKm, layoutId, setLayoutId, onSave, onCancel }) {
  const [cabin, setCabin] = useState('economy');
  const config = LAYOUTS.find(l => l.id === layoutId).config;
  const econ = useMemo(
    () => Object.fromEntries(CABIN_CLASSES.map(c => [c, cabinMenuEconomics(draft.cabins[c], c, distKm)])),
    [draft, distKm]);
  const clean = sanitizeCateringPlan(draft);
  const saveError = !draft.name.trim() ? 'Give the plan a name.' : cateringPlanSaveError(clean, plans);
  const unpriced = CABIN_CLASSES.flatMap(c => Object.entries(draft.cabins[c] ?? {})
    .filter(([, e]) => e.mode === 'sold' && !(e.price > 0)).map(([id]) => `${CATERING_ITEMS.find(i => i.id === id).name} (${CABIN_LABELS[c]})`));

  const setEntry = (itemId, patch) => setDraft(d => {
    const menu = { ...(d.cabins[cabin] ?? {}) };
    if (patch === null) delete menu[itemId];
    else menu[itemId] = { tier: 'standard', ...(menu[itemId] ?? {}), ...patch };
    return { ...d, cabins: { ...d.cabins, [cabin]: menu } };
  });
  const copyTo = (target) => setDraft(d => {
    const out = {};
    for (const [id, e] of Object.entries(d.cabins[cabin] ?? {})) {
      const from = itemCost(id, cabin, e.tier), to = itemCost(id, target, e.tier);
      if (to == null) continue;
      // Same markup over cost in the new cabin, to the nearest 50 cents.
      out[id] = e.mode === 'sold' && e.price > 0 && from > 0
        ? { ...e, price: Math.min(itemMaxPrice(id, target, e.tier), Math.round((e.price / from) * to * 2) / 2) }
        : { ...e };
    }
    return { ...d, cabins: { ...d.cabins, [target]: out } };
  });

  const e = econ[cabin];
  const distFactor = cateringDistanceFactor(distKm);
  const maxPts = Math.max(8, ...CATERING_ITEMS.map(it => (e.rows[it.id]?.pointsIfFree ?? 0)));
  const seats = CABIN_CLASSES.reduce((s, c) => s + (config[c] ?? 0), 0);
  const perPax = (k) => CABIN_CLASSES.reduce((s, c) => s + (config[c] ?? 0) * econ[c][k], 0) / seats;
  const routeQ = planQualityBonus(draft, distKm, config);
  const classicFull = cateringQualityBonus('full', distKm), classicNone = cateringQualityBonus('none', distKm);

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end', marginBottom: 12 }}>
        <label style={{ flex: '1 1 220px' }}>
          <div className="form-label" style={{ marginBottom: 4 }}>Plan name</div>
          <input className="form-input" value={draft.name} maxLength={CATERING_PLAN_NAME_MAX} placeholder="e.g. Long-haul flagship"
            onChange={ev => setDraft(d => ({ ...d, name: ev.target.value }))} />
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={!!saveError} title={saveError ?? undefined} onClick={() => onSave(clean)}>
            Save plan
          </button>
        </div>
      </div>
      {saveError && draft.name.trim() && <div style={{ fontSize: 12, color: 'var(--red)', marginBottom: 8 }}>{saveError}</div>}
      {usage.count > 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
          Used on {usage.count} route{usage.count !== 1 ? 's' : ''}. Saving changes what they serve from next week.
        </div>
      )}

      <div style={{ padding: '10px 12px', background: 'var(--surface2)', borderRadius: 'var(--radius)', marginBottom: 12 }}>
        <DistanceAndLayout distKm={distKm} setDistKm={setDistKm} layoutId={layoutId} setLayoutId={setLayoutId} slider />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginTop: 12, alignItems: 'end' }}>
          <Figure label="Cost per passenger" value={money2(-perPax('costPerPax'))} color="var(--red)" />
          <Figure label="Sales per passenger" value={money2(perPax('revenuePerPax'))} color={perPax('revenuePerPax') > 0 ? 'var(--green)' : 'var(--text-muted)'} />
          <Figure label="Net per passenger" value={money2(perPax('netPerPax'))} color={netColor(perPax('netPerPax'))} />
          <div style={{ gridColumn: 'span 2', minWidth: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
              <span>Route quality from catering</span>
              <span style={{ fontWeight: 700, fontSize: 14, color: qColor(routeQ) }}>{signed(routeQ)}</span>
            </div>
            <QualityScaleBar value={routeQ} min={Math.min(classicNone, -1)} max={Math.max(classicFull * (CATERING_SCORE_CEILING / CATERING_SCORE_FULL), 1)}
              ticks={[{ value: classicNone, label: 'None' }, { value: cateringQualityBonus('paid', distKm), label: 'Paid' }, { value: classicFull, label: 'Full' }]}
              label={`Route quality from catering ${signed(routeQ)}; classic Full is ${signed(classicFull)}`} />
          </div>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 8, lineHeight: 1.4 }}>
          Averaged over everyone on board for the layout chosen. Economy counts for half of route quality and the premium
          cabins share the other half. Food matters more the longer the flight: on a short hop a drink and a snack go a long
          way, on long haul the meal is most of it.
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }} role="tablist" aria-label="Cabin">
        {CABIN_CLASSES.slice().reverse().map(c => {
          const active = c === cabin, x = econ[c];
          return (
            <button key={c} type="button" role="tab" aria-selected={active} onClick={() => setCabin(c)}
              style={{ flex: '1 1 150px', textAlign: 'left', cursor: 'pointer', padding: '8px 10px', borderRadius: 'var(--radius)',
                border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                background: active ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'var(--surface3)', color: 'var(--text)' }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: active ? 'var(--accent)' : 'var(--text)' }}>{CABIN_LABELS[c]}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                net <span style={{ color: netColor(x.netPerPax) }}>{money2(x.netPerPax)}</span>
                {' · '}quality <span style={{ color: qColor(x.score) }}>{signed(+x.score.toFixed(1))}</span>
              </div>
            </button>
          );
        })}
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              <th style={{ ...th, textAlign: 'left' }}>{CABIN_LABELS[cabin]} menu</th>
              <th style={{ ...th, textAlign: 'left' }}>Serve</th>
              <th style={{ ...th, textAlign: 'left' }}>Quality tier</th>
              <th style={th}>Your price</th>
              <th style={th}>Cost / pax</th>
              <th style={th}>Who buys</th>
              <th style={th}>Sales / pax</th>
              <th style={th}>Net / pax</th>
              <th style={{ ...th, textAlign: 'left' }}>Quality added</th>
            </tr>
          </thead>
          <tbody>
            {CATERING_ITEMS.filter(it => it.cost[cabin] != null).map(it => {
              const entry = draft.cabins[cabin]?.[it.id] ?? null;
              const mode = entry?.mode ?? 'off';
              const tier = it.tiered ? (entry?.tier ?? 'standard') : 'standard';
              const row = e.rows[it.id] ?? null;
              const unit = itemCost(it.id, cabin, tier);
              const needsPrice = mode === 'sold' && !(entry.price > 0);
              return (
                <tr key={it.id} style={{ borderBottom: '1px solid var(--border)', opacity: mode === 'off' ? 0.6 : 1 }}>
                  <td style={{ ...td, textAlign: 'left', whiteSpace: 'normal' }}>
                    <div style={{ fontWeight: 600 }}>{it.name}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                      costs you {money2(unit * distFactor)} a serving on this flight
                      {row?.shadowed && <span style={{ color: 'var(--yellow)' }}> · the other meal is better, so this adds nothing</span>}
                    </div>
                  </td>
                  <td style={{ ...td, textAlign: 'left' }}>
                    <span style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
                      {[['off', 'Off'], ['free', 'Free'], ['sold', 'Sell']].map(([m, name]) => (
                        <button key={m} type="button" aria-pressed={mode === m}
                          onClick={() => setEntry(it.id, m === 'off' ? null : { mode: m })}
                          style={{ border: 'none', cursor: 'pointer', padding: '4px 9px', fontSize: 11, fontWeight: mode === m ? 700 : 500,
                            background: mode === m ? 'var(--accent)' : 'var(--surface3)', color: mode === m ? '#06201c' : 'var(--text-muted)' }}>
                          {name}
                        </button>
                      ))}
                    </span>
                  </td>
                  <td style={{ ...td, textAlign: 'left' }}>
                    {it.tiered ? (
                      <select className="form-select" value={tier} disabled={mode === 'off'} aria-label={`${it.name} quality tier`}
                        onChange={ev => setEntry(it.id, { tier: ev.target.value })}
                        style={{ width: 'auto', fontSize: 12, padding: '3px 6px' }}>
                        {CATERING_TIER_ORDER.map(t => <option key={t} value={t}>{CATERING_TIERS[t].name}</option>)}
                      </select>
                    ) : <span style={{ color: 'var(--text-dim)' }}>—</span>}
                  </td>
                  <td style={td}>
                    {mode === 'sold' ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                        $<input className="form-input" type="number" min={0} max={itemMaxPrice(it.id, cabin, tier)} step={0.5}
                          value={entry.price ?? ''} placeholder="type" aria-label={`${it.name} price`}
                          onChange={ev => { const v = parseFloat(ev.target.value); setEntry(it.id, { price: Number.isFinite(v) && v > 0 ? v : null }); }}
                          style={{ width: 72, fontSize: 12, padding: '3px 6px', textAlign: 'right', ...(needsPrice ? { borderColor: 'var(--yellow)' } : {}) }} />
                      </span>
                    ) : <span style={{ color: 'var(--text-dim)' }}>{mode === 'free' ? 'free' : '—'}</span>}
                  </td>
                  <td style={{ ...td, color: row ? 'var(--red)' : 'var(--text-dim)' }}>{row ? money2(-row.costPerPax) : '—'}</td>
                  <td style={td}>{row ? (mode === 'free' ? 'everyone' : `${Math.round(row.take * 100)}%`) : needsPrice ? <span style={{ color: 'var(--yellow)' }}>no price yet</span> : '—'}</td>
                  <td style={{ ...td, color: row?.revenuePerPax > 0 ? 'var(--green)' : 'var(--text-dim)' }}>{row && mode === 'sold' ? money2(row.revenuePerPax) : '—'}</td>
                  <td style={{ ...td, fontWeight: 600, color: row ? netColor(row.netPerPax) : 'var(--text-dim)' }}>{row ? money2(row.netPerPax) : '—'}</td>
                  <td style={{ ...td, textAlign: 'left' }}>
                    {row ? <ItemQualityBar points={row.points} pointsIfFree={row.pointsIfFree} max={maxPts} /> : <span style={{ color: 'var(--text-dim)' }}>—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td style={{ ...td, textAlign: 'left', fontWeight: 700 }} colSpan={4}>{CABIN_LABELS[cabin]} total, per passenger</td>
              <td style={{ ...td, fontWeight: 700, color: 'var(--red)' }}>{money2(-e.costPerPax)}</td>
              <td style={td} />
              <td style={{ ...td, fontWeight: 700, color: e.revenuePerPax > 0 ? 'var(--green)' : 'var(--text-dim)' }}>{money2(e.revenuePerPax)}</td>
              <td style={{ ...td, fontWeight: 700, color: netColor(e.netPerPax) }}>{money2(e.netPerPax)}</td>
              <td style={{ ...td, textAlign: 'left', fontWeight: 700, color: qColor(e.score) }}>cabin quality {signed(+e.score.toFixed(1))}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div style={{ marginTop: 10, padding: '10px 12px', background: 'var(--surface2)', borderRadius: 'var(--radius)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
          <span>{CABIN_LABELS[cabin]} cabin quality, before flight length is applied</span>
          <span style={{ fontWeight: 700, color: qColor(e.score) }}>{signed(+e.score.toFixed(1))}</span>
        </div>
        <QualityScaleBar value={e.score} min={CATERING_SCORE_NONE} max={CATERING_SCORE_CEILING}
          ticks={[{ value: CATERING_SCORE_NONE, label: 'Nothing served' }, { value: 0, label: '0' },
            { value: CATERING_SCORE_FULL, label: 'Classic Full' }, { value: CATERING_SCORE_CEILING, label: 'Ceiling' }]}
          label={`${CABIN_LABELS[cabin]} cabin quality ${e.score.toFixed(1)} on a scale from ${CATERING_SCORE_NONE} to ${CATERING_SCORE_CEILING}`} />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginTop: 12, fontSize: 12, color: 'var(--text-muted)' }}>
          Copy this menu to
          {CABIN_CLASSES.filter(c => c !== cabin).map(c => (
            <button key={c} type="button" className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 9px' }} onClick={() => copyTo(c)}>
              {CABIN_LABELS[c]}
            </button>
          ))}
          <span style={{ color: 'var(--text-dim)' }}>(prices keep the same markup over cost)</span>
        </div>
      </div>
      {unpriced.length > 0 && (
        <div style={{ fontSize: 12, color: 'var(--yellow)', marginTop: 8 }}>
          Set to sell but not priced yet, so not served: {unpriced.join(', ')}.
        </div>
      )}
    </div>
  );
}

function Figure({ label, value, color }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  );
}

// ─── Apply to routes ─────────────────────────────────────────────────────────

const LENGTHS = [
  { id: 'all', name: 'Any length', test: () => true },
  { id: 'short', name: 'Short · under 1,500 km', test: (d) => d < 1500 },
  { id: 'medium', name: 'Medium · 1,500–4,000 km', test: (d) => d >= 1500 && d <= 4000 },
  { id: 'long', name: 'Long · over 4,000 km', test: (d) => d > 4000 },
];

export function ApplyToRoutes({ plan, state, onApply, onCancel }) {
  const [length, setLength] = useState('all');
  const [region, setRegion] = useState('all');
  const [hub, setHub] = useState('all');
  const [picked, setPicked] = useState(() => new Set());
  const ref = planRef(plan.id);

  const pairs = useMemo(() => {
    const results = new Map((state.lastReport?.routeResults ?? []).map(r => [r.routeId, r]));
    const fleet = new Map((state.fleet ?? []).map(a => [a.id, a]));
    const byKey = new Map();
    for (const r of state.routes ?? []) {
      const key = routePairKey(r.origin, r.destination);
      if (!byKey.has(key)) byKey.set(key, { key, origin: r.origin, destination: r.destination, routes: [] });
      byKey.get(key).routes.push(r);
    }
    return [...byKey.values()].map(g => {
      const first = g.routes[0];
      const dist = routeDistanceKm(g.origin, g.destination);
      const current = normalizeCateringRef(first.cateringLevel, state.cateringPlans);
      const regions = new Set([g.origin, g.destination].map(c => getRegion(getAirport(c)?.country)).filter(Boolean));
      // What changes, at last week's passengers: the plan's bill against the
      // bill the tick charged, at the same kitchen or contract rate.
      let dNet = 0, dQ = 0, measured = 0;
      for (const r of g.routes) {
        const rr = results.get(r.id);
        const config = fleet.get(r.aircraftId)?.config ?? null;
        const now = { ...r, ...stateCateringFields(state, r) };
        const next = { ...r, cateringPlan: undefined, ...stateCateringFields(state, { ...r, cateringLevel: ref }), cateringLevel: ref };
        dQ += routeCateringQuality(next, dist, config) - routeCateringQuality(now, dist, config);
        if (!rr?.classSummary) continue;
        const d = rr.distance ?? dist;
        const was = routeCateringEconomics(now, rr.classSummary, d), will = routeCateringEconomics(next, rr.classSummary, d);
        const rate = was.cost > 0 ? (rr.cateringCost ?? was.cost) / was.cost : (next.cateringCostFactor ?? 1);
        dNet += (will.revenue - will.cost * rate) - ((rr.cateringRevenue ?? was.revenue) - (rr.cateringCost ?? was.cost));
        measured++;
      }
      return { ...g, dist, current, regions, dNet, dQ: dQ / g.routes.length, measured: measured > 0,
        hubs: new Set(routeStops(first).filter(c => state.hubs?.[c] || state.hub === c)) };
    }).sort((a, b) => a.dist - b.dist);
  }, [state, ref]);

  const allRegions = [...new Set(pairs.flatMap(p => [...p.regions]))].sort();
  const allHubs = [...new Set(pairs.flatMap(p => [...p.hubs]))].sort();
  const lengthTest = LENGTHS.find(l => l.id === length).test;
  const shown = pairs.filter(p => lengthTest(p.dist) && (region === 'all' || p.regions.has(region)) && (hub === 'all' || p.hubs.has(hub)));
  const chosen = pairs.filter(p => picked.has(p.key) && p.current !== ref);
  const totalNet = chosen.reduce((s, p) => s + p.dNet, 0);
  const avgQ = chosen.length ? chosen.reduce((s, p) => s + p.dQ, 0) / chosen.length : 0;
  const toggle = (key) => setPicked(s => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const sel = { width: 'auto', fontSize: 12, padding: '4px 6px' };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>Apply {plan.name} to routes</div>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>Back</button>
      </div>
      {pairs.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>You have no routes yet. New routes take the default service above.</div>
      ) : (<>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 10 }}>
          <select className="form-select" style={sel} value={length} onChange={e => setLength(e.target.value)} aria-label="Flight length">
            {LENGTHS.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          <select className="form-select" style={sel} value={region} onChange={e => setRegion(e.target.value)} aria-label="Region">
            <option value="all">Any region</option>
            {allRegions.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
          {allHubs.length > 0 && (
            <select className="form-select" style={sel} value={hub} onChange={e => setHub(e.target.value)} aria-label="Hub">
              <option value="all">Any hub</option>
              {allHubs.map(h => <option key={h} value={h}>Through {h}</option>)}
            </select>
          )}
          <button type="button" className="btn btn-ghost" style={{ fontSize: 12 }}
            onClick={() => setPicked(s => new Set([...s, ...shown.map(p => p.key)]))}>
            Select all {shown.length} shown
          </button>
          <button type="button" className="btn btn-ghost" style={{ fontSize: 12 }} disabled={picked.size === 0} onClick={() => setPicked(new Set())}>
            Clear
          </button>
        </div>
        <div style={{ maxHeight: 340, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 520 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, background: 'var(--surface)' }}>
                <th style={{ ...th, textAlign: 'left' }}>Route</th>
                <th style={th}>Distance</th>
                <th style={{ ...th, textAlign: 'left' }}>Serves now</th>
                <th style={th}>Catering net / week</th>
                <th style={th}>Quality</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(p => {
                const same = p.current === ref;
                return (
                  <tr key={p.key} style={{ borderBottom: '1px solid var(--border)', opacity: same ? 0.55 : 1 }}>
                    <td style={{ ...td, textAlign: 'left' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: same ? 'default' : 'pointer' }}>
                        <input type="checkbox" checked={same || picked.has(p.key)} disabled={same} onChange={() => toggle(p.key)} />
                        <span style={{ fontWeight: 600 }}>{p.origin}–{p.destination}</span>
                      </label>
                    </td>
                    <td style={td}>{Math.round(p.dist).toLocaleString()} km</td>
                    <td style={{ ...td, textAlign: 'left' }}>{cateringRefName(p.current, state.cateringPlans)}</td>
                    <td style={{ ...td, color: same || !p.measured ? 'var(--text-dim)' : netColor(p.dNet) }}>
                      {same ? 'already on it' : !p.measured ? 'not flown yet' : `${p.dNet >= 0 ? '+' : '−'}${formatMoney(Math.abs(p.dNet)).replace('-', '')}`}
                    </td>
                    <td style={{ ...td, color: same ? 'var(--text-dim)' : qColor(Math.round(p.dQ)) }}>{same ? '—' : signed(Math.round(p.dQ))}</td>
                  </tr>
                );
              })}
              {shown.length === 0 && (
                <tr><td colSpan={5} style={{ ...td, textAlign: 'left', color: 'var(--text-dim)' }}>No routes match these filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 10 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {chosen.length === 0 ? 'Tick the routes to move to this plan.' : (<>
              {chosen.length} route{chosen.length !== 1 ? 's' : ''}: catering net{' '}
              <strong style={{ color: netColor(totalNet) }}>{totalNet >= 0 ? '+' : '−'}{formatMoney(Math.abs(totalNet)).replace('-', '')} a week</strong>
              {' '}at last week's passengers, quality{' '}
              <strong style={{ color: qColor(Math.round(avgQ)) }}>{signed(+avgQ.toFixed(1))}</strong> on average.
              Better or worse food also moves demand, which this figure leaves out.
            </>)}
          </div>
          <button type="button" className="btn btn-primary" disabled={chosen.length === 0}
            onClick={() => onApply(chosen.flatMap(p => p.routes.map(r => r.id)), chosen.length)}>
            Apply to {chosen.length || ''} route{chosen.length !== 1 ? 's' : ''}
          </button>
        </div>
      </>)}
    </div>
  );
}

// ─── The card ────────────────────────────────────────────────────────────────

export default function CateringPlans() {
  const { state, dispatch } = useGame();
  const confirm = useConfirm();
  const [draft, setDraft] = useState(null);
  const [applyId, setApplyId] = useState(null);
  const [distKm, setDistKm] = useState(2500);
  const [layoutId, setLayoutId] = useState('narrow');
  const plans = state.cateringPlans ?? {};
  const planList = Object.values(plans).sort((a, b) => a.name.localeCompare(b.name));
  const config = LAYOUTS.find(l => l.id === layoutId).config;
  const atLimit = planList.length >= MAX_CATERING_PLANS;

  const uniqueName = (base) => {
    const taken = new Set(planList.map(p => p.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`.slice(0, CATERING_PLAN_NAME_MAX);
  };
  const emptyCabins = () => Object.fromEntries(CABIN_CLASSES.map(c => [c, {}]));
  const startFrom = (level) => setDraft({
    id: newPlanId(),
    name: uniqueName(level ? `My ${CATERING_LEVELS[level].name}` : 'New plan'),
    ...(level ? { basedOn: level } : {}),
    cabins: level ? classicTemplateCabins(level) : emptyCabins(),
  });
  const duplicate = (p) => setDraft({ ...JSON.parse(JSON.stringify(p)), id: newPlanId(), name: uniqueName(`${p.name} copy`.slice(0, CATERING_PLAN_NAME_MAX)) });
  const edit = (p) => setDraft({ ...JSON.parse(JSON.stringify(p)), cabins: { ...emptyCabins(), ...JSON.parse(JSON.stringify(p.cabins)) } });

  if (draft) {
    return (
      <div className="card" style={{ padding: '14px 18px' }}>
        <PlanEditor draft={draft} setDraft={setDraft} plans={plans} usage={cateringPlanUsage(draft.id, state)}
          distKm={distKm} setDistKm={setDistKm} layoutId={layoutId} setLayoutId={setLayoutId}
          onCancel={() => setDraft(null)}
          onSave={(plan) => { dispatch({ type: 'SAVE_CATERING_PLAN', plan }); setDraft(null); }} />
      </div>
    );
  }
  if (applyId && plans[applyId]) {
    return (
      <div className="card" style={{ padding: '14px 18px' }}>
        <ApplyToRoutes plan={plans[applyId]} state={state} onCancel={() => setApplyId(null)}
          onApply={(routeIds) => { dispatch({ type: 'SET_ROUTE_CATERING', routeIds, level: planRef(applyId) }); setApplyId(null); }} />
      </div>
    );
  }

  const row = (ref, plan) => {
    const s = cateringRefSummary(ref, plans, distKm, config);
    const use = plan ? cateringPlanUsage(plan.id, state) : null;
    const lo = cateringQualityBonus('none', distKm);
    const hi = Math.max(1, cateringQualityBonus('full', distKm) * (CATERING_SCORE_CEILING / CATERING_SCORE_FULL));
    return (
      <tr key={ref} style={{ borderBottom: '1px solid var(--border)' }}>
        <td style={{ ...td, textAlign: 'left', whiteSpace: 'normal' }}>
          <div style={{ fontWeight: 600 }}>{s.name}</div>
          {plan && (
            <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>
              {use.count} route{use.count !== 1 ? 's' : ''}{use.isDefault ? ' · default for new routes' : ''}
            </div>
          )}
        </td>
        <td style={{ ...td, color: s.costPerPax > 0 ? 'var(--red)' : 'var(--text-dim)' }}>{money2(-s.costPerPax)}</td>
        <td style={{ ...td, color: s.revenuePerPax > 0 ? 'var(--green)' : 'var(--text-dim)' }}>{money2(s.revenuePerPax)}</td>
        <td style={{ ...td, fontWeight: 600, color: netColor(s.netPerPax) }}>{money2(s.netPerPax)}</td>
        <td style={{ ...td, textAlign: 'left', minWidth: 150 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ flex: 1 }}><QualityScaleBar value={s.quality} min={Math.min(lo, -1)} max={hi} height={8} /></div>
            <span style={{ width: 28, textAlign: 'right', fontWeight: 700, color: qColor(s.quality) }}>{signed(s.quality)}</span>
          </div>
        </td>
        <td style={{ ...td, textAlign: 'right' }}>
          {plan ? (
            <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 8px' }} onClick={() => edit(plan)}>Edit</button>
              <button type="button" className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 8px' }} onClick={() => setApplyId(plan.id)}>Apply to routes</button>
              <button type="button" className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 8px' }} disabled={atLimit}
                title={atLimit ? `You can keep up to ${MAX_CATERING_PLANS} plans.` : undefined} onClick={() => duplicate(plan)}>Duplicate</button>
              <button type="button" className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 8px' }} disabled={use.isDefault}
                onClick={() => dispatch({ type: 'SET_DEFAULT_CATERING', level: ref })}>
                {use.isDefault ? 'Default' : 'Make default'}
              </button>
              <button type="button" className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 8px', color: 'var(--red)' }} disabled={use.count > 0}
                title={use.count > 0 ? 'Move its routes to another plan first.' : undefined}
                onClick={async () => {
                  if (await confirm({ title: `Delete ${plan.name}?`, body: 'No route uses it. This cannot be undone.', danger: true, confirmLabel: 'Delete' })) {
                    dispatch({ type: 'DELETE_CATERING_PLAN', id: plan.id });
                  }
                }}>Delete</button>
            </span>
          ) : (
            <button type="button" className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 8px' }} disabled={atLimit}
              title={atLimit ? `You can keep up to ${MAX_CATERING_PLANS} plans.` : `Start a plan of your own from ${s.name}.`}
              onClick={() => startFrom(ref)}>Customise</button>
          )}
        </td>
      </tr>
    );
  };

  return (
    <div className="card" style={{ padding: '14px 18px' }}>
      <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.5 }}>
        Build your own service. For each cabin choose what is served, how good it is, and whether it is free or sold
        and for how much. Better food and lower prices cost more and lift quality and reputation; thinner menus and
        higher prices earn more and cost quality. Save a menu as a plan, then put it on as many routes as you like.
        The five classic levels stay as they are.
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        <DistanceAndLayout distKm={distKm} setDistKm={setDistKm} layoutId={layoutId} setLayoutId={setLayoutId} />
        <button type="button" className="btn btn-primary" disabled={atLimit}
          title={atLimit ? `You can keep up to ${MAX_CATERING_PLANS} plans.` : undefined} onClick={() => startFrom(null)}>
          New blank plan
        </button>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 700 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              <th style={{ ...th, textAlign: 'left' }}>Plan</th>
              <th style={th}>Cost / pax</th>
              <th style={th}>Sales / pax</th>
              <th style={th}>Net / pax</th>
              <th style={{ ...th, textAlign: 'left' }}>Route quality</th>
              <th style={th} />
            </tr>
          </thead>
          <tbody>
            <tr><td colSpan={6} style={{ ...sectionLabel, padding: '8px 8px 4px' }}>Your plans</td></tr>
            {planList.length === 0 ? (
              <tr><td colSpan={6} style={{ ...td, textAlign: 'left', color: 'var(--text-dim)' }}>
                None yet. Start a blank plan, or customise a classic level below.
              </td></tr>
            ) : planList.map(p => row(planRef(p.id), p))}
            <tr><td colSpan={6} style={{ ...sectionLabel, padding: '12px 8px 4px' }}>Classic levels</td></tr>
            {CATERING_LEVEL_ORDER.map(id => row(id, null))}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 8, lineHeight: 1.4 }}>
        Per passenger on board, averaged across the layout chosen, before any caterer contract or hub kitchen rate.
        A customised copy of a classic level starts close to it, not identical.
      </div>
    </div>
  );
}
