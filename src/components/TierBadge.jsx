// Mega / major / regional badge, shared by the Airports tab's tables and lists.
export default function TierBadge({ tier }) {
  const cfg = {
    mega:     { bg: 'rgba(163,113,247,0.15)', color: '#a98bff', border: 'rgba(163,113,247,0.35)' },
    major:    { bg: 'rgba(56,139,253,0.15)',  color: '#3ea6ff', border: 'rgba(56,139,253,0.35)'  },
    regional: { bg: 'rgba(63,185,80,0.15)',   color: '#38d39f', border: 'rgba(63,185,80,0.35)'   },
  }[tier] ?? { bg: 'rgba(139,148,158,0.15)', color: '#93a4ba', border: 'rgba(139,148,158,0.35)' };
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3,
      background: cfg.bg, color: cfg.color,
      border: `1px solid ${cfg.border}`,
      textTransform: 'uppercase', letterSpacing: '0.06em',
    }}>
      {tier}
    </span>
  );
}
