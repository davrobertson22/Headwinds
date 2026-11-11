// Server-renders the REAL Operations and Route Detail screens, and the plan
// editor and Apply-to-routes panel, with service plans in the save.
//
// The engine suite (tools/catering-plans-test.mjs) proves the maths; this one
// proves the screens show the engine's figures: quality as a bar, cost and
// sales per passenger for every choice, and never a suggested price.
//
//   node --import ./tools/_register-loader.mjs tools/catering-plans-ui-test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AIRCRAFT_TYPES } from '../src/data/aircraft.js';
import { referencePrice } from '../src/utils/simulation.js';
import { makeCateringContract } from '../src/data/cateringContracts.js';
import {
  CATERING_ITEMS, CATERING_EXPECTED, classicTemplateCabins, cateringRefSummary, cabinMenuEconomics,
  planQualityBonus, itemReferencePrice,
} from '../src/data/cateringPlans.js';

const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

console.log('\nService plans — the screens render and quote the engine\n');

const jet = AIRCRAFT_TYPES.filter(t => !t.freighter && t.seats >= 150 && t.seats <= 200).sort((a, b) => b.range - a.range)[0];
const P = 'JFK', Q = 'LAX', PAIR = [P, Q].sort().join('-');
const FARE = Math.round(referencePrice(P, Q));
const YEAR = 2, WEEK = 20, ABS = (YEAR - 1) * 52 + WEEK;

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const Operations  = (await import('../src/components/Operations.jsx')).default;
const RouteDetail = (await import('../src/components/RouteDetail.jsx')).default;
const { PlanEditor, ApplyToRoutes, QualityScaleBar } = await import('../src/components/CateringPlans.jsx');
const { defaultAncillaries } = await import('../src/data/ancillaries.js');

const free = (ids) => Object.fromEntries(ids.map(id => [id, { mode: 'free', tier: 'standard' }]));
const FLAG = { id: 'flag', name: 'Flagship long haul', cabins: {
  economy: { ...free(CATERING_EXPECTED.economy), hotMeal: { mode: 'free', tier: 'premium' } },
  premiumEconomy: {}, businessClass: free(CATERING_EXPECTED.businessClass), firstClass: {} } };
const SHOP = { id: 'shop', name: 'Trolley shop', cabins: {
  economy: { water: { mode: 'free', tier: 'standard' }, hotMeal: { mode: 'sold', tier: 'standard', price: 14 }, snack: { mode: 'sold', tier: 'basic', price: null } },
  premiumEconomy: {}, businessClass: {}, firstClass: {} } };

function seed(extra = {}) {
  const save = {
    ...freshState(),
    phase: 'playing', week: WEEK, year: YEAR, hub: P, cash: 400_000_000, cateringPlansWorld: true,
    gates: { [P]: 8, [Q]: 8 },
    ancillaries: defaultAncillaries(),
    fleet: [{ id: 'ac1', typeId: jet.id, name: 'One', tailNumber: 'N1TEST', status: 'assigned',
      ageWeeks: 52, ownershipType: 'owned', config: { economy: jet.seats } }],
    routes: [{ id: 'r1', origin: P, destination: Q, stops: [P, Q], aircraftId: 'ac1', weeklyFrequency: 7, weeksOpen: 40, hub: P, ticketPrice: FARE }],
    routeCatering: { [PAIR]: 'full' },
    ...extra,
  };
  store.set('bbae_save_v2', JSON.stringify(save));
  return save;
}
const render = (el) => renderToString(React.createElement(GameProvider, null, el)).replace(/<!--.*?-->/g, '');
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const money2 = (n) => `${n < -0.004 ? '−' : ''}$${Math.abs(n).toFixed(2)}`;
const NARROW = { economy: 150, businessClass: 12 };
const noop = () => {};

console.log('── Operations: the plan list ───────────────────────────');

test('with no plans the card says so and offers every classic level to customise', () => {
  seed();
  const t = text(render(React.createElement(Operations)));
  assert.ok(t.includes('Service Plans'), 'section heading');
  assert.ok(t.includes('None yet. Start a blank plan, or customise a classic level below.'));
  assert.equal((t.match(/Customise/g) ?? []).length, 5, 'one per classic level');
  assert.ok(t.includes('New blank plan'));
});

