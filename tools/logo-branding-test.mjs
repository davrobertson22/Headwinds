// Logo maker + airline code: rival colours, tile colours, the bare mark on a
// livery, and the player's two-character code on the departure board — plus,
// for Headwinds, one look and one code per player (guard, rival view, route).
// Port of the Tailwinds suite of the same name; sections 6–7 are Headwinds-only.
//
//   node --import ./tools/_register-loader.mjs tools/logo-branding-test.mjs
//
// Written failing on HEAD: rivals carried no colour (every one drew in the
// default blue, and the default field had two Bolts and two Arctics that were
// pixel-identical), a logo always sat on the same dark tile — on the aircraft
// too — and the airline code came from the name and could differ airport to
// airport.
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString, renderToStaticMarkup } from 'react-dom/server';

const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.window.dispatchEvent = globalThis.window.dispatchEvent ?? (() => true);
globalThis.window.addEventListener = globalThis.window.addEventListener ?? (() => {});
globalThis.window.removeEventListener = globalThis.window.removeEventListener ?? (() => {});
globalThis.window.matchMedia = globalThis.window.matchMedia ?? (() => ({ matches: false }));
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

const B = await import('../src/utils/logoBranding.js');
const D = await import('../src/models/departureBoard.js');
const L = await import('../src/data/livery.js');
const { default: AirlineLogo, AIRLINE_LOGOS } = await import('../src/components/AirlineLogo.jsx');
const { gameReducer, freshState, GameProvider } = await import('../src/store/GameContext.jsx');
const SetupScreen = (await import('../src/components/SetupScreen.jsx')).default;
const BrandingModal = (await import('../src/components/BrandingModal.jsx')).default;
const { ACCENT_COLORS } = await import('../src/components/SetupScreen.jsx');

const render = (el) => renderToString(React.createElement(GameProvider, null, el)).replaceAll('<!-- -->', '');
const svg = (props) => renderToStaticMarkup(React.createElement(AirlineLogo, props));

const game = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'Pacific Airways', hub: 'SYD', enableObjectives: false });
const combo = (logoId, color, bg) => `${logoId}|${color ?? ''}|${bg ?? ''}`;

console.log('\n── 1. Rivals: a colour each, and no two airlines look the same ─────');

await test('a new game has rivals to colour', () => {
  assert.ok((game.competitors ?? []).length >= 6, `only ${game.competitors?.length} rivals`);
});
await test('every rival gets a palette colour', () => {
  const colors = B.fieldLogoColors(game);
  const hexes = new Set(B.LOGO_COLORS.map(c => c.hex));
  for (const c of game.competitors) assert.ok(hexes.has(colors[c.id]), `${c.name}: ${colors[c.id]}`);
});
await test('no two airlines (player included) share a mark in the same colour', () => {
  const colors = B.fieldLogoColors(game);
  const seen = new Set([combo(game.logoId, game.logoColor, game.logoBg)]);
  for (const c of game.competitors) {
    const k = combo(c.logoId, colors[c.id], c.logoBg);
    assert.ok(!seen.has(k), `${c.name} duplicates ${k}`);
    seen.add(k);
  }
});
await test('two rivals on the same preset come out in different colours', () => {
  const field = { logoId: 'horizon', logoColor: '#ff3b3b', competitors: [
    { id: 'a', name: 'Velocity Air', tier: 'budget', logoId: 'bolt' },
    { id: 'b', name: 'Velocity Air', tier: 'budget', logoId: 'bolt' },
    { id: 'c', name: 'Velocity Air', tier: 'budget', logoId: 'bolt' },
  ] };
  const col = B.fieldLogoColors(field);
  assert.equal(new Set(Object.values(col)).size, 3);
});
await test('the player keeps their pick; a rival on it moves', () => {
  const rival = { id: 'r1', name: 'Velocity Air', tier: 'budget', logoId: 'bolt' };
  const before = B.fieldLogoColors({ logoId: 'horizon', logoColor: '#1e9bff', competitors: [rival] }).r1;
  const after = B.fieldLogoColors({ logoId: 'bolt', logoColor: before, competitors: [rival] }).r1;
  assert.notEqual(after, before, 'the rival should step off the player’s mark');
  assert.deepEqual(B.carrierLogo({ logoId: 'bolt', logoColor: before, competitors: [rival] }, { isPlayer: true }).accentColor, before);
});
await test('a coloured tile or an uploaded logo frees the combination', () => {
  const rival = { id: 'r1', name: 'Velocity Air', tier: 'budget', logoId: 'bolt' };
  const free = B.fieldLogoColors({ logoId: 'horizon', logoColor: '#1e9bff', competitors: [rival] }).r1;
  assert.equal(B.fieldLogoColors({ logoId: 'bolt', logoColor: free, logoBg: '#14254a', competitors: [rival] }).r1, free);
  assert.equal(B.fieldLogoColors({ logoId: 'bolt', logoColor: free, customLogo: 'data:x', competitors: [rival] }).r1, free);
});
await test('colours are stable: same field → same colours, tier palettes respected', () => {
  const a = B.fieldLogoColors({ ...game, competitors: [...game.competitors] });
  const b = B.fieldLogoColors({ ...game, competitors: [...game.competitors] });
  assert.deepEqual(a, b);
  const prem = B.fieldLogoColors({ logoId: 'horizon', logoColor: '#1e9bff', competitors: [{ id: 'p', name: 'Crystal Skies', tier: 'premium', logoId: 'crown' }] }).p;
  assert.ok(['#ffd000', '#9b4dff', '#c44dff', '#d0a8ff', '#c0cad8', '#ffffff'].includes(prem), prem);
});
await test('ACCENT_COLORS is still exported from SetupScreen (same palette)', () => {
  assert.deepEqual(ACCENT_COLORS, B.LOGO_COLORS);
});

