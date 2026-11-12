// Rival updates sent as what changed: the client's half (server
// lib/rivalDelta.mjs has the why). The client keeps the last whole rival
// overlay the server sent on a poll, with the world stamp it reflected, and
// rebuilds the current one from a patch — key order included, so the result
// is the overlay the server would have sent, value for value.

/** The world half of a stamp ("<self>:<world>"), or null. */
export function worldHalfOf(stamp) {
  if (typeof stamp !== 'string') return null;
  const i = stamp.indexOf(':');
  return i < 0 ? null : stamp.slice(i + 1);
}

/**
 * The overlay `patch` describes, built on `held` (the overlay it was cut
 * against). Throws when the patch cannot belong to `held` — the caller then
 * forgets what it holds and takes the next whole overlay.
 */
export function applyRivalsPatch(held, patch) {
  if (!held || typeof held !== 'object' || !patch) throw new Error('rivals patch: nothing to apply it to');
  // Top-level keys, in the server's order.
  const keys = patch.keys ?? Object.keys(held);
  const out = {};
  for (const k of keys) {
    if (k === 'competitors' || k === 'humanRivals') { out[k] = undefined; continue; }
    if (k in (patch.top?.set ?? {})) out[k] = patch.top.set[k];
    else if (k in held) out[k] = held[k];
    else throw new Error(`rivals patch: "${k}" is neither held nor sent`);
  }
  // Competitors, by id, in the server's order.
  const byId = new Map((held.competitors ?? []).map((c) => [c?.id, c]));
  for (const c of patch.comps?.put ?? []) byId.set(c.id, c);
  const ids = patch.comps?.order ?? (held.competitors ?? []).map((c) => c?.id);
  out.competitors = ids.map((id) => {
    if (!byId.has(id)) throw new Error(`rivals patch: no competitor ${id}`);
    return byId.get(id);
  });
  // Contested pairs, in the server's order.
  const was = held.humanRivals ?? {};
  const put = patch.pairs?.put ?? {};
  const pairKeys = patch.pairs?.keys ?? Object.keys(was);
  const hr = {};
  for (const k of pairKeys) {
    if (k in put) hr[k] = put[k];
    else if (k in was) hr[k] = was[k];
    else throw new Error(`rivals patch: no pair ${k}`);
  }
  out.humanRivals = hr;
  if (!keys.includes('competitors')) delete out.competitors;
  if (!keys.includes('humanRivals')) delete out.humanRivals;
  return out;
}