test('a saved plan is listed with its routes, per-passenger cost, sales and net, and its quality', () => {
  seed({ cateringPlans: { flag: FLAG, shop: SHOP }, routeCatering: { [PAIR]: 'plan:flag' }, defaultCateringLevel: 'plan:shop' });
  const html = render(React.createElement(Operations));
  const t = text(html);
  const s = cateringRefSummary('plan:flag', { flag: FLAG }, 2500, NARROW);
  assert.ok(t.includes('Flagship long haul'));
  assert.ok(t.includes('1 route'), 'how many routes use it');
  assert.ok(t.includes('0 routes · default for new routes'), 'and which one is the default');
  assert.ok(t.includes(money2(-s.costPerPax)), `cost per passenger ${money2(-s.costPerPax)}`);
  assert.ok(t.includes(money2(s.netPerPax)), `net per passenger ${money2(s.netPerPax)}`);
  const shop = cateringRefSummary('plan:shop', { shop: SHOP }, 2500, NARROW);
  assert.ok(t.includes(money2(shop.revenuePerPax)), `sales per passenger ${money2(shop.revenuePerPax)}`);
  assert.ok((html.match(/role="img"/g) ?? []).length >= 7, 'a quality bar on every row: two plans and five classic levels');
  for (const word of ['Edit', 'Apply to routes', 'Duplicate', 'Make default', 'Delete']) assert.ok(t.includes(word), word);
});

test('the default-service picker offers the airline\'s plans beside the classic levels', () => {
  seed({ cateringPlans: { flag: FLAG } });
  const t = text(render(React.createElement(Operations)));
  assert.ok(t.includes('The catering level or service plan applied to every newly-opened route.'));
  assert.ok(t.split('Default Catering Service')[1].split('Service Plans')[0].includes('Flagship long haul'));
});

test('in a world without custom catering the Service Plans section is not there at all', () => {
  seed({ cateringPlansWorld: undefined });
  const t = text(render(React.createElement(Operations)));
  assert.ok(!t.includes('Service Plans') && !t.includes('New blank plan') && !t.includes('Customise'));
  assert.ok(t.includes('The catering level applied to every newly-opened route.'));
  assert.ok(t.includes('Catering Contracts'), 'the rest of the catering page is unchanged');
});

console.log('\n── The editor ──────────────────────────────────────────');

const editor = (draft, extra = {}) => renderToString(React.createElement(PlanEditor, {
  draft, setDraft: noop, plans: {}, usage: { count: 0 }, distKm: 2000, setDistKm: noop,
  layoutId: 'narrow', setLayoutId: noop, onSave: noop, onCancel: noop, ...extra })).replace(/<!--.*?-->/g, '');

