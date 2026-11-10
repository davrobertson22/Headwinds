#!/usr/bin/env node
// site-pages-test.mjs
// Guards the Headwinds site that Google and AdSense review: the landing page, the built
// public pages, the devlog pages and the sitemap. Companion to adsense-readiness-test.mjs,
// which covers ad code and /play.
//
// Each check is a failure measured on the live site on 2026-11-10, after AdSense turned
// both this site and Tailwinds down for "low value content" again:
//   * the landing page linked to 13 of 23 pages; four guides were in no footer either
//   * the devlog was one URL of 35,000 words
//   * every guide said "Last updated October 29, 2026" and the sitemap stamped all 26 URLs
//     with the build date on every deploy
//   * the six aircraft pages had no chart or image
//
//   node tools/site-pages-test.mjs
//   node tools/site-pages-test.mjs --root <checkout> --built <its public dir>
//       check another checkout that is already built (used to prove these checks fail on
//       the commit before the fix)
//
// It builds into a temporary directory (headwinds-public.mjs --out), so it does not touch
// apps/headwinds-web/public/ and can run beside any other suite.

import assert from 'node:assert/strict';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { devlogPages, withLatest, POST_MIN_WORDS, HOME_LATEST } from './site-devlog.mjs';
import { buildToTemp, listBuilt, compare, contentBlocks, longDate, ENTRY_PAGES } from './site-page-dates.mjs';

const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? path.resolve(process.argv[i + 1]) : null;
};
const HW = argOf('--root') || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(HW, 'apps/headwinds-web');
const prebuilt = argOf('--built');
const OUT = prebuilt || buildToTemp();
const DOMAIN = 'www.headwindsairlinegame.com';
const SITE = `https://${DOMAIN}`;

