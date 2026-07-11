import React, { useCallback, useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { sessionMessages, sendChat, transcribe } from './lib/api.js';
import { MicButton } from './components.jsx';

// Claude-app-style chat over a live session (phone). Renders the harness
// conversation log as markdown bubbles and sends messages to the live session.
// Pearls theme — white rounded bubbles, green accent, no coloured rails.
export default function ChatView({ session, notify }) {
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
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

  async function send() {
    const t = text.trim();
    if (!t || sending) return;
    setText('');
    setSending(true);
    setMessages((prev) => [...prev, { id: `local-${Date.now()}`, role: 'user', text: t }]);
    pinned.current = true;
    try {
      await sendChat(session.id, t);
    } catch (e) {
      notify(e.message);
    } finally {
      setSending(false);
    }
  }

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
      <div className="chat-bar">
        <MicButton
          className="micbtn"
          onBlob={async (blob, ext) => {
            try {
              const t = await transcribe(blob, ext);
              setText((prev) => (prev ? prev + ' ' : '') + t);
            } catch (e) {
              notify(e.message);
            }
          }}
          notify={notify}
        />
        <textarea
          className="chat-input"
          rows={1}
          placeholder="Message this session…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="primary chat-send" onClick={send} disabled={sending || !text.trim()}>
          Send
        </button>
      </div>
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
