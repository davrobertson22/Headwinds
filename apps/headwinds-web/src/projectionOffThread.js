/**
 * Work out an incoming state's weekly projection in a Web Worker before the
 * page adopts it.
 *
 * Every screen asks projectWeek(state) synchronously — the Dashboard, the map,
 * the alerts column, the Routes and Fleet tables. A full weekly tick for a big
 * airline is 0.2–0.6 s, and in a busy world nearly every 25-second poll brings
 * a new rival overlay, so the page froze for that long, over and over, with the
 * player doing nothing (and again, longer, when a new week landed).
 *
 * projectOffThread(next) sends `next` to a worker, which projects
 * hydrateState(next) with the same engine; the result is primed into
 * projectWeek's cache for the very object the screens will call it with, so
 * adopting `next` costs a cache hit. The page keeps showing the previous
 * numbers until then.
 *
 * Between ticks only the rival overlay changes. The worker keeps the last
 * state it was sent, so when `base` is that state, only `overlay` (kilobytes)
 * crosses — not the whole save.
 *
 * Always resolves (true when primed). No Worker, a worker error, an engine
 * error or a slow answer (> TIMEOUT_MS) all resolve false, and the screens
 * simply compute it themselves as before.
 */
import { hydrateState } from '../../../src/store/GameContext.jsx';
import { primeProjectWeek } from '../../../src/utils/financeProjection.js';
import { primeOwnMetalCuts } from '../../../packages/engine/src/models/network.js';

export const TIMEOUT_MS = 8000;

let worker = null;
let broken = false;
let seq = 0;
let heldId = null;       // the message id whose state the worker holds…
let heldState = null;    // …and that state, on this side
const waiting = new Map();

function spawnDefault() {
  return new Worker(new URL('./workers/projectionWorker.js', import.meta.url), { type: 'module' });
}
let spawn = spawnDefault;

function getWorker() {
  if (worker || broken) return worker;
  if (spawn === spawnDefault && (typeof Worker !== 'function' || typeof window === 'undefined')) { broken = true; return null; }
  try {
    worker = spawn();
    worker.onmessage = (e) => {
      const r = e.data;
      const w = waiting.get(r?.id);
      if (w) { waiting.delete(r.id); w(r); }
    };
    worker.onerror = () => { reset(true); };
  } catch { broken = true; worker = null; }
  return worker;
}

function reset(markBroken = false) {
  try { worker?.terminate(); } catch { /* already gone */ }
  worker = null;
  heldId = null;
  heldState = null;
  if (markBroken) broken = true;
  for (const w of waiting.values()) w({ error: 'worker reset' });
  waiting.clear();
}

function ask(msg) {
  const w = getWorker();
  if (!w) return Promise.resolve({ error: 'no worker' });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (waiting.delete(msg.id)) {
        // The worker is still busy on this one; its held state is now unknown.
        reset(false);
        resolve({ error: 'timeout' });
      }
    }, TIMEOUT_MS);
    waiting.set(msg.id, (r) => { clearTimeout(timer); resolve(r); });
    try { w.postMessage(msg); }
    catch (e) {
      // Not cloneable (should not happen with a JSON state) — never retry.
      clearTimeout(timer);
      waiting.delete(msg.id);
      reset(true);
      resolve({ error: String(e?.message ?? e) });
    }
  });
}

export async function projectOffThread(next, { base = null, overlay = null } = {}) {
  if (!next || typeof next !== 'object') return false;
  if (!getWorker()) return false;
  let reply;
  if (base && overlay && base === heldState && heldId != null) {
    const id = ++seq;
    const baseId = heldId;
    heldId = id; heldState = next;
    reply = await ask({ id, op: 'overlay', baseId, overlay });
  }
  if (!reply || reply.missing) {
    const id = ++seq;
    heldId = id; heldState = next;
    reply = await ask({ id, op: 'project', state: next });
  }
  if (!reply?.proj) return false;
  // Hub cuts the worker made for this projection: the page's own engine files
  // them, so its next projection (the player's click) starts from them.
  if (reply.cuts) primeOwnMetalCuts(reply.cuts);
  return primeProjectWeek(hydrateState(next), reply.proj);
}

// Tests: swap the worker factory (a worker_threads adapter) and start clean.
export function setProjectionWorkerForTests(factory) {
  reset(false);
  broken = false;
  spawn = factory ?? spawnDefault;
}
