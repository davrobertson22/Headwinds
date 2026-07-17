import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useGame } from './store/GameContext.jsx';
import { ToastProvider, useToast } from './components/ToastSystem.jsx';
import { ConfirmProvider } from './components/ConfirmModal.jsx';
import WeeklyDebrief from './components/WeeklyDebrief.jsx';
import SaveLoadModal from './components/SaveLoadModal.jsx';
import { formatMoney, formatGameDate, weekToGameDate } from './utils/simulation.js';
import SetupScreen from './components/SetupScreen.jsx';
import Dashboard from './components/Dashboard.jsx';
import Fleet from './components/Fleet.jsx';
import Routes from './components/Routes.jsx';
import Marketplace from './components/Marketplace.jsx';
import Finance from './components/Finance.jsx';
import { DashboardIcon, RoutesIcon, FleetIcon, MarketIcon, FinanceIcon, CompetitionIcon, PlannerIcon, GateIcon, OperationsIcon, RepIcon, HubIcon, LoyaltyIcon, PlaneIcon, SaveIcon, FolderOpenIcon, AlertIcon, SkullIcon, TrophyIcon } from './components/Icons.jsx';
import HubManagement from './components/HubManagement.jsx';
import Reputation from './components/Reputation.jsx';
import Competition from './components/Competition.jsx';
import RoutePlanner from './components/RoutePlanner.jsx';
import Airports from './components/Airports.jsx';
import RouteMap from './components/RouteMap.jsx';
import Operations from './components/Operations.jsx';
import Loyalty from './components/Loyalty.jsx';
import Alliances from './components/Alliances.jsx';
import Wiki from './components/Wiki.jsx';
import AirlineLogo from './components/AirlineLogo.jsx';
import OnboardingTour, { TOUR_KEY } from './components/OnboardingTour.jsx';
import BrandingModal from './components/BrandingModal.jsx';
import { gameAdBreak } from './utils/ads.js';
import useIsMobile from './hooks/useIsMobile.js';

// Build stamp — injected by vite.config.js `define`. Guarded so non-Vite contexts
// (e.g. node test harnesses that don't import App) never trip over the globals.
const BUILD_ID = typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'dev';
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0';
const BUILD_TIME = typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : '';

// Show a full-screen interstitial every Nth week advance (never on the first).
const AD_EVERY_N_WEEKS = 3;

// Tailwinds brand mark — the real logo artwork (transparent, mark only).
function TailwindsMark({ size = 22 }) {
  return (
    <img
      src="/tailwinds-mark-color.png"
      alt="Tailwinds"
      width={Math.round(size * 1.27)}
      height={size}
      style={{ flexShrink: 0, display: 'block', objectFit: 'contain' }}
    />
  );
}

function MapIcon({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6" />
      <line x1="8" y1="2" x2="8" y2="18" />
      <line x1="16" y1="6" x2="16" y2="22" />
    </svg>
  );
}

function AllianceIcon({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
    </svg>
  );
}

function HelpIcon({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

const TABS = [
  { id: 'dashboard',   label: 'Dashboard',     Icon: DashboardIcon   },
  { id: 'map',         label: 'Map',           Icon: MapIcon         },
  { id: 'planner',     label: 'Route Planner', Icon: PlannerIcon     },
  { id: 'routes',      label: 'Routes',        Icon: RoutesIcon      },
  { id: 'fleet',       label: 'Fleet',         Icon: FleetIcon       },
  { id: 'market',      label: 'Market',        Icon: MarketIcon      },
  { id: 'airports',    label: 'Gates',         Icon: GateIcon          },
  { id: 'hubs',        label: 'Hubs',          Icon: HubIcon           },
  { id: 'operations',  label: 'Operations',   Icon: OperationsIcon    },
  { id: 'reputation',  label: 'Reputation',    Icon: RepIcon         },
  { id: 'loyalty',     label: 'Loyalty',       Icon: LoyaltyIcon     },
  { id: 'alliances',   label: 'Alliances',    Icon: AllianceIcon    },
  { id: 'competition', label: 'Competition',  Icon: CompetitionIcon   },
  { id: 'finance',     label: 'Finance',       Icon: FinanceIcon     },
  { id: 'wiki',        label: 'Help',          Icon: HelpIcon        },
];

// Look up a tab's label/Icon by id.
const TABS_BY_ID = Object.fromEntries(TABS.map(t => [t.id, t]));

// Grouped navigation: Dashboard, Finance and Help stay one click away; the rest
// fold into four dropdown groups so the bar fits without cutting anything off.
const NAV_GROUPS = [
  { id: 'dashboard' },
  { label: 'Network',  Icon: MapIcon,        children: ['map', 'planner', 'routes'] },
  { label: 'Fleet',    Icon: FleetIcon,      children: ['fleet', 'market'] },
  { label: 'Airports', Icon: GateIcon,       children: ['airports', 'hubs'] },
  { label: 'Company',  Icon: OperationsIcon, children: ['operations', 'reputation', 'loyalty', 'alliances', 'competition'] },
  { id: 'finance' },
  { id: 'wiki' },
];

export default function App() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <AppInner />
      </ConfirmProvider>
    </ToastProvider>
  );
}

