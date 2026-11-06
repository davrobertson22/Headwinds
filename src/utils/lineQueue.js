// Fleet → On Order: where each order sits on its production line.
//
// Production-line worlds build a family's frames in weekly batches shared by
// every airline (engine data/productionLines.js). This answers, for one of
// your orders, "how many frames roll off this line before mine?" — every
// airline's bookings on the line from this week up to the week before yours
// (rivals' arrive injected in state.lineBook; yours are your pendingOrders
// and conversions), plus the ones booked into your own week alongside it.
// Read-only: it counts the same bookings the slot calendar and the tick use.
// React-free: tools/line-queue-test.mjs imports it.

import { lineBookings, lineOf, lineInfo, lineOrdersOf } from '../data/productionLines.js';

/**
 * @param {object} state        airline state (pendingOrders, fleet, lineBook)
 * @param {object} order        one pending order { typeId, lineId?, deliverAbsWeek, used? }
 * @param {number} nowAbs       the current absolute week
 * @returns {null | { lineId, lineName, ahead, yoursAhead, alongside, weeksOut }}
 *   ahead       frames due off the line before this one (all airlines)
 *   yoursAhead  of those, your own
 *   alongside   other frames booked into the same delivery week
 */
export function orderLinePlace(state, order, nowAbs) {
  if (!state?.productionLinesWorld || !order || order.used || !Number.isFinite(order.deliverAbsWeek)) return null;
  const lineId = order.lineId ?? lineOf(order.typeId);
  if (!lineId) return null;
  const booked = lineBookings(state, lineId, nowAbs);
  let ahead = 0;
  for (const [w, n] of booked) if (w < order.deliverAbsWeek) ahead += n;
  const alongside = Math.max(0, (booked.get(order.deliverAbsWeek) ?? 0) - 1);
  let yoursAhead = 0;
  for (const o of lineOrdersOf(state)) {
    if (o === order || o.used || !Number.isFinite(o.deliverAbsWeek)) continue;
    if ((o.lineId ?? lineOf(o.typeId)) !== lineId) continue;
    if (o.deliverAbsWeek >= nowAbs && o.deliverAbsWeek < order.deliverAbsWeek) yoursAhead++;
  }
  return {
    lineId, lineName: lineInfo(lineId).name,
    ahead, yoursAhead, alongside,
    weeksOut: Math.max(0, order.deliverAbsWeek - nowAbs),
  };
}
