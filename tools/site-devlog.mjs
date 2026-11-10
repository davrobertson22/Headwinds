// site-devlog.mjs
// Splits the Headwinds devlog into dated pages at build time.
//
// The SOURCE stays where it always was: apps/headwinds-web/pages/devlog.html, one long page
// you add a <div class="entry"> to the top of. tools/headwinds-public.mjs builds that page
// with the site's nav, footer and tags as usual, then hands it here, and this module turns
// it into:
//
//   devlog.html            the index: every update, by month, headline + first line
//   devlog/YYYY-MM.html    one page per month, entries in full
//   devlog/<slug>.html     a page of its own for any entry of 500+ words (the month page
//                          then carries a summary and a link, so no entry is published in
//                          full at two URLs)
//
// Why: until November 2026 the whole devlog was ONE URL of 35,000 words — a third of the
// site's writing, invisible to a reviewer as anything but a changelog. Dated pages are what
// a living site looks like to Google. The same change was made on Tailwinds.
//
// It also supplies the "Latest updates" block on the landing page (latestBlock).

export const POST_MIN_WORDS = 500;
export const HOME_LATEST = 5;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// ── Text helpers ──────────────────────────────────────────────────────────────

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', hellip: '…', rarr: '→', larr: '←', times: '×', middot: '·', minus: '−', deg: '°', eacute: 'é', frac12: '½', cent: '¢', hearts: '♥' };
const decode = (s) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z0-9]+);/gi, (m, n) => (n in NAMED ? NAMED[n] : m));
// Inline tags vanish (so "<strong>word</strong>:" stays "word:"); block tags become a space.
export const plain = (html) =>
  decode(html.replace(/<\/?(strong|em|a|code|span|b|i)\b[^>]*>/g, '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const wordCount = (html) => (plain(html) ? plain(html).split(' ').length : 0);

function clip(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 30)).replace(/[\s,;:—–-]+$/, '') + '…';
}

function slugify(text) {
  const base = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’‘']/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (base.length <= 60) return base || 'update';
  const cut = base.slice(0, 60);
  return cut.slice(0, cut.lastIndexOf('-') > 30 ? cut.lastIndexOf('-') : 60).replace(/-+$/, '');
}

// ── Parse ─────────────────────────────────────────────────────────────────────

