import { useEffect, useRef, useState } from 'react';
import { logoSrcsFor } from './LiveryPlane.jsx';
import { liveryKey, liveryNeedsLogo, normalizeLivery } from '../data/livery.js';
import { getLiveryTemplate, DEFAULT_LIVERY_TEMPLATE, tailCropOf } from '../data/liveryTemplates.js';
import { paintTail, loadLiveryTemplate, loadLogoImage } from '../utils/liveryPaint.js';

// An airline's tail: the licensed template's tail crop (fin, stabiliser and
// rear fuselage) painted in the airline's livery with its logo on the fin —
// the same paint as the Fleet page, cut down to the part that carries the
// identity. Shown wherever an airline is drawn big enough for it to read:
// hub markers on the maps, the season podium, the player profile, the logo
// maker's Tail section. Small list rows keep the square logo tile.
//
// Client-painted in an effect (utils/liveryPaint.js paintTail); during SSR
// and before the template has decoded it is an empty box of the right aspect.
//
//   livery   the airline's livery (normalised here; liveryFor(state) for yours)
//   logo     { id, accentColor, bgColor, customSrc } — the AirlineLogo fields
//   height   CSS px tall; the canvas paints at device pixel ratio (≤ 2)
//   crop     'tail' (fin, stabiliser, rear fuselage) or 'fin' (the fin alone)

const painted = new Map();   // key → canvas (bounded)
const PAINT_CACHE_MAX = 64;
const srcKey = (src) => (src ? `${src.length}:${src.slice(0, 64)}:${src.slice(-160)}` : '');

/**
 * The painted tail as a canvas, cached by look and size. Shared by the
 * component and the map markers (utils/hubFin.js), which need the pixels as
 * an <img> rather than a React canvas.
 */
export async function tailCanvas({ livery, logo = null, height = 48, dpr = 1, templateId = DEFAULT_LIVERY_TEMPLATE, crop = 'tail' }) {
  const spec = getLiveryTemplate(templateId) ?? getLiveryTemplate(DEFAULT_LIVERY_TEMPLATE);
  const norm = normalizeLivery(livery, livery?.tail ?? logo?.accentColor);
  const tailSrc = liveryNeedsLogo(norm) ? (logoSrcsFor(logo, norm)?.tail ?? null) : null;
  const px = Math.max(12, Math.round(height * dpr));
  const key = `${spec.id}|${crop}|${px}|${liveryKey(norm)}|${srcKey(tailSrc)}`;
  let canvas = painted.get(key);
  if (!canvas) {
    const [tpl, logoImg] = await Promise.all([loadLiveryTemplate(spec), loadLogoImage(tailSrc)]);
    canvas = paintTail(tpl, norm, { height: px, logo: logoImg, crop });
    if (painted.size >= PAINT_CACHE_MAX) painted.delete(painted.keys().next().value);
    painted.set(key, canvas);
  }
  return canvas;
}

export default function TailFin({ livery, logo = null, height = 48, crop = 'tail', templateId, title, className, style }) {
  const spec = (templateId && getLiveryTemplate(templateId)) || getLiveryTemplate(DEFAULT_LIVERY_TEMPLATE);
  const { aspect } = tailCropOf(spec, crop);
  const canvasRef = useRef(null);
  const [ready, setReady] = useState(false);
  const norm = normalizeLivery(livery, livery?.tail ?? logo?.accentColor);
  const lkey = liveryKey(norm);
  const tailSrc = liveryNeedsLogo(norm) ? (logoSrcsFor(logo, norm)?.tail ?? null) : null;

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    let cancelled = false;
    const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    (async () => {
      try {
        const canvas = await tailCanvas({ livery: norm, logo, height, dpr, templateId: spec.id, crop });
        const el = canvasRef.current;
        if (!el || cancelled) return;
        el.width = canvas.width; el.height = canvas.height;
        el.getContext('2d').drawImage(canvas, 0, 0);
        setReady(true);
      } catch {
        // Template missing or blocked: leave the empty box — never throw from paint.
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.id, crop, height, lkey, srcKey(tailSrc)]);

  const width = Math.round(height * aspect);
  return (
    <canvas
      ref={canvasRef}
      className={className}
      title={title}
      role="img"
      aria-label={title ?? 'Airline tail'}
      data-tail-template={spec.id}
      data-tail-crop={crop}
      data-ready={ready ? '1' : '0'}
      style={{ width, height, display: 'block', flexShrink: 0, opacity: ready ? 1 : 0, transition: 'opacity .18s', ...style }}
    />
  );
}
