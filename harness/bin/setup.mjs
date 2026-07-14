// setup.mjs — one-command install for the voice harness (`npm run setup`).
//
// Four things a fresh clone needs that nothing else does for you:
//   1. mobile-web/dist  — the phone app is gitignored, so a fresh clone serves NOTHING at /m.
//   2. the `claude` PowerShell alias — without it a terminal session is a bare, un-attachable
//      process, so opening it on the phone can only `--resume` it into a FORK.
//   3. the Claude Code Stop hook — without it the harness never learns a turn finished and
//      waits out the 10-minute output-stabilization timeout instead.
//   4. VAPID keys — push.js reads them from .env; nothing generates them, so push silently dies.
//
// Everything here is idempotent (safe to re-run) and reversible (`--uninstall`). Nothing is
// written until you confirm — this touches your PowerShell profile and your Claude settings.

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import readline from 'node:readline';
import webpush from 'web-push';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const HCLAUDE = join(REPO, 'harness', 'bin', 'hclaude.mjs');
const ENV_FILE = join(REPO, 'harness', '.env');
const DIST_INDEX = join(REPO, 'mobile-web', 'dist', 'index.html');
const SETTINGS = join(homedir(), '.claude', 'settings.json');
const HOOK_URL = 'http://127.0.0.1:4620/api/hooks/stop';

const BEGIN = '# >>> voice-harness (managed by `npm run setup`) >>>';
const END = '# <<< voice-harness <<<';

const args = process.argv.slice(2);
const UNINSTALL = args.includes('--uninstall');
const YES = args.includes('--yes') || args.includes('-y');

const c = { dim: (s) => `\x1b[2m${s}\x1b[0m`, ok: (s) => `\x1b[32m${s}\x1b[0m`, warn: (s) => `\x1b[33m${s}\x1b[0m` };
const say = (s = '') => process.stdout.write(s + '\n');

// ---------------------------------------------------------------- PowerShell profile

