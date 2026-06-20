/**
 * InfoTip — a small, always-available hover tooltip for explaining controls.
 *
 * Usage:
 *   <InfoTip text="Filter the aircraft list by category or manufacturer." />
 *   <InfoTip text="..." label="Filter" />   // renders a labelled pill instead of the ⓘ glyph
 *
 * Pure CSS hover (see .infotip styles in index.css) plus a native title
 * attribute fallback for keyboard / touch users.
 */
export default function InfoTip({ text, label, side = 'top', style }) {
  return (
    <span className={`infotip infotip-${side}`} style={style} tabIndex={0} aria-label={text} title={text}>
      <span className="infotip-trigger">{label ? label : 'ⓘ'}</span>
      <span className="infotip-bubble" role="tooltip">{text}</span>
    </span>
  );
}
