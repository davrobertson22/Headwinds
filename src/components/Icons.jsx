// SVG icon components for nav and UI

export function HubIcon({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
      <circle cx="12" cy="4"  r="2" />
      <circle cx="20" cy="12" r="2" />
      <circle cx="12" cy="20" r="2" />
      <circle cx="4"  cy="12" r="2" />
      <line x1="12" y1="7"  x2="12" y2="9"  />
      <line x1="17" y1="12" x2="15" y2="12" />
      <line x1="12" y1="15" x2="12" y2="17" />
      <line x1="7"  y1="12" x2="9"  y2="12" />
    </svg>
  );
}

export function DashboardIcon({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" style={{ flexShrink: 0 }}>
      <rect x="3" y="14" width="4" height="7" rx="1" />
      <rect x="10" y="9" width="4" height="12" rx="1" />
      <rect x="17" y="3" width="4" height="18" rx="1" />
    </svg>
  );
}

export function RoutesIcon({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <circle cx="5" cy="12" r="2.5" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="2.5" fill="currentColor" stroke="none" />
      <path d="M7.5 12 Q12 5 16.5 12" strokeDasharray="2 2" />
      <path d="M7.5 12 Q12 19 16.5 12" />
    </svg>
  );
}

export function FleetIcon({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" style={{ flexShrink: 0 }}>
      <path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z" />
    </svg>
  );
}

export function MarketIcon({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z" />
      <line x1="3" y1="6" x2="21" y2="6" />
      <path d="M16 10a4 4 0 01-8 0" />
    </svg>
  );
}

export function FinanceIcon({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <line x1="12" y1="1" x2="12" y2="23" />
      <path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />
    </svg>
  );
}

export function CompetitionIcon({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 00-3-3.87" />
      <path d="M16 3.13a4 4 0 010 7.75" />
    </svg>
  );
}

export function GateIcon({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <rect x="2" y="10" width="14" height="11" rx="1" />
      <path d="M16 15h4a1 1 0 011 1v5" />
      <rect x="5"  y="13" width="2.5" height="3" rx="0.5" fill="currentColor" stroke="none" opacity="0.5" />
      <rect x="10" y="13" width="2.5" height="3" rx="0.5" fill="currentColor" stroke="none" opacity="0.5" />
    </svg>
  );
}

export function OperationsIcon({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" />
    </svg>
  );
}

export function PlannerIcon({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <line x1="9" y1="9" x2="9" y2="21" />
    </svg>
  );
}

export function PlaneIcon({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" style={{ flexShrink: 0 }}>
      <path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z" />
    </svg>
  );
}


export function RepIcon({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" style={{ flexShrink: 0 }}>
      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
    </svg>
  );
}

export function LoyaltyIcon({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
    </svg>
  );
}


// ============================================================
//  Lucide line icons (lucide.dev, ISC license) — 24x24 stroke
//  grid, matching the nav icons above. Used to replace emoji.
// ============================================================

function LI({ size = 15, fill = 'none', children }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, verticalAlign: '-0.125em' }}>
      {children}
    </svg>
  );
}

export function DotIcon({ size = 15 }) {
  return <LI size={size} fill="currentColor"><circle cx="12" cy="12" r="6" stroke="none" /></LI>;
}

export function PackageIcon({ size = 15 }) {
  return <LI size={size}><path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><path d="m3.3 7 7.703 4.734a2 2 0 0 0 1.994 0L20.7 7"/><path d="m7.5 4.27 9 5.15"/></LI>;
}

export function AlertIcon({ size = 15 }) {
  return <LI size={size}><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></LI>;
}

export function WrenchIcon({ size = 15 }) {
  return <LI size={size}><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></LI>;
}

export function GlobeIcon({ size = 15 }) {
  return <LI size={size}><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></LI>;
}

export function GemIcon({ size = 15 }) {
  return <LI size={size}><path d="M6 3h12l4 6-10 13L2 9Z"/><path d="M11 3 8 9l4 13 4-13-3-6"/><path d="M2 9h20"/></LI>;
}

export function BulbIcon({ size = 15 }) {
  return <LI size={size}><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></LI>;
}

