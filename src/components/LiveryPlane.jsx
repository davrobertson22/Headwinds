import { useEffect, useRef, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as LogoModule from './AirlineLogo.jsx';
import { liveryKey, normalizeLivery } from '../data/livery.js';
import { liveryTemplateFor, getLiveryTemplate, DEFAULT_LIVERY_TEMPLATE } from '../data/liveryTemplates.js';
import { paintLivery, loadLiveryTemplate, loadLogoImage } from '../utils/liveryPaint.js';

// An aircraft in a livery. Paints the licensed template (utils/liveryPaint.js)
// on the client in an effect; during SSR and before the template has decoded
// it renders an empty box of the right aspect so layouts never jump.
//
//   livery     the paint scheme (normalised here; pass liveryFor(state))
//   titles     airline name on the fuselage ('' / undefined for none)
//   logo       { id, accentColor, customSrc } — the airline's mark, for the fin
//   category   aircraft category → which template (liveryTemplateFor)
//   templateId explicit template instead of a category
//   width      CSS px wide; the canvas paints at device pixel ratio (≤2)

const AirlineLogo = LogoModule.default;
// Headwinds resolves hosted rival logos (/logos/…) against the API origin;
// Tailwinds only ever has data-URL uploads and no resolver.
const resolveLogoSrc = LogoModule.resolveLogoSrc ?? ((src) => (typeof src === 'string' && src ? src : null));

const painted = new Map();           // key → canvas (bounded)
const PAINT_CACHE_MAX = 48;

function logoSrcFor(logo) {
  if (!logo) return null;
  const custom = resolveLogoSrc(logo.customSrc);
  if (custom) return custom;
  if (!logo.id) return null;
  return renderToStaticMarkup(<AirlineLogo id={logo.id} accentColor={logo.accentColor} size={128} radius={26} />);
}

export default function LiveryPlane({ livery, titles = '', logo = null, category, templateId, width = 320, className, style, title }) {
  const spec = (templateId && getLiveryTemplate(templateId)) || (category ? liveryTemplateFor(category) : getLiveryTemplate(DEFAULT_LIVERY_TEMPLATE));
  const aspect = spec.size[1] / spec.size[0];
  const canvasRef = useRef(null);
  const [ready, setReady] = useState(false);
  const norm = normalizeLivery(livery, livery?.tail);
  const lkey = liveryKey(norm);
  const logoSrc = norm.logoOnTail ? logoSrcFor(logo) : null;
  const name = norm.titlesOn ? String(titles ?? '').trim() : '';

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    let cancelled = false;
    const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    const px = Math.max(16, Math.round(width * dpr));
    const key = `${spec.id}|${px}|${lkey}|${name}|${logoSrc ? logoSrc.length + ':' + logoSrc.slice(0, 64) : ''}`;
    (async () => {
      try {
        let canvas = painted.get(key);
        if (!canvas) {
          const [tpl, logoImg] = await Promise.all([loadLiveryTemplate(spec), loadLogoImage(logoSrc)]);
          if (cancelled) return;
          canvas = paintLivery(tpl, norm, { width: px, titles: name, logo: logoImg });
          if (painted.size >= PAINT_CACHE_MAX) painted.delete(painted.keys().next().value);
          painted.set(key, canvas);
        }
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
  }, [spec.id, width, lkey, name, logoSrc]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      title={title}
      role="img"
      aria-label={title ?? `${name || 'Airline'} livery on a ${spec.name}`}
      data-livery-template={spec.id}
      data-ready={ready ? '1' : '0'}
      style={{ width, height: Math.round(width * aspect), display: 'block', opacity: ready ? 1 : 0, transition: 'opacity .18s', ...style }}
    />
  );
}
