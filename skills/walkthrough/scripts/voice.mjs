// Voices for the walkthrough builder: ElevenLabs (needs ELEVENLABS_API_KEY), Qwen3-TTS on this Mac (after a one-time
// --setup-voice qwen), the Mac's built-in `say`, or none at build time (the page then speaks each step with the
// reader's browser voice).
import { spawnSync, spawn } from 'node:child_process';
import { writeFileSync, statSync, existsSync, readFileSync, rmSync, mkdirSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { homedir, release as osRelease } from 'node:os';
import { fileURLToPath } from 'node:url';

const EL_API = 'https://api.elevenlabs.io';
export const EL = Object.freeze({
  model: process.env.ELEVENLABS_MODEL || 'eleven_v4_turbo',
  voiceId: process.env.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb',   // "George", one of ElevenLabs' default voices
  format: 'mp3_44100_128',
  kbps: 128,
});
export const SAY = Object.freeze({ voice: process.env.WALKTHROUGH_SAY_VOICE || 'Daniel', rate: 190 });

export const hasSay = (platform = process.platform) => platform === 'darwin' && spawnSync('which', ['say']).status === 0;

// ---- Qwen3-TTS on this Mac (mlx-audio, Apple Silicon). The model revision and every Python package are pinned
// (packages by hash, in qwen-requirements.txt), so every install voices the same way.
const SCRIPTS = dirname(fileURLToPath(import.meta.url));
export const QWEN_LOCK = join(SCRIPTS, 'qwen-requirements.txt');
export const QWEN = Object.freeze({
  model: 'mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16',
  revision: 'a6eb4f68e4b056f1215157bb696209bc82a6db48',
  packages: Object.freeze(['mlx-audio==0.6.8', 'mlx==0.32.5', 'transformers==5.24.1']),   // the top of the lock
  lock: createHash('sha256').update(readFileSync(QWEN_LOCK)).digest('hex').slice(0, 16),
  downloadGB: 4.5,
  minPython: Object.freeze([3, 11]),
  maxPython: Object.freeze([3, 14]),   // the newest Python the locked wheels cover
  minDarwin: 23,                       // macOS 14: the oldest the pinned mlx wheels support
});

export const qwenHome = () => process.env.WALKTHROUGH_HOME || join(homedir(), '.cache', 'whiteboard-walkthrough');
export function qwenPaths(home = qwenHome()) {
  const dir = join(home, 'qwen');
  return { dir, python: join(dir, 'venv', 'bin', 'python'), marker: join(dir, 'ready.json') };
}
export const appleSilicon = (platform = process.platform, arch = process.arch) => platform === 'darwin' && arch === 'arm64';
const darwinMajor = (release) => Number(String(release).split('.')[0]) || 0;

/** What a finished setup writes to its marker; a marker that differs (older pins) means "set up again". */
export const qwenMarker = () => ({ model: QWEN.model, revision: QWEN.revision, packages: [...QWEN.packages], lock: QWEN.lock });

/** Is the Qwen voice set up for these exact pins? Reads two files; never starts a process. */
export function qwenReady({ home = qwenHome(), platform = process.platform, arch = process.arch } = {}) {
  if (!appleSilicon(platform, arch)) return false;
  const p = qwenPaths(home);
  if (!existsSync(p.python)) return false;
  try {
    const m = JSON.parse(readFileSync(p.marker, 'utf8'));
    return JSON.stringify({ model: m.model, revision: m.revision, packages: m.packages, lock: m.lock }) === JSON.stringify(qwenMarker());
  } catch { return false; }
}

export const ENGINES = Object.freeze(['auto', 'elevenlabs', 'qwen', 'say', 'browser']);

/** The engine a build uses: the one asked for, or for "auto" the best one this machine has. */
export function pickEngine(requested = 'auto', { key = '', say = hasSay(), qwen = qwenReady() } = {}) {
  if (!ENGINES.includes(requested)) throw new Error(`unknown --voice ${requested} (${ENGINES.join(', ')})`);
  if (requested !== 'auto') return requested;
  if (key) return 'elevenlabs';
  if (qwen) return 'qwen';
  return say ? 'say' : 'browser';
}

/** Audio file type per engine. AAC goes in .mp4, not .m4a: claude.ai Artifacts do not serve .m4a. */
export const extFor = (engine) => (engine === 'elevenlabs' ? 'mp3' : 'mp4');

// ---- macOS say
export function saySynthesize(text, outFile, { voice = SAY.voice, rate = SAY.rate } = {}) {
  const txt = outFile + '.txt';
  writeFileSync(txt, text);
  const fmt = ['-o', outFile, '--file-format=mp4f', '--data-format=aac'];
  let r = spawnSync('say', ['-v', voice, '-r', String(rate), '-f', txt, ...fmt], { encoding: 'utf8' });
  if (r.status !== 0) r = spawnSync('say', ['-r', String(rate), '-f', txt, ...fmt], { encoding: 'utf8' });   // voice not installed: system default
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

// ---- Qwen: voicing and setup
export const QWEN_WORKER = join(SCRIPTS, 'voice_qwen.py');
export const NARRATOR = Object.freeze({ wav: join(SCRIPTS, '..', 'voices', 'narrator.wav'), json: join(SCRIPTS, '..', 'voices', 'narrator.json') });
/** The voice sample's identity for audio caching: a new sample re-voices every step. */
export const narratorHash = (wav = NARRATOR.wav) => createHash('sha256').update(readFileSync(wav)).digest('hex').slice(0, 12);
/** Cache tag for Qwen clips: a new model, revision, package lock or voice sample re-voices every step. */
export const qwenTag = () => `qwen:${QWEN.model}@${QWEN.revision}:${QWEN.lock}:${narratorHash()}`;

/** The worker runs inside macOS's sandbox with every network operation denied, so the text cannot leave the Mac. */
export const SANDBOX = Object.freeze({ exec: '/usr/bin/sandbox-exec', profile: '(version 1)(allow default)(deny network*)' });
const sandboxed = (python, args) => [SANDBOX.exec, ['-p', SANDBOX.profile, python, ...args]];

/** Everything the voice downloads stays in its own folder: the model (HF_HOME) and pip's cache. */
function qwenEnv(home, offline, env = process.env) {
  const e = { ...env, HF_HOME: join(qwenPaths(home).dir, 'hf'), PIP_CACHE_DIR: join(qwenPaths(home).dir, 'pip-cache') };
  delete e.HF_HUB_OFFLINE; delete e.TRANSFORMERS_OFFLINE;
  return offline ? { ...e, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' } : e;
}
const workerArgs = (outDir) => [QWEN_WORKER, '--model', QWEN.model, '--revision', QWEN.revision, '--out-dir', outDir, '--ref-audio', NARRATOR.wav, '--ref-text-file', NARRATOR.json];

/**
 * Voices every job in one worker run (the model loads once). jobs: [{ text, file }]. The text goes on stdin, never in
 * argv, and the worker runs sandboxed with no network. Resolves when every file exists; rejects with the worker's
 * last 20 stderr lines otherwise. Clips finished before a failure stay, so a re-run voices only the rest.
 */
export function qwenSynthesize(jobs, outDir, { home = qwenHome(), onClip = () => {} } = {}) {
  if (!existsSync(SANDBOX.exec)) return Promise.reject(new Error(`${SANDBOX.exec} is missing, so the Qwen voice cannot be kept off the network; not voicing`));
  const [cmd, args] = sandboxed(qwenPaths(home).python, workerArgs(outDir));
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { env: qwenEnv(home, true), stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '', buf = '';
    child.stderr.on('data', (d) => { err = (err + d).slice(-20000); });
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try { onClip(JSON.parse(line)); } catch { /* not a result line */ }
      }
    });
    child.on('error', (e) => reject(new Error(`could not start the Qwen voice (${e.message}); run: node build.mjs --setup-voice qwen`)));
    child.on('close', (code, signal) => {
      if (code !== 0) {
        const tail = err.trim().split('\n').slice(-20).join('\n');
        return reject(new Error(`the Qwen voice failed (${signal || 'exit ' + code}):\n${tail}`));
      }
      const missing = jobs.filter((j) => !existsSync(join(outDir, j.file)));
      if (missing.length) return reject(new Error(`the Qwen voice finished but did not write ${missing.map((j) => j.file).join(', ')}`));
      resolvePromise();
    });
    child.stdin.on('error', () => { /* worker exited early; the close handler reports it */ });
    child.stdin.end(JSON.stringify(jobs.map(({ text, file }) => ({ text, file }))));
  });
}

