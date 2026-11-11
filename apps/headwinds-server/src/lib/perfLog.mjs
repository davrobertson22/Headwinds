// Where the time goes, in the server's own log.
//
// The performance work of November 2026 was measured on airlines rebuilt from
// an export, never on production. This puts the same figures in the Railway
// log, so the next question ("is it still slow, and where?") is answered by
// reading it rather than by rebuilding a world:
//
//   [perf] decision UPDATE_TICKET_PRICE 412ms (views 301, reduce 38, commit 61) lean routes=4027 fleet=4884 airline=…
//   [tick] … computed 33 airline(s) in 9120ms; slowest: All Nippon 2011ms, Ajax Air 1702ms, …
//
// A decision is logged only when it is slow (PERF_LOG_SLOW_MS, default 250),
// plus one in PERF_LOG_SAMPLE (default 200) of the rest so there is a baseline
// to compare the slow ones with. Fastify already logs every request with its
// total; this adds the split, and nothing a player typed.
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
export const PERF_LOG_SLOW_MS = num(process.env.PERF_LOG_SLOW_MS, 250);
export const PERF_LOG_SAMPLE = Math.max(1, Math.round(num(process.env.PERF_LOG_SAMPLE, 200)));

/** A stopwatch with named laps: lap('views') records the time since the last lap. */
export function stopwatch(now = () => performance.now()) {
  const started = now();
  let last = started;
  const laps = {};
  return {
    lap(name) { const t = now(); laps[name] = (laps[name] ?? 0) + (t - last); last = t; },
    total: () => now() - started,
    laps: () => ({ ...laps }),
  };
}

let seen = 0;
/** Should this one be logged? Slow ones always; the rest one in PERF_LOG_SAMPLE. */
export function shouldLogPerf(totalMs, { slowMs = PERF_LOG_SLOW_MS, sample = PERF_LOG_SAMPLE } = {}) {
  if (totalMs >= slowMs) return true;
  return (++seen % sample) === 0;
}

/** One line for a decision. `facts` are small numbers and flags only. */
export function decisionPerfLine(type, watch, facts = {}) {
  const laps = watch.laps();
  const split = Object.entries(laps).map(([k, v]) => `${k} ${Math.round(v)}`).join(', ');
  const tail = Object.entries(facts).filter(([, v]) => v !== undefined && v !== null && v !== false)
    .map(([k, v]) => (v === true ? k : `${k}=${v}`)).join(' ');
  return `[perf] decision ${type} ${Math.round(watch.total())}ms (${split})${tail ? ' ' + tail : ''}`;
}

/** "slowest: A 2011ms, B 1702ms, C 640ms" from [{ name, ms }]. */
export function slowestLine(timings, n = 3) {
  const top = [...timings].sort((a, b) => b.ms - a.ms).slice(0, n);
  return top.length ? `slowest: ${top.map((t) => `${t.name} ${Math.round(t.ms)}ms`).join(', ')}` : '';
}
