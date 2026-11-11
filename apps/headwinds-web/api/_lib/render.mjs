// Server-rendered public world pages — /worlds and /worlds/:id.
// ----------------------------------------------------------------------------
// Why these exist (AdSense "Low value content", round 5, 2026-09-10): the game
// itself sits behind a sign-in, so to a reviewer, a crawler or a link preview
// the whole product was a login form plus a set of guide pages — and those
// guides share a template with Tailwinds, a site the same account already has
// approved. Nothing on the domain showed that real people are running real
// airlines here. These pages do: every public world's standings and headlines,
// rendered as plain HTML by a Vercel function so no JavaScript is needed to
// read them.
//
// This module is PURE — it takes API JSON and returns strings — so it can be
// unit-tested without a network (tools/worlds-pages-test.mjs). The handlers in
// api/worlds.mjs and api/sitemap-worlds.mjs do the fetching.
//
// Privacy: the server already treats a PUBLIC world's standings and news as
// readable by anyone (worlds.mjs / news.mjs `optionalAccount`), and since
// 2026-11-10 it answers a signed-out caller with the people taken out
// (server lib/publicView.mjs). What we emit is a strict subset again, and
// about AIRLINES only: names, hubs, alliances, logos and liveries, fleet and
// route counts, the average profit the rank is decided on, market cap. Never
// an account id, a player's name, `lastMoveAt` or an account badge — see
// stripStanding(). Private worlds render as a 404.
//
// The other public pages (an airline's own page, a world's season so far, the
// hall of fame) are in renderMore.mjs and share everything exported here.
import { logoSvg, finSvg } from './brand.mjs';
import { hubMapSvg } from './maps.mjs';

const DOMAIN = 'www.headwindsairlinegame.com';
const ORIGIN = `https://${DOMAIN}`;
const ADSENSE_CLIENT = 'ca-pub-5123198950074938';

export const WEEKS_PER_YEAR = 52;

// ── Escaping ────────────────────────────────────────────────────────────────
// Airline and alliance names are typed by players. Everything that came from a
// player goes through here before it touches the page.
export const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// ── Formatting (mirrors the lobby's fmtMoney so the two never disagree) ─────
export const fmtMoney = (n) => n == null ? '—' :
  Math.abs(n) >= 1e12 ? `$${(n / 1e12).toFixed(2)}T` :
  Math.abs(n) >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` :
  Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n / 1e3)}k`;

// Profit can be a loss: "−$1.2M", never "$-1.2M".
export const fmtProfit = (n) => (n == null ? '—' : n < 0 ? `−${fmtMoney(-n)}` : fmtMoney(n));

export const fmtInt = (n) => Number(n ?? 0).toLocaleString('en-US');
export const plural = (n, one, many) => `${fmtInt(n)} ${Number(n) === 1 ? one : many}`;
export const ordinal = (n) => {
  const v = Math.abs(Number(n)) % 100, s = ['th', 'st', 'nd', 'rd'];
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
};
export const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
};

// A linear week (1-based) → "Y3 W12".
export const yw = (linearWeek) => {
  const w = Math.max(1, Number(linearWeek) || 1);
  return `Y${Math.floor((w - 1) / WEEKS_PER_YEAR) + 1} W${((w - 1) % WEEKS_PER_YEAR) + 1}`;
};

// Only the fields a stranger may see. Adding a field here is a deliberate
// publication decision — keep the list explicit rather than spreading.
//
// `id` is the airline's id: it is the address of the airline's public page
// (/worlds/:world/airlines/:id) and already the address of its logo. It is not
// the account's id, which never appears.
export function stripStanding(a) {
  return {
    id: typeof a.id === 'string' && /^[a-z0-9]{6,40}$/i.test(a.id) ? a.id : null,
    rank: a.rank, prevRank: a.prevRank ?? null, name: a.name, hub: a.hub, alliance: a.alliance ?? null,
    routes: a.routes ?? 0, fleet: a.fleet ?? 0,
    // What the rank is ordered by: average weekly net profit over 52 weeks.
    avgProfit: a.avgProfit ?? null,
    paxWeek: a.paxWeek ?? null, flightsWeek: a.flightsWeek ?? null,
    marketCap: a.marketCap ?? null, joinedWeek: a.joinedWeek ?? null,
    // The airline's look: its logo and its paint (brand.mjs validates each).
    logoId: a.logoId ?? null, logoColor: a.logoColor ?? null, logoBg: a.logoBg ?? null,
    customLogo: a.customLogo ?? null, livery: a.livery ?? null, customTail: a.customTail ?? null,
  };
}

/** Where an airline's public page lives (null for a row with no usable id). */
export const airlinePath = (worldId, airlineId) =>
  (worldId && airlineId ? `/worlds/${worldId}/airlines/${airlineId}` : null);

