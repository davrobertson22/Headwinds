// What to do when an authoritative decision write does NOT land.
//
// Split out of GamePlayScreen for the same reason connection.js was: getting it
// wrong is not cosmetic. It is how a player's fare edit sits on screen looking
// saved for an hour and then silently reverts.
//
// ── The bug this file exists to prevent ──────────────────────────────────────
// Community reports, Discord, 2026-07-30:
//   Mariaklinga: "Price and other route settings reset in headwinds ... my
//                 routes randomly reset and then I only notice it when I make
//                 minus"
//   Kat the Fox: "for me it only happens while I change it sometimes"
//   A Ferg:      "yeah lots of times edits dont save/newroutes/etc"
//
// All three are one mechanism. `dispatch` applies every action optimistically
// through the local engine so the UI is instant, then POSTs the intent. When
// that POST failed, the old code called `load()` — and `load()` deliberately
// refuses to replace local state unless the server's week is STRICTLY NEWER
// ("don't stomp optimistic edits between polls"). So after a failed write:
//
//   • the server does not have the edit,
//   • the client still shows it,
//   • and nothing reconciles the two until the next weekly tick arrives with a
//     higher week and wipes it.
//
// The player sets a fare, sees it applied, flies a week at the OLD fare, and
// watches the number revert with no explanation. Hence "I only notice it when I
// make minus". Two rules fix it, and both live here.
//
// ── Rule 1: a lost compare-and-set is safe to retry, a timeout is not ────────
// POST /decisions writes under optimistic concurrency: `updateMany` guarded on
// the airline version read at the start of the request. The weekly tick holds
// row locks on every airline it writes for up to 30s, so a decision submitted
// while a world is committing loses that CAS and comes back 409.
//
// A 409 from that guard is the ONE failure where the outcome is known exactly:
// `updated.count === 0` means the transaction rolled back and NOTHING was
// written. Re-submitting the same intent is therefore safe — the server re-reads
// the airline fresh on each request, so the retry lands on the post-tick state,
// which is precisely where the player wanted their new fare.
//
// A timeout / NetworkError is the opposite: the request may have been applied
// and only the response lost. Retrying ADD_ROUTE there would open the route
// twice and buy an aircraft twice. So retries are gated on the server's explicit
// `version_conflict` code and nothing else — never on a bare 409 (the same
// status also carries "your airline is BANKRUPT" and the stock-pool refusals,
// which retrying would only repeat), and never on transport failure.
//
// ── Rule 2: any write that did not land must force a FULL resync ─────────────
// Whatever the reason, once a write has failed the optimistic state is a lie and
// only the server knows the truth. `load({ full: true })` drops the change stamp
// and adopts the server blob wholesale, bypassing the newer-week guard. A
// shallow `load()` cannot do this — that is the whole defect.
//
// It has to wait for the write chain to drain, though: writes are serialized,
// and adopting the server blob while later decisions are still on the wire would
// stomp THEIR optimistic edits and cause the exact bug in reverse.
//
// ── Rule 3 (2026-08-04): a server-ASSERTED rollback is also safe to retry ────
// Railway logs showed a failure class Rule 1 misses: while a tick commits, the
// API can starve of database connections for ~a minute (P2024 "Timed out
// fetching a new connection from the connection pool", observed in near-daily
// bursts — 7/31 23:02, 8/2 18:51 — the latter including a POST /decisions on
// Scarce Assets). The server maps every transient tx failure to 503
// `{ retryable: true }`, and that flag is a guarantee about OUTCOME, not a
// suggestion: it is set only for P2024 (the query never even started), P2028
// (interactive transaction expired — rolled back) and P2034 (write conflict /
// deadlock — rolled back). Nothing was written, so re-submitting the identical
// intent cannot open a route or buy an aircraft twice.
//
// api.js has carried `err.retryable` off the response since 2026-07-31 — and
// nothing ever read it. That gap is exactly "the save bug on Scarce Asset is
// still not fixed btw, it's still just rolling back" (Discord, 2026-08-03):
// the client rolled back edits the server had explicitly marked safe to
// re-send.
//
// Unlike a lost CAS (retried immediately — the tick has already committed by
// the time the 409 arrives), a retryable 503 usually means the squeeze is
// STILL ON, so these retries back off before re-entering it. This cannot relax
// the transport rule: `retryable` is read off a RESPONSE, and a timeout that
// never produced one can never carry the flag — NetworkErrors stay non-retried
// forever.

/** Server code for "you lost the optimistic-concurrency check; nothing was written". */
export const VERSION_CONFLICT = 'version_conflict';

/** How many times a single decision may be re-submitted after a lost CAS. */
export const MAX_DECISION_RETRIES = 1;

/** How many times a single decision may be re-submitted after a retryable 503. */
export const MAX_ROLLBACK_RETRIES = 2;

/**
 * Backoff before re-submitting after a retryable 503, indexed by how many
 * rollback retries have already been spent. Sized against the observed bursts:
 * the server answers a starved request in ~10s (its pool timeout), so with
 * these delays a decision keeps probing for roughly 38s worst-case — enough to
 * outlive a short squeeze, short enough that a player watching their edit
 * "saving…" is not left wondering for a minute.
 */
