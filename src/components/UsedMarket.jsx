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
import { useState, useEffect, useCallback } from 'react';
import { useGame } from '../store/GameContext.jsx';
import { useToast } from './ToastSystem.jsx';
import { formatMoney } from '../utils/simulation.js';
import { GlyphLabel } from './Icons.jsx';

const fmtAge = (weeks) => {
  const yrs = (weeks ?? 0) / 52;
  if (yrs < 0.1) return 'new';
  if (yrs < 1) return `${Math.round((weeks ?? 0))} wk`;
  return `${yrs.toFixed(1)} yr`;
};

const SORTS = {
  price: { label: 'Price',    fn: (a, b) => (a.price ?? 0) - (b.price ?? 0) },
  age:   { label: 'Age',      fn: (a, b) => (a.ageWeeks ?? 0) - (b.ageWeeks ?? 0) },
  type:  { label: 'Type',     fn: (a, b) => (a.typeName ?? '').localeCompare(b.typeName ?? '') },
  seats: { label: 'Seats',    fn: (a, b) => (b.seats ?? 0) - (a.seats ?? 0) },
};

export default function UsedMarket() {
  const { state, remote, remoteApi } = useGame();
  const addToast = useToast();
  const [listings, setListings] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [busyId, setBusyId]     = useState(null);
  const [sortKey, setSortKey]   = useState('price');

  const canUse = remote && typeof remoteApi?.fetchUsedAircraft === 'function';

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

  if (!remote) {
    return (
      <div className="card" style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>
        The used aircraft market is a Headwinds (multiplayer) feature — aircraft other airlines
        sell show up here to buy secondhand.
      </div>
    );
  }

  const sorted = [...listings].sort(SORTS[sortKey].fn);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
        <div style={{
          fontWeight: 700, fontSize: 13, color: 'var(--text-muted)',
          textTransform: 'uppercase', letterSpacing: '0.06em', flex: 1,
        }}>
          Used aircraft {listings.length > 0 && <span style={{ color: 'var(--text-dim)' }}>· {listings.length}</span>}
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

      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 620 }}>
          <thead>
            <tr style={{ color: 'var(--text-muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              <th style={{ textAlign: 'left',  padding: '10px 14px' }}>Aircraft</th>
              <th style={{ textAlign: 'left',  padding: '10px 8px'  }}>Category</th>
              <th style={{ textAlign: 'right', padding: '10px 8px'  }}>Age</th>
              <th style={{ textAlign: 'right', padding: '10px 8px'  }}>Seats</th>
              <th style={{ textAlign: 'right', padding: '10px 8px'  }}>Price</th>
              <th style={{ textAlign: 'right', padding: '10px 14px' }}></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((l) => {
              const affordable = (state.cash ?? 0) >= l.price;
              return (
                <tr key={l.id} style={{ borderTop: '1px solid var(--border)' }}>
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
                      disabled={!affordable || busyId != null}
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
              <tr><td colSpan={6} style={{ padding: 22, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12.5 }}>
                {loading ? 'Loading the market…'
                  : error ? `Couldn't load the market: ${error}`
                  : 'No used aircraft on the market right now. When an airline sells an owned jet, it appears here at its depreciated value — cheaper than new and delivered in a week.'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 10, lineHeight: 1.6 }}>
        <GlyphLabel size={11} text={
          'ℹ Used aircraft come from other airlines selling their fleet. You buy at the jet\'s depreciated value (NAV) — cheaper than a new order — and it arrives on the next weekly tick, carrying its real age, cabin and engines (so it costs a little more to maintain and has less life left). '
          + 'Selling any owned jet (Fleet ▸ Sell) pays you NAV − 5% instantly and lists it here for others.'
        } />
      </div>
    </div>
  );
}
