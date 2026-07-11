import React, { useCallback, useEffect, useRef, useState } from 'react';
import { searchArchive, archiveProjects, resumeArchive } from '../lib/api.js';

// Full-screen History drawer over the terminal dashboard. Search past Claude Code
// sessions (FTS over prompts/responses) and resume any into a live terminal tab.
// Dark IDE styling; kind/category shown via muted text tags — no coloured rails.
export default function HistoryOverlay({ onClose, onResume, notify }) {
  const [q, setQ] = useState('');
  const [project, setProject] = useState('');
  const [projects, setProjects] = useState([]);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(true);
  const [resuming, setResuming] = useState(null);
  const inputRef = useRef(null);
  const seq = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
    archiveProjects().then((r) => setProjects(r.projects || [])).catch(() => {});
  }, []);

  const run = useCallback(async (query, proj) => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const { sessions } = await searchArchive(query, proj);
      if (mine === seq.current) setResults(sessions);
    } catch (e) {
      if (mine === seq.current) notify?.('Search failed: ' + e.message);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [notify]);

  // Debounced search on query/project change.
  useEffect(() => {
    const t = setTimeout(() => run(q.trim(), project), 180);
    return () => clearTimeout(t);
  }, [q, project, run]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function resume(s) {
    if (resuming) return;
    if (!s.cwdExists) { notify?.('Original folder is gone: ' + (s.cwd || '?')); return; }
    setResuming(s.uuid);
    try {
      const session = await resumeArchive(s.uuid);
      onResume(session);
    } catch (e) {
      notify?.('Resume failed: ' + e.message);
      setResuming(null);
    }
  }

  return (
    <div className="hist-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="hist-panel" onMouseDown={(e) => e.stopPropagation()}>
        <header className="hist-head">
          <span className="hist-title">History</span>
          <input
            ref={inputRef}
            className="hist-search"
            placeholder="Search past sessions — prompts, responses, titles…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button className="tool" onClick={onClose} title="Close (Esc)">✕</button>
        </header>

        {projects.length > 0 && (
          <div className="hist-filters">
            <button className={'chip' + (project === '' ? ' on' : '')} onClick={() => setProject('')}>
              All projects
            </button>
            {projects.map((p) => (
              <button
                key={p.dir}
                className={'chip' + (project === p.dir ? ' on' : '')}
                onClick={() => setProject(project === p.dir ? '' : p.dir)}
                title={`${p.count} session${p.count === 1 ? '' : 's'}`}
              >
                {p.name} <span className="chip-n">{p.count}</span>
              </button>
            ))}
          </div>
        )}

        <div className="hist-list">
          {loading && results.length === 0 ? (
            <p className="hist-empty">Searching…</p>
          ) : results.length === 0 ? (
            <p className="hist-empty">{q ? 'No sessions match.' : 'No archived sessions yet.'}</p>
          ) : (
            results.map((s) => (
              <div key={s.uuid} className="hist-row">
                <div className="hist-row-main">
                  <div className="hist-row-title">
                    {s.title}
                    {s.live && <span className="hist-live" title="Currently open as a live session">● live</span>}
                  </div>
                  <div className="hist-meta">
                    <span className="hist-project">{s.project}</span>
                    <span className="hist-dot">·</span>
                    <span>{fmtDate(s.lastTs)}</span>
                    <span className="hist-dot">·</span>
                    <span>{s.userCount} prompt{s.userCount === 1 ? '' : 's'}</span>
                    {s.skills?.map((k) => <span key={k} className="hist-tag">/{k}</span>)}
                    {s.mcp?.map((m) => <span key={m} className="hist-tag mcp">{m}</span>)}
                  </div>
                  {s.snippet && <div className="hist-snippet">{renderSnippet(s.snippet)}</div>}
                </div>
                <button
                  className="tool hist-resume"
                  disabled={resuming === s.uuid || !s.cwdExists}
                  onClick={() => resume(s)}
                  title={s.cwdExists ? `Resume in ${s.cwd}` : 'Original folder no longer exists'}
                >
                  {resuming === s.uuid ? 'Resuming…' : s.cwdExists ? 'Resume' : 'Folder gone'}
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// FTS snippet: the backend wraps matched terms in U+0001 .. U+0002 (control chars,
// so highlighting cannot collide with brackets in code). Split on those markers
// and render the wrapped runs as <mark>. Marker chars are built at runtime to
// keep the source pure ASCII.
const MARK_A = String.fromCharCode(1);
const MARK_B = String.fromCharCode(2);
function renderSnippet(text) {
  const parts = [];
  let i = 0;
  let k = 0;
  while (i < text.length) {
    const a = text.indexOf(MARK_A, i);
    if (a === -1) { parts.push(text.slice(i)); break; }
    if (a > i) parts.push(text.slice(i, a));
    const b = text.indexOf(MARK_B, a + 1);
    if (b === -1) { parts.push(text.slice(a + 1)); break; }
    parts.push(<mark key={k++}>{text.slice(a + 1, b)}</mark>);
    i = b + 1;
  }
  return parts;
}

function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(+d)) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
