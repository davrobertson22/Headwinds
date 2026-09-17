// /health that tells the truth.
//
// Until 2026-09-16 the healthcheck returned {ok:true} without touching the
// database, so while Supavisor's pool was wedged for eighteen hours Railway
// showed both services "Online", the status pages were green, and the only
// evidence was a Discord thread. A healthcheck that cannot fail is a
// healthcheck in name only.
//
// This one runs SELECT 1 through the same Prisma pool every route uses, with a
// short ceiling: a wedged pool takes 60s to admit it, and the answer "the
// database did not respond in 3s" is the whole point. Railway reads the
// non-200 at deploy time and refuses to cut over to a build that cannot reach
// Postgres; an external pinger (UptimeRobot, Better Stack, a cron curl) reads
// it continuously — Railway itself does NOT re-poll the healthcheck after
// deploy, so an alert needs one of those.
export const HEALTH_DB_TIMEOUT_MS = 3_000;

/**
 * @returns {{ ok: boolean, ms: number, error?: string }}
 */
export async function probeDatabase(prisma, timeoutMs = HEALTH_DB_TIMEOUT_MS) {
  const t0 = Date.now();
  let timer;
  const ceiling = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error(`database did not answer within ${timeoutMs}ms`), { code: 'HEALTH_TIMEOUT' }));
    }, timeoutMs);
  });
  try {
    await Promise.race([prisma.$queryRaw`SELECT 1`, ceiling]);
    return { ok: true, ms: Date.now() - t0 };
  } catch (err) {
    const error = err?.code ?? String(err?.message ?? err).slice(0, 160);
    return { ok: false, ms: Date.now() - t0, error };
  } finally {
    clearTimeout(timer);
  }
}

/** HTTP status + body for the probe result. 503 when the database is not answering. */
export function healthReport({ db, service, commit }) {
  return {
    status: db.ok ? 200 : 503,
    body: { ok: db.ok, service, commit, db },
  };
}
