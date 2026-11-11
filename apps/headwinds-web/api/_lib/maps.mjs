// Maps and small charts for the public world pages, as inline SVG strings.
// ----------------------------------------------------------------------------
// The basemap is the game's own self-hosted NASA Blue Marble tiles
// (/tiles/bluemarble/{z}/{x}/{y}.jpg, Web Mercator — src/components/mapCore.js),
// laid under the overlay as <image> elements. Every map on the site reuses the
// same handful of tile URLs, so the browser fetches them once.
//
// PURE: airports are looked up through an injected `getAirport(code)`; a map
// with no lookup (the engine could not be loaded) renders as nothing rather
// than failing the page.
import { finSvg, mapColorOf } from './brand.mjs';

const TILE = 256;
const TILE_PATH = (z, x, y) => `/tiles/bluemarble/${z}/${x}/${y}.jpg`;
const ASPECT = 1024 / 535;            // every map is drawn at this shape
const MAX_LAT = 75, MIN_LAT = -58;    // the inhabited band; the poles are cropped
const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const rad = (d) => (d * Math.PI) / 180;
const f1 = (n) => (Math.round(n * 10) / 10).toString();

/** lon/lat → Web Mercator, normalised so the whole world is the unit square. */
export function project(lon, lat) {
  const phi = rad(Math.max(-85, Math.min(85, lat)));
  return { x: (lon + 180) / 360, y: (1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2 };
}
const Y_TOP = project(0, MAX_LAT).y, Y_BOT = project(0, MIN_LAT).y;

/** Points along the great circle between two airports (lon/lat degrees), ends included. */
export function greatCircle(a, b, maxSeg = 24) {
  const [la1, lo1, la2, lo2] = [rad(a.lat), rad(a.lon), rad(b.lat), rad(b.lon)];
  const d = 2 * Math.asin(Math.sqrt(Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2));
  if (!(d > 1e-6)) return [a, b];
  const n = Math.max(2, Math.min(maxSeg, Math.ceil((d * 180) / Math.PI / 6)));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(la1) * Math.cos(lo1) + B * Math.cos(la2) * Math.cos(lo2);
    const y = A * Math.cos(la1) * Math.sin(lo1) + B * Math.cos(la2) * Math.sin(lo2);
    const z = A * Math.sin(la1) + B * Math.sin(la2);
    pts.push({ lat: (Math.atan2(z, Math.hypot(x, y)) * 180) / Math.PI, lon: (Math.atan2(y, x) * 180) / Math.PI });
  }
  return pts;
}

/**
 * The frame a set of airports is drawn in: a zoom level, the view box in that
 * zoom's pixels, and `at(lon, lat)` → a point in it.
 *
 * A network that spans most of the globe gets the whole inhabited world,
 * re-centred on `centerLon` (its main hub) so a Pacific network is not cut in
 * half at the date line. A regional one is zoomed to its own extent.
 */
export function frameFor(points, { centerLon = 0 } = {}) {
  // x relative to the centre longitude, wrapped into [-0.5, 0.5).
  const cx = (centerLon + 180) / 360;
  const rel = (lon) => ((((lon + 180) / 360 - cx + 0.5) % 1) + 1) % 1 - 0.5;
  const pts = points.map((p) => ({ x: rel(p.lon), y: project(p.lon, p.lat).y }));
  let x0 = -0.5, x1 = 0.5, y0 = Y_TOP, y1 = Y_BOT;
  if (pts.length > 0) {
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
    if (w < 0.55 && h < (Y_BOT - Y_TOP) * 0.8) {
      // Regional: pad the extent, then grow one side to the map's shape.
      const pad = Math.max(0.015, Math.max(w, h * ASPECT) * 0.12);
      let bw = Math.max(0.09, w + 2 * pad), bh = Math.max(0.09 / ASPECT, h + 2 * pad / ASPECT);
      if (bw / bh < ASPECT) bw = bh * ASPECT; else bh = bw / ASPECT;
      const mx = (Math.max(...xs) + Math.min(...xs)) / 2, my = (Math.max(...ys) + Math.min(...ys)) / 2;
      x0 = mx - bw / 2; x1 = mx + bw / 2;
      y0 = Math.max(0.02, Math.min(0.98 - bh, my - bh / 2)); y1 = y0 + bh;
    }
  }
  // The deepest zoom whose view is still no more than ~1400 px of tiles wide.
  const z = Math.max(2, Math.min(5, Math.floor(Math.log2(1400 / (TILE * (x1 - x0))))));
  const S = TILE * 2 ** z;
  return {
    z, S, cx,
    view: { x: x0 * S, y: y0 * S, w: (x1 - x0) * S, h: (y1 - y0) * S },
    rel,
    at: (lon, lat) => ({ x: rel(lon) * S, y: project(lon, lat).y * S }),
  };
}

