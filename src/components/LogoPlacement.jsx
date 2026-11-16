import {
  LOGO_SHAPES, LOGO_SHAPE_LABELS, TAIL_LOGO_OFFSET_MAX, TAIL_LOGO_SCALE_MIN, TAIL_LOGO_SCALE_MAX,
  effectiveLogoShape, tailLogoMoved, normalizeLivery,
} from '../data/livery.js';

// The logo's shape on the livery and where it sits on the fin — shared by the
// Livery tab (LiveryEditor.jsx) and the logo maker's Tail section
// (TailPicker.jsx), so both edit the same livery fields the same way.
//
//   livery     the livery being edited
//   onChange   (patch) => void — merged into the livery by the parent
//   showShape  offer the outline (only means something for a tile or an
//              uploaded image; a bare preset mark has no edge to shape)
//   showPlace  offer the fin position and size
//
// Discord (VodkaOnFire, 2026-11-14): a round shape, and X / Y / size on the
// tail so only part of a big logo shows.

const pct = (v) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`;

export default function LogoPlacement({ livery, onChange, showShape = true, showPlace = true }) {
  const l = normalizeLivery(livery, livery?.tail);
  const shape = effectiveLogoShape(l, l.logoTile);
  if (!showShape && !showPlace) return null;
  const chip = (on) => ({
    padding: '4px 10px', borderRadius: 999, fontSize: 11.5, cursor: 'pointer',
    border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
    background: on ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : 'transparent',
    color: on ? 'var(--accent)' : 'var(--text-muted)',
    display: 'inline-flex', alignItems: 'center', gap: 6,
  });
  const icon = (s) => (
    <span aria-hidden="true" style={{
      width: 10, height: 10, display: 'inline-block', background: 'currentColor',
      borderRadius: s === 'circle' ? '50%' : s === 'rounded' ? 3 : 0,
    }} />
  );
  const slider = (field, label, min, max, fmt) => (
    <label style={{ display: 'grid', gridTemplateColumns: '78px 1fr 46px', alignItems: 'center', gap: 8, fontSize: 11.5, color: 'var(--text-muted)' }}>
      <span>{label}</span>
      <input type="range" min={min} max={max} step={0.05} value={l[field]} data-logo-place={field}
        aria-label={`Fin logo ${label.toLowerCase()}`}
        onChange={e => onChange({ [field]: Number(e.target.value) })} style={{ width: '100%' }} />
      <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(l[field])}</span>
    </label>
  );
  return (
    <div className="logo-placement" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {showShape && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 11.5, color: 'var(--text-muted)', minWidth: 78 }}>Logo shape</span>
          <div role="radiogroup" aria-label="Logo shape" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {LOGO_SHAPES.map(s => (
              <button key={s} type="button" role="radio" aria-checked={shape === s} data-logo-shape={s}
                style={chip(shape === s)} onClick={() => onChange({ logoShape: s })}>
                {icon(s)}{LOGO_SHAPE_LABELS[s]}
              </button>
            ))}
          </div>
        </div>
      )}
      {showPlace && (<>
        {slider('tailLogoX', 'Back / front', -TAIL_LOGO_OFFSET_MAX, TAIL_LOGO_OFFSET_MAX, pct)}
        {slider('tailLogoY', 'Down / up', -TAIL_LOGO_OFFSET_MAX, TAIL_LOGO_OFFSET_MAX, pct)}
        {slider('tailLogoScale', 'Size', TAIL_LOGO_SCALE_MIN, TAIL_LOGO_SCALE_MAX, v => `×${v.toFixed(2)}`)}
        <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5 }}>
          Moves the logo on the tail, here and on the aircraft. Whatever runs off the fin is cut off, so a big logo can show just part of itself.
          {tailLogoMoved(l) && <>{' '}<button type="button" data-logo-place-reset
            onClick={() => onChange({ tailLogoX: 0, tailLogoY: 0, tailLogoScale: 1 })}
            style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent)', cursor: 'pointer', fontSize: 11 }}>Centre it again</button></>}
        </div>
      </>)}
    </div>
  );
}
