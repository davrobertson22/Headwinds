// generate-aircraft-pages.mjs
// Generates the static aircraft guide pages in public/ from src/data/aircraft.js.
// Run from the project root:  node tools/generate-aircraft-pages.mjs
// Re-run whenever aircraft data changes, then rebuild (vite copies public/ into dist/).

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { AIRCRAFT_TYPES } from '../src/data/aircraft.js';
import { fuelCostPerKm } from '../src/utils/fuel.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public');
const SITE = 'https://www.tailwindsairlinegame.com';

// ── Category → page config ───────────────────────────────────────────────────

const PAGES = [
  {
    file: 'aircraft-narrow-body.html',
    title: 'Narrow-Body Aircraft Guide — Tailwinds Airline Management Game',
    h1: 'Narrow-Body Aircraft Guide',
    categories: ['Narrow Body'],
    description:
      'Every narrow-body jet in Tailwinds compared: seats, range, lease cost, fuel burn, and per-seat economics. Find the right single-aisle workhorse for your airline.',
    intro: `
      <p>Narrow-body jets are the backbone of almost every successful Tailwinds airline. They cover the busiest segment of the route map — short and medium-haul city pairs with strong, repeatable demand — and they do it with economics that widebodies simply cannot match on those stage lengths. If your airline only ever mastered one aircraft category, it should be this one.</p>
      <p>The core trade-off inside the category is capacity versus cost. Smaller types like the A318 or 737-700 are cheap to lease and easy to fill, which makes them forgiving while you learn a market. Larger types like the A321neo or 737 MAX 10 carry far more passengers for only modestly higher trip cost — brilliant on proven routes, punishing on speculative ones. The table and per-type notes below use each aircraft's actual in-game numbers, including fuel cost per seat-kilometre, the single best measure of how cheaply a jet moves one passenger one kilometre.</p>
      <h2>How to choose</h2>
      <p>Match seats to demand first, then range to mission, and only then look at price. A jet that is 30% too big for its route flies half-empty and loses money regardless of how efficient it is on paper. New-generation types (neo, MAX, A220, E2) burn noticeably less fuel per seat than the classics they replaced, but lease for more — they reward busy networks that keep them in the air. Older classics are the value play for cash-strapped early airlines: higher burn, far lower weekly lease.</p>`,
  },
  {
    file: 'aircraft-wide-body.html',
    title: 'Wide-Body Aircraft Guide — Tailwinds Airline Management Game',
    h1: 'Wide-Body Aircraft Guide',
    categories: ['Wide Body'],
    description:
      'All wide-body jets in Tailwinds compared: seats, range, lease cost, fuel burn, and per-seat economics. Pick the right twin-aisle for long-haul expansion.',
    intro: `
      <p>Widebodies are how a Tailwinds airline goes intercontinental — and how plenty of them go bankrupt. A twin-aisle jet carries two to three times the passengers of a narrow-body, costs several times as much to lease, and burns fuel accordingly. On a dense long-haul trunk route it prints money; on a thin route it is the fastest way to destroy a healthy balance sheet.</p>
      <p>Fill rate is everything at this scale. A 300-seat jet at 85% load is a triumph; the same jet at 45% is a weekly six-figure loss. Before leasing any aircraft on this page, be confident the city pair can actually fill it — big populations at both ends, ideally with hub feed behind one of them.</p>
      <h2>How to choose</h2>
      <p>Modern twins (787, A350, 777) dominate the efficiency table and should be your default for new long-haul flying. Older types — A340s, early 777s, the 767 family — lease for dramatically less and remain sensible on routes you have already proven, or as a bridge while you build cash. Watch range carefully: ultra-long-range variants carry a lease premium you only earn back on routes that actually need it.</p>`,
  },
  {
    file: 'aircraft-regional-jets.html',
    title: 'Regional Jet Guide — Tailwinds Airline Management Game',
    h1: 'Regional Jet Guide',
    categories: ['Regional Jet'],
    description:
      'Every regional jet in Tailwinds compared: seats, range, lease cost, fuel burn, and per-seat economics. Build profitable thin routes and hub feed.',
    intro: `
      <p>Regional jets solve a specific problem: routes with real demand, but not enough of it to fill a 150-seat narrow-body. In Tailwinds that describes a huge share of the map — secondary cities, short cross-border hops, and above all <em>hub feed</em>, the short flights that funnel connecting passengers into your hub for onward long-haul travel.</p>
      <p>Per-seat costs run higher than larger jets; that is the price of right-sizing. A regional jet is not competing with an A320 on cost per seat — it is competing with the empty seats the A320 would fly on a thin route. Judged that way, the category is one of the most reliably profitable in the game.</p>
      <h2>How to choose</h2>
      <p>The E-Jet and CRJ families cover the 70–130 seat band; the E2 generation offers materially better burn for a higher lease. At the small end, 50-seaters only make sense on very thin or very short missions where nothing bigger could break even. As always: pick the seat count the route can fill, not the one with the prettiest efficiency number.</p>`,
  },
  {
    file: 'aircraft-turboprops.html',
    title: 'Turboprop Aircraft Guide — Tailwinds Airline Management Game',
    h1: 'Turboprop Aircraft Guide',
    categories: ['Turboprop'],
    description:
      'All turboprops in Tailwinds compared: seats, range, lease cost, fuel burn, and per-seat economics. The cheapest way to fly short, thin routes.',
    intro: `
      <p>Turboprops are the most misunderstood aircraft in Tailwinds. New players skip them because they look slow and small; experienced players quietly build entire profitable sub-networks on them. Below roughly 800 kilometres, nothing else in the game touches their trip costs — the fuel table below makes the point better than any argument.</p>
      <p>Their weekly leases are the lowest in the game, which also makes them the lowest-risk way to experiment. A failed turboprop route costs you pocket change; a failed widebody route can cost you the company.</p>
      <h2>How to choose</h2>
      <p>The ATR 72 and Q400 are the modern workhorses — the ATR cheaper to run, the Q400 faster and better over longer regional sectors. Smaller 19–40 seat types unlock genuinely tiny markets (island hops, mountain fields, remote communities) that no jet can serve economically. Range is rarely the constraint; matching seats to a thin market is the whole art.</p>`,
  },
  {
    file: 'aircraft-freighters.html',
    title: 'Freighter Aircraft Guide — Tailwinds Airline Management Game',
    h1: 'Freighter Aircraft Guide',
    categories: ['Freighter'],
    description:
      'Every cargo aircraft in Tailwinds compared: payload, range, lease cost and fuel burn. Build a profitable cargo network alongside your passenger airline.',
    intro: `
      <p>Cargo is a different business with different rules. Freighters fly payload, not passengers: no catering, no loyalty points, no reputation dance — just tonnes, lanes, and yield. A well-built cargo network is steady, high-margin income that keeps earning even when passenger demand wobbles.</p>
      <p>Because these aircraft carry no seats, the comparison metric changes: what matters is payload tonnes against trip cost over the lanes you actually fly. Small feeders move parcels into your hub; big intercontinental freighters move serious tonnage between major economies.</p>
      <h2>How to choose</h2>
      <p>Start small. A regional freighter on a short, proven lane teaches you cargo pricing at minimal risk. Converted passenger jets (BCF/P2F types) are the mid-market value play — cheap to lease, decent payload. Purpose-built giants like the 747F only pay off on dense long-haul trade lanes with tonnage to fill them, but when they work, nothing else comes close.</p>`,
  },
  {
    file: 'aircraft-flagships.html',
    title: 'Flagship Aircraft: Double-Deckers & Concorde — Tailwinds Guide',
    h1: 'Flagships: Double-Deckers & Supersonic',
    categories: ['Double Deck', 'Supersonic'],
    description:
      'The A380, 747 family and Concorde in Tailwinds: seats, range, lease cost and economics of the game’s biggest and fastest aircraft — and when they actually pay.',
    intro: `
      <p>These are the trophy aircraft of Tailwinds — the double-deck giants and the supersonic Concorde. Every player wants to fly them. Most players lose money the first time they try. This page is about flying them profitably.</p>
      <p>Double-deckers live or die on one question: can the route fill 400–550 seats week after week? That only happens on the world's great trunk routes, usually between mega-hubs with strong feed on both ends. When it works, per-seat costs are excellent. When it doesn't, the weekly lease alone erases the profit of half your network.</p>
      <p>Concorde is its own economy. Its fuel burn is extraordinary, but supersonic prestige commands a large ticket premium in-game, and on the right premium transatlantic-style pairing it can work as a halo aircraft — brand first, margin second.</p>
      <h2>How to choose</h2>
      <p>Honestly? Wait. Flagships belong in a mature network with established mega-hubs, deep cash reserves, and proven trunk routes bursting past the capacity of your largest twins. Then, and only then, they are glorious.</p>`,
  },
];

