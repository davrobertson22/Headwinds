#!/usr/bin/env node
// Build the Headwinds web client's public/ directory.
//
//   node tools/headwinds-public.mjs        (also runs automatically via the
//                                           predev/prebuild hooks in
//                                           apps/headwinds-web/package.json)
//
// WHY THIS EXISTS: the repo-root public/ is synced FROM Tailwinds (rsync
// --delete in tools/sync-from-tailwinds.mjs), so nothing Headwinds-specific may
// live there — it would be wiped on the next sync. Instead, this script
// generates apps/headwinds-web/public/ (gitignored) fresh on every build:
//
//   1. copies root public/ (shared game assets + info pages)
//   2. re-brands every .html page for Headwinds — teal palette, Headwinds
//      name/canonicals, Play links → /play, footer cross-link to Tailwinds
//   3. overlays apps/headwinds-web/brand/  (Headwinds logos, icons, og-image)
//   4. overlays apps/headwinds-web/pages/  (hand-written Headwinds pages that
//      fully replace their Tailwinds counterparts: devlog, about,
//      competition-and-alliances, …)
//   5. writes a Headwinds manifest.webmanifest, robots.txt and sitemap.xml
//
// Because steps 2's transforms re-run on every build, freshly synced Tailwinds
// page updates are picked up automatically — edit the SHARED pages in the
// Tailwinds repo, and the HEADWINDS-ONLY pages in apps/headwinds-web/pages/.
import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HW    = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SRC   = path.join(HW, 'public');
const APP   = path.join(HW, 'apps/headwinds-web');
const BRAND = path.join(APP, 'brand');
const PAGES = path.join(APP, 'pages');
const OUT   = path.join(APP, 'public');

const DOMAIN = 'www.headwindsairlinegame.com';

// Pages still ~80-90% identical to their Tailwinds originals (word-swap rebrand
// only). Until each gets a hand-written override in apps/headwinds-web/pages/,
// its canonical points at the Tailwinds original so Google doesn't read the two
// sites as duplicates of each other (AdSense "low value content" trigger,
// diagnosed 2026-07-19). Remove a file from this set when its override lands.
const CROSS_CANONICAL = new Set([
  'aircraft.html', 'aircraft-narrow-body.html', 'aircraft-wide-body.html',
  'aircraft-regional-jets.html', 'aircraft-turboprops.html',
  'aircraft-freighters.html', 'aircraft-flagships.html',
  'fleet-planning.html', 'faq.html',
]);

// Never copied from the shared public/ (Tailwinds-only concerns).
const EXCLUDE = new Set([
  'sw.js',                        // solo PWA service worker — Headwinds doesn't register one
  'googleb69adfd073bb3cd6.html',  // Tailwinds' Google Search Console verification
  'manifest.webmanifest',         // rewritten below for Headwinds
  'sitemap.xml',                  // regenerated below for this domain
  'robots.txt',                   // regenerated below for this domain
  'llms.txt',                     // regenerated below for this domain
]);
const isJunk = (f) => f === '.DS_Store' || f.startsWith('.fuse_hidden');

// Tailwinds page palette → Headwinds palette (same dark family as the app).
const PALETTE = [
  ['#1b1b1f', '#0b0e13'], // page bg
  ['#18181b', '#0b0e13'], // alt bg / theme-color
  ['#141416', '#0a0d12'], // deepest bg
  ['#26262d', '#141a23'], // panel
  ['#2f3037', '#1b2330'], // panel-2
  ['#3a3b40', '#263143'], // line
  ['#ededee', '#e8edf4'], // text
  ['#c7c7cd', '#c3cddb'], // text-soft
  ['#a1a1aa', '#8b98ab'], // muted
  ['#9a9aa2', '#8b98ab'], // muted alt
  ['#6e6f76', '#66748a'], // faint
  ['#c79a4b', '#38c9b4'], // gold      → teal
  ['#d3ad63', '#5fe0cc'], // gold-light → teal-bright
  ['#20180a', '#04211d'], // on-gold text → on-teal text
];

