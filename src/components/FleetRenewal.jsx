// Fleet renewal UI — choosing what an order replaces, and showing it.
//
// Ported from Tailwinds (2026-10-16). The engine side lives in
// packages/engine/src/reducer.mjs (replacementCompatibility,
// SET_ORDER_REPLACEMENT, ORDER_AIRCRAFT `replaces`, withFleetRenewal). Every
// picker here asks that same function, so a greyed-out row and a refused
// action always give the same reason.
//
//   ReplacesSection        — the "Replaces" block on the order form
//   OrderReplacementLine   — the line + picker on an order in the queue
//   ReplacementPickerModal — choose one tail for an existing order
//   RenewalNotice          — Fleet detail panel: being replaced / waiting
//   RenewalBadge           — Fleet list: a small marker on either end
//   BulkReplaceModal       — Fleet bulk bar: pick a type for N selected tails
import { useMemo, useState } from 'react';
import { useGame, replacementCompatibility, orderDenial, leaseDenial } from '../store/GameContext.jsx';
import { getAircraftType, AIRCRAFT_TYPES, effectivePurchasePrice, eraWeeklyLease } from '../data/aircraft.js';
import { formatMoney, ageLabel, calendarYear, routeMaxLegKm } from '../utils/simulation.js';
import { absoluteWeek } from '../utils/fuel.js';
import { deliverySchedule } from '../data/delivery.js';
import { leaseWillAutoRenew } from '../models/leaseRenewal.js';
import AircraftCheckout from './AircraftCheckout.jsx';
import { Glyph } from './Icons.jsx';

const nowAbsOf = (state) => absoluteWeek(state.year, state.week);

/** Oldest first — the frames that most need replacing take the first deliveries. */
export function byAgeDesc(a, b) {
  return (b.ageWeeks ?? 0) - (a.ageWeeks ?? 0) || String(a.name).localeCompare(String(b.name));
}

// Scheduled routes only (passenger + freight). Not a block-hour question — a
// charter is not moved by the swap; the swap waits for it instead.
function ownRoutes(state, id) {
  return [...(state.routes ?? []), ...(state.cargoRoutes ?? [])]
    .filter(r => r && (r.aircraftId === id || r.coverForAircraftId === id));
}
function routeCount(state, id) {
  return ownRoutes(state, id).length;
}

/**
 * What happens to the old tail, said plainly, or a warning if its lease will
 * run out before the replacement arrives. Mirrors RETIRE_AIRCRAFT's terms
 * (50% of the rent left, deposit back) so the estimate is the real bill.
 */
export function disposalNote(state, tail, deliverAbsWeek, disposal) {
  if (!tail) return null;
  const weeksToGo = Math.max(0, deliverAbsWeek - nowAbsOf(state));
  if (tail.ownershipType === 'lease') {
    const left = (tail.leaseRemainingWeeks ?? 0) - weeksToGo;
    if (left <= 0 && !leaseWillAutoRenew(state, tail)) {
      return { tone: 'warn', text: `Its lease ends before this delivery — extend it, or its routes close when it goes back.` };
    }
    if (disposal === 'keep') return { tone: 'muted', text: 'Kept as a spare (still on lease).' };
    if (left <= 0) return { tone: 'muted', text: 'Handed back to the lessor.' };
    const fee = Math.round((tail.weeklyLease ?? getAircraftType(tail.typeId)?.weeklyLease ?? 0) * left * 0.5);
    return { tone: fee > 0 ? 'yellow' : 'muted',
      text: `Handed back with ~${left}w left on the lease: about ${formatMoney(fee)} early-return fee.` };
  }
  if (disposal === 'keep') return { tone: 'muted', text: 'Kept as a spare.' };
  return { tone: 'muted', text: 'Sold at its value on the day.' };
}

const TONE = { warn: 'var(--red)', yellow: 'var(--yellow)', muted: 'var(--text-muted)' };

