// site-guide-charts.mjs
// Fills the generated charts, tables and figures on the hand-written Headwinds pages in
// apps/headwinds-web/pages/, so the game numbers an article quotes always come from the
// engine and server constants the game actually runs on.
//
// A page marks a slot like this, and everything between the markers is replaced:
//     <!-- GEN:gate-classes-table:START -->
//     <!-- GEN:gate-classes-table:END -->
//
//   node tools/site-guide-charts.mjs          rewrite the slots
//   node tools/site-guide-charts.mjs --check  exit 1 if any slot is stale
//
// Run it after changing airports, gate scarcity, alliance or codeshare constants, then
// `node tools/site-page-dates.mjs`. tools/site-pages-test.mjs fails while a slot is stale.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  AIRPORTS, gateCapacityOf, gateAirlineCapOf, gateAllianceCapOf, GATE_FEE_BY_TIER,
  GATE_AUCTION_LOTS_BY_SIZE, GATE_CAPACITY_GROWTH_CEILING, GATE_HUB_GUARANTEE,
} from '../packages/engine/src/data/airports.js';
import { SLOTS_PER_GATE } from '../packages/engine/src/utils/simulation.js';
import { CODESHARE_WEEKLY_FEE_BY_TIER, CODESHARE_DURATION_WEEKS, MAX_CODESHARE_AGREEMENTS } from '../packages/engine/src/data/alliances.js';
import { auctionReserveOf, slotPoolPerSlotFee } from '../apps/headwinds-server/src/lib/gateService.mjs';
import { playerAllianceDef, PLAYER_ALLIANCE_MAX_MEMBERS } from '../apps/headwinds-server/src/lib/humanRivals.mjs';
import { CODESHARE_OFFER_EXPIRY_WEEKS } from '../apps/headwinds-server/src/lib/codeshareService.mjs';
import { barChart } from './site-charts.mjs';

const HW = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = path.join(HW, 'apps/headwinds-web/pages');

