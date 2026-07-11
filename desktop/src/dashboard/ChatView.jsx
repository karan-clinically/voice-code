import React, { useCallback, useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { sessionMessages, sendChat } from '../lib/api.js';
import ChatComposer from './ChatComposer.jsx';

// Claude-app-style conversation view over a live session. Renders the harness's
// conversation log (assistant turns from the Stop hook, user turns from this box)
// as markdown bubbles, polling incrementally. Overlays the terminal pane; the
// xterm stays mounted underneath so the PTY/scrollback survive the toggle.
export default function ChatView({ session, active, notify }) {
  const [messages, setMessages] = useState([]);
  const lastId = useRef(0);
  const scrollRef = useRef(null);
  const pinnedBottom = useRef(true);

  // Reset when the session changes.
  useEffect(() => {
    setMessages([]);
    lastId.current = 0;
  }, [session.id]);

  const poll = useCallback(async () => {
    try {
      const { messages: fresh, lastId: last } = await sessionMessages(session.id, lastId.current);
      if (fresh.length) {
        lastId.current = last;
        setMessages((prev) => [...prev, ...fresh]);
      }
    } catch {
      /* transient — harness may be busy */
    }
  }, [session.id]);

  // Poll only while this pane is the active/visible one.
  useEffect(() => {
    if (!active) return;
    poll();
    const t = setInterval(poll, 1500);
    return () => clearInterval(t);
  }, [active, poll]);

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
  const lastAssistantText = [...messages].reverse().find((m) => m.role === 'assistant')?.text || '';

  return (
    <div className={'chat-pane' + (active ? ' active' : '')}>
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        {messages.length === 0 ? (
          <div className="chat-empty">
            No messages yet. Type below to talk to this session — replies appear here formatted.
            <br />
            <span className="chat-empty-sub">Interactive prompts (permissions, plan approval) still need the Terminal view.</span>
          </div>
        ) : (
          messages
            .filter((m) => m.role !== 'system' || m.text)
            .map((m) => <Bubble key={m.id} role={m.role} text={m.text} />)
        )}
        {busy && <div className="chat-working">working…</div>}
      </div>
      <ChatComposer session={session} onSubmit={submit} lastAssistantText={lastAssistantText} notify={notify} />
    </div>
  );
}

const mdComponents = {
  // Open links in the system browser (Electron), never navigate the app frame.
  a: ({ href, children }) => (
    <a href={href} onClick={(e) => { e.preventDefault(); window.cvh?.openExternal?.(href); }}>
      {children}
    </a>
  ),
};

function Bubble({ role, text }) {
  if (role === 'system') return <div className="chat-system">{text}</div>;
  return (
    <div className={'chat-msg ' + role}>
      <div className="chat-bubble">
        {role === 'user' ? (
          <div className="chat-plain">{text}</div>
        ) : (
          <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>{text}</Markdown>
        )}
      </div>
    </div>
  );
}