// ── Headlines ───────────────────────────────────────────────────────────────
// A port of the ticker's composer (src/Feed.jsx describe()). `typeName` is
// injected so this module has no dependency on the engine's aircraft table;
// the handler passes the real lookup when it can load it.
export function describe(e, typeName = (id) => id ?? 'an aircraft') {
  const d = e.data ?? {};
  const pairLabel = (p) => `${p.origin}–${p.destination}${p.count > 1 ? ` ×${p.count}` : ''}`;
  switch (e.kind) {
    case 'event_started': return { who: d.name ?? 'World event', what: 'has begun', icon: d.icon ?? '🌍' };
    case 'event_ended':   return { who: d.name ?? 'World event', what: 'has passed', icon: d.icon ?? '🌍' };
    case 'bankruptcy':    return { who: e.airline ?? d.name, what: 'has gone under', icon: '📉' };
    case 'abandoned':     return { who: e.airline ?? d.name, what: 'was wound up by its owner', icon: '📉' };
    case 'ranking_changed': return { who: 'The standings', what: 'now rank on average weekly net profit (last 52 weeks)', icon: '🏆' };
    case 'year_in_review': return {
      who: d.leader?.name ?? e.airline ?? 'The world',
      what: `closed year ${d.year ?? '?'} at #1${d.airlines ? ` of ${fmtInt(d.airlines)} airlines` : ''}${d.topMover?.name ? ` — biggest climb of the year: ${d.topMover.name}, ${d.topMover.from} → ${d.topMover.to}` : ''}`,
      icon: '🏆',
    };
    case 'rank_change':   return {
      who: e.airline,
      what: d.direction === 'in' ? `climbed into the top 5 — now #${d.rank}` : 'dropped out of the top 5',
      icon: d.direction === 'in' ? '📈' : '📉',
    };
    case 'routes_opened': return {
      who: e.airline,
      what: d.total === 1 && d.pairs?.[0]
        ? `opened ${pairLabel(d.pairs[0])}`
        : `opened ${plural(d.total, 'route', 'routes')}${d.commonOrigin ? ` from ${d.commonOrigin}` : ''}`,
      icon: '🛫',
    };
    case 'routes_closed': return {
      who: e.airline,
      what: d.total === 1 && d.pairs?.[0] ? `closed ${pairLabel(d.pairs[0])}` : `closed ${plural(d.total, 'route', 'routes')}`,
      icon: '🛬',
    };
    case 'fleet_in': {
      const [top] = Object.entries(d.byType ?? {}).sort((a, b) => b[1] - a[1]);
      const what = top
        ? `${d.ordered ? 'ordered' : 'bought'} ${top[1] > 1 ? `${top[1]}× ` : 'a '}${typeName(top[0])}`
        : `${d.ordered ? 'ordered' : 'bought'} ${plural(d.total, 'aircraft', 'aircraft')}`;
      return { who: e.airline, what, icon: '✈️' };
    }
    case 'fleet_out':     return { who: e.airline, what: `${d.retired ? 'retired' : 'sold'} ${plural(d.total, 'aircraft', 'aircraft')}`, icon: '🛠️' };
    case 'gates_added':   return { who: e.airline, what: `took ${plural(d.total, 'gate', 'gates')}${d.airportCode ? ` at ${d.airportCode}` : ''}`, icon: '🛄' };
    case 'gates_removed': return { who: e.airline, what: `released ${plural(d.total, 'gate', 'gates')}${d.airportCode ? ` at ${d.airportCode}` : ''}`, icon: '🛄' };
    case 'hub_designated': return { who: e.airline, what: `designated ${d.airportCode ?? 'a new'} hub`, icon: '🏛️' };
    case 'hub_upgraded':   return { who: e.airline, what: `upgraded ${d.airportCode ? `its ${d.airportCode} hub` : 'a hub'}`, icon: '🏛️' };
    case 'focus_city':     return { who: e.airline, what: `made ${d.airportCode ?? 'an airport'} a focus city`, icon: '📍' };
    case 'lounge_built':   return { who: e.airline, what: `is building a lounge at ${d.code ?? d.airportCode ?? 'an airport'}`, icon: '🛋️' };
    case 'stock_tape':     return {
      who: e.airline,
      what: `${d.direction === 'buy' ? 'bought into' : 'sold down'} ${d.targetName ?? 'a rival'}${d.stakePct ? ` — now ${d.stakePct}%` : ''}`,
      icon: '📊',
    };
    case 'schedule_trim':       return { who: e.airline, what: `trimmed its schedule${d.total ? ` — ${plural(d.total, 'flight', 'flights')} cut` : ''}`, icon: '✂️' };
    case 'gate_auction_opened': return { who: d.airport, what: `gate auction opened — ${plural(d.lots ?? 1, 'gate', 'gates')} on offer`, icon: '🔨' };
    case 'gate_auction_won':    return { who: e.airline, what: `won ${plural(d.gates ?? 1, 'gate', 'gates')} at ${d.airport}`, icon: '🔨' };
    case 'gate_auction_unsold': return { who: d.airport, what: 'gate auction closed — no gates sold', icon: '🔨' };
    case 'gate_sold':           return { who: e.airline, what: `sold a ${d.airport} gate to ${d.buyer}`, icon: '🤝' };
    case 'gate_forfeited':      return {
      who: e.airline,
      what: `forfeited ${plural(d.gates ?? 1, 'gate', 'gates')} at ${d.airport} — unused for too long`
          + `${d.lockoutWeeks ? `, locked out for ${d.lockoutWeeks} weeks` : ''}`,
      icon: '🛑',
    };
    case 'used_aircraft_sold':  return { who: e.airline, what: `picked up a used ${typeName(d.typeId)}`, icon: '🏷️' };
    case 'joined':              return { who: e.airline, what: `joined the world${d.hub ? ` · hub ${d.hub}` : ''}`, icon: '🛬' };
    case 'alliance_founded':    return { who: d.alliance, what: 'alliance founded', icon: '🤝' };
    case 'alliance_joined':     return { who: e.airline, what: `joined the ${d.alliance} alliance`, icon: '🤝' };
    case 'alliance_left':       return { who: e.airline, what: 'left its alliance', icon: '🤝' };
    case 'world_ended':         return { who: d.championName ?? 'The season', what: d.championName ? 'took the title as the season closed' : 'has closed', icon: '🏆' };
    default:                    return { who: e.airline ?? 'World', what: String(e.kind ?? '').replace(/_/g, ' '), icon: '•' };
  }
}