/** The basemap tiles under a frame, and a wash that lets the overlay read. */
function basemap(frame) {
  const { z, S, cx, view } = frame;
  const n = 2 ** z;
  const out = [];
  // Frame x is relative to the centre; absolute world x = frame x + cx·S.
  const ax0 = view.x + cx * S, ax1 = ax0 + view.w;
  for (let tx = Math.floor(ax0 / TILE); tx <= Math.floor((ax1 - 0.01) / TILE); tx++) {
    for (let ty = Math.max(0, Math.floor(view.y / TILE)); ty <= Math.min(n - 1, Math.floor((view.y + view.h - 0.01) / TILE)); ty++) {
      const wrapped = ((tx % n) + n) % n;
      out.push(`<image href="${TILE_PATH(z, wrapped, ty)}" x="${f1(tx * TILE - cx * S)}" y="${ty * TILE}" width="${TILE + 0.6}" height="${TILE + 0.6}"/>`);
    }
  }
  out.push(`<rect x="${f1(view.x)}" y="${f1(view.y)}" width="${f1(view.w)}" height="${f1(view.h)}" fill="#0b0e13" opacity="0.5"/>`);
  return out.join('');
}

const open = (frame, label) => {
  const v = frame.view;
  return `<svg class="map" viewBox="${f1(v.x)} ${f1(v.y)} ${f1(v.w)} ${f1(v.h)}" role="img" aria-label="${esc(label)}" preserveAspectRatio="xMidYMid slice">`
    + `<rect x="${f1(v.x)}" y="${f1(v.y)}" width="${f1(v.w)}" height="${f1(v.h)}" fill="#0d1620"/>`;
};

/**
 * Where every airline in a world is based: a dot at each hub (sized by fleet,
 * in the airline's colour) and the tail fin of the leading airlines.
 *   rows   stripped standings rows (rank order)
 *   ctx    { getAirport, brand, apiOrigin }
 *   linkOf (row) → href for the fin, or null
 */
export function hubMapSvg(rows, ctx = {}, { fins = 12, linkOf = () => null, label = 'Map of airline hubs' } = {}) {
  const { getAirport } = ctx;
  if (typeof getAirport !== 'function') return '';
  const placed = rows.map((a) => ({ a, ap: getAirport(a.hub) })).filter((p) => p.ap && Number.isFinite(p.ap.lat) && Number.isFinite(p.ap.lon));
  if (placed.length === 0) return '';
  const frame = frameFor([], {});             // always the whole world: hubs are everywhere
  const unit = frame.view.w / 1024;           // 1 "px" at the map's nominal width
  const seen = new Map();                     // airlines sharing a hub fan out sideways
  const dots = [], tails = [];
  for (const { a, ap } of placed) {
    const p = frame.at(ap.lon, ap.lat);
    const k = seen.get(a.hub) ?? 0; seen.set(a.hub, k + 1);
    const r = (2.6 + Math.min(6, Math.sqrt(Math.max(0, a.fleet ?? 0)) / 5)) * unit;
    const title = `${a.name} — ${a.hub}, ${a.fleet ?? 0} aircraft`;
    dots.push(`<circle cx="${f1(p.x + k * 5 * unit)}" cy="${f1(p.y)}" r="${f1(r)}" fill="${mapColorOf(a, ctx.brand)}" fill-opacity="0.85" stroke="#0b0e13" stroke-width="${f1(0.8 * unit)}"><title>${esc(title)}</title></circle>`);
  }
  // Fins for the leaders, drawn last so they sit on top; the best-ranked on top of all.
  const seenFin = new Map();
  for (const { a, ap } of placed.slice(0, fins).reverse()) {
    const p = frame.at(ap.lon, ap.lat);
    const k = seenFin.get(a.hub) ?? 0; seenFin.set(a.hub, k + 1);
    const h = 26 * unit, w = h * 1.291;
    const fin = finSvg(a, { height: 26, uid: `hm${a.id ?? a.rank}`, apiOrigin: ctx.apiOrigin, brand: ctx.brand, title: `${a.name} — hub ${a.hub}` })
      .replace(/^<svg /, `<svg x="${f1(p.x - w / 2 + k * 16 * unit)}" y="${f1(p.y - h - 3 * unit)}" `)
      .replace(/width="\d+" height="\d+"/, `width="${f1(w)}" height="${f1(h)}"`);
    const href = linkOf(a);
    tails.push(href ? `<a href="${esc(href)}">${fin}</a>` : fin);
  }
  return `${open(frame, label)}${basemap(frame)}${dots.join('')}${tails.join('')}</svg>`;
}

