// Registry for built-in and user-supplied AI CLI adapters.

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
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
const customDefinitions = new Map();

function claudeCommand() {
  const explicit = process.env.CLAUDE_PATH;
  if (explicit && existsSync(explicit)) return explicit;
  const guess = join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  return existsSync(guess) ? guess : process.platform === 'win32' ? 'claude.exe' : 'claude';
}

function kimiK3Command() {
  const explicit = process.env.KIMI_K3_PATH;
  if (explicit && existsSync(explicit)) return explicit;
  const local = join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude-kimi-k3.cmd' : 'claude-kimi-k3');
  return existsSync(local) ? local : process.platform === 'win32' ? 'claude-kimi-k3.cmd' : 'claude-kimi-k3';
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
    permissionModes: true, prompts: true, rename: true, structuredCompletion: true,
  },
  auth: {
    // Spawned interactive sessions must use Claude's CLI-managed login. A
    // CLAUDE_CODE_OAUTH_TOKEN may still be present on the harness process for
    // the read-only claude.ai session list, but that inference-only token
    // prevents Remote Control and overrides the full-scope login on disk.
    methods: ['existing-cli-login', 'interactive-cli'],
    secretKeys: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
    inheritedEnv: ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'],
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
    if (ctx.model && !ctx.agentView) args.push('--model', ctx.model);
    return { command: claudeCommand(), args, env: {}, externalSessionId: ctx.resumeId || null };
  },
  buildRenameInput(label) {
    return `/rename ${label}`;
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
  // Native lifecycle hooks cover turns entered directly in the desktop TUI;
  // stabilization remains the fallback for older Codex installs or untrusted hooks.
  // Advertising chat here routes mobile sends through that pipeline instead of
  // writing raw keys, which is what enables reply history, summaries and TTS.
  capabilities: { chat: true, prompts: true, rename: true, structuredCompletion: true },
  auth: { methods: ['existing-cli-login', 'environment-token', 'interactive-cli'], secretKeys: ['OPENAI_API_KEY'], inheritedEnv: ['OPENAI_API_KEY'] },
  completion: { strategies: ['agent-event', 'native-hook', 'stabilization'], quietMs: 1800 },
  buildLaunchSpec() {
    return {
      command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
      args: ['-y', '@openai/codex', '--yolo'],
      env: {},
      externalSessionId: null,
    };
  },
  buildRenameInput(label) {
    return `/rename ${label}`;
  },
});

