import { useState, useEffect } from 'react';

/**
 * useIsMobile — true when the viewport is at or below `breakpoint` px.
 *
 * Used only by the handful of components that style with inline `style={{}}`
 * props, which a CSS media query cannot reach (e.g. the route map's fixed
 * height). Pure CSS layout should use the `@media (max-width: 640px)` block in
 * index.css instead — this hook is the JS escape hatch, not the default tool.
 *
 * SSR-safe and listener-cleaned-up. Defaults to the same 640px breakpoint the
 * stylesheet uses, so CSS and JS agree on what "mobile" means.
 */
export default function useIsMobile(breakpoint = 640) {
  const query = `(max-width: ${breakpoint}px)`;

  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false
  );

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    const onChange = (e) => setIsMobile(e.matches);
    setIsMobile(mql.matches);
    // addEventListener is the modern API; older Safari uses addListener.
    if (mql.addEventListener) mql.addEventListener('change', onChange);
    else mql.addListener(onChange);
    return () => {
      if (mql.removeEventListener) mql.removeEventListener('change', onChange);
      else mql.removeListener(onChange);
    };
  }, [query]);

  return isMobile;
}
