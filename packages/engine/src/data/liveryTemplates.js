// Licensed aircraft side-view templates the livery is painted onto.
//
// The artwork is Norebbo's all-white airliner illustration, bought per type
// (shopnorebbo.com) and shipped as apps/headwinds-web/brand/livery-<id>.png.
// Each template carries, in the coordinate space of the ORIGINAL 4629-wide
// crop (the shipped PNG may be smaller; the painter scales):
//   size    [w, h] of that coordinate space
//   parts   polygons that split the silhouette into recolourable regions —
//           everything opaque that no polygon claims is fuselage.
//           Precedence where they overlap: stab > engine > winglet > wing > fin.
//   body    crown / belly / window row / nose / tail landmarks the style
//           shapes (cheatline, swoosh, belly, …) are drawn against
//   titles  the x-span for the airline name, above the window line
//   logo    centre and size of the logo box on the fin
//   tail    the crop TailFin.jsx paints: fin, stabiliser, rear fuselage
//   fin     the fin alone, for the maps' hub markers
//   fuselageLogo  vertical centre, size and gap to the name of the logo on
//           the forward fuselage; it starts at titles.x0 and the name moves aft
//
// One template today: every aircraft category paints onto the 737-800 until
// more are bought (see claude/livery-editor.md — a $15 donation funds a type).

export const LIVERY_TEMPLATES = {
  'b737-800': {
    id: 'b737-800',
    name: 'Boeing 737-800',
    url: '/livery-b737-800.png',
    credit: 'Aircraft artwork by Norebbo, used under licence',
    size: [4629, 1364],
    parts: {
      fin: [
        [[3300, 0], [4447, 0], [4447, 793], [3300, 793]],
        [[4447, 0], [4700, 0], [4700, 1400], [4447, 1400]],
      ],
      stab: [
        [[3945, 897], [4060, 868], [4300, 822], [4520, 790], [4627, 776], [4627, 788], [4520, 806], [4300, 845], [4080, 892], [3960, 912]],
      ],
      wing: [
        [[1830, 1092], [2000, 1055], [2300, 1005], [2700, 950], [2865, 955], [2760, 1030], [2700, 1090], [2660, 1140], [2560, 1180], [2400, 1200], [2150, 1200], [1990, 1170], [1960, 1120], [1900, 1110]],
      ],
      winglet: [
        [[2690, 952], [2945, 676], [3000, 670], [3005, 690], [2870, 956]],
      ],
      engine: [
        [[1600, 1085], [1960, 1085], [1960, 1140], [2100, 1180], [2100, 1270], [1960, 1310], [1900, 1364], [1500, 1364], [1470, 1330], [1470, 1140], [1500, 1105], [1600, 1105]],
      ],
    },
    body: { crown: 793, belly: 1266, windowTop: 942, windowBottom: 988, noseX: 0, tailX: 4447 },
    titles: { x0: 700, x1: 1800 },
    logo: { cx: 4160, cy: 440, size: 290 },
    fuselageLogo: { cy: 842, size: 84, gap: 32 },
    // The tail crop (TailFin.jsx): the fin, the stabiliser and the rear
    // fuselage with its last windows and the aft door, in the same space.
    tail: { x0: 3350, y0: 0, x1: 4629, y1: 1290 },
    // The fin alone, cut at the fuselage crown — the classic airline tail
    // logo. The maps use it: the cleanest shape at marker size.
    fin: { x0: 3560, y0: 0, x1: 4629, y1: 774 },
  },
};

/** A template's crop as { x0, y0, w, h, aspect (w / h) }: 'tail' (fin + stabiliser + rear fuselage) or 'fin' (the fin alone). */
export function tailCropOf(spec, which = 'tail') {
  const fallback = which === 'fin'
    ? { x0: Math.round(spec.size[0] * 0.78), y0: 0, x1: spec.size[0], y1: Math.round(spec.body?.crown ?? spec.size[1] * 0.6) }
    : { x0: Math.round(spec.size[0] * 0.72), y0: 0, x1: spec.size[0], y1: spec.size[1] };
  const t = spec?.[which] ?? fallback;
  const w = t.x1 - t.x0, h = t.y1 - t.y0;
  return { x0: t.x0, y0: t.y0, w, h, aspect: w / h };
}

export const DEFAULT_LIVERY_TEMPLATE = 'b737-800';

// Aircraft category (data/aircraft.js `category`) → template id. Every entry
// points at the 737 for now; when a widebody / turboprop template is bought,
// change the mapping here and nothing else.
const CATEGORY_TEMPLATE = {
  'Narrow Body':  'b737-800',
  'Wide Body':    'b737-800',
  'Double Deck':  'b737-800',
  'Regional Jet': 'b737-800',
  'Turboprop':    'b737-800',
  'Freighter':    'b737-800',
  'Supersonic':   'b737-800',
};

export function liveryTemplateFor(category) {
  return LIVERY_TEMPLATES[CATEGORY_TEMPLATE[category] ?? DEFAULT_LIVERY_TEMPLATE] ?? LIVERY_TEMPLATES[DEFAULT_LIVERY_TEMPLATE];
}

export function getLiveryTemplate(id) {
  return LIVERY_TEMPLATES[id] ?? null;
}
