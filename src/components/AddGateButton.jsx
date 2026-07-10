import { useGame } from '../store/GameContext.jsx';
import { getAirport, gateMonthlyFee } from '../data/airports.js';
import { formatMoney, SLOTS_PER_GATE } from '../utils/simulation.js';

/**
 * Inline "+ Add gate" button for fixing gate/slot shortfalls without leaving
 * the current screen (e.g. the new-route form). Shows the monthly fee for the
 * next gate at the airport and dispatches ADD_GATE on click.
 */
export default function AddGateButton({ code, style }) {
  const { state, dispatch } = useGame();
  const count = (state.gates ?? {})[code] ?? 0;
  const fee = gateMonthlyFee(getAirport(code), count + 1);
  return (
    <button
      type="button"
      className="btn btn-ghost"
      style={{ padding: '2px 10px', fontSize: 11, marginLeft: 8, whiteSpace: 'nowrap', ...style }}
      title={`Lease one more gate at ${code} (+${SLOTS_PER_GATE} slots) for ${formatMoney(fee)}/mo`}
      onClick={() => dispatch({ type: 'ADD_GATE', airportCode: code })}
    >
      + Add gate ({formatMoney(fee)}/mo)
    </button>
  );
}
