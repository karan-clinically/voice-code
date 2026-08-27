// Codex lifecycle hooks -> Voice Harness's provider-neutral agent events.
// Kept separate from the hook executable so the translation and setup merge can
// be regression-tested without starting Codex or touching ~/.codex.

export const CODEX_HOOK_EVENTS = ['UserPromptSubmit', 'PermissionRequest', 'PostToolUse', 'Stop'];

const TYPE_BY_HOOK = {
  UserPromptSubmit: 'turn.started',
  PermissionRequest: 'prompt.requested',
  // Once an approved tool has run, the turn is working again rather than still
  // waiting on the permission that preceded it.
  PostToolUse: 'turn.started',
  Stop: 'turn.completed',
};

export function codexHookToAgentEvent(input = {}, env = process.env) {
  const type = TYPE_BY_HOOK[input.hook_event_name];
  const correlationId = String(env.CVH_SESSION_ID || '').trim();
  // Hooks are installed at user scope. A normal Codex launched outside Voice
  // Harness has no correlation token and must remain completely unaffected.
  if (!type || !correlationId) return null;
  return {
    type,
    correlationId,
    externalSessionId: input.session_id || null,
    cwd: input.cwd || null,
    responseText: input.last_assistant_message ?? null,
    transcriptPath: input.transcript_path || null,
    turnId: input.turn_id || null,
    toolName: input.tool_name || null,
  };
}

export function codexHookHandler(command) {
  return {
    type: 'command',
    command,
    commandWindows: command,
    timeout: 5,
  };
}

export function isVoiceHarnessCodexHook(handler, scriptPath) {
  if (!handler || handler.type !== 'command') return false;
  const commands = [handler.command, handler.commandWindows, handler.command_windows]
    .filter(Boolean)
    .map(String);
  return commands.some((command) => command.includes(scriptPath));
}

// Add or remove our handler without disturbing any user/plugin hook in the same
// event. Empty matcher groups left by uninstall are removed as well.
export function mergeCodexHooks(config = {}, { command, scriptPath, uninstall = false } = {}) {
  const next = { ...config, hooks: { ...(config.hooks || {}) } };
  for (const eventName of CODEX_HOOK_EVENTS) {
    const groups = Array.isArray(next.hooks[eventName]) ? next.hooks[eventName] : [];
    const kept = groups
      .map((group) => ({
        ...group,
        hooks: Array.isArray(group?.hooks)
          ? group.hooks.filter((handler) => !isVoiceHarnessCodexHook(handler, scriptPath))
          : [],
      }))
      .filter((group) => group.hooks.length > 0);
    if (!uninstall) kept.push({ hooks: [codexHookHandler(command)] });
    if (kept.length) next.hooks[eventName] = kept;
    else delete next.hooks[eventName];
  }
  if (Object.keys(next.hooks).length === 0) delete next.hooks;
  return next;
}
