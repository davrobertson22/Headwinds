import { useSyncExternalStore } from 'react';
import { navFavourites, subscribeNavFavourites } from '../utils/navFavourites.js';

/**
 * The pinned shortcuts, live — a star clicked in one dropdown has to show up on
 * the bar at once. Client and server snapshots are the same read, as in
 * useRecentAirports: the UI suites shim localStorage and must see real pins.
 */
export default function useNavFavourites() {
  const read = () => navFavourites();
  return useSyncExternalStore(subscribeNavFavourites, read, read);
}
