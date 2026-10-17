// ─────────────────────────────────────────────────────────────────────────────
// TROPHY BANK — admin-made trophies with their own artwork, awarded by hand
//
// Dave, 2026-10-17, for the first Discord event world: "Me to clearly be able
// to see a ranking list at the end of the game so I can assign trophies… I
// need a trophy bank to be able to store trophy images". So trophies are NOT
// derived from results the way career badges are: an admin makes one (name,
// artwork, description), then hands it to whoever they choose — usually from
// an event world's final ranking (routes/trophies.mjs), but any account will
// do. The award snapshots where it was won, so it outlives the world.
//
// Cosmetic only. Nothing in a world, the tick or the engine reads a trophy,
// which keeps it on the right side of the no-pay-to-win line on
// Account.isSupporter and of "every rival is on identical terms".
//
// `prisma` is passed in (no db import) so tools/event-worlds-test.mjs can
// drive every rule with a fake.
// ─────────────────────────────────────────────────────────────────────────────
import { createHash } from 'node:crypto';

export const TROPHY_NAME_MAX = 60;
export const TROPHY_DESCRIPTION_MAX = 280;
export const TROPHY_NOTE_MAX = 120;
// Raw image bytes. The admin form scales artwork down to 512 px before upload,
// so a real trophy is a few tens of kB; this is the ceiling, not the target.
export const TROPHY_IMAGE_MAX_BYTES = 750_000;
// Route body limit: the base64 data URL is ~4/3 of the bytes, plus the fields.
export const TROPHY_BODY_LIMIT = 1_200_000;
// 3D models (binary glTF). Uploaded raw, not base64. A model is fetched once per
// browser (immutable cache) and only when someone opens it, but it lives in
// Postgres, so the ceiling is deliberately modest: 2048-px textures are what
// make a trophy heavy, and 1024 px looks identical at trophy-case size.
export const TROPHY_MODEL_MAX_BYTES = 10_000_000;

function httpError(statusCode, message) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}

