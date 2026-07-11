// Local (harness-side) audio playback through the PC speakers. On Windows this
// uses PowerShell's WPF MediaPlayer (handles mp3, no native dependency). The
// desktop app can alternatively play via an HTML5 <audio> element.
// Config `tts_playback_target`: phone | desktop | both.

import { execFile } from 'node:child_process';
import { makeLogger } from '../util/logger.js';

const log = makeLogger('audio');

export function playLocal(path) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const safe = path.replace(/'/g, "''");
      const ps = [
        'Add-Type -AssemblyName presentationCore;',
        '$p = New-Object System.Windows.Media.MediaPlayer;',
        `$p.Open([uri]'${safe}');`,
        'Start-Sleep -Milliseconds 400;',
        '$p.Play();',
        '$secs = if ($p.NaturalDuration.HasTimeSpan) { [math]::Ceiling($p.NaturalDuration.TimeSpan.TotalSeconds) + 1 } else { 6 };',
        'Start-Sleep -Seconds $secs;',
        '$p.Stop(); $p.Close();',
      ].join(' ');
      execFile(
        'powershell.exe',
        ['-NoProfile', '-STA', '-Command', ps],
        { windowsHide: true },
        (err) => {
          if (err) log.warn(`playLocal failed: ${err.message}`);
          resolve(!err);
        }
      );
    } else {
      // Linux/macOS fallback: ffplay if available.
      execFile('ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', path], (err) => {
        if (err) log.warn(`ffplay failed: ${err.message}`);
        resolve(!err);
      });
    }
  });
}
