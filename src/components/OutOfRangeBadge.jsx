// OutOfRangeBadge — shared by the passenger Routes page and the cargo routes
// list. Four of the ten types whose range the 2026-09-20 aircraft audit
// corrected are freighters, so the cargo list needs it as much as Routes does.
import { Glyph } from './Icons.jsx';

// Red "Out of range" badge: the aircraft on this route can no longer reach one
// of its legs (a corrected aircraft range, or a refit that cost range), so the
// route has stopped flying. Set by applyRangeStranding in the reducer. The
// title carries the numbers and the fix, because the badge alone does not say
// what to do about it.
export default function OutOfRangeBadge({ route, style = null }) {
  const r = route?.rangeStranded;
  if (!r) return null;
  const km = (n) => `${Math.round(n ?? 0).toLocaleString()} km`;
  return (
    <span style={{
      ...(style ?? {}),
      fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3,
      background: 'rgba(248,81,73,0.15)', color: 'var(--red)',
      border: '1px solid rgba(248,81,73,0.3)',
      textTransform: 'uppercase', letterSpacing: '.04em',
    }} title={`The ${r.from}–${r.to} leg is ${km(r.sectorKm)}; this aircraft reaches ${km(r.rangeKm)}. `
            + `Not flying. Reassign to a longer-range aircraft — the route keeps its ramp and pricing.`}>
      <Glyph e="📏" /> Out of range
    </span>
  );
}
