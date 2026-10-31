import { useState } from 'react';
import { useGame } from '../store/GameContext.jsx';
import { AIRPORTS, getCountryName } from '../data/airports.js';
import { AIRLINE_LOGOS } from './AirlineLogo.jsx';
import LogoPicker, { AirlineCodeField } from './LogoPicker.jsx';
import { LOGO_COLORS, normalizeAirlineCode, cleanHex } from '../utils/logoBranding.js';
import { Glyph } from './Icons.jsx';
import useIsMobile from '../hooks/useIsMobile.js';

// ── Accent colour palette ────────────────────────────────────────────────────
// Lives in utils/logoBranding.js now (shared with the rival displays);
// re-exported under its old name for the components that import it from here.
export const ACCENT_COLORS = LOGO_COLORS;

// Country names come from the single source of truth in airports.js
// (data/airports.js → COUNTRY_NAMES / getCountryName), so this screen never
// drifts out of sync when new countries are added.
const countryName = getCountryName;

// Returns [{countryName, airports[]}] sorted A-Z by country name
function groupedByCountry(filter = '') {
  const q = filter.trim().toLowerCase();
  const groups = {};
  for (const a of AIRPORTS) {
    const name = countryName(a.country);
    const matches = !q
      || a.code.toLowerCase().includes(q)
      || a.city.toLowerCase().includes(q)
      || a.name.toLowerCase().includes(q)
      || name.toLowerCase().includes(q);
    if (!matches) continue;
    if (!groups[name]) groups[name] = [];
    groups[name].push(a);
  }
  return Object.entries(groups)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, airports]) => ({
      name,
      airports: [...airports].sort((a, b) => a.city.localeCompare(b.city)),
    }));
}

