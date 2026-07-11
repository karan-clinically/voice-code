# Claude Code Voice Harness — Full Implementation Plan

A voice-first control layer for Claude Code: speak on your phone, have the command typed into a specific tmux-hosted Claude Code session on your home PC, and hear the response read back via ElevenLabs TTS. Uses your existing Claude Code Max subscription (no Anthropic API costs) — the harness only pays for Whisper STT and ElevenLabs TTS.

---

## 0. Important architecture correction

Claude Code is a CLI tool that runs in a terminal (`claude` command). It is not browser-only. This is good news: it runs natively inside tmux panes, which makes automation far more reliable than screen-scraping a browser.

Completion detection strategy, in priority order:

1. **Claude Code Hooks** — primary, most reliable. Claude Code supports lifecycle hooks configured in `.claude/settings.json`. The Stop hook fires when Claude finishes responding. Configure it to:

   ```bash
   curl -X POST http://localhost:4620/api/hooks/stop -d '{"session":"$TMUX_PANE"}'
   ```

   This gives a deterministic “Claude is done” signal with zero polling.

2. **Output stabilization** — fallback. Poll `tmux capture-pane` every 500ms. If the buffer is unchanged for 3 consecutive polls **and** the last non-empty line matches the Claude Code idle prompt pattern, consider the response complete.

3. **Do not rely on asking Claude to emit custom delimiters** — unreliable, as established.

---

## 1. System overview

```text
┌─────────────┐   audio (m4a/wav)    ┌──────────────────────────────┐
│ Android app │ ───────────────────► │  Harness (Node.js, port 4620)│
│ (PhoneWhisper│ ◄─────────────────── │  on home PC                  │
│  fork)      │   TTS audio + text   │                              │
└─────────────┘   via Tailscale      │  ├─ Whisper API (STT)         │
                                     │  ├─ tmux controller           │
       ▲                             │  ├─ Claude Code hooks listener│
       │ QR pairing                  │  ├─ ElevenLabs (TTS)          │
       │                             │  └─ SQLite (better-sqlite3)   │
┌─────────────┐                      └──────────────┬───────────────┘
│ Electron    │  IPC / localhost REST+WS            │ tmux send-keys /
│ desktop app │ ◄───────────────────────────────────┤ capture-pane
│ (React UI)  │                                     ▼
└─────────────┘                      ┌──────────────────────────────┐
                                     │ tmux server                  │
                                     │  ├─ session: clinically      │
                                     │  ├─ session: clinibis        │
                                     │  └─ ... (Claude Code in each)│
                                     └──────────────────────────────┘
```

Three deliverables, built in this order:

1. `harness/` — Node.js backend; the core, everything depends on it.
2. `desktop/` — Electron + React launcher, config wizard, session dashboard, QR pairing.
3. `mobile/` — PhoneWhisper fork; Phase 2, build after 1 and 2 work end-to-end tested via curl.

---

## 2. Repository layout

