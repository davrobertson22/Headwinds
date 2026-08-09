// World activity TICKER — the 🌍 button in the multiplayer topbar.
// ----------------------------------------------------------------------------
// This used to be the whole news surface: a slide-over drawer holding an
// unrolled, unranked list of every public move in the world. Players told us it
// read as noise, and they were right — a bulk route opening filled it, and joins
// from months ago competed with this week's headlines.
//
// The full story now lives in the in-game News tab (src/components/News.jsx),
// which groups, filters and ranks. What is left here is what a ticker is for:
// the handful of tier-1 headlines, an unread dot, and a way through to the tab.
import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { api } from './api.js';
import OgBadge, { DevBadge } from './OgBadge.jsx';
import { useVisibleInterval } from './usePoll.js';
import { getAircraftType } from '../../../src/data/aircraft.js';

const TICKER_LIMIT = 8;

const plural = (n, one, many) => `${Number(n ?? 0).toLocaleString()} ${n === 1 ? one : many}`;
const typeName = (id) => getAircraftType(id)?.name ?? id ?? 'an aircraft';
// `count` is how many tails fly the pair — the server counts routes, not route
// records, so three aircraft on JFK–LHR is one route "×3", not three routes.
const pairLabel = (p) => `${p.origin}–${p.destination}${p.count > 1 ? ` ×${p.count}` : ''}`;

// A deliberately terse echo of News.jsx's composer: the ticker has one line per
// item, so it says what happened and leaves the detail to the tab.
function describe(e) {
  const d = e.data ?? {};
  switch (e.kind) {
    case 'event_started': return { who: d.name ?? 'World event', what: '', icon: d.icon ?? '🌍' };
    case 'event_ended':   return { who: d.name ?? 'World event', what: 'has passed', icon: d.icon ?? '🌍' };
    case 'bankruptcy':    return { who: e.airline, what: 'has gone under', icon: '📉' };
    case 'rank_change':   return {
      who: e.airline,
      what: d.direction === 'in' ? `climbed into the top 5 — now #${d.rank}` : 'dropped out of the top 5',
      icon: d.direction === 'in' ? '📈' : '📉',
    };
    case 'routes_opened': return {
      who: e.airline,
      what: d.total === 1 && d.pairs?.[0]
        ? `opened ${pairLabel(d.pairs[0])}`
        : `opened ${plural(d.total, 'route', 'routes')}${d.commonOrigin ? ` from ${d.commonOrigin}` : ''}`,
      icon: '🛫',
    };
    case 'routes_closed': return {
      who: e.airline,
      what: d.total === 1 && d.pairs?.[0]
        ? `closed ${pairLabel(d.pairs[0])}`
        : `closed ${plural(d.total, 'route', 'routes')}`,
      icon: '🛬',
    };
    case 'fleet_in': {
      const [top] = Object.entries(d.byType ?? {}).sort((a, b) => b[1] - a[1]);
      const what = top
        ? `${d.ordered ? 'ordered' : 'bought'} ${top[1] > 1 ? `${top[1]}× ` : 'a '}${typeName(top[0])}`
        : `${d.ordered ? 'ordered' : 'bought'} ${plural(d.total, 'aircraft', 'aircraft')}`;
      return { who: e.airline, what, icon: '✈️' };
    }
    case 'fleet_out':     return { who: e.airline, what: `${d.retired ? 'retired' : 'sold'} ${plural(d.total, 'aircraft', 'aircraft')}`, icon: '🛠️' };
    case 'gates_added':   return { who: e.airline, what: `took ${plural(d.total, 'gate', 'gates')}${d.airportCode ? ` at ${d.airportCode}` : ''}`, icon: '🛄' };
    case 'gates_removed': return { who: e.airline, what: `released ${plural(d.total, 'gate', 'gates')}${d.airportCode ? ` at ${d.airportCode}` : ''}`, icon: '🛄' };
    case 'hub_designated': return { who: e.airline, what: `designated ${d.airportCode ?? 'a new'} hub`, icon: '🏛️' };
    case 'hub_upgraded':   return { who: e.airline, what: `upgraded ${d.airportCode ? `its ${d.airportCode} hub` : 'a hub'}`, icon: '🏛️' };
    case 'focus_city':     return { who: e.airline, what: `made ${d.airportCode ?? 'an airport'} a focus city`, icon: '📍' };
    case 'stock_tape':     return {
      who: e.airline,
      what: `${d.direction === 'buy' ? 'bought into' : 'sold down'} ${d.targetName ?? 'a rival'}${d.stakePct ? ` — now ${d.stakePct}%` : ''}`,
      icon: '📊',
    };
    case 'gate_auction_opened': return { who: d.airport, what: `gate auction opened — ${plural(d.lots ?? 1, 'gate', 'gates')} on offer`, icon: '🔨' };
    case 'gate_auction_won':    return { who: e.airline, what: `won ${plural(d.gates ?? 1, 'gate', 'gates')} at ${d.airport}`, icon: '🔨' };
    case 'gate_auction_unsold': return { who: d.airport, what: 'gate auction closed — no gates sold', icon: '🔨' };
    case 'gate_sold':           return { who: e.airline, what: `sold a ${d.airport} gate to ${d.buyer}`, icon: '🤝' };
    case 'gate_forfeited':      return {
      who: e.airline,
      what: `forfeited ${plural(d.gates ?? 1, 'gate', 'gates')} at ${d.airport} — unused for too long`
          + `${d.lockoutWeeks ? `, locked out for ${d.lockoutWeeks} weeks` : ''}`,
      icon: '\u{1F6D1}',
    };
    case 'used_aircraft_sold':  return { who: e.airline, what: `picked up a used ${typeName(d.typeId)}`, icon: '🏷️' };
    case 'joined':              return { who: e.airline, what: `joined the world${d.hub ? ` · hub ${d.hub}` : ''}`, icon: '🛬' };
    case 'alliance_founded':    return { who: d.alliance, what: 'alliance founded', icon: '🤝' };
    case 'alliance_joined':     return { who: e.airline, what: `joined the ${d.alliance} alliance`, icon: '🤝' };
    case 'alliance_left':       return { who: e.airline, what: 'left its alliance', icon: '🤝' };
    default:                    return { who: e.airline, what: e.kind, icon: '•' };
  }
}

