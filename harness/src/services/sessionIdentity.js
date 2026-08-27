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
    session.kind === 'claude'
    && (session.claude_session_id === conversationId || session.external_session_id === conversationId));
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

export function providerConversationKey(session) {
  const conversationId = session?.sessionId || session?.external_session_id || session?.claude_session_id;
  if (!conversationId) return null;
  const provider = session?.agentKind || session?.provider_id || session?.kind || 'claude';
  return `${provider}:${conversationId}`;
}

// Provider thread ids occupy separate namespaces. Even an identical raw id must
// not make an OpenAI session hide an Anthropic session (or vice versa).
export function dedupeProviderSessions(rows) {
  const result = [];
  const byConversation = new Map();
  for (const row of rows || []) {
    const key = providerConversationKey(row);
    if (!key) {
      result.push(row);
      continue;
    }
    const previous = byConversation.get(key);
    if (!previous) {
      byConversation.set(key, row);
      result.push(row);
      continue;
    }
    if (Date.parse(row.ts || 0) > Date.parse(previous.ts || 0)) {
      result[result.indexOf(previous)] = row;
      byConversation.set(key, row);
    }
  }
  return result;
}

const normalizedCwd = (cwd) => String(cwd || '').replace(/[\\/]+$/, '').toLowerCase();

export function uniqueSessionLabel(rows, cwd, preferredLabel) {
  const base = String(preferredLabel || '').trim() || 'New session';
  const folder = normalizedCwd(cwd);
  const used = new Set((rows || [])
    .filter((row) => row?.alive !== false && normalizedCwd(row?.cwd) === folder)
    .map((row) => String(row?.label || '').trim().toLowerCase())
    .filter(Boolean));
  if (!used.has(base.toLowerCase())) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base} ${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}
