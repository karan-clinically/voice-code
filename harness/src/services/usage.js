// Spend tally: record raw units per provider call, price them at read time.
//
// The dollar figures are ESTIMATES — providers change pricing and ElevenLabs bills
// in subscription credits rather than dollars, so the total is a ballpark, not an
// invoice. Any rate can be overridden with a config key `rate_<unit_type>`.

import db from '../db.js';
import { getConfig } from '../config.js';
import { makeLogger } from '../util/logger.js';

const log = makeLogger('usage');

// USD per single unit. Deepgram was dropped as a voice provider, so only
// ElevenLabs + OpenAI are priced here (any lingering deepgram rows are filtered
// out of the summary below).
const DEFAULT_RATES = {
  // Calibrated to the ElevenLabs dashboard: $0.48 for 9.36K characters generated
  // (≈ $0.051 / 1k chars). Credit-priced, so still an estimate.
  elevenlabs_tts_char: 0.48 / 9360,
  elevenlabs_stt_sec: 0.4 / 3600, // Scribe ~$0.40 / hour
  openai_in_token: 0.15 / 1_000_000, // gpt-4o-mini input
  openai_out_token: 0.6 / 1_000_000, // gpt-4o-mini output
};

function rate(unitType) {
  const override = getConfig(`rate_${unitType}`);
  const v = override != null ? Number(override) : DEFAULT_RATES[unitType];
  return Number.isFinite(v) ? v : 0;
}

const ins = db.prepare('INSERT INTO api_usage (provider, service, unit_type, units) VALUES (?,?,?,?)');

// Fire-and-forget — usage accounting must never break a real request.
export function recordUsage(provider, service, unitType, units) {
  try {
    const n = Number(units);
    if (!Number.isFinite(n) || n <= 0) return;
    ins.run(provider, service, unitType, n);
  } catch (err) {
    log.warn(`recordUsage failed: ${err.message}`);
  }
}

// Human labels for the breakdown rows.
const LABEL = {
  elevenlabs_tts_char: { title: 'ElevenLabs · speech out', unit: 'chars' },
  elevenlabs_stt_sec: { title: 'ElevenLabs · speech in', unit: 'audio min' },
  openai_in_token: { title: 'OpenAI · summaries in', unit: 'tokens' },
  openai_out_token: { title: 'OpenAI · summaries out', unit: 'tokens' },
};

export function usageSummary() {
  // Deepgram is no longer used — exclude its historical rows so the tally reflects
  // the current ElevenLabs + OpenAI stack (the rows stay in the table, just hidden).
  const rows = db
    .prepare(
      "SELECT provider, service, unit_type, SUM(units) units, COUNT(*) calls FROM api_usage WHERE provider != 'deepgram' GROUP BY unit_type"
    )
    .all();
  const lines = rows
    .map((r) => {
      const meta = LABEL[r.unit_type] || { title: `${r.provider} · ${r.service}`, unit: 'units' };
      const displayUnits = r.unit_type.endsWith('_sec') ? r.units / 60 : r.units; // seconds -> minutes
      return {
        title: meta.title,
        unitLabel: meta.unit,
        units: displayUnits,
        calls: r.calls,
        usd: r.units * rate(r.unit_type),
      };
    })
    .sort((a, b) => b.usd - a.usd);
  const totalUsd = lines.reduce((a, l) => a + l.usd, 0);
  const since = db.prepare("SELECT MIN(created_at) t FROM api_usage WHERE provider != 'deepgram'").get()?.t || null;
  return { totalUsd, since, lines };
}

// One-time backfill so the tally reflects prior spend: the only reliable historical
// signal is the per-render TTS character counts in the logs (STT seconds and OpenAI
// tokens weren't recorded before, so those start from now).
export function seedFromLogsOnce() {
  try {
    if (db.prepare('SELECT COUNT(*) n FROM api_usage').get().n > 0) return;
    const logs = db
      .prepare("SELECT message FROM logs WHERE module='ttsCache' AND message LIKE '%cached tts%'")
      .all();
    let seeded = 0;
    for (const { message } of logs) {
      const m = message.match(/:\s*(\w+)\/[^,]+,\s*(\d+)\s*chars/);
      if (!m) continue;
      const provider = m[1];
      const unitType = provider === 'elevenlabs' ? 'elevenlabs_tts_char' : 'deepgram_tts_char';
      ins.run(provider, 'tts', unitType, Number(m[2]));
      seeded += 1;
    }
    if (seeded) log.info(`seeded ${seeded} historical TTS usage rows from logs`);
  } catch (err) {
    log.warn(`usage seed failed: ${err.message}`);
  }
}

seedFromLogsOnce();
