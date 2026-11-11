// Top-down planforms for the cabin floor plan (FleetConfig).
//
// The engine knows an aircraft's seats and category, not its shape, so the
// outline comes from this table: real length, span and fuselage width (metres),
// the economy seats-across, and how the engines hang. Everything else (nose,
// tail cone, wing chords, stabiliser) is derived from those, so a new type needs
// one line here — and a type with no line still draws, from its category.
//
// The CABIN inside the outline is laid out by floor units, exactly as the
// engine counts them (CLASS_SPACE_MULTIPLIERS: a business seat is 1.5 economy
// seats of floor). A cabin's length on the drawing is its share of the floor,
// and every configured seat is drawn: the picture cannot disagree with the
// numbers above it.
//
// Pure data and geometry. No React, no game state. The one engine import is
// the seat-product floor factor, so a 28" pitch or a lie-flat lays out with
// the floor the engine charges for it.

import { productSpaceMul, productOf } from '../data/seatProducts.js';

// ── Per-type dimensions ─────────────────────────────────────────────────────
// id: [length m, span m, fuselage width m, economy seats across, 'tokens']
// Tokens override the category defaults:
//   engines  w2 w4 w6 (under wing) · r2 r3 r4 (rear fuselage) · t3 (DC-10/MD-11
//            centre engine in the fin) · l3 (TriStar S-duct) · b4 (buried in the
//            wing root: Comet, Tu-104) · p1 p2 p4 (propellers) · c4 (Concorde)
//   tail     T (T-tail) · c (conventional) · tri (triple fin) · none
//   wing     high · sw:<deg> LE sweep · wx:<frac> root LE as share of length ·
//            kc:<frac> root chord as share of span · tp:<frac> taper · rect ·
//            tdc (DC-3 style tapered LE, straight TE) · raked · wl (winglets)
//   decks    hump:<frac> upper deck over the front <frac> of the cabin (747) ·
//            deck2 full-length upper deck (A380)
//   cabin    noaisle (bench seating, Islander)
export const PLANFORMS = {
  concorde:    [61.66, 25.6,  2.88, 4, 'c4 none'],
  tu144:       [65.7,  28.8,  3.3,  5, 'c4 none'],
  a220100:     [35.0,  35.1,  3.7,  5, 'sw:26'],
  a318:        [31.44, 34.1,  3.95, 6, ''],
  a319ceo:     [33.84, 34.1,  3.95, 6, ''],
  a220:        [38.7,  35.1,  3.7,  5, 'sw:26'],
  a319neo:     [33.84, 35.8,  3.95, 6, 'wl'],
  a320ceo:     [37.57, 34.1,  3.95, 6, ''],
  a320100:     [37.57, 33.91, 3.95, 6, ''],
  a320neo:     [37.57, 35.8,  3.95, 6, 'wl'],
  a321ceo:     [44.51, 34.1,  3.95, 6, 'wx:0.38'],
  a321100:     [44.51, 34.1,  3.95, 6, 'wx:0.38'],
  a321neo:     [44.51, 35.8,  3.95, 6, 'wl wx:0.38'],
  a321xlr:     [44.51, 35.8,  3.95, 6, 'wl wx:0.38'],
  a310300:     [46.66, 43.9,  5.64, 8, 'sw:28 wl'],
  a300600r:    [54.08, 44.84, 5.64, 8, 'sw:28'],
  a330200:     [58.82, 60.3,  5.64, 8, 'sw:30 wl'],
  a340300:     [63.69, 60.3,  5.64, 8, 'w4 sw:30 wl'],
  a340200:     [59.4,  60.3,  5.64, 8, 'w4 sw:30 wl'],
  a330300:     [63.67, 60.3,  5.64, 8, 'sw:30 wl'],
  a330neo:     [63.66, 64.0,  5.64, 8, 'sw:30 wl'],
  a340600:     [75.36, 63.45, 5.64, 8, 'w4 sw:31 wl'],
  a340500:     [67.93, 63.45, 5.64, 8, 'w4 sw:31 wl'],
  a350900:     [66.8,  64.75, 5.96, 9, 'sw:31.9 wl'],
  a350900ulr:  [66.8,  64.75, 5.96, 9, 'sw:31.9 wl'],
  a3501000:    [73.79, 64.75, 5.96, 9, 'sw:31.9 wl'],
  a3501000ulr: [73.79, 64.75, 5.96, 9, 'sw:31.9 wl'],
  a380:        [72.72, 79.75, 7.14, 10, 'w4 sw:33.5 deck2 wl wx:0.31'],
  casacn235:   [21.4,  25.81, 2.9,  4, 'high'],
  l410:        [14.42, 19.98, 2.1,  3, 'high'],
  an148:       [29.13, 28.91, 3.35, 5, 'w2 high T sw:25 wx:0.36'],
  atr42:       [22.67, 24.57, 2.57, 4, 'high T'],
  atr72:       [27.17, 27.05, 2.57, 4, 'high T'],
  b1900d:      [17.63, 17.67, 1.8,  2, 'T'],
  b737100:     [28.65, 28.35, 3.76, 6, ''],
  b737200:     [30.53, 28.35, 3.76, 6, ''],
  b717:        [37.81, 28.45, 3.34, 5, 'r2 T sw:24'],
  b727100:     [40.59, 32.92, 3.76, 6, 'r3 T sw:32'],
  b727200:     [46.69, 32.92, 3.76, 6, 'r3 T sw:32'],
  b737500:     [31.0,  28.88, 3.76, 6, ''],
  b737300:     [33.4,  28.88, 3.76, 6, ''],
  b737700:     [33.6,  35.79, 3.76, 6, 'wl'],
  b737600:     [31.24, 34.32, 3.76, 6, ''],
  b737700er:   [33.6,  35.79, 3.76, 6, 'wl'],
  b737400:     [36.4,  28.88, 3.76, 6, ''],
  b707320:     [46.61, 44.42, 3.76, 6, 'w4 sw:35'],
  b737max7:    [35.56, 35.92, 3.76, 6, 'wl'],
  b737800:     [39.47, 35.79, 3.76, 6, 'wl'],
  b737max8:    [39.52, 35.92, 3.76, 6, 'wl'],
  b737900er:   [42.11, 35.79, 3.76, 6, 'wl'],
  b737max9:    [42.16, 35.92, 3.76, 6, 'wl'],
  b737max10:   [43.8,  35.92, 3.76, 6, 'wl'],
  b757200:     [47.32, 38.05, 3.76, 6, ''],
  b757300:     [54.43, 38.05, 3.76, 6, ''],
  b767200er:   [48.51, 47.57, 5.03, 7, 'sw:31.5'],
  b767200:     [48.51, 47.57, 5.03, 7, 'sw:31.5'],
  b767300:     [54.94, 47.57, 5.03, 7, 'sw:31.5'],
  b767300base: [54.94, 47.57, 5.03, 7, 'sw:31.5'],
  b767400er:   [61.37, 51.92, 5.03, 7, 'sw:31.5 raked'],
  b7878:       [56.72, 60.12, 5.77, 9, 'sw:32 raked'],
  b777200er:   [63.73, 60.93, 6.2, 10, 'sw:31.6'],
  b777200:     [63.73, 60.93, 6.2, 10, 'sw:31.6'],
  b7879:       [62.81, 60.12, 5.77, 9, 'sw:32 raked'],
  b747200:     [70.66, 59.64, 6.5, 10, 'sw:37.5 hump:0.16'],
  b777200lr:   [63.73, 64.8,  6.2, 10, 'sw:31.6 raked'],
  b787x10:     [68.28, 60.12, 5.77, 9, 'sw:32 raked'],
  b747sp:      [56.31, 59.64, 6.5, 10, 'sw:37.5 hump:0.2 wx:0.27'],
  b777300er:   [73.86, 64.8,  6.2, 10, 'sw:31.6 raked'],
  b777300:     [73.86, 60.93, 6.2, 10, 'sw:31.6'],
  b747400:     [70.66, 64.44, 6.5, 10, 'sw:37.5 hump:0.27 wl'],
  b747400er:   [70.66, 64.44, 6.5, 10, 'sw:37.5 hump:0.27 wl'],
  b747400d:    [70.66, 59.64, 6.5, 10, 'sw:37.5 hump:0.27'],
  b7778x:      [69.79, 71.75, 6.2, 10, 'sw:32 raked'],
  b7779x:      [76.72, 71.75, 6.2, 10, 'sw:32 raked'],
  b7478i:      [76.25, 68.4,  6.5, 10, 'sw:37.5 hump:0.31 raked'],
  crj200:      [26.77, 21.21, 2.69, 4, 'wl'],
  crj700:      [32.51, 23.24, 2.69, 4, 'wl'],
  crj900:      [36.4,  24.85, 2.69, 4, 'wl'],
  crj1000:     [39.1,  26.18, 2.69, 4, 'wl'],
  avrorj85:    [28.6,  26.21, 3.56, 6, 'w4 high T sw:15 wx:0.38'],
  bae146200:   [28.6,  26.21, 3.56, 6, 'w4 high T sw:15 wx:0.38'],
  bn2islander: [10.86, 14.94, 1.2,  3, 'high rect noaisle wx:0.3'],
  c208b:       [12.67, 15.88, 1.6,  3, 'p1 high wx:0.3'],
  arj21:       [33.46, 27.29, 3.14, 5, 'sw:25'],
  c919:        [38.9,  35.8,  3.96, 6, 'wl'],
  dhc8300:     [25.68, 27.43, 2.69, 4, 'high T'],
  q400:        [32.81, 28.42, 2.69, 4, 'high T'],
  erj135:      [26.33, 20.04, 2.28, 3, 'sw:22.7'],
  erj145:      [29.87, 20.04, 2.28, 3, 'sw:22.7'],
  erj170:      [29.9,  26.0,  3.01, 4, 'w2 c sw:23 wx:0.36 wl'],
  e175:        [31.68, 26.0,  3.01, 4, 'w2 c sw:23 wx:0.36 wl'],
  e175e2:      [32.4,  31.0,  3.01, 4, 'w2 c sw:23 wx:0.36'],
  e190:        [36.24, 28.72, 3.01, 4, 'w2 c sw:23 wx:0.36 wl'],
  e190e2:      [36.25, 33.72, 3.01, 4, 'w2 c sw:23 wx:0.36'],
  e195:        [38.65, 28.72, 3.01, 4, 'w2 c sw:23 wx:0.36 wl'],
  e195e2:      [41.51, 35.12, 3.01, 4, 'w2 c sw:23 wx:0.36'],
  fokker70:    [30.91, 28.08, 3.3,  5, 'sw:17'],
  fokker100:   [35.53, 28.08, 3.3,  5, 'sw:17'],
  il96300:     [55.35, 57.66, 6.08, 9, 'w4 sw:30 wl'],
  mc21300:     [42.2,  35.9,  4.06, 6, ''],
  l1011:       [54.17, 47.35, 5.97, 9, 'l3 sw:35'],
  dc910:       [31.82, 27.25, 3.34, 5, ''],
  dc930:       [36.37, 28.47, 3.34, 5, ''],
  dc950:       [40.72, 28.47, 3.34, 5, ''],
  md90:        [46.5,  32.87, 3.34, 5, ''],
  md80:        [45.06, 32.87, 3.34, 5, ''],
  dc1030:      [55.5,  50.4,  6.02, 9, 't3 sw:35'],
  dc1010:      [55.55, 47.35, 6.02, 9, 't3 sw:35'],
  md11:        [61.6,  51.97, 6.02, 9, 't3 sw:35 wl'],
  spacejet:    [35.5,  29.2,  2.96, 4, 'w2 c sw:25 wx:0.37'],
  pc12:        [14.4,  16.28, 1.6,  2, 'p1 T wx:0.33'],
  saab340:     [19.73, 21.44, 2.31, 3, ''],
  saab2000:    [27.28, 24.76, 2.31, 3, ''],
  short360:    [21.58, 22.8,  2.24, 3, 'high rect'],
  ssj100:      [29.94, 27.8,  3.46, 5, 'w2 c sw:25 wx:0.37'],
  tu204:       [46.14, 41.8,  3.8,  6, 'sw:28 wl'],
  dhc6:        [15.77, 19.81, 1.6,  3, 'high rect'],
  dc3:         [19.66, 28.96, 2.5,  3, 'tdc wx:0.26'],
  c47:         [19.66, 28.96, 2.5,  3, 'tdc wx:0.26'],
  dc863:       [57.12, 45.23, 3.73, 6, 'w4 sw:30'],
  caravelle:   [32.01, 34.3,  3.2,  5, 'r2 c sw:20'],
  trident3b:   [39.98, 29.87, 3.44, 6, 'r3 T sw:35'],
  vc10:        [48.36, 44.55, 3.76, 6, 'r4 T sw:32'],
  cv990:       [42.5,  36.58, 3.48, 5, 'w4 sw:39'],
  tu154m:      [47.9,  37.55, 3.8,  6, 'r3 T sw:35'],
  tu134:       [37.1,  29.0,  2.9,  4, 'r2 T sw:35'],
  il62m:       [53.12, 43.2,  3.75, 6, 'r4 T sw:32'],
  il86:        [59.54, 48.06, 6.08, 9, 'w4 sw:35'],
  yak42:       [36.38, 34.88, 3.8,  6, 'r3 T sw:23'],
  yak40:       [20.36, 25.0,  2.4,  3, 'r3 T sw:2 kc:0.11 tp:0.5'],
  f27:         [23.56, 29.0,  2.7,  4, 'high'],
  f28:         [27.4,  25.07, 3.3,  5, 'sw:16'],
  b720b:       [41.25, 39.87, 3.76, 6, 'w4 sw:35'],
  b747100:     [70.66, 59.64, 6.5, 10, 'sw:37.5 hump:0.16'],
  b747300:     [70.66, 59.64, 6.5, 10, 'sw:37.5 hump:0.27'],
  a300b4:      [53.61, 44.84, 5.64, 8, 'sw:28'],
  a310200:     [46.66, 43.9,  5.64, 8, 'sw:28'],
  l188:        [31.85, 30.18, 3.3,  5, 'p4'],
  bac111:      [32.61, 28.5,  3.16, 5, 'sw:20'],
  cv580:       [24.84, 32.12, 2.84, 4, ''],
  b737max8200: [39.52, 35.92, 3.76, 6, 'wl'],
  a330800:     [58.82, 64.0,  5.64, 8, 'sw:30 wl'],
  sj100new:    [29.94, 27.8,  3.46, 5, 'w2 c sw:25 wx:0.37'],
  mc21310:     [42.2,  35.9,  4.06, 6, ''],
  c929:        [63.75, 63.9,  6.0,  9, 'sw:31 raked'],
  do328:       [21.11, 20.98, 2.4,  3, 'high T'],
  do328jet:    [21.28, 20.98, 2.4,  3, 'w2 high T sw:4 kc:0.11 tp:0.55'],
  do228:       [16.56, 16.97, 1.6,  2, 'high rect'],
  emb120:      [20.0,  19.78, 2.28, 3, 'T'],
  js31:        [14.37, 15.85, 1.98, 3, ''],
  js41:        [19.25, 18.29, 1.98, 3, ''],
  saab340a:    [19.73, 21.44, 2.31, 3, ''],
  dhc8100:     [22.25, 25.91, 2.69, 4, 'high T'],
  dhc8200:     [22.25, 25.91, 2.69, 4, 'high T'],
  dash7:       [24.58, 28.35, 2.6,  4, 'p4 high T'],
  ma60:        [24.71, 29.2,  2.9,  4, 'high'],
  ma600:       [24.71, 29.2,  2.9,  4, 'high'],
  c408:        [16.7,  22.0,  1.98, 2, 'high rect'],
  an24:        [23.53, 29.2,  2.9,  4, 'high'],
  emb110:      [15.1,  15.33, 1.7,  2, ''],
  dc4:         [28.6,  35.8,  2.8,  4, 'p4 wx:0.32'],
  northstar:   [28.5,  35.8,  2.8,  4, 'p4 wx:0.32'],
  l749:        [29.0,  37.49, 3.0,  4, 'p4 tri wx:0.33'],
  cv240:       [22.76, 27.97, 2.84, 4, ''],
  b377:        [33.63, 43.05, 3.4,  5, 'p4 wx:0.32'],
  dc6b:        [32.18, 35.81, 3.1,  5, 'p4 wx:0.32'],
  m404:        [22.75, 28.44, 2.9,  4, ''],
  l1049:       [34.62, 37.49, 3.0,  5, 'p4 tri wx:0.33'],
  comet1:      [28.35, 35.0,  3.0,  4, 'b4 c sw:20 wx:0.33'],
  viscount700: [24.94, 28.56, 3.0,  4, 'p4'],
  il14:        [22.3,  31.7,  2.6,  4, ''],
  l1049g:      [34.62, 37.49, 3.0,  5, 'p4 tri wx:0.33'],
  cv440:       [24.84, 32.12, 2.84, 4, ''],
  dc7c:        [34.21, 38.86, 3.1,  5, 'p4 wx:0.32'],
  tu104:       [38.85, 34.54, 3.5,  5, 'b4 c sw:35 wx:0.33'],
  britannia:   [37.87, 43.37, 3.66, 6, 'p4'],
  l1649:       [35.42, 45.72, 3.0,  5, 'p4 tri wx:0.33'],
  viscount800: [26.11, 28.56, 3.0,  5, 'p4'],
  b707120:     [44.22, 39.88, 3.76, 6, 'w4 sw:35'],
  comet4:      [33.99, 35.0,  3.0,  5, 'b4 c sw:20 wx:0.33'],
  il18:        [35.9,  37.42, 3.5,  5, 'p4'],
  dc830:       [45.87, 43.41, 3.73, 6, 'w4 sw:30'],
  vanguard:    [37.45, 36.15, 3.8,  6, 'p4'],
  hs748:       [20.42, 30.02, 2.67, 4, ''],
  // Business jets (Tailwinds charters): club seating, rear pods, T-tails.
  cl350:       [20.92, 21.0,  2.3,  2, 'r2 T sw:25 wl'],
  cj4:         [16.26, 15.49, 1.75, 2, 'r2 T sw:12 wl'],
  phenom300e:  [15.9,  16.2,  1.75, 2, 'r2 T sw:12 wl'],
  g650er:      [30.4,  30.36, 2.6,  2, 'r2 T sw:33 wl'],
  // Freighters with no passenger parent below.
  c46:         [23.27, 32.92, 3.0,  4, 'wx:0.3'],
  an124:       [69.1,  73.3,  7.3,  10, 'w4 high c sw:32'],
  an225:       [84.0,  88.4,  7.3,  10, 'w6 high c sw:32'],
  dc873f:      [57.12, 45.23, 3.73, 6, 'w4 sw:30'],
  an12:        [33.1,  38.0,  3.5,  5, 'p4 high'],
  cl44:        [41.7,  43.37, 4.0,  6, 'p4'],
  l10030:      [34.37, 40.41, 4.3,  6, 'p4 high'],
  il76t:       [46.59, 50.5,  4.8,  8, 'w4 high T sw:25'],
};

