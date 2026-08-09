import { useGame } from '../store/GameContext.jsx';
import { getAirport, gateMonthlyFee } from '../data/airports.js';
import { formatMoney, SLOTS_PER_GATE } from '../utils/simulation.js';
import { gateDenialFor, DisabledHint } from './GateDenial.jsx';

/**
 * Inline "+ Add gate" button for fixing gate/slot shortfalls without leaving
 * the current screen (e.g. the new-route form). Shows the monthly fee for the
 * next gate at the airport and dispatches ADD_GATE on click.
 *
 * In a gate-scarcity world the lease can be REFUSED (lockout, ownership caps,
 * a full airport). This button used to ignore that entirely: it stayed enabled,
 * dispatched ADD_GATE, and the reducer returned state unchanged — a click that
 * did nothing whatsoever, with no error and no explanation. It now asks the
 * same helper the Airports tab and the server ask, and disables + explains.
 */
export default function AddGateButton({ code, style }) {
  const { state, dispatch } = useGame();
  const count = (state.gates ?? {})[code] ?? 0;
  const fee = gateMonthlyFee(getAirport(code), count + 1);
  const denial = gateDenialFor(state, code);

  const button = (
    <button
      type="button"
      className="btn btn-ghost"
      style={{
        padding: '2px 10px', fontSize: 11, marginLeft: 8, whiteSpace: 'nowrap',
        opacity: denial ? 0.35 : 1,
        cursor: denial ? 'not-allowed' : 'pointer',
        ...style,
      }}
      disabled={!!denial}
      title={denial ? undefined : `Lease one more gate at ${code} (+${SLOTS_PER_GATE} slots) for ${formatMoney(fee)}/mo`}
      onClick={() => dispatch({ type: 'ADD_GATE', airportCode: code })}
    >
      + Add gate ({formatMoney(fee)}/mo)
    </button>
  );

  if (!denial) return button;

  // The reason goes on screen, not in a tooltip — a `disabled` button fires no
  // pointer events, so Chrome and Safari never show its title at all.
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, marginLeft: 8 }}>
      <DisabledHint title={denial} style={{ marginLeft: -8 }}>{button}</DisabledHint>
      <span style={{ fontSize: 10, lineHeight: 1.35, color: 'var(--red)', maxWidth: 340, whiteSpace: 'normal' }}>
        ⛔ {denial}
      </span>
    </span>
  );
}
