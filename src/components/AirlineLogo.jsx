import { useId } from 'react';

// ── Neutral background ────────────────────────────────────────────────────────
// Every preset shares the same greyscale base so the user-chosen accent colour
// is the ONLY colour in the mark and reads cleanly on top. Each instance is
// passed a unique `gid` so the gradient defs never collide on a page.
const BG_TOP = '#2b3441';
const BG_BOT = '#151a22';

function NeutralBG({ gid, r }) {
  return (
    <>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={BG_TOP} />
          <stop offset="100%" stopColor={BG_BOT} />
        </linearGradient>
      </defs>
      <rect width="40" height="40" rx={r} fill={`url(#${gid})`} />
    </>
  );
}

// ── Logo catalogue ────────────────────────────────────────────────────────────
// Each entry: id, name, and a render(gid, r, color) function where
//   gid   = unique gradient/defs ID prefix for this instance
//   r     = corner radius of the background rect
//   color = user-chosen accent color (hex string) — drives the motif on top of
//           the shared greyscale base. White is reserved for small highlights.

const DEFAULT_ACCENT = '#1e9bff';

export const AIRLINE_LOGOS = [
  {
    id: 'horizon',
    name: 'Horizon',
    render(gid, r, color = DEFAULT_ACCENT) {
      return (
        <>
          <NeutralBG gid={gid} r={r} />
          <line x1="6" y1="26" x2="34" y2="26" stroke="rgba(255,255,255,.18)" strokeWidth="0.8" />
          <path d="M 12 26 A 8 8 0 0 1 28 26" fill="none" stroke={color} strokeWidth="2.8" strokeLinecap="round" />
          <line x1="20" y1="26" x2="20" y2="11" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
          <line x1="20" y1="20" x2="13" y2="14" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
          <line x1="20" y1="20" x2="27" y2="14" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
        </>
      );
    },
  },
  {
    id: 'eagle',
    name: 'Eagle',
    render(gid, r, color = DEFAULT_ACCENT) {
      return (
        <>
          <NeutralBG gid={gid} r={r} />
          <path d="M 5 29 C 9 20 16 13 22 15 C 27 17 25 26 30 23 C 34 21 37 16 37 16"
            fill="none" stroke={color} strokeWidth="2.8" strokeLinecap="round" />
          <path d="M 5 29 C 11 25 20 23 30 27"
            fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeOpacity="0.4" />
        </>
      );
    },
  },
  {
    id: 'compass',
    name: 'Compass',
    render(gid, r, color = DEFAULT_ACCENT) {
      return (
        <>
          <NeutralBG gid={gid} r={r} />
          <polygon points="20,7  22,18  20,20  18,18" fill={color} />
          <polygon points="20,33 22,22  20,20  18,22" fill={color} />
          <polygon points="7,20  18,22  20,20  18,18" fill={color} />
          <polygon points="33,20 22,18  20,20  22,22" fill={color} />
          <polygon points="10,10 17,17 20,20 16,18" fill={color} opacity="0.45" />
          <polygon points="30,10 23,17 20,20 24,18" fill={color} opacity="0.45" />
          <polygon points="10,30 17,23 20,20 16,22" fill={color} opacity="0.45" />
          <polygon points="30,30 23,23 20,20 24,22" fill={color} opacity="0.45" />
          <circle cx="20" cy="20" r="2.5" fill={color} />
        </>
      );
    },
  },
  {
    id: 'jade',
    name: 'Jade',
    render(gid, r, color = DEFAULT_ACCENT) {
      return (
        <>
          <NeutralBG gid={gid} r={r} />
          <path d="M 6 30 C 10 18 20 11 35 14"
            fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" />
          <path d="M 6 30 C 13 25 24 23 35 26"
            fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeOpacity="0.35" />
        </>
      );
    },
  },
  {
    id: 'arctic',
    name: 'Arctic',
    render(gid, r, color = DEFAULT_ACCENT) {
      return (
        <>
          <NeutralBG gid={gid} r={r} />
          <line x1="20" y1="7"  x2="20" y2="33" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
          <line x1="7"  y1="20" x2="33" y2="20" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
          <line x1="10" y1="10" x2="30" y2="30" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
          <line x1="30" y1="10" x2="10" y2="30" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
          <line x1="16" y1="11" x2="24" y2="11" stroke={color} strokeWidth="1.1" />
          <line x1="16" y1="29" x2="24" y2="29" stroke={color} strokeWidth="1.1" />
          <line x1="11" y1="16" x2="11" y2="24" stroke={color} strokeWidth="1.1" />
          <line x1="29" y1="16" x2="29" y2="24" stroke={color} strokeWidth="1.1" />
          <circle cx="20" cy="20" r="2.8" fill={color} />
        </>
      );
    },
  },
  {
    id: 'sapphire',
    name: 'Sapphire',
    render(gid, r, color = DEFAULT_ACCENT) {
      return (
        <>
          <NeutralBG gid={gid} r={r} />
          <polygon points="20,7  33,20  20,33  7,20"
            fill="none" stroke={color} strokeWidth="2.5" />
          <polygon points="20,13 27,20  20,27  13,20"
            fill={color} opacity="0.45" />
          <path d="M 20 7 L 27 14 L 20 14 Z"
            fill={color} opacity="0.25" />
        </>
      );
    },
  },
  {
    id: 'crown',
    name: 'Crown',
    render(gid, r, color = DEFAULT_ACCENT) {
      return (
        <>
          <NeutralBG gid={gid} r={r} />
          <path d="M 8 29 L 8 18 L 14 24 L 20 11 L 26 24 L 32 18 L 32 29 Z"
            fill={color} />
          <rect x="8" y="28" width="24" height="3.5" rx="1.5" fill={color} />
          <circle cx="20" cy="18.5" r="2.2" fill="rgba(255,255,255,.9)" />
          <circle cx="13" cy="23.5" r="1.5" fill="rgba(255,255,255,.55)" />
          <circle cx="27" cy="23.5" r="1.5" fill="rgba(255,255,255,.55)" />
        </>
      );
    },
  },
  {
    id: 'bolt',
    name: 'Bolt',
    render(gid, r, color = DEFAULT_ACCENT) {
      return (
        <>
          <NeutralBG gid={gid} r={r} />
          <polygon points="23,6 12,22 19.5,22 17,34 28,18 20.5,18" fill={color} />
        </>
      );
    },
  },
  {
    id: 'phoenix',
    name: 'Phoenix',
    render(gid, r, color = DEFAULT_ACCENT) {
      return (
        <>
          <NeutralBG gid={gid} r={r} />
          <path d="M 7 33 C 7 22 12 14 20 9 C 28 14 33 22 33 33"
            fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" />
          <path d="M 13 33 C 14 22 17 15 20 9 C 23 15 26 22 27 33 Z"
            fill={color} opacity="0.22" />
          <circle cx="20" cy="9" r="2.8" fill={color} />
        </>
      );
    },
  },
  {
    id: 'comet',
    name: 'Comet',
    render(gid, r, color = DEFAULT_ACCENT) {
      return (
        <>
          <NeutralBG gid={gid} r={r} />
          <line x1="26" y1="16" x2="7"  y2="35" stroke="rgba(255,255,255,.85)" strokeWidth="2.5" strokeLinecap="round" />
          <line x1="24" y1="18" x2="9"  y2="36" stroke="rgba(255,255,255,.5)"  strokeWidth="1.5" strokeLinecap="round" />
          <line x1="22" y1="15" x2="6"  y2="30" stroke="rgba(255,255,255,.3)"  strokeWidth="1"   strokeLinecap="round" />
          <circle cx="29" cy="12" r="4.5" fill="#ffffff" />
          <circle cx="29" cy="12" r="2.5" fill={color} />
        </>
      );
    },
  },
  {
    id: 'summit',
    name: 'Summit',
    render(gid, r, color = DEFAULT_ACCENT) {
      return (
        <>
          <NeutralBG gid={gid} r={r} />
          <polygon points="28,13 37,30 19,30" fill={color} opacity="0.35" />
          <polygon points="20,8 32,30 8,30" fill={color} opacity="0.85" />
          <polygon points="20,8 24.5,17 15.5,17" fill="rgba(255,255,255,.9)" />
        </>
      );
    },
  },
  {
    id: 'prism',
    name: 'Prism',
    render(gid, r, color = DEFAULT_ACCENT) {
      // Prism is intentionally multi-colour (light dispersion); the accent
      // tints the glass outline while the spectrum stays fixed.
      return (
        <>
          <NeutralBG gid={gid} r={r} />
          <polygon points="20,7 34,31 6,31"
            fill="none" stroke={color} strokeWidth="1.8" strokeOpacity="0.85" />
          <line x1="20" y1="7" x2="34" y2="31" stroke="#ff5555" strokeWidth="1.2" opacity=".8" />
          <line x1="20" y1="7" x2="29" y2="31" stroke="#ffaa00" strokeWidth="1.2" opacity=".8" />
          <line x1="20" y1="7" x2="24" y2="31" stroke="#ffee00" strokeWidth="1.2" opacity=".7" />
          <line x1="20" y1="7" x2="19" y2="31" stroke="#44ee44" strokeWidth="1.2" opacity=".8" />
          <line x1="20" y1="7" x2="14" y2="31" stroke="#44aaff" strokeWidth="1.2" opacity=".8" />
          <line x1="20" y1="7" x2="6"  y2="31" stroke="#bb44ff" strokeWidth="1.2" opacity=".8" />
        </>
      );
    },
  },
  {
    id: 'jet',
    name: 'Jet',
    render(gid, r, color = DEFAULT_ACCENT) {
      return (
        <>
          <NeutralBG gid={gid} r={r} />
          <path d="M 7 30 L 31 9 L 27 19 L 33 17 L 18 31 L 21 22 Z" fill={color} />
          <path d="M 7 30 L 18 31 L 14 34 Z" fill={color} opacity="0.45" />
        </>
      );
    },
  },
  {
    id: 'orbit',
    name: 'Orbit',
    render(gid, r, color = DEFAULT_ACCENT) {
      return (
        <>
          <NeutralBG gid={gid} r={r} />
          <circle cx="20" cy="20" r="4" fill={color} />
          <ellipse cx="20" cy="20" rx="13" ry="6" fill="none" stroke={color} strokeWidth="1.6" opacity="0.85" />
          <ellipse cx="20" cy="20" rx="13" ry="6" fill="none" stroke={color} strokeWidth="1.2" opacity="0.4"
            transform="rotate(60 20 20)" />
          <ellipse cx="20" cy="20" rx="13" ry="6" fill="none" stroke={color} strokeWidth="1.2" opacity="0.4"
            transform="rotate(120 20 20)" />
          <circle cx="33" cy="20" r="1.8" fill={color} />
        </>
      );
    },
  },
  {
    id: 'delta',
    name: 'Delta',
    render(gid, r, color = DEFAULT_ACCENT) {
      return (
        <>
          <NeutralBG gid={gid} r={r} />
          <polygon points="20,8 31,30 20,24 9,30" fill={color} />
          <polygon points="20,8 25.5,19 20,17 14.5,19" fill={color} opacity="0.45" />
        </>
      );
    },
  },
  {
    id: 'sunburst',
    name: 'Sunburst',
    render(gid, r, color = DEFAULT_ACCENT) {
      const rays = Array.from({ length: 12 }, (_, i) => {
        const a = (i * 30 * Math.PI) / 180;
        return (
          <line key={i}
            x1={20 + Math.cos(a) * 9}  y1={20 + Math.sin(a) * 9}
            x2={20 + Math.cos(a) * 15} y2={20 + Math.sin(a) * 15}
            stroke={color} strokeWidth="1.8" strokeLinecap="round" />
        );
      });
      return (
        <>
          <NeutralBG gid={gid} r={r} />
          {rays}
          <circle cx="20" cy="20" r="6.5" fill={color} />
        </>
      );
    },
  },
  {
    id: 'globe',
    name: 'Globe',
    render(gid, r, color = DEFAULT_ACCENT) {
      return (
        <>
          <NeutralBG gid={gid} r={r} />
          <circle cx="20" cy="20" r="13" fill="none" stroke={color} strokeWidth="1.8" />
          <ellipse cx="20" cy="20" rx="5" ry="13" fill="none" stroke={color} strokeWidth="1.1" opacity="0.7" />
          <line x1="7" y1="20" x2="33" y2="20" stroke={color} strokeWidth="1.1" opacity="0.7" />
          <path d="M 8.5 14 H 31.5" stroke={color} strokeWidth="1" opacity="0.5" />
          <path d="M 8.5 26 H 31.5" stroke={color} strokeWidth="1" opacity="0.5" />
        </>
      );
    },
  },
  {
    id: 'wing',
    name: 'Wing',
    render(gid, r, color = DEFAULT_ACCENT) {
      return (
        <>
          <NeutralBG gid={gid} r={r} />
          <path d="M 6 28 C 18 27 27 22 34 11" fill="none" stroke={color} strokeWidth="2.8" strokeLinecap="round" />
          <path d="M 9 31 C 19 30 26 26 31 19" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" opacity="0.55" />
          <path d="M 12 33 C 20 33 25 30 29 25" fill="none" stroke={color} strokeWidth="1.2" strokeLinecap="round" opacity="0.3" />
        </>
      );
    },
  },
  {
    id: 'star',
    name: 'Star',
    render(gid, r, color = DEFAULT_ACCENT) {
      return (
        <>
          <NeutralBG gid={gid} r={r} />
          <polygon points="20,6 23.5,16 34,16 25.5,22.5 28.8,33 20,26.5 11.2,33 14.5,22.5 6,16 16.5,16"
            fill={color} />
        </>
      );
    },
  },
];