// A freighter draws as the airframe it was built from.
const FREIGHTER_PARENT = {
  atr72f: 'atr72', b737800bcf: 'b737800', b767300f: 'b767300', a330200f: 'a330200',
  b777f: 'b777200lr', b747400f: 'b747200', b7478f: 'b7478i', a350f: 'a350900',
  b7778f: 'b7778x', b757200pf: 'b757200', md11f: 'md11', a300600f: 'a300600r',
  dc1030f: 'dc1030', b737400f: 'b737400', b737300f: 'b737300', b727200f: 'b727200',
  e190f: 'e190', a321p2f: 'a321ceo', b767200sf: 'b767200er', b707320c: 'b707320',
  b727100c: 'b727100', dc863cf: 'dc863', l188f: 'l188', b747200f: 'b747200',
};

// ── Category defaults (used for anything the line above doesn't say) ────────
const CATEGORY_DEFAULTS = {
  'Narrow Body':  { dims: [38, 35, 3.9, 6],  eng: 'w2', tail: 'c', sweep: 25, wingX: 0.36, kc: 0.21, taper: 0.22, kink: true },
  'Wide Body':    { dims: [60, 58, 5.8, 9],  eng: 'w2', tail: 'c', sweep: 31, wingX: 0.35, kc: 0.205, taper: 0.2,  kink: true },
  'Double Deck':  { dims: [70, 64, 6.5, 10], eng: 'w4', tail: 'c', sweep: 36, wingX: 0.31, kc: 0.2,  taper: 0.24, kink: true },
  'Regional Jet': { dims: [30, 24, 2.7, 4],  eng: 'r2', tail: 'T', sweep: 25, wingX: 0.41, kc: 0.18, taper: 0.3,  kink: true },
  'Turboprop':    { dims: [24, 27, 2.6, 4],  eng: 'p2', tail: 'c', sweep: 3,  wingX: 0.36, kc: 0.11, taper: 0.55, kink: false },
  'Supersonic':   { dims: [61, 25, 2.9, 4],  eng: 'c4', tail: 'none', sweep: 60, wingX: 0.24, kc: 0.6, taper: 0.05, kink: false },
  'Freighter':    { dims: [50, 45, 5.0, 8],  eng: 'w2', tail: 'c', sweep: 30, wingX: 0.35, kc: 0.19, taper: 0.22, kink: true },
};
// Rear-engined narrowbodies (DC-9 family, BAC 1-11, F28…) take the regional
// jet's wing position and T-tail unless they say otherwise.
const REAR_DEFAULTS = { tail: 'T', wingX: 0.42, kc: 0.17, taper: 0.3, sweep: 24 };

