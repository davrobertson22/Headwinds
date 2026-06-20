// In-memory world store — a placeholder for Postgres.
//
// SCAFFOLD NOTE: this keeps worlds in process memory so the demo runs with zero
// infra. For the real server, swap this module for a Postgres-backed store
// (worlds table + airlines table with a JSONB `state` column, per the schema in
// HEADWINDS_MULTIPLAYER_PLAN.md §8). The rest of the server code stays the same
// because it only talks to this interface — never to memory directly.
const worlds = new Map();

export const store = {
  put(world) { worlds.set(world.id, world); return world; },
  get(id) { return worlds.get(id); },
  list() { return [...worlds.values()].map((w) => ({ id: w.id, name: w.name, status: w.status, week: w.week, year: w.year, players: w.airlines.size })); },
};
