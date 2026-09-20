import { useMemo } from 'react';
import { AIRPORTS } from '../data/airports.js';
import { groupAirports, airportOptionLabel } from '../utils/airportGroups.js';
import { rememberAirport } from '../utils/airportRecents.js';
import useRecentAirports from '../hooks/useRecentAirports.js';
import { useGame } from '../store/GameContext.jsx';
import { fuelBasisText } from './FuelBasisChip.jsx';

/**
 * Grouped airport picker: the player's hubs, focus cities and last few picks
 * pinned at the top, then the world by region — with the regions ordered by
 * where the airline actually flies, not by the order the continents happen to
 * be listed in. See utils/airportGroups.js for the bug report behind that.
 *
 * Every pick is recorded, which is what feeds the "Recently Used" group here
 * and in every other picker in the game. It costs the player nothing: there is
 * nothing to turn on and nothing to curate.
 */
export default function AirportSelect({
  value, onChange, gates, hubs, exclude = null, placeholder = null,
  showGates = true, requireGate = true, remember = true, ...rest
}) {
  const recent = useRecentAirports();
  // Station fuel basis in every option row (FUEL_OPERATIONS_PLAN.md §7.3) —
  // an <option> can't hold a chip, so it is text; empty in a classic world.
  const { state } = useGame();
  const groups = useMemo(
    () => groupAirports({ airports: AIRPORTS, gates, hubs, recent, exclude, requireGate }),
    [gates, hubs, recent, exclude, requireGate],
  );

  return (
    <select
      className="form-select"
      value={value}
      onChange={e => {
        // Recorded before the change is handed on, so a caller that unmounts
        // this select on change (the planner swaps in a locked pair) still gets
        // the pick written.
        if (remember) rememberAirport(e.target.value);
        onChange(e.target.value);
      }}
      {...rest}
    >
      {placeholder != null && <option value="">{placeholder}</option>}
      {groups.map(g => (
        <optgroup key={g.label} label={g.label}>
          {g.airports.map(a => (
            <option key={a.code} value={a.code}>
              {airportOptionLabel(a, gates, showGates)}{fuelBasisText(a.code, state)}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
