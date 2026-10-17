// Event worlds — the "weird rules" (engine data/eventRules.js).
//
// EventRulesEditor: the admin's switches, used by the create form and by the
//   world page while the event is still in its lobby.
// EventRulesCard:   what every visitor sees on an event world's page — the
//   rules in words, this year's double-profit airports, and (admin, lobby) Edit.
// EventRulesBanner: the same, compact, at the top of the game screen.
// foundingHubOptions: which airports the join form may offer as a base.
import { useState } from 'react';
import { api } from './api.js';
import { AIRCRAFT_CATEGORIES } from '../../../packages/engine/src/data/aircraft.js';
import { FAMILY_INFO } from '../../../packages/engine/src/data/families.js';
import {
  describeEventRules, foundingHubAllowed, MAX_BONUS_AIRPORTS,
} from '../../../packages/engine/src/data/eventRules.js';

const FAMILY_OPTIONS = Object.entries(FAMILY_INFO)
  .map(([id, f]) => ({ id, name: f.name }))
  .sort((a, b) => a.name.localeCompare(b.name));

const box = { border: '1px solid rgba(255,200,61,.35)', borderRadius: 10, padding: '10px 14px' };

/** Is `code` a base this world lets an airline be founded at? */
export const foundingHubOptions = (world, airports) => {
  const rules = world?.event?.rules ?? null;
  if (!rules?.hubs || rules.hubs.mode === 'none') return airports;
  return airports.filter((a) => foundingHubAllowed(rules, a.code));
};

/** One line under the hub picker explaining the base rule, or null. */
export function foundingHubNote(world) {
  const h = world?.event?.rules?.hubs;
  if (!h) return null;
  if (h.mode === 'regional') return 'Event rules: your base must be a regional airport.';
  if (h.mode === 'assigned') return `Event rules: base at one of ${(h.airports ?? []).join(', ')}.`;
  if (h.mode === 'none') return 'Event rules: no hubs — your base is just where you start; every airline flies point to point.';
  return null;
}

/**
 * Controlled editor. `value` is a rules object (or null); onChange gets the
 * next one (null when nothing is switched on). The server re-validates.
 */
export function EventRulesEditor({ value, onChange }) {
  const r = value ?? {};
  const set = (patch) => {
    const next = { ...r, ...patch };
    for (const k of Object.keys(next)) if (next[k] == null || next[k] === false) delete next[k];
    onChange(Object.keys(next).length ? next : null);
  };
  const air = r.aircraft ?? {};
  const setAir = (patch) => {
    const a = { ...air, ...patch };
    const empty = !(a.categories?.length || a.families?.length || a.types?.length);
    set({ aircraft: empty ? null : a });
  };
  const toggleIn = (list = [], x) => (list.includes(x) ? list.filter((y) => y !== x) : [...list, x]);

  return (
    <fieldset style={{ ...box, display: 'grid', gap: 12 }}>
      <legend style={{ padding: '0 6px', fontWeight: 700 }}>🏆 Event rules</legend>
      <p className="muted small" style={{ margin: 0 }}>
        Switch on any mix. Players see them on the world page and in the game, and every refusal
        explains which rule it was. You can change them until the world starts.
      </p>

      <div>
        <strong className="small">Aircraft allowed</strong>
        <span className="muted small"> — leave everything unticked for any aircraft</span>
        <div className="row wrap" style={{ gap: 10, marginTop: 4 }}>
          {AIRCRAFT_CATEGORIES.map((c) => (
            <label key={c} className="small" style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
              <input type="checkbox" checked={(air.categories ?? []).includes(c)}
                onChange={() => setAir({ categories: toggleIn(air.categories, c) })} />{c}
            </label>
          ))}
        </div>
        <label className="small" style={{ display: 'block', marginTop: 6 }}>Families (⌘/Ctrl-click for several)
          <select multiple size={6} style={{ width: '100%', maxWidth: 360, display: 'block' }}
            value={air.families ?? []}
            onChange={(e) => setAir({ families: [...e.target.selectedOptions].map((o) => o.value) })}>
            {FAMILY_OPTIONS.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </label>
        <span className="muted small">A 737-only world: pick “Boeing 737” here and nothing else.</span>
      </div>

      <label className="small" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
        <input type="checkbox" checked={r.noLeases === true} onChange={(e) => set({ noLeases: e.target.checked || null })} />
        <strong>No leases</strong> <span className="muted">— every aircraft is bought, new or used</span>
      </label>

      <div className="row wrap" style={{ gap: 12, alignItems: 'flex-end' }}>
        <label className="small"><strong>Hubs</strong>
          <select value={r.hubs?.mode ?? ''}
            onChange={(e) => set({ hubs: e.target.value ? { mode: e.target.value, ...(e.target.value === 'assigned' ? { airports: r.hubs?.airports ?? [] } : {}) } : null })}>
            <option value="">Normal hubs</option>
            <option value="none">No hubs — point to point only</option>
            <option value="regional">Regional airports only</option>
            <option value="assigned">Set cities only…</option>
          </select>
        </label>
        {r.hubs?.mode === 'assigned' && (
          <label className="small" style={{ flex: 1, minWidth: 220 }}>Hub cities (airport codes)
            <input placeholder="LHR, CDG, FRA, AMS" defaultValue={(r.hubs.airports ?? []).join(', ')}
              onBlur={(e) => set({ hubs: { mode: 'assigned', airports: e.target.value.split(/[\s,]+/).map((c) => c.trim().toUpperCase()).filter(Boolean) } })} />
            <span className="muted">Every airline bases and hubs only here — put a few teams on the same city.</span>
          </label>
        )}
      </div>

      <label className="small"><strong>Routes</strong>{' '}
        <select value={r.routes ?? ''} onChange={(e) => set({ routes: e.target.value || null })}>
          <option value="">Any routes</option>
          <option value="domestic">Domestic only (inside your home country)</option>
          <option value="international">International only (every flight crosses a border)</option>
        </select>
      </label>

      <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
        <label className="small" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={Boolean(r.bonusAirports)}
            onChange={(e) => set({ bonusAirports: e.target.checked ? { count: r.bonusAirports?.count ?? 5 } : null })} />
          <strong>Double-profit airports</strong>
        </label>
        {r.bonusAirports && (
          <label className="small">
            <input type="number" min={1} max={MAX_BONUS_AIRPORTS} style={{ width: 60 }} value={r.bonusAirports.count ?? 5}
              onChange={(e) => set({ bonusAirports: { ...r.bonusAirports, count: Math.max(1, Math.min(MAX_BONUS_AIRPORTS, Math.round(Number(e.target.value) || 1))) } })} />
            {' '}random major airports a year — routes touching one earn double profit
          </label>
        )}
      </div>

      <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
        <label className="small" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={Boolean(r.allianceRanking)}
            onChange={(e) => set({ allianceRanking: e.target.checked ? { score: r.allianceRanking?.score ?? 'sum' } : null })} />
          <strong>Rank alliances, not airlines</strong>
        </label>
        {r.allianceRanking && (
          <select className="small" value={r.allianceRanking.score ?? 'sum'}
            onChange={(e) => set({ allianceRanking: { score: e.target.value } })}>
            <option value="sum">by members' combined profit</option>
            <option value="average">by members' average profit</option>
          </select>
        )}
      </div>
    </fieldset>
  );
}

function RuleList({ items }) {
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
      {items.map((d) => (
        <li key={d.id} className="small">
          <span aria-hidden="true">{d.icon}</span> <strong>{d.title}.</strong> <span className="muted">{d.detail}</span>
        </li>
      ))}
    </ul>
  );
}

