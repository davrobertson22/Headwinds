// @not-a-test
// Bot lab — a report, not a test. Runs a world of bot-run airlines and prints how
// they did: fleet, revenue and profit at each year end, bankruptcies, and why the
// bots' decisions were refused. The harness is tools/bot-lab/harness.mjs; the bot
// is packages/engine/src/models/airlineBot.js; the plan is
// claude/background-competitors-plan.md.
//
//   node --import ./tools/_register-loader.mjs tools/bot-lab.mjs
//   node --import ./tools/_register-loader.mjs tools/bot-lab.mjs --world era1950 --bots 6 --years 5
//   node --import ./tools/_register-loader.mjs tools/bot-lab.mjs --world modern --params '{"maxPending":4}'
//   node --import ./tools/_register-loader.mjs tools/bot-lab.mjs --seed other-cycles --skip-hubs 5
//   node --import ./tools/_register-loader.mjs tools/bot-lab.mjs --years 6 --checkpoint /tmp/lab.json --budget 120   (repeat until done)
//
// Worlds: classic, modern, event737, era1950, lines (LAB_WORLDS in the harness).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createLab, stepLab, saveLab, loadLab, LAB_WORLDS } from './bot-lab/harness.mjs';

const args = process.argv.slice(2);
const opt = (flag, d) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : d; };
const world = opt('--world', 'modern'), bots = Number(opt('--bots', 8)), years = Number(opt('--years', 3)), tier = opt('--tier', 'cautious');
const params = opt('--params', null) ? JSON.parse(opt('--params')) : null;
const seed = opt('--seed', 'bot-lab'), skipHubs = Number(opt('--skip-hubs', 0));
if (!LAB_WORLDS[world]) { console.error(`Unknown world "${world}". One of: ${Object.keys(LAB_WORLDS).join(', ')}`); process.exit(1); }

const M = (v) => `${v < 0 ? '-' : ''}$${(Math.abs(v) / 1e6).toFixed(Math.abs(v) >= 1e8 ? 0 : 1)}M`;
// A long run in several sittings: --checkpoint FILE picks up where FILE left off,
// stops after --budget seconds of work, and saves. Run the same command again
// until it prints the final report.
const checkpoint = opt('--checkpoint', null), budget = Number(opt('--budget', 0));
const lab = checkpoint && existsSync(checkpoint) ? loadLab(readFileSync(checkpoint, 'utf8')) : createLab({ world, bots, tier, params, seed, skipHubs });
const t0 = Date.now();
console.log(`Bot lab: ${bots} ${tier} bots in a "${world}" world for ${years} year${years === 1 ? '' : 's'}${params ? ` (params ${JSON.stringify(params)})` : ''}`);
for (let w = lab.weeks + 1; w <= years * 52; w++) {
  if (budget > 0 && (Date.now() - t0) / 1000 > budget) { writeFileSync(checkpoint, saveLab(lab)); console.log(`\nPAUSED after week ${lab.weeks} of ${years * 52} — saved to ${checkpoint}; run the same command to continue.`); process.exit(0); }
  const week = await stepLab(lab);
  if (w % 52 !== 0) continue;
  const rows = Object.values(week.airlines); const alive = lab.airlines.filter((a) => a.status === 'ACTIVE').length;
  const yr = lab.series.slice(-52);
  console.log(`\nYear ${w / 52}: ${alive} of ${bots} flying`);
  console.log('  airline                   hub  fleet routes  revenue/wk  profit/wk (yr avg)     cash   load');
  for (const a of lab.airlines) {
    const last = yr.map((x) => x.airlines[a.id]).filter(Boolean); const v = last.at(-1);
    if (!v) { console.log(`  ${a.name.padEnd(25)} ${a.hub}  bankrupt in week ${a.bankruptWeek}`); continue; }
    const avg = last.reduce((s, x) => s + x.net, 0) / last.length;
    console.log(`  ${a.name.padEnd(25)} ${a.hub} ${String(v.fleet).padStart(6)} ${String(v.routes).padStart(6)} ${M(v.revenue).padStart(11)} ${M(avg).padStart(19)} ${M(v.cash).padStart(8)} ${v.loadFactor == null ? '    -' : (v.loadFactor * 100).toFixed(0).padStart(4) + '%'}${a.status !== 'ACTIVE' ? '  bankrupt wk ' + a.bankruptWeek : ''}`);
  }
  void rows;
}
const types = {}; for (const j of lab.journal) types[j.type] = (types[j.type] ?? 0) + 1;
const bot = lab.series.flatMap((w) => Object.values(w.airlines).map((v) => v.botMs)); const tick = lab.series.flatMap((w) => Object.values(w.airlines).map((v) => v.tickMs));
const avg = (a) => (a.reduce((s, x) => s + x, 0) / Math.max(1, a.length)).toFixed(1);
{
  const alive = lab.airlines.filter((a) => a.status === 'ACTIVE'); const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  const yr = lab.series.slice(-52); const avgNet = (a) => { const v = yr.map((x) => x.airlines[a.id]?.net).filter((n) => n != null); return v.length ? v.reduce((s, n) => s + n, 0) / v.length : 0; };
  console.log(`\nSUMMARY world=${world} seed=${seed} skip=${skipHubs} flying=${alive.length}/${bots} median-fleet=${med(alive.map((a) => a.state.fleet.length))} median-profit/wk=${M(med(alive.map(avgNet)))} total-fleet=${alive.reduce((s, a) => s + a.state.fleet.length, 0)} total-profit/wk=${M(alive.reduce((s, a) => s + avgNet(a), 0))} bankrupt-weeks=[${lab.airlines.filter((a) => a.status !== 'ACTIVE').map((a) => a.bankruptWeek).join(',')}]`);
}
console.log(`Decisions made: ${Object.entries(types).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);
console.log(`Decisions refused: ${Object.entries(lab.refusals).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${n}× ${k}`).join('; ') || 'none'}`);
console.log(`Bankruptcies: ${lab.airlines.filter((a) => a.status !== 'ACTIVE').length} of ${bots}`);
{ const { botStats } = await import('../packages/engine/src/models/airlineBot.js'); console.log(`Forecasts by purpose: ${Object.entries(botStats.by).map(([k, n]) => `${k} ${n}`).join(', ')}`); }
console.log(`Per airline per week: bot ${avg(bot)} ms (${((lab.forecasts ?? 0) / Math.max(1, bot.length)).toFixed(0)} forecasts), tick ${avg(tick)} ms. Whole run ${((Date.now() - t0) / 1000).toFixed(0)} s.`);
