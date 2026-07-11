# Claude Code Voice Harness

A voice-first control layer for [Claude Code](https://claude.com/claude-code). Speak (or type) a
command, have it typed into a specific Claude Code session on your PC, and hear the response read
back via ElevenLabs. It uses your existing Claude Code subscription — the harness only pays for
Whisper speech-to-text and ElevenLabs text-to-speech.

This repo contains **Phase 1 + 2**: the `harness/` backend and the `desktop/` Electron app. The
mobile app is a later phase.

---

## Architecture (Windows-native)

The original plan targeted tmux, but tmux doesn't run natively on Windows. This build runs entirely
on Windows using **node-pty (ConPTY)** instead:

- The **harness** owns each Claude Code session — it spawns `claude` inside a pseudo-terminal
  (ConPTY), types commands into it (the `send-keys` equivalent), and reads the rendered screen back
  through a headless terminal emulator (the `capture-pane` equivalent). No shell is involved, so
  voice transcripts can't cause shell injection.
- Because sessions are spawned by the harness, you **start each session from the desktop app**
  (pick a folder → it launches `claude` there), rather than attaching to terminals you opened
  yourself.
- **Completion detection** races two signals: the Claude Code **Stop hook** (reliable — carries the
  exact response text) and an **output-stabilization** fallback (works without the hook, slightly
  slower).

```
Desktop app (Electron+React)  ──localhost REST+WS──►  Harness (Node, :4620)
                                                        ├─ node-pty → claude sessions
                                                        ├─ Whisper (STT)  · ElevenLabs (TTS)
                                                        └─ SQLite (better-sqlite3)
Phone (Phase 2) ──Tailscale + bearer token──────────►  same API
```

---

## Prerequisites

- **Windows 10/11**, **Node.js 20+** (built/tested on Node 24).
- **Claude Code** installed and signed in (`claude --version` should work). The harness drives your
  existing, already-authenticated `claude` — no re-login, no Anthropic API cost.
- **git** (used to show each session's repo/branch).
- An **OpenAI API key** (Whisper STT) and an **ElevenLabs API key** (TTS).
- **Tailscale** (optional, for phone access later) — already detected automatically if installed.

---

## Install

```bash
git clone <this repo>
cd "voice harness"
npm install        # installs harness + desktop workspaces (builds native node-pty / better-sqlite3)
```

---

## First-run setup

### 1. API keys & voice

Launch the desktop app (below). The **setup wizard** walks you through:

1. **API keys** — paste your OpenAI + ElevenLabs keys and pick a voice (with a live preview button).
   Keys are stored locally in SQLite at `~/.claude-voice-harness/harness.db` and used server-side
   only — they are never sent to your phone.
2. **Tunnel** — Tailscale (auto-detected), local-network-only, or a custom URL.
3. **Claude hook** — copy the Stop-hook snippet (below) into your Claude settings.
4. **Pairing** — a QR code for the future phone app.

> For headless/CLI testing before the wizard, you can instead create `harness/.env`
> (git-ignored) from `harness/.env.example` and put your keys there.

### 2. Add the Claude Code Stop hook (recommended)

Add this to `~/.claude/settings.json` so the harness learns the instant Claude finishes and can read
back the exact response. It uses `curl.exe` (not the PowerShell `curl` alias) and reads Claude's JSON
from stdin:

```json
{
  "hooks": {
    "Stop": [
      {
        "type": "command",
        "command": "curl.exe",
        "args": ["-s", "-X", "POST", "http://127.0.0.1:4620/api/hooks/stop",
                 "-H", "Content-Type: application/json", "-d", "@-"],
        "timeout": 5
      }
    ]
  }
}
```

Without the hook, the harness still works via output-stabilization detection — just a little slower.

---

## Launch

**Development** (Vite dev server + Electron with hot reload):

```bash
npm run dev --workspace desktop
```

**Built** (build the renderer, then run Electron):

```bash
npm run start --workspace desktop
```

The desktop app boots the harness automatically (as a system-Node child on `localhost:4620`) and
lives in the system tray — closing the window keeps the harness running; quit from the tray.

You can also run the harness alone:

```bash
npm start --workspace harness
```

Then in the app: **+ New session** → pick a project folder → Claude Code launches there → type a
command and hear the spoken summary. `tts_playback_target` (`desktop` | `phone` | `both`) controls
where audio plays.

---

## Testing the voice pipeline without a phone (plan §8)

The harness listens on `:4620`. Localhost requests bypass auth; remote requests need
`Authorization: Bearer <pairing_token>`.

```bash
# 1. health
curl http://localhost:4620/api/health

# 2. start a session in a project folder, note the returned "id"
curl -X POST http://localhost:4620/api/sessions \
     -H "Content-Type: application/json" \
     -d '{"cwd":"C:/path/to/project","label":"demo"}'

# 3. typed command (no audio needed) — round-trips to spoken audio
curl -X POST http://localhost:4620/api/command \
     -H "Content-Type: application/json" \
     -d '{"sessionId":1,"text":"give me a one line summary of this project"}'

# 4. full voice pipeline with a recorded clip (needs your OpenAI key configured)
#    Generate a test clip on Windows without recording:
#    powershell -c "Add-Type -AssemblyName System.Speech; \
#      $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; \
#      $s.SetOutputToWaveFile('test.wav'); \
#      $s.Speak('give me a one line summary of this project'); $s.Dispose()"
curl -F audio=@test.wav -F sessionId=1 http://localhost:4620/api/command
```

Each `/api/command` returns `{ transcript, responseText, summary, audioUrl, interactionId }` and the
audio is cached at `~/.claude-voice-harness/audio/` (replay via `GET /api/tts/:interactionId`).

---

## Using it from your phone (mobile web client)

The harness serves a mobile page at **`/m`** — no native app needed. Open it in your
phone's browser over Tailscale.

1. Install Tailscale on the phone (same tailnet as the PC).
2. Enable HTTPS so the microphone works (browsers block mic on plain HTTP):
   ```
   tailscale serve --bg 4620
   ```
   This publishes `https://<your-machine>.<tailnet>.ts.net/` → the harness (tailnet-private,
   automatic TLS). Because it proxies as localhost, no token is needed on that URL.
3. On the phone, open `https://<your-machine>.<tailnet>.ts.net/m`.

The mobile page lets you, entirely from the phone:
- **Start Claude in a folder** — type/speak a path, Claude launches there.
- **Start a shell to navigate** — opens PowerShell in your projects base (`C:\AI` by default,
  set via the `mobile_base_dir` config key). `cd`/`ls` by typing or voice, tap **🔊 Where am I**
  to hear the current directory, then **🚀 Launch Claude** to hand off — after which you send
  commands (and slash-commands) by voice or text and hear the spoken summary.
- **Resume** any live session.

> A `502` on the phone means the harness isn't running on the PC (the tunnel has nothing to
> forward to) — start the desktop app or the harness. If the tunnel mapping drifts, re-run
> `tailscale serve --bg 4620`.

## Data & config locations

- Database: `~/.claude-voice-harness/harness.db`
- Audio cache: `~/.claude-voice-harness/audio/`
- Harness stdout log: `~/.claude-voice-harness/harness.out.log`

---

## Known items / notes

- **Harness-side speaker playback** uses PowerShell's MediaPlayer. If a spoken summary doesn't come
  out of the PC speakers, tell us — there's a more robust WAV/`SoundPlayer` path to switch to.
- **Electron** has an open `npm audit` advisory set (mostly macOS/edge-case); bump to the latest
  Electron patch before any wider distribution.
- **Mobile** (PhoneWhisper fork) is Phase 2 and not in this repo yet.

---

## API summary

| Route | Method | Notes |
|---|---|---|
| `/api/health` | GET | `{ok, version}` |
| `/api/sessions` | GET/POST | list / spawn (`{cwd,label}`) |
| `/api/sessions/:id` | GET | one session |
| `/api/sessions/:id/history` | GET | interactions |
| `/api/sessions/:id/kill` `/rename` | POST | manage |
| `/api/command` | POST | JSON `{text,sessionId}` or multipart `audio`+`sessionId` |
| `/api/transcribe` | POST | multipart `audio` → `{text}` (STT only) |
| `/api/tts/:interactionId` | GET | replay cached mp3 |
| `/api/hooks/stop` | POST | Claude Stop hook (localhost only) |
| `/api/config/state` · `/api/config` | GET · POST | wizard config (localhost only) |
| `/api/voices` · `/api/voices/preview` | GET · POST | ElevenLabs voices (localhost only) |
| `/api/tunnel/tailscale` | GET | Tailscale detection (localhost only) |
| `/api/pairing/payload` · `/api/pairing/regen` | GET · POST | QR payload / new token (localhost only) |
| `/ws` | WS | live `sessions` / `state` / `response` / `log` events |
```