```text
claude-voice-harness/
├── package.json                  # workspace root (npm workspaces)
├── harness/
│   ├── package.json
│   ├── src/
│   │   ├── index.js              # entry: starts HTTP+WS server, loads config
│   │   ├── config.js             # load/save config via SQLite, first-run detection
│   │   ├── db.js                 # better-sqlite3 init + migrations
│   │   ├── server/
│   │   │   ├── http.js           # Express app, routes
│   │   │   ├── ws.js             # WebSocket server (live session events)
│   │   │   └── routes/
│   │   │       ├── transcribe.js # POST /api/transcribe (audio in → text out)
│   │   │       ├── command.js    # POST /api/command (text/audio → tmux → TTS)
│   │   │       ├── sessions.js   # GET /api/sessions, GET /api/sessions/:id/history
│   │   │       ├── hooks.js      # POST /api/hooks/stop (Claude Code Stop hook)
│   │   │       ├── pairing.js    # GET /api/pairing/payload (for QR generation)
│   │   │       └── tts.js        # GET /api/tts/:responseId (audio replay)
│   │   ├── services/
│   │   │   ├── whisper.js        # OpenAI Whisper API client
│   │   │   ├── elevenlabs.js     # ElevenLabs TTS client (stream to file + serve)
│   │   │   ├── tmux.js           # list/inspect/send-keys/capture-pane wrapper
│   │   │   ├── claudeCode.js     # completion detection, response extraction
│   │   │   └── audio.js          # local playback (desktop speaker) via ffplay/afplay
│   │   └── util/
│   │       ├── logger.js         # pino logger → SQLite log table + stdout
│   │       └── ansi.js           # strip ANSI escape codes from tmux output
│   └── .env.example
├── desktop/
│   ├── package.json
│   ├── electron/
│   │   ├── main.js               # Electron main: spawn harness, tray icon, windows
│   │   ├── preload.js            # contextBridge IPC surface
│   │   └── harnessManager.js     # child_process fork of harness, lifecycle mgmt
│   ├── src/                      # React (Vite)
│   │   ├── App.jsx               # router: Wizard vs Dashboard based on config state
│   │   ├── wizard/
│   │   │   ├── Wizard.jsx        # multi-step config wizard
│   │   │   ├── StepApiKeys.jsx   # OpenAI + ElevenLabs keys, voice picker
│   │   │   ├── StepTunnel.jsx    # tunnel provider (Tailscale default, extensible)
│   │   │   ├── StepTmux.jsx      # verify tmux installed, pick default session
│   │   │   └── StepPairing.jsx   # QR code display (qrcode.react)
│   │   ├── dashboard/
│   │   │   ├── Dashboard.jsx     # session list + status
│   │   │   ├── SessionCard.jsx   # name, cwd, git repo/branch, state badge
│   │   │   ├── SessionDetail.jsx # history, replay TTS, send text command
│   │   │   └── LiveLog.jsx       # tail of harness activity via WS
│   │   └── lib/api.js            # fetch/WS client to harness on localhost:4620
│   └── vite.config.js
├── mobile/                       # Phase 2 — PhoneWhisper fork notes (see §9)
│   └── FORK_NOTES.md
└── PLAN.md                       # this file
```

---

## 3. Config & database (SQLite via better-sqlite3)

DB file: `~/.claude-voice-harness/harness.db`.

Audio cache: `~/.claude-voice-harness/audio/`.

```sql
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,          -- e.g. 'openai_api_key','elevenlabs_api_key',
  value TEXT NOT NULL            -- 'elevenlabs_voice_id','tunnel_provider',
);                               -- 'tunnel_url','pairing_token','tts_playback_target'

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tmux_session TEXT NOT NULL,
  tmux_pane TEXT NOT NULL,       -- e.g. '%3' (stable pane id)
  label TEXT,                    -- user-friendly name
  cwd TEXT,
  git_repo TEXT,
  git_branch TEXT,
  state TEXT DEFAULT 'idle',     -- idle | busy | response_ready | dead
  last_seen_at TEXT,
  UNIQUE(tmux_session, tmux_pane)
);

CREATE TABLE IF NOT EXISTS interactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER REFERENCES sessions(id),
  direction TEXT NOT NULL,       -- 'user' | 'claude'
  text TEXT NOT NULL,
  summary TEXT,                  -- spoken summary (for claude direction)
  audio_path TEXT,               -- cached TTS mp3
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT,
  module TEXT,
  message TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
```

Security notes:

- API keys stored in SQLite are plaintext on disk. Acceptable for personal use on your own PC; encrypt with `electron safeStorage` later if desired.
- All phone → harness requests must include header `Authorization: Bearer <pairing_token>` — random 32-byte token generated by wizard and embedded in QR. Reject anything else. This matters because Tailscale Funnel, if ever used, is public. Plain Tailscale is private to your tailnet, but the token is still cheap insurance.

---

## 4. Harness backend — module specs

### 4.1 `services/tmux.js`

Wraps `child_process.execFile('tmux', [...])`. No shell interpolation — always argument arrays.

```js
listPanes()
// tmux list-panes -a -F '#{session_name}|#{pane_id}|#{pane_current_path}|#{pane_current_command}'
// → [{ session, paneId, cwd, command }]

getGitInfo(cwd)
// execFile git -C cwd rev-parse --show-toplevel  → repo path (basename = repo name)
// execFile git -C cwd branch --show-current     → branch
// Both wrapped in try/catch; return nulls if not a repo.

sendText(paneId, text)
// tmux send-keys -t <paneId> -l -- <text>   (literal, avoids key-name interpretation)
// then: tmux send-keys -t <paneId> Enter

capturePane(paneId, lines = 2000)
// tmux capture-pane -t <paneId> -p -S -<lines>
// → raw text (pass through util/ansi.strip)

paneExists(paneId)
// tmux list-panes -a, check membership
```