// Solo-game claims that survive the mechanical rebrand but are WRONG for
// multiplayer (local saves, no account, AI competitors). Applied AFTER the
// rebrand, so `find` strings are written post-rebrand ("Headwinds", teal).
// A missing anchor is a WARNING, not an error — it means Tailwinds rewrote the
// sentence; update the patch when convenient. Pages that diverge too much for
// string patches live in apps/headwinds-web/pages/ instead.
const CONTENT_PATCHES = [
  // faq.html — accounts, saving, winning, offline are all different in multiplayer
  {
    file: 'faq.html',
    find: 'There is nothing to download, no account to create, and no purchase required to access any part of the game.',
    replace: 'There is nothing to download and no purchase required — just sign in with Google or an email link and join a world.',
  },
  {
    file: 'faq.html',
    find: "Your game saves automatically in your browser's local storage on the device you play on. You can also export a save file as a backup or to move your airline to another device, and import it there.",
    replace: "Your airline lives on the Headwinds server, not in your browser. Game weeks advance automatically even while you're offline, and signing in from any device picks up right where the world has gotten to.",
  },
  {
    file: 'faq.html',
    find: 'Headwinds is an open-ended management simulation. The core challenge is building a profitable, growing airline without going bankrupt, and in-game board objectives give you concrete goals to chase as your airline matures.',
    replace: 'Each Headwinds world runs for a fixed span of game-years and ends with final standings — the airline on top has out-flown real people, not an algorithm. Along the way, board objectives and the weekly rankings give you concrete goals to chase.',
  },
  {
    file: 'faq.html',
    find: "Yes — completely free, in your browser. There's nothing to download, no account to create, and no purchase required to access any part of the game.",
    replace: "Yes — completely free, in your browser. There's nothing to download and no purchase required. Sign in with Google or an email link and join a world.",
  },
  {
    file: 'faq.html',
    find: 'No. You pick an airline name, choose a home airport, and start playing. No sign-up, no email, no password.',
    replace: 'Yes — one quick sign-in with Google or an email link, so your airlines stay yours across worlds and devices. Then you pick an airline name, choose a home airport, and start playing.',
  },
  {
    file: 'faq.html',
    find: "Progress saves automatically in your browser's storage on the device you play on. Because saves are local, clearing your browser data will erase them — the game's save menu lets you export a save file as a backup, and import it on any other device to continue the same airline there.",
    replace: "Your airline is saved on the server, continuously — there's nothing to manage and nothing to lose. The world keeps running while you're away (game weeks advance automatically on the server clock), and signing in from any device picks up exactly where the world has gotten to.",
  },
  {
    file: 'faq.html',
    find: 'Headwinds is open-ended, like the classic tycoon games. The real challenge is building a profitable, respected airline without going bankrupt — and the in-game board objectives give you concrete goals as your airline grows.',
    replace: 'Each world runs for a fixed span of game-years and ends with final standings, so there is a scoreboard — and everyone on it is a real person. The in-game board objectives still give you concrete goals as your airline grows.',
  },
  {
    file: 'faq.html',
    find: 'Partially — as an installed progressive web app, the game can start without a connection once it has been loaded and cached. A connection is recommended for updates.',
    replace: "No — Headwinds is a live multiplayer game, so you need a connection to play. The world keeps running on the server either way; whatever happens while you're offline is waiting in your debrief.",
  },
  // how-to-play.html — sign-in + server saves; rivals are humans
  {
    file: 'how-to-play.html',
    find: 'There is nothing to download and no account to create. Everything runs in your browser, and your progress saves automatically on the device you play on.',
    replace: 'There is nothing to download — everything runs in your browser. Sign in with Google or an email link, join a world, and your airline lives on the server, advancing even while you are away.',
  },
  {
    file: 'how-to-play.html',
    find: 'When an AI carrier moves into your route',
    replace: 'When another player moves into your route',
  },
  // strategy.html — the rivals are people
  {
    file: 'strategy.html',
    find: 'You share the map with computer-controlled airlines, and they will move into your profitable routes.',
    replace: 'You share the map with other players’ airlines, and they will move into your profitable routes.',
  },
  // hub-strategy.html — encroachment comes from humans here
  {
    file: 'hub-strategy.html',
    find: "At mega-hubs you'll fight established AI carriers from day one.",
    replace: "At mega-hubs you're likelier to fight established rivals from day one.",
  },
  {
    file: 'hub-strategy.html',
    find: "Headwinds' AI competitors notice profitable markets and move in — the game models route encroachment directly.",
    replace: 'Your rivals are real players who notice profitable markets and move in — contested routes split demand between the airlines flying them.',
  },
  // route-economics.html — the demand pool is contested by real people
  {
    file: 'route-economics.html',
    find: "You're never pricing in a vacuum — you're competing for a finite pool.",
    replace: "You're never pricing in a vacuum — in Headwinds you're competing for that finite pool against real players, and they price back.",
  },
];

