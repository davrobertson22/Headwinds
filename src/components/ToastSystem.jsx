import { createContext, useContext, useReducer, useEffect, useRef, useState, useCallback } from 'react';
import { CheckIcon, AlertIcon, CloseIcon, BellIcon } from './Icons.jsx';
import {
  ALERT_CATEGORIES, ALERT_SETTINGS_OPEN_EVENT, RECENT_ALERTS_CAP,
  alertCategory, shouldShowToast, loadAlertPrefs, saveAlertPrefs, normalizeAlertPrefs,
  hiddenCount, openAlertSettings, isEditableTarget,
} from '../utils/alertPrefs.js';

// ── Context ───────────────────────────────────────────────────────────────────

const ToastCtx = createContext(null);
const NOOP = () => {};

let _id = 1;

function reducer(toasts, action) {
  switch (action.type) {
    case 'ADD':    return [...toasts, { ...action.toast, id: _id++ }];
    case 'REMOVE': return toasts.filter(t => t.id !== action.id);
    case 'CLEAR':  return toasts.length ? [] : toasts;
    default:       return toasts;
  }
}

/**
 * Pop-ups, plus the player's controls over them (Discord, 2026-10-30):
 *   · "Clear all" on the stack, and the Delete / Backspace key, close every
 *     pop-up on screen at once;
 *   · the 🔔 panel hides weekly pop-ups altogether or by kind, and keeps a list
 *     of this session's recent ones so a hidden alert is never simply lost.
 * Filtering rules live in utils/alertPrefs.js.
 */
