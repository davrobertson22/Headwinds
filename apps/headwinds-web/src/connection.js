// Connection/poll timing rules for the live game screen.
//
// Split out of GamePlayScreen so the timing that decides "poll hard now" and
// "we've lost contact" is a pure function that can be tested directly —
// getting it wrong is not a cosmetic bug: it is how a client ends up polling
// every 4 seconds forever, or sitting on a stale week without saying so.

// How long without a successful poll before we call it a lost connection. Long
// enough to ride out one failed request (15s timeout) plus the next 25s poll.
export const STALE_AFTER_MS = 45000;

// How long past a due tick we keep fast-polling before falling back to the
// normal cadence.
//
// THE BUG THIS EXISTS TO PREVENT: the original test was
//   nextTickAt - now < 5000
// with no lower bound. Once the tick time passes, that difference is NEGATIVE
// and the condition is true forever — so a client that has stopped receiving
// worldClock updates (i.e. one that has lost its connection) polls every 4s
// indefinitely, hammering the API at exactly the moment it is least able to
// answer, and stacking hung requests until only a page refresh clears them.
export const FAST_POLL_AFTER_DUE_MS = 90000;

// True in the short window around a due tick, so the new week lands moments
// after the server ticks instead of "within 25s, maybe".
export function shouldFastPoll(nextTickAt, now = Date.now()) {
  if (!nextTickAt) return false;
  const due = new Date(nextTickAt).getTime();
  if (!Number.isFinite(due)) return false;
  const dt = due - now;
  return dt < 5000 && dt > -FAST_POLL_AFTER_DUE_MS;
}

// True when the last successful poll is old enough that we should tell the
// player, and old enough that local state can no longer be trusted over the
// server's (so a resync adopts the server blob wholesale).
export function isStaleContact(lastOkMs, now = Date.now()) {
  return now - lastOkMs > STALE_AFTER_MS;
}
