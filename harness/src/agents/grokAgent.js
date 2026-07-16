#!/usr/bin/env node
// Native Voice Harness Grok coding agent.
// Runs inside the existing node-pty terminal transport and talks directly to xAI.

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { getConfig } from '../config.js';
import { recordUsage } from '../services/usage.js';
import { GROK_DIR } from '../db.js';

const pexecFile = promisify(execFile);
const API_URL = 'https://api.x.ai/v1/chat/completions';
const DEFAULT_MODEL = 'grok-4.5';
// Claude-like multi-step coding needs more than a dozen tool rounds.
const MAX_TOOL_LOOPS = 30;
const MAX_FILE_CHARS = 120_000;
const MAX_OUTPUT_CHARS = 40_000;
const MAX_GREP_MATCHES = 100;
const MAX_GLOB_RESULTS = 200;
const SKIP_DIR_NAMES = new Set([
  '.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.turbo',
  '.cache', 'out', 'tmp', '.venv', 'venv', '__pycache__',
]);
// Terminal display only. Full tool payloads still go into the saved conversation
// for the model; this just controls how noisy the PTY is while a turn runs.
// Default is compact: one-line tool status. `/verbose` expands args + results.
let verboseTools = false;

function ansi(s, code) {
  return `\x1b[${code}m${s}\x1b[0m`;
}
const dim = (s) => ansi(s, '2');
const green = (s) => ansi(s, '32');
const cyan = (s) => ansi(s, '36');
const red = (s) => ansi(s, '31');

function clip(s, max = MAX_OUTPUT_CHARS) {
  s = String(s ?? '');
  return s.length > max ? s.slice(0, max) + `\n…[truncated ${s.length - max} chars]` : s;
}

function toolArgSummary(name, args = {}) {
  if (name === 'run_command') {
    const cmd = String(args.command || '').replace(/\s+/g, ' ').trim();
    return cmd ? clip(cmd, 80) : '';
  }
  if (name === 'grep') return clip(String(args.pattern || ''), 60);
  if (name === 'glob') return clip(String(args.pattern || ''), 60);
  if (name === 'git_diff') return args.path ? String(args.path) : (args.staged ? 'staged' : 'working tree');
  if (args.path) return String(args.path);
  if (args.command) return clip(String(args.command).replace(/\s+/g, ' ').trim(), 80);
  const keys = Object.keys(args || {});
  if (!keys.length) return '';
  try { return clip(JSON.stringify(args), 80); } catch { return ''; }
}

function toolResultSummary(name, content) {
  let data;
  try { data = JSON.parse(content); } catch { return clip(String(content || ''), 60); }
  if (!data || typeof data !== 'object') return 'ok';
  if (data.ok === false) return `error: ${clip(String(data.error || 'failed'), 80)}`;
  if (name === 'list_dir') {
    const n = Array.isArray(data.entries) ? data.entries.length : 0;
    return `${n} entr${n === 1 ? 'y' : 'ies'}${data.truncated ? ' (truncated)' : ''}`;
  }
  if (name === 'glob') {
    const n = Array.isArray(data.matches) ? data.matches.length : 0;
    return `${n} file${n === 1 ? '' : 's'}${data.truncated ? ' (truncated)' : ''}`;
  }
  if (name === 'grep') {
    const n = Array.isArray(data.matches) ? data.matches.length : 0;
    return `${n} match${n === 1 ? '' : 'es'}${data.truncated ? ' (truncated)' : ''}`;
  }
  if (name === 'read_file') {
    const range = (data.start_line != null && data.end_line != null)
      ? ` L${data.start_line}-${data.end_line}`
      : '';
    const size = data.size != null ? ` ${data.size}b` : '';
    const trunc = data.truncated ? ', truncated' : '';
    return `ok${range}${size}${trunc}`;
  }
  if (name === 'write_file') return `wrote ${data.bytes ?? '?'}b`;
  if (name === 'patch_file') return `patched ×${data.replacements ?? 1}`;
  if (name === 'delete_file') return 'deleted';
  if (name === 'change_dir') return data.cwd ? `cwd ${data.cwd}` : 'ok';
  if (name === 'git_status' || name === 'git_diff') {
    const lines = String(data.stdout || '').split(/\r?\n/).filter(Boolean).length;
    return lines ? `${lines} line${lines === 1 ? '' : 's'}` : 'clean';
  }
  if (name === 'run_command') {
    const code = data.exit_code != null ? `exit ${data.exit_code}` : 'ok';
    const out = String(data.stdout || '');
    const err = String(data.stderr || '');
    const lines = (out + err).split(/\r?\n/).filter(Boolean).length;
    return lines ? `${code} · ${lines} line${lines === 1 ? '' : 's'}` : code;
  }
  return 'ok';
}

