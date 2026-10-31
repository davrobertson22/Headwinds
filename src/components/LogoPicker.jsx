import { useRef, useState } from 'react';
import AirlineLogo, { AIRLINE_LOGOS } from './AirlineLogo.jsx';
import { Glyph } from './Icons.jsx';
import { fileToLogoDataURL, LOGO_UPLOAD_HINT } from '../utils/logoImage.js';
import {
  LOGO_COLORS, TILE_COLORS, cleanHex, lowContrastTile,
  normalizeAirlineCode, suggestAirlineCode,
} from '../utils/logoBranding.js';
import useIsMobile from '../hooks/useIsMobile.js';

// The logo maker, shared by the new-game screen (SetupScreen.jsx) and the
// in-game branding editor (BrandingModal.jsx) so the two can never drift:
// preset grid + upload tile, logo colour, tile colour, and a preview at the
// sizes the game actually shows. Controlled — the parent owns every value.
//
//   logoId      a preset id, or 'custom' while an upload is selected
//   customLogo  data URL of the upload (kept even when a preset is picked, so
//               switching back is one tap)
//   logoBg      tile colour: null = the default dark tile, else a hex
//   taken       optional takenBranding(state) (utils/logoBranding.js): in
//               multiplayer, looks other players already fly are marked

const swatchBase = {
  width: 28, height: 28, borderRadius: '50%', cursor: 'pointer', flexShrink: 0,
  transition: 'border .1s, outline .1s',
};
const swatchStyle = (bg, sel) => ({
  ...swatchBase,
  background: bg,
  border: sel ? '3px solid var(--text)' : '2px solid var(--border)',
  outline: sel ? '2px solid var(--accent)' : 'none', outlineOffset: 2,
});
const DEFAULT_TILE_SWATCH = 'linear-gradient(180deg, #2b3441, #151a22)';

function tileStyle(selected) {
  return {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
    padding: '10px 6px',
    background: selected ? 'var(--accent-dim)' : 'transparent',
    border: `2px solid ${selected ? 'var(--accent)' : 'transparent'}`,
    borderRadius: 10, cursor: 'pointer',
    transition: 'border-color .12s, background .12s',
  };
}

function tileLabel(selected) {
  return {
    fontSize: 10,
    color: selected ? 'var(--accent)' : 'var(--text-dim)',
    fontWeight: selected ? 600 : 400, letterSpacing: '.3px',
  };
}

const sub = { fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 };

export function colorLabel(hex) {
  const h = cleanHex(hex);
  return LOGO_COLORS.find(c => c.hex === h)?.label ?? 'Custom';
}

