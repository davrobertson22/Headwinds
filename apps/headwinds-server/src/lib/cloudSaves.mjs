// Tailwinds cloud saves — a supporter perk, served from the Headwinds API.
//
// A Tailwinds (single-player) player signs in with their Headwinds account —
// the same Supabase login, so the bearer token is verified by auth.mjs exactly
// as every Headwinds request is — and keeps up to CLOUD_SLOTS airlines in the
// cloud, so the airline follows them between browsers and devices.
//
// It is a GOODWILL perk, not a product (Dave, 2026-10-14; full design in the
// Tailwinds repo, docs/cloud-save-design.md). The rules that follow from that:
//
//   • Account.isSupporter gates UPLOAD and nothing else. Listing, loading and
//     deleting work for any signed-in account, so a lapsed supporter keeps
//     every airline they put here. Taking an airline away because a tip stopped
//     would turn a thank-you into a hostage.
//   • A stale upload is refused with 409 and the slot's current version —
//     never last-write-wins. The client shows both and the player chooses.
//   • Uploads are validated by the Tailwinds importer's own decoder
//     (twsaveFile.mjs is a copy), then stored byte-for-byte. Nothing inside a
//     save is read beyond the slot-card summary, and nothing is ever granted:
//     like the badge, this never touches a game.
//   • The slot list never carries the bytes.
//
// Everything is injected (store, authenticate, allow, now) so the suite can
// drive the real routes through fastify.inject without a database:
// tools/tailwinds-cloud-saves-test.mjs. routes/tailwindsSaves.mjs wires the
// real ones.
import { decodeSaveFile, SAVE_FILE_VERSION } from './twsaveFile.mjs';
import { allow as defaultAllow } from './rateLimit.mjs';

export const CLOUD_SLOTS = 3;
/** Compressed upload ceiling. A late-game .twsave is ~60–100 KB. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
/** Decompressed ceiling while validating — far above any real save, far below a tab-killer. */
export const MAX_DECODED_BYTES = 16 * 1024 * 1024;
// Both windows sit inside rateLimit.mjs's 5-minute idle sweep. A longer window
// would be silently reset by that sweep after five quiet minutes.
export const UPLOAD_RATE_LIMIT = { count: 12, windowMs: 5 * 60_000 };
export const READ_RATE_LIMIT   = { count: 120, windowMs: 5 * 60_000 };
/** A custom logo bigger than this is left out of the slot card's summary. */
const MAX_META_LOGO_CHARS = 300_000;

export const NOT_SUPPORTER_MESSAGE =
  'Uploading to the cloud is a thank-you for supporters. Any cloud saves you already have stay yours to load.';

const httpError = (statusCode, message, appCode) =>
  Object.assign(new Error(message), { statusCode, ...(appCode ? { appCode } : {}) });

// ── Stores ────────────────────────────────────────────────────────────────────
//
// Contract, shared by both stores:
//   list(accountId)                    → summaries (no bytes), ordered by slot
//   read(accountId, slot)              → full row (with bytes) or null
//   write(accountId, slot, base, data) → { ok: true, row } | { ok: false, current }
//        base === null  : the slot must be EMPTY
//        base is a Date : the slot's uploadedAt must EQUAL base
//        `current` is the slot's summary at refusal time (null if empty)
//   remove(accountId, slot)            → void
// The conditional write is the conflict rule; it must be atomic in the store.

const SUMMARY_FIELDS = ['slot', 'fileVersion', 'meta', 'size', 'savedAt', 'uploadedAt', 'deviceLabel'];
const summaryOf = (r) => (r ? Object.fromEntries(SUMMARY_FIELDS.map((k) => [k, r[k]])) : null);

export function memoryCloudSaveStore() {
  const rows = new Map();
  const key = (a, s) => `${a}\u0000${s}`;
  return {
    async list(accountId) {
      return [...rows.values()].filter((r) => r.accountId === accountId)
        .sort((a, b) => a.slot - b.slot).map(summaryOf);
    },
    async read(accountId, slot) { return rows.get(key(accountId, slot)) ?? null; },
    async write(accountId, slot, base, data) {
      const k = key(accountId, slot);
      const existing = rows.get(k) ?? null;
      const fits = base === null ? existing === null : existing !== null && existing.uploadedAt.getTime() === base.getTime();
      if (!fits) return { ok: false, current: summaryOf(existing) };
      const row = { accountId, slot, ...data };
      rows.set(k, row);
      return { ok: true, row: summaryOf(row) };
    },
    async remove(accountId, slot) { rows.delete(key(accountId, slot)); },
  };
}

export function prismaCloudSaveStore(prisma) {
  const table = prisma.tailwindsCloudSave;
  const select = Object.fromEntries(SUMMARY_FIELDS.map((k) => [k, true]));
  const summary = (accountId, slot) =>
    table.findUnique({ where: { accountId_slot: { accountId, slot } }, select });
  return {
    list: (accountId) => table.findMany({ where: { accountId }, select, orderBy: { slot: 'asc' } }),
    read: (accountId, slot) => table.findUnique({ where: { accountId_slot: { accountId, slot } } }),
    async write(accountId, slot, base, data) {
      if (base === null) {
        // Create-if-absent. The unique (accountId, slot) index makes this
        // atomic: a concurrent create loses with P2002 and reads as a conflict.
        try {
          return { ok: true, row: await table.create({ data: { accountId, slot, ...data }, select }) };
        } catch (err) {
          if (err?.code === 'P2002') return { ok: false, current: await summary(accountId, slot) };
          throw err;
        }
      }
      // Compare-and-swap on uploadedAt, in one statement.
      const { count } = await table.updateMany({ where: { accountId, slot, uploadedAt: base }, data });
      const current = await summary(accountId, slot);
      return count === 1 ? { ok: true, row: current } : { ok: false, current };
    },
    async remove(accountId, slot) { await table.deleteMany({ where: { accountId, slot } }); },
  };
}

