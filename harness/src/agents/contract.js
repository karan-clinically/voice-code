// Provider-neutral AI CLI adapter contract. The harness core only relies on
// this small surface; provider-specific launch/auth/lifecycle knowledge belongs
// in adapters (or declarative manifests), never in the PTY/session services.

const ID_RE = /^[a-z][a-z0-9_-]{1,63}$/;

export const DEFAULT_CAPABILITIES = Object.freeze({
  terminal: true,
  chat: false,
  resume: false,
  continue: false,
  history: false,
  models: false,
  permissionModes: false,
  prompts: false,
  usage: false,
  structuredCompletion: false,
});

export function normalizeCapabilities(input = {}) {
  return Object.fromEntries(
    Object.entries({ ...DEFAULT_CAPABILITIES, ...input }).map(([key, value]) => [key, value === true])
  );
}

export function validateAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') throw new Error('adapter must be an object');
  if (!ID_RE.test(adapter.id || '')) throw new Error(`invalid adapter id: ${adapter.id || '(missing)'}`);
  if (!adapter.name || typeof adapter.name !== 'string') throw new Error(`adapter ${adapter.id} needs a name`);
  if (typeof adapter.buildLaunchSpec !== 'function') {
    throw new Error(`adapter ${adapter.id} needs buildLaunchSpec(context)`);
  }
  return Object.freeze({
    version: 1,
    description: '',
    icon: adapter.id,
    hidden: false,
    auth: { methods: ['existing-cli-login'], secretKeys: [], inheritedEnv: [] },
    completion: { strategies: ['stabilization'], quietMs: 1500 },
    ...adapter,
    capabilities: normalizeCapabilities(adapter.capabilities),
  });
}

// Turn a simple JSON manifest into an adapter. Place manifests in
// ~/.claude-voice-harness/agents/*.json. Tokens are substituted without a
// shell, so user text cannot become shell syntax.
export function adapterFromManifest(manifest) {
  const argsFor = (ctx) => {
    const template = ctx.resumeId && Array.isArray(manifest.resumeArgs)
      ? manifest.resumeArgs
      : Array.isArray(manifest.args) ? manifest.args : [];
    return template.map((arg) => String(arg)
      .replaceAll('{cwd}', ctx.cwd)
      .replaceAll('{externalSessionId}', ctx.resumeId || ''));
  };
  return validateAdapter({
    ...manifest,
    source: 'manifest',
    buildLaunchSpec(ctx) {
      return {
        command: manifest.command,
        args: argsFor(ctx),
        env: manifest.env || {},
        externalSessionId: ctx.resumeId || null,
      };
    },
  });
}