console.log('\n── 2. Tiles: the second colour ─────────────────────────────────────');

await test('default tile is the dark gradient (saves without logoBg look the same)', () => {
  const s = svg({ id: 'bolt', accentColor: '#ff3b3b' });
  assert.match(s, /linearGradient/);
});
await test('a hex tile paints a solid rect in that colour', () => {
  const s = svg({ id: 'bolt', accentColor: '#ffffff', bgColor: '#14254a' });
  assert.match(s, /fill="#14254a"/);
  assert.doesNotMatch(s, /linearGradient/);
});
await test("'none' draws the bare mark — no tile at all", () => {
  for (const l of AIRLINE_LOGOS) {
    const s = svg({ id: l.id, accentColor: '#ff3b3b', bgColor: 'none' });
    assert.doesNotMatch(s, /linearGradient|<rect width="40" height="40"/, l.id);
  }
});
await test('an upload sits on the chosen tile (transparent PNGs show it)', () => {
  assert.match(svg({ customSrc: 'data:image/png;base64,AA', bgColor: '#4a0f1c' }), /fill="#4a0f1c"/);
  assert.match(svg({ customSrc: 'data:image/png;base64,AA' }), /fill="#15202f"/);
  assert.doesNotMatch(svg({ customSrc: 'data:image/png;base64,AA', bgColor: 'none' }), /<rect width="40" height="40" rx="\d+" fill=/);
});
await test('low-contrast warning fires for near-identical colours only', () => {
  assert.equal(B.lowContrastTile('#ff3b3b', '#ff3b3b'), true);
  assert.equal(B.lowContrastTile('#ffffff', '#14254a'), false);
  assert.equal(B.lowContrastTile('#1e9bff', null), false);
});
await test('reducer stores the tile on START_GAME and SET_BRANDING; null clears it', () => {
  const g = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'T', hub: 'SYD', enableObjectives: false, logoBg: '#14254A' });
  assert.equal(g.logoBg, '#14254a');
  const s1 = gameReducer(g, { type: 'SET_BRANDING', logoBg: '#4a0f1c' });
  assert.equal(s1.logoBg, '#4a0f1c');
  assert.equal(gameReducer(s1, { type: 'SET_BRANDING', logoBg: 'javascript:1' }).logoBg, '#4a0f1c', 'junk ignored');
  assert.equal(gameReducer(s1, { type: 'SET_BRANDING', logoBg: null }).logoBg, null);
  assert.equal(gameReducer(s1, { type: 'SET_BRANDING', airlineName: 'R' }).logoBg, '#4a0f1c', 'absent → untouched');
});

console.log('\n── 3. Liveries: the bare mark on the paint ─────────────────────────');