// ── Page chrome (same theme, nav and footer as the generated guide pages) ───
const CSS = `
    :root { --bg:#0b0e13; --panel:#141a23; --line:#263143; --text:#e8edf4; --muted:#8b98ab; --teal:#38c9b4; --teal-light:#5fe0cc; }
    * { box-sizing: border-box; }
    body { font-family:'IBM Plex Sans',system-ui,-apple-system,sans-serif; background:var(--bg); color:var(--text); margin:0; line-height:1.7; }
    a { color:var(--teal-light); }
    header.site { border-bottom:1px solid var(--line); }
    nav.site { max-width:880px; margin:0 auto; padding:18px 24px; display:flex; flex-wrap:wrap; gap:20px; align-items:center; }
    nav.site .brand { display:inline-flex; align-items:center; gap:9px; font-family:'Space Grotesk',sans-serif; font-weight:700; font-size:1.15rem; letter-spacing:0.5px; color:#38c9b4; text-decoration:none; margin-right:auto; }
    nav.site .brand img { height:22px; width:auto; display:block; }
    nav.site a.link { color:var(--muted); text-decoration:none; font-size:0.95rem; font-weight:500; }
    nav.site a.link:hover { color:var(--teal-light); }
    main { max-width:880px; margin:0 auto; padding:48px 24px 72px; }
    h1 { font-family:'Space Grotesk',sans-serif; font-size:2.1rem; line-height:1.2; margin:0 0 8px; }
    .lede { color:var(--muted); font-size:1.1rem; margin:0 0 28px; }
    h2 { font-family:'Space Grotesk',sans-serif; font-size:1.45rem; margin:42px 0 12px; }
    h3 { font-family:'Space Grotesk',sans-serif; font-size:1.15rem; margin:0 0 6px; }
    p { margin:0 0 16px; }
    ul { margin:0 0 16px; padding-left:22px; }
    li { margin:0 0 8px; }
    .stats { display:flex; flex-wrap:wrap; gap:14px; margin:20px 0 8px; }
    .stat { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px 20px; flex:1 1 140px; }
    .stat .n { font-family:'Space Grotesk',sans-serif; font-size:1.5rem; font-weight:700; color:var(--teal-light); }
    .stat .l { color:var(--muted); font-size:0.88rem; }
    .cta { display:inline-block; background:var(--teal); color:#04211d; font-weight:700; padding:13px 30px; border-radius:8px; text-decoration:none; margin:18px 0; }
    .card { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:20px 22px; margin:0 0 18px; }
    .card .meta { color:var(--muted); font-size:0.92rem; margin:0 0 12px; }
    .badge { display:inline-block; font-size:0.72rem; font-weight:700; letter-spacing:0.6px; text-transform:uppercase; padding:2px 8px; border-radius:999px; border:1px solid var(--line); color:var(--muted); margin-left:8px; vertical-align:middle; }
    .badge.live { color:#04211d; background:var(--teal); border-color:var(--teal); }
    .tablewrap { overflow-x:auto; margin:0 0 8px; }
    table { border-collapse:collapse; width:100%; font-size:0.93rem; }
    th, td { text-align:left; padding:8px 8px; border-bottom:1px solid var(--line); white-space:nowrap; vertical-align:top; }
    th { color:var(--muted); font-weight:600; font-size:0.82rem; text-transform:uppercase; letter-spacing:0.4px; }
    td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; }
    td.name { white-space:normal; min-width:150px; }
    td.wrap { white-space:normal; }
    .news { list-style:none; padding:0; margin:0; }
    .news li { display:flex; gap:12px; padding:8px 0; border-bottom:1px solid var(--line); }
    .news .when { color:var(--muted); font-size:0.85rem; flex:0 0 80px; font-variant-numeric:tabular-nums; }
    .muted { color:var(--muted); }
    td.name a, .who a { color:var(--text); text-decoration:none; font-weight:600; }
    td.name a:hover, .who a:hover { color:var(--teal-light); text-decoration:underline; }
    .who { display:inline-flex; align-items:center; gap:8px; vertical-align:middle; }
    svg.logo { flex:0 0 auto; display:block; border-radius:4px; }
    svg.fin { flex:0 0 auto; display:block; }
    .up { color:#4ade80; } .down { color:#f87171; }
    td.move { font-size:0.8rem; font-variant-numeric:tabular-nums; padding-left:0; }
    .mapwrap { border:1px solid var(--line); border-radius:10px; overflow:hidden; margin:0 0 14px; background:#0d1620; line-height:0; }
    svg.map { display:block; width:100%; height:auto; aspect-ratio:1024/535; }
    svg.chart { display:block; width:100%; max-width:640px; height:auto; }
    .season { height:8px; background:var(--line); border-radius:999px; overflow:hidden; margin:6px 0 4px; }
    .season i { display:block; height:100%; background:var(--teal); border-radius:999px; }
    .hero { display:flex; align-items:center; gap:22px; flex-wrap:wrap; margin:0 0 6px; }
    .hero h1 { margin:0; }
    .links { display:flex; flex-wrap:wrap; gap:10px 18px; margin:0 0 18px; }
    .records { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:14px; margin:0 0 18px; }
    .record { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px 18px; }
    .record .k { color:var(--muted); font-size:0.82rem; text-transform:uppercase; letter-spacing:0.4px; }
    .record .v { font-family:'Space Grotesk',sans-serif; font-size:1.35rem; font-weight:700; color:var(--teal-light); margin:2px 0 6px; }
    .trophies { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:14px; margin:0 0 18px; }
    .trophy { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:16px; text-align:center; }
    .trophy img { width:120px; height:120px; object-fit:contain; display:block; margin:0 auto 10px; }
    .share { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin:0 0 18px; }
    .share input { flex:1 1 260px; background:var(--panel); border:1px solid var(--line); color:var(--text); border-radius:8px; padding:9px 12px; font:inherit; font-size:0.9rem; }
    .share button { background:var(--panel); border:1px solid var(--line); color:var(--teal-light); border-radius:8px; padding:9px 16px; font:inherit; font-weight:600; cursor:pointer; }
    footer.site { border-top:1px solid var(--line); }
    .footwrap { max-width:880px; margin:0 auto; padding:28px 24px; color:var(--muted); font-size:0.9rem; display:flex; flex-wrap:wrap; gap:16px; }
    .footwrap a { color:var(--teal-light); text-decoration:none; }
`;

