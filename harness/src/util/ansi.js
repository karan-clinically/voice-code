// Strip ANSI escape codes from raw terminal text.
// Primary screen capture goes through @xterm/headless (which interprets escapes),
// so this is a fallback for any raw byte-stream handling.

// Matches CSI / OSC / SGR and other escape sequences.
const ANSI_PATTERN = new RegExp(
  [
    '[\\u001B\\u009B][[\\]()#;?]*',
    '(?:(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)',
    '|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))',
  ].join(''),
  'g'
);

export function stripAnsi(input) {
  if (!input) return '';
  return String(input).replace(ANSI_PATTERN, '');
}
