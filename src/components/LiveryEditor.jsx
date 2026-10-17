import { useMemo } from 'react';
import LiveryPlane from './LiveryPlane.jsx';
import { ACCENT_COLORS } from './SetupScreen.jsx';
import { LIVERY_STYLES, LIVERY_STYLE_LABELS, LIVERY_WHITE, LIVERY_INK, normalizeLivery, normalizeHex } from '../data/livery.js';
import { getLiveryTemplate, DEFAULT_LIVERY_TEMPLATE } from '../data/liveryTemplates.js';

// The Livery tab of the branding editor: a live preview on the licensed
// template, one tile per style (each a tiny live render in the current
// colours), a swatch row per paintable part, and the logo / titles toggles.
// Controlled: every change calls onChange(nextLivery) and the parent decides
// when to dispatch SET_BRANDING.

export const LIVERY_PALETTE = [
  { hex: LIVERY_WHITE, label: 'White' },
  { hex: '#c9cfd8',    label: 'Silver' },
  { hex: LIVERY_INK,   label: 'Charcoal' },
  ...ACCENT_COLORS,
];

const FIELDS = [
  ['fuselage',  'Fuselage'],
  ['tail',      'Tail & winglets'],
  ['engines',   'Engines'],
  ['cheatline', 'Stripe / sweep'],
  ['titles',    'Titles'],
];

function randomLivery(current) {
  const pick = () => LIVERY_PALETTE[3 + Math.floor(Math.random() * (LIVERY_PALETTE.length - 3))].hex;
  const dark = Math.random() < 0.2;
  const fuselage = dark ? LIVERY_INK : (Math.random() < 0.8 ? LIVERY_WHITE : pick());
  return normalizeLivery({
    ...current,
    fuselage,
    tail: pick(),
    cheatline: pick(),
    engines: Math.random() < 0.5 ? fuselage : pick(),
    titles: dark || fuselage !== LIVERY_WHITE ? LIVERY_WHITE : LIVERY_INK,
    style: LIVERY_STYLES[Math.floor(Math.random() * LIVERY_STYLES.length)],
  });
}

export default function LiveryEditor({ livery, onChange, onReset, airlineName, logo, isDefault = false }) {
  const l = useMemo(() => normalizeLivery(livery, livery?.tail), [livery]);
  const tpl = getLiveryTemplate(DEFAULT_LIVERY_TEMPLATE);
  const set = (patch) => onChange(normalizeLivery({ ...l, ...patch }, l.tail));

  return (
    <div className="livery-editor">
      <div className="livery-preview">
        <LiveryPlane livery={l} titles={airlineName} logo={logo} templateId={tpl.id} width={520} style={{ width: '100%', height: 'auto' }} />
        <div className="livery-preview-cap">
          <span>Your livery on a {tpl.name}{isDefault ? ' · default colours from your logo' : ''}</span>
          <span className="livery-credit">{tpl.credit}</span>
        </div>
      </div>

      <div className="livery-section">
        <div className="livery-section-head">
          <span>Style</span>
          <button type="button" className="livery-link" onClick={() => onChange(randomLivery(l))}>Surprise me</button>
        </div>
        <div className="livery-styles" role="radiogroup" aria-label="Livery style">
          {LIVERY_STYLES.map(s => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={l.style === s}
              className={`livery-style${l.style === s ? ' on' : ''}`}
              onClick={() => set({ style: s })}
              title={LIVERY_STYLE_LABELS[s]}
            >
              <LiveryPlane livery={{ ...l, style: s, titlesOn: false, logoOnTail: false }} templateId={tpl.id} width={88} style={{ width: '100%', height: 'auto' }} />
              <span>{LIVERY_STYLE_LABELS[s]}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="livery-section">
        <div className="livery-section-head"><span>Colours</span></div>
        <div className="livery-rows">
          {FIELDS.map(([key, label]) => (
            <div key={key} className="livery-row">
              <label>{label}</label>
              <div className="livery-swatches">
                {LIVERY_PALETTE.map(c => (
                  <button
                    key={c.hex}
                    type="button"
                    title={c.label}
                    aria-label={`${label}: ${c.label}`}
                    aria-pressed={l[key] === c.hex}
                    className={`livery-swatch${l[key] === c.hex ? ' on' : ''}`}
                    style={{ background: c.hex }}
                    onClick={() => set({ [key]: c.hex })}
                  />
                ))}
                <input
                  type="color"
                  className="livery-custom"
                  title={`${label}: custom colour`}
                  aria-label={`${label}: custom colour`}
                  value={normalizeHex(l[key]) ?? LIVERY_WHITE}
                  onChange={e => set({ [key]: e.target.value })}
                />
              </div>
            </div>
          ))}
        </div>
        <div className="livery-opts">
          <label><input type="checkbox" checked={l.logoOnTail} onChange={e => set({ logoOnTail: e.target.checked })} /> Logo on the tail</label>
          <label><input type="checkbox" checked={l.titlesOn} onChange={e => set({ titlesOn: e.target.checked })} /> Airline name on the fuselage</label>
          {onReset && !isDefault && (
            <button type="button" className="livery-link" onClick={onReset}>Reset to default</button>
          )}
        </div>
      </div>
    </div>
  );
}
