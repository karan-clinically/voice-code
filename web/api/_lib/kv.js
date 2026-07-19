// Minimal Upstash Redis REST client for the PC presence registry. Serverless
// functions are stateless, so heartbeats need *some* store; Upstash's REST API
// needs only fetch. Works with either the Vercel KV integration env names or
// Upstash's own. Not configured => callers degrade gracefully (the UI shows a
// setup hint instead of the PC list).

function creds() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

export const kvConfigured = () => !!creds();

export async function kv(...command) {
  const c = creds();
  if (!c) throw new Error('KV store not configured (add the Upstash Redis integration in Vercel)');
  const r = await fetch(c.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(command),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) throw new Error(`KV ${command[0]} failed: ${data.error || r.status}`);
  return data.result;
}

// HGETALL returns a flat [field, value, field, value…] array over REST.
export async function hgetallObject(key) {
  const flat = (await kv('HGETALL', key)) || [];
  const out = {};
  for (let i = 0; i < flat.length; i += 2) out[flat[i]] = flat[i + 1];
  return out;
}
