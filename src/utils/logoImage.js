// Shared helper for turning a user-uploaded image file into a small square PNG
// data URL suitable for use as an airline logo. Downscaling keeps saved games
// light (saves live in localStorage) and the cover-fit + center-crop matches how
// the logo renders in-app. Used by both the setup screen and the in-game
// branding editor.

export const LOGO_PX = 128;

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