export default function LogoPicker({
  name = '', airlineCode = '',
  logoId, onLogoId,
  accentColor, onAccentColor,
  logoBg = null, onLogoBg,
  customLogo, onCustomLogo,
  maxHeight, taken = null,
}) {
  const isMobile = useIsMobile();
  const size = isMobile ? 44 : 52;
  const fileInputRef = useRef(null);
  const [logoError, setLogoError] = useState('');
  const usingCustom = logoId === 'custom' && !!customLogo;
  const tile = cleanHex(logoBg);
  const lowContrast = !usingCustom && lowContrastTile(accentColor, tile);
  const code = normalizeAirlineCode(airlineCode) ?? suggestAirlineCode(name);
  const takenBy = (id) => (taken?.any ? taken.look(id, accentColor, tile) : null);
  const selectedTakenBy = !usingCustom && logoId ? takenBy(logoId) : null;

  async function handleLogoFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';   // allow re-selecting the same file later
    if (!file) return;
    setLogoError('');
    try {
      const dataUrl = await fileToLogoDataURL(file);
      onCustomLogo(dataUrl);
      onLogoId('custom');
    } catch (err) {
      setLogoError(err.message || 'Could not use that image.');
    }
  }

  const previewLogo = { id: usingCustom ? null : logoId, customSrc: usingCustom ? customLogo : null, accentColor, bgColor: tile };
  const accentIsListed = LOGO_COLORS.some(c => c.hex === cleanHex(accentColor));
  const tileIsListed = TILE_COLORS.some(c => c.hex === tile);

  return (
    <div className="logo-picker">
      <div style={{
        display: 'grid',
        gridTemplateColumns: isMobile ? 'repeat(3, 1fr)' : 'repeat(4, 1fr)',
        gap: isMobile ? 8 : 10,
        padding: isMobile ? 10 : 14,
        background: 'var(--surface2)',
        borderRadius: 'var(--radius)',
        border: '1px solid var(--border)',
        ...(maxHeight ? { maxHeight, overflowY: 'auto' } : {}),
      }}>
        <button
          type="button"
          title="Upload your own logo"
          aria-pressed={usingCustom}
          onClick={() => fileInputRef.current?.click()}
          style={tileStyle(usingCustom)}
        >
          {customLogo ? (
            <AirlineLogo customSrc={customLogo} bgColor={tile} size={size} radius={10} />
          ) : (
            <div style={{
              width: size, height: size, borderRadius: 10,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: '2px dashed var(--border)',
              color: 'var(--text-dim)', fontSize: 22, fontWeight: 300,
            }}>
              <Glyph e="＋" />
            </div>
          )}
          <span style={tileLabel(usingCustom)}>{customLogo ? 'Custom' : 'Upload'}</span>
        </button>
        <input ref={fileInputRef} type="file" accept="image/*" onChange={handleLogoFile} style={{ display: 'none' }} />

        {AIRLINE_LOGOS.map(logo => {
          const selected = logoId === logo.id;
          const owner = takenBy(logo.id);
          return (
            <button
              key={logo.id}
              type="button"
              title={owner ? `${logo.name} — ${owner} already flies this in this colour` : logo.name}
              aria-pressed={selected}
              onClick={() => onLogoId(logo.id)}
              style={{ ...tileStyle(selected), ...(owner ? { opacity: 0.45 } : {}) }}
            >
              <AirlineLogo id={logo.id} size={size} accentColor={accentColor} bgColor={tile} />
              <span style={tileLabel(selected)}>{owner ? 'Taken' : logo.name}</span>
            </button>
          );
        })}
      </div>

      <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5 }}>
        {LOGO_UPLOAD_HINT} Transparent PNGs sit on your tile colour.
      </div>
      {logoError && <div style={{ marginTop: 8, fontSize: 12, color: 'var(--red)' }}>{logoError}</div>}
      {selectedTakenBy && (
        <div role="status" style={{ marginTop: 8, fontSize: 12, color: 'var(--red)' }}>
          {selectedTakenBy} already flies this logo in this colour on this tile. Pick another colour or tile.
        </div>
      )}
      {usingCustom && (
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
          Using your uploaded logo. Pick any preset above to switch back.
        </div>
      )}

      {/* ── Logo colour ── */}
      <div style={{ marginTop: 12, opacity: usingCustom ? 0.5 : 1 }}>
        <div style={sub}>
          Logo colour · <span style={{ color: 'var(--text)' }}>{colorLabel(accentColor)}</span>
          {usingCustom && <span style={{ fontStyle: 'italic' }}> (presets only)</span>}
        </div>
        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', alignItems: 'center' }}>
          {LOGO_COLORS.map(c => {
            const sel = cleanHex(accentColor) === c.hex;
            return (
              <button key={c.hex} type="button" title={c.label} aria-label={`Logo colour: ${c.label}`} aria-pressed={sel}
                onClick={() => onAccentColor(c.hex)} style={swatchStyle(c.hex, sel)} />
            );
          })}
          <input
            type="color"
            className="livery-custom"
            style={{ width: 28, height: 28, ...(accentIsListed ? {} : { outline: '2px solid var(--accent)', outlineOffset: 2 }) }}
            title="Any colour"
            aria-label="Logo colour: any colour"
            value={cleanHex(accentColor) ?? '#1e9bff'}
            onChange={e => onAccentColor(e.target.value)}
          />
        </div>
      </div>

      {/* ── Tile colour ── */}
      <div style={{ marginTop: 12 }}>
        <div style={sub}>
          Tile colour · <span style={{ color: 'var(--text)' }}>{TILE_COLORS.find(c => c.hex === tile)?.label ?? 'Custom'}</span>
        </div>
        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', alignItems: 'center' }}>
          {TILE_COLORS.map(c => {
            const sel = tile === c.hex;
            return (
              <button key={c.hex ?? 'default'} type="button" title={c.label} aria-label={`Tile colour: ${c.label}`} aria-pressed={sel}
                onClick={() => onLogoBg(c.hex)} style={swatchStyle(c.hex ?? DEFAULT_TILE_SWATCH, sel)} />
            );
          })}
          <input
            type="color"
            className="livery-custom"
            style={{ width: 28, height: 28, ...(tileIsListed ? {} : { outline: '2px solid var(--accent)', outlineOffset: 2 }) }}
            title="Any colour"
            aria-label="Tile colour: any colour"
            value={tile ?? '#202733'}
            onChange={e => onLogoBg(e.target.value)}
          />
        </div>
        {lowContrast && (
          <div role="status" style={{ marginTop: 8, fontSize: 11.5, color: 'var(--yellow)' }}>
            Your logo colour and tile colour are very close, so the mark will be hard to see.
          </div>
        )}
      </div>

      {/* ── Preview ── */}
      <div style={{
        marginTop: 12, padding: '10px 14px',
        background: 'var(--surface2)', borderRadius: 8,
        border: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 12,
      }}>
        <AirlineLogo {...previewLogo} size={38} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 14, display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            {code && <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', color: 'var(--accent)' }}>{code}</span>}
            <span>{name.trim() || 'Your airline'}</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {usingCustom
              ? 'Custom uploaded logo'
              : <>{AIRLINE_LOGOS.find(l => l.id === logoId)?.name} · {colorLabel(accentColor)} on {(TILE_COLORS.find(c => c.hex === tile)?.label ?? 'custom').replace(' (default)', '').toLowerCase()}</>}
          </div>
        </div>
        <div title="How it looks on the departure board" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-dim)' }}>
          <AirlineLogo {...previewLogo} size={18} radius={4} />
          {code && <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{code}&nbsp;123</span>}
        </div>
      </div>
    </div>
  );
}

