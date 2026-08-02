import { Router } from 'express';
import {
  getAdapter, isCustomProvider, listAdapters, publicAdapter,
  removeCustomProvider, saveCustomProvider,
} from '../../agents/registry.js';
import { credentialStatus, removeCredential, saveCredential } from '../../agents/credentials.js';
import { deleteConfig } from '../../config.js';
import { listSessions } from '../../services/sessionManager.js';

const router = Router();

router.get('/', (req, res) => {
  res.json({ providers: listAdapters({ includeHidden: req.query.all === '1' }) });
});

router.get('/:id', (req, res) => {
  const adapter = getAdapter(req.params.id);
  if (!adapter) return res.status(404).json({ error: 'provider not found' });
  res.json(publicAdapter(adapter));
});

function hasLiveSessions(id) {
  return listSessions().some((session) => session.alive && (session.provider_id || session.kind) === id);
}

// Create or update a custom provider and install it in the live registry. The
// route accepts only structured fields; commands and args are passed directly to
// node-pty and are never interpreted by a shell. Definitions are persisted under
// DATA_DIR/agents, while credentials stay in the config store and never echo back.
router.post('/', (req, res) => {
  const body = req.body || {};
  const id = String(body.id || '').trim().toLowerCase();
  const existed = isCustomProvider(id);
  if (body.type === 'anthropic' && typeof body.credential === 'string' && body.credential.trim() && body.credential.trim().length < 8) {
    return res.status(400).json({ error: 'API key must be at least 8 characters' });
  }
  if (existed && hasLiveSessions(id)) {
    return res.status(409).json({ error: 'end this provider\'s live sessions before editing it' });
  }
  try {
    const adapter = saveCustomProvider(body);
    if (typeof body.credential === 'string' && body.credential.trim()) {
      saveCredential(adapter, body.credential);
    }
    res.status(existed ? 200 : 201).json({ provider: publicAdapter(adapter) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Credential writes use the API's normal paired-device authentication. Values
// are accepted but never returned; clients only see configured/required state.
router.post('/:id/credential', (req, res) => {
  const adapter = getAdapter(req.params.id);
  if (!adapter) return res.status(404).json({ error: 'provider not found' });
  try {
    const authentication = saveCredential(adapter, req.body?.value);
    res.json({ ok: true, authentication });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id/credential', (req, res) => {
  const adapter = getAdapter(req.params.id);
  if (!adapter) return res.status(404).json({ error: 'provider not found' });
  try {
    removeCredential(adapter);
    res.json({ ok: true, authentication: credentialStatus(adapter) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  const id = String(req.params.id || '').toLowerCase();
  if (!isCustomProvider(id)) return res.status(400).json({ error: 'built-in providers cannot be removed' });
  if (hasLiveSessions(id)) return res.status(409).json({ error: 'end this provider\'s live sessions before removing it' });
  const adapter = getAdapter(id);
  try {
    if (adapter?.auth?.configKey) deleteConfig(adapter.auth.configKey);
    removeCustomProvider(id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
