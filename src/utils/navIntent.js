/**
 * Deep links between tabs, with the filter the destination should arrive under.
 *
 * The Dashboard's alert strip names problems ("3 loss-making routes", "2 leases
 * expire within 8 weeks") that live on other tabs. Sending the player to Routes
 * and leaving them to re-derive the filter is most of the work; the alert
 * should land them ON the filtered list.
 *
 * Two halves, because a tab switch UNMOUNTS the caller and MOUNTS the target:
 *
 *   requestNav(tab, { filter })  parks the intent and fires 'hw:navigate',
 *                                which App.jsx already listens for.
 *   consumeNavFilter(tab)        the target reads its filter once, on mount.
 *
 * The park is what makes it work — the target component does not exist yet when
 * the event fires, so an event listener alone would never hear it. Reading is
 * destructive so a later manual visit to the same tab is not re-filtered.
 */

let pending = null;

/**
 * Ask the shell to switch tabs.
 *
 * @param {string} tab    tab id, e.g. 'routes'
 * @param {object} [opts]
 * @param {string} [opts.focus]   element id to scroll to and flash on arrival
 * @param {object} [opts.filter]  destination-specific filter state, consumed by
 *                                the target tab via consumeNavFilter()
 */
export function requestNav(tab, opts = {}) {
  const { focus = null, filter = null } = opts;
  pending = filter ? { tab, filter } : null;
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('hw:navigate', {
    detail: focus ? { tab, focus } : { tab },
  }));
}

/**
 * Take the filter parked for this tab, if any. Returns null when the player
 * arrived by clicking the nav themselves.
 */
export function consumeNavFilter(tab) {
  if (!pending || pending.tab !== tab) return null;
  const { filter } = pending;
  pending = null;
  return filter;
}

/**
 * Read the intent parked for this tab WITHOUT taking it.
 *
 * A tab that hands the intent straight on to a child needs to look before that
 * child exists — the Route Planner has to switch itself into freight mode, but
 * CargoRoutePlanner is the component that owns the airports and must be the one
 * to consume them. Peeking leaves the intent in place for whoever consumes it.
 */
export function peekNavFilter(tab) {
  if (!pending || pending.tab !== tab) return null;
  return pending.filter;
}

/** Test seam: drop any parked intent. */
export function clearNavIntent() {
  pending = null;
}
