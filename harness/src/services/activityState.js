import { detectPrompt } from './prompt.js';

// What the rendered screen says a session is doing, or null when it shows neither.
// A picker outranks the spinner: while Claude waits on a decision it is not
// working, and a turn driven from the terminal (or Remote Control) never goes
// through awaitReply(), so the screen is the only place that transition appears.
// Without this a decision-pending session keeps reporting "Working".
export function screenState(screen, patterns = []) {
  if (detectPrompt(screen)) return 'awaiting_input';
  if (screenShowsWorking(screen, patterns)) return 'busy';
  return null;
}

// Shared working-state detection for terminal-driven agents. Adapter patterns
// cover stable UI copy; Claude's spinner also cycles through whimsical verbs
// ("Whisking…", "Churning…", etc.), so recognise its elapsed/token line too.
export function screenShowsWorking(screen, patterns = []) {
  const tail = String(screen || '').split('\n').slice(-35).join('\n');
  if (!tail) return false;

  const configured = patterns.some((pattern) => {
    try {
      return new RegExp(pattern, 'im').test(tail);
    } catch {
      return false;
    }
  });
  if (configured) return true;

  return /(?:^|\n)\s*[·✢✻✽✶*]\s+[^\n…]{1,60}…\s*\([^\n)]*(?:\d+\s*[ms]\b|tokens?\b)[^\n)]*\)/i.test(tail);
}
