import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_TRANSCRIPT_CHARS = 14_000;
const MAX_DIFF_CHARS = 18_000;

function clipTail(value, limit) {
  const text = String(value || '').trim();
  if (text.length <= limit) return text;
  return `[earlier content omitted]\n${text.slice(-limit)}`;
}

async function git(cwd, args) {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 512 * 1024,
    });
    return String(stdout || '').trim();
  } catch {
    return '';
  }
}

export async function readWorkspaceCheckpoint(cwd) {
  const [status, stat, diff] = await Promise.all([
    git(cwd, ['status', '--short', '--branch']),
    git(cwd, ['diff', '--stat']),
    git(cwd, ['diff', '--no-ext-diff', '--unified=2']),
  ]);
  return { status, stat, diff: clipTail(diff, MAX_DIFF_CHARS) };
}

function transcriptTail(messages = []) {
  const useful = messages
    .filter((message) => ['user', 'assistant'].includes(message?.role) && String(message?.text || '').trim())
    .slice(-16)
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}:\n${String(message.text).trim()}`)
    .join('\n\n');
  return clipTail(useful, MAX_TRANSCRIPT_CHARS) || '(No recorded conversation was available.)';
}

export function buildHandoffPrompt({ source, targetProvider, messages, workspace }) {
  const sourceName = source?.provider?.name || source?.kind || 'the previous agent';
  const targetName = targetProvider?.name || targetProvider?.id || 'this agent';
  const status = workspace?.status || '(Git status unavailable or this folder is not a Git repository.)';
  const stat = workspace?.stat || '(No unstaged diff summary.)';
  const diff = workspace?.diff || '(No unstaged diff.)';

  return `You are taking over an in-progress coding session from ${sourceName} in Voice Harness.

Continue the same task as ${targetName}. Treat the workspace on disk as authoritative. First inspect the current files and Git state, then continue from the latest user intent. Do not undo existing changes merely because you did not create them. If the checkpoint conflicts with the filesystem, follow the filesystem and briefly call out the discrepancy.

## Session checkpoint
- Previous session: ${source?.label || `Session ${source?.id || ''}`}
- Previous provider: ${sourceName}
- Working directory: ${source?.cwd || '(unknown)'}
- Branch: ${source?.git_branch || '(unknown)'}

## Recent conversation
${transcriptTail(messages)}

## Git status
${status}

## Diff summary
${stat}

## Current unstaged diff
${diff}

Begin by acknowledging the handoff in one short sentence, then continue the work. Do not ask the user to repeat context already present above.`;
}
