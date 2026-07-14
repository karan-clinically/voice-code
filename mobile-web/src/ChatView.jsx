import React, { useCallback, useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { sessionMessages, sendChat, sessionPrompt, selectPromptOption } from './lib/api.js';
import { ding } from './lib/audio.js';
import ChatComposer from './ChatComposer.jsx';

// Claude-app-style chat over a live session (phone). Renders the harness
// conversation log as markdown bubbles and sends messages to the live session.
// Pearls theme — white rounded bubbles, green accent, no coloured rails.
export default function ChatView({ session, notify }) {
  const [messages, setMessages] = useState([]);
  const [working, setWorking] = useState(false);
  const [prompt, setPrompt] = useState(null); // interactive picker Claude is waiting on
  const lastId = useRef(0);
  const lastSig = useRef(''); // change-signature for the full-transcript path
  const scrollRef = useRef(null);
  const pinned = useRef(true);
  const firstPoll = useRef(true); // don't chime for the backfilled history on open

  const poll = useCallback(async () => {
    try {
      const { messages: fresh, lastId: last, state, full } = await sessionMessages(session.id, lastId.current);
      // Prefer the server's busy state (once deployed); until then, clear the
      // indicator when the assistant's reply lands.
      if (state !== undefined) setWorking(state === 'busy');
      else if (fresh.some((m) => m.role === 'assistant')) setWorking(false);
      // Claude parked on an interactive picker → fetch its options to show buttons.
      if (state === 'awaiting_input') {
        try { setPrompt((await sessionPrompt(session.id)).prompt); } catch { /* transient */ }
      } else {
        setPrompt(null);
      }
      if (full) {
        // Live transcript snapshot: the whole conversation each poll. Replace only
        // when it actually changed (avoids needless re-render/scroll), keeping any
        // optimistic local- user turn that hasn't reached the transcript yet.
        const lastMsg = fresh[fresh.length - 1];
        const sig = fresh.length + '|' + (lastMsg ? lastMsg.text.slice(-48) : '');
        if (sig !== lastSig.current) {
          setMessages((prev) => {
            const locals = prev.filter(
              (m) => String(m.id).startsWith('local-') && !fresh.some((f) => f.role === 'user' && f.text === m.text)
            );
            return [...fresh.map((f) => ({ ...f, id: 't' + f.id })), ...locals];
          });
          if (!firstPoll.current && lastMsg && lastMsg.role === 'assistant') ding('success');
          lastSig.current = sig;
        }
      } else if (fresh.length) {
        lastId.current = last;
        setMessages((prev) => {
          // Drop the optimistic local copies of any user turns the server now returns.
          let base = prev;
          for (const f of fresh) {
            if (f.role === 'user') base = base.filter((m) => !(String(m.id).startsWith('local-') && m.text === f.text));
          }
          return [...base, ...fresh];
        });
        // Chime when Claude's reply lands — but not for the history backfilled on open.
        if (!firstPoll.current && fresh.some((m) => m.role === 'assistant')) ding('success');
      }
      firstPoll.current = false;
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
  }, [messages, working]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  async function submit(t) {
    setMessages((prev) => [...prev, { id: `local-${Date.now()}`, role: 'user', text: t }]);
    setWorking(true); // immediate feedback; the poll keeps it in sync
    pinned.current = true;
    try {
      await sendChat(session.id, t);
      ding('sent'); // the harness accepted it — Claude is now working
    } catch (e) {
      setWorking(false);
      ding('error');
      notify(e.message);
    }
  }

  async function choose(index) {
    setPrompt(null);
    setWorking(true);
    pinned.current = true;
    try {
      await selectPromptOption(session.id, index);
    } catch (e) {
      notify(e.message);
    }
    poll();
  }

  const lastAssistantText = [...messages].reverse().find((m) => m.role === 'assistant')?.text || '';

  return (
    <>
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        {messages.length === 0 ? (
          <p className="chat-empty">
            No messages yet — type below to talk to this session. Replies appear here formatted.
            <br />
            <span className="muted">When Claude asks a multiple-choice question, tap an option below.</span>
          </p>
        ) : (
          messages.map((m) => <Bubble key={m.id} role={m.role} text={m.text} />)
        )}
        {working && (
          <div className="chat-msg assistant">
            <div className="chat-bubble chat-working">
              <span className="cw-dot" /><span className="cw-dot" /><span className="cw-dot" />
              <span className="cw-label">Claude is working…</span>
            </div>
          </div>
        )}
      </div>
      {prompt && (
        <div className="chat-prompt">
          {prompt.multi ? (
            <p className="muted">Claude is asking a multi-part question — open the Terminal view to answer it.</p>
          ) : (
            <>
              <div className="chat-prompt-hint">Tap an option to answer</div>
              {prompt.options.map((o) => (
                <button key={o.n} className="chat-opt" onClick={() => choose(o.n)} disabled={working}>
                  <span className="voice-opt-n">{o.n}</span>
                  <span className="voice-opt-label">{o.label}</span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
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
