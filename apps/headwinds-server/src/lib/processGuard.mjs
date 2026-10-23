// Keep one dead database socket from killing the whole API.
//
// ── What happened (2026-10-23) ──────────────────────────────────────────────
// The API crashed 11 times in a day and then stayed down for 3h: Railway's
// ON_FAILURE policy restarts a service at most 10 times. Every crash had the
// same stack, ending in Prisma's own transaction timer:
//
//   DriverAdapterError: SocketTimeout            (or pg's "Connection terminated
//     at PgTransaction.executeRaw                  unexpectedly" — 14:26:37)
//     at async Timeout.<anonymous> (@prisma/client/runtime/client.js)
//
// @prisma/client 6.19 arms each interactive transaction with
// `setTimeout(async () => rollback(...), timeout)` and never catches what that
// async callback returns. When a transaction outlives its timeout on a
// connection that has meanwhile died, the ROLLBACK rejects, nobody is listening,
// and Node's default for an unhandled rejection is to exit the process —
// taking every other player's in-flight request with it.
//
// Ten of the eleven crashes came in 74 minutes of one player's session on Time
// Flies: a 15 MB airline whose decisions take 8-20 s, so its writes are the
// ones that reach the 20 s decision timeout. To the players it looked like
// "half of my actions don't get picked up".
//
// ── What this does ──────────────────────────────────────────────────────────
// An unhandled rejection that comes out of the database layer (Prisma, its pg
// adapter, or pg itself) is logged and the process carries on. The request
// that owned that transaction has already failed with its own error — the
// timer fired precisely because it ran out of time — and Postgres rolls back a
// transaction whose connection dropped. Nothing is left half-written.
//
// Any OTHER unhandled rejection keeps Node's default: it crashes the process
// and the platform restarts it. A rejection we cannot explain may mean broken
// in-memory state, and a restart is the safe answer to that.

const DB_FRAME = /@prisma[\\/](client|adapter-pg)|[\\/]node_modules[\\/]pg[\\/]lib[\\/]/;
const DB_NAME = /^(DriverAdapterError|PrismaClient\w*Error)$/;

/** Did this rejection come out of the database layer? */
export function isDatabaseLayerFault(reason) {
  if (!reason || typeof reason !== 'object') return false;
  if (DB_NAME.test(String(reason.name ?? ''))) return true;
  if (DB_NAME.test(String(reason.constructor?.name ?? ''))) return true;
  return DB_FRAME.test(String(reason.stack ?? ''));
}

let installed = false;

/**
 * Install the unhandled-rejection guard (once per process). `log` needs
 * `error`; `label` names the process in the log line ('api', 'worker').
 */
export function installProcessGuards({ log = console, label = 'api' } = {}) {
  if (installed) return;
  installed = true;
  process.on('unhandledRejection', (reason) => {
    if (isDatabaseLayerFault(reason)) {
      const msg = reason?.message ?? String(reason);
      log.error(
        `[${label}] unhandled database-layer rejection — logged, NOT crashing: ${msg}\n${reason?.stack ?? ''}`,
      );
      return;
    }
    // Same outcome as Node's default (--unhandled-rejections=throw): the
    // process dies on it and the platform restarts it.
    throw reason;
  });
}
