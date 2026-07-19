# Voice Code — Vercel edition

A Vercel-hosted, voice-first phone UI for **cloud Claude agent sessions**. This replaces the
Tailscale-served harness setup for cloud use: no PC, no PTY, no tunnel — the app is a static
React bundle plus a handful of serverless functions, and the agent sessions themselves run in
Anthropic's cloud via the **Managed Agents API** (public beta, `managed-agents-2026-04-01`).

```
Phone browser ──HTTPS──► Vercel
  ├─ static SPA (Vite + React)
  └─ /api/* serverless functions
       ├─ api.anthropic.com/v1/{agents,environments,sessions,…}   (Managed Agents)
       ├─ api.anthropic.com/v1/code/sessions                      (claude.ai/code list, read-only)
       └─ api.deepgram.com  (STT batch, temp tokens, Aura-2 TTS)
Phone mic ──WSS (short-lived JWT)──► api.deepgram.com/v1/listen   (live dictation)
```

## What it can and can't do

- **Can:** create/resume/list/delete cloud agent sessions, dictate commands (live streaming
  transcript, review-before-send), hear the agent's reply read aloud, interrupt a running agent,
  keep working after the phone locks (state lives server-side; the app just re-polls).
- **Can't:** drive your existing **claude.ai/code** sessions. There is no public API for sending
  prompts into those; this app lists them read-only (optional) with deep links into the Claude
  app. Voice-driven sessions run on Managed Agents instead — a parallel, API-driven flavor of
  cloud session.
- **Billing note:** Managed Agents bills **API tokens + $0.08/session-hour while running** on your
  Anthropic API account. Unlike the harness, this does *not* ride the Claude Max subscription.

## Deploy

1. **Vercel → New Project → import this repo.**
   - **Root Directory:** `web`
   - **Framework preset:** Vite (auto-detected)
2. **Environment variables** (Project → Settings → Environment Variables):

   | Variable | Required | What it is |
   |---|---|---|
   | `ANTHROPIC_API_KEY` | yes | API key from [platform.claude.com](https://platform.claude.com/settings/keys) |
   | `DEEPGRAM_API_KEY` | yes | Deepgram key (STT + TTS), [console.deepgram.com](https://console.deepgram.com) |
   | `APP_ACCESS_TOKEN` | yes | Any long random string — the app's login token. Generate one: `openssl rand -hex 24` |
   | `ANTHROPIC_AGENT_ID` | recommended | Pin after first run — see below |
   | `ANTHROPIC_ENVIRONMENT_ID` | recommended | Pin after first run — see below |
   | `VOICE_AGENT_MODEL` | no | Model for new agents (default `claude-opus-4-8`) |
   | `CLAUDE_CODE_OAUTH_TOKEN` | no | Enables the read-only claude.ai/code session list (see below) |

3. **Deploy**, open the URL on your phone, enter the access token, and speak. Add to home
   screen for a standalone app feel.

4. **Pin the agent** (recommended): the first request auto-creates a `voice-code` agent and
   `voice-code-env` environment. Visit `/api/setup?token=YOUR_APP_ACCESS_TOKEN` to see their ids,
   then set `ANTHROPIC_AGENT_ID` / `ANTHROPIC_ENVIRONMENT_ID` so cold starts skip the lookup and
   redeploys can never create duplicates.

### Optional: show your claude.ai/code sessions

On the PC where Claude Code is signed in, read the access token from
`~/.claude/.credentials.json` (`claudeAiOauth.accessToken`) and set it as
`CLAUDE_CODE_OAUTH_TOKEN`. The home screen then shows those sessions read-only with links into
claude.ai. Caveat: the token expires and is only refreshed by the CLI on your PC, so expect to
re-paste it periodically; the app shows a "token expired" hint when that happens.

## Local development

```bash
cd web
npm install
vercel dev        # serves SPA + api/ together on :3000 (needs `vercel login` + env vars)
# or: npm run dev # Vite only on :5173, proxying /api to :3000
```

## Design notes

- **Polling, not sockets.** The client polls session events (2.5s while running, slower when
  idle). Phones drop SSE/WebSocket connections on every screen lock, Vercel functions can't host
  WS relays, and the Managed Agents event-history endpoint is the documented catch-up mechanism —
  polling is the robust shape here.
- **Dictation** streams mic audio (webm/opus) from the browser directly to Deepgram using a
  short-lived JWT minted by `/api/stt-token` (the long-lived key never reaches the client). Where
  streaming can't work (iOS records mp4), it falls back to batch `/api/transcribe`. Either way the
  transcript lands in the command box for review — **voice never auto-sends**.
- **Spoken replies:** the agent is prompted to end each turn with a short read-aloud summary;
  the client speaks the tail of the final message via Aura-2 TTS (`/api/tts`), streamed mp3.
- **Auth:** one shared secret (`APP_ACCESS_TOKEN`), constant-time compared, sent as a Bearer
  header (or `?token=` for `<audio>`). All provider keys stay server-side.
