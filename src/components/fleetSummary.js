// Fleet → Summary: one row per aircraft type, plus a fleet-wide totals row.
//
// Pure so the table, its totals and its sort can be tested without React. The
// money and utilisation figures are deliberately the SAME expressions the rest
// of the Fleet page uses, so the totals row adds up to the stat boxes above it:
//   fixed / wk  = lease (leased tails) + base maintenance × age multiplier
//                 — the Weekly Leases + Weekly Maintenance boxes
//   utilisation = aircraftUtilization() via the page's utilFor — the UTIL. column
//   book value  = airframeNAV — what SELL_AIRCRAFT values an owned tail on
//
// A type that is only ON ORDER (nothing delivered yet) still gets a row, with
// no ages or utilisation, so the summary shows where the fleet is heading too.

import { isReserve } from '../data/reserve.js';
import { isOutOfService, airframeNAV } from '../data/maintenance.js';
import { maintenanceMultiplier } from '../utils/simulation.js';

const tailSeats = (a, type) => {
  const cfg = a.config;
  if (cfg) {
    const n = Object.values(cfg).filter(v => typeof v === 'number').reduce((x, y) => x + y, 0);
    if (n > 0) return n;
  }
  return type?.seats ?? 0;
};

const tailFixed = (a, type) => {
  const lease = a.ownershipType === 'owned' ? 0 : (a.weeklyLease ?? type?.weeklyLease ?? 0);
  const maint = Math.round((type?.baseMaintenancePerWk ?? 0) * maintenanceMultiplier(a.ageWeeks ?? 0));
  return lease + maint;
};

function emptyRow(typeId, type) {
  return {
    typeId, type, name: type?.name ?? typeId, category: type?.category ?? '',
    freighter: !!type?.freighter,
    count: 0, owned: 0, leased: 0, onOrder: 0,
    idle: 0, reserve: 0, down: 0,
    ageSumWks: 0, avgAgeWks: null, minAgeWks: null, maxAgeWks: null,
    seats: 0, tonnes: 0,
    hoursSum: 0, avgHours: null, avgUtilPct: null, anyOver: false,
    fixedPerWk: 0, bookValue: 0, share: 0,
  };
}

function addTail(row, a, type, { absWeek, utilOf }) {
  row.count++;
  if (a.ownershipType === 'owned') {
    row.owned++;
    row.bookValue += airframeNAV(a, type, absWeek);
  } else {
    row.leased++;
  }
  // Not flying, in three buckets that never double-count a tail: "down" is the
  // sim's own out-of-service test (in the shop or grounded); a stationed reserve
  // is parked on purpose and is NOT idle capacity, as on the page's chips.
  if (isOutOfService(a)) row.down++;
  else if (isReserve(a)) row.reserve++;
  else if (a.status === 'idle') row.idle++;

  const age = a.ageWeeks ?? 0;
  row.ageSumWks += age;
  row.minAgeWks = row.minAgeWks == null ? age : Math.min(row.minAgeWks, age);
  row.maxAgeWks = row.maxAgeWks == null ? age : Math.max(row.maxAgeWks, age);

  if (type?.freighter) row.tonnes += type.payloadTonnes ?? 0;
  else row.seats += tailSeats(a, type);

  const u = utilOf(a);
  row.hoursSum += u?.flyingHours ?? 0;
  if (u?.overCap) row.anyOver = true;

  row.fixedPerWk += tailFixed(a, type);
}

function finish(row, capHours, fleetSize) {
  if (row.count > 0) {
    row.avgAgeWks = row.ageSumWks / row.count;
    row.avgHours  = row.hoursSum / row.count;
    row.avgUtilPct = capHours > 0 ? row.avgHours / capHours : 0;
  }
  row.share = fleetSize > 0 ? row.count / fleetSize : 0;
  return row;
}

/**
 * @param {object}   p
 * @param {object[]} p.fleet          state.fleet
 * @param {object[]} [p.pendingOrders] state.pendingOrders
 * @param {Function} p.typeOf         typeId → aircraft type
 * @param {Function} p.utilOf         aircraft → { flyingHours, overCap }
 * @param {number}   p.capHours       weekly block-hour cap the utilisation % is read against
 * @param {number}   [p.absWeek]      absolute game week, for book value
 * @param {string[]} [p.categoryOrder] category display order for the default sort
 * @returns {{ rows: object[], totals: object }}
 */
export function fleetTypeSummary({
  fleet = [], pendingOrders = [], typeOf, utilOf, capHours, absWeek = 0, categoryOrder = [],
}) {
  const byType = new Map();
  const rowFor = (typeId) => {
    if (!byType.has(typeId)) byType.set(typeId, emptyRow(typeId, typeOf(typeId)));
    return byType.get(typeId);
  };
  const totals = emptyRow('__total__', null);
  totals.name = 'Fleet total';

  for (const a of fleet) {
    const type = typeOf(a.typeId);
    addTail(rowFor(a.typeId), a, type, { absWeek, utilOf });
    addTail(totals, a, type, { absWeek, utilOf });
  }
  for (const o of pendingOrders) {
    rowFor(o.typeId).onOrder++;
    totals.onOrder++;
  }

  const catIdx = (c) => { const i = categoryOrder.indexOf(c); return i < 0 ? 999 : i; };
  const rows = [...byType.values()]
    .map(r => finish(r, capHours, fleet.length))
    .sort((a, b) => (catIdx(a.category) - catIdx(b.category)) || a.name.localeCompare(b.name));

  return { rows, totals: finish(totals, capHours, fleet.length) };
}

/** Sortable columns → the value each sorts on. null/undefined always sort last. */
export const SUMMARY_SORTS = {
  name:     r => r.name,
  count:    r => r.count,
  owned:    r => r.owned,
  onOrder:  r => r.onOrder,
  avgAge:   r => r.avgAgeWks,
  oldest:   r => r.maxAgeWks,
  idle:     r => r.idle + r.reserve + r.down,
  capacity: r => (r.freighter ? r.tonnes : r.seats),
  util:     r => r.avgUtilPct,
  fixed:    r => r.fixedPerWk,
  value:    r => r.bookValue,
};

/** Sort summary rows by a SUMMARY_SORTS key; an unknown/null key keeps the default order. */
export function sortSummaryRows(rows, key, dir = 'asc') {
  const get = SUMMARY_SORTS[key];
  if (!get) return rows;
  const sign = dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const va = get(a), vb = get(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    const c = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
    return c * sign || a.name.localeCompare(b.name);
  });
}

// The sort is remembered per browser, like Routes and Your Gates.
export const FLEET_SUMMARY_SORT_KEY = 'fleet_summary_sort_v1';

export function readSummarySort() {
  try {
    const raw = JSON.parse(localStorage.getItem(FLEET_SUMMARY_SORT_KEY) || 'null');
    if (raw && (raw.key == null || SUMMARY_SORTS[raw.key]) && (raw.dir === 'asc' || raw.dir === 'desc')) {
      return { key: raw.key ?? null, dir: raw.dir };
    }
  } catch (_) { /* private mode / bad JSON */ }
  return { key: null, dir: 'asc' };
}

export function writeSummarySort(sort) {
  try { localStorage.setItem(FLEET_SUMMARY_SORT_KEY, JSON.stringify(sort)); } catch (_) { /* private mode */ }
}