const NAV = `  <header class="site">
    <nav class="site">
      <a class="brand" href="/"><img src="/headwinds-mark-color.png" alt="" width="39" height="22" />Headwinds</a>
      <a class="link" href="/how-to-play.html">How to Play</a>
      <a class="link" href="/strategy.html">Strategy</a>
      <a class="link" href="/aircraft.html">Aircraft</a>
      <a class="link" href="/glossary.html">Glossary</a>
      <a class="link" href="/faq.html">FAQ</a>
      <a class="link" href="/rules.html">Rules</a>
      <a class="link" href="/worlds">Worlds</a>
      <a class="link" href="/play">Play</a>
    </nav>
  </header>`;

const FOOTER = `  <footer class="site">
    <div class="footwrap">
      <a href="/">Home</a>
      <a href="/how-to-play.html">How to Play</a>
      <a href="/strategy.html">Strategy</a>
      <a href="/aircraft.html">Aircraft</a>
      <a href="/glossary.html">Glossary</a>
      <a href="/faq.html">FAQ</a>
      <a href="/rules.html">Rules</a>
      <a href="/worlds">Worlds</a>
      <a href="/worlds/hall-of-fame">Hall of Fame</a>
      <a href="/devlog.html">Devlog</a>
      <a href="/best-airline-management-games.html">Best Airline Games</a>
      <a href="/about.html">About</a>
      <a href="/contact.html">Contact</a>
      <a href="/privacy.html">Privacy</a>
      <a href="/terms.html">Terms</a>
      <a href="/play">Play Headwinds</a>
    </div>
  </footer>`;

export function layout({ title, description, path, body, noindex = false, ogImage = null }) {
  const url = `${ORIGIN}${path}`;
  // A page may bring its own preview card (an airline's share card); it must be
  // a path on this site. Everything else shares the site's.
  const image = typeof ogImage === 'string' && ogImage.startsWith('/') ? `${ORIGIN}${ogImage}` : `${ORIGIN}/og-image.png`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}" />
  ${noindex ? '<meta name="robots" content="noindex" />' : `<link rel="canonical" href="${esc(url)}" />`}
  <link rel="icon" type="image/png" href="/favicon.png" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet" />
  <style>${CSS}  </style>
  <script defer src="/_vercel/insights/script.js"></script>
  <meta name="google-adsense-account" content="${ADSENSE_CLIENT}" />
  <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_CLIENT}" crossorigin="anonymous"></script>
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(description)}" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="${esc(url)}" />
  <meta property="og:image" content="${esc(image)}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:image" content="${esc(image)}" />
</head>
<body>
${NAV}

  <main>
${body}
  </main>

