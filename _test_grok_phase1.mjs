// Live Phase-1 check: spawn a Grok session, send a short command, verify
// completion + chat log + kill. Uses the running harness on :4620.

const base = 'http://127.0.0.1:4620';

async function j(method, path, body) {
  const r = await fetch(base + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${data.error || text}`);
  return data;
}

const cwd = process.cwd();
console.log('1. create grok session in', cwd);
const session = await j('POST', '/api/sessions', {
  kind: 'grok',
  cwd,
  label: 'phase1-grok-test',
});
console.log('   id=', session.id, 'kind=', session.kind, 'alive=', session.alive);

// Give the agent a moment to print its banner / prompt.
await new Promise((r) => setTimeout(r, 1500));

console.log('2. POST /api/command (short no-tool turn)');
const started = Date.now();
let result;
try {
  result = await j('POST', '/api/command', {
    sessionId: session.id,
    text: 'Reply with exactly: GROK_PHASE1_OK. Do not use tools.',
    desktopPlayback: false,
    timeoutMs: 90000,
  });
} catch (e) {
  console.error('   command failed:', e.message);
  await j('POST', `/api/sessions/${session.id}/kill`, {}).catch(() => {});
  process.exit(1);
}
const ms = Date.now() - started;
console.log('   via=', result.via, 'ms=', ms);
console.log('   responseText=', String(result.responseText || '').slice(0, 200));
console.log('   summary=', String(result.summary || '').slice(0, 120));
console.log('   audioUrl=', result.audioUrl || null);
console.log('   interactionId=', result.interactionId || null);

console.log('3. GET /api/sessions/:id/messages');
const conv = await j('GET', `/api/sessions/${session.id}/messages`);
console.log('   messages=', conv.messages?.length || 0, 'state=', conv.state, 'full=', conv.full);
for (const m of (conv.messages || []).slice(-4)) {
  console.log(`   - ${m.role}: ${String(m.text || '').slice(0, 80)}`);
}

const okText = /GROK_PHASE1_OK/i.test(result.responseText || '');
const hasAssistant = (conv.messages || []).some((m) => m.role === 'assistant');
const hasUser = (conv.messages || []).some((m) => m.role === 'user');

console.log('4. kill session');
await j('POST', `/api/sessions/${session.id}/kill`, {});

const pass = okText && hasAssistant && hasUser && !!result.via;
console.log(pass ? 'PASS' : 'FAIL', {
  okText,
  hasAssistant,
  hasUser,
  via: result.via,
  ms,
});
process.exit(pass ? 0 : 2);
