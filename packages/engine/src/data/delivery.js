// ─────────────────────────────────────────────────────────────────────────────
// DELIVERY LEAD TIMES — classic (non-order-book) aircraft orders.
//
// The rule: the FIRST frame of a type in your queue arrives at 2x the lead;
// every further frame of that type stacks +lead after the last one queued.
//
// WHY THIS IS ITS OWN MODULE
// The table used to be copied into five files (the ORDER_AIRCRAFT reducer, the
// checkout, the market card/table, two Fleet progress bars), and the copies
// disagreed. The reducer only knew the four passenger body classes, so every
// Double Deck, Supersonic and Freighter type fell through to a 2-week default:
// a 747-400 or A380 arrived on a regional-jet clock, and an An-225 on the same
// clock as a 737F. Meanwhile the market card quoted Double Deck at 5 weeks and
// ignored the 2x first-frame rule entirely ("747-400 delivers in 2 weeks rather
// than 4" — Discord, 2026-10-03). One table, one schedule function, read by
// every screen and by the reducer, so the quote is the delivery.
//
// Freighters are sized by payload on the same bands landing fees use
// (freighterLandingCategory), so an ATR 72F delivers like a turboprop and an
// An-225 like the outsize aircraft it is. The bands are repeated here rather
// than imported so this module is a leaf, identical in Tailwinds and Headwinds
// (where that helper lives in the much heavier simulation.js).
//
// Worlds with the order book switch this off for slots (see order-book-design);
// classic saves keep it forever.
// ─────────────────────────────────────────────────────────────────────────────

export const DELIVERY_LEAD = {
  'Turboprop':    1,
  'Regional Jet': 2,
  'Narrow Body':  3,
  'Wide Body':    4,
  'Supersonic':   4,
  'Double Deck':  5,
  'Outsize':      5,
};

const FALLBACK_CLASS = 'Narrow Body';

function freighterClass(payloadTonnes = 0) {
  if (payloadTonnes >= 150) return 'Outsize';
  if (payloadTonnes >= 50) return 'Wide Body';
  if (payloadTonnes >= 20) return 'Narrow Body';
  if (payloadTonnes >= 10) return 'Regional Jet';
  return 'Turboprop';
}

/** The lead-time class a type delivers under. */
export function deliveryClass(type) {
  if (!type) return FALLBACK_CLASS;
  if (type.freighter) return freighterClass(type.payloadTonnes ?? 0);
  if (type.category === 'Supersonic' || type.supersonic) return 'Supersonic';
  if (type.category === 'Double Deck') return 'Double Deck';
  return DELIVERY_LEAD[type.category] != null ? type.category : FALLBACK_CLASS;
}

/** Weeks between consecutive frames of this type (the first frame waits 2x). */
export function deliveryLead(type) {
  return DELIVERY_LEAD[deliveryClass(type)];
}

/**
 * Absolute delivery weeks for `quantity` new frames of `type`, given what is
 * already queued. The reducer, the checkout and the market all call this.
 */
export function deliverySchedule(type, pendingOrders, absWeek, quantity = 1) {
  const lead = deliveryLead(type);
  const queued = (pendingOrders ?? []).filter(o => o?.typeId === type?.id);
  let last = queued.length > 0 ? Math.max(...queued.map(o => o.deliverAbsWeek)) : null;
  const weeks = [];
  for (let i = 0; i < Math.max(0, quantity); i++) {
    last = last === null ? absWeek + 2 * lead : last + lead;
    weeks.push(last);
  }
  return weeks;
}

/** Weeks from now until the next frame of `type` would arrive if ordered today. */
export function nextDeliveryWeeks(type, pendingOrders, absWeek) {
  return deliverySchedule(type, pendingOrders, absWeek, 1)[0] - absWeek;
}

/**
 * How far along a pending order is, 0..1. Measured against the order's own
 * wait (ordered week -> delivery week), not a category guess: a first frame
 * waits 2x lead, so dividing by lead left the bar at 0% for half the build.
 */
export function orderProgress(order, type, absWeek, absoluteWeekFn) {
  const left = (order?.deliverAbsWeek ?? absWeek) - absWeek;
  const placed = (order?.orderedYear != null && order?.orderedWeek != null && absoluteWeekFn)
    ? absoluteWeekFn(order.orderedYear, order.orderedWeek)
    : null;
  const total = placed != null ? order.deliverAbsWeek - placed : deliveryLead(type);
  if (!(total > 0)) return 1;
  return Math.max(0, Math.min(1, 1 - left / total));
}
