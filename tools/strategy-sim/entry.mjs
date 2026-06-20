// Entry point for the bundled strategy simulation.
// Usage (after bundling): node bundle.mjs <runs> <horizonWeeks> [strategy]
import { runStrategy } from './harness.mjs';

const runs    = parseInt(process.argv[2] ?? '500', 10);
const horizon = parseInt(process.argv[3] ?? '780', 10);
const only    = process.argv[4]; // optional single strategy

const strategies = only ? [only] : ['lean', 'aggressive', 'hub', 'acquire'];

const results = [];
for (const s of strategies) {
  const t0 = Date.now();
  const r = runStrategy(s, { runs, horizonWeeks: horizon });
  r.seconds = +((Date.now() - t0) / 1000).toFixed(1);
  results.push(r);
  // progress line to stderr so it doesn't pollute JSON on stdout
  process.stderr.write(`[done] ${s}: 2yr=${(r.survive2yr*100).toFixed(1)}% 5yr=${(r.survive5yr*100).toFixed(1)}% win=${(r.winRate*100).toFixed(1)}% (${r.seconds}s)\n`);
}

process.stdout.write(JSON.stringify(results, null, 2));
