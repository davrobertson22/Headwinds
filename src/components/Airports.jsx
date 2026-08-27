import { useState } from 'react';
import { useGame, gateLeaseDenial, slotsUsedAt as slotsUsedAtEngine } from '../store/GameContext.jsx';
import AirportDetail from './AirportDetail.jsx';
import {
  AIRPORTS, getAirport, gateMonthlyFee, totalGateMonthlyFee, REGIONS, getRegion, getCountryName,
  gateCapacityOf, gateAirlineCapOf, GATE_HUB_GUARANTEE, GATE_SURCHARGE_MULT, GATE_BID_MAX_QTY,
  GATE_IDLE_FORFEIT_WEEKS, GATE_IDLE_WARN_WEEKS,
} from '../data/airports.js';
import { SLOTS_PER_GATE, cargoSlotsUsedAt } from '../utils/simulation.js';
import { GateDenialNote, DisabledHint, lockoutWeeksLeft, idleWeeksAt, idleWarningFor } from './GateDenial.jsx';
import { formatMoney } from '../utils/simulation.js';
import { Glyph } from './Icons.jsx';

// ─── Gate scarcity helpers (Headwinds worlds with the option on) ─────────────
// state.gateMarket is the server-injected live view (capacity, taken, holdings,
// open auction + your sealed bid, listings). Airports without an entry are
// untouched — capacity derives locally, taken = 0.

function marketFor(state, code) {
  return state.gateMarket?.airports?.[code] ?? null;
}

function capacityInfo(state, code) {
  const m = marketFor(state, code);
  const capacity = m?.capacity ?? gateCapacityOf(getAirport(code));
  const taken = m?.taken ?? 0;
  return { capacity, taken, m, full: taken >= capacity, surcharge: m?.surcharge === true };
}

const TIER_RANK = { mega: 0, major: 1, regional: 2 };

// ── Global airport lookup ─────────────────────────────────────────────────────
//
// Every airport in the world, ranked for a jump-to box: an exact IATA code wins,
// then a code prefix, then city/name, then country. Ties break towards airports
// you already hold and then towards the bigger airport, so "LON" lands on
// Heathrow rather than an alphabetical accident.
//
// Exported (and pure) so the ranking can be tested without a renderer.
//
// @param {string} query
// @param {object} [opts]
// @param {object} [opts.gates] your gate holdings, { [code]: count }
// @param {number} [opts.limit] max results (default 10)
// @param {Array}  [opts.airports] airport list to search (default: all of them)
export function searchAirports(query, { gates = {}, limit = 10, airports = AIRPORTS } = {}) {
  const q = String(query ?? '').trim().toLowerCase();
  if (q.length < 2) return [];
  const scored = [];
  for (const a of airports) {
    const code    = a.code.toLowerCase();
    const city    = a.city.toLowerCase();
    const name    = (a.name ?? '').toLowerCase();
    const country = getCountryName(a.country).toLowerCase();
    let rank = null;
    if (code === q)                          rank = 0;
    else if (code.startsWith(q))             rank = 1;
    else if (city.startsWith(q))             rank = 2;
    else if (city.includes(q) || name.includes(q)) rank = 3;
    else if (country.includes(q))            rank = 4;
    if (rank === null) continue;
    scored.push({ a, rank });
  }
  scored.sort((x, y) => {
    if (x.rank !== y.rank) return x.rank - y.rank;
    const xHeld = (gates[x.a.code] ?? 0) > 0, yHeld = (gates[y.a.code] ?? 0) > 0;
    if (xHeld !== yHeld) return xHeld ? -1 : 1;
    const tx = TIER_RANK[x.a.tier] ?? 99, ty = TIER_RANK[y.a.tier] ?? 99;
    if (tx !== ty) return tx - ty;
    return (y.a.population ?? 0) - (x.a.population ?? 0);
  });
  return scored.slice(0, limit).map(({ a }) => a);
}

// Small colored chip used across the scarcity UI.
function ScarcityChip({ color, bg, border, title, children }) {
  return (
    <span title={title} style={{
      fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3,
      background: bg, color, border: `1px solid ${border}`,
      textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap',
    }}>
      {children}
    </span>
  );
}

