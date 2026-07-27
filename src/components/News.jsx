// News — the world's shared story, one screen.
// ----------------------------------------------------------------------------
// Multiplayer only (the tab is hidden in solo). Reads GET /worlds/:id/news via
// remoteApi.fetchNews; the server has already rolled related moves into single
// items and assigned each a tier, so this file is presentation plus two things
// the server deliberately does NOT do:
//
//   • RELEVANCE. "A rival just opened a route on a city pair you fly" needs the
//     viewer's own network. The client already holds it, so promoting those
//     items happens here — no per-request save-blob load, and the server's
//     response stays identical for every viewer and therefore cacheable.
//   • WORDING. The server ships structured data; sentences are composed here so
//     aircraft and airport names resolve against the same tables the rest of the
//     game uses.
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useGame } from '../store/GameContext.jsx';
import { getAircraftType } from '../data/aircraft.js';
import { formatMoney } from '../utils/simulation.js';
import { NewsIcon } from './Icons.jsx';

const CATEGORIES = [
  { id: 'world',     label: 'World',     icon: '🌍' },
  { id: 'routes',    label: 'Routes',    icon: '🛫' },
  { id: 'fleet',     label: 'Fleet',     icon: '✈️' },
  { id: 'airports',  label: 'Airports',  icon: '🛄' },
  { id: 'market',    label: 'Market',    icon: '🏷️' },
  { id: 'stocks',    label: 'Shares',    icon: '📊' },
  { id: 'standings', label: 'Standings', icon: '🏆' },
  { id: 'players',   label: 'Players',   icon: '👥' },
];

const PAGE = 40;

// Items you can act on link straight to the screen that does the acting. The
// shell owns the tab state, so we ask it to move via 'hw:navigate' (App.jsx);
// `focus` is the id of the section it should scroll to and flash.
const NAV_TARGET = {
  gate_auction_opened: { tab: 'airports', focus: 'gate-market', cta: 'Place a sealed bid' },
  gate_auction_won:    { tab: 'airports', focus: 'gate-market' },
  gate_sold:           { tab: 'airports', focus: 'gate-market' },
};

const goTo = (t) => window.dispatchEvent(
  new CustomEvent('hw:navigate', { detail: { tab: t.tab, focus: t.focus } }),
);

const typeName = (id) => getAircraftType(id)?.name ?? id ?? 'an aircraft';
const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

