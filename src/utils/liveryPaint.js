// Paints an airline livery onto a licensed all-white aircraft template.
//
// The template is a flattened PNG (white aircraft, grey shading, dark windows,
// transparent background — data/liveryTemplates.js). Recolouring is the
// classic "multiply over the white template" trick: a flat paint layer —
// fuselage colour, cheatline, fin colour, engines, titles, logo — is built from
// the template's part masks, then multiplied by the template per channel, so
// every highlight, panel line and shadow comes through in the new colour.
// Dark paints get a small specular lift so a navy fuselage keeps its sheen.
//
// Browser only (canvas). Nothing here runs on the server: LiveryPlane.jsx
// renders a placeholder during SSR and paints in an effect.

import { normalizeLivery } from '../data/livery.js';

const PART = { fuselage: 0, fin: 1, wing: 2, winglet: 3, engine: 4, stab: 5 };
const DRAW_ORDER = ['fin', 'wing', 'winglet', 'engine', 'stab'];   // lowest precedence first
const WING_GREY = '#dde2e8';

function hexRgb(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function tracePoly(ctx, pts, s) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x * s, y * s) : ctx.moveTo(x * s, y * s)));
  ctx.closePath();
}

// Part map per (template, width), cached: a Uint8Array of PART ids.
const partCache = new Map();
function partMap(spec, w, h, s) {
  const key = `${spec.id}@${w}`;
  const hit = partCache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  for (const name of DRAW_ORDER) {
    ctx.fillStyle = `rgb(${PART[name]},0,0)`;
    for (const p of spec.parts[name] ?? []) { tracePoly(ctx, p, s); ctx.fill(); }
  }
  const d = ctx.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = d[j + 3] ? d[j] : 0;
  if (partCache.size > 24) partCache.delete(partCache.keys().next().value);
  partCache.set(key, out);
  return out;
}

/** Draw the livery's style shapes (cheatline, swoosh …) into the paint layer. */
function drawStyle(p, livery, spec, s, w, h) {
  const b = spec.body;
  const X = x => x * s, Y = y => y * s;
  const fh = b.belly - b.crown;
  const wy = (b.windowTop + b.windowBottom) / 2;
  const L = b.tailX - b.noseX;
  switch (livery.style) {
    case 'classic':
      p.fillStyle = livery.cheatline;
      p.fillRect(0, Y(wy - 0.12 * fh), w, 0.26 * fh * s);
      p.fillStyle = livery.tail;
      p.fillRect(0, Y(wy - 0.17 * fh), w, 0.04 * fh * s);
      break;
    case 'belly': {
      const yb = b.crown + 0.56 * fh;
      const curve = () => {
        p.beginPath();
        p.moveTo(X(b.noseX - 50), Y(yb));
        p.lineTo(X(b.tailX - 2.6 * fh), Y(yb));
        p.bezierCurveTo(X(b.tailX - 1.4 * fh), Y(yb), X(b.tailX - 1.0 * fh), Y(b.crown - 0.2 * fh), X(b.tailX - 0.2 * fh), Y(b.crown - 0.9 * fh));
      };
      p.fillStyle = livery.cheatline;
      curve();
      p.lineTo(X(b.tailX + 300), Y(b.crown - 1.2 * fh));
      p.lineTo(X(b.tailX + 300), Y(b.belly + 400));
      p.lineTo(X(b.noseX - 50), Y(b.belly + 400));
      p.closePath(); p.fill();
      p.strokeStyle = livery.tail; p.lineWidth = 0.06 * fh * s;
      curve(); p.stroke();
      break;
    }
    case 'swoosh':
      p.fillStyle = livery.cheatline;
      p.beginPath();
      p.moveTo(X(b.noseX + 0.30 * L), Y(b.belly + 300));
      p.bezierCurveTo(X(b.noseX + 0.52 * L), Y(b.belly - 0.1 * fh), X(b.noseX + 0.68 * L), Y(b.crown + 0.35 * fh), X(b.tailX - 1.2 * fh), Y(b.crown - 0.7 * fh));
      p.lineTo(X(b.tailX + 300), Y(b.crown - 1.5 * fh));
      p.lineTo(X(b.tailX + 300), Y(b.belly + 300));
      p.closePath(); p.fill();
      p.strokeStyle = livery.tail; p.lineWidth = 0.09 * fh * s;
      p.beginPath();
      p.moveTo(X(b.noseX + 0.22 * L), Y(b.belly + 300));
      p.bezierCurveTo(X(b.noseX + 0.47 * L), Y(b.belly - 0.2 * fh), X(b.noseX + 0.64 * L), Y(b.crown + 0.2 * fh), X(b.tailX - 1.4 * fh), Y(b.crown - 0.8 * fh));
      p.stroke();
      break;
    case 'retro':
      p.fillStyle = '#c9cfd8';                                        // natural-metal belly
      p.fillRect(0, Y(b.crown + 0.62 * fh), w, h);
      p.fillStyle = livery.cheatline;                                 // window band
      p.fillRect(0, Y(wy - 0.16 * fh), w, 0.32 * fh * s);
      p.fillStyle = livery.tail;                                      // pinstripes
      p.fillRect(0, Y(wy - 0.2 * fh), w, 0.03 * fh * s);
      p.fillRect(0, Y(wy + 0.17 * fh), w, 0.03 * fh * s);
      break;
    case 'tail-wrap':
      p.fillStyle = livery.tail;
      p.beginPath();
      p.moveTo(X(b.tailX - 2.8 * fh), Y(b.crown - 2 * fh));
      p.bezierCurveTo(X(b.tailX - 2.6 * fh), Y(b.crown + 0.6 * fh), X(b.tailX - 1.6 * fh), Y(b.belly + 0.2 * fh), X(b.tailX - 0.4 * fh), Y(b.belly + 400));
      p.lineTo(X(b.tailX + 400), Y(b.belly + 400));
      p.lineTo(X(b.tailX + 400), Y(b.crown - 2 * fh));
      p.closePath(); p.fill();
      break;
    default: break;
  }
}