test('every item on the cabin menu is a row with Off, Free and Sell, and tiers where the item has them', () => {
  const html = editor(SHOP), t = text(html);
  for (const it of CATERING_ITEMS.filter(i => i.cost.economy != null)) assert.ok(t.includes(it.name), it.name);
  assert.ok(!t.includes('Fine dining'), 'not on the economy menu');
  for (const h of ['Serve', 'Quality tier', 'Your price', 'Cost / pax', 'Who buys', 'Sales / pax', 'Net / pax', 'Quality added']) assert.ok(t.includes(h), h);
  assert.equal((html.match(/aria-label="[^"]* quality tier"/g) ?? []).length, CATERING_ITEMS.filter(i => i.tiered).length);
  for (const tier of ['Basic', 'Standard', 'Premium']) assert.ok(t.includes(tier));
});

test('a sold item shows who buys, its cost and sales per passenger, and its net — the engine\'s figures', () => {
  const t = text(editor(SHOP));
  const row = cabinMenuEconomics(SHOP.cabins.economy, 'economy', 2000).rows.hotMeal;
  assert.ok(t.includes(`${Math.round(row.take * 100)}%`), 'share who buy');
  assert.ok(t.includes(money2(-row.costPerPax)), 'cost per passenger');
  assert.ok(t.includes(money2(row.revenuePerPax)), 'sales per passenger');
  assert.ok(t.includes(money2(row.netPerPax)), 'net per passenger');
  assert.ok(t.includes(`+${row.points.toFixed(1)}`), 'quality points it adds');
  assert.ok(t.includes('everyone'), 'a free item goes to everyone');
});

test('quality is drawn as bars: one per served item, one for the cabin, one for the route', () => {
  const html = editor(FLAG);
  const served = Object.keys(FLAG.cabins.economy).length;
  assert.ok((html.match(/Adds [\d.]+ quality points/g) ?? []).length >= served, 'an item bar per served item');
  assert.ok(html.includes('Economy cabin quality'), 'the cabin bar');
  assert.ok(html.includes('Route quality from catering'), 'the route bar');
  const t = text(html);
  assert.ok(t.includes('Classic Full') && t.includes('Nothing served'), 'the cabin bar is marked against the classic levels');
  const q = planQualityBonus(FLAG, 2000, NARROW);
  assert.ok(t.includes(`Route quality from catering ${q > 0 ? '+' : q < 0 ? '−' : ''}${Math.abs(q)}`));
});

test('a sold item\'s bar marks what it would add if it were free', () => {
  const html = editor(SHOP);
  const row = cabinMenuEconomics(SHOP.cabins.economy, 'economy', 2000).rows.hotMeal;
  assert.ok(html.includes(`Adds ${row.points.toFixed(1)} quality points. Free, it would add ${row.pointsIfFree.toFixed(1)}.`));
});

test('no price is ever suggested: the price box starts empty and the screen says the item is not served yet', () => {
  const html = editor(SHOP), t = text(html);
  assert.doesNotMatch(t, /suggest|recommended price|typical price|reference price/i);
  assert.ok(t.includes('no price yet'), 'an unpriced sold item says so on its row');
  assert.ok(t.includes('Set to sell but not priced yet, so not served: Packaged snack (Economy).'));
  assert.ok(/placeholder="type"/.test(html));
  const ref = itemReferencePrice('snack', 'economy', 'basic');
  assert.ok(!t.includes(`$${ref.toFixed(2)}`) || ref === 0.6 * 1, 'the hidden reference price is not printed');
});

test('the editor says when routes already use the plan, and refuses a duplicate name', () => {
  assert.ok(text(editor(FLAG, { usage: { count: 3 } })).includes('Used on 3 routes. Saving changes what they serve from next week.'));
  const t = text(editor({ ...SHOP, id: 'other', name: 'flagship long haul' }, { plans: { flag: FLAG } }));
  assert.ok(t.includes('You already have a plan called flagship long haul.'));
});

test('a customised classic level opens with its items filled in', () => {
  const t = text(editor({ id: 'x', name: 'My Paid Service', basedOn: 'paid', cabins: classicTemplateCabins('paid') }));
  assert.ok(!t.includes('no price yet'));
  assert.ok(t.includes('Economy total, per passenger'));
});

console.log('\n── Apply to routes ─────────────────────────────────────');

test('the panel lists every route with what it serves now, and filters by length and region', () => {
  const save = seed({ cateringPlans: { flag: FLAG } });
  const { hydrateState } = { hydrateState: (s) => s };
  const t = text(renderToString(React.createElement(ApplyToRoutes, { plan: FLAG, state: hydrateState({ ...save, routes: save.routes.map(r => ({ ...r, cateringLevel: 'full' })) }), onApply: noop, onCancel: noop })).replace(/<!--.*?-->/g, ''));
  assert.ok(t.includes('Apply Flagship long haul to routes'));
  assert.ok(t.includes(`${P}–${Q}`), t.slice(0, 700));
  assert.ok(t.includes('Full Service'), 'what the route serves now');
  assert.ok(t.includes('Any length') && t.includes('Any region') && t.includes('Through JFK'), 'length, region and hub filters');
  assert.ok(t.includes('Tick the routes to move to this plan.'));
  assert.ok(t.includes('not flown yet'), 'a route with no report yet says so, not a made-up figure');
});

console.log('\n── Route screens ───────────────────────────────────────');

test('Route Detail offers the plan, and under a snack-box caterer says what the flights go without', () => {
  seed({ cateringPlans: { flag: FLAG }, routeCatering: { [PAIR]: 'plan:flag' } });
  let t = text(render(React.createElement(RouteDetail, { origin: P, dest: Q, onBack: noop })));
  assert.ok(t.includes('Flagship long haul is one of your own service plans.'));
  assert.ok(!t.includes('go without'));
  const c = makeCateringContract('bigsky', 3, ABS);
  seed({ cateringPlans: { flag: FLAG }, routeCatering: { [PAIR]: 'plan:flag' }, cateringContracts: { [c.id]: c } });
  t = text(render(React.createElement(RouteDetail, { origin: P, dest: Q, onBack: noop })));
  assert.ok(t.includes('Big Sky Snacks'), 'by name');
  assert.ok(t.includes('snack-box kitchen'));
  assert.match(t, /go without .*hot meal/);
  assert.ok(!t.includes("can't deliver"), 'a plan is not level-capped');
});

test('every route-level catering picker is handed the plans and the kitchen report', () => {
  const dir = fileURLToPath(new URL('../src/components/', import.meta.url));
  const missing = [];
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.jsx'))) {
    if (file === 'CateringSelector.jsx') continue;
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    const re = /<CateringSelector\b[\s\S]*?\/>/g;
    let m;
    while ((m = re.exec(src))) {
      const line = `${file}:${src.slice(0, m.index).split('\n').length}`;
      if (!m[0].includes('plans=')) missing.push(`${line} (plans)`);
      if (!m[0].includes('SET_DEFAULT_CATERING') && !m[0].includes('kitchenNote=')) missing.push(`${line} (kitchenNote)`);
    }
  }
  assert.deepEqual(missing, []);
});

test('the quality bar puts its fill on the right side of zero', () => {
  const pos = renderToString(React.createElement(QualityScaleBar, { value: 5, min: -10, max: 10 }));
  const neg = renderToString(React.createElement(QualityScaleBar, { value: -5, min: -10, max: 10 }));
  assert.ok(pos.includes('left:50%') && pos.includes('var(--green)'));
  assert.ok(neg.includes('left:25%') && neg.includes('var(--red)'));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
