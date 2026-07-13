import { resumeArchive, openAgentView } from './api.js';

// Whether a /recent row can be opened / switched to.
export const canOpenRow = (it) => (it.kind === 'harness' && it.alive) || it.bgAgent || !!it.resumeUuid;

// Open a /recent row into a session: a live harness PTY directly; a background agent
// through the agent view (it rejects --resume); anything else resumes into a fresh
// PTY. Calls onOpen with the resulting session; surfaces errors via notify. Shared by
// the Home Sessions list and the in-session switcher drawer.
export async function openSessionRow(it, onOpen, notify) {
  try {
    if (it.kind === 'harness' && it.alive) {
      onOpen({ id: it.harnessId, kind: it.shell ? 'shell' : 'claude', label: it.name, cwd: it.cwd });
    } else if (it.bgAgent) {
      onOpen(await openAgentView(it.agentCwd || it.cwd, it.name));
    } else if (it.resumeUuid) {
      onOpen(await resumeArchive(it.resumeUuid));
    }
  } catch (e) {
    notify?.(e.message);
  }
}