// ── Formatting helpers ────────────────────────────────────────────────────────

const fmtMoney = (n) =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M` : `$${Math.round(n / 1000)}K`;
const fmtInt = (n) => n.toLocaleString('en-US');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── Shared page chrome (matches how-to-play.html styling) ────────────────────

const NAV = `
  <header class="site">
    <nav class="site">
      <a class="brand" href="/">Tailwinds</a>
      <a class="link" href="/how-to-play.html">How to Play</a>
      <a class="link" href="/strategy.html">Strategy</a>
      <a class="link" href="/aircraft.html">Aircraft</a>
      <a class="link" href="/glossary.html">Glossary</a>
      <a class="link" href="/faq.html">FAQ</a>
      <a class="link" href="/">Play</a>
    </nav>
  </header>`;

const FOOTER = `
  <footer class="site">
    <div class="footwrap">
      <a href="/">Home</a>
      <a href="/how-to-play.html">How to Play</a>
      <a href="/strategy.html">Strategy</a>
      <a href="/aircraft.html">Aircraft</a>
      <a href="/glossary.html">Glossary</a>
      <a href="/faq.html">FAQ</a>
      <a href="/devlog.html">Devlog</a>
      <a href="/about.html">About</a>
      <a href="/contact.html">Contact</a>
      <a href="/privacy.html">Privacy</a>
      <a href="/terms.html">Terms</a>
      <span style="margin-left:auto;">© Tailwinds — free to play in your browser.</span>
    </div>
  </footer>`;

const CSS = `
    :root { --bg:#1b1b1f; --panel:#26262d; --line:#3a3b40; --text:#ededee; --muted:#a1a1aa; --gold:#c79a4b; --gold-light:#d3ad63; }
    * { box-sizing: border-box; }
    body { font-family:'IBM Plex Sans',system-ui,-apple-system,sans-serif; background:var(--bg); color:var(--text); margin:0; line-height:1.7; }
    a { color:var(--gold-light); }
    header.site { border-bottom:1px solid var(--line); }
    nav.site { max-width:880px; margin:0 auto; padding:18px 24px; display:flex; flex-wrap:wrap; gap:20px; align-items:center; }
    nav.site .brand { font-family:'Space Grotesk',sans-serif; font-weight:700; font-size:1.15rem; color:var(--text); text-decoration:none; margin-right:auto; }
    nav.site a.link { color:var(--muted); text-decoration:none; font-size:0.95rem; font-weight:500; }
    nav.site a.link:hover { color:var(--gold-light); }
    main { max-width:860px; margin:0 auto; padding:48px 24px 72px; }
    h1 { font-family:'Space Grotesk',sans-serif; font-size:2.1rem; line-height:1.2; margin:0 0 8px; }
    .lede { color:var(--muted); font-size:1.1rem; margin:0 0 36px; }
    h2 { font-family:'Space Grotesk',sans-serif; font-size:1.45rem; margin:40px 0 12px; }
    h3 { font-size:1.15rem; margin:0 0 6px; font-family:'Space Grotesk',sans-serif; }
    p { margin:0 0 16px; }
    .cta { display:inline-block; background:var(--gold); color:#20180a; font-weight:700; padding:13px 30px; border-radius:8px; text-decoration:none; margin:18px 0; }
    table.stats { width:100%; border-collapse:collapse; font-size:0.88rem; margin:0 0 28px; }
    table.stats th, table.stats td { padding:8px 10px; border-bottom:1px solid var(--line); text-align:right; white-space:nowrap; }
    table.stats th:first-child, table.stats td:first-child { text-align:left; white-space:normal; }
    table.stats th { color:var(--muted); font-weight:600; position:sticky; top:0; background:var(--bg); }
    .tablewrap { overflow-x:auto; margin:0 0 28px; }
    .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:20px 24px; margin:0 0 18px; }
    .card .meta { color:var(--muted); font-size:0.85rem; margin:0 0 10px; }
    .card img { width:100%; max-width:480px; border-radius:8px; display:block; margin:10px 0 12px; }
    .card .specs { display:flex; flex-wrap:wrap; gap:8px 22px; font-size:0.88rem; color:var(--muted); margin:0 0 10px; }
    .card .specs b { color:var(--text); font-weight:600; }
    .note { border-left:3px solid var(--gold); padding:4px 0 4px 16px; color:var(--muted); margin:10px 0 0; font-size:0.92rem; }
    .crumbs { font-size:0.85rem; color:var(--muted); margin:0 0 20px; }
    .crumbs a { color:var(--muted); }`;

function pageShell({ title, description, canonical, h1, lede, body }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}" />
  <link rel="canonical" href="${canonical}" />
  <link rel="icon" type="image/png" href="/favicon.png" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet" />
  <style>${CSS}
  </style>
</head>
<body>
${NAV}

  <main>
    <p class="crumbs"><a href="/">Home</a> › <a href="/aircraft.html">Aircraft</a>${h1 === 'Aircraft in Tailwinds' ? '' : ` › ${esc(h1)}`}</p>
    <h1>${esc(h1)}</h1>
    <p class="lede">${lede}</p>
${body}
    <a class="cta" href="/">Play Tailwinds — It's Free →</a>
  </main>
${FOOTER}
</body>
</html>
`;
}

