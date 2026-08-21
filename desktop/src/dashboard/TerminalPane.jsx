import React, { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { termWsUrl } from '../lib/api.js';
import { openExternal } from '../lib/open.js';
import { clipboardImages, hasImageBridge, uploadImages, droppedPaths } from '../lib/attachments.js';
import '@xterm/xterm/css/xterm.css';

// Dark IDE terminal theme (brand-green cursor/accent).
const THEME = {
  background: '#0d1117',
  foreground: '#e6edf3',
  cursor: '#3fb950',
  cursorAccent: '#0d1117',
  selectionBackground: '#264f78',
  black: '#0d1117',
  red: '#ff7b72',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#58a6ff',
  magenta: '#bc8cff',
  cyan: '#39c5cf',
  white: '#b1bac4',
  brightBlack: '#6e7681',
  brightRed: '#ffa198',
  brightGreen: '#56d364',
  brightYellow: '#e3b341',
  brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd',
  brightWhite: '#f0f6fc',
};

// Quote a path for the prompt if it contains spaces.
const quote = (p) => (/\s/.test(p) ? `"${p}"` : p);

// The async clipboard API needs a secure context, which http://<tailnet-ip>:4620
// is not — fall back to the old selection+execCommand trick so copy still works
// there rather than failing silently.
const copyText = (text) => {
  if (!text) return;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => legacyCopy(text));
    return;
  }
  legacyCopy(text);
};

const legacyCopy = (text) => {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
  } catch {
    /* nothing more we can do */
  }
  ta.remove();
};