function printToolStart(name, args) {
  const label = toolArgSummary(name, args);
  if (verboseTools) {
    process.stdout.write(dim(`\n→ ${name} ${JSON.stringify(args)}\n`));
  } else {
    process.stdout.write(dim(`\n→ ${name}${label ? ' ' + label : ''} …`));
  }
}

function printToolEnd(name, content) {
  if (verboseTools) {
    process.stdout.write(dim(clip(content, 4000) + '\n'));
  } else {
    process.stdout.write(dim(` ${toolResultSummary(name, content)}\n`));
  }
}

function shapeSecret(v) {
  const s = String(v || '');
  if (!s) return '(missing)';
  return `${s.slice(0, 4)}…${s.slice(-4)} (${s.length} chars)`;
}

function keyFromConfig() {
  return getConfig('xai_api_key') || process.env.XAI_API_KEY || '';
}

let root = resolve(process.env.CVH_PROJECT_ROOT || process.cwd());
let cwd = root;
let rootLower = root.toLowerCase();

// Conversation persistence. The harness assigns a stable id per Grok session
// (CVH_GROK_CONV) and reuses it to resume; a standalone run makes its own. The
// full LLM context (system + user + assistant + tool messages) is written to
// <GROK_DIR>/<id>.json so the session survives its PTY dying and can be resumed
// with memory intact. Written atomically (tmp + rename) because the harness reads
// this same file to render the chat view.
const convId = process.env.CVH_GROK_CONV || randomUUID();
const convFile = join(GROK_DIR, `${convId}.json`);
let convTitle = null;
let convCreatedAt = null;

async function loadConversation() {
  try {
    const data = JSON.parse(await readFile(convFile, 'utf8'));
    if (Array.isArray(data.messages) && data.messages.length) {
      convTitle = data.title || null;
      convCreatedAt = data.createdAt || null;
      return data.messages;
    }
  } catch {
    /* no prior conversation — fresh session */
  }
  return null;
}

async function saveConversation(messages, model) {
  convCreatedAt = convCreatedAt || new Date().toISOString();
  const body = JSON.stringify({
    id: convId,
    cwd: root,
    title: convTitle,
    model,
    createdAt: convCreatedAt,
    updatedAt: new Date().toISOString(),
    messages,
  });
  const tmp = `${convFile}.tmp`;
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, convFile);
}

function safePath(p = '.') {
  const candidate = isAbsolute(String(p)) ? resolve(String(p)) : resolve(cwd, String(p));
  const low = candidate.toLowerCase();
  if (low !== rootLower && !low.startsWith(rootLower + '\\') && !low.startsWith(rootLower + '/')) {
    throw new Error(`path escapes project root: ${candidate}`);
  }
  return candidate;
}

function relFromRoot(absPath) {
  return relative(root, absPath).split(/[\\/]/).join('/') || '.';
}

function toolResult(ok, data) {
  return JSON.stringify(ok ? { ok: true, ...data } : { ok: false, error: String(data?.message || data) });
}

function globToRegExp(pattern) {
  let p = String(pattern || '').replace(/\\/g, '/').trim();
  if (!p) p = '**/*';
  // Common Claude-style convenience: "*.js" means anywhere in the tree.
  if (!p.includes('/') && (p.includes('*') || p.includes('?'))) p = `**/${p}`;
  let out = '^';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      out += '.*';
      i++;
      if (p[i + 1] === '/') i++;
    } else if (c === '*') {
      out += '[^/]*';
    } else if (c === '?') {
      out += '[^/]';
    } else if ('+|(){}^$[]'.includes(c)) {
      out += `\\${c}`;
    } else if (c === '.') {
      out += '\\.';
    } else {
      out += c;
    }
  }
  out += '$';
  return new RegExp(out, 'i');
}

