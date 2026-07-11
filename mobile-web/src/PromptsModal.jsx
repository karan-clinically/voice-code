import React, { useEffect, useState } from 'react';
import { listPrompts, savePrompt, deletePrompt } from './lib/api.js';

// Full-screen saved-prompts sheet (phone). Tap a row to drop it into the composer;
// save the current draft; delete rows. Global (harness DB). Pearls theme.
export default function PromptsModal({ currentText, onInsert, onClose, notify }) {
  const [prompts, setPrompts] = useState([]);
  const [loading, setLoading] = useState(true);

  const refresh = () =>
    listPrompts()
      .then((r) => setPrompts(r.prompts || []))
      .catch((e) => notify(e.message))
      .finally(() => setLoading(false));

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveCurrent() {
    const t = (currentText || '').trim();
    if (!t) return notify('Type a prompt first, then save it');
    try {
      await savePrompt(t);
      refresh();
    } catch (e) {
      notify(e.message);
    }
  }

  async function remove(id) {
    setPrompts((p) => p.filter((x) => x.id !== id));
    try {
      await deletePrompt(id);
    } catch (e) {
      notify(e.message);
      refresh();
    }
  }

  return (
    <div className="pm-sheet">
      <div className="pm-sheet-head">
        <div className="sv-title">Saved prompts</div>
        <button className="ghost" onClick={onClose}>✕</button>
      </div>
      <button className="primary pm-save" onClick={saveCurrent}>＋ Save current draft</button>
      <div className="pm-sheet-list">
        {loading ? (
          <p className="muted" style={{ textAlign: 'center', padding: 24 }}>Loading…</p>
        ) : prompts.length === 0 ? (
          <p className="muted" style={{ textAlign: 'center', padding: 24 }}>
            No saved prompts yet. Type one in the box, then “Save current draft”.
          </p>
        ) : (
          prompts.map((p) => (
            <div key={p.id} className="pm-item">
              <button className="pm-item-pick" onClick={() => { onInsert(p.text); onClose(); }}>
                {p.label && <span className="pm-item-label">{p.label}</span>}
                <span className="pm-item-text">{p.text}</span>
              </button>
              <button className="pm-item-del" onClick={() => remove(p.id)} aria-label="Delete">🗑</button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
