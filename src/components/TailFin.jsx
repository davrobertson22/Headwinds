import { useId } from 'react';
import AirlineLogo from './AirlineLogo.jsx';
import { normalizeLivery } from '../data/livery.js';
import { markColorOn } from '../utils/logoBranding.js';

// An airline's tail: its mark on the vertical stabiliser, in its livery
// colours, standing on the rear fuselage. Designed in the logo maker (shape +
// paint style, saved on the livery as finShape / finStyle) and drawn wherever
// an airline is shown big enough for a shape to read — hub markers on the
// maps, the season podium, the player profile. Small list rows keep the
// square logo tile, where a fin's narrow body would shrink the mark.
//
//   livery  the airline's livery (normalised here; liveryFor(state) for yours)
//   logo    { id, accentColor, bgColor, customSrc } — the AirlineLogo fields
//   size    height in px (width is 60/48 of it)
//   idPrefix  unique id for the clip paths when rendered with
//           renderToStaticMarkup (map markers): every static render restarts
//           React's useId counter, so two markers would share one id

// viewBox 0 0 60 48. The rear fuselage runs along y 36–48 (the tailcone
// sweeping up to the right), the fin rises from it, the tailplane sits aft.
// Each outline is drawn side-on like a real aircraft's: a leading edge that
// sweeps back from a dorsal-fin fairing at the root, a flat tip, a trailing
// edge that leans a little forward, and a rudder hinge line parallel to it.
//   d      the fin outline
//   hinge  [x1, y1, x2, y2] the rudder hinge line
//   mark   centre and size of the logo on the fin's broad body
//   stab   the tailplane: 'low' (behind the fuselage) or a path on the fin (T-tail)
const SHAPES = {
  // 737 / A320: the everyday swept fin.
  swept: {
    d: 'M3 36 C10 35 15 29 19 20 C22 13 27 5 32 4 L42 4 C43 4 44 5 44 6 L49 36 Z',
    hinge: [40.5, 7, 45.5, 36], mark: [32, 23, 14], stab: 'low',
  },
  // A330 / 747: tall and upright.
  tall: {
    d: 'M4 36 C11 34 15 25 18 13 C19.5 7 22 2 26 2 L37 2 C38 2 39 3 39 4 L46 36 Z',
    hinge: [36, 5, 42.5, 36], mark: [31, 20, 15], stab: 'low',
  },
  // 707 / DC-8 era: a gentler sweep and a rounded tip.
  retro: {
    d: 'M5 36 C12 33 17 24 21 13 C24 6 29 3 35 3 C42 3 46 8 46.5 15 L48 36 Z',
    hinge: [43, 10, 45, 36], mark: [32, 22, 14], stab: 'low',
  },
  // 727 / MD-80 / CRJ: the tailplane rides on top.
  't-tail': {
    d: 'M7 36 C13 34 16 27 19 17 C21 11 24 7 28 7 L39 7 L43 36 Z',
    hinge: [37, 9, 40, 36], mark: [30, 23, 13],
    stab: 'M21 6.5 L57 1 L58 3.6 L26 9.8 Z',
  },
};

// The second paint colour for stripe / two-tone: the cheatline colour, unless
// it IS the tail colour (the default livery paints both in the logo colour),
// then the fuselage colour so the style still shows.
function secondColour(l) {
  return l.cheatline && l.cheatline !== l.tail ? l.cheatline : l.fuselage;
}

export default function TailFin({ livery, logo = {}, size = 48, title, className, style, idPrefix = null }) {
  const rid = useId();
  const uid = String(idPrefix ?? rid).replace(/[^a-zA-Z0-9_-]/g, '');
  const l = normalizeLivery(livery, livery?.tail ?? logo?.accentColor);
  const shape = SHAPES[l.finShape] ?? SHAPES.swept;
  const clip = `fin-${uid}`;
  const body = `body-${uid}`;
  const two = secondColour(l);
  const [mx, my, ms] = shape.mark;
  const custom = typeof logo.customSrc === 'string' && logo.customSrc;
  const showMark = l.logoOnTail && (custom || logo.id);
  // A preset sits on the paint as its bare mark, recoloured to read on the
  // tail (a white kangaroo on a red fin); an upload, or a livery that asks
  // for the tile, gets its tile.
  const tile = custom || l.logoTile;
  const edge = 'rgba(255,255,255,.55)';
  const shade = 'rgba(0,0,0,.22)';
  // The rear fuselage: a tailcone that sweeps up to the right.
  const fuselage = 'M0 36 L60 36 L60 39 C52 42 40 46 26 48 L0 48 Z';
  return (
    <svg
      width={Math.round(size * 60 / 48)} height={size} viewBox="0 0 60 48"
      role="img" aria-label={title ?? 'Airline tail fin'}
      className={className} style={{ display: 'block', flexShrink: 0, overflow: 'visible', ...style }}
    >
      {title ? <title>{title}</title> : null}
      <defs>
        <clipPath id={clip}><path d={shape.d} /></clipPath>
        <clipPath id={body}><path d={fuselage} /></clipPath>
      </defs>
      {/* Low tailplane, behind the fuselage. */}
      {shape.stab === 'low' && (
        <path d="M40 38 L59 33.5 L59 36 L46 41.5 Z" fill={l.tail} stroke={edge} strokeWidth="0.6" strokeLinejoin="round" />
      )}
      {/* Rear fuselage with its window line and the livery's cheatline. */}
      <path d={fuselage} fill={l.fuselage} />
      <g clipPath={`url(#${body})`}>
        {l.style !== 'none' && <path d="M0 42.5 L60 42.5 L60 44.5 L0 44.5 Z" fill={l.cheatline} opacity="0.9" />}
        {[6, 12, 18, 24, 30, 36, 42].map(x => (
          <rect key={x} x={x} y={38.2} width="2.4" height="3" rx="0.8" fill={l.titles === l.fuselage ? shade : l.titles} opacity="0.55" />
        ))}
        <path d="M0 36 L60 36 L60 37 L0 37 Z" fill="rgba(255,255,255,.25)" />
      </g>
      <path d={fuselage} fill="none" stroke={edge} strokeWidth="0.7" strokeLinejoin="round" />
      {/* The fin. */}
      <path d={shape.d} fill={l.tail} />
      <g clipPath={`url(#${clip})`}>
        {l.finStyle === 'stripe' && <polygon points="0,34 60,22 60,27 0,39" fill={two} />}
        {l.finStyle === 'split' && <polygon points="0,38 60,28 60,48 0,48" fill={two} />}
        {/* Rudder hinge line. */}
        <line x1={shape.hinge[0]} y1={shape.hinge[1]} x2={shape.hinge[2]} y2={shape.hinge[3]} stroke={shade} strokeWidth="0.7" />
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
      <path d={shape.d} fill="none" stroke={edge} strokeWidth="0.8" strokeLinejoin="round" />
      {/* T-tail: the tailplane and its bullet fairing on top of the fin. */}
      {shape.stab !== 'low' && (
        <>
          <path d={shape.stab} fill={l.tail} stroke={edge} strokeWidth="0.6" strokeLinejoin="round" />
          <ellipse cx="30" cy="7.4" rx="5.5" ry="1.7" fill={l.tail} stroke={edge} strokeWidth="0.6" />
        </>
      )}
    </svg>
  );
}