const pyVersion = (py, run) => {
  const r = run(py, ['-c', 'import sys; print(sys.version_info[0], sys.version_info[1])'], { encoding: 'utf8' });
  if (!r || r.status !== 0) return null;
  const [maj, min] = String(r.stdout).trim().split(' ').map(Number);
  return Number.isInteger(maj) && Number.isInteger(min) ? [maj, min] : null;
};
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1];
const inRange = (v) => v && cmp(v, QWEN.minPython) >= 0 && cmp(v, QWEN.maxPython) <= 0;
const range = () => `${QWEN.minPython.join('.')} to ${QWEN.maxPython.join('.')}`;

/** A Python the locked packages support: WALKTHROUGH_PYTHON, else the newest python3.x on PATH in range. */
export function findPython(env = process.env, run = spawnSync) {
  if (env.WALKTHROUGH_PYTHON) {
    const v = pyVersion(env.WALKTHROUGH_PYTHON, run);
    if (!inRange(v)) throw new Error(`WALKTHROUGH_PYTHON (${env.WALKTHROUGH_PYTHON}) is ${v ? 'Python ' + v.join('.') : 'not a working Python'}; the Qwen voice needs Python ${range()}`);
    return env.WALKTHROUGH_PYTHON;
  }
  for (const py of ['python3.14', 'python3.13', 'python3.12', 'python3.11', 'python3']) if (inRange(pyVersion(py, run))) return py;
  throw new Error(`the Qwen voice needs Python ${range()}, and none was found on PATH (macOS ships 3.9). Install one from python.org or your package manager, or set WALKTHROUGH_PYTHON to its path`);
}