// ── Derived economics ─────────────────────────────────────────────────────────

function enrich(t) {
  const fuelKm = fuelCostPerKm(t); // $/km at base price
  return {
    ...t,
    fuelKm,
    fuelSeatKm: t.seats > 0 ? (fuelKm / t.seats) * 100 : null, // ¢ per seat-km
    fuelTonneKm: t.payloadTonnes ? (fuelKm / t.payloadTonnes) * 100 : null, // ¢ per tonne-km
    leasePerSeat: t.seats > 0 ? t.weeklyLease / t.seats : null,
  };
}

function rankNote(t, group) {
  if (t.seats > 0) {
    const sorted = [...group].filter((x) => x.seats > 0).sort((a, b) => a.fuelSeatKm - b.fuelSeatKm);
    const rank = sorted.findIndex((x) => x.id === t.id) + 1;
    const n = sorted.length;
    const third = rank <= n / 3 ? 'among the most fuel-efficient per seat' : rank > (2 * n) / 3 ? 'toward the thirstier end per seat' : 'mid-pack on per-seat fuel efficiency';
    return `Fuel efficiency: <b>#${rank} of ${n}</b> in its class (${t.fuelSeatKm.toFixed(2)}¢ per seat-km at base fuel price) — ${third}. Weekly lease works out to <b>$${Math.round(t.leasePerSeat).toLocaleString()}</b> per seat.`;
  }
  if (t.payloadTonnes) {
    const sorted = [...group].filter((x) => x.payloadTonnes).sort((a, b) => a.fuelTonneKm - b.fuelTonneKm);
    const rank = sorted.findIndex((x) => x.id === t.id) + 1;
    return `Cargo efficiency: <b>#${rank} of ${sorted.length}</b> freighters (${t.fuelTonneKm.toFixed(1)}¢ per tonne-km at base fuel price). Weekly lease per payload tonne: <b>$${Math.round(t.weeklyLease / t.payloadTonnes).toLocaleString()}</b>.`;
  }
  return '';
}