function AvailabilityChips({ state, code }) {
  if (!state.gateScarcityWorld) return null;
  const { capacity, taken, m, full, surcharge } = capacityInfo(state, code);
  const nearly = !full && taken >= 0.9 * capacity;
  // The rule-5 lockout was the ONE denial with no visual footprint at all —
  // no chip, no count, nothing. It is the likeliest reason a player who holds
  // no gates at an airport still cannot lease one.
  const locked = lockoutWeeksLeft(state, code);
  const idle   = idleWeeksAt(state, code);
  return (
    <>
      <span style={{ fontSize: 11, color: full ? 'var(--red)' : nearly ? 'var(--yellow)' : 'var(--text-dim)', whiteSpace: 'nowrap' }}>
        {taken}/{capacity} taken
      </span>
      {full && <ScarcityChip color="var(--red)" bg="rgba(248,81,73,0.12)" border="rgba(248,81,73,0.35)" title="Every gate is taken — win one at auction or buy one from another airline">FULL</ScarcityChip>}
      {surcharge && <ScarcityChip color="var(--yellow)" bg="rgba(210,153,34,0.12)" border="rgba(210,153,34,0.4)" title={`Congestion surcharge: this airport is over 90% full — all gate fees here cost ${Math.round((GATE_SURCHARGE_MULT - 1) * 100)}% extra`}>+{Math.round((GATE_SURCHARGE_MULT - 1) * 100)}% fees</ScarcityChip>}
      {m?.auction && <ScarcityChip color="var(--accent)" bg="rgba(56,201,180,0.12)" border="rgba(56,201,180,0.4)" title="A gate auction is open — place a sealed bid in the Gate Market below">🔨 Auction</ScarcityChip>}
      {locked > 0 && (
        <ScarcityChip
          color="var(--red)" bg="rgba(248,81,73,0.12)" border="rgba(248,81,73,0.35)"
          title={`Your gates here were forfeited after ${GATE_IDLE_FORFEIT_WEEKS} weeks with no service. You can lease at ${code} again in ${locked} week${locked === 1 ? '' : 's'}.`}
        >
          🔒 Locked · {locked} wk
        </ScarcityChip>
      )}
      {idle >= GATE_IDLE_WARN_WEEKS && locked === 0 && (
        <ScarcityChip
          color="var(--yellow)" bg="rgba(210,153,34,0.12)" border="rgba(210,153,34,0.4)"
          title={idleWarningFor(state, code) ?? ''}
        >
          ⚠️ Idle {idle}/{GATE_IDLE_FORFEIT_WEEKS} wk
        </ScarcityChip>
      )}
    </>
  );
}

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
                    <GateDenialNote reason={r.addDenial} compact />
                    {r.idleWarning && (
                      <div style={{
                        fontSize: 10, lineHeight: 1.35, color: 'var(--yellow)',
                        marginTop: 3, maxWidth: 420, whiteSpace: 'normal',
                      }}>
                        ⚠️ {r.idleWarning}
                      </div>
                    )}
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
                      <DisabledHint title={r.addDenial}>
                        <button
                          className="btn btn-primary"
                          style={{
                            padding: '2px 8px', fontSize: 12,
                            opacity: r.addDenial ? 0.35 : 1,
                            cursor: r.addDenial ? 'not-allowed' : 'pointer',
                          }}
                          disabled={!!r.addDenial}
                          title={r.addDenial ? undefined : 'Lease one more gate'}
                          onClick={() => onAdd(r.code)}
                        >
                          +
                        </button>
                      </DisabledHint>
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

// Why a sealed bid did or didn't turn into gates. Mirrors the reasons the
// server records on GateAuction.outcomes at resolution.
const AUCTION_OUTCOME = {
  WON:               'won',
  OUTBID:            'outbid — the gates went to higher bids',
  BELOW_RESERVE:     'below the reserve price, so it never qualified',
  INSUFFICIENT_CASH: 'won on price but voided — bids are not escrowed, and the cash has to be there when the auction resolves',
  OWNERSHIP_CAP:     'voided by the single-airline ownership cap',
  ALLIANCE_CAP:      'voided by the alliance ownership cap',
  LOCKED_OUT:        'voided — you were locked out of this airport',
  AIRLINE_INACTIVE:  'voided — your airline was not active at resolution',
  NO_LEDGER_ROW:     'voided — the airport had no gate ledger to award from',
  WRITE_CONFLICT:    'voided — your airline changed mid-award; nothing was charged',
  NOT_RECORDED:      'did not win (this auction predates per-bid result tracking)',
};

