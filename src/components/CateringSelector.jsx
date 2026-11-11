import { CATERING_LEVELS, CATERING_LEVEL_ORDER, cateringQualityBonus } from '../data/catering.js';
import { normalizeCateringRef, planRef, planForRef, planQualityBonus } from '../data/cateringPlans.js';

/**
 * Reusable catering picker: the five classic levels plus the airline's own
 * service plans (data/cateringPlans.js).
 *
 * Props:
 *   value     current ref — a classic level id or `plan:<id>`
 *   onChange  (ref) => void
 *   distKm    optional — shows the quality delta for this route distance
 *   compact   optional — smaller pills, no description block
 *   label     optional heading text (default "Catering service")
 *   plans     optional — state.cateringPlans; omitted, only classic levels show
 *   config    optional — the aircraft's cabin layout, so a plan is scored on
 *             the cabins actually fitted
 *   capNote   optional — stateCateringCapReport(...) for this route. When a
 *             caterer can't deliver the chosen level, levels above its cap are
 *             marked and the route is told plainly what it will actually get.
 *   kitchenNote optional — stateCateringKitchenReport(...) for a route on a
 *             plan: what its caterers leave out.
 */
const PLAN_COLOR = 'var(--accent-bright, var(--accent))';
const list = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

export default function CateringSelector({
  value, onChange, distKm, compact = false, label = 'Catering service',
  capNote = null, plans = null, config = null, kitchenNote = null,
}) {
  const ref = normalizeCateringRef(value, plans);
  const activePlan = planForRef(ref, plans);
  const capIdx = capNote ? CATERING_LEVEL_ORDER.indexOf(capNote.cap) : Infinity;
  const planList = Object.values(plans ?? {}).sort((a, b) => a.name.localeCompare(b.name));

  const pill = ({ key, id, name, color, desc, qDelta, overCap = false }) => {
    const active = id === ref;
    return (
      <button
        key={key}
        type="button"
        onClick={() => onChange?.(id)}
        title={desc}
        style={{
          display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
          gap: 2, cursor: 'pointer',
          padding: compact ? '4px 9px' : '6px 11px',
          borderRadius: 'var(--radius)',
          border: `1px solid ${active ? color : 'var(--border)'}`,
          background: active ? `color-mix(in srgb, ${color} 16%, transparent)` : 'var(--surface3)',
          color: active ? color : 'var(--text-muted)',
          fontWeight: active ? 700 : 500,
          fontSize: compact ? 11 : 12,
          transition: 'all 0.12s',
        }}
      >
        <span style={overCap ? { textDecoration: 'line-through', opacity: 0.7 } : undefined}>{name}</span>
        {qDelta != null && !compact && (
          <span style={{ fontSize: 10, fontWeight: 600, color: qDelta > 0 ? 'var(--green)' : qDelta < 0 ? 'var(--red)' : 'var(--text-dim)' }}>
            quality {qDelta >= 0 ? '+' : ''}{qDelta}
          </span>
        )}
      </button>
    );
  };

  return (
    <div>
      {label && (
        <div className="form-label" style={{ marginBottom: 6 }}>{label}</div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {CATERING_LEVEL_ORDER.map(id => {
          const meta    = CATERING_LEVELS[id];
          const overCap = !activePlan && CATERING_LEVEL_ORDER.indexOf(id) > capIdx;
          return pill({
            key: id, id, color: meta.color, overCap,
            name: compact ? meta.short : meta.name,
            desc: overCap ? `${meta.desc} — your caterer here can only deliver ${CATERING_LEVELS[capNote.cap].name}.` : meta.desc,
            qDelta: distKm != null ? cateringQualityBonus(id, distKm) : null,
          });
        })}
        {planList.map(p => pill({
          key: `plan-${p.id}`, id: planRef(p.id), color: PLAN_COLOR,
          name: p.name,
          desc: `${p.name} — one of your own service plans. Edit it under Operations › Catering.`,
          qDelta: distKm != null ? planQualityBonus(p, distKm, config) : null,
        }))}
      </div>
      {capNote && !activePlan && (
        <div style={{ fontSize: 11, color: 'var(--yellow)', marginTop: 6, lineHeight: 1.4 }}>
          ⚠ {capNote.suppliers.map(s => `${s.name} (${s.codes.join(', ')})`).join(' and ')} can't
          deliver {CATERING_LEVELS[capNote.chosen].name}. This route is served — and charged —
          as {CATERING_LEVELS[capNote.cap].name}. Change caterer on the Operations page.
        </div>
      )}
      {kitchenNote && activePlan && kitchenNote.gaps.map(g => (
        <div key={`${g.supplier}-${g.codes.join('-')}`} style={{ fontSize: 11, color: 'var(--yellow)', marginTop: 6, lineHeight: 1.4 }}>
          ⚠ {g.supplier} ({g.codes.join(', ')}) runs a {g.kitchen.toLowerCase()}.
          {g.missing.length > 0 && <> Flights it caters go without {list(g.missing.map(m => m.toLowerCase()))}.</>}
          {g.downgraded.length > 0 && <> It serves {list(g.downgraded.map(m => m.toLowerCase()))} as Standard, not Premium.</>}
          {' '}You pay only for what is served. Change caterer on the Operations page.
        </div>
      ))}
      {!compact && (
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6, lineHeight: 1.4 }}>
          {activePlan
            ? `${activePlan.name} is one of your own service plans. Change what it serves under Operations › Catering.`
            : CATERING_LEVELS[ref].desc}
        </div>
      )}
    </div>
  );
}
