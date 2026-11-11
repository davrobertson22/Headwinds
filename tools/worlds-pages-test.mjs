#!/usr/bin/env node
// @run-alone — regenerates apps/headwinds-web/public/, so it must not run beside
// another suite that does (tools/run-tests.mjs).
// Public world pages — /worlds, /worlds/:id, /sitemap-worlds.xml.
//
//   node tools/worlds-pages-test.mjs
//
// Background (AdSense "Low value content", round 5, 2026-09-10): with every
// earlier defect fixed and deployed, the site was rejected again. What a
// reviewer could see was a sign-in form at /play plus guide pages that share a
// template with the already-approved Tailwinds site. The product itself —
// worlds full of player-run airlines — was invisible without an account.
// These pages put it on the public web as plain HTML.
//
// Two kinds of assertion here:
//   * on the repo — the rewrites, the nav links, the sitemaps (these fail on a
//     HEAD without the feature, no import needed);
//   * on the renderer — fed fixture JSON in the exact shape the API returns,
//     no network. Player-typed names are hostile by default.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HW  = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const APP = path.join(HW, 'apps/headwinds-web');
const OUT = path.join(APP, 'public');

let failures = 0;
const fail = (msg) => { failures++; console.error(`  ✗ ${msg}`); };
const pass = (msg) => console.log(`  ✓ ${msg}`);
const check = (cond, okMsg, badMsg = okMsg) => (cond ? pass(okMsg) : fail(badMsg));

// ── Fixtures: the API's own shapes (GET /worlds, /worlds/:id, /worlds/:id/news)
const HOSTILE = `<script>alert('x')</script>Air "Quotes" & Co`;
const world = (over = {}) => ({
  id: 'cmrx2f2m4000eo1158zc52qfr', name: 'Scarce Assets', status: 'RUNNING', visibility: 'PUBLIC',
  lengthYears: 100, weeksPerDay: 24, paceLabel: '1 week / 1 hr',
  progress: { year: 23, week: 42, totalYears: 100, percent: 23 },
  maxPlayers: 50, startingCapital: 15_000_000, seedCapital: 15_000_000, demandMultiplier: 1,
  scheduledStartAt: null, gateScarcity: true, newWorldRestrictions: false, crewPipeline: false,
  rivalItineraries: false, startYear: null, stage: 'beta', alpha: false, playerCount: 3,
  startedAt: '2026-07-23T05:23:11.360Z', endsAt: '2027-02-24T21:23:11.360Z', createdAt: '2026-07-23T05:22:59.453Z',
  ...over,
});
const standing = (rank, name, over = {}) => ({
  rank, id: `cmair00000000000000000${rank}`, worldId: 'cmrx2f2m4000eo1158zc52qfr', accountId: `acct-secret-${rank}`,
  name, hub: 'SIN', cash: 349_840_704_305, marketCap: 226_187_231_950, shares: 104_302_508, svps: 4303.8,
  week: 1186, status: 'ACTIVE', joinedWeek: 653, routes: 75, fleet: 258, alliance: null,
  avgProfit: 41_250_000, prevRank: rank, paxWeek: 120_000, flightsWeek: 900,
  logoId: 'compass', logoColor: '#1e9bff', logoBg: null, customLogo: null, livery: null, customTail: null,
  playerName: `secret-player-${rank}`,
  og: true, dev: false, lastMoveAt: '2026-09-09T09:39:24.370Z', ...over,
});
const detail = {
  world: world(),
  standings: [
    standing(1, 'Singapore Airlines', { alliance: 'Oriental' }),
    standing(2, HOSTILE, { hub: 'CDG', alliance: 'Oriental', marketCap: 2_500_000, cash: 120_000, avgProfit: 120_000, prevRank: 3,
      logoColor: '"><script>alert(2)</script>', logoId: '<img onerror=x>', customLogo: 'javascript:alert(3)', livery: { tail: 'url(evil)', tailDesign: '<b>' } }),
    standing(3, 'Axo Air', { hub: 'STL', avgProfit: -1_200_000, prevRank: 2, customLogo: '/logos/cmair000000000000000003?v=abcdef123456' }),
  ],
};
const news = [
  { id: 'wn:1', at: '2026-09-10T14:24:06.944Z', year: 23, week: 42, linearWeek: 1186, category: 'airports', kind: 'gate_forfeited',
    airlineId: 'a', accountId: 'acct-secret-9', airline: 'Pinguin Airlines', og: true, dev: false,
    data: { name: 'Pinguin Airlines', gates: 1, airport: 'YVR', lockoutWeeks: 24, lockedUntilWeek: 1210 }, tier: 1 },
  { id: 'wn:2', at: '2026-09-10T13:24:01.639Z', year: 23, week: 41, linearWeek: 1185, category: 'fleet', kind: 'fleet_in',
    airlineId: 'b', airline: HOSTILE, data: { total: 5, ordered: true, byType: { b737800: 5 } }, tier: 1 },
  { id: 'wn:3', at: '2026-09-10T13:24:01.639Z', year: 23, week: 41, linearWeek: 1185, category: 'world', kind: 'event_ended',
    airlineId: null, airline: null, data: { icon: '🚨', name: 'Political Unrest', type: 'disruption' }, tier: 1 },
  { id: 'wn:4', at: '2026-09-10T12:00:00.000Z', year: 23, week: 40, linearWeek: 1184, category: 'standings', kind: 'rank_change',
    airline: 'Axo Air', data: { direction: 'in', rank: 3 }, tier: 1 },
  { id: 'wn:5', at: '2026-09-10T11:00:00.000Z', year: 23, week: 40, linearWeek: 1184, category: 'routes', kind: 'some_future_kind',
    airline: 'Axo Air', data: {}, tier: 1 },
];

