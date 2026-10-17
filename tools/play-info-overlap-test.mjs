#!/usr/bin/env node
// Guard for the /play scroll bug (Oct 2026): scrolling past the bottom of the
// game, or of the lobby after visiting an airline, showed the static
// #play-info text drawn over the app.
//
//   node tools/play-info-overlap-test.mjs
//
// Cause: src/index.css (the shared game stylesheet, lazy-loaded with
// GamePlayScreen) sets html,body,#root{height:100%}. Once that chunk has
// loaded it stays loaded for the tab, so #root is pinned to one viewport:
//   * lobby: its content overflows #root and paints over #play-info, which
//     starts exactly one viewport down;
//   * game: .app-layout fills the viewport and the document scrolls past it
//     into #play-info.
// Tailwinds never had it because its landing and #root are never shown together.
//
// The fix lives in play.html's inline <style>: outside the game #root grows with
// its content again, and while .app-layout is mounted #play-info is hidden. This
// test checks the cause is still there (so the guard still means something) and
// that both halves of the fix are present and out-rank the game stylesheet.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HW = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const play = readFileSync(path.join(HW, 'apps/headwinds-web/play.html'), 'utf8');
const gameCss = readFileSync(path.join(HW, 'src/index.css'), 'utf8');
const app = readFileSync(path.join(HW, 'src/App.jsx'), 'utf8');

let failed = 0;
const pass = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { failed++; console.log(`  FAIL ${m}`); };

const style = (play.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';
const norm = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');
const css = norm(style);

// The cause. If the game stylesheet stops pinning #root, the guard below is moot.
if (/html\s*,\s*body\s*,\s*#root\s*\{[^}]*height:\s*100%/.test(gameCss)) pass('game stylesheet still pins html,body,#root to height:100% (the cause)');
else console.log('  note game stylesheet no longer pins #root height — fix may be removable');

// The game screen's root element is what the :has() selectors key on.
if (app.includes('className="app-layout"')) pass('game shell still renders .app-layout');
else fail('src/App.jsx no longer renders className="app-layout" — the #play-info guards key on it');

// Half 1: outside the game #root grows with its content. Must beat the game
// stylesheet's `#root` (1,0,0) without !important: html body #root = (1,0,2).
if (/html body #root:not\(:has\(\.app-layout\)\) \{ ?height: ?auto;? ?\}/.test(css)) pass('outside the game, #root height is released (lobby cannot overflow onto #play-info)');
else fail('play.html is missing `html body #root:not(:has(.app-layout)) { height: auto; }` — the lobby will overlap #play-info after visiting an airline');

// Half 2: inside the game #play-info is not rendered, so nothing scrolls into view.
if (/#root:has\(\.app-layout\) ~ #play-info \{ ?display: ?none;? ?\}/.test(css)) pass('inside the game, #play-info is hidden');
else fail('play.html is missing `#root:has(.app-layout) ~ #play-info { display: none; }` — the game can be scrolled past into #play-info');

// #play-info must still be in the static HTML for crawlers (adsense-readiness-test).
if (play.includes('<div id="play-info">')) pass('#play-info is still in the static HTML');
else fail('#play-info was removed from play.html');

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
