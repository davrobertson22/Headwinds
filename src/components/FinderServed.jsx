/**
 * The Route Finders' "Served" cell: how much of a market is already flown.
 *
 *   "Simple; next to estimated load (or market), add a 0-x% digit to tell you
 *    how much of the demand is satisfied already. Saves you having to check
 *    every individual route and recalculate every time you do."
 *    (VodkaOnFire, Discord 2026-10-21 — passenger and freight alike)
 *
 * The figure comes from models/routeFinder.js (laneServed / cargoLaneServed):
 * the engine's own share fight with everyone already on the lane, divided by
 * the market's weekly size. This file only prints it — one component for both
 * finders, so the two never disagree about what "served" means or how it reads.
 *
 * Colour reads as opportunity, the way the finder is used: little flown is
 * green (room for you), most of it flown is red (you would be fighting for the
 * scraps). 0% is dim rather than green — on a list of unflown lanes a column of
 * green zeroes says nothing.
 */

export function servedTone(share) {
  if (!(share > 0.005)) return 'var(--text-dim)';
  if (share >= 0.85) return 'var(--red)';
  if (share >= 0.5) return 'var(--yellow)';
  return 'var(--green)';
}

/** Whole-percent, never "-0%"; past 100% is printed as it is (a market grown by cheap fares). */
export function servedPct(share) {
  return Math.max(0, Math.round((share ?? 0) * 100));
}

/** The tooltip: who carries what, and how much is left. */
export function servedTitle(served, { unit = 'travellers', cargo = false } = {}) {
  if (!served) return '';
  const fmt = (n) => Math.round(n).toLocaleString();
  const carried = cargo ? served.tonnes : served.pax;
  const yours   = cargo ? served.yourTonnes : served.yourPax;
  const rivals  = cargo ? served.rivalTonnes : served.rivalPax;
  const u = cargo ? 't' : ` ${unit}`;
  const lines = [
    `${fmt(carried)}${u} of ${fmt(served.pool)}${u} a week already flown (${servedPct(served.share)}%).`,
  ];
  if (rivals > 0) lines.push(`Rivals: ${fmt(rivals)}${u} (${servedPct(served.rivalShare)}%)${cargo ? '' : ', one-stop connections over their hubs included'}.`);
  if (yours > 0)  lines.push(`You: ${fmt(yours)}${u} (${servedPct(served.yourShare)}%).`);
  const left = served.pool - carried;
  lines.push(left > 0
    ? `About ${fmt(left)}${u} a week nobody carries yet.`
    : 'Flown past its base size — cheap fares and frequent service grow a market.');
  lines.push(cargo
    ? 'Estimated at maturity, this month, at the rates already on the lane.'
    : 'The same share fight the weekly results run, at maturity, this month — before you add anything.');
  return lines.join('\n');
}

export default function ServedCell({ served, cargo = false, unit = 'travellers' }) {
  if (!served) {
    return <span style={{ color: 'var(--text-dim)' }} title="No market on this pair">–</span>;
  }
  const pct   = servedPct(served.share);
  const yours = servedPct(served.yourShare);
  return (
    <span data-served={pct} title={servedTitle(served, { unit, cargo })} style={{ whiteSpace: 'nowrap', cursor: 'help' }}>
      <span style={{ color: servedTone(served.share), fontWeight: 600 }}>{pct}%</span>
      {yours > 0 && (
        <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>you {yours}%</div>
      )}
    </span>
  );
}
