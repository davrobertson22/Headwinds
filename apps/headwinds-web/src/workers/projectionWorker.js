// The projection worker: runs projectWeek for a state the client is about to
// adopt, so a rival poll or a new week never freezes the page for a full
// weekly tick. All logic lives in ../projectionWorkerCore.js.
import { createProjectionWorkerCore } from '../projectionWorkerCore.js';

const handle = createProjectionWorkerCore();
self.onmessage = (e) => {
  const reply = handle(e.data);
  if (reply) self.postMessage(reply);
};