function DisposalToggle({ value, onChange }) {
  const opt = (v, label, title) => (
    <button
      type="button"
      className="btn"
      title={title}
      onClick={() => onChange(v)}
      style={{
        fontSize: 12, padding: '4px 10px',
        background: value === v ? 'rgba(56,139,253,0.18)' : 'var(--surface3)',
        color: value === v ? 'var(--accent)' : 'var(--text-muted)',
        border: `1px solid ${value === v ? 'rgba(56,139,253,0.45)' : 'var(--border)'}`,
      }}
    >{label}</button>
  );
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Then the old aircraft is</span>
      {opt('dispose', 'Sold / returned', 'Owned aircraft are sold at their value on the day; leased ones go back to the lessor on the normal early-return terms.')}
      {opt('keep', 'Kept as a spare', 'The old aircraft stays in the fleet, idle — park it as a reserve or give it new routes.')}
    </div>
  );
}

// ── Order form ────────────────────────────────────────────────────────────────
/**
 * The order-form block. `draft` is the order as currently configured (type,
 * ownership, wingtip range, cabin) so the check matches what will be built.
 * `deliveryWeeks` are this order's delivery weeks, earliest first.
 * `firstReplaceable` skips frames that cannot replace anything (Headwinds'
 * Starter Fleet frames arrive at signing); 0 in Tailwinds.
 */
