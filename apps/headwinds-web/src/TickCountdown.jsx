import { useState, useEffect } from 'react';
import { gameClockAt, formatGameClock, tickIntervalMs } from '../../../src/components/gameClock.js';

// How long past due before "landing…" turns into "running late". A big world's
// week normally commits in well under a minute.
export const LATE_AFTER_MS = 2 * 60_000;

/** Weeks this world's server clock is behind, from how far past nextTickAt we
 *  are: 1 while the due week is landing, 2+ once later weeks have come due too. */
export function weeksBehind(overdueMs, weeksPerDay) {
  const wpd = Number(weeksPerDay);
  if (!(overdueMs >= 0) || !(wpd > 0)) return overdueMs >= 0 ? 1 : 0;
  return 1 + Math.floor(overdueMs / tickIntervalMs(wpd));
}

// Live countdown to the server's next weekly tick. Derived from worldClock
// .nextTickAt; when it crosses zero we show "landing…" and the poller tightens
// up so the new week arrives promptly instead of "within 15s, maybe".
// Rendered inside the game topbar's DATE tile (via remoteChrome).
//
// preStart: a scheduled world still in LOBBY. The airline is playable but the
// clock is parked, so the countdown is to week 1 and the tooltip names the start.
//
// weeksPerDay (when the server sends it) adds the in-game time of day in front
// of the countdown — "Tue 14:45 · next week in 1h 20m". It runs Mon 00:00 →
// Sun 23:59 across the week's real interval and holds at 23:59 if a tick is
// late. See src/components/gameClock.js.
//
// Overdue for longer than LATE_AFTER_MS, it says the WORLD is behind ("running
// late", "catching up · 6 weeks behind") rather than an endless "landing…",
// and the tooltip says everyone in the world sees it — players were asking on
// Discord whether it was just them (2026-11-09).
export default function TickCountdown({ nextTickAt, paceLabel, stale, preStart = false, startsAt = null, weeksPerDay = null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!nextTickAt) return null;
  const ms = new Date(nextTickAt).getTime() - now;
  const clock = preStart ? null : gameClockAt(now, { nextTickAt, weeksPerDay });
  const clockText = clock ? formatGameClock(clock) : '';
  const clockTip = clock
    ? `Game time ${clockText} UTC. The simulation runs in whole weeks — this week's results land at Sunday midnight.`
    : null;
  const lead = clockText ? <><strong>{clockText}</strong>{' UTC · '}</> : null;
  // Overdue AND out of contact is not "landing" — it's us, not the world.
  if (ms <= 0) {
    if (stale) return <span title={clockTip ?? undefined}>{lead}waiting for the server…</span>;
    const overdue = -ms;
    if (!preStart && overdue >= LATE_AFTER_MS) {
      const behind = weeksBehind(overdue, weeksPerDay);
      const tip = [
        behind > 1
          ? `The server is running this world ${behind} weeks behind and is catching up a week at a time.`
          : 'This week is taking longer than usual to land on the server.',
        'Everyone in this world sees the same — it isn\'t your connection.',
        clockTip,
      ].filter(Boolean).join(' ');
      return (
        <span title={tip}>
          {lead}{behind > 1 ? <>catching up · <strong>{behind} weeks behind</strong></> : 'next week running late…'}
        </span>
      );
    }
    return <span title={clockTip ?? undefined}>{lead}{preStart ? 'first week landing…' : 'next week landing…'}</span>;
  }
  const totalSec = Math.ceil(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const label = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
  const parts = [];
  if (preStart && startsAt) {
    const at = new Date(startsAt);
    if (Number.isFinite(at.getTime())) {
      parts.push(`World starts ${at.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} — set up now, week 1 flies at the first tick`);
    }
  }
  if (clockTip) parts.push(clockTip);
  if (paceLabel) parts.push(`World pace: ${paceLabel}`);
  return (
    <span title={parts.length ? parts.join(' · ') : undefined}>
      {lead}{preStart ? 'first week in' : 'next week in'} <strong>{label}</strong>
    </span>
  );
}
