// Centralized environment loading + validation.
// Loads .env (local dev) and fails fast with a clear message if a required var is
// missing — better than a cryptic crash deep in a request handler.
import 'dotenv/config';

function required(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(
      `Missing required env var ${name}. Copy apps/headwinds-server/.env.example ` +
      `to .env and fill it in (or set it in your host's config).`
    );
  }
  return v.trim();
}

function optional(name, fallback) {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

export const env = {
  // Postgres
  databaseUrl: required('DATABASE_URL'),
  // Supabase Auth
  supabaseUrl: required('SUPABASE_URL'),
  supabaseAnonKey: required('SUPABASE_ANON_KEY'),
  // Server
  port: Number(optional('PORT', '8787')),
  corsOrigins: optional('CORS_ORIGINS', 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  // Spawner
  spawnIntervalMinutes: Number(optional('SPAWN_INTERVAL_MINUTES', '30')),
  spawnTargetOpenWorlds: Number(optional('SPAWN_TARGET_OPEN_WORLDS', '4')),
  spawnYoungThresholdHours: Number(optional('SPAWN_YOUNG_THRESHOLD_HOURS', '48')),
};