function rebrand(html) {
  let s = html;
  // 1. Domain: canonicals, og:url, sitemap refs all move to this site.
  s = s.replace(/(?:www\.)?tailwindsairlinegame\.com/g, DOMAIN);
  // 2. Palette (hex values appear in inline <style> blocks and style attrs).
  for (const [from, to] of PALETTE) s = s.replaceAll(from, to).replaceAll(from.toUpperCase(), to);
  // 3. Brand name — capital-T word only, so lowercase asset filenames like
  //    /tailwinds-mark-color.png keep pointing at the shared art they name.
  s = s.replace(/\bTailwinds\b/g, 'Headwinds');
  // 4. "Play" links point at the app, not the landing page.
  s = s.replace(/<a class="link" href="\/">Play<\/a>/g, '<a class="link" href="/play">Play</a>');
  s = s.replace(/class="cta" href="\/"/g, 'class="cta" href="/play"');
  // 5. Footer cross-link back to the solo game. The optional group also strips
  //    the reverse "Multiplayer: Headwinds" link the synced Tailwinds info pages
  //    now carry, so the live Headwinds pages never link to themselves.
  s = s.replace(
    /© Headwinds — free to play in your browser\.(?:\s*Multiplayer:\s*<a\b[^>]*>Headwinds<\/a>\.)?/g,
    '© Headwinds — multiplayer, free in your browser. Solo game: <a href="https://www.tailwindsairlinegame.com" target="_blank" rel="noopener noreferrer">Tailwinds</a>.'
  );
  return s;
}

// Surface the Headwinds-only Rules page in the shared nav + footer of EVERY page.
// The Rules page is multiplayer-specific (it has no Tailwinds counterpart), so
// the link can't live in the synced root public/ pages — it's injected here at
// build time instead. Idempotent: rules.html already carries its own links, and
// re-runs start from a clean OUT, so nothing double-links. A page missing the
// FAQ anchor simply keeps the link it does have.
function injectRulesLink(html) {
  if (html.includes('href="/rules.html"')) return html;   // e.g. rules.html itself
  let s = html;
  // Top nav (class="link") — Rules sits after FAQ, before Play.
  s = s.replace(
    '<a class="link" href="/faq.html">FAQ</a>',
    '<a class="link" href="/faq.html">FAQ</a>\n      <a class="link" href="/rules.html">Rules</a>',
  );
  // Footer list (plain anchors) — Rules after FAQ.
  s = s.replace(
    '<a href="/faq.html">FAQ</a>',
    '<a href="/faq.html">FAQ</a>\n      <a href="/rules.html">Rules</a>',
  );
  return s;
}

// Put the Headwinds logo mark + teal wordmark in the header of EVERY page.
// The shared info pages (synced from Tailwinds) and the hand-written Headwinds
// pages both ship a text-only brand link — only the landing page (the app's own
// index.html) carries the mark. This makes the whole site consistent with it.
// Every generated page uses the identical `.brand` markup and CSS rule, so a
// single string swap covers all of them. Idempotent: after the swap the source
// strings are gone, and re-runs start from a clean OUT. Uses the literal teal
// hex (#38c9b4) rather than a CSS var because the shared pages name their accent
// var `--gold` (holding teal post-rebrand) while the hand-written pages use
// `--teal` — the hex works on both without depending on either name.
function injectBrandLogo(html) {
  let s = html;
  // 1. Restyle the brand link: horizontal lockup, mark sized to the wordmark,
  //    wordmark in Headwinds teal.
  s = s.replace(
    'nav.site .brand { font-family:\'Space Grotesk\',sans-serif; font-weight:700; font-size:1.15rem; color:var(--text); text-decoration:none; margin-right:auto; }',
    'nav.site .brand { display:inline-flex; align-items:center; gap:9px; font-family:\'Space Grotesk\',sans-serif; font-weight:700; font-size:1.15rem; letter-spacing:0.5px; color:#38c9b4; text-decoration:none; margin-right:auto; }\n    nav.site .brand img { height:22px; width:auto; display:block; }',
  );
  // 2. Add the mark image ahead of the wordmark text. Decorative (alt="") — the
  //    adjacent "Headwinds" text already names the link. 848x479 art → 39x22.
  s = s.replace(
    '<a class="brand" href="/">Headwinds</a>',
    '<a class="brand" href="/"><img src="/headwinds-mark-color.png" alt="" width="39" height="22" />Headwinds</a>',
  );
  return s;
}

