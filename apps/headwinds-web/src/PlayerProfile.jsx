// A player's public profile — the account behind the airlines.
//
// Reached from anywhere a player's name appears: the world standings, the
// in-game rival dossier, your own Career panel. Everything rendered here is
// the SERVER's public view — private worlds are absent from the payload
// itself, and finished seasons carry only a podium place or nothing — so
// there is deliberately nothing for this component to hide. See
// PLAYER_PROFILES_PLAN.md.
import { useEffect, useState } from 'react';
import { api } from './api.js';
import OgBadge, { DevBadge } from './OgBadge.jsx';

const fmtNum = (n) => Math.round(Number(n) || 0).toLocaleString();

function fmtPax(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`;
  if (v >= 1_000) return `${Math.round(v / 1000)}k`;
  return String(Math.round(v));
}

const fmtDate = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
};

// Podium places are the only finishes a profile shows — everything else is
// "Played" (the server never even sends lower ranks).
const PLACE = {
  1: { icon: '🏆', label: '1st' },
  2: { icon: '🥈', label: '2nd' },
  3: { icon: '🥉', label: '3rd' },
};

const chipStyle = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '4px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600,
  background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.14)',
};

function Figure({ label, value }) {
  return (
    <div>
      <div className="muted small">{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, lineHeight: 1.2 }}>{value}</div>
    </div>
  );
}

export default function PlayerProfileScreen({ accountId, token, onClose = null }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!token) return undefined;
    let alive = true;
    setData(null); setError(null);
    api(`/players/${accountId}`, { token })
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setError(e); });
    return () => { alive = false; };
  }, [accountId, token]);

  if (!token) {
    return <div className="card"><p className="muted">Sign in above to view player profiles.</p></div>;
  }
  if (error) {
    return (
      <div className="card">
        <p className="muted">
          {error?.status === 404
            ? 'No such player.'
            : 'Could not load this profile — try again in a moment.'}
        </p>
        {onClose
          ? <button className="btn small" onClick={onClose}>Close</button>
          : <a href="#/">← Back to worlds</a>}
      </div>
    );
  }
  if (!data) return <p className="muted">Loading profile…</p>;

  return <PlayerProfileView data={data} onClose={onClose} />;
}

// The pure rendering half — exported so the test suite can SSR it with a
// fixture payload (the screen's data arrives via fetch, which SSR never runs).
export function PlayerProfileView({ data, onClose = null }) {
  const { player, badges = [], trophies = [], totals, seasons = [], current = [] } = data;

  return (
    <>
      <section className="card">
        <div className="row" style={{ alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0 }}>{player.displayName}</h2>
          {player.dev ? <DevBadge /> : null}
          {player.isOG ? <OgBadge /> : null}
        </div>
        {fmtDate(player.memberSince) && (
          <p className="muted small" style={{ marginTop: 4 }}>
            Flying since {fmtDate(player.memberSince)}
          </p>
        )}
        {badges.length > 0 && (
          <div className="row wrap" style={{ gap: 8, marginTop: 10 }}>
            {badges.map((b) => (
              <span key={b.id} title={b.description} style={chipStyle}>
                <span aria-hidden="true">{b.icon}</span>{b.label}
              </span>
            ))}
          </div>
        )}
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h3 style={{ marginTop: 0 }}>Trophy case</h3>
        {trophies.length === 0 ? (
          <p className="muted">No trophies yet — seasons are long.</p>
        ) : (
          <div className="row wrap" style={{ gap: 12 }}>
            {trophies.map((t) => (
              <div
                key={t.worldId}
                style={{ border: '1px solid rgba(255,255,255,.14)', borderRadius: 10,
                         padding: '10px 14px', minWidth: 180 }}
              >
                <div style={{ fontSize: 22 }} aria-hidden="true">{PLACE[t.place]?.icon}</div>
                <div style={{ fontWeight: 700 }}>
                  {PLACE[t.place]?.label} · {t.worldName ?? 'Unnamed world'}
                </div>
                <div className="muted small">
                  {t.airlineName ?? '—'}
                  {fmtDate(t.endedAt) ? ` · ${fmtDate(t.endedAt)}` : ''}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h3 style={{ marginTop: 0 }}>Currently flying</h3>
        {current.length === 0 ? (
          <p className="muted">Not flying in any public world right now.</p>
        ) : (
          <table className="worlds">
            <thead>
              <tr><th>Airline</th><th>Hub</th><th>World</th><th>Week</th><th>Rank</th></tr>
            </thead>
            <tbody>
              {current.map((c) => (
                <tr key={c.airlineId}>
                  <td>
                    {c.airlineName}
                    {c.status && c.status !== 'ACTIVE'
                      ? <span className="muted small"> · {String(c.status).toLowerCase()}</span>
                      : null}
                  </td>
                  <td>{c.hub}</td>
                  <td>
                    <a href={`#/w/${c.worldId}`}>{c.worldName ?? 'World'}</a>
                    {c.worldStatus === 'LOBBY' ? <span className="muted small"> · lobby</span> : null}
                  </td>
                  <td>{c.week ?? '—'}</td>
                  <td>{c.rank ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {totals && totals.worldsFinished > 0 ? (
        <section className="card" style={{ marginTop: 16 }}>
          <h3 style={{ marginTop: 0 }}>Career</h3>
          <div
            style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))',
                     gap: 16, paddingBottom: 14 }}
          >
            <Figure label="Seasons finished" value={fmtNum(totals.worldsFinished)} />
            <Figure label="Championships" value={fmtNum(totals.championships)} />
            <Figure label="Podiums" value={fmtNum(totals.podiums)} />
            <Figure label="Passengers carried" value={fmtPax(totals.lifetimePassengers)} />
            <Figure label="Weeks flown" value={fmtNum(totals.weeksPlayed)} />
          </div>

          <div className="list-head">
            <span>Season</span>
            <span>Airline</span>
            <span>Finish</span>
          </div>
          {seasons.map((w) => (
            <div key={w.worldId} className="row" style={{ padding: '6px 0', gap: 12 }}>
              <span style={{ flex: 1 }}>
                {w.worldName ?? 'Unnamed world'}
                {w.lengthYears ? <span className="muted small"> · {w.lengthYears}y</span> : null}
                {fmtDate(w.endedAt) ? <span className="muted small"> · {fmtDate(w.endedAt)}</span> : null}
              </span>
              <span style={{ flex: 1 }}>
                {w.airlineName ?? '—'}
                {w.hub ? <span className="muted small"> · {w.hub}</span> : null}
              </span>
              <span style={{ flex: 1 }}>
                {w.place != null
                  ? <><span aria-hidden="true">{PLACE[w.place]?.icon}</span> {PLACE[w.place]?.label}</>
                  : <span className="muted">Played</span>}
              </span>
            </div>
          ))}
        </section>
      ) : (
        <p className="muted small" style={{ marginTop: 16 }}>
          No finished seasons yet — results are banked when a world ends.
        </p>
      )}

      <p style={{ marginTop: 16 }}>
        {/* In the lobby this is a normal route; in the in-game overlay the
            page must close, not navigate the shell away from the game. */}
        {onClose
          ? <button className="btn small" onClick={onClose}>Close</button>
          : <a href="#/">← Back to worlds</a>}
      </p>
    </>
  );
}
