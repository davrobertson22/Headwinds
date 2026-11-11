// Airline logos and tail fins as SVG strings, for the public world pages.
// ----------------------------------------------------------------------------
// The artwork itself is generated from the game's own components
// (brandMarks.mjs ← tools/generate-brand-marks.mjs); this file only composes
// it the way src/components/AirlineLogo.jsx and TailFin.jsx do: which colour
// the mark takes, whether it sits on a tile, where it goes on the fin.
//
// PURE and string-only. Everything that came from a player — colours, logo
// ids, upload paths — is validated against a strict pattern before it reaches
// the markup; anything else falls back to the default look.
import { LOGO_MARKS, FIN, TAIL_DESIGN_MARKUP } from './brandMarks.mjs';

const HEX = /^#[0-9a-f]{6}$/i;
const DEFAULT_ACCENT = '#1e9bff';
const TILE_TOP = '#2b3441', TILE_BOT = '#151a22', UPLOAD_TILE = '#15202f';
const MARK_LIGHT = '#f5f7fa', MARK_DARK = '#15202f';
// An uploaded logo or tail, as the API hands it out: /logos/<cuid>?v=<hash>.
const UPLOAD_PATH = /^\/(logos|tails)\/[a-z0-9]{8,64}\?v=[a-f0-9]{6,32}$/i;

export const hexOr = (v, fallback) => (typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : fallback);
const safeId = (v) => String(v ?? 'x').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'x';
const attr = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The absolute URL of an uploaded logo/tail, or null when the path is not one. */
export function uploadUrl(apiOrigin, p) {
  return typeof p === 'string' && UPLOAD_PATH.test(p) && apiOrigin ? `${apiOrigin}${p}` : null;
}

// ── Fallbacks for the two engine helpers ─────────────────────────────────────
// The handler passes the engine's own normalizeLivery / markColorOn
// (ctx.brand). These stand in when it could not be loaded, so a page still
// draws a sensible fin rather than none.
const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
export const contrast = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
function fallbackLivery(raw, accent) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const acc = hexOr(accent, DEFAULT_ACCENT);
  return {
    fuselage: hexOr(src.fuselage, '#f5f7fa'), tail: hexOr(src.tail, acc), cheatline: hexOr(src.cheatline, acc),
    logoOnTail: src.logoOnTail !== false, logoTile: src.logoTile === true,
    tailDesign: Object.hasOwn(TAIL_DESIGN_MARKUP, src.tailDesign) ? src.tailDesign : 'solid',
  };
}
function fallbackMarkColorOn(bg, accent) {
  const acc = hexOr(accent, DEFAULT_ACCENT);
  if (!HEX.test(bg ?? '')) return acc;
  if (contrast(acc, bg) >= 3) return acc;
  return contrast(MARK_LIGHT, bg) >= 2.5 ? MARK_LIGHT : MARK_DARK;
}

// ── The square logo ──────────────────────────────────────────────────────────
// `r` is the corner radius on the 40-unit box; `bg` is a hex, null (the shared
// greyscale tile) or 'none' (bare mark). `href` is an uploaded image.
function logoInner({ id, color, bg, href, r, uid }) {
  if (href) {
    const tile = bg === 'none' ? '' : `<rect width="40" height="40" rx="${r}" fill="${hexOr(bg, UPLOAD_TILE)}"/>`;
    return `<defs><clipPath id="c-${uid}"><rect width="40" height="40" rx="${r}"/></clipPath></defs>${tile}`
      + `<image href="${attr(href)}" width="40" height="40" preserveAspectRatio="xMidYMid slice" clip-path="url(#c-${uid})"/>`;
  }
  const mark = LOGO_MARKS[Object.hasOwn(LOGO_MARKS, id) ? id : 'compass']
    .split('{C}').join(hexOr(color, DEFAULT_ACCENT)).split('{G}').join(`m-${uid}-`);
  if (bg === 'none') return mark;
  if (HEX.test(bg ?? '')) return `<rect width="40" height="40" rx="${r}" fill="${bg.toLowerCase()}"/>${mark}`;
  return `<defs><linearGradient id="g-${uid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${TILE_TOP}"/><stop offset="100%" stop-color="${TILE_BOT}"/></linearGradient></defs>`
    + `<rect width="40" height="40" rx="${r}" fill="url(#g-${uid})"/>${mark}`;
}

/**
 * An airline's square logo tile.
 *   a     a standings row (logoId, logoColor, logoBg, customLogo)
 *   opts  size (px), uid (unique on the page), apiOrigin (for uploads),
 *         hrefOf (url → url; the share card swaps in embedded data URLs)
 */
export function logoSvg(a, { size = 22, uid, apiOrigin = '', hrefOf = (u) => u, className = 'logo' } = {}) {
  const id = safeId(uid ?? a?.id);
  const up = uploadUrl(apiOrigin, a?.customLogo);
  const inner = logoInner({
    id: a?.logoId, color: a?.logoColor, bg: a?.logoBg ?? null, href: up ? hrefOf(up) : null,
    r: 8, uid: id,
  });
  return `<svg class="${className}" width="${size}" height="${size}" viewBox="0 0 40 40" aria-hidden="true">${inner}</svg>`;
}

/**
 * An airline's tail fin — the same drawing as the game's TailFin: the livery's
 * tail colour, one of the designs in the accent colour, and the logo (or an
 * uploaded tail) clipped to the silhouette.
 *   brand  { normalizeLivery, markColorOn } from the engine, when loaded
 */
