// SHIM — moved to @tailwinds/engine (Phase 0 engine extraction).
// The real module now lives in packages/engine/src/. This thin re-export keeps
// the solo app's existing import sites working unchanged. Repoint imports to
// '@tailwinds/engine' over time, then delete this shim.
export * from '../../packages/engine/src/models/demand.js';