const visibleText = (html) => html
  .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ');
const words = (html) => visibleText(html).split(/\s+/).filter(Boolean).length;

// ── 1. Routing: the pages have to be reachable at clean URLs ────────────────
console.log('1. vercel.json routes /worlds, /worlds/:id and /sitemap-worlds.xml to the functions');
{
  const cfg = JSON.parse(readFileSync(path.join(APP, 'vercel.json'), 'utf8'));
  const rw = cfg.rewrites ?? [];
  const has = (src, dst) => rw.some((r) => r.source === src && r.destination === dst);
  check(has('/worlds', '/api/worlds'), '/worlds → /api/worlds', 'no rewrite /worlds → /api/worlds');
  check(has('/worlds/:id', '/api/worlds?id=:id'), '/worlds/:id → /api/worlds?id=:id', 'no rewrite /worlds/:id → /api/worlds?id=:id');
  check(has('/sitemap-worlds.xml', '/api/sitemap-worlds'), '/sitemap-worlds.xml → /api/sitemap-worlds', 'no rewrite for /sitemap-worlds.xml');
  check(has('/worlds/:id/history', '/api/worlds?id=:id&view=history'), '/worlds/:id/history → the season-so-far page', 'no rewrite for /worlds/:id/history');
  check(has('/worlds/:id/airlines/:airline', '/api/worlds?id=:id&airline=:airline'), '/worlds/:id/airlines/:airline → the airline page', 'no rewrite for the airline page');
  check(has('/worlds/:id/airlines/:airline/card.png', '/api/og?world=:id&airline=:airline'), '…/card.png → the share card', 'no rewrite for the share card');
  const web = JSON.parse(readFileSync(path.join(APP, 'package.json'), 'utf8'));
  check(Boolean(web.dependencies?.['@vercel/og']), 'the share card\'s renderer is a declared dependency', '@vercel/og is not in apps/headwinds-web/package.json');
  for (const f of ['api/worlds.mjs', 'api/og.mjs', 'api/sitemap-worlds.mjs', 'api/_lib/render.mjs', 'api/_lib/renderMore.mjs', 'api/_lib/brand.mjs', 'api/_lib/maps.mjs', 'api/_lib/card.mjs', 'api/_lib/data.mjs', 'api/_lib/brandMarks.mjs']) {
    check(existsSync(path.join(APP, f)), `${f} exists`, `${f} missing`);
  }
}

