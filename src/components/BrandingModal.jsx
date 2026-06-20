import { useState, useRef } from 'react';
import { useGame } from '../store/GameContext.jsx';
import AirlineLogo, { AIRLINE_LOGOS } from './AirlineLogo.jsx';
import { ACCENT_COLORS } from './SetupScreen.jsx';
import { fileToLogoDataURL } from '../utils/logoImage.js';
import { Glyph } from './Icons.jsx';
import { CloseIcon } from './Icons.jsx';

// In-game branding editor: change the airline name, logo (preset or uploaded
// image) and accent colour without starting a new game.
export default function BrandingModal({ onClose }) {
  const { state, dispatch } = useGame();

  const [name,        setName]        = useState(state.airlineName ?? '');
  const [logoId,      setLogoId]      = useState(state.customLogo ? 'custom' : (state.logoId ?? AIRLINE_LOGOS[0].id));
  const [accentColor, setAccentColor] = useState(state.logoColor ?? ACCENT_COLORS[0].hex);
  const [customLogo,  setCustomLogo]  = useState(state.customLogo ?? null);
  const [logoError,   setLogoError]   = useState('');
  const fileInputRef = useRef(null);

  const usingCustom = logoId === 'custom' && customLogo;
  const canSave = name.trim().length > 0;

  async function handleLogoFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setLogoError('');
    try {
      const dataUrl = await fileToLogoDataURL(file);
      setCustomLogo(dataUrl);
      setLogoId('custom');
    } catch (err) {
      setLogoError(err.message || 'Could not use that image.');
    }
  }

  function handleSave() {
    if (!canSave) return;
    dispatch({
      type:        'SET_BRANDING',
      airlineName: name.trim(),
      logoId:      usingCustom ? 'horizon' : logoId,
      logoColor:   accentColor,
      customLogo:  usingCustom ? customLogo : null,
    });
    onClose();
  }

  return (
    <div className="saveload-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="saveload-modal" style={{ maxWidth: 560 }}>
        <div className="saveload-header">
          <h2 className="saveload-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <Glyph e="✎" size={18} /> Edit Branding
          </h2>
          <button className="saveload-close btn btn-ghost" onClick={onClose}><CloseIcon size={15} /></button>
        </div>
        <p className="saveload-hint">
          Update your airline's name and look. Changes apply immediately across the game.
        </p>

        {/* ── Name ── */}
        <div className="form-group">
          <label className="form-label">Airline Name</label>
          <input
            className="form-input"
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            maxLength={40}
          />
        </div>

        {/* ── Logo grid ── */}
        <div className="form-group">
          <label className="form-label">Airline Logo</label>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 10,
            padding: '14px',
            background: 'var(--surface2)',
            borderRadius: 'var(--radius)',
            border: '1px solid var(--border)',
            maxHeight: 280,
            overflowY: 'auto',
          }}>
            {/* Upload tile */}
            <button
              type="button"
              title="Upload your own logo"
              onClick={() => fileInputRef.current?.click()}
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
                padding: '10px 6px',
                background: usingCustom ? 'var(--accent-dim)' : 'transparent',
                border: `2px solid ${usingCustom ? 'var(--accent)' : 'transparent'}`,
                borderRadius: 10, cursor: 'pointer',
                transition: 'border-color .12s, background .12s',
              }}
            >
              {usingCustom ? (
                <AirlineLogo customSrc={customLogo} size={52} radius={10} />
              ) : (
                <div style={{
                  width: 52, height: 52, borderRadius: 10,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  border: '2px dashed var(--border)',
                  color: 'var(--text-dim)', fontSize: 22, fontWeight: 300,
                }}>
                  <Glyph e="＋" />
                </div>
              )}
              <span style={{
                fontSize: 10,
                color: usingCustom ? 'var(--accent)' : 'var(--text-dim)',
                fontWeight: usingCustom ? 600 : 400, letterSpacing: '.3px',
              }}>
                {usingCustom ? 'Custom' : 'Upload'}
              </span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleLogoFile}
              style={{ display: 'none' }}
            />

            {AIRLINE_LOGOS.map(logo => {
              const selected = logoId === logo.id;
              return (
                <button
                  key={logo.id}
                  type="button"
                  title={logo.name}
                  onClick={() => setLogoId(logo.id)}
                  style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
                    padding: '10px 6px',
                    background: selected ? 'var(--accent-dim)' : 'transparent',
                    border: `2px solid ${selected ? 'var(--accent)' : 'transparent'}`,
                    borderRadius: 10, cursor: 'pointer',
                    transition: 'border-color .12s, background .12s',
                  }}
                >
                  <AirlineLogo id={logo.id} size={52} accentColor={accentColor} />
                  <span style={{
                    fontSize: 10,
                    color: selected ? 'var(--accent)' : 'var(--text-dim)',
                    fontWeight: selected ? 600 : 400, letterSpacing: '.3px',
                  }}>
                    {logo.name}
                  </span>
                </button>
              );
            })}
          </div>

          {logoError && (
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--red)' }}>{logoError}</div>
          )}
          {usingCustom && (
            <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
              Using your uploaded logo. Pick any preset above to switch back.
            </div>
          )}

          {/* ── Colour picker ── */}
          <div style={{ marginTop: 10, opacity: usingCustom ? 0.5 : 1 }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
              Logo colour {usingCustom && <span style={{ fontStyle: 'italic' }}>(presets only)</span>}
            </div>
            <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
              {ACCENT_COLORS.map(c => {
                const sel = accentColor === c.hex;
                return (
                  <button
                    key={c.hex}
                    type="button"
                    title={c.label}
                    onClick={() => setAccentColor(c.hex)}
                    style={{
                      width: 28, height: 28, borderRadius: '50%', background: c.hex,
                      border: sel ? '3px solid var(--text)' : '2px solid var(--border)',
                      cursor: 'pointer',
                      outline: sel ? '2px solid var(--accent)' : 'none', outlineOffset: 2,
                      transition: 'border .1s, outline .1s', flexShrink: 0,
                    }}
                  />
                );
              })}
            </div>
          </div>

          {/* Preview */}
          <div style={{
            marginTop: 12, padding: '10px 14px',
            background: 'var(--surface2)', borderRadius: 8,
            border: '1px solid var(--border)',
            display: 'flex', alignItems: 'center', gap: 10,
          }}>
            <AirlineLogo
              id={logoId}
              customSrc={usingCustom ? customLogo : null}
              size={38}
              accentColor={accentColor}
            />
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{name.trim() || 'Your airline'}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {usingCustom
                  ? 'Custom uploaded logo'
                  : <>{AIRLINE_LOGOS.find(l => l.id === logoId)?.name} livery ·{' '}
                      {ACCENT_COLORS.find(c => c.hex === accentColor)?.label ?? 'Custom'} accent</>}
              </div>
            </div>
          </div>
        </div>

        {/* ── Actions ── */}
        <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
          <button type="button" className="btn btn-ghost" style={{ flex: '0 0 auto', padding: '10px 18px' }} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            style={{ flex: 1, padding: 10, fontWeight: 700, opacity: canSave ? 1 : 0.5, cursor: canSave ? 'pointer' : 'not-allowed' }}
            disabled={!canSave}
            onClick={handleSave}
          >
            Save Changes
          </button>
        </div>
      </div>
    </div>
  );
}
