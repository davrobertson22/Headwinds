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
// readable by anyone (worlds.mjs / news.mjs `optionalAccount`). What we emit
// is a strict subset of that: airline names, hubs, alliances, fleet and route
// counts, cash and market cap. Never account ids, never `lastMoveAt`, never
// badges — see stripStanding(). Private worlds render as a 404.

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
  Math.abs(n) >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` :
  Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n / 1e3)}k`;

const fmtInt = (n) => Number(n ?? 0).toLocaleString('en-US');
const plural = (n, one, many) => `${fmtInt(n)} ${Number(n) === 1 ? one : many}`;
const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
};

// A linear week (1-based) → "Y3 W12".
const yw = (linearWeek) => {
  const w = Math.max(1, Number(linearWeek) || 1);
  return `Y${Math.floor((w - 1) / WEEKS_PER_YEAR) + 1} W${((w - 1) % WEEKS_PER_YEAR) + 1}`;
};

// Only the fields a stranger may see. Adding a field here is a deliberate
// publication decision — keep the list explicit rather than spreading.
export function stripStanding(a) {
  return {
    rank: a.rank, name: a.name, hub: a.hub, alliance: a.alliance ?? null,
    routes: a.routes ?? 0, fleet: a.fleet ?? 0,
    cash: a.cash ?? null, marketCap: a.marketCap ?? null, joinedWeek: a.joinedWeek ?? null,
  };
}

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
    case 'bankruptcy':    return { who: e.airline, what: 'has gone under', icon: '📉' };
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
      <a href="/devlog.html">Devlog</a>
      <a href="/best-airline-management-games.html">Best Airline Games</a>
      <a href="/about.html">About</a>
      <a href="/contact.html">Contact</a>
      <a href="/privacy.html">Privacy</a>
      <a href="/terms.html">Terms</a>
      <a href="/play">Play Headwinds</a>
    </div>
  </footer>`;

export function layout({ title, description, path, body, noindex = false }) {
  const url = `${ORIGIN}${path}`;
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
  <meta property="og:image" content="${ORIGIN}/og-image.png" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta name="twitter:card" content="summary_large_image" />
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
const statusBadge = (w) => w.status === 'RUNNING' ? '<span class="badge live">Live</span>'
  : w.status === 'LOBBY' ? '<span class="badge">Opening</span>'
  : w.status === 'ENDED' ? '<span class="badge">Concluded</span>' : '';

const stageBadge = (w) => (w.alpha || w.stage === 'alpha') ? '<span class="badge">Alpha</span>'
  : w.stage === 'beta' ? '<span class="badge">Beta</span>' : '';

const eraLabel = (w) => Number.isInteger(w.startYear)
  ? `era world starting in ${w.startYear}` : 'classic world';

const progressLabel = (w) => {
  const p = w.progress ?? {};
  if (w.status === 'ENDED') return `season complete — ${p.totalYears ?? w.lengthYears} years flown`;
  if (w.status === 'LOBBY') return `opens soon — a ${w.lengthYears}-year season`;
  return `year ${p.year ?? '?'}, week ${p.week ?? '?'} of a ${p.totalYears ?? w.lengthYears}-year season (${p.percent ?? 0}% flown)`;
};

const rulesList = (w) => {
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

function standingsTable(rows, { limit = null, worldId = null } = {}) {
  const list = limit ? rows.slice(0, limit) : rows;
  if (!list.length) return '<p class="muted">No airlines have founded here yet.</p>';
  const tr = list.map((a) => `        <tr>
          <td class="num">${a.rank ?? ''}</td>
          <td class="name">${esc(a.name)}</td>
          <td>${esc(a.hub ?? '')}</td>
          <td class="wrap">${a.alliance ? esc(a.alliance) : '<span class="muted">—</span>'}</td>
          <td class="num">${fmtInt(a.routes)}</td>
          <td class="num">${fmtInt(a.fleet)}</td>
          <td class="num">${fmtMoney(a.marketCap)}</td>
          <td class="num">${fmtMoney(a.cash)}</td>
        </tr>`).join('\n');
  const more = limit && rows.length > limit && worldId
    ? `<p class="muted">… and ${rows.length - limit} more. <a href="/worlds/${esc(worldId)}">Full standings and headlines →</a></p>` : '';
  return `      <div class="tablewrap">
      <table>
        <thead><tr><th class="num">#</th><th>Airline</th><th>Hub</th><th>Alliance</th><th class="num">Routes</th><th class="num">Fleet</th><th class="num">Market cap</th><th class="num">Cash</th></tr></thead>
        <tbody>
${tr}
        </tbody>
      </table>
      </div>