// One live xterm.js terminal bound to a session's PTY over /ws/term. Every pane
// stays mounted (hidden when inactive) so scrollback and the socket survive tab
// switches. Registers an imperative { focus, write, paste } via onApi so the
// Dashboard can drive the focused terminal (voice, image paste, drag-drop).
export default function TerminalPane({ session, active, onApi, onWorking, notify }) {
  const wrapRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const wsRef = useRef(null);

  useEffect(() => {
    const term = new Terminal({
      fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.15,
      cursorBlink: true,
      // Match the harness's retained scrollback. A newly opened tab receives the
      // session's existing output as a replay; a smaller client-side buffer used
      // to evict its oldest lines immediately, making the scrollbar stop short.
      scrollback: 20000,
      allowProposedApi: true,
      theme: THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_e, uri) => openExternal(uri)));
    term.open(wrapRef.current);
    termRef.current = term;
    fitRef.current = fit;

    const ws = new WebSocket(termWsUrl(session.id));
    wsRef.current = ws;
    let activityTimer = null;

    const reconcileActivity = () => {
      clearTimeout(activityTimer);
      activityTimer = setTimeout(() => {
        const buf = term.buffer.active;
        const start = Math.max(0, buf.baseY + term.rows - 35);
        const lines = [];
        for (let y = start; y < buf.baseY + term.rows; y += 1) {
          lines.push(buf.getLine(y)?.translateToString(true) || '');
        }
        const tail = lines.join('\n');
        const stableBusy = /esc to interrupt|thinking…|working…/i.test(tail);
        const rotatingSpinner = /(?:^|\n)\s*[·✢✻✽✶*]\s+[^\n…]{1,60}…\s*\([^\n)]*(?:\d+\s*[ms]\b|tokens?\b)[^\n)]*\)/i.test(tail);
        if (stableBusy || rotatingSpinner) onWorking?.(session.id);
      }, 80);
    };

    const sendInput = (d) => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'in', d }));
    };
    const sendResize = () => {
      const el = wrapRef.current;
      if (!el || el.clientWidth === 0 || el.clientHeight === 0) return; // hidden pane
      try {
        fit.fit();
      } catch {
        return;
      }
      if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }));
    };

    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.t === 'data') term.write(m.d, reconcileActivity);
      else if (m.t === 'exit') term.write('\r\n\x1b[2m— session ended —\x1b[0m\r\n');
    };
    ws.onopen = () => sendResize();
    ws.onerror = () => notify?.('Terminal connection error');

    const dataDisp = term.onData(sendInput);
    const ro = new ResizeObserver(() => sendResize());
    ro.observe(wrapRef.current);
    setTimeout(sendResize, 0);

    // --- copy / paste / image-paste / drag-drop -----------------------------
    const el = wrapRef.current;

    // Copy on Ctrl+C when there's a selection (else let it interrupt);
    // Ctrl+Shift+C always copies. Paste is handled once in capture phase below.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !e.ctrlKey) return true;
      if (e.key.toLowerCase() === 'c' && (e.shiftKey || term.hasSelection())) {
        copyText(term.getSelection());
        if (!e.shiftKey) term.clearSelection();
        return false; // copy, not SIGINT
      }
      return true;
    });

    // Own paste in capture phase, before xterm's hidden textarea sees it. Electron
    // can otherwise feed clipboard text through both its native edit action and
    // xterm's listener. Images become temp-file paths; text uses term.paste once.
    let lastPasteText = '';
    let lastPasteAt = 0;
    const insertPastedText = (text) => {
      if (!text) return;
      const now = Date.now();
      if (text === lastPasteText && now - lastPasteAt < 300) return;
      lastPasteText = text;
      lastPasteAt = now;
      term.paste(text);
      term.focus();
    };
    const pasteFromSystem = async () => {
      const imagePath = await window.cvh?.clipboardImagePath?.();
      if (imagePath) {
        sendInput(quote(imagePath) + ' ');
        term.focus();
        return;
      }
      let text = '';
      if (window.cvh?.clipboardText) text = await window.cvh.clipboardText();
      else if (navigator.clipboard?.readText) text = await navigator.clipboard.readText().catch(() => '');
      insertPastedText(text);
    };
    const onPaste = (e) => {
      const cd = e.clipboardData;
      const hasImage =
        !!cd &&
        (Array.from(cd.items || []).some((it) => it.type && it.type.startsWith('image/')) ||
          Array.from(cd.files || []).some((f) => f.type && f.type.startsWith('image/')));
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!hasImage) {
        const text = cd?.getData('text/plain') || '';
        if (text) insertPastedText(text);
        else pasteFromSystem().catch(() => {});
        return;
      }
      if (hasImageBridge()) {
        window.cvh
          .clipboardImagePath()
          .then((p) => {
            if (p) {
              sendInput(quote(p) + ' ');
              term.focus();
            }
          })
          .catch(() => {});
        return;
      }
      // Served in a browser: the paste carries the bitmap itself, so upload it and
      // drop the path the harness wrote it to at the prompt.
      const images = clipboardImages(cd);
      if (!images.length) return;
      notify?.(`Uploading ${images.length === 1 ? 'image' : images.length + ' images'}…`);
      uploadImages(session.id, images)
        .then((paths) => {
          if (!paths.length) throw new Error('nothing was stored');
          sendInput(paths.map(quote).join(' ') + ' ');
          term.focus();
          notify?.('');
        })
        .catch((err) => notify?.('Image paste failed: ' + err.message));
    };
    // Ctrl+V must never reach xterm: it encodes plain ctrl+letter as a control
    // code (^V) and cancels the event, which also kills the browser's own paste.
    // Under Electron the preload bridge reads the clipboard, because Electron does
    // not consistently dispatch a populated paste event to xterm's hidden textarea.
    // Served as a plain web page (/desktop in a browser) there is no bridge, so we
    // let the default action run and pick the text up in onPaste below — that keeps
    // paste working without asking for the clipboard-read permission.
    const onPasteKey = (e) => {
      if (e.type !== 'keydown' || (!e.ctrlKey && !e.metaKey) || e.altKey || e.key.toLowerCase() !== 'v') return;
      e.stopImmediatePropagation();
      if (window.cvh?.clipboardText) {
        e.preventDefault();
        pasteFromSystem().catch(() => {});
      }
    };
    el.addEventListener('paste', onPaste, true);
    el.addEventListener('keydown', onPasteKey, true);

    // Drag a file (or several) in → drop their paths at the prompt.
    const onDragOver = (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    };
    const onDrop = (e) => {
      e.preventDefault();
      droppedPaths(session.id, e.dataTransfer.files)
        .then((paths) => {
          if (!paths.length) return;
          sendInput(paths.map(quote).join(' ') + ' ');
          term.focus();
        })
        .catch((err) => notify?.('Attach failed: ' + err.message));
    };
    el.addEventListener('dragover', onDragOver);
    el.addEventListener('drop', onDrop);

    // Imperative API for the Dashboard (voice injection, paste helpers).
    const api = {
      focus: () => term.focus(),
      write: sendInput, // raw injection, no trailing Enter
      hasSelection: () => term.hasSelection(),
      selection: () => term.getSelection(),
      clearSelection: () => term.clearSelection(),
    };
    onApi?.(session.id, api);

    return () => {
      onApi?.(session.id, null);
      clearTimeout(activityTimer);
      ro.disconnect();
      dataDisp.dispose();
      el.removeEventListener('paste', onPaste, true);
      el.removeEventListener('keydown', onPasteKey, true);
      el.removeEventListener('dragover', onDragOver);
      el.removeEventListener('drop', onDrop);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  // On becoming the active tab, re-fit (a hidden pane couldn't measure) + focus.
  useEffect(() => {
    if (!active) return;
    const term = termRef.current;
    const ws = wsRef.current;
    const el = wrapRef.current;
    if (!term || !el) return;
    requestAnimationFrame(() => {
      if (el.clientWidth === 0) return;
      try {
        fitRef.current.fit();
      } catch {
        /* ignore */
      }
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }));
      term.focus();
    });
  }, [active]);

  return <div ref={wrapRef} className={'term-pane' + (active ? ' active' : '')} />;
}