function statsTable(group, isFreight) {
  const rows = group
    .map(
      (t) => `      <tr>
        <td><a href="#${t.id}">${esc(t.name)}</a></td>
        <td>${isFreight ? `${t.payloadTonnes} t` : fmtInt(t.seats)}</td>
        <td>${fmtInt(t.range)} km</td>
        <td>${fmtMoney(t.weeklyLease)}</td>
        <td>${fmtMoney(t.purchasePrice)}</td>
        <td>${t.fuelBurnPer100km.toFixed(0)} L</td>
        <td>${isFreight ? (t.fuelTonneKm ? t.fuelTonneKm.toFixed(1) + '¢' : '—') : t.fuelSeatKm ? t.fuelSeatKm.toFixed(2) + '¢' : '—'}</td>
      </tr>`
    )
    .join('\n');
  return `    <div class="tablewrap"><table class="stats">
      <thead><tr><th>Aircraft</th><th>${isFreight ? 'Payload' : 'Seats'}</th><th>Range</th><th>Lease/wk</th><th>Price</th><th>Fuel/100km</th><th>Fuel/${isFreight ? 'tonne' : 'seat'}-km</th></tr></thead>
      <tbody>
${rows}
      </tbody>
    </table></div>`;
}

function aircraftCard(t, group, isFreight) {
  const specs = [
    isFreight ? `<span>Payload <b>${t.payloadTonnes} tonnes</b></span>` : `<span>Seats <b>${fmtInt(t.seats)}</b></span>`,
    `<span>Range <b>${fmtInt(t.range)} km</b></span>`,
    `<span>Lease <b>${fmtMoney(t.weeklyLease)}/wk</b></span>`,
    `<span>Buy <b>${fmtMoney(t.purchasePrice)}</b></span>`,
    `<span>Fuel <b>${t.fuelBurnPer100km.toFixed(0)} L/100km</b> (≈ $${t.fuelKm.toFixed(2)}/km)</span>`,
    `<span>Maintenance <b>${fmtMoney(t.baseMaintenancePerWk)}/wk</b></span>`,
  ].join('\n        ');
  return `    <div class="card" id="${t.id}">
      <h3>${esc(t.name)}</h3>
      <p class="meta">${esc(t.manufacturer)} · ${esc(t.category)}</p>
      <div class="specs">
        ${specs}
      </div>
      <p>${esc(t.description || '')}</p>
      <p class="note">${rankNote(t, group)}</p>
    </div>`;
}

