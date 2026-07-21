# Claude Code Voice Harness

> Provider architecture: the PTY/session core now supports pluggable AI CLI
> adapters. Claude Code, Grok, and Codex are built-ins; simple additional CLIs can
> be registered with a local JSON manifest. See [AGENT_ADAPTERS.md](AGENT_ADAPTERS.md).

A voice-first control layer for [Claude Code](https://claude.com/claude-code). Speak (or type) a
command, have it typed into a specific Claude Code session on your PC, and hear the response read
back aloud. It uses your existing Claude Code subscription — the harness only pays for
Deepgram speech-to-text and text-to-speech (ElevenLabs is an optional alternative voice).

**Voice is review-before-send.** Dictation never reaches a Claude session on its own: the transcript
lands in the command box on whichever device you spoke into, you edit it if you like, and only
**Send** types it into the pty.

This repo contains **Phase 1 + 2**: the `harness/` backend and the `desktop/` Electron app. The
mobile app is a later phase.

> **☁️ Hosted (Vercel) edition:** there is now a second, PC-free way to run Voice Code —
> [`web/`](web/README.md) is a Vercel-deployable app that drives **cloud** Claude agent sessions
> through Anthropic's Managed Agents API instead of local PTYs, with the same
> dictate-review-send voice loop (Deepgram STT/TTS). No harness, no Tailscale. Your existing
> claude.ai/code sessions appear read-only there (no public API can send prompts into them);
> voice-driven work runs in Managed Agents cloud sessions, billed to an Anthropic API key.
> It also acts as a device directory: harnesses heartbeat to it (`HUB_URL`/`HUB_TOKEN`), the
> home screen shows each PC as connected/disconnected AnyDesk-style, and tapping a connected
> PC launches straight into that machine's own subscription-billed sessions.
> See [web/README.md](web/README.md) for setup.

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
                                                        ├─ Deepgram (STT + Aura-2 TTS)
                                                        ├─ ElevenLabs (optional TTS)
                                                        └─ SQLite (better-sqlite3)
Phone (Phase 2) ──Tailscale + bearer token──────────►  same API
```

---

## Prerequisites

- **Windows 10/11**, **Node.js 20+** (built/tested on Node 24).
- **Claude Code** installed and signed in (`claude --version` should work). The harness drives your
  existing, already-authenticated `claude` — no re-login, no Anthropic API cost.
- **git** (used to show each session's repo/branch).
- A **Deepgram API key** (STT — get one at [console.deepgram.com](https://console.deepgram.com); new
  accounts include free credit, no card required). The same key does **both** speech-to-text and
  text-to-speech, so this is the only key you need.
- Optionally an **ElevenLabs API key** — only if you want its more expressive voices instead of
  Deepgram's Aura-2.
- Optionally an **OpenAI API key** — used only for Wispr-style dictation cleanup, never for STT.
- **Tailscale** (optional, for phone access later) — already detected automatically if installed.

---

## Install

```bash
git clone <this repo>
cd "voice harness"
npm install        # installs harness + desktop workspaces (builds native node-pty / better-sqlite3)
npm run setup      # builds the phone app, installs the `claude` alias + Stop hook, generates VAPID keys
```

`npm run setup` is what makes the harness actually *work* — it does the four things nothing else
does for you, shows you exactly what it will change, and asks before writing:

| It installs | Why you need it |
|---|---|
| **`mobile-web/dist`** (builds it) | `dist/` is git-ignored, so a fresh clone serves **nothing** at `/m`. |
| **the `claude` PowerShell alias** | Without it a terminal session is a bare, un-attachable process — opening it on the phone can only `--resume` it into a **fork**. See [`hclaude`](#sharing-a-terminal-session-with-your-phone-hclaude). |
| **the Claude Code Stop hook** | Without it the harness never learns a turn finished and waits out the 10-minute output-stabilization timeout. |
| **VAPID keys** | `push.js` reads them from `.env`; nothing else generates them, so push notifications silently never fire. |

It's idempotent (safe to re-run — it upgrades an existing install in place) and reversible with
`npm run setup -- --uninstall`. It backs up `~/.claude/settings.json` before touching it, and
`--yes` skips the prompt for scripted installs.

> After it runs, open a **new** PowerShell window so the profile loads. Don't `. $PROFILE` —
> that's `Microsoft.PowerShell_profile.ps1`, a *different* file that often doesn't exist, so
> dot-sourcing it silently does nothing. The alias lives in `profile.ps1` (all-hosts), which
> auto-loads on every new shell.

---

## First-run setup

### 1. API keys & voice

Launch the desktop app (below). The **setup wizard** walks you through:

1. **API keys** — paste your Deepgram key (that alone is enough: it does both STT and the voice), then
   pick a voice. There is a **Test transcription** button that records 3s from your mic and shows what
   Deepgram heard, a **Batch / Live stream** dictation toggle, and a **Deepgram / ElevenLabs** voice
   toggle with a **Test voice** button (see below). An ElevenLabs key is optional. Keys are stored
   locally in SQLite at `~/.claude-voice-harness/harness.db` and used server-side only — they are
   never sent to your phone.
2. **Tunnel** — Tailscale (auto-detected), local-network-only, or a custom URL. The phone app is
   published via **Tailscale funnel** by default (`tunnel_mode=funnel`), so the same `ts.net` URL
   works on **and** off the tailnet. Funnel is public, so all funnel traffic must present the
   pairing token; direct-localhost (desktop app / Stop hook) and tailnet peers proxied by tailscaled
   stay tokenless — see `server/auth.js` for the three trust tiers.
3. **Claude hook** — copy the Stop-hook snippet (below) into your Claude settings.
4. **Pairing** — a QR code for the future phone app.

> For headless/CLI testing before the wizard, you can instead create `harness/.env`
> (git-ignored) from `harness/.env.example` and put your keys there.

### 2. The Claude Code Stop hook

**`npm run setup` installs this for you** (merging it into `~/.claude/settings.json` without
disturbing your other hooks or settings, after taking a backup). This section is just what it
writes, for reference or if you'd rather do it by hand.

The hook is how the harness learns the instant Claude finishes and can read back the exact
response. It uses `curl.exe` (not the PowerShell `curl` alias) and reads Claude's JSON from stdin:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "curl.exe",
            "args": ["-s", "-X", "POST", "http://127.0.0.1:4620/api/hooks/stop",
                     "-H", "Content-Type: application/json", "-d", "@-"],
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

> ⚠️ Note the **nested `"hooks"` array** — each `Stop` entry wraps its commands in one. A flat
> entry (command directly under `Stop`) parses fine but **never fires**, so turn-completion
> silently falls back to the slow path with no error to tell you why.

Without the hook the harness still works, via output-stabilization detection — but every turn
waits out a timeout instead of completing the moment Claude is done.

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

# 4. batch speech-to-text (needs your Deepgram key configured). Returns {text} —
#    it does NOT run anything; in the apps that text lands in the command box for
#    review and only Send types it into the session.
#    Generate a test clip on Windows without recording:
#    powershell -c "Add-Type -AssemblyName System.Speech; \
#      $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; \
#      $s.SetOutputToWaveFile('test.wav'); \
#      $s.Speak('give me a one line summary of this project'); $s.Dispose()"
curl -F audio=@test.wav http://localhost:4620/api/transcribe
```

Each `/api/command` returns `{ transcript, responseText, summary, audioUrl, interactionId }` and the
audio is cached at `~/.claude-voice-harness/audio/` (replay via `GET /api/tts/:interactionId`).

---

## Using it from your phone (mobile web app)

The harness serves a mobile web app at **`/m`** — no native app needed. It's a **React + Vite**
app (`mobile-web/` workspace) styled to the MDpearls design system.

> **Build step:** the harness serves `mobile-web/dist`, so after any UI change run
> `npm run build --workspace mobile-web`. (The old hand-written version is kept at
> `harness/src/mobile/index.legacy.html`, unserved.)

1. Enable HTTPS so the microphone works (browsers block mic on plain HTTP). The harness self-heals
   this every 60s using `tunnel_mode` (`funnel` by default — public — or `serve` for tailnet-only):
   ```
   tailscale funnel --bg 4620      # public: works on any network
   # or:  tailscale serve --bg 4620   # tailnet-only
   ```
   Both publish `https://<your-machine>.<tailnet>.ts.net/` → the harness with automatic TLS. On the
   tailnet the phone is tokenless; over funnel (public) the app carries the **pairing token** from
   the desktop pairing QR / hash-link.
2. On the phone, open `https://<your-machine>.<tailnet>.ts.net/m` (pair once if using funnel).

The Home screen **is** the connected-sessions list (a **☰ Settings** sheet with Dictation/Rewrite +
theme + the ElevenLabs voice picker, a **💲 spend tally**, and **🕘 History** live in the header). A
floating **＋ New session** button opens a sheet where you can:
- **Start Claude in a folder** — type/speak a path, or **📁 Browse** the PC's folders to pick one
  (works over the funnel now).
- **Start a shell to navigate** — PowerShell in your projects base (`C:\AI` by default, via the
  `mobile_base_dir` config key). `cd`/`ls` by typing or voice, then **🚀 Launch Claude** to hand off.

The list itself is:
- A Claude-Code-app-style, day-bucketed list of every *connected* session
  (harness PTYs marked Phone/This PC, external terminals marked Remote control, cloud ones Cloud),
  each showing a friendly name, Working/Connected status, and folder · repo. Tap to open or resume.
  **Background agents** (which reject `claude --resume`) show a **🤖** tag and open into Claude's
  native **agent view** (`claude agents`) so you can attach or peek — drive it with the ⌨ key pad.
- **Full-screen session view** — a live, colour-rendered terminal (the real Claude Code TUI) that
  **repaints instantly** off the `/ws/term` stream (no 2s poll), with a mic + expanding text field;
  voice input is cleaned up (Wispr-style, gpt-4o-mini) before Claude sees it, and Claude's spoken
  reply auto-plays. The header title tracks the session's **live** Claude title and doubles as a
  **session switcher** (tap it → a left drawer of connected sessions → jump between them without
  going Home). A **⌨ key pad** replaces the composer for driving TUIs (cursor cluster, Esc/Tab/⇧Tab,
  Ctrl-C, Enter, ⌫); a bare Enter confirms an on-screen prompt. **Questions & bash-permission prompts
  are read aloud** via ElevenLabs (once each, honouring the **🔊/🔇** header toggle). Voice mode shows
  the persisted conversation, so it survives navigating away and back.

> A `502` on the phone means either the harness isn't running on the PC, or something repointed the
> Tailscale `serve` root off port 4620. The harness **self-heals** the `serve` mapping every 60s
> (disable with `tailscale_serve=off`); to fix manually: `tailscale serve --bg 4620`.

## Installable app + push notifications (PWA)

The phone app is an **installable PWA** — a manifest + icon + service worker served under `/m`.
Android Chrome offers **Install app** (⋮ menu); it gets a home-screen icon and a standalone window.
On iPhone: **Share → Add to Home Screen** (required there before notifications work, iOS ≥ 16.4).

With **☰ Settings → Notifications → On** (grant the permission once), the device subscribes to
**Web Push**, and you get a phone notification — *even with the app closed* — when a session:
- **needs your input** (a question / bash-permission prompt, including one a background agent hits
  on its own — a screen watcher catches those),
- **finishes** a turn, or
- **fails** (an errored turn).

Notifications are deduped per session, **suppressed while you're looking at the app** (the service
worker skips the toast if a window is focused), and **tapping one deep-links into that session**.
Setup: **VAPID keys** live in `harness/.env` (gitignored — private key never committed); the notifier
(`services/notify.js`) maps session-state transitions (`busy→awaiting_input`/`response_ready`/`idle`)
plus the prompt watcher to pushes. A hard reload does **not** subscribe — you must toggle it On once.

