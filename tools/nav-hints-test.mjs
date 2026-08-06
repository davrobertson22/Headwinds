// Nav paths, deep-link intents and lease-expiry alerts.
//
// Three small systems that exist for one reason: the game kept telling players
// about things without telling them where those things are.
//
// 1. NAV PATHS. The nav bar folds most tabs into four dropdown groups, so only
//    eight controls are visible. The onboarding tour never got the memo — step
//    one said "Open the Market tab" and there is no Market tab, only Fleet >
//    Market. These tests pin src/navPath.js to App.jsx's real TABS/NAV_GROUPS
//    so a tab that moves group can't silently rot the instructions again, and
//    assert every tour highlight resolves to something a player can find.
//
// 2. NAV INTENTS. A Dashboard alert that says "3 loss-making routes" should
//    land on Routes with the losing filter applied. The subtlety is that the
//    destination component does not exist when the alert is clicked, so the
//    filter is parked, not evented, and read once on mount.
//
// 3. LEASE EXPIRY. An expiring lease auto-returns the aircraft and CLOSES its
//    routes, with only a toast an away player never sees. One shared predicate
//    now feeds the Dashboard alert, the Fleet filter chip and the debrief, so
//    the three surfaces cannot disagree about which tails are at risk.
//
//   node tools/nav-hints-test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { TAB_LABELS, TAB_GROUP, navPathFor, NAV_SEP } from '../src/navPath.js';
import { requestNav, consumeNavFilter, clearNavIntent } from '../src/utils/navIntent.js';
import {
  LEASE_EXPIRY_WARN_WEEKS, leaseRemainingWeeks, isLeaseExpiring, leasesExpiringSoon,
} from '../src/utils/leaseAlerts.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

// ── Parse App.jsx's nav declarations as the source of truth ──────────────────
const appSrc = readFileSync(join(ROOT, 'src/App.jsx'), 'utf8');

function block(src, startMarker) {
  const i = src.indexOf(startMarker);
  assert.ok(i >= 0, `${startMarker} not found in App.jsx`);
  const j = src.indexOf('\n];', i);
  assert.ok(j > i, `end of ${startMarker} not found`);
  return src.slice(i, j);
}

const tabsBlock   = block(appSrc, 'const TABS = [');
const groupsBlock = block(appSrc, 'const NAV_GROUPS = [');

const appTabs = new Map();
for (const m of tabsBlock.matchAll(/\{\s*id:\s*'([a-z]+)',\s*label:\s*'([^']+)'/g)) {
  appTabs.set(m[1], m[2]);
}

const appGroupOf = new Map();
const appTopLevel = new Set();
for (const m of groupsBlock.matchAll(/\{\s*id:\s*'([a-z]+)'\s*\}/g)) appTopLevel.add(m[1]);
for (const m of groupsBlock.matchAll(/label:\s*'([A-Za-z]+)',[^\n]*children:\s*\[([^\]]+)\]/g)) {
  const group = m[1];
  for (const c of m[2].matchAll(/'([a-z]+)'/g)) appGroupOf.set(c[1], group);
}

// ── 1. navPath.js agrees with the rendered nav ───────────────────────────────

test('App.jsx parsed: tabs and groups were actually found', () => {
  assert.ok(appTabs.size >= 15, `only parsed ${appTabs.size} tabs`);
  assert.ok(appGroupOf.size >= 8, `only parsed ${appGroupOf.size} grouped tabs`);
  assert.ok(appTopLevel.has('dashboard'));
});

test('every tab in App.jsx has a label in navPath.js', () => {
  for (const [id, label] of appTabs) {
    assert.equal(TAB_LABELS[id], label, `label mismatch for '${id}'`);
  }
});

test('navPath.js invents no tabs App.jsx does not render', () => {
  for (const id of Object.keys(TAB_LABELS)) {
    assert.ok(appTabs.has(id), `navPath.js knows '${id}' but App.jsx has no such tab`);
  }
});

test('every grouped tab is filed under the same group App.jsx renders it in', () => {
  for (const [id, group] of appGroupOf) {
    assert.equal(TAB_GROUP[id], group, `'${id}' is under '${group}' in App.jsx`);
  }
});

test('top-level tabs carry no group prefix', () => {
  for (const id of appTopLevel) {
    assert.equal(TAB_GROUP[id], undefined, `'${id}' is a top-level button, not in a dropdown`);
    assert.equal(navPathFor(id), TAB_LABELS[id]);
  }
});

test('navPathFor renders a click path for a buried tab', () => {
  assert.equal(navPathFor('market'), `Fleet ${NAV_SEP} Market`);
  assert.equal(navPathFor('routes'), `Network ${NAV_SEP} Routes`);
  assert.equal(navPathFor('planner'), `Network ${NAV_SEP} Route Planner`);
});

test('navPathFor returns null for an unknown tab rather than a broken instruction', () => {
  assert.equal(navPathFor('nope'), null);
  assert.equal(navPathFor(undefined), null);
});

// ── 2. The onboarding tour points at things that exist ───────────────────────
const tourSrc = readFileSync(join(ROOT, 'src/components/OnboardingTour.jsx'), 'utf8');

