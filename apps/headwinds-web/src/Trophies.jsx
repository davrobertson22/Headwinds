// Trophy bank + event ranking — the admin side of event worlds.
//
// TrophyBank (Moderation → Trophies): make trophies with their own artwork,
// edit or delete them, see and revoke every award.
// EventRankingPanel (an event world's page, admins only): the ranking — final
// once the world ends — with an "Award" control on every row.
// TrophyCard: one awarded trophy as a public trophy case shows it.
// TrophyViewer: the 3D turntable a trophy with a .glb model opens into.
//
// Server: apps/headwinds-server/src/lib/trophies.mjs + routes/trophies.mjs.
// 3D: ./trophy3d.js (three.js, loaded from a CDN only when a model is opened).
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, API_BASE } from './api.js';

const load3d = () => import('./trophy3d.js');
// The server's ceiling (lib/trophies.mjs TROPHY_MODEL_MAX_BYTES).
export const TROPHY_MODEL_MAX_BYTES = 10_000_000;

/** PUT a .glb to a trophy. Raw bytes, not JSON — models run to megabytes. */
export async function uploadTrophyModel(token, trophyId, buffer) {
  const res = await fetch(`${API_BASE}/admin/trophies/${trophyId}/model`, {
    method: 'PUT',
    headers: { 'Content-Type': 'model/gltf-binary', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: buffer,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `${res.status} ${res.statusText}`);
  return data;
}

const fmtMB = (n) => (n == null ? '' : `${(n / 1e6).toFixed(1)} MB`);

/** Full-screen turntable for one trophy's model. */
export function TrophyViewer({ modelUrl, name, onClose }) {
  const canvasRef = useRef(null);
  const [state, setState] = useState('loading'); // loading | ready | error
  const [err, setErr] = useState(null);
  useEffect(() => {
    let viewer = null, cancelled = false;
    load3d()
      .then((m) => m.mountTrophyViewer(canvasRef.current, `${API_BASE}${modelUrl}`))
      .then((v) => { if (cancelled) v.dispose(); else { viewer = v; setState('ready'); } })
      .catch((e) => { if (!cancelled) { setErr(e); setState('error'); } });
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => { cancelled = true; viewer?.dispose(); window.removeEventListener('keydown', onKey); };
  }, [modelUrl, onClose]);
  return (
    <div role="dialog" aria-modal="true" aria-label={`${name ?? 'Trophy'} in 3D`} onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(5,10,20,.82)', display: 'grid', placeItems: 'center', padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ position: 'relative', width: 'min(92vw, 640px)', aspectRatio: '1 / 1', borderRadius: 14,
                 background: 'radial-gradient(circle at 50% 40%, #2a3448, #0d1320 70%)', border: '1px solid rgba(255,200,61,.35)' }}>
        <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block', borderRadius: 14, touchAction: 'none', cursor: 'grab' }} />
        <div style={{ position: 'absolute', left: 14, top: 10, fontWeight: 700 }}>{name}</div>
        <button className="btn small" type="button" onClick={onClose} style={{ position: 'absolute', right: 10, top: 8 }}>✕</button>
        {state === 'loading' && <div className="muted" style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>Loading the 3D trophy…</div>}
        {state === 'error' && <div className="error" style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', padding: 24, textAlign: 'center' }}>Couldn’t show the 3D trophy: {err?.message ?? String(err)}</div>}
        {state === 'ready' && <div className="muted small" style={{ position: 'absolute', bottom: 10, width: '100%', textAlign: 'center' }}>Drag to turn · scroll or pinch to zoom</div>}
      </div>
    </div>
  );
}

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
  const [open3d, setOpen3d] = useState(false);
  return (
    <div style={{ border: '1px solid rgba(255,200,61,.35)', borderRadius: 10, padding: '10px 14px',
                  minWidth: 180, maxWidth: 260, display: 'flex', gap: 12, alignItems: 'center' }}>
      {a.modelUrl ? (
        <button type="button" onClick={() => setOpen3d(true)} title="View in 3D"
          style={{ position: 'relative', padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}>
          <TrophyArt url={a.imageUrl} size={64} alt={a.name ?? 'Trophy'} />
          <span style={{ position: 'absolute', right: -4, bottom: -4, fontSize: 10, fontWeight: 800, padding: '1px 5px',
                         borderRadius: 4, background: '#ffc83d', color: '#1a1300' }}>3D</span>
        </button>
      ) : <TrophyArt url={a.imageUrl} size={64} alt={a.name ?? 'Trophy'} />}
      {open3d && <TrophyViewer modelUrl={a.modelUrl} name={a.name} onClose={() => setOpen3d(false)} />}
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
  const [model, setModel] = useState(null); // { buffer, name, size } of a picked .glb
  const [editing, setEditing] = useState(null); // trophy id
  const [viewing, setViewing] = useState(null); // trophy whose model is open
  const [status, setStatus] = useState(null);   // progress line while saving

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

  const pickModel = async (e, then) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setError(null);
    if (!/\.glb$/i.test(f.name)) { setError(new Error('Pick a .glb file (binary glTF). A .gltf with separate files won’t upload — export as .glb.')); return; }
    if (f.size > TROPHY_MODEL_MAX_BYTES) { setError(new Error(`That model is ${fmtMB(f.size)} — the limit is ${fmtMB(TROPHY_MODEL_MAX_BYTES)}. Shrinking its textures to 1024 px usually does it.`)); return; }
    then({ buffer: await f.arrayBuffer(), name: f.name, size: f.size });
  };

  // No picture but a model: render one from the model, so the trophy case
  // always has something to show before anyone opens the 3D view.
  const posterFor = async (buffer) => {
    setStatus('Rendering a picture from the 3D model…');
    const m = await load3d();
    return m.renderTrophyPoster(buffer.slice(0), { size: 512 });
  };

  const create = async (ev) => {
    ev.preventDefault();
    setBusy(true); setError(null);
    try {
      const picture = image ?? (model ? await posterFor(model.buffer) : null);
      setStatus('Saving…');
      const { trophy } = await api('/admin/trophies', { method: 'POST', token, body: { name: name.trim(), description: description.trim() || null, image: picture } });
      if (model) {
        setStatus(`Uploading the 3D model (${fmtMB(model.size)})…`);
        await uploadTrophyModel(token, trophy.id, model.buffer);
      }
      setName(''); setDescription(''); setImage(null); setModel(null); load();
    } catch (e) { setError(e); }
    setStatus(null);
    setBusy(false);
  };
  const attachModel = async (t, m) => {
    setError(null); setBusy(true);
    try {
      // A trophy with no picture yet gets one rendered from the model.
      if (!t.imageUrl) {
        const picture = await posterFor(m.buffer);
        await api(`/admin/trophies/${t.id}`, { method: 'POST', token, body: { image: picture } });
      }
      setStatus(`Uploading the 3D model (${fmtMB(m.size)})…`);
      await uploadTrophyModel(token, t.id, m.buffer);
      setEditing(null); load();
    } catch (e) { setError(e); }
    setStatus(null); setBusy(false);
  };
  const removeModel = async (t) => {
    if (!window.confirm(`Remove the 3D model from “${t.name}”? The picture stays.`)) return;
    try { await api(`/admin/trophies/${t.id}/model`, { method: 'DELETE', token }); load(); } catch (e) { setError(e); }
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
          <label>3D model (optional)
            <input type="file" accept=".glb,model/gltf-binary" onChange={(e) => pickModel(e, setModel)} />
            <span className="muted small">
              {model ? `${model.name} · ${fmtMB(model.size)}` : `A .glb file, up to ${fmtMB(TROPHY_MODEL_MAX_BYTES)}.`}
              {' '}Players can spin it in the trophy case. No picture? One is rendered from the model.
            </span>
          </label>
        </div>
        <div className="row">
          <button className="btn primary" disabled={busy || !name.trim()} type="submit">{busy ? 'Saving…' : 'Add to the bank'}</button>
        </div>
      </form>
      {error && <p className="error">{error.message ?? String(error)}</p>}
      {status && <p className="muted small">{status}</p>}
      {viewing && <TrophyViewer modelUrl={viewing.modelUrl} name={viewing.name} onClose={() => setViewing(null)} />}

      <h3>Trophy bank</h3>
      {data == null ? <p className="muted">Loading…</p> : data.trophies.length === 0 ? <p className="muted">No trophies yet.</p> : (
        <div className="row wrap" style={{ gap: 12 }}>
          {data.trophies.map((t) => (
            <div key={t.id} className="card" style={{ width: 220, margin: 0 }}>
              <TrophyArt url={t.imageUrl} size={96} alt={t.name} />
              <div style={{ fontWeight: 700, marginTop: 8 }}>{t.name}</div>
              {t.description && <div className="muted small">{t.description}</div>}
              <div className="muted small">
                Awarded {t.awardCount ?? 0}×{t.modelUrl ? ` · 3D model ${fmtMB(t.modelSize)}` : ''}
              </div>
              <div className="row wrap" style={{ marginTop: 6 }}>
                {t.modelUrl && <button className="btn small" type="button" onClick={() => setViewing(t)}>View 3D</button>}
                {editing === t.id ? (
                  <>
                    <label className="small">Picture <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(e) => pick(e, (d) => replaceImage(t.id, d))} /></label>
                    <label className="small">3D model <input type="file" accept=".glb,model/gltf-binary" onChange={(e) => pickModel(e, (m) => attachModel(t, m))} /></label>
                    <button className="btn small" type="button" onClick={() => setEditing(null)}>Done</button>
                  </>
                ) : <button className="btn small" type="button" onClick={() => setEditing(t.id)}>Change picture / 3D</button>}
                {t.modelUrl && editing !== t.id && <button className="btn small" type="button" onClick={() => removeModel(t)}>Remove 3D</button>}
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

export function EventRankingPanel({ world, standings = [], token, fallen = 0, allianceStandings = null }) {
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

  // Alliance-ranked events: award the whole team in one go, each member
  // getting the trophy with the TEAM's place.
  const [teamChoice, setTeamChoice] = useState({});
  const [teamNotes, setTeamNotes] = useState({});
  const awardTeam = async (team) => {
    const trophyId = teamChoice[team.name] ?? trophies[0]?.id;
    if (!trophyId) return;
    setBusy(`team:${team.name}`); setError(null);
    try {
      for (const m of team.members) {
        const already = (awardsBy.get(m.accountId) ?? []).some((a) => a.trophyId === trophyId);
        if (already) continue;
        await api(`/admin/trophies/${trophyId}/award`, {
          method: 'POST', token,
          body: { accountId: m.accountId, worldId: world.id, place: team.rank, note: (teamNotes[team.name] ?? '').trim() || (team.alliance ? team.name : null) },
        });
      }
      load();
    } catch (e) { setError(e); }
    setBusy(null);
  };

  const copyRanking = () => {
    const text = allianceStandings
      ? allianceStandings.map((t) => `${t.rank}. ${t.name} — ${fmtMoney(t.score)}/wk (${t.members.map((m) => m.playerName ?? m.name).join(', ')})`).join('\n')
      : standings.map((s) => `${s.rank}. ${s.name}${s.playerName ? ` (${s.playerName})` : ''} — ${fmtMoney(s.avgProfit)}/wk`).join('\n');
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
      {allianceStandings && (
        <>
          <h4 style={{ margin: '8px 0 4px' }}>🤝 Alliance ranking — this event ranks alliances</h4>
          <table className="worlds" style={{ marginBottom: 14 }}>
            <thead><tr><th>#</th><th>Alliance</th><th>Members</th><th>Score / wk</th><th>Award the team</th></tr></thead>
            <tbody>
              {allianceStandings.map((t) => (
                <tr key={`${t.alliance ? 'a' : 's'}:${t.name}`}>
                  <td>{t.rank}</td>
                  <td>{t.alliance ? t.name : <span className="muted">{t.name} (no alliance)</span>}</td>
                  <td className="small">{t.members.map((m) => `${m.name}${m.playerName ? ` (${m.playerName})` : ''}`).join(', ')}</td>
                  <td>{fmtMoney(t.score)}</td>
                  <td>
                    {trophies.length > 0 && (
                      <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                        <select value={teamChoice[t.name] ?? trophies[0].id}
                          onChange={(e) => setTeamChoice((c) => ({ ...c, [t.name]: e.target.value }))}>
                          {trophies.map((tr) => <option key={tr.id} value={tr.id}>{tr.name}</option>)}
                        </select>
                        <input placeholder="Note (optional)" maxLength={120} style={{ width: 120 }}
                          value={teamNotes[t.name] ?? ''} onChange={(e) => setTeamNotes((n) => ({ ...n, [t.name]: e.target.value }))} />
                        <button className="btn small primary" type="button" disabled={busy === `team:${t.name}`} onClick={() => awardTeam(t)}>
                          {busy === `team:${t.name}` ? '…' : `Award all ${t.members.length}`}
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <h4 style={{ margin: '8px 0 4px' }}>Airlines</h4>
        </>
      )}
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
