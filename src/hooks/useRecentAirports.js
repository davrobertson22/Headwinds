import { useSyncExternalStore } from 'react';
import { recentAirports, subscribeRecentAirports } from '../utils/airportRecents.js';

/**
 * The player's recent airport picks, live.
 *
 * Every picker in the game reads this, so one pick in the Route Finder has to
 * reorder the Route Planner's dropdown without a reload — hence a subscription
 * rather than a useState seeded on mount.
 *
 * Client and server snapshots are the SAME read on purpose. There is no real
 * SSR here (the game is a Vite SPA), so "server" means the UI suites, which
 * shim localStorage and would otherwise render a picker whose recent group is
 * permanently empty — a test that can only ever agree with itself. Off a real
 * server the read finds no localStorage and returns the shared frozen empty
 * list, which is the correct answer there too.
 */
export default function useRecentAirports() {
  const read = () => recentAirports();
  return useSyncExternalStore(subscribeRecentAirports, read, read);
}
