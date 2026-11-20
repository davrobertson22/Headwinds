import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

// Tips you can tap (mobile audit item 10). A phone has no hover, so the game's
// `title` text (on figures, badges and the ⓘ InfoTips) never shows there, and
// InfoTip's own CSS bubble, centred on its icon and up to 260px wide, is cut
// off near a screen edge or inside a sideways-scrolling table.
//
// Mounted once (App.jsx). Only on touch screens, `(hover: none)`: a tap on an
// element carrying a title opens that text in a bubble kept inside the screen,
// below the element (above it near the bottom). A tap anywhere, or a scroll,
// closes it. Taps that DO something are left alone: buttons, links, form
// fields, and anything that shows a pointer cursor (clickable rows, cards).
// The ⓘ InfoTip is the exception: it does nothing else, so it always opens.
const INTERACTIVE = 'button, a, input, select, textarea, label, summary, [role="button"], [role="menuitem"], [contenteditable="true"]';
const TOUCH_QUERY = '(hover: none)';

function tipTarget(node) {
  const el = node?.closest?.('[title]');
  if (!el) return null;
  const text = el.getAttribute('title');
  if (!text || !text.trim()) return null;
  if (el.matches('.infotip')) return { el, text };
  if (el.closest(INTERACTIVE) || node.closest(INTERACTIVE)) return null;
  try { if (getComputedStyle(node).cursor === 'pointer') return null; } catch { /* detached */ }
  return { el, text };
}

export default function TapTips() {
  const [tip, setTip] = useState(null);   // { text, rect, el }
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia?.(TOUCH_QUERY).matches) return undefined;
    let current = null;
    const close = () => { current = null; setTip(null); };
    const onClick = (e) => {
      const hit = tipTarget(e.target);
      if (!hit) { if (current) close(); return; }
      if (current === hit.el) { close(); return; }   // second tap on the same thing closes it
      current = hit.el;
      setTip({ text: hit.text, rect: hit.el.getBoundingClientRect() });
    };
    const onScroll = () => { if (current) close(); };
    document.addEventListener('click', onClick, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', close);
    };
  }, []);
  if (!tip) return null;
  const vw = window.innerWidth, vh = window.innerHeight;
  const width = Math.min(300, vw - 24);
  const left = Math.max(12, Math.min(tip.rect.left + tip.rect.width / 2 - width / 2, vw - width - 12));
  const below = tip.rect.bottom + 8;
  const placeAbove = below > vh * 0.62;
  const style = placeAbove
    ? { left, width, bottom: Math.max(8, vh - tip.rect.top + 8) }
    : { left, width, top: below };
  return createPortal(
    <div className="tap-tip" role="tooltip" style={style}>{tip.text}</div>,
    document.body,
  );
}
