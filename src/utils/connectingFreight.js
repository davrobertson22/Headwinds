// Tooltip text for freight connecting through your network (simulateCargoNetwork):
// shared by the freight table, the freight planner and the fleet card.
import { formatMoney } from './simulation.js';

export function connectingFreightTitle(sim) {
  const feeds = sim?.feeds ?? [];
  const lines = feeds.slice(0, 8).map(f => {
    const [o, d] = f.od.split('-');
    return `${o}–${d} via ${f.via}: ${f.tonnes.toLocaleString()} t · ${formatMoney(f.revenue)}`;
  });
  if (feeds.length > 8) lines.push(`…and ${feeds.length - 8} more`);
  return `Connecting freight: ${sim.connectingTonnes.toLocaleString()} t/wk on top of `
    + `${(sim.localTonnes ?? 0).toLocaleString()} t of this lane's own freight. `
    + `It fills payload the local freight leaves empty, and this leg's share of its revenue is by distance.\n\n`
    + lines.join('\n');
}
