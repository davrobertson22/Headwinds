import TailFin from './TailFin.jsx';
import { FIN_SHAPES, FIN_SHAPE_LABELS, FIN_STYLES, FIN_STYLE_LABELS, normalizeLivery } from '../data/livery.js';

// The logo maker's tail-fin section: a live preview, one tile per fin shape and
// one per paint style, each a tiny live render in the airline's own colours.
// Controlled like LiveryEditor: onChange(nextLivery); the branding modal saves.
// The fin's colours are the livery's — this picks only shape and style.
export default function FinPicker({ livery, logo, onChange, onOpenLivery = null }) {
  const l = normalizeLivery(livery, livery?.tail);
  const set = (patch) => onChange(normalizeLivery({ ...l, ...patch }, l.tail));
  const tileStyle = (on) => ({
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
    padding: '8px 10px 6px', borderRadius: 8, cursor: 'pointer', minWidth: 62,
    border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
    background: on ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : 'transparent',
    color: on ? 'var(--accent)' : 'var(--text-muted)', fontSize: 11,
  });
  return (
    <div className="fin-picker" style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <div style={{ padding: 10, borderRadius: 10, background: 'var(--surface2, rgba(255,255,255,.04))' }}>
        <TailFin livery={l} logo={logo} size={96} title="Your tail fin" />
      </div>
      <div style={{ flex: '1 1 260px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div role="radiogroup" aria-label="Fin shape" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {FIN_SHAPES.map(shape => (
            <button key={shape} type="button" role="radio" aria-checked={l.finShape === shape}
              data-fin-shape={shape} style={tileStyle(l.finShape === shape)} onClick={() => set({ finShape: shape })}>
              <TailFin livery={{ ...l, finShape: shape }} logo={logo} size={34} />
              {FIN_SHAPE_LABELS[shape]}
            </button>
          ))}
        </div>
        <div role="radiogroup" aria-label="Fin paint" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {FIN_STYLES.map(st => (
            <button key={st} type="button" role="radio" aria-checked={l.finStyle === st}
              data-fin-style={st} style={tileStyle(l.finStyle === st)} onClick={() => set({ finStyle: st })}>
              <TailFin livery={{ ...l, finStyle: st }} logo={logo} size={34} />
              {FIN_STYLE_LABELS[st]}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>
          Shown at your hubs on the maps, on the season podium and on your profile.
          Colours come from your livery{onOpenLivery ? <> — <button type="button" onClick={onOpenLivery}
            style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent)', cursor: 'pointer', fontSize: 11.5 }}>change them on the Livery tab.</button></> : '.'}
        </div>
      </div>
    </div>
  );
}