// ── 2. Discoverability: linked from every page, listed in the sitemaps ──────
console.log('\n2. Every page links to /worlds; robots.txt lists the worlds sitemap');
{
  console.log('   (regenerating apps/headwinds-web/public/ …)');
  execFileSync(process.execPath, [path.join(HW, 'tools/headwinds-public.mjs')], { stdio: 'pipe' });
  const generated = readdirSync(OUT).filter((f) => f.endsWith('.html')).sort();
  const unlinked = generated.filter((f) => !readFileSync(path.join(OUT, f), 'utf8').includes('href="/worlds"'));
  check(unlinked.length === 0, `all ${generated.length} generated pages link to /worlds`,
    `${unlinked.length}/${generated.length} generated pages have no /worlds link: ${unlinked.slice(0, 6).join(', ')}${unlinked.length > 6 ? ', …' : ''}`);
  // The logo and fin artwork is generated from the game's own components.
  try {
    execFileSync(process.execPath, ['--import', pathToFileURL(path.join(HW, 'tools/_register-loader.mjs')).href, path.join(HW, 'tools/generate-brand-marks.mjs'), '--check'], { stdio: 'pipe' });
    pass('api/_lib/brandMarks.mjs matches the logo and tail-fin components');
  } catch (e) {
    fail(`api/_lib/brandMarks.mjs is stale — run: node --import ./tools/_register-loader.mjs tools/generate-brand-marks.mjs (${String(e.stderr ?? e.message).trim().split('\n').pop()})`);
  }
  for (const f of ['index.html', 'play.html']) {
    const html = readFileSync(path.join(APP, f), 'utf8');
    check(html.includes('href="/worlds"'), `${f} links to /worlds`, `${f} has no /worlds link`);
  }
  const sitemap = readFileSync(path.join(OUT, 'sitemap.xml'), 'utf8');
  check(sitemap.includes('<loc>https://www.headwindsairlinegame.com/worlds</loc>'), 'sitemap.xml lists /worlds', 'sitemap.xml does not list /worlds');
  const robots = readFileSync(path.join(OUT, 'robots.txt'), 'utf8');
  check(robots.includes('Sitemap: https://www.headwindsairlinegame.com/sitemap-worlds.xml'), 'robots.txt lists sitemap-worlds.xml', 'robots.txt does not list sitemap-worlds.xml');
}

// ── 3. The renderer ─────────────────────────────────────────────────────────
console.log('\n3. Renderer: index page');
let R = null, M = null, CARD = null;
try {
  R = await import(pathToFileURL(path.join(APP, 'api/_lib/render.mjs')).href);
  M = await import(pathToFileURL(path.join(APP, 'api/_lib/renderMore.mjs')).href);
  CARD = await import(pathToFileURL(path.join(APP, 'api/_lib/card.mjs')).href);
} catch (e) {
  fail(`cannot import the renderers: ${e.message}`);
  R = null;
}
// What the handler loads from the engine, as the renderers receive it.
const AIRPORTS = { SIN: { code: 'SIN', city: 'Singapore', country: 'SG', lat: 1.36, lon: 103.99 }, CDG: { code: 'CDG', city: 'Paris', country: 'FR', lat: 49.01, lon: 2.55 },
  STL: { code: 'STL', city: 'St. Louis', country: 'US', lat: 38.75, lon: -90.37 }, LHR: { code: 'LHR', city: 'London', country: 'GB', lat: 51.47, lon: -0.45 },
  SYD: { code: 'SYD', city: 'Sydney', country: 'AU', lat: -33.95, lon: 151.18 } };
