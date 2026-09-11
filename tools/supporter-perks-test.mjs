// What makes the supporter badge safe to sell.
//
//   node --import ./tools/_register-loader.mjs tools/supporter-perks-test.mjs
//
// NO PAY-TO-WIN. `isSupporter` is cosmetic and must stay that way. This asserts
// the shared engine cannot see it at all — not that we remembered to be careful,
// but that the string does not appear in packages/engine. If a future change
// makes the sim read it, this test is what says no.
//
// The badge is now the ENTIRE perk surface. There was briefly an ad-free perk
// here too, with a pause/resume gate in play.html and a src/ads.js to drive it;
// it was removed because the game is ad-funded and supporters seeing ads is not
// a problem worth spending ad revenue on. If it ever comes back, what that code
// got right is worth repeating: leave the AdSense tag in the static head where
// the reviewer fetches it, and failsafe-release on a timer, because ads stuck
// paused is silent revenue loss with no error anywhere.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HW = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

// ── The engine cannot see the flag ───────────────────────────────────────────
console.log('\n── no pay-to-win ─────────────────────────────────────────');

function walk(dir) {
  const out = [];
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(mjs|js|jsx)$/.test(f)) out.push(p);
  }
  return out;
}

test('packages/engine never reads isSupporter', () => {
  const files = walk(path.join(HW, 'packages/engine/src'));
  assert.ok(files.length > 20, `only found ${files.length} engine files — is the path right?`);
  const guilty = files.filter((f) => /isSupporter/.test(readFileSync(f, 'utf8')));
  assert.equal(guilty.length, 0,
    'the simulation must not be able to see who paid. Offending files:\n      '
    + guilty.map((f) => path.relative(HW, f)).join('\n      '));
});

test('the decision allow-list never accepts a supporter flag from a client', () => {
  const guard = readFileSync(path.join(HW, 'apps/headwinds-server/src/lib/decisionGuard.mjs'), 'utf8');
  assert.ok(!/isSupporter/.test(guard),
    'decisionGuard must not carry isSupporter — it is granted by an admin, never sent by a player');
});

// ── The in-game flag is injected, never stored ───────────────────────────────
// The full game UI (src/components/Competition.jsx) reads `state.accountSupporter`
// to put the chip on the player's OWN leaderboard row. Like the rival views
// beside it, that field is rebuilt on every read and tick — persisting it would
// write a badge into the save blob that could then go stale against a revoke,
// and stripRivals is what keeps it out.
console.log('\n── the in-game flag ──────────────────────────────────────');

const { withRivals, stripRivals } = await import('../apps/headwinds-server/src/lib/humanRivals.mjs');

test('withRivals stamps the player\'s own supporter flag onto game state', () => {
  const base = { cash: 1, airlineName: 'Test Air' };
  const on = withRivals(base, { competitors: [], humanRivals: {}, selfSupporter: true });
  assert.equal(on.accountSupporter, true, 'a supporter should be stamped onto their own state');
  const off = withRivals(base, { competitors: [], humanRivals: {}, selfSupporter: false });
  assert.equal(off.accountSupporter, false, 'a non-supporter must not be stamped');
  assert.equal(withRivals(base, undefined).accountSupporter, false, 'a missing view must not stamp a badge');
});

test('stripRivals keeps the flag out of the persisted blob', () => {
  const stamped = withRivals({ cash: 1 }, { competitors: [], humanRivals: {}, selfSupporter: true });
  const stored = stripRivals(stamped);
  assert.ok(!('accountSupporter' in stored),
    'accountSupporter must be stripped before writing — it is rebuilt every read, and a stored copy would survive a revoke');
  assert.ok(!('accountOG' in stored), 'the existing badge fields should still be stripped too');
  assert.equal(stored.cash, 1, 'stripRivals should leave real state alone');
});

// ── Nothing promises an ad-free game ─────────────────────────────────────────
// The ad-free perk was offered and then withdrawn before launch. The risk now is
// a leftover line somewhere still promising it — a support page or card that
// says "no ads" is a promise the game does not keep, and the player who paid for
// it has every right to be annoyed. Sweep every supporter-facing surface.
console.log('\n── no ad-free promise anywhere ───────────────────────────');

test('no supporter surface promises an ad-free game', () => {
  const surfaces = [
    'apps/headwinds-web/src/support.js',
    'apps/headwinds-web/src/SupportCard.jsx',
    'apps/headwinds-web/pages/support.html',
  ];
  const guilty = [];
  for (const rel of surfaces) {
    const txt = readFileSync(path.join(HW, rel), 'utf8');
    // "the ads stay on" and similar are fine; a PROMISE of removal is not.
    if (/no ads\b|ad-free|ads are off|ads switch off|without ads/i.test(txt)) guilty.push(rel);
  }
  assert.equal(guilty.length, 0, `these still promise an ad-free game:\n      ${guilty.join('\n      ')}`);
});

test('the ad loader is plain again — nothing pauses it', () => {
  const html = readFileSync(path.join(HW, 'apps/headwinds-web/play.html'), 'utf8');
  assert.ok(html.includes('adsbygoogle.js?client='), 'play.html must still load AdSense');
  assert.ok(!html.includes('pauseAdRequests'),
    'the gate is gone, so nothing should hold ad requests back for anyone');
});

console.log(`\n${failed ? 'FAIL' : 'PASS'} — ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