## Dictation: review before send

Voice input is **never** injected into a Claude session automatically. However you dictate, the
transcript lands in the command box on that device, you can edit it, and only **Send** (or **Run**,
in the shell view) types it into the pty. There is no auto-send path — `/api/command` is text-only,
and the two audio endpoints (`/api/transcribe`, `/ws/stt`) return text and nothing else.

Two modes, toggled in desktop **Settings (⚙)** or the phone's **Settings** sheet. The setting is
stored harness-side (`stt_mode`), so both devices share it and it survives restarts.

| Mode | How it feels | What happens |
| --- | --- | --- |
| **Batch** (default) | Tap mic, speak, tap again — text appears a beat later | The whole clip is POSTed to `/api/transcribe` → Deepgram pre-recorded (Nova-3, `smart_format`) |
| **Live stream** | Words appear in the box *as you speak* | Audio frames stream over `/ws/stt` → Deepgram live (Nova-3, `interim_results`); `stt_partial` renders live, `stt_final` settles on release |

Notes:
- **Encoding:** clients send whatever `MediaRecorder` produces cheaply — Opus in a WebM container,
  in 250ms timeslices. The harness relays those bytes as-is and lets Deepgram detect the container,
  so no `encoding`/`sample_rate` params are needed.
- **Resilience:** if the Deepgram stream dies mid-utterance, the client surfaces the error and
  retries that same utterance as a batch upload of the audio it already recorded.