registerAdapter({
  id: 'kimi-k3',
  name: 'Kimi K3',
  description: 'Claude Code powered by Kimi K3 through the configured local launcher',
  capabilities: {
    chat: true, resume: true, continue: true, history: true,
    permissionModes: true, prompts: true, structuredCompletion: true,
  },
  auth: {
    methods: ['existing-cli-login'],
    secretKeys: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
    inheritedEnv: ['MOONSHOT_API_KEY', 'KIMI_API_KEY', 'KIMI_ANTHROPIC_BASE_URL'],
  },
  completion: {
    strategies: ['agent-event', 'native-hook', 'stabilization'],
    busyPatterns: ['esc to interrupt', 'thinking…', 'working…'],
    quietMs: 1500,
  },
  buildLaunchSpec(ctx) {
    const args = ctx.continueSession ? ['--continue'] : ctx.resumeId ? ['--resume', ctx.resumeId] : [];
    if (ctx.model) args.push('--model', ctx.model);
    return { command: kimiK3Command(), args, env: {}, externalSessionId: ctx.resumeId || null };
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

const BUILTIN_IDS = new Set(adapters.keys());
const AGENTS_DIR = join(DATA_DIR, 'agents');
const ID_RE = /^[a-z][a-z0-9_-]{1,63}$/;

function cleanText(value, field, max = 200) {
  const text = String(value || '').trim();
  if (!text || text.length > max || /[\r\n\0]/.test(text)) throw new Error(`invalid ${field}`);
  return text;
}

function cleanArgs(value, field = 'arguments') {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 40) throw new Error(`invalid ${field}`);
  return value.map((arg) => cleanText(arg, field, 500));
}

function cleanEndpoint(value) {
  const text = cleanText(value, 'endpoint', 500).replace(/\/+$/, '');
  let url;
  try { url = new URL(text); } catch { throw new Error('endpoint must be a valid URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('endpoint must use http or https');
  return text;
}

// Normalize the deliberately small persisted format. It describes either an
// installed CLI that owns its login, or an Anthropic-compatible endpoint driven
// through Claude Code. Secrets are never accepted here or written to the file.
export function validateCustomDefinition(input) {
  const id = String(input?.id || '').trim().toLowerCase();
  if (!ID_RE.test(id)) throw new Error('id must start with a letter and use only letters, numbers, - or _');
  if (BUILTIN_IDS.has(id)) throw new Error('built-in providers cannot be replaced');
  const type = input?.type === 'anthropic' ? 'anthropic' : input?.type === 'cli' ? 'cli' : null;
  if (!type) throw new Error('type must be cli or anthropic');
  const definition = {
    id,
    name: cleanText(input.name, 'name', 80),
    description: String(input.description || '').trim().slice(0, 240),
    type,
  };
  if (type === 'cli') {
    definition.command = cleanText(input.command, 'command', 500);
    definition.args = cleanArgs(input.args);
    definition.resumeArgs = cleanArgs(input.resumeArgs, 'resume arguments');
  } else {
    definition.endpoint = cleanEndpoint(input.endpoint);
    definition.model = cleanText(input.model, 'model', 120);
  }
  return definition;
}

function adapterFromDefinition(raw) {
  const definition = validateCustomDefinition(raw);
  if (definition.type === 'cli') {
    return {
      definition,
      adapter: adapterFromManifest({
        ...definition,
        source: 'custom',
        auth: { methods: ['existing-cli-login', 'interactive-cli'] },
        completion: { strategies: ['stabilization'], quietMs: 1800 },
        capabilities: { terminal: true, resume: definition.resumeArgs.length > 0, prompts: true },
      }),
    };
  }

  const auth = {
    methods: ['api-key'],
    configKey: `provider:${definition.id}:api_key`,
    envVar: 'ANTHROPIC_AUTH_TOKEN',
    secretKeys: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'],
    inheritedEnv: [],
    validate: (value) => typeof value === 'string' && value.trim().length >= 8,
  };
  const adapter = validateAdapter({
    id: definition.id,
    name: definition.name,
    description: definition.description,
    source: 'custom',
    auth,
    capabilities: {
      chat: true, resume: true, continue: true, history: true,
      permissionModes: true, prompts: true, structuredCompletion: true,
    },
    completion: {
      strategies: ['native-hook', 'stabilization'],
      busyPatterns: ['esc to interrupt', 'thinking…', 'working…'],
      quietMs: 1500,
    },
    buildLaunchSpec(ctx) {
      const args = ctx.continueSession ? ['--continue'] : ctx.resumeId ? ['--resume', ctx.resumeId] : [];
      if (ctx.model) args.push('--model', ctx.model);
      const model = definition.model;
      return {
        command: claudeCommand(),
        args,
        env: {
          ANTHROPIC_BASE_URL: definition.endpoint,
          ANTHROPIC_MODEL: model,
          ANTHROPIC_DEFAULT_OPUS_MODEL: model,
          ANTHROPIC_DEFAULT_SONNET_MODEL: model,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
          CLAUDE_CODE_SUBAGENT_MODEL: model,
        },
        externalSessionId: ctx.resumeId || null,
      };
    },
  });
  return { definition, adapter };
}

function manifestPath(id) {
  return join(AGENTS_DIR, `${id}.json`);
}

function installCustomDefinition(raw) {
  const { definition, adapter } = adapterFromDefinition(raw);
  adapters.set(definition.id, adapter);
  customDefinitions.set(definition.id, definition);
  return adapter;
}

export function saveCustomProvider(raw) {
  const { definition, adapter } = adapterFromDefinition(raw);
  mkdirSync(AGENTS_DIR, { recursive: true });
  const target = manifestPath(definition.id);
  writeFileSync(target, JSON.stringify(definition, null, 2) + '\n', 'utf8');
  adapters.set(definition.id, adapter);
  customDefinitions.set(definition.id, definition);
  return adapter;
}

export function removeCustomProvider(id) {
  if (!customDefinitions.has(id)) throw new Error('custom provider not found');
  try { unlinkSync(manifestPath(id)); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  customDefinitions.delete(id);
  adapters.delete(id);
}

export function isCustomProvider(id) {
  return customDefinitions.has(id);
}

function loadManifests() {
  const dir = AGENTS_DIR;
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (raw.type) installCustomDefinition(raw);
      else {
        const adapter = adapterFromManifest(raw);
        if (BUILTIN_IDS.has(adapter.id)) throw new Error('cannot replace a built-in provider');
        adapters.set(adapter.id, adapter);
        customDefinitions.set(adapter.id, { ...raw, type: 'cli' });
      }
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
  const definition = customDefinitions.get(adapter.id) || null;
  return {
    id: adapter.id,
    name: adapter.name,
    description: adapter.description,
    icon: adapter.icon,
    version: adapter.version,
    source: adapter.source || 'builtin',
    configurable: !!definition,
    configuration: definition ? {
      type: definition.type,
      command: definition.command || null,
      args: definition.args || [],
      resumeArgs: definition.resumeArgs || [],
      endpoint: definition.endpoint || null,
      model: definition.model || null,
    } : null,
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
