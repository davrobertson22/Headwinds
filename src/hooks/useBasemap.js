import { useState, useEffect, useCallback } from 'react';
import { readBasemap, writeBasemap, BASEMAP_EVENT, BASEMAP_KEY, normalizeBasemap } from '../components/mapCore.js';

/**
 * useBasemap — the player's map style ('satellite' | 'dark'), shared by every
 * map on the page. Setting it from one place (the map header, the map-first
 * layout's settings menu) updates every mounted map, and another tab's change
 * arrives through the storage event.
 */
export default function useBasemap() {
  const [basemap, setLocal] = useState(readBasemap);

  useEffect(() => {
    const onChange = (e) => setLocal(normalizeBasemap(e?.detail));
    const onStorage = (e) => { if (e.key === BASEMAP_KEY) setLocal(normalizeBasemap(e.newValue)); };
    window.addEventListener(BASEMAP_EVENT, onChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(BASEMAP_EVENT, onChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const setBasemap = useCallback((v) => setLocal(writeBasemap(v)), []);
  return [basemap, setBasemap];
}