// Raster formats only, identified by their MAGIC BYTES rather than the label
// the client put on the data URL. No SVG: it is a document that can carry
// script, and these bytes are served from the API's own origin.
const SNIFF = [
  { type: 'image/png',  test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { type: 'image/jpeg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/gif',  test: (b) => b.length > 6 && b.toString('ascii', 0, 4) === 'GIF8' },
  { type: 'image/webp', test: (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
];

/** data URL → { bytes, contentType, hash }, or a 400 explaining why not. */
export function decodeTrophyImage(dataUrl) {
  if (typeof dataUrl !== 'string') throw httpError(400, 'The trophy image must be an uploaded picture');
  const m = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl.trim());
  if (!m) throw httpError(400, 'The trophy image must be an uploaded picture');
  const bytes = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
  if (bytes.length === 0) throw httpError(400, 'The trophy image is empty');
  if (bytes.length > TROPHY_IMAGE_MAX_BYTES) {
    throw httpError(413, `The trophy image is ${Math.round(bytes.length / 1000)} kB — keep it under ${Math.round(TROPHY_IMAGE_MAX_BYTES / 1000)} kB`);
  }
  const kind = SNIFF.find((k) => k.test(bytes));
  if (!kind) throw httpError(400, 'Use a PNG, JPEG, GIF or WebP image for the trophy');
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  return { bytes, contentType: kind.type, hash };
}

const cleanText = (v, max, label, { required = false } = {}) => {
  if (v == null || v === '') {
    if (required) throw httpError(400, `${label} is required`);
    return null;
  }
  if (typeof v !== 'string') throw httpError(400, `${label} must be text`);
  const t = v.trim();
  if (required && !t) throw httpError(400, `${label} is required`);
  if (t.length > max) throw httpError(400, `${label} must be at most ${max} characters`);
  return t || null;
};

/**
 * Check an uploaded .glb: the 12-byte glTF 2.0 header must say "glTF", version
 * 2, and a total length equal to what arrived, and the first chunk must be the
 * JSON chunk. Returns { bytes, hash, size } or throws a 400/413.
 */
export function validateTrophyModel(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw httpError(400, 'No 3D model received');
  if (buf.length > TROPHY_MODEL_MAX_BYTES) {
    throw httpError(413, `The model is ${(buf.length / 1e6).toFixed(1)} MB — keep it under ${TROPHY_MODEL_MAX_BYTES / 1e6} MB (shrinking its textures to 1024 px usually does it)`);
  }
  if (buf.length < 20 || buf.toString('ascii', 0, 4) !== 'glTF') {
    throw httpError(400, 'That is not a .glb file — export the model as binary glTF (.glb)');
  }
  const version = buf.readUInt32LE(4), length = buf.readUInt32LE(8);
  if (version !== 2) throw httpError(400, `glTF version ${version} is not supported — export as glTF 2.0`);
  if (length !== buf.length) throw httpError(400, 'The .glb file is incomplete or damaged');
  if (buf.toString('ascii', 16, 20) !== 'JSON') throw httpError(400, 'The .glb file is damaged (no JSON chunk)');
  const hash = createHash('sha256').update(buf).digest('hex').slice(0, 12);
  return { bytes: buf, hash, size: buf.length };
}

export const trophyModelUrl = (t) => (t?.modelHash ? `/trophies/${t.id}/model?v=${t.modelHash}` : null);

/** Where the artwork is served, cache-keyed on its hash. Null when there is none. */
export function trophyImageUrl(t) {
  return t?.imageHash ? `/trophies/${t.id}/image?v=${t.imageHash}` : null;
}

/** A bank entry for the admin screen — never the bytes. */
export function serializeTrophy(t) {
  return {
    id: t.id,
    name: t.name,
    description: t.description ?? null,
    imageUrl: trophyImageUrl(t),
    modelUrl: trophyModelUrl(t),
    modelSize: t.modelSize ?? null,
    createdAt: t.createdAt ?? null,
    awardCount: t._count?.awards ?? undefined,
  };
}

/** One awarded trophy as a trophy case shows it. */
export function serializeAward(a) {
  return {
    id: a.id,
    trophyId: a.trophyId,
    name: a.trophy?.name ?? null,
    description: a.trophy?.description ?? null,
    imageUrl: a.trophy ? trophyImageUrl({ id: a.trophyId, imageHash: a.trophy.imageHash }) : null,
    modelUrl: a.trophy ? trophyModelUrl({ id: a.trophyId, modelHash: a.trophy.modelHash }) : null,
    worldId: a.worldId ?? null,
    worldName: a.worldName ?? null,
    airlineName: a.airlineName ?? null,
    place: a.place ?? null,
    note: a.note ?? null,
    awardedAt: a.awardedAt ?? null,
  };
}

// Never select the bytes for a list.
export const TROPHY_META_SELECT = {
  id: true, name: true, description: true, imageHash: true, imageType: true,
  modelHash: true, modelSize: true, createdAt: true,
};

/** Attach (or replace) a trophy's 3D model. */
export async function setTrophyModel(prisma, id, buf) {
  const m = validateTrophyModel(buf);
  const exists = await prisma.trophy.findUnique({ where: { id }, select: { id: true } });
  if (!exists) throw httpError(404, 'No such trophy');
  return prisma.trophy.update({
    where: { id },
    data: { model: m.bytes, modelHash: m.hash, modelSize: m.size },
    select: TROPHY_META_SELECT,
  });
}

export async function clearTrophyModel(prisma, id) {
  return prisma.trophy.update({
    where: { id },
    data: { model: null, modelHash: null, modelSize: null },
    select: TROPHY_META_SELECT,
  });
}

export async function createTrophy(prisma, { name, description, image } = {}, { adminEmail = null } = {}) {
  const data = {
    name: cleanText(name, TROPHY_NAME_MAX, 'A trophy name', { required: true }),
    description: cleanText(description, TROPHY_DESCRIPTION_MAX, 'The description'),
    createdByEmail: adminEmail,
  };
  if (image != null && image !== '') {
    const img = decodeTrophyImage(image);
    Object.assign(data, { image: img.bytes, imageType: img.contentType, imageHash: img.hash });
  }
  return prisma.trophy.create({ data, select: TROPHY_META_SELECT });
}

export async function updateTrophy(prisma, id, { name, description, image } = {}) {
  const data = {};
  if (name !== undefined) data.name = cleanText(name, TROPHY_NAME_MAX, 'A trophy name', { required: true });
  if (description !== undefined) data.description = cleanText(description, TROPHY_DESCRIPTION_MAX, 'The description');
  if (image !== undefined) {
    if (image === null || image === '') Object.assign(data, { image: null, imageType: null, imageHash: null });
    else {
      const img = decodeTrophyImage(image);
      Object.assign(data, { image: img.bytes, imageType: img.contentType, imageHash: img.hash });
    }
  }
  const exists = await prisma.trophy.findUnique({ where: { id }, select: { id: true } });
  if (!exists) throw httpError(404, 'No such trophy');
  return prisma.trophy.update({ where: { id }, data, select: TROPHY_META_SELECT });
}

/** A trophy that has been handed out cannot be deleted — revoke its awards first. */
export async function deleteTrophy(prisma, id) {
  const awarded = await prisma.trophyAward.count({ where: { trophyId: id } });
  if (awarded > 0) throw httpError(409, `This trophy has been awarded ${awarded} time${awarded === 1 ? '' : 's'} — revoke those first`);
  await prisma.trophy.delete({ where: { id } });
}

/**
 * Hand a trophy to an account. With `worldId`, the world's name and the
 * account's airline name there are snapshotted onto the award, so it still
 * reads "Discord Cup · Cup Air" after the world is deleted. The same trophy
 * cannot go to the same account twice for the same world.
 */
export async function awardTrophy(prisma, { trophyId, accountId, worldId = null, place = null, note = null } = {}, { adminEmail = null } = {}) {
  if (!trophyId || !accountId) throw httpError(400, 'Pick a trophy and a player');
  if (place != null && (!Number.isInteger(place) || place < 1 || place > 1000)) throw httpError(400, 'place must be a whole number from 1');
  const trophy = await prisma.trophy.findUnique({ where: { id: trophyId }, select: { id: true } });
  if (!trophy) throw httpError(404, 'No such trophy');
  const account = await prisma.account.findUnique({ where: { id: accountId }, select: { id: true } });
  if (!account) throw httpError(404, 'No such player');

  let worldName = null, airlineName = null;
  if (worldId) {
    const world = await prisma.world.findUnique({ where: { id: worldId }, select: { id: true, name: true, tickConfig: true } });
    if (!world) throw httpError(404, 'No such world');
    worldName = (typeof world.tickConfig?.event?.name === 'string' && world.tickConfig.event.name.trim()) || world.name;
    const airline = await prisma.airline.findUnique({
      where: { worldId_accountId: { worldId, accountId } },
      select: { name: true },
    });
    airlineName = airline?.name ?? null;
    const dup = await prisma.trophyAward.findFirst({ where: { trophyId, accountId, worldId }, select: { id: true } });
    if (dup) throw httpError(409, 'That player already has this trophy for this world');
  }

  const award = await prisma.trophyAward.create({
    data: {
      trophyId, accountId, worldId: worldId || null, worldName, airlineName,
      place: place ?? null,
      note: cleanText(note, TROPHY_NOTE_MAX, 'The note'),
      awardedByEmail: adminEmail,
    },
    include: { trophy: { select: TROPHY_META_SELECT } },
  });
  return award;
}

/** Everything an account has been awarded, newest first — the public trophy case. */
export async function awardsForAccount(prisma, accountId) {
  const rows = await prisma.trophyAward.findMany({
    where: { accountId },
    orderBy: { awardedAt: 'desc' },
    include: { trophy: { select: TROPHY_META_SELECT } },
  });
  return rows.map(serializeAward);
}
