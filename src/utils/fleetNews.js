// fleetNews.js — the words for a fleet move. ONE copy for every screen that
// tells a player what a rival did with its fleet:
//   • the in-game News tab        (src/components/News.jsx)
//   • the lobby news widget       (apps/headwinds-web/src/Feed.jsx)
//   • the rival profile, in game  (src/components/Competition.jsx)
//   • the rival profile, in lobby (apps/headwinds-web/src/App.jsx)
//
// Each used to phrase these on its own, and they disagreed: the rival profiles
// dropped the count entirely ("Ordered a 737-800" for a twelve-frame order),
// and retirements printed "retired a unknown". The server now journals what
// executed (lib/publicDecisions.mjs withFleetFacts); this module is the one
// place that turns those counts into words.
//
// Pure: callers pass their own `typeName(id)` so nothing here imports the
// aircraft catalogue (the lobby and the game resolve names from different
// copies of it).

const UNKNOWN = 'unknown';

/** "a Boeing 777-200ER", "5× Boeing 777-200ER", "an aircraft", "3 aircraft". */
export function frames(n, typeId, typeName) {
  const count = Math.max(1, Math.round(Number(n) || 1));
  if (!typeId || typeId === UNKNOWN) return count > 1 ? `${count.toLocaleString()} aircraft` : 'an aircraft';
  const name = typeName(typeId) ?? typeId;
  return count > 1 ? `${count.toLocaleString()}× ${name}` : `a ${name}`;
}

/** { typeId: n } → "5× A, a B and 2 more", biggest first. */
export function framesList(byType, typeName, { max = 2 } = {}) {
  const parts = Object.entries(byType ?? {})
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([id, n]) => frames(n, id, typeName));
  if (parts.length === 0) return '';
  return parts.length > max
    ? `${parts.slice(0, max).join(', ')} and ${parts.length - max} more`
    : parts.join(' and ');
}

/**
 * Headline for a rolled news item of kind fleet_in / fleet_out (see the
 * server's newsService composeGroup). Null for any other kind.
 */
export function fleetHeadline(kind, d = {}, typeName, { max = 2 } = {}) {
  if (kind === 'fleet_in') {
    const verb = d.ordered ? 'ordered' : 'bought';
    const got = framesList(d.byType, typeName, { max })
      || (d.total > 0 ? frames(d.total, null, typeName) : '');
    const dropped = framesList(d.cancelledByType, typeName, { max })
      || (d.cancelled > 0 ? frames(d.cancelled, null, typeName) : '');
    if (got && dropped) return `${verb} ${got}, cancelled ${dropped}`;
    if (got) return `${verb} ${got}`;
    if (dropped) return `cancelled orders for ${dropped}`;
    return `${verb} aircraft`;
  }
  if (kind === 'fleet_out') {
    const verb = d.retired ? 'retired' : 'sold';
    return `${verb} ${framesList(d.byType, typeName, { max }) || frames(d.total, null, typeName)}`;
  }
  return null;
}

/**
 * One rival-profile line for a journalled fleet decision ({ type, payload }),
 * or null when the move is not a fleet move (the caller labels those).
 */
export function describeFleetMove(m, typeName) {
  const p = m?.payload ?? {};
  const one = () => (p.byType
    ? framesList(p.byType, typeName)
    : frames(p.quantity ?? 1, p.typeId, typeName));
  switch (m?.type) {
    case 'ORDER_AIRCRAFT':       return `Ordered ${one()}`;
    case 'BUY_AIRCRAFT':         return `Bought ${one()}`;
    case 'LEASE_AIRCRAFT':       return `Leased ${one()}`;
    case 'SELL_AIRCRAFT':
    case 'SELL_AIRCRAFT_BULK':   return `Sold ${one()}`;
    case 'RETIRE_AIRCRAFT':
    case 'RETIRE_AIRCRAFT_BULK': return `Retired ${one()}`;
    case 'CANCEL_ORDER':         return `Cancelled an order for ${frames(p.cancelled ?? 1, p.typeId, typeName)}`;
    default:                     return null;
  }
}
