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
//   finShape / finStyle  the tail-fin mark (see FIN_SHAPES below)
//   logoTile    paint the logo on its square tile, the way it looks in the
//               app. Off by default: a preset is painted as the bare mark,
//               recoloured when needed so it reads on the paint under it
//   titlesOn    draw the airline name on the fuselage

export const LIVERY_STYLES = ['none', 'classic', 'belly', 'swoosh', 'retro', 'tail-wrap'];

export const LIVERY_STYLE_LABELS = {
  none: 'Plain', classic: 'Cheatline', belly: 'Belly', swoosh: 'Swoosh', retro: 'Retro', 'tail-wrap': 'Tail wrap',
};

// The airline's tail fin — its mark as a fin in livery colours, designed in
// the logo maker and drawn on the maps (hub markers), the season podium and
// the player profile (web: src/components/TailFin.jsx). Shape and paint only;
// the colours are the livery's own (tail, cheatline, fuselage).
//   finShape  the fin's outline
//   finStyle  how the tail colour sits on it: solid, a stripe in the
//             cheatline colour, or split with the fuselage colour on top
export const FIN_SHAPES = ['swept', 'tall', 'retro', 't-tail'];
export const FIN_SHAPE_LABELS = { swept: 'Swept', tall: 'Tall', retro: 'Classic', 't-tail': 'T-tail' };
export const FIN_STYLES = ['solid', 'stripe', 'split'];
export const FIN_STYLE_LABELS = { solid: 'Solid', stripe: 'Stripe', split: 'Two-tone' };

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
  finShape:   'swept',
  finStyle:   'solid',
});

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
    finShape:   FIN_SHAPES.includes(src.finShape) ? src.finShape : DEFAULT_LIVERY.finShape,
    finStyle:   FIN_STYLES.includes(src.finStyle) ? src.finStyle : DEFAULT_LIVERY.finStyle,
  };
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
  return [l.fuselage, l.tail, l.engines, l.cheatline, l.style, l.titles, l.logoOnTail ? 1 : 0, l.titlesOn ? 1 : 0, l.logoOnFuselage ? 1 : 0, l.logoTile ? 1 : 0].join('|');
}