async function walkFiles(startDir, onFile, state = { stop: false }) {
  if (state.stop) return;
  let entries;
  try {
    entries = await readdir(startDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (state.stop) return;
    if (ent.name === '.' || ent.name === '..') continue;
    const abs = join(startDir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIR_NAMES.has(ent.name)) continue;
      await walkFiles(abs, onFile, state);
    } else if (ent.isFile()) {
      await onFile(abs, state);
    }
  }
}

async function listDir({ path = '.', max_entries = 200 } = {}) {
  const dir = safePath(path);
  const entries = await readdir(dir, { withFileTypes: true });
  const rows = entries
    .slice(0, Math.max(1, Math.min(Number(max_entries) || 200, 500)))
    .map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other' }));
  return { cwd, path: dir, entries: rows, truncated: entries.length > rows.length };
}

async function globFiles({ pattern = '**/*', path = '.', max_results = MAX_GLOB_RESULTS } = {}) {
  const start = safePath(path);
  const re = globToRegExp(pattern);
  const max = Math.max(1, Math.min(Number(max_results) || MAX_GLOB_RESULTS, 1000));
  const matches = [];
  const state = { stop: false };
  await walkFiles(start, async (abs, st) => {
    const rel = relFromRoot(abs);
    if (re.test(rel) || re.test(rel.split('/').pop() || '')) {
      matches.push(rel);
      if (matches.length >= max) st.stop = true;
    }
  }, state);
  matches.sort((a, b) => a.localeCompare(b));
  return { pattern, path: start, matches, truncated: state.stop };
}

async function grepFiles({
  pattern,
  path = '.',
  glob,
  case_insensitive = false,
  max_matches = MAX_GREP_MATCHES,
  context = 0,
} = {}) {
  if (!pattern) throw new Error('pattern required');
  const start = safePath(path);
  const max = Math.max(1, Math.min(Number(max_matches) || MAX_GREP_MATCHES, 500));
  const ctx = Math.max(0, Math.min(Number(context) || 0, 5));
  let re;
  try {
    re = new RegExp(pattern, case_insensitive ? 'i' : '');
  } catch (e) {
    throw new Error(`invalid regex: ${e.message}`);
  }
  const fileFilter = glob ? globToRegExp(glob) : null;
  const matches = [];
  const state = { stop: false };

  await walkFiles(start, async (abs, st) => {
    const rel = relFromRoot(abs);
    if (fileFilter && !(fileFilter.test(rel) || fileFilter.test(rel.split('/').pop() || ''))) return;
    let text;
    try {
      text = await readFile(abs, 'utf8');
    } catch {
      return;
    }
    // Skip likely-binary / huge blobs quickly.
    if (text.includes('\u0000')) return;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      const startLine = Math.max(0, i - ctx);
      const endLine = Math.min(lines.length - 1, i + ctx);
      const snippet = lines.slice(startLine, endLine + 1).map((line, idx) => ({
        line: startLine + idx + 1,
        text: clip(line, 400),
        match: startLine + idx === i,
      }));
      matches.push({
        path: rel,
        line: i + 1,
        text: clip(lines[i], 400),
        context: ctx ? snippet : undefined,
      });
      if (matches.length >= max) {
        st.stop = true;
        return;
      }
    }
  }, state);

  return {
    pattern,
    path: start,
    glob: glob || null,
    matches,
    count: matches.length,
    truncated: state.stop,
  };
}

async function readTextFile({ path, offset, limit } = {}) {
  if (!path) throw new Error('path required');
  const file = safePath(path);
  const st = await stat(file);
  if (!st.isFile()) throw new Error('not a file');
  const text = await readFile(file, 'utf8');
  const lines = text.split(/\r?\n/);
  const totalLines = lines.length;

  // 1-based offset/limit, Claude-style. offset may be negative (from end).
  let startIdx = 0;
  let endIdx = totalLines;
  if (offset != null || limit != null) {
    let off = Number(offset);
    if (!Number.isFinite(off)) off = 1;
    if (off < 0) startIdx = Math.max(0, totalLines + off);
    else startIdx = Math.max(0, off - 1);
    const lim = limit == null ? totalLines : Math.max(1, Number(limit) || 1);
    endIdx = Math.min(totalLines, startIdx + lim);
  }

  let slice = lines.slice(startIdx, endIdx);
  let content = slice.map((line, i) => `${String(startIdx + i + 1).padStart(6, ' ')}|${line}`).join('\n');
  let truncated = false;
  if (content.length > MAX_FILE_CHARS) {
    content = content.slice(0, MAX_FILE_CHARS) + `\n…[truncated ${content.length - MAX_FILE_CHARS} chars]`;
    truncated = true;
  }
  return {
    path: file,
    size: st.size,
    total_lines: totalLines,
    start_line: startIdx + 1,
    end_line: Math.max(startIdx, endIdx),
    content,
    truncated: truncated || endIdx < totalLines,
  };
}

