// The Dashboard's compact profit waterfall — Finance's cost bridge folded into
// a handful of bars that fit beside the KPIs.
//
// Nothing here prices anything. It regroups the rows of the SHARED cost bridge
// (utils/pnlBridge.js costBridge — the one Finance's Cost Bridge card draws),
// so the two can never disagree: every non-subtotal bridge row lands in
// exactly one bucket, and a row this file has never heard of goes to "Other"
// rather than going missing. tools/compact-waterfall-test.mjs checks that the
// walk lands on the bridge's net cash to the dollar.
//
// React-free: the test imports it directly.

import { costBridge, bridgeInputsFromReport } from './pnlBridge.js';

/** Buckets in walk order. `rows` are costBridge row keys. */
export const COMPACT_BUCKETS = [
  { key: 'flying',   label: 'Flying',       rows: ['direct'],
    tip: 'Fuel, crew, cabin service, catering, handling and landing fees.' },
  { key: 'fleet',    label: 'Fleet',        rows: ['ownFlying', 'ownParked'],
    tip: 'Leases and maintenance on every aircraft, flying or parked.' },
  { key: 'staff',    label: 'Staff',        rows: ['labour'],
    tip: 'Pilots, cabin crew, engineers and ground staff.' },
  { key: 'overhead', label: 'Gates & HQ',   rows: ['gates', 'overhead', 'distribution'],
    tip: 'Gates and slots, head office, insurance, bases, and distribution fees.' },
  { key: 'brand',    label: 'Brand',        rows: ['brand'],
    tip: 'Marketing, the loyalty programme, hub investment and travel partners.' },
  { key: 'other',    label: 'Other',        rows: ['partnerRev', 'farmFees', 'strike', 'residual'],
    tip: 'Partner and codeshare revenue, fuel farm fees, and any strike losses.' },
  { key: 'below',    label: 'Loans & tax',  rows: ['loans', 'oneOff', 'deposits', 'unplanned', 'tax', 'netResidual'],
    tip: 'Loan payments, one-time charges, heavy checks, deposits returned and corporate tax.' },
];

const SKIP = new Set(['revenue', 'contribution', 'routeOperating', 'ebitda', 'net']);

/**
 * Fold a costBridge() result into waterfall steps.
 * @returns {{ steps: Array<{key,label,tip,value,from,to,kind,parts}>, revenue, net, netMargin }}
 *   kind: 'start' (route revenue) | 'step' | 'end' (net cash flow)
 */
export function compactWaterfall(bridge) {
  const rows = bridge?.rows ?? [];
  const byKey = new Map(rows.map(r => [r.key, r]));
  const start = byKey.get('revenue')?.value ?? 0;
  const net = bridge?.netProfit ?? 0;

  const known = new Set(COMPACT_BUCKETS.flatMap(b => b.rows));
  const extra = rows.filter(r => !SKIP.has(r.key) && !known.has(r.key) && r.kind !== 'subtotal' && r.kind !== 'total');

  const steps = [{ key: 'revenue', label: 'Revenue', tip: byKey.get('revenue')?.tip ?? '', value: start, from: 0, to: start, kind: 'start', parts: [] }];
  let running = start;
  for (const b of COMPACT_BUCKETS) {
    const parts = b.rows.map(k => byKey.get(k)).filter(Boolean)
      .concat(b.key === 'other' ? extra : []);
    const value = parts.reduce((s, r) => s + (r.value ?? 0), 0);
    if (Math.round(value) === 0) continue;
    steps.push({
      key: b.key, label: b.label, tip: b.tip, value, from: running, to: running + value, kind: 'step',
      parts: parts.filter(r => Math.round(r.value ?? 0) !== 0).map(r => ({ key: r.key, label: r.label, value: r.value })),
    });
    running += value;
  }
  steps.push({ key: 'net', label: 'Net cash', tip: byKey.get('net')?.tip ?? '', value: net, from: 0, to: net, kind: 'end', parts: [] });
  return { steps, revenue: bridge?.revenue ?? start, net, netMargin: bridge?.netMargin ?? 0, walkEnd: running };
}

/** The projected week (Dashboard's `proj`, the same projection Finance uses). */
export function projectedWaterfall(proj, state) {
  return compactWaterfall(costBridge(proj, state));
}

/** Last week as it happened, from the stored report (null before the first week). */
export function lastWeekWaterfall(state) {
  if (!state?.lastReport) return null;
  return compactWaterfall(costBridge(bridgeInputsFromReport(state.lastReport), state));
}
