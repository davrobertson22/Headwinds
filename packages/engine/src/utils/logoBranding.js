// Airline branding helpers shared by the logo picker, the rival displays, the
// departure board and the livery painter. Pure (no React, no DOM), so the
// engine tests can import it.
//
//   LOGO_COLORS          the logo-colour palette (SetupScreen re-exports it as
//                        ACCENT_COLORS for older imports)
//   TILE_COLORS          the second colour: the tile behind a preset mark
//   fieldLogoColors      a colour for every rival, so no two airlines in a
//                        game share the same mark in the same colour
//   carrierLogo          { id, accentColor, bgColor, customSrc } for any
//                        carrier (the player or a rival)
//   normalizeAirlineCode / suggestAirlineCode   the two-character airline code
//   contrastRatio / markColorOn                 legibility checks

// ── Palettes ─────────────────────────────────────────────────────────────────
// Ordered as a continuous rainbow spectrum (red → violet), then neutrals.
export const LOGO_COLORS = [
  { hex: '#ff3b3b', label: 'Crimson'    },
  { hex: '#ff6b35', label: 'Coral'      },
  { hex: '#ff8c00', label: 'Orange'     },
  { hex: '#ffa200', label: 'Amber'      },
  { hex: '#ffd000', label: 'Gold'       },
  { hex: '#ffe600', label: 'Sun'        },
  { hex: '#c6e600', label: 'Lime'       },
  { hex: '#5fd23a', label: 'Green'      },
  { hex: '#1fbf6b', label: 'Emerald'    },
  { hex: '#00c9a7', label: 'Teal'       },
  { hex: '#00bcd4', label: 'Cyan'       },
  { hex: '#1e9bff', label: 'Sky'        },
  { hex: '#3b6bff', label: 'Blue'       },
  { hex: '#6b4bff', label: 'Indigo'     },
  { hex: '#9b4dff', label: 'Violet'     },
  { hex: '#c44dff', label: 'Purple'     },
  { hex: '#ff4dd2', label: 'Magenta'    },
  { hex: '#ff6fae', label: 'Pink'       },
  { hex: '#d0a8ff', label: 'Lavender'   },
  { hex: '#ffffff', label: 'White'      },
  { hex: '#c0cad8', label: 'Silver'     },
];

/**
 * The tile behind a preset mark. `null` is the original dark gradient every
 * logo had before tiles could be chosen, so saves without `logoBg` look the
 * same. Deep colours first (they suit most marks), then the bright palette.
 */
export const TILE_COLORS = [
  { hex: null,      label: 'Dark (default)' },
  { hex: '#0b0e13', label: 'Black'    },
  { hex: '#14254a', label: 'Navy'     },
  { hex: '#4a0f1c', label: 'Burgundy' },
  { hex: '#0f3a2a', label: 'Forest'   },
  { hex: '#3a1f5c', label: 'Plum'     },
  { hex: '#5a3a12', label: 'Bronze'   },
  ...LOGO_COLORS,
];

/** The colour a `null` tile reads as, for contrast checks (mid-gradient). */
export const DEFAULT_TILE_BASE = '#202733';

/** Fallback logo colour when nothing sets one (AirlineLogo's own default). */
export const DEFAULT_LOGO_COLOR = '#1e9bff';

const HEX6 = /^#[0-9a-f]{6}$/i;

/** '#ABC' / 'aabbcc' / '#AaBbCc' → '#aabbcc', else null. */
export function cleanHex(v) {
  if (typeof v !== 'string') return null;
  let s = v.trim();
  if (!s.startsWith('#')) s = `#${s}`;
  const m3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(s);
  if (m3) s = `#${m3[1]}${m3[1]}${m3[2]}${m3[2]}${m3[3]}${m3[3]}`;
  return HEX6.test(s) ? s.toLowerCase() : null;
}

// ── Contrast ─────────────────────────────────────────────────────────────────

