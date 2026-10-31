import { useState } from 'react';
import { useGame } from '../store/GameContext.jsx';
import { AIRLINE_LOGOS } from './AirlineLogo.jsx';
import LogoPicker, { AirlineCodeField } from './LogoPicker.jsx';
import { LOGO_COLORS, normalizeAirlineCode, cleanHex, brandingClash, takenBranding } from '../utils/logoBranding.js';
import { Glyph } from './Icons.jsx';
import { CloseIcon } from './Icons.jsx';
import LiveryEditor from './LiveryEditor.jsx';
import { liveryFor, isLiveryShaped } from '../data/livery.js';

// In-game branding editor: change the airline name, logo (preset or uploaded
// image) and accent colour without starting a new game — and, on the Livery
// tab, the paint scheme shown on the aircraft (LiveryEditor.jsx).
export default function BrandingModal({ onClose, initialTab = 'identity' }) {
  const { state, dispatch } = useGame();
  const [tab, setTab] = useState(initialTab === 'livery' ? 'livery' : 'identity');

  const [name,        setName]        = useState(state.airlineName ?? '');
  const [logoId,      setLogoId]      = useState(state.customLogo ? 'custom' : (state.logoId ?? AIRLINE_LOGOS[0].id));
  const [accentColor, setAccentColor] = useState(state.logoColor ?? LOGO_COLORS[0].hex);
  const [customLogo,  setCustomLogo]  = useState(state.customLogo ?? null);
  const [logoBg,      setLogoBg]      = useState(cleanHex(state.logoBg));
  const [airlineCode, setAirlineCode] = useState(state.airlineCode ?? '');
  // Livery: edits are local until Save. `liveryDirty` keeps a name-only rebrand
  // from freezing the default (logo-colour-derived) paint into the blob;
  // `livery: null` on save clears a saved scheme back to that default.
  const [livery,      setLivery]      = useState(() => liveryFor(state));
  const [liveryDirty, setLiveryDirty] = useState(false);
  const [liveryReset, setLiveryReset] = useState(false);
  const hasSavedLivery = isLiveryShaped(state.livery);

  const usingCustom = logoId === 'custom' && customLogo;
  const codeInvalid = airlineCode.trim() !== '' && !normalizeAirlineCode(airlineCode);
  // Multiplayer: another player's look or code can't be copied (the server
  // refuses it too — this just says so before Save). Solo rivals step aside.
  const takenAll = takenBranding(state);
  // A look you already fly (from before this rule) is yours to keep.
  const ownLook = (id, color, bg) => !state.customLogo && id === state.logoId
    && cleanHex(color) === cleanHex(state.logoColor) && cleanHex(bg) === cleanHex(state.logoBg);
  const taken = { ...takenAll, look: (id, color, bg) => (ownLook(id, color, bg) ? null : takenAll.look(id, color, bg)) };
  const clash = brandingClash(state, {
    logoId: usingCustom ? 'horizon' : logoId, logoColor: accentColor, logoBg: cleanHex(logoBg),
    customLogo: usingCustom ? customLogo : null, airlineCode: normalizeAirlineCode(airlineCode),
  });
  const canSave = name.trim().length > 0 && !codeInvalid && !clash;

  function handleSave() {
    if (!canSave) return;
    dispatch({
      type:        'SET_BRANDING',
      airlineName: name.trim(),
      logoId:      usingCustom ? 'horizon' : logoId,
      logoColor:   accentColor,
      customLogo:  usingCustom ? customLogo : null,
      logoBg:      cleanHex(logoBg),
      airlineCode: normalizeAirlineCode(airlineCode),
      ...(liveryReset ? { livery: null } : liveryDirty ? { livery } : {}),
    });
    onClose();
  }

  function changeLivery(next) { setLivery(next); setLiveryDirty(true); setLiveryReset(false); }
  function resetLivery() {
    setLivery(liveryFor({ ...state, livery: undefined, logoColor: accentColor }));
    setLiveryDirty(false); setLiveryReset(true);
  }

  return (
    <div className="saveload-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="saveload-modal" style={{ maxWidth: tab === 'livery' ? 640 : 560 }}>
        <div className="saveload-header">
          <h2 className="saveload-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <Glyph e="✎" size={18} /> Edit Branding
          </h2>
          <button className="saveload-close btn btn-ghost" onClick={onClose}><CloseIcon size={15} /></button>
        </div>
        <div className="branding-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'identity'} className={`branding-tab${tab === 'identity' ? ' on' : ''}`} onClick={() => setTab('identity')}>Name &amp; logo</button>
          <button type="button" role="tab" aria-selected={tab === 'livery'} className={`branding-tab${tab === 'livery' ? ' on' : ''}`} onClick={() => setTab('livery')}>Livery</button>
        </div>
        {tab === 'livery' ? (
          <LiveryEditor
            livery={livery}
            onChange={changeLivery}
            onReset={hasSavedLivery || liveryDirty ? resetLivery : null}
            isDefault={!hasSavedLivery && !liveryDirty}
            airlineName={name.trim() || 'Your airline'}
            logo={{ id: usingCustom ? null : logoId, accentColor, bgColor: cleanHex(logoBg), customSrc: usingCustom ? customLogo : null }}
          />
        ) : (<>
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

        <AirlineCodeField value={airlineCode} onChange={setAirlineCode} name={name}
          takenBy={airlineCode !== (state.airlineCode ?? '') ? taken.code(airlineCode) : null} />

        {/* ── Logo maker (shared with the new-game screen) ── */}
        <div className="form-group">
          <label className="form-label">Airline Logo</label>
          <LogoPicker
            name={name}
            airlineCode={airlineCode}
            logoId={logoId} onLogoId={setLogoId}
            accentColor={accentColor} onAccentColor={setAccentColor}
            logoBg={logoBg} onLogoBg={setLogoBg}
            customLogo={customLogo} onCustomLogo={setCustomLogo}
            maxHeight={280}
            taken={taken}
          />
        </div>
        </>)}

        {/* ── Actions ── */}
        <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
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
        {tab === 'livery' && (
          <div className="livery-foot">
            Your livery shows on the Fleet page, your airline profile, the planes on the globe, and to every rival.
            More aircraft templates arrive as players fund them (see the Fleet page).
          </div>
        )}
      </div>
    </div>
  );
}
