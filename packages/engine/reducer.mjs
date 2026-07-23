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
// The canonical reducer now physically lives at ./src/reducer.mjs (extracted
// from the solo app's GameContext.jsx, which was the authoritative logic). The
// solo app's React provider and the multiplayer server both import from here, so
// they can never silently diverge. This file is a thin entrypoint over it.
export { gameReducer, freshState, reconcileState, gateLeaseDenial } from './src/reducer.mjs';