Session discovery loop: every 5s, `listPanes()`, filter panes whose `pane_current_command` is `claude` or `node` (Claude Code shows as `claude`), upsert into `sessions` table with cwd + git info, mark missing panes dead. Broadcast changes over WS.

### 4.2 `services/claudeCode.js` — completion detection

```js
async function executeCommand(sessionRow, text) {
  markState(sessionRow.id, 'busy');
  const before = await tmux.capturePane(sessionRow.tmux_pane);
  await tmux.sendText(sessionRow.tmux_pane, text);
  const raw = await waitForCompletion(sessionRow);      // see below
  const response = extractNewOutput(before, raw);       // diff old vs new buffer
  markState(sessionRow.id, 'response_ready');
  return response;
}

async function waitForCompletion(sessionRow, timeoutMs = 10 * 60 * 1000) {
  // Race two promises:
  // A) hookSignal: a per-pane EventEmitter that routes/hooks.js fires when
  //    Claude Code's Stop hook POSTs /api/hooks/stop with matching pane/cwd.
  // B) stabilization fallback: poll capture-pane every 1s; resolve when buffer
  //    unchanged for 4 consecutive polls AND does not end with a spinner/
  //    "esc to interrupt" indicator line.
  // Whichever resolves first wins. Reject on timeout.
}

function extractNewOutput(beforeBuf, afterBuf) {
  // Find longest common prefix of before/after line arrays; new output = the
  // suffix of afterBuf. Strip the echoed user command and the trailing input
  // prompt box. Return cleaned text.
}
```

Claude Code hook setup, documented in README and shown by the wizard:

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "curl -s -X POST http://localhost:4620/api/hooks/stop -H 'Content-Type: application/json' -d \"{\\\"cwd\\\": \\\"$(pwd)\\\", \\\"pane\\\": \\\"$TMUX_PANE\\\"}\""
      }]
    }]
  }
}
```

The hooks route matches on pane (preferred) or falls back to cwd → session lookup.

Verify against current Claude Code hooks docs during implementation (`/hooks` command inside Claude Code lists them; schema may have evolved).

### 4.3 `services/whisper.js`

- `transcribe(audioBuffer, filename)` → `POST https://api.openai.com/v1/audio/transcriptions`, model `whisper-1` (or `gpt-4o-mini-transcribe` — check current pricing/quality; both fine), multipart form. Return text.
- 25MB limit per file; phone clips will be far under this.

### 4.4 `services/elevenlabs.js`

- `synthesize(text, voiceId)` → `POST https://api.elevenlabs.io/v1/text-to-speech/{voiceId}` with `model_id: "eleven_turbo_v2_5"` (low latency), stream response to `~/.claude-voice-harness/audio/<uuid>.mp3`, return path.
- Summarize before speaking. Claude Code responses are long and full of code. Never TTS raw output. Summarization strategy for v1 (zero extra API cost): rule-based — strip code blocks (replace with “...a code block of N lines...”), strip file path lists, take first + last paragraphs, cap at ~600 chars. A `summarizeForSpeech(text)` util in `claudeCode.js`. Later option: pipe through a cheap LLM, but that reintroduces API cost — keep rule-based for v1.

### 4.5 `services/audio.js`

- `playLocal(path)` — desktop speaker playback: try `ffplay -nodisp -autoexit`, fall back to `paplay`/`aplay` on Linux or `powershell -c (New-Object Media.SoundPlayer ...).PlaySync()` on Windows; convert to WAV or use `ffplay` from bundled `ffmpeg-static`.
- Use the `sound-play` npm package or ship `ffmpeg-static` + `ffplay` for simplicity.
- Config `tts_playback_target`: `phone | desktop | both`.

### 4.6 HTTP API — Express, port 4620, bind 0.0.0.0

All `/api/*` routes except `/api/hooks/stop` (localhost-only check instead) require `Authorization: Bearer <pairing_token>` **or** originate from localhost (desktop app).

