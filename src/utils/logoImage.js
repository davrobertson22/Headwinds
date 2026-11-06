// Shared helper for turning a user-uploaded image file into a small square PNG
// data URL suitable for use as an airline logo. Downscaling keeps saved games
// light (saves live in localStorage) and the cover-fit + center-crop matches how
// the logo renders in-app. Used by both the setup screen and the in-game
// branding editor.

export const LOGO_PX = 128;

/**
 * What to upload, in one sentence, for the UI to show next to the file picker.
 * Players kept asking ("also what should the ideal image size be for the logos"
 * — Discord, 2026-09-07) because nothing on screen said. Lives here so the
 * advice and the code that enforces it can never drift apart.
 */
export const LOGO_UPLOAD_HINT =
  `Square image, ${LOGO_PX * 2}×${LOGO_PX * 2} or larger — it is centre-cropped to a square and saved at ${LOGO_PX}px. Keep the mark centred and clear of the edges.`;

export function fileToLogoDataURL(file) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type?.startsWith('image/')) {
      reject(new Error('Please choose an image file (PNG, JPG, SVG, etc.).'));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("That image couldn't be loaded."));
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = LOGO_PX;
        canvas.height = LOGO_PX;
        const ctx = canvas.getContext('2d');
        // Cover-fit: scale to fill the square, center-crop the overflow.
        const scale = Math.max(LOGO_PX / img.width, LOGO_PX / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.drawImage(img, (LOGO_PX - w) / 2, (LOGO_PX - h) / 2, w, h);
        try {
          resolve(canvas.toDataURL('image/png'));
        } catch {
          reject(new Error("That image couldn't be processed."));
        }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// ── Custom tails ─────────────────────────────────────────────────────────────
// An uploaded tail is shrunk to the fin's proportions (components/TailFin.jsx
// FIN_ASPECT, 1.291 wide for 1 tall) and drawn clipped to the fin silhouette
// everywhere tails show. Cover-fit, centred: the image fills the fin's
// bounding box and the clip takes the corners. Transparent areas show the
// livery's tail colour, so a mark on a clear background still sits on paint.
// WebP keeps the alpha at a fraction of PNG's size; the fallbacks exist for a
// browser that cannot encode it (PNG) or a photo whose PNG would blow the
// server's budget (JPEG, alpha lost — the tail colour is painted in first,
// so a cleared background becomes the tail colour rather than black).
export const TAIL_W = 480;
export const TAIL_H = 372;               // = round(480 / 1.291)
/** Must stay under the server's LOGO_DATAURL_MAX_CHARS (decisionGuard.mjs). */
export const TAIL_DATAURL_MAX_CHARS = 196_608;

export const TAIL_UPLOAD_HINT =
  `A wide image, ${TAIL_W * 2}×${TAIL_H * 2} or larger, nose to the right — it is centre-cropped to the fin and saved at ${TAIL_W}×${TAIL_H}. Only the fin shows; download the outline template to see where.`;

function encodeTail(canvas) {
  for (const [type, q] of [['image/webp', 0.9], ['image/png'], ['image/jpeg', 0.88]]) {
    const url = canvas.toDataURL(type, q);
    if (!url.startsWith(`data:${type}`)) continue;        // this browser cannot encode it
    if (url.length <= TAIL_DATAURL_MAX_CHARS) return url;
  }
  return null;
}

export function fileToTailDataURL(file) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type?.startsWith('image/')) {
      reject(new Error('Please choose an image file (PNG, JPG, SVG, etc.).'));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("That image couldn't be loaded."));
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = TAIL_W;
        canvas.height = TAIL_H;
        const ctx = canvas.getContext('2d');
        const scale = Math.max(TAIL_W / img.width, TAIL_H / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.drawImage(img, (TAIL_W - w) / 2, (TAIL_H - h) / 2, w, h);
        try {
          const url = encodeTail(canvas);
          if (url) resolve(url);
          else reject(new Error('That image is too detailed to store — try a simpler or smaller one.'));
        } catch {
          reject(new Error("That image couldn't be processed."));
        }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
