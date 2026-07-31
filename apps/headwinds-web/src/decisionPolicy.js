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

/** Server code for "you lost the optimistic-concurrency check; nothing was written". */
export const VERSION_CONFLICT = 'version_conflict';

/** How many times a single decision may be re-submitted after a lost CAS. */
export const MAX_DECISION_RETRIES = 1;

/**
 * A lost compare-and-set, identified by the server's explicit code — NOT by the
 * 409 status alone, which is also used for semantic refusals that retrying would
 * simply repeat.
 */
export function isVersionConflict(err) {
  return Boolean(err && err.status === 409 && err.code === VERSION_CONFLICT);
}

/**
 * May this failed decision be re-submitted verbatim?
 *
 * Only for a lost CAS, and only within the retry budget. Deliberately false for
 * every transport failure: those have an UNKNOWN outcome, and a re-sent
 * ADD_ROUTE / BUY_AIRCRAFT that actually landed the first time would double.
 */
export function shouldRetryDecision(err, attempt = 0, maxRetries = MAX_DECISION_RETRIES) {
  if (attempt >= maxRetries) return false;
  return isVersionConflict(err);
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
export async function runDecisionWrite({ post, errorBefore = null }) {
  try {
    let res;
    try {
      res = await post();
    } catch (e) {
      // Only a lost compare-and-set is re-submitted, and only once. See the
      // header: a timeout might already have been applied, so re-sending it
      // could open a route or buy an aircraft twice.
      if (!shouldRetryDecision(e, 0)) throw e;
      res = await post();
    }
    return { ok: true, res, rejection: freshDecisionError(res?.error, errorBefore) };
  } catch (error) {
    return { ok: false, error };
  }
}
