// Grouping sessions by the folder they run in — shared by the Home list and the
// in-session switcher drawer so both read the same way: a folder heading, then the
// sessions inside it. A folder with a single session still gets its heading; where
// a session is running is part of identifying it, not a detail that only matters
// once there are several.

export const cwdName = (cwd) => String(cwd || '').split(/[\\/]/).filter(Boolean).pop() || '';
export const cwdKey = (cwd) => String(cwd || '').replace(/[\\/]+$/, '').toLowerCase();

// [{ type:'folder', key, cwd, items:[…] } | { type:'session', key, item }] in the
// order the rows arrived: a folder takes the position of its first (most recent)
// session, so the list keeps its recency feel instead of re-sorting by name.
// Rows with no folder — remote-control and saved rows — stay on their own.
export function groupByFolder(rows) {
  const entries = [];
  const byKey = new Map();
  for (const item of rows) {
    const key = cwdKey(item.cwd);
    if (!key) {
      entries.push({ type: 'session', key: item.key, item });
      continue;
    }
    const seen = byKey.get(key);
    if (seen) {
      seen.items.push(item);
      continue;
    }
    const entry = { type: 'folder', key, cwd: item.cwd, items: [item] };
    byKey.set(key, entry);
    entries.push(entry);
  }
  return entries;
}