const ctx = { apiOrigin: 'https://api.headwindsairlinegame.com', getAirport: (c) => AIRPORTS[c], brand: null };
if (R) {
  const live = [world(), world({ id: 'cmthwrje0000abc123def456', name: 'Piston Age', startYear: 1950, playerCount: 8, maxPlayers: 40, gateScarcity: false })];
  const concluded = [world({ id: 'cmonyx000000000000000001', name: 'Onyx Wake', status: 'ENDED', playerCount: 4, champion: 'Air Caldor' })];
  const html = R.renderWorldsIndex({ live, concluded, standingsById: { [live[0].id]: detail.standings }, ctx });
  check(html.includes('Avg weekly profit</th>'), 'index cards show avg weekly profit');
  check(html.includes('href="/worlds/hall-of-fame"'), 'index links to the hall of fame');
  const quiet = R.renderWorldsIndex({ live: [world({ playerCount: 2 })], concluded: [], standingsById: { [live[0].id]: detail.standings.slice(0, 2) }, ctx });
  check(!quiet.includes('<table>') && quiet.includes('2 airlines so far'), 'a world with two airlines gets a short card, not a two-row table');
  const order = R.renderWorldsIndex({ live: [world({ id: 'cmsmall0000000000000001', name: 'Small', playerCount: 4 }), world({ name: 'Big', playerCount: 40 })], concluded: [], standingsById: {}, ctx });
  check(order.indexOf('>Big<') < order.indexOf('>Small<'), 'the busiest world is listed first');

  check(html.includes('<title>Live Worlds'), 'has a title');
  check(html.includes('<link rel="canonical" href="https://www.headwindsairlinegame.com/worlds" />'), 'self-canonical');
  check(html.includes('google-adsense-account') && html.includes('adsbygoogle.js?client=ca-pub-5123198950074938'), 'carries the AdSense meta + loader like every other page');
  check(html.includes('Scarce Assets') && html.includes('Piston Age') && html.includes('Onyx Wake'), 'names every live and concluded world');
  check(html.includes('href="/worlds/cmrx2f2m4000eo1158zc52qfr"'), 'links each world to its own page');
  check(html.includes('Air Caldor'), 'concluded season shows its champion');
  check(html.includes('era world starting in 1950'), 'era worlds say so');
  check(html.includes('Singapore Airlines') && html.includes('Axo Air'), 'top standings appear on the card');
  check(!html.includes('<script>alert'), 'player-typed airline name is escaped (no live <script>)');
  check(html.includes('&lt;script&gt;alert'), 'escaped name is still shown');
  check(!html.includes('acct-secret'), 'no account ids leak');
  check(!html.includes('lastMoveAt') && !html.includes('2026-09-09T09:39'), 'no activity timestamps leak');
  check(html.includes('href="/worlds"') && html.includes('href="/play"'), 'site nav + footer present');
  const w = words(html);
  check(w >= 400, `${w} visible words with two worlds listed (floor 400)`, `only ${w} visible words — thin`);

  const empty = R.renderWorldsIndex({ live: [], concluded: [], standingsById: {} });
  check(empty.includes('No public worlds are open'), 'empty world list renders a sentence, not a blank page');

  console.log('\n4. Renderer: world page');
  const page = R.renderWorldPage({ detail, news, typeName: (id) => ({ b737800: 'Boeing 737-800' })[id] ?? id, ctx });
  check(page.includes('<title>Scarce Assets — 47 of 50 airline seats open · Headwinds</title>'), 'title names the world (and, while seats are open, reads as an invite — world-invite-test)');
  check(page.includes('<link rel="canonical" href="https://www.headwindsairlinegame.com/worlds/cmrx2f2m4000eo1158zc52qfr" />'), 'self-canonical');
  check((page.match(/<tr>\s*<td class="num">\d+<\/td>/g) ?? []).length === 3, 'one standings row per airline');
  check(page.includes('$226.19B'), 'market cap formatted like the lobby ($226.19B)');
  check(page.includes('$2.5M') && page.includes('$120k'), 'small numbers formatted like the lobby ($2.5M, $120k)');
  check(page.includes('Avg weekly profit</th>') && page.includes('$41.3M'), 'the table shows the figure the rank is decided on (avg weekly profit)', 'no "Avg weekly profit" column — the table is ranked on a number it does not show');
  check(!page.includes('>Cash</th>'), 'no cash column: a bank balance is not the ranking and not the public\'s business');
  check(page.includes('−$1.2M'), 'a loss reads −$1.2M, not $-1.2M');
  check(page.includes('class="up"') && page.includes('▲1') && page.includes('▼1'), 'rank moves since last week are shown');
  check(page.includes('href="/worlds/cmrx2f2m4000eo1158zc52qfr/airlines/cmair000000000000000001"'), 'each airline links to its own page');
  check(page.includes('href="/worlds/cmrx2f2m4000eo1158zc52qfr/history"'), 'links to the season-so-far page');
  check((page.match(/<svg class="logo"/g) ?? []).length >= 3, 'a logo beside every airline');
  check(!page.includes('alert(2)') && !page.includes('onerror') && !page.includes('javascript:') && !page.includes('url(evil)'), 'hostile logo colour, logo id, upload path and livery never reach the markup');
  check(page.includes('https://api.headwindsairlinegame.com/logos/cmair000000000000000003?v=abcdef123456'), 'a genuine uploaded logo is linked from the API origin');
  check(page.includes('<svg class="map"') && page.includes('/tiles/bluemarble/2/'), 'hub map drawn over the game\'s own satellite tiles');
  check(!page.includes('secret-player'), 'no player name leaks');
  const bare = R.renderWorldPage({ detail, news, typeName: undefined });
  check(bare.includes('Singapore Airlines') && !bare.includes('<svg class="map"'), 'with no engine data the page still renders, just without its map');
  check(page.includes('<strong>Oriental</strong> — 2 member airlines'), 'alliances tallied from the standings');
  check(page.includes('forfeited 1 gate at YVR'), 'gate_forfeited headline composed');
  check(page.includes('ordered 5× Boeing 737-800'), 'fleet_in headline uses the injected type name');
  check(page.includes('Political Unrest</strong> has passed'), 'world event headline composed');
  check(page.includes('climbed into the top 5 — now #3'), 'rank_change headline composed');
  check(page.includes('some future kind'), 'an unknown kind degrades to readable text rather than throwing');
  check(page.includes('Y23 W42') && page.includes('Y23 W41'), 'headlines dated by game year/week');
  check(!page.includes('<script>alert'), 'hostile name escaped in table and headlines');
  check(!page.includes('acct-secret'), 'no account ids leak (standings or news)');
  check(page.includes('href="/play#/w/cmrx2f2m4000eo1158zc52qfr"'), 'join CTA deep-links into the game');
  check(page.includes('Gate scarcity:</strong> on'), 'world rules explained');
  const pw = words(page);
  check(pw >= 350, `${pw} visible words (floor 350)`, `only ${pw} visible words — thin`);

  const ended = R.renderWorldPage({ detail: { world: world({ status: 'ENDED', name: 'Onyx Wake' }), standings: detail.standings }, news: [] });
  check(ended.includes('Final Standings') && ended.includes('won by Singapore Airlines'), 'concluded world reads as final, names the champion');
  check(!ended.includes('href="/play#/w/'), 'no join CTA on a concluded world');
  check(ended.includes('No headlines yet'), 'empty news renders a sentence');

  console.log('\n5. Renderer: error pages + sitemap');
  const nf = R.renderNotFound();
  check(nf.includes('<meta name="robots" content="noindex" />') && !nf.includes('rel="canonical"'), '404 page is noindex, not canonical');
  const un = R.renderUnavailable();
  check(un.includes('noindex'), '503 page is noindex');
  const sm = R.renderWorldsSitemap({ live, concluded, now: new Date('2026-09-10T00:00:00Z') });
  check(sm.startsWith('<?xml version="1.0"'), 'sitemap is XML');
  check((sm.match(/<loc>/g) ?? []).length === 7, 'sitemap lists /worlds, the hall of fame, 2 live worlds each with its history page, and 1 concluded', `sitemap has ${(sm.match(/<loc>/g) ?? []).length} locs, expected 7`);
  const smA = R.renderWorldsSitemap({ live, concluded, airlinesById: { [live[0].id]: [standing(1, 'Big', { routes: 75 }), standing(2, 'Tiny', { routes: 2 })] }, now: new Date('2026-09-10T00:00:00Z') });
  check(smA.includes('/airlines/cmair000000000000000001</loc>') && !smA.includes('/airlines/cmair000000000000000002'), 'airlines with a real network are listed; a two-route airline is not');
  check(sm.includes('<loc>https://www.headwindsairlinegame.com/worlds/cmonyx000000000000000001</loc>'), 'concluded worlds stay in the sitemap');

  console.log('\n6. Renderer: the escaper');
  check(R.esc(`<a href="x">&'`) === '&lt;a href=&quot;x&quot;&gt;&amp;&#39;', 'esc() covers < > & " \'');
  check(R.esc(null) === '' && R.esc(undefined) === '', 'esc() of nothing is empty');
  const s = R.stripStanding(detail.standings[0]);
  check(!('accountId' in s) && !('lastMoveAt' in s) && !('og' in s) && !('playerName' in s) && !('cash' in s), 'stripStanding drops account id, player name, activity time, badges and cash');
  check(s.id === 'cmair000000000000000001' && R.stripStanding({ id: '../../etc' }).id === null, 'the airline id (the page address) is kept only when it looks like one');

  // ── The pages added 2026-11-10 ────────────────────────────────────────────
  console.log('\n7. Renderer: an airline\'s page');
  const rival = {
    airline: { id: 'cmair000000000000000001', name: 'Singapore Airlines', accountId: 'acct-secret-1' },
    hubs: ['SIN'], alliance: 'Oriental', badges: ['secret-badge'], lastMoveAt: '2026-09-09T09:39:24.370Z',
    routeNetwork: [
      { origin: 'SIN', destination: 'LHR', weeklyFrequency: 14, economyFare: 810 },
      { origin: 'SIN', destination: 'LHR', weeklyFrequency: 7, economyFare: 810 },
      { origin: 'SIN', destination: 'SYD', weeklyFrequency: 10, economyFare: 420 },
      { origin: 'SIN', destination: '<script>', weeklyFrequency: 1, economyFare: 1 },
    ],
    cargoNetwork: [{ origin: 'SIN', destination: 'CDG', weeklyFrequency: 3 }],
    fleetByType: { b737800: 5, a380: 2 },
    rankHistory: [{ week: 1180, rank: 3 }, { week: 1183, rank: 2 }, { week: 1186, rank: 1 }],
    recentMoves: [],
  };
  const ap = M.renderAirlinePage({ detail, rival, news: [{ ...news[1], airlineId: 'cmair000000000000000001', airline: 'Singapore Airlines' }], typeName: (id) => ({ b737800: 'Boeing 737-800', a380: 'Airbus A380' })[id] ?? id, ctx });
  check(ap.includes('<title>Singapore Airlines — #1 in Scarce Assets · Headwinds</title>'), 'title names the airline, its rank and its world');
  check(ap.includes('<link rel="canonical" href="https://www.headwindsairlinegame.com/worlds/cmrx2f2m4000eo1158zc52qfr/airlines/cmair000000000000000001" />'), 'self-canonical');
  check(ap.includes('og:image" content="https://www.headwindsairlinegame.com/worlds/cmrx2f2m4000eo1158zc52qfr/airlines/cmair000000000000000001/card.png?w=1186"'), 'its preview image is its own share card, addressed by game week');
  check(ap.includes('2 city pairs') && ap.includes('<td class="num">21</td>'), 'a pair scheduled twice is one row with the frequencies added (14 + 7 = 21)');
  check(ap.includes('Singapore and London') && ap.includes('$810'), 'routes are named by city, with the published fare');
  check(ap.includes('Boeing 737-800') && ap.includes('Airbus A380'), 'fleet listed by type name');
  check(ap.includes('<svg class="map"') && ap.includes('<svg class="chart"'), 'network map and rank chart drawn');
  check(ap.includes('1 freight lane'), 'freight lanes counted');
  check(ap.includes('ordered 5× Boeing 737-800'), 'its own headlines are listed');
  check(!ap.includes('<script>alert') && !ap.includes('SIN–<script>'), 'a hostile airport code is dropped, not printed');
  check(!ap.includes('acct-secret') && !ap.includes('secret-badge') && !ap.includes('secret-player') && !ap.includes('2026-09-09T09:39'), 'no account id, badge, player name or last-move time');
  check(!/349[.,]84|\$349/.test(ap), 'no cash balance');
  check(!ap.includes('name="robots" content="noindex"'), 'an airline with a real network is indexable');
  const tiny = M.renderAirlinePage({ detail: { world: world(), standings: [standing(1, 'New Air', { routes: 2 })] }, rival: { ...rival, routeNetwork: rival.routeNetwork.slice(2, 3) }, ctx });
  check(tiny.includes('name="robots" content="noindex"'), 'a just-founded airline\'s page is noindex (thin)');
  check(M.renderAirlinePage({ detail, rival: { airline: { id: 'cmnotinthisworld0000001' } }, ctx }) === null, 'an airline not in the standings renders nothing (the handler answers 404)');
  const aw = words(ap);
  check(aw >= 250, `${aw} visible words (floor 250)`, `only ${aw} visible words — thin`);

  console.log('\n8. Renderer: the season so far');
  const history = {
    thisWeek: 1186, rankingSince: 1100,
    years: [
      { year: 21, week: 1093, metric: 'svps', podium: [{ rank: 1, airlineId: 'gone1', name: 'Old Guard', hub: 'LHR', gone: false, active: false, metric: 'svps', score: 12.5 }] },
      { year: 22, week: 1145, metric: 'avgWeeklyNetProfit', podium: [
        { rank: 1, airlineId: 'cmair000000000000000001', name: 'Singapore Airlines', hub: 'SIN', gone: false, active: true, metric: 'avgWeeklyNetProfit', score: 30_000_000 },
        { rank: 2, airlineId: 'cmair000000000000000002', name: null, hub: null, gone: true, metric: 'avgWeeklyNetProfit', score: 1 },
        { rank: 3, airlineId: 'cmair000000000000000003', name: 'Axo Air', hub: 'STL', gone: false, active: true, metric: 'avgWeeklyNetProfit', score: 5 }] },
    ],
    yearsLed: [{ airlineId: 'cmair000000000000000001', name: 'Singapore Airlines', hub: 'SIN', years: 1, lastYear: 22 }],
    reign: { airlineId: 'cmair000000000000000001', name: 'Singapore Airlines', weeks: 41, since: 1146, capped: false },
    yearAgo: { week: 1134, airlines: 3, ranks: [{ airlineId: 'cmair000000000000000003', rank: 1 }, { airlineId: 'cmair000000000000000001', rank: 3 }] },
  };
  const hp = M.renderHistoryPage({ detail: { ...detail, fallen: 4 }, history, news, typeName: (id) => ({ b737800: 'Boeing 737-800' })[id] ?? id, ctx });
  check(hp.includes('<link rel="canonical" href="https://www.headwindsairlinegame.com/worlds/cmrx2f2m4000eo1158zc52qfr/history" />'), 'self-canonical');
  check(hp.includes('held #1 for 41 weeks in a row (since Y23 W2)'), 'the leader\'s run at #1 is stated');
  check(hp.includes('3rd → 1st') && hp.includes('1st → 3rd'), 'biggest climb and slide come from last year\'s ranks');
  check(hp.includes('4 have gone under or walked away'), 'the fallen are counted');
  check(hp.includes('an airline since re-founded'), 'a podium place earned before a restart is not credited to the new airline');
  check(hp.includes('Old Guard') && hp.includes('no longer flying'), 'an airline that has left keeps its place in the record');
  check(hp.includes('$12.50 a share') && hp.includes('$30.0M a week'), 'pre-rework years show a share value, later ones a profit');
  check(hp.includes('Largest orders') && hp.includes('Boeing 737-800'), 'the year\'s largest order is drawn from the news');
  check(!hp.includes('<script>alert') && !hp.includes('acct-secret') && !hp.includes('secret-player'), 'escaped, and nobody named');
  const early = M.renderHistoryPage({ detail, history: {}, news: [], ctx });
  check(early.includes('No game year has finished yet'), 'a world in its first year renders sentences, not empty tables');
  const hw = words(hp);
  check(hw >= 250, `${hw} visible words (floor 250)`, `only ${hw} visible words — thin`);

  console.log('\n9. Renderer: hall of fame');
  const hof = M.renderHallOfFame({
    live: [world(), world({ id: 'cmquiet000000000000001', name: 'Empty Sky', playerCount: 1 })], concluded: [],
    standingsById: { cmrx2f2m4000eo1158zc52qfr: detail.standings, cmquiet000000000000001: [standing(1, 'Lonely Air')] },
    historyById: { cmrx2f2m4000eo1158zc52qfr: history },
    awards: [
      { id: 'a1', trophyId: 't1', name: 'Concorde Cup', imageUrl: '/trophies/cmtrophy0000001/image?v=abc123def456', worldName: 'Sprint One', airlineName: HOSTILE, place: 1, note: 'Event winner', awardedAt: '2026-10-20T00:00:00Z', accountId: 'acct-secret-7', playerName: 'secret-player-7' },
      { id: 'a2', trophyId: 't2', name: 'Bad Art', imageUrl: 'javascript:alert(4)', worldName: 'Sprint One', airlineName: 'Axo Air', place: 2, awardedAt: '2026-10-20T00:00:00Z' },
    ],
    ctx,
  });
  check(hof.includes('<link rel="canonical" href="https://www.headwindsairlinegame.com/worlds/hall-of-fame" />'), 'self-canonical');
  check(hof.includes('Reigning leaders') && hof.includes('Singapore Airlines') && hof.includes('<td class="num">41</td>'), 'each world\'s leader, with its weeks at #1');
  check(!hof.includes('Lonely Air') && hof.includes('1 world has too few airlines'), 'a one-airline world has no "leader" and no records');
  check(hof.includes('Largest fleet') && hof.includes('Highest average weekly profit') && hof.includes('Largest alliance'), 'records computed from the standings');
  check(hof.includes('No season has finished yet') && hof.includes('Finales ahead') && hof.includes('Feb 24, 2027'), 'with no champion yet, the finales still to come are listed');
  check(hof.includes('Concorde Cup') && hof.includes('https://api.headwindsairlinegame.com/trophies/cmtrophy0000001/image?v=abc123def456'), 'trophies shown with their artwork');
  check(!hof.includes('javascript:') && !hof.includes('<script>alert'), 'a hostile trophy image path or airline name never reaches the markup');
  check(!hof.includes('acct-secret') && !hof.includes('secret-player'), 'trophy winners are airlines — no account, no player name');
  const done = M.renderHallOfFame({ live: [], concluded: [world({ id: 'cmonyx000000000000000001', name: 'Onyx Wake', status: 'ENDED', champion: 'Air Caldor' })], ctx });
  check(done.includes('Air Caldor') && done.includes('Onyx Wake'), 'concluded seasons list their champion');
  const fw = words(hof);
  check(fw >= 400, `${fw} visible words (floor 400)`, `only ${fw} visible words — thin`);
  const titles = [page, ap, hp, hof, html].map((h) => (h.match(/<title>([^<]+)<\/title>/) ?? [])[1]);
  check(new Set(titles).size === titles.length, 'every page kind has its own title');

  console.log('\n10. The share card');
  const card = await CARD.buildCard({ detail, airlineId: 'cmair000000000000000001', ctx, inline: async () => null });
  check(card && card.lines.includes('Singapore Airlines') && card.lines.includes('#1 of 3') && card.lines.includes('Scarce Assets'), 'says who, where they stand and in which world');
  const flat = JSON.stringify(card?.element ?? {});
  check(!flat.includes('acct-secret') && !flat.includes('secret-player'), 'nobody named on the card');
  check(!/41\.3M|349\.84|226\.19/.test(flat), 'no profit, cash or market cap on the card — rank and network only');
  check(flat.includes('data:image/svg+xml;base64,'), 'the tail fin is embedded in the picture');
  check(await CARD.buildCard({ detail, airlineId: 'cmnotinthisworld0000001', ctx }) === null, 'no card for an airline that is not in the world');
  const og = readFileSync(path.join(APP, 'api/og.mjs'), 'utf8');
  check(/statusCode = 302/.test(og) && og.includes("'/og-image.png'"), 'a card that cannot be drawn falls back to the site\'s ordinary preview, never an error');
}

console.log(failures ? `\n${failures} failure(s)` : '\nAll green');
process.exit(failures ? 1 : 0);