export default function SetupScreen() {
  const { dispatch } = useGame();
  const [airlineName,       setAirlineName]       = useState('');
  const [hub,               setHub]               = useState('JFK');
  const [hubSearch,         setHubSearch]         = useState('');
  const [logoId,            setLogoId]            = useState(AIRLINE_LOGOS[0].id);
  const [accentColor,       setAccentColor]       = useState(ACCENT_COLORS[0].hex);
  const [customLogo,        setCustomLogo]        = useState(null);   // data URL or null
  const [logoBg,            setLogoBg]            = useState(null);   // tile colour; null = default dark
  const [airlineCode,       setAirlineCode]       = useState('');     // '' = derived from the name
  const [enableObjectives,  setEnableObjectives]  = useState(true);
  const [step,              setStep]              = useState(1);
  const isMobile = useIsMobile();

  const usingCustom = logoId === 'custom' && customLogo;

  const STEPS = ['Brand', 'Home hub', 'Launch'];
  const codeInvalid = airlineCode.trim() !== '' && !normalizeAirlineCode(airlineCode);
  const canContinue = step !== 1 || (airlineName.trim().length > 0 && !codeInvalid);

  function handleStart(e) {
    e.preventDefault();
    if (!airlineName.trim()) { setStep(1); return; }
    dispatch({
      type:             'START_GAME',
      airlineName:      airlineName.trim(),
      hub,
      // If a custom upload is selected, keep a real preset id as a fallback
      // and pass the image separately; otherwise use the chosen preset.
      logoId:           usingCustom ? 'horizon' : logoId,
      logoColor:        accentColor,
      customLogo:       usingCustom ? customLogo : null,
      logoBg:           cleanHex(logoBg),
      airlineCode:      normalizeAirlineCode(airlineCode),
      enableObjectives,
    });
  }

  const hubAirport    = AIRPORTS.find(a => a.code === hub);
  const countryGroups = groupedByCountry(hubSearch);

  return (
    <div className="setup-screen">
      <div className="setup-card" style={{ maxWidth: 600 }}>
        <div className="setup-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <img
            src="/tailwinds-mark-color.png"
            alt="Tailwinds"
            width={Math.round(28 * 1.27)}
            height={28}
            style={{ flexShrink: 0, display: 'block', objectFit: 'contain' }}
          />
          Tailwinds - Airline Manager
        </div>
        <div className="setup-subtitle">
          Build the world's greatest airline from scratch.
          You're starting with $15,000,000 in equity to get started — use it wisely.
        </div>

        {/* ── Step indicator ── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 22px' }}>
          {STEPS.map((label, i) => {
            const n = i + 1;
            const active = step === n;
            const done = step > n;
            return (
              <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8, flex: i < STEPS.length - 1 ? 1 : 'none' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <div style={{
                    width: 24, height: 24, borderRadius: '50%', flexShrink: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 12, fontWeight: 700,
                    background: active || done ? 'var(--accent)' : 'var(--surface3)',
                    color: active || done ? '#fff' : 'var(--text-dim)',
                    transition: 'background .15s',
                  }}>
                    {done ? <Glyph e="✓" size={14} /> : n}
                  </div>
                  <span style={{
                    fontSize: 12, fontWeight: active ? 700 : 500,
                    color: active ? 'var(--text)' : 'var(--text-dim)',
                    whiteSpace: 'nowrap',
                  }}>{label}</span>
                </div>
                {i < STEPS.length - 1 && (
                  <div style={{ flex: 1, height: 2, background: step > n ? 'var(--accent)' : 'var(--border)', borderRadius: 2 }} />
                )}
              </div>
            );
          })}
        </div>

        <form onSubmit={handleStart}>

          {/* ════ STEP 1 — Brand your airline ════ */}
          <div style={{ display: step === 1 ? 'block' : 'none' }}>

          {/* ── Airline name ── */}
          <div className="form-group">
            <label className="form-label">Airline Name</label>
            <input
              className="form-input"
              type="text"
              placeholder="e.g. Pacific Airways"
              value={airlineName}
              onChange={e => setAirlineName(e.target.value)}
              maxLength={40}
              required
            />
          </div>

          {/* ── Airline code ── */}
          <AirlineCodeField value={airlineCode} onChange={setAirlineCode} name={airlineName} />

          {/* ── Logo maker (shared with Edit Branding) ── */}
          <div className="form-group">
            <label className="form-label">Airline Logo</label>
            <LogoPicker
              name={airlineName}
              airlineCode={airlineCode}
              logoId={logoId} onLogoId={setLogoId}
              accentColor={accentColor} onAccentColor={setAccentColor}
              logoBg={logoBg} onLogoBg={setLogoBg}
              customLogo={customLogo} onCustomLogo={setCustomLogo}
            />
          </div>

          </div>{/* ════ END STEP 1 ════ */}

          {/* ════ STEP 2 — Home hub ════ */}
          <div style={{ display: step === 2 ? 'block' : 'none' }}>

          {/* ── Hub airport ── */}
          <div className="form-group">
            <label className="form-label">Home Hub Airport</label>

            {/* Search box */}
            <input
              className="form-input"
              type="text"
              placeholder="Search by city, airport or country…"
              value={hubSearch}
              onChange={e => setHubSearch(e.target.value)}
              style={{ marginBottom: 6 }}
            />

            {/* Scrollable airport list */}
            <div style={{
              maxHeight: 280,
              overflowY: 'auto',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              background: 'var(--surface2)',
            }}>
              {countryGroups.length === 0 ? (
                <div style={{ padding: '20px 14px', color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>
                  No airports match "{hubSearch}"
                </div>
              ) : countryGroups.map(({ name, airports }) => (
                <div key={name}>
                  {/* Country subheading */}
                  <div style={{
                    padding: '6px 12px',
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: '.8px',
                    textTransform: 'uppercase',
                    color: 'var(--accent)',
                    background: 'var(--surface3)',
                    borderBottom: '1px solid var(--border)',
                    position: 'sticky',
                    top: 0,
                    zIndex: 1,
                  }}>
                    {name}
                  </div>

                  {/* Airports in this country */}
                  {airports.map(a => {
                    const selected = a.code === hub;
                    return (
                      <button
                        key={a.code}
                        type="button"
                        onClick={() => setHub(a.code)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          width: '100%',
                          padding: '7px 12px',
                          background: selected ? 'var(--accent-dim)' : 'transparent',
                          border: 'none',
                          borderBottom: '1px solid var(--border)',
                          cursor: 'pointer',
                          textAlign: 'left',
                          color: 'var(--text)',
                          transition: 'background .1s',
                        }}
                      >
                        <span style={{
                          fontFamily: 'monospace',
                          fontWeight: 700,
                          fontSize: 13,
                          color: selected ? 'var(--accent)' : 'var(--text-dim)',
                          minWidth: 36,
                        }}>
                          {a.code}
                        </span>
                        <span style={{ fontSize: 13, flex: 1 }}>
                          {a.city}
                          <span style={{ color: 'var(--text-muted)', fontSize: 11, marginLeft: 6 }}>
                            {a.name}
                          </span>
                        </span>
                        <span style={{
                          fontSize: 10,
                          color: 'var(--text-muted)',
                          textTransform: 'uppercase',
                          letterSpacing: '.4px',
                        }}>
                          {a.tier}
                        </span>
                        {selected && (
                          <span style={{ color: 'var(--accent)', fontSize: 14, marginLeft: 4 }}><Glyph e="✓" /></span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>

            {/* Selected airport summary */}
            {hubAirport && (
              <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-muted)' }}>
                {hubAirport.name} · {hubAirport.population}M metro area · {hubAirport.tier} hub
                <span style={{ marginLeft: 8, color: 'var(--accent)', fontWeight: 600 }}>
                  <Glyph e="🏠" /> Home country: {countryName(hubAirport.country)}
                </span>
              </div>
            )}
          </div>

          </div>{/* ════ END STEP 2 ════ */}

          {/* ════ STEP 3 — Options & launch ════ */}
          <div style={{ display: step === 3 ? 'block' : 'none' }}>

          {/* ── Board Objectives toggle ── */}
          <div className="form-group">
            <label className="form-label">Game Options</label>
            <button
              type="button"
              onClick={() => setEnableObjectives(v => !v)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                width: '100%',
                padding: '12px 14px',
                background: 'var(--surface2)',
                border: `1px solid ${enableObjectives ? 'var(--accent)' : 'var(--border)'}`,
                borderRadius: 'var(--radius)',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              {/* Toggle pill */}
              <div style={{
                width: 36,
                height: 20,
                borderRadius: 10,
                background: enableObjectives ? 'var(--accent)' : 'var(--surface3)',
                position: 'relative',
                flexShrink: 0,
                transition: 'background 0.2s',
              }}>
                <div style={{
                  position: 'absolute',
                  top: 2,
                  left: enableObjectives ? 18 : 2,
                  width: 16,
                  height: 16,
                  borderRadius: '50%',
                  background: '#fff',
                  transition: 'left 0.2s',
                }} />
              </div>
              <div>
                <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)' }}>
                  <Glyph e="🏅" /> Board Objectives
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                  {enableObjectives
                    ? 'Earn cash rewards by hitting strategic milestones and financial targets'
                    : 'Sandbox mode, no objectives, play freely'}
                </div>
              </div>
            </button>
          </div>

          {/* ── How to play ── */}
          <div style={{
            padding: 14,
            background: 'var(--surface2)',
            borderRadius: 'var(--radius)',
            fontSize: 12,
            color: 'var(--text-muted)',
            marginBottom: 24,
          }}>
            <strong style={{ color: 'var(--text)' }}>How to play:</strong> Lease aircraft from the
            Market, open routes between airports, then advance week-by-week to collect revenue.
            Don't let your cash hit zero! Your hub airport determines your <strong style={{ color: 'var(--text)' }}>home country</strong> — you can only build hubs within that country.
          </div>

          </div>{/* ════ END STEP 3 ════ */}

          {/* ── Step navigation ── */}
          <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
            {step > 1 && (
              <button
                type="button"
                className="btn btn-ghost"
                style={{ flex: '0 0 auto', padding: '12px 18px', fontSize: 14, fontWeight: 600 }}
                onClick={() => setStep(s => s - 1)}
              >
                ← Back
              </button>
            )}
            {step < 3 ? (
              <button
                type="button"
                className="btn btn-primary"
                style={{ flex: 1, padding: 12, fontSize: 15, fontWeight: 700, opacity: canContinue ? 1 : 0.5, cursor: canContinue ? 'pointer' : 'not-allowed' }}
                disabled={!canContinue}
                onClick={() => { if (canContinue) setStep(s => s + 1); }}
              >
                Continue →
              </button>
            ) : (
              <button
                type="submit"
                className="btn btn-primary"
                style={{ flex: 1, padding: 12, fontSize: 15, fontWeight: 700 }}
              >
                Launch Airline →
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
