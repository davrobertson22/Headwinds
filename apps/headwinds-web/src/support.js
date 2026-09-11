// Ko-fi support — one place that knows where the money goes and what we say
// about it, so the lobby card, the season-end prompt, the footer and the static
// pages can never drift apart.

// Dave's Ko-fi page. The widget script Ko-fi hands out (kofiwidget2.init/draw)
// is deliberately NOT used: it injects its button with document.write-style DOM
// writes that fight React's reconciler, costs a render-blocking third-party
// request, and renders a button in Ko-fi's colours rather than Headwinds'. A
// plain link to the same page takes the same donation.
export const KOFI_URL = 'https://ko-fi.com/E2V226S4CD';

// What Headwinds costs Dave to run in a month, as a display string (e.g. '$40').
// Server-cost framing converts better than a tip jar BECAUSE it is specific and
// checkable — so leave this null rather than guessing: the copy below drops to a
// version with no figure in it, and no claim is made that can't be stood behind.
// Set it once you've totalled Railway + Supabase + domains, and never imply the
// game shuts down without it unless that is actually true.
export const MONTHLY_COST = null;

// The one-line ask. Shared by every surface so the pitch is identical wherever
// a player meets it.
export const SUPPORT_PITCH = MONTHLY_COST
  ? `Headwinds costs about ${MONTHLY_COST} a month in servers. It's free, and it stays free — if it's worth something to you, this helps cover the bill.`
  : "Headwinds is free and it stays free. Running the worlds costs real money every month, so if the game is worth something to you, chipping in helps cover the servers.";

// What a supporter actually gets. Kept honest and kept short — and kept
// cosmetic. See Account.isSupporter in schema.prisma for why nothing on this
// list may ever touch the simulation.
export const SUPPORT_PERKS = [
  'A ♥ SUPPORTER badge beside your airline, in every world',
  'No ads, anywhere in the game',
  'Nothing that affects the game itself — no cash, no gates, no speed',
];

// Dismissal is remembered for 30 days, not forever: a player who says "not now"
// in week one may feel differently after a season. Per-browser and best-effort —
// localStorage throws in private windows and can come back empty, so every read
// and write is guarded and the card simply shows when in doubt.
const DISMISS_KEY = 'hw.support.dismissedAt';
const DISMISS_DAYS = 30;

export function isSupportCardDismissed() {
  try {
    const at = Number(window.localStorage.getItem(DISMISS_KEY));
    if (!Number.isFinite(at) || at <= 0) return false;
    return Date.now() - at < DISMISS_DAYS * 24 * 60 * 60 * 1000;
  } catch { return false; }
}

export function dismissSupportCard() {
  try { window.localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch { /* no-op */ }
}