/**
 * The resolved planform spec for an aircraft type: dimensions plus every
 * shape parameter, defaults filled in. Never null — an unknown type draws from
 * its category.
 */
export function planformFor(type) {
  const id = type?.id;
  const row = PLANFORMS[id] ?? PLANFORMS[FREIGHTER_PARENT[id]] ?? null;
  const parentType = !PLANFORMS[id] && FREIGHTER_PARENT[id] ? FREIGHTER_PARENT[id] : null;
  const cat = CATEGORY_DEFAULTS[type?.category] ?? CATEGORY_DEFAULTS['Narrow Body'];
  const [L, S, D, y] = row ?? cat.dims;
  const tokens = (row?.[4] ?? '').split(/\s+/).filter(Boolean);
  const has = (t) => tokens.includes(t);
  const num = (k) => { const t = tokens.find(x => x.startsWith(`${k}:`)); return t ? Number(t.slice(k.length + 1)) : null; };

  // Category of the drawing: a freighter borrows its parent's shape family.
  let shapeCat = type?.category;
  if (shapeCat === 'Freighter') {
    if (parentType) shapeCat = guessCategory(parentType);
    else shapeCat = tokens.some(t => /^p\d$/.test(t)) ? 'Turboprop' : 'Wide Body';
  }
  const base = { ...(CATEGORY_DEFAULTS[shapeCat] ?? cat) };

  const eng = tokens.find(t => /^(w[246]|r[234]|t3|l3|b4|p[124]|c4)$/.test(t)) ?? base.eng;
  const rear = /^r\d$/.test(eng);
  if (rear && shapeCat !== 'Regional Jet') Object.assign(base, REAR_DEFAULTS);
  if (eng.startsWith('w') && shapeCat === 'Regional Jet') Object.assign(base, { wingX: 0.36, kc: 0.19, taper: 0.25 });

  const tail = has('T') ? 'T' : has('tri') ? 'tri' : has('none') ? 'none' : has('c') ? 'c' : base.tail;
  const tdc  = has('tdc');
  const rect = has('rect');
  const spec = {
    id: id ?? null,
    L, S, D, y,
    eng, tail,
    high: has('high'),
    sweep: num('sw') ?? (tdc ? 9 : rect ? 0 : base.sweep),
    wingX: num('wx') ?? base.wingX,
    kc: num('kc') ?? (tdc ? 0.15 : rect ? 0.14 : base.kc),
    taper: num('tp') ?? (tdc ? 0.4 : rect ? 1 : base.taper),
    kink: base.kink && !tdc && !rect && !eng.startsWith('p'),
    teSweepIn: tdc ? -0.5 : 2,
    raked: has('raked'),
    winglets: has('wl'),
    hump: num('hump'),
    deck2: has('deck2'),
    noAisle: has('noaisle'),
    prop: eng.startsWith('p'),
    supersonic: eng === 'c4',
    known: !!row,
  };
  return spec;
}

