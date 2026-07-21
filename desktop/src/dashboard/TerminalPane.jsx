import React, { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { termWsUrl } from '../lib/api.js';
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

// One live xterm.js terminal bound to a session's PTY over /ws/term. Every pane
// stays mounted (hidden when inactive) so scrollback and the socket survive tab
// switches. Registers an imperative { focus, write, paste } via onApi so the
// Dashboard can drive the focused terminal (voice, image paste, drag-drop).
export default function TerminalPane({ session, active, onApi, notify }) {
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
    term.loadAddon(new WebLinksAddon((_e, uri) => window.cvh?.openExternal(uri)));
    term.open(wrapRef.current);
    termRef.current = term;
    fitRef.current = fit;

    const ws = new WebSocket(termWsUrl(session.id));
    wsRef.current = ws;

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
      if (m.t === 'data') term.write(m.d);
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
    // Ctrl+Shift+C always copies. Paste is intentionally NOT intercepted here —
    // xterm does its own single native text paste, so intercepting would double
    // it. Images are special-cased in the capture-phase paste listener below.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !e.ctrlKey) return true;
      if (e.key.toLowerCase() === 'c' && (e.shiftKey || term.hasSelection())) {
        const sel = term.getSelection();
        if (sel) navigator.clipboard.writeText(sel).catch(() => {});
        if (!e.shiftKey) term.clearSelection();
        return false; // copy, not SIGINT
      }
      return true;
    });

    // Image paste: intercept in capture phase (before xterm's textarea handler).
    // If the clipboard holds an image, inject a temp-file path Claude Code can
    // ingest and block the default; plain text falls through to xterm's single
    // native paste, so there's no double-paste.
    const onPaste = (e) => {
      const cd = e.clipboardData;
      const hasImage =
        !!cd &&
        (Array.from(cd.items || []).some((it) => it.type && it.type.startsWith('image/')) ||
          Array.from(cd.files || []).some((f) => f.type && f.type.startsWith('image/')));
      if (!hasImage) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      window.cvh
        ?.clipboardImagePath?.()
        .then((p) => {
          if (p) {
            sendInput(quote(p) + ' ');
            term.focus();
          }
        })
        .catch(() => {});
    };
    el.addEventListener('paste', onPaste, true);

    // Drag a file (or several) in → drop their paths at the prompt.
    const onDragOver = (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    };
    const onDrop = (e) => {
      e.preventDefault();
      const paths = Array.from(e.dataTransfer.files || [])
        .map((f) => f.path)
        .filter(Boolean);
      if (paths.length) {
        sendInput(paths.map(quote).join(' ') + ' ');
        term.focus();
      }
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
      ro.disconnect();
      dataDisp.dispose();
      el.removeEventListener('paste', onPaste, true);
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
