// Headwinds web client — sign in → browse worlds → join → play.
// Hash routes: '#/' world list · '#/w/<id>' world lobby · '#/w/<id>/play' the
// full Tailwinds game UI running on server-authoritative state.
import { useState, useEffect, useCallback, useMemo, lazy, Suspense, Fragment } from 'react';
import { supabase } from './supabase.js';
import { api } from './api.js';
import { AIRPORTS } from '../../../packages/engine/src/data/airports.js';
import { AIRCRAFT_TYPES } from '../../../packages/engine/src/data/aircraft.js';
import { hydrateRoute } from '../../../packages/engine/src/utils/simulation.js';

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

// ── Airline gameplay panel (Phase 2) ──────────────────────────────────────────
// Reads the authoritative state blob from the server; submits decisions and
// re-renders from the server's result. The engine runs HERE only for display
// helpers (hydrateRoute) — never to compute outcomes.

function AirlinePanel({ worldId, token }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  // forms
  const [leaseType, setLeaseType] = useState('');
  const [gateCode, setGateCode] = useState('');
  const [rtAircraft, setRtAircraft] = useState('');
  const [rtDest, setRtDest] = useState('');
  const [rtFreq, setRtFreq] = useState(7);

  const load = useCallback(() => {
    api(`/worlds/${worldId}/airline`, { token }).then(setData).catch(setError);
  }, [worldId, token]);
  useEffect(() => {
    load();
    const t = setInterval(load, 10000); // catch server ticks
    return () => clearInterval(t);
  }, [load]);

  const decide = async (type, payload) => {
    setBusy(true); setError(null);
    try {
      const res = await api(`/worlds/${worldId}/decisions`, { method: 'POST', token, body: { type, payload } });
      setData((d) => ({ ...d, state: res.state }));
      if (res.error) setError(new Error(res.error));
    } catch (e) { setError(e); }
    setBusy(false);
  };

  if (error && !data) return <ErrorNote error={error} />;
  if (!data) return <p className="muted">Loading your airline…</p>;

  const s = data.state;
  const routes = (s.routes ?? []).map((r) => hydrateRoute(r, s.routePricing, s.routeCatering));
  const report = (s.financialHistory ?? [])[s.financialHistory?.length - 1];
  const idleAircraft = (s.fleet ?? []).filter((a) => a.status === 'idle');
  const paxTypes = AIRCRAFT_TYPES.filter((t) => !t.freighter);
  const acType = (id) => AIRCRAFT_TYPES.find((t) => t.id === id);

  return (
    <div className="card">
      <div className="row wrap kpis">
        <span><strong>Y{s.year ?? 1} W{s.week ?? 1}</strong> <span className="muted">(server clock)</span></span>
        <span>Cash <strong>{fmtMoney(s.cash)}</strong></span>
        <span>Fleet <strong>{s.fleet?.length ?? 0}</strong></span>
        <span>Routes <strong>{routes.length}</strong></span>
        {report && (
          <span>Last week{' '}
            <strong className={report.profit >= 0 ? 'pos' : 'neg'}>
              {report.profit >= 0 ? '+' : ''}{fmtMoney(report.profit)}
            </strong>
            <span className="muted"> (rev {fmtMoney(report.revenue)})</span>
          </span>
        )}
      </div>
      <ErrorNote error={error} />

      <h4>Fleet</h4>
      {(s.fleet ?? []).length === 0 ? <p className="muted small">No aircraft yet — lease one below.</p> : (
        <table className="worlds compact">
          <tbody>
            {s.fleet.map((a) => (
              <tr key={a.id}>
                <td>{a.name ?? a.typeId}</td>
                <td className="muted">{acType(a.typeId)?.name ?? a.typeId}</td>
                <td>{a.leased ? 'leased' : 'owned'}</td>
                <td><StatusChip status={a.status ?? 'idle'} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="row wrap">
        <select value={leaseType} onChange={(e) => setLeaseType(e.target.value)}>
          <option value="">Lease an aircraft…</option>
          {paxTypes.map((t) => (
            <option key={t.id} value={t.id}>{t.name} · {t.seats} seats · {Math.round(t.range).toLocaleString()} km</option>
          ))}
        </select>
        <button className="btn small" disabled={busy || !leaseType}
          onClick={() => { decide('LEASE_AIRCRAFT', { typeId: leaseType }); setLeaseType(''); }}>
          Lease
        </button>
      </div>

      <h4>Routes</h4>
      {routes.length === 0 ? <p className="muted small">No routes — add a gate at a destination, then open one.</p> : (
        <table className="worlds compact">
          <thead><tr><th>Route</th><th>Fare</th><th>Freq/wk</th><th /></tr></thead>
          <tbody>
            {routes.map((r) => (
              <tr key={r.id}>
                <td>{r.origin} → {r.destination}</td>
                <td>
                  <input type="number" className="inline-num" defaultValue={Math.round(r.ticketPrice ?? 0)}
                    onBlur={(e) => {
                      const p = Number(e.target.value);
                      // Engine payload field is `ticketPrice` (was `price` — a bug that
                      // clamped every lobby fare edit down to $1).
                      if (p > 0 && p !== Math.round(r.ticketPrice ?? 0)) decide('UPDATE_TICKET_PRICE', { routeId: r.id, ticketPrice: p });
                    }} />
                </td>
                <td>
                  <input type="number" className="inline-num" defaultValue={r.weeklyFrequency}
                    onBlur={(e) => {
                      const f = Number(e.target.value);
                      if (f > 0 && f !== r.weeklyFrequency) decide('UPDATE_FREQUENCY', { routeId: r.id, weeklyFrequency: f });
                    }} />
                </td>
                <td><button className="btn danger small" disabled={busy}
                  onClick={() => window.confirm(`Close ${r.origin}→${r.destination}?`) && decide('CLOSE_ROUTE', { routeId: r.id })}>
                  Close
                </button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="row wrap">
        <select value={rtAircraft} onChange={(e) => setRtAircraft(e.target.value)}>
          <option value="">Open route with…</option>
          {idleAircraft.map((a) => <option key={a.id} value={a.id}>{a.name ?? acType(a.typeId)?.name}</option>)}
        </select>
        <input list="hub-airports" placeholder="Destination" className="hub-input"
          value={rtDest} onChange={(e) => setRtDest(e.target.value)} />
        <input type="number" min={1} max={50} className="inline-num" title="Flights per week"
          value={rtFreq} onChange={(e) => setRtFreq(e.target.value)} />
        <button className="btn small" disabled={busy || !rtAircraft || !rtDest}
          onClick={() => {
            decide('ADD_ROUTE', {
              aircraftId: rtAircraft,
              origin: s.hub,
              destination: rtDest.toUpperCase(),
              weeklyFrequency: Number(rtFreq),
            });
            setRtDest('');
          }}>
          Open route from {s.hub}
        </button>
      </div>
      <p className="muted small">
        Gates: {Object.entries(s.gates ?? {}).map(([c, n]) => `${c}×${n}`).join(', ') || 'none'} —
        routes need a gate at both ends.
      </p>
      <div className="row wrap">
        <input list="hub-airports" placeholder="Airport" className="hub-input"
          value={gateCode} onChange={(e) => setGateCode(e.target.value)} />
        <button className="btn small" disabled={busy || gateCode.length < 3}
          onClick={() => { decide('ADD_GATE', { airportCode: gateCode.toUpperCase() }); setGateCode(''); }}>
          Add gate
        </button>
      </div>
      <p className="muted small">
        This is the Phase-2 starter cockpit — the full Tailwinds UI moves over next.
        The server tick advances your airline even while you're away.
      </p>
    </div>
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

function RivalDetail({ worldId, airlineId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

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
      </div>

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
            <div className="row">
              <button className="btn primary" onClick={() => goTo(`/w/${world.id}/play`)}>▶ Open the game</button>
              <button className="btn danger small" onClick={leave}>Abandon airline</button>
            </div>
          </div>
        )}
      </div>

      {mine && <AirlinePanel worldId={world.id} token={token} />}

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
                  <td>{a.name}{mine?.id === a.id ? <span className="muted"> (you)</span> : null}</td>
                  <td>{a.hub}</td>
                  <td>{a.routes}</td><td>{a.fleet}</td>
                  <td>{fmtMoney(a.cash)}</td><td>{fmtMoney(a.marketCap)}</td>
                  <td><StatusChip status={a.status} /></td>
                </tr>
                {openRival === a.id && (
                  <tr>
                    <td colSpan={8} style={{ padding: 0, border: 'none' }}>
                      <RivalDetail worldId={world.id} airlineId={a.id} />
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
          {route.screen === 'worlds' && <WorldsScreen token={token} me={me} />}
          {route.screen === 'world' && <WorldScreen worldId={route.worldId} token={token} me={me} refreshMe={refreshMe} />}
        </>
      )}

      <footer className="muted small">
        Headwinds is the multiplayer companion to{' '}
        <a href="https://www.tailwindsairlinegame.com" target="_blank" rel="noreferrer">Tailwinds</a>.
      </footer>
    </div>
  );
}
