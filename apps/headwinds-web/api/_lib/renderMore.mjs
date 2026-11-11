// The other public pages built from a world's data:
//
//   /worlds/:id/airlines/:airlineId   one airline — its network map, fleet,
//                                     rank history and the share card address
//   /worlds/:id/history               the season so far — the last 52 weeks,
//                                     and every finished year's podium
//   /worlds/hall-of-fame              reigning leaders, records, concluded
//                                     seasons and hand-awarded trophies
//
// Same rules as render.mjs: PURE (API JSON in, a string out — unit-tested in
// tools/worlds-pages-test.mjs), everything a player typed goes through esc(),
// and nothing here names a person: these pages are about airlines.
import {
  esc, fmtMoney, fmtProfit, fmtInt, plural, ordinal, fmtDate, yw, layout, stripStanding, describe,
  statusBadge, stageBadge, airlinePath, airlineCell, moveCell, seasonBar, WEEKS_PER_YEAR,
  AIRLINE_PAGE_MIN_ROUTES, QUIET_WORLD_AIRLINES,
} from './render.mjs';
import { finSvg, mapColorOf } from './brand.mjs';
import { routeMapSvg, rankChartSvg } from './maps.mjs';

const ORIGIN = 'https://www.headwindsairlinegame.com';
const CODE = /^[A-Z0-9]{3,4}$/;
const isCode = (c) => typeof c === 'string' && CODE.test(c);
const thisWeekOf = (w) => ((w.progress?.year ?? 1) - 1) * WEEKS_PER_YEAR + (w.progress?.week ?? 1);
const cityOf = (ctx, code) => {
  const ap = ctx.getAirport?.(code);
  return ap ? (ap.city ?? ap.name ?? code) : code;
};
const kmBetween = (a, b) => {
  const r = (d) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};
const fin = (a, ctx, height, uid) => finSvg(a, { height, uid, apiOrigin: ctx.apiOrigin, brand: ctx.brand, title: `${a.name} tail` });
const newsList = (items, typeName) => `<ul class="news">${items.map((e) => {
  const { who, what, icon } = describe(e, typeName);
  return `<li><span class="when">${esc(yw(e.linearWeek ?? ((e.year - 1) * WEEKS_PER_YEAR + e.week)))}</span><span>${icon} <strong>${esc(who)}</strong> ${esc(what)}</span></li>`;
}).join('\n')}</ul>`;

