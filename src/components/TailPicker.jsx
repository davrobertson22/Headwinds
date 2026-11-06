import { useRef, useState } from 'react';
import TailFin, { LOGO_FREE_DESIGNS, tailTemplateSVG } from './TailFin.jsx';
import { LIVERY_PALETTE } from './LiveryEditor.jsx';
import { TAIL_DESIGNS, TAIL_DESIGN_LABELS, normalizeLivery } from '../data/livery.js';
import { fileToTailDataURL, TAIL_UPLOAD_HINT, TAIL_W, TAIL_H } from '../utils/logoImage.js';

// The logo maker's Tail section: the airline's tail logo (TailFin.jsx) with
// what shapes it — the design, the tail and accent colours, and whether the
// logo sits on the fin bare or on its tile — or an uploaded tail of their own
// (`tail`, a data URL; onTail(dataUrl | null)), drawn clipped to the fin in
// place of the design and logo. Controlled like LiveryEditor:
// onChange(nextLivery); the branding modal saves.
const TEMPLATE_HREF = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(tailTemplateSVG(TAIL_W, TAIL_H))}`;

export default function TailPicker({ livery, logo, tail = null, airlineName, onChange, onTail = null, onOpenLivery = null }) {
  const l = normalizeLivery(livery, livery?.tail);
  const fileRef = useRef(null);
  const [tailError, setTailError] = useState('');
  const usingUpload = typeof tail === 'string' && tail.length > 0;
  // The striped designs carry the tail on their own, with no logo.
  const logoFree = LOGO_FREE_DESIGNS.has(l.tailDesign);
  async function handleTailFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setTailError('');
    try {
      onTail?.(await fileToTailDataURL(file));
    } catch (err) {
      setTailError(err.message || 'Could not use that image.');
    }
  }
  const set = (patch) => onChange(normalizeLivery({ ...l, ...patch }, l.tail));
  const tileStyle = (on) => ({
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
    padding: '8px 10px 6px', borderRadius: 8, cursor: 'pointer', minWidth: 60,
    border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
    background: on ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : 'transparent',
    color: on ? 'var(--accent)' : 'var(--text-muted)', fontSize: 11,
  });
  const toggle = (on, disabled = false) => ({
    padding: '4px 10px', borderRadius: 999, fontSize: 11.5, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.45 : 1,
    border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
    background: on ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : 'transparent',
    color: on ? 'var(--accent)' : 'var(--text-muted)',
  });
  const swatches = (field, label) => (
    <div>
      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 6 }}>{label}</div>
      <div role="radiogroup" aria-label={label} style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {LIVERY_PALETTE.map(c => (
          <button key={c.hex} type="button" role="radio" aria-checked={l[field] === c.hex} title={c.label}
            data-tail-swatch={field} data-tail-colour={c.hex} onClick={() => set({ [field]: c.hex })}
            style={{
              width: 20, height: 20, borderRadius: '50%', background: c.hex, cursor: 'pointer', padding: 0,
              border: l[field] === c.hex ? '2px solid var(--accent)' : '1px solid rgba(255,255,255,.25)',
              boxShadow: l[field] === c.hex ? '0 0 0 2px var(--panel, #141922)' : 'none',
            }} />
        ))}
      </div>
    </div>
  );
  return (
    <div className="tail-picker" style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <div style={{ padding: 12, borderRadius: 10, background: 'var(--surface2, rgba(255,255,255,.04))' }}>
        <TailFin livery={l} logo={logo} tail={tail} height={110} title={`${airlineName || 'Your airline'} tail`} />
      </div>
      <div style={{ flex: '1 1 280px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div role="radiogroup" aria-label="Tail design" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {onTail && (
            <button type="button" role="radio" aria-checked={usingUpload} data-tail-design="upload"
              style={tileStyle(usingUpload)} onClick={() => fileRef.current?.click()}
              title={usingUpload ? 'Replace your uploaded tail' : 'Upload your own tail image'}>
              {usingUpload
                ? <TailFin livery={l} logo={logo} tail={tail} height={34} />
                : <div style={{ width: Math.round(34 * 1.291), height: 34, borderRadius: 6, border: '2px dashed var(--border)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, fontWeight: 300 }}>＋</div>}
              {usingUpload ? 'Your upload' : 'Upload'}
            </button>
          )}
          {TAIL_DESIGNS.map(d => (
            <button key={d} type="button" role="radio" aria-checked={!usingUpload && l.tailDesign === d}
              data-tail-design={d} style={tileStyle(!usingUpload && l.tailDesign === d)}
              onClick={() => { if (usingUpload) onTail?.(null); set({ tailDesign: d }); }}>
              <TailFin livery={{ ...l, tailDesign: d }} logo={logo} height={34} />
              {TAIL_DESIGN_LABELS[d]}
            </button>
          ))}
        </div>
        {onTail && <input ref={fileRef} type="file" accept="image/*" onChange={handleTailFile} data-tail-file style={{ display: 'none' }} />}
        {usingUpload ? (
          <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5 }}>
            Your image is cropped to the fin; clear areas show your tail colour.{' '}
            <button type="button" data-tail-remove onClick={() => onTail?.(null)}
              style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent)', cursor: 'pointer', fontSize: 11 }}>Remove it</button>
            {' '}to go back to a designed tail.
          </div>
        ) : onTail ? (
          <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5 }}>
            {TAIL_UPLOAD_HINT}{' '}
            <a href={TEMPLATE_HREF} download="tail-template.svg" data-tail-template style={{ color: 'var(--accent)' }}>Download the template</a>
          </div>
        ) : null}
        {tailError && <div style={{ fontSize: 12, color: 'var(--red)' }}>{tailError}</div>}
        {swatches('tail', 'Tail colour')}
        {!usingUpload && l.tailDesign !== 'solid' && swatches('cheatline', 'Design colour')}
        {!usingUpload && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <button type="button" style={toggle(l.logoOnTail, logoFree)} aria-pressed={l.logoOnTail} data-tail-logo disabled={logoFree}
            onClick={() => set({ logoOnTail: !l.logoOnTail })}>Logo on the fin</button>
          <button type="button" style={toggle(l.logoTile, !l.logoOnTail || logoFree)} aria-pressed={l.logoTile} data-tail-tile disabled={!l.logoOnTail || logoFree}
            title="Put the logo on its square tile, the way it looks in the app, instead of as a bare mark"
            onClick={() => set({ logoTile: !l.logoTile })}>On its tile</button>
          {logoFree && <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>the stripes carry this tail — no logo</span>}
        </div>}
        <div style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>
          Shown at your hubs on the maps, on the season podium and on your profile.
          The tail and design colours are your livery's{onOpenLivery ? <> — <button type="button" onClick={onOpenLivery}
            style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent)', cursor: 'pointer', fontSize: 11.5 }}>the rest of the paint is on the Livery tab.</button></> : '.'}
        </div>
      </div>
    </div>
  );
}
