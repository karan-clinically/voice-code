// Pure identity helpers shared by the session list and archive-resume route.
// Working directories and titles are presentation metadata, never identity: many
// unrelated sessions (and background agents) can legitimately share both.

export function processForHarnessSession(session, liveProcesses) {
  if (!session || session.kind !== 'claude' || !session.pid) return null;
  return liveProcesses.find((process) => Number(process.pid) === Number(session.pid)) || null;
}

export function liveHarnessForConversation(sessions, conversationId, liveProcesses) {
  if (!conversationId) return null;
  const open = sessions.filter((session) => session.alive);
  const stored = open.find((session) =>
    session.claude_session_id === conversationId || session.external_session_id === conversationId);
  if (stored) return stored;

  const pids = new Set(liveProcesses
    .filter((process) => process.sessionId === conversationId)
    .map((process) => Number(process.pid)));
  return open.find((session) => session.kind === 'claude' && pids.has(Number(session.pid))) || null;
}

export function isBackgroundAgentSession(session, backgroundSessionIds) {
  return !!session?.agentView
    || !!(session?.sessionId && backgroundSessionIds.has(session.sessionId));
}