// ── Category pages ────────────────────────────────────────────────────────────

const all = AIRCRAFT_TYPES.map(enrich);

for (const page of PAGES) {
  const group = all
    .filter((t) => page.categories.includes(t.category))
    .sort((a, b) => (a.seats || a.payloadTonnes || 0) - (b.seats || b.payloadTonnes || 0));
  const isFreight = page.categories.includes('Freighter');
  const body = [
    page.intro,
    `<h2>All ${group.length} aircraft at a glance</h2>`,
    `<p>Figures are the game's actual values. Fuel cost assumes the base fuel price of $1.20/litre — the live market price in your save drifts between roughly half and nearly double that, which is why <a href="/route-economics.html">fuel hedging</a> matters.</p>`,
    statsTable(group, isFreight),
    `<h2>Type-by-type notes</h2>`,
    group.map((t) => aircraftCard(t, group, isFreight)).join('\n'),
  ].join('\n');

  const html = pageShell({
    title: page.title,
    description: page.description,
    canonical: `${SITE}/${page.file}`,
    h1: page.h1,
    lede: page.description,
    body,
  });
  writeFileSync(path.join(OUT, page.file), html);
  console.log(`wrote public/${page.file} (${group.length} aircraft)`);
}

// ── Index page ────────────────────────────────────────────────────────────────

const catCounts = PAGES.map((p) => ({
  ...p,
  count: all.filter((t) => p.categories.includes(t.category)).length,
}));

const indexBody = `
      <p>Tailwinds ships with <strong>${all.length} real-world aircraft types</strong>, from 19-seat island hoppers to the Airbus A380 — every one modelled with its own seats or payload, range, lease and purchase price, fuel burn, crew cost, and maintenance bill. Which ones you fly, and where, is most of the game.</p>
      <p>The guides below cover every type in each category, with full stat tables, per-seat economics computed from the game's actual data, and honest notes on when each aircraft earns its keep. If you're new, start with the <a href="/fleet-planning.html">fleet planning guide</a> to learn how to think about aircraft selection, then dive into a category.</p>

      <h2>Browse by category</h2>
${catCounts
  .map(
    (p) => `      <div class="card">
        <h3><a href="/${p.file}">${esc(p.h1)}</a></h3>
        <p class="meta">${p.count} aircraft</p>
        <p>${esc(p.description)}</p>
      </div>`
  )
  .join('\n')}

      <h2>How aircraft economics work in Tailwinds</h2>
      <p>Every aircraft in the game charges you in four ways: a <strong>weekly lease</strong> (or capital tied up in a purchase), <strong>fuel</strong> burned per kilometre flown, <strong>crew</strong> cost per kilometre, and a weekly <strong>maintenance</strong> bill that grows as the airframe ages. Revenue comes from the seats (or cargo tonnes) you fill. The art of fleet planning is matching capacity and range to each route so you pay for exactly the aircraft the mission needs — and nothing more.</p>
      <p>Two derived numbers appear throughout these guides. <strong>Fuel per seat-km</strong> is the fuel cost of moving one seat one kilometre — the cleanest efficiency comparison between types. <strong>Lease per seat</strong> spreads the weekly lease across capacity, showing how expensive each seat is before it ever leaves the gate. Together they explain most of why one aircraft makes money on a route and another loses it.</p>`;

writeFileSync(
  path.join(OUT, 'aircraft.html'),
  pageShell({
    title: `Aircraft Guide — All ${all.length} Planes in Tailwinds Airline Management Game`,
    description: `Complete guide to all ${all.length} aircraft in Tailwinds: narrow-bodies, widebodies, regional jets, turboprops, freighters and flagships — with real in-game stats and economics.`,
    canonical: `${SITE}/aircraft.html`,
    h1: 'Aircraft in Tailwinds',
    lede: `Every aircraft in the game, organised by category — with real stats, per-seat economics, and advice on when to fly each one.`,
    body: indexBody,
  })
);
console.log(`wrote public/aircraft.html (index, ${all.length} aircraft)`);