export function ToastProvider({ children, initialPrefs }) {
  const [toasts, dispatch] = useReducer(reducer, []);
  const [prefs, setPrefsState] = useState(() => initialPrefs ? normalizeAlertPrefs(initialPrefs) : loadAlertPrefs());
  const [recent, setRecent] = useState([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const toastsRef = useRef(toasts);
  toastsRef.current = toasts;

  const add = useCallback((toast) => {
    if (!toast) return;
    if (toast.alert) {
      const shown = shouldShowToast(toast, prefsRef.current);
      setRecent(r => [{ ...toast, rid: _id++, hidden: !shown, category: alertCategory(toast) }, ...r].slice(0, RECENT_ALERTS_CAP));
      if (!shown) return;
    }
    dispatch({ type: 'ADD', toast });
  }, []);

  const setPrefs = useCallback((next) => setPrefsState(saveAlertPrefs(next)), []);
  const clearAll = useCallback(() => dispatch({ type: 'CLEAR' }), []);

  // Delete (and Backspace — the Mac "delete" key) clears every pop-up, unless
  // the player is typing somewhere.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      if (e.defaultPrevented || e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (isEditableTarget(e.target) || isEditableTarget(document.activeElement)) return;
      if (!toastsRef.current.length) return;
      e.preventDefault();
      dispatch({ type: 'CLEAR' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const open = () => setSettingsOpen(true);
    window.addEventListener(ALERT_SETTINGS_OPEN_EVENT, open);
    return () => window.removeEventListener(ALERT_SETTINGS_OPEN_EVENT, open);
  }, []);

  return (
    <ToastCtx.Provider value={add}>
      {children}
      <ToastContainer toasts={toasts} dispatch={dispatch} onClearAll={clearAll} prefs={prefs} />
      {settingsOpen && (
        <AlertSettings prefs={prefs} setPrefs={setPrefs} recent={recent} onClose={() => setSettingsOpen(false)} />
      )}
    </ToastCtx.Provider>
  );
}

/** Returns a function: addToast({ type, title, message, icon?, duration?, alert? }) */
export function useToast() {
  return useContext(ToastCtx) ?? NOOP;
}

// ── Container ─────────────────────────────────────────────────────────────────

const smallBtn = {
  background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px',
  fontSize: 11, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4,
};

export function ToastContainer({ toasts, dispatch, onClearAll, prefs }) {
  if (toasts.length === 0) return null;
  // The bar appears once there's something worth clearing, or a weekly alert
  // whose kind the player might want to switch off.
  const showBar = toasts.length >= 2 || toasts.some(t => t.alert);
  const off = hiddenCount(prefs);
  return (
    <div className="toast-stack" style={{
      position: 'fixed',
      bottom: 20,
      right: 20,
      display: 'flex',
      flexDirection: 'column-reverse',
      gap: 8,
      zIndex: 2000,
      width: 300,
      pointerEvents: 'none',
    }}>
      {toasts.map(t => (
        <Toast
          key={t.id}
          toast={t}
          onDismiss={() => dispatch({ type: 'REMOVE', id: t.id })}
        />
      ))}
      {showBar && (
        // Last in the DOM = top of the column-reverse stack.
        <div className="toast-bar" style={{
          display: 'flex', alignItems: 'center', gap: 6,
          alignSelf: 'flex-end',
          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 999,
          padding: '2px 6px 2px 10px', boxShadow: '0 4px 14px rgba(0,0,0,.45)',
          pointerEvents: 'all', fontSize: 11, color: 'var(--text-muted)',
        }}>
          <span>{toasts.length} pop-up{toasts.length !== 1 ? 's' : ''}</span>
          <button
            type="button"
            data-alert-settings
            onClick={openAlertSettings}
            title="Choose which pop-ups to show"
            aria-label="Pop-up settings"
            style={{ ...smallBtn, color: off ? 'var(--accent)' : 'var(--text-dim)' }}
          >
            <BellIcon size={13} />{off ? <span>{off} off</span> : null}
          </button>
          <button
            type="button"
            data-clear-all
            onClick={onClearAll}
            title="Clear all pop-ups (Delete key)"
            style={{ ...smallBtn, color: 'var(--accent)' }}
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  );
}

// ── Settings panel ────────────────────────────────────────────────────────────

export function AlertSettings({ prefs, setPrefs, recent = [], onClose }) {
  const p = normalizeAlertPrefs(prefs);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggleCat = (id) => setPrefs({ ...p, hidden: { ...p.hidden, [id]: !p.hidden[id] } });
  const label = Object.fromEntries(ALERT_CATEGORIES.map(c => [c.id, c.label]));

  return (
    <div
      className="alert-settings-overlay"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 2100, background: 'rgba(0,0,0,.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
    >
      <div role="dialog" aria-modal="true" aria-label="Pop-up alerts" className="alert-settings" style={{
        background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg, 14px)',
        width: 'min(460px, 100%)', maxHeight: 'min(640px, calc(100vh - 32px))', overflowY: 'auto',
        boxShadow: '0 18px 44px -14px rgba(0,0,0,.6)', padding: '16px 18px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ color: 'var(--accent)', display: 'inline-flex' }}><BellIcon size={16} /></span>
          <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)', flex: 1 }}>Pop-up alerts</div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ ...smallBtn, fontSize: 18, color: 'var(--text-dim)' }}>×</button>
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5, margin: '0 0 12px' }}>
          Choose which of the weekly pop-ups you see. Pop-ups about something you just did
          (like “Not enough cash”) always show. Press <kbd>Delete</kbd> to clear everything on screen.
        </p>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600, color: 'var(--text)', cursor: 'pointer', padding: '6px 0' }}>
          <input
            type="checkbox"
            data-alert-master
            checked={p.showAlerts}
            onChange={() => setPrefs({ ...p, showAlerts: !p.showAlerts })}
            style={{ accentColor: 'var(--accent)' }}
          />
          Show weekly pop-ups
        </label>

        <div style={{ borderTop: '1px solid var(--border)', margin: '6px 0 4px' }} />
        {ALERT_CATEGORIES.map(c => (
          <label key={c.id} style={{
            display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 0',
            cursor: p.showAlerts ? 'pointer' : 'default', opacity: p.showAlerts ? 1 : 0.45,
          }}>
            <input
              type="checkbox"
              data-alert-cat={c.id}
              checked={p.showAlerts && !p.hidden[c.id]}
              disabled={!p.showAlerts}
              onChange={() => toggleCat(c.id)}
              style={{ marginTop: 2, accentColor: 'var(--accent)' }}
            />
            <span>
              <span style={{ display: 'block', fontSize: 13, color: 'var(--text)' }}>{c.label}</span>
              <span style={{ display: 'block', fontSize: 11, color: 'var(--text-dim)' }}>{c.hint}</span>
            </span>
          </label>
        ))}

        <div style={{ borderTop: '1px solid var(--border)', margin: '10px 0 8px' }} />
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>
          Recent weekly pop-ups
        </div>
        {recent.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>None yet since you opened the game.</div>
        ) : (
          <ul className="alert-recent" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {recent.map(r => (
              <li key={r.rid} style={{ fontSize: 12, lineHeight: 1.4, opacity: r.hidden ? 0.7 : 1 }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                  <span style={{ fontWeight: 600, color: 'var(--text)', flex: 1, minWidth: 0 }}>{r.title}</span>
                  {r.hidden && (
                    <span title={label[r.category] ?? ''} style={{ fontSize: 10, color: 'var(--text-dim)', border: '1px solid var(--border)', borderRadius: 999, padding: '0 6px', whiteSpace: 'nowrap' }}>hidden</span>
                  )}
                </div>
                {r.message && <div style={{ color: 'var(--text-muted)' }}>{r.message}</div>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ── Individual toast ──────────────────────────────────────────────────────────

const TYPE_CONFIG = {
  success: { color: 'var(--green)', icon: CheckIcon },
  warning: { color: 'var(--yellow)', icon: AlertIcon },
  danger:  { color: 'var(--red)',   icon: CloseIcon },
  info:    { color: 'var(--accent)', icon: 'ℹ' },
};

export function Toast({ toast, onDismiss }) {
  const dur = toast.duration ?? (toast.type === 'event' ? 6000 : 4000);

  useEffect(() => {
    const t = setTimeout(onDismiss, dur);
    return () => clearTimeout(t);
  }, []);

  const cfg = TYPE_CONFIG[toast.type] ?? TYPE_CONFIG.info;
  const color = toast.eventColor ?? cfg.color;
  const icon  = toast.icon       ?? cfg.icon;

  return (
    <div style={{
      background: 'var(--surface)',
      border: `1px solid var(--border)`,
      borderLeft: `3px solid ${color}`,
      borderRadius: 'var(--radius)',
      padding: '10px 12px',
      display: 'flex',
      gap: 10,
      alignItems: 'flex-start',
      boxShadow: '0 4px 20px rgba(0,0,0,.55)',
      pointerEvents: 'all',
      animation: 'toast-slide-in .2s ease',
    }}>
      <span style={{ color, flexShrink: 0, fontSize: 15, marginTop: 1, lineHeight: 1, display: 'inline-flex' }}>
        {typeof icon === 'function' ? (() => { const Ic = icon; return <Ic size={15} />; })() : icon}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {toast.title && (
          <div style={{ fontWeight: 600, fontSize: 13, color, marginBottom: 2 }}>{toast.title}</div>
        )}
        <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.45 }}>{toast.message}</div>
        {toast.link?.href && (
          <a
            href={toast.link.href} target="_blank" rel="noopener noreferrer"
            style={{ display: 'inline-block', marginTop: 4, fontSize: 12, fontWeight: 600, color, textDecoration: 'none' }}
          >{toast.link.label ?? 'Open →'}</a>
        )}
      </div>
      <button
        onClick={onDismiss}
        aria-label="Dismiss"
        style={{
          background: 'none', border: 'none', color: 'var(--text-dim)',
          cursor: 'pointer', fontSize: 16, padding: 0, lineHeight: 1,
          flexShrink: 0, marginTop: 1,
        }}
      >×</button>
    </div>
  );
}
