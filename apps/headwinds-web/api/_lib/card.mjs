// An airline's share card, as the element tree the image renderer draws
// (api/og.mjs). Kept apart from the handler so the layout can be built — and
// tested — without the renderer: tools/worlds-pages-test.mjs checks what the
// card says and, above all, what it does not.
import { stripStanding, fmtInt } from './render.mjs';
import { finSvg, finLayout } from './brand.mjs';

const el = (type, style, children, props = {}) => ({ type, props: { style, ...props, ...(children === undefined ? {} : { children }) } });
// Flat, so the fin's surround can be painted back over in exactly this colour.
const BG = '#0c1118';
const compact = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : fmtInt(n));

/**
 * @param {object} p
 * @param {object} p.detail     GET /worlds/:id
 * @param {string} p.airlineId
 * @param {object} p.ctx        { apiOrigin, brand, getAirport }
 * @param {Function} p.inline   async (url) → data URL | null, for uploaded logos and tails
 * @returns {Promise<{ element: object, airline: object, lines: string[] } | null>}
 */
export async function buildCard({ detail, airlineId, ctx = {}, inline = async () => null }) {
  const { world: w, standings = [] } = detail;
  const rows = standings.map(stripStanding);
  const me = rows.find((a) => a.id && a.id === airlineId);
  if (!me) return null;

  // The fin: the airline's paint and preset logo are one SVG. An UPLOADED tail
  // or logo cannot ride inside it (the renderer does not draw a picture nested
  // in an SVG picture), so it is read, inlined and laid over the fin as its own
  // layer — then everything outside the silhouette is painted back over in the
  // card's colour. An upload that cannot be read is skipped: the fin keeps its
  // paint and simply has no mark.
  const FW = 387, FH = 300;
  const lay = finLayout(me, { apiOrigin: ctx.apiOrigin, brand: ctx.brand });
  const k = FW / lay.w;
  const svgSrc = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
  const layers = [el('img', { position: 'absolute', left: 0, top: 0, width: FW, height: FH }, undefined, {
    src: svgSrc(finSvg(me, { height: FH, uid: 'card', apiOrigin: ctx.apiOrigin, brand: ctx.brand, xmlns: true, uploads: false })), width: FW, height: FH,
  })];
  const upload = lay.tail ?? lay.logo;
  const bytes = upload ? await inline(upload) : null;
  if (bytes && lay.tail) {
    layers.push(el('img', { position: 'absolute', left: 0, top: 0, width: FW, height: FH, objectFit: 'cover' }, undefined, { src: bytes, width: FW, height: FH }));
  } else if (bytes && lay.logo) {
    const size = Math.round(lay.logoBox.size * k);
    layers.push(el('div', {
      position: 'absolute', left: Math.round(lay.logoBox.x * k), top: Math.round(lay.logoBox.y * k), width: size, height: size,
      borderRadius: size / 2, overflow: 'hidden', backgroundColor: lay.tile, display: 'flex',
    }, [el('img', { width: size, height: size, objectFit: 'cover' }, undefined, { src: bytes, width: size, height: size })]));
  }
  if (bytes) {
    layers.push(el('img', { position: 'absolute', left: 0, top: 0, width: FW, height: FH }, undefined, {
      src: svgSrc(`<svg xmlns="http://www.w3.org/2000/svg" width="${FW}" height="${FH}" viewBox="0 0 ${lay.w} ${lay.h}"><path d="${lay.outside}" fill="${BG}" fill-rule="evenodd"/></svg>`), width: FW, height: FH,
    }));
  }

  const ended = w.status === 'ENDED';
  const city = ctx.getAirport?.(me.hub)?.city;
  const place = `#${me.rank} of ${fmtInt(rows.length)}`;
  const stats = [
    ['Hub', city ? `${city} (${me.hub})` : (me.hub ?? '—')],
    ['Routes', fmtInt(me.routes)],
    ['Aircraft', fmtInt(me.fleet)],
    ...(me.paxWeek > 0 ? [['Passengers a week', compact(me.paxWeek)]] : []),
  ];
  const name = String(me.name ?? 'Airline');
  const nameSize = name.length > 26 ? 52 : name.length > 16 ? 64 : 78;

  const element = el('div', {
    width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
    backgroundColor: BG,
    color: '#e8edf4', padding: '56px 64px 44px', fontFamily: 'Geist, sans-serif',
  }, [
    el('div', { display: 'flex', alignItems: 'center', gap: 56 }, [
      el('div', { position: 'relative', display: 'flex', width: FW, height: FH, flexShrink: 0 }, layers),
      el('div', { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }, [
        el('div', { display: 'flex', fontSize: nameSize, lineHeight: 1.08, letterSpacing: -1.5, color: '#ffffff' }, name),
        el('div', { display: 'flex', alignItems: 'baseline', gap: 16, marginTop: 22 }, [
          el('div', { display: 'flex', fontSize: 48, color: '#5fe0cc' }, place),
          el('div', { display: 'flex', fontSize: 30, color: '#8b98ab' }, `${ended ? 'final · ' : 'in '}${w.name}`),
        ]),
      ]),
    ]),
    el('div', { display: 'flex', flexDirection: 'column', gap: 22 }, [
      el('div', { display: 'flex', gap: 48 }, stats.map(([k, v]) => el('div', { display: 'flex', flexDirection: 'column' }, [
        el('div', { display: 'flex', fontSize: 20, color: '#8b98ab', letterSpacing: 1.5 }, k.toUpperCase()),
        el('div', { display: 'flex', fontSize: 36, color: '#e8edf4' }, v),
      ]))),
      el('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '2px solid #263143', paddingTop: 18, fontSize: 24 }, [
        el('div', { display: 'flex', color: '#38c9b4', letterSpacing: 3 }, 'HEADWINDS'),
        el('div', { display: 'flex', color: '#8b98ab' }, 'Every rival is a real person · headwindsairlinegame.com'),
      ]),
    ]),
  ]);
  return { element, airline: me, lines: [name, place, w.name, ...stats.flat()] };
}
