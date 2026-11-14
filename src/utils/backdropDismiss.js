/**
 * Props for a modal backdrop that closes on a click outside the panel, but
 * not on a drag that STARTED inside the panel.
 *
 * A browser fires `click` on the nearest common ancestor of mousedown and
 * mouseup. Press inside a text field, drag to select, release over the
 * backdrop, and that ancestor is the backdrop itself, so the plain
 * `e.target === e.currentTarget` test closed the modal mid-selection
 * (Discord: drag-selecting the airline name closed the rename menu).
 *
 * The press origin is kept on the backdrop's DOM node, not in a closure, so it
 * survives a re-render between mousedown and click.
 *
 *   <div className="saveload-overlay" {...backdropDismiss(onClose)}>
 */
export function backdropDismiss(onDismiss) {
  return {
    onMouseDown: (e) => { e.currentTarget.__pressedBackdrop = e.target === e.currentTarget; },
    onClick: (e) => {
      const pressed = e.currentTarget.__pressedBackdrop;
      e.currentTarget.__pressedBackdrop = false;
      if (e.target === e.currentTarget && pressed !== false) onDismiss(e);
    },
  };
}
