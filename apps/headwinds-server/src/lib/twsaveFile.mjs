// ─────────────────────────────────────────────────────────────────────────────
// COPY of Tailwinds `src/store/saveFile.js` (Airline Management Game repo),
// for validating cloud-save uploads (lib/cloudSaves.mjs). The server must
// accept exactly what the Tailwinds client writes and refuse exactly what its
// importer refuses, so this is the same code, not a re-implementation.
// Differences from the original, and nothing else:
//   • metaFromState is inlined (Tailwinds imports it from saveStore.js);
//   • the browser-only downloadSaveFile is dropped.
// Change the Tailwinds file first, then re-copy. tools/tailwinds-cloud-saves-test.mjs
// pins the format constants so a silent divergence fails there.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Save files — a Tailwinds airline as a file the player owns.
 *
 * WHY THIS EXISTS
 * ───────────────
 * Every save lives in one browser profile on one machine (see saveStore.js).
 * Clearing site data, switching browser or device, or Safari's 7-day eviction
 * of script-written storage all lose the airline, and nothing local can fix
 * that. A file the player downloads is the one copy that survives our mistakes
 * and the browser's — docs/save-storage-indexeddb-plan.md §6 Phase 4.
 *
 * It is also the unit the planned supporter cloud sync uploads
 * (docs/cloud-save-design.md): a cloud save IS a .twsave, byte for byte, so
 * there is one format, one validator, and anything that downloads from the
 * cloud can be imported by the same button.
 *
 * FORMAT
 * ──────
 *   gzip( UTF-8 JSON { format: 'tailwinds-save', version, exportedAt, meta, state } )
 *
 * Compressed because a late-game state is ~600 KB of JSON and gzips ~10x. The
 * reader sniffs the gzip magic bytes rather than trusting the extension, so a
 * browser without CompressionStream can still write a plain-JSON .twsave and
 * every build can read it. It also accepts the two LEGACY localStorage shapes —
 * a bare state (the autosave) and a flat slot record with `gameState` — because
 * players have copied those out of devtools to rescue an airline, and the cost
 * of saying yes is three lines.
 *
 * WHAT THE READER PROMISES
 * ────────────────────────
 * decodeSaveFile never throws. It resolves `{ ok: true, state, meta, exportedAt }`
 * or `{ ok: false, reason, message }`, where `message` is written for the player.
 * Nothing it reads is trusted beyond "is this shaped like an airline" — the
 * reducer's LOAD_STATE (reconcileState) is what repairs and migrates a save, for
 * a file exactly as for a slot.
 *
 * Decompression is capped (MAX_SAVE_FILE_BYTES), streaming, so a hostile or
 * corrupt file cannot inflate into a tab-killing allocation.
 */
// metaFromState — copied from Tailwinds src/store/saveStore.js, where the
// Save/Load slot cards read exactly these fields.
export function metaFromState(state) {
  return {
    airlineName: state?.airlineName,
    logoId:      state?.logoId,
    logoColor:   state?.logoColor,
    customLogo:  state?.customLogo ?? null,
    hub:         state?.hub,
    cash:        state?.cash,
    week:        state?.week,
    year:        state?.year,
    startYear:   state?.startYear,
  };
}

export const SAVE_FILE_FORMAT  = 'tailwinds-save';
export const SAVE_FILE_VERSION = 1;
export const SAVE_FILE_EXT     = '.twsave';

/** Decompressed ceiling. The biggest save measured is under 1 MB; this is ~60x that. */
export const MAX_SAVE_FILE_BYTES = 64 * 1024 * 1024;

const MSG = {
  empty:     'That file is empty — the download may not have finished. Try exporting the save again.',
  tooBig:    'That file is far bigger than any Tailwinds save, so it was not opened.',
  damaged:   'That file could not be read — it may be damaged or incomplete. If you downloaded it, try exporting it again.',
  notASave:  'That file is not a Tailwinds save. Save files end in .twsave and come from Export in the Save / Load window.',
  newer:     'That save was made by a newer version of Tailwinds than this page. Reload the page to update, then import it again.',
  noGunzip:  'This browser cannot open compressed save files. Updating it, or importing in Chrome, Edge, Firefox or Safari 16.4+, will work.',
};

const fail = (reason) => ({ ok: false, reason, message: MSG[reason] });

// ── Shape checks ──────────────────────────────────────────────────────────────

/**
 * Is this plausibly a Tailwinds game state with an airline in it?
 *
 * Deliberately loose: the reducer's reconcileState fills missing fields on any
 * save, so the bar here is "an airline was started", not "every field present".
 * A setup-phase state (no airline yet) is not worth importing and is refused.
 */
export function looksLikeGameState(s) {
  return !!s && typeof s === 'object' && !Array.isArray(s)
    && typeof s.airlineName === 'string' && s.airlineName.trim() !== ''
    && Array.isArray(s.fleet)
    && Array.isArray(s.routes)
    && Number.isFinite(s.week)
    && Number.isFinite(s.year)
    && Number.isFinite(s.cash)
    && s.phase !== 'setup';
}

