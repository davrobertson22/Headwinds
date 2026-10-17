// Opens the branding modal (App.jsx) from any screen, on a given tab.
// A DOM event rather than context: the Fleet page's "Edit livery" button is
// the only caller and the modal lives at the top of the tree.
export const BRANDING_OPEN_EVENT = 'hw:open-branding';

export function openBranding(tab = 'identity') {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(BRANDING_OPEN_EVENT, { detail: { tab } }));
}
