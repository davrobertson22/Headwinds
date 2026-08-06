import { Glyph } from './Icons.jsx';
import { isReserve, reserveCoverageSummary } from '../data/reserve.js';

/**
 * ReserveNotice — "this plane is on reserve" warnings for every picker that can
 * deploy one.
 *
 * Five actions pull a tail off standby (ADD_ROUTE, ADD_TAG_ROUTE,
 * ADD_CARGO_ROUTE, TRANSFER_ROUTES, REASSIGN_ROUTE) and each one nulls
 * `reserveBase` without comment. The cover is bought weekly — parking plus a
 * readiness premium — so silently spending it on a new route is the kind of
 * thing a player only notices when a breakdown goes uncovered a month later.
 *
 * Deliberately NOT a confirmation dialog: deploying a reserve is a legitimate
 * move, so the answer is a label you cannot miss, not an extra click. The three
 * exports are the three places that label has to fit:
 *   - reserveOptionTag  → plain text, for <option> labels (no markup allowed)
 *   - ReserveBadge      → a chip, for list rows that render real elements
 *   - ReserveNotice     → the callout under a confirm button, with the cost
 *
 * All are pure and no-op on non-reserves, so callers can render unconditionally.
 */

/** Plain-text tag for <option> labels, where JSX cannot go. */
export function reserveOptionTag(a) {
  return isReserve(a) ? ` · 🛡 ON RESERVE @ ${a.reserveBase}` : '';
}

/** Suffix for the confirm button: names the consequence at the click site. */
export function reserveButtonTag(a) {
  return isReserve(a) ? ' · ends standby' : '';
}

/** Inline chip for rows that render markup (transfer modal, move menu). */
export function ReserveBadge({ aircraft, style }) {
  if (!isReserve(aircraft)) return null;
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 3,
        padding: '1px 7px', borderRadius: 999, whiteSpace: 'nowrap',
        fontSize: 10, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase',
        background: 'rgba(234,179,8,.14)', color: 'var(--yellow)',
        border: '1px solid rgba(234,179,8,.35)',
        ...style,
      }}
    >
      <Glyph e="🛡️" size={10} /> Reserve @ {aircraft.reserveBase}
    </span>
  );
}

/**
 * The callout. Quantifies the cover being spent rather than just naming it —
 * "stops covering your 3 other A320s there (7 routes)" is a decision; "ends
 * standby" is jargon. When nothing same-type flies the base, it says so: that
 * reserve was doing nothing, and deploying it is free.
 *
 * @param {object} aircraft - the reserve about to be deployed
 * @param {array}  fleet    - state.fleet
 * @param {array}  ops      - passenger + cargo routes
 * @param {string} action   - sentence-initial, e.g. "Opening this route"
 * @param {string} typeName - aircraft type name, for "your 3 other A320s"
 */
export default function ReserveNotice({
  aircraft, fleet = [], ops = [], action = 'Assigning it here', typeName, style,
}) {
  const cov = reserveCoverageSummary(aircraft, fleet, ops);
  if (!cov) return null;
  const what = typeName ? `${typeName}${cov.tails !== 1 ? 's' : ''}` : `same-type aircraft`;
  return (
    <div
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 8,
        fontSize: 12, lineHeight: 1.5, color: 'var(--yellow)',
        background: 'rgba(234,179,8,.10)', border: '1px solid rgba(234,179,8,.35)',
        borderRadius: 'var(--radius)', padding: '8px 10px', margin: '6px 0',
        ...style,
      }}
    >
      <Glyph e="🛡️" size={12} />
      <span>
        <strong>{aircraft.tailNumber || aircraft.name}</strong> is on reserve at {cov.base} —{' '}
        {action.charAt(0).toLowerCase() + action.slice(1)} takes it off standby.{' '}
        {cov.tails > 0 ? (
          <>It stops covering your {cov.tails} other {what} at {cov.base} ({cov.routes} route{cov.routes !== 1 ? 's' : ''}) when one goes into the shop.</>
        ) : (
          <>Nothing else of this type flies {cov.base} right now, so it has nothing to cover — you also stop paying to park it there.</>
        )}
      </span>
    </div>
  );
}