// Vercel Web Analytics on EVERY generated page. The tracking script route
// (/_vercel/insights/*) is added to the deployment by Vercel once Analytics is
// enabled on the project — without this tag no data is ever collected. The Vite
// entry pages (index.html, play.html) carry the same snippet directly; this
// covers the rebranded + hand-written info pages. Idempotent: skips any page
// that already has it.
// Open Graph + Twitter card meta on every generated page (rebranded + overrides).
// og:url always points at THIS domain — even on cross-canonicaled pages, because
// canonical is a signal for Google while og describes the Headwinds link people
// actually paste into Discord/Reddit. Idempotent: skips pages carrying og:title.
const OG_WEBSITE = new Set(['about.html', 'contact.html', 'privacy.html', 'terms.html', 'faq.html', 'rules.html']);
function injectSocialMeta(html, file) {
  if (html.includes('property="og:title"')) return html;
  const t = html.match(/<title>([\s\S]*?)<\/title>/);
  const d = html.match(/<meta name="description" content="([^"]*)"/);
  if (!t || !d || !html.includes('</head>')) return html;
  const title = t[1].trim().replace(/"/g, '&quot;');
  const type = OG_WEBSITE.has(file) ? 'website' : 'article';
  const block = `  <meta property="og:title" content="${title}" />
  <meta property="og:description" content="${d[1]}" />
  <meta property="og:type" content="${type}" />
  <meta property="og:url" content="https://${DOMAIN}/${file}" />
  <meta property="og:image" content="https://${DOMAIN}/og-image.png" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta name="twitter:card" content="summary_large_image" />
`;
  return html.replace('</head>', block + '</head>');
}

const ANALYTICS_SNIPPET = `  <!-- Vercel Web Analytics -->
  <script>
    window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };
  </script>
  <script defer src="/_vercel/insights/script.js"></script>
`;
function injectAnalytics(html) {
  if (html.includes('/_vercel/insights/script.js')) return html;
  if (!html.includes('</head>')) { console.warn('  \u26a0 no </head> found; analytics snippet not injected'); return html; }
  return html.replace('</head>', `${ANALYTICS_SNIPPET}</head>`);
}

// ── build ─────────────────────────────────────────────────────────────────────
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

let copied = 0, branded = 0, patchMisses = 0;
for (const f of readdirSync(SRC)) {
  if (EXCLUDE.has(f) || isJunk(f) || statSync(path.join(SRC, f)).isDirectory()) continue;
  if (f.endsWith('.html')) {
    let html = rebrand(readFileSync(path.join(SRC, f), 'utf8'));
    for (const p of CONTENT_PATCHES) {
      if (p.file !== f) continue;
      if (html.includes(p.find)) {
        html = html.replaceAll(p.find, p.replace);
      } else {
        patchMisses++;
        console.warn(`  ⚠ content patch missed in ${f}: "${p.find.slice(0, 60)}…"\n    (Tailwinds likely rewrote this passage — update CONTENT_PATCHES in tools/headwinds-public.mjs)`);
      }
    }
    if (CROSS_CANONICAL.has(f)) {
      const self = `<link rel="canonical" href="https://${DOMAIN}/${f}" />`;
      if (html.includes(self)) {
        html = html.replace(self, `<link rel="canonical" href="https://www.tailwindsairlinegame.com/${f}" />`);
      } else {
        console.warn(`  \u26a0 cross-canonical missed in ${f}: self-canonical tag not found`);
      }
    }
    writeFileSync(path.join(OUT, f), html);
    branded++;
  } else {
    copyFileSync(path.join(SRC, f), path.join(OUT, f));
    copied++;
  }
}

// Headwinds brand art (overwrites the recolorable shared bits: favicons, icons).
let brandFiles = 0;
if (existsSync(BRAND)) {
  for (const f of readdirSync(BRAND)) {
    if (isJunk(f)) continue;
    copyFileSync(path.join(BRAND, f), path.join(OUT, f));
    brandFiles++;
  }
}

// Hand-written Headwinds pages replace their rebranded counterparts wholesale.
let overrides = 0;
if (existsSync(PAGES)) {
  for (const f of readdirSync(PAGES)) {
    if (isJunk(f)) continue;
    copyFileSync(path.join(PAGES, f), path.join(OUT, f));
    overrides++;
  }
}

