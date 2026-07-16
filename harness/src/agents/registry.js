// Registry for built-in and user-supplied AI CLI adapters.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from '../db.js';
import { MODEL_OPTIONS } from '../services/models.js';
import { adapterFromManifest, validateAdapter } from './contract.js';
import { credentialStatus } from './credentials.js';
import { makeLogger } from '../util/logger.js';

const log = makeLogger('agent-adapters');
const HERE = dirname(fileURLToPath(import.meta.url));
const adapters = new Map();

function claudeCommand() {
  const explicit = process.env.CLAUDE_PATH;
  if (explicit && existsSync(explicit)) return explicit;
  const guess = join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  return existsSync(guess) ? guess : process.platform === 'win32' ? 'claude.exe' : 'claude';
}

export function registerAdapter(input) {
  const adapter = validateAdapter(input);
  if (adapters.has(adapter.id)) throw new Error(`duplicate adapter id: ${adapter.id}`);
  adapters.set(adapter.id, adapter);
  return adapter;
}

registerAdapter({
  id: 'claude',
  name: 'Claude Code',
  description: 'Anthropic Claude Code CLI',
  capabilities: {
    chat: true, resume: true, continue: true, history: true, models: true,
    permissionModes: true, prompts: true, structuredCompletion: true,
  },
  auth: {
    methods: ['existing-cli-login', 'environment-token', 'interactive-cli'],
    secretKeys: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
    inheritedEnv: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'],
  },
  completion: {
    strategies: ['agent-event', 'native-hook', 'stabilization'],
    busyPatterns: ['esc to interrupt', 'thinking…', 'working…'],
    quietMs: 1500,
  },
  models: MODEL_OPTIONS,
  buildLaunchSpec(ctx) {
    const args = ctx.agentView ? ['agents']
      : ctx.continueSession ? ['--continue']
      : ctx.resumeId ? ['--resume', ctx.resumeId] : [];
    return { command: claudeCommand(), args, env: {}, externalSessionId: ctx.resumeId || null };
  },
});

registerAdapter({
  id: 'grok',
  name: 'Grok',
  description: 'Voice Harness native xAI coding agent',
  capabilities: { chat: true, resume: true, history: true, prompts: true, usage: true, structuredCompletion: true },
  auth: {
    methods: ['api-key'],
    configKey: 'xai_api_key',
    envVar: 'XAI_API_KEY',
    secretKeys: ['XAI_API_KEY'],
    inheritedEnv: ['XAI_API_KEY'],
    validate: (value) => /^xai-[A-Za-z0-9_-]{12,}$/.test(value),
  },
  completion: { strategies: ['agent-event', 'idle-pattern'], idlePatterns: ['grok>'], quietMs: 1500 },
  buildLaunchSpec(ctx) {
    const convId = ctx.externalSessionId || ctx.grokConv || randomUUID();
    return {
      command: process.execPath,
      args: [join(HERE, 'grokAgent.js'), ctx.cwd],
      env: { CVH_PROJECT_ROOT: ctx.cwd, CVH_GROK_CONV: convId },
      externalSessionId: convId,
    };
  },
});

registerAdapter({
  id: 'codex',
  name: 'Codex CLI',
  description: 'OpenAI Codex terminal agent',
  capabilities: { prompts: true },
  auth: { methods: ['existing-cli-login', 'environment-token', 'interactive-cli'], secretKeys: ['OPENAI_API_KEY'], inheritedEnv: ['OPENAI_API_KEY'] },
  completion: { strategies: ['stabilization'], quietMs: 1800 },
  buildLaunchSpec() {
    return {
      command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
      args: ['-y', '@openai/codex', '--yolo'],
      env: {},
      externalSessionId: null,
    };
  },
});

registerAdapter({
  id: 'shell',
  name: 'Shell',
  description: 'Generic navigation terminal',
  hidden: true,
  auth: { methods: ['none'], secretKeys: [], inheritedEnv: [] },
  completion: { strategies: [], quietMs: 0 },
  buildLaunchSpec() {
    return process.platform === 'win32'
      ? { command: 'powershell.exe', args: ['-NoLogo', '-NoExit'], env: {}, externalSessionId: null }
      : { command: process.env.SHELL || '/bin/sh', args: [], env: {}, externalSessionId: null };
  },
});

function loadManifests() {
  const dir = join(DATA_DIR, 'agents');
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      registerAdapter(adapterFromManifest(JSON.parse(readFileSync(join(dir, name), 'utf8'))));
    } catch (err) {
      log.warn(`ignored agent manifest ${name}: ${err.message}`);
    }
  }
}
loadManifests();

export function getAdapter(id = 'claude') {
  return adapters.get(id) || null;
}

export function requireAdapter(id = 'claude') {
  const adapter = getAdapter(id);
  if (!adapter) throw new Error(`unknown AI CLI provider: ${id}`);
  return adapter;
}

export function publicAdapter(adapter) {
  return {
    id: adapter.id,
    name: adapter.name,
    description: adapter.description,
    icon: adapter.icon,
    version: adapter.version,
    source: adapter.source || 'builtin',
    hidden: !!adapter.hidden,
    capabilities: adapter.capabilities,
    authentication: { methods: adapter.auth?.methods || [], ...credentialStatus(adapter) },
    models: adapter.capabilities.models ? adapter.models || [] : [],
  };
}

export function allAdapters() {
  return [...adapters.values()];
}

export function listAdapters({ includeHidden = false } = {}) {
  return [...adapters.values()].filter((a) => includeHidden || !a.hidden).map(publicAdapter);
}
