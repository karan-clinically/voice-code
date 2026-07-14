import { resumeArchive, openAgentView } from './api.js';

// Whether a /recent row can be opened / switched to.
export const canOpenRow = (it) => (it.kind === 'harness' && it.alive) || it.bgAgent || !!it.resumeUuid;

// Open a /recent row into a session.
//
//   ATTACHABLE (harness-owned pty) → attach in place. The harness owns the process,
//     so the phone, the terminal and Claude remote control all drive the SAME session.
//   background agent → the agent view (it rejects --resume).
//   ELSEWHERE (harness doesn't own it) → the only lever is `claude --resume`, which
//     BRANCHES into a new conversation that immediately diverges from the live one.
//     That used to happen silently and left you driving a stale fork, so confirm first.
//
// Calls onOpen with the resulting session; surfaces errors via notify. Shared by the
// Home Sessions list and the in-session switcher drawer.
export async function openSessionRow(it, onOpen, notify) {
  try {
    if (it.kind === 'harness' && it.alive) {
      onOpen({ id: it.harnessId, kind: it.shell ? 'shell' : 'claude', label: it.name, cwd: it.cwd });
    } else if (it.bgAgent) {
      onOpen(await openAgentView(it.agentCwd || it.cwd, it.name));
    } else if (it.resumeUuid) {
      const ok = window.confirm(
        `"${it.name}" is running outside the harness, so it can't be joined.\n\n` +
          'Continuing it starts a NEW branch from its history — the original keeps ' +
          'running separately and your branch will not see its new messages.\n\n' +
          'Continue in a new branch?'
      );
      if (!ok) return;
      onOpen(await resumeArchive(it.resumeUuid));
    }
  } catch (e) {
    notify?.(e.message);
  }
}
