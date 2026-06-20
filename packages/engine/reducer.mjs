// @tailwinds/engine/reducer
// ----------------------------------------------------------------------------
// The pure, framework-free game reducer + initial-state factory.
//
// This is the SAME reducer the single-player game runs in the browser, with no
// React/DOM/localStorage dependencies — which is exactly why the Headwinds
// server can import and run it as the authoritative tick.
//
//   import { gameReducer, freshState } from '@tailwinds/engine/reducer';
//   let state = gameReducer(freshState(), { type: 'START_GAME', ... });
//   state = gameReducer(state, { type: 'ADVANCE_WEEK' });   // one game-week
//
// SCAFFOLD NOTE (transitional): today this re-exports the existing React-free
// reducer that already lives at src/store/_engine.generated.mjs. The "real"
// extraction step (Phase 0 in HEADWINDS_MULTIPLAYER_PLAN.md) is to make THIS
// file the single source of truth and have the solo app's React provider import
// the reducer from here, rather than defining it inline in GameContext.jsx.
// Until then, this facade lets the server and the golden-master harness depend
// on a stable engine entrypoint without touching the working solo app.
export { gameReducer, freshState } from '../../src/store/_engine.generated.mjs';
