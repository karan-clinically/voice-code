import React, { useCallback, useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { sessionMessages, sendChat, sessionPrompt, selectPromptOption } from './lib/api.js';
import { ding } from './lib/audio.js';
import { copyText } from './lib/clipboard.js';
import { listenForResume } from './lib/resume.js';
import { mergeTail } from './lib/transcript.js';
import ChatComposer from './ChatComposer.jsx';

// App-style chat over a live session (phone) — Claude or Grok. Renders the
// harness conversation log as markdown bubbles and sends messages to the live
// session. Pearls theme — white rounded bubbles, green accent, no coloured rails.
export default function ChatView({ session, notify, speakerOn, onToggleSpeaker }) {
  const agentName = session.kind === 'grok' ? 'Grok' : 'Claude';
  const [messages, setMessages] = useState([]);
  const [working, setWorking] = useState(false);
  const [prompt, setPrompt] = useState(null); // interactive picker Claude is waiting on
  const [queuedTexts, setQueuedTexts] = useState([]); // parked behind the running turn; tap to push now
  const lastId = useRef(0);
  const lastSig = useRef(''); // change-signature for the full-transcript path
  const transcript = useRef([]); // assembled transcript the deltas merge into
  const transcriptVersion = useRef(null); // server's stamp; unchanged = skip the body
  const scrollRef = useRef(null);
  const pinned = useRef(true);
  const firstPoll = useRef(true); // don't chime for the backfilled history on open

  const poll = useCallback(async () => {
    try {
      const { messages: fresh, lastId: last, state, full, delta, unchanged, version, queuedCommands } =
        await sessionMessages(session.id, lastId.current, { version: transcriptVersion.current });
      transcriptVersion.current = version || null;
      setQueuedTexts(Array.isArray(queuedCommands) ? queuedCommands : []);
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
      if (unchanged) {
        // Nothing written since the last poll — the state/prompt handling above is
        // the whole point of this round trip.
      } else if (full || delta) {
        // Live transcript. `full` is the opening snapshot; after that the server
        // sends only the tail, so keep the assembled conversation here and merge
        // into it. Re-render only when it actually changed (avoids needless
        // re-render/scroll), keeping any optimistic local- user turn that hasn't
        // reached the transcript yet.
        const merged = full ? fresh : mergeTail(transcript.current, fresh);
        transcript.current = merged;
        lastId.current = last || merged.length;
        const lastMsg = merged[merged.length - 1];
        const sig = merged.length + '|' + (lastMsg ? lastMsg.text.slice(-48) : '');
        if (sig !== lastSig.current) {
          setMessages((prev) => {
            const locals = prev.filter(
              (m) => String(m.id).startsWith('local-') && !merged.some((f) => f.role === 'user' && f.text === m.text)
            );
            return [...merged.map((f) => ({ ...f, id: 't' + f.id })), ...locals];
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
    const stopResume = listenForResume(poll);
    return () => { clearInterval(t); stopResume(); };
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
      const r = await sendChat(session.id, t);
      ding('sent'); // the harness accepted it — Claude is working (or holding it queued)
      if (r?.queued) {
        setQueuedTexts((prev) => (prev.includes(t) ? prev : [...prev, t]));
        notify('Queued behind the running turn — tap it to push now');
      } else if (r?.injected) {
        setQueuedTexts((prev) => prev.filter((q) => q !== t));
      }
    } catch (e) {
      setWorking(false);
      ding('error');
      notify(e.message);
    }
  }

  // Tap on a queued bubble: re-send the same text, which the server treats as
  // "push it into the running turn now".
  async function pushNow(t) {
    try {
      await sendChat(session.id, t);
      ding('sent');
      setQueuedTexts((prev) => prev.filter((q) => q !== t));
      poll();
    } catch (e) {
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
            <span className="muted">
              {session.kind === 'grok'
                ? 'Grok replies land here after each turn completes.'
                : 'When Claude asks a multiple-choice question, tap an option below.'}
            </span>
          </p>
        ) : (
          messages
            // A queued turn renders as its own tappable bubble below, not as a
            // normal (already-sent-looking) optimistic user bubble.
            .filter((m) => !(String(m.id).startsWith('local-') && queuedTexts.includes(m.text)))
            .map((m) => <Bubble key={m.id} role={m.role} text={m.text} />)
        )}
        {queuedTexts.map((t) => (
          <div key={'q-' + t} className="chat-msg user">
            <button className="chat-bubble chat-queued" onClick={() => pushNow(t)} title="Push into the running turn now">
              <div className="chat-plain">{t}</div>
              <span className="chat-queued-tag">queued · tap to send now</span>
            </button>
          </div>
        ))}
        {working && (
          <div className="chat-msg assistant">
            <div className="chat-bubble chat-working">
              <span className="cw-dot" /><span className="cw-dot" /><span className="cw-dot" />
              <span className="cw-label">{agentName} is working…</span>
            </div>
          </div>
        )}
      </div>
      {prompt && session.kind !== 'grok' && (
        <div className="chat-prompt">
          {prompt.context && <p className="prompt-context">{prompt.context}</p>}
          {prompt.question && <p className="prompt-question">{prompt.question}</p>}
          {prompt.multi ? (
            <p className="muted">Claude is asking a multi-part question — open the Terminal view to answer it.</p>
          ) : (
            <>
              <div className="chat-prompt-hint">Tap an option to answer</div>
              {prompt.options.map((o) => (
                <button key={o.n} className="chat-opt" onClick={() => choose(o.n)} disabled={working}>
                  <span className="voice-opt-n">{o.n}</span>
                  <span className="voice-opt-label">
                    {o.label}
                    {o.description && <small>{o.description}</small>}
                  </span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
      {/* `busy` must come from the live poll: `session` is a snapshot from when the
          view opened, so session.state never flips and the ■ Stop button would never
          appear while Claude works. */}
      <ChatComposer
        session={session}
        onSubmit={submit}
        lastAssistantText={lastAssistantText}
        notify={notify}
        busy={working}
        speakerOn={speakerOn}
        onToggleSpeaker={onToggleSpeaker}
      />
    </>
  );
}

const mdComponents = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">{children}</a>
  ),
  code: CopyableCode,
};

function CopyableCode({ children, className }) {
  const [copied, setCopied] = useState(false);
  const value = String(children || '').replace(/\n$/, '');
  const copy = async () => {
    if (!(await copyText(value))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  return (
    <code
      className={(className || '') + ' copy-code'}
      role="button"
      tabIndex={0}
      title="Tap to copy"
      aria-label={`Copy ${value}`}
      data-copied={copied ? 'Copied' : undefined}
      onClick={copy}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copy(); } }}
    >
      {children}
    </code>
  );
}

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