export function SwordsIcon({ size = 15 }) {
  return <LI size={size}><polyline points="14.5 17.5 3 6 3 3 6 3 17.5 14.5"/><line x1="13" x2="19" y1="19" y2="13"/><line x1="16" x2="20" y1="16" y2="20"/><line x1="19" x2="21" y1="21" y2="19"/><polyline points="14.5 6.5 18 3 21 3 21 6 17.5 9.5"/><line x1="5" x2="9" y1="14" y2="18"/><line x1="7" x2="4" y1="17" y2="20"/><line x1="3" x2="5" y1="19" y2="21"/></LI>;
}

export function UsersIcon({ size = 15 }) {
  return <LI size={size}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></LI>;
}

export function BuildingIcon({ size = 15 }) {
  return <LI size={size}><path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/><path d="M10 18h4"/></LI>;
}

export function TargetIcon({ size = 15 }) {
  return <LI size={size}><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></LI>;
}

export function TrophyIcon({ size = 15 }) {
  return <LI size={size}><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></LI>;
}

export function BanknoteIcon({ size = 15 }) {
  return <LI size={size}><rect width="20" height="12" x="2" y="6" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/></LI>;
}

export function TrendUpIcon({ size = 15 }) {
  return <LI size={size}><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></LI>;
}

export function TrendDownIcon({ size = 15 }) {
  return <LI size={size}><polyline points="22 17 13.5 8.5 8.5 13.5 2 7"/><polyline points="16 17 22 17 22 11"/></LI>;
}

export function CalendarIcon({ size = 15 }) {
  return <LI size={size}><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/></LI>;
}

export function StarIcon({ size = 15 }) {
  return <LI size={size}><path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/></LI>;
}

export function BanIcon({ size = 15 }) {
  return <LI size={size}><circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/></LI>;
}

export function ScissorsIcon({ size = 15 }) {
  return <LI size={size}><circle cx="6" cy="6" r="3"/><path d="M8.12 8.12 12 12"/><path d="M20 4 8.12 15.88"/><circle cx="6" cy="18" r="3"/><path d="M14.8 14.8 20 20"/></LI>;
}

export function CheckIcon({ size = 15 }) {
  return <LI size={size}><path d="M20 6 9 17l-5-5"/></LI>;
}

export function CloseIcon({ size = 15 }) {
  return <LI size={size}><path d="M18 6 6 18"/><path d="m6 6 12 12"/></LI>;
}

export function CircleCheckIcon({ size = 15 }) {
  return <LI size={size}><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></LI>;
}

export function CircleXIcon({ size = 15 }) {
  return <LI size={size}><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></LI>;
}

export function TakeoffIcon({ size = 15 }) {
  return <LI size={size}><path d="M2 22h20"/><path d="M6.36 17.4 4 17l-2-4 1.1-.55a2 2 0 0 1 1.8 0l.17.1a2 2 0 0 0 1.8 0L8 12 5 6l.9-.45a2 2 0 0 1 2.09.2l4.02 3a2 2 0 0 0 2.1.2l4.19-2.06a2.41 2.41 0 0 1 1.73-.17L21 7a1.4 1.4 0 0 1 .87 1.99l-.38.76c-.23.46-.6.84-1.07 1.08L7.58 17.2a2 2 0 0 1-1.22.18Z"/></LI>;
}

export function SaveIcon({ size = 15 }) {
  return <LI size={size}><path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/></LI>;
}

export function FolderOpenIcon({ size = 15 }) {
  return <LI size={size}><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></LI>;
}

export function FuelIcon({ size = 15 }) {
  return <LI size={size}><line x1="3" x2="15" y1="22" y2="22"/><line x1="4" x2="14" y1="9" y2="9"/><path d="M14 22V4a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v18"/><path d="M14 13h2a2 2 0 0 1 2 2v2a2 2 0 0 0 2 2a2 2 0 0 0 2-2V9.83a2 2 0 0 0-.59-1.42L18 5"/></LI>;
}

export function SeatIcon({ size = 15 }) {
  return <LI size={size}><path d="M19 9V6a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v3"/><path d="M3 16a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5a2 2 0 0 0-4 0v1.5a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5V11a2 2 0 0 0-4 0z"/><path d="M5 18v2"/><path d="M19 18v2"/></LI>;
}

export function CartIcon({ size = 15 }) {
  return <LI size={size}><circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/></LI>;
}

export function PenIcon({ size = 15 }) {
  return <LI size={size}><path d="M12 20h9"/><path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z"/></LI>;
}