await test('livery logoTile defaults off and is part of the cache key', () => {
  assert.equal(L.normalizeLivery({}).logoTile, false);
  assert.equal(L.normalizeLivery({ logoTile: true }).logoTile, true);
  assert.notEqual(L.liveryKey({ logoTile: true }), L.liveryKey({}));
});
await test('the mark keeps its colour where it reads, else goes white/ink', () => {
  assert.equal(B.markColorOn('#f5f7fa', '#1e9bff'), '#1e9bff', 'blue on a white body');
  assert.equal(B.markColorOn('#ff3b3b', '#ff3b3b'), '#ffffff', 'red on a red tail → white');
  assert.equal(B.markColorOn('#ffe600', '#ffd000'), '#15202f', 'gold on a sun-yellow tail → ink');
});

console.log('\n── 4. Airline code ─────────────────────────────────────────────────');

await test('normalizeAirlineCode: two characters, at least one letter', () => {
  assert.equal(B.normalizeAirlineCode('qf'), 'QF');
  assert.equal(B.normalizeAirlineCode(' 9w '), '9W');
  assert.equal(B.normalizeAirlineCode('U2'), 'U2');
  for (const bad of ['99', 'Q', 'QFA', 'Q-', '', null, 12]) assert.equal(B.normalizeAirlineCode(bad), null, String(bad));
});
await test('suggestAirlineCode reads initials, else the first two letters', () => {
  assert.equal(B.suggestAirlineCode('Pacific Airways'), 'PA');
  assert.equal(B.suggestAirlineCode('Qantas'), 'QA');
  assert.equal(B.suggestAirlineCode(''), '');
});
await test('an explicit code is kept even when a rival earlier in the list would derive it', () => {
  const codes = D.assignAirlineCodes([
    { id: 'r', name: 'Quiet Flyer' },         // derives QF
    { id: '__player__', name: 'Pacific Airways', code: 'qf' },
  ]);
  assert.equal(codes.__player__, 'QF');
  assert.notEqual(codes.r, 'QF');
});
await test('two airlines claiming the same code: first wins, second walks', () => {
  const codes = D.assignAirlineCodes([{ id: 'a', name: 'Alpha', code: 'QF' }, { id: 'b', name: 'Beta', code: 'QF' }]);
  assert.equal(codes.a, 'QF');
  assert.notEqual(codes.b, 'QF');
});
await test('with no explicit codes the old assignment is unchanged', () => {
  const list = [{ id: 'a', name: 'Aurora Air' }, { id: 'b', name: 'Antipodes Air' }, { id: 'c', name: 'Adriatic Air' }];
  assert.deepEqual(D.assignAirlineCodes(list), { a: 'AA', b: 'AB', c: 'AC' });
});
await test('world codes: a rival prints the same code at every airport', () => {
  const state = { ...game, airlineCode: 'QF' };
  const codes = D.worldAirlineCodes(state);
  assert.equal(codes.__player__, 'QF');
  const vals = Object.values(codes);
  assert.equal(new Set(vals).size, vals.length, 'world codes are unique');
  const [r1, r2] = game.competitors;
  const board = (carriers) => D.buildDepartureBoard({ airport: 'SYD', day: 0, worldSeed: 'w', carriers });
  const leg = { to: 'MEL', weeklyFrequency: 14 };
  const withBoth = board([
    { id: r1.id, name: r1.name, code: codes[r1.id], legs: [leg] },
    { id: r2.id, name: r2.name, code: codes[r2.id], legs: [leg] },
  ]);
  const alone = board([{ id: r2.id, name: r2.name, code: codes[r2.id], legs: [leg] }]);
  const prefix = (rows, id) => rows.find(r => r.airlineId === id).flightNo.slice(0, 2);
  assert.equal(prefix(withBoth, r2.id), prefix(alone, r2.id));
});
await test("the player's flight numbers start with their code", () => {
  const rows = D.buildDepartureBoard({ airport: 'SYD', day: 0, worldSeed: 'w', carriers: [
    { id: '__player__', name: 'Pacific Airways', code: 'QF', isPlayer: true, legs: [{ to: 'MEL', weeklyFrequency: 14 }] },
  ] });
  assert.ok(rows.length > 0);
  for (const r of rows) assert.match(r.flightNo, /^QF\d+$/);
});
await test('reducer: code stored upper-cased; junk ignored; empty/null clears', () => {
  const g = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'T', hub: 'SYD', enableObjectives: false, airlineCode: 'qf' });
  assert.equal(g.airlineCode, 'QF');
  const plain = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'T', hub: 'SYD', enableObjectives: false });
  assert.equal('airlineCode' in plain, false, 'no code chosen → no key (state hashes stay byte-identical)');
  assert.equal('logoBg' in plain, false);
  assert.equal(gameReducer(g, { type: 'SET_BRANDING', airlineCode: 'ua' }).airlineCode, 'UA');
  assert.equal(gameReducer(g, { type: 'SET_BRANDING', airlineCode: '99' }).airlineCode, 'QF');
  assert.equal(gameReducer(g, { type: 'SET_BRANDING', airlineCode: '' }).airlineCode, null);
});