/**
 * Where the forward-fuselage logo and the airline name go, in template
 * coordinates. Without a body logo the name has the whole titles span; with
 * one, the logo takes the front of the span and the name starts after it.
 *   → { logo: { x, y, size } | null, x0, x1 }
 */
export function titlesLayout(spec, livery) {
  const t = spec.titles, f = spec.fuselageLogo;
  if (!livery?.logoOnFuselage || !f) return { logo: null, x0: t.x0, x1: t.x1 };
  return { logo: { x: t.x0, y: f.cy - f.size / 2, size: f.size }, x0: t.x0 + f.size + f.gap, x1: t.x1 };
}

/**
 * Paint a livery onto a template.
 *   template  { img: HTMLImageElement (decoded), spec }  — see loadLiveryTemplate
 *   livery    anything normalizeLivery accepts
 *   width     output width in px (height follows the template's aspect)
 *   titles    airline name for the fuselage ('' for none)
 *   logo      an image/canvas drawn on the fin when livery.logoOnTail, and
 *             on the forward fuselage when livery.logoOnFuselage
 *   bodyLogo  the fuselage's own version of it (a bare mark recoloured for
 *             the body paint); defaults to `logo`
 * Returns an HTMLCanvasElement.
 */
export function paintLivery(template, liveryIn, { width = 1200, titles = '', logo = null, bodyLogo = logo, fontFamily = 'Inter, system-ui, -apple-system, sans-serif' } = {}) {
  const { img, spec } = template;
  const livery = normalizeLivery(liveryIn, liveryIn?.tail);
  const s = width / spec.size[0];
  const w = Math.max(1, Math.round(spec.size[0] * s)), h = Math.max(1, Math.round(spec.size[1] * s));
  const b = spec.body;

  // 1. Template pixels at the working size.
  const tc = document.createElement('canvas'); tc.width = w; tc.height = h;
  const tctx = tc.getContext('2d', { willReadFrequently: true });
  tctx.drawImage(img, 0, 0, w, h);
  const td = tctx.getImageData(0, 0, w, h).data;

  // 2. Part ids.
  const parts = partMap(spec, w, h, s);

  // 3. Flat paint layer: base fuselage colour, style shapes, titles, then the
  // other parts' colours stamped in by part id, then the logo.
  const pc = document.createElement('canvas'); pc.width = w; pc.height = h;
  const p = pc.getContext('2d', { willReadFrequently: true });
  p.fillStyle = livery.fuselage; p.fillRect(0, 0, w, h);
  drawStyle(p, livery, spec, s, w, h);

  const name = livery.titlesOn ? String(titles ?? '').trim() : '';
  const lay = titlesLayout(spec, livery);
  if (name) {
    const band = (b.windowTop - b.crown) * s;
    const maxW = (lay.x1 - lay.x0) * s;
    let fs = band * 0.55;
    p.font = `700 ${fs}px ${fontFamily}`;
    const tw = p.measureText(name).width;
    if (tw > maxW) { fs *= maxW / tw; p.font = `700 ${fs}px ${fontFamily}`; }
    p.fillStyle = livery.titles;
    p.textBaseline = 'alphabetic';
    p.fillText(name, lay.x0 * s, b.crown * s + band * 0.38 + fs * 0.36);
  }

  const P = p.getImageData(0, 0, w, h);
  const pd = P.data;
  const finC = hexRgb(livery.tail), engC = hexRgb(livery.engines), wingC = hexRgb(WING_GREY);
  for (let i = 0, j = 0; i < parts.length; i++, j += 4) {
    const id = parts[i];
    if (id === PART.fin || id === PART.stab || id === PART.winglet) { pd[j] = finC[0]; pd[j + 1] = finC[1]; pd[j + 2] = finC[2]; }
    else if (id === PART.engine) { pd[j] = engC[0]; pd[j + 1] = engC[1]; pd[j + 2] = engC[2]; }
    else if (id === PART.wing) { pd[j] = wingC[0]; pd[j + 1] = wingC[1]; pd[j + 2] = wingC[2]; }
  }
  p.putImageData(P, 0, 0);
  if (logo && livery.logoOnTail && spec.logo) {
    const sz = spec.logo.size * s;
    if (sz >= 3) p.drawImage(logo, spec.logo.cx * s - sz / 2, spec.logo.cy * s - sz / 2, sz, sz);
  }
  if (bodyLogo && lay.logo) {
    const sz = lay.logo.size * s;
    if (sz >= 3) p.drawImage(bodyLogo, lay.logo.x * s, lay.logo.y * s, sz, sz);
  }
  const Pf = p.getImageData(0, 0, w, h).data;

  // 4. Multiply template × paint; lift the brightest template pixels on dark
  // paint so curved surfaces keep a sheen instead of going flat.
  const out = tctx.createImageData(w, h);
  const od = out.data;
  for (let j = 0; j < td.length; j += 4) {
    const a = td[j + 3];
    if (!a) continue;
    for (let k = 0; k < 3; k++) {
      const t = td[j + k] / 255, c = Pf[j + k] / 255;
      let v = t * c;
      if (t > 0.86) v += (1 - c) * ((t - 0.86) / 0.14) * 0.22;
      od[j + k] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
    }
    od[j + 3] = a;
  }
  const oc = document.createElement('canvas'); oc.width = w; oc.height = h;
  oc.getContext('2d').putImageData(out, 0, 0);
  return oc;
}

