import { useMemo } from 'react';
import { AIRPORTS } from '../data/airports.js';
import { groupAirports, airportOptionLabel } from '../utils/airportGroups.js';

/**
 * Grouped airport picker: the player's hubs and focus cities pinned at the top,
 * then every region, alphabetical by city inside each group.
 */
export default function AirportSelect({
  value, onChange, gates, hubs, exclude = null, placeholder = null,
  showGates = true, requireGate = true, ...rest
}) {
  const groups = useMemo(
    () => groupAirports({ airports: AIRPORTS, gates, hubs, exclude, requireGate }),
    [gates, hubs, exclude, requireGate],
  );

  return (
    <select
      className="form-select"
      value={value}
      onChange={e => onChange(e.target.value)}
      {...rest}
    >
      {placeholder != null && <option value="">{placeholder}</option>}
      {groups.map(g => (
        <optgroup key={g.label} label={g.label}>
          {g.airports.map(a => (
            <option key={a.code} value={a.code}>
              {airportOptionLabel(a, gates, showGates)}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
