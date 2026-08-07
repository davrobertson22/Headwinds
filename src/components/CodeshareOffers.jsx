import { useCallback, useEffect, useState } from 'react';
import { Glyph } from './Icons.jsx';

/**
 * Codeshare offers, in and out.
 *
 * The panel that makes a codeshare a deal. Before this the Alliances tab had a
 * "Sign" button that bound a real player to an agreement they were never told
 * about; there was nowhere for an offer to sit, because there were no offers.
 *
 * Multiplayer only — solo has nobody to ask, so Alliances.jsx does not render
 * it there.
 */
export default function CodeshareOffers({ remoteApi, refreshKey = 0, onChanged }) {
  const [data, setData]   = useState(null);
  const [busy, setBusy]   = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    if (!remoteApi?.fetchCodeshares) return;
    remoteApi.fetchCodeshares().then(setData).catch(setError);
  }, [remoteApi]);

  useEffect(() => {
    load();
    // An offer arrives from another player, not from anything this client did,
    // so it needs a poll — the same 15s cadence the alliance roster uses.
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load, refreshKey]);

  async function decide(offer, decision) {
    setBusy(offer.id); setError(null);
    try {
      await remoteApi.decideCodeshareOffer(offer.id, decision);
      await load();
      onChanged?.();
    } catch (e) { setError(e); }
    setBusy(null);
  }

  const incoming = data?.incoming ?? [];
  const outgoing = data?.outgoing ?? [];
  if (!error && incoming.length === 0 && outgoing.length === 0) return null;

  return (
    <div style={{ marginBottom: 16 }}>
      {error && (
        <div style={{ fontSize: 12, color: '#f87171', marginBottom: 8 }}>
          <Glyph e="✗" /> {String(error.message || error)}
        </div>
      )}

      {incoming.length > 0 && (
        <>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8, fontWeight: 600 }}>
            OFFERS TO YOU ({incoming.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
            {incoming.map((o) => (
              <div key={o.id} className="card"
                   style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{o.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {o.hub ? `Hub: ${o.hub} · ` : ''}wants to codeshare
                    {o.status && o.status !== 'ACTIVE'
                      ? <span style={{ color: 'var(--yellow)' }}> · {o.status.toLowerCase()}</span>
                      : null}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn btn-primary" style={{ fontSize: 11, padding: '4px 12px' }}
                          disabled={busy === o.id} onClick={() => decide(o, 'accept')}>
                    Accept
                  </button>
                  <button className="btn" style={{ fontSize: 11, padding: '4px 10px' }}
                          disabled={busy === o.id} onClick={() => decide(o, 'reject')}>
                    Decline
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {outgoing.length > 0 && (
        <>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8, fontWeight: 600 }}>
            AWAITING A REPLY ({outgoing.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
            {outgoing.map((o) => (
              <div key={o.id} className="card"
                   style={{ padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 12, fontSize: 12 }}>
                <span style={{ flex: 1 }}>
                  <strong>{o.name}</strong>
                  <span style={{ color: 'var(--text-muted)' }}>
                    {' '}— offered week {o.offeredWeek}, lapses week {o.expiresWeek}
                  </span>
                </span>
                <button className="btn" style={{ fontSize: 11, padding: '4px 10px' }}
                        disabled={busy === o.id} onClick={() => decide(o, 'withdraw')}>
                  Withdraw
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
