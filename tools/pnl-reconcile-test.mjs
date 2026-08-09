// ─────────────────────────────────────────────────────────────────────────────
// THE WEEKLY P&L CARD MUST ADD UP.
//
// Reported 2026-08-09, from a screenshot: LAST WEEK showed operating profit
// +$393.11M and corporate tax −$76.71M, and then a net profit of +$298.15M.
// 393.11 − 76.71 is 316.40. Eighteen and a quarter million dollars were missing
// from a column of six numbers, and the THIS WEEK column beside it reconciled
// perfectly — so the card read as "I made less and had more costs and yet
// somehow I'm making more money".
//
// Nothing was wrong with the money. The reducer charges heavy maintenance
// checks and AOG repairs (net of insurance) BELOW EBITDA and OUTSIDE
// report.totalCost, and it credits back the variable cost a strike saved. The
// card derived its rows from totalCost — so it could not see any of that — and
// then overwrote its Net row with the engine's real post-tax cash figure. Every
// row was defensible; their sum was a lie.
//
// This suite exists because the arithmetic-only version of it would have passed.
// It server-renders the REAL Dashboard over a state produced by the REAL
// reducer, and reads the numbers back OUT OF THE MARKUP a browser would get. It
// never recomputes a row with the helper the component uses, because a test that
// does that agrees with the component about being wrong.
//
//   node --import ./tools/_register-loader.mjs tools/pnl-reconcile-test.mjs
// ─────────────────────────────────────────────────────────────────────────────

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import { projectWeek } from '../packages/engine/src/utils/financeProjection.js';
import { costBridge, bridgeInputsFromReport } from '../packages/engine/src/utils/pnlBridge.js';
import { defaultClassPrices } from '../packages/engine/src/utils/simulation.js';
import { referencePrice } from '../packages/engine/src/utils/market.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 8).join('\n      ')}`); failed++; }
}

// ── Browser shims: the card reads a save out of localStorage ─────────────────
const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k), clear: () => store.clear(),
  key: i => [...store.keys()][i] ?? null, get length() { return store.size; },
};
globalThis.window ??= {
  localStorage: globalThis.localStorage,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
};

