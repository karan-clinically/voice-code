// Rotating harness.db snapshots. The conversation log (messages/interactions)
// lives only in this one SQLite file — a corrupted or deleted harness.db would
// be the single way to genuinely lose every conversation, so keep daily
// point-in-time copies. Uses better-sqlite3's online backup API, which is safe
// to run while the harness is serving (WAL readers/writers keep working).

import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import db, { DATA_DIR } from '../db.js';
import { makeLogger } from '../util/logger.js';

const log = makeLogger('backup');

export const BACKUP_DIR = join(DATA_DIR, 'backups');
const KEEP = 7;
const NAME_RE = /^harness-(\d{4}-\d{2}-\d{2})\.db$/;

function todayName() {
  return `harness-${new Date().toISOString().slice(0, 10)}.db`;
}

async function backupIfDue() {
  const dest = join(BACKUP_DIR, todayName());
  if (existsSync(dest)) return false; // today's snapshot already taken
  mkdirSync(BACKUP_DIR, { recursive: true });
  await db.backup(dest);
  // Prune beyond the newest KEEP (names sort chronologically).
  const old = readdirSync(BACKUP_DIR).filter((f) => NAME_RE.test(f)).sort().slice(0, -KEEP);
  for (const f of old) {
    try { unlinkSync(join(BACKUP_DIR, f)); } catch { /* locked/gone — retry tomorrow */ }
  }
  log.info(`db snapshot written: ${dest} (keeping ${KEEP} days)`);
  return true;
}

// One snapshot shortly after boot (crash recovery is exactly when a fresh copy
// matters), then an hourly due-check so the daily snapshot happens even on a
// harness that never restarts.
export function startBackups({ initialDelayMs = 60_000, checkIntervalMs = 60 * 60_000 } = {}) {
  const run = () => backupIfDue().catch((err) => log.warn(`db backup failed: ${err.message}`));
  setTimeout(run, initialDelayMs).unref?.();
  const timer = setInterval(run, checkIntervalMs);
  timer.unref?.();
  return timer;
}