${FOOTER}
</body>
</html>
`;
}

// ── Shared fragments ────────────────────────────────────────────────────────
export const statusBadge = (w) => w.status === 'RUNNING' ? '<span class="badge live">Live</span>'
  : w.status === 'LOBBY' ? '<span class="badge">Opening</span>'
  : w.status === 'ENDED' ? '<span class="badge">Concluded</span>' : '';

export const stageBadge = (w) => (w.alpha || w.stage === 'alpha') ? '<span class="badge">Alpha</span>'
  : w.stage === 'beta' ? '<span class="badge">Beta</span>' : '';

export const eraLabel = (w) => Number.isInteger(w.startYear)
  ? `era world starting in ${w.startYear}` : 'classic world';

export const progressLabel = (w) => {
  const p = w.progress ?? {};
  if (w.status === 'ENDED') return `season complete — ${p.totalYears ?? w.lengthYears} years flown`;
  if (w.status === 'LOBBY') return `opens soon — a ${w.lengthYears}-year season`;
  return `year ${p.year ?? '?'}, week ${p.week ?? '?'} of a ${p.totalYears ?? w.lengthYears}-year season (${p.percent ?? 0}% flown)`;
};

export const rulesList = (w) => {
  const items = [];
  items.push(`<li><strong>Founding capital:</strong> ${fmtMoney(w.seedCapital ?? w.startingCapital)} for a new airline${w.seedCapital && w.startingCapital && w.seedCapital !== w.startingCapital ? ` (${fmtMoney(w.startingCapital)} at the world's opening, scaled with the era)` : ''}.</li>`);
  items.push(`<li><strong>Pace:</strong> ${esc(w.paceLabel ?? `${w.weeksPerDay} weeks per day`)} — the server flies a game week on that clock whether or not anyone is logged in.</li>`);
  if (w.demandMultiplier && w.demandMultiplier !== 1) items.push(`<li><strong>Demand:</strong> ${w.demandMultiplier}× the real-world baseline.</li>`);
  items.push(`<li><strong>Gate scarcity:</strong> ${w.gateScarcity ? 'on — airports have finite gates, sold at auction and tradeable between airlines' : 'off — gates are always available at list price'}.</li>`);
  if (w.newWorldRestrictions) items.push('<li><strong>New World Restrictions:</strong> on — only older single-deck types can be leased, and the lease order book is capped against the operating fleet.</li>');
  if (w.crewPipeline) items.push('<li><strong>Crew pipeline:</strong> on — hiring has a lead time and an understaffed operation degrades.</li>');
  items.push(`<li><strong>Rival one-stops:</strong> ${w.rivalItineraries ? 'on — rivals sell connections over their hubs in every market' : 'off'}.</li>`);
  return `<ul>${items.join('\n')}</ul>`;
};

// The ▲/▼ beside a rank: the move since last week's official standings.
export function moveCell(a) {
  if (a.prevRank == null || a.rank == null || a.prevRank === a.rank) return '';
  const d = a.prevRank - a.rank;
  return d > 0 ? `<span class="up" title="Up ${d} since last week">▲${d}</span>` : `<span class="down" title="Down ${-d} since last week">▼${-d}</span>`;
}

/** An airline's name with its logo, linked to its public page when it has one. */
export function airlineCell(a, { worldId = null, ctx = {}, size = 22, uid = '' } = {}) {
  const href = airlinePath(worldId, a.id);
  const logo = logoSvg(a, { size, uid: `${uid}${a.id ?? a.rank ?? 'x'}`, apiOrigin: ctx.apiOrigin });
  return `<span class="who">${logo}${href ? `<a href="${esc(href)}">${esc(a.name)}</a>` : `<span>${esc(a.name)}</span>`}</span>`;
}

// `ctx` is what the handler could load beyond the API's JSON: the API origin
// (for uploaded logos), the engine's airport lookup and livery helpers. Every
// field is optional — a page rendered with none still has its tables.
export function standingsTable(rows, { limit = null, worldId = null, ctx = {}, uid = '' } = {}) {
  const list = limit ? rows.slice(0, limit) : rows;
  if (!list.length) return '<p class="muted">No airlines have founded here yet.</p>';
  const tr = list.map((a) => `        <tr>
          <td class="num">${a.rank ?? ''}</td>
          <td class="move">${moveCell(a)}</td>
          <td class="name">${airlineCell(a, { worldId, ctx, uid })}</td>
          <td>${esc(a.hub ?? '')}</td>
          <td class="wrap">${a.alliance ? esc(a.alliance) : '<span class="muted">—</span>'}</td>
          <td class="num">${fmtInt(a.routes)}</td>
          <td class="num">${fmtInt(a.fleet)}</td>
          <td class="num">${fmtProfit(a.avgProfit)}</td>
          <td class="num">${fmtMoney(a.marketCap)}</td>
        </tr>`).join('\n');
  const more = limit && rows.length > limit && worldId
    ? `<p class="muted">… and ${rows.length - limit} more. <a href="/worlds/${esc(worldId)}">Full standings and headlines →</a></p>` : '';
  return `      <div class="tablewrap">
      <table>
        <thead><tr><th class="num">#</th><th></th><th>Airline</th><th>Hub</th><th>Alliance</th><th class="num">Routes</th><th class="num">Fleet</th><th class="num" title="Average weekly net profit over the last 52 weeks — what the rank is decided on">Avg weekly profit</th><th class="num">Market cap</th></tr></thead>
        <tbody>
${tr}
        </tbody>
      </table>
      </div>
${more}`;
}

/** The season bar: how much of the world's length has been flown. */
export const seasonBar = (w) => {
  const pct = Math.max(0, Math.min(100, Number(w.status === 'ENDED' ? 100 : w.progress?.percent ?? 0)));
  return `<div class="season" role="img" aria-label="${pct}% of the season flown"><i style="width:${pct}%"></i></div>`;
};

/** The hub map in its frame, or nothing when the airports could not be loaded. */
export function hubMapBlock(rows, worldId, ctx, opts = {}) {
  const svg = hubMapSvg(rows, ctx, { linkOf: (a) => airlinePath(worldId, a.id), ...opts });
  return svg ? `      <div class="mapwrap">${svg}</div>` : '';
}

// A world too new or too quiet for a table to say anything.
export const QUIET_WORLD_AIRLINES = 3;

// ── /worlds ─────────────────────────────────────────────────────────────────
// `live` is GET /worlds (LOBBY + RUNNING), `concluded` is GET /worlds?status=ENDED,
// `standingsById` maps world id → standings array (may be missing for a world
// whose detail fetch failed — the card then shows counts only).
export function renderWorldsIndex({ live = [], concluded = [], standingsById = {}, ctx = {} }) {
  const players = live.reduce((s, w) => s + (w.playerCount ?? 0), 0);
  const allRows = live.flatMap((w) => (standingsById[w.id] ?? []).map(stripStanding));
  const aircraft = allRows.reduce((s, a) => s + (a.fleet ?? 0), 0);
  const pax = allRows.reduce((s, a) => s + (a.paxWeek ?? 0), 0);
  // The busiest worlds first: a visitor should meet a full table before an
  // empty one. A world with only a couple of airlines gets a short card that
  // says there is room, not a two-row table.
  const ordered = [...live].sort((a, b) => (b.playerCount ?? 0) - (a.playerCount ?? 0));
  const cards = ordered.map((w) => {
    const rows = (standingsById[w.id] ?? []).map(stripStanding);
    const head = `      <h3><a href="/worlds/${esc(w.id)}">${esc(w.name)}</a>${statusBadge(w)}${stageBadge(w)}</h3>
      <p class="meta">${progressLabel(w)} · ${esc(w.paceLabel ?? '')} · ${fmtInt(w.playerCount)} of ${fmtInt(w.maxPlayers)} seats taken · ${eraLabel(w)}${w.gateScarcity ? ' · gate scarcity' : ''}</p>`;
    if ((w.playerCount ?? 0) < QUIET_WORLD_AIRLINES) {
      const names = rows.map((a) => airlineCell(a, { worldId: w.id, ctx, uid: `q${w.id}` })).join(' &nbsp; ');
      return `    <section class="card" id="${esc(w.id)}">
