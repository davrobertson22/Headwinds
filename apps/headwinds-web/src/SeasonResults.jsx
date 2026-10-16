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
import { SeasonSupportPrompt } from './SupportCard.jsx';

const fmtSvps = (n) => n == null ? '—'
  : Math.abs(n) >= 100 ? `$${Math.round(n).toLocaleString('en-US')}`
  : `$${Number(n).toFixed(2)}`;
const fmtInt = (n) => (n == null ? '—' : Math.round(n).toLocaleString('en-US'));
// Average weekly net profit over the final 52 weeks — the title metric since
// the 2026-10-15 rankings rework. Seasons decided before it carry SVPS only.
const fmtAvgProfit = (n) => {
  if (n == null) return '—';
  const abs = Math.abs(n);
  const body = abs >= 1e9 ? `$${(abs / 1e9).toFixed(2)}B` : abs >= 1e6 ? `$${(abs / 1e6).toFixed(2)}M`
    : abs >= 1e3 ? `$${Math.round(abs / 1e3)}k` : `$${Math.round(abs)}`;
  return `${n < 0 ? '−' : ''}${body}/wk`;
};

const MEDAL = ['🥇', '🥈', '🥉'];

export default function SeasonResults({ worldId, token, myAirlineId = null, preloaded = null, me = null }) {
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
  // Which rule decided this season: the payload says so (`ranking.metric`);
  // without it, a podium carrying avgProfit means the new rule.
  const byProfit = data.ranking?.metric
    ? data.ranking.metric !== 'svps'
    : (awards?.podium ?? []).some((p) => p.avgProfit != null);
  const metricLabel = byProfit ? 'Avg profit (final 52 wks)' : 'SVPS';
  const metricOf = (p) => (byProfit ? fmtAvgProfit(p.avgProfit) : fmtSvps(p.svps));

  // Podium: the banked award payload if present, else the top of the final
  // standings. Both carry name + accountId + svps, so the render is identical.
  const podium = awards?.podium?.length
    ? awards.podium
    : standings.slice(0, 3).map((a) => ({
        rank: a.rank, airlineId: a.id, accountId: a.accountId, name: a.name, svps: a.svps,
        avgProfit: a.avgProfit ?? null,
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
                <div className="muted small">{byProfit ? `${metricOf(p)} average` : `SVPS ${metricOf(p)}`}</div>
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
            <thead><tr><th>#</th><th>Airline</th><th>Hub</th><th>{metricLabel}</th></tr></thead>
            <tbody>
              {standings.map((a) => (
                <tr key={a.id} className={myAirlineId === a.id ? 'me-row' : ''}>
                  <td>{a.rank}</td>
                  <td>{nameLink(a.accountId, a.name)}{myAirlineId === a.id ? <span className="muted"> (you)</span> : null}</td>
                  <td>{a.hub}</td>
                  <td>{metricOf(a)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      <p className="muted small" style={{ marginTop: 8 }}>
        {byProfit && 'The title goes to the highest average weekly net profit over the final 52 weeks. '}
        Passengers, network and #1-week records above are banked to each player's career.
      </p>

      {/* The one moment in the whole game worth asking at: a season they just
          finished, and the servers that ran it for seven months. */}
      <SeasonSupportPrompt me={me} />
    </div>
  );
}