// ─── Gate Market (scarcity worlds): sealed auction bids + player listings ────
// ── Alliance slot pool (scarcity worlds, alliance members) ───────────────────
// The owner's per-airport switch ("share my spare slots") plus the live picture
// of who is drawing on whom. Data comes from the server-injected pool view
// (state.gateMarket.slotPool, refreshed instantly after a toggle; falls back to
// the tick-injected state.allianceSlotPool). Everything here is usage, never
// holdings — the ownership caps are untouched by sharing.
function SlotPoolSection({ state, remoteApi }) {
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [reserveDrafts, setReserveDrafts] = useState({}); // code → string

  if (!state.gateScarcityWorld || !remoteApi?.setGateSlotShare) return null;
  if (!state.allianceMembership) return null; // pool is an alliance benefit

  const pool = state.gateMarket?.slotPool ?? state.allianceSlotPool ?? {};
  const myGateCodes = Object.entries(state.gates ?? {})
    .filter(([, count]) => count > 0)
    .map(([code]) => code)
    .sort();
  if (myGateCodes.length === 0 && Object.keys(pool).length === 0) return null;

  // Slots my own schedule uses at an airport (pax + cargo) — same arithmetic
  // the engine's slot checks use, so "spare" here matches what can be shared.
  // That means slotsUsedAtEngine: a rotation stopping here occupies two
  // movements a cycle, and offering them to the pool would be offering slots
  // this airline is itself using.
  const usedAt = (code) =>
    slotsUsedAtEngine(state.routes ?? [], code)
    + slotsUsedAtEngine(state.cargoRoutes ?? [], code);

  const run = (fn) => {
    setBusy(true); setErr(null);
    fn().catch((e) => setErr(e?.message ?? String(e))).finally(() => setBusy(false));
  };
  const INPUT = {
    width: 70, padding: '3px 8px', fontSize: 12, borderRadius: 4,
    background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)',
  };

  const rows = myGateCodes.map((code) => {
    const count = state.gates[code];
    const p = pool[code] ?? null;
    const capacity = count * 50; // SLOTS_PER_GATE
    const used = usedAt(code);
    return { code, count, capacity, used, spare: Math.max(0, capacity - used), p };
  });
  const borrowedRows = Object.entries(pool)
    .filter(([, p]) => (p?.draw ?? 0) > 0 || (p?.grant ?? 0) > (p?.draw ?? 0))
    .sort(([a], [b]) => a.localeCompare(b));
  const weeklyEarnings = rows.reduce((s, r) => s + (r.p?.weeklyEarnings ?? 0), 0);
  const weeklyCost = Object.values(pool).reduce((s, p) => s + (p?.weeklyCost ?? 0), 0);

  return (
    <section id="slot-pool" style={{ marginBottom: 28 }}>
      <div style={{
        fontSize: 11, fontWeight: 600, color: 'var(--text-muted)',
        textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8,
      }}>
        ⚖ Alliance Slot Pool
      </div>
      <div className="card" style={{ padding: '12px 16px' }}>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8, lineHeight: 1.5 }}>
          Share the spare weekly slots on your gates with your alliance — partners can fly on
          them, paying you the slot's gate fee&nbsp;+25%, even at airports where they hold no
          gates at all (up to a gate's worth of slots there). Gates feeding the pool count as
          in use, so they can't be forfeited. If you grow back into shared slots, partners get
          a 4-week warning before their flights are cut.
          {(weeklyEarnings > 0 || weeklyCost > 0) && (
            <strong style={{ color: 'var(--text)' }}>
              {' '}This week: {weeklyEarnings > 0 ? `earning ${formatMoney(weeklyEarnings)}` : ''}
              {weeklyEarnings > 0 && weeklyCost > 0 ? ' · ' : ''}
              {weeklyCost > 0 ? `paying ${formatMoney(weeklyCost)} for borrowed slots` : ''}.
            </strong>
          )}
        </div>
        {err && <div style={{ fontSize: 12, color: 'var(--red)', marginBottom: 8 }}>{err}</div>}

        {rows.map(({ code, count, capacity, used, spare, p }) => {
          const sharing = p?.sharing === true;
          const reserved = p?.reserved ?? 0;
          const draft = reserveDrafts[code] ?? String(reserved);
          return (
            <div key={code} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
              <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 13, minWidth: 36 }}>{code}</span>
              <span style={{ fontSize: 12, color: 'var(--text-muted)', flex: 1, minWidth: 180 }}>
                {count} gate{count === 1 ? '' : 's'} · {used}/{capacity} slots used · {spare} spare
                {sharing && (p?.lentOut ?? 0) > 0 && (
                  <span style={{ color: 'var(--accent)' }}>
                    {' '}· {p.lentOut} lent{p.weeklyEarnings > 0 ? ` (+${formatMoney(p.weeklyEarnings)}/wk)` : ''}
                    {(p.borrowers ?? []).length > 0 && ` to ${p.borrowers.map((x) => x.name).join(', ')}`}
                  </span>
                )}
              </span>
              <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 5 }}>
                Keep back
                <input
                  style={INPUT} type="number" min="0" step="10" value={draft} disabled={busy}
                  onChange={(e) => setReserveDrafts((d) => ({ ...d, [code]: e.target.value }))}
                  onBlur={() => {
                    const v = Math.max(0, Math.round(Number(draft) || 0));
                    if (sharing && v !== reserved) {
                      run(() => remoteApi.setGateSlotShare(code, { sharing: true, reservedSlots: v }));
                    }
                  }}
                />
                slots
              </label>
              <button
                className={sharing ? 'btn' : 'btn btn-primary'}
                style={{ fontSize: 12, padding: '4px 12px' }}
                disabled={busy}
                onClick={() => run(() => remoteApi.setGateSlotShare(code, {
                  sharing: !sharing,
                  reservedSlots: Math.max(0, Math.round(Number(draft) || 0)),
                }))}
              >
                {sharing ? 'Stop sharing' : 'Share spare slots'}
              </button>
            </div>
          );
        })}

        {borrowedRows.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>
              Borrowed from the pool
            </div>
            {borrowedRows.map(([code, p]) => (
              <div key={code} style={{ fontSize: 12, padding: '4px 0', color: 'var(--text-muted)' }}>
                <span style={{ fontFamily: 'monospace', fontWeight: 700, color: 'var(--text)' }}>{code}</span>
                {' '}— using {p.draw ?? 0} of {p.grant ?? 0} granted slot{(p.grant ?? 0) === 1 ? '' : 's'}
                {(p.weeklyCost ?? 0) > 0 && ` · ${formatMoney(p.weeklyCost)}/wk`}
                {(p.lenders ?? []).length > 0 && ` · on ${p.lenders.map((x) => x.name).join(', ')}'s gates`}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function GateMarketSection({ state, remoteApi }) {
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [bidDrafts, setBidDrafts] = useState({});   // code → { amount, quantity }
  const [sellCode, setSellCode] = useState('');
  const [sellPrice, setSellPrice] = useState('');

  if (!state.gateScarcityWorld || !remoteApi?.placeGateBid) return null;
  const market = state.gateMarket?.airports ?? {};
  const weekNow = state.gateMarket?.week ?? ((state.year - 1) * 52 + state.week);

  const auctions = Object.entries(market)
    .filter(([, m]) => m.auction)
    .sort(([a], [b]) => a.localeCompare(b));
  // Sealed auctions used to leave no trace once they resolved: the section
  // simply stopped rendering them, so "did I win?" had no answer anywhere in
  // the game. The server now returns recent results, newest first.
  const pastAuctions = Object.entries(market)
    .filter(([, m]) => m.lastAuction)
    .sort(([, a], [, b]) => b.lastAuction.resolvedWeek - a.lastAuction.resolvedWeek);
  const listings = Object.entries(market)
    .flatMap(([code, m]) => (m.listings ?? []).map((l) => ({ ...l, code })))
    .sort((a, b) => a.code.localeCompare(b.code) || a.askPrice - b.askPrice);
  // Airports where you have an unlisted, non-guaranteed gate to sell.
  const sellable = Object.entries(state.gates ?? {})
    .filter(([, count]) => count > 0)
    .map(([code, count]) => {
      const guaranteed = code === state.hub ? Math.min(count, GATE_HUB_GUARANTEE) : 0;
      const myOpen = (market[code]?.listings ?? []).filter((l) => l.yours).length;
      return { code, count, free: count - guaranteed - myOpen };
    })
    .filter((x) => x.free > 0);

  if (auctions.length === 0 && pastAuctions.length === 0 && listings.length === 0 && sellable.length === 0) return null;

  const run = (fn) => {
    setBusy(true); setErr(null);
    fn().catch((e) => setErr(e?.message ?? String(e))).finally(() => setBusy(false));
  };
  const SUB = {
    fontSize: 11, fontWeight: 600, color: 'var(--text-muted)',
    textTransform: 'uppercase', letterSpacing: '0.07em', margin: '14px 0 6px',
  };
  const INPUT = {
    width: 110, padding: '3px 8px', fontSize: 12, borderRadius: 4,
    background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)',
  };

  return (
    <section id="gate-market" style={{ marginBottom: 28 }}>
      <div style={{
        fontSize: 11, fontWeight: 600, color: 'var(--text-muted)',
        textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8,
      }}>
        Gate Market
      </div>
      <div className="card" style={{ padding: '12px 16px' }}>
        {err && <div style={{ fontSize: 12, color: 'var(--red)', marginBottom: 8 }}>{err}</div>}

        {/* Open auctions — sealed bids, highest wins at the year tick */}
        {auctions.length > 0 && (
          <>
            <div style={{ ...SUB, marginTop: 0 }}>🔨 Open auctions — sealed bids, resolve at the new year</div>
            {auctions.map(([code, m]) => {
              const a = m.auction;
              const weeksLeft = Math.max(0, a.closesWeek - weekNow);
              // Never offer a quantity the auction can't fill — you can't win
              // 3 gates out of a 2-gate lot, and the ownership caps cut it
              // further. `maxWinnable` is the server's own arithmetic, so the
              // form can't promise what resolution would refuse. 0 means the
              // caps rule you out entirely: say so instead of taking a bid that
              // would be voided at the year tick.
              const maxQty = Math.max(1, Math.min(
                GATE_BID_MAX_QTY, a.lots, a.maxWinnable ?? a.lots,
              ));
              const barred = (a.maxWinnable ?? 1) < 1;
              const saved = bidDrafts[code] ?? { amount: a.yourBid?.amount ?? a.reserve, quantity: a.yourBid?.quantity ?? 1 };
              const draft = { ...saved, quantity: Math.max(1, Math.min(Number(saved.quantity) || 1, maxQty)) };
              return (
                <div key={code} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
                  <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 13, minWidth: 36 }}>{code}</span>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {a.lots} gate{a.lots > 1 ? 's' : ''} on offer · reserve {formatMoney(a.reserve)}/gate ·
                    closes in {weeksLeft} wk{weeksLeft === 1 ? '' : 's'}
                  </span>
                  {a.yourBid && (
                    <span style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600 }}>
                      {/* Show the number you can actually win — a bid placed
                          before the cap existed may ask for more lots than exist. */}
                      Your bid: {formatMoney(a.yourBid.amount)} × {Math.min(a.yourBid.quantity, maxQty)}
                    </span>
                  )}
                  {barred ? (
                    <span style={{
                      marginLeft: 'auto', fontSize: 11, fontWeight: 600, color: 'var(--red)',
                      maxWidth: 420, textAlign: 'right', lineHeight: 1.45,
                    }}>
                      You cannot win a gate here — {a.detail}.
                    </span>
                  ) : (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
                    <input
                      style={INPUT} type="number" min={a.reserve} step={10000}
                      value={draft.amount}
                      title="Your sealed per-gate bid (hidden from other airlines)"
                      onChange={(e) => setBidDrafts((d) => ({ ...d, [code]: { ...draft, amount: e.target.value } }))}
                    />
                    {maxQty > 1 ? (
                      <select
                        style={{ ...INPUT, width: 58 }}
                        value={draft.quantity}
                        title={`How many gates you're bidding for (${a.lots} on offer)`}
                        onChange={(e) => setBidDrafts((d) => ({ ...d, [code]: { ...draft, quantity: Number(e.target.value) } }))}
                      >
                        {Array.from({ length: maxQty }, (_, i) => i + 1)
                          .map((n) => <option key={n} value={n}>×{n}</option>)}
                      </select>
                    ) : (
                      <span style={{ fontSize: 12, color: 'var(--text-muted)' }} title="Only one gate is on offer">×1</span>
                    )}
                    <button className="btn btn-primary" style={{ padding: '3px 10px', fontSize: 12 }} disabled={busy}
                      onClick={() => run(() => remoteApi.placeGateBid(code, Math.round(Number(draft.amount)), draft.quantity))}>
                      {a.yourBid ? 'Update bid' : 'Place bid'}
                    </button>
                    {a.yourBid && (
                      <button className="btn btn-ghost" style={{ padding: '3px 8px', fontSize: 11 }} disabled={busy}
                        onClick={() => run(() => remoteApi.withdrawGateBid(code))}>
                        Withdraw
                      </button>
                    )}
                  </span>
                  )}
                </div>
              );
            })}
          </>
        )}

        {/* Resolved auctions — including the ones that sold nothing, which is
            precisely the case that used to produce no signal at all. */}
        {pastAuctions.length > 0 && (
          <>
            <div style={SUB}>📜 Recent auction results</div>
            {pastAuctions.map(([code, m]) => {
              const r = m.lastAuction;
              const weeksAgo = Math.max(0, weekNow - r.resolvedWeek);
              return (
                <div key={`past-${code}`} style={{ padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                    <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 13, minWidth: 36 }}>{code}</span>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      {r.sold > 0
                        ? `${r.sold} of ${r.lots} gate${r.lots > 1 ? 's' : ''} sold`
                        : `no gates sold — ${r.bidCount === 0 ? 'nobody bid' : 'no bid could be awarded'}`}
                      {' · '}resolved {weeksAgo === 0 ? 'this week' : `${weeksAgo} wk${weeksAgo === 1 ? '' : 's'} ago`}
                    </span>
                  </div>
                  {r.winners.length > 0 && (
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3, paddingLeft: 46 }}>
                      {r.winners.map((w, i) => (
                        <span key={i} style={{ marginRight: 12, color: w.yours ? 'var(--accent)' : undefined, fontWeight: w.yours ? 600 : 400 }}>
                          {w.yours ? 'You' : w.name} ×{w.gates} at {formatMoney(w.pricePerGate)}/gate
                        </span>
                      ))}
                    </div>
                  )}
                  {r.yours && (
                    <div style={{
                      fontSize: 11, marginTop: 4, paddingLeft: 46, fontWeight: 600,
                      color: r.yours.reason === 'WON' ? 'var(--accent)' : 'var(--amber, var(--text-muted))',
                    }}>
                      Your bid ({formatMoney(r.yours.amount ?? 0)}/gate × {r.yours.quantity ?? 1}): {AUCTION_OUTCOME[r.yours.reason] ?? 'did not win'}
                      {r.yours.detail ? ` — ${r.yours.detail}` : ''}
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}

        {/* Player-to-player listings */}
        {listings.length > 0 && (
          <>
            <div style={SUB}>🤝 Gates for sale</div>
            {listings.map((l) => (
              <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
                <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 13, minWidth: 36 }}>{l.code}</span>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  1 gate · from {l.yours ? 'you' : l.seller}
                </span>
                <span style={{ fontSize: 13, fontWeight: 700 }}>{formatMoney(l.askPrice)}</span>
                <span style={{ marginLeft: 'auto' }}>
                  {l.yours ? (
                    <button className="btn btn-ghost" style={{ padding: '3px 10px', fontSize: 12 }} disabled={busy}
                      onClick={() => run(() => remoteApi.withdrawGateListing(l.id))}>
                      Withdraw listing
                    </button>
                  ) : (
                    <button className="btn btn-primary" style={{ padding: '3px 10px', fontSize: 12 }}
                      disabled={busy || (state.cash ?? 0) < l.askPrice}
                      title={(state.cash ?? 0) < l.askPrice ? 'Not enough cash' : `Buy this ${l.code} gate at the asking price`}
                      onClick={() => run(() => remoteApi.buyGateListing(l.id))}>
                      Buy
                    </button>
                  )}
                </span>
              </div>
            ))}
          </>
        )}

        {/* Sell one of yours */}
        {sellable.length > 0 && (
          <>
            <div style={SUB}>💰 Sell a gate</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <select style={{ ...INPUT, width: 150 }} value={sellCode} onChange={(e) => setSellCode(e.target.value)}>
                <option value="">Airport…</option>
                {sellable.map((s) => <option key={s.code} value={s.code}>{s.code} ({s.free} sellable)</option>)}
              </select>
              <input style={INPUT} type="number" min={1} step={50000} placeholder="Asking price"
                value={sellPrice} onChange={(e) => setSellPrice(e.target.value)} />
              <button className="btn btn-primary" style={{ padding: '3px 10px', fontSize: 12 }}
                disabled={busy || !sellCode || !(Number(sellPrice) > 0)}
                onClick={() => run(() => remoteApi.listGate(sellCode, Math.round(Number(sellPrice))).then(() => { setSellCode(''); setSellPrice(''); }))}>
                List for sale
              </button>
              <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                Sold to whichever airline buys at your price. Your first {GATE_HUB_GUARANTEE} home-hub gates can't be sold; recently won/bought gates have a 12-wk cooldown.
              </span>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

export default function Airports({ initialRegion = null }) {
  const { state, dispatch, remoteApi } = useGame();
  const { gates = {}, routes, cargoRoutes = [], cash, hubs = {} } = state;
  const scarcity = !!state.gateScarcityWorld;
  // An open auction is time-boxed and easy to miss, so while one is running the
  // Gate Market jumps above your gate list instead of sitting below it.
  const liveAuction = scarcity
    && Object.values(state.gateMarket?.airports ?? {}).some((m) => m?.auction);
  const addDenialFor = (code) => (scarcity ? gateLeaseDenial(state, code) : null);
  const [search, setSearch]                       = useState('');
  // Global lookup: any airport in the world, from the top of this tab. The
  // browse search below it is scoped to whichever region you picked, so looking
  // up an airport you don't hold a gate at meant knowing its region first — or
  // going to the Route Finder / gate list to see its numbers (Knightmare,
  // Discord 2026-08-26).
  const [lookup, setLookup]                       = useState('');
  const [regionFilter, setRegionFilter]           = useState(initialRegion); // null = show picker
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

  // Total departures / arrivals consuming slots at an airport. Counted through
  // the engine's own helper, so a multi-stop rotation calling here shows the two
  // movements it actually makes — the endpoint-only reading under-reported this
  // page against the guards that refuse flights on the strength of it.
  function slotsUsedAt(code) {
    return slotsUsedAtEngine(routes, code) + cargoSlotsUsedAt(code, cargoRoutes);
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

  const TIER_ORDER = TIER_RANK;

  const lookupResults = searchAirports(lookup, { gates });
  const lookupTooShort = lookup.trim().length === 1;

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
          {scarcity && (
            <>
              <br />
              <span style={{ fontSize: 11, color: 'var(--yellow)' }}
                title={`Gate scarcity world: airports have finite gates (max 60% per airline, 80% per alliance). Full airports auction new gates yearly. Gates unused for 24 weeks are forfeited. Airports over 90% full charge +${Math.round((GATE_SURCHARGE_MULT - 1) * 100)}% fees.`}>
                ⛩ Gate scarcity world — gates are limited
              </span>
            </>
          )}
        </div>
      </div>

      {/* ── Find any airport ──────────────────────────────────────── */}
      <section style={{ marginBottom: 24 }}>
        <input
          className="form-input"
          placeholder="Find any airport — code, city, name or country…"
          value={lookup}
          onChange={e => setLookup(e.target.value)}
          style={{ width: '100%', maxWidth: 420 }}
        />
        {lookupTooShort && (
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 6 }}>Keep typing — two characters or more.</div>
        )}
        {lookup.trim().length >= 2 && (
          <div style={{
            marginTop: 8, border: '1px solid var(--border)', borderRadius: 'var(--radius)',
            background: 'var(--surface2)', maxWidth: 560, overflow: 'hidden',
          }}>
            {lookupResults.length === 0 ? (
              <div style={{ padding: '12px 14px', fontSize: 13, color: 'var(--text-muted)' }}>
                No airport matches “{lookup.trim()}”.
              </div>
            ) : lookupResults.map(a => {
              const held = gates[a.code] ?? 0;
              return (
                <button
                  key={a.code}
                  onClick={() => setSelectedAirport(a.code)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
                    padding: '9px 14px', background: 'transparent', border: 'none',
                    borderBottom: '1px solid var(--border-subtle)', cursor: 'pointer', color: 'var(--text)',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface3)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <span style={{ fontWeight: 700, width: 42, flexShrink: 0 }}>{a.code}</span>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {a.city}, {getCountryName(a.country)}
                    <span style={{ color: 'var(--text-dim)' }}> · {a.name}</span>
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', flexShrink: 0 }}>{a.tier}</span>
                  {hubs[a.code] && (
                    <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--gold, #ffcf4d)', flexShrink: 0 }}>HUB</span>
                  )}
                  {held > 0 && (
                    <span style={{ fontSize: 11, color: 'var(--accent)', flexShrink: 0 }}>{held} gate{held !== 1 ? 's' : ''}</span>
                  )}
                  <span style={{ fontSize: 12, color: 'var(--text-dim)', flexShrink: 0 }}>→</span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* ── Gate market, floated up while an auction is live ───────── */}
      {liveAuction && <GateMarketSection state={state} remoteApi={remoteApi} />}

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
                  addDenial:  addDenialFor(code),
                  // Use-it-or-lose-it countdown. This is the ONLY place a
                  // player can see a forfeiture coming: the warning toast the
                  // engine raises at week 16 does not survive the next
                  // server-side tick.
                  idleWeeks:   idleWeeksAt(state, code),
                  idleWarning: idleWarningFor(state, code),
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
                      <div style={{ fontSize: 11, color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span>{count} gate{count > 1 ? 's' : ''} · {formatMoney(weeklyCost)}/wk ({formatMoney(weeklyCost * 4)}/mo)</span>
                        <AvailabilityChips state={state} code={code} />
                      </div>
                      <GateDenialNote state={state} code={code} />
                      {idleWarningFor(state, code) && (
                        <div style={{ fontSize: 11, color: 'var(--yellow)', marginTop: 3, lineHeight: 1.35 }}>
                          ⚠️ {idleWarningFor(state, code)}
                        </div>
                      )}
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
                      {(() => {
                        const denial = addDenialFor(code);
                        return (
                          <DisabledHint title={denial}>
                            <button
                              className="btn btn-primary"
                              style={{
                                padding: '4px 12px', fontSize: 12,
                                opacity: denial ? 0.35 : 1,
                                cursor: denial ? 'not-allowed' : 'pointer',
                              }}
                              disabled={!!denial}
                              title={denial ? undefined : 'Lease one more gate'}
                              onClick={() => dispatch({ type: 'ADD_GATE', airportCode: code })}
                            >
                              + Gate
                            </button>
                          </DisabledHint>
                        );
                      })()}
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

      {/* ── Gate market: auctions + player-to-player sales (scarcity worlds) ── */}
      {scarcity && !liveAuction && <GateMarketSection state={state} remoteApi={remoteApi} />}

      {/* ── Alliance slot pool: share spare slots with your alliance ── */}
      {scarcity && <SlotPoolSection state={state} remoteApi={remoteApi} />}

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
                // Hoisted so the reason can style the whole row, not just grey
                // out the button — a greyed button with no words next to it is
                // what made this page unreadable in the first place.
                const denial     = addDenialFor(airport.code);

                return (
                  <div
                    key={airport.code}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '7px 10px', borderRadius: 'var(--radius)',
                      background: denial ? 'rgba(248,81,73,0.06)' : held ? 'var(--surface2)' : 'var(--surface)',
                      border: `1px solid ${denial ? 'rgba(248,81,73,0.3)' : held ? 'var(--accent-dim)' : 'var(--border)'}`,
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
                      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2, paddingLeft: 42, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span>{formatMoney(weeklyCost)}/wk · {SLOTS_PER_GATE} slots/gate</span>
                        <AvailabilityChips state={state} code={airport.code} />
                      </div>
                      <GateDenialNote reason={denial} style={{ paddingLeft: 42 }} />
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexShrink: 0, marginLeft: 10 }}>
                      <button
                        className="btn btn-ghost"
                        style={{ padding: '3px 8px', fontSize: 11 }}
                        onClick={() => setSelectedAirport(airport.code)}
                      >
                        Details
                      </button>
                      <DisabledHint title={denial}>
                        <button
                          className="btn btn-primary"
                          style={{
                            padding: '3px 10px', fontSize: 12,
                            opacity: denial ? 0.35 : 1,
                            cursor: denial ? 'not-allowed' : 'pointer',
                          }}
                          disabled={!!denial}
                          title={denial ? undefined : 'Lease a gate here'}
                          onClick={() => dispatch({ type: 'ADD_GATE', airportCode: airport.code })}
                        >
                          + Gate
                        </button>
                      </DisabledHint>
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