${head}
      <p>${(w.playerCount ?? 0) === 0 ? 'Nobody has founded an airline here yet' : `${plural(w.playerCount, 'airline', 'airlines')} so far`} — the map is close to empty, and every hub is there for the taking. ${names}</p>
      <p class="muted"><a href="/worlds/${esc(w.id)}">World page and rules →</a></p>
    </section>`;
    }
    return `    <section class="card" id="${esc(w.id)}">
${head}
${seasonBar(w)}
${hubMapBlock(rows, w.id, ctx, { fins: 8, label: `Where the airlines of ${w.name} are based` })}
${standingsTable(rows, { limit: 5, worldId: w.id, ctx, uid: `i${w.id}` })}
    </section>`;
  }).join('\n');

  const hall = concluded.length ? `
    <h2>Concluded seasons</h2>
    <div class="tablewrap">
    <table>
      <thead><tr><th>World</th><th>Champion</th><th class="num">Airlines</th><th class="num">Length</th><th>Ended</th></tr></thead>
      <tbody>
${concluded.map((w) => `        <tr><td class="name"><a href="/worlds/${esc(w.id)}">${esc(w.name)}</a></td><td class="name">${w.champion ? `🏆 ${esc(w.champion)}` : '<span class="muted">—</span>'}</td><td class="num">${fmtInt(w.playerCount)}</td><td class="num">${fmtInt(w.lengthYears)} yrs</td><td>${fmtDate(w.endsAt)}</td></tr>`).join('\n')}
      </tbody>
    </table>
    </div>` : '';

  const body = `    <h1>Live worlds</h1>
    <p class="lede">Every airline on this page belongs to a real person. Standings refresh as each world's clock ticks — nothing here is simulated by an AI opponent.</p>

    <div class="stats">
      <div class="stat"><div class="n">${fmtInt(live.length)}</div><div class="l">Worlds running now</div></div>
      <div class="stat"><div class="n">${fmtInt(players)}</div><div class="l">Airlines competing</div></div>
${aircraft > 0 ? `      <div class="stat"><div class="n">${fmtInt(aircraft)}</div><div class="l">Aircraft in their fleets</div></div>\n` : ''}${pax > 0 ? `      <div class="stat"><div class="n">${fmtInt(pax)}</div><div class="l">Passengers flown last week</div></div>\n` : ''}      <div class="stat"><div class="n">${fmtInt(concluded.length)}</div><div class="l">Seasons concluded</div></div>
    </div>

    <p class="links"><a href="/worlds/hall-of-fame">Hall of fame: leaders, records and trophies →</a></p>

    <p>A world is one shared airline economy with its own calendar. It opens with a set of rules — starting capital, pace, whether airport gates are scarce, which era the aircraft catalogue is drawn from — and then runs unattended on the server, one game week at a time, until its season ends. Anyone with a free account can found an airline in any world that still has a seat; the join form is at the top of each world's page inside the game.</p>

${cards || '    <p class="muted">No public worlds are open right now. New seasons open regularly — check back soon.</p>'}
${hall}

    <h2>How to read the standings</h2>
    <p><strong>Rank</strong> is the world's official standing: average weekly net profit over the last 52 weeks, with weeks an airline was not flying counted as zero, so a short hot streak cannot outscore a steady year. Private airlines are ranked too — profit needs no share price — and when a world ends, the best average over its final 52 weeks takes the title. Seasons that ended before the October 2026 rankings rework were decided on shareholder value per share. <strong>Avg weekly profit</strong> is that ranking figure itself, so the table is in the order of its own column; the arrow beside a rank is the move since last week. <strong>Market cap</strong> is what the world's stock market currently thinks the airline is worth — a different opinion, and often a different order.</p>
    <p><strong>Hub</strong> is the airport the airline was founded at. Most networks grow outward from it, and two airlines sharing a hub are usually fighting over the same passengers. <strong>Alliance</strong> is a player-founded bloc: members feed connecting traffic to each other and earn a demand boost where their networks overlap, in exchange for a weekly fee.</p>
    <p><strong>Routes</strong> counts the routes in the airline's schedule, not departures; an airline that puts several aircraft on one busy city pair schedules it more than once, so the count can run ahead of the city pairs on its map. <strong>Fleet</strong> is every airframe the airline has taken delivery of; aircraft still on order are not counted. Each map shows where the airlines are based: a dot per airline at its hub, larger for a larger fleet, with the tail fins of the leaders. Click an airline's name for its own page — its network map, fleet and rank history.</p>
    <p>The <a href="/how-to-play.html">how-to-play guide</a> covers founding an airline and opening your first routes; the <a href="/hub-strategy.html">hub strategy</a> and <a href="/competition-and-alliances.html">competition and alliances</a> pages explain how the table above gets fought over.</p>

    <a class="cta" href="/play">Found an airline — it's free →</a>`;

  return layout({
    title: 'Live Worlds & Standings — Headwinds Multiplayer Airline Game',
    description: `${fmtInt(live.length)} live worlds, ${fmtInt(players)} player-run airlines. Live standings, alliances and headlines from every public Headwinds world — the multiplayer airline management game.`,
    path: '/worlds',
    body,
  });
}

