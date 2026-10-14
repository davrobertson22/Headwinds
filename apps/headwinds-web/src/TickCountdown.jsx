import { useState, useEffect } from 'react';
import { gameClockAt, formatGameClock } from '../../../src/components/gameClock.js';

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
  const lead = clockText ? <><strong>{clockText}</strong>{' · '}</> : null;
  // Overdue AND out of contact is not "landing" — it's us, not the world.
  if (ms <= 0) {
    if (stale) return <span title={clockTip ?? undefined}>{lead}waiting for the server…</span>;
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
