// site-page-dates.mjs
// Real "last updated" dates for the Headwinds site: the day a page's own content last
// changed, not the day of the latest build.
//
// Until November 2026 every guide said "Last updated October 29, 2026" and sitemap.xml
// stamped all 26 URLs with the build date on every deploy. A whole site claiming to have
// changed on the same day is what bulk-produced content looks like to Google, and it makes
// <lastmod> useless as a signal. The same fix was made on Tailwinds.
//
// How it works:
//   apps/headwinds-web/page-dates.json   one { updated, hash, blocks } per page, committed
//   tools/headwinds-public.mjs           reads it on every build and prints each page's date
//                                        in its byline, its JSON-LD and the sitemap
//   this file                            keeps the record current
//
//   node tools/site-page-dates.mjs                    re-date pages whose content changed
//   node tools/site-page-dates.mjs --date=2026-11-10  ...using the date given instead of today
//   node tools/site-page-dates.mjs --check            exit 1 if the record is out of date
//   node tools/site-page-dates.mjs --seed-from-git    (one-off) date every page from the last
//                                                     commit that changed its source
//
// Run it after editing anything in apps/headwinds-web/pages/, sections/, index.html or
// play.html, after adding a devlog entry, or after regenerating the aircraft pages.
//
// A date moves only for a SIGNIFICANT change, which is what Google asks <lastmod> to mean.
// A page is cut into blocks (paragraphs, list items, table rows, headings, images, charts)
// and re-dated when MIN_BLOCKS or more are added, removed or reworded since it was last
// dated. Only <main> counts and the byline is ignored, so nav, footer and CSS changes never
// move a date. Small edits accumulate against the dated version until they cross the line.
// Devlog pages only ever change by gaining an entry, so any change dates them.
//
// It works on the BUILT pages (what is served), by building into a temporary directory;
// apps/headwinds-web/public/ is not touched.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const HW = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(HW, 'apps/headwinds-web');
export const MANIFEST = path.join(APP, 'page-dates.json');
export const MIN_BLOCKS = 3;
// The two Vite entry pages are not in the public dir; they are dated from their sources.
export const ENTRY_PAGES = ['index.html', 'play.html'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// ── Fingerprint ───────────────────────────────────────────────────────────────

const sha = (text) => createHash('sha256').update(text).digest('hex');
const isDevlog = (rel) => /^devlog(\.html$|\/)/.test(rel);

function mainBody(html) {
  const main = html.match(/<main[\s\S]*<\/main>/);
  const body = main ? main[0] : (html.match(/<body[\s\S]*<\/body>/) || [html])[0];
  return body.replace(/<p class="byline"[\s\S]*?<\/p>/g, '').replace(/<(script|style|noscript)[\s\S]*?<\/\1>/g, '');
}

export function contentBlocks(html) {
  const marked = mainBody(html)
    .replace(/<svg[\s\S]*?<\/svg>/g, (svg) => `\u0001chart ${sha(svg).slice(0, 12)}\u0001`)
    .replace(/<img[^>]*\ssrc="([^"]*)"[^>]*>/g, (_, src) => `\u0001image ${src}\u0001`)
    .replace(/<\/(p|li|h[1-6]|tr|figcaption|dt|dd|blockquote|summary)>/g, '\u0001');
  return marked
    .split('\u0001')
    .map((piece) => piece.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((text) => sha(text).slice(0, 6));
}

export function blocksTouched(oldBlocks, newBlocks) {
  const a = new Set(oldBlocks);
  const b = new Set(newBlocks);
  let added = 0;
  let removed = 0;
  for (const x of b) if (!a.has(x)) added++;
  for (const x of a) if (!b.has(x)) removed++;
  return Math.max(added, removed);
}

function fingerprint(rel, html, updated) {
  const blocks = contentBlocks(html);
  const entry = { updated, hash: sha(blocks.join(' ')).slice(0, 16) };
  if (!isDevlog(rel)) entry.blocks = blocks.join(' ');
  return entry;
}

// ── Dates on a page ───────────────────────────────────────────────────────────

const BYLINE_RE = /(<p class="byline"[^>]*>[^<]*Last updated )([A-Z][a-z]+ \d{1,2}, \d{4})/;
const MODIFIED_RE = /("dateModified":\s*")(\d{4}-\d{2}-\d{2})/;
export const longDate = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
};
export const todayIso = () => {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
};
// A generated page can state the date of its own content (a devlog post's publication day).
const declaredDate = (html) => (html.match(/<meta name="date" content="(\d{4}-\d{2}-\d{2})"/) || [])[1];

export function readManifest() {
  return existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : {};
}

// The date the build should print for a page: the record's, else the page's own, else today.
export function dateFor(manifest, rel, html) {
  return (manifest[rel] && manifest[rel].updated) || declaredDate(html) || todayIso();
}

// Writes the date into the page's byline and JSON-LD, wherever it has them.
export function applyDate(html, iso) {
  return html.replace(BYLINE_RE, (_, lead) => lead + longDate(iso)).replace(MODIFIED_RE, (_, lead) => lead + iso);
}

// ── The built site ────────────────────────────────────────────────────────────

// Every .html under a built public dir, as paths relative to it.
export function listBuilt(out) {
  const found = [];
  const walk = (dir) => {
    for (const name of readdirSync(path.join(out, dir)).sort()) {
      const rel = dir ? `${dir}/${name}` : name;
      if (statSync(path.join(out, rel)).isDirectory()) {
        if (dir === '' && (name === 'tiles' || name === 'img')) continue; // asset trees
        walk(rel);
      } else if (name.endsWith('.html') && !/^google[0-9a-f]+\.html$/.test(name)) found.push(rel);
    }
  };
  walk('');
  return found;
}

// Builds the public dir into a temporary directory and returns its path.
export function buildToTemp() {
  const out = mkdtempSync(path.join(os.tmpdir(), 'hw-public-'));
  execFileSync(process.execPath, [path.join(HW, 'tools/headwinds-public.mjs'), '--out', out, '--no-tiles'], { stdio: ['ignore', 'ignore', 'inherit'] });
  return out;
}

// { rel: html } for every page of the site: the built public pages plus the two entry pages.
export function sitePages(out) {
  const pages = {};
  for (const rel of ENTRY_PAGES) pages[rel] = readFileSync(path.join(APP, rel), 'utf8');
  for (const rel of listBuilt(out)) pages[rel] = readFileSync(path.join(out, rel), 'utf8');
  return pages;
}

// Compares the site with the record. Returns { manifest, changes } where changes lists
// every page that needs (or, with a date, has just been given) a new entry.
export function compare(pages, before, date) {
  const manifest = {};
  const changes = [];
  for (const [rel, html] of Object.entries(pages)) {
    const known = before[rel];
    const blocks = contentBlocks(html);
    const touched = known && known.blocks !== undefined ? blocksTouched(known.blocks.split(' '), blocks) : null;
    if (known && (known.hash === sha(blocks.join(' ')).slice(0, 16) || (touched !== null && touched < MIN_BLOCKS))) {
      manifest[rel] = known;
    } else {
      manifest[rel] = fingerprint(rel, html, (!known && declaredDate(html)) || date);
      changes.push(`${rel}: ${known ? (touched === null ? 'changed' : `${touched} blocks changed`) : 'new page'} — dated ${manifest[rel].updated}`);
    }
  }
  for (const rel of Object.keys(before)) if (!(rel in pages)) changes.push(`${rel}: in page-dates.json but no longer a page`);
  return { manifest, changes };
}

// ── Seeding from git (one-off) ────────────────────────────────────────────────

const git = (...args) => execFileSync('git', args, { cwd: HW, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

// The day a source file last changed significantly, or null if git does not know it.
function lastSignificantChange(srcRel) {
  let log;
  try {
    log = git('log', '--format=%H %ad', '--date=short', '--', srcRel).trim().split('\n').filter(Boolean);
  } catch {
    return null;
  }
  let head = null;
  let day = null;
  for (const line of log) {
    const [commit, date] = line.split(' ');
    let html;
    try {
      html = git('show', `${commit}:${srcRel}`);
    } catch {
      break;
    }
    const blocks = contentBlocks(html);
    if (head === null) head = blocks;
    if (blocksTouched(blocks, head) >= MIN_BLOCKS) break;
    day = date;
  }
  return day;
}

// Which source files a built page is made from.
function sourcesOf(rel) {
  if (ENTRY_PAGES.includes(rel)) return [`apps/headwinds-web/${rel}`];
  const list = [];
  if (existsSync(path.join(APP, 'pages', rel))) list.push(`apps/headwinds-web/pages/${rel}`);
  else if (existsSync(path.join(HW, 'public', rel))) list.push(`public/${rel}`);
  if (existsSync(path.join(APP, 'sections', rel))) list.push(`apps/headwinds-web/sections/${rel}`);
  return list;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=')[1];
  const out = buildToTemp();
  try {
    const pages = sitePages(out);
    if (process.argv.includes('--seed-from-git')) {
      const manifest = {};
      for (const [rel, html] of Object.entries(pages)) {
        const days = sourcesOf(rel).map(lastSignificantChange).filter(Boolean).sort();
        const day = isDevlog(rel) ? declaredDate(html) : days[days.length - 1];
        manifest[rel] = fingerprint(rel, html, day || todayIso());
        console.log(`${manifest[rel].updated}  ${rel}`);
      }
      writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
    } else {
      const check = process.argv.includes('--check');
      const date = arg('date');
      if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('--date must be YYYY-MM-DD');
      const { manifest, changes } = compare(pages, readManifest(), date || todayIso());
      for (const line of changes) console.log(check ? `stale: ${line}` : line);
      if (!check) writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
      console.log(changes.length ? (check ? `\n${changes.length} out of date — run: node tools/site-page-dates.mjs` : `\n${changes.length} re-dated; the next build prints the new dates`) : 'every page date is current');
      if (check && changes.length) process.exit(1);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}
