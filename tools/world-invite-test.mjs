#!/usr/bin/env node
// World invites — a link a player can send that lands a friend IN that world.
//
//   node --import ./tools/_register-loader.mjs tools/world-invite-test.mjs
//
// Background (2026-10-14): every public world already had a page at
// /worlds/<id> with a join link, but three things broke the invite loop:
//   * Sign-in always returned to bare /play. A friend who opened
//     /play#/w/<id>, wasn't signed in yet (the usual case for an invite), and
//     clicked "Continue with Google" landed on the list of ALL worlds — the
//     world they were invited to was gone.
//   * Nothing in the game produced the link. A player had to know the public
//     page existed and copy its address by hand.
//   * The link preview read as a scoreboard ("Live Standings"), not an invite.
//
// Sections 1–2 fail on a HEAD without the fix (App.jsx's sign-in persists
// nothing; the helpers don't exist). Section 5 fails on HEAD's renderer.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HW  = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SRC = path.join(HW, 'apps/headwinds-web/src');

let failures = 0;
const fail = (msg) => { failures++; console.error(`  ✗ ${msg}`); };
const pass = (msg) => console.log(`  ✓ ${msg}`);
const check = (cond, okMsg, badMsg = okMsg) => (cond ? pass(okMsg) : fail(badMsg));

const memStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
};
const WID = 'cmufqpjqv009x1do1h8db7vx1';

