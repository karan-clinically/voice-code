import React, { useEffect, useState } from 'react';
import { sessionScreenPlain, sessionInput, launchClaudeIn, launchHermesIn, sayUrl } from './lib/api.js';
import { playUrl } from './lib/audio.js';
import { DictationMic, Terminal } from './components.jsx';

// Shell session: navigate with cd/ls (type or voice), hear the current
// directory, then launch an agent in place.
export default function ShellView({ session, onLaunched, onBack, notify }) {
  const [cmd, setCmd] = useState('');
  const [cwd, setCwd] = useState(session.cwd || '');
  const [launching, setLaunching] = useState(false);

  useEffect(() => {
    let stop = false;
    const poll = async () => {
      if (stop) return;
      try {
        const d = await sessionScreenPlain(session.id);
        if (d.promptCwd) setCwd(d.promptCwd);
      } catch {
        /* transient */
      }
    };
    poll();
    const t = setInterval(poll, 2000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [session.id]);

  async function run(text) {
    if (!text) return;
    try {
      await sessionInput(session.id, text);
      setCmd('');
    } catch (e) {
      notify(e.message);
    }
  }
  async function whereami() {
    try {
      playUrl(sayUrl(cwd ? 'You are in ' + cwd : 'Directory unknown'));
    } catch (e) {
      notify(e.message);
    }
  }
  async function launch(agent = 'claude') {
    setLaunching(true);
    try {
      if (agent === 'hermes') await launchHermesIn(session.id);
      else await launchClaudeIn(session.id);
      setTimeout(() => {
        setLaunching(false);
        onLaunched({ ...session, kind: agent, cwd });
      }, 3000);
    } catch (e) {
      setLaunching(false);
      notify(e.message);
    }
  }

  return (
    <div className="session-view">
      <div className="sv-top">
        <button className="ghost sv-back" onClick={onBack}>←</button>
        <div className="sv-title">Terminal · {cwd}</div>
      </div>
      <Terminal sessionId={session.id} className="sv-term" />
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button onClick={() => run('ls')}>ls</button>
        <button onClick={() => run('cd ..')}>cd ..</button>
        <button onClick={whereami}>🔊 Where am I</button>
        <button className="primary" onClick={() => launch('hermes')} disabled={launching}>🚀 Launch Hermes/Grok</button>
        <button onClick={() => launch('claude')} disabled={launching}>Launch Claude</button>
      </div>
      <div className="sv-bar">
        <DictationMic className="micbtn" text={cmd} setText={setCmd} notify={notify} />
        <textarea
          className="sv-input"
          rows={1}
          placeholder="shell command (e.g. cd voice harness)"
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              run(cmd.trim());
            }
          }}
        />
        <button className="primary sv-send" onClick={() => run(cmd.trim())}>Run</button>
      </div>
      <div className={'sv-state' + (launching ? ' busy' : '')}>{launching ? 'launching agent…' : cwd}</div>
    </div>
  );
}