function guessCategory(parentId) {
  const p = PLANFORMS[parentId];
  if (!p) return 'Wide Body';
  if (/p\d/.test(p[4])) return 'Turboprop';
  if (/hump|deck2/.test(p[4])) return 'Double Deck';
  return p[2] >= 4.5 ? 'Wide Body' : p[3] <= 4 ? 'Regional Jet' : 'Narrow Body';
}

// ── Geometry ────────────────────────────────────────────────────────────────
// Metres. x runs nose (0) → tail (L); y is lateral, 0 on the centreline. Wing,
// stabiliser and engine shapes are the +y half; the renderer mirrors them.

const f = (n) => Math.round(n * 1000) / 1000;
const pt = (x, y) => `${f(x)},${f(y)}`;
const rad = (deg) => (deg * Math.PI) / 180;

function lerpLine(line, y) {
  for (let i = 1; i < line.length; i++) {
    const [x0, y0] = line[i - 1], [x1, y1] = line[i];
    if (y <= y1 || i === line.length - 1) {
      const t = y1 === y0 ? 0 : (y - y0) / (y1 - y0);
      return x0 + (x1 - x0) * Math.max(0, Math.min(1, t));
    }
  }
  return line[line.length - 1][0];
}

function fuselagePath(L, D, noseLen, tailStart, pointy = false) {
  const R = D / 2, wEnd = D * 0.1, tl = L - tailStart;
  const nc = pointy ? R * 0.04 : R * 0.62;
  return [
    `M${pt(0, 0)}`,
    `C${pt(0, -nc)} ${pt(noseLen * (pointy ? 0.55 : 0.38), -R)} ${pt(noseLen, -R)}`,
    `L${pt(tailStart, -R)}`,
    `C${pt(tailStart + tl * 0.55, -R)} ${pt(L - tl * 0.12, -wEnd * 1.3)} ${pt(L, -wEnd)}`,
    `L${pt(L, wEnd)}`,
    `C${pt(L - tl * 0.12, wEnd * 1.3)} ${pt(tailStart + tl * 0.55, R)} ${pt(tailStart, R)}`,
    `L${pt(noseLen, R)}`,
    `C${pt(noseLen * (pointy ? 0.55 : 0.38), R)} ${pt(0, nc)} ${pt(0, 0)}Z`,
  ].join(' ');
}

