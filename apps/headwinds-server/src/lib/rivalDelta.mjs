// Rival updates sent as what changed.
//
// Between ticks almost every poll is "a rival moved": the server sends the
// rival overlay — every other airline's competitor entry and every contested
// pair's rival specs — and the client adopts it. On the busiest world that is
// 2.9 MB of JSON (~240 kB on the wire) each time, for a move that usually
// changes one airline's entry and a handful of pairs (measured 2026-11-12).
//
// The server remembers, per airline, a fingerprint of the last overlay it sent
// (a hash per top-level key, per competitor entry and per contested pair, and
// the order of each) and the world stamp it reflected. A client that says it
// holds that overlay (`rbase=<world stamp>`) is sent only the entries whose
// hash moved, the keys that went, and the order where it changed; it rebuilds
// the overlay exactly (web rivalDelta.js). Anything else gets the whole
// overlay, as before. Fingerprints are kept for airlines that polled in the
// last ten minutes; a restart forgets them all, which only costs one whole
// overlay per tab.
import { createHash } from 'node:crypto';

const IDLE_MS = 10 * 60_000;
const MAX_AIRLINES = 5000;
const records = new Map();   // airlineId -> { served, at, sig }

const h = (s) => createHash('sha1').update(s).digest('base64').slice(0, 20);
const json = (v) => JSON.stringify(v === undefined ? null : v);

/** Hashes of every part of an overlay that is patched separately. */
export function overlaySignature(overlay) {
  const top = new Map();
  for (const k of Object.keys(overlay ?? {})) {
    if (k === 'competitors' || k === 'humanRivals') continue;
    top.set(k, h(json(overlay[k])));
  }
  const comps = new Map();
  const ids = [];
  for (const c of overlay?.competitors ?? []) { ids.push(c?.id); comps.set(c?.id, h(json(c))); }
  const pairs = new Map();
  const hr = overlay?.humanRivals ?? {};
  const keys = Object.keys(hr);
  for (const k of keys) pairs.set(k, h(json(hr[k])));
  return {
    keys: h(json(Object.keys(overlay ?? {}))), keyList: Object.keys(overlay ?? {}),
    top, comps, compOrder: h(json(ids)), ids, pairs, pairOrder: h(json(keys)), pairKeys: keys,
    // Duplicate competitor ids cannot be patched by id: such an overlay is always sent whole.
    patchable: Array.isArray(overlay?.competitors) && new Set(ids).size === ids.length && ids.every((id) => id != null),
  };
}

/** The patch that turns the overlay `prev` was taken from into `overlay` (whose signature is `next`). */
export function diffOverlay(prev, next, overlay) {
  const topSet = {}, topDrop = [];
  for (const [k, hash] of next.top) if (prev.top.get(k) !== hash) topSet[k] = overlay[k];
  for (const k of prev.top.keys()) if (!next.top.has(k)) topDrop.push(k);
  const comps = { order: prev.compOrder === next.compOrder ? null : next.ids, put: [] };
  for (const c of overlay.competitors ?? []) if (prev.comps.get(c.id) !== next.comps.get(c.id)) comps.put.push(c);
  const pairs = { keys: prev.pairOrder === next.pairOrder ? null : next.pairKeys, put: {} };
  const hr = overlay.humanRivals ?? {};
  for (const [k, hash] of next.pairs) if (prev.pairs.get(k) !== hash) pairs.put[k] = hr[k];
  return { keys: prev.keys === next.keys ? null : next.keyList, top: { set: topSet, drop: topDrop }, comps, pairs };
}

/**
 * What to send for this poll: `{ rivals }` (the whole overlay) or
 * `{ rivalsPatch }`. Remembers what was sent either way.
 * @param airlineId  whose overlay
 * @param served     the world stamp the overlay reflects
 * @param overlay    rivalOverlay(view)
 * @param rbase      the world stamp of the overlay the client holds, if it said
 */
export function rivalsReply(airlineId, served, overlay, rbase, now = Date.now()) {
  for (const [id, r] of records) if (now - r.at > IDLE_MS) records.delete(id);
  const sig = overlaySignature(overlay);
  const kept = records.get(airlineId);
  records.delete(airlineId);
  if (records.size >= MAX_AIRLINES) records.delete(records.keys().next().value);
  records.set(airlineId, { served, at: now, sig });
  if (rbase && kept && kept.served === rbase && kept.sig.patchable && sig.patchable) {
    return { rivalsPatch: { base: rbase, ...diffOverlay(kept.sig, sig, overlay) } };
  }
  return { rivals: overlay };
}

/** Test seams. */
export function clearRivalDeltaRecords() { records.clear(); }
export function rivalDeltaRecordCount() { return records.size; }
