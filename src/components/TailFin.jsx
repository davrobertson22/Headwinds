import { useId } from 'react';
import AirlineLogo from './AirlineLogo.jsx';
import { normalizeLivery } from '../data/livery.js';
import { markColorOn } from '../utils/logoBranding.js';

// The airline's tail logo, drawn the way the airline-tail charts draw them:
// a flat fin silhouette, nose to the right, in the livery's tail colour, the
// logo big in the middle, and one of a few designs (TAIL_DESIGNS) in the
// accent colour. Designed in the logo maker (Tail section); shown over your
// hubs on the maps, over each rival's hubs on the Rivals map, on the season
// podium and on the player profile. Small list rows keep the square logo.
//
// Plain SVG: it server-renders, and the maps use it as static markup
// (utils/hubFin.js), so there is nothing to decode or paint.
//
//   livery   the airline's livery (normalised here; liveryFor(state) for yours)
//   logo     { id, accentColor, bgColor, customSrc } — the AirlineLogo fields
//   height   CSS px tall (width follows FIN_ASPECT)
//   idPrefix unique id for the clip path in static markup (useId restarts per
//            renderToStaticMarkup, so two markers would share one id)

// The silhouette, measured off the chart Dave sent (the Air Canada cell,
// 395 px tall): a trapezoid 1.291 wide for 1 tall. The trailing edge on the
// left leans aft 0.405 from base to tip, the tip chord is 0.367, the leading
// edge is one straight line from the tip to the base's right corner, and the
// base is the full bottom. The tip corners are rounded a touch. Units: the
// box below is 1291 × 1000.
export const FIN_W = 1291, FIN_H = 1000, FIN_ASPECT = FIN_W / FIN_H;
const R = 22;
export const FIN_PATH = `M405 ${FIN_H} L${R * 0.4} ${R * 1.1} Q0 0 ${R} 0 L${367 - R * 0.6} 0 Q367 0 ${367 + R * 0.5} ${R * 0.9} L${FIN_W} ${FIN_H} Z`;
// Where the logo goes: centred on the fin's body (the chart's marks sit a
// little below the middle), 0.6 of the height wide. The striped designs
// carry no logo — a band the length of the fin leaves no clear paint for a
// mark, which is why the chart's striped tails (Delta, Air France, Aeroflot)
// have none either.
const LOGO = { cx: 600, cy: 580, size: 600 };
export const LOGO_FREE_DESIGNS = new Set(['stripe', 'stripes']);

// The accent for the design: the cheatline colour, unless it IS the tail
// colour (the default livery paints both in the logo colour), then the
// fuselage colour so the design still shows.
function accentOf(l) {
  return l.cheatline && l.cheatline !== l.tail ? l.cheatline : l.fuselage;
}

// Designs, clipped to the silhouette. The bands run parallel to the leading
// edge (down and to the right), the way real tail designs do; `x0` is where
// a band's upper edge crosses the top of the box, `t` its thickness.
function Design({ design, accent, white }) {
  const W = FIN_W, H = FIN_H;
  const s = H / (W - 367);                              // the leading edge's drop per unit of run
  const band = (x0, t, fill) => <polygon points={`${x0},0 ${x0 + 2 * W},${2 * W * s} ${x0 + 2 * W},${2 * W * s + t} ${x0},${t}`} fill={fill} />;
  switch (design) {
    case 'stripe':
      return band(60, 150, accent);
    case 'stripes':
      return <>
        {band(-40, 70, accent)}
        {band(60, 70, white)}
        {band(160, 70, accent)}
      </>;
    case 'swoosh':
      return <path d={`M0 ${H * 0.72} C ${W * 0.3} ${H * 1.02} ${W * 0.6} ${H * 1.08} ${W} ${H * 0.9} L${W} ${H} L0 ${H} Z`} fill={accent} />;
    case 'split':
      return <polygon points={`0,${H * 0.6} ${W},${H} 0,${H}`} fill={accent} />;
    default:
      return null;
  }
}

export default function TailFin({ livery, logo = {}, height = 48, title, className, style, idPrefix = null }) {
  const rid = useId();
  const uid = String(idPrefix ?? rid).replace(/[^a-zA-Z0-9_-]/g, '');
  const clip = `fin-${uid}`;
  const l = normalizeLivery(livery, livery?.tail ?? logo?.accentColor);
  const custom = typeof logo.customSrc === 'string' && logo.customSrc;
  const showMark = l.logoOnTail && !LOGO_FREE_DESIGNS.has(l.tailDesign) && (custom || logo.id);
  // A preset sits on the paint as its bare mark, recoloured to read on the
  // tail; an upload, or a livery that asks for the tile, gets its tile.
  const tile = custom || l.logoTile;
  const { cx, cy, size } = LOGO;
  const width = Math.round(height * FIN_ASPECT);
  return (
    <svg
      width={width} height={height} viewBox={`0 0 ${FIN_W} ${FIN_H}`}
      role="img" aria-label={title ?? 'Airline tail'}
      data-tail-design={l.tailDesign}
      className={className} style={{ display: 'block', flexShrink: 0, ...style }}
    >
      {title ? <title>{title}</title> : null}
      <defs><clipPath id={clip}><path d={FIN_PATH} /></clipPath></defs>
      <g clipPath={`url(#${clip})`}>
        <rect x="0" y="0" width={FIN_W} height={FIN_H} fill={l.tail} />
        <Design design={l.tailDesign} accent={accentOf(l)} white={l.fuselage} />
        {showMark ? (
          <g transform={`translate(${cx - size / 2} ${cy - size / 2})`}>
            <AirlineLogo
              id={logo.id} size={size} customSrc={custom || undefined}
              bgColor={tile ? logo.bgColor : 'none'}
              accentColor={tile ? logo.accentColor : markColorOn(l.tail, logo.accentColor)}
            />
          </g>
        ) : null}
      </g>
      <path d={FIN_PATH} fill="none" stroke="rgba(0,0,0,.18)" strokeWidth="6" strokeLinejoin="round" />
    </svg>
  );
}
