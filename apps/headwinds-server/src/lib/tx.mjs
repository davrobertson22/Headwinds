// Interactive-transaction policy for every write path in this service.
// ----------------------------------------------------------------------------
// Prisma's default interactive-transaction budget is 5s total (`timeout`) and 2s
// to acquire a connection (`maxWait`). That default is wrong for Headwinds for a
// structural reason: the WORKER's weekly tick commits an entire world — every
// airline blob, standings, dividends, news — inside ONE transaction, and while it
// runs it holds row locks on every Airline row it has written (see tickService's
// TICK_TX_OPTS, which already had to be raised to 30s for the same reason).
//
// A player decision landing mid-tick therefore does not fail on its own merits:
// its `airline.updateMany` simply BLOCKS on the tick's row lock, the 5s budget
// expires underneath it, and Prisma raises
//
//     Invalid `prisma.airline.updateMany()` invocation:
//     Transaction API error: Transaction already closed ...
//
// which the API then handed straight to the player as a red toast. The write was
// never in conflict — it was just early. So: give player-facing transactions a
// real budget, and retry the handful of Postgres/Prisma failures that are
// transient by definition rather than surfacing them.
//
// Retries are safe here because every one of these transactions is written as
// compare-and-set: the row versions are read before the transaction and re-checked
// inside it, so a rolled-back attempt leaves nothing behind, and a retry either
// lands cleanly or loses its CAS and returns an honest 409.

// The ceiling that actually matters. The web client aborts a request at
// REQUEST_TIMEOUT_MS = 15s (apps/headwinds-web/src/api.js) and shows "The server
// did not respond". Retrying past that point buys the player nothing — it just
// swaps one bad toast for another — so every attempt plus its backoff has to fit
// inside this, with headroom for the rest of the request.
export const PLAYER_DEADLINE_MS = 11_000;

// Player-facing writes: long enough to sit out most of a tick commit, short enough
// that two attempts still land inside PLAYER_DEADLINE_MS.
export const TX_OPTS = { timeout: 9_000, maxWait: 5_000 };

// Prisma error codes that mean "this attempt was unlucky", not "this write is wrong".
//   P2028 — transaction API error / transaction already closed (budget expired)
//   P2034 — write conflict or deadlock detected
//   P2024 — timed out fetching a connection from the pool
const TRANSIENT_CODES = new Set(['P2028', 'P2034', 'P2024']);

// Some of these arrive as a raw driver error without a Prisma code attached
// (notably through pgBouncer), so match the wording too.
const TRANSIENT_TEXT = /transaction already closed|transaction api error|transaction not found|write conflict|deadlock detected|unable to start a transaction|timed out fetching a new connection/i;

export function isTransientTxError(err) {
  if (!err) return false;
  if (TRANSIENT_CODES.has(err.code)) return true;
  return typeof err.message === 'string' && TRANSIENT_TEXT.test(err.message);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run an interactive transaction with a real budget and transient-failure retry.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {(tx: any) => Promise<any>} fn          transaction body (must be CAS-guarded)
 * @param {object} [opts]
 * @param {number} [opts.retries=1]               extra attempts after the first
 * @param {number} [opts.baseDelayMs=150]         backoff base (exponential + jitter)
 * @param {number|null} [opts.deadlineMs]         total wall-clock ceiling across all
 *                                                attempts; defaults to
 *                                                PLAYER_DEADLINE_MS. Pass null for
 *                                                background work (the worker tick)
 *                                                where no client is waiting.
 * @param {(info: object) => void} [opts.onRetry] observability hook
 * @param {number} [opts.timeout]                 overrides TX_OPTS.timeout
 * @param {number} [opts.maxWait]                 overrides TX_OPTS.maxWait
 */
export async function withTx(prisma, fn, opts = {}) {
  const {
    retries = 1,
    baseDelayMs = 150,
    deadlineMs = PLAYER_DEADLINE_MS,
    onRetry,
    ...txOpts
  } = opts;

  const startedAt = Date.now();
  const base = { ...TX_OPTS, ...txOpts };

  for (let attempt = 0; ; attempt++) {
    // Each attempt gets the smaller of its configured budget and whatever is left
    // of the deadline, so a slow first attempt shortens the second rather than
    // doubling the player's wait past the client's abort.
    const options = { ...base };
    if (deadlineMs != null) {
      const remaining = deadlineMs - (Date.now() - startedAt);
      options.timeout = Math.max(1_000, Math.min(options.timeout, remaining));
      options.maxWait = Math.min(options.maxWait, options.timeout);
    }

    try {
      return await prisma.$transaction(fn, options);
    } catch (err) {
      if (attempt >= retries || !isTransientTxError(err)) throw err;

      // Exponential backoff with jitter: two players blocked behind the same tick
      // must not retry in lockstep and deadlock each other all over again.
      const delay = baseDelayMs * 2 ** attempt + Math.floor(Math.random() * baseDelayMs);

      // No point sleeping to start an attempt that cannot finish before the client
      // gives up — surface the transient error now and let the caller map it.
      if (deadlineMs != null && Date.now() - startedAt + delay + 1_000 >= deadlineMs) throw err;

      onRetry?.({ attempt: attempt + 1, delay, code: err.code, message: err.message });
      await sleep(delay);
    }
  }
}
