// The API's one error handler: uniform `{ error, code? }` below 500, a safe
// player-facing message at 500+. Lives here rather than inline in server.mjs so
// suites that build a Fastify app around a single plugin
// (tools/tailwinds-cloud-saves-test.mjs) answer exactly as production does.
import { transientKind, TRANSIENT_MESSAGE } from './tx.mjs';

// Uniform error shape. Respect an error's statusCode (set by our helpers /
// Fastify's validation); default to 500 and log unexpected ones.
//
// Below 500 the message is ours and is written for the player, so it is sent
// as-is. At 500+ it is NOT: it is whatever the driver said, and the client
// renders `error` directly in a toast — which is how players ended up staring at
// "Invalid `prisma.airline.updateMany()` invocation: Transaction API error...".
// Internals stay in the log; the player gets something actionable.
export function errorHandler(err, request, reply) {
  // A transaction that timed out or lost a deadlock is not a broken request —
  // it is a busy database. A dropped or unobtainable connection is not a
  // broken request either — it is a database that did not answer. Both are
  // 503 + retryable so the client re-submits instead of telling the player
  // their move failed (or, worse, that it was our bug).
  const kind = err.statusCode ? null : transientKind(err);
  const status = err.statusCode ?? (kind ? 503 : 500);

  if (status >= 500) request.log.error(err);
  // Below 500, pass through the machine-readable code when a helper set one.
  // Read from `appCode`, NOT `code`: Prisma ('P2028') and Fastify
  // ('FST_ERR_VALIDATION') both put their own values on `err.code`, and
  // transientKind above matches on it — a name collision here would be a
  // very quiet way to break transient-failure retry.
  // The client cannot decide whether a failed write is safe to re-submit from
  // the status alone — 409 is both "lost the version check, nothing written"
  // and "your airline is BANKRUPT". See apps/headwinds-web/src/decisionPolicy.js.
  if (status < 500) {
    return reply.code(status).send({
      error: err.message || 'Request failed',
      ...(err.appCode ? { code: err.appCode } : {}),
    });
  }

  return reply.code(status).send({
    error: kind ? TRANSIENT_MESSAGE[kind] : 'Something went wrong on our end. Try again in a moment.',
    retryable: Boolean(kind),
  });
}
