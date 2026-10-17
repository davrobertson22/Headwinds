// Per-world production rates for the create-world form (production lines ON).
// One box per size class, and under "Set individual aircraft families" one per
// line. A blank box keeps the default, shown as its placeholder: the class rate
// scaled to the world's player cap, or the class rate you typed. The engine
// (data/productionLines.js) owns the numbers so the form, the market card, the
// checkout and the server's race check all read the same table.
import { useMemo } from 'react';
import {
  capacityScale, lineRateDefaults, linesByClass, normalizeLineRates,
  MIN_LINE_RATE, MAX_LINE_RATE, PRODUCTION_LINES,
} from '../../../packages/engine/src/data/productionLines.js';
import { getAircraftType } from '../../../packages/engine/src/data/aircraft.js';

export const EMPTY_LINE_RATES = { classes: {}, lines: {} };

const CLASS_LABEL = {
  'Turboprop': 'Turboprops',
  'Regional Jet': 'Regional jets',
  'Narrow Body': 'Narrowbodies',
  'Wide Body': 'Widebodies',
  'Double Deck': 'Jumbos (747, A380)',
  'Supersonic': 'Supersonic',
  'Outsize': 'Outsize',
  'Conversion': 'Freighter conversions',
};

const typesOf = (lineId) => (PRODUCTION_LINES[lineId]?.types ?? [])
  .map((t) => getAircraftType(t)?.name ?? t).join(', ');

function RateInput({ value, placeholder, onChange, label, title }) {
  return (
    <input type="number" inputMode="numeric" min={MIN_LINE_RATE} max={MAX_LINE_RATE} step={1}
      aria-label={label} title={title} placeholder={String(placeholder)} value={value ?? ''}
      style={{ width: '4.5em' }}
      onChange={(e) => onChange(e.target.value)} />
  );
}

export default function ProductionRates({ rates = EMPTY_LINE_RATES, onChange, maxPlayers }) {
  const scale = capacityScale(maxPlayers);
  const groups = useMemo(() => linesByClass(), []);
  const defaults = lineRateDefaults({ scale, rates });
  const set = (key, id, v) => onChange({ ...rates, [key]: { ...(rates[key] ?? {}), [id]: v } });
  const lineCount = groups.reduce((n, g) => n + g.lines.length, 0);
  const setLines = Object.keys(normalizeLineRates({ lines: rates.lines })?.lines ?? {}).length;
  const customised = normalizeLineRates(rates) != null;

  return (
    <div className="prod-rates" style={{ flexBasis: '100%', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span>Production rates <span className="muted small">
        frames a week per line, shared by the whole world · blank = the default for {Number(maxPlayers) || 50} players
      </span></span>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 8 }}>
        {groups.map((g) => (
          <label key={g.cls} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span>{CLASS_LABEL[g.cls] ?? g.cls}</span>
            <RateInput label={`${CLASS_LABEL[g.cls] ?? g.cls} frames a week`}
              value={rates.classes?.[g.cls]} placeholder={defaults.classes[g.cls]}
              onChange={(v) => set('classes', g.cls, v)} />
          </label>
        ))}
      </div>
      <details>
        <summary>Set individual aircraft families ({lineCount} lines{setLines ? ` · ${setLines} set` : ''})</summary>
        <span className="muted small">A family's own rate beats its class rate. Hover a family to see which types it builds.</span>
        {groups.map((g) => (
          <fieldset key={g.cls} style={{ border: 0, padding: 0, margin: '10px 0 0' }}>
            <legend className="muted small">{CLASS_LABEL[g.cls] ?? g.cls}</legend>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 6 }}>
              {g.lines.map((l) => (
                <label key={l.id} title={typesOf(l.id)}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span className="small">{l.name}</span>
                  <RateInput label={`${l.name} frames a week`} title={typesOf(l.id)}
                    value={rates.lines?.[l.id]} placeholder={defaults.lines[l.id]}
                    onChange={(v) => set('lines', l.id, v)} />
                </label>
              ))}
            </div>
          </fieldset>
        ))}
      </details>
      <span className="muted small">
        Whole numbers from {MIN_LINE_RATE} to {MAX_LINE_RATE}. A line still speeds up by about half again
        when its order book runs past six months. Fixed once the world is created.
        {customised && <>{' '}<button type="button" className="btn small" onClick={() => onChange(EMPTY_LINE_RATES)}>Reset to defaults</button></>}
      </span>
    </div>
  );
}
