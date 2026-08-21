import React, { useEffect, useMemo, useState } from 'react';

// Claude's choices, lifted out of the terminal into something you can answer with
// a thumb. The TUI renders every prompt the same way — a numbered list you walk
// with arrows — but they are not the same question: some take one answer, some
// take several, and some want words the list can't express. So the drawer picks
// its control from the prompt instead of mirroring the terminal:
//
//   radio     one answer, and tapping it IS the answer — no confirm step for the
//             most common prompt in the app (a permission dialog).
//   checkbox  several answers, so tapping only marks; Send submits the set.
//   text      always available. Any TUI prompt accepts typed input followed by
//             Enter, so this needs no detection to be correct, and it is the only
//             way to say something the options don't cover.
//
// Dismissing leaves the prompt untouched on screen — the terminal and keypad
// still answer it, which matters when the detector reads a picker wrongly.
export default function PromptDrawer({ prompt, busy = false, onPick, onPickMany, onText, onClose }) {
  const multi = !!prompt?.multi;
  const options = useMemo(() => prompt?.options || [], [prompt]);
  const [checked, setChecked] = useState(() => new Set(options.filter((o) => o.selected).map((o) => o.n)));
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  // A new prompt reuses this component; re-seed from what the TUI already has
  // ticked so the drawer opens agreeing with the screen behind it.
  useEffect(() => {
    setChecked(new Set(options.filter((o) => o.selected).map((o) => o.n)));
    setText('');
  }, [prompt?.question, options]);

  if (!prompt) return null;
  const working = busy || sending;

  const run = async (action) => {
    if (working) return;
    setSending(true);
    try {
      await action();
    } finally {
      setSending(false);
    }
  };
  const toggle = (n) => setChecked((prev) => {
    const next = new Set(prev);
    if (next.has(n)) next.delete(n);
    else next.add(n);
    return next;
  });

  return (
    <>
      <div className="pd-backdrop" onClick={onClose} />
      <div className="pd-drawer" role="dialog" aria-modal="true" aria-label="Claude is asking">
        <div className="pd-head">
          <span className="pd-title">{multi ? 'Choose any that apply' : 'Claude is asking'}</span>
          <button type="button" className="ghost" onClick={onClose} aria-label="Answer in the terminal instead">✕</button>
        </div>
        <div className="pd-body">
          {prompt.question && <p className="pd-question">{prompt.question}</p>}
          {prompt.context && <p className="pd-context">{prompt.context}</p>}

          <div className="pd-options" role={multi ? 'group' : 'radiogroup'}>
            {options.map((option) => {
              const on = multi ? checked.has(option.n) : option.cursor;
              return (
                <button
                  key={option.n}
                  type="button"
                  className={'pd-option' + (on ? ' on' : '')}
                  role={multi ? 'checkbox' : 'radio'}
                  aria-checked={on}
                  disabled={working}
                  onClick={() => (multi ? toggle(option.n) : run(() => onPick(option)))}
                >
                  <span className={'pd-mark' + (multi ? ' box' : '')} aria-hidden="true">{on ? (multi ? '✓' : '●') : ''}</span>
                  <span className="pd-option-copy">
                    <span className="pd-option-label">{option.label}</span>
                    {option.description && <span className="pd-option-desc">{option.description}</span>}
                  </span>
                  <span className="pd-option-n">{option.n}</span>
                </button>
              );
            })}
          </div>

          {multi && (
            <button
              type="button"
              className="primary pd-submit"
              disabled={working}
              onClick={() => run(() => onPickMany([...checked]))}
            >
              {working ? 'Sending…' : checked.size ? `Send ${checked.size} selected` : 'Send with none selected'}
            </button>
          )}

          <div className="pd-text">
            <label className="pd-text-label" htmlFor="pd-text-input">Or answer in your own words</label>
            <div className="row">
              <input
                id="pd-text-input"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Type an answer…"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && text.trim()) run(() => onText(text.trim()));
                }}
                style={{ flex: 1 }}
              />
              <button
                type="button"
                className="primary"
                disabled={working || !text.trim()}
                onClick={() => run(() => onText(text.trim()))}
              >
                Send
              </button>
            </div>
          </div>

          {prompt.hint && <p className="pd-hint">{prompt.hint}</p>}
        </div>
      </div>
    </>
  );
}
