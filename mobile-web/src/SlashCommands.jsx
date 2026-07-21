import React, { useMemo, useState } from 'react';
import {
  SLASH_COMMANDS,
  BUCKET_LABEL,
  loadSlashCommandUsage,
  recordSlashCommandUse,
} from './lib/slashCommands.js';

// Full-screen picker of Claude Code slash commands (phone). Tap one to drop it in
// the command box, then Send. Menu-openers (/model, /mcp…) then use the ⋯ keys.
export default function SlashCommands({ onPick, onClose }) {
  const [q, setQ] = useState('');
  const [usage, setUsage] = useState(loadSlashCommandUsage);
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const match = (c) => !needle || c.cmd.includes(needle) || c.desc.toLowerCase().includes(needle);
    const used = SLASH_COMMANDS.filter((c) => usage[c.cmd] && match(c));
    const recent = [...used]
      .sort((a, b) => (Number(usage[b.cmd].lastUsed) || 0) - (Number(usage[a.cmd].lastUsed) || 0))
      .slice(0, 3);
    const recentCommands = new Set(recent.map((c) => c.cmd));
    const frequent = [...used]
      .filter((c) => !recentCommands.has(c.cmd))
      .sort((a, b) =>
        ((Number(usage[b.cmd].count) || 0) - (Number(usage[a.cmd].count) || 0))
        || ((Number(usage[b.cmd].lastUsed) || 0) - (Number(usage[a.cmd].lastUsed) || 0)))
      .slice(0, 3);
    const prioritized = [...recent, ...frequent];
    const usedCommands = new Set(prioritized.map((c) => c.cmd));
    const standard = ['run', 'menu', 'args'].map((b) => ({
      bucket: b,
      items: SLASH_COMMANDS.filter((c) => c.bucket === b && !usedCommands.has(c.cmd) && match(c)),
    })).filter((g) => g.items.length);
    return prioritized.length ? [{ bucket: 'used', items: prioritized }, ...standard] : standard;
  }, [q, usage]);

  function pick(c) {
    setUsage((current) => recordSlashCommandUse(c.cmd, current));
    onPick(c);
  }

  return (
    <div className="pm-sheet">
      <div className="pm-sheet-head">
        <div className="sv-title">Slash commands</div>
        <button className="ghost" onClick={onClose}>✕</button>
      </div>
      <input
        className="hist-search cmd-search"
        placeholder="Filter commands…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        autoFocus
      />
      <div className="pm-sheet-list">
        {groups.length === 0 ? (
          <p className="muted" style={{ textAlign: 'center', padding: 24 }}>No matching commands.</p>
        ) : (
          groups.map((g) => (
            <div key={g.bucket} className="cmd-group">
              <div className="cmd-group-label">
                {g.bucket === 'used' ? 'Recent & frequently used' : BUCKET_LABEL[g.bucket]}
              </div>
              {g.items.map((c) => (
                <button key={c.cmd} className="pm-item cmd-item" onClick={() => pick(c)}>
                  <span className="cmd-name">{c.cmd}</span>
                  <span className="cmd-desc">{c.desc}</span>
                </button>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
