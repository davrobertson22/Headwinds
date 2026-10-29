import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import RouteMap from './RouteMap.jsx';
import AirlineLogo from './AirlineLogo.jsx';
import useBasemap from '../hooks/useBasemap.js';
import { LAYOUT_KEY } from './mapCore.js';
import { formatMoney, formatGameDate } from '../utils/simulation.js';
import { CoinsIcon, SettingsIcon, CloseIcon, SaveIcon, FolderOpenIcon } from './Icons.jsx';

// ── Map-first layout ──────────────────────────────────────────────────────────
// The world map is the whole screen; everything else floats over it. The
// classic layout (top bar + tab strip + page) is untouched — this is a second
// shell over the SAME screens, chosen per browser (LAYOUT_KEY) and switched
// from the settings menu here or the top bar there.
//
//   top centre     cash + date pill, then Next week (solo) / the world clock
//   top left       the airline badge (opens branding)
//   top right      multiplayer chrome — lobby, invite, feed, messages
//   left rail      Airports ▸, News, Fleet ▸
//   right rail     Rivals, Dashboard, Finance
//   bottom dock    Company ▸, Search (Route Finder), Network ▸, Market
//   corners        Help (left), Settings (right)
//
// Any page opens in a panel over the map, with the rails and dock still live
// so the player can hop between screens without closing it. "Map" (or ✕, Esc,
// or a click on the dimmed map) closes the panel.
//
// Every screen is reached from the same nav model App.jsx owns (TABS / NAV
// GROUPS), so nothing here can drift from what navPath.js tells the tour.

export { LAYOUT_KEY };
export const LAYOUTS = ['classic', 'map'];

// ── Opt-in ───────────────────────────────────────────────────────────────────
// The map-first layout is a beta players choose to try. Classic shows a slim
// invitation strip (and a NEW dot on the Map view button) until the player has
// tried it once or dismissed it; the first visit to map-first shows a one-off
// hint saying how to get back.
export const LAYOUT_INVITE_KEY = 'headwinds.layoutInvite';   // 'tried' | 'dismissed'
export const MAP_HINT_KEY = 'headwinds.mapHintSeen';

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

/** Where each control sits. Exported so a test can assert every reachable tab
 *  is still reachable from the map-first layout. Entries are a tab id or a
 *  nav-group label (which opens that group's menu). */
export const SHELL_SLOTS = {
  left:  ['group:Airports', 'news', 'group:Fleet'],
  right: ['competition', 'dashboard', 'finance'],
  dock:  ['group:Company', 'finder', 'group:Network', 'market'],
  corner: ['wiki'],
};

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
function PopMenu({ anchor, side, onClose, children, label }) {
  if (!anchor) return null;
  const r = anchor.getBoundingClientRect();
  const W = 220;
  const vw = window.innerWidth;
  const style = {};
  if (side === 'up') {
    style.left = Math.max(8, Math.min(r.left + r.width / 2 - W / 2, vw - W - 8));
    style.bottom = window.innerHeight - r.top + 8;
  } else if (side === 'up-left') {
    style.right = Math.max(8, vw - r.right);
    style.bottom = window.innerHeight - r.top + 8;
  } else if (side === 'right') {
    style.left = r.right + 8;
    style.top = Math.max(8, r.top - 4);
  } else {
    style.left = Math.max(8, r.left - W - 8);
    style.top = Math.max(8, Math.min(r.top - 4, window.innerHeight - 320));
  }
  return createPortal(
    <>
      <div className="ms-menu-backdrop" onClick={onClose} />
      <div className="ms-menu" role="menu" aria-label={label} style={{ ...style, width: W }}>
        {children}
      </div>
    </>,
    document.body,
  );
}

