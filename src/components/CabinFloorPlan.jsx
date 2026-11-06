import { useMemo, useRef, useState } from 'react';
import { planformFor, planformGeometry, cabinLayout, paintStroke, dragDivider, dividers, unitsToConfig } from '../utils/planform.js';

// The cabin, drawn inside the aircraft it belongs to: a top-down cutaway with
// the roof lifted off. The airframe comes from utils/planform.js (real length,
// span and fuselage width per type); the cabin from the same floor units the
// engine prices, so every seat in the config is on the picture and each cabin's
// length is its share of the floor.
//
//   type     aircraft type (getAircraftType)
//   config   { firstClass, businessClass, premiumEconomy, economy }
//   livery   normalised livery (liveryFor(state)) — skin, fin and engine colours
//   maxSeats floor in economy-seat units (defaults to type.seats)
//   editable { brush, onChange(config) } — paint the cabin: a stroke along
//            the fuselage converts the floor under it to `brush` (a class key
//            or 'empty'); the dividers between cabins drag. Every stroke is
//            resolved by paintStroke/unitsToConfig (utils/planform.js) against
//            the layout as it stood when the pointer went down, so a long drag
//            is one stroke, not a drift of rounded steps.
//   orientation 'horizontal' (nose left) or 'vertical' (nose up, for phones)

export const CABIN_COLORS = {
  firstClass:     '#bc8cff',
  businessClass:  '#ffb43d',
  premiumEconomy: '#3ea6ff',
  economy:        '#38d39f',
};

const WING    = '#c4c9d1';
const FLOOR   = '#262a30';
const GALLEY  = '#3a3f48';
const GLASS   = '#2a3848';

