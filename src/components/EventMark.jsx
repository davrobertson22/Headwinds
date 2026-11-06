import AirlineLogo from './AirlineLogo.jsx';

// The lead icon of a news line: the airline's logo, with the event's emoji as
// a small badge on its corner, so who moved reads before what they did. A line
// with no airline behind it (a world event, an alliance founding) or one whose
// airline we have no branding for keeps the bare emoji, exactly as before.
//
//   brand  { logoId, logoColor, logoBg, customLogo } (utils/airlineBrands.js) or null
//   icon   the event's emoji
//   size   logo size in px
export default function EventMark({ brand, icon, size = 22 }) {
  if (!brand) {
    return <span className="event-mark-emoji" style={{ flexShrink: 0, fontSize: Math.round(size * 0.68) }}>{icon}</span>;
  }
  const badge = Math.max(11, Math.round(size * 0.55));
  return (
    <span
      className="event-mark"
      style={{ position: 'relative', flexShrink: 0, width: size, height: size, display: 'inline-block', alignSelf: 'flex-start', marginTop: 1 }}
    >
      <AirlineLogo
        id={brand.logoId} accentColor={brand.logoColor} bgColor={brand.logoBg}
        customSrc={brand.customLogo} size={size}
      />
      {icon ? (
        <span
          aria-hidden="true"
          style={{
            position: 'absolute', right: -Math.round(badge * 0.35), bottom: -Math.round(badge * 0.3),
            fontSize: Math.round(badge * 0.78), lineHeight: 1,
            width: badge, height: badge, borderRadius: '50%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'var(--panel, #141922)',
          }}
        >{icon}</span>
      ) : null}
    </span>
  );
}
