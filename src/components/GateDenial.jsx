// Why a gate lease is refused — said out loud, on the row.
// ----------------------------------------------------------------------------
// `gateLeaseDenial` (packages/engine/src/reducer.mjs) is the ONE source of the
// disabled "+ Gate" state in a scarcity world, and it has always returned a
// well-written sentence. That sentence used to be attached only as `title` on
// a `disabled` button — and browsers suppress pointer events on disabled form
// controls, so Chrome and Safari never render the tooltip. The reason was
// unreachable: a player saw a greyed-out button and nothing else.
//
// Everything here exists so the reason is READABLE without hover, in the same
// words the server uses when it refuses the same lease over the API (a 400 from
// routes/decisions.mjs), so the two paths can never disagree.
import { gateLeaseDenial } from '../store/GameContext.jsx';
import { absoluteWeek } from '../utils/fuel.js';
import { GATE_IDLE_FORFEIT_WEEKS, GATE_IDLE_WARN_WEEKS } from '../data/airports.js';

/** The denial sentence for `code`, or null when leasing is allowed. */
export function gateDenialFor(state, code) {
  return state?.gateScarcityWorld ? gateLeaseDenial(state, code) : null;
}

/** Whole weeks until a rule-5 lockout at `code` expires (0 when not locked). */
export function lockoutWeeksLeft(state, code) {
  if (!state?.gateScarcityWorld || code === state.hub) return 0;
  const until = state.gateLockouts?.[code] ?? 0;
  return Math.max(0, until - absoluteWeek(state.year ?? 1, state.week ?? 1));
}

/** Weeks of no service on gates you hold at `code` (drives the 16-week warning). */
export function idleWeeksAt(state, code) {
  if (!state?.gateScarcityWorld || code === state.hub) return 0;
  return state.gateIdleWeeks?.[code] ?? 0;
}

/**
 * The denial reason as visible text. Renders nothing when leasing is allowed.
 * `compact` trims it to one line for dense table rows.
 */
export function GateDenialNote({ state, code, reason, compact = false, style }) {
  // `reason` lets a caller that already computed the denial (the gate table
  // builds one per row) reuse this styling without a second lookup.
  const denial = reason ?? gateDenialFor(state, code);
  if (!denial) return null;
  return (
    <div
      role="note"
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 5,
        fontSize: compact ? 10 : 11, lineHeight: 1.35,
        color: 'var(--red)', marginTop: 3, maxWidth: compact ? 420 : 560,
        whiteSpace: 'normal',
        ...style,
      }}
    >
      <span aria-hidden="true" style={{ flexShrink: 0 }}>⛔</span>
      <span>{denial}</span>
    </div>
  );
}

/**
 * Wraps a disabled control so the tooltip still appears. A `disabled` button
 * fires no pointer events of its own, but an enabled ancestor does — so the
 * title has to live on the wrapper, not on the button.
 */
export function DisabledHint({ title, children, style }) {
  if (!title) return children;
  return (
    <span title={title} style={{ display: 'inline-flex', cursor: 'not-allowed', ...style }}>
      {children}
    </span>
  );
}

/** Idle-gate warning sentence ahead of forfeiture, or null. */
export function idleWarningFor(state, code) {
  const weeks = idleWeeksAt(state, code);
  if (weeks < GATE_IDLE_WARN_WEEKS) return null;
  const left = GATE_IDLE_FORFEIT_WEEKS - weeks;
  if (left <= 0) return null;
  return `No routes have served ${code} for ${weeks} weeks. Your gates here are forfeited in `
       + `${left} week${left === 1 ? '' : 's'} — open a route or release them.`;
}