export function HouseIcon({ size = 15 }) {
  return <LI size={size}><path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></LI>;
}

export function MedalIcon({ size = 15 }) {
  return <LI size={size}><path d="M7.21 15 2.66 7.14a2 2 0 0 1 .13-2.2L4.4 2.8A2 2 0 0 1 6 2h12a2 2 0 0 1 1.6.8l1.6 2.14a2 2 0 0 1 .14 2.2L16.79 15"/><path d="M11 12 5.12 2.2"/><path d="m13 12 5.88-9.8"/><path d="M8 7h8"/><circle cx="12" cy="17" r="5"/><path d="M12 18v-2h-.5"/></LI>;
}

export function UserIcon({ size = 15 }) {
  return <LI size={size}><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></LI>;
}

export function LinkIcon({ size = 15 }) {
  return <LI size={size}><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></LI>;
}

export function PalmIcon({ size = 15 }) {
  return <LI size={size}><path d="M13 8c0-2.76-2.46-5-5.5-5S2 5.24 2 8h2l1-1 1 1h4"/><path d="M13 7.14A5.82 5.82 0 0 1 16.5 6c3.04 0 5.5 2.24 5.5 5h-3l-1-1-1 1h-3"/><path d="M5.89 9.71c-2.15 2.15-2.3 5.47-.35 7.43l4.24-4.25.7-.7.71-.71 2.12-2.12c-1.95-1.96-5.27-1.8-7.42.35"/><path d="M11 15.5c.5 2.5-.17 4.5-1 6.5h4c2-5.5-.5-12-1-14"/></LI>;
}

export function BriefcaseIcon({ size = 15 }) {
  return <LI size={size}><path d="M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/><rect width="20" height="14" x="2" y="6" rx="2"/></LI>;
}

export function RefreshIcon({ size = 15 }) {
  return <LI size={size}><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></LI>;
}

export function RepeatIcon({ size = 15 }) {
  return <LI size={size}><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></LI>;
}

export function MegaphoneIcon({ size = 15 }) {
  return <LI size={size}><path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/></LI>;
}

export function MapIcon({ size = 15 }) {
  return <LI size={size}><path d="M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z"/><path d="M15 5.764v15"/><path d="M9 3.236v15"/></LI>;
}

export function SearchIcon({ size = 15 }) {
  return <LI size={size}><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></LI>;
}

export function RulerIcon({ size = 15 }) {
  return <LI size={size}><path d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Z"/><path d="m14.5 12.5 2-2"/><path d="m11.5 9.5 2-2"/><path d="m8.5 6.5 2-2"/><path d="m17.5 15.5 2-2"/></LI>;
}

export function BarChartIcon({ size = 15 }) {
  return <LI size={size}><path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></LI>;
}

export function WindIcon({ size = 15 }) {
  return <LI size={size}><path d="M12.8 19.6A2 2 0 1 0 14 16H2"/><path d="M17.5 8a2.5 2.5 0 1 1 2 4H2"/><path d="M9.8 4.4A2 2 0 1 1 11 8H2"/></LI>;
}

export function SettingsIcon({ size = 15 }) {
  return <LI size={size}><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></LI>;
}

export function HandshakeIcon({ size = 15 }) {
  return <LI size={size}><path d="m11 17 2 2a1 1 0 1 0 3-3"/><path d="m14 14 2.5 2.5a1 1 0 1 0 3-3l-3.88-3.88a3 3 0 0 0-4.24 0l-.88.88a1 1 0 1 1-3-3l2.81-2.81a5.79 5.79 0 0 1 7.06-.87l.47.28a2 2 0 0 0 1.42.25L21 4"/><path d="m21 3 1 11h-2"/><path d="M3 3 2 14l6.5 6.5a1 1 0 1 0 3-3"/><path d="M3 4h8"/></LI>;
}

export function LockIcon({ size = 15 }) {
  return <LI size={size}><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></LI>;
}

export function ShieldIcon({ size = 15 }) {
  return <LI size={size}><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/></LI>;
}

export function CompassIcon({ size = 15 }) {
  return <LI size={size}><path d="m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z"/><circle cx="12" cy="12" r="10"/></LI>;
}

export function ClipboardIcon({ size = 15 }) {
  return <LI size={size}><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/></LI>;
}

