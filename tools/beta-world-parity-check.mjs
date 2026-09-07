// beta-world-parity-check.mjs — runs the second golden master so the suite
// cannot forget it: a world with the hub-connectivity package OFF (every
// existing Headwinds beta world) must tick byte-for-byte as the engine did
// before the package existed. See tools/golden-master/beta-world.mjs.
//
//   node tools/beta-world-parity-check.mjs
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
try {
  const out = execFileSync(process.execPath, [path.join(here, 'golden-master', 'beta-world.mjs')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  process.stdout.write(out);
  console.log('  ✓ beta-world parity');
} catch (e) {
  process.stdout.write(e.stdout ?? '');
  process.stderr.write(e.stderr ?? '');
  console.error('  ✗ beta-world parity — something reached a flag-off world (or a change meant for the betas needs a stated re-baseline)');
  process.exit(1);
}
