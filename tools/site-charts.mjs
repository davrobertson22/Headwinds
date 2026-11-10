// site-charts.mjs
// Static SVG charts for the content pages, drawn from the game's own data at generation time.
// No client-side script: each mark carries a <title> for a native hover tooltip, and every
// chart sits beside the table it was drawn from. Colours are the site's dark theme; the two
// series colours were checked for colour-blind separation against the page background.

const C = {
  surface: '#1b1b1f',
  grid: '#2e2f36',
  axis: '#4a4b53',
  text: '#ededee',
  muted: '#a1a1aa',
};
export const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500'];
const FONT = "'IBM Plex Sans',system-ui,-apple-system,sans-serif";
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const r1 = (n) => Math.round(n * 10) / 10;
const textW = (s, size = 12) => String(s).length * size * 0.54;

function scale(min, max, count = 5) {
  if (max === min) max = min + 1;
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const lo = Math.floor(min / step + 1e-9) * step;
  const hi = Math.ceil(max / step - 1e-9) * step;
  const values = [];
  for (let v = lo; v <= hi + step / 2; v += step) values.push(Number(v.toPrecision(12)));
  return { lo, hi, values };
}

function frame({ width, height, label, body }) {
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}" font-family="${FONT}" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
}

function legend(series, x, y) {
  let dx = x;
  return series
    .map((s) => {
      const out = `<circle cx="${dx + 5}" cy="${y - 4}" r="5" fill="${s.color}"/><text x="${dx + 16}" y="${y}" font-size="12" fill="${C.muted}">${esc(s.label)}</text>`;
      dx += 16 + textW(s.label) + 22;
      return out;
    })
    .join('');
}

function axes({ m, w, h, xs, ys, xFmt, yFmt, xLabel, yLabel, px, py }) {
  let out = '';
  for (const v of ys.values) {
    out += `<line x1="${m.l}" x2="${m.l + w}" y1="${r1(py(v))}" y2="${r1(py(v))}" stroke="${v === ys.lo ? C.axis : C.grid}" stroke-width="1"/>`;
    out += `<text x="${m.l - 8}" y="${r1(py(v) + 4)}" font-size="11.5" fill="${C.muted}" text-anchor="end">${esc(yFmt(v))}</text>`;
  }
  for (const v of xs.values) {
    out += `<line x1="${r1(px(v))}" x2="${r1(px(v))}" y1="${m.t + h}" y2="${m.t + h + 5}" stroke="${C.axis}" stroke-width="1"/>`;
    out += `<text x="${r1(px(v))}" y="${m.t + h + 19}" font-size="11.5" fill="${C.muted}" text-anchor="middle">${esc(xFmt(v))}</text>`;
  }
  out += `<text x="${m.l + w / 2}" y="${m.t + h + 40}" font-size="12" fill="${C.muted}" text-anchor="middle">${esc(xLabel)}</text>`;
  out += `<text x="6" y="${m.t - 14}" font-size="12" fill="${C.muted}">${esc(yLabel)}</text>`;
  return out;
}

// points: [{ x, y, name, tip, series }] · series: [{ key, label, color }] · label: names to print on the chart
export function scatterChart({ label, points, series, xLabel, yLabel, xFmt = String, yFmt = String, xZero = true, yZero = true, labelNames = [], width = 760, height = 430 }) {
  const m = { l: 62, r: 24, t: series.length > 1 ? 66 : 36, b: 50 };
  const w = width - m.l - m.r;
  const h = height - m.t - m.b;
  const xv = points.map((p) => p.x);
  const yv = points.map((p) => p.y);
  const xs = scale(xZero ? 0 : Math.min(...xv), Math.max(...xv));
  const ys = scale(yZero ? 0 : Math.min(...yv), Math.max(...yv));
  const px = (v) => m.l + ((v - xs.lo) / (xs.hi - xs.lo)) * w;
  const py = (v) => m.t + h - ((v - ys.lo) / (ys.hi - ys.lo)) * h;
  const colorOf = Object.fromEntries(series.map((s) => [s.key, s.color]));

  let body = axes({ m, w, h, xs, ys, xFmt, yFmt, xLabel, yLabel, px, py });
  if (series.length > 1) body += legend(series, 6, 20);

  // Dots: series colour with a 2px ring in the page colour, so overlapping dots stay distinct.
  const dots = points.map((p) => ({ ...p, cx: px(p.x), cy: py(p.y) }));
  for (const d of dots) {
    body += `<circle cx="${r1(d.cx)}" cy="${r1(d.cy)}" r="5.5" fill="${colorOf[d.series]}" stroke="${C.surface}" stroke-width="2"><title>${esc(d.tip || d.name)}</title></circle>`;
  }

  // A few direct labels, each placed where it covers the fewest other dots and no other label.
  const placed = [];
  const hit = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
  for (const name of labelNames) {
    const d = dots.find((p) => p.name === name);
    if (!d) continue;
    const tw = textW(d.short || d.name);
    const options = [
      { anchor: 'start', x: d.cx + 9, y: d.cy + 4, x0: d.cx + 9, x1: d.cx + 9 + tw },
      { anchor: 'end', x: d.cx - 9, y: d.cy + 4, x0: d.cx - 9 - tw, x1: d.cx - 9 },
      { anchor: 'middle', x: d.cx, y: d.cy - 10, x0: d.cx - tw / 2, x1: d.cx + tw / 2 },
      { anchor: 'middle', x: d.cx, y: d.cy + 19, x0: d.cx - tw / 2, x1: d.cx + tw / 2 },
    ].map((o) => ({ ...o, y0: o.y - 11, y1: o.y + 3 }));
    let best = null;
    for (const o of options) {
      if (o.x0 < m.l + 2 || o.x1 > width - 4 || o.y0 < m.t - 6 || o.y1 > m.t + h - 2) continue;
      if (placed.some((p) => hit(o, p))) continue;
      const covered = dots.filter((p) => p !== d && p.cx > o.x0 - 5 && p.cx < o.x1 + 5 && p.cy > o.y0 - 5 && p.cy < o.y1 + 5).length;
      if (!best || covered < best.covered) best = { ...o, covered };
    }
    if (!best || best.covered > 2) continue;
    placed.push(best);
    body += `<text x="${r1(best.x)}" y="${r1(best.y)}" font-size="12" fill="${C.text}" text-anchor="${best.anchor}" paint-order="stroke" stroke="${C.surface}" stroke-width="3" stroke-linejoin="round">${esc(d.short || d.name)}</text>`;
  }
  return frame({ width, height, label, body });
}

