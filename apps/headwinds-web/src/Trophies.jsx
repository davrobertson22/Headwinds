// Trophy bank + event ranking — the admin side of event worlds.
//
// TrophyBank (Moderation → Trophies): make trophies with their own artwork,
// edit or delete them, see and revoke every award.
// EventRankingPanel (an event world's page, admins only): the ranking — final
// once the world ends — with an "Award" control on every row.
// TrophyCard: one awarded trophy as a public trophy case shows it.
//
// Server: apps/headwinds-server/src/lib/trophies.mjs + routes/trophies.mjs.
import { useCallback, useEffect, useState } from 'react';
import { api, API_BASE } from './api.js';

// The longest edge an uploaded trophy keeps. Artwork is shown at ~96 px, so
// 512 is ample for retina and keeps a PNG in the tens of kB.
export const TROPHY_IMAGE_EDGE = 512;

export const trophyImageSrc = (url) => (url ? `${API_BASE}${url}` : null);

const ordinal = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  const s = ['th', 'st', 'nd', 'rd'];
  const m = v % 100;
  return v + (s[(m - 20) % 10] ?? s[m] ?? s[0]);
};
const fmtMoney = (n) => {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n), a = Math.abs(v);
  const s = a >= 1e9 ? `${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${Math.round(a / 1e3)}k` : String(Math.round(a));
  return `${v < 0 ? '−' : ''}$${s}`;
};

/** Read a picked file, scale it to TROPHY_IMAGE_EDGE, return a PNG data URL. */
export async function fileToTrophyDataUrl(file) {
  const raw = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('Could not read that file'));
    r.readAsDataURL(file);
  });
  // An animated GIF would lose its animation on a canvas — keep it as-is.
  if (file.type === 'image/gif') return raw;
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error('That file is not an image the browser can read'));
    i.src = raw;
  });
  const scale = Math.min(1, TROPHY_IMAGE_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.naturalWidth * scale));
  c.height = Math.max(1, Math.round(img.naturalHeight * scale));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

const imgBox = (size) => ({
  width: size, height: size, objectFit: 'contain', display: 'block',
  borderRadius: 8, background: 'rgba(255,255,255,.04)',
});

function TrophyArt({ url, size = 64, alt = '' }) {
  const src = trophyImageSrc(url);
  if (!src) return <div style={{ ...imgBox(size), display: 'grid', placeItems: 'center', fontSize: size * 0.5 }} aria-hidden="true">🏆</div>;
  return <img src={src} alt={alt} width={size} height={size} style={imgBox(size)} loading="lazy" />;
}

/** One awarded trophy, as the public trophy case shows it. */
export function TrophyCard({ award: a }) {
  return (
    <div style={{ border: '1px solid rgba(255,200,61,.35)', borderRadius: 10, padding: '10px 14px',
                  minWidth: 180, maxWidth: 260, display: 'flex', gap: 12, alignItems: 'center' }}>
      <TrophyArt url={a.imageUrl} size={64} alt={a.name ?? 'Trophy'} />
      <div>
        <div style={{ fontWeight: 700 }}>{a.name ?? 'Trophy'}</div>
        {(a.worldName || a.place) && (
          <div className="small">
            {a.place ? `${ordinal(a.place)} · ` : ''}{a.worldName ?? ''}
          </div>
        )}
        <div className="muted small">
          {[a.airlineName, a.note].filter(Boolean).join(' · ')}
        </div>
        {a.description ? <div className="muted small" style={{ marginTop: 4 }}>{a.description}</div> : null}
      </div>
    </div>
  );
}

// ── The bank ─────────────────────────────────────────────────────────────────