export function ReplacesSection({ draft, quantity, setQuantity, selected, setSelected, disposal, setDisposal, deliveryWeeks, defaultOpen = false, firstReplaceable = 0 }) {
  const { state } = useGame();
  const [open, setOpen] = useState(defaultOpen || selected.length > 0);

  const rows = useMemo(() => {
    if (!open) return [];
    return (state.fleet ?? [])
      .filter(a => a.status !== 'retired')
      .map(a => ({ a, t: getAircraftType(a.typeId), c: replacementCompatibility(state, draft, a.id), n: routeCount(state, a.id) }))
      .sort((x, y) => (y.c.ok ? 1 : 0) - (x.c.ok ? 1 : 0) || byAgeDesc(x.a, y.a));
  }, [open, state, draft.typeId, draft.rangeMod, JSON.stringify(draft.config ?? null)]);

  const okIds = new Set(rows.filter(r => r.c.ok).map(r => r.a.id));
  const capacity = Math.max(0, quantity - firstReplaceable);
  // A selection that stopped fitting (the cabin changed, say) drops out.
  const live = open ? selected.filter(id => okIds.has(id)) : selected;
  const ordered = (state.fleet ?? []).filter(a => live.includes(a.id)).sort(byAgeDesc);
  const slotOf = new Map(ordered.map((a, i) => [a.id, i]));

  function toggle(id) {
    setSelected(live.includes(id) ? live.filter(x => x !== id) : [...live, id]);
  }

  const head = {
    fontSize: 11, fontWeight: 600, color: 'var(--text-muted)',
    textTransform: 'uppercase', letterSpacing: '0.07em',
  };

  return (
    <section style={{ marginBottom: 18 }}>
      <div
        role="button" tabIndex={0}
        onClick={() => setOpen(v => !v)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(v => !v); } }}
        style={{ ...head, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 8 }}
      >
        <span>↻ Replaces existing aircraft</span>
        <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400, color: live.length ? 'var(--accent)' : 'var(--text-dim)' }}>
          {live.length ? `${Math.min(live.length, capacity)} selected` : 'optional'}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 10, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▶</span>
      </div>
      {open && (
        <div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 8px', lineHeight: 1.5 }}>
            When each new aircraft arrives it takes over every route of the one it replaces —
            same frequencies, fares and maturity, no relaunch cost. Oldest aircraft are swapped first.
          </p>
          <DisposalToggle value={disposal} onChange={setDisposal} />
          {firstReplaceable > 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
              The first {firstReplaceable} aircraft arrive straight away and don't replace anything; replacements start with the next.
            </div>
          )}
          {live.length > capacity && (
            <div style={{ fontSize: 12, color: 'var(--yellow)', marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {live.length} selected but only {capacity} can be replaced by this order — the {live.length - capacity} youngest won't be.
              <button type="button" className="btn" style={{ fontSize: 11, padding: '3px 8px' }} onClick={() => setQuantity(live.length + firstReplaceable)}>
                Order {live.length + firstReplaceable}
              </button>
            </div>
          )}
          <div style={{ marginTop: 8, maxHeight: 260, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
            {rows.length === 0 && (
              <div style={{ padding: 10, fontSize: 12, color: 'var(--text-dim)', fontStyle: 'italic' }}>No aircraft in the fleet.</div>
            )}
            {rows.map(({ a, t, c, n }) => {
              const slot = slotOf.get(a.id);
              const dw = slot != null && slot < capacity ? deliveryWeeks[Math.min(firstReplaceable + slot, deliveryWeeks.length - 1)] : null;
              const note = dw != null ? disposalNote(state, a, dw, disposal) : null;
              return (
                <label key={a.id} style={{
                  display: 'flex', gap: 8, alignItems: 'flex-start', padding: '7px 10px',
                  borderBottom: '1px solid var(--border)', opacity: c.ok ? 1 : 0.5,
                  cursor: c.ok ? 'pointer' : 'not-allowed', fontSize: 12,
                }}>
                  <input type="checkbox" disabled={!c.ok} checked={live.includes(a.id)} onChange={() => toggle(a.id)} style={{ marginTop: 2 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div>
                      <strong>{a.name}</strong>
                      <span style={{ color: 'var(--text-muted)' }}> · {t?.name} · {ageLabel(a.ageWeeks ?? 0)} · {a.ownershipType === 'lease' ? 'leased' : 'owned'}</span>
                    </div>
                    <div style={{ fontSize: 11, color: c.ok ? 'var(--text-muted)' : 'var(--red)' }}>
                      {!c.ok ? c.reason : n > 0 ? `${n} route${n !== 1 ? 's' : ''}` : 'No routes — it is simply disposed of'}
                      {dw != null && <span style={{ color: 'var(--accent)' }}> · swapped in {Math.max(0, dw - nowAbsOf(state))}w</span>}
                    </div>
                    {note && <div style={{ fontSize: 11, color: TONE[note.tone] }}>{note.text}</div>}
                  </div>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

/** The ids the form should send, oldest first and no more than the order size. */
export function replacesForDispatch(state, selected, draft, quantity, firstReplaceable = 0) {
  return (state.fleet ?? [])
    .filter(a => selected.includes(a.id) && replacementCompatibility(state, draft, a.id).ok)
    .sort(byAgeDesc)
    .slice(0, Math.max(0, quantity - firstReplaceable))
    .map(a => a.id);
}

// ── The order queue ───────────────────────────────────────────────────────────
export function OrderReplacementLine({ order, compact = false }) {
  // Order cards are also rendered on their own (tests, previews) with no game
  // around them; there is nothing to pick from there, so render nothing.
  let state = null;
  try { ({ state } = useGame()); } catch { state = null; }
  const [picking, setPicking] = useState(false);
  if (!state) return null;
  const old = order.replacesAircraftId ? (state.fleet ?? []).find(a => a.id === order.replacesAircraftId) : null;
  const gone = order.replacesAircraftId && !old;
  const note = old ? disposalNote(state, old, order.deliverAbsWeek, order.replaceDisposal) : null;
  return (
    <div style={{ fontSize: compact ? 10 : 12, marginTop: compact ? 2 : 0, marginBottom: compact ? 0 : 10 }}>
      {order.replacesAircraftId ? (
        <div>
          <span style={{ color: gone ? 'var(--yellow)' : 'var(--accent)' }}>
            ↻ Replaces {old?.name ?? order.replacesName ?? 'an aircraft'}
            {gone ? ' (no longer in your fleet)' : order.replaceDisposal === 'keep' ? ' · keep as spare' : old?.ownershipType === 'lease' ? ' · return' : ' · sell'}
          </span>
          {' '}
          <button type="button" className="btn btn-ghost" style={{ fontSize: compact ? 10 : 11, padding: '1px 6px' }} onClick={() => setPicking(true)}>
            Change
          </button>
          {!compact && note && <div style={{ fontSize: 11, color: TONE[note.tone], marginTop: 2 }}>{note.text}</div>}
        </div>
      ) : (
        <button type="button" className="btn btn-ghost" style={{ fontSize: compact ? 10 : 11, padding: '1px 6px', color: 'var(--text-muted)' }}
          title="Pick an aircraft for this one to take over from when it is delivered" onClick={() => setPicking(true)}>
          ↻ Replace an aircraft…
        </button>
      )}
      {picking && <ReplacementPickerModal order={order} onClose={() => setPicking(false)} />}
    </div>
  );
}

export function ReplacementPickerModal({ order, onClose }) {
  const { state, dispatch } = useGame();
  const [disposal, setDisposal] = useState(order.replaceDisposal ?? 'dispose');
  const type = getAircraftType(order.typeId);
  const rows = useMemo(() => (state.fleet ?? [])
    .filter(a => a.status !== 'retired')
    .map(a => ({ a, t: getAircraftType(a.typeId), c: replacementCompatibility(state, order, a.id), n: routeCount(state, a.id) }))
    .sort((x, y) => (y.c.ok ? 1 : 0) - (x.c.ok ? 1 : 0) || byAgeDesc(x.a, y.a)), [state, order]);

  function pick(aircraftId) {
    dispatch({ type: 'SET_ORDER_REPLACEMENT', orderId: order.id, aircraftId, disposal });
    onClose();
  }

  return (
    <div className="saveload-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="saveload-modal" style={{ width: 'min(560px, 94vw)' }}>
        <div className="saveload-header">
          <h2 style={{ margin: 0, fontSize: 17 }}>Replace an aircraft</h2>
          <button className="btn" onClick={onClose}><Glyph e="✕" /></button>
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-dim)', margin: '4px 0 12px', lineHeight: 1.5 }}>
          When <strong>{order.name}</strong> ({type?.name}) arrives in {Math.max(0, order.deliverAbsWeek - nowAbsOf(state))}w,
          it takes over every route of the aircraft you pick. Routes keep their frequencies, fares and maturity.
        </p>
        <DisposalToggle value={disposal} onChange={setDisposal} />
        {order.replacesAircraftId && (
          <button className="btn btn-ghost" style={{ marginTop: 10, fontSize: 12 }} onClick={() => pick(null)}>
            Don't replace anything
          </button>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12, maxHeight: '52vh', overflowY: 'auto' }}>
          {rows.map(({ a, t, c, n }) => {
            const current = a.id === order.replacesAircraftId;
            const note = c.ok ? disposalNote(state, a, order.deliverAbsWeek, disposal) : null;
            return (
              <div key={a.id} style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px',
                border: `1px solid ${current ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 8,
                opacity: c.ok ? 1 : 0.55,
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>
                    {a.name}<span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> · {t?.name} · {ageLabel(a.ageWeeks ?? 0)}</span>
                  </div>
                  <div style={{ fontSize: 11, color: c.ok ? 'var(--text-muted)' : 'var(--red)' }}>
                    {!c.ok ? c.reason : n > 0 ? `${n} route${n !== 1 ? 's' : ''} · ${a.ownershipType === 'lease' ? 'leased' : 'owned'}` : `No routes · ${a.ownershipType === 'lease' ? 'leased' : 'owned'}`}
                  </div>
                  {note && <div style={{ fontSize: 11, color: TONE[note.tone] }}>{note.text}</div>}
                </div>
                <button className="btn btn-primary" disabled={!c.ok} onClick={() => pick(a.id)}>
                  {current ? 'Update' : 'Replace'}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Fleet: detail panel and list ──────────────────────────────────────────────
export function RenewalNotice({ aircraft }) {
  const { state, dispatch } = useGame();
  const incoming = (state.pendingOrders ?? []).find(o => o.replacesAircraftId === aircraft.id);
  const target = aircraft.replacing ? (state.fleet ?? []).find(a => a.id === aircraft.replacing.aircraftId) : null;
  if (!incoming && !aircraft.replacing) return null;
  const box = {
    marginBottom: 14, padding: '10px 12px', borderRadius: 8, fontSize: 13, lineHeight: 1.5,
    background: 'rgba(56,139,253,0.08)', border: '1px solid rgba(56,139,253,0.3)',
  };
  return (
    <div style={box}>
      {incoming && (
        <div>
          <strong style={{ color: 'var(--accent)' }}>↻ Being replaced.</strong>{' '}
          {incoming.name} arrives in {Math.max(0, incoming.deliverAbsWeek - nowAbsOf(state))}w and takes over this aircraft's routes; this one is then
          {incoming.replaceDisposal === 'keep' ? ' kept as a spare.' : aircraft.ownershipType === 'lease' ? ' handed back to the lessor.' : ' sold.'}{' '}
          <button className="btn btn-ghost" style={{ fontSize: 11, padding: '2px 8px' }}
            onClick={() => dispatch({ type: 'SET_ORDER_REPLACEMENT', orderId: incoming.id, aircraftId: null })}>
            Don't replace
          </button>
        </div>
      )}
      {aircraft.replacing && (
        <div>
          <strong style={{ color: 'var(--yellow)' }}>⏳ Waiting to replace {target?.name ?? aircraft.replacing.name}.</strong>{' '}
          {aircraft.replacing.waiting ? `${aircraft.replacing.waiting[0].toUpperCase()}${aircraft.replacing.waiting.slice(1)}. ` : ''}
          It takes over the routes the week it is free.{' '}
          <button className="btn btn-ghost" style={{ fontSize: 11, padding: '2px 8px' }}
            onClick={() => dispatch({ type: 'CLEAR_FLEET_REPLACEMENT', aircraftId: aircraft.id })}>
            Stop waiting
          </button>
        </div>
      )}
    </div>
  );
}

export function RenewalBadge({ aircraft, pendingOrders }) {
  const incoming = (pendingOrders ?? []).find(o => o.replacesAircraftId === aircraft.id);
  const style = { marginLeft: 6, fontSize: 10, fontWeight: 600, whiteSpace: 'nowrap' };
  if (aircraft.replacing) {
    return <span style={{ ...style, color: 'var(--yellow)' }} title={aircraft.replacing.waiting ?? undefined}>⏳ replacing {aircraft.replacing.name ?? ''}</span>;
  }
  if (incoming) {
    return <span style={{ ...style, color: 'var(--accent)' }} title={`Replaced by ${incoming.name} on delivery`}>↻ being replaced</span>;
  }
  return null;
}

// ── Fleet: bulk replace ───────────────────────────────────────────────────────
/**
 * Pick one type to replace a selection of tails with. Each row says how many
 * of the selection it can take over (the engine's check, on a standard
 * cabin), then hands the fitting ones to the normal order form.
 */
export function BulkReplaceModal({ aircraftIds, onClose, onOrdered }) {
  const { state } = useGame();
  const [query, setQuery] = useState('');
  const [checkout, setCheckout] = useState(null);
  const tails = useMemo(() => aircraftIds.map(id => state.fleet.find(a => a.id === id)).filter(Boolean), [aircraftIds, state.fleet]);
  const calYear = calendarYear(state);
  const nowAbs = nowAbsOf(state);
  const avgSeats = tails.length ? tails.reduce((s, a) => s + (getAircraftType(a.typeId)?.seats ?? 0), 0) / tails.length : 0;

  const rows = useMemo(() => {
    // Cheap pre-screen before the full check: the probe has a standard cabin
    // and no wingtips, so its range is exactly the catalogue range, and a
    // freighter can never take passenger routes (or the reverse).
    const cargoIds = new Set((state.cargoRoutes ?? []).map(r => r.id));
    const need = new Map(tails.map(a => {
      const mine = ownRoutes(state, a.id);
      return [a.id, {
        maxLeg: mine.reduce((m, r) => Math.max(m, routeMaxLegKm(r)), 0),
        pax:    mine.some(r => !cargoIds.has(r.id)),
        cargo:  mine.some(r => cargoIds.has(r.id)),
      }];
    }));
    const out = [];
    for (const t of AIRCRAFT_TYPES) {
      if (orderDenial(state, t.id)) continue;
      const probe = { id: '__replace-probe', typeId: t.id, ownershipType: 'owned', name: t.name, rangeMod: 1 };
      const fit = tails.filter(a => {
        const n = need.get(a.id);
        if (n.maxLeg > t.range || (n.pax && t.freighter) || (n.cargo && !t.freighter)) return false;
        return replacementCompatibility(state, probe, a.id).ok;
      });
      if (fit.length === 0) continue;
      out.push({
        t, fit,
        price: effectivePurchasePrice(t, 1, calYear),
        lease: eraWeeklyLease(t, calYear),
        leaseBlock: leaseDenial(state, t.id)?.message ?? null,
        // Production-line worlds quote slots on the order form itself.
        firstIn: state.productionLinesWorld ? null : deliverySchedule(t, state.pendingOrders ?? [], nowAbs, 1)[0] - nowAbs,
      });
    }
    return out.sort((x, y) => y.fit.length - x.fit.length
      || Math.abs((x.t.seats ?? 0) - avgSeats) - Math.abs((y.t.seats ?? 0) - avgSeats));
  }, [state, tails]);

  const q = query.trim().toLowerCase();
  const shown = rows.filter(r => !q || `${r.t.manufacturer} ${r.t.name} ${r.t.category}`.toLowerCase().includes(q));
  const typeNames = [...new Set(tails.map(a => getAircraftType(a.typeId)?.name).filter(Boolean))];

  if (checkout) {
    return (
      <AircraftCheckout
        typeId={checkout.typeId}
        mode={checkout.mode}
        replaceIds={checkout.ids}
        onOrdered={() => { onOrdered?.(); onClose(); }}
        onClose={() => setCheckout(null)}
      />
    );
  }

  return (
    <div className="saveload-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="saveload-modal" style={{ width: 'min(720px, 96vw)' }}>
        <div className="saveload-header">
          <h2 style={{ margin: 0, fontSize: 17 }}>Replace {tails.length} aircraft</h2>
          <button className="btn" onClick={onClose}><Glyph e="✕" /></button>
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-dim)', margin: '4px 0 12px', lineHeight: 1.5 }}>
          Order new aircraft to take over from your {typeNames.slice(0, 3).join(', ')}{typeNames.length > 3 ? ` and ${typeNames.length - 3} more types` : ''}.
          Each new one takes over one old aircraft's routes the week it arrives, oldest first — same frequencies, fares
          and maturity. "Fits" counts the selected aircraft each type can take over like-for-like: range, runways,
          airport rules and weekly block hours.
        </p>
        <input
          className="input" placeholder="Search types…" value={query} onChange={e => setQuery(e.target.value)}
          style={{ width: '100%', marginBottom: 10, padding: '6px 10px', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)' }}
        />
        {rows.length === 0 && (
          <div style={{ fontSize: 13, color: 'var(--text-dim)', fontStyle: 'italic' }}>
            Nothing on the market can take over these aircraft's routes as they stand.
          </div>
        )}
        <div style={{ maxHeight: '56vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {shown.map(({ t, fit, price, lease, leaseBlock, firstIn }) => {
            const seatDelta = t.freighter ? null : Math.round((t.seats ?? 0) - avgSeats);
            const all = fit.length === tails.length;
            return (
              <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>
                    {t.name}
                    <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}> · {t.manufacturer} · {t.category}</span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    <span style={{ color: all ? 'var(--green)' : 'var(--yellow)', fontWeight: 600 }}>Fits {fit.length} of {tails.length}</span>
                    {' · '}{t.freighter ? `${t.payloadTonnes}t` : `${t.seats} seats`}
                    {seatDelta != null && seatDelta !== 0 && ` (${seatDelta > 0 ? '+' : ''}${seatDelta} each)`}
                    {' · '}{t.range.toLocaleString()} km{firstIn != null && ` · first delivery ${firstIn}w`}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                    {formatMoney(price)} each · or {formatMoney(lease)}/wk leased
                  </div>
                </div>
                <button className="btn btn-primary" style={{ fontSize: 12, padding: '4px 10px', opacity: leaseBlock ? 0.4 : 1 }}
                  disabled={!!leaseBlock} title={leaseBlock ?? undefined}
                  onClick={() => setCheckout({ typeId: t.id, mode: 'lease', ids: fit.map(a => a.id) })}>
                  Lease {fit.length}
                </button>
                <button className="btn" style={{ fontSize: 12, padding: '4px 10px', background: 'rgba(63,185,80,0.15)', color: 'var(--green)', border: '1px solid rgba(63,185,80,0.4)' }}
                  onClick={() => setCheckout({ typeId: t.id, mode: 'buy', ids: fit.map(a => a.id) })}>
                  Buy {fit.length}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