// ── /worlds/:id/airlines/:airlineId ─────────────────────────────────────────
// `detail` is GET /worlds/:id, `rival` is GET /worlds/:id/rivals/:airlineId (as
// a signed-out caller gets it), `news` the world's tier-1 items. Returns null
// when the airline is not in the world's standings (gone under, or never here)
// — the handler answers that with the 404 page.
export function renderAirlinePage({ detail, rival, news = [], typeName = (id) => id ?? 'an aircraft', ctx = {} }) {
  const { world: w, standings = [] } = detail;
  const rows = standings.map(stripStanding);
  const me = rows.find((a) => a.id && a.id === rival?.airline?.id);
  if (!me) return null;

  // The schedule lists a city pair once per aircraft rotation flying it (a busy
  // pair can appear dozens of times). For a reader a route is the pair: merge
  // them, adding the frequencies up.
  const pairs = new Map();
  for (const r of rival.routeNetwork ?? []) {
    if (!isCode(r.origin) || !isCode(r.destination) || r.origin === r.destination) continue;
    const key = [r.origin, r.destination].sort().join('-');
    const p = pairs.get(key);
    if (p) p.weeklyFrequency += Number(r.weeklyFrequency) || 0;
    else pairs.set(key, { origin: r.origin, destination: r.destination, weeklyFrequency: Number(r.weeklyFrequency) || 0, economyFare: r.economyFare ?? null });
  }
  const routes = [...pairs.values()];
  const cargo = (rival.cargoNetwork ?? []).filter((r) => isCode(r.origin) && isCode(r.destination));
  const hubs = (rival.hubs ?? []).filter(isCode);
  const hubList = hubs.length ? hubs : (isCode(me.hub) ? [me.hub] : []);
  const color = mapColorOf(me, ctx.brand);
  const page = airlinePath(w.id, me.id);
  const ended = w.status === 'ENDED';

  // ── Network facts, from the public schedule ──
  const airports = new Set(routes.flatMap((r) => [r.origin, r.destination]));
  const countries = new Set([...airports].map((c) => ctx.getAirport?.(c)?.country).filter(Boolean));
  const departures = routes.reduce((s, r) => s + (r.weeklyFrequency ?? 0), 0);
  let longest = null;
  for (const r of routes) {
    const o = ctx.getAirport?.(r.origin), d = ctx.getAirport?.(r.destination);
    if (!o || !d) continue;
    const km = kmBetween(o, d);
    if (!longest || km > longest.km) longest = { r, km };
  }
  const busiest = [...routes].sort((a, b) => (b.weeklyFrequency ?? 0) - (a.weeklyFrequency ?? 0)).slice(0, 15);

  const map = routeMapSvg(routes, hubList, ctx, { color, label: `${me.name} route network` });
  const mapBlock = map.svg ? `    <div class="mapwrap">${map.svg}</div>
    <p class="muted">${map.drawn < map.total
      ? `${fmtInt(map.drawn)} of ${fmtInt(map.total)} city pairs: the busiest and the longest — the full network would paint the map solid.`
      : `All ${plural(map.total, 'city pair', 'city pairs')} it flies.`} Heavier lines fly more often; the ringed dots are hubs.</p>` : '';

  const facts = [];
  if (routes.length) facts.push(`${esc(me.name)} flies passengers on ${plural(routes.length, 'city pair', 'city pairs')} between ${plural(airports.size, 'airport', 'airports')}${countries.size > 1 ? ` in ${fmtInt(countries.size)} countries` : ''}; its published frequencies add up to ${fmtInt(departures)} a week.${(me.routes ?? 0) > routes.length ? ` (The standings count ${fmtInt(me.routes)} routes for it: a pair flown by several aircraft is scheduled, and counted, more than once.)` : ''}`);
  if (hubList.length) facts.push(`It ${hubList.length > 1 ? 'runs hubs at' : 'is based at'} ${hubList.map((c) => `${esc(cityOf(ctx, c))} (${esc(c)})`).join(', ')}.`);
  if (longest) facts.push(`Its longest route is ${esc(longest.r.origin)}–${esc(longest.r.destination)}, ${esc(cityOf(ctx, longest.r.origin))} to ${esc(cityOf(ctx, longest.r.destination))}: ${fmtInt(Math.round(longest.km / 10) * 10)} km.`);
  if (cargo.length) facts.push(`It also flies ${plural(cargo.length, 'freight lane', 'freight lanes')} with dedicated freighters.`);

  const routeTable = busiest.length ? `    <div class="tablewrap">
    <table>
      <thead><tr><th>Route</th><th>Between</th><th class="num">Flights a week</th><th class="num">Economy fare</th></tr></thead>
      <tbody>
${busiest.map((r) => `        <tr><td>${esc(r.origin)}–${esc(r.destination)}</td><td class="wrap">${esc(cityOf(ctx, r.origin))} and ${esc(cityOf(ctx, r.destination))}</td><td class="num">${fmtInt(r.weeklyFrequency)}</td><td class="num">${r.economyFare ? `$${fmtInt(r.economyFare)}` : '—'}</td></tr>`).join('\n')}
      </tbody>
    </table>
    </div>` : '<p class="muted">No passenger routes yet — this airline has only just founded.</p>';

  // ── Fleet ──
  const types = Object.entries(rival.fleetByType ?? {}).filter(([, n]) => Number(n) > 0).sort((a, b) => b[1] - a[1]);
  const shown = types.slice(0, 12), rest = types.slice(12);
  const fleetTable = types.length ? `    <div class="tablewrap">
    <table>
      <thead><tr><th>Aircraft type</th><th class="num">In fleet</th></tr></thead>
      <tbody>
${shown.map(([id, n]) => `        <tr><td>${esc(typeName(id))}</td><td class="num">${fmtInt(n)}</td></tr>`).join('\n')}
${rest.length ? `        <tr><td class="muted">${plural(rest.length, 'other type', 'other types')}</td><td class="num">${fmtInt(rest.reduce((s, [, n]) => s + n, 0))}</td></tr>` : ''}
      </tbody>
    </table>
    </div>` : '<p class="muted">No aircraft delivered yet.</p>';

  // ── Rank over time ──
  const hist = (rival.rankHistory ?? []).filter((h) => Number.isFinite(h.rank));
  const chart = rankChartSvg(hist, { total: rows.length, label: yw, color });
  const best = hist.length ? Math.min(...hist.map((h) => h.rank)) : null;
  const worst = hist.length ? Math.max(...hist.map((h) => h.rank)) : null;
  const rankBlock = chart ? `    <h2>Rank, week by week</h2>
    ${chart}
    <p class="muted">The last ${plural(hist.length, 'week', 'weeks')} of official standings${best === worst ? `: #${best} throughout` : `: as high as #${best}, as low as #${worst}`}. The rank is decided on average weekly net profit over the trailing 52 weeks, so it moves slowly — one good week does not buy a place.</p>` : '';

  // ── Who it is up against ──
  const above = rows.find((a) => a.rank === me.rank - 1), below = rows.find((a) => a.rank === me.rank + 1);
  const sameHub = rows.filter((a) => a.id !== me.id && a.hub === me.hub);
  const link = (a) => airlineCell(a, { worldId: w.id, ctx, uid: 'n' });
  const around = [
    above ? `<li>One place ahead: ${link(above)} at #${above.rank}, on ${fmtProfit(above.avgProfit)} a week.</li>` : (me.rank === 1 ? '<li>Nobody is ahead: this is the airline every other one in the world is chasing.</li>' : ''),
    below ? `<li>One place behind: ${link(below)} at #${below.rank}, on ${fmtProfit(below.avgProfit)} a week.</li>` : '',
    sameHub.length ? `<li>Shares its ${esc(me.hub)} hub with ${sameHub.slice(0, 6).map(link).join(', ')}${sameHub.length > 6 ? ` and ${sameHub.length - 6} more` : ''}.</li>` : (isCode(me.hub) ? `<li>No other airline in this world is founded at ${esc(me.hub)}.</li>` : ''),
  ].filter(Boolean).join('\n');

  const mine = news.filter((e) => e.airlineId && e.airlineId === me.id).slice(0, 12);
  const headlines = mine.length ? `    <h2>In the headlines</h2>
${newsList(mine, typeName)}` : '';

  const move = moveCell(me);
  const lede = `${ended ? 'Finished' : 'Currently'} <strong>#${me.rank} of ${fmtInt(rows.length)}</strong> in <a href="/worlds/${esc(w.id)}">${esc(w.name)}</a>${me.alliance ? `, and a member of the ${esc(me.alliance)} alliance` : ''}. A real person ${ended ? 'ran' : 'runs'} this airline.`;

  const body = `    <p class="muted"><a href="/worlds">Worlds</a> › <a href="/worlds/${esc(w.id)}">${esc(w.name)}</a></p>
    <div class="hero">
      ${fin(me, ctx, 84, 'hero')}
      <h1>${esc(me.name)}</h1>
    </div>
    <p class="lede">${lede}</p>

    <div class="stats">
      <div class="stat"><div class="n">#${me.rank} ${move}</div><div class="l">of ${fmtInt(rows.length)} airlines${ended ? ' · final' : ''}</div></div>
      <div class="stat"><div class="n">${fmtProfit(me.avgProfit)}</div><div class="l">Avg weekly profit (52 wks)</div></div>
      <div class="stat"><div class="n">${fmtInt(me.routes)}</div><div class="l">Routes</div></div>
      <div class="stat"><div class="n">${fmtInt(me.fleet)}</div><div class="l">Aircraft</div></div>
${me.paxWeek != null ? `      <div class="stat"><div class="n">${fmtInt(me.paxWeek)}</div><div class="l">Passengers last week</div></div>` : ''}
    </div>

    <h2>Route network</h2>
${mapBlock}
    <p>${facts.join(' ') || 'No published network yet.'}</p>

    <h2>Busiest routes</h2>
${routeTable}
    <p class="muted">Schedules and economy fares are public in every world, the way a real airline's timetable is. What a route earns, how full it flies and what the airline has in the bank are not — rivals have to work those out.</p>

    <h2>Fleet</h2>
${fleetTable}

${rankBlock}

    <h2>Who it is up against</h2>
    <ul>
${around}
    </ul>

${headlines}

    <h2>Share this airline</h2>
    <div class="share">
      <input id="share-url" readonly value="${esc(`${ORIGIN}${page}`)}" aria-label="Link to this page" onfocus="this.select()" />
      <button type="button" id="share-btn">Copy link</button>
    </div>
    <p class="muted">Paste the link into Discord or a group chat and it unfurls as a card with this airline's tail, rank and network size. The card follows the standings — it is redrawn each game week.</p>
    <script>
      document.getElementById('share-btn').addEventListener('click', function () {
        var url = document.getElementById('share-url').value, btn = this;
        var done = function () { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy link'; }, 2500); };
        if (navigator.share && /Mobi|Android/i.test(navigator.userAgent)) { navigator.share({ title: document.title, url: url }).catch(function () {}); return; }
        if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, function () { document.getElementById('share-url').select(); });
        else document.getElementById('share-url').select();
      });
    </script>

    ${ended
      ? '<a class="cta" href="/worlds">See the worlds running now →</a>'
      : `<a class="cta" href="/play#/w/${esc(w.id)}">Take on ${esc(me.name)} — found an airline in ${esc(w.name)} →</a>`}
    <p class="muted">${ended
      ? 'This season is over and its table is frozen; the live worlds are where seats are open.'
      : `Free, in the browser. A new airline in ${esc(w.name)} starts with the world's founding capital and an empty map — and ${esc(me.name)} is exactly the kind of rival it will be pricing against.`}</p>`;

  const thin = (me.routes ?? 0) < AIRLINE_PAGE_MIN_ROUTES;
  return layout({
    title: `${me.name} — #${me.rank} in ${w.name} · Headwinds`,
    description: `${me.name}, a player-run airline in the Headwinds world ${w.name}: ranked #${me.rank} of ${fmtInt(rows.length)}, ${plural(me.routes, 'route', 'routes')} and ${fmtInt(me.fleet)} aircraft from its ${me.hub ?? ''} hub. Network map, fleet and rank history.`,
    path: page,
    // A just-founded airline's page is a few numbers and no network: reachable
    // (its owner will share it) but not something to put in front of a crawler.
    noindex: thin,
    ogImage: `${page}/card.png?w=${thisWeekOf(w)}`,
    body,
  });
}

