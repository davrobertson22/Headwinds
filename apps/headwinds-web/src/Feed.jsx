// World activity feed — "this week in your world".
// A 🌍 Activity button for the multiplayer top bar opening a slide-over feed of
// every player's PUBLIC moves (server-filtered: route/fleet/hub/alliance events,
// never prices, budgets or loans) plus system events (joins, alliances forming).
// Headwinds-owned (not synced from Tailwinds) — safe to evolve freely.
import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { api } from './api.js';
import OgBadge, { DevBadge } from './OgBadge.jsx';

const LABELS = {
  ADD_ROUTE:            (e) => `opened ${e.payload?.origin ?? '?'}–${e.payload?.destination ?? '?'}`,
  CLOSE_ROUTE:          (e) => (e.payload?.origin && e.payload?.destination)
                          ? `closed ${e.payload.origin}–${e.payload.destination}` : 'closed a route',
  CLOSE_ROUTES:         (e) => {
    const rs = Array.isArray(e.payload?.routes) ? e.payload.routes.filter(r => r?.origin && r?.destination) : [];
    const n = e.payload?.count ?? rs.length;
    if (rs.length) {
      const shown = rs.slice(0, 3).map(r => `${r.origin}–${r.destination}`).join(', ');
      return `closed ${shown}${n > rs.slice(0, 3).length ? ` +${n - 3} more` : ''}`;
    }
    return n > 1 ? `closed ${n} routes` : 'closed a route';
  },
  ADD_CARGO_ROUTE:      (e) => `opened cargo lane ${e.payload?.origin ?? '?'}–${e.payload?.destination ?? '?'}`,
  CLOSE_CARGO_ROUTE:    (e) => `closed cargo lane ${e.payload?.origin ?? '?'}–${e.payload?.destination ?? '?'}`,
  LEASE_AIRCRAFT:       (e) => `leased ${e.payload?.typeId ? `a ${e.payload.typeId}` : 'an aircraft'}`,
  BUY_AIRCRAFT:         (e) => `bought ${e.payload?.typeId ? `a ${e.payload.typeId}` : 'an aircraft'}`,
  ORDER_AIRCRAFT:       (e) => `ordered ${e.payload?.typeId ? `a ${e.payload.typeId}` : 'an aircraft'}`,
  SELL_AIRCRAFT:        () => 'sold an aircraft',
  RETIRE_AIRCRAFT:      () => 'retired an aircraft',
  ADD_GATE:             (e) => `added a gate${e.payload?.airportCode ? ` at ${e.payload.airportCode}` : ''}`,
  REMOVE_GATE:          (e) => `released a gate${e.payload?.airportCode ? ` at ${e.payload.airportCode}` : ''}`,
  UPGRADE_HUB:          (e) => `upgraded ${e.payload?.airportCode ? `hub ${e.payload.airportCode}` : 'a hub'}`,
  DESIGNATE_HUB:        (e) => `designated ${e.payload?.airportCode ?? 'a new'} hub`,
  DESIGNATE_FOCUS_CITY: (e) => `made ${e.payload?.airportCode ?? 'an airport'} a focus city`,
  JOIN_ALLIANCE:        () => 'joined an alliance',
  LEAVE_ALLIANCE:       () => 'left an alliance',
};

