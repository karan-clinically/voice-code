import React from 'react';

// A hardware-style key pad for driving TUIs from the phone — the agent view, Claude's
// numbered pickers, permission dialogs — i.e. the keys a soft keyboard doesn't give
// you: a real cursor cluster, Enter/Esc/Tab, Ctrl-C to interrupt, backspace. Every key
// writes its raw sequence straight to the pty via sendRaw (the same /ws/term channel
// the ⋯ popover used). Layout mirrors a keyboard's arrow cluster (inverted T) so the
// directions land where the thumb expects them. ⇧Tab cycles Claude's permission mode.
const SEQ = {
  esc: '\x1b', tab: '\t', stab: '\x1b[Z', enter: '\r', space: ' ', bs: '\x7f',
  up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C',
  cC: '\x03', // Ctrl-C — interrupt / cancel the current turn
};

export default function TerminalKeypad({ sendRaw, onClose }) {
  // A momentary press cue so a tap on a phone still feels like it registered.
  const K = (s, label, cls) => (
    <button type="button" className={'tk' + (cls ? ' ' + cls : '')} onClick={() => sendRaw(s)}>
      {label}
    </button>
  );
  return (
    <div className="tkbd">
      <div className="tkbd-rows">
        <div className="tkbd-specials">
          {K(SEQ.esc, 'Esc')}
          {K(SEQ.tab, 'Tab')}
          {K(SEQ.stab, '⇧Tab')}
          {K(SEQ.cC, 'Ctrl-C', 'tk-cspan')}
          {K(SEQ.bs, '⌫')}
        </div>
        <div className="tkbd-arrows">
          <span />
          {K(SEQ.up, '↑')}
          <span />
          {K(SEQ.left, '←')}
          {K(SEQ.down, '↓')}
          {K(SEQ.right, '→')}
        </div>
      </div>
      <div className="tkbd-wide">
        {K(SEQ.space, 'Space', 'tk-space')}
        {K(SEQ.enter, '⏎  Enter', 'tk-enter')}
      </div>
      <button type="button" className="tk tk-abc" onClick={onClose}>Abc — back to typing</button>
    </div>
  );
}