// ── /worlds/:id/history ─────────────────────────────────────────────────────
// `history` is GET /worlds/:id/history: { years, yearsLed, reign, yearAgo }.
// News is kept for 52 game weeks, so "the last 52 weeks" is written from it
// while it exists; the year-by-year table comes from the standings, which are
// kept for the world's whole life.
export function renderHistoryPage({ detail, history = {}, news = [], typeName = (id) => id ?? 'an aircraft', ctx = {} }) {
  const { world: w, standings = [], fallen = 0 } = detail;
  const rows = standings.map(stripStanding);
  const byId = new Map(rows.filter((a) => a.id).map((a) => [a.id, a]));
  const now = history.thisWeek ?? thisWeekOf(w);
  const ended = w.status === 'ENDED';
  const calYear = (y) => (Number.isInteger(w.startYear) ? w.startYear + y - 1 : null);
  // A podium entry: the airline as it is now (logo, link) when it is still in
  // the standings; just its name when it has since left; a dash when the row
  // was re-founded and the company that earned the place no longer exists.
  const entry = (p, uid) => {
    if (!p) return '<span class="muted">—</span>';
    const live = byId.get(p.airlineId);
    if (live && !p.gone) return airlineCell(live, { worldId: w.id, ctx, uid });
    if (p.name) return `<span>${esc(p.name)}</span> <span class="muted">(no longer flying)</span>`;
    return '<span class="muted">an airline since re-founded</span>';
  };
  const scoreCell = (p) => (!p || p.score == null ? '—' : p.metric === 'svps' ? `$${Number(p.score).toFixed(2)} a share` : `${fmtProfit(p.score)} a week`);

  // ── The last 52 weeks ──
  const leader = rows[0] ?? null;
  const reign = history.reign && leader && history.reign.airlineId === leader.id ? history.reign : null;
  const ago = new Map((history.yearAgo?.ranks ?? []).map((r) => [r.airlineId, r.rank]));
  const moved = rows.filter((a) => a.id && ago.has(a.id)).map((a) => ({ a, from: ago.get(a.id), by: ago.get(a.id) - a.rank }));
  const climbers = moved.filter((m) => m.by > 0).sort((x, y) => y.by - x.by).slice(0, 5);
  const fallers = moved.filter((m) => m.by < 0).sort((x, y) => x.by - y.by).slice(0, 3);
  const newcomers = rows.filter((a) => Number.isFinite(a.joinedWeek) && a.joinedWeek > now - WEEKS_PER_YEAR);

  const of = (kind) => news.filter((e) => e.kind === kind);
  const bust = of('bankruptcy').map((e) => e.airline ?? e.data?.name).filter(Boolean);
  const founded = of('alliance_founded').map((e) => e.data?.alliance).filter(Boolean);
  const orders = of('fleet_in').filter((e) => e.data?.ordered && e.airline).sort((a, b) => (b.data.total ?? 0) - (a.data.total ?? 0)).slice(0, 3);
  const events = [...new Set(of('event_started').map((e) => e.data?.name).filter(Boolean))];
  const list = (names, max = 6) => `${names.slice(0, max).map(esc).join(', ')}${names.length > max ? ` and ${names.length - max} more` : ''}`;

  const year = [];
  if (leader) {
    year.push(`<li><strong>On top:</strong> ${airlineCell(leader, { worldId: w.id, ctx, uid: 'l' })} ${ended ? 'finished' : 'leads'} on ${fmtProfit(leader.avgProfit)} of average weekly profit${reign && reign.weeks > 1 ? `, and has held #1 for ${reign.capped ? 'at least ' : ''}${fmtInt(reign.weeks)} weeks in a row (since ${yw(reign.since)})` : ''}.</li>`);
  }
  if (climbers.length) year.push(`<li><strong>Biggest climbs:</strong> ${climbers.map((m) => `${airlineCell(m.a, { worldId: w.id, ctx, uid: 'c' })} ${ordinal(m.from)} → ${ordinal(m.a.rank)}`).join('; ')}.</li>`);
  if (fallers.length) year.push(`<li><strong>Biggest slides:</strong> ${fallers.map((m) => `${airlineCell(m.a, { worldId: w.id, ctx, uid: 's' })} ${ordinal(m.from)} → ${ordinal(m.a.rank)}`).join('; ')}.</li>`);
  if (newcomers.length) {
    const top = [...newcomers].sort((a, b) => a.rank - b.rank)[0];
    year.push(`<li><strong>New arrivals:</strong> ${plural(newcomers.length, 'airline was', 'airlines were')} founded in the last 52 weeks; the best placed is ${airlineCell(top, { worldId: w.id, ctx, uid: 'j' })} at #${top.rank}.</li>`);
  }
  if (bust.length) year.push(`<li><strong>Gone under:</strong> ${list(bust)}.</li>`);
  if (founded.length) year.push(`<li><strong>Alliances founded:</strong> ${list(founded)}.</li>`);
  if (orders.length) year.push(`<li><strong>Largest orders:</strong> ${orders.map((e) => {
    const [top] = Object.entries(e.data.byType ?? {}).sort((a, b) => b[1] - a[1]);
    return `${esc(e.airline)} — ${fmtInt(e.data.total)} aircraft${top ? `, mostly ${esc(typeName(top[0]))}` : ''} (${yw(e.linearWeek)})`;
  }).join('; ')}.</li>`);
  if (events.length) year.push(`<li><strong>World events:</strong> ${plural(events.length, 'different event', 'different events')} moved demand for everyone — ${list(events, 5)}.</li>`);

  const oldest = news.length ? Math.min(...news.map((e) => e.linearWeek ?? now)) : null;

  // ── Year by year ──
  const years = [...(history.years ?? [])].sort((a, b) => b.year - a.year);
  const yearTable = years.length ? `    <div class="tablewrap">
    <table>
      <thead><tr><th class="num">Year</th><th>Leader</th><th class="num">Leader's figure</th><th>Second</th><th>Third</th></tr></thead>
      <tbody>
${years.map((y) => {
  const [p1, p2, p3] = [1, 2, 3].map((r) => y.podium.find((p) => p.rank === r));
  return `        <tr><td class="num">${y.year}${calYear(y.year) ? ` <span class="muted">· ${calYear(y.year)}</span>` : ''}</td><td class="name">${entry(p1, `y${y.year}a`)}</td><td class="num">${scoreCell(p1)}</td><td class="name">${entry(p2, `y${y.year}b`)}</td><td class="name">${entry(p3, `y${y.year}c`)}</td></tr>`;
}).join('\n')}
      </tbody>
    </table>
    </div>` : '<p class="muted">No game year has finished yet — the first row lands when the world\'s clock reaches year 2.</p>';

  const led = (history.yearsLed ?? []).slice(0, 8);
  const ledBlock = led.length ? `    <h2>Years on top</h2>
    <ul>
${led.map((t) => `      <li>${byId.has(t.airlineId) ? airlineCell(byId.get(t.airlineId), { worldId: w.id, ctx, uid: 't' }) : `<span>${esc(t.name)}</span>`} — closed ${plural(t.years, 'year', 'years')} at #1 (most recently year ${t.lastYear})</li>`).join('\n')}
    </ul>` : '';
  const legacyNote = years.some((y) => y.metric === 'svps')
    ? ' Years before the October 2026 rankings rework were ranked on shareholder value per share, so their figure is a share value rather than a profit.' : '';

  const body = `    <p class="muted"><a href="/worlds">Worlds</a> › <a href="/worlds/${esc(w.id)}">${esc(w.name)}</a></p>
    <h1>${esc(w.name)}: the season so far${statusBadge(w)}${stageBadge(w)}</h1>
    <p class="lede">${ended
      ? `A concluded ${fmtInt(w.lengthYears)}-year season, year by year.`
      : `Year ${fmtInt(w.progress?.year ?? 1)} of ${fmtInt(w.lengthYears)}. ${plural(rows.length, 'airline is', 'airlines are')} flying${fallen > 0 ? `; ${plural(fallen, 'has', 'have')} gone under or walked away along the way` : ''}.`}</p>
${seasonBar(w)}

    <h2>The last 52 weeks</h2>
${year.length ? `    <ul>\n${year.join('\n')}\n    </ul>` : '    <p class="muted">Too early to say — this world has not flown a full year yet.</p>'}
    <p class="muted">A game year is 52 weeks on this world's clock (${esc(w.paceLabel ?? '')}), so "the last year" here is a few real days${ended ? '' : ', and this section is rewritten as the world moves on'}. Climbs and slides compare this week's official rank with the rank 52 weeks ago.</p>

    <h2>Headlines from the last year</h2>
${news.length ? newsList(news, typeName) : '    <p class="muted">No headlines on record yet.</p>'}
    <p class="muted">${news.length ? `The ${plural(news.length, 'biggest move', 'biggest moves')} still on record${oldest ? `, back to ${yw(oldest)}` : ''}. ` : ''}World news is kept for 52 game weeks and then cleared; the table below is the permanent record.</p>

    <h2>Every year's podium</h2>
${yearTable}
    <p class="muted">Each row is the official top three on the tick that closed that game year${Number.isInteger(w.startYear) ? `, with the calendar year this era world had reached` : ''}.${legacyNote} An airline that has since gone bankrupt keeps its place in the record.</p>

${ledBlock}

    ${ended
      ? '<a class="cta" href="/worlds">See the worlds running now →</a>'
      : `<a class="cta" href="/play#/w/${esc(w.id)}">Join ${esc(w.name)} and get your name in the table →</a>`}`;

  return layout({
    title: `${w.name}: The Season So Far — Year-by-Year Standings · Headwinds`,
    description: `The story of ${w.name}, a ${w.lengthYears}-year multiplayer airline world: the last 52 weeks of climbs, collapses and headlines, and the top three airlines at the close of every game year${leader ? `. Current leader: ${leader.name}` : ''}.`,
    path: `/worlds/${w.id}/history`,
    body,
  });
}

// ── /worlds/hall-of-fame ────────────────────────────────────────────────────
// `live` / `concluded` are the world lists, `standingsById` and `historyById`
// map a live world's id to its standings and its history (either may be
// missing for a world whose fetch failed), `awards` is GET /trophies/awards.
const TROPHY_IMAGE = /^\/trophies\/[a-z0-9]{8,64}\/image(\?v=[a-f0-9]{6,64})?$/i;

export function renderHallOfFame({ live = [], concluded = [], standingsById = {}, historyById = {}, awards = [], ctx = {} }) {
  // A world with a couple of airlines has a "leader" and "records" in name only.
  const worlds = live.filter((w) => (standingsById[w.id] ?? []).length >= QUIET_WORLD_AIRLINES)
    .sort((a, b) => (b.playerCount ?? 0) - (a.playerCount ?? 0));
  const rowsOf = new Map(worlds.map((w) => [w.id, standingsById[w.id].map(stripStanding)]));
  const all = worlds.flatMap((w) => rowsOf.get(w.id).map((a) => ({ a, w })));
  const who = ({ a, w }, uid) => `${airlineCell(a, { worldId: w.id, ctx, uid })} <span class="muted">in <a href="/worlds/${esc(w.id)}">${esc(w.name)}</a></span>`;

  // ── Reigning leaders ──
  const leaders = worlds.map((w) => {
    const a = rowsOf.get(w.id)[0];
    const reign = historyById[w.id]?.reign;
    return { a, w, reign: reign && reign.airlineId === a.id ? reign : null };
  });
  const leaderTable = leaders.length ? `    <div class="tablewrap">
    <table>
      <thead><tr><th>World</th><th>Leader</th><th>Hub</th><th class="num">Avg weekly profit</th><th class="num">Weeks at #1</th><th class="num">Season</th></tr></thead>
      <tbody>
${leaders.map(({ a, w, reign }) => `        <tr><td class="name"><a href="/worlds/${esc(w.id)}">${esc(w.name)}</a></td><td class="name"><span class="who">${fin(a, ctx, 24, `ld${w.id}`)}<a href="${esc(airlinePath(w.id, a.id) ?? `/worlds/${w.id}`)}">${esc(a.name)}</a></span></td><td>${esc(a.hub ?? '')}</td><td class="num">${fmtProfit(a.avgProfit)}</td><td class="num">${reign ? `${reign.capped ? '≥ ' : ''}${fmtInt(reign.weeks)}` : '—'}</td><td class="num">Y${fmtInt(w.progress?.year ?? 1)} of ${fmtInt(w.lengthYears)}</td></tr>`).join('\n')}
      </tbody>
    </table>
    </div>` : '<p class="muted">No world has standings yet.</p>';

  // ── Records ──
  const top = (pick) => all.filter((e) => Number.isFinite(pick(e.a)) && pick(e.a) > 0).sort((x, y) => pick(y.a) - pick(x.a))[0] ?? null;
  const records = [];
  const add = (k, e, v, uid) => { if (e) records.push(`      <div class="record"><div class="k">${k}</div><div class="v">${v}</div><div>${who(e, uid)}</div></div>`); };
  let e;
  if ((e = top((a) => a.avgProfit))) add('Highest average weekly profit', e, fmtProfit(e.a.avgProfit), 'r1');
  if ((e = top((a) => a.fleet))) add('Largest fleet', e, `${fmtInt(e.a.fleet)} aircraft`, 'r2');
  if ((e = top((a) => a.routes))) add('Biggest network', e, `${fmtInt(e.a.routes)} routes`, 'r3');
  if ((e = top((a) => a.paxWeek))) add('Most passengers in a week', e, fmtInt(e.a.paxWeek), 'r4');
  if ((e = top((a) => a.flightsWeek))) add('Most departures in a week', e, fmtInt(e.a.flightsWeek), 'r5');
  if ((e = top((a) => a.marketCap))) add('Most valuable on the stock market', e, fmtMoney(e.a.marketCap), 'r6');
  const longest = leaders.filter((l) => l.reign).sort((x, y) => y.reign.weeks - x.reign.weeks)[0];
  if (longest && longest.reign.weeks > 1) add('Longest current run at #1', longest, `${longest.reign.capped ? '≥ ' : ''}${fmtInt(longest.reign.weeks)} weeks`, 'r7');
  let dynasty = null;
  for (const w of worlds) {
    const t = historyById[w.id]?.yearsLed?.[0];
    const a = t && rowsOf.get(w.id).find((r) => r.id === t.airlineId);
    if (a && (!dynasty || t.years > dynasty.years)) dynasty = { a, w, years: t.years };
  }
  if (dynasty && dynasty.years > 1) add('Most game years closed at #1', dynasty, `${fmtInt(dynasty.years)} years`, 'r8');
  let bloc = null;
  for (const w of worlds) {
    const count = new Map();
    for (const a of rowsOf.get(w.id)) if (a.alliance) count.set(a.alliance, (count.get(a.alliance) ?? 0) + 1);
    for (const [name, n] of count) if (!bloc || n > bloc.n) bloc = { name, n, w };
  }
  if (bloc && bloc.n > 1) records.push(`      <div class="record"><div class="k">Largest alliance</div><div class="v">${fmtInt(bloc.n)} airlines</div><div><strong>${esc(bloc.name)}</strong> <span class="muted">in <a href="/worlds/${esc(bloc.w.id)}">${esc(bloc.w.name)}</a></span></div></div>`);

  // ── Champions, or the finales still to come ──
  const finales = [...worlds].filter((w) => w.endsAt).sort((a, b) => String(a.endsAt).localeCompare(String(b.endsAt)));
  const champions = concluded.length ? `    <div class="tablewrap">
    <table>
      <thead><tr><th>World</th><th>Champion</th><th class="num">Airlines</th><th class="num">Length</th><th>Ended</th></tr></thead>
      <tbody>
${concluded.map((w) => `        <tr><td class="name"><a href="/worlds/${esc(w.id)}">${esc(w.name)}</a></td><td class="name">${w.champion ? `🏆 ${esc(w.champion)}` : '<span class="muted">—</span>'}</td><td class="num">${fmtInt(w.playerCount)}</td><td class="num">${fmtInt(w.lengthYears)} yrs</td><td>${fmtDate(w.endsAt)}</td></tr>`).join('\n')}
      </tbody>
    </table>
    </div>` : `    <p>No season has finished yet, so this list is empty and the first name on it is still being decided. A world's title goes to the airline with the best average weekly net profit over its <em>final</em> 52 weeks — not to whoever led for longest — which is why a leader today is a favourite and nothing more.</p>`;
  const finaleTable = finales.length ? `    <h3>Finales ahead</h3>
    <div class="tablewrap">
    <table>
      <thead><tr><th>World</th><th>Season ends</th><th class="num">Game years left</th><th>Leading now</th></tr></thead>
      <tbody>
${finales.map((w) => `        <tr><td class="name"><a href="/worlds/${esc(w.id)}">${esc(w.name)}</a></td><td>${fmtDate(w.endsAt)}</td><td class="num">${fmtInt(Math.max(0, (w.lengthYears ?? 0) - (w.progress?.year ?? 1) + 1))}</td><td class="name">${airlineCell(rowsOf.get(w.id)[0], { worldId: w.id, ctx, uid: `fn${w.id}` })}</td></tr>`).join('\n')}
      </tbody>
    </table>
    </div>` : '';

  // ── Trophies ──
  const shown = awards.filter((t) => t && t.name && t.airlineName).slice(0, 60);
  const trophyBlock = shown.length ? `    <div class="trophies">
${shown.map((t) => `      <div class="trophy">${TROPHY_IMAGE.test(t.imageUrl ?? '') && ctx.apiOrigin ? `<img src="${esc(`${ctx.apiOrigin}${t.imageUrl}`)}" alt="${esc(t.name)} trophy" width="120" height="120" loading="lazy" />` : '<div style="font-size:3rem;line-height:120px;height:120px">🏆</div>'}
        <strong>${esc(t.name)}</strong><br />${esc(t.airlineName)}${t.place ? ` · ${ordinal(Number(t.place))} place` : ''}
        <div class="muted" style="font-size:0.88rem">${[t.worldName, t.note, fmtDate(t.awardedAt)].filter(Boolean).map(esc).join(' · ')}</div>
      </div>`).join('\n')}
    </div>` : '    <p class="muted">No trophies have been handed out yet.</p>';

  const quiet = live.length - worlds.length;
  const body = `    <p class="muted"><a href="/worlds">← All worlds</a></p>
    <h1>Hall of fame</h1>
    <p class="lede">Who is winning, who holds the records, and who has a trophy to show for it — across every public Headwinds world. Every airline here is run by a real person.</p>

    <h2>Reigning leaders</h2>
${leaderTable}
    <p class="muted">The airline at #1 in each live world, and how many weeks in a row it has held the place. ${quiet > 0 ? `${plural(quiet, 'world has', 'worlds have')} too few airlines yet to have a table worth reading. ` : ''}Each world's <em>season so far</em> page has every year's podium.</p>
${worlds.length ? `    <p class="links">${worlds.map((w) => `<a href="/worlds/${esc(w.id)}/history">${esc(w.name)}: the season so far →</a>`).join('')}</p>` : ''}

    <h2>Records in the live worlds</h2>
${records.length ? `    <div class="records">\n${records.join('\n')}\n    </div>` : '    <p class="muted">No records yet.</p>'}
    <p class="muted">Standing records, read off this week's tables — they fall whenever somebody builds something bigger. Worlds differ in age, pace and rules, so a record set in a hundred-year world with scarce gates was harder won than the number alone shows.</p>

    <h2>Champions</h2>
${champions}
${finaleTable}

    <h2>Trophy cabinet</h2>
${trophyBlock}
    <p class="muted">Trophies are not computed: they are made for community event worlds — short, fast seasons with their own house rules — and handed to the winners by hand once the final ranking is in. Events are announced on the Headwinds Discord.</p>

    <h2>How a title is won</h2>
    <p>Every world keeps one official table. An airline's place in it is its <strong>average weekly net profit over the last 52 game weeks</strong>, with any week it was not flying counted as zero. That window is deliberate: a single lucky quarter cannot carry an airline to the top, and neither can a balance sheet built decades ago — the airline has to be earning now.</p>
    <p>When a world reaches the end of its season, the same table decides it. The champion is the airline with the best average over the <strong>final 52 weeks</strong>; second and third complete the podium, and the result is written onto each player's record. An airline that led for forty years and coasted through the last one can lose the title to a rival that timed its run — which is exactly how the closing year of a long world is meant to feel.</p>
    <p>Bankrupt airlines are out of the table but stay in the history, and a player who re-founds after a bankruptcy starts again from the bottom. The <a href="/strategy.html">strategy guide</a> covers playing the long clock; <a href="/competition-and-alliances.html">competition and alliances</a> covers what the airlines above are doing to each other in the meantime.</p>

    <a class="cta" href="/play">Found an airline — it's free →</a>`;

  return layout({
    title: 'Hall of Fame — Leaders, Records & Trophies · Headwinds',
    description: `The airlines leading every live Headwinds world, the standing records across ${fmtInt(all.length)} player-run airlines, concluded seasons and event trophies — in the multiplayer airline management game where every rival is a real person.`,
    path: '/worlds/hall-of-fame',
    body,
  });
}
