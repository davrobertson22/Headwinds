import { createContext, useContext, useState, useCallback, useEffect } from 'react';

// A styled confirm/alert dialog replacing native window.confirm / window.alert
// (which render as raw OS chrome and read as unfinished). Promise-based so call
// sites stay readable:
//
//   const confirm = useConfirm();
//   if (await confirm({ title: 'Sell aircraft?', body: '…', danger: true })) { … }
//
// .alert() shows a single OK button. Styles are inline with hex fallbacks so the
// dialog looks right in BOTH the in-game tree (solo index.css) and the Headwinds
// lobby tree (styles.css), which define different CSS-variable names.
const ConfirmCtx = createContext(null);

const S = {
  overlay: {
    position: 'fixed', inset: 0, zIndex: 3000,
    background: 'rgba(5,8,14,.78)',
    backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
  },
  modal: {
    background: 'var(--surface, #121820)',
    border: '1px solid var(--border, #263143)',
    borderRadius: 12,
    padding: '22px 24px 18px',
    width: 'min(440px, 94vw)',
    boxShadow: '0 24px 60px rgba(0,0,0,.6)',
    color: 'var(--text, #e8edf4)',
  },
  title: { fontSize: 16, fontWeight: 700, margin: '0 0 10px', lineHeight: 1.3 },
  body:  { fontSize: 13, color: 'var(--text-muted, #93a4ba)', lineHeight: 1.6, margin: '0 0 20px', whiteSpace: 'pre-line' },
  actions: { display: 'flex', gap: 10, justifyContent: 'flex-end' },
  btnBase: { padding: '8px 16px', fontSize: 13, fontWeight: 600, borderRadius: 7, cursor: 'pointer' },
  ghost: { background: 'transparent', color: 'var(--text-muted, #93a4ba)', border: '1px solid var(--border, #263143)' },
  primary: { background: 'var(--accent, #38c9b4)', color: '#06201c', border: 'none' },
  danger: { background: 'var(--red, #f85149)', color: '#fff', border: 'none' },
};

export function ConfirmProvider({ children }) {
  const [req, setReq] = useState(null);

  const ask = useCallback((opts) => new Promise((resolve) => {
    const o = typeof opts === 'string' ? { title: opts } : (opts || {});
    setReq({ ...o, resolve });
  }), []);

  const api = useCallback((opts) => ask(opts), [ask]);
  api.alert = useCallback((opts) => ask({ ...(typeof opts === 'string' ? { title: opts } : opts), alertOnly: true }), [ask]);

  const close = (result) => setReq((r) => { r?.resolve(result); return null; });

  useEffect(() => {
    if (!req) return;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(false); }
      if (e.key === 'Enter')  { e.preventDefault(); close(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [req]);

  return (
    <ConfirmCtx.Provider value={api}>
      {children}
      {req && (
        <div style={S.overlay} onClick={(e) => { if (e.target === e.currentTarget) close(false); }}>
          <div style={S.modal} role="alertdialog" aria-modal="true">
            <h2 style={S.title}>{req.title}</h2>
            {req.body && <p style={S.body}>{req.body}</p>}
            <div style={S.actions}>
              {!req.alertOnly && (
                <button style={{ ...S.btnBase, ...S.ghost }} onClick={() => close(false)}>
                  {req.cancelLabel ?? 'Cancel'}
                </button>
              )}
              <button
                style={{ ...S.btnBase, ...(req.danger ? S.danger : S.primary) }}
                autoFocus
                onClick={() => close(true)}
              >
                {req.confirmLabel ?? (req.alertOnly ? 'OK' : 'Confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmCtx.Provider>
  );
}

// Returns an async confirm(opts) → boolean; .alert(opts) shows a single OK button.
// Falls back to native dialogs if no provider is mounted.
export function useConfirm() {
  const api = useContext(ConfirmCtx);
  if (api) return api;
  const fallback = (opts) => {
    const o = typeof opts === 'string' ? { title: opts } : (opts || {});
    return Promise.resolve(window.confirm([o.title, o.body].filter(Boolean).join('\n\n')));
  };
  fallback.alert = (opts) => {
    const o = typeof opts === 'string' ? { title: opts } : (opts || {});
    window.alert([o.title, o.body].filter(Boolean).join('\n\n'));
    return Promise.resolve(true);
  };
  return fallback;
}