const fmtWhen = (iso) => {
  const d = new Date(iso);
  const mins = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

const LAST_SEEN_KEY = (worldId) => `hw_feed_seen_${worldId}`;

// The ticker lives in the topbar, which the shared App shell renders — it has no
// handle on the App's active tab. A DOM event is the least-coupled way across:
// App listens for it and navigates. (See the 'hw:navigate' listener in App.jsx.)
const openNewsTab = () => {
  window.dispatchEvent(new CustomEvent('hw:navigate', { detail: 'news' }));
};

export default function FeedWidget({ worldId, token, myAirlineId = null, onOpenNews = openNewsTab }) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState(null);
  const [error, setError] = useState(null);
  const [hasNew, setHasNew] = useState(false);

  const load = useCallback(() => {
    // tier=1 only: the ticker carries headlines, not the full record.
    api(`/worlds/${worldId}/news?tier=1&limit=${TICKER_LIMIT}`, { token })
      .then((d) => {
        setError(null);
        const items = d.items ?? [];
        const latest = items[0]?.at;
        const seen = localStorage.getItem(LAST_SEEN_KEY(worldId));
        setHasNew(Boolean(latest && latest !== seen));
        setEvents(items);
      })
      .catch(setError);
  }, [worldId, token]);

  useEffect(() => { load(); }, [load]);
  // Paused while the tab is hidden; refetches on return. See usePoll.js.
  useVisibleInterval(load, open ? 20000 : 60000);

  const openDrawer = () => {
    setOpen((o) => !o);
    const latest = events?.[0]?.at;
    if (latest) {
      localStorage.setItem(LAST_SEEN_KEY(worldId), latest);
      setHasNew(false);
    }
  };

  return (
    <>
      <button className="hw-msg-btn" onClick={openDrawer} title="World headlines">
        🌍 <span className="hw-btn-label">Activity</span>
        {hasNew && !open && <span className="hw-msg-badge">•</span>}
      </button>
      {/* Portal to <body>: the button lives inside the game topbar, whose
          backdrop-filter makes it the containing block for position:fixed —
          rendered in place, the full-height drawer would be clipped to the
          58px topbar. */}
      {open && createPortal(
        <div className="hw-msg-drawer">
          <div className="hw-msg-head">
            <div style={{ fontWeight: 700, fontSize: 14, padding: '2px 4px' }}>Headlines</div>
            <button className="hw-msg-close" onClick={() => setOpen(false)} title="Close">×</button>
          </div>
          {error && <p className="error" style={{ padding: '0 14px' }}>{String(error.message || error)}</p>}
          <div className="hw-msg-body">
            {!events && <p className="muted" style={{ padding: '8px 4px' }}>Loading…</p>}
            {events && events.length === 0 && (
              <p className="muted" style={{ padding: '8px 4px' }}>
                Quiet so far — big moves show up here as players make them.
              </p>
            )}
            {events && events.map((e) => {
              const d = describe(e);
              const mine = myAirlineId && e.airlineId === myAirlineId;
              return (
                <div key={e.id} style={{
                  display: 'flex', gap: 8, alignItems: 'baseline',
                  padding: '7px 4px', borderBottom: '1px solid var(--border, rgba(255,255,255,0.08))',
                  fontSize: 13, lineHeight: 1.5,
                }}>
                  <span style={{ flexShrink: 0 }}>{d.icon}</span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <strong>{d.who}</strong>{e.dev ? <DevBadge /> : null}{e.og ? <OgBadge /> : null}{mine ? <strong> (you)</strong> : ''}
                    {d.what ? ` ${d.what}` : ''}
                    {e.week != null && <span style={{ opacity: 0.55 }}> · W{e.week}</span>}
                  </span>
                  <span style={{ flexShrink: 0, opacity: 0.55, fontSize: 11 }}>{fmtWhen(e.at)}</span>
                </div>
              );
            })}
            <button
              className="hw-msg-btn"
              style={{ margin: '12px auto', display: 'block' }}
              onClick={() => { setOpen(false); onOpenNews?.(); }}
            >
              See all news →
            </button>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
