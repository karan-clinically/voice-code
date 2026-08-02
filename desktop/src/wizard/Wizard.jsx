import React, { useState } from 'react';
import StepApiKeys from './StepApiKeys.jsx';
import StepAgents from './StepAgents.jsx';
import StepProjects from './StepProjects.jsx';
import StepTunnel from './StepTunnel.jsx';
import StepHook from './StepHook.jsx';
import StepPairing from './StepPairing.jsx';

const STEPS = ['Brains', 'Projects', 'Speech & voice', 'Tunnel', 'Claude hook', 'Pairing'];

export default function Wizard({ onDone, onExit }) {
  const [step, setStep] = useState(0);
  const next = () => setStep((s) => Math.min(s + 1, STEPS.length - 1));
  const back = () => setStep((s) => Math.max(s - 1, 0));

  return (
    <div className="app">
      <header className="topbar">
        <h1>Claude Code Voice Harness · Setup</h1>
        {onExit && (
          <button className="wizard-exit" onClick={onExit} title="Leave settings and return to your sessions">
            Exit settings ×
          </button>
        )}
      </header>
      <main className="content">
        <ol className="stepper">
          {STEPS.map((s, i) => (
            <li key={s} className={i === step ? 'active' : i < step ? 'done' : ''}>
              <span className="step-n">{i + 1}</span>
              {s}
            </li>
          ))}
        </ol>
        <div className="card">
          {step === 0 && <StepAgents onNext={next} />}
          {step === 1 && <StepProjects onNext={next} onBack={back} />}
          {step === 2 && <StepApiKeys onNext={next} />}
          {step === 3 && <StepTunnel onNext={next} onBack={back} />}
          {step === 4 && <StepHook onNext={next} onBack={back} />}
          {step === 5 && <StepPairing onBack={back} onDone={onDone} />}
        </div>
      </main>
    </div>
  );
}