export function TrophyBank({ token }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [image, setImage] = useState(null); // data URL
  const [editing, setEditing] = useState(null); // trophy id

  const [events, setEvents] = useState(null);
  const load = useCallback(() => {
    api('/admin/trophies', { token }).then(setData).catch(setError);
    api('/admin/worlds', { token })
      .then((d) => setEvents((d.worlds ?? []).filter((w) => w.event)))
      .catch(setError);
  }, [token]);
  useEffect(() => { load(); }, [load]);

  const pick = async (e, then) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try { then(await fileToTrophyDataUrl(f)); } catch (err) { setError(err); }
  };

  const create = async (ev) => {
    ev.preventDefault();
    setBusy(true); setError(null);
    try {
      await api('/admin/trophies', { method: 'POST', token, body: { name: name.trim(), description: description.trim() || null, image } });
      setName(''); setDescription(''); setImage(null); load();
    } catch (e) { setError(e); }
    setBusy(false);
  };
  const replaceImage = async (id, dataUrl) => {
    setError(null);
    try { await api(`/admin/trophies/${id}`, { method: 'POST', token, body: { image: dataUrl } }); setEditing(null); load(); }
    catch (e) { setError(e); }
  };
  const remove = async (t) => {
    if (!window.confirm(`Delete the trophy “${t.name}”?`)) return;
    try { await api(`/admin/trophies/${t.id}`, { method: 'DELETE', token }); load(); } catch (e) { setError(e); }
  };
  const revoke = async (a) => {
    if (!window.confirm(`Take “${a.name}” back from ${a.playerName ?? 'this player'}?`)) return;
    try { await api(`/admin/trophy-awards/${a.id}`, { method: 'DELETE', token }); load(); } catch (e) { setError(e); }
  };

  return (
    <div>
      <EventsList events={events} />
      <form className="card create-form" onSubmit={create}>
        <h3 style={{ marginTop: 0 }}>New trophy</h3>
        <p className="muted small">
          Make it once, award it as often as you like — from an event world's ranking (open the
          world's page) or to anyone. It shows with its picture in the player's public trophy case.
        </p>
        <div className="row wrap" style={{ alignItems: 'flex-start' }}>
          {image ? <img src={image} alt="" width={72} height={72} style={imgBox(72)} /> : null}
          <label>Name
            <input required maxLength={60} placeholder="Discord Cup · October 2026" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>Description (optional)
            <input maxLength={280} placeholder="Winner of the first Headwinds Discord event" value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <label>Picture
            <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(e) => pick(e, setImage)} />
            <span className="muted small">PNG, JPEG, WebP or GIF. Scaled to {TROPHY_IMAGE_EDGE}px; transparent PNGs look best.</span>
          </label>
        </div>
        <div className="row"><button className="btn primary" disabled={busy || !name.trim()} type="submit">{busy ? 'Saving…' : 'Add to the bank'}</button></div>
      </form>
      {error && <p className="error">{error.message ?? String(error)}</p>}

      <h3>Trophy bank</h3>
      {data == null ? <p className="muted">Loading…</p> : data.trophies.length === 0 ? <p className="muted">No trophies yet.</p> : (
        <div className="row wrap" style={{ gap: 12 }}>
          {data.trophies.map((t) => (
            <div key={t.id} className="card" style={{ width: 220, margin: 0 }}>
              <TrophyArt url={t.imageUrl} size={96} alt={t.name} />
              <div style={{ fontWeight: 700, marginTop: 8 }}>{t.name}</div>
              {t.description && <div className="muted small">{t.description}</div>}
              <div className="muted small">Awarded {t.awardCount ?? 0}×</div>
              <div className="row wrap" style={{ marginTop: 6 }}>
                {editing === t.id
                  ? <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(e) => pick(e, (d) => replaceImage(t.id, d))} />
                  : <button className="btn small" type="button" onClick={() => setEditing(t.id)}>Change picture</button>}
                {!(t.awardCount > 0) && <button className="btn small danger" type="button" onClick={() => remove(t)}>Delete</button>}
              </div>
            </div>
          ))}
        </div>
      )}

      <h3 style={{ marginTop: 24 }}>Awarded</h3>
      {data == null ? null : data.awards.length === 0 ? <p className="muted">Nothing awarded yet.</p> : (
        <table className="worlds">
          <thead><tr><th>Trophy</th><th>Player</th><th>Where</th><th>Note</th><th>When</th><th /></tr></thead>
          <tbody>
            {data.awards.map((a) => (
              <tr key={a.id}>
                <td>{a.name}</td>
                <td><a href={`#/players/${a.accountId}`}>{a.playerName ?? a.accountId}</a></td>
                <td>{a.place ? `${ordinal(a.place)} · ` : ''}{a.worldName ?? '—'}{a.airlineName ? <span className="muted small"> · {a.airlineName}</span> : null}</td>
                <td>{a.note ?? ''}</td>
                <td className="muted small">{a.awardedAt ? new Date(a.awardedAt).toLocaleDateString() : ''}</td>
                <td><button className="btn small" type="button" onClick={() => revoke(a)}>Revoke</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Every event world, newest first, with its results one click away ─────────

const fmtWhen = (t) => (t ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');

export function EventsList({ events }) {
  if (events == null) return null;
  return (
    <section className="card">
      <h3 style={{ marginTop: 0 }}>Event worlds</h3>
      {events.length === 0 ? (
        <p className="muted">No event worlds yet — tick “Event world” when you create a world.</p>
      ) : (
        <table className="worlds">
          <thead><tr><th>Event</th><th>Status</th><th>Pace</th><th>Starts</th><th>Ends</th><th>Players</th><th /></tr></thead>
          <tbody>
            {events.map((w) => (
              <tr key={w.id}>
                <td>{w.event?.name ?? w.name}</td>
                <td>{w.status === 'ENDED' ? 'Finished' : w.status === 'RUNNING' ? 'Running' : w.status === 'LOBBY' ? 'Open — not started' : w.status}</td>
                <td>{w.paceLabel ?? ''}</td>
                <td>{fmtWhen(w.startedAt ?? w.scheduledStartAt)}</td>
                <td>{fmtWhen(w.endedAt ?? w.endsAt)}</td>
                <td>{w.playerCount}</td>
                <td>
                  <a className={`btn small ${w.status === 'ENDED' ? 'primary' : ''}`} href={`#/w/${w.id}`}>
                    {w.status === 'ENDED' ? 'Results & awards →' : 'Open →'}
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ── An event world's ranking, with Award controls ────────────────────────────

export function EventRankingPanel({ world, standings = [], token, fallen = 0 }) {
  const [bank, setBank] = useState(null);
  const [error, setError] = useState(null);
  const [choice, setChoice] = useState({}); // accountId → trophyId
  const [notes, setNotes] = useState({});   // accountId → note
  const [busy, setBusy] = useState(null);

  const load = useCallback(() => {
    api(`/admin/trophies?worldId=${encodeURIComponent(world.id)}`, { token }).then(setBank).catch(setError);
  }, [token, world.id]);
  useEffect(() => { load(); }, [load]);

  const ended = world.status === 'ENDED';
  const trophies = bank?.trophies ?? [];
  const awardsBy = new Map();
  for (const a of bank?.awards ?? []) {
    if (!awardsBy.has(a.accountId)) awardsBy.set(a.accountId, []);
    awardsBy.get(a.accountId).push(a);
  }

  const award = async (row) => {
    const trophyId = choice[row.accountId] ?? trophies[0]?.id;
    if (!trophyId) return;
    setBusy(row.accountId); setError(null);
    try {
      await api(`/admin/trophies/${trophyId}/award`, {
        method: 'POST', token,
        body: { accountId: row.accountId, worldId: world.id, place: row.rank, note: (notes[row.accountId] ?? '').trim() || null },
      });
      load();
    } catch (e) { setError(e); }
    setBusy(null);
  };

  const copyRanking = () => {
    const text = standings.map((s) => `${s.rank}. ${s.name}${s.playerName ? ` (${s.playerName})` : ''} — ${fmtMoney(s.avgProfit)}/wk`).join('\n');
    navigator.clipboard?.writeText(`${world.event?.name ?? world.name} — ${ended ? 'final ranking' : 'ranking so far'}\n${text}`).catch(() => {});
  };

  return (
    <section className="card" style={{ borderColor: 'rgba(255,200,61,.45)' }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>🏆 {ended ? 'Final ranking' : 'Ranking so far'} · {world.event?.name ?? world.name}</h3>
        <span className="row" style={{ gap: 8 }}>
          <button className="btn small" type="button" onClick={copyRanking}>Copy ranking</button>
          <a className="btn small" href="#/admin">Trophy bank →</a>
        </span>
      </div>
      <p className="muted small">
        Admins only. Ranked by average weekly net profit over the last 52 weeks
        {ended ? ' — this is the final order.' : ', exactly like the standings; it becomes final when the world ends.'}
        {fallen > 0 ? ` ${fallen} airline${fallen === 1 ? '' : 's'} went bankrupt or quit and are not ranked.` : ''}
        {trophies.length === 0 ? ' Add a trophy to the bank first to award one.' : ''}
      </p>
      {error && <p className="error">{error.message ?? String(error)}</p>}
      <table className="worlds">
        <thead><tr><th>#</th><th>Airline</th><th>Player</th><th>Avg weekly profit</th><th>Trophies</th><th>Award</th></tr></thead>
        <tbody>
          {standings.map((s) => (
            <tr key={s.id}>
              <td>{s.rank}</td>
              <td>{s.name} <span className="muted small">{s.hub}</span></td>
              <td><a href={`#/players/${s.accountId}`}>{s.playerName ?? 'profile'}</a></td>
              <td>{fmtMoney(s.avgProfit)}</td>
              <td>{(awardsBy.get(s.accountId) ?? []).map((a) => <span key={a.id} title={a.note ?? ''}>🏆 {a.name} </span>)}</td>
              <td>
                {trophies.length > 0 && (
                  <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                    <select value={choice[s.accountId] ?? trophies[0].id}
                      onChange={(e) => setChoice((c) => ({ ...c, [s.accountId]: e.target.value }))}>
                      {trophies.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                    <input placeholder="Note (optional)" maxLength={120} style={{ width: 130 }}
                      value={notes[s.accountId] ?? ''} onChange={(e) => setNotes((n) => ({ ...n, [s.accountId]: e.target.value }))} />
                    <button className="btn small primary" type="button" disabled={busy === s.accountId} onClick={() => award(s)}>
                      {busy === s.accountId ? '…' : 'Award'}
                    </button>
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