| Route | Method | Body / Returns |
|---|---:|---|
| `/api/health` | GET | `{ok, version}` |
| `/api/sessions` | GET | List of sessions with state, cwd, git info |
| `/api/sessions/:id/select` | POST | Mark as phone’s active session, per-device via `X-Device-Id` header |
| `/api/transcribe` | POST multipart audio | `{text}` — STT only, PhoneWhisper “type into field” mode |
| `/api/command` | POST multipart audio or JSON `{text}`, field `sessionId` | Pipeline: STT → tmux → wait → summarize → TTS. Returns `{transcript, responseText, summary, audioUrl, interactionId}`. Long-poll OK; can take minutes. Also emit WS events so clients do not depend on the held connection. |
| `/api/tts/:interactionId` | GET | `audio/mpeg` file replay |
| `/api/hooks/stop` | POST | Body `{cwd, pane}`. Fires internal completion event; returns 204. |
| `/api/pairing/payload` | GET | Localhost only. JSON the QR encodes; see §6. |

### 4.7 WebSocket events (`/ws`, same auth)

Server → client JSON messages:

- `{type:'sessions', sessions:[...]}` — on any change.
- `{type:'state', sessionId, state}` — `idle | busy | response_ready`.
- `{type:'response', sessionId, interactionId, summary, audioUrl}`.
- `{type:'log', level, message}` — for desktop LiveLog.

---

## 5. Desktop app — Electron + React

### 5.1 Electron main (`electron/main.js`)

1. On launch: check `harness.db` config completeness → decide Wizard vs Dashboard route; pass via query param to renderer.
2. `harnessManager.js`: `child_process.fork('harness/src/index.js')`; restart on crash (max 3 retries); kill on app quit. Pipe harness stdout to a log file.
3. Tray icon with Show/Quit. Closing window hides to tray; harness keeps running.
4. Optionally ensure a tmux server is running: `tmux start-server`. Do **not** auto-create Claude Code sessions in v1 — user manages their own tmux sessions; the dashboard just discovers them. A “New session” button can run `tmux new-session -d -s <name> -c <folder> claude` as a nice-to-have in step 14.

### 5.2 Wizard steps — React

1. **API keys** — OpenAI key, ElevenLabs key, voice picker. Fetch `GET /v1/voices` from ElevenLabs to populate dropdown, with a “test voice” button that synthesizes “Hello, harness configured” and plays it.
2. **Tunnel** — provider select: Tailscale (recommended) | Local network only | Custom URL. For Tailscale: run `tailscale status --json` to detect install + get the machine’s tailnet IP/MagicDNS name; show install instructions if missing. Store resulting base URL, e.g. `http://mypc.tailnet-name.ts.net:4620`. Architecture note: `tunnelProviders/` is a simple interface `{detect(), getBaseUrl()}` so ngrok/Cloudflare can be added later.
3. **tmux + Claude Code** — verify `tmux -V` and `claude --version`; show the hooks JSON snippet (§4.2) with a “copy” button and a “verify hook” test (waits for a POST after user runs a trivial Claude Code prompt).
4. **Pairing** — generate `pairing_token` (`crypto.randomBytes(32).hex`), render QR of the pairing payload (§6), plus “regenerate token” button.

### 5.3 Dashboard

- Grid of SessionCards: label (editable), tmux session name, cwd basename, git repo/branch, state badge (idle=grey, busy=amber pulse, response ready=green), last interaction time.
- Click card → SessionDetail: interaction history (user/claude bubbles), play button per Claude response (streams `/api/tts/:id`), text input to send a typed command (same pipeline minus STT).
- LiveLog panel (collapsible) fed by WS log events.
- Settings gear → re-open wizard steps individually.

---

## 6. QR pairing payload

QR encodes JSON rendered with `qrcode.react`:

```json
{
  "v": 1,
  "name": "Home PC",
  "baseUrl": "http://mypc.tailnet.ts.net:4620",
  "token": "<pairing_token>",
  "apk": "https://github.com/<you>/phone-whisper-fork/releases/latest"
}
```

Phone app flow: scan → if app installed, deep-link `cvh://pair?...` consumes it and stores `baseUrl` + `token`; if not installed, the QR’s APK URL is human-readable so any QR scanner gets them to the download. Deep link registration is part of the fork work.

