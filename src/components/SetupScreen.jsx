import { useState, useRef } from 'react';
import { useGame } from '../store/GameContext.jsx';
import { AIRPORTS, getCountryName } from '../data/airports.js';
import AirlineLogo, { AIRLINE_LOGOS } from './AirlineLogo.jsx';
import { Glyph } from './Icons.jsx';
import { fileToLogoDataURL } from '../utils/logoImage.js';

// ── Accent colour palette ────────────────────────────────────────────────────
// Ordered as a continuous rainbow spectrum (red → violet), then a neutral set.
export const ACCENT_COLORS = [
  { hex: '#ff3b3b', label: 'Crimson'    },
  { hex: '#ff6b35', label: 'Coral'      },
  { hex: '#ff8c00', label: 'Orange'     },
  { hex: '#ffa200', label: 'Amber'      },
  { hex: '#ffd000', label: 'Gold'       },
  { hex: '#ffe600', label: 'Sun'        },
  { hex: '#c6e600', label: 'Lime'       },
  { hex: '#5fd23a', label: 'Green'      },
  { hex: '#1fbf6b', label: 'Emerald'    },
  { hex: '#00c9a7', label: 'Teal'       },
  { hex: '#00bcd4', label: 'Cyan'       },
  { hex: '#1e9bff', label: 'Sky'        },
  { hex: '#3b6bff', label: 'Blue'       },
  { hex: '#6b4bff', label: 'Indigo'     },
  { hex: '#9b4dff', label: 'Violet'     },
  { hex: '#c44dff', label: 'Purple'     },
  { hex: '#ff4dd2', label: 'Magenta'    },
  { hex: '#ff6fae', label: 'Pink'       },
  { hex: '#d0a8ff', label: 'Lavender'   },
  { hex: '#ffffff', label: 'White'      },
  { hex: '#c0cad8', label: 'Silver'     },
];

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
  const [logoError,         setLogoError]         = useState('');
  const [enableObjectives,  setEnableObjectives]  = useState(true);
  const [step,              setStep]              = useState(1);
  const fileInputRef = useRef(null);

  const usingCustom = logoId === 'custom' && customLogo;

  async function handleLogoFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';   // allow re-selecting the same file later
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

  const STEPS = ['Brand', 'Home hub', 'Launch'];
  const canContinue = step !== 1 || airlineName.trim().length > 0;

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
          You're starting with $10,000,000 in equity to get started — use it wisely.
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

          {/* ── Logo picker ── */}
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
            }}>
              {/* Upload-your-own tile */}
              <button
                type="button"
                title="Upload your own logo"
                onClick={() => fileInputRef.current?.click()}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 6,
                  padding: '10px 6px',
                  background: usingCustom ? 'var(--accent-dim)' : 'transparent',
                  border: `2px solid ${usingCustom ? 'var(--accent)' : 'transparent'}`,
                  borderRadius: 10,
                  cursor: 'pointer',
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
                  fontWeight: usingCustom ? 600 : 400,
                  letterSpacing: '.3px',
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
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: 6,
                      padding: '10px 6px',
                      background: selected ? 'var(--accent-dim)' : 'transparent',
                      border: `2px solid ${selected ? 'var(--accent)' : 'transparent'}`,
                      borderRadius: 10,
                      cursor: 'pointer',
                      transition: 'border-color .12s, background .12s',
                    }}
                  >
                    <AirlineLogo id={logo.id} size={52} accentColor={accentColor} />
                    <span style={{
                      fontSize: 10,
                      color: selected ? 'var(--accent)' : 'var(--text-dim)',
                      fontWeight: selected ? 600 : 400,
                      letterSpacing: '.3px',
                    }}>
                      {logo.name}
                    </span>
                  </button>
                );
              })}
            </div>

            {logoError && (
              <div style={{ marginTop: 8, fontSize: 12, color: 'var(--red)' }}>
                {logoError}
              </div>
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
                        width: 28,
                        height: 28,
                        borderRadius: '50%',
                        background: c.hex,
                        border: sel
                          ? '3px solid var(--text)'
                          : '2px solid var(--border)',
                        cursor: 'pointer',
                        outline: sel ? '2px solid var(--accent)' : 'none',
                        outlineOffset: 2,
                        transition: 'border .1s, outline .1s',
                        flexShrink: 0,
                      }}
                    />
                  );
                })}
              </div>
            </div>

            {/* Preview */}
            {airlineName.trim() && (
              <div style={{
                marginTop: 12,
                padding: '10px 14px',
                background: 'var(--surface2)',
                borderRadius: 8,
                border: '1px solid var(--border)',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
              }}>
                <AirlineLogo
                  id={logoId}
                  customSrc={usingCustom ? customLogo : null}
                  size={38}
                  accentColor={accentColor}
                />
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{airlineName}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {usingCustom
                      ? 'Custom uploaded logo'
                      : <>{AIRLINE_LOGOS.find(l => l.id === logoId)?.name} livery ·{' '}
                          {ACCENT_COLORS.find(c => c.hex === accentColor)?.label ?? 'Custom'} accent</>}
                  </div>
                </div>
              </div>
            )}
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
                    : 'Sandbox mode — no objectives, play freely'}
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