console.log('\n── 4b. Multiplayer: other players keep their look and code ──────────');

const humanField = (extra = {}) => ({
  logoId: 'horizon', logoColor: '#1e9bff', airlineCode: 'PA', ...extra,
  competitors: [
    { id: 'h1', name: 'Kiwi Wings', human: true, logoId: 'bolt', logoColor: '#ff3b3b', airlineCode: 'KW' },
    { id: 'h2', name: 'Up Air', human: true, logoId: 'star', logoColor: '#ffd000', logoBg: '#14254a' },
  ],
});
await test('a human rival keeps their colour even when it matches mine', () => {
  const st = humanField({ logoId: 'bolt', logoColor: '#ff3b3b' });
  assert.equal(B.fieldLogoColors(st).h1, '#ff3b3b');
});
await test("brandingClash refuses another player's look", () => {
  const why = B.brandingClash(humanField(), { logoId: 'bolt', logoColor: '#ff3b3b' });
  assert.match(why, /Kiwi Wings already flies the Bolt in Crimson on the default tile/);
  assert.equal(B.brandingClash(humanField(), { logoId: 'bolt', logoColor: '#ff3b3b', logoBg: '#14254a' }), null, 'a different tile is fine');
  assert.match(B.brandingClash(humanField(), { logoId: 'star', logoColor: '#ffd000', logoBg: '#14254A' }), /Up Air/);
  assert.equal(B.brandingClash(humanField(), { logoId: 'bolt', logoColor: '#ff3b3b', customLogo: 'data:image/png;base64,AA' }), null, 'uploads never clash');
});
await test("brandingClash refuses another player's code, case-insensitively", () => {
  assert.match(B.brandingClash(humanField(), { airlineCode: 'kw' }), /KW is already Kiwi Wings/);
  assert.equal(B.brandingClash(humanField(), { airlineCode: 'QF' }), null);
});
await test('a name-only rebrand never trips over a clash that predates the rule', () => {
  const st = humanField({ logoId: 'bolt', logoColor: '#ff3b3b', airlineCode: 'KW' });
  assert.equal(B.brandingClash(st, { airlineName: 'Renamed' }), null);
  assert.equal(B.brandingClash(st, { logoId: 'bolt', logoColor: '#ff3b3b', logoBg: null, airlineCode: 'KW' }), null, 'unchanged look and code');
});
await test('solo: AI rivals never block', () => {
  assert.equal(B.brandingClash(game, { logoId: game.competitors[0].logoId, logoColor: B.fieldLogoColors(game)[game.competitors[0].id] }), null);
  assert.equal(B.takenBranding(game).any, false);
});
await test('takenBranding names the owner of a look and a code', () => {
  const t = B.takenBranding(humanField());
  assert.equal(t.look('bolt', '#FF3B3B', null), 'Kiwi Wings');
  assert.equal(t.look('bolt', '#ff3b3b', '#14254a'), null);
  assert.equal(t.code('kw'), 'Kiwi Wings');
});

console.log('\n── 5. Screens: one logo maker in both places ───────────────────────');