/** World page: the rules in words; admins may edit them while the world is in its lobby. */
export function EventRulesCard({ world, token, isAdmin = false, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(world?.event?.rules ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  if (!world?.event) return null;
  const items = world.event.rulesSummary ?? describeEventRules(world.event.rules ?? null, { year: world.progress?.year ?? 1 });
  const canEdit = isAdmin && world.status === 'LOBBY';
  if (items.length === 0 && !canEdit) return null;

  const save = async () => {
    setBusy(true); setError(null);
    try {
      await api(`/worlds/${world.id}/event-rules`, { method: 'POST', token, body: { rules: draft } });
      setEditing(false); onSaved?.();
    } catch (e) { setError(e); }
    setBusy(false);
  };

  return (
    <section className="card" style={{ borderColor: 'rgba(255,200,61,.45)' }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h3 style={{ margin: 0 }}>🏆 Event rules</h3>
        {canEdit && !editing && (
          <button className="btn small" type="button" onClick={() => { setDraft(world.event.rules ?? null); setEditing(true); }}>
            {items.length ? 'Edit rules' : 'Add rules'}
          </button>
        )}
      </div>
      {editing ? (
        <>
          <EventRulesEditor value={draft} onChange={setDraft} />
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn primary small" type="button" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save rules'}</button>
            <button className="btn small" type="button" onClick={() => setEditing(false)}>Cancel</button>
            <span className="muted small">Airlines already in the lobby pick the new rules up straight away. Locked once the world starts.</span>
          </div>
          {error && <p className="error">{error.message ?? String(error)}</p>}
        </>
      ) : items.length ? (
        <>
          <p className="muted small" style={{ marginTop: 4 }}>This event plays by its own rules:</p>
          <RuleList items={items} />
        </>
      ) : (
        <p className="muted small">Standard rules — no special rules switched on.</p>
      )}
    </section>
  );
}

/** Game screen: the rules, compact and collapsible. Reads state.eventRules. */
export function EventRulesBanner({ rules, year = 1 }) {
  const [open, setOpen] = useState(false);
  const items = describeEventRules(rules ?? null, { year });
  if (!items.length) return null;
  const bonus = items.find((d) => d.id === 'bonusAirports');
  return (
    <div style={{ ...box, margin: '6px 0', background: 'rgba(255,200,61,.06)' }}>
      <button type="button" onClick={() => setOpen((o) => !o)}
        style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0, font: 'inherit', width: '100%', textAlign: 'left' }}>
        <strong>🏆 Event rules</strong>
        <span className="muted small"> · {items.map((d) => d.title).join(' · ')}</span>
        {bonus?.airports?.length ? <span className="small" style={{ color: '#ffc83d' }}> · 💰 this year: {bonus.airports.join(', ')}</span> : null}
        <span className="muted small" style={{ float: 'right' }}>{open ? 'Hide' : 'Details'}</span>
      </button>
      {open && <div style={{ marginTop: 8 }}><RuleList items={items} /></div>}
    </div>
  );
}
