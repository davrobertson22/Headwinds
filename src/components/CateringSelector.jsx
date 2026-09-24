import { CATERING_LEVELS, CATERING_LEVEL_ORDER, cateringQualityBonus, normalizeCateringLevel } from '../data/catering.js';

/**
 * Reusable catering service-level picker.
 *
 * Props:
 *   value     current level id
 *   onChange  (levelId) => void
 *   distKm    optional — shows the quality delta for this route distance
 *   compact   optional — smaller pills, no description block
 *   label     optional heading text (default "Catering service")
 *   capNote   optional — stateCateringCapReport(...) for this route. When a
 *             caterer can't deliver the chosen level, levels above its cap are
 *             marked and the route is told plainly what it will actually get.
 */
export default function CateringSelector({ value, onChange, distKm, compact = false, label = 'Catering service', capNote = null }) {
  const level = normalizeCateringLevel(value);
  const capIdx = capNote ? CATERING_LEVEL_ORDER.indexOf(capNote.cap) : Infinity;

  return (
    <div>
      {label && (
        <div className="form-label" style={{ marginBottom: 6 }}>{label}</div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {CATERING_LEVEL_ORDER.map(id => {
          const meta     = CATERING_LEVELS[id];
          const active   = id === level;
          const overCap  = CATERING_LEVEL_ORDER.indexOf(id) > capIdx;
          const qDelta   = distKm != null ? cateringQualityBonus(id, distKm) : null;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onChange?.(id)}
              title={overCap ? `${meta.desc} — your caterer here can only deliver ${CATERING_LEVELS[capNote.cap].name}.` : meta.desc}
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
                gap: 2, cursor: 'pointer',
                padding: compact ? '4px 9px' : '6px 11px',
                borderRadius: 'var(--radius)',
                border: `1px solid ${active ? meta.color : 'var(--border)'}`,
                background: active ? `color-mix(in srgb, ${meta.color} 16%, transparent)` : 'var(--surface3)',
                color: active ? meta.color : 'var(--text-muted)',
                fontWeight: active ? 700 : 500,
                fontSize: compact ? 11 : 12,
                transition: 'all 0.12s',
              }}
            >
              <span style={overCap ? { textDecoration: 'line-through', opacity: 0.7 } : undefined}>{compact ? meta.short : meta.name}</span>
              {qDelta != null && !compact && (
                <span style={{ fontSize: 10, fontWeight: 600, color: qDelta > 0 ? 'var(--green)' : qDelta < 0 ? 'var(--red)' : 'var(--text-dim)' }}>
                  quality {qDelta >= 0 ? '+' : ''}{qDelta}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {capNote && (
        <div style={{ fontSize: 11, color: 'var(--yellow)', marginTop: 6, lineHeight: 1.4 }}>
          ⚠ {capNote.suppliers.map(s => `${s.name} (${s.codes.join(', ')})`).join(' and ')} can't
          deliver {CATERING_LEVELS[capNote.chosen].name}. This route is served — and charged —
          as {CATERING_LEVELS[capNote.cap].name}. Change caterer on the Operations page.
        </div>
      )}
      {!compact && (
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6, lineHeight: 1.4 }}>
          {CATERING_LEVELS[level].desc}
        </div>
      )}
    </div>
  );
}
