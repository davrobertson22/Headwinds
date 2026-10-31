// ── Pop-up alert preferences ─────────────────────────────────────────────────
//
// Discord, 2026-10-30 (tagged tailwinds): late in a game the weekly tick throws
// so many pop-ups — breakdowns, deliveries, rivals entering routes — that they
// bury the screen. Players asked for a key / button that clears them all, and a
// way to hide them for good or choose which kinds show.
//
// This file is the pure half (no React): which category a pop-up belongs to,
// whether a player's settings let it through, and how those settings are kept.
// The toast stack (components/ToastSystem.jsx) is the only caller that filters.
//
// Only WEEKLY alerts can be hidden. App.jsx marks a pop-up `alert: true` when it
// arrives with a new game week (i.e. the tick produced it). Pop-ups about
// something the player just did — "Not enough cash", "Lease unavailable" —
// arrive without a week change and always show, whatever the settings say.
//
// Categories are read from the TITLE rather than tagged in the engine, so this
// changes no game state (golden-master parity holds) and needs no engine port.
// tools/alert-prefs-test.mjs scrapes every pop-up title out of the engine and
// fails if one lands in "Everything else", so a new pop-up gets a home.

export const ALERT_PREFS_KEY = 'alert_prefs_v1';
export const ALERT_SETTINGS_OPEN_EVENT = 'tw:open-alert-settings';
export const RECENT_ALERTS_CAP = 40;

export const ALERT_CATEGORIES = [
  { id: 'maintenance', label: 'Breakdowns & maintenance', hint: 'Mechanical failures, write-offs, checks, reserve cover' },
  { id: 'fleet',       label: 'Fleet, orders & leases',   hint: 'Deliveries, order changes, lease expiries and renewals, retrofits' },
  { id: 'rivals',      label: 'Rivals & competition',     hint: 'Rivals entering or leaving your routes, fare wars, codeshares, collapses' },
  { id: 'finance',     label: 'Cash, loans & shares',     hint: 'Cash warnings, missed loan payments, dividends, hedges, fuel' },
  { id: 'operations',  label: 'Bases, gates, crew & contracts', hint: 'Lounges, bases, ground stations, gates, strikes, catering, partners' },
  { id: 'events',      label: 'World events & milestones', hint: 'World events starting and ending, objectives completed' },
  { id: 'other',       label: 'Everything else',          hint: 'Anything not listed above' },
];
const CATEGORY_IDS = new Set(ALERT_CATEGORIES.map(c => c.id));

// First match wins, so order matters: "Cover complete" is maintenance before
// the operations rule sees "complete —"; "Objective Complete" is a milestone.
const RULES = [
  // Save failures are never hideable (see shouldShowToast).
  ['system',      /not being saved|saving again/i],
  ['maintenance', /mechanical failure|written off|back in service|\bcheck\b|forced grounding|reserve dispatched|\bcover (complete|made permanent)|no cover for/i],
  ['events',      /objective complete|\bcomet\b|this era|this event|randomi[sz]ed world|— ended$/i],
  ['rivals',      /\bentered\b|backed off|contesting|new entrant|consolidation|collapses|in trouble|ceases operations|competes for your freight|fare war|competitor|codeshare|^\W*acquired\b|delisted|\brival/i],
  ['fleet',       /deliver|\border\b|launch customer|\blease|wi-?fi|wingtips|\breplaces?\b|waiting to replace|take over from|nothing to replace|out of range/i],
  ['finance',     /cash|weeks negative|\bloan\b|dividend|buyback|share offering|on the exchange|hedge|refinery|collateral|fuel farm|consortium seat/i],
  ['operations',  /lounge|jet base|\bbase\b|upgraded|ground station|complete —|catering|contract|partner|frustrated|renewed for|\bgates?\b|auction|alliance slots|flights cut|strike|\bcrew\b|seasonal route|started$/i],
];

/** Which category a pop-up belongs to: one of ALERT_CATEGORIES' ids, or 'system'. */
export function alertCategory(toast) {
  if (!toast) return 'other';
  // Random world events are the only pop-ups that carry their own colour.
  if (toast.eventColor) return 'events';
  const title = String(toast.title ?? '');
  for (const [id, re] of RULES) if (re.test(title)) return id;
  if (toast.icon === '⛽') return 'finance';
  return 'other';
}

export const DEFAULT_ALERT_PREFS = Object.freeze({ showAlerts: true, hidden: Object.freeze({}) });

/** Coerce anything (stale JSON, junk) into a valid prefs object. */
export function normalizeAlertPrefs(p) {
  const hidden = {};
  if (p && typeof p.hidden === 'object' && p.hidden) {
    for (const [k, v] of Object.entries(p.hidden)) if (CATEGORY_IDS.has(k) && v === true) hidden[k] = true;
  }
  return { showAlerts: p?.showAlerts !== false, hidden };
}

export function loadAlertPrefs() {
  try {
    const raw = globalThis.localStorage?.getItem(ALERT_PREFS_KEY);
    return normalizeAlertPrefs(raw ? JSON.parse(raw) : null);
  } catch {
    return normalizeAlertPrefs(null);
  }
}

export function saveAlertPrefs(p) {
  const clean = normalizeAlertPrefs(p);
  try { globalThis.localStorage?.setItem(ALERT_PREFS_KEY, JSON.stringify(clean)); } catch { /* private mode */ }
  return clean;
}

/** Does this pop-up get through the player's settings? */
export function shouldShowToast(toast, prefs) {
  if (!toast?.alert) return true;               // the player's own action: always
  const cat = alertCategory(toast);
  if (cat === 'system') return true;            // save problems: always
  const p = normalizeAlertPrefs(prefs);
  if (!p.showAlerts) return false;
  return !p.hidden[cat];
}

/**
 * Tag a batch of reducer pop-ups. A batch that arrives with a different game
 * week than the last one seen came from the weekly tick → `alert: true`.
 * `prevWeekKey` null (the first batch after mount) also counts as weekly: it is
 * what piled up while the player was away.
 */
export function tagWeeklyBatch(prevWeekKey, weekKey, toasts) {
  const weekly = prevWeekKey !== weekKey;
  return (toasts ?? []).map(t => (weekly ? { ...t, alert: true } : t));
}

/** How many categories are switched off (for the settings button's badge). */
export function hiddenCount(prefs) {
  const p = normalizeAlertPrefs(prefs);
  return p.showAlerts ? Object.keys(p.hidden).length : ALERT_CATEGORIES.length;
}

/** Ask the toast stack to open its settings panel (from a menu or button). */
export function openAlertSettings() {
  try { window.dispatchEvent(new Event(ALERT_SETTINGS_OPEN_EVENT)); } catch { /* SSR */ }
}

/** Is a key press aimed at something the player is typing in? */
export function isEditableTarget(el) {
  if (!el || typeof el !== 'object') return false;
  const tag = String(el.tagName ?? '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = String(el.type ?? 'text').toLowerCase();
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file', 'image'].includes(type);
  }
  return el.isContentEditable === true;
}