// ── /worlds/:id ─────────────────────────────────────────────────────────────
// `detail` is GET /worlds/:id ({ world, standings, private? }), `news` is the
// items array from GET /worlds/:id/news?tier=1.
export function renderWorldPage({ detail, news = [], typeName, ctx = {} }) {
  const { world: w, standings = [] } = detail;
  const rows = standings.map(stripStanding);

  const alliances = new Map();
  for (const a of rows) if (a.alliance) alliances.set(a.alliance, (alliances.get(a.alliance) ?? 0) + 1);
  const allianceList = alliances.size
    ? `<ul>${[...alliances.entries()].sort((x, y) => y[1] - x[1]).map(([n, c]) => `<li><strong>${esc(n)}</strong> — ${plural(c, 'member airline', 'member airlines')}</li>`).join('')}</ul>`
    : '<p class="muted">No alliances have formed here yet.</p>';

  const headlines = news.length
    ? `<ul class="news">${news.map((e) => {
        const { who, what, icon } = describe(e, typeName);
        return `<li><span class="when">${esc(yw(e.linearWeek ?? ((e.year - 1) * WEEKS_PER_YEAR + e.week)))}</span><span>${icon} <strong>${esc(who)}</strong> ${esc(what)}</span></li>`;
      }).join('\n')}</ul>`
    : '<p class="muted">No headlines yet — the first big moves show up here once the world starts ticking.</p>';

  const champion = w.status === 'ENDED' ? rows[0] : null;
  const lede = w.status === 'ENDED'
    ? `A concluded ${w.lengthYears}-year Headwinds season${champion ? ` — won by ${esc(champion.name)} of ${esc(champion.hub ?? '')}` : ''}. Final standings and the headlines that decided it.`
    : `Live standings for a ${w.lengthYears}-year Headwinds season running at ${esc(w.paceLabel ?? '')}. ${fmtInt(w.playerCount ?? rows.length)} player-run airlines competing.`;

  const body = `    <p class="muted"><a href="/worlds">← All worlds</a></p>
    <h1>${esc(w.name)}${statusBadge(w)}${stageBadge(w)}</h1>
    <p class="lede">${lede}</p>

    <div class="stats">
      <div class="stat"><div class="n">${fmtInt(w.playerCount ?? rows.length)}<span class="muted" style="font-size:0.9rem"> / ${fmtInt(w.maxPlayers)}</span></div><div class="l">Airlines</div></div>
      <div class="stat"><div class="n">${w.status === 'ENDED' ? 'Final' : `Y${w.progress?.year ?? '?'} W${w.progress?.week ?? '?'}`}</div><div class="l">${w.status === 'ENDED' ? 'Season complete' : `of ${fmtInt(w.lengthYears)} years · ${w.progress?.percent ?? 0}% flown`}</div></div>
      <div class="stat"><div class="n">${esc(w.paceLabel ?? '')}</div><div class="l">Pace</div></div>
      <div class="stat"><div class="n">${Number.isInteger(w.startYear) ? esc(w.startYear) : 'Classic'}</div><div class="l">${Number.isInteger(w.startYear) ? 'Era start year' : 'Modern catalogue'}</div></div>
    </div>

${seasonBar(w)}
    <p class="links"><a href="/worlds/${esc(w.id)}/history">The season so far: the last year, and every year's podium →</a></p>

    <h2>Standings</h2>
${standingsTable(rows, { worldId: w.id, ctx, uid: 'w' })}
    <p>Airlines are ranked on average weekly net profit over the last 52 weeks, the same standing players see in the game (seasons that ended before the October 2026 rankings rework were ranked on shareholder value per share) — that figure is the <strong>avg weekly profit</strong> column, and the arrow beside a rank is the move since last week. The market cap column is what this world's stock market thinks each carrier is worth, not its rank. <strong>Routes</strong> counts the routes in the airline's schedule (a busy city pair flown by several aircraft is scheduled more than once), not departures; <strong>fleet</strong> is every airframe delivered, orders not included. Each airline's name opens its own page, with its route map and rank history. ${w.status === 'ENDED' ? 'These are the final figures — the season closed and the table is frozen.' : `The table refreshes on every tick: at this world's pace of ${esc(w.paceLabel ?? '')}, a new game week lands whether or not anyone is watching.`}</p>

${rows.length ? `    <h2>Where everyone is based</h2>
${hubMapBlock(rows, w.id, ctx, { fins: 14, label: `Where the airlines of ${w.name} are based` })}
    <p class="muted">One dot per airline at its founding hub, larger for a larger fleet, in the airline's own colour; the tail fins belong to the leaders. Two airlines on the same dot are fighting over the same passengers.</p>
` : ''}
    <h2>Headlines</h2>
    <p class="muted">The moves big enough to change the table: fleet orders of five or more airframes, routes opened or dropped in bulk, gates won at auction or forfeited, alliances forming and breaking, airlines going under, and the world events that hit everyone's demand at once.</p>
${headlines}

    <h2>Alliances</h2>
${allianceList}

    <h2>World rules</h2>
${rulesList(w)}
    <p class="muted">Opened ${fmtDate(w.startedAt ?? w.createdAt)}${w.endsAt ? ` · ${w.status === 'ENDED' ? 'ended' : 'ends'} ${fmtDate(w.endsAt)}` : ''}.</p>

    ${w.status === 'ENDED'
      ? '<a class="cta" href="/worlds">See the worlds running now →</a>'
      : `<a class="cta" href="/play#/w/${esc(w.id)}">Found an airline in ${esc(w.name)} →</a>`}
    <p class="muted">${w.status === 'ENDED'
      ? 'Concluded seasons stay readable as a record of who built what; the live worlds are where seats are open.'
      : `Free, in the browser, no download. Sign in with Google, Discord or a one-time email link, pick a hub, and your first week flies on the next tick. Joining a running world is normal — a new airline starts with the same founding capital as everyone else did, and the incumbents above are exactly the rivals you will be pricing against.`}</p>`;

  const top = rows.slice(0, 3).map((a) => a.name).join(', ');
  // This page is what a player's invite link points at, so the title and
  // description are what Discord / WhatsApp show in the preview card. While
  // seats are open they read as an invitation; a full or finished world keeps
  // the standings framing.
  const airlines = w.playerCount ?? rows.length;
  const seatsOpen = ['LOBBY', 'RUNNING'].includes(w.status) && Number.isFinite(w.maxPlayers) ? Math.max(0, w.maxPlayers - airlines) : 0;
  const era = Number.isInteger(w.startYear) ? `started in ${w.startYear}` : 'modern fleet';
  const title = seatsOpen > 0
    ? `${w.name} — ${fmtInt(seatsOpen)} of ${fmtInt(w.maxPlayers)} airline seats open · Headwinds`
    : `${w.name} — ${w.status === 'ENDED' ? 'Final Standings' : 'Live Standings'} · Headwinds`;
  const description = seatsOpen > 0
    ? `Found an airline in ${w.name}, a free ${w.lengthYears}-year multiplayer airline world: ${w.paceLabel ?? ''}, ${era}, ${plural(airlines, 'player-run airline', 'player-run airlines')} so far${rows[0] ? `, led by ${rows[0].name}` : ''}. Every rival is a real person.`
    : `${w.status === 'ENDED' ? 'Final' : 'Live'} standings for ${w.name}, a ${w.lengthYears}-year multiplayer airline world with ${fmtInt(airlines)} player-run airlines${top ? `. Leading: ${top}` : ''}.`;
  return layout({
    title,
    description,
    path: `/worlds/${w.id}`,
    body,
  });
}

// ── Error pages ─────────────────────────────────────────────────────────────
export function renderNotFound() {
  return layout({
    title: 'World not found · Headwinds', description: 'No public Headwinds world at this address.',
    path: '/worlds', noindex: true,
    body: `    <h1>World not found</h1>
    <p class="lede">There is no public world at this address — it may be private, or its season has been archived.</p>
    <p><a href="/worlds">See every live world →</a></p>`,
  });
}

export function renderUnavailable() {
  return layout({
    title: 'Standings temporarily unavailable · Headwinds', description: 'The Headwinds game server did not answer in time.',
    path: '/worlds', noindex: true,
    body: `    <h1>Standings temporarily unavailable</h1>
    <p class="lede">The game server did not answer in time. The worlds are still flying — try again in a minute.</p>
    <p><a href="/play">Open the game →</a></p>`,
  });
}

// ── sitemap-worlds.xml ──────────────────────────────────────────────────────
// `airlinesById` (optional) maps a live world's id → its standings: airlines
// with a real network get their page listed. A two-route airline's page is
// reachable but not submitted — the same threshold marks it noindex.
export const AIRLINE_PAGE_MIN_ROUTES = 10;

export function renderWorldsSitemap({ live = [], concluded = [], airlinesById = {}, now = new Date() }) {
  const today = now.toISOString().slice(0, 10);
  const url = (loc, lastmod, changefreq, priority) =>
    `  <url><loc>${esc(loc)}</loc><lastmod>${esc(lastmod)}</lastmod><changefreq>${changefreq}</changefreq><priority>${priority}</priority></url>`;
  const lines = [url(`${ORIGIN}/worlds`, today, 'hourly', '0.8'), url(`${ORIGIN}/worlds/hall-of-fame`, today, 'daily', '0.6')];
  for (const w of live) {
    lines.push(url(`${ORIGIN}/worlds/${w.id}`, today, 'hourly', '0.7'));
    lines.push(url(`${ORIGIN}/worlds/${w.id}/history`, today, 'daily', '0.6'));
    for (const a of (airlinesById[w.id] ?? []).map(stripStanding)) {
      if (a.id && (a.routes ?? 0) >= AIRLINE_PAGE_MIN_ROUTES) lines.push(url(`${ORIGIN}${airlinePath(w.id, a.id)}`, today, 'daily', '0.5'));
    }
  }
  for (const w of concluded) lines.push(url(`${ORIGIN}/worlds/${w.id}`, (w.endsAt ?? w.createdAt ?? today).slice(0, 10), 'yearly', '0.4'));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${lines.join('\n')}\n</urlset>\n`;
}
