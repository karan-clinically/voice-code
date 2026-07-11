import React, { useCallback, useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { sessionMessages, sendChat } from './lib/api.js';
import ChatComposer from './ChatComposer.jsx';

// Claude-app-style chat over a live session (phone). Renders the harness
// conversation log as markdown bubbles and sends messages to the live session.
// Pearls theme — white rounded bubbles, green accent, no coloured rails.
export default function ChatView({ session, notify }) {
  const [messages, setMessages] = useState([]);
  const lastId = useRef(0);
  const scrollRef = useRef(null);
  const pinned = useRef(true);

  const poll = useCallback(async () => {
    try {
      const { messages: fresh, lastId: last } = await sessionMessages(session.id, lastId.current);
      if (fresh.length) {
        lastId.current = last;
        setMessages((prev) => [...prev, ...fresh]);
      }
    } catch {
      /* transient */
    }
  }, [session.id]);

  useEffect(() => {
    poll();
    const t = setInterval(poll, 1600);
    return () => clearInterval(t);
  }, [poll]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  async function submit(t) {
    setMessages((prev) => [...prev, { id: `local-${Date.now()}`, role: 'user', text: t }]);
    pinned.current = true;
    try {
      await sendChat(session.id, t);
    } catch (e) {
      notify(e.message);
    }
  }

  const lastAssistantText = [...messages].reverse().find((m) => m.role === 'assistant')?.text || '';

  return (
    <>
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        {messages.length === 0 ? (
          <p className="chat-empty">
            No messages yet — type below to talk to this session. Replies appear here formatted.
            <br />
            <span className="muted">Interactive prompts still need the Terminal view.</span>
          </p>
        ) : (
          messages.map((m) => <Bubble key={m.id} role={m.role} text={m.text} />)
        )}
      </div>
      <ChatComposer session={session} onSubmit={submit} lastAssistantText={lastAssistantText} notify={notify} />
    </>
  );
}

const mdComponents = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">{children}</a>
  ),
};

function Bubble({ role, text }) {
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
