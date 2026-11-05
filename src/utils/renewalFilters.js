// Filters for the fleet-renewal screens, kept pure so both pickers, both order
// lists and the tests all agree on what a filter shows.
//
// Two sides of the same job (Discord, Nov 2026): when an order is told which
// tail it replaces, the player wants to narrow BOTH lists — the orders on the
// books, and the fleet tails they could replace.
//
//   filterTailRows  — the "which aircraft does this replace" pickers. Rows are
//                     { a: tail, t: type, c: replacementCompatibility(...) }.
//   filterOrders    — the On Order panel (Fleet) and Orders tab (Marketplace).
//
// A filter never changes what is selected or dispatched — it only hides rows.

/** Show the filter bar once a list is at least this long. */
export const FILTER_MIN_ROWS = 5;

export const EMPTY_TAIL_FILTER  = Object.freeze({ q: '', typeId: '', own: 'all', okOnly: false });
export const EMPTY_ORDER_FILTER = Object.freeze({ q: '', typeId: '', own: 'all', replacing: 'all' });

const norm = (s) => String(s ?? '').toLowerCase();
const isLease = (ownershipType) => ownershipType !== 'owned';

function matchesOwn(own, ownershipType) {
  if (own === 'owned') return !isLease(ownershipType);
  if (own === 'lease') return isLease(ownershipType);
  return true;
}

/** Every word of the query must appear in one of the fields. */
function matchesQuery(q, fields) {
  const words = norm(q).trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = fields.map(norm).join(' ');
  return words.every(w => hay.includes(w));
}

export function tailFilterActive(f) {
  return !!(f && (f.q?.trim() || f.typeId || (f.own && f.own !== 'all') || f.okOnly));
}
export function orderFilterActive(f) {
  return !!(f && (f.q?.trim() || f.typeId || (f.own && f.own !== 'all') || (f.replacing && f.replacing !== 'all')));
}

export function filterTailRows(rows, f = EMPTY_TAIL_FILTER) {
  if (!tailFilterActive(f)) return rows;
  return rows.filter(({ a, t, c }) =>
    (!f.typeId || a.typeId === f.typeId) &&
    matchesOwn(f.own, a.ownershipType) &&
    (!f.okOnly || c?.ok) &&
    matchesQuery(f.q, [a.name, a.tailNumber, t?.name, t?.category, a.reserveBase]));
}

export function filterOrders(orders, f = EMPTY_ORDER_FILTER, typeOf = () => null) {
  if (!orderFilterActive(f)) return orders;
  return orders.filter(o => {
    const t = typeOf(o.typeId);
    if (f.typeId && o.typeId !== f.typeId) return false;
    if (!matchesOwn(f.own, o.ownershipType)) return false;
    if (f.replacing === 'yes' && !o.replacesAircraftId) return false;
    if (f.replacing === 'no' && o.replacesAircraftId) return false;
    return matchesQuery(f.q, [o.name, t?.name, t?.category, o.engineLabel, o.replacesName]);
  });
}

/** Types present in a list, most common first: [{ id, name, count }]. */
export function typeOptions(items, typeIdOf, typeOf) {
  const m = new Map();
  for (const it of items) {
    const id = typeIdOf(it);
    if (!id) continue;
    const e = m.get(id) ?? { id, name: typeOf(id)?.name ?? id, count: 0 };
    e.count++;
    m.set(id, e);
  }
  return [...m.values()].sort((x, y) => y.count - x.count || x.name.localeCompare(y.name));
}
