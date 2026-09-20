import { useGame } from '../store/GameContext.jsx';
import { stationFuelBasis, stationFuelDriver, stationFuelBand, fuelStationsOn } from '../../packages/engine/src/data/fuelStations.js';
import { fuelPricePerLitre } from '../../packages/engine/src/utils/fuel.js';

/**
 * The one chip every airport surface wears (FUEL_OPERATIONS_PLAN.md §7.3):
 * the station's fuel basis — `0.92×` / `1.20×` — colour-banded, with the
 * dominant driver and today's $/litre in the tooltip. Renders nothing in a
 * world that isn't on station pricing, so nobody is shown a price they are
 * not charged.
 *
 * Rule: any surface that names an airport shows its basis, the same way it
 * shows gate fees or runway length. Nobody should find out a station is dear
 * by reading the P&L.
 */
export const BAND_COLORS = {
  'cheap':     { color: 'var(--green)',  bg: 'rgba(56,211,159,0.10)', border: 'rgba(56,211,159,0.35)' },
  'normal':    { color: 'var(--text-muted)', bg: 'var(--surface3)',   border: 'var(--border)' },
  'dear':      { color: 'var(--yellow)', bg: 'rgba(255,180,61,0.10)', border: 'rgba(255,180,61,0.35)' },
  'very dear': { color: 'var(--red)',    bg: 'rgba(255,93,108,0.10)', border: 'rgba(255,93,108,0.35)' },
};

export function fuelBasisTitle(code, state) {
  const d = stationFuelDriver(code);
  if (!d) return '';
  const idx = state?.fuelPrice?.index ?? 1;
  return `Fuel at ${code}: ${d.basis.toFixed(2)}× the world index — ${d.text}. `
       + `$${fuelPricePerLitre(idx * d.basis).toFixed(2)}/L at today's ${idx.toFixed(2)}× index.`;
}

export default function FuelBasisChip({ code, compact = false, style }) {
  const { state } = useGame();
  if (!fuelStationsOn(state) || !code) return null;
  const basis = stationFuelBasis(code);
  const band  = stationFuelBand(basis);
  const c = BAND_COLORS[band];
  return (
    <span
      className="badge fuel-basis-chip"
      data-testid={`fuel-basis-${code}`}
      title={fuelBasisTitle(code, state)}
      style={{
        background: c.bg, color: c.color, border: `1px solid ${c.border}`,
        fontSize: compact ? 10 : 11, padding: compact ? '0 5px' : '1px 6px', borderRadius: 4,
        fontFamily: 'monospace', fontWeight: 600, whiteSpace: 'nowrap', ...style,
      }}
    >
      ⛽ {basis.toFixed(2)}×
    </span>
  );
}

/** Plain-text form for <option> rows and titles, where a chip can't render. */
export function fuelBasisText(code, state) {
  if (!fuelStationsOn(state) || !code) return '';
  return ` · ⛽${stationFuelBasis(code).toFixed(2)}×`;
}
