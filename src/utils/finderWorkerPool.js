/**
 * A small pool of Web Workers that price Route Finder rows.
 *
 * Discord, 2026-10-21 (VodkaOnFire): "It takes 4-8 seconds at this point every
 * time you load up the route finder and change the filter." Every finder
 * forecast runs a network week with the candidate route in it, and a profit
 * sort needs 150 of them. On the main thread that was seconds of work handed
 * out 24 ms at a time; here it runs on up to four background cores while the
 * page stays free.
 *
 * - Each worker holds one state at a time (sent once per state object, not per
 *   job) and its own network-tick memo. A lane always goes to the same worker
 *   (hashed on origin, destination and frequency), so switching the aircraft
 *   reuses that worker's ticks — the tick never sees the aircraft. An idle
 *   worker takes work from the busiest queue rather than sit out.
 * - `submit(owner, job, tasks)` REPLACES what that owner still has queued: a new
 *   search drops the old one's unpriced rows. Rows already being priced finish.
 * - Any failure — a worker that will not start, a state the browser cannot copy
 *   to a worker — marks the pool broken and calls `onFail` for every row it
 *   held; the finder then prices on the main thread exactly as before.
 */

const CHUNK = 4;

function hashKey(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * @param {{ size: number, spawn: () => Worker, chunk?: number }} opts
 * job:   { state, ctx, token, onResult(key, projection), onFail(key) }
 * tasks: [{ key, row: { origin, code, distKm, refPrice, block }, affinity? }]
 */
export function createForecastPool({ size, spawn, chunk = CHUNK }) {
  const slots = [];
  const inflight = new Map();          // jobId -> { slot, items }
  const stateIds = new WeakMap();
  let nextStateId = 1, nextJobId = 1;
  let broken = false, started = false;

  function failAll() {
    if (broken) return;
    broken = true;
    const lost = [];
    for (const s of slots) { lost.push(...s.queue); s.queue = []; }
    for (const { items } of inflight.values()) lost.push(...items);
    inflight.clear();
    for (const s of slots) { try { s.worker?.terminate?.(); } catch { /* ignore */ } }
    for (const t of lost) { try { t.job.onFail?.(t.key); } catch { /* ignore */ } }
  }

  function start() {
    if (started) return !broken;
    started = true;
    try {
      for (let i = 0; i < size; i++) {
        const slot = { worker: null, busy: false, stateObj: null, stateId: null, queue: [] };
        slot.worker = spawn();
        slot.worker.onmessage = (e) => onReply(slot, e.data);
        slot.worker.onerror = () => failAll();
        slot.worker.onmessageerror = () => failAll();
        slots.push(slot);
      }
    } catch {
      failAll();
      return false;
    }
    return true;
  }

  function send(slot, items) {
    const job = items[0].job;
    const jobId = nextJobId++;
    inflight.set(jobId, { slot, items });   // before posting: a failed post hands these back too
    slot.busy = true;
    try {
      if (slot.stateObj !== job.state) {
        let id = stateIds.get(job.state);
        if (!id) { id = nextStateId++; stateIds.set(job.state, id); }
        slot.worker.postMessage({ type: 'state', id, state: job.state });
        slot.stateObj = job.state;
        slot.stateId = id;
      }
      slot.worker.postMessage({
        type: 'price', jobId, stateId: slot.stateId, ctx: job.ctx,
        rows: items.map((t) => ({ key: t.key, ...t.row })),
      });
    } catch {
      // DataCloneError and friends: this state cannot travel to a worker.
      failAll();
    }
  }

  function takeChunk(queue, fromEnd = false) {
    if (queue.length === 0) return [];
    const first = fromEnd ? queue[queue.length - 1] : queue[0];
    const out = [];
    if (fromEnd) {
      while (out.length < chunk && queue.length && queue[queue.length - 1].job === first.job) out.push(queue.pop());
    } else {
      while (out.length < chunk && queue.length && queue[0].job === first.job) out.push(queue.shift());
    }
    return out;
  }

  function pump() {
    if (broken) return;
    for (const slot of slots) {
      if (slot.busy) continue;
      let items = takeChunk(slot.queue);
      if (items.length === 0) {
        // Nothing of its own: help the busiest queue, from the far end.
        let donor = null;
        for (const s of slots) if (s !== slot && s.queue.length > chunk && (!donor || s.queue.length > donor.queue.length)) donor = s;
        if (donor) items = takeChunk(donor.queue, true);
      }
      if (items.length) send(slot, items);
      if (broken) return;
    }
  }

  function onReply(slot, msg) {
    if (broken || !msg || msg.type !== 'result') return;
    const rec = inflight.get(msg.jobId);
    if (!rec) return;
    inflight.delete(msg.jobId);
    slot.busy = false;
    if (msg.missing) {
      // The worker lost the state it was sent (it should never): send it again.
      slot.stateObj = null;
      slot.queue.unshift(...rec.items);
      pump();
      return;
    }
    const byKey = new Map(rec.items.map((t) => [t.key, t]));
    for (const [key, projection] of msg.results ?? []) {
      const t = byKey.get(key);
      if (!t) continue;
      byKey.delete(key);
      try { t.job.onResult?.(key, projection ?? null); } catch { /* a listener's bug is not the pool's */ }
    }
    for (const t of byKey.values()) { try { t.job.onFail?.(t.key); } catch { /* ignore */ } }
    pump();
  }

  return {
    get size() { return size; },
    get broken() { return broken; },
    /** Replace `owner`'s queued rows with `tasks` (rows of the same job already in flight are not re-sent). */
    submit(owner, job, tasks) {
      if (broken || !start()) return false;
      for (const s of slots) s.queue = s.queue.filter((t) => t.owner !== owner);
      const flying = new Set();
      for (const { items } of inflight.values()) {
        for (const t of items) if (t.owner === owner && t.job.token === job.token) flying.add(t.key);
      }
      for (const t of tasks) {
        if (flying.has(t.key)) continue;
        const slot = slots[hashKey(t.affinity ?? t.key) % slots.length];
        slot.queue.push({ owner, key: t.key, row: t.row, job });
      }
      pump();
      return !broken;
    },
    /** Rows this owner has queued or in flight. */
    pending(owner) {
      let n = 0;
      for (const s of slots) for (const t of s.queue) if (t.owner === owner) n++;
      for (const { items } of inflight.values()) for (const t of items) if (t.owner === owner) n++;
      return n;
    },
    terminate() { failAll(); },
  };
}

let shared;   // undefined: not tried yet; null: no workers here

/**
 * The page's pool, or null where there are no module workers (server render,
 * Node tests, an old browser) or after it broke — the caller then prices on
 * the main thread.
 */
export function getForecastPool() {
  if (shared === undefined) {
    shared = null;
    try {
      if (typeof window !== 'undefined' && typeof Worker !== 'undefined') {
        const cores = Number(globalThis.navigator?.hardwareConcurrency) || 2;
        shared = createForecastPool({
          size: Math.max(1, Math.min(4, cores - 1)),
          spawn: () => new Worker(new URL('../workers/finderForecastWorker.js', import.meta.url), { type: 'module' }),
        });
      }
    } catch { shared = null; }
  }
  return shared && !shared.broken ? shared : null;
}

/** Test seam: install a pool (or null for none); undefined resets to auto-detect. */
export function setForecastPoolForTests(pool) { shared = pool; }
