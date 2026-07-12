// Claude Code built-in slash commands (from code.claude.com/docs), used by the
// phone terminal for: (a) the tappable command picker, and (b) validating a spoken
// "slash <command>" so voice dictation can invoke them without saying "/".
// bucket: 'run' = runs immediately · 'menu' = opens a selector (use the ⋯ keys to
// navigate) · 'args' = takes arguments (edit before sending).

export const SLASH_COMMANDS = [
  // runs immediately
  { cmd: '/help', desc: 'Show available commands', bucket: 'run' },
  { cmd: '/clear', desc: 'Start fresh (old chat stays in /resume)', bucket: 'run' },
  { cmd: '/status', desc: 'Session status: model, cwd, MCP, account', bucket: 'run' },
  { cmd: '/context', desc: 'Visualize context usage', bucket: 'run' },
  { cmd: '/cost', desc: 'Show session cost / token usage', bucket: 'run' },
  { cmd: '/usage', desc: 'API usage and cost breakdown', bucket: 'run' },
  { cmd: '/tasks', desc: 'List background subagent work', bucket: 'run' },
  { cmd: '/diff', desc: 'Interactive diff viewer', bucket: 'run' },
  { cmd: '/doctor', desc: 'Setup checkup and diagnostics', bucket: 'run' },
  { cmd: '/hooks', desc: 'View hook configurations', bucket: 'run' },
  { cmd: '/memory', desc: 'Edit CLAUDE.md memory files', bucket: 'run' },
  { cmd: '/init', desc: 'Initialize project with CLAUDE.md', bucket: 'run' },
  { cmd: '/run', desc: 'Launch and drive your app', bucket: 'run' },
  { cmd: '/security-review', desc: 'Check diff for vulnerabilities', bucket: 'run' },
  { cmd: '/feedback', desc: 'Report bugs / share conversation', bucket: 'run' },

  // opens a selector — use the ⋯ keys (arrows · Space · Enter) to pick
  { cmd: '/model', desc: 'Switch model', bucket: 'menu' },
  { cmd: '/effort', desc: 'Set reasoning effort', bucket: 'menu' },
  { cmd: '/mcp', desc: 'Manage MCP servers', bucket: 'menu' },
  { cmd: '/agents', desc: 'Manage subagents', bucket: 'menu' },
  { cmd: '/skills', desc: 'List available skills', bucket: 'menu' },
  { cmd: '/permissions', desc: 'Manage tool permission rules', bucket: 'menu' },
  { cmd: '/resume', desc: 'Return to an earlier conversation', bucket: 'menu' },
  { cmd: '/branch', desc: 'Branch the conversation', bucket: 'menu' },
  { cmd: '/vim', desc: 'Toggle vim editing mode', bucket: 'menu' },

  // take arguments — edit before sending
  { cmd: '/compact', desc: 'Summarize to free space (opt: instructions)', bucket: 'args' },
  { cmd: '/config', desc: 'Adjust a setting', bucket: 'args' },
  { cmd: '/cd', desc: 'Move session to a directory', bucket: 'args' },
  { cmd: '/add-dir', desc: 'Add directory access', bucket: 'args' },
  { cmd: '/review', desc: 'Read-only PR review', bucket: 'args' },
  { cmd: '/code-review', desc: 'Review diff for bugs/cleanups', bucket: 'args' },
  { cmd: '/simplify', desc: 'Cleanup-only review', bucket: 'args' },
  { cmd: '/plan', desc: 'Enter plan mode', bucket: 'args' },
  { cmd: '/btw', desc: 'Quick side question (not saved)', bucket: 'args' },
  { cmd: '/copy', desc: 'Copy last response', bucket: 'args' },
  { cmd: '/export', desc: 'Export the conversation', bucket: 'args' },
  { cmd: '/fast', desc: 'Toggle fast mode (on|off)', bucket: 'args' },
  { cmd: '/advisor', desc: 'Second-model guidance (model|off)', bucket: 'args' },
  { cmd: '/deep-research', desc: 'Fan-out web research', bucket: 'args' },
  { cmd: '/loop', desc: 'Run a prompt on an interval', bucket: 'args' },
  { cmd: '/schedule', desc: 'Create a scheduled routine', bucket: 'args' },
  { cmd: '/fork', desc: 'Spawn a background subagent', bucket: 'args' },
  { cmd: '/background', desc: 'Detach as a background agent', bucket: 'args' },
  { cmd: '/debug', desc: 'Enable debug logging', bucket: 'args' },
];

export const BUCKET_LABEL = { run: 'Runs immediately', menu: 'Opens a menu', args: 'Takes arguments' };

const KNOWN = new Set(SLASH_COMMANDS.map((c) => c.cmd));

// Spoken slash commands: dictation can't say "/", so turn a leading
// "slash <cmd>" / "forward slash <cmd>" into "/<cmd>" when <cmd> is a real command
// (validated). Anything typed/spoken that isn't a known command is left untouched.
export function normalizeSpokenSlash(text) {
  const m = String(text).match(/^\s*(?:forward[\s-]*)?slash[\s-]+([a-z][a-z-]*)\b(.*)$/i);
  if (!m) return text;
  const cmd = '/' + m[1].toLowerCase();
  return KNOWN.has(cmd) ? cmd + m[2] : text;
}