function AppInner() {
  // `remote` is set only by Headwinds' RemoteGameProvider (multiplayer): the
  // server owns time and persistence there, so solo-only chrome (Next Week,
  // Save/Load, New Game) is hidden. Always falsy in the solo game.
  // `remoteChrome` carries the multiplayer topbar extras (tick countdown,
  // lobby link, feed + messages) so the game renders ONE header.
  const { state, dispatch, remote, remoteChrome } = useGame();
  const [activeTab, setActiveTab] = useState('dashboard');
  const [openGroup, setOpenGroup] = useState(null);
  const [menuPos, setMenuPos] = useState(null);
  const [showTour, setShowTour] = useState(false);
  const [saveLoadMode, setSaveLoadMode] = useState(null); // 'save' | 'load' | null
  const [showNewGameConfirm, setShowNewGameConfirm] = useState(false);
  const [showBranding, setShowBranding] = useState(false);
  const isMobile = useIsMobile();
  const [showMobileMenu, setShowMobileMenu] = useState(false);
  const addToast = useToast();

  // Show tour automatically the first time a game starts
  useEffect(() => {
    if (state.phase === 'playing' && !localStorage.getItem(TOUR_KEY)) {
      setShowTour(true);
    }
  }, [state.phase]);

  // Fire pending toasts from the reducer
  useEffect(() => {
    if (!state.pendingToasts?.length) return;
    state.pendingToasts.forEach(t => addToast(t));
    dispatch({ type: 'CLEAR_TOASTS' });
  }, [state.pendingToasts]);

  const WEEK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  const LS_KEY = 'airline_next_week_at';

  function loadNextWeekAt() {
    const saved = localStorage.getItem(LS_KEY);
    if (saved) {
      const ts = parseInt(saved, 10);
      if (ts > Date.now()) return ts;
    }
    return Date.now() + WEEK_INTERVAL_MS;
  }

  const nextWeekAt = useRef(loadNextWeekAt());
  const [timeUntilNextWeek, setTimeUntilNextWeek] = useState(() => Math.max(0, nextWeekAt.current - Date.now()));

  function resetTimer() {
    const ts = Date.now() + WEEK_INTERVAL_MS;
    nextWeekAt.current = ts;
    localStorage.setItem(LS_KEY, String(ts));
    setTimeUntilNextWeek(WEEK_INTERVAL_MS);
  }

  // Shared week-advance, used by both the manual button and the hourly timer so
  // the ad cadence is identical regardless of how the week advances. Kept in a
  // ref so the interval's closure always calls the latest version.
  const weeksSinceAd = useRef(0);
  const advanceWeek = useRef(() => {});
  advanceWeek.current = () => {
    if (remote) return; // multiplayer: the server owns time — never advance locally
    dispatch({ type: 'ADVANCE_WEEK' });
    setActiveTab('dashboard');
    resetTimer();

    weeksSinceAd.current += 1;
    if (weeksSinceAd.current >= AD_EVERY_N_WEEKS) {
      weeksSinceAd.current = 0;
      gameAdBreak('weekly_debrief');
    }
  };

  // Auto-advance every hour.
  // Multiplayer (Headwinds): time belongs to the SERVER world clock — the local
  // timer must never run (its ADVANCE_WEEK is swallowed, but it would still
  // yank the player to the Dashboard and fire ad breaks every hour).
  useEffect(() => {
    if (remote) return;
    if (state.phase !== 'playing') return;

    const tick = setInterval(() => {
      const remaining = nextWeekAt.current - Date.now();
      if (remaining <= 0) {
        advanceWeek.current();
      } else {
        setTimeUntilNextWeek(remaining);
      }
    }, 1000);

    return () => clearInterval(tick);
  }, [state.phase]);

  // Clear saved timer on reset/new game
  useEffect(() => {
    if (state.phase === 'setup') {
      localStorage.removeItem(LS_KEY);
    }
  }, [state.phase]);

  if (state.phase === 'setup') return <SetupScreen />;

  function handleAdvanceWeek() {
    advanceWeek.current();
  }

  function formatCountdown(ms) {
    const totalSec = Math.ceil(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  function handleReset() {
    setShowNewGameConfirm(true);
  }

  function confirmNewGame() {
    setShowNewGameConfirm(false);
    dispatch({ type: 'RESET' });
  }

  // In multiplayer the Competition tab shows the OTHER HUMANS in your world, so
  // "Rivals" is the accurate label there.
  const tabLabel = (id) => (remote && id === 'competition') ? 'Rivals' : TABS_BY_ID[id]?.label;
  const navigate = (id) => { setActiveTab(id); setOpenGroup(null); };

  const tabContent = {
    dashboard:   <Dashboard onNavigate={navigate} />,
    map:         <RouteMap />,
    planner:     <RoutePlanner />,
    routes:      <Routes />,
    fleet:       <Fleet />,
    market:      <Marketplace />,
    airports:    <Airports />,
    hubs:        <HubManagement />,
    operations:  <Operations />,
    reputation:  <Reputation />,
    loyalty:     <Loyalty />,
    alliances:   <Alliances />,
    competition: <Competition />,
    finance:     <Finance />,
    wiki:        <Wiki />,
  };

  return (
    <div className="app-layout">
      {/* Top bar */}
      <div className="topbar">
        <div className="topbar-logo">
          {remote ? (
            <a href="#/" title="Headwinds home" style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              fontWeight: 800, letterSpacing: 2, color: 'var(--accent)', textDecoration: 'none',
            }}>
              <img src="/headwinds-mark-color.png" alt="" style={{ height: 20, width: 'auto', display: 'block' }} />
              HEADWINDS
            </a>
          ) : (<>
            <span className="topbar-logo-icon"><TailwindsMark size={20} /></span>
            Tailwinds - Airline Manager
          </>)}
        </div>
        <div className="topbar-sep" />
        <button
          type="button"
          onClick={() => setShowBranding(true)}
          title="Edit airline branding"
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            background: 'none', border: 'none', padding: 0, margin: 0,
            cursor: 'pointer', color: 'inherit',
          }}
        >
          <AirlineLogo id={state.logoId} customSrc={state.customLogo} size={28} radius={6} accentColor={state.logoColor} />
          <div className="topbar-airline">{state.airlineName}</div>
        </button>
        <div className="topbar-spacer" />
        <div className="topbar-kpis">
          <div className="topbar-kpi">
            <span className="topbar-kpi-label">DATE</span>
            <span className="topbar-kpi-value" style={{ fontSize: 13 }}>{formatGameDate(state)}</span>
            {remote && remoteChrome?.clock && (
              <span style={{ fontSize: 10, color: 'var(--text-dim)', lineHeight: 1, marginTop: 3, whiteSpace: 'nowrap' }}>
                {remoteChrome.clock}
              </span>
            )}
          </div>
          <div className="topbar-kpi-divider" />
          <div className="topbar-kpi">
            <span className="topbar-kpi-label">CASH</span>
            <span className={`topbar-cash ${state.cash < 0 ? 'negative' : ''}`}>
              {formatMoney(state.cash)}
            </span>
          </div>
        </div>
        {!remote && (
        <button className="btn-advance" onClick={handleAdvanceWeek} title="Advance now (auto-advances in the shown time)">
          Next Week › <span style={{ fontSize: 11, opacity: 0.7, marginLeft: 4 }}>{formatCountdown(timeUntilNextWeek)}</span>
        </button>
        )}
        {remote && remoteChrome?.right && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            {remoteChrome.right}
          </span>
        )}
        {!isMobile && (<>
        {!remote && (<>
        <button
          className="btn btn-ghost"
          style={{ fontSize: 12, padding: '5px 10px', display: 'inline-flex', alignItems: 'center', gap: 6 }}
          onClick={() => setSaveLoadMode('save')}
          title="Save game to a slot"
        >
          <SaveIcon size={13} /> Save
        </button>
        <button
          className="btn btn-ghost"
          style={{ fontSize: 12, padding: '5px 10px', display: 'inline-flex', alignItems: 'center', gap: 6 }}
          onClick={() => setSaveLoadMode('load')}
          title="Load a saved game"
        >
          <FolderOpenIcon size={13} /> Load
        </button>
        </>)}
        <button
          className="btn btn-ghost"
          style={{ fontSize: 12, padding: '5px 10px' }}
          onClick={() => setShowTour(true)}
          title="How to play"
        >
          ?
        </button>
        <a
          className="btn btn-ghost"
          style={{ fontSize: 12, padding: '5px 10px', display: 'inline-flex', alignItems: 'center', gap: 5, textDecoration: 'none' }}
          href="https://discord.com/invite/B7zP8X3YGm"
          target="_blank"
          rel="noopener noreferrer"
          title="Join the Tailwinds community on Discord"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="#5865F2" aria-hidden="true"><path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z"/></svg>
          Discord
        </a>
        {!remote && (
        <button
          className="btn btn-ghost"
          style={{ fontSize: 12, padding: '5px 10px' }}
          onClick={handleReset}
        >
          New Game
        </button>
        )}
        </>)}
        {isMobile && (
          <div className="topbar-menu-wrap">
            <button
              className="btn btn-ghost topbar-menu-btn"
              onClick={() => setShowMobileMenu(v => !v)}
              aria-label="More actions"
              aria-expanded={showMobileMenu}
            >
              ⋯
            </button>
            {showMobileMenu && (
              <>
                <div className="topbar-menu-backdrop" onClick={() => setShowMobileMenu(false)} />
                <div className="topbar-menu" role="menu">
                  {!remote && (<>
                  <button role="menuitem" onClick={() => { setSaveLoadMode('save'); setShowMobileMenu(false); }}>
                    <SaveIcon size={14} /> Save game
                  </button>
                  <button role="menuitem" onClick={() => { setSaveLoadMode('load'); setShowMobileMenu(false); }}>
                    <FolderOpenIcon size={14} /> Load game
                  </button>
                  </>)}
                  <button role="menuitem" onClick={() => { setShowTour(true); setShowMobileMenu(false); }}>
                    <span style={{ width: 14, textAlign: 'center', fontWeight: 700 }}>?</span> How to play
                  </button>
                  <a
                    role="menuitem"
                    href="https://discord.com/invite/B7zP8X3YGm"
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => setShowMobileMenu(false)}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="#5865F2" aria-hidden="true"><path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z"/></svg>
                    Discord
                  </a>
                  {!remote && (
                  <button role="menuitem" className="topbar-menu-danger" onClick={() => { setShowMobileMenu(false); handleReset(); }}>
                    New Game
                  </button>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Nav tabs (grouped) */}
      <div className="nav-tabs">
        {NAV_GROUPS.map((grp) => {
          if (!grp.children) {
            const t = TABS_BY_ID[grp.id];
            const Icon = t.Icon;
            return (
              <button
                key={grp.id}
                className={`nav-tab ${activeTab === grp.id ? 'active' : ''}`}
                onClick={() => navigate(grp.id)}
              >
                <Icon size={14} />
                <span>{tabLabel(grp.id)}</span>
              </button>
            );
          }
          const GroupIcon = grp.Icon;
          const activeChild = grp.children.includes(activeTab);
          const open = openGroup === grp.label;
          return (
            <div key={grp.label} className="nav-group">
              <button
                className={`nav-tab ${activeChild ? 'active' : ''} ${open ? 'open' : ''}`}
                onClick={(e) => {
                  if (open) { setOpenGroup(null); return; }
                  const r = e.currentTarget.getBoundingClientRect();
                  setMenuPos({ top: r.bottom + 4, left: r.left });
                  setOpenGroup(grp.label);
                }}
                aria-expanded={open}
              >
                <GroupIcon size={14} />
                <span>{grp.label}</span>
                <span className="nav-caret" aria-hidden="true">▾</span>
              </button>
              {open && menuPos && createPortal(
                <>
                  <div className="nav-group-backdrop" onClick={() => setOpenGroup(null)} />
                  <div className="nav-group-menu" role="menu" style={{ top: menuPos.top, left: menuPos.left }}>
                    {grp.children.map((cid) => {
                      const ct = TABS_BY_ID[cid];
                      const CIcon = ct.Icon;
                      return (
                        <button
                          key={cid}
                          role="menuitem"
                          className={activeTab === cid ? 'active' : ''}
                          onClick={() => navigate(cid)}
                        >
                          <CIcon size={14} />
                          <span>{tabLabel(cid)}</span>
                        </button>
                      );
                    })}
                  </div>
                </>,
                document.body
              )}
            </div>
          );
        })}
      </div>

      {/* Page content */}
      <div className="main-content">
        {tabContent[activeTab]}
        {/* Disclaimer lives at the end of the scrollable content (desktop +
            mobile) so it's reachable on scroll without permanently occupying
            screen space. */}
        <footer className="app-footer app-footer-inline">
          <div style={{ marginBottom: 8 }}>
            {[
              ['How to Play', '/how-to-play.html'],
              ['Strategy Guide', '/strategy.html'],
              ['Glossary', '/glossary.html'],
              // Headwinds-only: fair-play rules page (no Tailwinds counterpart).
              ...(remote ? [['Rules', '/rules.html']] : []),
              ['Devlog', '/devlog.html'],
              ['About', '/about.html'],
              ['Privacy', '/privacy.html'],
            ].map(([label, href]) => (
              <a
                key={href}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: 'var(--accent)', textDecoration: 'none', marginRight: 16, fontSize: 12, fontWeight: 500 }}
              >
                {label}
              </a>
            ))}
          </div>
          AI was used in the development of this game. While core mechanics were designed by humans,
          much of the coding and scaling of designs were done through the use of LLMs.
          <div
            title={BUILD_TIME ? `Built ${BUILD_TIME}` : undefined}
            style={{ marginTop: 8, fontSize: 11, color: 'var(--text-dim)', letterSpacing: '.02em' }}
          >
            {remote ? 'Headwinds' : 'Tailwinds'} v{APP_VERSION} · build {BUILD_ID}
          </div>
        </footer>
      </div>

      {/* Weekly debrief modal */}
      <WeeklyDebrief />

      {/* Advance-week error overlay — shows if reducer threw */}
      {state.advanceWeekError && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,.8)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999,
        }}>
          <div style={{
            background: 'var(--surface)', border: '1px solid var(--red)',
            borderRadius: 12, padding: 32, maxWidth: 500, width: '90%',
          }}>
            <div style={{ fontSize: 24, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}><AlertIcon size={24} /> Advance Week Error</div>
            <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 16 }}>
              An error occurred while advancing the week. Please copy this message and report it:
            </p>
            <pre style={{
              background: 'var(--surface2)', padding: 12, borderRadius: 6,
              fontSize: 11, overflowX: 'auto', color: 'var(--red)', whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}>
              {state.advanceWeekError}
            </pre>
            <button
              className="btn btn-primary"
              style={{ marginTop: 16, width: '100%' }}
              onClick={() => dispatch({ type: 'CLEAR_ERROR' })}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Bankrupt overlay */}
      {state.phase === 'bankrupt' && (
        <div className="bankrupt-overlay">
          <div className="bankrupt-card">
            <div style={{ marginBottom: 16, color: 'var(--red)' }}><SkullIcon size={48} /></div>
            <h2 style={{ fontSize: 24, marginBottom: 8 }}>Bankruptcy</h2>
            <p style={{ color: 'var(--text-muted)', marginBottom: 8 }}>
              {state.airlineName} has been declared bankrupt.
            </p>
            <p style={{ color: 'var(--text-dim)', fontSize: 13, marginBottom: 24, lineHeight: 1.6 }}>
              {state.bankruptcyReason === 'missed_loans'
                ? '3 loan payments were missed. The bank has called in your debt and seized operations.'
                : state.bankruptcyReason === 'consecutive_negative'
                ? 'Your cash was negative for 6 consecutive weeks. Unable to sustain operations.'
                : 'Your airline ran out of cash.'}
            </p>
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 24, padding: '10px 14px', background: 'var(--surface2)', borderRadius: 8 }}>
              Weeks survived: <strong style={{ color: 'var(--text)' }}>{((state.year - 1) * 52 + state.week)}</strong>
              {state.missedLoanPayments > 0 && <> · Missed payments: <strong style={{ color: 'var(--red)' }}>{state.missedLoanPayments}</strong></>}
            </div>
            {remote ? (
              /* Multiplayer: there's no local reset — the world carries on.
                 The game bar's "← World lobby" link is the way out. */
              <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>
                This world carries on without you. Head back to the world lobby to
                spectate the standings or join another world.
              </p>
            ) : (
              <button
                className="btn btn-primary"
                style={{ width: '100%', padding: 12 }}
                onClick={handleReset}
              >
                Start New Airline
              </button>
            )}
          </div>
        </div>
      )}

      {/* Victory overlay — all competitors acquired */}
      {state.gameWon && !state.victoryAcknowledged && (
        <VictoryOverlay
          stats={state.victoryStats}
          airlineName={state.airlineName}
          logoId={state.logoId}
          logoColor={state.logoColor}
          customLogo={state.customLogo}
          onContinue={() => dispatch({ type: 'ACKNOWLEDGE_VICTORY' })}
          onNewGame={handleReset}
        />
      )}

      {/* Onboarding tour */}
      {showTour && <OnboardingTour onClose={() => setShowTour(false)} />}

      {/* Save / Load modal */}
      {saveLoadMode && (
        <SaveLoadModal mode={saveLoadMode} onClose={() => setSaveLoadMode(null)} />
      )}

      {/* Edit branding modal */}
      {showBranding && <BrandingModal onClose={() => setShowBranding(false)} />}

      {/* New Game confirmation */}
      {showNewGameConfirm && (
        <div className="saveload-overlay" onClick={e => { if (e.target === e.currentTarget) setShowNewGameConfirm(false); }}>
          <div className="confirm-modal">
            <h2 className="confirm-modal-title">Start a New Game?</h2>
            <p className="confirm-modal-body">
              Your current game is auto-saved and can be recovered via <strong>Load Game</strong> if you save it to a slot first.
              Starting a new game will reset everything.
            </p>
            <div className="confirm-modal-actions">
              <button className="btn btn-ghost" onClick={() => setShowNewGameConfirm(false)}>Cancel</button>
              <button className="btn btn-danger" onClick={confirmNewGame}>Start New Game</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Victory screen ───────────────────────────────────────────────────────────

function VictoryStat({ label, value }) {
  return (
    <div style={{ textAlign: 'center', minWidth: 90 }}>
      <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)' }}>{value}</div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 2 }}>
        {label}
      </div>
    </div>
  );
}

function VictoryOverlay({ stats, airlineName, logoId, logoColor, customLogo, onContinue, onNewGame }) {
  const s = stats ?? {};
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9998,
      background: 'radial-gradient(circle at 50% 30%, rgba(16,185,129,0.18), rgba(0,0,0,0.85))',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div className="card" style={{
        width: '100%', maxWidth: 460, padding: '32px 28px 24px', textAlign: 'center',
        border: '1px solid rgba(16,185,129,0.5)',
      }}>
        <div style={{ marginBottom: 8, color: 'var(--accent)' }}><TrophyIcon size={52} /></div>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
          <AirlineLogo id={logoId} customSrc={customLogo} size={44} radius={8} accentColor={logoColor} />
        </div>
        <h2 style={{ fontSize: 26, marginBottom: 6, color: 'var(--green)' }}>You Control the Skies</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 14, marginBottom: 4, lineHeight: 1.5 }}>
          {airlineName} has acquired every competitor{s.lastRival ? <> — {s.lastRival} was the last to fall</> : null}.
          The industry is yours.
        </p>

        <div style={{
          display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '18px 24px',
          margin: '22px 0', padding: '18px 12px', background: 'var(--surface2)', borderRadius: 10,
        }}>
          {s.marketCap != null && <VictoryStat label="Market cap" value={formatMoney(s.marketCap)} />}
          <VictoryStat label="Cash" value={formatMoney(s.cash ?? 0)} />
          <VictoryStat label="Aircraft" value={s.fleetCount ?? 0} />
          <VictoryStat label="Routes" value={s.routeCount ?? 0} />
          <VictoryStat label="Airports" value={s.airports ?? 0} />
          <VictoryStat label="Years played" value={s.year ?? '–'} />
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={onContinue}
            style={{
              flex: 1, padding: '11px 0', borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: 'pointer',
              background: 'var(--green)', border: 'none', color: '#fff',
            }}
          >
            Keep Playing
          </button>
          <button
            onClick={onNewGame}
            style={{
              flex: 1, padding: '11px 0', borderRadius: 8, fontWeight: 600, fontSize: 14, cursor: 'pointer',
              background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text)',
            }}
          >
            New Game
          </button>
        </div>
      </div>
    </div>
  );
}