// `mainInner` is everything between <main> and </main> of the devlog page.
// Returns { lede, entries } with entries newest first.
export function parseDevlog(mainInner) {
  const first = mainInner.indexOf('<div class="entry"');
  if (first < 0) throw new Error('devlog: no <div class="entry"> found');
  const lede = (mainInner.slice(0, first).match(/<p class="lede">[\s\S]*?<\/p>/) || [''])[0];
  const chunks = mainInner.slice(first).split(/(?=<div class="entry")/).filter((c) => c.trim());
  const entries = chunks.map((chunk, i) => {
    const where = `devlog entry ${i + 1}`;
    const open = chunk.match(/^<div class="entry"([^>]*)>/);
    if (!open) throw new Error(`${where}: text outside an entry: ${chunk.trim().slice(0, 80)}`);
    const dateM = chunk.match(/<p class="date">([^<]+)<\/p>/);
    const h2M = chunk.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    if (!dateM || !h2M) throw new Error(`${where}: needs a <p class="date"> and an <h2>`);
    const dm = dateM[1].trim().match(/^([A-Z][a-z]+) (\d{1,2}), (\d{4})$/);
    const month = dm ? MONTHS.indexOf(dm[1]) : -1;
    if (month < 0) throw new Error(`${where}: date "${dateM[1]}" is not "Month D, YYYY"`);
    const close = chunk.lastIndexOf('</div>');
    if (close < 0) throw new Error(`${where}: entry is not closed`);
    const bodyHtml = chunk.slice(chunk.indexOf('</h2>') + 5, close).replace(/^\s*\n/, '').trimEnd();
    if (/<div/.test(bodyHtml)) throw new Error(`${where} (${dateM[1]}): a <div> inside an entry is not supported`);
    const attr = (name) => (open[1].match(new RegExp(`data-${name}="([^"]*)"`)) || [])[1];
    const titleHtml = h2M[1].trim();
    const firstBlock = bodyHtml.match(/<(li|p)[^>]*>([\s\S]*?)<\/\1>/);
    return {
      dateText: dateM[1].trim(),
      year: Number(dm[3]),
      month,
      day: Number(dm[2]),
      iso: `${dm[3]}-${String(month + 1).padStart(2, '0')}-${String(dm[2]).padStart(2, '0')}`,
      monthKey: `${dm[3]}-${String(month + 1).padStart(2, '0')}`,
      monthLabel: `${MONTHS[month]} ${dm[3]}`,
      titleHtml,
      title: plain(titleHtml),
      bodyHtml,
      words: wordCount(titleHtml + ' ' + bodyHtml),
      excerpt: clip(firstBlock ? plain(firstBlock[2]) : plain(bodyHtml), 210),
      fixedSlug: attr('slug'),
      postFlag: attr('post'),
    };
  });

  entries.sort((x, y) => (x.iso < y.iso ? 1 : x.iso > y.iso ? -1 : 0));

  // Slugs are handed out oldest first, so adding a new entry never renames an old one.
  const used = new Set();
  for (const e of [...entries].reverse()) {
    let slug = e.fixedSlug || slugify(e.title);
    if (/^\d{4}-\d{2}$/.test(slug)) slug = `update-${slug}`;
    const base = slug;
    let n = 2;
    while (used.has(slug)) slug = `${base}-${n++}`;
    used.add(slug);
    e.slug = slug;
    e.isPost = e.postFlag === 'yes' || (e.postFlag !== 'no' && e.words >= POST_MIN_WORDS);
  }

  // A month too short to stand as a page (under POST_MIN_WORDS in total) shares the next
  // newer month's page. The newest month is never folded: it is still filling up.
  const monthWords = new Map();
  for (const e of entries) monthWords.set(e.monthKey, (monthWords.get(e.monthKey) || 0) + e.words);
  const keys = [...monthWords.keys()].sort();
  const pageOf = new Map();
  for (let i = keys.length - 1; i >= 0; i--) {
    const thin = monthWords.get(keys[i]) < POST_MIN_WORDS && i < keys.length - 1;
    pageOf.set(keys[i], thin ? pageOf.get(keys[i + 1]) : keys[i]);
  }
  for (const e of entries) {
    e.pageKey = pageOf.get(e.monthKey);
    e.url = e.isPost ? `/devlog/${e.slug}.html` : `/devlog/${e.pageKey}.html#${e.slug}`;
  }

  const months = [];
  for (const e of entries) {
    let m = months[months.length - 1];
    if (!m || m.key !== e.pageKey) months.push((m = { key: e.pageKey, entries: [] }));
    m.entries.push(e);
  }
  for (const m of months) {
    const labels = [...new Set(m.entries.map((e) => e.monthLabel))].reverse();
    m.label = labels.length === 1 ? labels[0] : `${labels.slice(0, -1).map((l) => l.split(' ')[0]).join(', ')} and ${labels[labels.length - 1]}`;
    for (const e of m.entries) e.pageLabel = m.label;
  }
  return { lede, entries, months };
}

// ── Page assembly: the built devlog page is the template for all of them ──────

const EXTRA_CSS = `
    /* devlog index, month pages and posts (tools/site-devlog.mjs) */
    h2 a { color:var(--text); text-decoration:none; }
    h2 a:hover { color:var(--teal-light); }
    .crumbs { font-size:0.85rem; color:var(--muted); margin:0 0 20px; }
    .crumbs a { color:var(--muted); }
    .postdate { color:var(--muted); font-size:0.88rem; margin:0 0 32px; }
    .entry { scroll-margin-top:16px; }
    .entry h2 { margin:0 0 12px; }
    .post h2 { margin:32px 0 10px; }
    .month { margin:0 0 40px; }
    .month .count { color:var(--muted); font-size:0.88rem; margin:0 0 14px; }
    ul.idx { list-style:none; padding:0; margin:0; border-top:1px solid var(--line); }
    ul.idx li { margin:0; padding:12px 0; border-bottom:1px solid var(--line); display:grid; grid-template-columns:64px 1fr; gap:2px 14px; }
    ul.idx .d { color:var(--teal-light); font-size:0.82rem; font-weight:600; text-transform:uppercase; letter-spacing:0.04em; padding-top:3px; }
    ul.idx a { font-weight:600; text-decoration:none; }
    ul.idx a:hover { text-decoration:underline; }
    ul.idx .x { grid-column:2; color:var(--muted); font-size:0.92rem; line-height:1.55; }
    .pager { display:flex; flex-wrap:wrap; justify-content:space-between; gap:12px 24px; margin:32px 0 8px; font-size:0.95rem; }
    .pager a { text-decoration:none; }
    @media (max-width:520px) { ul.idx li { grid-template-columns:1fr; } ul.idx .x { grid-column:1; } }
`;

