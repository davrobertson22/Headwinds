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

// Connection-level failures: the pooler dropped our socket, or never handed us
// one. Nothing about the request was wrong — the database was simply not
// answering at that instant.
//   P1001 — can't reach database server
//   P1002 — database server reached but timed out
//   P1008 — operations timed out
//   P1017 — server has closed the connection
//
// THE OUTAGE THIS EXISTS FOR: on 2026-09-16 Supavisor's transaction-mode pool
// wedged for ~18 hours. Every query died with
//     FATAL: (ECHECKOUTTIMEOUT) unable to check out connection from the pool
//     after 60000ms in Transaction mode
// as a PrismaClientUnknownRequestError with NO code, and once the pool was
// reconfigured every stale socket in Prisma's pool threw P1017 "Server has
// closed the connection" exactly once before being replaced. Both reached the
// player as a red "Something went wrong on our end" 500 — our-bug wording for a
// failure that was not ours and that a retry would have cleared. The client
// already treats 503 as transient (apps/headwinds-web/src/api.js); the server
// just never said 503. See OUTAGE notes in the Headwinds project.
const CONNECTION_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017']);
const CONNECTION_TEXT = /server has closed the connection|can't reach database server|unable to check out connection from the pool|ECHECKOUTTIMEOUT|connection reset by peer|connection refused|broken pipe/i;

/**
 * Why a request failed through no fault of its own, or null if it is a real error.
 *   'tx'         — lost a lock race / transaction budget; the world is busy committing
 *   'connection' — the database or its pooler did not answer
 * Both are safe to retry: every write is CAS-guarded (see the header), and a
 * dropped connection rolls back whatever it was carrying.
 */
export function transientKind(err) {
  if (!err) return null;
  if (err.transient === 'tx' || err.transient === 'connection') return err.transient;
  if (CONNECTION_CODES.has(err.code)) return 'connection';
  if (TRANSIENT_CODES.has(err.code)) return 'tx';
  const msg = typeof err.message === 'string' ? err.message : '';
  if (CONNECTION_TEXT.test(msg)) return 'connection';
  if (TRANSIENT_TEXT.test(msg)) return 'tx';
  return null;
}

// ── A write must not outlive the client that asked for it ───────────────────
// Incident 2026-09-21 (Discord, TheCookiesGuy: "It's like the progress doesn't
// save but the money does"). While Supavisor was wedging, a POST /decisions
// could spend most of its life waiting for pool connections — up to 20s each
// for the airline read and the rival view, then the transaction — and commit
// AFTER the browser had already aborted at its 25s limit. The client treats a
// timeout as "unknown outcome": it rolls back to the server's state, which it
// fetched before the late commit landed, and the shallow polls that follow
// refuse to replace a same-week blob. So the player watched the edit vanish,
// while the purchase had in fact gone through and the cash was spent — and
// doing it again paid twice.
//
// The cure is to make the outcome KNOWN: past the cutoff, the transaction
// aborts itself before (and after) its writes, rolls back, and the request
// answers 503 retryable — nothing was written, which is exactly what the
// client's rollback shows. The cutoff sits well inside the client timeout so a
// commit that passes the final check still finishes before the browser gives up.
export class DeadlineError extends Error {
  constructor(elapsedMs, limitMs) {
    super(`Request outlived its ${limitMs}ms commit cutoff (${Math.round(elapsedMs)}ms) — rolled back, nothing written`);
    this.name = 'DeadlineError';
    this.transient = 'connection';
    // Retrying cannot help: the deadline is the request's, not the attempt's.
    this.noRetry = true;
  }
}

/** Throw DeadlineError once `elapsedMs` has reached `limitMs`. Call inside a transaction body. */
export function assertWithinDeadline(elapsedMs, limitMs) {
  if (Number.isFinite(elapsedMs) && elapsedMs >= limitMs) throw new DeadlineError(elapsedMs, limitMs);
}

export function isTransientTxError(err) {
  return transientKind(err) !== null;
}

// What the player reads on a 503. Below 500 the message is the route's own; at
// 500 it is the driver's and never shown. These two are the only 5xx lines a
// player sees, so they say what is happening and that trying again will work.
export const TRANSIENT_MESSAGE = {
  tx: 'The world is busy committing this week — give it a moment and try again.',
  connection: 'The database is not answering right now — give it a moment and try again.',
};

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
      if (attempt >= retries || err?.noRetry || !isTransientTxError(err)) throw err;

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