const fmt = (n) => Math.round(n).toLocaleString('en-US');
const usd = (n) => `$${fmt(n)}`;
// site-charts.mjs draws in the Tailwinds palette; these pages are not rebranded by the
// build, so swap in the Headwinds surface, text and muted colours here.
const HW_PALETTE = [['#1b1b1f', '#0b0e13'], ['#ededee', '#e8edf4'], ['#a1a1aa', '#8b98ab']];
const recolor = (svg) => HW_PALETTE.reduce((s, [from, to]) => s.replaceAll(from, to), svg);
const chart = (svg) => `<div class="chartwrap">${recolor(svg)}</div>`;
const table = (head, rows) => `<div class="tablewrap"><table class="data">
        <thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
        <tbody>
${rows.map((r) => `          <tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('\n')}
        </tbody>
      </table></div>`;

// ── Gate scarcity classes ─────────────────────────────────────────────────────

// One row per base capacity, largest first. The tier decides the rent: the two smallest
// classes are both regional airports, split by the population they serve.
function gateClasses() {
  const byCap = new Map();
  for (const a of AIRPORTS) {
    const cap = gateCapacityOf(a);
    if (!byCap.has(cap)) byCap.set(cap, { cap, airports: [], tier: a.tier });
    byCap.get(cap).airports.push(a);
  }
  const names = { 500: 'Mega hubs', 250: 'Major airports', 100: 'Large regional airports', 25: 'Small regional airports' };
  return [...byCap.values()]
    .sort((x, y) => y.cap - x.cap)
    .map((c) => {
      const sample = c.airports[0];
      return { ...c, name: names[c.cap] ?? `${c.cap}-gate airports`, sample };
    });
}

const BLOCKS = {
  'gate-classes-chart': () => {
    const rows = gateClasses();
    return chart(
      barChart({
        label: 'Airports in Headwinds by gate capacity in a gate-scarcity world',
        bars: rows.map((c) => ({ label: `${c.name} (${c.cap} gates)`, value: c.airports.length, tip: `${fmt(c.airports.length)} airports with ${c.cap} gates each` })),
        valueFmt: fmt,
        xLabel: `Airports in each size class, of ${fmt(AIRPORTS.length)} in the game`,
      })
    );
  },

  'gate-classes-table': () =>
    table(
      ['Size class', 'Airports', 'Gates', 'Airline cap', 'Alliance cap', 'Auctioned a year', 'Largest size', 'Rent per gate a week', 'Auction reserve'],
      gateClasses().map((c) => [
        c.name,
        fmt(c.airports.length),
        fmt(c.cap),
        fmt(gateAirlineCapOf(c.cap)),
        fmt(gateAllianceCapOf(c.cap)),
        fmt(GATE_AUCTION_LOTS_BY_SIZE[c.cap] ?? 0),
        fmt(c.cap * GATE_CAPACITY_GROWTH_CEILING),
        usd((GATE_FEE_BY_TIER[c.sample.tier] ?? 0) / 4),
        usd(auctionReserveOf(c.sample)),
      ])
    ),

  'mega-hubs': () => {
    const mega = AIRPORTS.filter((a) => gateCapacityOf(a) === 500);
    const cities = [...new Set(mega.map((a) => a.city))];
    const twice = cities.filter((city) => mega.filter((a) => a.city === city).length > 1);
    return `<p>The ${fmt(mega.length)} airports that start with 500 gates are the world's largest hubs: ${mega.map((a) => `${a.city} (${a.code})`).join(', ')}. ${twice.length ? `${twice.join(' and ')} ${twice.length === 1 ? 'has' : 'have'} two of them.` : ''}</p>`;
  },

  'gate-numbers': () => {
    const mega = AIRPORTS.find((a) => gateCapacityOf(a) === 500);
    return `<p>Every route needs a gate at both ends, and one gate handles ${SLOTS_PER_GATE} departures a week. Each airline can always lease ${GATE_HUB_GUARANTEE} gates at its home hub, however full the airport. A slot borrowed from an alliance partner at a mega hub costs ${usd(slotPoolPerSlotFee(mega))} a week for each weekly departure, all of it paid to the partner who owns the gate.</p>`;
  },

  'alliance-terms-table': () => {
    const def = playerAllianceDef({ id: 'example', name: 'Example' }, 1);
    const fees = Object.values(CODESHARE_WEEKLY_FEE_BY_TIER);
    return table(
      ['', 'Player alliance', 'Codeshare'],
      [
        ['Who you sign with', `Up to ${PLAYER_ALLIANCE_MAX_MEMBERS} airlines, one alliance each`, `Any one other airline, up to ${MAX_CODESHARE_AGREEMENTS} codeshares at a time`],
        ['How it starts', 'Found one, or ask to join; the founder approves', `An offer the other airline accepts; unanswered offers lapse after ${CODESHARE_OFFER_EXPIRY_WEEKS} weeks`],
        ['Weekly cost', `${usd(def.weeklyFee)} per member`, `${usd(Math.min(...fees))} to ${usd(Math.max(...fees))}, by the partner's tier (budget, legacy or premium)`],
        ['How long', 'Until you leave or the alliance disbands', `${CODESHARE_DURATION_WEEKS} weeks, then it has to be signed again`],
        ['What it earns', `Connecting passengers through partners' hubs, a ${Math.round(def.demandBoostPct * 100)}% demand boost on routes a partner also flies, and +${def.qualityBonus} quality on every route`, 'Interline revenue from passengers connecting between the two networks'],
        ['Gates (scarcity worlds)', 'Members may share spare slots, and together may hold no more than 80% of any airport', 'No effect'],
      ]
    );
  },
};

const SLOT = /(<!-- GEN:([a-z0-9-]+):START -->)[\s\S]*?(<!-- GEN:\2:END -->)/g;

export function fill(html, file = 'page') {
  return html.replace(SLOT, (_, start, id, end) => {
    if (!BLOCKS[id]) throw new Error(`${file}: no generated block called "${id}"`);
    return `${start}\n      ${BLOCKS[id]()}\n      ${end}`;
  });
}

// { file: freshHtml } for every page whose slots are stale.
export function staleSlots() {
  const out = {};
  for (const file of readdirSync(PAGES).filter((f) => f.endsWith('.html')).sort()) {
    const before = readFileSync(path.join(PAGES, file), 'utf8');
    const after = fill(before, file);
    if (after !== before) out[file] = after;
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const stale = staleSlots();
  for (const [file, html] of Object.entries(stale)) {
    if (check) console.log(`stale: apps/headwinds-web/pages/${file}`);
    else {
      writeFileSync(path.join(PAGES, file), html);
      console.log(`filled apps/headwinds-web/pages/${file}`);
    }
  }
  console.log(Object.keys(stale).length ? '' : 'every generated block is current');
  if (check && Object.keys(stale).length) process.exit(1);
}
