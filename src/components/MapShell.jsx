import { useState, useEffect, useRef, useCallback, Component } from 'react';
import { createPortal } from 'react-dom';
import RouteMap from './RouteMap.jsx';
import AirlineLogo from './AirlineLogo.jsx';
import useBasemap from '../hooks/useBasemap.js';
import { LAYOUT_KEY } from './mapCore.js';
import { formatMoney, formatGameDate } from '../utils/simulation.js';
import { useAirlineAlerts } from '../utils/airlineAlerts.js';
import { peekNavFilter, requestNav } from '../utils/navIntent.js';
import { peekDepartureBoardRequest } from './Departures.jsx';
import { openAlertSettings } from '../utils/alertPrefs.js';
import { BellIcon } from './Icons.jsx';
import { financeGroupOf } from './Finance.jsx';
import {
  CoinsIcon, SettingsIcon, CloseIcon, SaveIcon, FolderOpenIcon,
  DashboardIcon, MapIcon, SearchIcon, PlannerIcon, RoutesIcon, GateIcon, HubIcon, CalendarIcon,
  FleetIcon, MarketIcon, PlaneIcon, CompetitionIcon, HandshakeIcon, TrendUpIcon, NewsIcon, GlobeIcon,
  OperationsIcon, UsersIcon, WrenchIcon, FuelIcon, MegaphoneIcon, GiftIcon, TicketIcon, RepIcon,
  LoyaltyIcon, SeatIcon, FinanceIcon, ScaleIcon, BanknoteIcon, BarChartIcon, ClipboardIcon,
  CompassIcon, RocketIcon,
} from './Icons.jsx';

// ── Map-first layout ──────────────────────────────────────────────────────────
// The world map is the whole screen; everything else floats over it. The
// classic layout (top bar + tab strip + page) is untouched — this is a second
// shell over the SAME screens, chosen per browser (LAYOUT_KEY) and switched
// from the settings menu here or the top bar there.
//
// Reworked 2026-10-29 from Barca's Discord feedback on the beta:
//
//   top left       a big airline crest (opens branding), Paradox-flag style
//   top centre     ONE row: cash · last week's result · date · clock / Next week
//   top right      multiplayer chrome, then Guide · Tutorial · Discord · Settings
//   right edge     alerts (idle aircraft, expiring leases, losses…) and world
//                  events, each with a hover tooltip; a click goes there
//   bottom left    Map ⇄ Dashboard
//   bottom dock    seven groups, every one a single click:
//                  Search · Network · Fleet · World · Operations · Service · Finance
//
// A group button opens its first page (or the one the player last had open in
// that group), and the panel's header carries the group's other pages as tabs —
// "Search" lands on the Route Finder with the Route Planner one tab over. No
// page has two buttons any more (Market used to be in the Fleet menu AND the
// dock; the Route Finder in Network AND the dock), and every control is on the
// bottom or the top rather than three sides.
//
// The map view has its own pages where a classic page holds several things:
// Operations splits into Crew, Departures (board + schedule, under Network),
// Marketing and Catering (under Service); Finance splits into Statements, Loans
// & Forecast, Analysis, Breakdown and Fuel (under Operations). App.jsx builds
// the page elements (`pages`); a classic tab id — from a deep link, the news
// feed or the tour — is mapped to its page by resolveMapPage().

export { LAYOUT_KEY };
export const LAYOUTS = ['classic', 'map'];

// ── Opt-in ───────────────────────────────────────────────────────────────────
// The map-first layout is a beta players choose to try. Classic shows a slim
// invitation strip (and a NEW dot on the Map view button) until the player has
// tried it once or dismissed it; the first visit to map-first shows a one-off
// hint saying how to get back.
export const LAYOUT_INVITE_KEY = 'headwinds.layoutInvite';   // 'tried' | 'dismissed'
export const MAP_HINT_KEY = 'headwinds.mapHintSeen';
const LAST_PAGES_KEY = 'headwinds.mapLastPages';

export function readInviteOpen() {
  try { return !localStorage.getItem(LAYOUT_INVITE_KEY); }
  catch { return false; }
}

export function closeInvite(reason) {
  try { localStorage.setItem(LAYOUT_INVITE_KEY, reason === 'tried' ? 'tried' : 'dismissed'); } catch { /* private mode */ }
}