/**
 * Everything needed to draw the airframe, in metres. Pure function of the spec.
 */
export function planformGeometry(spec) {
  const { L, S, D } = spec;
  const R = D / 2;
  const b = S / 2;
  const noseLen  = spec.supersonic ? D * 5.5 : spec.prop ? D * 1.35 : D * 1.5;
  const tailLen  = spec.supersonic ? D * 3 : spec.prop ? D * 2.4 : D * 2.3;
  const tailStart = L - tailLen;
  const fuselage = fuselagePath(L, D, noseLen, tailStart, spec.supersonic);

  // ── Wing (+y half) ──
  let le, te, wingPath, wingSpec;
  if (spec.supersonic) {
    wingPath = [
      `M${pt(L * 0.24, 0)}`,
      `C${pt(L * 0.42, b * 0.12)} ${pt(L * 0.6, b * 0.5)} ${pt(L * 0.84, b * 0.93)}`,
      `L${pt(L * 0.865, b)} L${pt(L * 0.905, b)} L${pt(L * 0.93, b * 0.4)}`,
      `L${pt(L * 0.955, b * 0.12)} L${pt(L * 0.955, 0)}Z`,
    ].join(' ');
    le = [[L * 0.24, 0], [L * 0.5, b * 0.3], [L * 0.84, b * 0.93], [L * 0.865, b]];
    te = [[L * 0.955, 0], [L * 0.955, b * 0.12], [L * 0.93, b * 0.4], [L * 0.905, b]];
  } else {
    const t = Math.tan(rad(spec.sweep));
    const Cr = spec.kc * S, Ct = Cr * spec.taper;
    const xw = spec.wingX * L;
    const tipLE = [xw + b * t, b];
    const yk = spec.kink ? Math.max(R * 1.15, b * 0.33) : 0;
    le = [[xw, 0]];
    if (spec.raked) {
      const yr = b * 0.9;
      le.push([xw + yr * t, yr]);
      le.push([xw + yr * t + (b - yr) * Math.tan(rad(spec.sweep + 22)), b]);
    } else {
      le.push(tipLE);
    }
    const tipX = le[le.length - 1][0];
    const tipTE = [tipX + Ct * (spec.raked ? 0.5 : 1), b];
    te = [[xw + Cr, 0]];
    if (spec.kink) te.push([xw + Cr + yk * Math.tan(rad(spec.teSweepIn)), yk]);
    te.push(tipTE);
    const outline = [...le, ...te.slice().reverse()];
    wingPath = `M${outline.map(([x, y]) => pt(x, y)).join(' L')}Z`;
    wingSpec = { xw, Cr, Ct, yk };
  }
  const LE = (y) => lerpLine(le, y);
  const TE = (y) => lerpLine(te, y);

  // Hinge line, aileron/flap breaks: what makes a wing read as a wing.
  const surfaceLines = [];
  if (!spec.supersonic) {
    for (const yb of [b * 0.68, wingSpec?.yk || b * 0.38]) {
      const x0 = LE(yb) + (TE(yb) - LE(yb)) * 0.74;
      surfaceLines.push(`M${pt(x0, yb)} L${pt(TE(yb), yb)}`);
    }
  } else {
    for (const yb of [b * 0.25, b * 0.55]) surfaceLines.push(`M${pt(TE(yb) - D * 0.6, yb)} L${pt(TE(yb), yb)}`);
  }

  // Flap-track fairings on swept jets.
  const fairings = [];
  if (spec.kink && !spec.prop) {
    for (const fy of [0.27, 0.45, 0.62, 0.78]) {
      const y = b * fy; if (y < R * 1.3) continue;
      const c = TE(y) - LE(y);
      fairings.push({ x: TE(y) - c * 0.2, y, len: c * 0.42, w: Math.max(0.25, S * 0.011) });
    }
  }

  // ── Surface detail: what makes a flat grey shape read as a wing ──
  // Flaps inboard, aileron outboard (behind the hinge line), a slat strip
  // along the leading edge, spoiler panels ahead of the flaps, and the
  // wing-to-body fairing whose ends show fore and aft of the root.
  const flapSurfaces = [], slats = [], spoilers = [];
  let rootFairing = null;
  if (!spec.supersonic) {
    const yIn = R * 1.02, yOut = b * 0.97, yBreak = b * 0.68;
    const hinge = (y) => LE(y) + (TE(y) - LE(y)) * 0.74;
    const strip = (y0, y1, fx0, fx1, n = 6) => {
      const top = [], bot = [];
      for (let i = 0; i <= n; i++) {
        const y = y0 + (y1 - y0) * (i / n);
        top.push([LE(y) + (TE(y) - LE(y)) * fx0, y]);
        bot.push([LE(y) + (TE(y) - LE(y)) * fx1, y]);
      }
      return `M${[...top, ...bot.reverse()].map(([x, y]) => pt(x, y)).join(' L')}Z`;
    };
    flapSurfaces.push({ kind: 'flap',    d: strip(yIn, yBreak, 0.74, 1) });
    flapSurfaces.push({ kind: 'aileron', d: strip(yBreak, yOut, 0.74, 1) });
    if (!spec.prop || spec.y >= 5) slats.push(strip(yIn, yOut, 0, 0.1));
    if (spec.kink && !spec.prop) {
      const n = spec.y >= 7 ? 5 : 4;
      for (let i = 0; i < n; i++) {
        const y0 = yIn + (yBreak - yIn) * (0.08 + 0.84 * i / n), y1 = yIn + (yBreak - yIn) * (0.08 + 0.84 * (i + 0.82) / n);
        spoilers.push(strip(y0, y1, 0.6, 0.73, 1));
      }
    }
    if (wingSpec && !spec.high) {
      const { xw, Cr } = wingSpec;
      rootFairing = { x: xw - Cr * 0.3, y: -R * 1.16, w: Cr * 1.55, h: R * 2.32, r: R * 0.55 };
    }
  }

  // Winglets: a thin fence at the tip, swept back.
  let winglet = null;
  if (spec.winglets && !spec.raked && !spec.supersonic) {
    const c = TE(b) - LE(b);
    winglet = `M${pt(LE(b) + c * 0.15, b)} L${pt(LE(b) + c * 0.95, b + S * 0.012)} L${pt(TE(b), b)}Z`;
  }

  // ── Horizontal stabiliser (+y half) ──
  let stab = null, stabOnTop = false, stabInfo = null;
  if (spec.tail !== 'none') {
    const ks = spec.prop ? 0.3 : spec.tail === 'T' ? 0.36 : 0.34;
    const bs = (S * ks) / 2;
    const st = Math.tan(rad(spec.prop ? 8 : 30));
    const Csr = D * (spec.prop ? 0.95 : spec.tail === 'T' ? 0.85 : 1.0);
    const Cst = Csr * 0.42;
    const tipTEx = spec.tail === 'T' ? L + D * 0.3 : L - D * 0.05;
    const xs = tipTEx - bs * st - Cst;
    stab = `M${pt(xs, 0)} L${pt(xs + bs * st, bs)} L${pt(xs + bs * st + Cst, bs)} L${pt(xs + Csr, 0)}Z`;
    stabOnTop = spec.tail === 'T';
    stabInfo = { xs, bs, st, Csr, Cst };
  }

  // ── Fin, seen from above: a thin lens on the centreline ──
  const finStart = spec.supersonic ? L * 0.8 : tailStart + tailLen * 0.08;
  const finEnd   = spec.tail === 'T' ? L + D * 0.25 : L - D * 0.03;
  const finW     = D * (spec.supersonic ? 0.09 : 0.11);
  const finMid   = finStart + (finEnd - finStart) * 0.45;
  const fin = `M${pt(finStart, 0)} Q${pt(finMid, -finW)} ${pt(finEnd, -finW * 0.25)} L${pt(finEnd, finW * 0.25)} Q${pt(finMid, finW)} ${pt(finStart, 0)}Z`;
  const tipFins = [];
  if (spec.tail === 'tri' && stabInfo) {
    const y = stabInfo.bs * 0.97, x0 = stabInfo.xs + stabInfo.bs * stabInfo.st;
    tipFins.push({ x0: x0 - D * 0.15, x1: x0 + stabInfo.Cst + D * 0.2, y, w: D * 0.07 });
  }

  // ── Engines ──
  // underWing: drawn before the wing (it hides their back half);
  // overWing / onBody: drawn after.
  const underWing = [], overWing = [], onBody = [], props = [], intakes = [];
  const wingEngines = (n, diaK, positions) => {
    const dia = D * diaK, len = dia * 2.1;
    for (const fy of positions) {
      const y = fy * b;
      underWing.push({ x: LE(y) - len * 0.62, y, len, w: dia, pylonTo: LE(y) + (TE(y) - LE(y)) * 0.35 });
    }
  };
  switch (spec.eng) {
    case 'w2': wingEngines(2, spec.high ? 0.42 : 0.55, [Math.max(0.34, (R + D * 0.55) / b)]); break;
    case 'w4': wingEngines(4, spec.high ? 0.36 : 0.42, spec.high ? [0.26, 0.45] : [0.38, 0.67]); break;
    case 'w6': wingEngines(6, 0.36, [0.27, 0.43, 0.6]); break;
    case 't3': {
      wingEngines(2, 0.5, [0.36]);
      const dia = D * 0.5, len = dia * 2.4;
      onBody.push({ x: finStart - len * 0.35, y: 0, len, w: dia, centre: true });
      break;
    }
    case 'l3': {
      wingEngines(2, 0.5, [0.36]);
      intakes.push({ x: finStart - D * 0.3, len: D * 0.75, w: D * 0.3 });
      break;
    }
    case 'r2': case 'r3': case 'r4': {
      const quad = spec.eng === 'r4';
      const dia = D * (quad ? 0.36 : 0.48), len = dia * (quad ? 2.9 : 2.5);
      const x = tailStart - len * (quad ? 0.55 : 0.45);
      const y1 = R + D * 0.12 + dia / 2;
      onBody.push({ x, y: y1, len, w: dia, pylon: R });
      if (quad) onBody.push({ x, y: y1 + dia * 1.04, len, w: dia });
      if (spec.eng === 'r3') intakes.push({ x: finStart - D * 0.25, len: D * 0.7, w: D * 0.3 });
      break;
    }
    case 'b4': {
      const y0 = R + D * 0.12;
      for (const dy of [0, D * 0.32]) intakes.push({ wingRoot: true, x: LE(y0 + dy) - D * 0.05, y: y0 + dy + D * 0.13, len: D * 0.22, w: D * 0.22 });
      break;
    }
    case 'c4': {
      for (const fy of [0.27, 0.4]) underWing.push({ x: L * 0.76, y: fy * b, len: L * 0.215, w: b * 0.12, box: true });
      break;
    }
    case 'p1': {
      const dp = Math.min(D * 1.6, 2.7);
      props.push({ x: -D * 0.12, y: 0, dia: dp, nose: true });
      break;
    }
    case 'p2': case 'p4': {
      const positions = spec.eng === 'p4' ? [0.25, 0.48] : [Math.max(0.29, (R + D * 0.75) / b)];
      positions.forEach((fy, i) => {
        const y = fy * b;
        const c = TE(y) - LE(y);
        const w = Math.min(D * 0.42, S * 0.04);
        const len = Math.max(c * (spec.high ? 1.3 : 1.15), w * 3.2);
        overWing.push({ x: LE(y) - len * 0.38, y, len, w, nacelle: true });
        // Propeller clears the fuselage and the next prop out.
        const gapIn  = i === 0 ? (y - R) * 2 * 0.92 : (y - positions[i - 1] * b) * 0.95;
        const gapOut = i + 1 < positions.length ? (positions[i + 1] * b - y) * 0.95 : Infinity;
        const dia = Math.min(D * 1.5, gapIn, gapOut, S * 0.16);
        props.push({ x: LE(y) - len * 0.38 - D * 0.08, y, dia });
      });
      break;
    }
  }

  // Elevator hinge, rudder line, APU exhaust, radome joint.
  const elevator = stabInfo
    ? (() => { const { xs, bs, st, Csr, Cst } = stabInfo; const h = (y) => (xs + y * st) + ((y === 0 ? Csr : Cst)) * 0.68;
        return `M${pt(h(0), 0)} L${pt(h(bs), bs)} L${pt(xs + bs * st + Cst, bs)} L${pt(xs + Csr, 0)}Z`; })()
    : null;
  const rudder = `M${pt(finStart + (finEnd - finStart) * 0.62, 0)} L${pt(finEnd, 0)}`;
  const apu = spec.supersonic ? null : { x: L - D * 0.06, r: D * 0.07 };
  const radome = `M${pt(noseLen * 0.22, -R * 0.52)} Q${pt(noseLen * 0.1, 0)} ${pt(noseLen * 0.22, R * 0.52)}`;

  // ── Cockpit glazing: a windscreen band following the nose ──
  const cx0 = spec.supersonic ? noseLen * 0.66 : noseLen * 0.36;
  const cw = R * (spec.supersonic ? 0.42 : 0.62);
  const ca = D * 0.15, ct = D * 0.045;
  const cockpit = `M${pt(cx0 + ca, -cw)} Q${pt(cx0 - ca * 0.5, 0)} ${pt(cx0 + ca, cw)} L${pt(cx0 + ca + ct, cw * 0.9)} Q${pt(cx0 + ct - ca * 0.25, 0)} ${pt(cx0 + ca + ct, -cw * 0.9)}Z`;

  // ── Cabin ──
  const rim = Math.max(0.12, D * 0.075);
  const cabinX0 = noseLen + D * 0.22 + (spec.supersonic ? D * 0.4 : 0);
  const cabinX1 = Math.min(tailStart + D * 0.3, spec.supersonic ? L * 0.8 : Infinity);
  const decks = [{ id: 'main', x0: cabinX0, x1: cabinX1, width: D - rim * 2, y: spec.y }];
  if (spec.hump || spec.deck2) {
    const ux1 = spec.deck2 ? cabinX1 - D * 0.55 : cabinX0 + (cabinX1 - cabinX0) * spec.hump;
    const uy = spec.deck2 ? spec.y - 2 : 6;
    decks.unshift({ id: 'upper', x0: cabinX0 + D * (spec.deck2 ? 0.25 : 0.55), x1: ux1, width: (D - rim * 2) * (spec.deck2 ? 0.86 : 0.62), y: uy, separate: true });
  }

  // High wings pass over the cabin: show the wing box as a dashed outline.
  const wingBoxOverCabin = spec.high && !spec.supersonic ? { x0: LE(R), x1: TE(R) } : null;

  // ── Extent ──
  const propReach = props.reduce((m, p) => Math.max(m, p.y + p.dia / 2), 0);
  const halfH = Math.max(b + (winglet ? S * 0.015 : 0), propReach, stabInfo?.bs ?? 0, R) + S * 0.015;
  const xMin = Math.min(0, ...props.map(p => p.x - D * 0.15)) - L * 0.015;
  const xMax = Math.max(L, finEnd, stabInfo ? stabInfo.xs + stabInfo.bs * stabInfo.st + stabInfo.Cst : 0) + L * 0.015;

  return {
    spec, R, b, noseLen, tailStart, fuselage, wing: wingPath, surfaceLines, fairings, winglet,
    flapSurfaces, slats, spoilers, rootFairing, elevator, rudder, apu, radome,
    stab, stabOnTop, fin, tipFins, underWing, overWing, onBody, props, intakes, cockpit,
    rim, decks, wingBoxOverCabin, extent: { xMin, xMax, halfH },
  };
}