// Highlights that are deliberately NOT tabs: chrome in the top bar.
const LITERAL_HIGHLIGHTS = new Set(['Next Week']);

const tourHighlights = [...tourSrc.matchAll(/\b(?:remoteHighlight|highlight):\s*'([^']*)'/g)]
  .map(m => m[1])
  .filter(Boolean);

test('the tour actually declares highlights (regex still matches the file)', () => {
  assert.ok(tourHighlights.length >= 4, `found ${tourHighlights.length} highlights`);
});

test('every tour highlight is a real tab id or declared top-bar chrome', () => {
  for (const h of tourHighlights) {
    const ok = Object.prototype.hasOwnProperty.call(TAB_LABELS, h) || LITERAL_HIGHLIGHTS.has(h);
    assert.ok(ok, `tour highlight '${h}' is neither a tab id nor known chrome — ` +
      `players are being sent to a control that does not exist`);
  }
});

test('no tour highlight is a bare tab LABEL (the old bug: "Market", not "market")', () => {
  const labels = new Set(Object.values(TAB_LABELS));
  for (const h of tourHighlights) {
    if (LITERAL_HIGHLIGHTS.has(h)) continue;
    assert.ok(!labels.has(h) || Object.prototype.hasOwnProperty.call(TAB_LABELS, h),
      `tour highlight '${h}' is a display label, not a tab id`);
  }
});

test('the tour renders the path, not the raw id', () => {
  assert.ok(/navPathFor\(/.test(tourSrc), 'OnboardingTour.jsx never calls navPathFor');
});

// ── 3. Nav intents park a filter for a tab that has not mounted yet ──────────

test('a filter parked for a tab is delivered to that tab exactly once', () => {
  clearNavIntent();
  requestNav('routes', { filter: { filterTab: 'unprofitable' } });
  assert.deepEqual(consumeNavFilter('routes'), { filterTab: 'unprofitable' });
  assert.equal(consumeNavFilter('routes'), null, 'a filter must not survive being read');
});

test('a filter parked for one tab is invisible to another', () => {
  clearNavIntent();
  requestNav('fleet', { filter: { filterChip: 'expiring' } });
  assert.equal(consumeNavFilter('routes'), null);
  assert.deepEqual(consumeNavFilter('fleet'), { filterChip: 'expiring' });
});

test('navigating without a filter clears a stale one', () => {
  clearNavIntent();
  requestNav('routes', { filter: { filterTab: 'unprofitable' } });
  requestNav('fleet');
  assert.equal(consumeNavFilter('routes'), null,
    'a plain nav must not leave an old filter armed for a later visit');
});

// ── 4. Lease expiry: one predicate, three surfaces ───────────────────────────
const leased = (id, weeks) => ({ id, name: id, ownershipType: 'lease', leaseRemainingWeeks: weeks });
const owned  = (id) => ({ id, name: id, ownershipType: 'owned' });

test('owned aircraft never read as expiring', () => {
  assert.equal(leaseRemainingWeeks(owned('N1')), null);
  assert.equal(isLeaseExpiring(owned('N1')), false);
});

test('a lease inside the warning window is flagged', () => {
  assert.equal(isLeaseExpiring(leased('a', 8)), true);
  assert.equal(isLeaseExpiring(leased('b', 1)), true);
  assert.equal(isLeaseExpiring(leased('c', LEASE_EXPIRY_WARN_WEEKS + 1)), false);
});

test('an already-expired lease is not "expiring" — the tick has taken it', () => {
  // The engine removes the aircraft on the tick that hits 0, so a 0 here is a
  // tail already gone. Counting it would make the alert outlive the aircraft.
  assert.equal(isLeaseExpiring(leased('d', 0)), false);
  assert.equal(isLeaseExpiring(leased('e', -3)), false);
});

test('a lease with no remaining-weeks field is not guessed at', () => {
  assert.equal(isLeaseExpiring({ id: 'f', ownershipType: 'lease' }), false);
});

test('expiring tails come back soonest-first, so the fix order is obvious', () => {
  const fleet = [owned('own'), leased('far', 40), leased('soon', 2), leased('mid', 7)];
  assert.deepEqual(leasesExpiringSoon(fleet).map(a => a.id), ['soon', 'mid']);
});

test('the window is caller-adjustable without touching the predicate', () => {
  const fleet = [leased('a', 2), leased('b', 12), leased('c', 30)];
  assert.deepEqual(leasesExpiringSoon(fleet, 16).map(a => a.id), ['a', 'b']);
});

test('an empty or missing fleet is not a crash', () => {
  assert.deepEqual(leasesExpiringSoon([]), []);
  assert.deepEqual(leasesExpiringSoon(undefined), []);
});

// ── 5. The surfaces actually use the shared helper ───────────────────────────
for (const [file, what] of [
  ['src/components/Dashboard.jsx', 'the Dashboard alert strip'],
  ['src/components/Fleet.jsx', 'the Fleet filter chips'],
  ['src/components/WeeklyDebrief.jsx', 'the weekly debrief'],
]) {
  test(`${what} reads lease expiry from the shared helper`, () => {
    const src = readFileSync(join(ROOT, file), 'utf8');
    assert.ok(/leaseAlerts\.js/.test(src), `${file} does not import utils/leaseAlerts.js`);
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
