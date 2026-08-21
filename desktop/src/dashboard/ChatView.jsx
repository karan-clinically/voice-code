import React, { useCallback, useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { sessionMessages, sendChat } from '../lib/api.js';
import { openExternal } from '../lib/open.js';
import ChatComposer from './ChatComposer.jsx';

// App-style conversation view over a live session (Claude or Grok). Renders the
// harness conversation log (assistant turns from the Stop/turn-complete hook,
// user turns from this box) as markdown bubbles, polling incrementally. Overlays
// the terminal pane; the xterm stays mounted underneath so the PTY/scrollback
// survive the toggle.
export default function ChatView({ session, active, notify }) {
  const [messages, setMessages] = useState([]);
  const lastId = useRef(0);
  const lastSig = useRef(''); // change-signature for the full-transcript path
  const scrollRef = useRef(null);
  const pinnedBottom = useRef(true);

  // Reset when the session changes.
  useEffect(() => {
    setMessages([]);
    lastId.current = 0;
    lastSig.current = '';
  }, [session.id]);

  const poll = useCallback(async () => {
    try {
      const { messages: fresh, lastId: last, full, version } = await sessionMessages(session.id, lastId.current);
      if (full) {
        // Whenever Claude's own on-disk transcript is readable the server ignores
        // ?after and returns the WHOLE conversation, flagged `full`. Appending that
        // re-added the entire history on every poll, so scrolling back replayed the
        // same turns over and over — replace instead, and only when it actually
        // changed, so the view doesn't re-render and fight the scroll position.
        // "Changed" is the server's stamp of the transcript file (mtime + size),
        // which moves on every write. The earlier heuristic — message count plus
        // the tail of the last message — missed any change that landed elsewhere
        // (a queued user turn sitting last while the assistant's reply filled in
        // above it), leaving the chat stale until something else moved it. Grok
        // sends no stamp, so fall back to comparing the whole payload.
        const sig = version ? String(version) : JSON.stringify(fresh);
        if (sig === lastSig.current) return;
        lastSig.current = sig;
        setMessages((prev) => {
          // Keep an optimistic bubble only until its turn reaches the transcript.
          const locals = prev.filter(
            (m) => m._local && !fresh.some((f) => f.role === 'user' && f.text === m.text)
          );
          return [...fresh.map((f) => ({ ...f, id: 't' + f.id })), ...locals];
        });
        return;
      }
      if (fresh.length) {
        lastId.current = last;
        setMessages((prev) => {
          let base = prev;
          for (const f of fresh) {
            if (f.role === 'user') base = base.filter((m) => !(m._local && m.text === f.text));
          }
          return [...base, ...fresh];
        });
      }
    } catch {
      /* transient — harness may be busy */
    }
  }, [session.id]);

  // Poll only while this pane is the active/visible one. A hidden window has its
  // timers slowed right down, so also poll the moment it comes back, rather than
  // leaving the last minute's turns to arrive on the next tick.
  useEffect(() => {
    if (!active) return;
    poll();
    const t = setInterval(poll, 1500);
    const onVisible = () => { if (document.visibilityState === 'visible') poll(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', poll);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', poll);
    };
  }, [active, poll]);

  // The harness pushes state over the socket (busy → idle when a turn lands);
  // fetch the turn right then instead of waiting out the interval.
  useEffect(() => {
    if (active) poll();
  }, [active, poll, session.state]);

  // Auto-scroll to bottom unless the user scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) pinnedBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  async function submit(t) {
    // Optimistic user bubble (the server also records it; poll will reconcile).
    setMessages((prev) => [...prev, { id: `local-${Date.now()}`, role: 'user', text: t, _local: true }]);
    pinnedBottom.current = true;
    try {
      await sendChat(session.id, t);
    } catch {
      setMessages((prev) => [...prev, { id: `err-${Date.now()}`, role: 'system', text: 'Failed to send — is the session alive?' }]);
    }
  }

  const busy = session.state === 'busy';
  // A turn that has only run tools so far carries steps but no prose; skip it so
  // the composer's replay button still offers the last thing Claude actually said.
  const lastAssistantText = [...messages].reverse().find((m) => m.role === 'assistant' && m.text)?.text || '';

  return (
    <div className={'chat-pane' + (active ? ' active' : '')}>
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        {messages.length === 0 ? (
          <div className="chat-empty">
            No messages yet. Type below to talk to this session — replies appear here formatted.
            <br />
            <span className="chat-empty-sub">
              {session.kind === 'grok'
                ? 'Grok replies land here after each turn completes.'
                : 'Interactive prompts (permissions, plan approval) still need the Terminal view.'}
            </span>
          </div>
        ) : (
          (() => {
            const shown = messages.filter((m) => m.role !== 'system' || m.text);
            const lastIdx = shown.length - 1;
            return shown.map((m, i) => (
              <Bubble
                key={m.id}
                role={m.role}
                text={m.text}
                steps={m.steps}
                // Only the turn still being written is "live" — that one shows its
                // steps expanded; every finished turn keeps them folded away.
                live={busy && i === lastIdx}
              />
            ));
          })()
        )}
        {busy && <div className="chat-working">working…</div>}
      </div>
      <ChatComposer session={session} onSubmit={submit} lastAssistantText={lastAssistantText} notify={notify} />
    </div>
  );
}

const mdComponents = {
  // Open links in the system browser (Electron) or a new tab (served), never
  // navigate the app frame out from under the session.
  a: ({ href, children }) => (
    <a href={href} onClick={(e) => { e.preventDefault(); openExternal(href); }}>
      {children}
    </a>
  ),
};

// The tool calls behind a turn. Open while the turn is running — that is the only
// window into a long stretch of work with no prose — and folded once it lands, so
// scrolling back through a conversation isn't wading through tool logs. Toggling
// by hand still works; the next state change re-applies the default.
function Steps({ steps, live }) {
  const [open, setOpen] = useState(live);
  useEffect(() => { setOpen(live); }, [live]);
  if (!steps?.length) return null;
  return (
    <div className={'chat-steps' + (open ? ' open' : '')}>
      <button type="button" className="chat-steps-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="chat-steps-caret">{open ? '▾' : '▸'}</span>
        {live && <span className="chat-steps-live" aria-hidden="true" />}
        {steps.length} {steps.length === 1 ? 'step' : 'steps'}
      </button>
      {open && (
        <ol className="chat-steps-list">
          {steps.map((s, i) => <li key={i}>{s}</li>)}
        </ol>
      )}
    </div>
  );
}

function Bubble({ role, text, steps, live }) {
  if (role === 'system') return <div className="chat-system">{text}</div>;
  return (
    <div className={'chat-msg ' + role}>
      <div className="chat-bubble">
        {role === 'assistant' && <Steps steps={steps} live={live} />}
        {role === 'user' ? (
          <div className="chat-plain">{text}</div>
        ) : (
          text && <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>{text}</Markdown>
        )}
      </div>
    </div>
  );
}
