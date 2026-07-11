import React, { useEffect, useState } from 'react';
import { listPrompts, savePrompt, deletePrompt } from '../lib/api.js';

// Scrollable saved-prompts picker. Tap a row to drop it into the composer; save
// the current draft as a new snippet; delete rows. Global (harness DB).
export default function PromptsModal({ currentText, onInsert, onClose, notify }) {
  const [prompts, setPrompts] = useState([]);
  const [loading, setLoading] = useState(true);

  const refresh = () =>
    listPrompts()
      .then((r) => setPrompts(r.prompts || []))
      .catch((e) => notify?.('Load failed: ' + e.message))
      .finally(() => setLoading(false));

  useEffect(() => {
    refresh();
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveCurrent() {
    const t = (currentText || '').trim();
    if (!t) return notify?.('Nothing to save — type a prompt first');
    try {
      await savePrompt(t);
      refresh();
    } catch (e) {
      notify?.('Save failed: ' + e.message);
    }
  }

  async function remove(id) {
    setPrompts((p) => p.filter((x) => x.id !== id));
    try {
      await deletePrompt(id);
    } catch (e) {
      notify?.('Delete failed: ' + e.message);
      refresh();
    }
  }

  return (
    <div className="pm-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="pm-panel" onMouseDown={(e) => e.stopPropagation()}>
        <header className="pm-head">
          <span className="pm-title">Saved prompts</span>
          <button className="tool" onClick={saveCurrent} title="Save the current draft">＋ Save current</button>
          <button className="tool" onClick={onClose} title="Close (Esc)">✕</button>
        </header>
        <div className="pm-list">
          {loading ? (
            <p className="pm-empty">Loading…</p>
          ) : prompts.length === 0 ? (
            <p className="pm-empty">No saved prompts yet. Type one below, then “Save current”.</p>
          ) : (
            prompts.map((p) => (
              <div key={p.id} className="pm-row">
                <button className="pm-pick" onClick={() => { onInsert(p.text); onClose(); }} title="Insert into the composer">
                  {p.label && <span className="pm-label">{p.label}</span>}
                  <span className="pm-text">{p.text}</span>
                </button>
                <button className="pm-del" onClick={() => remove(p.id)} title="Delete">🗑</button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