export const LOGO_MAP = Object.fromEntries(AIRLINE_LOGOS.map(l => [l.id, l]));

// ── Renderer ──────────────────────────────────────────────────────────────────

/**
 * Renders an airline logo by ID.
 *   id          — one of the AIRLINE_LOGOS ids
 *   size        — px size (width = height, default 40)
 *   radius      — corner radius; default 20% of size
 *   accentColor — hex color applied to the logo's main accent elements
 *   customSrc   — data/image URL of a user-uploaded logo; when set it
 *                 overrides the preset and is drawn clipped to the rounded
 *                 square (so it matches the look of the built-in logos)
 *   style       — extra inline styles on the wrapping <svg>
 */
export default function AirlineLogo({ id, size = 40, radius, accentColor, customSrc, style, className }) {
  const uid  = useId().replace(/:/g, '');
  const gid  = `lg-${id}-${uid}`;
  const logo = LOGO_MAP[id];
  const r    = radius ?? Math.round(size * 0.2);

  // ── User-uploaded custom logo ──────────────────────────────────────────────
  if (customSrc) {
    const cid = `clip-${uid}`;
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 40 40"
        style={{ flexShrink: 0, display: 'block', ...style }}
        className={className}
      >
        <defs>
          <clipPath id={cid}>
            <rect width="40" height="40" rx={r} />
          </clipPath>
        </defs>
        <rect width="40" height="40" rx={r} fill="#15202f" />
        <image
          href={customSrc}
          width="40"
          height="40"
          preserveAspectRatio="xMidYMid slice"
          clipPath={`url(#${cid})`}
        />
      </svg>
    );
  }

  if (!logo) {
    return (
      <svg width={size} height={size} viewBox="0 0 40 40" style={style} className={className}>
        <rect width="40" height="40" rx={r} fill="#15202f" />
        <text x="20" y="26" textAnchor="middle" fill="#93a4ba"
          fontSize="20" fontWeight="700" fontFamily="system-ui">
          ?
        </text>
      </svg>
    );
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      style={{ flexShrink: 0, display: 'block', ...style }}
      className={className}
    >
      {logo.render(gid, r, accentColor)}
    </svg>
  );
}