function readHintSeen() {
  try { return !!localStorage.getItem(MAP_HINT_KEY); }
  catch { return true; }
}

export function readLayout() {
  try { return localStorage.getItem(LAYOUT_KEY) === 'map' ? 'map' : 'classic'; }
  catch { return 'classic'; }
}

export function writeLayout(v) {
  const l = v === 'map' ? 'map' : 'classic';
  try { localStorage.setItem(LAYOUT_KEY, l); } catch { /* private mode */ }
  if (l === 'map') closeInvite('tried');
  return l;
}

/** The tab the map stands for. Opening it in map-first means "close the panel". */
export const MAP_TAB = 'map';

// ── Pages and groups ─────────────────────────────────────────────────────────
// `tab` is the classic tab a page belongs to (its label in multiplayer, and
// what navPath.js calls it). Pages without a classic tab of their own carry a
// label and an icon here.
export const MAP_PAGES = {
  dashboard:      { tab: 'dashboard' },
  wiki:           { tab: 'wiki', label: 'Guide' },
  finder:         { tab: 'finder' },
  planner:        { tab: 'planner' },
  routes:         { tab: 'routes' },
  airports:       { tab: 'airports' },
  hubs:           { tab: 'hubs' },
  departures:     { tab: 'operations', label: 'Departures', Icon: CalendarIcon },
  fleet:          { tab: 'fleet' },
  market:         { tab: 'market' },
  used:           { tab: 'used' },
  competition:    { tab: 'competition' },
  alliances:      { tab: 'alliances' },
  stocks:         { tab: 'stocks' },
  news:           { tab: 'news', remoteOnly: true },
  operations:     { tab: 'operations', label: 'Crew', Icon: UsersIcon },
  maintenance:    { tab: 'maintenance' },
  fuel:           { tab: 'finance', label: 'Fuel', Icon: FuelIcon },
  marketing:      { tab: 'operations', label: 'Marketing', Icon: MegaphoneIcon },
  catering:       { tab: 'operations', label: 'Catering', Icon: GiftIcon },
  ancillaries:    { tab: 'ancillaries', Icon: TicketIcon },
  reputation:     { tab: 'reputation', Icon: RepIcon },
  loyalty:        { tab: 'loyalty', Icon: LoyaltyIcon },
  // Travel partners exist only in worlds created with them (App.jsx hides the
  // classic tab the same way).
  partners:       { tab: 'partners', Icon: HandshakeIcon, when: (s) => s?.partnershipsWorld === true },
  'fin-statements': { tab: 'finance', label: 'Statements', Icon: ScaleIcon },
  'fin-planning':   { tab: 'finance', label: 'Loans & Forecast', Icon: BanknoteIcon },
  'fin-analysis':   { tab: 'finance', label: 'Analysis', Icon: BarChartIcon },
  'fin-breakdown':  { tab: 'finance', label: 'Breakdown', Icon: ClipboardIcon },
};

/** The bottom dock, left to right. Every page except the Dashboard and the
 *  Guide (both chrome buttons) lives in exactly one group. */
export const MAP_GROUPS = [
  { id: 'search',  label: 'Search',     Icon: SearchIcon,     pages: ['finder', 'planner'] },
  { id: 'network', label: 'Network',    Icon: RoutesIcon,     pages: ['routes', 'airports', 'hubs', 'departures'] },
  { id: 'fleet',   label: 'Fleet',      Icon: FleetIcon,      pages: ['fleet', 'market', 'used'] },
  { id: 'world',   label: 'World',      Icon: GlobeIcon,      pages: ['competition', 'alliances', 'stocks', 'news'] },
  { id: 'ops',     label: 'Operations', short: 'Ops', Icon: OperationsIcon, pages: ['operations', 'maintenance', 'fuel'] },
  { id: 'service', label: 'Service',    Icon: SeatIcon,       pages: ['marketing', 'catering', 'ancillaries', 'reputation', 'loyalty', 'partners'] },
  { id: 'finance', label: 'Finance',    Icon: FinanceIcon,    pages: ['fin-statements', 'fin-planning', 'fin-analysis', 'fin-breakdown'] },
];