// ── Cabin layout ────────────────────────────────────────────────────────────

export const CABIN_CLASSES = [
  { key: 'firstClass',     short: 'F', space: 2.0 },
  { key: 'businessClass',  short: 'J', space: 1.5 },
  { key: 'premiumEconomy', short: 'W', space: 1.25 },
  { key: 'economy',        short: 'Y', space: 1.0 },
];

/** Seat groups across the cabin for `n` seats abreast, e.g. 9 → [3,3,3]. */
export function seatGroups(n, twinAisle, noAisle = false) {
  if (n <= 0) return [];
  if (noAisle) return [n];
  if (twinAisle) {
    const T = { 10: [3, 4, 3], 9: [3, 3, 3], 8: [2, 4, 2], 7: [2, 3, 2], 6: [2, 2, 2], 5: [2, 1, 2], 4: [1, 2, 1], 3: [1, 1, 1] };
    return T[n] ?? (n > 10 ? [3, n - 6, 3] : [1, 1]);
  }
  const S = { 6: [3, 3], 5: [2, 3], 4: [2, 2], 3: [1, 2], 2: [1, 1], 1: [1] };
  return S[n] ?? [Math.floor(n / 2), Math.ceil(n / 2)];
}

/**
 * Seats across for a class on a deck whose economy is `yAbreast`: the class's
 * seat takes `space` economy seats of floor, so it gets that much less of the
 * width. Rows stay about economy pitch, and the area each seat covers on the
 * drawing is the floor the engine charges for it.
 */
