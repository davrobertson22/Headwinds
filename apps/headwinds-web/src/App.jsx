// Headwinds web client — Phase 1: sign in → browse worlds → join → sit in the lobby.
// Hash-based routing keeps it dependency-free: '#/' = world list, '#/w/<id>' = world.
import { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from './supabase.js';
import { api } from './api.js';
import { AIRPORTS } from '../../../packages/engine/src/data/airports.js';

// ── Session ───────────────────────────────────────────────────────────────────

function useSession() {
  const [session, setSession] = useState(null);
  const [ready, setReady] = useState(() => !supabase); // unconfigured → show setup notice immediately
  useEffect(() => {
    if (!supabase) { setReady(true); return; }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session ?? null);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);
  return { session, ready, token: session?.access_token ?? null };
}

// ── Hash router ───────────────────────────────────────────────────────────────

function useRoute() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const m = hash.match(/^#\/w\/([\w-]+)/);
  return m ? { screen: 'world', worldId: m[1] } : { screen: 'worlds' };
}

const goTo = (path) => { window.location.hash = path; };

// ── Small bits ────────────────────────────────────────────────────────────────

const fmtMoney = (n) => n == null ? '—' :
  Math.abs(n) >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` :
  Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n / 1e3)}k`;

function StatusChip({ status }) {
  return <span className={`chip chip-${status.toLowerCase()}`}>{status}</span>;
}

function ErrorNote({ error }) {
  return error ? <p className="error">{String(error.message || error)}</p> : null;
}

// ── Sign in ───────────────────────────────────────────────────────────────────

function SignIn() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(null);

  if (!supabase) {
    return (
      <div className="card narrow">
        <h2>Setup needed</h2>
        <p>Auth isn't configured. Copy <code>.env.example</code> to <code>.env.local</code> in
        <code> apps/headwinds-web</code> and fill in the Supabase URL + anon key, then restart the dev server.</p>
      </div>
    );
  }

  const google = async () => {
    setError(null);
    const { error: e } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    });
    if (e) setError(e);
  };

  const magicLink = async (ev) => {
    ev.preventDefault();
    setError(null);
    const { error: e } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    if (e) setError(e); else setSent(true);
  };

  return (
    <div className="card narrow">
      <h2>Sign in to play</h2>
      <p className="muted">One account, all worlds. Your airline waits for you between sessions.</p>
      <button className="btn primary wide" onClick={google}>Continue with Google</button>
      <div className="divider">or</div>
      {sent ? (
        <p>Check your email — we sent you a sign-in link.</p>
      ) : (
        <form onSubmit={magicLink} className="row">
          <input
            type="email" required placeholder="you@example.com"
            value={email} onChange={(e) => setEmail(e.target.value)}
          />
          <button className="btn" type="submit">Email me a link</button>
        </form>
      )}
      <ErrorNote error={error} />
    </div>
  );
}

// ── Join form (shared by list + world screen) ─────────────────────────────────

