import React, { useEffect, useState } from 'react';
import { sessionScreenPlain, sessionInput, listProviders, launchProviderIn, sayUrl, killSession } from './lib/api.js';
import { playUrl } from './lib/audio.js';
import { DictationMic, Terminal } from './components.jsx';

// Shell session: navigate with cd/ls (type or voice), hear the current
// directory, then launch an agent in place.
export default function ShellView({ session, onLaunched, onBack, notify }) {
  const [cmd, setCmd] = useState('');
  const [cwd, setCwd] = useState(session.cwd || '');
  const [launching, setLaunching] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [providers, setProviders] = useState([]);

  useEffect(() => {
    listProviders().then((d) => setProviders(d.providers || [])).catch(() => {});
  }, []);

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
  async function launch(provider) {
    setLaunching(true);
    try {
      const launched = await launchProviderIn(session.id, provider.id);
      setLaunching(false);
      onLaunched(launched);
    } catch (e) {
      setLaunching(false);
      notify(e.message);
    }
  }

  async function endSession() {
    setShowMenu(false);
    const name = session.label || cwd || `Session ${session.id}`;
    if (!window.confirm(`End "${name}"?\n\nThis stops the shell session everywhere — phone and desktop terminal.`)) return;
    try {
      await killSession(session.id);
      onBack();
    } catch (e) {
      notify?.('End session failed: ' + e.message);
    }
  }

  return (
    <div className="session-view">
      <div className="sv-top">
        <button className="ghost sv-back" onClick={onBack}>←</button>
        <div className="sv-title">Terminal · {cwd}</div>
        <button
          className="ghost sv-more"
          onClick={() => setShowMenu((v) => !v)}
          aria-label="Session options"
          aria-expanded={showMenu}
        >
          ⋯
        </button>
        {showMenu && (
          <>
            <div className="sv-menu-backdrop" onClick={() => setShowMenu(false)} />
            <div className="sv-menu" role="menu">
              <div className="sv-menu-head">Session</div>
              <button className="sv-menu-item" role="menuitem" onClick={endSession}>
                <span className="sv-menu-ico">🛑</span>
                <span className="sv-menu-label">End session</span>
                <span className="sv-menu-state">Kill</span>
              </button>
            </div>
          </>
        )}
      </div>
      <Terminal sessionId={session.id} className="sv-term" />
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button onClick={() => run('ls')}>ls</button>
        <button onClick={() => run('cd ..')}>cd ..</button>
        <button onClick={whereami}>🔊 Where am I</button>
        {(providers.length ? providers : [{ id: 'claude', name: 'Claude Code' }]).map((provider, index) => (
          <button
            key={provider.id}
            className={index === 0 ? 'primary' : ''}
            onClick={() => launch(provider)}
            disabled={launching}
          >
            Launch {provider.name}
          </button>
        ))}
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
