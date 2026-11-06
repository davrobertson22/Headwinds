import TailFin from './TailFin.jsx';
import { LIVERY_PALETTE } from './LiveryEditor.jsx';
import { normalizeLivery } from '../data/livery.js';
import { getLiveryTemplate, DEFAULT_LIVERY_TEMPLATE } from '../data/liveryTemplates.js';

// The logo maker's Tail section: the airline's tail as the licensed template
// paints it (TailFin.jsx), with the choices that shape it — the tail colour,
// whether the logo sits on the fin, and whether it sits there bare or on its
// tile. The rest of the paint (fuselage, stripe, titles) is the Livery tab's.
// Controlled like LiveryEditor: onChange(nextLivery); the branding modal saves.
export default function TailPicker({ livery, logo, airlineName, onChange, onOpenLivery = null }) {
  const l = normalizeLivery(livery, livery?.tail);
  const set = (patch) => onChange(normalizeLivery({ ...l, ...patch }, l.tail));
  const tpl = getLiveryTemplate(DEFAULT_LIVERY_TEMPLATE);
  const toggle = (on) => ({
    padding: '4px 10px', borderRadius: 999, fontSize: 11.5, cursor: 'pointer',
    border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
    background: on ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : 'transparent',
    color: on ? 'var(--accent)' : 'var(--text-muted)',
  });
  return (
    <div className="tail-picker" style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <div style={{ padding: '10px 12px 6px', borderRadius: 10, background: 'var(--surface2, rgba(255,255,255,.04))' }}>
        <TailFin livery={l} logo={logo} height={120} title={`${airlineName || 'Your airline'} tail`} />
        <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4, textAlign: 'right' }}>{tpl.credit}</div>
      </div>
      <div style={{ flex: '1 1 260px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 6 }}>Tail colour</div>
          <div role="radiogroup" aria-label="Tail colour" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {LIVERY_PALETTE.map(c => (
              <button key={c.hex} type="button" role="radio" aria-checked={l.tail === c.hex} title={c.label}
                data-tail-colour={c.hex} onClick={() => set({ tail: c.hex })}
                style={{
                  width: 22, height: 22, borderRadius: '50%', background: c.hex, cursor: 'pointer', padding: 0,
                  border: l.tail === c.hex ? '2px solid var(--accent)' : '1px solid rgba(255,255,255,.25)',
                  boxShadow: l.tail === c.hex ? '0 0 0 2px var(--panel, #141922)' : 'none',
                }} />
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button type="button" style={toggle(l.logoOnTail)} aria-pressed={l.logoOnTail} data-tail-logo
            onClick={() => set({ logoOnTail: !l.logoOnTail })}>Logo on the fin</button>
          <button type="button" style={toggle(l.logoTile)} aria-pressed={l.logoTile} data-tail-tile disabled={!l.logoOnTail}
            title="Paint the logo on its square tile, the way it looks in the app, instead of as a bare mark"
            onClick={() => set({ logoTile: !l.logoTile })}>On its tile</button>
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>
          Shown at your hubs on the maps, on the season podium and on your profile.
          The rest of the paint is set{onOpenLivery ? <> <button type="button" onClick={onOpenLivery}
            style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent)', cursor: 'pointer', fontSize: 11.5 }}>on the Livery tab.</button></> : ' on the Livery tab.'}
        </div>
      </div>
    </div>
  );
}