- **Cost:** the Deepgram socket is keep-alived while you speak and closed immediately on mic release,
  so an idle stream is never billed.
- The Deepgram key never leaves the harness — the phone streams audio to *your PC*, which talks to
  Deepgram.
- **Rewrite (Settings → Rewrite):** a **Clean up | Summarise** toggle controls how much a dictated
  instruction is rewritten before it lands in the box. *Clean up* (default) fixes filler/grammar
  near-verbatim; *Summarise* condenses rambling speech into a tight instruction while keeping every
  file name/path/code identifier. Runs through `refine.js` (gpt-4o-mini) and needs an OpenAI key —
  without one it's a no-op (raw ASR). It's review-before-send either way.

## Voice (text-to-speech)

Spoken replies use **ElevenLabs**. The phone's **Settings (☰) → Voice** has a dropdown of your
account's voices (with a **Preview** button); the choice is stored server-side and applies to *new*
replies. Audio is an mp3 in `~/.claude-voice-harness/audio/`, streamed to the phone so playback
starts on the first frames.

Deepgram Aura-2 is still wired in as a backend provider (`services/tts/`) and is the automatic
fallback when no ElevenLabs key is present, but it is **no longer offered in the phone UI**: Aura-2
renders at ~1× realtime (a 6-second reply takes ~6 seconds to synthesize) and its header-less 24 kHz
mp3 won't play progressively in the browser, so it's too slow for hands-free. ElevenLabs streams and
starts in ~1 second.