export function classAbreast(space, yAbreast) {
  let n = Math.max(1, Math.round(yAbreast / space));
  if (yAbreast >= 7 && n === 5 && space >= 2) n = 4;
  return n;
}

/**
 * Lay a configuration out on the airframe.
 *
 *   config    { firstClass, businessClass, premiumEconomy, economy }
 *   maxSeats  the type's floor, in economy-seat units (type.seats)
 *   geom      planformGeometry(planformFor(type))
 *
 * → { zones, galleys, seats, totals }. Every configured seat appears exactly
 *   once in `seats`; zone lengths are proportional to floor units; floor the
 *   config leaves unused is an `empty` zone at the back.
 */
/** Floor per seat of a class in THIS config: class multiplier × seat product. */
export function spaceOf(config, cls) {
  const c = CABIN_CLASSES.find(x => x.key === cls);
  return (c?.space ?? 1) * productSpaceMul(config, cls);
}

export function cabinLayout(config, maxSeats, geom) {
  const spec = geom.spec;
  const decks = geom.decks.map(d => {
    const len = d.x1 - d.x0;
    const front = len * (d.id === 'upper' ? 0.07 : 0.045);
    const back  = len * (d.id === 'upper' ? 0.06 : 0.05);
    return { ...d, ux0: d.x0 + front, ux1: d.x1 - back, front, back };
  });
  const galleys = [];
  for (const d of decks) {
    galleys.push({ deck: d.id, x0: d.x0, x1: d.ux0 });
    galleys.push({ deck: d.id, x0: d.ux1, x1: d.x1 });
  }

  // Floor capacity per deck ∝ usable length × economy seats across.
  const weights = decks.map(d => (d.ux1 - d.ux0) * d.y);
  const wsum = weights.reduce((s, w) => s + w, 0) || 1;
  const cap = weights.map(w => (maxSeats * w) / wsum);

  // Walk the classes front to back, upper deck first (premium goes upstairs).
  const order = decks.map((d, i) => i);
  const zones = [];
  let di = 0, used = 0;
  const totals = {};
  for (const cls of CABIN_CLASSES) {
    let n = Math.max(0, Math.floor(config?.[cls.key] ?? 0));
    totals[cls.key] = n;
    while (n > 0) {
      const d = order[di];
      const room = cap[d] - used;
      const sp  = spaceOf(config, cls.key);
      const fit = di === order.length - 1 ? n : Math.min(n, Math.floor((room + 1e-9) / sp));
      if (fit <= 0) { di++; used = 0; continue; }
      zones.push({ deck: decks[d].id, cls: cls.key, short: cls.short, seats: fit, units: fit * sp });
      used += fit * sp;
      n -= fit;
      if (n > 0) { di++; used = 0; }
    }
  }

  // Unused floor: whatever each deck has left.
  for (let i = 0; i < decks.length; i++) {
    const usedHere = zones.filter(z => z.deck === decks[i].id).reduce((s, z) => s + z.units, 0);
    const left = cap[i] - usedHere;
    if (left > 0.5) zones.push({ deck: decks[i].id, cls: 'empty', short: '', seats: 0, units: left });
  }

  // Positions: each deck's zones in order, length ∝ units. A deck that ends up
  // over capacity (the last one, when rounding strands floor upstairs) is
  // squeezed to fit rather than run past the galley.
  const seats = [];
  for (let i = 0; i < decks.length; i++) {
    const d = decks[i];
    const mine = zones.filter(z => z.deck === d.id);
    const units = Math.max(cap[i], mine.reduce((s, z) => s + z.units, 0));
    const perUnit = (d.ux1 - d.ux0) / (units || 1);
    d.cap = cap[i]; d.perUnit = perUnit;
    let x = d.ux0;
    for (const z of mine) {
      z.x0 = x; z.x1 = x + z.units * perUnit; x = z.x1;
      if (z.cls === 'empty') continue;
      const twin = d.y >= 7;
      const prod = config?.products ? productOf(config, z.cls) : null;
      const aisleAccess = !!prod?.extras.some(e => e.key === 'aisle');
      // Direct aisle access is a 1-2-1 (twin aisle) or 1-1 (single) layout
      // whatever the floor says. Otherwise seats across follow the CLASS: a
      // 28" pitch or a lie-flat changes the rows, not the row.
      const clsSpace = CABIN_CLASSES.find(c => c.key === z.cls)?.space ?? 1;
      const a = spec.noAisle ? d.y : aisleAccess ? (twin ? 4 : 2) : classAbreast(clsSpace, d.y);
      const groups = aisleAccess && !spec.noAisle ? (twin ? [1, 2, 1] : [1, 1]) : seatGroups(a, twin, spec.noAisle);
      z.abreast = a; z.groups = groups; z.tier = prod?.tier.key ?? null;
      placeSeats(z, d, groups, a, seats);
    }
  }
  return { zones, galleys, seats, totals, decks };
}

