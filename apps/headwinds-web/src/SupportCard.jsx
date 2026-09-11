// "Support the dev" — the ask, in the three places a player will actually meet
// it (see also the footer link in App.jsx and the static /support.html page).
//
// WHERE THIS DOES NOT GO: anywhere in the gameplay loop. No modal, nothing at a
// tick, nothing on a bankruptcy or failure screen. A player who has just lost an
// airline is not a prospect, and a game that interrupts itself to ask for money
// reads as a different kind of game than this one.
import { useState } from 'react';
import { SupporterBadge } from './OgBadge.jsx';
import {
  KOFI_URL, SUPPORT_PITCH, SUPPORT_PERKS,
  isSupportCardDismissed, dismissSupportCard,
} from './support.js';

// The Ko-fi cup, inlined. A remote image would be a third-party request on the
// lobby's critical path for a 16px glyph, and it would break the day Ko-fi moves
// its CDN — this renders in the button's own colour and can't 404.
function KofiMark({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"
         style={{ flex: 'none', verticalAlign: '-2px' }}>
      <path d="M3 5h14a4 4 0 0 1 0 8h-1.1A6 6 0 0 1 10 18H8a6 6 0 0 1-6-6V6a1 1 0 0 1 1-1Zm14 6a2 2 0 0 0 0-4h-1v4h1ZM2 20h16a1 1 0 0 1 0 2H2a1 1 0 0 1 0-2Z" />
    </svg>
  );
}

/** The Ko-fi button itself — same destination everywhere it appears. */
export function KofiButton({ label = 'Support on Ko-fi', className = 'btn primary' }) {
  return (
    <a className={className} href={KOFI_URL} target="_blank" rel="noopener noreferrer"
       style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <KofiMark />{label}
    </a>
  );
}

/**
 * The lobby card. Dismissible for 30 days (support.js), and replaced by a short
 * thank-you for anyone who has already given — asking a supporter again is how
 * you turn a supporter back into a stranger.
 *
 * `me` is the /me payload; `me.account.isSupporter` decides which face it wears.
 */
export default function SupportCard({ me }) {
  const isSupporter = me?.account?.isSupporter === true;
  const [dismissed, setDismissed] = useState(() => isSupportCardDismissed());

  // Signed-out visitors see the lobby's sign-in card instead; no ask until
  // there's an account the badge could actually land on.
  if (!me?.account) return null;

  if (isSupporter) {
    return (
      <div className="card">
        <h3 style={{ marginTop: 0 }}><SupporterBadge /> Thank you</h3>
        <p className="muted small" style={{ marginBottom: 0 }}>
          You've chipped in toward the servers — the badge is on your airline in every
          world, and the ads are off. It genuinely helps. If you ever want to change or
          cancel a monthly tip, it's all on your{' '}
          <a href={KOFI_URL} target="_blank" rel="noopener noreferrer">Ko-fi page</a>.
        </p>
      </div>
    );
  }

  if (dismissed) return null;

  return (
    <div className="card">
      <div className="list-head" style={{ alignItems: 'flex-start' }}>
        <h3 style={{ margin: 0 }}>Support Headwinds</h3>
        <button
          className="btn small" title="Hide this for a month"
          onClick={() => { dismissSupportCard(); setDismissed(true); }}
        >
          Not now
        </button>
      </div>
      <p className="muted small">{SUPPORT_PITCH}</p>
      <ul className="muted small" style={{ margin: '0 0 14px', paddingLeft: 18 }}>
        {SUPPORT_PERKS.map((perk) => <li key={perk}>{perk}</li>)}
      </ul>
      <KofiButton />
      <p className="muted small" style={{ margin: '10px 0 0' }}>
        One-off or monthly, whatever suits. Ko-fi will ask for a name — leave your
        Headwinds username in the message and the badge goes on within a day or so.
      </p>
    </div>
  );
}

/**
 * The season-end prompt. A player who has just finished a season is the highest-
 * intent audience the game has: they got a whole season out of it and the cost of
 * running that season is a real thing that just happened. Deliberately smaller
 * than the lobby card — one line and a button, under the final standings.
 */
export function SeasonSupportPrompt({ me }) {
  // Signed-out visitors browsing a finished world didn't play this season —
  // and supporters have already given. Neither gets asked.
  if (!me?.account || me.account.isSupporter === true) return null;
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <p className="muted small" style={{ margin: '0 0 12px' }}>
        That's a season — about seven months of a world ticking around the clock.
        Headwinds is free and stays free; if it was worth something to you, chipping in
        covers the servers that ran it.
      </p>
      <KofiButton label="Support the dev on Ko-fi" className="btn small" />
    </div>
  );
}