export function TelescopeIcon({ size = 15 }) {
  return <LI size={size}><path d="m10.065 12.493-6.18 1.318a.934.934 0 0 1-1.108-.702l-.537-2.15a1.07 1.07 0 0 1 .691-1.265l13.504-4.44"/><path d="m13.56 11.747 4.332-.924"/><path d="m16 21-3.105-6.21"/><path d="M16.485 5.94a2 2 0 0 1 1.455-2.425l1.09-.272a1 1 0 0 1 1.212.727l1.515 6.06a1 1 0 0 1-.727 1.213l-1.09.272a2 2 0 0 1-2.425-1.455z"/><path d="m6.158 8.633 1.114 4.456"/><path d="m8 21 3.105-6.21"/><circle cx="12" cy="13" r="2"/></LI>;
}

export function ScaleIcon({ size = 15 }) {
  return <LI size={size}><path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="M7 21h10"/><path d="M12 3v18"/><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/></LI>;
}

export function LandmarkIcon({ size = 15 }) {
  return <LI size={size}><line x1="3" x2="21" y1="22" y2="22"/><line x1="6" x2="6" y1="18" y2="11"/><line x1="10" x2="10" y1="18" y2="11"/><line x1="14" x2="14" y1="18" y2="11"/><line x1="18" x2="18" y1="18" y2="11"/><polygon points="12 2 20 7 4 7"/></LI>;
}

export function ZapIcon({ size = 15 }) {
  return <LI size={size}><path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/></LI>;
}

export function MenuIcon({ size = 15 }) {
  return <LI size={size}><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/></LI>;
}

export function SkullIcon({ size = 15 }) {
  return <LI size={size}><path d="m12.5 17-.5-1-.5 1h1z"/><path d="M15 22a1 1 0 0 0 1-1v-1a2 2 0 0 0 1.56-3.25 8 8 0 1 0-11.12 0A2 2 0 0 0 8 20v1a1 1 0 0 0 1 1z"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="12" r="1"/></LI>;
}

export function RocketIcon({ size = 15 }) {
  return <LI size={size}><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></LI>;
}

export function HeartIcon({ size = 15 }) {
  return <LI size={size}><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></LI>;
}

export function DoorIcon({ size = 15 }) {
  return <LI size={size}><path d="M13 4h3a2 2 0 0 1 2 2v14"/><path d="M2 20h3"/><path d="M13 20h9"/><path d="M10 12v.01"/><path d="M13 4.562v16.157a1 1 0 0 1-1.242.97L5 20V5.562a2 2 0 0 1 1.515-1.94l4-1A2 2 0 0 1 13 4.561Z"/></LI>;
}

export function TicketIcon({ size = 15 }) {
  return <LI size={size}><path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2"/><path d="M13 17v2"/><path d="M13 11v2"/></LI>;
}

export function CoinsIcon({ size = 15 }) {
  return <LI size={size}><circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/></LI>;
}

export function FlagIcon({ size = 15 }) {
  return <LI size={size}><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/></LI>;
}

export function SirenIcon({ size = 15 }) {
  return <LI size={size}><path d="M7 18v-6a5 5 0 1 1 10 0v6"/><path d="M5 21a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-1a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2z"/><path d="M21 12h1"/><path d="M18.5 4.5 18 5"/><path d="M2 12h1"/><path d="M12 2v1"/><path d="m4.929 4.929.707.707"/><path d="M12 12v6"/></LI>;
}



