import { useState } from 'react';
import useIsMobile from '../hooks/useIsMobile.js';

// A page's explainer, folded on phones (mobile audit item 8). On a computer it
// renders its children untouched. On a phone it shows one line, "ⓘ <label> ▾",
// and the explainer opens under it on a tap; the choice is remembered per page
// (localStorage `fold:<id>`), so a player who wants it open keeps it open.
// Intros like Route Finder's ran ~180px: half the screen below the game's own
// top bar, before the page's tools began.
export default function FoldOnPhone({ id, label, children }) {
  const isMobile = useIsMobile();
  const key = `fold:${id}`;
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(key) === 'open'; } catch { return false; }
  });
  if (!isMobile) return children;
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try { if (next) localStorage.setItem(key, 'open'); else localStorage.removeItem(key); } catch { /* private mode */ }
  };
  return (
    <>
      <button type="button" className="fold-toggle" aria-expanded={open} onClick={toggle} data-fold={id}>
        <span aria-hidden="true">ⓘ</span>
        <span>{label}</span>
        <span aria-hidden="true" className="fold-caret">{open ? '▴' : '▾'}</span>
      </button>
      {open && children}
    </>
  );
}
