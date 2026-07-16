// Provider credential broker. Provider authentication is deliberately separate
// from phone-to-harness authentication: this module only controls credentials
// inherited by an AI CLI process.

import { getConfig, setConfig, deleteConfig } from '../config.js';

function authFor(adapter) {
  return adapter?.auth || { methods: ['existing-cli-login'], secretKeys: [], inheritedEnv: [] };
}

export function credentialStatus(adapter) {
  const auth = authFor(adapter);
  if (auth.methods?.includes('none')) return { status: 'not-required', configured: true };
  if (auth.configKey) {
    const configured = !!getConfig(auth.configKey);
    return { status: configured ? 'configured' : 'required', configured };
  }
  return { status: 'cli-managed', configured: null };
}

export function saveCredential(adapter, value) {
  const auth = authFor(adapter);
  if (!auth.configKey) throw new Error(`${adapter.name} does not accept a harness-managed credential`);
  const secret = typeof value === 'string' ? value.trim() : '';
  if (!secret) throw new Error('credential must not be blank');
  if (typeof auth.validate === 'function' && !auth.validate(secret)) {
    throw new Error(`credential is not valid for ${adapter.name}`);
  }
  setConfig(auth.configKey, secret);
  return credentialStatus(adapter);
}

export function removeCredential(adapter) {
  const auth = authFor(adapter);
  if (!auth.configKey) throw new Error(`${adapter.name} has no harness-managed credential`);
  deleteConfig(auth.configKey);
  return credentialStatus(adapter);
}

// Return a child-process environment policy. Every secret declared by another
// adapter is removed, while this adapter may explicitly inherit selected names.
// A harness-managed key is injected under auth.envVar and never passed as an arg.
export function spawnEnvironment(adapter, allAdapters = []) {
  const auth = authFor(adapter);
  const inherited = new Set(auth.inheritedEnv || []);
  const removeEnv = new Set();
  for (const candidate of allAdapters) {
    for (const key of candidate.auth?.secretKeys || []) {
      if (!inherited.has(key)) removeEnv.add(key);
    }
  }
  const env = {};
  if (auth.configKey && auth.envVar) {
    const value = getConfig(auth.configKey);
    if (value) env[auth.envVar] = value;
  }
  return { env, removeEnv: [...removeEnv] };
}