`interactions.tts_chars` records characters synthesized per reply, so voice spend is auditable — see
the header **💲 spend tally** (`SpendModal`), which estimates ElevenLabs + OpenAI cost calibrated to
the ElevenLabs dashboard rate.

## Two views per session: Terminal & Chat

Each session has a **Terminal | Chat** toggle (desktop tabs and the phone session
view). **Terminal** is the raw xterm — the real Claude Code TUI. **Chat** is a
Claude-app-style conversation: markdown-formatted bubbles with a text box that
sends to the live session.

- On desktop the terminal stays mounted under the chat overlay, so the PTY and
  scrollback survive toggling back and forth.
- **Terminal** shows the full scrollback (up to ~4000 lines), like a real terminal.
- The reply appears formatted as the turn completes.

The chat input is a **"code container"** (like the Claude Code app): an auto-grow
text field with a control row underneath —
- a **mode pill** that cycles the session's permission mode **Ask → Auto-accept →
  Plan → Bypass** (it sends Shift+Tab to the live session and reads the mode back
  off the TUI footer),
- a **mic** (dictate into the field), a **replay** button (speaks the last reply
  again via TTS), a **"/"** button that opens a scrollable **saved-prompts** picker
  (insert / save-current / delete; stored globally in the harness DB),
- an **attach** button (desktop native file picker; the phone uploads and inserts
  the stored path — Claude reads local paths), and
- a context **send / stop** button (Stop sends Esc to interrupt Claude mid-turn).