---

## 7. Build order for Claude Code — execute sequentially

> Each step ends with a verification command. Do not proceed until it passes.

1. **Scaffold workspace.** Root `package.json` with npm workspaces `["harness","desktop"]`. `git init`.  
   ✔ `npm install` succeeds.
2. **DB layer.** `harness/src/db.js` + migrations (§3).  
   ✔ Node script inserts/reads a config row.
3. **tmux service.** Implement §4.1 + ANSI stripper.  
   ✔ Manual test script lists panes of a real tmux session and captures output.
4. **Session discovery loop.** Upsert sessions, git info, dead detection.  
   ✔ Start/stop a tmux session running Claude; watch table update.
5. **HTTP server + auth middleware + `/api/health` + `/api/sessions`.**  
   ✔ `curl` both with/without token.
6. **Whisper service + `/api/transcribe`.**  
   ✔ `curl` a test WAV file → transcript JSON.
7. **Completion detection + hooks route (§4.2).** Implement race of hook signal vs stabilization.  
   ✔ End-to-end: `curl /api/command` with `{text:"list files in this directory"}` against a live Claude Code tmux session; receive response text.
8. **Summarizer + ElevenLabs service + `/api/tts/:id` + local playback.**  
   ✔ The same `curl` now returns `audioUrl`; file plays.
9. **WebSocket server + events.**  
   ✔ `wscat` shows state transitions during a command.
10. **Electron shell + harnessManager + tray.**  
    ✔ Launching desktop app boots harness (health check green).
11. **Wizard** — 4 steps, writes config, QR render.  
    ✔ Fresh DB → wizard → dashboard.
12. **Dashboard** — cards, detail, history, replay, typed commands, live log.  
    ✔ Full desktop round-trip: type command → hear summary.
13. **Pairing endpoint + token regen.**  
    ✔ QR payload matches config.
14. **Nice-to-haves if time permits:** “New Claude Code session” button; per-session ElevenLabs voice; both playback mode.

Key dependencies: `express`, `ws`, `better-sqlite3`, `multer`, `pino`, `undici` (or native fetch), `ffmpeg-static` + `sound-play`, `qrcode.react`, `electron`, `vite`, `react`.

---

## 8. Testing without the phone — do this before any mobile work

```bash
# health
curl -H "Authorization: Bearer $TOKEN" http://localhost:4620/api/health

# sessions
curl -H "Authorization: Bearer $TOKEN" http://localhost:4620/api/sessions

# voice pipeline with a recorded clip
curl -H "Authorization: Bearer $TOKEN" -F audio=@test.wav -F sessionId=1 \
     http://localhost:4620/api/command
```

Record `test.wav` saying something like “give me a one line summary of this project”. If this round-trips to spoken audio, the backend is done.

---

## 9. Phase 2 — PhoneWhisper fork (`mobile/FORK_NOTES.md`)

Scope for the fork; keep minimal, Android/Kotlin:

1. **Settings additions:** `baseUrl`, `token`, `deviceId` (generated UUID) — populated by QR deep link `cvh://pair`.
2. **Endpoint swap:** point the existing transcription HTTP client at `POST {baseUrl}/api/transcribe` with the bearer token. The server holds the OpenAI key — key never lives on the phone. Keep the existing overlay/accessibility injection behaviour untouched: this preserves the “dictate into any app” feature you liked.
3. **New “Claude mode”:** a second overlay action (long-press the bubble, or a mode toggle) that records and POSTs to `/api/command` with the selected `sessionId`, then plays the returned `audioUrl`.
4. **Session picker screen:** `GET /api/sessions` list mirroring the desktop cards; tap to select active session; subscribe to WS for state badges; notification when `response_ready` fires; tapping the notification plays the summary audio.
5. **Rebuild, sign, install.** Verify the upstream repo’s license before publishing your fork publicly. Fine either way for personal use, but GPL vs MIT changes obligations if you later ship the commercial version.

---

## 10. Deferred — commercial version, do not build now

Multi-user auth, hosted key management, Postgres, payment, tunnel-provider plugins beyond Tailscale, iOS. Revisit after the personal version has been daily-driven for a few weeks.