function JoinForm({ world, token, needsCode, onJoined }) {
  const [airlineName, setAirlineName] = useState('');
  const [hub, setHub] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const hubOptions = useMemo(
    () => AIRPORTS.map((a) => ({ code: a.code, label: `${a.code} — ${a.city}` })),
    []
  );
  const hubValid = AIRPORTS.some((a) => a.code === hub.toUpperCase());

  const join = async (ev) => {
    ev.preventDefault();
    setBusy(true); setError(null);
    try {
      const res = await api(`/worlds/${world.id}/join`, {
        method: 'POST', token,
        body: {
          airlineName: airlineName.trim(),
          hub: hub.toUpperCase(),
          ...(needsCode && joinCode ? { joinCode: joinCode.trim().toUpperCase() } : {}),
        },
      });
      onJoined?.(res.airline);
    } catch (e) { setError(e); }
    setBusy(false);
  };

  return (
    <form className="join-form" onSubmit={join}>
      <h3>Found your airline in “{world.name}”</h3>
      <div className="row wrap">
        <input
          required maxLength={40} placeholder="Airline name"
          value={airlineName} onChange={(e) => setAirlineName(e.target.value)}
        />
        <input
          required list="hub-airports" placeholder="Hub (e.g. JFK)" className="hub-input"
          value={hub} onChange={(e) => setHub(e.target.value)}
        />
        <datalist id="hub-airports">
          {hubOptions.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
        </datalist>
        {needsCode && (
          <input
            required placeholder="Join code" className="hub-input"
            value={joinCode} onChange={(e) => setJoinCode(e.target.value)}
          />
        )}
        <button className="btn primary" disabled={busy || !hubValid} type="submit">
          {busy ? 'Joining…' : 'Join world'}
        </button>
      </div>
      {hub && !hubValid && <p className="muted small">Pick a real airport code from the list.</p>}
      <ErrorNote error={error} />
    </form>
  );
}

// ── Create world ──────────────────────────────────────────────────────────────

function CreateWorld({ token, onCreated }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [lengthYears, setLengthYears] = useState(50);
  const [weeksPerDay, setWeeksPerDay] = useState(24);
  const [visibility, setVisibility] = useState('PRIVATE');
  const [maxPlayers, setMaxPlayers] = useState(20);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const paceLabel = (w) => (24 / w < 1 ? `1 wk / ${Math.round((24 / w) * 60)} min` : `1 wk / ${24 / w} hr`);

  const create = async (ev) => {
    ev.preventDefault();
    setBusy(true); setError(null);
    try {
      const res = await api('/worlds', {
        method: 'POST', token,
        body: {
          ...(name.trim() ? { name: name.trim() } : {}),
          lengthYears: Number(lengthYears),
          weeksPerDay: Number(weeksPerDay),
          visibility,
          maxPlayers: Number(maxPlayers),
        },
      });
      onCreated?.(res.world);
      goTo(`/w/${res.world.id}`);
    } catch (e) { setError(e); }
    setBusy(false);
  };

  if (!open) {
    return <button className="btn" onClick={() => setOpen(true)}>+ Create a world</button>;
  }
  return (
    <form className="card create-form" onSubmit={create}>
      <h3>New world</h3>
      <div className="row wrap">
        <input maxLength={60} placeholder="Name (optional — we'll invent one)" value={name}
          onChange={(e) => setName(e.target.value)} />
        <label>Length
          <select value={lengthYears} onChange={(e) => setLengthYears(e.target.value)}>
            <option value={50}>50 game-years</option>
            <option value={100}>100 game-years</option>
          </select>
        </label>
        <label>Pace
          <select value={weeksPerDay} onChange={(e) => setWeeksPerDay(e.target.value)}>
            {[6, 12, 24, 48].map((w) => <option key={w} value={w}>{paceLabel(w)}</option>)}
          </select>
        </label>
        <label>Visibility
          <select value={visibility} onChange={(e) => setVisibility(e.target.value)}>
            <option value="PRIVATE">Private (join code)</option>
            <option value="PUBLIC">Public</option>
          </select>
        </label>
        <label>Max players
          <input type="number" min={1} max={500} value={maxPlayers}
            onChange={(e) => setMaxPlayers(e.target.value)} />
        </label>
      </div>
      <div className="row">
        <button className="btn primary" disabled={busy} type="submit">{busy ? 'Creating…' : 'Create'}</button>
        <button className="btn" type="button" onClick={() => setOpen(false)}>Cancel</button>
      </div>
      <ErrorNote error={error} />
    </form>
  );
}

// ── Worlds list ───────────────────────────────────────────────────────────────

function WorldsScreen({ token, me }) {
  const [worlds, setWorlds] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    api('/worlds').then((d) => setWorlds(d.worlds)).catch(setError);
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  const myWorldIds = new Set((me?.airlines ?? []).map((a) => a.worldId));

  return (
    <>
      {me?.airlines?.length > 0 && (
        <div className="card">
          <h3>Your airlines</h3>
          <div className="row wrap">
            {me.airlines.map((a) => (
              <button key={a.id} className="btn airline-chip" onClick={() => goTo(`/w/${a.worldId}`)}>
                <strong>{a.name}</strong> · {a.hub} · {fmtMoney(a.cash)}
                {a.world ? <span className="muted"> — {a.world.name}</span> : null}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="list-head">
        <h2>Open worlds</h2>
        {token && <CreateWorld token={token} />}
      </div>
      <ErrorNote error={error} />
      {!worlds ? <p className="muted">Loading worlds…</p> : worlds.length === 0 ? (
        <p className="muted">No public worlds yet — create one, or wait for the spawner.</p>
      ) : (
        <table className="worlds">
          <thead>
            <tr><th>World</th><th>Pace</th><th>Progress</th><th>Players</th><th>Status</th><th /></tr>
          </thead>
          <tbody>
            {worlds.map((w) => (
              <tr key={w.id}>
                <td><a href={`#/w/${w.id}`}>{w.name}</a></td>
                <td>{w.paceLabel}</td>
                <td>Y{w.progress.year}/{w.progress.totalYears} <span className="muted">({w.progress.percent}%)</span></td>
                <td>{w.playerCount}/{w.maxPlayers}</td>
                <td><StatusChip status={w.status} /></td>
                <td>
                  <button className="btn small" onClick={() => goTo(`/w/${w.id}`)}>
                    {myWorldIds.has(w.id) ? 'Open' : 'View / join'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

// ── World detail / lobby ──────────────────────────────────────────────────────

function WorldScreen({ worldId, token, me, refreshMe }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    api(`/worlds/${worldId}`, { token }).then(setData).catch(setError);
  }, [worldId, token]);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  if (error) return <div className="card"><ErrorNote error={error} /><a href="#/">← All worlds</a></div>;
  if (!data) return <p className="muted">Loading world…</p>;

  const { world, standings } = data;
  const mine = (me?.airlines ?? []).find((a) => a.worldId === world.id && a.status !== 'ABANDONED');
  const canJoin = token && !mine && ['LOBBY', 'RUNNING'].includes(world.status)
    && (world.playerCount ?? standings.length) < world.maxPlayers;

  const leave = async () => {
    if (!window.confirm(`Abandon ${mine.name} in ${world.name}? This can't be undone.`)) return;
    try {
      await api(`/worlds/${world.id}/leave`, { method: 'POST', token });
      refreshMe(); load();
    } catch (e) { setError(e); }
  };

  return (
    <>
      <a href="#/" className="muted">← All worlds</a>
      <div className="card world-head">
        <div>
          <h2>{world.name} <StatusChip status={world.status} /></h2>
          <p className="muted">
            {world.paceLabel} · Year {world.progress.year} of {world.progress.totalYears} ·
            {' '}{world.playerCount ?? standings.length}/{world.maxPlayers} players
            {world.joinCode ? <> · join code: <code className="join-code">{world.joinCode}</code></> : null}
          </p>
          <div className="progress"><div style={{ width: `${world.progress.percent}%` }} /></div>
        </div>
        {mine && (
          <div className="mine">
            <p>Flying as <strong>{mine.name}</strong> ({mine.hub}) — {fmtMoney(mine.cash)}</p>
            <button className="btn danger small" onClick={leave}>Abandon airline</button>
          </div>
        )}
      </div>

      {canJoin && (
        <div className="card">
          <JoinForm
            world={world} token={token}
            needsCode={world.visibility === 'PRIVATE' && !world.joinCode}
            onJoined={() => { refreshMe(); load(); }}
          />
        </div>
      )}
      {!token && <div className="card"><p className="muted">Sign in above to join this world.</p></div>}

      <h3>Standings</h3>
      {standings.length === 0 ? <p className="muted">No airlines yet — be the first to join.</p> : (
        <table className="worlds">
          <thead>
            <tr><th>#</th><th>Airline</th><th>Hub</th><th>Cash</th><th>Market cap</th><th>Status</th></tr>
          </thead>
          <tbody>
            {standings.map((a) => (
              <tr key={a.id} className={mine?.id === a.id ? 'me-row' : ''}>
                <td>{a.rank}</td><td>{a.name}</td><td>{a.hub}</td>
                <td>{fmtMoney(a.cash)}</td><td>{fmtMoney(a.marketCap)}</td>
                <td><StatusChip status={a.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted small">
        Gameplay (the weekly tick) arrives in Phase 2 — for now worlds are lobbies with standings.
      </p>
    </>
  );
}

// ── App shell ─────────────────────────────────────────────────────────────────

export default function App() {
  const { session, ready, token } = useSession();
  const route = useRoute();
  const [me, setMe] = useState(null);

  const refreshMe = useCallback(() => {
    if (!token) { setMe(null); return; }
    api('/me', { token }).then(setMe).catch(() => setMe(null));
  }, [token]);
  useEffect(() => { refreshMe(); }, [refreshMe]);

  const signOut = () => supabase?.auth.signOut();

  return (
    <div className="shell">
      <header>
        <a href="#/" className="brand">HEADWINDS<span className="muted"> · multiplayer</span></a>
        {session ? (
          <div className="row">
            <span className="muted">{me?.account?.displayName ?? session.user.email}</span>
            <button className="btn small" onClick={signOut}>Sign out</button>
          </div>
        ) : null}
      </header>

      {!ready ? <p className="muted">Loading…</p> : (
        <>
          {!session && <SignIn />}
          {route.screen === 'worlds'
            ? <WorldsScreen token={token} me={me} />
            : <WorldScreen worldId={route.worldId} token={token} me={me} refreshMe={refreshMe} />}
        </>
      )}

      <footer className="muted small">
        Headwinds is the multiplayer companion to{' '}
        <a href="https://www.tailwindsairlinegame.com" target="_blank" rel="noreferrer">Tailwinds</a>.
      </footer>
    </div>
  );
}
