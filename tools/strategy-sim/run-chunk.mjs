// Run one chunk of games and append aggregate counts to a JSONL results file.
// Usage: node run-chunk.mjs <strategy> <startSeed> <count> <horizonWeeks> <outFile>
// Chunking keeps each invocation within the sandbox's per-call time limit; the
// caller aggregates the JSONL lines across chunks.
import { appendFileSync } from 'fs';
import { playGame } from './harness.mjs';

const [strategy, startSeedS, countS, horizonS, outFile] = process.argv.slice(2);
const startSeed = parseInt(startSeedS, 10);
const count     = parseInt(countS, 10);
const horizon   = parseInt(horizonS, 10);

let s2 = 0, s5 = 0, wins = 0, bank = 0;
const deathWeeks = [];
const survivorCash = [];
for (let i = 0; i < count; i++) {
  const r = playGame(strategy, startSeed + i, horizon);
  if (r.survived2) s2++;
  if (r.survived5) s5++;
  if (r.won) wins++;
  if (r.bankruptWeek != null) { bank++; deathWeeks.push(r.bankruptWeek); }
  else survivorCash.push(Math.round(r.finalCash));
}
const line = JSON.stringify({ strategy, startSeed, count, s2, s5, wins, bank, deathWeeks, survivorCash });
appendFileSync(outFile, line + '\n');
process.stdout.write(line + '\n');
