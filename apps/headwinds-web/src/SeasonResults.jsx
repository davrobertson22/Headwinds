// End-of-season ceremony — the honours roll for a world that has reached ENDED.
//
// A ~7-real-month season used to end in silence. This renders the champion, the
// podium, the superlative awards (Iron Throne / Busiest / Biggest Network / Best
// Comeback) and the viewer's own finish. Data comes from GET /worlds/:id, whose
// `seasonAwards` field the final tick banked into a durable world_ended news
// row; if that field is missing (a world that ended before the feature) it
// falls back to the podium it can derive from the final standings.
//
// Used two ways: inline in the lobby WorldScreen (which already holds the
// payload, passed as `preloaded`), and as a dismissible overlay over the frozen
// game in GamePlayScreen (which fetches for itself).
import { useState, useEffect } from 'react';
import { api } from './api.js';

const fmtSvps = (n) => n == null ? '—'
  : Math.abs(n) >= 100 ? `$${Math.round(n).toLocaleString('en-US')}`
  : `$${Number(n).toFixed(2)}`;
const fmtInt = (n) => (n == null ? '—' : Math.round(n).toLocaleString('en-US'));

const MEDAL = ['🥇', '🥈', '🥉'];

export default function SeasonResults({ worldId, token, myAirlineId = null, preloaded = null }) {
  const [data, setData] = useState(preloaded);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (preloaded) { setData(preloaded); return; }
    let alive = true;
    api(`/worlds/${worldId}`, { token })
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e));
    return () => { alive = false; };
  }, [worldId, token, preloaded]);

  if (error) return <div className="card"><p className="error">Couldn't load the final results.</p></div>;
  if (!data) return <div className="card"><p className="muted">Loading the final results…</p></div>;

  const standings = data.standings ?? [];
  const awards = data.seasonAwards ?? null;

  // Podium: the banked award payload if present, else the top of the final
  // standings. Both carry name + accountId + svps, so the render is identical.
  const podium = awards?.podium?.length
    ? awards.podium
    : standings.slice(0, 3).map((a) => ({
        rank: a.rank, airlineId: a.id, accountId: a.accountId, name: a.name, svps: a.svps,
      }));
  const champion = awards?.championName ?? podium[0]?.name ?? null;
  const mine = myAirlineId ? standings.find((a) => a.id === myAirlineId) : null;

  const nameLink = (accountId, name) => accountId
    ? <a href={`#/players/${accountId}`} onClick={(e) => e.stopPropagation()}>{name}</a>
    : name;

  return (
    <div className="card">
      <div style={{ textAlign: 'center', marginBottom: 8 }}>
        <div style={{ fontSize: 30 }} aria-hidden="true">🏁</div>
        <h2 style={{ margin: '4px 0' }}>The season has ended</h2>
        {champion && (
          <p style={{ margin: 0, fontSize: 18 }}>
            <span aria-hidden="true">🏆 </span>Champion: <strong>{nameLink(podium[0]?.accountId, champion)}</strong>
          </p>
        )}
        {mine && (
          <p className="muted" style={{ marginTop: 6 }}>
            You finished <strong>#{mine.rank}</strong> of {standings.length} as {mine.name}.
          </p>
        )}
      </div>

      {podium.length > 0 && (
        <>
          <h4>Podium</h4>
          <div className="row wrap" style={{ gap: 12, marginBottom: 8 }}>
            {podium.slice(0, 3).map((p, i) => (
              <div key={p.airlineId ?? i} className="card" style={{ flex: '1 1 160px', margin: 0, textAlign: 'center' }}>
                <div style={{ fontSize: 24 }} aria-hidden="true">{MEDAL[i] ?? `#${p.rank}`}</div>
                <div><strong>{nameLink(p.accountId, p.name)}</strong></div>
                <div className="muted small">SVPS {fmtSvps(p.svps)}</div>
              </div>
            ))}
          </div>
        </>
      )}

      {(awards?.awards?.length ?? 0) > 0 && (
        <>
          <h4>Season awards</h4>
          <div className="row wrap" style={{ gap: 10, marginBottom: 8 }}>
            {awards.awards.map((a) => (
              <div key={a.id} className="card" style={{ flex: '1 1 200px', margin: 0 }}>
                <div><span aria-hidden="true">{a.icon} </span><strong>{a.label}</strong></div>
                <div>{nameLink(a.accountId, a.name)}</div>
                {a.detail && <div className="muted small">{a.detail}</div>}
              </div>
            ))}
          </div>
        </>
      )}

      {standings.length > 3 && (
        <details>
          <summary className="muted small" style={{ cursor: 'pointer' }}>Final standings ({standings.length})</summary>
          <table className="worlds" style={{ marginTop: 8 }}>
            <thead><tr><th>#</th><th>Airline</th><th>Hub</th><th>SVPS</th></tr></thead>
            <tbody>
              {standings.map((a) => (
                <tr key={a.id} className={myAirlineId === a.id ? 'me-row' : ''}>
                  <td>{a.rank}</td>
                  <td>{nameLink(a.accountId, a.name)}{myAirlineId === a.id ? <span className="muted"> (you)</span> : null}</td>
                  <td>{a.hub}</td>
                  <td>{fmtSvps(a.svps)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      <p className="muted small" style={{ marginTop: 8 }}>
        Passengers, network and #1-week records above are banked to each player's career.
      </p>
    </div>
  );
}