export const ROLLBACK_RETRY_DELAYS_MS = [2_500, 6_000];

/**
 * A lost compare-and-set, identified by the server's explicit code — NOT by the
 * 409 status alone, which is also used for semantic refusals that retrying would
 * simply repeat.
 */
export function isVersionConflict(err) {
  return Boolean(err && err.status === 409 && err.code === VERSION_CONFLICT);
}

/**
 * A transient failure the SERVER has asserted wrote nothing (Rule 3). Gated on
 * the explicit flag AND the 503 status it is only ever sent with — a truthy
 * `retryable` on any other shape (an old server, a proxy's error body, a
 * NetworkError someone decorated) does not count.
 */
export function isRetryableRollback(err) {
  return Boolean(err && err.status === 503 && err.retryable === true);
}

/**
 * May this failed decision be re-submitted verbatim?
 *
 * Only for the two failures whose outcome is KNOWN to be "nothing was written":
 * a lost CAS (immediately) and a server-asserted transient rollback (after a
 * backoff — see runDecisionWrite). Deliberately false for every transport
 * failure: those have an UNKNOWN outcome, and a re-sent ADD_ROUTE /
 * BUY_AIRCRAFT that actually landed the first time would double.
 */
export function shouldRetryDecision(err, attempt = 0, maxRetries = MAX_DECISION_RETRIES) {
  if (isVersionConflict(err)) return attempt < maxRetries;
  return false;
}

/**
 * How long to wait before re-submitting, given how many rollback retries have
 * already been spent. Null means "do not retry this failure (any more)".
 * Version conflicts re-submit immediately: by the time the 409 arrived, the
 * tick that beat us had already committed, so there is nothing to wait out.
 */
export function decisionRetryDelayMs(err, { conflictRetries = 0, rollbackRetries = 0 } = {}) {
  if (isVersionConflict(err)) {
    return conflictRetries < MAX_DECISION_RETRIES ? 0 : null;
  }
  if (isRetryableRollback(err)) {
    return rollbackRetries < MAX_ROLLBACK_RETRIES
      ? ROLLBACK_RETRY_DELAYS_MS[Math.min(rollbackRetries, ROLLBACK_RETRY_DELAYS_MS.length - 1)]
      : null;
  }
  return null;
}

/**
 * Should the failure handler adopt the server's state wholesale?
 *
 * Yes for every terminal failure — the optimistic apply did not land (or, for a
 * timeout, MIGHT not have), so local state can no longer be trusted — but only
 * once no further writes are in flight. A later write in the chain settles with
 * authoritative state of its own; rolling back underneath it would discard the
 * edits it is carrying.
 */
export function shouldRollback(writesInFlight) {
  return (writesInFlight ?? 0) <= 0;
}

/**
 * A decision only "reported" an engine rejection when it set a NEW one.
 *
 * `state.error` is sticky: the reducer writes it (MRO certification, heavy-check
 * funding) and never clears it, so it persists in the save blob indefinitely.
 * Showing `res.error` unconditionally would re-raise a week-old message on every
 * subsequent action. The server sends only the freshly-set error; this is the
 * client-side guard for older servers that still send the sticky one.
 */
export function freshDecisionError(nextError, prevError) {
  if (!nextError) return null;
  if (nextError === prevError) return null;
  return String(nextError);
}

/**
 * Run one authoritative decision write, with the retry rule applied.
 *
 * Kept out of GamePlayScreen so the sequence that decides whether a player's
 * edit survives is testable without a browser: `post` is the only collaborator,
 * and the outcome is data rather than a pile of side effects. The caller keeps
 * the React work — adopting state, showing the notice, rolling back.
 *
 * Resolves (never rejects) with one of:
 *   { ok: true,  res, rejection }  — the write landed. `rejection` is the engine's
 *                                    reason when it accepted the request but
 *                                    refused the action, else null.
 *   { ok: false, error }           — the write did not land, after any retry.
 */
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runDecisionWrite({ post, errorBefore = null, sleep = defaultSleep }) {
  const spent = { conflictRetries: 0, rollbackRetries: 0 };
  for (;;) {
    let res;
    try {
      res = await post();
    } catch (e) {
      // Re-submit ONLY the failures whose outcome is known to be "nothing was
      // written": a lost CAS (immediately, once) and a server-asserted
      // transient rollback (after a backoff, twice). Everything else — a
      // timeout that may already have been applied, a semantic refusal that
      // retrying would only repeat — surfaces to the caller. See the header.
      const delay = decisionRetryDelayMs(e, spent);
      if (delay == null) return { ok: false, error: e };
      if (isVersionConflict(e)) spent.conflictRetries += 1;
      else spent.rollbackRetries += 1;
      if (delay > 0) await sleep(delay);
      continue;
    }
    return { ok: true, res, rejection: freshDecisionError(res?.error, errorBefore) };
  }
}