function luminance(hex) {
  const h = cleanHex(hex);
  if (!h) return 0;
  const n = parseInt(h.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/** WCAG contrast ratio between two colours, 1 (identical) … 21. */
export function contrastRatio(a, b) {
  const la = luminance(a), lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Below this the mark stops reading against what it sits on. */
export const MIN_MARK_CONTRAST = 1.8;

const MARK_LIGHT = '#ffffff';
const MARK_DARK  = '#15202f';

/**
 * The colour to draw a mark in when it sits straight on `bg` (a fin, a
 * fuselage): the airline's own colour when it reads, else white (or ink on
 * pale paint) — a white kangaroo on a red tail, not a red one.
 */
export function markColorOn(bg, accent) {
  const acc = cleanHex(accent) ?? DEFAULT_LOGO_COLOR;
  const base = cleanHex(bg);
  if (!base) return acc;
  if (contrastRatio(acc, base) >= MIN_MARK_CONTRAST) return acc;
  // White is how real tails do it, so it wins whenever it reads at all; ink
  // only on pale paint (yellow, silver, white) where white would vanish.
  return contrastRatio(MARK_LIGHT, base) >= 2.5 ? MARK_LIGHT : MARK_DARK;
}

/** True when a mark in `accent` on a tile of `bg` (null = default) is hard to see. */
export function lowContrastTile(accent, bg) {
  return contrastRatio(cleanHex(accent) ?? DEFAULT_LOGO_COLOR, cleanHex(bg) ?? DEFAULT_TILE_BASE) < MIN_MARK_CONTRAST;
}

// ── Rival colours ────────────────────────────────────────────────────────────
// Rivals never carried a colour, so every one drew in the default blue and two
// rivals on the same preset were indistinguishable. Each rival now gets a
// colour that suits its tier, picked by a hash of its name (stable for the
// game's life), and no two airlines — the player included — share the same
// preset in the same colour on the same tile. The player is placed first and
// always keeps their choice: a rival on the player's mark simply takes the
// next free colour.
//
// Multiplayer (Headwinds): a rival flagged `human` is another player. Their
// colour is their own choice and is never changed — humans are placed right
// after you, before any AI carrier, and brandingClash() stops two players from
// picking the same look in the first place.

const TIER_PALETTES = {
  budget:  ['#ff8c00', '#ffa200', '#c6e600', '#ff4dd2', '#ff6b35', '#ffe600', '#ff6fae', '#5fd23a'],
  legacy:  ['#ff3b3b', '#3b6bff', '#1e9bff', '#1fbf6b', '#00c9a7', '#6b4bff', '#00bcd4'],
  premium: ['#ffd000', '#9b4dff', '#c44dff', '#d0a8ff', '#c0cad8', '#ffffff'],
};
const ALL_HEX = LOGO_COLORS.map(c => c.hex);

function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const comboKey = (logoId, color, bg) => `${logoId}|${cleanHex(color) ?? ''}|${cleanHex(bg) ?? ''}`;

const fieldCache = new WeakMap();

/**
 * { [competitorId]: '#rrggbb' } for every rival in the game.
 * `state` needs { competitors, logoId, logoColor, logoBg, customLogo }.
 * A rival that already carries an explicit `logoColor` keeps it when free.
 */
export function fieldLogoColors(state) {
  const comps = Array.isArray(state?.competitors) ? state.competitors : [];
  const playerKey = state?.customLogo ? 'custom' : comboKey(state?.logoId, state?.logoColor, state?.logoBg);
  const hit = fieldCache.get(comps);
  if (hit && hit.playerKey === playerKey) return hit.colors;

  const taken = new Set();
  if (!state?.customLogo && state?.logoId) taken.add(playerKey);
  const colors = {};
  for (const c of comps) {
    if (!c?.human || c.customLogo || !cleanHex(c.logoColor)) continue;
    colors[c.id ?? c.name] = cleanHex(c.logoColor);
    taken.add(comboKey(c.logoId, c.logoColor, c.logoBg));
  }
  for (const c of comps) {
    if (!c) continue;
    const id = c.id ?? c.name;
    if (colors[id]) continue;                         // a player's own pick, placed above
    if (c.customLogo) continue;                       // an uploaded mark collides with nothing
    const tierPal = TIER_PALETTES[c.tier] ?? TIER_PALETTES.legacy;
    const start = hash32(String(c.name ?? id)) % tierPal.length;
    const order = [
      ...(cleanHex(c.logoColor) ? [cleanHex(c.logoColor)] : []),
      ...tierPal.slice(start), ...tierPal.slice(0, start),
      ...ALL_HEX,
    ];
    let pick = order.find(hex => !taken.has(comboKey(c.logoId, hex, c.logoBg)));
    if (!pick) pick = order[0];
    taken.add(comboKey(c.logoId, pick, c.logoBg));
    colors[id] = pick;
  }
  fieldCache.set(comps, { playerKey, colors });
  return colors;
}

export const PLAYER_ID = '__player__';

/**
 * Logo props for any carrier: pass the result straight to <AirlineLogo>
 * ({ id, accentColor, bgColor, customSrc }). `carrier` is the player when it
 * is flagged isPlayer or has the player's id; otherwise a competitor record
 * (or anything with its id/name/logoId).
 */
export function carrierLogo(state, carrier) {
  if (!carrier || carrier.isPlayer || carrier.id === PLAYER_ID) {
    return { id: state?.logoId, accentColor: state?.logoColor, bgColor: state?.logoBg ?? null, customSrc: state?.customLogo ?? null };
  }
  const id = carrier.id ?? carrier.name;
  const colors = fieldLogoColors(state);
  return {
    id: carrier.logoId,
    accentColor: colors[id] ?? cleanHex(carrier.logoColor) ?? undefined,
    bgColor: carrier.logoBg ?? null,
    customSrc: carrier.customLogo ?? null,
  };
}

// ── Airline code ─────────────────────────────────────────────────────────────
// A two-character designator like QF or UA, chosen by the player. Letters and
// digits, at least one letter (real codes run from AA to 9W — never 99).

/** 'qf' → 'QF'; anything that isn't a valid two-character code → null. */
export function normalizeAirlineCode(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toUpperCase();
  return /^[A-Z0-9]{2}$/.test(s) && /[A-Z]/.test(s) ? s : null;
}

/** The code a name suggests: initials of the first two words, else its first two letters. */
export function suggestAirlineCode(name) {
  const words = String(name ?? '').toUpperCase().replace(/[^A-Z ]/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length >= 2) return words[0][0] + words[1][0];
  const w = words[0] ?? '';
  return w.length >= 2 ? w.slice(0, 2) : '';
}

// ── Multiplayer: one look and one code per airline ──────────────────────────

/** "Bolt in Crimson on the default tile" — for messages. */
export function describeLook(logoId, color, bg, logoName = (id) => id) {
  const col = LOGO_COLORS.find(c => c.hex === cleanHex(color))?.label ?? 'a custom colour';
  const tile = cleanHex(bg) ? (TILE_COLORS.find(c => c.hex === cleanHex(bg))?.label ?? 'a custom').toLowerCase() : 'the default';
  return `${logoName(logoId)} in ${col} on ${tile} tile`;
}

const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const presetName = (id) => capitalize(String(id ?? 'that'));

/**
 * Why a rebrand would copy another PLAYER's look or code, or null.
 * `state` is the airline as it stands (with `competitors` — in Headwinds the
 * other players, each flagged `human`); `change` is the SET_BRANDING payload.
 * Only what the change touches is checked, so a name-only rebrand never trips
 * over a clash that predates this rule. AI rivals never block: they step
 * aside (fieldLogoColors). Uploaded logos are never compared.
 */
export function brandingClash(state, change = {}) {
  const humans = (state?.competitors ?? []).filter(c => c?.human);
  if (!humans.length) return null;
  if ('airlineCode' in change) {
    const code = normalizeAirlineCode(change.airlineCode);
    if (code && code !== normalizeAirlineCode(state?.airlineCode)) {
      const owner = humans.find(c => normalizeAirlineCode(c.airlineCode) === code);
      if (owner) return `${code} is already ${owner.name}’s airline code — please choose another.`;
    }
  }
  const touchesLook = ['logoId', 'logoColor', 'logoBg', 'customLogo'].some(k => k in change);
  if (!touchesLook) return null;
  const custom = 'customLogo' in change ? change.customLogo : state?.customLogo;
  if (custom) return null;
  const logoId = 'logoId' in change ? change.logoId : state?.logoId;
  const color = 'logoColor' in change ? change.logoColor : state?.logoColor;
  const bg = 'logoBg' in change ? change.logoBg : state?.logoBg;
  const mine = comboKey(logoId, color, bg);
  if (mine === comboKey(state?.logoId, state?.logoColor, state?.logoBg) && !state?.customLogo) return null;
  const owner = humans.find(c => !c.customLogo && comboKey(c.logoId, c.logoColor, c.logoBg) === mine);
  if (owner) return `${owner.name} already flies the ${describeLook(logoId, color, bg, presetName)} — pick another colour or tile.`;
  return null;
}

/** The other players' looks and codes, for the picker to mark as taken. */
export function takenBranding(state) {
  const humans = (state?.competitors ?? []).filter(c => c?.human);
  const looks = new Map(), codes = new Map();
  for (const c of humans) {
    if (!c.customLogo && c.logoId) looks.set(comboKey(c.logoId, c.logoColor, c.logoBg), c.name);
    const code = normalizeAirlineCode(c.airlineCode);
    if (code) codes.set(code, c.name);
  }
  return {
    look: (logoId, color, bg) => looks.get(comboKey(logoId, color, bg)) ?? null,
    code: (code) => codes.get(normalizeAirlineCode(code)) ?? null,
    any: humans.length > 0,
  };
}
