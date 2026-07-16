import { Router } from 'express';
import { getAdapter, listAdapters, publicAdapter } from '../../agents/registry.js';
import { credentialStatus, removeCredential, saveCredential } from '../../agents/credentials.js';
import { localhostOnly } from '../auth.js';

const router = Router();

router.get('/', (req, res) => {
  res.json({ providers: listAdapters({ includeHidden: req.query.all === '1' }) });
});

router.get('/:id', (req, res) => {
  const adapter = getAdapter(req.params.id);
  if (!adapter) return res.status(404).json({ error: 'provider not found' });
  res.json(publicAdapter(adapter));
});

// Provider credentials are local-machine administration. Values are accepted
// but never returned; remote clients only see configured/required state.
router.post('/:id/credential', localhostOnly, (req, res) => {
  const adapter = getAdapter(req.params.id);
  if (!adapter) return res.status(404).json({ error: 'provider not found' });
  try {
    const authentication = saveCredential(adapter, req.body?.value);
    res.json({ ok: true, authentication });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id/credential', localhostOnly, (req, res) => {
  const adapter = getAdapter(req.params.id);
  if (!adapter) return res.status(404).json({ error: 'provider not found' });
  try {
    removeCredential(adapter);
    res.json({ ok: true, authentication: credentialStatus(adapter) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