// ── 1. The sign-in redirect keeps the world ──────────────────────────────────
console.log('\n1. Sign-in remembers the world it started from');
const app = readFileSync(path.join(SRC, 'App.jsx'), 'utf8');
const signIn = app.slice(app.indexOf('function SignIn('), app.indexOf('function JoinForm('));
const oauthBody = signIn.slice(signIn.indexOf('const oauth'), signIn.indexOf('signInWithOAuth'));
const otpBody = signIn.slice(signIn.indexOf('const magicLink'), signIn.indexOf('signInWithOtp'));
check(/rememberReturnRoute\(/.test(oauthBody), 'Google/Discord sign-in stores the current world route before redirecting',
  'Google/Discord sign-in redirects to bare /play and stores nothing — the invited world is lost');
check(/rememberReturnRoute\(/.test(otpBody), 'email-link sign-in stores the current world route before sending',
  'email-link sign-in redirects to bare /play and stores nothing — the invited world is lost');
check(/resumeAfterSignIn\(/.test(app.slice(app.indexOf('export default function App('))),
  'App resumes the remembered route once a session appears', 'App never reads a remembered route back');

let M = null;
try { M = await import(pathToFileURL(path.join(SRC, 'invite.js')).href); }
catch (e) { fail(`apps/headwinds-web/src/invite.js does not load: ${e.message}`); }

if (M) {
  // ── 2. remember / resume ────────────────────────────────────────────────────
  console.log('\n2. Remember → resume, one shot, validated, expiring');
  const t0 = Date.parse('2026-10-14T08:00:00Z');
  let s = memStorage();
  M.rememberReturnRoute(`#/w/${WID}`, s, t0);
  check(M.resumeAfterSignIn({ signedIn: false, screen: 'worlds', storage: s, now: t0 + 1000 }) === null,
    'nothing resumes before a session exists');
  check(M.resumeAfterSignIn({ signedIn: true, screen: 'worlds', storage: s, now: t0 + 60_000 }) === `/w/${WID}`,
    'after sign-in on the world list, the invited world lobby is the target');
  check(M.resumeAfterSignIn({ signedIn: true, screen: 'worlds', storage: s, now: t0 + 61_000 }) === null,
    'one shot: a second session event does not bounce the player again');

  s = memStorage();
  M.rememberReturnRoute(`#/w/${WID}/play`, s, t0);
  check(M.resumeAfterSignIn({ signedIn: true, screen: 'worlds', storage: s, now: t0 + 1 }) === `/w/${WID}/play`,
    'the in-game route survives too');

  s = memStorage();
  M.rememberReturnRoute(`#/w/${WID}`, s, t0);
  check(M.resumeAfterSignIn({ signedIn: true, screen: 'world', storage: s, now: t0 + 1 }) === null,
    'a player who already landed somewhere specific is not redirected…');
  check(s.getItem(M.RETURN_ROUTE_KEY) === null, '…and the stale entry is cleared anyway');

  s = memStorage();
  M.rememberReturnRoute(`#/w/${WID}`, s, t0);
  check(M.resumeAfterSignIn({ signedIn: true, screen: 'worlds', storage: s, now: t0 + M.RETURN_ROUTE_TTL_MS + 1 }) === null,
    'an abandoned sign-in from hours ago does not hijack a later visit');

  for (const junk of ['', '#/', '#/admin', '#/report', '#/players/abc', 'javascript:alert(1)', '#/w/../../x', `#/w/${WID}/play/extra`, '#/w/short']) {
    s = memStorage();
    M.rememberReturnRoute(junk, s, t0);
    if (s.getItem(M.RETURN_ROUTE_KEY) !== null) fail(`stored a non-world route: ${JSON.stringify(junk)}`);
  }
  pass('only #/w/<id> and #/w/<id>/play are ever stored');

  s = memStorage(); s.setItem(M.RETURN_ROUTE_KEY, JSON.stringify({ route: '#/admin', at: t0 }));
  check(M.resumeAfterSignIn({ signedIn: true, screen: 'worlds', storage: s, now: t0 + 1 }) === null,
    'a tampered stored value is re-validated on the way out');
  s = memStorage(); s.setItem(M.RETURN_ROUTE_KEY, '{not json');
  check(M.resumeAfterSignIn({ signedIn: true, screen: 'worlds', storage: s, now: t0 + 1 }) === null, 'garbage in storage is ignored');

  const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  let threw = false;
  try {
    M.rememberReturnRoute(`#/w/${WID}`, throwing, t0);
    M.resumeAfterSignIn({ signedIn: true, screen: 'worlds', storage: throwing, now: t0 });
    M.rememberReturnRoute(`#/w/${WID}`, null, t0);
    M.resumeAfterSignIn({ signedIn: true, screen: 'worlds', storage: null, now: t0 });
  } catch { threw = true; }
  check(!threw, 'blocked or missing storage (private mode) never breaks sign-in');

  // ── 3. Invite link + text ───────────────────────────────────────────────────
  console.log('\n3. Invite link and message');
  const pub = { id: WID, name: 'Timely Takeoff', status: 'RUNNING', visibility: 'PUBLIC', playerCount: 8, maxPlayers: 60, paceLabel: '1 week / 1 hr', startYear: 1950 };
  const priv = { ...pub, name: 'Friends Only', visibility: 'PRIVATE', supporterWorld: true, joinCode: 'hunter22' };
  check(M.worldInviteUrl(pub) === `https://www.headwindsairlinegame.com/worlds/${WID}`,
    'a public world shares its public page (rich preview, works signed out)');
  check(M.worldInviteUrl(priv) === `https://www.headwindsairlinegame.com/play#/w/${WID}`,
    'a private world shares the in-game lobby link (it has no public page)');
  const pubText = M.worldInviteText(pub);
  check(pubText.includes('Timely Takeoff') && pubText.includes('52 of 60'), 'public message names the world and the open seats');
  const privText = M.worldInviteText(priv);
  check(/password/i.test(privText) && !privText.includes('hunter22'), 'private message mentions a password but never includes it');
  check(/supporter/i.test(privText), 'supporter world says joiners need the badge');
  check(!M.worldInviteText({ ...pub, playerCount: undefined }).includes('undefined'), 'missing player count degrades cleanly');

  // ── 4. Share: native sheet → clipboard → manual ────────────────────────────
  console.log('\n4. Sharing falls back sensibly');
  let shared = null;
  let r = await M.shareWorldInvite(pub, { nav: { share: async (d) => { shared = d; } } });
  check(r.kind === 'shared' && shared?.url === M.worldInviteUrl(pub) && shared?.text, 'uses the native share sheet when there is one');
  r = await M.shareWorldInvite(pub, { nav: { share: async () => { const e = new Error('x'); e.name = 'AbortError'; throw e; } } });
  check(r.kind === 'cancelled', 'dismissing the share sheet is a cancel, not an error');
  let clip = null;
  r = await M.shareWorldInvite(pub, { nav: { clipboard: { writeText: async (t) => { clip = t; } } } });
  check(r.kind === 'copied' && clip?.includes(M.worldInviteUrl(pub)), 'desktop: copies message + link to the clipboard');
  r = await M.shareWorldInvite(pub, { nav: { share: async () => { throw new Error('NotAllowedError'); }, clipboard: { writeText: async (t) => { clip = t; } } } });
  check(r.kind === 'copied', 'a share sheet that fails for another reason falls back to copying');
  r = await M.shareWorldInvite(pub, { nav: {} });
  check(r.kind === 'manual' && r.url === M.worldInviteUrl(pub), 'no share, no clipboard: hands back the link to show for manual copy');

  // ── 4b. The real button, rendered ──────────────────────────────────────────
  const React = (await import('react')).default;
  const { renderToString } = await import('react-dom/server');
  const { default: InviteButton } = await import(pathToFileURL(path.join(SRC, 'InviteButton.jsx')).href);
  const card = renderToString(React.createElement(InviteButton, { world: pub }));
  check(/<button[^>]*>[^<]*Invite/.test(card), 'lobby button renders');
  const bar = renderToString(React.createElement(InviteButton, { worldId: WID, token: 't', variant: 'topbar' }));
  check(bar.includes('hw-lobby-link') && bar.includes('Invite'), 'top-bar variant renders with the top-bar link style');
  check(/<InviteButton[^>]*world=\{world\}/.test(app), 'world lobby shows the Invite button');
  const gp = readFileSync(path.join(SRC, 'GamePlayScreen.jsx'), 'utf8');
  check(/<InviteButton[^>]*worldId=\{worldId\}/.test(gp), 'in-game top bar shows the Invite button');
}

// ── 5. The preview reads as an invitation ────────────────────────────────────
console.log('\n5. World page preview');
const R = await import(pathToFileURL(path.join(HW, 'apps/headwinds-web/api/_lib/render.mjs')).href);
const w = (over = {}) => ({
  id: WID, name: 'Timely Takeoff', status: 'RUNNING', visibility: 'PUBLIC', lengthYears: 100, weeksPerDay: 24,
  paceLabel: '1 week / 1 hr', progress: { year: 6, week: 10, totalYears: 100, percent: 5 }, maxPlayers: 60,
  playerCount: 8, startYear: 1950, stage: 'beta', gateScarcity: false, newWorldRestrictions: false,
  crewPipeline: false, rivalItineraries: false, startedAt: '2026-09-01T00:00:00Z', createdAt: '2026-09-01T00:00:00Z', ...over,
});
const st = [{ rank: 1, name: 'Ajax Air', hub: 'PEK', marketCap: 1, cash: 1, routes: 1, fleet: 1, svps: 1, status: 'ACTIVE' }];
const meta = (html, prop) => (html.match(new RegExp(`<meta property="${prop}" content="([^"]*)"`)) ?? [])[1] ?? '';
const open = R.renderWorldPage({ detail: { world: w(), standings: st }, news: [] });
check(meta(open, 'og:title').includes('52 of 60 airline seats open'), `og:title leads with open seats ("${meta(open, 'og:title')}")`);
const d = meta(open, 'og:description');
check(d.includes('1 week / 1 hr') && d.includes('1950'), 'og:description carries pace and era start year');
check(/real person/i.test(d), 'og:description says rivals are real people');
check(open.includes('Discord'), 'join copy lists Discord sign-in');
const full = R.renderWorldPage({ detail: { world: w({ playerCount: 60 }), standings: st }, news: [] });
check(!/seats? open/i.test(meta(full, 'og:title')), 'a full world does not advertise seats');
const ended = R.renderWorldPage({ detail: { world: w({ status: 'ENDED' }), standings: st }, news: [] });
check(meta(ended, 'og:title').includes('Final Standings'), 'a concluded world keeps its Final Standings title');
const hostile = R.renderWorldPage({ detail: { world: w({ name: `<b>"X"</b>` }), standings: st }, news: [] });
check(!hostile.includes('<b>"X"</b>'), 'a hostile world name is escaped in the meta tags');

console.log(failures ? `\n${failures} failure(s)` : '\nAll world-invite checks passed');
process.exit(failures ? 1 : 0);