// Inject the Rules link across every generated page (rebranded + overlaid).
// Runs after overlays land in OUT so hand-written Headwinds pages get it too.
let linked = 0;
for (const f of readdirSync(OUT)) {
  if (!f.endsWith('.html')) continue;
  const p = path.join(OUT, f);
  const before = readFileSync(p, 'utf8');
  const after = injectSocialMeta(injectAnalytics(injectBrandLogo(injectRulesLink(before))), f);
  if (after !== before) { writeFileSync(p, after); linked++; }
}

// PWA manifest — Headwinds identity, app lives at /play.
writeFileSync(path.join(OUT, 'manifest.webmanifest'), JSON.stringify({
  name: 'Headwinds — Multiplayer Airline Management',
  short_name: 'Headwinds',
  description: 'Build an airline against real people in persistent shared worlds. The multiplayer companion to Tailwinds.',
  start_url: '/play',
  scope: '/',
  display: 'standalone',
  orientation: 'any',
  background_color: '#0b0e13',
  theme_color: '#0b0e13',
  icons: [
    { src: '/pwa-icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/pwa-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/pwa-icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
}, null, 2) + '\n');

// robots.txt + sitemap.xml for this domain.
writeFileSync(path.join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: https://${DOMAIN}/sitemap.xml\n`);
// llms.txt for this domain — a plain-language map of the site for AI crawlers/agents.
writeFileSync(path.join(OUT, 'llms.txt'), `# Headwinds — Multiplayer Airline Management Game

> Headwinds is a free, browser-based multiplayer airline management game. Persistent shared worlds run on a server clock 24/7, and every rival airline is a real player — no AI carriers. Build routes across 1,500+ real airports with 100+ real aircraft, found player-run alliances, and compete to top the final standings. Built on the same engine as the solo game Tailwinds (https://www.tailwindsairlinegame.com).

Headwinds is free to play at https://${DOMAIN}/ — sign in with Google or an email link and join a world.

## Start here

- [How to Play](https://${DOMAIN}/how-to-play.html): joining a world, first aircraft, first routes
- [Fair Play Rules](https://${DOMAIN}/rules.html): multiplayer conduct, multi-accounting, enforcement
- [About](https://${DOMAIN}/about.html): what the game simulates and how it was made

## Guides

- [Strategy Guide](https://${DOMAIN}/strategy.html): competing against real players
- [Route Economics](https://${DOMAIN}/route-economics.html): demand, fares, and contested routes
- [Hub Strategy](https://${DOMAIN}/hub-strategy.html): building connecting banks under competition
- [Competition & Alliances](https://${DOMAIN}/competition-and-alliances.html): rivalry, diplomacy, player alliances
- [Glossary](https://${DOMAIN}/glossary.html): airline and multiplayer terms

## Comparisons

- [Best Multiplayer Airline Management Games in 2026](https://${DOMAIN}/best-airline-management-games.html): honest comparison of Headwinds, AirwaySim, AirlineSim, Airline Manager 4, Airline Mogul, and Tailwinds

## Updates

- [Devlog](https://${DOMAIN}/devlog.html): player-facing changelog
`);
const today = new Date().toISOString().slice(0, 10);
// /play is the JS app shell (sign-in + lobby) — thin, low-value to index, so it
// stays out of the sitemap. It remains reachable via the landing CTA + rewrite.
// Cross-canonicaled pages stay out of the sitemap — a sitemap should only list
// URLs whose canonical is on this domain.
const pages = ['', ...readdirSync(OUT).filter((f) => f.endsWith('.html') && !CROSS_CANONICAL.has(f)).sort()];
const prio = (p) => p === '' ? '1.0' : /^(how-to-play|strategy|devlog|rules|best-)/.test(p) ? '0.8' : '0.6';
writeFileSync(path.join(OUT, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  pages.map((p) => `  <url>\n    <loc>https://${DOMAIN}/${p}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>${prio(p)}</priority>\n  </url>`).join('\n') +
  `\n</urlset>\n`);

console.log(`headwinds-public: ${branded} pages rebranded, ${overrides} overridden, ${copied} assets copied, ${brandFiles} brand files, ${linked} pages Rules-linked${patchMisses ? `, ${patchMisses} content patch(es) MISSED` : ''} → ${path.relative(HW, OUT)}/`);