// ── Bytes helpers ─────────────────────────────────────────────────────────────

function isGzip(bytes) {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

async function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (input && typeof input.arrayBuffer === 'function') return new Uint8Array(await input.arrayBuffer());
  if (typeof input === 'string') return new TextEncoder().encode(input);
  return null;
}

/** Read a stream to the end, refusing to buffer more than `maxBytes`. */
async function readCapped(stream, maxBytes) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* already errored */ }
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

async function gzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ── Encode ────────────────────────────────────────────────────────────────────

/** The envelope written to disk, before compression. */
export function buildSaveEnvelope(state, exportedAt = Date.now()) {
  return {
    format: SAVE_FILE_FORMAT,
    version: SAVE_FILE_VERSION,
    exportedAt,
    meta: metaFromState(state),
    state,
  };
}

/**
 * The bytes of a .twsave for this state. Gzipped where the browser can;
 * plain JSON otherwise, which every reader also accepts.
 *
 * @returns {Promise<Uint8Array>}
 */
export async function encodeSaveFile(state, { exportedAt = Date.now(), compress = true } = {}) {
  const json = JSON.stringify(buildSaveEnvelope(state, exportedAt));
  const bytes = new TextEncoder().encode(json);
  if (!compress || typeof CompressionStream === 'undefined') return bytes;
  try { return await gzip(bytes); } catch { return bytes; }
}

// ── Decode ────────────────────────────────────────────────────────────────────

/**
 * Read a .twsave (or a legacy JSON save) back into a game state.
 *
 * @param {File|Blob|ArrayBuffer|Uint8Array|string} input
 * @returns {Promise<{ok: true, state, meta, exportedAt: number|null}
 *                 | {ok: false, reason: string, message: string}>}
 */
export async function decodeSaveFile(input, { maxBytes = MAX_SAVE_FILE_BYTES } = {}) {
  let bytes;
  try { bytes = await toBytes(input); } catch { return fail('damaged'); }
  if (!bytes) return fail('notASave');
  if (bytes.length === 0) return fail('empty');
  if (bytes.length > maxBytes) return fail('tooBig');

  if (isGzip(bytes)) {
    if (typeof DecompressionStream === 'undefined') return fail('noGunzip');
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      bytes = await readCapped(stream, maxBytes);
    } catch {
      return fail('damaged');          // truncated or corrupt gzip
    }
    if (!bytes) return fail('tooBig');
    if (bytes.length === 0) return fail('empty');
  }

  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return fail('notASave'); }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);   // BOM from a text editor

  let parsed;
  try { parsed = JSON.parse(text); } catch {
    // Starts like JSON but does not parse: a cut-off file. Anything else is not ours.
    return /^\s*[{[]/.test(text) ? fail('damaged') : fail('notASave');
  }
  if (!parsed || typeof parsed !== 'object') return fail('notASave');

  let state, exportedAt = null;
  if (parsed.format === SAVE_FILE_FORMAT) {
    if (!Number.isInteger(parsed.version) || parsed.version < 1) return fail('damaged');
    if (parsed.version > SAVE_FILE_VERSION) return fail('newer');
    state = parsed.state;
    exportedAt = Number.isFinite(parsed.exportedAt) ? parsed.exportedAt : null;
  } else if (parsed.format !== undefined) {
    return fail('notASave');           // someone else's file format
  } else if (looksLikeGameState(parsed)) {
    state = parsed;                    // legacy autosave: the bare state
  } else if (looksLikeGameState(parsed.gameState)) {
    state = parsed.gameState;          // legacy slot record
    exportedAt = Number.isFinite(parsed.savedAt) ? parsed.savedAt : null;
  } else {
    return fail('notASave');
  }

  if (!looksLikeGameState(state)) return fail(parsed.format === SAVE_FILE_FORMAT ? 'damaged' : 'notASave');
  return { ok: true, state, meta: metaFromState(state), exportedAt };
}

// ── Naming and download ───────────────────────────────────────────────────────

/** "1991 wk 12" for an era game, "Year 3 wk 12" for a classic one. */
export function saveFileDateLabel(meta) {
  const y = Number.isInteger(meta?.startYear) && Number.isFinite(meta?.year)
    ? String(meta.startYear + meta.year - 1)
    : (Number.isFinite(meta?.year) ? `Year ${meta.year}` : '');
  const w = Number.isFinite(meta?.week) ? `wk ${meta.week}` : '';
  return [y, w].filter(Boolean).join(' ');
}

/** "Tailwinds - Probe Air - 1991 wk 12.twsave", safe on Windows, macOS and iOS. */
export function saveFileName(meta) {
  const clean = (s) => String(s ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const airline = clean(meta?.airlineName).slice(0, 60).trim();
  const parts = ['Tailwinds', airline, saveFileDateLabel(meta)].filter(Boolean);
  return parts.join(' - ') + SAVE_FILE_EXT;
}