export default function MapShell({
  state, remote, remoteChrome,
  tabs, navGroups, tabLabel, activeTab, navigate, content, footer,
  onAdvance, countdown, onBranding, onTour, onSave, onLoad, onNewGame, onClassic,
  discordHref,
}) {
  const [menu, setMenu] = useState(null);         // { key, anchor, side }
  // First visit only: say how to get back to the classic layout.
  const [showHint, setShowHint] = useState(() => !readHintSeen());
  const dismissHint = () => {
    setShowHint(false);
    try { localStorage.setItem(MAP_HINT_KEY, '1'); } catch { /* private mode */ }
  };
  const [basemap, setBasemap] = useBasemap();
  const panelOpen = activeTab && activeTab !== MAP_TAB;

  const closeAll = useCallback(() => {
    if (menu) { setMenu(null); return; }
    if (panelOpen) navigate(MAP_TAB);
  }, [menu, panelOpen, navigate]);
  useEscape(closeAll);

  const go = (id) => { setMenu(null); navigate(id); };
  const groupsByLabel = Object.fromEntries(navGroups.filter(g => g.children).map(g => [g.label, g]));
  const hasTab = (id) => !!tabs[id] && (id !== 'news' || remote);

  const openMenu = (key, side) => (e) => {
    const anchor = e.currentTarget;
    setMenu(m => (m?.key === key ? null : { key, anchor, side }));
  };

  // One control per slot entry. `variant` is 'rail' (round icon) or 'dock'.
  const slot = (entry, variant, side) => {
    if (entry.startsWith('group:')) {
      const g = groupsByLabel[entry.slice(6)];
      if (!g) return null;
      const Icon = g.Icon;
      const active = g.children.includes(activeTab) && activeTab !== MAP_TAB;
      const open = menu?.key === entry;
      return (
        <button
          key={entry}
          type="button"
          data-shell={entry}
          className={`ms-${variant}-btn${active ? ' active' : ''}${open ? ' open' : ''}`}
          onClick={openMenu(entry, side)}
          aria-haspopup="menu"
          aria-expanded={open}
          title={g.label}
        >
          <Icon size={variant === 'dock' ? 20 : 19} />
          {variant === 'dock' && <span>{g.label}</span>}
        </button>
      );
    }
    if (!hasTab(entry)) return null;
    const t = tabs[entry];
    const Icon = t.Icon;
    const label = tabLabel(entry);
    const short = entry === 'finder' ? 'Search' : label;
    return (
      <button
        key={entry}
        type="button"
        data-shell={entry}
        className={`ms-${variant}-btn${activeTab === entry ? ' active' : ''}`}
        onClick={() => (activeTab === entry ? go(MAP_TAB) : go(entry))}
        aria-pressed={activeTab === entry}
        title={label}
      >
        <Icon size={variant === 'dock' ? 20 : 19} />
        {variant === 'dock' && <span>{short}</span>}
      </button>
    );
  };

  const openGroup = menu?.key?.startsWith('group:') ? groupsByLabel[menu.key.slice(6)] : null;
  const active = panelOpen ? tabs[activeTab] : null;
  const ActiveIcon = active?.Icon;

  return (
    <div className={`ms-root${panelOpen ? ' ms-panel-open' : ''}`}>
      {/* The map — always mounted, so closing a panel is instant and keeps
          the zoom the player left it at. */}
      <div className="ms-map" aria-hidden={panelOpen ? 'true' : undefined}>
        <RouteMap fullBleed />
      </div>

      {/* Top HUD */}
      <div className="ms-top">
        <button type="button" className="ms-airline" onClick={onBranding} title="Edit airline branding">
          <AirlineLogo id={state.logoId} customSrc={state.customLogo} size={26} radius={6} accentColor={state.logoColor} />
          <span className="ms-airline-name">{state.airlineName}</span>
        </button>

        <div className="ms-centre">
          <div className="ms-cash" title={`Cash · ${formatGameDate(state)}`}>
            <CoinsIcon size={16} />
            <span className={`ms-cash-value${state.cash < 0 ? ' negative' : ''}`}>{formatMoney(state.cash)}</span>
            <span className="ms-date">{formatGameDate(state)}</span>
          </div>
          {remote ? (
            remoteChrome?.clock ? <div className="ms-next ms-clock">{remoteChrome.clock}</div> : null
          ) : (
            <button type="button" className="ms-next" onClick={onAdvance} title="Advance now (auto-advances in the shown time)">
              Next week <span className="ms-next-sub">{countdown}</span>
            </button>
          )}
        </div>

        <div className="ms-top-right">
          {remote && remoteChrome?.right}
        </div>
      </div>

      {/* Side rails */}
      <nav className="ms-rail ms-rail-left" aria-label="Airports, news and fleet">
        {SHELL_SLOTS.left.map(e => slot(e, 'rail', 'right'))}
      </nav>
      <nav className="ms-rail ms-rail-right" aria-label="Rivals, dashboard and finance">
        {SHELL_SLOTS.right.map(e => slot(e, 'rail', 'left'))}
      </nav>

      {/* Corners */}
      <div className="ms-corner ms-corner-left">{SHELL_SLOTS.corner.map(e => slot(e, 'rail', 'right'))}</div>
      <div className="ms-corner ms-corner-right">
        <button
          type="button"
          data-shell="settings"
          className={`ms-rail-btn${menu?.key === 'settings' ? ' open' : ''}`}
          onClick={openMenu('settings', 'up-left')}
          aria-haspopup="menu"
          aria-expanded={menu?.key === 'settings'}
          title="Settings"
        >
          <SettingsIcon size={19} />
        </button>
      </div>

      {showHint && !panelOpen && (
        <div className="ms-beta-hint" role="status">
          <span className="ms-beta-tag">Beta</span>
          <span>You're trying the map view. Switch back any time in <strong>⚙ Settings ▸ Classic layout</strong>.</span>
          <button type="button" onClick={dismissHint} aria-label="Got it">Got it</button>
        </div>
      )}

      {/* Bottom dock */}
      <nav className="ms-dock" aria-label="Main">
        {SHELL_SLOTS.dock.map(e => slot(e, 'dock', 'up'))}
      </nav>

      {/* Group menus */}
      {openGroup && (
        <PopMenu anchor={menu.anchor} side={menu.side} onClose={() => setMenu(null)} label={openGroup.label}>
          <div className="ms-menu-title">{openGroup.label}</div>
          {openGroup.children.filter(hasTab).map(cid => {
            const CIcon = tabs[cid].Icon;
            const isMap = cid === MAP_TAB;
            const on = isMap ? !panelOpen : activeTab === cid;
            return (
              <button key={cid} role="menuitem" className={on ? 'active' : ''} onClick={() => go(cid)}>
                <CIcon size={15} />
                <span>{isMap ? 'Map only' : tabLabel(cid)}</span>
              </button>
            );
          })}
        </PopMenu>
      )}

      {/* Settings */}
      {menu?.key === 'settings' && (
        <PopMenu anchor={menu.anchor} side={menu.side} onClose={() => setMenu(null)} label="Settings">
          <div className="ms-menu-title">Map style</div>
          <div className="ms-menu-seg" role="group" aria-label="Map style">
            {[['satellite', 'Satellite'], ['dark', 'Dark']].map(([v, l]) => (
              <button key={v} className={basemap === v ? 'active' : ''} aria-pressed={basemap === v} onClick={() => setBasemap(v)}>{l}</button>
            ))}
          </div>
          <div className="ms-menu-sep" />
          <button role="menuitem" data-layout-switch="classic" onClick={() => { setMenu(null); dismissHint(); onClassic(); }}>
            <span className="ms-menu-glyph">▤</span><span>Back to classic layout</span>
          </button>
          <button role="menuitem" onClick={() => { setMenu(null); onTour(); }}>
            <span className="ms-menu-glyph">?</span><span>How to play</span>
          </button>
          {discordHref && (
            <a role="menuitem" href={discordHref} target="_blank" rel="noopener noreferrer" onClick={() => setMenu(null)}>
              <span className="ms-menu-glyph">◎</span><span>Discord</span>
            </a>
          )}
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
          <section className="ms-panel" role="dialog" aria-label={tabLabel(activeTab)}>
            <header className="ms-panel-head">
              {ActiveIcon && <ActiveIcon size={16} />}
              <h2>{tabLabel(activeTab)}</h2>
              <button type="button" className="ms-panel-close" onClick={() => navigate(MAP_TAB)} aria-label="Close and show the map" title="Back to the map (Esc)">
                <CloseIcon size={16} />
              </button>
            </header>
            <div className="ms-panel-body main-content" key={activeTab}>
              {content}
              {footer}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
