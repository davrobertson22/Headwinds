// Used Market — the used aircraft market (Headwinds multiplayer only).
// ----------------------------------------------------------------------------
// The game is the counterparty on both sides. When any airline sells an owned
// jet (Fleet ▸ Sell) it's paid NAV − 5% instantly and that exact tail lands here
// at NAV — cheaper than new (it's depreciated) and with no factory wait: a used
// purchase arrives on the NEXT weekly tick, carrying the jet's real age, cabin
// and engines. The 5% spread is the house's cut. A listing unsold for two game-
// years is scrapped.
//
// Inventory is fetched from GET /worlds/:id/used-aircraft (remoteApi.fetchUsedAircraft)
// rather than injected into state, so this whole feature is inert in solo.
//
// Bulk buy: "add checkboxes next to aircraft so you can tag a number and then bulk
// purchase. On a laggy(er) server, it takes minutes rather than seconds to buy
// aircraft" (VodkaOnFire, Discord 2026-10-25). Tick rows (shift-click ticks a
// range), and one request buys them all (remoteApi.buyUsedAircraftBatch → POST
// /worlds/:id/used-aircraft/buy). Any the server can't sell you — bought out from
// under you, or past your cash — are skipped and named; the rest go through.
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useGame } from '../store/GameContext.jsx';
import { useToast } from './ToastSystem.jsx';
import { formatMoney } from '../utils/simulation.js';
import { GlyphLabel } from './Icons.jsx';
import { ownedFamilyIds, usedListingPasses, normalizeMaxAge } from '../utils/marketFilters.js';

// "Add slider/box/similar to filter out aircraft older than X years in market"
// and "Add 'Owned by you' filter to airliner market" (VodkaOnFire, Discord
// 2026-10-21). Here the age is the airframe's own; the families are the ones
// you fly or have on order (utils/marketFilters.js). Per-browser, like the
// Market's own chips.
const FILTERS_KEY = 'hw_used_market_filters';
function loadUsedFilters() {
  try {
    const v = JSON.parse(localStorage.getItem(FILTERS_KEY) ?? 'null');
    return { maxAge: normalizeMaxAge(v?.maxAge), yourFamilies: !!v?.yourFamilies };
  } catch { return { maxAge: null, yourFamilies: false }; }
}

const fmtAge = (weeks) => {
  const yrs = (weeks ?? 0) / 52;
  if (yrs < 0.1) return 'new';
  if (yrs < 1) return `${Math.round((weeks ?? 0))} wk`;
  return `${yrs.toFixed(1)} yr`;
};

// The most one bulk purchase may name — the server's USED_BATCH_MAX
// (apps/headwinds-server/src/lib/aircraftMarketService.mjs).
export const USED_BATCH_MAX = 50;

const SORTS = {
  price: { label: 'Price',    fn: (a, b) => (a.price ?? 0) - (b.price ?? 0) },
  age:   { label: 'Age',      fn: (a, b) => (a.ageWeeks ?? 0) - (b.ageWeeks ?? 0) },
  type:  { label: 'Type',     fn: (a, b) => (a.typeName ?? '').localeCompare(b.typeName ?? '') },
  seats: { label: 'Seats',    fn: (a, b) => (b.seats ?? 0) - (a.seats ?? 0) },
};