// Ask PowerShell itself where the profile lives — hardcoding the path is how you end up
// writing to a file the shell never loads (Documents vs OneDrive\Documents, PS5 vs PS7).
// CurrentUserAllHosts (`profile.ps1`) is the right target: it auto-loads for every host of
// that edition. NOTE `$PROFILE` alone is CurrentUserCurrentHost, a *different* file that
// often doesn't exist — dot-sourcing it is a common way to think you reloaded and haven't.
function psProfiles() {
  const out = [];
  for (const exe of ['pwsh.exe', 'powershell.exe']) {
    try {
      const p = execFileSync(exe, ['-NoProfile', '-Command', '$PROFILE.CurrentUserAllHosts'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (p && !out.includes(p)) out.push(p);
    } catch {
      /* that edition isn't installed */
    }
  }
  return out;
}

// The alias block, with this repo's hclaude path baked in (PowerShell single-quote escaping
// doubles an embedded quote). Routes plain launches, --attach, and the resume/continue forms
// through the harness; everything else falls through to the real CLI untouched.
function aliasBlock() {
  const p = HCLAUDE.replace(/'/g, "''");
  return `${BEGIN}
# A plain \`claude\` launch is routed through the local harness so the session is
# harness-owned and can be driven from the phone/desktop app too (no forked sessions).
# \`claude --resume <uuid>\` and \`claude -c|--continue\` route through it as well.
# Ctrl-\\ detaches; \`claude --attach\` reattaches. Any other invocation passes straight
# through to the real CLI, and if the harness is offline it falls back so you're never stuck.
$global:CVHRealClaude = (Get-Command claude -CommandType Application -ErrorAction SilentlyContinue).Source
$global:CVHAttach = '${p}'
function claude {
  $first = if ($args.Count -ge 1) { [string]$args[0] } else { '' }
  $isAttach = $first -in @('--attach', 'attach')
  $interactive = ($args.Count -eq 0) -or ($args.Count -eq 1 -and (Test-Path -PathType Container -LiteralPath $args[0]))
  $isResume = ($args.Count -eq 2) -and ($first -eq '--resume') -and ([string]$args[1] -match '^[0-9a-fA-F-]{36}$')
  $isContinue = ($args.Count -eq 1) -and ($first -in @('-c', '--continue'))
  $haveAttach = Test-Path -LiteralPath $global:CVHAttach
  if ($isAttach -and $haveAttach) {
    $rest = if ($args.Count -ge 2) { $args[1..($args.Count - 1)] } else { @() }
    node $global:CVHAttach --attach @rest
    if ($LASTEXITCODE -eq 3) { Write-Host '(voice-harness offline - cannot list sessions)' -ForegroundColor DarkYellow }
  } elseif ($interactive -and $haveAttach) {
    $cwd = if ($args.Count -eq 1) { (Resolve-Path -LiteralPath $args[0]).Path } else { (Get-Location).Path }
    node $global:CVHAttach --cwd "$cwd"
    if ($LASTEXITCODE -eq 3) {
      Write-Host '(voice-harness offline - starting Claude directly)' -ForegroundColor DarkYellow
      if ($global:CVHRealClaude) { & $global:CVHRealClaude } else { claude.exe }
    }
  } elseif ($isResume -and $haveAttach) {
    node $global:CVHAttach --resume $args[1] --cwd "$((Get-Location).Path)"
    if ($LASTEXITCODE -eq 3) {
      Write-Host '(voice-harness: resuming directly)' -ForegroundColor DarkYellow
      if ($global:CVHRealClaude) { & $global:CVHRealClaude @args } else { claude.exe @args }
    }
  } elseif ($isContinue -and $haveAttach) {
    node $global:CVHAttach --continue --cwd "$((Get-Location).Path)"
    if ($LASTEXITCODE -eq 3) {
      Write-Host '(voice-harness: continuing directly)' -ForegroundColor DarkYellow
      if ($global:CVHRealClaude) { & $global:CVHRealClaude @args } else { claude.exe @args }
    }
  } elseif ($global:CVHRealClaude) {
    & $global:CVHRealClaude @args
  } else {
    claude.exe @args
  }
}
if (Test-Path -LiteralPath $global:CVHAttach) {
  Write-Host 'voice-harness: claude alias ready  (Ctrl-\\ detaches | claude --attach reattaches)' -ForegroundColor DarkGray
}
${END}`;
}

// Strip both our managed block AND the older hand-written one (its header/footer rules), so
// re-running upgrades an existing install in place instead of stacking a second `claude`.
function stripBlocks(text) {
  let t = text;
  const managed = new RegExp(`\\r?\\n?${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g');
  t = t.replace(managed, '');
  // Legacy block: `# === Voice Harness: ...` through the next all-`=` comment rule.
  t = t.replace(/\r?\n?# === Voice Harness:[\s\S]*?\r?\n# ={5,}\r?\n?/g, '\n');
  return t;
}

function planProfiles() {
  const targets = psProfiles();
  return targets.map((path) => {
    const before = existsSync(path) ? readFileSync(path, 'utf8') : '';
    const had = /\$global:CVHAttach/.test(before);
    return { path, before, had };
  });
}

// ---------------------------------------------------------------- Stop hook

// Claude's real schema nests the command inside a `hooks` array (the README's flat form does
// NOT fire). Merge ours in without disturbing any other hook or setting the user has.
function stopHookEntry() {
  return {
    hooks: [
      {
        type: 'command',
        command: 'curl.exe',
        args: ['-s', '-X', 'POST', HOOK_URL, '-H', 'Content-Type: application/json', '-d', '@-'],
        timeout: 5,
      },
    ],
  };
}
const isOurHook = (e) =>
  Array.isArray(e?.hooks) && e.hooks.some((h) => Array.isArray(h?.args) && h.args.includes(HOOK_URL));

function readSettings() {
  if (!existsSync(SETTINGS)) return {};
  try {
    return JSON.parse(readFileSync(SETTINGS, 'utf8'));
  } catch {
    return null; // unparseable — refuse to touch it
  }
}

// ---------------------------------------------------------------- main

async function confirm(question) {
  if (YES) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise((r) => rl.question(question, r));
  rl.close();
  return /^y(es)?$/i.test(a.trim());
}

const profiles = planProfiles();
const settings = readSettings();
const envText = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : '';
const haveVapid = /^VAPID_PUBLIC_KEY=.+$/m.test(envText);
const haveDist = existsSync(DIST_INDEX);
const hookInstalled = Array.isArray(settings?.hooks?.Stop) && settings.hooks.Stop.some(isOurHook);

say();
say(UNINSTALL ? 'voice-harness setup — UNINSTALL' : 'voice-harness setup');
say(c.dim('─'.repeat(58)));

if (settings === null) {
  say(c.warn(`! ${SETTINGS} is not valid JSON — I will not touch it.`));
}

const plan = [];
if (UNINSTALL) {
  for (const p of profiles) if (p.had) plan.push(`remove the claude alias from ${p.path}`);
  if (hookInstalled && settings) plan.push(`remove the Stop hook from ${SETTINGS}`);
} else {
  if (!haveDist) plan.push('build the phone app (mobile-web → dist/)  [required: /m serves nothing without it]');
  for (const p of profiles) plan.push(`${p.had ? 'update' : 'install'} the claude alias in ${p.path}`);
  if (settings !== null && !hookInstalled) plan.push(`add the Claude Code Stop hook to ${SETTINGS}  [backed up first]`);
  if (!haveVapid) plan.push(`generate VAPID keys into ${ENV_FILE}  [push notifications]`);
}

if (!plan.length) {
  say(c.ok('Nothing to do — everything is already set up.'));
  process.exit(0);
}
say('This will:');
for (const s of plan) say('  • ' + s);
say();

if (!(await confirm('Proceed? [y/N] '))) {
  say('Aborted — nothing was changed.');
  process.exit(0);
}
say();

// 1. phone app
if (!UNINSTALL && !haveDist) {
  say('▸ building the phone app…');
  const r = spawnSync('npm', ['run', 'build', '--workspace', 'mobile-web'], {
    cwd: REPO,
    stdio: 'inherit',
    shell: true,
  });
  say(r.status === 0 ? c.ok('  built mobile-web/dist') : c.warn('  build failed — run `npm run build --workspace mobile-web` yourself'));
}

// 2. PowerShell alias
for (const p of profiles) {
  const stripped = stripBlocks(p.before).replace(/\s+$/, '');
  const next = UNINSTALL ? stripped + '\n' : (stripped ? stripped + '\n\n' : '') + aliasBlock() + '\n';
  mkdirSync(dirname(p.path), { recursive: true });
  writeFileSync(p.path, next, 'utf8');
  say(c.ok(`  ${UNINSTALL ? 'removed' : p.had ? 'updated' : 'installed'} alias → ${p.path}`));
}

// 3. Stop hook
if (settings !== null) {
  const s = settings;
  s.hooks = s.hooks || {};
  const existing = Array.isArray(s.hooks.Stop) ? s.hooks.Stop : [];
  const kept = existing.filter((e) => !isOurHook(e)); // drop ours, keep everyone else's
  const nextStop = UNINSTALL ? kept : [...kept, stopHookEntry()];
  const changed = UNINSTALL ? hookInstalled : !hookInstalled;
  if (changed) {
    if (existsSync(SETTINGS)) copyFileSync(SETTINGS, SETTINGS + '.bak');
    if (nextStop.length) s.hooks.Stop = nextStop;
    else delete s.hooks.Stop;
    mkdirSync(dirname(SETTINGS), { recursive: true });
    writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + '\n', 'utf8');
    say(c.ok(`  ${UNINSTALL ? 'removed' : 'added'} Stop hook → ${SETTINGS}  ${c.dim('(backup: settings.json.bak)')}`));
  }
}

// 4. VAPID keys
if (!UNINSTALL && !haveVapid) {
  const { publicKey, privateKey } = webpush.generateVAPIDKeys();
  const block =
    `${envText.replace(/\s+$/, '')}\n\n# Web Push (generated by \`npm run setup\`). Keep the private key secret.\n` +
    `VAPID_PUBLIC_KEY=${publicKey}\nVAPID_PRIVATE_KEY=${privateKey}\nVAPID_SUBJECT=mailto:admin@example.com\n`;
  mkdirSync(dirname(ENV_FILE), { recursive: true });
  writeFileSync(ENV_FILE, block, 'utf8');
  say(c.ok(`  generated VAPID keys → ${ENV_FILE}`));
}

say();
if (UNINSTALL) {
  say('Done. Open a NEW terminal for the alias removal to take effect.');
} else {
  say(c.ok('Done.'));
  say();
  say('Next: open a ' + c.ok('NEW') + ' PowerShell window (the profile auto-loads there).');
  say(c.dim("  Don't `. $PROFILE` — that's a different file and often doesn't exist."));
  say('  Then `claude` in any repo → it becomes harness-owned and shareable with your phone.');
  say(c.dim('  Rejoin an existing session with `claude --attach` — `-c`/`--resume` start a new branch.'));
}
say();
