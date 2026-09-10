#!/usr/bin/env node
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
  rank, id: `air${rank}`, worldId: 'cmrx2f2m4000eo1158zc52qfr', accountId: `acct-secret-${rank}`,
  name, hub: 'SIN', cash: 349_840_704_305, marketCap: 226_187_231_950, shares: 104_302_508, svps: 4303.8,
  week: 1186, status: 'ACTIVE', joinedWeek: 653, routes: 75, fleet: 258, alliance: null,
  og: true, dev: false, lastMoveAt: '2026-09-09T09:39:24.370Z', ...over,
});
const detail = {
  world: world(),
  standings: [
    standing(1, 'Singapore Airlines', { alliance: 'Oriental' }),
    standing(2, HOSTILE, { hub: 'CDG', alliance: 'Oriental', marketCap: 2_500_000, cash: 120_000 }),
    standing(3, 'Axo Air', { hub: 'STL' }),
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
  for (const f of ['api/worlds.mjs', 'api/sitemap-worlds.mjs', 'api/_lib/render.mjs']) {
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
let R = null;
try {
  R = await import(pathToFileURL(path.join(APP, 'api/_lib/render.mjs')).href);
} catch (e) {
  fail(`cannot import api/_lib/render.mjs: ${e.message}`);
}
if (R) {
  const live = [world(), world({ id: 'cmthwrje0000abc123def456', name: 'Piston Age', startYear: 1950, playerCount: 8, maxPlayers: 40, gateScarcity: false })];
  const concluded = [world({ id: 'cmonyx000000000000000001', name: 'Onyx Wake', status: 'ENDED', playerCount: 4, champion: 'Air Caldor' })];
  const html = R.renderWorldsIndex({ live, concluded, standingsById: { [live[0].id]: detail.standings } });

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
  const page = R.renderWorldPage({ detail, news, typeName: (id) => ({ b737800: 'Boeing 737-800' })[id] ?? id });
  check(page.includes('<title>Scarce Assets — Live Standings · Headwinds</title>'), 'title names the world');
  check(page.includes('<link rel="canonical" href="https://www.headwindsairlinegame.com/worlds/cmrx2f2m4000eo1158zc52qfr" />'), 'self-canonical');
  check((page.match(/<tr>\s*<td class="num">\d+<\/td>/g) ?? []).length === 3, 'one standings row per airline');
  check(page.includes('$226.19B'), 'market cap formatted like the lobby ($226.19B)');
  check(page.includes('$2.5M') && page.includes('$120k'), 'small numbers formatted like the lobby ($2.5M, $120k)');
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
  check((sm.match(/<loc>/g) ?? []).length === 4, 'sitemap lists /worlds + 2 live + 1 concluded', `sitemap has ${(sm.match(/<loc>/g) ?? []).length} locs, expected 4`);
  check(sm.includes('<loc>https://www.headwindsairlinegame.com/worlds/cmonyx000000000000000001</loc>'), 'concluded worlds stay in the sitemap');

  console.log('\n6. Renderer: the escaper');
  check(R.esc(`<a href="x">&'`) === '&lt;a href=&quot;x&quot;&gt;&amp;&#39;', 'esc() covers < > & " \'');
  check(R.esc(null) === '' && R.esc(undefined) === '', 'esc() of nothing is empty');
  const s = R.stripStanding(detail.standings[0]);
  check(!('accountId' in s) && !('lastMoveAt' in s) && !('og' in s) && !('id' in s), 'stripStanding drops account id, activity time, badges, row id');
}

console.log(failures ? `\n${failures} failure(s)` : '\nAll green');
process.exit(failures ? 1 : 0);
