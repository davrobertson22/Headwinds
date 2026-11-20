// Airline."rivalState" written by the weekly tick itself (outage 2026-10-22).
//
// The column is the trimmed copy of `state` that loadRivalRows reads. A
// trigger (migration 20261022000000_airline_rival_state) fills it on every
// `state` write by running rival_state_of() inside Postgres, which costs
// ~0.15 s per MB of state. For a world's weekly commit that is every airline at
// once (Scarce Assets: ~10 s), inside the tick's transaction budget.
//
// The tick already has each airline's new state in memory, and
// projectRivalState() is the JS twin of rival_state_of(). So the tick:
//   1. beginAppRivalStates(tx)  marks its transaction (SET LOCAL), which makes
//      the trigger stand aside (migration 20261023000000_rival_state_app_writer);
//   2. writes its airline rows as before;
//   3. writeRivalStates(tx, map) sets "rivalState" for every row it wrote, in
//      ONE statement, from projectRivalState(persisted state).
// Writers that never call (1) keep the trigger: decisions, joins, fire sales.
//
// A prisma double without $queryRaw (the tick test harnesses) skips both: it
// has no trigger and no column to keep in step.
import { projectRivalState } from './humanRivals.mjs';

export const RIVAL_STATE_WRITER_SETTING = 'headwinds.rival_state_writer';

/** Mark this transaction as the writer of "rivalState". Returns whether it did. */
export async function beginAppRivalStates(tx) {
  if (typeof tx?.$queryRaw !== 'function') return false;
  // set_config(..., true) is SET LOCAL: it ends with this transaction.
  await tx.$queryRaw`SELECT set_config('headwinds.rival_state_writer', 'app', true)`;
  return true;
}

/** The value the trigger would have written for a persisted `state`. */
export const rivalStateFor = (persistedState) => projectRivalState(persistedState);

// Prisma's model writes serialize a Json column's numbers their own way
// (measured 2026-10-23, @prisma/client 6.19.3 + adapter-pg, ~32,000 values
// through prisma.airline.updateMany, compared as jsonb in Postgres):
//   - an integer inside the i64 range: as JavaScript prints it;
//   - otherwise, if the shortest round-trip form (what JavaScript prints)
//     has at most 16 significant digits: that form;
//   - otherwise the EXACT binary value rounded to 16 significant digits,
//     exact ties to even: 0.015063631343319494 -> 0.01506363134331949,
//     0.1 + 0.2 -> 0.3, -4.5734405517578125 (a true tie) -> -4.573440551757812,
//     0.0027553585171699525 (just above a tie) -> 0.002755358517169953.
// The stored `state` holds those values and rival_state_of(state) copies
// them, so "rivalState" must too. JSON.stringify keeps 17 digits and raw query
// parameters are not rounded, so the payload is built here. Only the numeric
// VALUE has to match: jsonb compares numbers as numerics ("1e21" = "1e+21").
const I64_LIMIT = 2 ** 63;
export function prismaJsonNumber(x) {
  if (!Number.isFinite(x)) return 'null';
  if (x === 0) return '0';
  if (Number.isInteger(x) && Math.abs(x) < I64_LIMIT) return String(x);
  const shortest = Math.abs(x).toExponential();
  if (shortest.split('e')[0].replace('.', '').length <= 16) return (x < 0 ? '-' : '') + shortest;
  // Exact decimal expansion (a double's terminates; 100 digits is enough to
  // tell a true tie at digit 17 from a near one).
  const [mant, expStr] = Math.abs(x).toExponential(99).split('e');
  let exp = Number(expStr);
  const digits = mant.replace('.', '');
  const head = digits.slice(0, 16);
  const r = digits[16];
  const up = r > '5' || (r === '5' && (/[1-9]/.test(digits.slice(17)) || Number(head[15]) % 2 === 1));
  let ds = (BigInt(head) + (up ? 1n : 0n)).toString();
  if (ds.length > 16) { ds = ds.slice(0, 16); exp += 1; }
  const out = ds.replace(/0+$/, '') || '0';
  const m = out.length > 1 ? `${out[0]}.${out.slice(1)}` : out;
  return `${x < 0 ? '-' : ''}${m}e${exp}`;
}

/** JSON text of `value` with numbers rounded as Prisma's Json writes round them. */
export function prismaJsonText(value) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'number': return prismaJsonNumber(value);
    case 'string': case 'boolean': return JSON.stringify(value);
    case 'bigint': return value.toString();
    case 'undefined': case 'function': case 'symbol': return undefined;
    default: break;
  }
  if (typeof value.toJSON === 'function') return prismaJsonText(value.toJSON());
  if (Array.isArray(value)) {
    return '[' + value.map((v) => prismaJsonText(v) ?? 'null').join(',') + ']';
  }
  const parts = [];
  for (const k of Object.keys(value)) {
    const v = prismaJsonText(value[k]);
    if (v !== undefined) parts.push(JSON.stringify(k) + ':' + v);
  }
  return '{' + parts.join(',') + '}';
}

/**
 * Write "rivalState" for each id in `byId` (Map id -> rival state, already
 * projected). One statement; returns the number of rows updated.
 */
export async function writeRivalStates(tx, byId) {
  if (typeof tx?.$queryRaw !== 'function' || !byId || byId.size === 0) return 0;
  const payload = prismaJsonText(Object.fromEntries(byId));
  const rows = await tx.$queryRaw`
    UPDATE "Airline" AS a
       SET "rivalState" = v.value
      FROM jsonb_each(${payload}::jsonb) AS v(key, value)
     WHERE a.id = v.key
    RETURNING a.id`;
  return Array.isArray(rows) ? rows.length : 0;
}
