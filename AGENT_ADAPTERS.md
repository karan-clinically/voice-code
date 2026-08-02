# AI CLI adapters

Voice Harness treats the PTY transport as provider-neutral infrastructure. An
adapter supplies the provider-specific executable, arguments, authentication
policy, completion hints, and optional capabilities. Terminal access is the
baseline: chat, resume, history, models, prompts, and usage are optional.

## Built-in adapters

Built-ins live in `harness/src/agents/registry.js`. Claude Code, Grok, Codex CLI,
and the hidden navigation shell all use the same adapter contract. The backend
publishes safe metadata at `GET /api/providers`; clients use its capability map
instead of maintaining their own provider list.

Provider credentials are separate from the bearer token that protects remote
access to the harness. `harness/src/agents/credentials.js` injects only the
selected provider's managed or explicitly inherited credentials into its child
process. Credential values are never returned by the provider API.

## Adding a CLI without code

Create `~/.claude-voice-harness/agents/<id>.json` and restart the harness:

```json
{
  "id": "example-cli",
  "name": "Example CLI",
  "description": "Example terminal coding agent",
  "command": "example",
  "args": ["--project", "{cwd}"],
  "resumeArgs": ["--resume", "{externalSessionId}"],
  "auth": {
    "methods": ["existing-cli-login"]
  },
  "completion": {
    "strategies": ["stabilization"],
    "busyPatterns": ["working"],
    "idlePatterns": ["^>"],
    "quietMs": 1500
  },
  "capabilities": {
    "terminal": true,
    "resume": true
  }
}
```

Arguments are passed directly to `node-pty`; no command shell performs token
substitution. Supported placeholders are `{cwd}` and `{externalSessionId}`.

Legacy hand-written manifests are trusted local configuration because they may
contain fields beyond the app schema. The apps use the narrower validated CRUD
API described below.

## Adding providers from the apps

Desktop **Settings → Brains → Add brain** and mobile **Settings → Brains**
create the same persistent custom-provider definitions. They are installed in the
live registry immediately and written under `~/.claude-voice-harness/agents/`.
No harness restart is required.

Two connection types are supported:

- **Anthropic-compatible API** — provide an HTTP(S) endpoint, model ID, and API
  key. The harness launches its installed Claude Code CLI with that endpoint and
  injects the key only into that provider's child process. The definition file
  contains no secret.
- **Installed CLI / OAuth login** — provide an executable plus an optional list
  of arguments. The CLI owns its browser, device-code, or other login. Arguments
  are entered one per line and are passed directly to the process without a shell.

Provider IDs and launch fields are validated. Built-ins cannot be overwritten or
removed, and a custom provider cannot be edited or removed while one of its
sessions is live. Provider API responses expose only credential-presence status,
never credential values.

## Programmatic contract

An adapter must have `id`, `name`, and `buildLaunchSpec(context)`. The launch
method returns:

```js
{
  command: 'example',
  args: ['--project', context.cwd],
  env: {},
  externalSessionId: context.externalSessionId || null
}
```

Capabilities default to false except `terminal`. Authentication metadata declares
whether the CLI owns its login, needs a harness-managed key, or needs no login.
Completion metadata controls generic output stabilization. Rich integrations can
also translate native hooks into canonical events sent to `POST /api/agent-events`:

- `agent.started`
- `auth.required`
- `turn.started`
- `prompt.requested`
- `turn.completed`
- `turn.failed`
- `usage.reported`
- `agent.exited`

Every event should carry the per-process `CVH_SESSION_ID` as `correlationId`.
The endpoint is localhost-only.

## Compatibility

`kind` and `claude_session_id` remain populated during migration. New code should
use `provider_id` and `external_session_id`. Provider-specific legacy launch routes
also remain temporarily, while new clients use `POST /api/sessions/:id/launch-provider`.
