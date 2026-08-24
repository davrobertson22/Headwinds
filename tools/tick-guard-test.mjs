// tick-guard-test.mjs — the worker watchdog (src/lib/tickGuard.mjs).
//
// Guards the 2026-08-23 failure mode: a tick pass hung forever on a dead pooled
// connection, `ticking` stayed true, and the worker sat silent (but "healthy")
// for 17.5 hours. The guard must (1) report a wedged pass exactly once so the
// worker can exit for a platform restart, (2) never fire on passes that finish
// inside the budget, and (3) emit heartbeats so silence is visible in the logs.
import assert from 'node:assert/strict';
import { createTickGuard } from '../apps/headwinds-server/src/lib/tickGuard.mjs';

let t = 0;
const clock = () => t;
const mk = (opts = {}) => {
  const events = [];
  const guard = createTickGuard({
    wedgeMs: 60_000,
    heartbeatMs: 300_000,
    onWedge: (e) => events.push(['wedge', e]),
    onHeartbeat: (e) => events.push(['beat', e]),
    now: clock,
    ...opts,
  });
  return { guard, events };
};

let pass = 0;
const ok = (name) => { pass++; console.log('  ok - ' + name); };

// 1. A pass that finishes inside the budget never wedges.
{
  t = 0; const { guard, events } = mk();
  guard.beginPass(); t = 30_000; assert.deepEqual(guard.check(), { ok: true });
  guard.endPass(); t = 90_000;
  const r = guard.check();
  assert.ok(!r.wedged, 'idle guard must not wedge');
  assert.equal(events.filter(e => e[0] === 'wedge').length, 0);
  ok('pass finishing inside the budget does not wedge');
}

// 2. A hung pass wedges once it overruns — and only once.
{
  t = 0; const { guard, events } = mk();
  guard.beginPass();
  t = 59_999; assert.ok(!guard.check().wedged, 'must not fire early');
  t = 60_000;
  const r = guard.check();
  assert.equal(r.wedged, true);
  assert.equal(r.elapsedMs, 60_000);
  t = 120_000; guard.check(); guard.check();
  assert.equal(events.filter(e => e[0] === 'wedge').length, 1, 'wedge fires once per pass');
  ok('hung pass wedges at the budget, exactly once');
}

// 3. endPass() re-arms: a later pass can wedge again.
{
  t = 0; const { guard, events } = mk();
  guard.beginPass(); t = 61_000; guard.check();
  guard.endPass();
  guard.beginPass(); t = 130_000;
  assert.equal(guard.check().wedged, true);
  assert.equal(events.filter(e => e[0] === 'wedge').length, 2);
  ok('a new pass re-arms the wedge');
}

// 4. Heartbeats fire on schedule, whether idle or mid-pass, and carry state.
{
  t = 0; const { guard, events } = mk({ wedgeMs: 10_000_000 });
  t = 300_000;
  assert.equal(guard.check().heartbeat, true);
  assert.equal(events.at(-1)[1].running, false);
  assert.equal(events.at(-1)[1].idleMs, 300_000);
  t = 300_001; assert.ok(!guard.check().heartbeat, 'not due again yet');
  guard.beginPass(); t = 600_000;
  assert.equal(guard.check().heartbeat, true);
  assert.equal(events.at(-1)[1].running, true);
  assert.equal(events.at(-1)[1].elapsedMs, 600_000 - 300_001);
  assert.equal(events.at(-1)[1].passes, 1);
  ok('heartbeat fires on schedule with honest state');
}

// 5. A wedge outranks a due heartbeat (the exit must not be masked).
{
  t = 0; const { guard, events } = mk();
  guard.beginPass(); t = 400_000; // both wedge and heartbeat overdue
  assert.equal(guard.check().wedged, true);
  assert.equal(events.at(-1)[0], 'wedge');
  ok('wedge outranks a due heartbeat');
}

// 6. Config guard: wedgeMs is mandatory.
{
  assert.throws(() => createTickGuard({}), /wedgeMs/);
  assert.throws(() => createTickGuard({ wedgeMs: 0 }), /wedgeMs/);
  ok('refuses a missing or zero wedge budget');
}

console.log(`tick-guard-test: ${pass}/6 passed`);
