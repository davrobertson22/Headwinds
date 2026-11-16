// Airline livery — the paint scheme shown on the licensed aircraft templates
// (web: src/utils/liveryPaint.js, src/data/liveryTemplates.js).
//
// Pure data, shared by the reducer (SET_BRANDING), the server decision guard
// and the client editor, so a livery is validated the same way everywhere.
// Nothing in the sim reads it: it is cosmetic, like logoId/logoColor.
//
// Shape (every colour a lowercase #rrggbb):
//   fuselage    body colour
//   tail        fin, stabiliser and winglets
//   engines     nacelles and pylons
//   cheatline   the stripe / sweep colour the style uses
//   style       one of LIVERY_STYLES
//   titles      colour of the airline name on the fuselage
//   logoOnTail  draw the airline's logo on the fin
//   logoOnFuselage  draw it on the forward fuselage too, ahead of the name
//               (off by default, so liveries saved before it look the same)
//   tailDesign  the tail logo's design on the maps and profile (TAIL_DESIGNS)
//   logoTile    paint the logo on its square tile, the way it looks in the
//               app. Off by default: a preset is painted as the bare mark,
//               recoloured when needed so it reads on the paint under it,
//               and an uploaded image straight on the paint (a transparent
//               PNG's clear areas show the livery). On: either on its tile
//   titlesOn    draw the airline name on the fuselage
//   logoShape   the logo's outline on the livery: 'square' | 'rounded' |
//               'circle', or null for the default (a tile is a circle, the
//               way it has always painted; a bare upload is uncropped). It
//               clips the tile, and an uploaded image whether tiled or bare
//   tailLogoX / tailLogoY  move the fin logo, in default-logo widths
//               (−1…1; +x towards the nose, +y up). Anything that leaves the
//               fin is cut off, so part of a big mark can run off the edge
//   tailLogoScale  size of the fin logo, 0.5…3 × the default
//   (Discord, VodkaOnFire 2026-11-14: transparent PNGs straight on the paint,
//   a round shape, and X/Y/size so only part of the logo shows on the tail.)

export const LIVERY_STYLES = ['none', 'classic', 'belly', 'swoosh', 'retro', 'tail-wrap'];

export const LIVERY_STYLE_LABELS = {
  none: 'Plain', classic: 'Cheatline', belly: 'Belly', swoosh: 'Swoosh', retro: 'Retro', 'tail-wrap': 'Tail wrap',
};

// The tail logo's design (TailFin.jsx): how the accent sits on the flat fin.
export const TAIL_DESIGNS = ['solid', 'stripe', 'stripes', 'swoosh', 'split'];
export const TAIL_DESIGN_LABELS = { solid: 'Solid', stripe: 'Stripe', stripes: 'Stripes', swoosh: 'Swoosh', split: 'Split' };

// The logo's outline on the livery (logoShape). null = the default for the
// context — see effectiveLogoShape.
export const LOGO_SHAPES = ['square', 'rounded', 'circle'];
export const LOGO_SHAPE_LABELS = { square: 'Square', rounded: 'Rounded', circle: 'Circle' };

// Fin-logo placement limits (tailLogoX/Y in default-logo widths, scale ×).
export const TAIL_LOGO_OFFSET_MAX = 1;
export const TAIL_LOGO_SCALE_MIN = 0.5;
export const TAIL_LOGO_SCALE_MAX = 3;

export const LIVERY_WHITE = '#f5f7fa';
export const LIVERY_INK   = '#15202f';
const DEFAULT_ACCENT = '#1e9bff';

export const DEFAULT_LIVERY = Object.freeze({
  fuselage:   LIVERY_WHITE,
  tail:       DEFAULT_ACCENT,
  engines:    LIVERY_WHITE,
  cheatline:  DEFAULT_ACCENT,
  style:      'none',
  titles:     LIVERY_INK,
  logoOnTail: true,
  logoOnFuselage: false,
  logoTile:   false,
  titlesOn:   true,
  tailDesign: 'solid',
  logoShape:  null,
  tailLogoX:  0,
  tailLogoY:  0,
  tailLogoScale: 1,
});

// A finite number clamped to [lo, hi] and rounded to 2 dp; anything else → d.
function clampNum(v, lo, hi, d) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return d;
  const c = Math.min(hi, Math.max(lo, n));
  return Math.round(c * 100) / 100 || 0;      // `|| 0` folds −0 into 0
}

const HEX = /^#([0-9a-f]{6})$/i;
const SHORT_HEX = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;

/** '#abc' / '#AABBCC' / 'aabbcc' → '#aabbcc', or null when it isn't a colour. */
export function normalizeHex(v) {
  if (typeof v !== 'string') return null;
  let s = v.trim();
  if (!s.startsWith('#')) s = `#${s}`;
  const m3 = SHORT_HEX.exec(s);
  if (m3) s = `#${m3[1]}${m3[1]}${m3[2]}${m3[2]}${m3[3]}${m3[3]}`;
  return HEX.test(s) ? s.toLowerCase() : null;
}