/**
 * One airline's passenger network: great-circle arcs, heavier where it flies
 * more often, with its hubs marked and named.
 *   routes  [{ origin, destination, weeklyFrequency }]
 *   hubs    airport codes
 *   ctx     { getAirport }
 * Returns { svg, drawn, total } — `drawn` < `total` when the busiest routes
 * were kept and the long tail left off (a 1,700-route network is a solid blob
 * and a megabyte of markup).
 */
export function routeMapSvg(routes, hubs, ctx = {}, { color = '#5fe0cc', max = 350, label = 'Route network map' } = {}) {
  const { getAirport } = ctx;
  if (typeof getAirport !== 'function') return { svg: '', drawn: 0, total: routes.length };
  const ok = (ap) => ap && Number.isFinite(ap.lat) && Number.isFinite(ap.lon);
  const legs = routes.map((r) => ({ r, o: getAirport(r.origin), d: getAirport(r.destination) })).filter((l) => ok(l.o) && ok(l.d));
  if (legs.length === 0) return { svg: '', drawn: 0, total: routes.length };
  legs.sort((a, b) => (b.r.weeklyFrequency ?? 0) - (a.r.weeklyFrequency ?? 0));
  // Too many to draw: keep the busiest AND the longest. The busiest alone are
  // all short hops round the hub, and the map would not show how far the
  // airline actually reaches.
  let kept = legs;
  if (legs.length > max) {
    const busy = legs.slice(0, Math.ceil(max * 0.55));
    const far = legs.slice(busy.length)
      .map((l) => ({ l, d: (l.o.lat - l.d.lat) ** 2 + (((l.o.lon - l.d.lon + 540) % 360) - 180) ** 2 }))
      .sort((a, b) => b.d - a.d).slice(0, max - busy.length).map((x) => x.l);
    kept = [...busy, ...far];
  }
  // Hubs, busiest first — the map is centred on the one most routes touch.
  const touches = new Map();
  for (const l of legs) { touches.set(l.o.code, (touches.get(l.o.code) ?? 0) + 1); touches.set(l.d.code, (touches.get(l.d.code) ?? 0) + 1); }
  const hubAps = hubs.map((c) => getAirport(c)).filter(ok).sort((a, b) => (touches.get(b.code) ?? 0) - (touches.get(a.code) ?? 0));
  const airports = new Map();
  for (const l of kept) { airports.set(l.o.code, l.o); airports.set(l.d.code, l.d); }
  for (const h of hubAps) airports.set(h.code, h);
  const frame = frameFor([...airports.values()], { centerLon: hubAps[0]?.lon ?? kept[0].o.lon });
  const unit = frame.view.w / 1024;

  const arcs = kept.map(({ r, o, d }) => {
    const pts = greatCircle(o, d).map((p) => frame.at(p.lon, p.lat));
    // Break the path where it wraps round the back of the map.
    let dstr = '';
    pts.forEach((p, i) => {
      const jump = i > 0 && Math.abs(p.x - pts[i - 1].x) > frame.S / 2;
      dstr += `${i === 0 || jump ? 'M' : 'L'}${f1(p.x)} ${f1(p.y)}`;
    });
    const w = (0.7 + Math.min(2.2, (r.weeklyFrequency ?? 0) / 14)) * unit;
    return `<path d="${dstr}" stroke-width="${f1(w)}"/>`;
  }).join('');
  const hubSet = new Set(hubAps.map((h) => h.code));
  const dots = [...airports.values()].filter((ap) => !hubSet.has(ap.code)).map((ap) => {
    const p = frame.at(ap.lon, ap.lat);
    return `<circle cx="${f1(p.x)}" cy="${f1(p.y)}" r="${f1(1.5 * unit)}"/>`;
  }).join('');
  const hubMarks = hubAps.map((ap) => {
    const p = frame.at(ap.lon, ap.lat);
    return `<circle cx="${f1(p.x)}" cy="${f1(p.y)}" r="${f1(5 * unit)}" fill="${color}" stroke="#fff" stroke-width="${f1(1.4 * unit)}"><title>${esc(`${ap.code} — ${ap.city ?? ap.name ?? ''} (hub)`)}</title></circle>`
      + `<text x="${f1(p.x + 8 * unit)}" y="${f1(p.y + 4 * unit)}" font-size="${f1(13 * unit)}" font-weight="700" fill="#fff" stroke="#0b0e13" stroke-width="${f1(3 * unit)}" paint-order="stroke" font-family="system-ui,sans-serif">${esc(ap.code)}</text>`;
  }).join('');
  const svg = `${open(frame, label)}${basemap(frame)}`
    + `<g fill="none" stroke="${color}" stroke-opacity="0.6" stroke-linecap="round">${arcs}</g>`
    + `<g fill="#fff" fill-opacity="0.8">${dots}</g>${hubMarks}</svg>`;
  return { svg, drawn: kept.length, total: routes.length };
}

