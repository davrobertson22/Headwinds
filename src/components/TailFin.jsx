import { useId } from 'react';
import AirlineLogo from './AirlineLogo.jsx';
import { normalizeLivery } from '../data/livery.js';
import { markColorOn } from '../utils/logoBranding.js';

// An airline's tail fin: its mark on a fin in its livery colours. Designed in
// the logo maker (shape + paint style, saved on the livery as finShape /
// finStyle) and drawn wherever an airline is shown big enough for a shape to
// read — hub markers on the maps, the season podium, the player profile.
// Small list rows keep the square logo tile, where a fin's narrow body would
// shrink the mark.
//
//   livery  the airline's livery (normalised here; liveryFor(state) for yours)
//   logo    { id, accentColor, bgColor, customSrc } — the AirlineLogo fields
//   size    height in px (width is 40/44 of it)
//   idPrefix  unique id for the fin's clip path when rendered with
//           renderToStaticMarkup (map markers): every static render restarts
//           React's useId counter, so two markers would share one id

// viewBox 0 0 40 44: the fin stands on a short fuselage strip along y 40–44.
// `mark` is where the logo sits on each outline: centre and size, in the
// fin's upper body — the stripe and two-tone paint run below it, so the mark
// always sits on the tail colour it was recoloured for.
const SHAPES = {
  swept:    { d: 'M3 41 L21 4 L33 4 L37 41 Z',                                         mark: [27, 18, 16] },
  tall:     { d: 'M7 41 L16 2 L32 2 L35 41 Z',                                         mark: [25, 16, 16] },
  retro:    { d: 'M5 41 C7 24 13 8 23 5 C31 3 35 10 35 18 L35 41 Z',                   mark: [25, 18, 16] },
  't-tail': { d: 'M8 41 L20 10 L30 10 L33 41 Z', stab: 'M11 10 L38.5 6 L38.5 9.5 L13 12.5 Z', mark: [26, 21, 13] },
};

// The second paint colour for stripe / two-tone: the cheatline colour, unless
// it IS the tail colour (the default livery paints both in the logo colour),
// then the fuselage colour so the style still shows.
function secondColour(l) {
  return l.cheatline && l.cheatline !== l.tail ? l.cheatline : l.fuselage;
}

export default function TailFin({ livery, logo = {}, size = 44, title, className, style, idPrefix = null }) {
  const rid = useId();
  const uid = String(idPrefix ?? rid).replace(/[^a-zA-Z0-9_-]/g, '');
  const l = normalizeLivery(livery, livery?.tail ?? logo?.accentColor);
  const shape = SHAPES[l.finShape] ?? SHAPES.swept;
  const clip = `fin-${uid}`;
  const two = secondColour(l);
  const [mx, my, ms] = shape.mark;
  const custom = typeof logo.customSrc === 'string' && logo.customSrc;
  const showMark = l.logoOnTail && (custom || logo.id);
  // A preset sits on the paint as its bare mark, recoloured to read on the
  // tail (a white kangaroo on a red fin); an upload, or a livery that asks
  // for the tile, gets its tile.
  const tile = custom || l.logoTile;
  return (
    <svg
      width={Math.round(size * 40 / 44)} height={size} viewBox="0 0 40 44"
      role="img" aria-label={title ?? 'Airline tail fin'}
      className={className} style={{ display: 'block', flexShrink: 0, overflow: 'visible', ...style }}
    >
      {title ? <title>{title}</title> : null}
      <defs>
        <clipPath id={clip}><path d={shape.d} /></clipPath>
      </defs>
      {/* Fuselage strip the fin stands on. */}
      <rect x="0" y="40" width="40" height="4" rx="2" fill={l.fuselage} stroke="rgba(255,255,255,.35)" strokeWidth="0.6" />
      {shape.stab ? <path d={shape.stab} fill={l.tail} stroke="rgba(255,255,255,.45)" strokeWidth="0.6" strokeLinejoin="round" /> : null}
      <path d={shape.d} fill={l.tail} />
      <g clipPath={`url(#${clip})`}>
        {l.finStyle === 'stripe' && <polygon points="0,38 40,26 40,31 0,43" fill={two} />}
        {l.finStyle === 'split' && <polygon points="0,41 40,28 40,44 0,44" fill={two} />}
        {showMark ? (
          <g transform={`translate(${mx - ms / 2} ${my - ms / 2})`}>
            <AirlineLogo
              id={logo.id} size={ms} customSrc={custom || undefined}
              bgColor={tile ? logo.bgColor : 'none'}
              accentColor={tile ? logo.accentColor : markColorOn(l.tail, logo.accentColor)}
            />
          </g>
        ) : null}
      </g>
      <path d={shape.d} fill="none" stroke="rgba(255,255,255,.55)" strokeWidth="0.8" strokeLinejoin="round" />
    </svg>
  );
}
