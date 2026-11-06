// Network map: colour passenger lines by load factor instead of profit.
//
// The "Colour" switch beside the Width toggle. Profit says whether a route
// pays; load factor says whether it is full — together with width (how many
// it carries) the map shows trunks that are full, big routes flying empty,
// and small ones that could take a bigger aircraft. The scale runs cool to
// hot with no green or red, so it can't be misread as profit, and no amber,
// which is freight. React-free: tools/route-colour-test.mjs imports it.

export const ROUTE_COLOUR_KEY = 'headwinds.routeColorMode';
export const ROUTE_COLOUR_MODES = ['profit', 'lf'];

/** Load-factor bands, lowest first: a route sits in the first band whose `upTo` it is under. */
export const LF_BANDS = [
  { upTo: 0.5,      color: '#6a6fc2', label: '< 50%' },
  { upTo: 0.65,     color: '#4da6ff', label: '50–65%' },
  { upTo: 0.8,      color: '#38e1ff', label: '65–80%' },
  { upTo: 0.9,      color: '#ffe066', label: '80–90%' },
  { upTo: Infinity, color: '#ffffff', label: '90%+' },
];

/** Colour of a line flying at load factor `lf` (0..1). No result yet → the lowest band. */
export function loadFactorColor(lf) {
  const v = Number.isFinite(lf) ? lf : 0;
  return LF_BANDS.find(b => v < b.upTo).color;
}

/** Remembered mode, falling back to profit for anything unknown. */
export function normalizeColourMode(v) {
  return ROUTE_COLOUR_MODES.includes(v) ? v : 'profit';
}
