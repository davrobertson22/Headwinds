import { useState } from 'react';
import { useConfirm } from './ConfirmModal.jsx';
import { useGame } from '../store/GameContext.jsx';
import { formatMoney, weekToGameDate } from '../utils/simulation.js';
import AirlineLogo from './AirlineLogo.jsx';
import { SaveIcon, FolderOpenIcon, CloseIcon } from './Icons.jsx';

const SLOT_PREFIX = 'bbae_slot_';
const NUM_SLOTS = 3;

function readSlot(i) {
  try {
    const raw = localStorage.getItem(SLOT_PREFIX + i);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function readAllSlots() {
  return Array.from({ length: NUM_SLOTS }, (_, i) => readSlot(i));
}

function writeSlot(i, state) {
  const record = {
    airlineName: state.airlineName,
    logoId:      state.logoId,
    logoColor:   state.logoColor,
    customLogo:  state.customLogo ?? null,
    hub:         state.hub,
    cash:        state.cash,
    week:        state.week,
    year:        state.year,
    savedAt:     Date.now(),
    gameState:   state,
  };
  localStorage.setItem(SLOT_PREFIX + i, JSON.stringify(record));
}

function deleteSlot(i) {
  localStorage.removeItem(SLOT_PREFIX + i);
}

function SlotCard({ index, slot, mode, onSave, onLoad, onDelete }) {
  const isEmpty = !slot;
  const gameDateStr = slot
    ? (() => {
        const { monthName, weekInMonth } = weekToGameDate(slot.week);
        return `${monthName} wk ${weekInMonth}, Yr ${slot.year}`;
      })()
    : null;
  const dateStr = slot
    ? new Date(slot.savedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
      + ' ' + new Date(slot.savedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : null;

  return (
    <div className={`save-slot${isEmpty ? ' save-slot-empty' : ''}`}>
      <div className="save-slot-header">
        <span className="save-slot-label">Slot {index + 1}</span>
        {!isEmpty && (
          <button className="save-slot-delete" onClick={() => onDelete(index)} title="Delete save"><CloseIcon size={13} /></button>
        )}
      </div>

      {isEmpty ? (
        <div className="save-slot-body save-slot-body-empty">
          <span className="save-slot-empty-text">Empty</span>
        </div>
      ) : (
        <div className="save-slot-body">
          <div className="save-slot-airline">
            <AirlineLogo id={slot.logoId} customSrc={slot.customLogo} size={26} radius={5} accentColor={slot.logoColor} />
            <div>
              <div className="save-slot-airline-name">{slot.airlineName}</div>
              <div className="save-slot-hub">{slot.hub}</div>
            </div>
          </div>
          <div className="save-slot-meta">
            <div className="save-slot-meta-row">
              <span className="save-slot-meta-label">Date</span>
              <span>{gameDateStr}</span>
            </div>
            <div className="save-slot-meta-row">
              <span className="save-slot-meta-label">Cash</span>
              <span style={{ color: slot.cash < 0 ? 'var(--red)' : 'var(--green)' }}>{formatMoney(slot.cash)}</span>
            </div>
            <div className="save-slot-meta-row">
              <span className="save-slot-meta-label">Saved</span>
              <span className="save-slot-date">{dateStr}</span>
            </div>
          </div>
        </div>
      )}

      <div className="save-slot-actions">
        {mode === 'save' && (
          <button className="btn btn-primary save-slot-btn" onClick={() => onSave(index)}>
            {isEmpty ? 'Save Here' : 'Overwrite'}
          </button>
        )}
        {mode === 'load' && !isEmpty && (
          <button className="btn btn-primary save-slot-btn" onClick={() => onLoad(index)}>
            Load
          </button>
        )}
        {mode === 'load' && isEmpty && (
          <span className="save-slot-empty-action">No save</span>
        )}
      </div>
    </div>
  );
}

export default function SaveLoadModal({ mode, onClose }) {
  const { state, dispatch } = useGame();
  const confirm = useConfirm();
  const [slots, setSlots] = useState(readAllSlots);

  function handleSave(i) {
    writeSlot(i, state);
    setSlots(readAllSlots());
  }

  function handleLoad(i) {
    const slot = readSlot(i);
    if (!slot) return;
    dispatch({ type: 'LOAD_STATE', payload: slot.gameState });
    onClose();
  }

  async function handleDelete(i) {
    if (!await confirm({ title: `Delete slot ${i + 1}?`, body: 'This cannot be undone.', danger: true, confirmLabel: 'Delete slot' })) return;
    deleteSlot(i);
    setSlots(readAllSlots());
  }

  return (
    <div className="saveload-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="saveload-modal">
        <div className="saveload-header">
          <h2 className="saveload-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            {mode === 'save' ? <><SaveIcon size={18} /> Save Game</> : <><FolderOpenIcon size={18} /> Load Game</>}
          </h2>
          <button className="saveload-close btn btn-ghost" onClick={onClose}><CloseIcon size={15} /></button>
        </div>
        <p className="saveload-hint">
          {mode === 'save'
            ? 'Pick a slot. Your game also auto-saves continuously in the background.'
            : 'Pick a slot to restore. Your current auto-save is unaffected.'}
        </p>
        <div className="save-slots">
          {slots.map((slot, i) => (
            <SlotCard
              key={i}
              index={i}
              slot={slot}
              mode={mode}
              onSave={handleSave}
              onLoad={handleLoad}
              onDelete={handleDelete}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
