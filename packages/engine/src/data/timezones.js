// Standard-time UTC offsets for airports — for timetables, never the tick.
//
// Airports carry a country but no time zone. Timetables (the schedule editor,
// the departure board, the globe's "first departure around 06:00 local") need
// a local clock, so this gives each airport its country's STANDARD offset in
// hours. Daylight saving is ignored on purpose: the game's calendar has no
// DST dates, and a timetable that jumped an hour twice a year would read as a
// bug. Countries spanning several zones are split by longitude (and latitude
// where an island chain sits apart, e.g. Hawaii).
//
// Cosmetic only: nothing in the simulation reads this.

const SINGLE = {
  AE: 4, AF: 4.5, AG: -4, AI: -4, AL: 1, AM: 4, AO: 1, AR: -3, AS: -11, AT: 1, AW: -4, AZ: 4,
  BA: 1, BB: -4, BD: 6, BE: 1, BF: 0, BG: 2, BH: 3, BI: 2, BJ: 1, BL: -4, BM: -4, BN: 8, BO: -4,
  BQ: -4, BS: -5, BT: 6, BW: 2, BY: 3, BZ: -6, CF: 1, CG: 1, CH: 1, CI: 0, CK: -10, CM: 1, CN: 8,
  CO: -5, CR: -6, CU: -5, CV: -1, CW: -4, CY: 2, CZ: 1, DE: 1, DJ: 3, DK: 1, DM: -4, DO: -4,
  DZ: 1, EE: 2, EG: 2, ER: 3, ET: 3, FI: 2, FJ: 12, FO: 0, FR: 1, GA: 1, GB: 0, GD: -4, GE: 4,
  GF: -3, GH: 0, GI: 1, GL: -2, GM: 0, GN: 0, GP: -4, GQ: 1, GR: 2, GT: -6, GU: 10, GW: 0,
  GY: -4, HK: 8, HN: -6, HR: 1, HT: -5, HU: 1, IE: 0, IL: 2, IM: 0, IN: 5.5, IQ: 3, IR: 3.5,
  IS: 0, IT: 1, JE: 0, JM: -5, JO: 3, JP: 9, KE: 3, KG: 6, KH: 7, KM: 3, KN: -4, KP: 9, KR: 9,
  KW: 3, KY: -5, KZ: 5, LA: 7, LB: 2, LC: -4, LK: 5.5, LR: 0, LS: 2, LT: 2, LU: 1, LV: 2, LY: 2,
  MA: 1, MD: 2, ME: 1, MG: 3, MH: 12, MK: 1, ML: 0, MM: 6.5, MO: 8, MP: 10, MQ: -4, MR: 0,
  MT: 1, MU: 4, MV: 5, MW: 2, MY: 8, MZ: 2, NA: 2, NC: 11, NE: 1, NF: 11, NG: 1, NI: -6, NL: 1,
  NO: 1, NP: 5.75, NR: 12, NZ: 12, OM: 4, PA: -5, PE: -5, PG: 10, PH: 8, PK: 5, PL: 1, PM: -3,
  PR: -4, PW: 9, PY: -3, QA: 3, RE: 4, RO: 2, RS: 1, RW: 2, SA: 3, SB: 11, SC: 4, SD: 2, SE: 1,
  SG: 8, SH: 0, SI: 1, SK: 1, SL: 0, SN: 0, SO: 3, SR: -3, SS: 2, ST: 0, SV: -6, SX: -4, SY: 3,
  SZ: 2, TC: -5, TD: 1, TG: 0, TH: 7, TJ: 5, TL: 9, TM: 5, TN: 1, TO: 13, TR: 3, TT: -4, TV: 12,
  TW: 8, TZ: 3, UA: 2, UG: 3, UY: -3, UZ: 5, VC: -4, VE: -4, VG: -4, VN: 7, VU: 11, WS: 13,
  XK: 1, YE: 3, ZA: 2, ZM: 2, ZW: 2,
};

// Countries spanning zones: (lat, lon) → offset.
const MULTI = {
  // Southern Idaho (Boise) is Mountain though west of Las Vegas.
  US: (lat, lon) => (lon < -140 && lat < 30 ? -10 : lon < -130 ? -9
    : lon < -114.5 && !(lat > 42 && lat < 46 && lon > -117.2) ? -8
    : lon < -101 ? -7 : lon < -86.5 ? -6 : -5),
  CA: (lat, lon) => (lon < -120 ? -8 : lon < -101 ? -7 : lon < -90 ? -6 : lon < -67 ? -5
    : lon < -55 ? -4 : -3.5),
  MX: (lat, lon) => (lon < -114 ? -8 : lon < -105.5 ? -7 : lon > -88 ? -5 : -6),
  BR: (lat, lon) => (lon < -66 ? -5 : lon < -54 ? -4 : -3),
  AU: (lat, lon) => (lon < 129 ? 8 : lon < 141 ? 9.5 : 10),
  ID: (lat, lon) => (lon < 114.5 ? 7 : lon < 126 ? 8 : 9),
  // Yakutsk/Chita/Blagoveshchensk (+9) sit at Vladivostok's longitude band.
  RU: (lat, lon) => (lon < 22.5 ? 2 : lon < 50 ? 3 : lon >= 108 && lon < 130 ? 9
    : Math.round(lon / 15) + 1),
  CL: (lat, lon) => (lon < -100 ? -6 : -4),
  EC: (lat, lon) => (lon < -85 ? -6 : -5),
  ES: (lat, lon) => (lon < -10 ? 0 : 1),
  PT: (lat, lon) => (lon < -20 ? -1 : 0),
  CD: (lat, lon) => (lon < 21 ? 1 : 2),
  MN: (lat, lon) => (lon < 99 ? 7 : 8),
  FM: (lat, lon) => (lon < 150 ? 10 : 11),
  KI: (lat, lon) => (lon < 0 ? 14 : lon > 0 && lon < 175 ? 12 : 13),
  PF: (lat, lon) => (lon > -141 ? -9.5 : -10),
};

// Airports a country rule gets wrong — zone borders don't follow longitude
// (the Texas panhandle, Saskatchewan, Arizona's Yuma, Russia's oblasts…).
// Audited against the airports file, 2026-10-14.
const BY_AIRPORT = {
  AMA: -6, LBB: -6, MAF: -6, YUM: -7, IFP: -7, DHN: -6, ESC: -5, ADK: -10,
  YQR: -6, YXE: -6, YLW: -8, YDF: -3.5, YXY: -7, YXJ: -7,
  TPQ: -7, CTM: -5,
  IGU: -3, STM: -3, TBT: -4, FEN: -2,
  AMQ: 9, TTE: 9,
  ASF: 4, IJK: 4, SCW: 3, VKT: 3, SGC: 5, NJC: 5, NUX: 5, DYR: 12,
  TKK: 10, PUQ: -3,
};

/** Standard-time offset from UTC, in hours, for an airport ({ code, country, lat, lon }).
 *  Unknown countries fall back to solar time (longitude ÷ 15, to the half hour). */
export function utcOffsetHours(airport) {
  if (!airport) return 0;
  if (BY_AIRPORT[airport.code] != null) return BY_AIRPORT[airport.code];
  const { country, lat = 0, lon = 0 } = airport;
  if (MULTI[country]) return MULTI[country](lat, lon);
  if (SINGLE[country] != null) return SINGLE[country];
  return Math.round((lon / 15) * 2) / 2;
}

/** Same, in minutes. */
export const utcOffsetMinutes = (airport) => Math.round(utcOffsetHours(airport) * 60);