/**
 * Rank over time, #1 at the top.
 *   history  [{ week, rank }] oldest first
 *   label    (linearWeek) → "Y3 W12"
 */
export function rankChartSvg(history, { total = null, label = (w) => `W${w}`, color = '#5fe0cc' } = {}) {
  const pts = (history ?? []).filter((h) => Number.isFinite(h.week) && Number.isFinite(h.rank));
  if (pts.length < 2) return '';
  const W = 640, H = 150, L = 34, R = 14, T = 14, B = 24;
  const worst = Math.max(...pts.map((p) => p.rank), Math.min(total ?? 5, 5));
  const w0 = pts[0].week, w1 = pts[pts.length - 1].week;
  const x = (w) => L + ((w - w0) / Math.max(1, w1 - w0)) * (W - L - R);
  const y = (r) => T + ((r - 1) / Math.max(1, worst - 1)) * (H - T - B);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${f1(x(p.week))} ${f1(y(p.rank))}`).join('');
  const ticks = [...new Set([1, Math.ceil(worst / 2), worst])].map((r) =>
    `<line x1="${L}" x2="${W - R}" y1="${f1(y(r))}" y2="${f1(y(r))}" stroke="#263143"/><text x="${L - 6}" y="${f1(y(r) + 4)}" text-anchor="end">#${r}</text>`).join('');
  const last = pts[pts.length - 1];
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Rank over the last ${pts.length} weeks: from #${pts[0].rank} to #${last.rank}">`
    + `<g font-size="11" fill="#8b98ab" font-family="system-ui,sans-serif">${ticks}`
    + `<text x="${L}" y="${H - 6}">${esc(label(w0))}</text><text x="${W - R}" y="${H - 6}" text-anchor="end">${esc(label(w1))}</text></g>`
    + `<path d="${line}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`
    + `<circle cx="${f1(x(last.week))}" cy="${f1(y(last.rank))}" r="4.5" fill="${color}" stroke="#0b0e13" stroke-width="2"/></svg>`;
}
