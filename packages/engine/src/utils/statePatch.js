/**
 * What one action changed in a game state, small enough to send.
 *
 * A decision used to be answered with the airline's whole state: 19–22 MB of
 * JSON for the largest airlines, serialised, compressed, downloaded and parsed
 * on every click, when a fare change alters one route (measured 2026-11-11:
 * 111 ms to serialise and 202 ms to compress on the server, 76 ms to parse in
 * the browser; `lastReport` alone is 12.6 MB and only changes at a tick).
 *
 * The reducer never edits in place: a key it did not touch is the SAME object
 * in the state it returns, and so is a row it did not touch in a table it did.
 * So the difference is found by identity, without reading either state:
 *
 *   set   top-level keys whose value is a different object (or a new key)
 *   drop  top-level keys that are gone
 *   rows  for a long table where only some rows are different objects: those
 *         rows by position, and the table's new length (rows appended at the
 *         end ride along; a table that lost or reordered rows is sent whole
 *         under `set`)
 *   maps  for a large keyed table (fares by city pair, say) where only some
 *         entries are different objects: those entries, and the keys removed
 *
 * applyStatePatch(before, patch) is then `after`, value for value, for anyone
 * holding a state equal to `before`. Both ends must hold the same `before`:
 * the server only answers with a patch when the caller names the version it
 * has, and it is the version the action was applied to.
 */
const ROWS_MIN_LENGTH = 24;        // shorter tables are sent whole
const ROWS_MAX_SHARE = 0.25;       // …and so is a table with more than a quarter of its rows changed

export function diffState(before, after, { skip = null } = {}) {
  const patch = { set: {}, drop: [], rows: {}, maps: {} };
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') {
    return { set: { ...(after ?? {}) }, drop: [], rows: {}, maps: {} };
  }
  for (const k of Object.keys(after)) {
    if (skip?.has(k)) continue;
    const a = before[k], b = after[k];
    if (a === b) continue;
    if (b === undefined) { if (a !== undefined) patch.drop.push(k); continue; }
    const rows = rowsChanged(a, b);
    if (rows) { patch.rows[k] = rows; continue; }
    const entries = entriesChanged(a, b);
    if (entries) patch.maps[k] = entries; else patch.set[k] = b;
  }
  for (const k of Object.keys(before)) {
    if (skip?.has(k)) continue;
    if (!(k in after) && before[k] !== undefined) patch.drop.push(k);
  }
  return patch;
}

function rowsChanged(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return null;
  if (b.length < a.length || a.length < ROWS_MIN_LENGTH) return null;
  const at = [];
  const limit = Math.max(8, Math.floor(a.length * ROWS_MAX_SHARE));
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) { at.push([i, b[i]]); if (at.length > limit) return null; }
  }
  for (let i = a.length; i < b.length; i++) at.push([i, b[i]]);
  if (at.length > limit + (b.length - a.length)) return null;
  return { len: b.length, at };
}

const isPlain = (x) => x !== null && typeof x === 'object' && !Array.isArray(x)
  && (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null);

function entriesChanged(a, b) {
  if (!isPlain(a) || !isPlain(b)) return null;
  const keysA = Object.keys(a), keysB = Object.keys(b);
  if (keysA.length < ROWS_MIN_LENGTH) return null;
  const limit = Math.max(8, Math.floor(keysA.length * ROWS_MAX_SHARE));
  const put = {}; const del = []; let n = 0;
  for (const k of keysB) {
    if (a[k] !== b[k] || !(k in a)) {
      if (b[k] === undefined) { if (a[k] !== undefined) { del.push(k); n++; } continue; }
      put[k] = b[k]; if (++n > limit) return null;
    }
  }
  for (const k of keysA) if (!(k in b) && a[k] !== undefined) { del.push(k); if (++n > limit) return null; }
  return { put, del };
}

/** True when the patch changes nothing. */
export function isEmptyPatch(patch) {
  return !patch || (Object.keys(patch.set ?? {}).length === 0 && (patch.drop ?? []).length === 0
    && Object.keys(patch.rows ?? {}).length === 0 && Object.keys(patch.maps ?? {}).length === 0);
}

/**
 * `before` with the patch applied: a new state object sharing everything the
 * patch does not mention. Throws when the patch cannot belong to this state (a
 * table it patches by row is missing or too short) — the caller's state is not
 * the one the patch was cut from, and it should fetch the whole state instead.
 */
export function applyStatePatch(before, patch) {
  const out = { ...(before ?? {}) };
  for (const k of patch?.drop ?? []) delete out[k];
  for (const [k, v] of Object.entries(patch?.set ?? {})) out[k] = v;
  for (const [k, rows] of Object.entries(patch?.rows ?? {})) {
    const old = before?.[k];
    if (!Array.isArray(old) || !rows || !Array.isArray(rows.at) || !(rows.len >= 0)) throw new Error(`state patch: no table to patch at "${k}"`);
    const table = old.slice(0, rows.len);
    for (const [i, row] of rows.at) {
      if (!(i >= 0 && i < rows.len)) throw new Error(`state patch: row ${i} is outside "${k}"`);
      table[i] = row;
    }
    for (let i = 0; i < rows.len; i++) if (!(i in table)) throw new Error(`state patch: "${k}" is shorter here than where the patch was cut`);
    out[k] = table;
  }
  for (const [k, entries] of Object.entries(patch?.maps ?? {})) {
    const old = before?.[k];
    if (!isPlain(old) || !entries) throw new Error(`state patch: no keyed table to patch at "${k}"`);
    const table = { ...old };
    for (const key of entries.del ?? []) delete table[key];
    for (const [key, v] of Object.entries(entries.put ?? {})) table[key] = v;
    out[k] = table;
  }
  return out;
}
