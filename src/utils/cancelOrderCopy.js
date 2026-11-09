// What cancelling a pending order returns, in words — ONE answer for every
// screen that offers the button.
//
// The Market page and the Fleet page each had their own copy of this dialog.
// When production lines arrived (cancel forfeit 5/10/20/30% by how near the
// slot is, lease deposit back only 26+ weeks out, launch frames firm) only the
// Market's copy learned the new terms. The Fleet page went on promising "a 5%
// cancellation fee" and "your deposit is returned in full" on an order the
// reducer then refunded at 70%, or at nothing (audit 2026-11-09, A1).
//
// The figures come from the same functions CANCEL_ORDER uses, so the dialog
// cannot drift from the refund again.

import { cancelTerms } from '../data/productionLines.js';
import { absoluteWeek } from './fuel.js';
import { formatMoney } from './simulation.js';

/** Share of the price a classic (no production lines) purchase order refunds. */
export const CLASSIC_CANCEL_REFUND = 0.95;

/**
 * { allowed, title, body, refund, forfeit, reason } for cancelling `order` in
 * `state`. `allowed: false` (a firm launch order) carries the reason instead
 * of a body — show it, don't open a confirm the reducer will refuse.
 */
export function cancelOrderDialog(state, order) {
  const title = `Cancel the order for ${order?.name ?? 'this aircraft'}?`;
  if (state?.productionLinesWorld === true && !order?.used) {
    const terms = cancelTerms(order, absoluteWeek(state.year, state.week));
    if (!terms.allowed) {
      return { allowed: false, title, body: null, refund: 0, forfeit: 0, reason: terms.reason };
    }
    const wk = `${terms.weeksOut} week${terms.weeksOut === 1 ? '' : 's'}`;
    const body = terms.forfeit > 0
      ? `The slot is ${wk} away, so ${order.ownershipType === 'lease' ? 'the deposit is forfeit' : `${Math.round(terms.forfeitPct * 100)}% is forfeit`}: you get ${formatMoney(terms.refund)} back and lose ${formatMoney(terms.forfeit)}. The slot goes back on the line for anyone to take.`
      : `You get ${formatMoney(terms.refund)} back in full. The slot goes back on the line for anyone to take.`;
    return { allowed: true, title, body, refund: terms.refund, forfeit: terms.forfeit, reason: null };
  }
  const owned = order?.ownershipType === 'owned' && (order.totalPrice ?? 0) > 0;
  const deposit = order?.ownershipType === 'lease' ? (order.leaseDeposit ?? 0) : 0;
  const refund = owned ? Math.round(order.totalPrice * CLASSIC_CANCEL_REFUND) : deposit;
  const body = owned
    ? `You'll be refunded ${formatMoney(refund)} (a 5% cancellation fee applies).`
    : deposit > 0
      ? `Lease orders are free to cancel before delivery — your ${formatMoney(deposit)} security deposit is returned in full.`
      : 'Lease orders are free to cancel before delivery.';
  return { allowed: true, title, body, refund, forfeit: owned ? order.totalPrice - refund : 0, reason: null };
}
