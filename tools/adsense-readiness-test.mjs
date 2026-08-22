#!/usr/bin/env node
// Guard for the things that got headwindsairlinegame.com rejected from AdSense
// for "Low value content" on 2026-07-28 and again on 2026-08-22.
//
//   node tools/adsense-readiness-test.mjs
//
// The 2026-08-22 diagnosis, measured by crawling the live site as Googlebot:
// the editorial content was fine (23 pages, ~50,000 words, all HTTP 200), but
//   * NO ad code existed anywhere on the domain — not the loader, not one
//     <ins> unit, nothing in the 807 KB game bundle. Only a bare
//     google-adsense-account meta tag, and only on two pages.
//   * /play — the page the ad account is most associated with, and the only
//     page a player ever actually uses — was a 1,247-byte shell: six words of
//     text and <div id="root">. To a reviewer, the site's main page was blank.
//   * the AdSense property was the apex host, while robots.txt, ads.txt and
//     sitemap.xml only resolve on www.
//
// Each assertion below is one of those failures. Run this before ticking
// "I confirm I have fixed the issues" in AdSense.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HW  = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const APP = path.join(HW, 'apps/headwinds-web');
const OUT = path.join(APP, 'public');

const PUB_ID = 'ca-pub-5123198950074938';
const LOADER = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${PUB_ID}`;
const DOMAIN = 'www.headwindsairlinegame.com';
const PLAY_WORD_FLOOR = 300;

let failures = 0;
const fail = (msg) => { failures++; console.error(`  ✗ ${msg}`); };
const pass = (msg) => console.log(`  ✓ ${msg}`);

// Visible words: kill script/style/noscript wholesale, then all tags. Counting
// without stripping scripts inflates a JS-heavy page by thousands of "words".
function words(html) {
  const stripped = html
    .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ');
  return stripped.split(/\s+/).filter(Boolean).length;
}

console.log('Regenerating apps/headwinds-web/public/ …');
execFileSync(process.execPath, [path.join(HW, 'tools/headwinds-public.mjs')], { stdio: 'inherit' });

const generated = readdirSync(OUT).filter((f) => f.endsWith('.html')).sort();
if (generated.length < 20) fail(`only ${generated.length} generated pages — expected 20+`);

console.log('\n1. Ad code on every generated page');
{
  const noMeta = generated.filter((f) => !readFileSync(path.join(OUT, f), 'utf8').includes(`content="${PUB_ID}"`));
  const noLoader = generated.filter((f) => !readFileSync(path.join(OUT, f), 'utf8').includes(LOADER));
  if (noMeta.length) fail(`${noMeta.length}/${generated.length} generated pages missing the google-adsense-account meta: ${noMeta.slice(0, 5).join(', ')}${noMeta.length > 5 ? ', …' : ''}`);
  else pass(`all ${generated.length} generated pages carry the google-adsense-account meta`);
  if (noLoader.length) fail(`${noLoader.length}/${generated.length} generated pages missing the adsbygoogle.js loader: ${noLoader.slice(0, 5).join(', ')}${noLoader.length > 5 ? ', …' : ''}`);
  else pass(`all ${generated.length} generated pages load adsbygoogle.js`);
}

console.log('\n2. Ad code on the Vite entry pages');
for (const f of ['index.html', 'play.html']) {
  const html = readFileSync(path.join(APP, f), 'utf8');
  if (!html.includes(`content="${PUB_ID}"`)) fail(`${f}: no google-adsense-account meta`);
  else if (!html.includes(LOADER)) fail(`${f}: has the meta tag but never loads adsbygoogle.js — the meta alone serves no ads`);
  else pass(`${f}: meta + loader`);
}

console.log('\n3. /play is not an empty shell');
{
  const html = readFileSync(path.join(APP, 'play.html'), 'utf8');
  const w = words(html);
  if (w < PLAY_WORD_FLOOR) fail(`play.html has ${w} visible words (floor ${PLAY_WORD_FLOOR}) — this is the "site's main page is blank" rejection`);
  else pass(`play.html has ${w} visible words`);

  const navTargets = ['/how-to-play.html', '/strategy.html', '/rules.html', '/faq.html', '/about.html'];
  const missing = navTargets.filter((t) => !html.includes(`href="${t}"`));
  if (missing.length) fail(`play.html does not link to ${missing.join(', ')} — the lobby is a dead end for a crawler`);
  else pass('play.html links into the content site');

  if (!html.includes('id="root"')) fail('play.html lost its #root mount point — the app will not boot');
  else pass('play.html still mounts the app at #root');
}

console.log('\n4. Hosts agree (apex vs www)');
{
  const sitemap = readFileSync(path.join(OUT, 'sitemap.xml'), 'utf8');
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const offHost = locs.filter((u) => !u.startsWith(`https://${DOMAIN}/`));
  if (!locs.length) fail('sitemap.xml has no <loc> entries');
  else if (offHost.length) fail(`${offHost.length} sitemap URLs are not on ${DOMAIN}: ${offHost.slice(0, 3).join(', ')}`);
  else pass(`all ${locs.length} sitemap URLs are on ${DOMAIN}`);

  if (!locs.includes(`https://${DOMAIN}/play`)) fail('/play is missing from sitemap.xml — it has real content now, so it should be indexable');
  else pass('/play is listed in sitemap.xml');

  const robots = readFileSync(path.join(OUT, 'robots.txt'), 'utf8');
  if (!robots.includes(`https://${DOMAIN}/sitemap.xml`)) fail('robots.txt does not point at the www sitemap');
  else pass('robots.txt points at the www sitemap');

  const vercel = JSON.parse(readFileSync(path.join(APP, 'vercel.json'), 'utf8'));
  const apexRedirect = (vercel.redirects || []).some((r) => (r.has || []).some((h) => h.type === 'host' && h.value === 'headwindsairlinegame.com') && String(r.destination).includes(DOMAIN));
  if (!apexRedirect) fail('vercel.json no longer redirects the apex host to www — AdSense and Search Console would see two sites');
  else pass('vercel.json redirects apex → www');
}

console.log('\n5. No page is cross-canonicaled off this domain');
{
  const strays = generated.filter((f) => /rel="canonical"[^>]*tailwindsairlinegame\.com/.test(readFileSync(path.join(OUT, f), 'utf8')));
  if (strays.length) fail(`${strays.length} pages canonical to tailwindsairlinegame.com: ${strays.join(', ')} — this is exactly what caused the 2026-07-28 rejection`);
  else pass('every generated page canonicals to itself on this domain');
}

console.log('\n6. ads.txt is present and correct');
{
  const p = path.join(OUT, 'ads.txt');
  if (!existsSync(p)) fail('ads.txt missing from the generated public/');
  else {
    const txt = readFileSync(p, 'utf8');
    if (!txt.includes(`google.com, pub-${PUB_ID.replace('ca-pub-', '')}, DIRECT`)) fail('ads.txt does not carry the DIRECT line for this publisher');
    else pass('ads.txt carries the DIRECT publisher line');
  }
}

console.log(failures ? `\nFAIL — ${failures} problem(s)` : '\nADSENSE READINESS OK');
process.exit(failures ? 1 : 0);