function page(template, { site, file, title, description, date, ogType, jsonLd, main }) {
  const url = `${site}/${file}`;
  let s = template;
  const swap = (re, to, what) => {
    const found = typeof re === 'string' ? s.includes(re) : re.test(s);
    if (!found && what) throw new Error(`site-devlog: the devlog page has no ${what} to rewrite`);
    s = s.replace(re, to);
  };
  swap(/<title>[\s\S]*?<\/title>/, `<title>${esc(title)}</title>`, '<title>');
  swap(/(<meta name="description" content=")[^"]*(")/, `$1${esc(description)}$2`, 'meta description');
  swap(/(<link rel="canonical" href=")[^"]*(")/, `$1${url}$2`, 'canonical link');
  swap(/(<meta property="og:title" content=")[^"]*(")/, `$1${esc(title)}$2`);
  swap(/(<meta property="og:description" content=")[^"]*(")/, `$1${esc(description)}$2`);
  swap(/(<meta property="og:url" content=")[^"]*(")/, `$1${url}$2`);
  if (ogType) swap(/(<meta property="og:type" content=")[^"]*(")/, `$1${ogType}$2`);
  const extra =
    `  <meta name="date" content="${date}" />\n` +
    (jsonLd ? `  <script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>\n` : '') +
    `  <style>${EXTRA_CSS}  </style>\n`;
  swap('</head>', `${extra}</head>`, '</head>');
  swap(/<main>[\s\S]*<\/main>/, () => `<main>\n${main}\n  </main>`, '<main>');
  return s;
}

const shortDate = (e) => `${MONTHS[e.month].slice(0, 3)} ${e.day}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const CTA = `    <a class="cta" href="/play">Join a world →</a>`;

// builtPage: the finished devlog.html (nav, footer, tags all in place). site: "https://www.…".
// Returns { files: Map<path under the public dir, html>, entries, months }.
export function devlogPages(builtPage, site) {
  const mainM = builtPage.match(/<main>([\s\S]*)<\/main>/);
  if (!mainM) throw new Error('site-devlog: the devlog page has no <main>');
  const { lede, entries, months } = parseDevlog(mainM[1]);
  const oldest = entries[entries.length - 1];
  const files = new Map();

  files.set(
    'devlog.html',
    page(builtPage, {
      site,
      file: 'devlog.html',
      title: 'Devlog — Headwinds Multiplayer Airline Game Updates',
      description: "Development log for Headwinds: what's new in the multiplayer airline management game — new features, balance changes, and fixes, update by update.",
      date: entries[0].iso,
      main: `    <h1>Devlog</h1>
    ${lede}
    <p>${plural(entries.length, 'update')} since ${MONTHS[oldest.month]} ${oldest.year}, newest first. Each month has a page of its own with every entry in full.</p>

${months
  .map(
    (m) => `    <section class="month">
      <h2><a href="/devlog/${m.key}.html">${m.label}</a></h2>
      <p class="count">${plural(m.entries.length, 'update')} · <a href="/devlog/${m.key}.html">read the month in full</a></p>
      <ul class="idx">
${m.entries.map((e) => `        <li><span class="d">${shortDate(e)}</span><a href="${e.url}">${e.titleHtml}</a><span class="x">${esc(e.excerpt)}</span></li>`).join('\n')}
      </ul>
    </section>`
  )
  .join('\n\n')}

${CTA}`,
    })
  );

  months.forEach((m, i) => {
    const newer = months[i - 1];
    const older = months[i + 1];
    const cards = m.entries
      .map((e) =>
        e.isPost
          ? `    <div class="entry" id="${e.slug}">
      <p class="date">${e.dateText}</p>
      <h2><a href="${e.url}">${e.titleHtml}</a></h2>
      <p>${esc(e.excerpt)}</p>
      <p><a href="${e.url}">Read the full update →</a></p>
    </div>`
          : `    <div class="entry" id="${e.slug}">
      <p class="date">${e.dateText}</p>
      <h2><a href="#${e.slug}">${e.titleHtml}</a></h2>
${e.bodyHtml}
    </div>`
      )
      .join('\n\n');
    files.set(
      `devlog/${m.key}.html`,
      page(builtPage, {
        site,
        file: `devlog/${m.key}.html`,
        title: `Headwinds Devlog: ${m.label} Updates`,
        description: clip(`Every Headwinds update from ${m.label}, in full: ${m.entries.slice(0, 3).map((e) => e.title).join('; ')}`, 158),
        date: m.entries[0].iso,
        main: `    <p class="crumbs"><a href="/">Home</a> › <a href="/devlog.html">Devlog</a> › ${m.label}</p>
    <h1>Devlog: ${m.label}</h1>
    <p class="lede">${plural(m.entries.length, 'update')} to Headwinds in ${m.label}, newest first. The <a href="/devlog.html">devlog index</a> lists every month.</p>

${cards}

    <p class="pager">
      <span>${older ? `<a href="/devlog/${older.key}.html">← ${older.label}</a>` : ''}</span>
      <span><a href="/devlog.html">All months</a></span>
      <span>${newer ? `<a href="/devlog/${newer.key}.html">${newer.label} →</a>` : ''}</span>
    </p>

${CTA}`,
      })
    );
  });

  entries.forEach((e, at) => {
    if (!e.isPost) return;
    const newer = entries[at - 1];
    const older = entries[at + 1];
    files.set(
      `devlog/${e.slug}.html`,
      page(builtPage, {
        site,
        file: `devlog/${e.slug}.html`,
        title: `${e.title} — Headwinds Devlog`,
        description: clip(e.excerpt, 158),
        date: e.iso,
        ogType: 'article',
        jsonLd: {
          '@context': 'https://schema.org',
          '@type': 'BlogPosting',
          headline: e.title,
          datePublished: e.iso,
          mainEntityOfPage: `${site}/devlog/${e.slug}.html`,
          author: { '@type': 'Organization', name: 'Headwinds', url: site },
          publisher: { '@type': 'Organization', name: 'Headwinds', url: site },
        },
        main: `    <p class="crumbs"><a href="/">Home</a> › <a href="/devlog.html">Devlog</a> › <a href="/devlog/${e.pageKey}.html">${e.pageLabel}</a></p>
    <h1>${e.titleHtml}</h1>
    <p class="postdate">${e.dateText} · By the Headwinds team</p>

    <div class="post">
${e.bodyHtml}
    </div>

    <p class="pager">
      <span>${older ? `<a href="${older.url}">← ${older.titleHtml}</a>` : ''}</span>
      <span>${newer ? `<a href="${newer.url}">${newer.titleHtml} →</a>` : ''}</span>
    </p>
    <p><a href="/devlog/${e.pageKey}.html">More updates from ${e.pageLabel}</a> · <a href="/devlog.html">All updates</a></p>

${CTA}`,
      })
    );
  });

  return { files, entries, months };
}

// ── Landing page block ────────────────────────────────────────────────────────

export const HOME_START = '<!-- DEVLOG-LATEST:START (generated from pages/devlog.html by tools/headwinds-public.mjs; do not edit) -->';
export const HOME_END = '<!-- DEVLOG-LATEST:END -->';

export function latestBlock(entries) {
  return entries
    .slice(0, HOME_LATEST)
    .map(
      (e) => `          <a class="update" href="${e.url}">
            <span class="update-date">${e.dateText}</span>
            <strong>${e.titleHtml}</strong>
            <span class="update-x">${esc(e.excerpt)}</span>
          </a>`
    )
    .join('\n');
}

// Returns the landing page with its Latest updates block brought up to date (the same
// string back when it already is, or when the page has no markers).
export function withLatest(landingHtml, devlogSource) {
  const s = landingHtml.indexOf(HOME_START);
  const t = landingHtml.indexOf(HOME_END);
  if (s < 0 || t < s) return landingHtml;
  const mainM = devlogSource.match(/<main>([\s\S]*)<\/main>/);
  const { entries } = parseDevlog(mainM[1]);
  return `${landingHtml.slice(0, s + HOME_START.length)}\n${latestBlock(entries)}\n          ${landingHtml.slice(t)}`;
}
