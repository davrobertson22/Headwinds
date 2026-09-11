// The two things that make the supporter badge safe to sell.
//
//   node --import ./tools/_register-loader.mjs tools/supporter-perks-test.mjs
//
// 1. ADS. Supporters are promised no ads, so ad requests start paused in
//    play.html and src/ads.js decides. The dangerous failure is not a supporter
//    seeing an ad — it is ads staying paused FOREVER for everybody because the
//    app threw before it could resolve, which is silent revenue loss with no
//    error anywhere. The failsafe is tested here.
//
// 2. NO PAY-TO-WIN. `isSupporter` is cosmetic and must stay that way. This
//    asserts the shared engine cannot see it at all — not that we remembered to
//    be careful, but that the string does not appear in packages/engine. If a
//    future change makes the sim read it, this test is what says no.
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

// ── 1. The ad gate ───────────────────────────────────────────────────────────
// ads.js keeps module-level state (one decision per page load), so each case
// needs a fresh import. A cache-busting query gives us that.
const ADS = '../apps/headwinds-web/src/ads.js';
let freshCount = 0;
async function freshAds() {
  globalThis.window = { adsbygoogle: Object.assign([], { pauseAdRequests: 1 }) };
  return import(`${ADS}?fresh=${freshCount++}`);
}
const paused = () => globalThis.window.adsbygoogle.pauseAdRequests;

console.log('\n── the ad gate ───────────────────────────────────────────');

{
  const { resolveAds } = await freshAds();
  test('a supporter keeps ads paused', () => {
    resolveAds(true);
    assert.equal(paused(), 1, 'ads must stay paused for a supporter');
  });
}
{
  const { resolveAds } = await freshAds();
  test('everyone else gets ads released', () => {
    resolveAds(false);
    assert.equal(paused(), 0, 'ads must be released for a non-supporter');
  });
}
{
  const { resolveAds } = await freshAds();
  test('the first decision wins — a later /me refresh cannot flash ads at a supporter', () => {
    resolveAds(true);
    resolveAds(false);
    assert.equal(paused(), 1, 'a second resolve must not override the first');
  });
}
// The failsafe fires on a real 8s timer, which is far too slow to wait for and
// too important to assert loosely. ads.js reads setTimeout at CALL time, so the
// stub has to stay installed across the call, not just across the import —
// restoring it right after importing (the obvious way to write this) silently
// tests nothing. Holding the callback lets us fire it on demand and check the
// actual release path.
let armedCb = null, armedMs = null, cleared = false;
function withStubbedTimers(fn) {
  const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
  armedCb = null; armedMs = null; cleared = false;
  globalThis.setTimeout = (cb, ms) => { armedCb = cb; armedMs = ms; return 'T'; };
  globalThis.clearTimeout = (t) => { if (t === 'T') cleared = true; };
  try { return fn(); }
  finally { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; }
}

{
  const { armAdFailsafe } = await freshAds();
  test('the failsafe releases ads if the app never resolves', () => {
    withStubbedTimers(() => armAdFailsafe());
    assert.ok(armedCb, 'arming did not schedule anything — ads would stay paused forever');
    assert.ok(armedMs > 0 && armedMs <= 15000, `failsafe delay ${armedMs}ms is not a sane window`);
    assert.equal(paused(), 1, 'still paused while waiting');
    armedCb();
    assert.equal(paused(), 0, 'the failsafe must release ads when the app never resolved');
  });
}
{
  const mod = await freshAds();
  test('resolving disarms the failsafe, so it cannot later flash ads at a supporter', () => {
    withStubbedTimers(() => { mod.armAdFailsafe(); mod.resolveAds(true); });
    assert.equal(paused(), 1, 'supporter still ad-free after resolving');
    assert.ok(cleared, 'the pending failsafe timer was never cleared');
    if (armedCb) armedCb();
    assert.equal(paused(), 1, 'a stale failsafe must not release ads onto a supporter');
  });
}
{
  const { SUPPORTER_AD_FREE } = await freshAds();
  test('the kill switch exists and is a boolean', () => {
    assert.equal(typeof SUPPORTER_AD_FREE, 'boolean',
      'ads.js must expose a one-line switch to turn the whole ad gate off');
  });
}

// The pause has to actually be armed in the page, or ads.js is releasing
// something that was never held.
test('play.html arms the pause BEFORE loading adsbygoogle.js', () => {
  const html = readFileSync(path.join(HW, 'apps/headwinds-web/play.html'), 'utf8');
  const pause = html.indexOf('pauseAdRequests = 1');
  const loader = html.indexOf('adsbygoogle.js?client=');
  assert.ok(pause !== -1, 'play.html does not pause ad requests — supporters would see ads');
  assert.ok(loader !== -1, 'play.html no longer loads adsbygoogle.js at all');
  assert.ok(pause < loader, 'the pause must come before the loader or it arrives too late');
});

// ── 2. The engine cannot see the flag ────────────────────────────────────────
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

// ── 3. The in-game flag is injected, never stored ────────────────────────────
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

console.log(`\n${failed ? 'FAIL' : 'PASS'} — ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
