import { useId } from 'react';
import AirlineLogo from './AirlineLogo.jsx';
import { normalizeLivery } from '../data/livery.js';
import { getLiveryTemplate, DEFAULT_LIVERY_TEMPLATE, finOutlineOf } from '../data/liveryTemplates.js';
import { markColorOn } from '../utils/logoBranding.js';

// The airline's tail logo — the flat fin silhouette the airline-tail charts
// use, in the livery's tail colour, with the logo big on the fin and one of a
// few designs (TAIL_DESIGNS) in the accent colour. The silhouette is the
// licensed template's real fin, traced from its artwork
// (data/liveryTemplates.js `fin.outline`), so the shape is a 737's and not a
// drawing. Designed in the logo maker (Tail section), shown over your hubs on
// the maps, over each rival's hubs on the Rivals map, on the season podium
// and on the player profile. Small list rows keep the square logo tile.
//
// Plain SVG: it server-renders, and the maps use it as static markup
// (utils/hubFin.js), so there is nothing to decode or paint.
//
//   livery   the airline's livery (normalised here; liveryFor(state) for yours)
//   logo     { id, accentColor, bgColor, customSrc } — the AirlineLogo fields
//   height   CSS px tall (width follows the fin's aspect)
//   idPrefix unique id for the clip path in static markup (useId restarts per
//            renderToStaticMarkup, so two markers would share one id)

// The accent for the design: the cheatline colour, unless it IS the tail
// colour (the default livery paints both in the logo colour), then the
// fuselage colour so the design still shows.
function accentOf(l) {
  return l.cheatline && l.cheatline !== l.tail ? l.cheatline : l.fuselage;
}

// Designs, drawn in the fin's box (w × h) and clipped to the silhouette. The
// bands run parallel to the swept leading edge, the way real tail designs
// do, and sit low on the fin so the logo above them stays on clear paint.
function Design({ design, w, h, accent, white }) {
  const slope = h / w * 1.16;            // the leading edge's slope, in the fin's box
  const band = (y0, t, fill) => <polygon points={`0,${y0 + t} ${w},${y0 - w * slope + t} ${w},${y0 - w * slope} 0,${y0}`} fill={fill} />;
  switch (design) {
    case 'stripe':
      return band(h * 1.5, h * 0.13, accent);
    case 'stripes':
      return <>
        {band(h * 1.36, h * 0.055, accent)}
        {band(h * 1.46, h * 0.055, white)}
        {band(h * 1.56, h * 0.055, accent)}
      </>;
    case 'swoosh':
      return <path d={`M0 ${h} C ${w * 0.35} ${h * 0.97} ${w * 0.7} ${h * 0.85} ${w} ${h * 0.52} L${w} ${h} Z`} fill={accent} />;
    case 'split':
      return <polygon points={`0,${h} ${w},${h * 0.62} ${w},${h}`} fill={accent} />;
    default:
      return null;
  }
}

export default function TailFin({ livery, logo = {}, height = 48, templateId, title, className, style, idPrefix = null }) {
  const spec = (templateId && getLiveryTemplate(templateId)) || getLiveryTemplate(DEFAULT_LIVERY_TEMPLATE);
  const fin = finOutlineOf(spec);
  const rid = useId();
  const uid = String(idPrefix ?? rid).replace(/[^a-zA-Z0-9_-]/g, '');
  const clip = `fin-${uid}`;
  const l = normalizeLivery(livery, livery?.tail ?? logo?.accentColor);
  const custom = typeof logo.customSrc === 'string' && logo.customSrc;
  const showMark = l.logoOnTail && (custom || logo.id);
  // A preset sits on the paint as its bare mark, recoloured to read on the
  // tail; an upload, or a livery that asks for the tile, gets its tile.
  const tile = custom || l.logoTile;
  const { cx, cy, size } = fin.logo;
  const points = fin.points.map(([x, y]) => `${x},${y}`).join(' ');
  const width = Math.round(height * fin.aspect);
  return (
    <svg
      width={width} height={height} viewBox={`0 0 ${fin.w} ${fin.h}`}
      role="img" aria-label={title ?? 'Airline tail'}
      data-tail-template={spec.id} data-tail-design={l.tailDesign}
      className={className} style={{ display: 'block', flexShrink: 0, ...style }}
    >
      {title ? <title>{title}</title> : null}
      <defs><clipPath id={clip}><polygon points={points} /></clipPath></defs>
      <g clipPath={`url(#${clip})`}>
        <rect x="0" y="0" width={fin.w} height={fin.h} fill={l.tail} />
        <Design design={l.tailDesign} w={fin.w} h={fin.h} accent={accentOf(l)} white={l.fuselage} />
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
      <polygon points={points} fill="none" stroke="rgba(255,255,255,.35)" strokeWidth={fin.w / 160} strokeLinejoin="round" />
    </svg>
  );
}