// Deterministic RNG. AOG events and forced checks are random by design, so a
// bare Math.random would make this suite flaky in both directions — sometimes
// no unplanned spend at all (a vacuous pass), sometimes a different week.
function seedRandom(seed) {
  let x = seed >>> 0;
  Math.random = () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading the card back out of the HTML
// ─────────────────────────────────────────────────────────────────────────────
//
// Two modes. When the card tags its cells with data-pnl-exact we read unrounded
// dollars and assert to the cent. When it does not — an older build — we fall
// back to the abbreviated text a player actually reads ("-$1.20M") and carry
// that cell's display granularity, so the assertion is still real but is only
// as tight as the display allows. Either way the numbers come from the markup.

function balancedDiv(html, from) {
  const start = html.indexOf('>', from) + 1;
  let depth = 1, i = start;
  while (i < html.length && depth > 0) {
    const nextOpen = html.indexOf('<div', i), nextClose = html.indexOf('</div', i);
    if (nextClose === -1) break;
    if (nextOpen !== -1 && nextOpen < nextClose) { depth++; i = nextOpen + 4; }
    else { depth--; i = nextClose + 5; }
  }
  return html.slice(start, i - 5);
}

function topLevelSpans(frag) {
  const out = [];
  let i = 0;
  while (i < frag.length) {
    const open = frag.indexOf('<span', i);
    if (open === -1) break;
    let depth = 0, j = open;
    while (j < frag.length) {
      const nOpen = frag.indexOf('<span', j + 1), nClose = frag.indexOf('</span>', j + 1);
      if (nClose === -1) { j = frag.length; break; }
      if (nOpen !== -1 && nOpen < nClose) { depth++; j = nOpen; }
      else if (depth === 0) { j = nClose + 7; break; }
      else { depth--; j = nClose; }
    }
    out.push(frag.slice(open, j));
    i = j;
  }
  return out;
}

const attrOf = (span, name) => {
  const m = span.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? m[1] : null;
};

function visibleText(span) {
  let inner = span.slice(span.indexOf('>') + 1, span.lastIndexOf('</span>'));
  const tip = inner.indexOf('<span class="infotip');
  if (tip !== -1) inner = inner.slice(0, tip);
  return inner.replace(/<!-- -->/g, '').replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').trim();
}

/** Parse money as the card prints it, plus the rounding band the format adds. */
function parseShownMoney(text) {
  const t = (text ?? '').trim();
  if (t === '' || t === '—') return { value: null, tol: 0 };
  const m = t.match(/^([+-]?)\$([\d.,]+)([BMK]?)$/);
  if (!m) return { value: null, tol: 0 };
  const unit = { B: 1e9, M: 1e6, K: 1e3, '': 1 }[m[3]];
  const step = m[3] === 'B' ? 1e7 : m[3] === 'M' ? 1e4 : m[3] === 'K' ? 1e2 : 1;
  return { value: (m[1] === '-' ? -1 : 1) * Number(m[2].replace(/,/g, '')) * unit, tol: step / 2 };
}

function readWeeklyPnl(html) {
  const title = html.indexOf('Weekly P&amp;L');
  assert.notEqual(title, -1, 'the Weekly P&L card did not render at all');
  const gridAt = html.indexOf('<div style="display:grid;grid-template-columns:minmax(0,1fr)', title);
  assert.notEqual(gridAt, -1, 'the Weekly P&L card rendered no ladder grid');
  const cols = /minmax\(0,1fr\) auto auto/.test(html.slice(gridAt, gridAt + 140)) ? 3 : 2;
  const body = topLevelSpans(balancedDiv(html, gridAt)).slice(cols);  // drop headers
  const exact = body.some(c => / data-pnl-exact="/.test(c));
  const rows = [];
  for (let i = 0; i + cols - 1 < body.length; i += cols) {
    const labelCell = body[i];
    const label = visibleText(labelCell);
    const read = (cell) => {
      const text = visibleText(cell);
      if (exact) {
        const raw = attrOf(cell, 'data-pnl-exact');
        return { value: raw ? Number(raw) : null, tol: 0, text };
      }
      const shown = parseShownMoney(text);
      return { value: shown.value, tol: shown.tol, text };
    };
    const lw = cols === 3 ? read(body[i + 1]) : { value: null, tol: 0, text: '' };
    const pj = read(body[i + cols - 1]);
    rows.push({
      key: attrOf(labelCell, 'data-pnl-row') ?? label,
      // Older builds carry no kind tag; these two labels are structurally the
      // subtotal and the total on every version of this card.
      kind: attrOf(labelCell, 'data-pnl-kind')
        ?? (label === 'Net profit' ? 'total'
          : label === 'Operating profit' ? 'subtotal'
          : label.startsWith('Depreciation') ? 'memo' : 'line'),
      label,
      lw: lw.value, lwTol: lw.tol, lwText: lw.text,
      pj: pj.value, pjTol: pj.tol, pjText: pj.text,
    });
  }
  return { exact, twoColumn: cols === 3, rows };
}

/** Walk one column: every itemised line must land on the printed total. */
function walkColumn(parsed, col) {
  const val = r => (col === 'lw' ? r.lw : r.pj);
  const tol = r => (col === 'lw' ? r.lwTol : r.pjTol);
  const lines = parsed.rows.filter(r => r.kind === 'line' && val(r) != null);
  const total = parsed.rows.find(r => r.kind === 'total');
  assert.ok(total, 'no Net profit row on the card');
  const walked = lines.reduce((s, r) => s + val(r), 0);
  return {
    walked, total: val(total), gap: walked - val(total),
    tol: lines.reduce((s, r) => s + tol(r), 0) + tol(total),
    lines,
  };
}

const money = v => (v < 0 ? '-' : '') + '$' + Math.abs(Math.round(v)).toLocaleString();

function reportColumn(parsed, col, label) {
  const w = walkColumn(parsed, col);
  const shown = w.lines.map(r => `        ${r.label.padEnd(34)} ${money(col === 'lw' ? r.lw : r.pj)}`).join('\n');
  return `${label} column does not add up.\n${shown}\n`
       + `        ${'-'.repeat(34)}\n`
       + `        ${'rows add to'.padEnd(34)} ${money(w.walked)}\n`
       + `        ${'card prints'.padEnd(34)} ${money(w.total)}\n`
       + `        ${'UNEXPLAINED'.padEnd(34)} ${money(w.gap)}`
       + (parsed.exact ? '' : `  (display rounding allows +/-${money(w.tol)})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures — driven by the REAL reducer, not hand-built reports
// ─────────────────────────────────────────────────────────────────────────────

const { GameProvider } = await import('../src/store/GameContext.jsx');
const Dashboard = (await import('../src/components/Dashboard.jsx')).default;

const render = (state) => {
  store.set('bbae_save_v2', JSON.stringify(state));
  return renderToString(React.createElement(GameProvider, null, React.createElement(Dashboard)));
};

const DESTS = ['ORD', 'LAX', 'MIA', 'BOS', 'SFO', 'ATL'];

/**
 * A JFK carrier flying an aged fleet at the reference fare — old enough to
 * accrue heavy checks and break things, priced well enough to pay tax, so the
 * whole ladder (EBITDA → loans → one-offs → unplanned maintenance → tax) is
 * actually populated rather than a column of zeroes that adds up trivially.
 */
function startedAirline({ seed = 12345, ownership = 'owned', ageWeeks = 500, freq = 21, fare = 1.15 } = {}) {
  seedRandom(seed);
  let s = gameReducer(freshState(),
    { type: 'START_GAME', airlineName: 'Probe Air', hub: 'JFK', enableObjectives: false });
  s = { ...s, cash: 5e9 };
  for (let i = 0; i < 10; i++) s = gameReducer(s, { type: 'ADD_GATE', airportCode: 'JFK' });
  for (const d of DESTS) {
    s = gameReducer(s, { type: 'BUY_AIRCRAFT', typeId: 'b737800' });
    const ac = s.fleet[s.fleet.length - 1].id;
    s = gameReducer(s, { type: 'ADD_GATE', airportCode: d });
    s = gameReducer(s, { type: 'ADD_ROUTE', aircraftId: ac, origin: 'JFK', destination: d, weeklyFrequency: freq });
  }
  // ADD_ROUTE leaves the fare at the $1 floor, which would make the airline
  // structurally loss-making and leave the tax row — the row the report was
  // actually about — empty on every rendered week.
  const routePricing = { ...s.routePricing };
  for (const d of DESTS) {
    routePricing[['JFK', d].sort().join('-')] =
      defaultClassPrices(Math.round(referencePrice('JFK', d) * fare));
  }
  return {
    ...s, routePricing, awareness: 70,
    hubs: { ...(s.hubs ?? {}), JFK: { tier: 2, tierSince: 0 } },
    fleet: s.fleet.map(a => ({ ...a, ageWeeks, ownershipType: ownership })),
  };
}

const unplannedSpend = (r) =>
  (r?.maintenanceChecks?.spend ?? 0) + (r?.mro?.aogSpend ?? 0) - (r?.mro?.aogInsurance ?? 0);

/** Advance real weeks until `stop(state)` is satisfied. */
function advanceUntil(s, stop, maxWeeks = 160) {
  for (let i = 0; i < maxWeeks; i++) {
    s = gameReducer(s, { type: 'ADVANCE_WEEK' });
    if (stop(s)) return { state: s, weeks: i + 1, hit: true };
  }
  return { state: s, weeks: maxWeeks, hit: false };
}

// In exact mode every tolerance is 0, so these are cent-exact assertions. In
// the text fallback they widen to the rounding the display itself introduces —
// never wider.
function closeTo(actual, expected, tol, message) {
  assert.ok(actual != null && Math.abs(actual - expected) <= tol,
    `${message}\n      card shows ${money(actual ?? NaN)}, engine says ${money(expected)}`
    + (tol ? `  (display rounding allows +/-${money(tol)})` : ''));
}

console.log('\nWeekly P&L reconciliation (rendered card)\n');
console.log('── A week the engine charged an AOG repair ───────────────────────────────');

const heavy = advanceUntil(startedAirline(),
  s => unplannedSpend(s.lastReport) !== 0 && (s.lastReport?.corporateTax ?? 0) > 0);
const heavyState = heavy.state;
const heavyHtml = render(heavyState);
const heavyPnl = readWeeklyPnl(heavyHtml);

test('the fixture reached a week with real unplanned maintenance spend AND tax', () => {
  assert.ok(heavy.hit,
    `no unplanned maintenance in a taxed week within ${heavy.weeks} simulated weeks — `
    + 'this suite would pass vacuously, which is exactly how the bug survived. '
    + 'Re-seed the fixture.');
  assert.ok(unplannedSpend(heavyState.lastReport) !== 0);
  assert.ok((heavyState.lastReport.corporateTax ?? 0) > 0);
});

test('LAST WEEK: every row on screen adds up to the Net profit on screen', () => {
  const w = walkColumn(heavyPnl, 'lw');
  assert.ok(Math.abs(w.gap) <= w.tol, reportColumn(heavyPnl, 'lw', 'LAST WEEK'));
});

test('LAST WEEK: the Net profit printed IS the engine’s cash movement', () => {
  // Non-negotiable: this figure also drives the "+$X last wk" chip, the weekly
  // debrief and the bank balance. The rows bend to it; it never bends to them.
  const net = heavyPnl.rows.find(r => r.kind === 'total');
  closeTo(net.lw, heavyState.lastReport.cashDelta, net.lwTol,
    'the card must print the reducer’s post-tax cashDelta, not a re-derivation');
});

test('the heavy-check / AOG cash actually appears as its own row', () => {
  const row = heavyPnl.rows.find(r => r.key === 'unplanned' || r.label === 'Heavy checks & AOG');
  assert.ok(row, 'the money left the airline with no line on the card to name it');
  closeTo(row.lw, -unplannedSpend(heavyState.lastReport), row.lwTol,
    'and the row must be the engine’s figure, net of insurance');
});

test('the projection column says "not forecast", not "+$0.00M"', () => {
  const row = heavyPnl.rows.find(r => r.key === 'unplanned' || r.label === 'Heavy checks & AOG');
  assert.ok(row, 'no heavy-check row rendered');
  assert.equal(row.pjText, '—',
    `the projection printed "${row.pjText}". projectWeek has no heavy-check model, `
    + 'so forecasting zero is the same lie in miniature — print a dash.');
});

test('the "Other" residual row stays hidden while everything reconciles', () => {
  const other = heavyPnl.rows.find(r => r.key === 'residual' || r.label === 'Other');
  assert.ok(!other,
    `an unexplained "${other?.lwText}" is on screen — the engine moved cash this `
    + 'card cannot name, which is what that row exists to shout about');
});

test('depreciation is a memo BELOW the bottom line, not a cost row', () => {
  const memo = heavyPnl.rows.find(r => r.key === 'depreciation');
  assert.ok(memo, 'nothing on the card explains why the tax reads under 21%');
  assert.equal(memo.kind, 'memo', 'it must not be walkable — no cash moves');
  const totalAt = heavyPnl.rows.findIndex(r => r.kind === 'total');
  assert.ok(heavyPnl.rows.indexOf(memo) > totalAt, 'a non-cash memo belongs below the total');
  closeTo(memo.lw, -(heavyState.financialHistory[heavyState.financialHistory.length - 1].depreciation),
    memo.lwTol, 'and it must be the figure the engine actually used for the tax base');
});

test('the tax row explains the base it is charged on', () => {
  const i = heavyHtml.indexOf('data-pnl-row="tax"');
  assert.notEqual(i, -1, 'no tax row rendered');
  const tip = heavyHtml.slice(i, i + 3000);
  assert.ok(/depreciation/i.test(tip),
    'the tip still reads as "21% of taxable profit" beneath an operating-profit '
    + 'row that is NOT the base it is charged on');
});

// ── The other unplanned-maintenance path: a booked heavy check ───────────────
console.log('\n── A week a booked C check was paid for ──────────────────────────────────');

const checkState = (() => {
  let s = advanceUntil(startedAirline({ seed: 4242 }), () => false, 8).state;
  // Book a C check for the coming week: the tick pays for it, and the payment
  // lands in maintenanceChecks.spend — the other half of "unplanned".
  s = gameReducer(s, { type: 'SCHEDULE_CHECK', aircraftId: s.fleet[0].id, checkType: 'C' });
  return gameReducer(s, { type: 'ADVANCE_WEEK' });
})();
const checkPnl = readWeeklyPnl(render(checkState));

test('the C-check fixture actually charged a heavy check', () => {
  assert.ok((checkState.lastReport.maintenanceChecks?.spend ?? 0) > 0,
    'no check spend — the maintenanceChecks half of the row is untested');
});

test('LAST WEEK adds up in a week the airline paid for a heavy check', () => {
  const w = walkColumn(checkPnl, 'lw');
  assert.ok(Math.abs(w.gap) <= w.tol, reportColumn(checkPnl, 'lw', 'LAST WEEK (C check)'));
});

// ── Partner revenue: the double count on the other bridge ────────────────────
console.log('\n── An airline in a codeshare (partner revenue) ───────────────────────────');

let allied = startedAirline({ seed: 777 });
allied = gameReducer(allied, { type: 'SIGN_CODESHARE', competitorId: allied.competitors[0].id });
const alliedRun = advanceUntil(allied, s => (s.lastReport?.totalPartnerRevenue ?? 0) > 0, 20);
const alliedState = alliedRun.state;
const alliedPnl = readWeeklyPnl(render(alliedState));

test('the codeshare fixture is actually earning partner revenue', () => {
  assert.ok((alliedState.lastReport.totalPartnerRevenue ?? 0) > 0,
    'no partner revenue — the double-count case would not be exercised');
});

test('LAST WEEK still adds up with partner revenue in the mix', () => {
  const w = walkColumn(alliedPnl, 'lw');
  assert.ok(Math.abs(w.gap) <= w.tol, reportColumn(alliedPnl, 'lw', 'LAST WEEK (codeshare)'));
});

test('the cost bridge does not count partner revenue twice', () => {
  // The Finance page's ladder read report.totalRevenue — which ALREADY includes
  // the partner share — into a row labelled "Route revenue", then added the
  // partner share again on its own line. The residual landed at exactly minus
  // the partner revenue, and every allied carrier saw a bogus "Other" row.
  const b = costBridge(bridgeInputsFromReport(alliedState.lastReport), alliedState);
  assert.equal(b.residual, 0,
    `residual is ${money(b.residual)} against partner revenue of `
    + `${money(alliedState.lastReport.totalPartnerRevenue)} — that is the double count`);
  assert.ok(!b.rows.some(r => r.key === 'residual'), 'so no spurious "Other" row on Finance');
});

test('the cost bridge reconciles below the line too, on a real past week', () => {
  const b = costBridge(bridgeInputsFromReport(alliedState.lastReport), alliedState);
  assert.equal(b.netResidual, 0,
    `${money(b.netResidual)} moved between EBITDA and net that no row names`);
  const walked = b.rows.filter(r => r.kind === 'income' || r.kind === 'cost')
                       .reduce((s, r) => s + r.value, 0);
  assert.equal(walked, b.netProfit, 'the whole ladder must land on the engine’s cashDelta');
  assert.equal(b.netProfit, alliedState.lastReport.cashDelta);
});

test('a projection still reconciles end to end', () => {
  const b = costBridge(projectWeek(alliedState), alliedState);
  assert.equal(b.residual, 0);
  assert.equal(b.netResidual, 0);
});

// ── A lease in its final week ────────────────────────────────────────────────
console.log('\n── A lease reaching its final week (redelivery) ──────────────────────────');

const leaseState = (() => {
  const s = advanceUntil(startedAirline({ seed: 99, ownership: 'lease' }), () => false, 6).state;
  // Put every leased tail into its last week, so projectWeek books redelivery.
  return { ...s, fleet: s.fleet.map(a => ({ ...a, ownershipType: 'lease', leaseRemainingWeeks: 1 })) };
})();
const leaseProj = projectWeek(leaseState);
const leasePnl  = readWeeklyPnl(render(leaseState));

test('the lease fixture actually books a redelivery charge', () => {
  assert.ok(leaseProj.leaseRedelivery > 0,
    'projectWeek booked no redelivery — the projected-column case is vacuous');
});

test('THIS WEEK: the rows add up to the projected Net profit', () => {
  const w = walkColumn(leasePnl, 'pj');
  assert.ok(Math.abs(w.gap) <= w.tol, reportColumn(leasePnl, 'pj', 'THIS WEEK (proj.)'));
});

test('one-time charges include the redelivery the projection actually subtracts', () => {
  const row = leasePnl.rows.find(r => r.key === 'oneOff' || r.label === 'One-time charges');
  assert.ok(row, 'no one-time charges row despite a redelivery this week');
  closeTo(row.pj, -(leaseProj.seasonalReactivation + leaseProj.leaseRedelivery), row.pjTol,
    'projectWeek subtracts BOTH from netCash; the card must show both');
});

test('THIS WEEK: the Net profit printed IS the canonical projection', () => {
  const net = leasePnl.rows.find(r => r.kind === 'total');
  closeTo(net.pj, leaseProj.netCash, net.pjTol,
    'it must equal the "Projected Profit / wk" KPI exactly');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