/** Pages reached from the chrome rather than the dock. */
export const MAP_CHROME_PAGES = ['dashboard', 'wiki'];

export function mapGroupOf(page) {
  return MAP_GROUPS.find(g => g.pages.includes(page)) ?? null;
}

/**
 * The map page a navigation lands on. Accepts a map page id (returned as is),
 * MAP_TAB, or a classic tab id — the news feed, the Dashboard's alerts and the
 * tour all speak classic. Peeks (never takes) any parked deep link, so the page
 * that mounts still reads it: Finance's view picks the Finance tab, a parked
 * departure-board airport sends 'operations' to Departures.
 *
 * Called when the player navigates, NOT on every render — once the page has
 * consumed its deep link, re-resolving would move it.
 */
export function resolveMapPage(id) {
  if (id === MAP_TAB) return MAP_TAB;
  if (id === 'operations') return peekDepartureBoardRequest() ? 'departures' : 'operations';
  if (id === 'finance') {
    const g = financeGroupOf(peekNavFilter('finance')?.view);
    return g === 'fuel' ? 'fuel' : `fin-${g ?? 'statements'}`;
  }
  return MAP_PAGES[id] ? id : MAP_TAB;
}

function readLastPages() {
  try { return JSON.parse(localStorage.getItem(LAST_PAGES_KEY) || '{}') || {}; }
  catch { return {}; }
}

function useEscape(handler) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') ref.current?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/** A popover menu, portalled so no parent overflow clips it. */
function PopMenu({ anchor, onClose, children, label }) {
  if (!anchor) return null;
  const r = anchor.getBoundingClientRect();
  const W = 230;
  const style = {
    right: Math.max(8, window.innerWidth - r.right),
    top: r.bottom + 8,
    width: W,
  };
  return createPortal(
    <>
      <div className="ms-menu-backdrop" onClick={onClose} />
      <div className="ms-menu" role="menu" aria-label={label} style={style}>
        {children}
      </div>
    </>,
    document.body,
  );
}

/** The map must never take the HUD down with it — a throw inside a map effect
 *  used to unmount the whole game to a black page. */
class MapBoundary extends Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err) { try { console.error('[map view] map crashed', err); } catch { /* ignore */ } }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="ms-map-failed">
        <span>The map hit a problem.</span>
        <button type="button" onClick={() => this.setState({ failed: false })}>Reload the map</button>
      </div>
    );
  }
}

/** A plain chat-bubble mark for the Discord link (no third-party logo). */
function ChatIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
    </svg>
  );
}

function signedMoney(v) {
  return `${v >= 0 ? '+' : '−'}${formatMoney(Math.abs(v))}`;
}

/** Alerts and world events down the right edge. */
function AlertRail({ alerts, events, go, openPage, pageFor }) {
  if (!alerts.length && !events.length) return null;
  return (
    <aside className="ms-alerts" aria-label="Alerts">
      {alerts.map(a => {
        const Icon = typeof a.icon === 'function' ? a.icon : null;
        const page = pageFor(a.to);
        return (
          <button
            key={a.id}
            type="button"
            className={`ms-alert ms-alert-${a.level}`}
            data-alert={a.id}
            onClick={() => go(a.to, a.filter)}
            aria-label={a.text}
          >
            {Icon ? <Icon size={18} /> : <span className="ms-alert-glyph">{a.icon}</span>}
            <span className="ms-alert-tip" role="tooltip">
              <span className="ms-alert-tip-text">{a.text}</span>
              {page && <span className="ms-alert-tip-go">{page} →</span>}
            </span>
          </button>
        );
      })}
      {events.length > 0 && alerts.length > 0 && <span className="ms-alerts-sep" aria-hidden="true" />}
      {events.map(ev => (
        <button
          key={ev.id}
          type="button"
          className="ms-alert ms-alert-event"
          data-event={ev.id}
          style={{ '--ev': ev.color ?? 'var(--accent)' }}
          onClick={() => openPage('dashboard')}
          aria-label={`${ev.name}, ${ev.weeksLeft} weeks left`}
        >
          <span className="ms-alert-glyph">{ev.icon}</span>
          {ev.weeksLeft != null && <span className="ms-alert-badge">{ev.weeksLeft}w</span>}
          <span className="ms-alert-tip" role="tooltip">
            <span className="ms-alert-tip-title">{ev.name}</span>
            {ev.description && <span className="ms-alert-tip-text">{ev.description}</span>}
            <span className="ms-alert-tip-go">{ev.weeksLeft != null ? `${ev.weeksLeft} week${ev.weeksLeft === 1 ? '' : 's'} left · ` : ''}Details on the Dashboard →</span>
          </span>
        </button>
      ))}
    </aside>
  );
}