await test('the new-game screen shows the code field, tile colours and every preset', () => {
  const html = render(React.createElement(SetupScreen));
  assert.match(html, /Airline Code/);
  assert.match(html, /Tile colour/);
  assert.match(html, /Logo colour: Crimson/);
  for (const l of AIRLINE_LOGOS) assert.ok(html.includes(`title="${l.name}"`), l.name);
});
await test('Edit Branding uses the same picker and code field', () => {
  const html = render(React.createElement(BrandingModal, { onClose: () => {} }));
  assert.match(html, /Airline Code/);
  assert.match(html, /Tile colour: Navy/);
  assert.match(html, /How it looks on the departure board/);
});

console.log('\n── 6. Server: the guard, the rival view, the route ─────────────────');

const { guardDecision, GuardError } = await import('../apps/headwinds-server/src/lib/decisionGuard.mjs');
const { toHumanCompetitor } = await import('../apps/headwinds-server/src/lib/humanRivals.mjs');
const { readFileSync } = await import('node:fs');

await test('the guard forwards a valid tile and code, normalised', () => {
  const out = guardDecision('SET_BRANDING', { logoBg: '#14254A', airlineCode: 'qf' }, freshState());
  assert.equal(out.logoBg, '#14254a');
  assert.equal(out.airlineCode, 'QF');
});
await test('the guard forwards null (clear) and leaves absent keys absent', () => {
  const out = guardDecision('SET_BRANDING', { logoBg: null, airlineCode: '' }, freshState());
  assert.equal(out.logoBg, null);
  assert.equal(out.airlineCode, null);
  const name = guardDecision('SET_BRANDING', { airlineName: 'Skyline' }, freshState());
  assert.equal('logoBg' in name, false);
  assert.equal('airlineCode' in name, false);
});
await test('the guard refuses junk rather than storing it', () => {
  assert.throws(() => guardDecision('SET_BRANDING', { logoBg: 'url(javascript:1)' }, freshState()), GuardError);
  assert.throws(() => guardDecision('SET_BRANDING', { airlineCode: '99' }, freshState()), GuardError);
  assert.throws(() => guardDecision('SET_BRANDING', { airlineCode: 'QFA' }, freshState()), GuardError);
});
await test("every rival view carries a player's tile and code", () => {
  const row = { id: 'a1', name: 'Kiwi Wings', hub: 'AKL', status: 'ACTIVE',
    state: { ...freshState(), airlineName: 'Kiwi Wings', hub: 'AKL', logoId: 'bolt', logoColor: '#ff3b3b', logoBg: '#14254a', airlineCode: 'KW' } };
  const c = toHumanCompetitor(row);
  assert.equal(c.human, true);
  assert.equal(c.logoBg, '#14254a');
  assert.equal(c.airlineCode, 'KW');
});
await test('the decision route refuses a clash before the reducer runs, as a 409', () => {
  const src = readFileSync(new URL('../apps/headwinds-server/src/routes/decisions.mjs', import.meta.url), 'utf8');
  const at = src.indexOf("if (type === 'SET_BRANDING')");
  assert.ok(at > 0, 'no SET_BRANDING branch in routes/decisions.mjs');
  const branch = src.slice(at, at + 400);
  assert.match(branch, /brandingClash\(/);
  assert.match(branch, /httpError\(409, clash\)/);
  assert.ok(at < src.indexOf('gameReducer(injected'), 'the clash check must run before the reducer');
});

console.log('\n── 7. Edit Branding in a world: other players\u2019 looks are marked ───');

const { RemoteGameProvider } = await import('../src/store/GameContext.jsx');
const remote = (st, el) => renderToString(React.createElement(RemoteGameProvider, { state: st, dispatch: () => {} }, el)).replaceAll('<!-- -->', '');
const world = {
  ...game, multiplayer: true, logoId: 'horizon', logoColor: '#ff3b3b', airlineCode: 'PA',
  competitors: [{ id: 'h1', name: 'Kiwi Wings', human: true, logoId: 'bolt', logoColor: '#ff3b3b', airlineCode: 'KW', routes: {} }],
};
await test("another player's preset in my colour shows as Taken", () => {
  const html = remote(world, React.createElement(BrandingModal, { onClose: () => {} }));
  assert.match(html, /Bolt — Kiwi Wings already flies this in this colour/);
});
await test('my own look is never marked taken', () => {
  const html = remote(world, React.createElement(BrandingModal, { onClose: () => {} }));
  assert.doesNotMatch(html, /title="Horizon — /);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
