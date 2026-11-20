// Phones only: a "Sort by" picker for tables that sort by clicking their
// column headers. On phones those tables become cards (index.css "Card
// tables") and the header row is hidden, so sorting moves here. Hidden above
// 640px by the same CSS block, so desktop is unchanged.
//
//   options: [{ id, label }]  value: current column id  dir: 'asc' | 'desc'
//   onPick(id): choose a column    onFlip(): reverse the current order
export default function MobileSortPicker({ options, value, dir, onPick, onFlip, id = 'm-sort' }) {
  return (
    <div className="m-sortbar">
      <label htmlFor={id}>Sort by</label>
      <select id={id} value={value} onChange={(e) => onPick(e.target.value)}>
        {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
      <button type="button" className="btn btn-ghost m-sortdir" onClick={onFlip}
        aria-label={dir === 'desc' ? 'Highest first: tap for lowest first' : 'Lowest first: tap for highest first'}>
        {dir === 'desc' ? '▼ High' : '▲ Low'}
      </button>
    </div>
  );
}
