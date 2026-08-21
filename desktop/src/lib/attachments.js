// Pasting a screenshot into a session. Inside Electron the preload bridge reads
// the OS clipboard and writes a temp file, so there is already a path to hand the
// CLI. Served as a plain web page (harness /desktop) the browser gives us pixels
// and no path at all — upload the bitmap to the harness, which writes it next to
// the phone's attachments and returns the local path the CLI can read.

import { attachFile } from './api.js';

export const hasImageBridge = () => !!window.cvh?.clipboardImagePath;

// Image files carried by a paste event, named so the upload passes the server's
// extension check (clipboard blobs are usually unnamed).
export function clipboardImages(data) {
  const out = [];
  for (const item of Array.from(data?.items || [])) {
    if (item.kind !== 'file' || !item.type?.startsWith('image/')) continue;
    const blob = item.getAsFile();
    if (!blob) continue;
    const subtype = (blob.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
    const ext = subtype === 'jpeg' ? 'jpg' : subtype;
    const named = blob.name && /\.[a-z0-9]+$/i.test(blob.name);
    out.push(named ? blob : new File([blob], `pasted-image-${Date.now()}-${out.length + 1}.${ext}`, {
      type: blob.type || `image/${ext}`,
    }));
  }
  // Some browsers expose clipboard images through `files` and leave `items`
  // empty. Only used when the primary list found none, so nothing uploads twice.
  if (!out.length) {
    for (const file of Array.from(data?.files || [])) {
      if (file.type?.startsWith('image/')) out.push(file);
    }
  }
  return out;
}

// Mirrors ATTACH_EXT in harness/src/server/routes/sessions.js.
const ACCEPT = '.png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.md,.csv,.json';

export const quotePath = (p) => (/s/.test(p) ? `"${p}"` : p);

// Upload files the browser handed us (paste, drop, picker) and return the local
// paths the harness stored them at — the form the CLI can read.
export async function uploadFiles(sessionId, files) {
  const paths = [];
  for (const file of files) {
    const { path } = await attachFile(sessionId, file);
    if (path) paths.push(path);
  }
  return paths;
}
export const uploadImages = uploadFiles;

// Dropped files already on this machine carry their path under Electron; a
// browser only gives the bytes, so those go up to the harness instead.
export async function droppedPaths(sessionId, fileList) {
  const files = Array.from(fileList || []);
  const local = files.map((f) => f.path).filter(Boolean);
  if (local.length || !files.length) return local;
  return uploadFiles(sessionId, files);
}

// "Attach a file": the OS dialog under Electron (the path is all we need); a
// file input in a browser, uploading whatever was chosen. Resolves to paths,
// empty when cancelled.
export function pickAttachments(sessionId) {
  if (window.cvh?.pickFile) return window.cvh.pickFile().then((p) => (p ? [p] : []));
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = ACCEPT;
    input.style.display = 'none';
    document.body.appendChild(input);
    const done = () => input.remove();
    input.addEventListener('change', () => {
      const files = Array.from(input.files || []);
      done();
      uploadFiles(sessionId, files).then(resolve, reject);
    });
    input.addEventListener('cancel', () => { done(); resolve([]); });
    input.click();
  });
}