export function finSvg(a, { height = 48, uid, apiOrigin = '', hrefOf = (u) => u, brand = null, title = null, className = 'fin', xmlns = false, uploads = true } = {}) {
  const id = safeId(uid ?? a?.id);
  const normalizeLivery = brand?.normalizeLivery ?? fallbackLivery;
  const markColorOn = brand?.markColorOn ?? fallbackMarkColorOn;
  const raw = a?.livery && typeof a.livery === 'object' && !Array.isArray(a.livery) ? a.livery : {};
  const l = normalizeLivery(raw, a?.logoColor);
  const tailCol = hexOr(l.tail, DEFAULT_ACCENT);
  const fuselage = hexOr(l.fuselage, '#f5f7fa');
  const cheat = hexOr(l.cheatline, tailCol);
  const accent = cheat !== tailCol ? cheat : fuselage;
  const design = Object.hasOwn(TAIL_DESIGN_MARKUP, l.tailDesign) ? l.tailDesign : 'solid';

  const tailUp = uploadUrl(apiOrigin, a?.customTail);
  const logoUp = uploadUrl(apiOrigin, a?.customLogo);
  const showMark = !tailUp && l.logoOnTail !== false && !FIN.logoFree.includes(design);
  const tile = Boolean(logoUp) || l.logoTile === true;

  // `uploads: false` leaves an uploaded tail or logo OUT of the drawing (the
  // share card lays those over the fin itself — finLayout() says where).
  const paint = tailUp && !uploads ? '' : tailUp
    ? `<image href="${attr(hrefOf(tailUp))}" x="0" y="0" width="${FIN.w}" height="${FIN.h}" preserveAspectRatio="xMidYMid slice"/>`
    : TAIL_DESIGN_MARKUP[design].split('{A}').join(accent).split('{F}').join(fuselage);
  const mark = showMark && (uploads || !logoUp)
    ? `<g transform="translate(${FIN.logo.x} ${FIN.logo.y})"><svg width="${FIN.logo.size}" height="${FIN.logo.size}" viewBox="0 0 40 40">${logoInner({
        id: a?.logoId,
        color: tile ? a?.logoColor : markColorOn(tailCol, a?.logoColor),
        bg: tile ? (a?.logoBg ?? null) : 'none',
        href: logoUp ? hrefOf(logoUp) : null,
        r: 20, uid: `f${id}`,
      })}</svg></g>`
    : '';
  const width = Math.round(height * (FIN.w / FIN.h));
  return `<svg${xmlns ? ' xmlns="http://www.w3.org/2000/svg"' : ''} class="${className}" width="${width}" height="${height}" viewBox="0 0 ${FIN.w} ${FIN.h}" ${title ? `role="img" aria-label="${attr(title)}"` : 'aria-hidden="true"'}>`
    + (title ? `<title>${attr(title)}</title>` : '')
    + `<defs><clipPath id="fin-${id}"><path d="${FIN.path}"/></clipPath></defs>`
    + `<g clip-path="url(#fin-${id})"><rect x="0" y="0" width="${FIN.w}" height="${FIN.h}" fill="${tailCol}"/>${paint}${mark}</g>`
    + `<path d="${FIN.path}" fill="none" stroke="${FIN.outline.stroke}" stroke-width="${FIN.outline.width}" stroke-linejoin="round"/></svg>`;
}

/** The colour to draw an airline's routes and dots in: its tail colour, kept readable on the dark map. */
export function mapColorOf(a, brand = null) {
  const raw = a?.livery && typeof a.livery === 'object' && !Array.isArray(a.livery) ? a.livery : {};
  const l = (brand?.normalizeLivery ?? fallbackLivery)(raw, a?.logoColor);
  const c = hexOr(l.tail, hexOr(a?.logoColor, DEFAULT_ACCENT));
  // A navy or black tail vanishes on the night-side map: fall back to the logo colour, then to teal.
  if (lum(c) >= 0.12) return c;
  const alt = hexOr(a?.logoColor, '#5fe0cc');
  return lum(alt) >= 0.12 ? alt : '#5fe0cc';
}

/**
 * Where an airline's uploads go on its fin, for a caller that draws them
 * itself over `finSvg(…, { uploads: false })`: the uploaded tail covers the
 * whole box; the uploaded logo sits in a round tile at `logoBox`. All in the
 * fin's own units (FIN.w × FIN.h); `outside` is the box minus the silhouette,
 * to paint over whatever spills past the edge.
 */
export function finLayout(a, { apiOrigin = '', brand = null } = {}) {
  const raw = a?.livery && typeof a.livery === 'object' && !Array.isArray(a.livery) ? a.livery : {};
  const l = (brand?.normalizeLivery ?? fallbackLivery)(raw, a?.logoColor);
  const design = Object.hasOwn(TAIL_DESIGN_MARKUP, l.tailDesign) ? l.tailDesign : 'solid';
  const tailUp = uploadUrl(apiOrigin, a?.customTail);
  const logoUp = uploadUrl(apiOrigin, a?.customLogo);
  return {
    w: FIN.w, h: FIN.h,
    tail: tailUp,
    logo: !tailUp && logoUp && l.logoOnTail !== false && !FIN.logoFree.includes(design) ? logoUp : null,
    logoBox: { ...FIN.logo },
    tile: hexOr(a?.logoBg, UPLOAD_TILE),
    outside: `M0 0H${FIN.w}V${FIN.h}H0Z ${FIN.path}`,
  };
}