async function writeTextFile({ path, content = '' } = {}) {
  if (!path) throw new Error('path required');
  const file = safePath(path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, String(content), 'utf8');
  return { path: file, bytes: Buffer.byteLength(String(content), 'utf8') };
}

async function patchTextFile({ path, old_text, new_text = '', replace_all = false } = {}) {
  if (!path) throw new Error('path required');
  if (!old_text) throw new Error('old_text required');
  const file = safePath(path);
  const text = await readFile(file, 'utf8');
  const count = text.split(old_text).length - 1;
  if (count === 0) throw new Error('old_text not found');
  if (!replace_all && count !== 1) {
    throw new Error(`old_text is not unique (${count} matches); set replace_all=true or include more context`);
  }
  const next = replace_all ? text.split(old_text).join(String(new_text)) : text.replace(old_text, String(new_text));
  await writeFile(file, next, 'utf8');
  return { path: file, replacements: replace_all ? count : 1 };
}

async function deleteFile({ path } = {}) {
  if (!path) throw new Error('path required');
  const file = safePath(path);
  const st = await stat(file);
  if (!st.isFile()) throw new Error('not a file');
  await rm(file);
  return { path: file, deleted: true };
}

async function changeDir({ path = '.' } = {}) {
  const dir = safePath(path);
  const st = await stat(dir);
  if (!st.isDirectory()) throw new Error('not a directory');
  cwd = dir;
  return { cwd };
}

async function runCommand({ command, timeout_ms = 120000, workdir } = {}) {
  if (!command) throw new Error('command required');
  const timeout = Math.max(1000, Math.min(Number(timeout_ms) || 120000, 600000));
  const runCwd = workdir ? safePath(workdir) : cwd;
  try {
    const { stdout, stderr } = await pexecFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', String(command)],
      { cwd: runCwd, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
    );
    return {
      cwd: runCwd,
      command,
      exit_code: 0,
      stdout: clip(stdout),
      stderr: clip(stderr),
    };
  } catch (e) {
    // Non-zero exits should be data for the model, not hard tool failures.
    return {
      cwd: runCwd,
      command,
      exit_code: typeof e.code === 'number' ? e.code : 1,
      stdout: clip(e.stdout || ''),
      stderr: clip(e.stderr || e.message || String(e)),
    };
  }
}

async function gitStatus() {
  return runCommand({
    command: 'git status --short --branch',
    workdir: root,
    timeout_ms: 30000,
  });
}

async function gitDiff({ path, staged = false } = {}) {
  const args = ['git', 'diff', '--no-color'];
  if (staged) args.push('--staged');
  if (path) {
    const p = safePath(path);
    args.push('--', p);
  }
  // Use PowerShell-safe joined command.
  return runCommand({
    command: args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' '),
    workdir: root,
    timeout_ms: 30000,
  });
}

const toolHandlers = {
  list_dir: listDir,
  glob: globFiles,
  grep: grepFiles,
  read_file: readTextFile,
  write_file: writeTextFile,
  patch_file: patchTextFile,
  delete_file: deleteFile,
  change_dir: changeDir,
  run_command: runCommand,
  git_status: gitStatus,
  git_diff: gitDiff,
};

