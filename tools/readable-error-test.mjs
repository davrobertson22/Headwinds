// readableError — the one line an error is allowed to occupy on screen.
//
// 2026-08-25: Supabase's Cloudflare edge answered the sign-in call with a 522
// error PAGE. supabase-js put the entire HTML body into error.message, ErrorNote
// rendered String(error.message) verbatim, and the login card showed ~200 lines
// of raw HTML source (Donovan's Discord screenshot: "^Login button does this").
// Every error a player sees now goes through readableError, which collapses
// markup and walls of text into a line a human can act on.
//
//   node --import ./tools/_register-loader.mjs tools/readable-error-test.mjs

import assert from 'node:assert/strict';
import { readableError } from '../apps/headwinds-web/src/api.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; }
}

const FRIENDLY = /unexpected response/;

console.log('\nreadableError\n');

test('THE BUG: a Cloudflare 522 HTML page collapses to one friendly line', () => {
  const page = `<!DOCTYPE html>\n<html class="no-js" lang="en-US">\n<head><title>krlvgiupfftzdvtlpxor.supabase.co | 522: Connection timed out</title></head>\n<body>${'<div class="cf-error-details">'.repeat(50)}</body></html>`;
  const out = readableError(new Error(page));
  assert.match(out, FRIENDLY);
  assert.ok(!out.includes('<'), 'no markup may survive');
  assert.ok(out.length < 200, 'must be one line, not a page');
});

test('markup is caught even when the message does not start with it', () => {
  const out = readableError(new Error('error code 522 <html><body>Connection timed out</body></html>'));
  assert.match(out, FRIENDLY);
});

test('a wall of text longer than ~two sentences collapses too', () => {
  const out = readableError(new Error('x'.repeat(400)));
  assert.match(out, FRIENDLY);
});

test('a normal server message passes through untouched', () => {
  assert.equal(readableError(new Error('You have no airline in this world')),
    'You have no airline in this world');
});

test('a plain string error passes through', () => {
  assert.equal(readableError('Invalid join code'), 'Invalid join code');
});

test('angle brackets in a short game message are not markup', () => {
  assert.equal(readableError(new Error('Fare must be < $10,000')), 'Fare must be < $10,000');
});

test('null / message-less errors degrade to a generic line, never "[object Object]"', () => {
  assert.equal(readableError(null), 'Something went wrong.');
  const out = readableError({});
  assert.ok(!out.includes('[object'), out);
});

console.log(`\n${failed ? '❌' : '✅'}  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
