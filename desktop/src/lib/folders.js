// Grouping the tab strip by the folder a session runs in. Several sessions on one
// project is the normal way to work here, and left in arrival order they scatter
// across the strip — so tabs cluster by folder, and a folder's colour is shared by
// every tab in it rather than being a property of whichever tab you happened to
// right-click.

// The same directory reaches the app spelled several ways (trailing slash from a
// picker, different drive-letter case from a shell), so compare a normalised form.
export const folderKey = (cwd) => String(cwd || '').replace(/[\/]+$/, '').toLowerCase();

// Cluster same-folder sessions together WITHOUT resorting the strip: each folder
// keeps the position of its first tab, and a later tab from that folder moves up
// to join it. Dragging still decides the order of folders and of tabs inside one.
export function clusterByFolder(sessions) {
  const groups = new Map(); // folderKey -> tabs, in first-seen order
  const loose = []; // no cwd (a session that never reported one) stays where it is
  for (const session of sessions) {
    const key = folderKey(session.cwd);
    if (!key) {
      loose.push(session);
      continue;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(session);
  }
  return [...[...groups.values()].flat(), ...loose];
}

// One colour per folder: the most recently coloured session in it. The harness
// hands a new session its folder's colour on spawn, but sessions that predate
// that — or were coloured one at a time — would still look unrelated, and this
// makes the strip agree with itself without rewriting anyone's stored choice.
export function folderColors(sessions) {
  const colors = new Map();
  for (const session of [...sessions].sort((a, b) => b.id - a.id)) {
    const key = folderKey(session.cwd);
    if (key && session.tab_color && !colors.has(key)) colors.set(key, session.tab_color);
  }
  return colors;
}

// Where each folder group starts, so the strip can space groups apart.
export function firstOfFolder(sessions) {
  const seen = new Set();
  const firsts = new Set();
  for (const session of sessions) {
    const key = folderKey(session.cwd);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    firsts.add(session.id);
  }
  return firsts;
}