// ── Request helpers ───────────────────────────────────────────────────────────

function slotParam(raw) {
  if (!/^(0|[1-9]\d*)$/.test(String(raw ?? '')) || Number(raw) >= CLOUD_SLOTS) {
    throw httpError(400, `There are ${CLOUD_SLOTS} cloud slots, numbered 0 to ${CLOUD_SLOTS - 1}.`);
  }
  return Number(raw);
}

/** `x-tw-base-upload`: "none" for an empty slot, else the uploadedAt the client last saw. */
function baseParam(raw) {
  if (raw === 'none') return null;
  const t = typeof raw === 'string' ? Date.parse(raw) : NaN;
  if (!Number.isFinite(t)) {
    throw httpError(400, 'Say which version of the slot this upload replaces (x-tw-base-upload: "none" or the slot\'s uploadedAt).');
  }
  return new Date(t);
}

function cleanDeviceLabel(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/[<>\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60).trim();
  return s || null;
}

function cardMeta(meta) {
  const m = { ...meta };
  if (typeof m.customLogo === 'string' && m.customLogo.length > MAX_META_LOGO_CHARS) m.customLogo = null;
  return m;
}

export function serializeSlot(r) {
  if (!r) return null;
  const iso = (d) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());
  return {
    slot: r.slot,
    meta: r.meta,
    size: r.size,
    savedAt: iso(r.savedAt),
    uploadedAt: iso(r.uploadedAt),
    deviceLabel: r.deviceLabel ?? null,
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * @param {{ store, authenticate: (request) => Promise<void>, allow?, now?: () => Date }} deps
 * @returns a Fastify plugin (encapsulated: its octet-stream parser stays local)
 */
export function cloudSaveRoutes({ store, authenticate, allow = defaultAllow, now = () => new Date() }) {
  const limit = (account, kind, { count, windowMs }) => {
    if (!allow(`tw-saves-${kind}:${account.id}`, count, windowMs)) {
      throw httpError(429, 'Too many cloud-save requests. Wait a minute and try again.');
    }
  };

  return async function tailwindsCloudSaves(fastify) {
    fastify.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES },
      (request, body, done) => done(null, body),
    );

    // The three slots, summarised, plus whether this account may upload.
    fastify.get('/tw/saves', { preHandler: authenticate }, async (request) => {
      const account = request.account;
      limit(account, 'read', READ_RATE_LIMIT);
      const rows = await store.list(account.id);
      const slots = Array.from({ length: CLOUD_SLOTS }, (_, i) => serializeSlot(rows.find((r) => r.slot === i)));
      return { supporter: Boolean(account.isSupporter), maxSlots: CLOUD_SLOTS, maxUploadBytes: MAX_UPLOAD_BYTES, slots };
    });

    // The .twsave itself. Already gzip, so the global compressor stays out of it.
    fastify.get('/tw/saves/:slot', { preHandler: authenticate, compress: false }, async (request, reply) => {
      const account = request.account;
      const slot = slotParam(request.params.slot);
      limit(account, 'read', READ_RATE_LIMIT);
      const row = await store.read(account.id, slot);
      if (!row) throw httpError(404, 'That cloud slot is empty.');
      return reply
        .header('content-type', 'application/octet-stream')
        .header('cache-control', 'no-store')
        .send(Buffer.from(row.bytes));
    });

    // Upload. Supporters only — the one thing the perk gates.
    fastify.put('/tw/saves/:slot', { preHandler: authenticate }, async (request, reply) => {
      const account = request.account;
      const slot = slotParam(request.params.slot);
      if (!account.isSupporter) throw httpError(403, NOT_SUPPORTER_MESSAGE, 'NOT_SUPPORTER');
      limit(account, 'write', UPLOAD_RATE_LIMIT);
      const body = request.body;
      if (!Buffer.isBuffer(body)) throw httpError(415, 'Send the save file as application/octet-stream.');
      const base = baseParam(request.headers['x-tw-base-upload']);

      const decoded = await decodeSaveFile(body, { maxBytes: MAX_DECODED_BYTES });
      if (!decoded.ok) throw httpError(422, decoded.message, 'INVALID_SAVE');

      const at = now();
      const result = await store.write(account.id, slot, base, {
        fileVersion: SAVE_FILE_VERSION,
        meta: cardMeta(decoded.meta),
        bytes: body,
        size: body.length,
        savedAt: new Date(decoded.exportedAt ?? at.getTime()),
        uploadedAt: at,
        deviceLabel: cleanDeviceLabel(request.headers['x-tw-device']),
      });
      if (!result.ok) {
        return reply.code(409).send({
          error: 'This cloud slot changed since you last looked, probably from another device.',
          code: 'CLOUD_SLOT_CHANGED',
          current: serializeSlot(result.current),
        });
      }
      return { slot: serializeSlot(result.row) };
    });

    // Delete. Any account — a lapsed supporter can still tidy up.
    fastify.delete('/tw/saves/:slot', { preHandler: authenticate }, async (request, reply) => {
      const account = request.account;
      const slot = slotParam(request.params.slot);
      limit(account, 'write', UPLOAD_RATE_LIMIT);
      await store.remove(account.id, slot);
      return reply.code(204).send();
    });
  };
}