// Emoji-string -> icon component lookup, for legacy inline/data glyphs
const GLYPH_MAP = {
  '✈': PlaneIcon, '✈️': PlaneIcon, '🛫': PlaneIcon, '🛬': PlaneIcon, '🛩': PlaneIcon, '🛩️': PlaneIcon,
  '📦': PackageIcon,
  '⚠': AlertIcon, '⚠️': AlertIcon,
  '🔧': WrenchIcon, '🛠': WrenchIcon, '🛠️': WrenchIcon, '🔩': WrenchIcon, '🪛': WrenchIcon,
  '🌍': GlobeIcon, '🌎': GlobeIcon, '🌏': GlobeIcon, '🌐': GlobeIcon,
  '💎': GemIcon,
  '💡': BulbIcon,
  '⚔': SwordsIcon, '⚔️': SwordsIcon,
  '👥': UsersIcon,
  '🧍': UserIcon, '🧑': UserIcon,
  '🏢': BuildingIcon, '🏛': BuildingIcon, '🏛️': BuildingIcon,
  '🏠': HouseIcon, '🏚': HouseIcon, '🏚️': HouseIcon,
  '🎯': TargetIcon,
  '🏆': TrophyIcon,
  '🏅': MedalIcon, '🥇': MedalIcon, '🥈': MedalIcon, '🥉': MedalIcon, '👑': MedalIcon,
  '💵': BanknoteIcon,
  '💰': CoinsIcon, '🤑': CoinsIcon, '💱': CoinsIcon,
  '📈': TrendUpIcon,
  '📉': TrendDownIcon, '💸': TrendDownIcon,
  '📅': CalendarIcon, '🗓': CalendarIcon, '🗓️': CalendarIcon,
  '⭐': StarIcon, '★': StarIcon, '🌟': StarIcon,
  '🚫': BanIcon, '⛔': BanIcon,
  '✂': ScissorsIcon, '✂️': ScissorsIcon,
  '✓': CheckIcon, '✔': CheckIcon, '✔️': CheckIcon,
  '✕': CloseIcon, '✗': CloseIcon, '❌': CloseIcon,
  '✅': CircleCheckIcon,
  '💾': SaveIcon,
  '📂': FolderOpenIcon, '📁': FolderOpenIcon,
  '⛽': FuelIcon,
  '💺': SeatIcon,
  '🛒': CartIcon,
  '✍': PenIcon, '✍️': PenIcon,
  '🔗': LinkIcon,
  '🌴': PalmIcon,
  '💼': BriefcaseIcon,
  '🔄': RefreshIcon,
  '🔁': RepeatIcon,
  '📣': MegaphoneIcon, '📢': MegaphoneIcon, '🪧': MegaphoneIcon,
  '🗺': MapIcon, '🗺️': MapIcon,
  '🔍': SearchIcon, '🔎': SearchIcon,
  '📏': RulerIcon, '📐': RulerIcon,
  '📊': BarChartIcon,
  '💨': WindIcon, '🌀': WindIcon,
  '⚙': SettingsIcon, '⚙️': SettingsIcon,
  '🤝': HandshakeIcon,
  '🔒': LockIcon, '🔐': LockIcon,
  '🛡': ShieldIcon, '🛡️': ShieldIcon,
  '🧭': CompassIcon,
  '📋': ClipboardIcon,
  '🔭': TelescopeIcon,
  '⚖': ScaleIcon, '⚖️': ScaleIcon,
  '🏦': LandmarkIcon,
  '⚡': ZapIcon, '⚡️': ZapIcon,
  '🔴': DotIcon, '🟢': DotIcon, '🟡': DotIcon, '🔵': DotIcon,
  '☰': MenuIcon,
  '💀': SkullIcon,
  '🚀': RocketIcon,
  '❤': HeartIcon, '❤️': HeartIcon, '💚': HeartIcon, '🧡': HeartIcon,
  '🚪': DoorIcon,
  '🎟': TicketIcon, '🎟️': TicketIcon, '🎫': TicketIcon,
  '🏳': FlagIcon, '🏳️': FlagIcon, '🚩': FlagIcon,
  '🚨': SirenIcon,
};

// Render an emoji string as its mapped line icon; unmapped (flavor) emoji pass through as text.
export function Glyph({ e, size = 14 }) {
  if (e == null) return null;
  const Ic = GLYPH_MAP[e] || GLYPH_MAP[String(e).replace(/️/g, '')];
  return Ic ? <Ic size={size} /> : <>{e}</>;
}

// Split a leading emoji off a label string and render it as an icon followed by the rest.
// e.g. "📋 P&L" -> <PackageIcon/> P&L ; passes strings with no leading emoji straight through.
export function GlyphLabel({ text, size = 14, gap = 6 }) {
  if (typeof text !== 'string') return <>{text}</>;
  const m = text.match(/^(\S+?)️?\s+(.*)$/u);
  if (m && (GLYPH_MAP[m[1]] || GLYPH_MAP[m[1].replace(/️/g, '')])) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap }}>
        <Glyph e={m[1]} size={size} /> {m[2]}
      </span>
    );
  }
  return <>{text}</>;
}
