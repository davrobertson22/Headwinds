// Headwinds web client — sign in → browse worlds → join → play.
// Hash routes: '#/' world list · '#/w/<id>' world lobby · '#/w/<id>/play' the
// full Tailwinds game UI running on server-authoritative state.
import { useState, useEffect, useCallback, useMemo, lazy, Suspense, Fragment } from 'react';
import { supabase } from './supabase.js';
import { api } from './api.js';
import { ReportDialog, REPORT_CATEGORIES } from './Report.jsx';
import { AIRPORTS } from '../../../packages/engine/src/data/airports.js';
import { AIRCRAFT_TYPES } from '../../../packages/engine/src/data/aircraft.js';

// Lazy: the full game UI (and its CSS) loads only when a player opens a world —
// it's the whole solo app, no need to ship it to the lobby.
const GamePlayScreen = lazy(() => import('./GamePlayScreen.jsx'));

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
  if (hash.startsWith('#/admin')) return { screen: 'admin' };
  if (hash.startsWith('#/report')) return { screen: 'report' };
  const m = hash.match(/^#\/w\/([\w-]+)(\/play)?/);
  if (m && m[2]) return { screen: 'play', worldId: m[1] };
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

  // Google and Discord share the same redirect flow. Back to /play, not the
  // origin — the static landing page at '/' has no Supabase client, so tokens
  // landing there would never be exchanged.
  const oauth = async (provider) => {
    setError(null);
    const { error: e } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: `${window.location.origin}/play` },
    });
    if (e) setError(e);
  };

  const magicLink = async (ev) => {
    ev.preventDefault();
    setError(null);
    const { error: e } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/play` },
    });
    if (e) setError(e); else setSent(true);
  };

  return (
    <div className="card narrow">
      <h2>Sign in to play</h2>
      <p className="muted">One account, all worlds. Your airline waits for you between sessions.</p>
      <button className="btn primary wide" onClick={() => oauth('google')}>Continue with Google</button>
      <button className="btn discord wide" onClick={() => oauth('discord')}>Continue with Discord</button>
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
        {/* World creation is admin-only — the server enforces it (403), this just
            hides the button for everyone else. */}
        {token && me?.account?.isAdmin && <CreateWorld token={token} />}
      </div>
      <ErrorNote error={error} />
      {!worlds ? <p className="muted">Loading worlds…</p> : worlds.length === 0 ? (
        <p className="muted">
          {me?.account?.isAdmin
            ? 'No public worlds yet — create one, or wait for the spawner.'
            : 'No open worlds right now — a fresh one spins up shortly, check back in a minute.'}
        </p>
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
                <td>{w.status === 'LOBBY'
                  ? <span className="muted">Y1 — starts on first join</span>
                  : <>Y{w.progress.year}/{w.progress.totalYears} <span className="muted">({w.progress.percent}%)</span></>}</td>
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

// ── Rival detail (public profile, expanded from the standings table) ─────────

const MOVE_LABELS = {
  ADD_ROUTE: (p) => `Opened route ${p.origin ?? '?'} → ${p.destination ?? '?'}`,
  CLOSE_ROUTE: (p) => `Closed route ${p.origin ?? '?'} → ${p.destination ?? '?'}`,
  ADD_CARGO_ROUTE: (p) => `Opened cargo route ${p.origin ?? '?'} → ${p.destination ?? '?'}`,
  CLOSE_CARGO_ROUTE: (p) => `Closed cargo route ${p.origin ?? '?'} → ${p.destination ?? '?'}`,
  LEASE_AIRCRAFT: (p, ac) => `Leased a ${ac(p.typeId)}`,
  BUY_AIRCRAFT: (p, ac) => `Bought a ${ac(p.typeId)}`,
  ORDER_AIRCRAFT: (p, ac) => `Ordered a ${ac(p.typeId)}`,
  SELL_AIRCRAFT: () => 'Sold an aircraft',
  RETIRE_AIRCRAFT: () => 'Retired an aircraft',
  ADD_GATE: (p) => `Added a gate at ${p.airportCode ?? '?'}`,
  UPGRADE_HUB: (p) => `Upgraded hub ${p.airportCode ?? ''}`.trim(),
  DESIGNATE_HUB: (p) => `Designated ${p.airportCode ?? 'a'} hub`,
  DESIGNATE_FOCUS_CITY: (p) => `Designated ${p.airportCode ?? 'a'} focus city`,
  JOIN_ALLIANCE: (p) => `Joined the ${p.allianceId ?? ''} alliance`.replace('  ', ' '),
  LEAVE_ALLIANCE: () => 'Left their alliance',
};

function RivalDetail({ worldId, airlineId, airlineName, token, canReport }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [reporting, setReporting] = useState(false);

  useEffect(() => {
    let alive = true;
    api(`/worlds/${worldId}/rivals/${airlineId}`)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e));
    return () => { alive = false; };
  }, [worldId, airlineId]);

  if (error) return <div className="rival-detail"><ErrorNote error={error} /></div>;
  if (!data) return <div className="rival-detail"><p className="muted small">Loading rival intel…</p></div>;

  const acName = (typeId) => AIRCRAFT_TYPES.find((t) => t.id === typeId)?.name ?? typeId ?? 'aircraft';
  const ranks = data.rankHistory ?? [];
  const trend = ranks.length >= 2 ? ranks[0].rank - ranks[ranks.length - 1].rank : 0;

  return (
    <div className="rival-detail">
      <div className="row wrap">
        {data.hubs.length > 0 && <span className="small">Hubs: <strong>{data.hubs.join(', ')}</strong></span>}
        {data.alliance && <span className="small">Alliance: <strong>{data.alliance}</strong></span>}
        {ranks.length >= 2 && (
          <span className="small">
            Rank trend: <strong className={trend > 0 ? 'pos' : trend < 0 ? 'neg' : ''}>
              {trend > 0 ? `▲ up ${trend}` : trend < 0 ? `▼ down ${-trend}` : '— steady'}
            </strong> <span className="muted">(last {ranks.length} wks)</span>
          </span>
        )}
        {canReport && (
          <button
            className="btn small" style={{ marginLeft: 'auto' }}
            onClick={() => setReporting(true)}
            title="Report this player to the admins"
          >⚠ Report</button>
        )}
      </div>
      {reporting && (
        <ReportDialog
          worldId={worldId} token={token} airlineId={airlineId}
          airlineName={airlineName} onClose={() => setReporting(false)}
        />
      )}

      <h5>Route network ({data.routeNetwork.length})</h5>
      {data.routeNetwork.length === 0 ? <p className="muted small">No routes open yet.</p> : (
        <div className="grid">
          {data.routeNetwork.map((r, i) => (
            <span key={i}>
              {r.origin} → {r.destination}
              <span className="muted"> · {r.weeklyFrequency}×/wk{r.economyFare ? ` · $${r.economyFare}` : ''}</span>
            </span>
          ))}
        </div>
      )}

      <h5>Fleet</h5>
      {Object.keys(data.fleetByType).length === 0 ? <p className="muted small">No aircraft yet.</p> : (
        <div className="grid">
          {Object.entries(data.fleetByType).map(([typeId, n]) => (
            <span key={typeId}>{n}× {acName(typeId)}</span>
          ))}
        </div>
      )}

      {data.recentMoves.length > 0 && (
        <>
          <h5>Recent moves</h5>
          {data.recentMoves.map((m, i) => (
            <div className="rival-move" key={i}>
              <span className="wk">W{m.week}</span>
              {(MOVE_LABELS[m.type] ?? (() => m.type))(m.payload ?? {}, acName)}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

// ── World detail / lobby ──────────────────────────────────────────────────────

function WorldScreen({ worldId, token, me, refreshMe }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [openRival, setOpenRival] = useState(null); // airlineId of expanded row

  const load = useCallback(() => {
    api(`/worlds/${worldId}`, { token }).then((d) => { setData(d); setError(null); }).catch(setError);
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
            {world.paceLabel} ·{' '}
            {world.status === 'LOBBY'
              ? 'Year 1 — the clock starts when the first player joins'
              : `Year ${world.progress.year} of ${world.progress.totalYears}`} ·
            {' '}{world.playerCount ?? standings.length}/{world.maxPlayers} players
            {world.joinCode ? <> · join code: <code className="join-code">{world.joinCode}</code></> : null}
          </p>
          <div className="progress"><div style={{ width: `${world.progress.percent}%` }} /></div>
        </div>
        {mine && (
          <div className="mine">
            <p>Flying as <strong>{mine.name}</strong> ({mine.hub}) — {fmtMoney(mine.cash)}</p>
            <div className="row">
              <button className="btn primary" onClick={() => goTo(`/w/${world.id}/play`)}>▶ Open the game</button>
              <button className="btn danger small" onClick={leave}>Abandon airline</button>
            </div>
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
      <p className="muted small">Every airline below is a real player. Click one to see their network, fleet and recent moves.</p>
      {standings.length === 0 ? <p className="muted">No airlines yet — be the first to join.</p> : (
        <table className="worlds">
          <thead>
            <tr><th>#</th><th>Airline</th><th>Hub</th><th>Routes</th><th>Fleet</th><th>Cash</th><th>Market cap</th><th>Status</th></tr>
          </thead>
          <tbody>
            {standings.map((a) => (
              <Fragment key={a.id}>
                <tr
                  className={`rival-row ${mine?.id === a.id ? 'me-row' : ''}`}
                  onClick={() => setOpenRival(openRival === a.id ? null : a.id)}
                >
                  <td>{a.rank}</td>
                  <td>
                    {a.name}{mine?.id === a.id ? <span className="muted"> (you)</span> : null}
                    {a.alliance ? <span className="alliance-tag" title={`Alliance: ${a.alliance}`}>🤝 {a.alliance}</span> : null}
                  </td>
                  <td>{a.hub}</td>
                  <td>{a.routes}</td><td>{a.fleet}</td>
                  <td>{fmtMoney(a.cash)}</td><td>{fmtMoney(a.marketCap)}</td>
                  <td><StatusChip status={a.status} /></td>
                </tr>
                {openRival === a.id && (
                  <tr>
                    <td colSpan={8} style={{ padding: 0, border: 'none' }}>
                      <RivalDetail
                        worldId={world.id} airlineId={a.id} airlineName={a.name}
                        token={token} canReport={!!(token && mine && mine.id !== a.id)}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

// ── Moderation panel (admins only) ────────────────────────────────────────────

const CATEGORY_LABEL = Object.fromEntries(REPORT_CATEGORIES.map((c) => [c.value, c.label]));

const fmtWhen = (t) => {
  if (!t) return '';
  const d = new Date(t);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
    + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};

function ModerationScreen({ token, me }) {
  const [tab, setTab] = useState('OPEN'); // 'OPEN' | 'ALL' | 'BANS'
  const [reports, setReports] = useState(null);
  const [bans, setBans] = useState(null);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const isAdmin = me?.account?.isAdmin;

  const load = useCallback(() => {
    if (!token || !isAdmin) return;
    setError(null);
    if (tab === 'BANS') {
      api('/admin/bans', { token }).then((d) => setBans(d.bans)).catch(setError);
    } else {
      api(`/admin/reports?status=${tab}`, { token })
        .then((d) => setReports(d.reports)).catch(setError);
    }
  }, [token, isAdmin, tab]);
  useEffect(() => { load(); }, [load]);

  if (!token) return <div className="card"><p className="muted">Sign in to view the admin panel.</p><a href="#/">← All worlds</a></div>;
  if (!isAdmin) return <div className="card"><p className="error">This area is for game admins only.</p><a href="#/">← All worlds</a></div>;

  const ban = async (accountId, who) => {
    const reason = window.prompt(`Ban ${who}? They'll be signed out and blocked from every world, and their airlines abandoned.\n\nReason (shown to them on their next sign-in attempt):`, '');
    if (reason === null) return; // cancelled
    setBusyId(accountId); setError(null);
    try {
      const res = await api(`/admin/accounts/${accountId}/ban`, { method: 'POST', token, body: { reason } });
      window.alert(`Banned ${who}. Abandoned ${res.airlinesAbandoned} airline(s); closed ${res.reportsActioned} open report(s).`);
      load();
    } catch (e) { setError(e); }
    setBusyId(null);
  };

  const dismiss = async (reportId) => {
    if (!window.confirm('Dismiss this report as not actionable?')) return;
    setBusyId(reportId); setError(null);
    try {
      await api(`/admin/reports/${reportId}/dismiss`, { method: 'POST', token, body: {} });
      load();
    } catch (e) { setError(e); }
    setBusyId(null);
  };

  const unban = async (accountId, who) => {
    if (!window.confirm(`Unban ${who}? They'll be able to sign in and join worlds again (past airlines stay abandoned).`)) return;
    setBusyId(accountId); setError(null);
    try {
      await api(`/admin/accounts/${accountId}/unban`, { method: 'POST', token });
      load();
    } catch (e) { setError(e); }
    setBusyId(null);
  };

  return (
    <>
      <a href="#/" className="muted">← All worlds</a>
      <div className="list-head">
        <h2>Moderation</h2>
        <div className="row">
          <button className={`btn small ${tab === 'OPEN' ? 'primary' : ''}`} onClick={() => setTab('OPEN')}>Open reports</button>
          <button className={`btn small ${tab === 'ALL' ? 'primary' : ''}`} onClick={() => setTab('ALL')}>All reports</button>
          <button className={`btn small ${tab === 'BANS' ? 'primary' : ''}`} onClick={() => setTab('BANS')}>Banned players</button>
        </div>
      </div>
      <ErrorNote error={error} />

      {tab !== 'BANS' ? (
        reports == null ? <p className="muted">Loading reports…</p> :
        reports.length === 0 ? <p className="muted">{tab === 'OPEN' ? 'No open reports — all clear.' : 'No reports yet.'}</p> : (
          <div className="mod-list">
            {reports.map((r) => (
              <div key={r.id} className={`card mod-report ${r.status !== 'OPEN' ? 'resolved' : ''}`}>
                <div className="mod-report-head">
                  <span className="mod-cat">{CATEGORY_LABEL[r.category] ?? r.category}</span>
                  <StatusChip status={r.status} />
                  {r.reported.openReportCount > 1 && (
                    <span className="chip chip-warn" title="Multiple open reports about this player">
                      {r.reported.openReportCount} open reports
                    </span>
                  )}
                  <span className="muted small" style={{ marginLeft: 'auto' }}>{fmtWhen(r.createdAt)}</span>
                </div>

                <p className="mod-line">
                  <strong>{r.reported.airline?.name ?? r.reported.displayName}</strong>
                  <span className="muted"> ({r.reported.email})</span>
                  {r.reported.bannedAt && <span className="chip chip-banned"> banned</span>}
                  {' '}reported by <strong>{r.reporter.airline?.name ?? r.reporter.displayName}</strong>
                  <span className="muted"> in {r.world?.name ?? 'a world'}</span>
                </p>

                {r.details && <p className="mod-details">“{r.details}”</p>}

                {r.status !== 'OPEN' && (
                  <p className="muted small">
                    {r.status === 'ACTIONED' ? 'Actioned' : 'Dismissed'}
                    {r.resolvedByEmail ? ` by ${r.resolvedByEmail}` : ''}
                    {r.resolvedAt ? ` · ${fmtWhen(r.resolvedAt)}` : ''}
                    {r.resolutionNote ? ` — ${r.resolutionNote}` : ''}
                  </p>
                )}

                {r.status === 'OPEN' && (
                  <div className="row">
                    {r.reported.bannedAt ? (
                      <span className="muted small">This account is already banned.</span>
                    ) : (
                      <button className="btn danger small" disabled={busyId === r.reported.accountId}
                        onClick={() => ban(r.reported.accountId, r.reported.airline?.name ?? r.reported.displayName)}>
                        Ban this player
                      </button>
                    )}
                    <button className="btn small" disabled={busyId === r.id} onClick={() => dismiss(r.id)}>Dismiss</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )
      ) : (
        bans == null ? <p className="muted">Loading…</p> :
        bans.length === 0 ? <p className="muted">No banned players.</p> : (
          <table className="worlds">
            <thead><tr><th>Player</th><th>Email</th><th>Reason</th><th>Banned</th><th /></tr></thead>
            <tbody>
              {bans.map((b) => (
                <tr key={b.id}>
                  <td>{b.displayName}</td>
                  <td className="muted">{b.email}</td>
                  <td>{b.banReason || <span className="muted">—</span>}</td>
                  <td className="muted small">{fmtWhen(b.bannedAt)}{b.bannedByEmail ? ` · by ${b.bannedByEmail}` : ''}</td>
                  <td>
                    <button className="btn small" disabled={busyId === b.id} onClick={() => unban(b.id, b.displayName)}>Unban</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}
    </>
  );
}

// ── Report a player (standalone entry — deep-linked as #/report) ──────────────
// The static Rules page links here with "⚑ Report a player". Reporting is world-
// and target-scoped, so this walks a signed-in player through it: pick one of the
// worlds you're in, then pick who to report — funnelling into the very same
// POST /worlds/:id/report the in-game Report buttons use (ReportDialog).
function ReportScreen({ token, me }) {
  const active = (me?.airlines ?? []).filter((a) => a.status !== 'ABANDONED');
  const [worldId, setWorldId] = useState(active.length === 1 ? active[0].worldId : '');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [target, setTarget] = useState(null); // { id, name } being reported

  useEffect(() => {
    if (!worldId || !token) { setData(null); return; }
    let alive = true;
    setData(null); setError(null);
    api(`/worlds/${worldId}`, { token })
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e));
    return () => { alive = false; };
  }, [worldId, token]);

  if (!token) {
    return (
      <div className="card">
        <h2>Report a player</h2>
        <p className="muted">Sign in above to report a player.</p>
        <a href="#/" className="muted">← All worlds</a>
      </div>
    );
  }
  if (active.length === 0) {
    return (
      <div className="card">
        <h2>Report a player</h2>
        <p className="muted">You can report players in the worlds you're competing in — you're not in any yet.</p>
        <a className="btn" href="#/">Browse worlds</a>
      </div>
    );
  }

  const myAirlineId = active.find((a) => a.worldId === worldId)?.id;
  const others = (data?.standings ?? [])
    .filter((a) => a.id !== myAirlineId && a.status !== 'ABANDONED');
  const worldName = active.find((a) => a.worldId === worldId)?.world?.name
    ?? data?.world?.name ?? 'your world';

  return (
    <>
      <a href="#/" className="muted">← All worlds</a>
      <div className="card">
        <h2>Report a player</h2>
        <p className="muted">
          Flag someone breaking the <a href="/rules.html">fair-play rules</a>. Pick the
          world and the player — it goes straight to the admins for review.
        </p>
        {active.length > 1 && (
          <label>World
            <select value={worldId} onChange={(e) => { setWorldId(e.target.value); setTarget(null); }}>
              <option value="">Select a world…</option>
              {active.map((a) => (
                <option key={a.worldId} value={a.worldId}>{a.world?.name ?? a.worldId}</option>
              ))}
            </select>
          </label>
        )}
        <ErrorNote error={error} />
      </div>

      {worldId && (
        <>
          <h3>Players in {worldName}</h3>
          {!data ? <p className="muted">Loading players…</p> :
            others.length === 0 ? <p className="muted">No other players to report in this world yet.</p> : (
            <table className="worlds">
              <thead><tr><th>Airline</th><th>Hub</th><th /></tr></thead>
              <tbody>
                {others.map((a) => (
                  <tr key={a.id}>
                    <td>
                      {a.name}
                      {a.alliance ? <span className="alliance-tag" title={`Alliance: ${a.alliance}`}>🤝 {a.alliance}</span> : null}
                    </td>
                    <td>{a.hub}</td>
                    <td>
                      <button className="btn danger small" onClick={() => setTarget({ id: a.id, name: a.name })}>
                        ⚑ Report
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      {target && (
        <ReportDialog
          worldId={worldId} token={token} airlineId={target.id} airlineName={target.name}
          onClose={() => setTarget(null)}
        />
      )}
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

  // The game owns the whole viewport — no lobby shell around it.
  if (route.screen === 'play') {
    if (!ready) return null;
    if (!session) return <div className="shell"><SignIn /></div>;
    return (
      <Suspense fallback={<div className="shell"><p className="muted">Loading the game…</p></div>}>
        <GamePlayScreen worldId={route.worldId} token={token} />
      </Suspense>
    );
  }

  return (
    <div className="shell">
      <header>
        <a href="#/" className="brand">
          <img src="/headwinds-mark-color.png" alt="" className="brand-mark" />
          HEADWINDS<span className="muted"> · multiplayer</span>
        </a>
        {session ? (
          <div className="row">
            {me?.account?.isAdmin && <a href="#/admin" className="btn small">🛡 Admin</a>}
            <span className="muted">{me?.account?.displayName ?? session.user.email}</span>
            <button className="btn small" onClick={signOut}>Sign out</button>
          </div>
        ) : null}
      </header>

      {!ready ? <p className="muted">Loading…</p> : (
        <>
          {!session && <SignIn />}
          {route.screen === 'worlds' && <WorldsScreen token={token} me={me} />}
          {route.screen === 'world' && <WorldScreen worldId={route.worldId} token={token} me={me} refreshMe={refreshMe} />}
          {route.screen === 'admin' && <ModerationScreen token={token} me={me} />}
          {route.screen === 'report' && <ReportScreen token={token} me={me} />}
        </>
      )}

      <footer className="muted small">
        <a href="/">Home</a> · <a href="/how-to-play.html">How to play</a> ·{' '}
        <a href="/strategy.html">Strategy</a> · <a href="/devlog.html">Devlog</a> ·{' '}
        <a href="/faq.html">FAQ</a> — Headwinds is the multiplayer companion to{' '}
        <a href="https://www.tailwindsairlinegame.com" target="_blank" rel="noreferrer">Tailwinds</a>.
      </footer>
    </div>
  );
}