function rgb(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [240, 241, 243];
}
/** Lighten (k > 1) or darken (k < 1) a hex colour. Lightening heads for white. */
export function shade(hex, k) {
  const c = rgb(hex).map(v => (k >= 1 ? v + (255 - v) * (k - 1) : v * k));
  return `#${c.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
}

const r3 = (n) => Math.round(n * 1000) / 1000;
// A rounded rectangle as path data, for the seat paths (one per class).
function roundRect(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  return `M${r3(x + r)} ${r3(y)}h${r3(w - 2 * r)}a${r3(r)} ${r3(r)} 0 0 1 ${r3(r)} ${r3(r)}v${r3(h - 2 * r)}a${r3(r)} ${r3(r)} 0 0 1 ${r3(-r)} ${r3(r)}h${r3(2 * r - w)}a${r3(r)} ${r3(r)} 0 0 1 ${r3(-r)} ${r3(-r)}v${r3(2 * r - h)}a${r3(r)} ${r3(r)} 0 0 1 ${r3(r)} ${r3(-r)}z`;
}

const line = { vectorEffect: 'non-scaling-stroke' };

export default function CabinFloorPlan({ type, config, livery, maxSeats, maxHeight = 'min(64vh, 560px)', className, style, editable = null, orientation = 'horizontal' }) {
  const geom = useMemo(() => planformGeometry(planformFor(type)), [type?.id]);
  const floor = maxSeats ?? type?.seats ?? 0;
  const layout = useMemo(
    () => cabinLayout(config ?? {}, floor, geom),
    [geom, floor, config?.firstClass, config?.businessClass, config?.premiumEconomy, config?.economy],
  );
  const planeRef = useRef(null);
  const drag = useRef(null);
  const [hover, setHover] = useState(null);
  if (!type) return null;

  const { spec, extent, R } = geom;
  const vertical = orientation === 'vertical';
  const skin   = livery?.fuselage ?? '#f4f5f7';
  const fin    = livery?.tail ?? '#3ea6ff';
  const engine = livery?.engines ?? skin;
  const ink    = shade(skin, 0.42);         // outlines, in the skin's own family
  const wingInk = shade(WING, 0.5);
  const upper  = layout.decks.find(d => d.separate);

  // The upper deck is drawn as its own plan below the aircraft.
  const deckGap = spec.D * 1.1;
  const upperY  = upper ? extent.halfH + deckGap + spec.D * 0.5 : 0;
  const vbW = extent.xMax - extent.xMin;
  const vbTop = -extent.halfH;
  const vbH = extent.halfH * 2 + (upper ? deckGap + spec.D * 1.25 : 0);
  const fontM = (vbW / 600) * 11;   // ≈ 11 px at a 600 px render
  const sw = vbW / 900;             // hairline, in metres, at a typical render

  const id = `cfp-${spec.id ?? 'x'}`;
  const seatPaths = (deckId) => {
    const by = {};
    for (const s of layout.seats) {
      if (s.deck !== deckId) continue;
      const b = (by[s.cls] ??= { body: [], back: [], n: 0 });
      const back = s.w * 0.26;
      const r = Math.min(s.h, s.w) * 0.18;
      b.body.push(roundRect(s.x, s.y, s.w - back + r, s.h, r));
      b.back.push(roundRect(s.x + s.w - back, s.y + s.h * 0.06, back, s.h * 0.88, r * 0.8));
      b.n++;
    }
    return Object.entries(by).map(([cls, p]) => (
      <g key={cls} data-cabin={cls} data-seats={p.n}>
        <path d={p.body.join('')} fill={CABIN_COLORS[cls]} />
        <path d={p.back.join('')} fill={shade(CABIN_COLORS[cls], 0.55)} />
      </g>
    ));
  };

  const cabin = (deck, yOff) => {
    const halfW = deck.width / 2;
    const zones = layout.zones.filter(z => z.deck === deck.id);
    const galleys = layout.galleys.filter(g => g.deck === deck.id);
    return (
      <g transform={yOff ? `translate(0 ${yOff})` : undefined}>
        <rect x={deck.x0} y={-halfW} width={deck.x1 - deck.x0} height={deck.width} fill={FLOOR} />
        {/* the cabin floor is lit from the centreline, like the fuselage */}
        <rect x={deck.x0} y={-halfW} width={deck.x1 - deck.x0} height={deck.width} fill={`url(#${id}-floor)`} />
        {galleys.map((g, i) => (
          <rect key={`g${i}`} x={g.x0} y={-halfW} width={Math.max(0, g.x1 - g.x0)} height={deck.width} fill={GALLEY} />
        ))}
        {zones.filter(z => z.cls === 'empty').map((z, i) => (
          <rect key={`e${i}`} data-cabin="empty" x={z.x0} y={-halfW} width={z.x1 - z.x0} height={deck.width} fill={`url(#${id}-hatch)`} />
        ))}
        {seatPaths(deck.id)}
        {zones.slice(1).map((z, i) => (
          <line key={`b${i}`} x1={z.x0} x2={z.x0} y1={-halfW} y2={halfW} stroke="#15181c" strokeWidth={1.2} style={line} />
        ))}
      </g>
    );
  };

  const both = (d, props) => (
    <>
      <path d={d} {...props} />
      <path d={d} {...props} transform="scale(1 -1)" />
    </>
  );
  const mirrored = (y) => (y === 0 ? [y] : [y, -y]);

  const nacelle = (e, key) => mirrored(e.y).map((y, i) => {
    const rx = e.box ? e.w * 0.1 : e.w * 0.45;
    return (
      <g key={`${key}${i}`}>
        {e.pylon != null && (
          <rect x={e.x + e.len * 0.3} y={y > 0 ? e.pylon - sw : y + e.w / 2 - sw} width={e.len * 0.34}
                height={Math.abs(y) - e.w / 2 - e.pylon + 2 * sw} fill={shade(WING, 0.92)} stroke={wingInk} strokeWidth={0.6} style={line} />
        )}
        {e.pylonTo != null && (
          <rect x={e.x + e.len * 0.55} y={y - e.w * 0.11} width={e.pylonTo - e.x - e.len * 0.55} height={e.w * 0.22}
                fill={shade(WING, 0.88)} stroke={wingInk} strokeWidth={0.5} style={line} />
        )}
        <rect x={e.x} y={y - e.w / 2} width={e.len} height={e.w} rx={rx} fill={`url(#${id}-nac)`} stroke={ink} strokeWidth={0.8} style={line} />
        {!e.box && <>
          {/* inlet lip and the fan behind it */}
          <rect x={e.x} y={y - e.w * 0.44} width={e.len * 0.11} height={e.w * 0.88} rx={e.w * 0.05} fill={shade(engine, 0.5)} />
          <rect x={e.x + e.len * 0.03} y={y - e.w * 0.34} width={e.len * 0.05} height={e.w * 0.68} rx={e.w * 0.04} fill="#2b2f36" />
          {!e.nacelle && <rect x={e.x + e.len * 0.92} y={y - e.w * 0.3} width={e.len * 0.13} height={e.w * 0.6} rx={e.w * 0.18} fill="#555b64" stroke={ink} strokeWidth={0.5} style={line} />}
        </>}
        {e.box && <rect x={e.x + e.len * 0.02} y={y - e.w * 0.42} width={e.len * 0.1} height={e.w * 0.84} fill="#2b2f36" />}
      </g>
    );
  });

  // Silhouette for the shadow on the apron.
  const silhouette = [geom.fuselage, geom.wing, geom.stab].filter(Boolean);

  // ── Painting ──
  // Pointer → metres along the fuselage, through the plane group's own CTM so
  // the vertical orientation and any CSS scaling come out in the wash.
  const planeX = (evt) => {
    const g = planeRef.current;
    const svg = g?.ownerSVGElement;
    if (!g || !svg) return null;
    const p = svg.createSVGPoint(); p.x = evt.clientX; p.y = evt.clientY;
    return p.matrixTransform(g.getScreenCTM().inverse()).x;
  };
  const commit = (by, favour) => editable?.onChange?.(unitsToConfig(by, floor, favour, config));
  const startPaint = (deck) => (evt) => {
    if (!editable || evt.button > 0) return;
    const x = planeX(evt); if (x == null) return;
    evt.preventDefault();
    evt.currentTarget.setPointerCapture?.(evt.pointerId);
    const brush = editable.brush ?? 'economy';
    drag.current = { kind: 'paint', deck: deck.id, layout, brush, lo: x, hi: x };
    commit(paintStroke(layout, deck.id, x, x, brush), brush);
  };
  const startDivider = (deck, div) => (evt) => {
    if (!editable || evt.button > 0) return;
    evt.preventDefault(); evt.stopPropagation();
    evt.currentTarget.setPointerCapture?.(evt.pointerId);
    drag.current = { kind: 'divider', deck: deck.id, layout, div };
  };
  const movePaint = (evt) => {
    const d = drag.current; if (!d) return;
    const x = planeX(evt); if (x == null) return;
    if (d.kind === 'paint') {
      d.lo = Math.min(d.lo, x); d.hi = Math.max(d.hi, x);
      commit(paintStroke(d.layout, d.deck, d.lo, d.hi, d.brush), d.brush);
    } else {
      const by = dragDivider(d.layout, d.deck, d.div, x);
      commit(by, x >= d.div.x ? d.div.left.cls : d.div.right.cls);
    }
  };
  const endPaint = () => { drag.current = null; };

  const paintLayer = (deck, yOff) => {
    if (!editable) return null;
    const halfW = deck.width / 2;
    const grip = spec.D * 0.22;
    const divs = dividers(layout, deck.id);
    return (
      <g transform={yOff ? `translate(0 ${yOff})` : undefined} data-paint-layer={deck.id}>
        <rect
          x={deck.ux0} y={-halfW} width={deck.ux1 - deck.ux0} height={deck.width}
          fill="transparent" style={{ cursor: 'crosshair', touchAction: 'none' }}
          onPointerDown={startPaint(deck)} onPointerMove={movePaint} onPointerUp={endPaint} onPointerCancel={endPaint}
        />
        {divs.map((div, i) => (
          <g key={i} data-divider={`${div.left.cls}|${div.right.cls}`}
             style={{ cursor: vertical ? 'ns-resize' : 'ew-resize', touchAction: 'none' }}
             onPointerDown={startDivider(deck, div)} onPointerMove={movePaint} onPointerUp={endPaint} onPointerCancel={endPaint}
             onPointerEnter={() => setHover(`${deck.id}:${i}`)} onPointerLeave={() => setHover(null)}>
            <rect x={div.x - grip * 0.9} y={-halfW - grip * 1.3} width={grip * 1.8} height={deck.width + grip * 2.6} fill="transparent" />
            <line x1={div.x} x2={div.x} y1={-halfW - grip * 0.3} y2={halfW + grip * 0.3} stroke="#fff" strokeOpacity={hover === `${deck.id}:${i}` ? 0.95 : 0.55} strokeWidth={1.5} style={line} />
            <rect x={div.x - grip * 0.5} y={-halfW - grip * 1.2} width={grip} height={grip * 0.9} rx={grip * 0.25} fill="#fff" fillOpacity={hover === `${deck.id}:${i}` ? 1 : 0.8} />
            <rect x={div.x - grip * 0.5} y={halfW + grip * 0.3} width={grip} height={grip * 0.9} rx={grip * 0.25} fill="#fff" fillOpacity={hover === `${deck.id}:${i}` ? 1 : 0.8} />
          </g>
        ))}
      </g>
    );
  };

  const counts = layout.totals;
  const label = `${type.name}: ${counts.firstClass ?? 0} first, ${counts.businessClass ?? 0} business, `
    + `${counts.premiumEconomy ?? 0} premium economy, ${counts.economy ?? 0} economy`;

  // Vertical: rotate the whole plane 90° clockwise so the nose points up.
  // (x, y) → (-y, x), so the viewBox swaps its axes.
  const viewBox = vertical
    ? `${-(vbTop + vbH)} ${extent.xMin} ${vbH} ${vbW}`
    : `${extent.xMin} ${vbTop} ${vbW} ${vbH}`;

  return (
    <svg
      className={className}
      viewBox={viewBox}
      role="img"
      aria-label={label}
      data-plane={spec.id ?? ''}
      data-editable={editable ? 'true' : undefined}
      data-orientation={orientation}
      preserveAspectRatio="xMidYMid meet"
      style={{ display: 'block', width: '100%', height: 'auto', maxHeight, ...style }}
    >
      <title>{label}</title>
      <defs>
        {/* a cylinder lit from above: bright crown, falling away to the sides */}
        <linearGradient id={`${id}-fuse`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0"    stopColor={shade(skin, 0.68)} />
          <stop offset="0.18" stopColor={shade(skin, 0.9)} />
          <stop offset="0.5"  stopColor={shade(skin, 1.08)} />
          <stop offset="0.82" stopColor={shade(skin, 0.9)} />
          <stop offset="1"    stopColor={shade(skin, 0.68)} />
        </linearGradient>
        <linearGradient id={`${id}-nac`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0"    stopColor={shade(engine, 0.6)} />
          <stop offset="0.45" stopColor={shade(engine, 1.05)} />
          <stop offset="1"    stopColor={shade(engine, 0.6)} />
        </linearGradient>
        <linearGradient id={`${id}-floor`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0"   stopColor="#000" stopOpacity="0.35" />
          <stop offset="0.5" stopColor="#000" stopOpacity="0" />
          <stop offset="1"   stopColor="#000" stopOpacity="0.35" />
        </linearGradient>
        <linearGradient id={`${id}-wing`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={shade(WING, 0.94)} />
          <stop offset="1" stopColor={shade(WING, 1.05)} />
        </linearGradient>
        <pattern id={`${id}-hatch`} patternUnits="userSpaceOnUse" width={spec.D * 0.16} height={spec.D * 0.16} patternTransform="rotate(45)">
          <rect width={spec.D * 0.16} height={spec.D * 0.16} fill={FLOOR} />
          <line x1="0" y1="0" x2="0" y2={spec.D * 0.16} stroke="#4c525c" strokeWidth={spec.D * 0.04} />
        </pattern>
        <clipPath id={`${id}-body`}><path d={geom.fuselage} /></clipPath>
        <filter id={`${id}-shadow`} x="-10%" y="-10%" width="125%" height="125%">
          <feGaussianBlur stdDeviation={spec.D * 0.22} />
        </filter>
      </defs>

      <g ref={planeRef} transform={vertical ? 'rotate(90)' : undefined}>
      {/* Shadow on the apron */}
      <g transform={`translate(${spec.D * 0.28} ${spec.D * 0.42})`} filter={`url(#${id}-shadow)`} opacity="0.5" pointerEvents="none">
        {silhouette.map((d, i) => <g key={i}>{both(d, { fill: '#000' })}</g>)}
      </g>

      {/* Low-set tailplane sits under the fuselage */}
      {geom.stab && !geom.stabOnTop && <>
        {both(geom.stab, { fill: WING, stroke: wingInk, strokeWidth: 0.8, style: line })}
        {geom.elevator && both(geom.elevator, { fill: shade(WING, 0.9), stroke: wingInk, strokeWidth: 0.5, style: line })}
      </>}

      {/* Wing-to-body fairing, then the engines that hang under the wing */}
      {geom.rootFairing && (
        <rect x={geom.rootFairing.x} y={geom.rootFairing.y} width={geom.rootFairing.w} height={geom.rootFairing.h}
              rx={geom.rootFairing.r} fill={shade(skin, 0.78)} stroke={ink} strokeWidth={0.7} style={line} />
      )}
      {geom.fairings.map((fr, i) => mirrored(fr.y).map((y, j) => (
        <rect key={`f${i}${j}`} x={fr.x} y={y - fr.w / 2} width={fr.len} height={fr.w} rx={fr.w / 2} fill={shade(WING, 0.82)} stroke={wingInk} strokeWidth={0.5} style={line} />
      )))}
      {geom.underWing.map((e, i) => nacelle(e, `u${i}`))}

      {/* Wing */}
      {both(geom.wing, { fill: `url(#${id}-wing)`, stroke: wingInk, strokeWidth: 0.9, style: line })}
      {geom.flapSurfaces.map((fs, i) => <g key={`fs${i}`}>{both(fs.d, { fill: shade(WING, fs.kind === 'flap' ? 0.9 : 0.86), stroke: wingInk, strokeWidth: 0.55, style: line })}</g>)}
      {geom.slats.map((d, i) => <g key={`sl${i}`}>{both(d, { fill: shade(WING, 1.12), stroke: wingInk, strokeWidth: 0.45, style: line })}</g>)}
      {geom.spoilers.map((d, i) => <g key={`sp${i}`}>{both(d, { fill: shade(WING, 0.95), stroke: wingInk, strokeWidth: 0.4, style: line })}</g>)}
      {geom.winglet && both(geom.winglet, { fill: shade(WING, 0.85), stroke: wingInk, strokeWidth: 0.6, style: line })}
      {geom.surfaceLines.map((d, i) => <g key={`s${i}`}>{both(d, { fill: 'none', stroke: wingInk, strokeWidth: 0.6, style: line })}</g>)}
      {geom.intakes.filter(k => k.wingRoot).map((k, i) => mirrored(k.y).map((y, j) => (
        <rect key={`wr${i}${j}`} x={k.x} y={y - k.w / 2} width={k.len} height={k.w} rx={k.w * 0.4} fill={GLASS} />
      )))}

      {/* Propeller nacelles ride on top of the wing */}
      {geom.overWing.map((e, i) => nacelle(e, `o${i}`))}

      {/* Fuselage, roof lifted off over the cabin */}
      <path d={geom.fuselage} fill={`url(#${id}-fuse)`} stroke={ink} strokeWidth={1} style={line} />
      <path d={geom.radome} fill="none" stroke={ink} strokeOpacity="0.55" strokeWidth={0.6} style={line} />
      <g clipPath={`url(#${id}-body)`}>
        {cabin(layout.decks.find(d => d.id === 'main'), 0)}
      </g>
      {paintLayer(layout.decks.find(d => d.id === 'main'), 0)}
      {geom.wingBoxOverCabin && [geom.wingBoxOverCabin.x0, geom.wingBoxOverCabin.x1].map((x, i) => (
        <line key={`wb${i}`} x1={x} x2={x} y1={-R} y2={R} stroke="#e8ebf0" strokeOpacity={0.55} strokeWidth={1} strokeDasharray="4 3" style={line} />
      ))}
      <path d={geom.cockpit} fill={GLASS} stroke={ink} strokeWidth={0.5} style={line} />
      {geom.apu && <circle cx={geom.apu.x} cy={0} r={geom.apu.r} fill="#3a3f48" stroke={ink} strokeWidth={0.5} style={line} />}

      {/* Tail-mounted engines, intakes, fin */}
      {geom.onBody.map((e, i) => nacelle(e, `b${i}`))}
      {geom.intakes.filter(k => !k.wingRoot).map((k, i) => (
        <g key={`i${i}`}>
          <rect x={k.x} y={-k.w / 2} width={k.len} height={k.w} rx={k.w * 0.45} fill={`url(#${id}-nac)`} stroke={ink} strokeWidth={0.7} style={line} />
          <rect x={k.x} y={-k.w * 0.4} width={k.len * 0.12} height={k.w * 0.8} rx={k.w * 0.06} fill="#2b2f36" />
        </g>
      ))}
      <path d={geom.fin} fill={fin} stroke={shade(fin, 0.5)} strokeWidth={0.8} style={line} />
      <path d={geom.rudder} fill="none" stroke={shade(fin, 0.5)} strokeWidth={0.5} style={line} />
      {geom.stab && geom.stabOnTop && <>
        {both(geom.stab, { fill: WING, stroke: wingInk, strokeWidth: 0.8, style: line })}
        {geom.elevator && both(geom.elevator, { fill: shade(WING, 0.9), stroke: wingInk, strokeWidth: 0.5, style: line })}
      </>}
      {geom.tipFins.map((t, i) => mirrored(t.y).map((y, j) => (
        <rect key={`tf${i}${j}`} x={t.x0} y={y - t.w / 2} width={t.x1 - t.x0} height={t.w} rx={t.w / 2} fill={fin} stroke={shade(fin, 0.5)} strokeWidth={0.6} style={line} />
      )))}

      {/* Propellers: edge-on from above, a blurred arc of blade */}
      {geom.props.map((p, i) => (p.nose ? [0] : mirrored(p.y)).map((y, j) => (
        <g key={`p${i}${j}`}>
          <rect x={p.x - spec.D * 0.035} y={y - p.dia / 2} width={spec.D * 0.07} height={p.dia} rx={spec.D * 0.035} fill="#9aa1ab" fillOpacity={0.35} />
          <rect x={p.x - spec.D * 0.012} y={y - p.dia / 2} width={spec.D * 0.024} height={p.dia} rx={spec.D * 0.012} fill="#23272d" />
          <ellipse cx={p.x - spec.D * 0.04} cy={y} rx={spec.D * 0.13} ry={spec.D * 0.11} fill={`url(#${id}-nac)`} stroke={ink} strokeWidth={0.6} style={line} />
        </g>
      )))}

      {/* Upper deck, drawn as its own plan under the aircraft */}
      {upper && (
        <g data-deck="upper">
          <text x={upper.x0} y={upperY - upper.width / 2 - spec.D * 0.28} fontSize={fontM} fill="var(--text-muted, #a2a2a8)"
                transform={vertical ? `rotate(-90 ${upper.x0} ${upperY - upper.width / 2 - spec.D * 0.28})` : undefined}>Upper deck</text>
          <rect x={upper.x0 - spec.D * 0.12} y={upperY - upper.width / 2 - spec.D * 0.1} width={upper.x1 - upper.x0 + spec.D * 0.24}
                height={upper.width + spec.D * 0.2} rx={spec.D * 0.35} fill={`url(#${id}-fuse)`} stroke={ink} strokeWidth={1} style={line} />
          {cabin(upper, upperY)}
          {paintLayer(upper, upperY)}
        </g>
      )}
      </g>
    </svg>
  );
}
