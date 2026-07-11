// GET /api/fs/list?path=<dir> — list subdirectories for the phone folder picker.
// Localhost-only. path='' or 'drives' returns the drive letters. Directories
// only; per-entry and per-dir errors are swallowed so inaccessible folders
// don't break browsing.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, parse } from 'node:path';
import { Router } from 'express';
import { localhostOnly } from '../auth.js';

const router = Router();
router.use(localhostOnly);

const MAX_ENTRIES = 1000;

function listDrives() {
  const drives = [];
  for (const L of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    const d = `${L}:\\`;
    try {
      if (existsSync(d)) drives.push(d);
    } catch {
      /* skip */
    }
  }
  return drives;
}

router.get('/list', (req, res) => {
  const raw = (req.query.path || '').toString().trim().replace(/["']/g, '');

  if (raw === '' || raw.toLowerCase() === 'drives') {
    const drives = listDrives();
    return res.json({
      path: null,
      parent: null,
      dirs: drives.map((d) => ({ name: d, path: d })),
    });
  }

  const abs = resolve(raw);
  let entries;
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch (err) {
    return res.status(400).json({ error: `cannot open: ${abs}` });
  }

  const dirs = [];
  for (const e of entries) {
    if (dirs.length >= MAX_ENTRIES) break;
    let isDir = false;
    try {
      isDir = e.isDirectory() || (e.isSymbolicLink() && statSync(join(abs, e.name)).isDirectory());
    } catch {
      isDir = false;
    }
    if (isDir) dirs.push({ name: e.name, path: join(abs, e.name) });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  const root = parse(abs).root;
  const atRoot = abs.replace(/[\\/]+$/, '') === root.replace(/[\\/]+$/, '');
  const parent = atRoot ? 'drives' : dirname(abs);

  res.json({ path: abs, parent, dirs });
});

export default router;