/**
 * The two-character airline code, like QF or UA. Empty means "from my name"
 * (the placeholder shows what that gives). Prints on flight numbers.
 */
export function AirlineCodeField({ value, onChange, name = '', takenBy = null }) {
  const raw = String(value ?? '');
  const invalid = raw.trim() !== '' && !normalizeAirlineCode(raw);
  const owner = !invalid && takenBy ? takenBy : null;
  const suggestion = suggestAirlineCode(name);
  return (
    <div className="form-group">
      <label className="form-label" htmlFor="airline-code">Airline Code</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <input
          id="airline-code"
          className="form-input"
          type="text"
          inputMode="text"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          value={raw}
          placeholder={suggestion || 'QF'}
          onChange={e => onChange(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 2))}
          maxLength={2}
          aria-invalid={invalid || !!owner}
          style={{ width: 72, textAlign: 'center', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontWeight: 700, letterSpacing: 2 }}
        />
        <div style={{ fontSize: 11.5, color: invalid || owner ? 'var(--red)' : 'var(--text-dim)', lineHeight: 1.45 }}>
          {invalid
            ? 'Two characters: letters, or a letter and a digit (like QF or 9W).'
            : owner
            ? `${normalizeAirlineCode(raw)} is already ${owner}’s code. Please choose another.`
            : <>Two characters, like QF or UA — it starts your flight numbers on the departure board.{' '}
                {!raw.trim() && suggestion && <>Leave it blank to use <b>{suggestion}</b>.</>}</>}
        </div>
      </div>
    </div>
  );
}
