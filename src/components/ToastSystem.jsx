import { createContext, useContext, useReducer, useEffect } from 'react';
import { CheckIcon, AlertIcon, CloseIcon } from './Icons.jsx';

// ── Context ───────────────────────────────────────────────────────────────────

const ToastCtx = createContext(null);

let _id = 1;

function reducer(toasts, action) {
  switch (action.type) {
    case 'ADD':    return [...toasts, { ...action.toast, id: _id++ }];
    case 'REMOVE': return toasts.filter(t => t.id !== action.id);
    default:       return toasts;
  }
}

export function ToastProvider({ children }) {
  const [toasts, dispatch] = useReducer(reducer, []);
  return (
    <ToastCtx.Provider value={dispatch}>
      {children}
      <ToastContainer toasts={toasts} dispatch={dispatch} />
    </ToastCtx.Provider>
  );
}

/** Returns a function: addToast({ type, title, message, icon?, duration? }) */
export function useToast() {
  const dispatch = useContext(ToastCtx);
  return (toast) => dispatch({ type: 'ADD', toast });
}

// ── Container ─────────────────────────────────────────────────────────────────

function ToastContainer({ toasts, dispatch }) {
  if (toasts.length === 0) return null;
  return (
    <div style={{
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

function Toast({ toast, onDismiss }) {
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
      </div>
      <button
        onClick={onDismiss}
        style={{
          background: 'none', border: 'none', color: 'var(--text-dim)',
          cursor: 'pointer', fontSize: 16, padding: 0, lineHeight: 1,
          flexShrink: 0, marginTop: 1,
        }}
      >×</button>
    </div>
  );
}