// bars: [{ label, value, series, tip }] · horizontal, one baseline, value printed at the bar's end
export function barChart({ label, bars, series = [{ key: 'a', label: '', color: SERIES[0] }], valueFmt = String, xLabel = '', width = 760 }) {
  const row = 30;
  const labelW = Math.min(260, Math.max(...bars.map((b) => textW(b.label, 12.5))) + 14);
  const m = { l: labelW, r: 70, t: series.length > 1 ? 44 : 14, b: xLabel ? 34 : 12 };
  const w = width - m.l - m.r;
  const height = m.t + bars.length * row + m.b;
  const max = Math.max(...bars.map((b) => b.value));
  const colorOf = Object.fromEntries(series.map((s) => [s.key, s.color]));
  let body = series.length > 1 ? legend(series, m.l, 20) : '';
  body += `<line x1="${m.l}" x2="${m.l}" y1="${m.t}" y2="${m.t + bars.length * row}" stroke="${C.axis}" stroke-width="1"/>`;
  bars.forEach((b, i) => {
    const y = m.t + i * row + 6;
    const bw = Math.max(4, (b.value / max) * w);
    const bh = 18;
    body += `<text x="${m.l - 10}" y="${y + 13}" font-size="12.5" fill="${C.text}" text-anchor="end">${esc(b.label)}</text>`;
    body += `<path d="M${m.l} ${y}h${r1(bw - 4)}a4 4 0 0 1 4 4v${bh - 8}a4 4 0 0 1 -4 4H${m.l}Z" fill="${colorOf[b.series || series[0].key]}"><title>${esc(b.tip || `${b.label}: ${valueFmt(b.value)}`)}</title></path>`;
    body += `<text x="${r1(m.l + bw + 8)}" y="${y + 13}" font-size="12" fill="${C.muted}">${esc(valueFmt(b.value))}</text>`;
  });
  if (xLabel) body += `<text x="${m.l}" y="${height - 10}" font-size="12" fill="${C.muted}">${esc(xLabel)}</text>`;
  return frame({ width, height, label, body });
}

// lines: [{ label, color, points: [[x, y], ...] }] · reference: optional { label, points } drawn in grey
export function lineChart({ label, lines, reference, xLabel, yLabel, xFmt = String, yFmt = String, width = 760, height = 430 }) {
  const m = { l: 62, r: 96, t: 66, b: 50 };
  const w = width - m.l - m.r;
  const h = height - m.t - m.b;
  const all = [...lines, ...(reference ? [reference] : [])].flatMap((l) => l.points);
  const xs = scale(Math.min(...all.map((p) => p[0])), Math.max(...all.map((p) => p[0])), 6);
  const ys = scale(Math.min(...all.map((p) => p[1])), Math.max(...all.map((p) => p[1])));
  const px = (v) => m.l + ((v - xs.lo) / (xs.hi - xs.lo)) * w;
  const py = (v) => m.t + h - ((v - ys.lo) / (ys.hi - ys.lo)) * h;
  const path = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${r1(px(p[0]))} ${r1(py(p[1]))}`).join('');
  let body = axes({ m, w, h, xs, ys, xFmt, yFmt, xLabel, yLabel, px, py });
  body += legend(lines.map((l) => ({ label: l.label, color: l.color })).concat(reference ? [{ label: reference.label, color: C.axis }] : []), 6, 20);
  if (reference) body += `<path d="${path(reference.points)}" fill="none" stroke="${C.axis}" stroke-width="2" stroke-linecap="round"/>`;
  // End labels, nudged apart so they never sit on top of each other.
  const ends = lines.map((l) => ({ l, y: py(l.points[l.points.length - 1][1]) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;
  for (const l of lines) {
    body += `<path d="${path(l.points)}" fill="none" stroke="${l.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><title>${esc(l.label)}</title></path>`;
    const last = l.points[l.points.length - 1];
    body += `<circle cx="${r1(px(last[0]))}" cy="${r1(py(last[1]))}" r="4.5" fill="${l.color}" stroke="${C.surface}" stroke-width="2"/>`;
    const e = ends.find((x) => x.l === l);
    body += `<text x="${r1(px(last[0]) + 10)}" y="${r1(e.y + 4)}" font-size="12" fill="${C.text}">${esc(l.endLabel || l.label)}</text>`;
  }
  return frame({ width, height, label, body });
}

// The CSS every page with a chart needs (kept here so generators and hand pages agree).
export const CHART_CSS = `
    figure.chart { margin:8px 0 32px; }
    figure.chart .chartwrap { overflow-x:auto; border:1px solid var(--line); border-radius:10px; background:var(--bg); padding:14px 10px 6px; }
    figure.chart svg.chart { display:block; width:100%; min-width:620px; height:auto; }
    figure.chart figcaption { color:var(--muted); font-size:0.9rem; line-height:1.55; margin-top:10px; }`;
