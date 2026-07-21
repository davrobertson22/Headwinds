import { useState } from 'react';
import { useGame } from '../store/GameContext.jsx';
import AirportDetail from './AirportDetail.jsx';
import { AIRPORTS, getAirport, gateMonthlyFee, totalGateMonthlyFee, REGIONS, getRegion, getCountryName } from '../data/airports.js';
import { SLOTS_PER_GATE, cargoSlotsUsedAt } from '../utils/simulation.js';
import { formatMoney } from '../utils/simulation.js';
import { Glyph } from './Icons.jsx';

// Tier badge styling
function TierBadge({ tier }) {
  const cfg = {
    mega:     { bg: 'rgba(163,113,247,0.15)', color: '#a98bff', border: 'rgba(163,113,247,0.35)' },
    major:    { bg: 'rgba(56,139,253,0.15)',  color: '#3ea6ff', border: 'rgba(56,139,253,0.35)'  },
    regional: { bg: 'rgba(63,185,80,0.15)',   color: '#38d39f', border: 'rgba(63,185,80,0.35)'   },
  }[tier] ?? { bg: 'rgba(139,148,158,0.15)', color: '#93a4ba', border: 'rgba(139,148,158,0.35)' };
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3,
      background: cfg.bg, color: cfg.color,
      border: `1px solid ${cfg.border}`,
      textTransform: 'uppercase', letterSpacing: '0.06em',
    }}>
      {tier}
    </span>
  );
}

// ─── Your Gates table (default view) ─────────────────────────────────────────
//
// Dense, sortable table so a large network (30+ airports of gates) fits on one
// screen — mirrors the Routes page. The card view remains for phones.
const GATE_COLUMNS = [
  { id: 'airport', label: 'Airport', align: 'left'  },
  { id: 'region',  label: 'Region',  align: 'left'  },
  { id: 'gates',   label: 'Gates',   align: 'right' },
  { id: 'slots',   label: 'Slots',   align: 'right' },
  { id: 'util',    label: 'Use',     align: 'right' },
  { id: 'cost',    label: 'Cost/wk', align: 'right' },
];

const GATE_SORTERS = {
  airport: (a, b) => a.code.localeCompare(b.code),
  region:  (a, b) => REGIONS.indexOf(a.region) - REGIONS.indexOf(b.region) || a.code.localeCompare(b.code),
  gates:   (a, b) => a.count - b.count,
  slots:   (a, b) => a.used - b.used,
  util:    (a, b) => a.usagePct - b.usagePct,
  cost:    (a, b) => a.weeklyCost - b.weeklyCost,
};

function utilColor(usagePct) {
  return usagePct >= 0.9 ? 'var(--red)'
       : usagePct >= 0.7 ? 'var(--yellow)'
       : 'var(--green)';
}