const readOut = (rel) => readFileSync(path.join(OUT, rel), 'utf8');
const built = listBuilt(OUT);
const topLevel = built.filter((rel) => !rel.includes('/'));
const landing = readFileSync(path.join(APP, 'index.html'), 'utf8');
const manifestPath = path.join(APP, 'page-dates.json');
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
const mainText = (h) => {
  const m = h.match(/<main[\s\S]*<\/main>/);
  return (m ? m[0] : h).replace(/<(script|style|svg)[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
};
const words = (h) => mainText(h).split(' ').length;

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}\n      ${String(err.message).split('\n').slice(0, 12).join('\n      ')}`);
  }
}

try {
  console.log('\n1. The landing page is the front door');
  test('it links to every page of the site', () => {
    const missing = topLevel.filter((f) => !landing.includes(`href="/${f}"`));
    assert.deepEqual(missing, [], 'add a card to the Guides section of apps/headwinds-web/index.html');
  });
  test('it links to the live worlds page and the game', () => {
    assert.ok(landing.includes('href="/worlds"') && landing.includes('href="/play"'));
  });
  test(`it shows the ${HOME_LATEST} latest devlog entries, and they are current`, () => {
    assert.equal((landing.match(/class="update"/g) || []).length, HOME_LATEST, 'the Latest updates block is missing: run node tools/headwinds-public.mjs');
    const source = readFileSync(path.join(APP, 'pages/devlog.html'), 'utf8');
    assert.equal(withLatest(landing, source), landing, 'the Latest updates block is stale: run node tools/headwinds-public.mjs and commit index.html');
  });

  console.log('\n2. Every guide is linked from every page');
  test('each footer carries all nine guides', () => {
    const guides = ['how-to-play', 'strategy', 'hub-strategy', 'route-economics', 'fleet-planning', 'competition-and-alliances', 'aircraft', 'glossary', 'faq'];
    const short = [];
    for (const rel of built) {
      const footer = (readOut(rel).match(/<footer class="site">[\s\S]*?<\/footer>/) || [''])[0];
      const lacks = guides.filter((g) => !footer.includes(`href="/${g}.html"`));
      if (lacks.length) short.push(`${rel}: ${lacks.join(', ')}`);
    }
    assert.deepEqual(short, []);
  });

  console.log('\n3. The devlog is dated pages, not one URL');
  const source = readFileSync(path.join(APP, 'pages/devlog.html'), 'utf8');
  const expected = devlogPages(source, SITE);
  test('month pages and standalone posts are built', () => {
    const missing = [...expected.files.keys()].filter((rel) => !existsSync(path.join(OUT, rel)));
    assert.deepEqual(missing, []);
    assert.ok(expected.months.length >= 4 && expected.entries.some((e) => e.isPost));
  });
  test('devlog.html is an index: every entry by headline, none in full', () => {
    const index = readOut('devlog.html');
    assert.ok(words(index) < 12000, `devlog.html still has ${words(index)} words`);
    for (const e of expected.entries) assert.ok(index.includes(`href="${e.url}"`), `no link to "${e.title}"`);
  });
  test('no entry is published in full at two URLs', () => {
    for (const e of expected.entries.filter((x) => x.isPost)) {
      const probe = mainText(`<main>${e.bodyHtml}</main>`).slice(200, 420);
      assert.ok(probe.length > 100 && !mainText(readOut(`devlog/${e.pageKey}.html`)).includes(probe), `${e.title}: in full on its month page too`);
    }
  });
  test('every entry has one home with a working anchor, and slugs are unique', () => {
    const slugs = expected.entries.map((e) => e.slug);
    assert.equal(new Set(slugs).size, slugs.length);
    for (const e of expected.entries) {
      const [file, anchor] = e.url.slice(1).split('#');
      assert.ok(existsSync(path.join(OUT, file)), `${e.title}: ${file} was not built`);
      if (anchor) assert.ok(readOut(file).includes(`id="${anchor}"`), `${e.title}: #${anchor} missing from ${file}`);
    }
  });
  test(`every devlog page has ${POST_MIN_WORDS}+ words (the month still filling up excepted)`, () => {
    const newest = `devlog/${expected.months[0].key}.html`;
    for (const rel of built.filter((r) => r.startsWith('devlog/') && r !== newest)) {
      assert.ok(words(readOut(rel)) >= POST_MIN_WORDS, `${rel}: ${words(readOut(rel))} words`);
    }
  });
  test('devlog pages keep the site nav, footer, ad code and their own canonical', () => {
    for (const rel of built.filter((r) => r.startsWith('devlog/'))) {
      const h = readOut(rel);
      assert.ok(h.includes('<nav class="site">') && h.includes('<footer class="site">'), `${rel}: lost its nav or footer`);
      assert.ok(h.includes('adsbygoogle.js?client='), `${rel}: no ad loader`);
      assert.ok(h.includes(`<link rel="canonical" href="${SITE}/${rel}"`), `${rel}: wrong canonical`);
    }
  });

  console.log('\n4. Dates are real');
  const pages = Object.fromEntries([...ENTRY_PAGES.map((rel) => [rel, readFileSync(path.join(APP, rel), 'utf8')]), ...built.map((rel) => [rel, readOut(rel)])]);
  test('apps/headwinds-web/page-dates.json is current', () => {
    assert.ok(Object.keys(manifest).length, 'page-dates.json is missing');
    assert.deepEqual(compare(pages, manifest, 'today').changes, [], 'run: node tools/site-page-dates.mjs');
  });
  test('each byline prints the page\'s own date', () => {
    for (const rel of built) {
      const m = readOut(rel).match(/Last updated ([A-Z][a-z]+ \d{1,2}, \d{4})/);
      if (m && manifest[rel]) assert.equal(m[1], longDate(manifest[rel].updated), rel);
    }
  });
  const sitemap = readOut('sitemap.xml');
  const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>\s*<lastmod>([^<]+)<\/lastmod>/g)].map((m) => [m[1], m[2]]);
  test('the sitemap lists every page once, devlog pages included', () => {
    const want = ['', 'play', 'worlds', ...built].map((p) => `${SITE}/${p}`).sort();
    assert.deepEqual(urls.map((u) => u[0]).sort(), want);
  });
  test('the sitemap gives each page its own lastmod, not the build date', () => {
    for (const [loc, day] of urls) {
      const rel = loc.slice(SITE.length + 1);
      if (manifest[rel]) assert.equal(day, manifest[rel].updated, loc);
    }
    const days = new Set(urls.map((u) => u[1]));
    assert.ok(days.size >= 8, `only ${days.size} distinct dates across ${urls.length} URLs`);
  });

  console.log('\n5. Aircraft pages');
  test('each class page carries two charts drawn from the game data', () => {
    for (const rel of topLevel.filter((f) => /^aircraft-.+\.html$/.test(f))) {
      assert.equal((readOut(rel).match(/<svg class="chart"/g) || []).length, 2, rel);
    }
  });
  test('the committed aircraft pages match the generator', () => {
    const r = spawnSync(process.execPath, ['tools/generate-aircraft-pages.mjs', '--check'], { cwd: HW, encoding: 'utf8' });
    assert.equal(r.status, 0, `run: node tools/generate-aircraft-pages.mjs\n${r.stdout}${r.stderr}`.trim());
  });
  test('the multiplayer section still sits ahead of the stats table', () => {
    for (const rel of topLevel.filter((f) => /^aircraft-.+\.html$/.test(f))) {
      const h = readOut(rel);
      assert.ok(h.indexOf('<div class="tablewrap">') < h.indexOf('<figure class="chart">'), `${rel}: a chart moved above the table, which is the anchor sections are injected at`);
    }
  });

  console.log('\n6. Every page stands on its own');
  test('unique titles, a description, and a canonical on this domain', () => {
    const titles = new Map();
    for (const rel of built) {
      const h = readOut(rel);
      const title = (h.match(/<title>([^<]+)<\/title>/) || [])[1];
      assert.ok(title, `${rel}: no <title>`);
      assert.ok(!titles.has(title), `${rel} and ${titles.get(title)} share the title "${title}"`);
      titles.set(title, rel);
      assert.ok(/<meta name="description" content="[^"]{50,}"/.test(h), `${rel}: missing or very short description`);
      assert.ok(h.includes(`<link rel="canonical" href="${SITE}/${rel}"`), `${rel}: canonical is not its own address`);
    }
  });
  test('every internal link and image points at something that exists', () => {
    const routes = new Set(['/', '/play', '/worlds']);
    const broken = [];
    const check = (from, html) => {
      for (const m of html.matchAll(/(?:href|src)="(\/[^"]*)"/g)) {
        const [target, anchor] = m[1].split('#');
        const file = target.split('?')[0];
        if (routes.has(file) || /^\/(src|assets|api|_vercel|worlds\/)/.test(file)) continue;
        const onDisk = path.join(OUT, file);
        if (!existsSync(onDisk)) broken.push(`${from} → ${m[1]}`);
        else if (anchor && file.endsWith('.html') && !readFileSync(onDisk, 'utf8').includes(`id="${anchor}"`)) broken.push(`${from} → ${m[1]} (no such anchor)`);
      }
    };
    check('index.html', landing);
    for (const rel of built) check(rel, readOut(rel));
    assert.deepEqual(broken, []);
  });
  test('the page-date fingerprint ignores the byline', () => {
    const page = readOut('how-to-play.html');
    assert.deepEqual(contentBlocks(page.replace(/Last updated [A-Z][a-z]+ \d{1,2}, \d{4}/, 'Last updated January 1, 2030')), contentBlocks(page));
  });
} finally {
  if (!prebuilt) rmSync(OUT, { recursive: true, force: true });
}

console.log(`\n${failed ? 'FAIL' : 'PASS'} — ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