${more}`;
}

// ── /worlds ─────────────────────────────────────────────────────────────────
// `live` is GET /worlds (LOBBY + RUNNING), `concluded` is GET /worlds?status=ENDED,
// `standingsById` maps world id → standings array (may be missing for a world
// whose detail fetch failed — the card then shows counts only).
export function renderWorldsIndex({ live = [], concluded = [], standingsById = {} }) {
  const players = live.reduce((s, w) => s + (w.playerCount ?? 0), 0);
  const cards = live.map((w) => {
    const rows = (standingsById[w.id] ?? []).map(stripStanding);
    return `    <section class="card" id="${esc(w.id)}">
      <h3><a href="/worlds/${esc(w.id)}">${esc(w.name)}</a>${statusBadge(w)}${stageBadge(w)}</h3>
      <p class="meta">${progressLabel(w)} · ${esc(w.paceLabel ?? '')} · ${fmtInt(w.playerCount)} of ${fmtInt(w.maxPlayers)} seats taken · ${eraLabel(w)}${w.gateScarcity ? ' · gate scarcity' : ''}</p>
${standingsTable(rows, { limit: 5, worldId: w.id })}
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
      <div class="stat"><div class="n">${fmtInt(concluded.length)}</div><div class="l">Seasons concluded</div></div>
    </div>

    <p>A world is one shared airline economy with its own calendar. It opens with a set of rules — starting capital, pace, whether airport gates are scarce, which era the aircraft catalogue is drawn from — and then runs unattended on the server, one game week at a time, until its season ends. Anyone with a free account can found an airline in any world that still has a seat; the join form is at the top of each world's page inside the game.</p>

${cards || '    <p class="muted">No public worlds are open right now. New seasons open regularly — check back soon.</p>'}
${hall}

    <h2>How to read the standings</h2>
    <p><strong>Rank</strong> is by market capitalisation — what the world's stock market currently thinks the airline is worth, smoothed week to week so a single good result cannot teleport a carrier up the table. A private airline is still valued; it just has no listed share price until it floats.</p>
    <p><strong>Hub</strong> is the airport the airline was founded at. Most networks grow outward from it, and two airlines sharing a hub are usually fighting over the same passengers. <strong>Alliance</strong> is a player-founded bloc: members feed connecting traffic to each other and earn a demand boost where their networks overlap, in exchange for a weekly fee.</p>
    <p><strong>Routes</strong> counts city pairs flown, not departures — a pair served by three aircraft is still one route. <strong>Fleet</strong> is every airframe on the books, including those on order. <strong>Cash</strong> is what the airline has in the bank this week; a huge fleet on a thin cash line is an airline one bad quarter from a forced sale.</p>
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
export function renderWorldPage({ detail, news = [], typeName }) {
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

    <h2>Standings</h2>
${standingsTable(rows)}
    <p>Airlines are ranked by market capitalisation — what this world's stock market currently thinks each carrier is worth, smoothed week to week so one strong result cannot vault a name up the table. <strong>Routes</strong> counts city pairs flown, not departures; <strong>fleet</strong> is every airframe on the books, orders included; <strong>cash</strong> is the bank balance this week. ${w.status === 'ENDED' ? 'These are the final figures — the season closed and the table is frozen.' : `The table refreshes on every tick: at this world's pace of ${esc(w.paceLabel ?? '')}, a new game week lands whether or not anyone is watching.`}</p>

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
      : `Free, in the browser, no download. Sign in with Google or a one-time email link, pick a hub, and your first week flies on the next tick. Joining a running world is normal — a new airline starts with the same founding capital as everyone else did, and the incumbents above are exactly the rivals you will be pricing against.`}</p>`;

  const top = rows.slice(0, 3).map((a) => a.name).join(', ');
  return layout({
    title: `${w.name} — ${w.status === 'ENDED' ? 'Final Standings' : 'Live Standings'} · Headwinds`,
    description: `${w.status === 'ENDED' ? 'Final' : 'Live'} standings for ${w.name}, a ${w.lengthYears}-year multiplayer airline world with ${fmtInt(w.playerCount ?? rows.length)} player-run airlines${top ? `. Leading: ${top}` : ''}.`,
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
export function renderWorldsSitemap({ live = [], concluded = [], now = new Date() }) {
  const today = now.toISOString().slice(0, 10);
  const url = (loc, lastmod, changefreq, priority) =>
    `  <url><loc>${esc(loc)}</loc><lastmod>${esc(lastmod)}</lastmod><changefreq>${changefreq}</changefreq><priority>${priority}</priority></url>`;
  const lines = [url(`${ORIGIN}/worlds`, today, 'hourly', '0.8')];
  for (const w of live) lines.push(url(`${ORIGIN}/worlds/${w.id}`, today, 'hourly', '0.7'));
  for (const w of concluded) lines.push(url(`${ORIGIN}/worlds/${w.id}`, (w.endsAt ?? w.createdAt ?? today).slice(0, 10), 'yearly', '0.4'));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${lines.join('\n')}\n</urlset>\n`;
}