/**
 * One-time setup. A working install is only checked (offline: the model is complete and a test sentence voices), never
 * taken apart. Otherwise a new environment is built beside the old one from the hashed lock, the model is downloaded
 * at its pinned revision, a test sentence is voiced in the sandbox, and only then is the new environment swapped in
 * and the marker written (last), so an interrupted setup is never "ready". Safe to run again.
 */
export function qwenSetup({ home = qwenHome(), platform = process.platform, arch = process.arch, release = osRelease(), env = process.env, log = console.log, run = spawnSync, rename = renameSync } = {}) {
  if (!appleSilicon(platform, arch)) throw new Error('the Qwen voice needs a Mac with Apple Silicon (M1 or later); use --voice say or --voice browser');
  if (darwinMajor(release) < QWEN.minDarwin) throw new Error('the Qwen voice needs macOS 14 (Sonoma) or later; use --voice say or --voice browser');
  if (!existsSync(SANDBOX.exec)) throw new Error(`${SANDBOX.exec} is missing, so the Qwen voice cannot be kept off the network`);
  const p = qwenPaths(home);
  const step = (what, cmd, args, opts = {}) => {
    log(what);
    const r = run(cmd, args, { stdio: 'inherit', ...opts });
    if (!r || r.error || r.status !== 0) throw new Error(`setup failed while ${what.toLowerCase().replace(/[.…]+$/, '')} (${r?.error ? r.error.message : 'exit ' + r?.status})`);
  };
  const smoke = (python) => {
    const out = join(p.dir, 'smoke');
    rmSync(out, { recursive: true, force: true });
    const [cmd, args] = sandboxed(python, workerArgs(out));
    step('Voicing a test sentence with the network off…', cmd, args,
      { env: qwenEnv(home, true, env), input: JSON.stringify([{ text: 'The walkthrough voice is ready.', file: '01-0000000000.mp4' }]), stdio: ['pipe', 'ignore', 'inherit'] });
    const ok = existsSync(join(out, '01-0000000000.mp4'));
    rmSync(out, { recursive: true, force: true });
    if (!ok) throw new Error('setup failed: the test sentence produced no audio');
  };

  const venv = dirname(dirname(p.python)), old = join(p.dir, 'venv.old'), staging = join(p.dir, 'venv.new');
  if (!existsSync(venv) && existsSync(old)) { rename(old, venv); log('Recovered the environment from an interrupted setup.'); }

  if (qwenReady({ home, platform, arch })) {
    log(`The Qwen voice is already set up in ${p.dir}; checking it (offline).`);
    try {
      const [cmd, args] = sandboxed(p.python, [QWEN_WORKER, '--download', '--offline', '--model', QWEN.model, '--revision', QWEN.revision]);
      step('Checking the model is complete…', cmd, args, { env: qwenEnv(home, true, env) });
      smoke(p.python);
    } catch (e) {
      rmSync(p.marker, { force: true });
      throw new Error(`${e.message}. The install failed its check; run --setup-voice qwen again to rebuild it`);
    }
    log('The Qwen voice is ready.');
    return;
  }

  log(`Setting up the Qwen voice in ${p.dir}: ${QWEN.packages.join(', ')} and their dependencies (pinned by hash), and the Qwen3-TTS model (about ${QWEN.downloadGB} GB), downloaded once from PyPI and Hugging Face. Everything it downloads stays in that folder; delete it to remove the voice.`);
  const python = findPython(env, run);
  mkdirSync(p.dir, { recursive: true });
  const stagedPython = join(staging, 'bin', 'python');
  rmSync(staging, { recursive: true, force: true });
  step('Making a Python environment…', python, ['-m', 'venv', staging]);
  step('Installing the Python packages…', stagedPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '--quiet', '--require-hashes', '--only-binary', ':all:', '--no-deps', '-r', QWEN_LOCK], { env: qwenEnv(home, false, env) });
  step(`Downloading the model (about ${QWEN.downloadGB} GB the first time)…`, stagedPython, [QWEN_WORKER, '--download', '--model', QWEN.model, '--revision', QWEN.revision], { env: qwenEnv(home, false, env) });
  smoke(stagedPython);
  // Promote: the old environment moves aside, the new one takes its place, then the marker is written. The marker on
  // disk always describes the environment beside it (or none), so a crash at any point leaves either the old install,
  // a not-ready state, or the new install; a stranded venv.old is put back at the next start (above).
  rmSync(old, { recursive: true, force: true });   // safe: venv exists here, so venv.old is a finished setup's leftover
  if (existsSync(venv)) rename(venv, old);
  try { rename(staging, venv); } catch (e) {
    if (!existsSync(venv) && existsSync(old)) rename(old, venv);
    throw new Error(`setup failed while swapping in the new environment (${e.message}); the previous one is back in place`);
  }
  writeFileSync(p.marker, JSON.stringify({ ...qwenMarker(), set_up_at: new Date().toISOString() }, null, 2) + '\n');
  rmSync(old, { recursive: true, force: true });
  log('The Qwen voice is ready. Builds pick it automatically, or ask for it with --voice qwen.');
}
