// Voices for the walkthrough builder: ElevenLabs (needs ELEVENLABS_API_KEY), the Mac's built-in `say`, or none at
// build time (the page then speaks each step with the reader's browser voice).
import { spawnSync } from 'node:child_process';
import { writeFileSync, statSync } from 'node:fs';

const EL_API = 'https://api.elevenlabs.io';
export const EL = Object.freeze({
  model: process.env.ELEVENLABS_MODEL || 'eleven_v4_turbo',
  voiceId: process.env.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb',   // "George", one of ElevenLabs' default voices
  format: 'mp3_44100_128',
  kbps: 128,
});
export const SAY = Object.freeze({ voice: process.env.WALKTHROUGH_SAY_VOICE || 'Daniel', rate: 190 });

export const hasSay = (platform = process.platform) => platform === 'darwin' && spawnSync('which', ['say']).status === 0;

/** The engine a build uses: the one asked for, or for "auto" the best one this machine has. */
export function pickEngine(requested = 'auto', { key = '', say = hasSay() } = {}) {
  if (!['auto', 'elevenlabs', 'say', 'browser'].includes(requested)) throw new Error(`unknown --voice ${requested} (auto, elevenlabs, say, browser)`);
  if (requested !== 'auto') return requested;
  if (key) return 'elevenlabs';
  return say ? 'say' : 'browser';
}

export const extFor = (engine) => (engine === 'say' ? 'm4a' : 'mp3');

// ---- macOS say
export function saySynthesize(text, outFile, { voice = SAY.voice, rate = SAY.rate } = {}) {
  const txt = outFile + '.txt';
  writeFileSync(txt, text);
  let r = spawnSync('say', ['-v', voice, '-r', String(rate), '-f', txt, '-o', outFile, '--data-format=aac'], { encoding: 'utf8' });
  if (r.status !== 0) r = spawnSync('say', ['-r', String(rate), '-f', txt, '-o', outFile, '--data-format=aac'], { encoding: 'utf8' });   // voice not installed: system default
  spawnSync('rm', ['-f', txt]);
  if (r.status !== 0) throw new Error(`say failed: ${r.stderr}`);
  return outFile;
}

// ---- ElevenLabs
const el = (key, path, init = {}) => fetch(EL_API + path, { ...init, headers: { 'xi-api-key': key, ...(init.headers || {}) } });

export async function elBalance(key) {
  try {
    const r = await el(key, '/v1/user/subscription');
    if (!r.ok) return null;
    const j = await r.json();
    return { tier: j.tier, remaining: j.character_limit - j.character_count };
  } catch { return null; }
}

export async function elSynthesize(key, text, outFile, { model = EL.model, voiceId = EL.voiceId } = {}) {
  const r = await el(key, `/v1/text-to-speech/${voiceId}?output_format=${EL.format}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, model_id: model }),
  });
  if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${(await r.text()).slice(0, 200)}`);
  writeFileSync(outFile, Buffer.from(await r.arrayBuffer()));
  return { historyItemId: r.headers.get('history-item-id') };
}

// The exact charge sits on the history item, which is readable a moment after generation returns.
export async function elCharge(key, id, { tries = 5, delayMs = 1500 } = {}) {
  for (let i = 0; i < tries; i++) {
    try { const r = await el(key, `/v1/history/${id}`); if (r.ok) { const h = await r.json(); return h.character_count_change_to - h.character_count_change_from; } } catch { /* retry */ }
    await new Promise((res) => setTimeout(res, delayMs));
  }
  return null;
}

/** Deletes the history item so ElevenLabs does not keep the text. */
export async function elDelete(key, id) {
  try { return (await el(key, `/v1/history/${id}`, { method: 'DELETE' })).ok; } catch { return false; }
}

// ---- durations
/** Seconds of speech in an audio file: afinfo on a Mac, else the constant-bitrate MP3 size. */
export function audioSeconds(file) {
  const r = spawnSync('afinfo', [file], { encoding: 'utf8' });
  const m = (r.stdout || '').match(/estimated duration:\s*([\d.]+)\s*sec/);
  if (m) return Math.round(Number(m[1]));
  return file.endsWith('.mp3') ? Math.round(statSync(file).size * 8 / (EL.kbps * 1000)) : 0;
}

/** Rough seconds for a browser voice reading the text (about 155 words a minute). */
export const estimateSeconds = (text) => Math.round(text.trim().split(/\s+/).length / 155 * 60);
