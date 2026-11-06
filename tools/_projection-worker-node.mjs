// worker_threads entry for tools/projection-worker-test.mjs: the browser
// worker's message loop, on Node's worker API. Not a test (no -test suffix).
import { parentPort } from 'node:worker_threads';
globalThis.window = globalThis.window ?? {};
globalThis.window.matchMedia = globalThis.window.matchMedia
  ?? (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
const { createProjectionWorkerCore } = await import('../apps/headwinds-web/src/projectionWorkerCore.js');
const handle = createProjectionWorkerCore();
parentPort.on('message', (msg) => {
  const reply = handle(msg);
  if (reply) parentPort.postMessage(reply);
});
parentPort.postMessage({ ready: true });
