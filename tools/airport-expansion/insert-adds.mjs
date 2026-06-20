#!/usr/bin/env node
/**
 * insert-adds.mjs — splice ADD-verdict airports from a scored CSV into
 * src/data/airports.js, just before the AIRPORTS array closes.
 *
 * Usage: node insert-adds.mjs scored-all.csv
 * Idempotency: skips any code already present in airports.js.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const scoredPath = process.argv[2] || 'scored-all.csv';
const airportsPath = path.resolve(__dir, '../../src/data/airports.js');

// ── parse scored CSV ─────────────────────────────────────────────────────────
const rows = fs.readFileSync(scoredPath, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
const header = rows.shift().split(',');
const H = Object.fromEntries(header.map((h, i) => [h, i]));
// CSV can contain quoted fields with commas — minimal CSV parse:
function parseLine(line) {
  const out = []; let cur = '', q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === ',' && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur); return out;
}
const adds = rows.map(parseLine).filter(c => c[H.verdict] === 'ADD');

// ── current file + existing codes ────────────────────────────────────────────
let src = fs.readFileSync(airportsPath, 'utf8');
const existing = new Set([...src.matchAll(/\bcode:\s*'([A-Z0-9]{3})'/g)].map(m => m[1]));

// ── build objects, grouped by country ────────────────────────────────────────
const byCountry = {};
let added = 0, skipped = 0;
for (const c of adds) {
  const code = c[H.code];
  if (existing.has(code)) { skipped++; continue; }
  const country = c[H.country];
  const pop = +c[H.population];
  const leisure = +c[H.leisure] === 1;
  const tier = pop >= 6 ? 'major' : 'regional';
  const visitors = leisure ? (pop < 0.5 ? 0.6 : 0.3) : 0;
  (byCountry[country] ??= []).push({
    code, name: c[H.name].replace(/"/g, ''), city: c[H.city].replace(/"/g, ''),
    country, lat: +c[H.lat], lon: +c[H.lon], population: pop, tier, visitors,
  });
  added++;
}

// ── format JS lines ──────────────────────────────────────────────────────────
const q = s => `'${String(s).replace(/'/g, "\\'")}'`;
const fmt = a => {
  let s = `  { code: ${q(a.code)}, name: ${q(a.name)}, city: ${q(a.city)}, country: ${q(a.country)}, lat: ${a.lat}, lon: ${a.lon}, population: ${a.population}`;
  if (a.visitors) s += `, visitors: ${a.visitors}`;
  s += `, tier: ${q(a.tier)} },`;
  return s;
};
const today = new Date().toISOString().slice(0, 10);
let block = `\n  // ══════════════════════════════════════════════════════════════════════════\n` +
            `  // EXPANSION WAVE (${today}) — ${added} airports added via tools/airport-expansion\n` +
            `  // (tiered scorer: distinct + viable against the live gravity model)\n` +
            `  // ══════════════════════════════════════════════════════════════════════════\n`;
for (const country of Object.keys(byCountry).sort()) {
  block += `  // ── ${country} ──\n`;
  for (const a of byCountry[country].sort((x, y) => y.population - x.population)) block += fmt(a) + '\n';
}

// ── splice before the AIRPORTS array close ───────────────────────────────────
// The AIRPORTS array is the first top-level `\n];` in the file.
const closeIdx = src.indexOf('\n];');
if (closeIdx === -1) { console.error('Could not find AIRPORTS array close'); process.exit(1); }
src = src.slice(0, closeIdx) + '\n' + block + src.slice(closeIdx + 1);
fs.writeFileSync(airportsPath, src);
console.log(`Inserted ${added} airports (skipped ${skipped} already present) across ${Object.keys(byCountry).length} countries.`);
