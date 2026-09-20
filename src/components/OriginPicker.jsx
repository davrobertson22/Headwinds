import { useMemo, useState } from 'react';
import { AIRPORTS, getAirport } from '../data/airports.js';
import { networkAirports, rankByNetwork } from '../utils/airportGroups.js';
import { rememberAirport } from '../utils/airportRecents.js';
import useRecentAirports from '../hooks/useRecentAirports.js';
import { useGame } from '../store/GameContext.jsx';
import FuelBasisChip from './FuelBasisChip.jsx';

/**
 * The compact search-and-pick airport control on the two Route Finders.
 *
 * It used to open on `AIRPORTS.slice(0, 8)` — literally the first eight rows of
 * the data file, the same eight for every player in every world, none of which
 * had anything to do with the airline doing the searching. The only way past
 * them was to know what you wanted and type it:
 *
 *   "Would it be possible to chose which airports come up first? I am mostly
 *    flying Asian routes but I have to go all the way down to select them."
 *    (Barca, Discord 2026-09-10)
 *
 * Now it opens on the player's own network — last picked, then hubs, then focus
 * cities, then wherever else they hold gates, biggest first — and every row says
 * why it is there. Search still reaches the whole world; it just floats your own
 * airports to the top of the matches, so typing "LON" does not bury the Heathrow
 * gates you actually hold under three fields you have never flown to.
 *
 * Passenger and freight shared this markup by copy-paste before, down to the
 * dropdown shadow. One component, one accent prop, no drift.
 */

const EMPTY = {};
const WHY_LABEL = { recent: 'recent', hub: 'hub', focus: 'focus city' };

function whyTag(row) {
  if (WHY_LABEL[row.why]) return WHY_LABEL[row.why];
  if (row.why === 'gates' && row.gates > 0) return `${row.gates} gate${row.gates === 1 ? '' : 's'}`;
  return null;
}

/** Why a SEARCH hit matters to this airline — same vocabulary as the row list. */
function whyMatch(a, { gates, hubs, recent }) {
  if (recent.includes(a.code)) return whyTag({ why: 'recent' });
  const tier = hubs[a.code] ? (hubs[a.code].tier ?? 0) : null;
  if (tier != null) return whyTag({ why: tier >= 1 ? 'hub' : 'focus' });
  return whyTag({ why: 'gates', gates: gates[a.code] ?? 0 });
}

function Row({ airport, tag, onPick }) {
  return (
    <div
      onClick={onPick}
      style={{ padding: '7px 10px', cursor: 'pointer', display: 'flex', gap: 8, alignItems: 'center' }}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--surface3)'}
      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
    >
      <span style={{ fontWeight: 700, fontSize: 13, width: 34, flexShrink: 0 }}>{airport.code}</span>
      <span style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{airport.city}</span>
      <FuelBasisChip code={airport.code} compact />
      {tag && (
        <span style={{ marginLeft: 'auto', flexShrink: 0, fontSize: 10, color: 'var(--text-dim)' }}>{tag}</span>
      )}
    </div>
  );
}

function Heading({ children }) {
  return (
    <div style={{
      padding: '5px 10px', fontSize: 10, fontWeight: 600, letterSpacing: '0.07em',
      textTransform: 'uppercase', color: 'var(--text-dim)', background: 'var(--surface)',
      borderBottom: '1px solid var(--border-subtle)',
    }}>
      {children}
    </div>
  );
}

/**
 * @param {string}   value        selected airport code
 * @param {function} onChange     (code) => void — fired with the new code
 * @param {string}   [accent]     border/highlight colour while open
 * @param {string}   [label]      form label above the control
 * @param {number}   [limit]      how many rows to offer with an empty query
 */
export default function OriginPicker({
  value, onChange, accent = 'var(--accent)', label = 'From', limit = 8,
}) {
  const { state } = useGame();
  const recent = useRecentAirports();
  const [open, setOpen]   = useState(false);
  const [query, setQuery] = useState('');

  const gates = state.gates ?? EMPTY;
  const hubs  = state.hubs ?? EMPTY;
  const selected = getAirport(value);

  // Your network, for an empty box. `fallback` tops it up for a brand new
  // airline that holds nothing yet — an empty dropdown is worse than an
  // arbitrary one.
  const network = useMemo(
    () => networkAirports({ gates, hubs, recent, limit, fallback: true }),
    [gates, hubs, recent, limit],
  );
  const hasNetwork = network.some(r => r.why != null);

  const matches = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (!q) return [];
    const hits = AIRPORTS.filter(a =>
      a.code.includes(q) || a.city.toUpperCase().includes(q) || a.name.toUpperCase().includes(q));
    return rankByNetwork(hits, { gates, hubs, recent }).slice(0, limit);
  }, [query, gates, hubs, recent, limit]);

  function pick(code) {
    rememberAirport(code);
    setQuery('');
    setOpen(false);
    onChange(code);
  }

  return (
    <div style={{ position: 'relative', minWidth: 180 }}>
      <div className="form-label" style={{ marginBottom: 6 }}>{label}</div>
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 8, background: 'var(--surface2)',
          border: `1px solid ${open ? accent : 'var(--border)'}`,
          borderRadius: 'var(--radius)', padding: '7px 10px', cursor: 'pointer',
        }}
        onClick={() => setOpen(v => !v)}
      >
        {selected ? (
          <>
            <span style={{ fontWeight: 700, fontSize: 15 }}>{selected.code}</span>
            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{selected.city}</span>
          </>
        ) : (
          <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>Select airport…</span>
        )}
        <span style={{ marginLeft: 'auto', color: 'var(--text-dim)', fontSize: 11 }}>▾</span>
      </div>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 100,
          background: 'var(--surface2)', border: `1px solid ${accent}`,
          borderRadius: 'var(--radius)', boxShadow: 'var(--shadow)', overflow: 'hidden',
        }}>
          <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>
            <input
              autoFocus
              className="form-input"
              placeholder="Search any airport — city or code…"
              value={query}
              onChange={e => setQuery(e.target.value)}
              style={{ width: '100%' }}
            />
          </div>
          <div style={{ maxHeight: 220, overflowY: 'auto' }}>
            {query ? (
              <>
                {matches.map(a => (
                  <Row key={a.code} airport={a} onPick={() => pick(a.code)}
                       tag={whyMatch(a, { gates, hubs, recent })} />
                ))}
                {matches.length === 0 && (
                  <div style={{ padding: 12, color: 'var(--text-dim)', fontSize: 12, textAlign: 'center' }}>No airports found</div>
                )}
              </>
            ) : (
              <>
                {hasNetwork && <Heading>Your network</Heading>}
                {network.map((r, i) => (
                  <div key={r.airport.code}>
                    {/* The filler below your own airports is a different kind of
                        row and says so, rather than pretending to be network. */}
                    {hasNetwork && r.why === null && network[i - 1]?.why != null && <Heading>Elsewhere</Heading>}
                    <Row airport={r.airport} tag={whyTag(r)} onPick={() => pick(r.airport.code)} />
                  </div>
                ))}
                <div style={{ padding: '7px 10px', fontSize: 11, color: 'var(--text-dim)', borderTop: '1px solid var(--border-subtle)' }}>
                  Type to search all {AIRPORTS.length.toLocaleString()} airports.
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