const tools = [
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List files/directories under the project root (single directory, non-recursive).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, max_entries: { type: 'integer' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description: 'Find files by glob pattern under the project (skips node_modules/.git/dist). Example: **/*.{js,jsx}',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string', description: 'Subdirectory to search from' },
          max_results: { type: 'integer' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search file contents with a regex. Prefer this over shell find/select-string for code navigation.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string', description: 'File or directory to search' },
          glob: { type: 'string', description: 'Optional file filter, e.g. *.{js,jsx}' },
          case_insensitive: { type: 'boolean' },
          max_matches: { type: 'integer' },
          context: { type: 'integer', description: 'Context lines around each match (0-5)' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 text file. Use offset/limit (1-based line numbers) for large files. Negative offset counts from end.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          offset: { type: 'integer' },
          limit: { type: 'integer' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a UTF-8 text file under the project root. Prefer patch_file for existing files.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'patch_file',
      description: 'Replace text in a UTF-8 file. old_text must be unique unless replace_all=true.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_text: { type: 'string' },
          new_text: { type: 'string' },
          replace_all: { type: 'boolean' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a single file under the project root.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'change_dir',
      description: 'Change the agent working directory within the project root.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a PowerShell command and return stdout/stderr/exit_code. Non-zero exits are returned as data, not thrown.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          timeout_ms: { type: 'integer' },
          workdir: { type: 'string', description: 'Optional working directory under project root' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_status',
      description: 'Show git status --short --branch for the project root.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_diff',
      description: 'Show git diff for the project (optionally one path, optionally staged).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          staged: { type: 'boolean' },
        },
      },
    },
  },
];

function systemPrompt() {
  return `You are Grok running as the native Voice Harness coding agent in a Windows PTY.

Project root: ${root}
Current working directory is tool-managed and starts at the project root.

Tools:
- Navigation/search: glob, grep, list_dir, change_dir
- Files: read_file (supports offset/limit), write_file, patch_file, delete_file
- Execution: run_command (PowerShell; returns exit_code)
- Git: git_status, git_diff

Workflow (Claude Code style):
1) Explore with glob/grep before broad reads.
2) Read only the slices you need (offset/limit).
3) Prefer patch_file for edits; use write_file for new files.
4) Verify with a focused command (node --check, tests, build, git_diff).
5) Summarize what changed and how you verified it.

Rules:
- Use tools; do not claim you ran something unless you used a tool.
- Use PowerShell syntax for run_command.
- Keep edits scoped under the project root.
- If you need a secret/API key, ask the user to store it in Voice Harness settings; never ask them to paste secrets into the terminal output.
- Be concise. Prefer short summary statements over dumping large code blocks in the final reply. Include only key snippets, plus what changed and verification.`;
}

async function callXai(messages, apiKey, model) {
  const r = await fetch(API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, messages, tools, tool_choice: 'auto', temperature: 0.2 }),
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!r.ok) {
    const msg = data?.error?.message || data?.message || text || `HTTP ${r.status}`;
    throw new Error(`xAI ${r.status}: ${msg}`);
  }
  if (data.usage) {
    const input = data.usage.prompt_tokens ?? data.usage.input_tokens ?? data.usage.total_prompt_tokens;
    const output = data.usage.completion_tokens ?? data.usage.output_tokens ?? data.usage.total_completion_tokens;
    recordUsage('xai', 'grok', 'xai_in_token', input);
    recordUsage('xai', 'grok', 'xai_out_token', output);
  }
  return data.choices?.[0]?.message || { role: 'assistant', content: '' };
}

function parseArgs(s) {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return {}; }
}

async function answer(userText, messages, apiKey, model, save) {
  if (!convTitle) convTitle = userText.replace(/\s+/g, ' ').trim().slice(0, 80) || 'Grok session';
  messages.push({ role: 'user', content: userText });
  await save(); // reflect the pending user turn on disk so the chat view shows it at once
  for (let i = 0; i < MAX_TOOL_LOOPS; i++) {
    const msg = await callXai(messages, apiKey, model);
    messages.push(msg);
    const calls = msg.tool_calls || [];
    if (!calls.length) {
      await save();
      return String(msg.content || '').trim();
    }
    // Run independent tool calls in parallel (Claude-like), preserve reply order.
    const settled = await Promise.all(calls.map(async (call) => {
      const name = call.function?.name;
      const args = parseArgs(call.function?.arguments);
      const fn = toolHandlers[name];
      printToolStart(name, args);
      let content;
      try {
        if (!fn) throw new Error(`unknown tool: ${name}`);
        content = toolResult(true, await fn(args));
      } catch (e) {
        content = toolResult(false, e);
      }
      printToolEnd(name, content);
      return { role: 'tool', tool_call_id: call.id, content };
    }));
    for (const row of settled) messages.push(row);
    await save(); // persist after each tool round so a long turn isn't lost on a crash
  }
  await save();
  return 'Stopped: too many tool loops. Ask me to continue and I will resume from the current state.';
}

