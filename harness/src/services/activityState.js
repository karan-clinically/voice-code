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

  return /(?:^|\n)\s*[·✻✽✶*]\s+[^\n…]{1,60}…\s*\([^\n)]*(?:\d+\s*[ms]\b|tokens?\b)[^\n)]*\)/i.test(tail);
}
