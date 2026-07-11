// pino logger -> stdout + SQLite `logs` table + an EventEmitter the WS server
// subscribes to (step 9) so the desktop LiveLog can tail activity.
// Logging must never crash the harness: SQLite writes are wrapped in try/catch.

import { EventEmitter } from 'node:events';
import pino from 'pino';
import db from '../db.js';

export const logEvents = new EventEmitter();

const base = pino({ level: process.env.LOG_LEVEL || 'info' });

let insertLog;
try {
  insertLog = db.prepare('INSERT INTO logs(level, module, message) VALUES(?, ?, ?)');
} catch {
  insertLog = null;
}

function emit(level, module, msg, extra) {
  const message = extra !== undefined ? `${msg} ${safeStringify(extra)}` : msg;
  base[level]?.({ module, extra }, msg);
  try {
    insertLog?.run(level, module, message);
  } catch {
    // never let a logging failure take down the request path
  }
  logEvents.emit('log', { level, module, message, ts: new Date().toISOString() });
}

function safeStringify(v) {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function makeLogger(module) {
  return {
    debug: (msg, extra) => emit('debug', module, msg, extra),
    info: (msg, extra) => emit('info', module, msg, extra),
    warn: (msg, extra) => emit('warn', module, msg, extra),
    error: (msg, extra) => emit('error', module, msg, extra),
  };
}