// Tell the harness this turn finished — same Stop-hook contract Claude uses, so
// /api/command, chat, TTS, and push notifications all light up for Grok sessions.
async function signalTurnComplete(text, stopReason = 'end_turn') {
  const body = {
    CVH_SESSION_ID: process.env.CVH_SESSION_ID || undefined,
    cwd: root,
    last_assistant_message: String(text || '').trim(),
    stop_reason: stopReason,
    agent: 'grok',
  };
  try {
    await fetch('http://127.0.0.1:4620/api/hooks/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    // Harness offline / not yet up — agent still works standalone.
  }
}

async function main() {
  root = resolve(process.env.CVH_PROJECT_ROOT || process.argv[2] || process.cwd());
  cwd = root;
  rootLower = root.toLowerCase();
  try { await access(root, FS.R_OK); } catch { await mkdir(root, { recursive: true }); }

  const apiKey = keyFromConfig();
  const model = getConfig('xai_model', process.env.XAI_MODEL || DEFAULT_MODEL);
  console.log(cyan('Voice Harness Grok Coding Agent'));
  console.log(dim(`model=${model} root=${root}`));
  console.log(dim(`xai_api_key=${shapeSecret(apiKey)}`));

  // Resume a saved conversation with full memory, or start fresh.
  const restored = await loadConversation();
  const messages = restored || [{ role: 'system', content: systemPrompt() }];
  if (restored) {
    const turns = restored.filter((m) => m.role === 'user').length;
    console.log(dim(`resumed conversation ${convId.slice(0, 8)} — ${turns} prior turn(s)${convTitle ? `: ${convTitle}` : ''}`));
  }
  console.log(dim('Commands: /help, /cwd, /verbose, /quiet, /exit. Type an instruction and press Enter.'));
  console.log(dim('Tools: glob, grep, read_file, write_file, patch_file, delete_file, list_dir, change_dir, run_command, git_status, git_diff'));
  console.log(dim('Tool output is compact by default — only the final summary is expanded. /verbose shows full tool dumps.'));
  if (!apiKey) {
    console.log(red('\nMissing xAI API key. Add it in Voice Harness desktop setup/settings as xai_api_key, or set XAI_API_KEY.'));
  }

  const save = () => saveConversation(messages, model).catch((e) => process.stderr.write(red(`\n[persist failed: ${e.message}]\n`)));
  const rl = createInterface({ input, output, prompt: green('grok> ') });
  rl.prompt();
  for await (const line of rl) {
    const text = line.trim();
    if (!text) { rl.prompt(); continue; }
    if (text === '/exit' || text === '/quit') break;
    if (text === '/cwd') { console.log(cwd); rl.prompt(); continue; }
    if (text === '/verbose' || text === '/v') {
      verboseTools = true;
      console.log(dim('Tool output: verbose (full args + results). /quiet to collapse.'));
      rl.prompt();
      continue;
    }
    if (text === '/quiet' || text === '/compact') {
      verboseTools = false;
      console.log(dim('Tool output: compact (one-line status). /verbose to expand.'));
      rl.prompt();
      continue;
    }
    if (text === '/help') {
      console.log('Coding tools: glob, grep, read_file, write_file, patch_file, delete_file, list_dir, change_dir, run_command, git_status, git_diff');
      console.log('Display: /verbose (full tool dumps) · /quiet (compact tool status, default) · /cwd · /exit');
      console.log('Workflow tip: glob/grep → partial read_file → patch_file → verify with run_command/git_diff.');
      rl.prompt();
      continue;
    }
    if (!apiKey) { console.log(red('No xAI API key configured.')); rl.prompt(); continue; }
    try {
      console.log(dim('thinking…'));
      const out = await answer(text, messages, apiKey, model, save);
      if (out) console.log('\n' + out + '\n');
      // Fire after the reply is on screen so chat/TTS/command waiters see final text.
      await signalTurnComplete(out || '(no response)', 'end_turn');
    } catch (e) {
      console.log(red(`\n${e.message}\n`));
      await signalTurnComplete(e.message || 'Grok turn failed', 'error');
    }
    rl.prompt();
  }
  rl.close();
}

main().catch((e) => {
  console.error(red(e.stack || e.message));
  process.exit(1);
});