export default function MapShell({
  state, remote, remoteChrome,
  tabs, tabLabel, activeTab, navigate, pages, footer,
  onAdvance, countdown, onBranding, onTour, onSave, onLoad, onNewGame, onClassic,
  discordHref,
}) {
  const [menu, setMenu] = useState(null);         // { key, anchor }
  // First visit only: say how to get back to the classic layout.
  const [showHint, setShowHint] = useState(() => !readHintSeen());
  const dismissHint = () => {
    setShowHint(false);
    try { localStorage.setItem(MAP_HINT_KEY, '1'); } catch { /* private mode */ }
  };
  const [basemap, setBasemap] = useBasemap();
  const page = activeTab && activeTab !== MAP_TAB && MAP_PAGES[activeTab] ? activeTab : null;
  const panelOpen = !!page;

  const available = (id) => !!MAP_PAGES[id] && !!pages?.[id] && (!MAP_PAGES[id].remoteOnly || remote)
    && (!MAP_PAGES[id].when || MAP_PAGES[id].when(state));
  const pageLabel = (id) => {
    const p = MAP_PAGES[id];
    if (!p) return '';
    if (p.label) return p.label;
    return tabLabel(p.tab) ?? id;
  };
  const pageIcon = (id) => MAP_PAGES[id]?.Icon ?? tabs?.[MAP_PAGES[id]?.tab]?.Icon ?? null;

  // The page each group reopens on — the last one the player had open there.
  const lastPages = useRef(null);
  if (lastPages.current == null) lastPages.current = readLastPages();
  useEffect(() => {
    const g = page && mapGroupOf(page);
    if (!g || lastPages.current[g.id] === page) return;
    lastPages.current = { ...lastPages.current, [g.id]: page };
    try { localStorage.setItem(LAST_PAGES_KEY, JSON.stringify(lastPages.current)); } catch { /* private mode */ }
  }, [page]);

  const closeAll = useCallback(() => {
    if (menu) { setMenu(null); return; }
    if (panelOpen) navigate(MAP_TAB);
  }, [menu, panelOpen, navigate]);
  useEscape(closeAll);

  const openPage = (id) => { setMenu(null); navigate(id); };
  const toggleGroup = (g) => {
    setMenu(null);
    if (page && g.pages.includes(page)) { navigate(MAP_TAB); return; }
    const remembered = lastPages.current[g.id];
    const target = available(remembered) && g.pages.includes(remembered)
      ? remembered : g.pages.find(available);
    if (target) navigate(target);
  };
  // An alert's target is a classic tab with a filter; requestNav parks the
  // filter and fires hw:navigate, which App resolves to a map page.
  const goAlert = (tab, filter) => {
    setMenu(null);
    requestNav(tab, filter ? { filter } : {});
  };
  const alertPageLabel = (tab) => {
    const p = resolveMapPage(tab);
    if (!p || p === MAP_TAB) return null;
    const g = mapGroupOf(p);
    return g ? `${g.label} ▸ ${pageLabel(p)}` : pageLabel(p);
  };

  const alerts = useAirlineAlerts(state);
  const events = state.activeEvents ?? [];

  const group = page ? mapGroupOf(page) : null;
  const groupPages = group ? group.pages.filter(available) : [];
  const ActiveIcon = page ? (group?.Icon ?? pageIcon(page)) : null;
  const lastWeek = state.lastReport?.cashDelta;
  const onDashboard = page === 'dashboard';

  return (
    <div className={`ms-root${panelOpen ? ' ms-panel-open' : ''}`}>
      {/* The map — always mounted, so closing a panel is instant and keeps
          the zoom the player left it at. */}
      <div className="ms-map" aria-hidden={panelOpen ? 'true' : undefined}>
        {/* paused: a page covers it, so it holds its last frame (044e14e). */}
        <MapBoundary><RouteMap fullBleed paused={panelOpen} /></MapBoundary>
      </div>

      {/* Top HUD */}
      <div className="ms-top">
        <button type="button" className="ms-crest" onClick={onBranding} title="Edit airline branding">
          <span className="ms-crest-logo">
            <AirlineLogo id={state.logoId} customSrc={state.customLogo} size={52} radius={10} accentColor={state.logoColor} />
          </span>
          <span className="ms-crest-plate">
            <span className="ms-crest-name">{state.airlineName}</span>
            {state.hub && <span className="ms-crest-sub">{state.hub}</span>}
          </span>
        </button>

        <div className={`ms-status${remote ? ' no-next' : ''}`} role="group" aria-label="Cash and date">
          <span className="ms-cash" title="Cash">
            <CoinsIcon size={18} />
            <span className={`ms-cash-value${state.cash < 0 ? ' negative' : ''}`}>{formatMoney(state.cash)}</span>
            {lastWeek != null && (
              <span
                className={`ms-delta ${lastWeek >= 0 ? 'up' : 'down'}`}
                data-last-week={lastWeek}
                title="Last week's result: the change in cash over the last week"
              >{signedMoney(lastWeek)}<span className="ms-delta-sub"> last wk</span></span>
            )}
          </span>
          <span className="ms-status-sep ms-date-sep" aria-hidden="true" />
          <span className="ms-date">{formatGameDate(state)}</span>
          {remote ? (
            remoteChrome?.clock ? (<>
              <span className="ms-status-sep" aria-hidden="true" />
              <span className="ms-clock">{remoteChrome.clock}</span>
            </>) : null
          ) : (
            <button type="button" className="ms-next" onClick={onAdvance} title="Advance now (auto-advances in the shown time)">
              Next week <span className="ms-next-sub">{countdown}</span>
            </button>
          )}
        </div>

        <div className={`ms-top-right${remote ? ' is-remote' : ''}`}>
          {remote && remoteChrome?.right && <span className="ms-remote-chrome">{remoteChrome.right}</span>}
          <span className="ms-help-row">
            {available('wiki') && (
              <button
                type="button"
                data-shell="wiki"
                className={`ms-top-btn${page === 'wiki' ? ' active' : ''}`}
                onClick={() => (page === 'wiki' ? openPage(MAP_TAB) : openPage('wiki'))}
                title="Game guide"
              ><CompassIcon size={15} /><span className="ms-top-btn-label">Guide</span></button>
            )}
            <button type="button" data-shell="tutorial" className="ms-top-btn" onClick={() => { setMenu(null); onTour(); }} title="Replay the tutorial">
              <RocketIcon size={15} /><span className="ms-top-btn-label">Tutorial</span>
            </button>
            {discordHref && (
              <a data-shell="discord" className="ms-top-btn" href={discordHref} target="_blank" rel="noopener noreferrer" title="Join the Discord">
                <ChatIcon size={15} /><span className="ms-top-btn-label">Discord</span>
              </a>
            )}
            <button
              type="button"
              data-shell="settings"
              className={`ms-top-btn ms-top-icon${menu?.key === 'settings' ? ' open' : ''}`}
              onClick={(e) => { const anchor = e.currentTarget; setMenu(m => (m?.key === 'settings' ? null : { key: 'settings', anchor })); }}
              aria-haspopup="menu"
              aria-expanded={menu?.key === 'settings'}
              title="Settings"
            >
              <SettingsIcon size={16} />
            </button>
          </span>
        </div>
      </div>

      <AlertRail alerts={alerts} events={events} go={goAlert} openPage={openPage} pageFor={alertPageLabel} />

      {/* Bottom left: Map ⇄ Dashboard */}
      {available('dashboard') && (
        <button
          type="button"
          data-shell="dashboard"
          className={`ms-home${onDashboard ? ' active' : ''}`}
          onClick={() => openPage(onDashboard ? MAP_TAB : 'dashboard')}
          title={onDashboard ? 'Back to the map (Esc)' : 'Open the Dashboard'}
        >
          {onDashboard ? <MapIcon size={20} /> : <DashboardIcon size={20} />}
          <span>{onDashboard ? 'Map' : 'Dashboard'}</span>
        </button>
      )}

      {showHint && !panelOpen && (
        <div className="ms-beta-hint" role="status">
          <span className="ms-beta-tag">Beta</span>
          <span>You're trying the map view. Switch back any time in <strong>⚙ Settings ▸ Back to classic layout</strong>.</span>
          <button type="button" onClick={dismissHint} aria-label="Got it">Got it</button>
        </div>
      )}

      {/* Bottom dock — one click per group */}
      <nav className="ms-dock" aria-label="Main">
        {MAP_GROUPS.map(g => {
          if (!g.pages.some(available)) return null;
          const Icon = g.Icon;
          const active = !!page && g.pages.includes(page);
          return (
            <button
              key={g.id}
              type="button"
              data-shell={`group:${g.id}`}
              className={`ms-dock-btn${active ? ' active' : ''}`}
              onClick={() => toggleGroup(g)}
              aria-pressed={active}
              title={g.pages.filter(available).map(pageLabel).join(' · ')}
            >
              <Icon size={20} />
              <span className="ms-lbl-long">{g.label}</span>
              <span className="ms-lbl-short">{g.short ?? g.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Settings */}
      {menu?.key === 'settings' && (
        <PopMenu anchor={menu.anchor} onClose={() => setMenu(null)} label="Settings">
          <div className="ms-menu-title">Map style</div>
          <div className="ms-menu-seg" role="group" aria-label="Map style">
            {[['satellite', 'Satellite'], ['dark', 'Dark']].map(([v, l]) => (
              <button key={v} className={basemap === v ? 'active' : ''} aria-pressed={basemap === v} onClick={() => setBasemap(v)}>{l}</button>
            ))}
          </div>
          <div className="ms-menu-sep" />
          <button role="menuitem" onClick={() => { setMenu(null); onBranding(); }}>
            <span className="ms-menu-glyph">✎</span><span>Airline branding</span>
          </button>
          <button role="menuitem" data-alert-settings onClick={() => { setMenu(null); openAlertSettings(); }}>
            <BellIcon size={15} /><span>Pop-up alerts</span>
          </button>
          <button role="menuitem" data-layout-switch="classic" onClick={() => { setMenu(null); dismissHint(); onClassic(); }}>
            <span className="ms-menu-glyph">▤</span><span>Back to classic layout</span>
          </button>
          {!remote && (<>
            <div className="ms-menu-sep" />
            <button role="menuitem" onClick={() => { setMenu(null); onSave(); }}><SaveIcon size={15} /><span>Save game</span></button>
            <button role="menuitem" onClick={() => { setMenu(null); onLoad(); }}><FolderOpenIcon size={15} /><span>Load game</span></button>
            <button role="menuitem" className="danger" onClick={() => { setMenu(null); onNewGame(); }}><span className="ms-menu-glyph">↺</span><span>New game</span></button>
          </>)}
        </PopMenu>
      )}

      {/* The open page */}
      {panelOpen && (
        <>
          <div className="ms-panel-backdrop" onClick={() => navigate(MAP_TAB)} />
          <section className="ms-panel" role="dialog" aria-label={group ? `${group.label}: ${pageLabel(page)}` : pageLabel(page)}>
            <header className="ms-panel-head">
              {ActiveIcon && <ActiveIcon size={16} />}
              <h2 className={groupPages.length > 1 ? 'has-tabs' : undefined}>{group ? group.label : pageLabel(page)}</h2>
              {groupPages.length > 1 && (
                <div className="ms-tabs" role="tablist" aria-label={group.label}>
                  {groupPages.map(id => (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      data-page={id}
                      aria-selected={page === id}
                      className={page === id ? 'active' : ''}
                      onClick={() => openPage(id)}
                    >{pageLabel(id)}</button>
                  ))}
                </div>
              )}
              <button type="button" className="ms-panel-close" onClick={() => navigate(MAP_TAB)} aria-label="Close and show the map" title="Back to the map (Esc)">
                <CloseIcon size={16} />
              </button>
            </header>
            <div className="ms-panel-body main-content" key={page}>
              {pages[page]}
              {footer}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