export function isDarkColor(hex) {
  const h = normalizeHex(hex);
  if (!h) return false;
  const n = parseInt(h.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b < 140;
}

/**
 * Coerce anything into a complete, valid livery. Unknown colours fall back to
 * the default (or `accent`, the airline's logo colour, for the tail/cheatline),
 * unknown styles to 'none'. Never throws — the guard decides whether to refuse.
 */
export function normalizeLivery(raw, accent) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const acc = normalizeHex(accent) ?? DEFAULT_LIVERY.tail;
  const col = (v, d) => normalizeHex(v) ?? d;
  return {
    fuselage:   col(src.fuselage,  DEFAULT_LIVERY.fuselage),
    tail:       col(src.tail,      acc),
    engines:    col(src.engines,   DEFAULT_LIVERY.engines),
    cheatline:  col(src.cheatline, acc),
    style:      LIVERY_STYLES.includes(src.style) ? src.style : DEFAULT_LIVERY.style,
    titles:     col(src.titles,    DEFAULT_LIVERY.titles),
    logoOnTail: src.logoOnTail !== false,
    logoOnFuselage: src.logoOnFuselage === true,
    logoTile:   src.logoTile === true,
    titlesOn:   src.titlesOn !== false,
    tailDesign: TAIL_DESIGNS.includes(src.tailDesign) ? src.tailDesign : DEFAULT_LIVERY.tailDesign,
    logoShape:  LOGO_SHAPES.includes(src.logoShape) ? src.logoShape : null,
    tailLogoX:  clampNum(src.tailLogoX, -TAIL_LOGO_OFFSET_MAX, TAIL_LOGO_OFFSET_MAX, 0),
    tailLogoY:  clampNum(src.tailLogoY, -TAIL_LOGO_OFFSET_MAX, TAIL_LOGO_OFFSET_MAX, 0),
    tailLogoScale: clampNum(src.tailLogoScale, TAIL_LOGO_SCALE_MIN, TAIL_LOGO_SCALE_MAX, 1),
  };
}

/**
 * The outline a logo is drawn in: the livery's logoShape, or the default —
 * a tile paints as a circle (what the fin and aircraft have always shown),
 * a bare image is not cropped at all. `tiled` = the logo sits on its tile.
 */
export function effectiveLogoShape(livery, tiled) {
  const l = normalizeLivery(livery, livery?.tail);
  return l.logoShape ?? (tiled ? 'circle' : 'square');
}

/** SVG corner radius for a shape, in a 40-unit box (AirlineLogo's viewBox). */
export function logoShapeRadius40(shape) {
  return shape === 'circle' ? 20 : shape === 'rounded' ? 8 : 0;
}

/**
 * Where the fin logo goes once the livery's offset and size are applied.
 * `base` is the renderer's default box { cx, cy, size } (y grows downward,
 * as in canvas and SVG); +tailLogoY moves the mark UP and +tailLogoX towards
 * the NOSE, whichever way the drawing faces — the map fin faces right, the
 * aircraft template left (`noseRight` false), and the same livery has to put
 * the logo in the same place on both.
 */
export function tailLogoBox(base, livery, noseRight = true) {
  const l = normalizeLivery(livery, livery?.tail);
  return {
    cx: base.cx + (noseRight ? 1 : -1) * l.tailLogoX * base.size,
    cy: base.cy - l.tailLogoY * base.size,
    size: base.size * l.tailLogoScale,
  };
}

/** True when the fin logo is anywhere but its default spot and size. */
export function tailLogoMoved(livery) {
  const l = normalizeLivery(livery, livery?.tail);
  return l.tailLogoX !== 0 || l.tailLogoY !== 0 || l.tailLogoScale !== 1;
}

/** True when the livery paints the airline's logo anywhere (fin or body). */
export function liveryNeedsLogo(livery) {
  const l = normalizeLivery(livery, livery?.tail);
  return l.logoOnTail || l.logoOnFuselage;
}

/** True when `raw` could be a livery at all (an object); the guard refuses the rest. */
export function isLiveryShaped(raw) {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw);
}

/**
 * The livery to paint for an airline state (or a rival projection): the saved
 * one, or a default derived from the logo colour — white body, accent tail —
 * so every airline has a livery from day one without touching the editor.
 */
export function liveryFor(state) {
  const accent = state?.logoColor;
  if (isLiveryShaped(state?.livery)) return normalizeLivery(state.livery, accent);
  return normalizeLivery({}, accent);
}

/** Stable key for caches: the livery's fields in a fixed order. */
export function liveryKey(livery) {
  const l = normalizeLivery(livery, livery?.tail);
  return [l.fuselage, l.tail, l.engines, l.cheatline, l.style, l.titles, l.logoOnTail ? 1 : 0, l.titlesOn ? 1 : 0, l.logoOnFuselage ? 1 : 0, l.logoTile ? 1 : 0, l.tailDesign, l.logoShape ?? '', l.tailLogoX, l.tailLogoY, l.tailLogoScale].join('|');
}
