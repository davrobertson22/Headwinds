// Real-world programme sizes, used to scale launch-customer minimums.
//
// Frames built of each in-game type (approximate, civil builds where the
// military run dwarfs the airline one). For programmes still in production,
// or that never delivered, the figure is total firm orders at their peak.
// Types missing here fall back to the class default in productionLines.js.
//
// Shared by convention with Tailwinds: keep the two files identical.
export const REAL_BUILDS = {
  concorde: 20,
  a220100: 80, a220: 750,
  a318: 80, a319ceo: 1486, a320ceo: 4751, a321ceo: 1791,
  a319neo: 50, a320neo: 4000, a321neo: 6000, a321xlr: 550,
  a300b4: 248, a300600r: 200, a300600f: 100, a310200: 85, a310300: 170,
  a330200: 670, a330300: 780, a330200f: 38, a330neo: 300, a330800: 20,
  a340300: 218, a340600: 97,
  a350900: 950, a350900ulr: 7, a3501000: 350, a3501000ulr: 12, a350f: 60,
  a380: 251,
  casacn235: 290, l410: 1200, an148: 45,
  atr42: 120, atr72: 900, atr72f: 40,
  b1900d: 439,
  b707120: 140, b707320: 175, b707320c: 335, b720b: 154,
  b727100: 407, b727100c: 164, b727200: 1260, b727200f: 15,
  b737100: 30, b737200: 1095, b737300: 1113, b737400: 486, b737500: 389,
  b737700: 1128, b737800: 4991, b737900er: 505,
  b737max7: 300, b737max8: 3000, b737max8200: 360, b737max9: 300, b737max10: 1000,
  b737300f: 120, b737400f: 150, b737800bcf: 300,
  b717: 156,
  b757200: 913, b757300: 55, b757200pf: 80,
  b767200er: 121, b767300: 583, b767400er: 38, b767300f: 250, b767200sf: 70,
  b7878: 450, b7879: 1100, b787x10: 250,
  b777200er: 422, b777200lr: 61, b777300er: 838, b777f: 350,
  b7778x: 50, b7779x: 450, b7778f: 60,
  b747100: 205, b747200: 225, b747200f: 73, b747sp: 45, b747300: 81,
  b747400: 442, b747400d: 19, b747400f: 126, b7478i: 48, b7478f: 107,
  crj200: 1021, crj700: 330, crj900: 500, crj1000: 60,
  bae146200: 115, avrorj85: 87,
  bn2islander: 1280, c208b: 2500, c408: 100, pc12: 2000,
  arj21: 600, c919: 1000,
  dhc6: 150, dash7: 113, dhc8100: 299, dhc8200: 105, dhc8300: 267, q400: 585,
  emb110: 494, emb120: 354,
  erj135: 108, erj145: 708, erj170: 191, e175: 900, e190: 568, e195: 172,
  e190e2: 40, e195e2: 300, e190f: 30, a321p2f: 200,
  fokker70: 47, fokker100: 283, f27: 586, f28: 241,
  il96300: 30, il62m: 190, il86: 106, il76t: 120, il14: 1348, il18: 564,
  mc21300: 175, mc21310: 175,
  l1011: 250, l188: 170, l188f: 40, l10030: 70,
  dc3: 607, c47: 10000, c46: 3181, dc4: 79, dc6b: 288, dc7c: 121,
  dc830: 57, dc863: 107, dc863cf: 53, dc873f: 50,
  dc910: 137, dc930: 662, dc950: 96, md80: 1191, md90: 116,
  dc1030: 163, dc1030f: 36, md11: 131, md11f: 53,
  spacejet: 213,
  saab340a: 159, saab340: 300, saab2000: 63,
  short360: 164,
  ssj100: 230, sj100new: 100,
  tu104: 201, tu134: 852, tu154m: 320, tu204: 85,
  yak40: 1011, yak42: 185,
  an12: 1248, an24: 1367, an124: 55, an225: 1,
  caravelle: 282, trident3b: 26, vc10: 54, cv990: 37, bac111: 87,
  do228: 300, do328: 217, do328jet: 110,
  js31: 386, js41: 104,
  ma60: 120, ma600: 20,
  cl44: 27,
  northstar: 71, l749: 119, l1049: 24, l1049g: 99, l1649: 44,
  cv240: 176, cv440: 199, cv580: 175, m404: 103, b377: 56,
  comet1: 12, comet4: 76,
  viscount700: 287, viscount800: 150, britannia: 45, vanguard: 44, hs748: 380,
  // Business jets (Tailwinds only; unused ids are harmless here).
  cl350: 450, cj4: 400, phenom300e: 750, g650er: 500,
};

export function realBuilt(typeOrId) {
  const id = typeof typeOrId === 'string' ? typeOrId : typeOrId?.id;
  const n = REAL_BUILDS[id];
  return Number.isFinite(n) && n > 0 ? n : null;
}
