// A Route Finder forecast worker: prices finder rows off the main thread so the
// page stays responsive and several cores share the work. All logic lives in
// utils/finderForecastWorkerCore.js; this file only wires it to the worker.
import { createForecastWorkerCore } from '../utils/finderForecastWorkerCore.js';

const handle = createForecastWorkerCore();
self.onmessage = (e) => {
  const reply = handle(e.data);
  if (reply) self.postMessage(reply);
};