// ── Template loading (one decode per template, shared) ─────────────────────
const templateLoads = new Map();
export function loadLiveryTemplate(spec) {
  if (!templateLoads.has(spec.id)) {
    templateLoads.set(spec.id, new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => resolve({ img, spec });
      img.onerror = () => { templateLoads.delete(spec.id); reject(new Error(`Could not load livery template ${spec.url}`)); };
      img.src = spec.url;
    }));
  }
  return templateLoads.get(spec.id);
}

// ── Rasterising a logo for the fin ──────────────────────────────────────────
// `src` is a data URL / URL (uploaded logo) or an SVG markup string (a preset
// AirlineLogo rendered to static markup). Resolves to an Image, cached by src.
const logoLoads = new Map();

// SVG markup → data URL the browser will decode as an image. React's
// renderToStaticMarkup leaves the root <svg> without an xmlns, and a
// namespace-less SVG document is not an image: Image.onerror fires and the
// fin came out blank (reported the day the editor shipped). Add it when absent.
export function svgImageUrl(markup) {
  const m = String(markup).trimStart();
  const withNs = /^<svg\b[^>]*\sxmlns=/.test(m) ? m : m.replace(/^<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(withNs)}`;
}

export function loadLogoImage(src) {
  if (!src) return Promise.resolve(null);
  if (!logoLoads.has(src)) {
    logoLoads.set(src, new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      const svg = src.trimStart().startsWith('<svg');
      // A hosted logo (a rival's /logos/… URL, possibly on the API origin) must
      // load with CORS or drawing it would taint the canvas and break
      // getImageData; a route without the headers just yields no logo.
      if (!svg && !src.startsWith('data:')) img.crossOrigin = 'anonymous';
      img.src = svg ? svgImageUrl(src) : src;
    }));
    if (logoLoads.size > 64) logoLoads.delete(logoLoads.keys().next().value);
  }
  return logoLoads.get(src);
}

// ── Top-down globe sprite ───────────────────────────────────────────────────
// The globe's plane icon is a 64 px top-down airliner drawn from a path, not
// the template. Recolour it from the livery so the planes flying your routes
// match the paint: fuselage colour for the body, tail colour for the fin.
export function planeSpriteColors(livery) {
  const l = normalizeLivery(livery, livery?.tail);
  return { body: l.fuselage, fin: l.tail };
}