function GateTable({ rows, onAdd, onRemove, onDetails }) {
  const [sortCol, setSortCol] = useState(null);   // null = default order (region → hub → congestion)
  const [sortDir, setSortDir] = useState('desc');

  const sorted = (() => {
    if (!sortCol) return rows;
    const s = [...rows].sort(GATE_SORTERS[sortCol] ?? GATE_SORTERS.airport);
    if (sortDir === 'desc') s.reverse();
    return s;
  })();

  function clickHeader(id) {
    if (sortCol === id) {
      setSortDir(d => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortCol(id);
      setSortDir(id === 'airport' || id === 'region' ? 'asc' : 'desc');
    }
  }

  const TH = {
    padding: '6px 10px', color: 'var(--text-muted)', fontWeight: 600, fontSize: 11,
    whiteSpace: 'nowrap', textTransform: 'uppercase', letterSpacing: '0.04em',
    borderBottom: '1px solid var(--border)', cursor: 'pointer', userSelect: 'none',
  };
  const TD = { padding: '6px 10px', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' };

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>
              {GATE_COLUMNS.map(c => (
                <th key={c.id} onClick={() => clickHeader(c.id)} style={{ ...TH, textAlign: c.align }}>
                  {c.label}{sortCol === c.id ? (sortDir === 'desc' ? ' ▾' : ' ▴') : ''}
                </th>
              ))}
              <th style={{ ...TH, cursor: 'default' }} />
            </tr>
          </thead>
          <tbody>
            {sorted.map(r => {
              const barColor = utilColor(r.usagePct);
              return (
                <tr key={r.code}>
                  <td style={{ ...TD, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 13 }}>{r.code}</span>
                    {r.isHub && <span title="Hub" style={{ color: 'var(--accent)', marginLeft: 4 }}>★</span>}
                    <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>{r.city}</span>
                    <span style={{ marginLeft: 6 }}><TierBadge tier={r.tier} /></span>
                  </td>
                  <td style={{ ...TD, color: 'var(--text-muted)' }}>{r.region}</td>
                  <td style={{ ...TD, textAlign: 'right', fontWeight: 600 }}>{r.count}</td>
                  <td style={{ ...TD, textAlign: 'right', color: barColor, fontWeight: 600 }}>
                    {r.used} / {r.capacity}
                  </td>
                  <td style={{ ...TD, textAlign: 'right' }}>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <div style={{ width: 50, height: 5, borderRadius: 3, background: 'var(--surface3)', overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${Math.min(100, r.usagePct * 100)}%`, background: barColor, borderRadius: 3 }} />
                      </div>
                      <span style={{ color: barColor, fontWeight: 600, minWidth: 34, textAlign: 'right', display: 'inline-block' }}>
                        {Math.round(r.usagePct * 100)}%
                      </span>
                    </div>
                  </td>
                  <td style={{ ...TD, textAlign: 'right', color: 'var(--red)' }}>{formatMoney(r.weeklyCost)}</td>
                  <td style={{ ...TD, textAlign: 'right' }}>
                    <div style={{ display: 'inline-flex', gap: 4 }}>
                      <button
                        className="btn btn-ghost"
                        style={{ padding: '2px 8px', fontSize: 11 }}
                        onClick={() => onDetails(r.code)}
                      >
                        Details
                      </button>
                      <button
                        className="btn"
                        style={{
                          padding: '2px 8px', fontSize: 12,
                          opacity: r.canRemove ? 1 : 0.35,
                          cursor: r.canRemove ? 'pointer' : 'not-allowed',
                          background: 'rgba(248,81,73,0.1)', color: 'var(--red)',
                          border: '1px solid rgba(248,81,73,0.3)',
                        }}
                        disabled={!r.canRemove}
                        title={r.canRemove ? 'Remove one gate' : 'Routes are using all slot capacity'}
                        onClick={() => onRemove(r.code)}
                      >
                        −
                      </button>
                      <button
                        className="btn btn-primary"
                        style={{ padding: '2px 8px', fontSize: 12 }}
                        onClick={() => onAdd(r.code)}
                      >
                        +
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function Airports() {
  const { state, dispatch } = useGame();
  const { gates = {}, routes, cargoRoutes = [], cash, hubs = {} } = state;
  const [search, setSearch]                       = useState('');
  const [regionFilter, setRegionFilter]           = useState(null); // null = show picker
  const [myGatesRegion, setMyGatesRegion]         = useState(null); // null = All
  const [selectedAirport, setSelectedAirport]     = useState(null);
  // 'table' scales to a big network (30+ airports of gates); phones default to
  // the card view, same convention as the Routes page.
  const [gatesView, setGatesView] = useState(() => {
    try { return window.matchMedia('(max-width: 640px)').matches ? 'cards' : 'table'; }
    catch { return 'table'; }
  });

  if (selectedAirport) {
    return <AirportDetail code={selectedAirport} onBack={() => setSelectedAirport(null)} />;
  }

  // Total departures / arrivals consuming slots at an airport
  function slotsUsedAt(code) {
    return routes
      .filter(r => r.origin === code || r.destination === code)
      .reduce((s, r) => s + r.weeklyFrequency, 0)
      + cargoSlotsUsedAt(code, cargoRoutes);
  }

  const myGateEntries = Object.entries(gates)
    .filter(([, count]) => count > 0)
    .map(([code, count]) => ({ code, count, airport: getAirport(code) }))
    .filter(({ airport }) => airport)
    .sort((a, b) => {
      // 1. Region
      const ra = REGIONS.indexOf(getRegion(a.airport.country));
      const rb = REGIONS.indexOf(getRegion(b.airport.country));
      if (ra !== rb) return ra - rb;
      // 2. Hub airports first
      const aIsHub = !!(hubs[a.code]);
      const bIsHub = !!(hubs[b.code]);
      if (aIsHub !== bIsHub) return aIsHub ? -1 : 1;
      // 3. Slot utilisation descending (most congested needs attention first)
      const aUtil = slotsUsedAt(a.code) / (a.count * SLOTS_PER_GATE || 1);
      const bUtil = slotsUsedAt(b.code) / (b.count * SLOTS_PER_GATE || 1);
      if (Math.abs(aUtil - bUtil) > 0.01) return bUtil - aUtil;
      // 4. Gate count descending
      if (a.count !== b.count) return b.count - a.count;
      // 5. Alphabetical
      return a.code.localeCompare(b.code);
    });

  const totalGates       = myGateEntries.reduce((s, { count }) => s + count, 0);
  const totalWeeklyFees  = myGateEntries.reduce((s, { airport, count }) =>
    s + Math.round(totalGateMonthlyFee(airport, count) / 4), 0);

  const TIER_ORDER = { mega: 0, major: 1, regional: 2 };

  // Build sorted, filtered list then group by country name
  const filteredAirports = AIRPORTS.filter(a => {
    if (regionFilter && getRegion(a.country) !== regionFilter) return false;
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return a.code.toLowerCase().includes(q) ||
           a.city.toLowerCase().includes(q) ||
           a.name.toLowerCase().includes(q) ||
           getCountryName(a.country).toLowerCase().includes(q);
  });

  // Group by country name, sort countries A-Z, airports within by tier then population
  const browseGroups = (() => {
    const groups = {};
    for (const a of filteredAirports) {
      const name = getCountryName(a.country);
      if (!groups[name]) groups[name] = { airports: [], region: getRegion(a.country) };
      groups[name].airports.push(a);
    }
    // Sort airports within each country: held first, then mega→major→regional, then pop desc
    for (const g of Object.values(groups)) {
      g.airports.sort((a, b) => {
        const aHeld = (gates[a.code] ?? 0) > 0;
        const bHeld = (gates[b.code] ?? 0) > 0;
        if (aHeld !== bHeld) return aHeld ? -1 : 1;
        const ta = TIER_ORDER[a.tier] ?? 99;
        const tb = TIER_ORDER[b.tier] ?? 99;
        if (ta !== tb) return ta - tb;
        return b.population - a.population;
      });
    }
    // Sort countries: if a region filter is active keep region-natural order, else A-Z
    return Object.entries(groups)
      .sort(([nameA, gA], [nameB, gB]) => {
        if (regionFilter) return nameA.localeCompare(nameB);
        const ra = REGIONS.indexOf(gA.region);
        const rb = REGIONS.indexOf(gB.region);
        if (ra !== rb) return ra - rb;
        return nameA.localeCompare(nameB);
      })
      .map(([name, g]) => ({ name, region: g.region, airports: g.airports }));
  })();

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            {myGateEntries.length} airport{myGateEntries.length !== 1 ? 's' : ''} · {totalGates} gate{totalGates !== 1 ? 's' : ''} total
          </div>
          {totalWeeklyFees > 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 3 }}>
              Gate fees: <span style={{ color: 'var(--red)' }}>{formatMoney(totalWeeklyFees)}/wk</span>
              {' · '}{formatMoney(totalWeeklyFees * 4)}/month
            </div>
          )}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'right' }}>
          Each gate: {SLOTS_PER_GATE} slots / wk<br />
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>1 slot = 1 departure / wk</span>
        </div>
      </div>

      {/* ── My gates ──────────────────────────────────────────────── */}
      {myGateEntries.length > 0 && (
        <section style={{ marginBottom: 28 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <div style={{
              fontSize: 11, fontWeight: 600, color: 'var(--text-muted)',
              textTransform: 'uppercase', letterSpacing: '0.07em',
            }}>
              Your Gates
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              {[{ id: 'table', label: '⊟ Table' }, { id: 'cards', label: '⊞ Cards' }].map(v => {
                const active = gatesView === v.id;
                return (
                  <button
                    key={v.id}
                    onClick={() => setGatesView(v.id)}
                    style={{
                      padding: '3px 10px', fontSize: 11, borderRadius: 20, cursor: 'pointer',
                      fontWeight: active ? 700 : 400,
                      background: active ? 'var(--accent)' : 'var(--surface2)',
                      color: active ? '#fff' : 'var(--text-muted)',
                      border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                      transition: 'all 0.15s',
                    }}
                  >
                    {v.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Table view: every region at once — dense rows scale to any network */}
          {gatesView === 'table' && (
            <GateTable
              rows={myGateEntries.map(({ code, count, airport }) => {
                const used     = slotsUsedAt(code);
                const capacity = count * SLOTS_PER_GATE;
                return {
                  code, count,
                  city:       airport.city,
                  tier:       airport.tier,
                  region:     getRegion(airport.country),
                  used, capacity,
                  usagePct:   capacity > 0 ? used / capacity : 0,
                  weeklyCost: Math.round(totalGateMonthlyFee(airport, count) / 4),
                  canRemove:  used <= (count - 1) * SLOTS_PER_GATE,
                  isHub:      !!hubs[code],
                };
              })}
              onAdd={code => dispatch({ type: 'ADD_GATE', airportCode: code })}
              onRemove={code => dispatch({ type: 'REMOVE_GATE', airportCode: code })}
              onDetails={code => setSelectedAirport(code)}
            />
          )}

          {/* Region filter tabs (card view) — gates are shown one region at a
              time so a large network never has to render every card at once. */}
          {gatesView === 'cards' && (() => {
            const heldRegions = [...new Set(myGateEntries.map(({ airport }) => getRegion(airport.country)))];
            if (heldRegions.length <= 1) return null;
            const activeRegion = myGatesRegion ?? heldRegions[0];
            return (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                {heldRegions.map(r => {
                  const active = activeRegion === r;
                  const regionCount = myGateEntries.filter(({ airport }) => getRegion(airport.country) === r).length;
                  return (
                    <button
                      key={r}
                      onClick={() => setMyGatesRegion(r)}
                      style={{
                        padding: '3px 10px', fontSize: 12, borderRadius: 20, cursor: 'pointer',
                        fontWeight: active ? 700 : 400,
                        background: active ? 'var(--accent)' : 'var(--surface2)',
                        color: active ? '#fff' : 'var(--text-muted)',
                        border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                        transition: 'all 0.15s',
                      }}
                    >
                      {r} ({regionCount})
                    </button>
                  );
                })}
              </div>
            );
          })()}

          {gatesView === 'cards' && (() => {
            const heldRegions  = [...new Set(myGateEntries.map(({ airport }) => getRegion(airport.country)))];
            // With multiple regions, only ever render the active one. A single
            // region renders directly (no filtering needed).
            const activeRegion = myGatesRegion ?? heldRegions[0];
            const visibleEntries = heldRegions.length > 1
              ? myGateEntries.filter(({ airport }) => getRegion(airport.country) === activeRegion)
              : myGateEntries;
            return visibleEntries.map(({ code, count, airport }) => {
            const used       = slotsUsedAt(code);
            const capacity   = count * SLOTS_PER_GATE;
            const usagePct   = capacity > 0 ? used / capacity : 0;
            const weeklyCost = Math.round(totalGateMonthlyFee(airport, count) / 4);
            const canRemove  = used <= (count - 1) * SLOTS_PER_GATE;
            const barColor   = usagePct >= 0.9 ? 'var(--red)'
                             : usagePct >= 0.7 ? 'var(--yellow)'
                             : 'var(--green)';

            return (
              <div key={code}>
                <div className="card" style={{ marginBottom: 8, padding: '12px 16px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    {/* Airport info */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                        <span style={{ fontWeight: 700, fontSize: 16 }}>{code}</span>
                        <span style={{ fontSize: 13, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {/* "San Francisco · San Francisco Intl" truncates redundantly on phones — skip the city when the airport name already starts with it. */}
                          {airport.name?.toLowerCase().startsWith((airport.city ?? '').toLowerCase()) ? airport.name : `${airport.city} · ${airport.name}`}
                        </span>
                        <TierBadge tier={airport.tier} />
                      </div>
                      {/* Slot utilisation bar */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 5 }}>
                        <div style={{
                          flex: 1, height: 6, borderRadius: 3,
                          background: 'var(--surface3)', overflow: 'hidden',
                        }}>
                          <div style={{
                            height: '100%', width: `${Math.min(100, usagePct * 100)}%`,
                            background: barColor, borderRadius: 3, transition: 'width 0.3s',
                          }} />
                        </div>
                        <span style={{ fontSize: 12, color: barColor, fontWeight: 600, minWidth: 90, textAlign: 'right' }}>
                          {used} / {capacity} slots
                        </span>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                        {count} gate{count > 1 ? 's' : ''} · {formatMoney(weeklyCost)}/wk ({formatMoney(weeklyCost * 4)}/mo)
                      </div>
                    </div>

                    {/* Add / remove / view buttons */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0 }}>
                      <button
                        className="btn btn-ghost"
                        style={{ padding: '4px 12px', fontSize: 12 }}
                        onClick={() => setSelectedAirport(code)}
                      >
                        Details →
                      </button>
                      <button
                        className="btn btn-primary"
                        style={{ padding: '4px 12px', fontSize: 12 }}
                        onClick={() => dispatch({ type: 'ADD_GATE', airportCode: code })}
                      >
                        + Gate
                      </button>
                      <button
                        className="btn"
                        style={{
                          padding: '4px 12px', fontSize: 12,
                          opacity: canRemove ? 1 : 0.35,
                          cursor: canRemove ? 'pointer' : 'not-allowed',
                          background: 'rgba(248,81,73,0.1)',
                          color: 'var(--red)',
                          border: '1px solid rgba(248,81,73,0.3)',
                        }}
                        disabled={!canRemove}
                        title={canRemove ? 'Remove one gate' : 'Routes are using all slot capacity'}
                        onClick={() => dispatch({ type: 'REMOVE_GATE', airportCode: code })}
                      >
                        − Gate
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            );
          });
          })()}

        </section>
      )}

      {/* ── Browse / add airports ─────────────────────────────────── */}
      <section>
        <div style={{
          fontSize: 11, fontWeight: 600, color: 'var(--text-muted)',
          textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10,
        }}>
          {myGateEntries.length > 0 ? 'Expand to More Airports' : 'Acquire Your First Gates'}
        </div>

        {/* Region picker — shown when no region is selected */}
        {regionFilter === null ? (
          <div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 14 }}>
              Select a region to browse airports:
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10 }}>
              {REGIONS.map(r => {
                const emoji = {
                  'North America': '🌎',
                  'South America': '🌎',
                  'Europe':        '🌍',
                  'Middle East':   '🌍',
                  'Africa':        '🌍',
                  'Asia':          '🌏',
                  'Oceania':       '🌏',
                }[r] ?? '🌐';
                const airportCount = AIRPORTS.filter(a => getRegion(a.country) === r).length;
                return (
                  <button
                    key={r}
                    onClick={() => setRegionFilter(r)}
                    style={{
                      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                      gap: 6, padding: '16px 12px', borderRadius: 'var(--radius)',
                      background: 'var(--surface2)', border: '1px solid var(--border)',
                      cursor: 'pointer', transition: 'all 0.15s',
                      color: 'var(--text)',
                    }}
                    onMouseEnter={e => {
                      e.currentTarget.style.background = 'var(--surface3)';
                      e.currentTarget.style.borderColor = 'var(--accent)';
                    }}
                    onMouseLeave={e => {
                      e.currentTarget.style.background = 'var(--surface2)';
                      e.currentTarget.style.borderColor = 'var(--border)';
                    }}
                  >
                    <span style={{ display: 'inline-flex', color: 'var(--accent)' }}><Glyph e={emoji} size={26} /></span>
                    <span style={{ fontWeight: 600, fontSize: 13 }}>{r}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{airportCount} airports</span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <>
            {/* Region filter tabs (with back/all option removed — just show active region + change link) */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10, alignItems: 'center' }}>
              <button
                onClick={() => setRegionFilter(null)}
                style={{
                  padding: '4px 10px', fontSize: 12, borderRadius: 20, cursor: 'pointer',
                  background: 'var(--surface2)', color: 'var(--text-muted)',
                  border: '1px solid var(--border)', transition: 'all 0.15s',
                }}
              >
                ← Regions
              </button>
              {REGIONS.map(r => {
                const active = regionFilter === r;
                return (
                  <button
                    key={r}
                    onClick={() => setRegionFilter(r)}
                    style={{
                      padding: '4px 10px', fontSize: 12, borderRadius: 20, cursor: 'pointer',
                      fontWeight: active ? 700 : 400,
                      background: active ? 'var(--accent)' : 'var(--surface2)',
                      color: active ? '#fff' : 'var(--text-muted)',
                      border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                      transition: 'all 0.15s',
                    }}
                  >
                    {r}
                  </button>
                );
              })}
            </div>

            <input
              className="form-input"
              placeholder="Search by code, city or country…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ marginBottom: 12, maxWidth: 320 }}
            />

            {browseGroups.length === 0 ? (
              <div style={{ padding: '20px 0', color: 'var(--text-muted)', fontSize: 13 }}>
                No airports match "{search}"
              </div>
            ) : browseGroups.map(({ name, airports: groupAirports }) => (
          <div key={name} style={{ marginBottom: 4 }}>
            {/* Country subheading */}
            <div style={{
              fontSize: 10, fontWeight: 700, letterSpacing: '.7px',
              textTransform: 'uppercase', color: 'var(--accent)',
              padding: '8px 0 4px',
              borderBottom: '1px solid var(--border)',
              marginBottom: 4,
              position: 'sticky', top: 0,
              background: 'var(--surface)',
              zIndex: 1,
            }}>
              {name}
            </div>

            {/* Airport rows */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {groupAirports.map(airport => {
                const count      = gates[airport.code] ?? 0;
                const weeklyCost = Math.round(gateMonthlyFee(airport, count + 1) / 4);
                const held       = count > 0;

                return (
                  <div
                    key={airport.code}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '7px 10px', borderRadius: 'var(--radius)',
                      background: held ? 'var(--surface2)' : 'var(--surface)',
                      border: `1px solid ${held ? 'var(--accent-dim)' : 'var(--border)'}`,
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 13, minWidth: 36 }}>
                          {airport.code}
                        </span>
                        <span style={{ fontSize: 13, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {airport.city}
                        </span>
                        <TierBadge tier={airport.tier} />
                        {held && (
                          <span style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600, whiteSpace: 'nowrap' }}>
                            <Glyph e="✓" /> {count} gate{count > 1 ? 's' : ''}
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2, paddingLeft: 42 }}>
                        {formatMoney(weeklyCost)}/wk · {SLOTS_PER_GATE} slots/gate
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexShrink: 0, marginLeft: 10 }}>
                      <button
                        className="btn btn-ghost"
                        style={{ padding: '3px 8px', fontSize: 11 }}
                        onClick={() => setSelectedAirport(airport.code)}
                      >
                        Details
                      </button>
                      <button
                        className="btn btn-primary"
                        style={{ padding: '3px 10px', fontSize: 12 }}
                        onClick={() => dispatch({ type: 'ADD_GATE', airportCode: airport.code })}
                      >
                        + Gate
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
            ))}
          </>
        )}
      </section>
    </div>
  );
}