function placeSeats(z, deck, groups, a, out) {
  const rows = Math.ceil(z.seats / a);
  z.rows = rows;
  const pitch = (z.x1 - z.x0) / rows;
  const aisle = Math.min(0.5, deck.width * 0.11);
  const aisles = Math.max(0, groups.length - 1);
  const slot = (deck.width - aisles * aisle) / a;
  // Beds are long: a lie-flat or suite draws deeper than a recliner.
  const bedK = { angled: 1.25, flat: 1.4, suite: 1.5, sleeper: 1.3, apartment: 1.6 }[z.tier] ?? 1;
  const capK = ({ firstClass: 2.4, businessClass: 2.1, premiumEconomy: 1.5, economy: 1.35 }[z.cls]) * bedK;
  const depth = Math.min(pitch * 0.78, slot * capK);
  const wK = z.cls === 'economy' ? 0.86 : 0.8;
  let left = z.seats;
  for (let r = 0; r < rows; r++) {
    const rx = z.x0 + r * pitch + (pitch - depth) * 0.45;
    let y = -deck.width / 2;
    for (let g = 0; g < groups.length; g++) {
      for (let s = 0; s < groups[g]; s++) {
        if (left > 0) {
          out.push({ deck: deck.id, cls: z.cls, x: rx, y: y + slot * (1 - wK) / 2, w: depth, h: slot * wK });
          left--;
        }
        y += slot;
      }
      y += aisle;
    }
  }
}

// ── Painting ────────────────────────────────────────────────────────────────
// The cabin is a run of floor units, always in the order First, Business,
// Premium Economy, Economy, then whatever is left unused. Painting converts
// the floor under the stroke to the brush class; the run is then re-sorted
// into that order and rounded to whole seats. Dragging a divider is a stroke
// that paints the vacated side with the neighbour's class.

/** Floor units per class after painting [xa, xb] (metres) on `deckId` with `cls`. */
export function paintStroke(layout, deckId, xa, xb, cls) {
  const by = { firstClass: 0, businessClass: 0, premiumEconomy: 0, economy: 0, empty: 0 };
  const lo = Math.min(xa, xb), hi = Math.max(xa, xb);
  for (const z of layout.zones) {
    const d = layout.decks.find(x => x.id === z.deck);
    let keep = z.units;
    if (z.deck === deckId && d?.perUnit > 0) {
      const overlap = Math.max(0, Math.min(hi, z.x1) - Math.max(lo, z.x0));
      const painted = Math.min(z.units, overlap / d.perUnit);
      keep -= painted;
      by[cls] += painted;
    }
    by[z.cls] += keep;
  }
  return by;
}

/**
 * Whole seats from floor units, never past the floor: rounded to nearest,
 * then `favour` (the brush class) gives seats back first if that overshoots.
 */
export function unitsToConfig(by, maxSeats, favour = 'economy', config = null) {
  const cfg = {};
  const sp = (c) => spaceOf(config, c.key);
  for (const c of CABIN_CLASSES) cfg[c.key] = Math.max(0, Math.round((by[c.key] ?? 0) / sp(c)));
  const used = () => CABIN_CLASSES.reduce((s, c) => s + cfg[c.key] * sp(c), 0);
  const order = [favour, ...CABIN_CLASSES.map(c => c.key).filter(k => k !== favour)];
  let guard = 0;
  while (used() > maxSeats + 1e-9 && guard++ < 10000) {
    const k = order.find(k => cfg[k] > 0) ?? order[0];
    cfg[k] = Math.max(0, cfg[k] - 1);
    if (cfg[k] === 0) order.push(order.shift());
  }
  return cfg;
}

/** The boundaries a player can drag on a deck: between each pair of zones. */
export function dividers(layout, deckId) {
  const zs = layout.zones.filter(z => z.deck === deckId);
  const out = [];
  for (let i = 1; i < zs.length; i++) {
    out.push({ x: zs[i].x0, left: zs[i - 1], right: zs[i], min: zs[i - 1].x0, max: zs[i].x1 });
  }
  return out;
}

/** Floor units after moving a divider from `fromX` to `toX`. */
export function dragDivider(layout, deckId, div, toX) {
  const x = Math.max(div.min, Math.min(div.max, toX));
  if (x > div.x) return paintStroke(layout, deckId, div.x, x, div.left.cls);
  if (x < div.x) return paintStroke(layout, deckId, x, div.x, div.right.cls);
  return paintStroke(layout, deckId, div.x, div.x, div.left.cls);
}
