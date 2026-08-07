#!/usr/bin/env node
// Set (or change) the web login password for the code.cnly.au front door.
// Run this in a terminal ON THE PC — the password is read with echo off, hashed
// with scrypt, and only the hash is stored. Setting a password also rotates the
// session-signing secret, which logs out every existing browser session.
//
//   node harness/bin/set-password.mjs

import { randomBytes, scryptSync } from 'node:crypto';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

process.env.CVH_DATA_DIR ||= ''; // default data dir
const { default: db } = await import('../src/db.js');

function promptHidden(question) {
  return new Promise((resolve) => {
    // Muted output stream: the prompt prints, the typed characters do not.
    let muted = false;
    const out = new Writable({
      write(chunk, enc, cb) {
        if (!muted) process.stdout.write(chunk, enc);
        cb();
      },
    });
    const rl = createInterface({ input: process.stdin, output: out, terminal: true });
    rl.question(question, (answer) => {
      muted = false;
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

const pw = await promptHidden('New web password: ');
if (!pw || pw.length < 8) {
  console.error('Password must be at least 8 characters. Nothing changed.');
  process.exit(1);
}
const again = await promptHidden('Repeat password:  ');
if (pw !== again) {
  console.error('Passwords do not match. Nothing changed.');
  process.exit(1);
}

const N = 16384;
const salt = randomBytes(16);
const hash = scryptSync(pw, salt, 32, { N, r: 8, p: 1 });
const stored = `scrypt$${N}$${salt.toString('hex')}$${hash.toString('hex')}`;

const upsert = db.prepare(
  "INSERT INTO config(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
);
upsert.run('web_password_hash', stored);
upsert.run('web_session_secret', randomBytes(32).toString('hex')); // logs out all sessions
console.log('Password set. All existing browser sessions are signed out.');
console.log('If the harness is running, it picks this up immediately — no restart needed.');
process.exit(0);