function describe(e) {
  if (e.kind === 'joined') return { who: e.airline, what: `joined the world${e.hub ? ` · hub ${e.hub}` : ''}`, icon: '🛬' };
  if (e.kind === 'alliance_founded') return { who: e.alliance, what: 'alliance founded', icon: '🤝' };
  if (e.kind === 'alliance_joined') return { who: e.airline, what: `joined the ${e.alliance} alliance`, icon: '🤝' };
  // Gate scarcity events
  if (e.kind === 'gate_auction_opened') {
    return { who: e.airport, what: `gate auction opened — ${e.lots} gate${e.lots > 1 ? 's' : ''} on offer (sealed bids, resolves at the new year)`, icon: '🔨' };
  }
  if (e.kind === 'gate_auction_won') {
    return { who: e.airline, what: `won ${e.gates} gate${e.gates > 1 ? 's' : ''} at ${e.airport} for $${(e.pricePerGate ?? 0).toLocaleString()}/gate`, icon: '🔨' };
  }
  if (e.kind === 'gate_sold') {
    return { who: e.airline, what: `sold a ${e.airport} gate to ${e.buyer} for $${(e.price ?? 0).toLocaleString()}`, icon: '🤝' };
  }
  const label = LABELS[e.type];
  return { who: e.airline, what: label ? label(e) : e.type, icon: '✈️' };
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

export default function FeedWidget({ worldId, token, myAirlineId = null }) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState(null);
  const [nextBefore, setNextBefore] = useState(null);
  const [error, setError] = useState(null);
  const [hasNew, setHasNew] = useState(false);
  const [paginated, setPaginated] = useState(false);

  const load = useCallback(() => {
    api(`/worlds/${worldId}/feed`, { token })
      .then((d) => {
        setError(null);
        const latest = d.events[0]?.at;
        const seen = localStorage.getItem(LAST_SEEN_KEY(worldId));
        setHasNew(Boolean(latest && latest !== seen));
        if (paginated) {
          // User loaded older pages — a full replace would wipe that history and
          // reset scroll. Prepend only genuinely-new events; leave nextBefore
          // (the older-page cursor) untouched.
          setEvents((prev) => {
            if (!prev || prev.length === 0) return d.events;
            const newest = prev[0]?.at;
            const fresh = newest ? d.events.filter((e) => e.at > newest) : d.events;
            return fresh.length ? [...fresh, ...prev] : prev;
          });
        } else {
          setEvents(d.events);
          setNextBefore(d.nextBefore);
        }
      })
      .catch(setError);
  }, [worldId, token, paginated]);

  // Light poll for the "new activity" dot; full refresh while open.
  useEffect(() => {
    load();
    const t = setInterval(load, open ? 15000 : 60000);
    return () => clearInterval(t);
  }, [load, open]);

  const openDrawer = () => {
    setOpen((o) => !o);
    const latest = events?.[0]?.at;
    if (latest) {
      localStorage.setItem(LAST_SEEN_KEY(worldId), latest);
      setHasNew(false);
    }
  };

  const loadMore = () => {
    if (!nextBefore) return;
    setPaginated(true);
    api(`/worlds/${worldId}/feed?before=${encodeURIComponent(nextBefore)}`, { token })
      .then((d) => {
        setEvents((prev) => [...(prev ?? []), ...d.events]);
        setNextBefore(d.nextBefore);
      })
      .catch(setError);
  };

  return (
    <>
      <button className="hw-msg-btn" onClick={openDrawer} title="World activity">
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
            <div style={{ fontWeight: 700, fontSize: 14, padding: '2px 4px' }}>This week in your world</div>
            <button className="hw-msg-close" onClick={() => setOpen(false)} title="Close">×</button>
          </div>
          {error && <p className="error" style={{ padding: '0 14px' }}>{String(error.message || error)}</p>}
          <div className="hw-msg-body">
            {!events && <p className="muted" style={{ padding: '8px 4px' }}>Loading…</p>}
            {events && events.length === 0 && (
              <p className="muted" style={{ padding: '8px 4px' }}>
                Nothing yet — moves show up here as players act.
              </p>
            )}
            {events && events.map((e, i) => {
              const d = describe(e);
              const mine = myAirlineId && e.airlineId === myAirlineId;
              return (
                <div key={`${e.at}-${i}`} style={{
                  display: 'flex', gap: 8, alignItems: 'baseline',
                  padding: '7px 4px', borderBottom: '1px solid var(--border, rgba(255,255,255,0.08))',
                  fontSize: 13, lineHeight: 1.5,
                }}>
                  <span style={{ flexShrink: 0 }}>{d.icon}</span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <strong>{d.who}</strong>{e.dev ? <DevBadge /> : null}{e.og ? <OgBadge /> : null}{mine ? <strong> (you)</strong> : ''} {d.what}
                    {e.week != null && <span style={{ opacity: 0.55 }}> · W{e.week}</span>}
                  </span>
                  <span style={{ flexShrink: 0, opacity: 0.55, fontSize: 11 }}>{fmtWhen(e.at)}</span>
                </div>
              );
            })}
            {nextBefore && (
              <button className="hw-msg-btn" style={{ margin: '10px auto', display: 'block' }} onClick={loadMore}>
                Load older
              </button>
            )}
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