> **How the chat log is built.** Claude Code writes each session's transcript
> `.jsonl` to disk as it runs, so **Chat reads that transcript live** — the whole
> conversation, every turn, updating in place (even a session you're driving from
> another device, no mirror needed; `getLiveConversation` returns it with
> `full:true`). When no transcript resolves for the session's Claude uuid it falls
> back to the harness's own recorded log: **assistant** turns from the Stop hook,
> **user** turns from the chat box / voice command. Interactive moments (permission
> prompts, plan approval, slash-menus) render in the Terminal view.

## Session Archive & Resume

Every Claude Code session is already written to disk at
`~/.claude/projects/<slugified-cwd>/<session-uuid>.jsonl` (the filename **is** the
session id). The harness indexes those transcripts — across **all** your projects —
into a local SQLite **FTS5** full-text index over prompts + responses, refreshed
incrementally by file mtime (a rescan of ~125 sessions is a few milliseconds). No
logging is added; it reads what Claude Code already records.

- **Desktop** — the **🕘 History** button opens a search drawer: type to full-text
  search, filter by project, and each result shows title · project · date · prompt
  count · skills/MCP used · a highlighted snippet. **Resume** reopens that
  conversation as a live terminal tab (`claude --resume` in its original folder).
- **Phone** — the **🕘 History** entry on Home gives the same searchable list;
  **Resume** drops you straight into the live session view.
