import React, { useCallback, useEffect, useRef, useState } from 'react';
import { searchArchive, archiveProjects, resumeArchive } from './lib/api.js';

// Full-screen History view (phone). Search past Claude Code sessions and resume
// any into a live session. Pearls styling — kind/skills shown as muted text
// tags, thin full borders, no coloured edge rails.
export default function History({ onOpen, onBack, notify }) {
  const [q, setQ] = useState('');
  const [project, setProject] = useState('');
  const [projects, setProjects] = useState([]);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(true);
  const [resuming, setResuming] = useState(null);
  const seq = useRef(0);

  useEffect(() => {
    archiveProjects().then((r) => setProjects(r.projects || [])).catch(() => {});
  }, []);

  const run = useCallback(
    async (query, proj) => {
      const mine = ++seq.current;
      setLoading(true);
      try {
        const { sessions } = await searchArchive(query, proj);
        if (mine === seq.current) setResults(sessions);
      } catch (e) {
        if (mine === seq.current) notify(e.message);
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    [notify]
  );

  useEffect(() => {
    const t = setTimeout(() => run(q.trim(), project), 200);
    return () => clearTimeout(t);
  }, [q, project, run]);

  async function resume(s) {
    if (resuming) return;
    if (!s.cwdExists) {
      notify('Original folder is gone: ' + (s.cwd || '?'));
      return;
    }
    setResuming(s.uuid);
    try {
      onOpen(await resumeArchive(s.uuid));
    } catch (e) {
      notify('Resume failed: ' + e.message);
      setResuming(null);
    }
  }

  return (
    <div className="history-view">
      <div className="hist-top">
        <button className="sv-back" onClick={onBack} aria-label="Back">←</button>
        <input
          className="hist-search"
          placeholder="Search past sessions…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
        />
      </div>

      {projects.length > 0 && (
        <div className="hist-chips">
          <button className={'chip' + (project === '' ? ' on' : '')} onClick={() => setProject('')}>All</button>
          {projects.map((p) => (
            <button
              key={p.dir}
              className={'chip' + (project === p.dir ? ' on' : '')}
              onClick={() => setProject(project === p.dir ? '' : p.dir)}
            >
              {p.name} <span className="chip-n">{p.count}</span>
            </button>
          ))}
        </div>
      )}

      <div className="hist-scroll">
        {loading && results.length === 0 ? (
          <p className="muted" style={{ textAlign: 'center', padding: 28 }}>Searching…</p>
        ) : results.length === 0 ? (
          <p className="muted" style={{ textAlign: 'center', padding: 28 }}>
            {q ? 'No sessions match.' : 'No archived sessions yet.'}
          </p>
        ) : (
          results.map((s) => (
            <div key={s.uuid} className="hist-card">
              <div className="hist-card-title">
                {s.title}
                {s.live && <span className="hist-live">● live</span>}
              </div>
              <div className="hist-card-meta">
                <span className="hist-proj">{s.project}</span>
                <span className="hist-sep">·</span>
                <span>{fmtDate(s.lastTs)}</span>
                <span className="hist-sep">·</span>
                <span>{s.userCount} prompt{s.userCount === 1 ? '' : 's'}</span>
              </div>
              {(s.skills?.length > 0 || s.mcp?.length > 0) && (
                <div className="hist-tags">
                  {s.skills.map((k) => <span key={k} className="hist-tag">/{k}</span>)}
                  {s.mcp.map((m) => <span key={m} className="hist-tag mcp">{m}</span>)}
                </div>
              )}
              {s.snippet && <div className="hist-snip">{renderSnippet(s.snippet)}</div>}
              <button
                className="primary hist-resume"
                disabled={resuming === s.uuid || !s.cwdExists}
                onClick={() => resume(s)}
              >
                {resuming === s.uuid ? 'Resuming…' : s.cwdExists ? 'Resume' : 'Folder gone'}
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// FTS snippet: the backend wraps matched terms in U+0001 .. U+0002 (control chars,
// so highlighting can't collide with brackets in code). Split on those markers and
// render the wrapped runs as <mark>. Marker chars are built at runtime to keep the
// source pure ASCII.
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
