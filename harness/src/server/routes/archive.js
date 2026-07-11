// Session Archive API — search past Claude Code transcripts and resume any of
// them into a live PTY (reusing the /ws/term terminal foundation).
//
//   GET  /api/archive?q=&project=&limit=  — search (FTS when q, else recent)
//   GET  /api/archive/projects            — distinct projects (filter facet)
//   GET  /api/archive/:uuid               — metadata + first N prompts (preview)
//   POST /api/archive/:uuid/resume        — `claude --resume <uuid>` in its cwd
//   POST /api/archive/reindex             — force a rescan
//
// Gated by the standard authMiddleware (localhost bypass / bearer token) — the
// phone reaches this over Tailscale, so it is intentionally NOT localhost-only.

import { existsSync } from 'node:fs';
import { Router } from 'express';
import {
  searchArchive, getArchivePrompts, getArchiveMeta, listProjects, reindex,
} from '../../services/archiveIndex.js';
import { createSession } from '../../services/sessionManager.js';
import { backfillFromTranscript } from '../../services/conversation.js';
import { makeLogger } from '../../util/logger.js';

const log = makeLogger('archive-route');
const router = Router();

router.get('/', (req, res) => {
  try {
    const sessions = searchArchive({
      q: req.query.q || '',
      project: req.query.project || '',
      limit: req.query.limit,
    });
    res.json({ sessions });
  } catch (err) {
    log.error(`search error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/projects', (req, res) => {
  res.json({ projects: listProjects() });
});

router.post('/reindex', async (req, res) => {
  try {
    res.json(await reindex());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Preview: metadata + the first few user prompts. Defined before /:uuid/resume
// (Express matches in order; both are distinct paths so order is not critical).
router.get('/:uuid', async (req, res) => {
  try {
    const data = await getArchivePrompts(req.params.uuid);
    if (!data) return res.status(404).json({ error: 'session not found in archive' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:uuid/resume', async (req, res) => {
  const meta = getArchiveMeta(req.params.uuid);
  if (!meta) return res.status(404).json({ error: 'session not found in archive' });
  if (!meta.cwd) return res.status(422).json({ error: 'archived session has no recorded working directory' });
  if (!existsSync(meta.cwd)) {
    return res.status(409).json({ error: `original folder is gone: ${meta.cwd}` });
  }
  try {
    const session = await createSession({
      cwd: meta.cwd,
      label: meta.title,
      kind: 'claude',
      resumeId: meta.uuid,
    });
    // Seed the Chat view with the prior conversation from the on-disk transcript
    // (best-effort; the live session itself won't rewrite it).
    backfillFromTranscript(session.id, meta.uuid).catch(() => {});
    log.info(`resumed archive ${meta.uuid} as session db#${session.id}`);
    res.status(201).json(session);
  } catch (err) {
    log.error(`resume error for ${meta.uuid}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

export default router;