// initialListings / initialSelected are for server-side render tests only: the
// live market is fetched in an effect, which a server render never runs.
export default function UsedMarket({ initialListings = null, initialSelected = null } = {}) {
  const { state, remote, remoteApi } = useGame();
  const addToast = useToast();
  const [listings, setListings] = useState(() => initialListings ?? []);
  const [loading, setLoading]   = useState(() => initialListings == null);
  const [error, setError]       = useState(null);
  const [busyId, setBusyId]     = useState(null);   // a listing id, or 'batch'
  const [selected, setSelected] = useState(() => new Set(initialSelected ?? []));
  const lastTicked = useRef(null);
  const [sortKey, setSortKey]   = useState('price');
  const [filters, setFiltersState] = useState(loadUsedFilters);
  function setFilters(patch) {
    setFiltersState(prev => {
      const next = { ...prev, ...patch, maxAge: normalizeMaxAge(patch.maxAge !== undefined ? patch.maxAge : prev.maxAge) };
      try { localStorage.setItem(FILTERS_KEY, JSON.stringify(next)); } catch { /* private mode */ }
      return next;
    });
  }
  const ownedFamilies = useMemo(() => ownedFamilyIds(state.fleet, state.pendingOrders), [state.fleet, state.pendingOrders]);

  const canUse = remote && typeof remoteApi?.fetchUsedAircraft === 'function';
  const canBatch = canUse && typeof remoteApi?.buyUsedAircraftBatch === 'function';

  // A listing that has left the market (bought, scrapped) can't stay ticked.
  useEffect(() => {
    setSelected(prev => {
      if (prev.size === 0) return prev;
      const live = new Set(listings.map(l => l.id));
      const next = new Set([...prev].filter(id => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [listings]);

  const refresh = useCallback(async () => {
    if (!canUse) { setLoading(false); return; }
    try {
      const res = await remoteApi.fetchUsedAircraft();
      setListings(Array.isArray(res?.listings) ? res.listings : []);
      setError(null);
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [canUse, remoteApi]);

  useEffect(() => { refresh(); }, [refresh]);

  const buy = useCallback(async (l) => {
    if (busyId) return;
    setBusyId(l.id);
    try {
      const res = await remoteApi.buyUsedAircraft(l.id);
      // The buyer's new state (cash paid) is adopted in GamePlayScreen; refresh
      // the shop from the response so the bought tail disappears immediately.
      if (Array.isArray(res?.usedMarket?.listings)) setListings(res.usedMarket.listings);
      else await refresh();
      addToast({
        type: 'success',
        title: 'Used aircraft purchased',
        message: `${l.typeName} bought for ${formatMoney(l.price)} — it arrives next week.`,
        icon: '✈',
        duration: 6000,
      });
    } catch (e) {
      addToast({ type: 'error', title: 'Purchase failed', message: e?.message || String(e), duration: 6000 });
      refresh();
    } finally {
      setBusyId(null);
    }
  }, [busyId, remoteApi, refresh, addToast]);

  const buyBatch = useCallback(async (rows) => {
    if (busyId || rows.length === 0) return;
    setBusyId('batch');
    try {
      const res = await remoteApi.buyUsedAircraftBatch(rows.map(l => l.id));
      if (Array.isArray(res?.usedMarket?.listings)) setListings(res.usedMarket.listings);
      else await refresh();
      const bought = Array.isArray(res?.bought) ? res.bought : [];
      const skipped = Array.isArray(res?.skipped) ? res.skipped : [];
      const spent = bought.reduce((sum, b) => sum + (b.price ?? 0), 0);
      setSelected(new Set());
      lastTicked.current = null;
      addToast({
        type: 'success',
        title: `${bought.length} used aircraft purchased`,
        message: `${formatMoney(spent)} spent — ${bought.length === 1 ? 'it arrives' : 'they arrive'} next week.`,
        icon: '✈',
        duration: 6000,
      });
      if (skipped.length > 0) {
        addToast({
          type: 'warning',
          title: `${skipped.length} not bought`,
          message: skipped.slice(0, 4).map(k => `${k.typeName ?? 'Aircraft'}: ${k.reason}`).join(' ')
            + (skipped.length > 4 ? ` …and ${skipped.length - 4} more.` : ''),
          duration: 9000,
        });
      }
    } catch (e) {
      addToast({ type: 'error', title: 'Purchase failed', message: e?.message || String(e), duration: 6000 });
      refresh();
    } finally {
      setBusyId(null);
    }
  }, [busyId, remoteApi, refresh, addToast]);

  if (!remote) {
    return (
      <div className="card" style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>
        The used aircraft market is a Headwinds (multiplayer) feature — aircraft other airlines
        sell show up here to buy secondhand.
      </div>
    );
  }

  const visible = listings.filter(l => usedListingPasses(l, filters, ownedFamilies));
  const sorted = [...visible].sort(SORTS[sortKey].fn);
  const hidden = listings.length - visible.length;

  // Selection: only what's on screen counts — a ticked jet the filters now hide is
  // never bought behind the player's back. Bought in the order shown, so if cash
  // runs short the server skips from the bottom of the list the player is looking at.
  const cash = state.cash ?? 0;
  const tickable = (l) => l.price <= cash;
  const chosen = sorted.filter(l => selected.has(l.id));
  const chosenTotal = chosen.reduce((sum, l) => sum + (l.price ?? 0), 0);
  const shortBy = Math.max(0, chosenTotal - cash);
  const pageTickable = sorted.filter(tickable).slice(0, USED_BATCH_MAX);
  const allTicked = pageTickable.length > 0 && pageTickable.every(l => selected.has(l.id));
  const busy = busyId != null;

  const toggleRow = (l, index, shiftKey) => {
    setSelected(prev => {
      const next = new Set(prev);
      const on = !prev.has(l.id);
      // Shift-click: tick (or untick) every row between the last one clicked and this.
      const from = shiftKey && lastTicked.current != null ? Math.min(lastTicked.current, index) : index;
      const to   = shiftKey && lastTicked.current != null ? Math.max(lastTicked.current, index) : index;
      for (let i = from; i <= to; i++) {
        const row = sorted[i];
        if (!row || !tickable(row)) continue;
        if (on) { if (next.size < USED_BATCH_MAX) next.add(row.id); }
        else next.delete(row.id);
      }
      return next;
    });
    lastTicked.current = index;
  };
  const toggleAll = () => {
    setSelected(prev => {
      if (allTicked) {
        const next = new Set(prev);
        for (const l of pageTickable) next.delete(l.id);
        return next;
      }
      const next = new Set(chosen.map(l => l.id));
      for (const l of pageTickable) { if (next.size >= USED_BATCH_MAX) break; next.add(l.id); }
      return next;
    });
    lastTicked.current = null;
  };
  const chip = (on) => ({
    display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0,
    padding: '3px 10px', borderRadius: 20, fontSize: 11.5, whiteSpace: 'nowrap', cursor: 'pointer',
    border: on ? '1px solid var(--accent)' : '1px solid var(--border)',
    background: on ? 'rgba(56,139,253,0.15)' : 'var(--surface2)',
    color: on ? 'var(--accent)' : 'var(--text-muted)',
  });

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
        <div style={{
          fontWeight: 700, fontSize: 13, color: 'var(--text-muted)',
          textTransform: 'uppercase', letterSpacing: '0.06em', flex: 1,
        }}>
          Used aircraft {listings.length > 0 && <span style={{ color: 'var(--text-dim)' }}>· {visible.length}{hidden > 0 ? ` of ${listings.length}` : ''}</span>}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {ownedFamilies.size > 0 && (
            <button
              type="button"
              data-used-filter="yourFamilies"
              aria-pressed={filters.yourFamilies}
              title="Show only the families you already fly or have on order"
              style={chip(filters.yourFamilies)}
              onClick={() => setFilters({ yourFamilies: !filters.yourFamilies })}
            >
              {filters.yourFamilies ? '✓ ' : ''}Your families
            </button>
          )}
          <label style={chip(filters.maxAge != null)} title="Hide airframes older than this many years. Leave blank for any age.">
            Up to
            <input
              type="number"
              min={0}
              max={60}
              data-used-max-age=""
              placeholder="any"
              value={filters.maxAge ?? ''}
              onChange={e => setFilters({ maxAge: e.target.value })}
              aria-label="Hide airframes older than this many years"
              style={{
                width: 44, padding: '1px 4px', fontSize: 11.5, textAlign: 'center',
                background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 10,
              }}
            />
            yrs old
          </label>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {Object.entries(SORTS).map(([k, s]) => (
            <button
              key={k}
              className="btn btn-ghost"
              style={{
                fontSize: 11.5, padding: '3px 10px',
                color: sortKey === k ? 'var(--accent)' : 'var(--text-muted)',
                borderColor: sortKey === k ? 'var(--accent)' : 'var(--border)',
              }}
              onClick={() => setSortKey(k)}
            >{s.label}</button>
          ))}
          <button className="btn btn-ghost" style={{ fontSize: 11.5, padding: '3px 10px' }} onClick={refresh}>↻</button>
        </div>
      </div>

      {canBatch && chosen.length > 0 && (
        <div
          data-used-bulk-bar=""
          className="card"
          style={{
            display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
            padding: '8px 14px', marginBottom: 8, fontSize: 12.5,
            border: '1px solid var(--accent)', background: 'rgba(56,139,253,0.08)',
          }}
        >
          <div style={{ flex: 1, minWidth: 180 }}>
            <strong>{chosen.length} selected</strong> · {formatMoney(chosenTotal)}
            {shortBy > 0 && (
              <span data-used-bulk-short="" style={{ color: 'var(--red)', marginLeft: 6 }}>
                — {formatMoney(shortBy)} more than your cash
              </span>
            )}
          </div>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ fontSize: 11.5, padding: '4px 10px' }}
            disabled={busy}
            onClick={() => { setSelected(new Set()); lastTicked.current = null; }}
          >Clear</button>
          <button
            type="button"
            data-used-bulk-buy=""
            className="btn btn-primary"
            style={{ fontSize: 11.5, padding: '4px 12px' }}
            disabled={busy || shortBy > 0}
            title={shortBy > 0 ? 'Not enough cash for all of these' : 'All deliver on the next weekly tick'}
            onClick={() => buyBatch(chosen)}
          >
            {busyId === 'batch' ? 'Buying…' : `Buy ${chosen.length} used`}
          </button>
        </div>
      )}

      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 620 }}>
          <thead>
            <tr style={{ color: 'var(--text-muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {canBatch && (
                <th style={{ width: 34, padding: '10px 0 10px 14px' }}>
                  <input
                    type="checkbox"
                    data-used-select-all=""
                    aria-label={`Select every affordable aircraft shown (up to ${USED_BATCH_MAX})`}
                    title={`Select every aircraft shown that you can afford (up to ${USED_BATCH_MAX})`}
                    checked={allTicked}
                    disabled={busy || pageTickable.length === 0}
                    onChange={toggleAll}
                  />
                </th>
              )}
              <th style={{ textAlign: 'left',  padding: '10px 14px' }}>Aircraft</th>
              <th style={{ textAlign: 'left',  padding: '10px 8px'  }}>Category</th>
              <th style={{ textAlign: 'right', padding: '10px 8px'  }}>Age</th>
              <th style={{ textAlign: 'right', padding: '10px 8px'  }}>Seats</th>
              <th style={{ textAlign: 'right', padding: '10px 8px'  }}>Price</th>
              <th style={{ textAlign: 'right', padding: '10px 14px' }}></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((l, index) => {
              const affordable = cash >= l.price;
              const ticked = selected.has(l.id);
              const full = !ticked && selected.size >= USED_BATCH_MAX;
              return (
                <tr
                  key={l.id}
                  style={{ borderTop: '1px solid var(--border)', background: ticked ? 'rgba(56,139,253,0.06)' : undefined }}
                >
                  {canBatch && (
                    <td style={{ padding: '9px 0 9px 14px' }}>
                      <input
                        type="checkbox"
                        data-used-select={l.id}
                        aria-label={`Select ${l.typeName}`}
                        title={!affordable ? 'Not enough cash'
                          : full ? `At most ${USED_BATCH_MAX} at once`
                          : 'Select to buy several at once (shift-click selects a range)'}
                        checked={ticked}
                        disabled={busy || !affordable || full}
                        onChange={(e) => toggleRow(l, index, !!e.nativeEvent?.shiftKey)}
                      />
                    </td>
                  )}
                  <td style={{ padding: '9px 14px' }}>
                    <div style={{ fontWeight: 600 }}>{l.typeName}</div>
                    <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                      {l.origin ? `ex-${l.origin}` : 'ex-operator'}{l.engineLabel ? ` · ${l.engineLabel}` : ''}
                    </div>
                  </td>
                  <td style={{ padding: '9px 8px', color: 'var(--text-muted)', fontSize: 12 }}>{l.category ?? '—'}</td>
                  <td style={{ textAlign: 'right', padding: '9px 8px' }}>{fmtAge(l.ageWeeks)}</td>
                  <td style={{ textAlign: 'right', padding: '9px 8px' }}>{l.seats ?? '—'}</td>
                  <td style={{ textAlign: 'right', padding: '9px 8px', fontWeight: 600 }}>{formatMoney(l.price)}</td>
                  <td style={{ textAlign: 'right', padding: '9px 14px', whiteSpace: 'nowrap' }}>
                    <button
                      className="btn btn-primary"
                      style={{ fontSize: 11.5, padding: '4px 12px' }}
                      disabled={!affordable || busy}
                      title={affordable ? 'Delivers on the next weekly tick' : 'Not enough cash'}
                      onClick={() => buy(l)}
                    >
                      {busyId === l.id ? 'Buying…' : 'Buy used'}
                    </button>
                  </td>
                </tr>
              );
            })}
            {sorted.length === 0 && (
              <tr><td colSpan={canBatch ? 7 : 6} style={{ padding: 22, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12.5 }}>
                {loading ? 'Loading the market…'
                  : error ? `Couldn't load the market: ${error}`
                  : hidden > 0 ? `${hidden} used aircraft on the market, none matching your filters.`
                  : 'No used aircraft on the market right now. When an airline sells an owned jet, it appears here at its depreciated value — cheaper than new and delivered in a week.'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 10, lineHeight: 1.6 }}>
        <GlyphLabel size={11} text={
          'ℹ Used aircraft come from other airlines selling their fleet. Tick several to buy them in one go. You buy at the jet\'s depreciated value (NAV) — cheaper than a new order — and it arrives on the next weekly tick, carrying its real age, cabin and engines (so it costs a little more to maintain and has less life left). '
          + 'Selling any owned jet (Fleet ▸ Sell) pays you NAV − 5% instantly and lists it here for others. A jet bought here never sells back, or borrows, for more than you paid for it.'
        } />
      </div>
    </div>
  );
}