- Sessions that are **currently open** are flagged `live` in the archive (the
  harness records each session's Claude UUID from the Stop hook), so current and
  archived sessions cross-reference.

> Resume needs the session's **original working directory** to still exist —
> Claude resolves `--resume <id>` per-project, so a moved/deleted folder shows
> "Folder gone" instead of a Resume button.

## Sharing a terminal session with your phone (`hclaude`)

A Claude session you start in a **bare terminal** is a single-owner TUI — no other device can attach
to it, so opening it on the phone could only `--resume` it into a *second, forked* process.
`harness/bin/hclaude.mjs` fixes that: it asks the harness to **spawn** the session (so the harness
owns the pty) and pipes your real terminal to it over `/ws/term`. The same session is then drivable
from the terminal, the phone, and the desktop app — no forks.

- **`claude`** (aliased in your PowerShell `$PROFILE`) — a plain launch starts a harness-owned,
  shareable session; every other invocation (`-p`, `--resume`, `--version`, subcommands) passes
  through to the real CLI. Harness offline → falls back to the real CLI so you're never blocked.
- **`Ctrl-\`** detaches, leaving the session running for the phone; **`claude --attach`** reattaches
  a terminal to a running harness session (or `--attach <id>`).
- The alias needs PowerShell's execution policy to allow local scripts
  (`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` if a new terminal shows nothing on load).

## Keeping the harness running

For the phone to work whenever the PC is on, the harness must run independently. This session set up
a **restart-loop launcher** (`start-harness.vbs` + `harness-run.cmd` at the repo root, gitignored)
registered in the Windows **Startup folder** (`ClaudeVoiceHarness.vbs`) — it auto-starts at logon and
relaunches node within ~3s if it ever exits. Remove it by deleting `ClaudeVoiceHarness.vbs` from the
Startup folder. Alternatively, launch the desktop app (it manages the harness in the tray).

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
- **Phone access** is the React web app at `/m` over Tailscale (above) — no native app needed. The
  Stop hook makes completion detection instant; without it the harness falls back to output
  stabilization.
- **Config keys of note:** `dictation_cleanup` (on/off), `cleanup_model`, `mobile_base_dir`,
  `tailscale_serve` (self-heal on/off), `tunnel_mode` (`serve`\|`funnel`), `tunnel_url` (pairing-QR
  base URL), `tts_playback_target` (`desktop`\|`phone`\|`both`), `rate_<unit_type>` (spend-tally
  rate overrides).

---

## API summary

| Route | Method | Notes |
|---|---|---|
| `/api/health` | GET | `{ok, version}` |
| `/api/sessions` | GET/POST | list / spawn (`{cwd,label,kind,forceNew}`; `forceNew:true` allows parallel sessions for the same agent and folder) |
| `/api/sessions/recent` | GET | connected sessions for the phone home screen — harness PTYs + live Claude sessions from Claude's own API (`api.anthropic.com/v1/code/sessions`); disconnected ones filtered, **deduped to one row per conversation** (by transcript uuid; prefers the live harness PTY so a tap opens in place, not a `--resume` fork) |
| `/api/sessions/:id` | GET | one session (includes `muted`) |
| `/api/sessions/:id/history` | GET | interactions |
| `/api/sessions/:id/screen` | GET | rendered terminal (`?full=1&color=1` for colored HTML; `full` returns up to ~4000 lines of scrollback) |
| `/api/sessions/:id/mute` | POST | silence phone push for one session `{muted}` (badge still shows; persisted) |
| `/api/sessions/:id/input` | POST | raw shell input `{text}` |
| `/api/sessions/:id/launch-claude` | POST | run `claude` in a shell session |
| `/api/sessions/:id/messages` | GET | Chat-view conversation log — prefers the live on-disk transcript (whole conversation, `full:true`); else the harness table (`?after=<id>` incremental) |
| `/api/sessions/:id/chat` | POST | Chat-view send: record `{text}` + submit it to the live session |
| `/api/sessions/:id/key` | POST | Composer control key `{key}` — `cycle-mode` (Shift+Tab) or `stop` (Esc) |
| `/api/sessions/:id/mode` | GET | Current permission mode read off the TUI (`ask`\|`auto`\|`plan`\|`bypass`) |
| `/api/sessions/:id/attach` | POST | Upload a file → returns a local `{path}` to drop into the message |
| `/api/prompts` | GET/POST | Saved-prompt snippets (list / create) for the "/" picker |
| `/api/prompts/:id` | DELETE | Delete a saved prompt |
| `/api/sessions/:id/kill` `/rename` | POST | manage |
| `/api/fs/list` | GET | list subdirs/drives for the folder picker — behind standard auth (works over the funnel with the pairing token); returns directory names only |
| `/api/archive` | GET | search past sessions (`?q=` FTS, `?project=` filter; recent when no `q`) |
| `/api/archive/projects` | GET | distinct projects (filter facet) |
| `/api/archive/:uuid` | GET | one archived session + first prompts (preview) |
| `/api/archive/:uuid/resume` | POST | reopen `claude --resume <uuid>` in its original cwd → new live session |
| `/api/archive/reindex` | POST | force a rescan of the transcript corpus |
| `/api/command` | POST | JSON `{text,sessionId}` — **text only**; audio never reaches a pty in one hop |
| `/api/transcribe` | POST | multipart `audio` → `{text}` (batch STT; text goes to the command box) |
| `/api/settings` | GET · POST | non-secret prefs (`stt_mode`, `tts_provider`, voice ids) — phone-reachable; **API keys can be neither read nor written here** |
| `/api/settings/voices` | GET | phone-safe ElevenLabs voice list (names/ids only) for the Settings voice dropdown |
| `/api/tts/:interactionId` | GET | replay cached mp3 |
| `/api/tts/say` | GET/POST | speak arbitrary `{text}` → mp3 (also used to read prompts aloud) |
| `/api/sessions/:id/prompt` · `/select` | GET · POST | current interactive picker off the screen · answer option `{index}` |
| `/api/sessions/agent-view` | POST | open Claude's `claude agents` view in a pty (`{cwd,label}`) to attach/peek a background agent |
| `/api/push/vapid` | GET | public VAPID key + enabled flag + subscribed-device count |
| `/api/push/subscribe` · `/unsubscribe` | POST | register / drop this device's Web Push subscription |
| `/api/push/test` | POST | send a test notification to all subscribed devices |
| `/api/hooks/stop` | POST | Claude Stop hook (localhost only) |
| `/api/config/state` · `/api/config` | GET · POST | wizard config (localhost only) |
| `/api/voices?provider=` · `/api/voices/preview` | GET · POST | voices for a TTS provider + sample (localhost only) |
| `/api/tunnel/tailscale` | GET | Tailscale detection (localhost only) |
| `/api/pairing/payload` · `/api/pairing/regen` | GET · POST | QR payload / new token (localhost only) |
| `/ws` | WS | live `sessions` / `state` / `response` / `log` events |
| `/ws/stt` | WS | live dictation: send audio frames → `stt_partial` / `stt_final` / `error` |
```