const fmtWhen = (iso) => {
  const d = new Date(iso);
  const mins = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

// ── Sentence composition ─────────────────────────────────────────────────────
// Returns { icon, headline, sub } — `headline` follows the subject's name.
// Exported so tools/news-render-test.mjs can assert the actual sentences: SSR
// never runs effects, so testing through the component alone would only ever
// exercise the loading state.
export function compose(item) {
  const d = item.data ?? {};
  switch (item.kind) {
    case 'event_started':
      return {
        icon: d.icon ?? '🌍',
        subject: d.name ?? 'World event',
        headline: '',
        sub: d.description ?? null,
        standalone: true,
      };
    case 'event_ended':
      return {
        icon: d.icon ?? '🌍',
        subject: d.name ?? 'World event',
        headline: 'has passed',
        sub: 'Conditions are back to normal.',
        standalone: true,
      };
    case 'bankruptcy':
      return {
        icon: '📉',
        headline: 'has gone under',
        sub: [
          d.routes != null ? plural(d.routes, 'route', 'routes') : null,
          d.fleet != null ? plural(d.fleet, 'aircraft', 'aircraft') : null,
        ].filter(Boolean).join(' and ') + ' leave the market',
      };
    case 'rank_change':
      return d.direction === 'in'
        ? { icon: '📈', headline: `climbed into the top 5 — now #${d.rank}` }
        : { icon: '📉', headline: `dropped out of the top 5 (was #${d.previousRank})` };

    case 'routes_opened': {
      const what = d.cargo ? 'cargo lane' : 'route';
      const head = d.total === 1 && d.pairs[0]
        ? `opened ${d.pairs[0].origin}–${d.pairs[0].destination}`
        : `opened ${plural(d.total, what, `${what}s`)}${d.commonOrigin ? ` from ${d.commonOrigin}` : ''}`;
      return { icon: '🛫', headline: head, pairs: d.pairs, total: d.total };
    }
    case 'routes_closed': {
      const what = d.cargo ? 'cargo lane' : 'route';
      const head = d.total === 1 && d.pairs[0]
        ? `closed ${d.pairs[0].origin}–${d.pairs[0].destination}`
        : `closed ${plural(d.total, what, `${what}s`)}`;
      return { icon: '🛬', headline: head, pairs: d.pairs, total: d.total };
    }
    case 'fleet_in': {
      const parts = Object.entries(d.byType ?? {})
        .sort((a, b) => b[1] - a[1])
        .map(([id, n]) => (n > 1 ? `${n}× ${typeName(id)}` : `a ${typeName(id)}`));
      const verb = d.ordered ? 'ordered' : 'bought';
      const list = parts.length > 2
        ? `${parts.slice(0, 2).join(', ')} and ${parts.length - 2} more`
        : parts.join(' and ');
      return { icon: '✈️', headline: `${verb} ${list || plural(d.total, 'aircraft', 'aircraft')}` };
    }
    case 'fleet_out': {
      const verb = d.retired ? 'retired' : 'sold';
      const parts = Object.entries(d.byType ?? {})
        .sort((a, b) => b[1] - a[1])
        .map(([id, n]) => (n > 1 ? `${n}× ${typeName(id)}` : `a ${typeName(id)}`));
      return { icon: '🛠️', headline: `${verb} ${parts.join(' and ') || plural(d.total, 'aircraft', 'aircraft')}` };
    }
    case 'gates_added':
      return { icon: '🛄', headline: `took ${plural(d.total, 'gate', 'gates')}${d.airportCode ? ` at ${d.airportCode}` : ''}` };
    case 'gates_removed':
      return { icon: '🛄', headline: `released ${plural(d.total, 'gate', 'gates')}${d.airportCode ? ` at ${d.airportCode}` : ''}` };
    case 'hub_designated':
      return { icon: '🏛️', headline: `designated ${d.airportCode ?? 'a new'} hub` };
    case 'hub_upgraded':
      return { icon: '🏛️', headline: `upgraded ${d.airportCode ? `its ${d.airportCode} hub` : 'a hub'}` };
    case 'focus_city':
      return { icon: '📍', headline: `made ${d.airportCode ?? 'an airport'} a focus city` };

    case 'stock_tape': {
      const shares = Math.abs(d.netShares ?? 0);
      const verb = d.direction === 'buy' ? 'bought' : 'sold';
      const target = d.targetName ?? 'a rival';
      const stake = Number.isFinite(d.stakePct) && d.stakePct > 0
        ? ` — now holds ${d.stakePct}%`
        : '';
      return {
        icon: '📊',
        headline: `${verb} ${plural(shares, 'share', 'shares')} in ${target}${stake}`,
        sub: d.grossValue ? `${formatMoney(d.grossValue)} at ${formatMoney(d.pricePerShare ?? 0)}/share` : null,
      };
    }

    case 'gate_auction_opened':
      return {
        icon: '🔨',
        subject: d.airport,
        headline: `gate auction opened — ${plural(d.lots ?? 1, 'gate', 'gates')} on offer`,
        sub: 'Sealed bids, resolves at the new year.',
        standalone: true,
      };
    case 'gate_auction_won':
      return {
        icon: '🔨',
        headline: `won ${plural(d.gates ?? 1, 'gate', 'gates')} at ${d.airport}`,
        sub: d.pricePerGate ? `${formatMoney(d.pricePerGate)} per gate` : null,
      };
    case 'gate_sold':
      return {
        icon: '🤝',
        headline: `sold a ${d.airport} gate to ${d.buyer}`,
        sub: d.price ? formatMoney(d.price) : null,
      };
    case 'used_aircraft_sold':
      return {
        icon: '🏷️',
        headline: `picked up a used ${typeName(d.typeId)}`,
        sub: [d.price ? formatMoney(d.price) : null, d.exOperator ? `ex-${d.exOperator}` : null]
          .filter(Boolean).join(' · ') || null,
      };

    case 'joined':
      return { icon: '🛬', headline: `joined the world${d.hub ? ` · hub ${d.hub}` : ''}` };
    case 'alliance_founded':
      return { icon: '🤝', subject: d.alliance, headline: 'alliance founded', standalone: true };
    case 'alliance_joined':
      return { icon: '🤝', headline: `joined the ${d.alliance} alliance` };
    case 'alliance_left':
      return { icon: '🤝', headline: 'left its alliance' };
    default:
      return { icon: '•', headline: item.kind };
  }
}

// ── Relevance ────────────────────────────────────────────────────────────────
// Everything the viewer's own network touches. An item is "near" when it names
// one of your airports or one of your city pairs — that is the difference
// between a rival's expansion being news and being noise.
function useMyNetwork() {
  const { state } = useGame();
  return useMemo(() => {
    const airports = new Set([
      ...Object.keys(state?.gates ?? {}),
      ...Object.keys(state?.hubs ?? {}),
    ]);
    const pairs = new Set();
    for (const r of [...(state?.routes ?? []), ...(state?.cargoRoutes ?? [])]) {
      if (!r?.origin || !r?.destination) continue;
      airports.add(r.origin);
      airports.add(r.destination);
      pairs.add([r.origin, r.destination].sort().join('-'));
    }
    return { airports, pairs };
  }, [state?.routes, state?.cargoRoutes, state?.gates, state?.hubs]);
}

function touchesMe(item, net, myAirlineId) {
  if (myAirlineId && item.airlineId === myAirlineId) return true;
  const d = item.data ?? {};
  if (d.airportCode && net.airports.has(d.airportCode)) return true;
  if (d.airport && net.airports.has(d.airport)) return true;
  if (d.targetId && d.targetId === myAirlineId) return true;
  for (const p of d.pairs ?? []) {
    if (net.pairs.has([p.origin, p.destination].sort().join('-'))) return true;
    if (net.airports.has(p.origin) || net.airports.has(p.destination)) return true;
  }
  return false;
}

// ── Component ────────────────────────────────────────────────────────────────
export default function News() {
  const { remoteApi } = useGame();
  const net = useMyNetwork();
  const myAirlineId = remoteApi?.airlineId ?? null;

  const [items, setItems] = useState(null);
  const [nextBefore, setNextBefore] = useState(null);
  const [error, setError] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [active, setActive] = useState(() => new Set(CATEGORIES.map((c) => c.id)));
  const [bigOnly, setBigOnly] = useState(false);
  const [nearOnly, setNearOnly] = useState(false);
  const [expanded, setExpanded] = useState(() => new Set());
  const [hideMine, setHideMine] = useState(false);
  const seenIds = useRef(new Set());

  const allOn = active.size === CATEGORIES.length;
  const categoriesParam = allOn ? '' : `&categories=${[...active].join(',')}`;

  const load = useCallback(() => {
    if (!remoteApi?.fetchNews) return;
    remoteApi.fetchNews(`?limit=${PAGE}${categoriesParam}`)
      .then((d) => {
        setError(null);
        seenIds.current = new Set(d.items.map((i) => i.id));
        setItems(d.items);
        setNextBefore(d.nextBefore);
      })
      .catch(setError);
  }, [remoteApi, categoriesParam]);

  useEffect(() => {
    load();
    // Refresh on the same cadence as the world clock's slowest useful tick. The
    // server caches first pages for 20s, so this is cheap even with a full lobby.
    const t = setInterval(load, 45000);
    return () => clearInterval(t);
  }, [load]);

  const loadMore = () => {
    if (!nextBefore || loadingMore) return;
    setLoadingMore(true);
    remoteApi.fetchNews(`?limit=${PAGE}&before=${encodeURIComponent(nextBefore)}${categoriesParam}`)
      .then((d) => {
        // Rollup groups can straddle a page boundary and come back a second time
        // with the same id — dedupe rather than render the move twice.
        const fresh = d.items.filter((i) => !seenIds.current.has(i.id));
        fresh.forEach((i) => seenIds.current.add(i.id));
        setItems((prev) => [...(prev ?? []), ...fresh]);
        setNextBefore(d.nextBefore);
      })
      .catch(setError)
      .finally(() => setLoadingMore(false));
  };

  const toggleCategory = (id) => {
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      // Never let the player filter everything out — an empty screen reads broken.
      return next.size === 0 ? new Set([id]) : next;
    });
  };

  const shown = useMemo(() => {
    if (!items) return null;
    return items
      .map((it) => {
        const near = touchesMe(it, net, myAirlineId);
        return { ...it, near, effectiveTier: near ? 1 : it.tier };
      })
      .filter((it) => (!bigOnly || it.effectiveTier === 1))
      .filter((it) => (!nearOnly || it.near))
      .filter((it) => (!hideMine || it.airlineId !== myAirlineId));
  }, [items, net, myAirlineId, bigOnly, nearOnly, hideMine]);

  const chip = (on) => ({
    padding: '4px 10px', borderRadius: 999, fontSize: 12, cursor: 'pointer',
    border: `1px solid ${on ? 'var(--accent)' : 'var(--border, rgba(255,255,255,0.14))'}`,
    background: on ? 'color-mix(in srgb, var(--accent) 18%, transparent)' : 'transparent',
    color: on ? 'var(--accent)' : 'var(--text-dim, #9aa)',
    whiteSpace: 'nowrap',
  });

  let lastWeekKey = null;

  return (
    <div className="panel" style={{ maxWidth: 900 }}>
      <h2 style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 0 }}>
        <NewsIcon size={18} /> News
      </h2>
      <p className="muted" style={{ marginTop: -6, fontSize: 13 }}>
        Everything happening in your world, newest first. Moves by the same airline in the
        same week are grouped together.
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '12px 0' }}>
        {CATEGORIES.map((c) => (
          <button key={c.id} style={chip(active.has(c.id))} onClick={() => toggleCategory(c.id)}>
            {c.icon} {c.label}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
        <button style={chip(bigOnly)} onClick={() => setBigOnly((v) => !v)}>★ Big moves only</button>
        <button style={chip(nearOnly)} onClick={() => setNearOnly((v) => !v)}>📍 Near my network</button>
        <button style={chip(hideMine)} onClick={() => setHideMine((v) => !v)}>🙈 Hide my moves</button>
      </div>

      {error && <p className="error">{String(error.message || error)}</p>}
      {!items && !error && <p className="muted">Loading…</p>}
      {shown && shown.length === 0 && (
        <p className="muted">
          Nothing here yet{active.size < CATEGORIES.length || bigOnly || nearOnly ? ' with these filters' : ''}.
          {' '}Moves show up as players act.
        </p>
      )}

      {shown && shown.map((it) => {
        const c = compose(it);
        const weekKey = it.year != null ? `Y${it.year} W${it.week}` : null;
        const divider = weekKey && weekKey !== lastWeekKey ? weekKey : null;
        if (weekKey) lastWeekKey = weekKey;
        const isOpen = expanded.has(it.id);
        const mine = myAirlineId && it.airlineId === myAirlineId;
        const canExpand = (c.pairs?.length ?? 0) > 1;
        const nav = NAV_TARGET[it.kind];

        return (
          <div key={it.id}>
            {divider && (
              <div style={{
                position: 'sticky', top: 0, zIndex: 1,
                margin: '16px 0 6px', padding: '3px 0',
                fontSize: 11, letterSpacing: 1, textTransform: 'uppercase',
                color: 'var(--text-dim, #8a94a6)',
                borderBottom: '1px solid var(--border, rgba(255,255,255,0.10))',
                background: 'var(--panel, #141922)',
              }}>
                Year {it.year} · Week {it.week}
              </div>
            )}
            <div
              {...(nav ? {
                role: 'button',
                tabIndex: 0,
                title: 'Open the Gate Market',
                onClick: () => goTo(nav),
                onKeyDown: (e) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goTo(nav); }
                },
              } : {})}
              style={{
                display: 'flex', gap: 10, alignItems: 'baseline',
                padding: '9px 6px', borderBottom: '1px solid var(--border, rgba(255,255,255,0.07))',
                fontSize: 13.5, lineHeight: 1.55,
                borderLeft: it.effectiveTier === 1 ? '2px solid var(--accent)' : '2px solid transparent',
                paddingLeft: 10,
                cursor: nav ? 'pointer' : undefined,
              }}
            >
              <span style={{ flexShrink: 0, fontSize: 15 }}>{c.icon}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <strong>{c.standalone ? (c.subject ?? '') : (it.airline ?? c.subject ?? '')}</strong>
                {mine ? <strong> (you)</strong> : null}
                {c.headline ? ` ${c.headline}` : ''}
                {c.sub && (
                  <div style={{ opacity: 0.65, fontSize: 12.5 }}>{c.sub}</div>
                )}
                {nav?.cta && (
                  <div style={{ color: 'var(--accent)', fontSize: 12.5, fontWeight: 600 }}>
                    {nav.cta} →
                  </div>
                )}
                {canExpand && (
                  <div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();   // don't also follow the row's link
                        setExpanded((p) => {
                          const n = new Set(p);
                          if (n.has(it.id)) n.delete(it.id); else n.add(it.id);
                          return n;
                        });
                      }}
                      style={{
                        background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                        color: 'var(--accent)', fontSize: 12,
                      }}
                    >
                      {isOpen ? 'Hide' : `Show all ${c.total}`}
                    </button>
                    {isOpen && (
                      <div style={{ opacity: 0.75, fontSize: 12.5, marginTop: 2 }}>
                        {c.pairs.map((p, i) => (
                          <span key={`${p.origin}-${p.destination}-${i}`}>
                            {i > 0 ? ', ' : ''}{p.origin}–{p.destination}
                          </span>
                        ))}
                      </div>
                    )}
                    {!isOpen && (
                      <div style={{ opacity: 0.6, fontSize: 12.5 }}>
                        {c.pairs.slice(0, 3).map((p) => `${p.origin}–${p.destination}`).join(', ')}
                        {c.total > 3 ? ` +${c.total - 3} more` : ''}
                      </div>
                    )}
                  </div>
                )}
              </span>
              <span style={{ flexShrink: 0, opacity: 0.5, fontSize: 11 }}>{fmtWhen(it.at)}</span>
            </div>
          </div>
        );
      })}

      {nextBefore ? (
        <button
          className="btn"
          style={{ margin: '16px auto', display: 'block' }}
          onClick={loadMore}
          disabled={loadingMore}
        >
          {loadingMore ? 'Loading…' : 'Load older news'}
        </button>
      ) : (shown && shown.length > 0 && (
        <p className="muted" style={{ textAlign: 'center', marginTop: 16, fontSize: 12 }}>
          That's the last year of news — anything older isn't kept.
        </p>
      ))}
    </div>
  );
}
