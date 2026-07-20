// Lightweight in-memory rate limiter (no external dependency, in the spirit of
// the messages route's per-hour cap). A per-instance sliding window keyed by an
// arbitrary string (typically account id). Enough to blunt a single client
// flooding the write endpoints (decisions, join/leave) with junk that bloats the
// Decision table and Supabase egress. On a multi-instance deployment each
// instance limits independently — still caps any single abuser hitting one node.

const buckets = new Map(); // key -> number[] of recent hit timestamps (ms)

let lastSweep = 0;
function sweep(now) {
  if (now - lastSweep < 60_000) return; // sweep at most once a minute
  lastSweep = now;
  for (const [k, hits] of buckets) {
    // Drop keys with no hits in the last 5 minutes so idle players don't leak.
    if (!hits.some((t) => now - t < 300_000)) buckets.delete(k);
  }
}

// Returns true if this hit is within the limit, false if the caller is over it.
export function allow(key, limit, windowMs) {
  const now = Date.now();
  sweep(now);
  const recent = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    buckets.set(key, recent); // remember the window; refuse the hit
    return false;
  }
  recent.push(now);
  buckets.set(key, recent);
  return true;
}
