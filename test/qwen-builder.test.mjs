// The Qwen voice without the model: a fake venv python obeys the worker protocol, and setup runs with an injected
// command runner. The builder's own tests; test/qwen.test.mjs holds Codex's, written from the spec.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, chmodSync, existsSync, readdirSync, copyFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { build } from '../skills/walkthrough/scripts/build.mjs';
import { QWEN, qwenPaths, qwenMarker, qwenReady, qwenSetup, qwenTag, findPython } from '../skills/walkthrough/scripts/voice.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLE = join(ROOT, 'skills/walkthrough/examples/order-refunds.json');
const onAppleSilicon = process.platform === 'darwin' && process.arch === 'arm64';
const quiet = () => {};
let home, saved;

// A fake worker: logs each run, writes every job's file (or fails as FAKE_MODE says).
const FAKE = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2), out = args[args.indexOf('--out-dir') + 1];
const jobs = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.appendFileSync(path.join(process.env.WALKTHROUGH_HOME, 'runs.jsonl'), JSON.stringify({ args, jobs: jobs.map(j => j.file), offline: process.env.HF_HUB_OFFLINE }) + '\\n');
const mode = fs.existsSync(path.join(process.env.WALKTHROUGH_HOME, 'mode')) ? fs.readFileSync(path.join(process.env.WALKTHROUGH_HOME, 'mode'), 'utf8') : 'ok';
jobs.forEach((j, i) => {
  if (mode === 'fail' && i === 1) { for (let k = 0; k < 30; k++) console.error('noise ' + k); console.error('the model fell over'); process.exit(3); }
  if (mode === 'skip' && i === 0) return;
  fs.writeFileSync(path.join(out, j.file), 'audio');
  console.log(JSON.stringify({ file: j.file, audio_s: 1 }));
});
`;

function install(h, marker = qwenMarker()) {
  const p = qwenPaths(h);
  mkdirSync(dirname(p.python), { recursive: true });
  writeFileSync(p.python, FAKE); chmodSync(p.python, 0o755);
  if (marker) writeFileSync(p.marker, JSON.stringify(marker));
  return p;
}
const runs = () => existsSync(join(home, 'runs.jsonl')) ? readFileSync(join(home, 'runs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [];
const specCopy = () => { const d = mkdtempSync(join(tmpdir(), 'wt-qspec-')); const p = join(d, 'order-refunds.json'); copyFileSync(EXAMPLE, p); return { d, p }; };

beforeEach(() => {
  saved = { home: process.env.WALKTHROUGH_HOME, key: process.env.ELEVENLABS_API_KEY };
  home = mkdtempSync(join(tmpdir(), 'wt-qhome-'));
  process.env.WALKTHROUGH_HOME = home;
  delete process.env.ELEVENLABS_API_KEY;
});
afterEach(() => {
  for (const [k, v] of [['WALKTHROUGH_HOME', saved.home], ['ELEVENLABS_API_KEY', saved.key]]) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

test('qwenReady: only on Apple Silicon, with the venv python and a marker for these exact pins', () => {
  assert.equal(qwenReady({ home, platform: 'darwin', arch: 'arm64' }), false);   // nothing installed
  install(home);
  assert.equal(qwenReady({ home, platform: 'darwin', arch: 'arm64' }), true);
  assert.equal(qwenReady({ home, platform: 'darwin', arch: 'x64' }), false);
  assert.equal(qwenReady({ home, platform: 'linux', arch: 'arm64' }), false);
  writeFileSync(qwenPaths(home).marker, JSON.stringify({ ...qwenMarker(), revision: 'old' }));
  assert.equal(qwenReady({ home, platform: 'darwin', arch: 'arm64' }), false);   // set up for older pins
  writeFileSync(qwenPaths(home).marker, '{not json');
  assert.equal(qwenReady({ home, platform: 'darwin', arch: 'arm64' }), false);
});

test('--voice qwen without setup says how to set it up', async () => {
  const { p } = specCopy();
  await assert.rejects(build([p, '--voice', 'qwen'], quiet), onAppleSilicon ? /--setup-voice qwen/ : /Apple Silicon/);
});

test('one worker run voices every step offline, text on stdin, and a re-run voices nothing', { skip: !onAppleSilicon }, async () => {
  install(home);
  const { p, d } = specCopy();
  const r = await build([p, '--voice', 'qwen'], quiet);
  assert.equal(r.engine, 'qwen');
  const audio = readdirSync(join(d, 'order-refunds', 'audio'));
  assert.equal(audio.filter((f) => /^\d{2}-[0-9a-f]{10}\.mp4$/.test(f)).length, 8);
  const [run] = runs();
  assert.equal(runs().length, 1);
  assert.equal(run.jobs.length, 8);
  assert.equal(run.offline, '1');
  const spec = JSON.parse(readFileSync(p, 'utf8'));
  for (const s of spec.steps) assert.ok(!run.args.some((a) => a.includes(s.say.slice(0, 30))), 'step text must not be in argv');
  assert.equal((await build([p, '--voice', 'qwen'], quiet)).todo, 0);
  assert.equal(runs().length, 1);
  spec.steps[3].say += ' One more sentence.';
  writeFileSync(p, JSON.stringify(spec));
  await build([p, '--voice', 'qwen'], quiet);
  assert.deepEqual(runs()[1].jobs.length, 1);
});

test('auto picks Qwen when it is set up, and when an ElevenLabs key comes without --ok-to-send', { skip: !onAppleSilicon }, async () => {
  install(home);
  const { p } = specCopy();
  assert.equal((await build([p, '--dry-run'], quiet)).engine, 'qwen');
  process.env.ELEVENLABS_API_KEY = 'k';
  const lines = [];
  assert.equal((await build([p, '--dry-run'], (l) => lines.push(l))).engine, 'qwen');
  assert.ok(lines.some((l) => /using the Qwen voice instead/.test(l)));
});

test('a worker failure fails the build with its last 20 stderr lines and keeps finished clips', { skip: !onAppleSilicon }, async () => {
  install(home);
  writeFileSync(join(home, 'mode'), 'fail');
  const { p, d } = specCopy();
  await assert.rejects(build([p, '--voice', 'qwen'], quiet), (e) => /the model fell over/.test(e.message) && !/noise 5\b/.test(e.message) && /noise 29/.test(e.message));
  assert.equal(readdirSync(join(d, 'order-refunds', 'audio')).length, 1);
  writeFileSync(join(home, 'mode'), 'ok');
  await build([p, '--voice', 'qwen'], quiet);
  assert.equal(runs().at(-1).jobs.length, 7);   // only what was missing
});

test('a worker that exits 0 without writing a clip fails the build naming it', { skip: !onAppleSilicon }, async () => {
  install(home);
  writeFileSync(join(home, 'mode'), 'skip');
  const { p } = specCopy();
  await assert.rejects(build([p, '--voice', 'qwen'], quiet), /did not write 01-[0-9a-f]{10}\.mp4/);
});

test('--setup-voice takes only qwen', async () => {
  await assert.rejects(build(['--setup-voice', 'say'], quiet), /--setup-voice takes qwen/);
  await assert.rejects(build(['--setup-voice'], quiet), /--setup-voice takes qwen/);
});

test('setup refuses off Apple Silicon, and before macOS 14', () => {
  const never = () => assert.fail('must not run anything');
  assert.throws(() => qwenSetup({ home, platform: 'linux', arch: 'x64', log: quiet, run: never }), /Apple Silicon/);
  assert.throws(() => qwenSetup({ home, platform: 'darwin', arch: 'arm64', release: '22.6.0', log: quiet, run: never }), /macOS 14/);
});

// A stand-in for every command setup runs: Python version probes, venv, pip, download, and the sandboxed smoke test.
function fakeRun({ failOn = null } = {}) {
  const calls = [];
  const run = (cmd, args, opts = {}) => {
    const what = args.includes('-c') ? 'version' : args.includes('venv') ? 'venv' : args.includes('pip') ? 'pip'
      : args.includes('--download') ? (args.includes('--offline') ? 'check' : 'download') : args.includes('--out-dir') ? 'smoke' : 'other';
    calls.push({ what, cmd, args, env: opts.env });
    if (what === failOn) return { status: 1 };
    if (what === 'version') return { status: 0, stdout: '3 12\n' };
    if (what === 'venv') { const py = join(args[args.indexOf('venv') + 1], 'bin', 'python'); mkdirSync(dirname(py), { recursive: true }); writeFileSync(py, ''); }
    if (what === 'smoke') { const o = args[args.indexOf('--out-dir') + 1]; mkdirSync(o, { recursive: true }); writeFileSync(join(o, '01-0000000000.mp4'), 'a'); }
    return { status: 0 };
  };
  return { run, calls };
}
const mac = { platform: 'darwin', arch: 'arm64', release: '25.3.0', log: quiet };

test('a fresh setup installs from the hashed lock, downloads at the pinned revision, smoke-tests in the sandbox, then marks ready', { skip: !onAppleSilicon && 'sandbox-exec is macOS-only' }, () => {
  const { run, calls } = fakeRun();
  qwenSetup({ home, ...mac, env: { HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' }, run });
  assert.deepEqual(calls.map((c) => c.what).filter((w) => w !== 'version'), ['venv', 'pip', 'download', 'smoke']);
  const pip = calls.find((c) => c.what === 'pip');
  for (const f of ['--require-hashes', '--no-deps', '--only-binary', ':all:', '-r']) assert.ok(pip.args.includes(f), f);
  assert.ok(pip.args.at(-1).endsWith('qwen-requirements.txt'));
  assert.equal(pip.env.PIP_CACHE_DIR, join(home, 'qwen', 'pip-cache'));
  const dl = calls.find((c) => c.what === 'download');
  assert.ok(dl.args.includes('a6eb4f68e4b056f1215157bb696209bc82a6db48'));
  assert.equal(dl.env.HF_HUB_OFFLINE, undefined, 'a user\'s offline flags must not break the download');
  assert.equal(dl.env.HF_HOME, join(home, 'qwen', 'hf'));
  const smoke = calls.find((c) => c.what === 'smoke');
  assert.equal(smoke.cmd, '/usr/bin/sandbox-exec');
  assert.match(smoke.args[1], /deny network\*/);
  assert.equal(qwenReady({ home, platform: 'darwin', arch: 'arm64' }), true);
  assert.equal(existsSync(join(home, 'qwen', 'venv.new')), false);
});

test('a failed fresh setup leaves no marker and no half-built environment in place', { skip: !onAppleSilicon && 'sandbox-exec is macOS-only' }, () => {
  for (const failOn of ['pip', 'download', 'smoke']) {
    const { run } = fakeRun({ failOn });
    assert.throws(() => qwenSetup({ home, ...mac, env: {}, run }), /setup failed/);
    assert.equal(existsSync(qwenPaths(home).marker), false, failOn);
    assert.equal(existsSync(qwenPaths(home).python), false, failOn);
  }
});

test('re-running setup on a working install only checks it, offline, and keeps it when the check passes', { skip: !onAppleSilicon && 'sandbox-exec is macOS-only' }, () => {
  install(home);
  const before = readFileSync(qwenPaths(home).marker, 'utf8');
  const { run, calls } = fakeRun();
  qwenSetup({ home, ...mac, env: {}, run });
  assert.deepEqual(calls.map((c) => c.what), ['check', 'smoke']);
  assert.ok(calls.every((c) => c.env.HF_HUB_OFFLINE === '1'));
  assert.ok(calls.every((c) => c.cmd === '/usr/bin/sandbox-exec' && /deny network\*/.test(c.args[1])), 'both run with the network denied');
  assert.equal(readFileSync(qwenPaths(home).marker, 'utf8'), before);
  const failing = fakeRun({ failOn: 'check' });
  assert.throws(() => qwenSetup({ home, ...mac, env: {}, run: failing.run }), /failed its check/);
  assert.equal(qwenReady({ home, platform: 'darwin', arch: 'arm64' }), false, 'a broken install is no longer ready');
});

test('swapping in a new environment: a failed rename puts the old one back; a stranded old one is recovered', { skip: !onAppleSilicon && 'sandbox-exec is macOS-only' }, () => {
  const p = install(home, { ...qwenMarker(), lock: 'older' });   // an old install, not ready for these pins
  writeFileSync(p.python, 'OLD');
  let n = 0;
  const failSecond = (a, b) => { n += 1; if (n === 2) throw new Error('disk said no'); renameSync(a, b); };
  assert.throws(() => qwenSetup({ home, ...mac, env: {}, run: fakeRun().run, rename: failSecond }), /previous one is back in place/);
  assert.equal(readFileSync(p.python, 'utf8'), 'OLD');
  assert.equal(qwenReady({ home, platform: 'darwin', arch: 'arm64' }), false);
  // a crash between the two renames leaves only venv.old: the next setup puts it back first, then rebuilds
  renameSync(dirname(dirname(p.python)), join(home, 'qwen', 'venv.old'));
  const logs = [];
  qwenSetup({ home, ...mac, env: {}, run: fakeRun().run, log: (l) => logs.push(l) });
  assert.ok(logs.some((l) => /Recovered the environment/.test(l)));
  assert.equal(qwenReady({ home, platform: 'darwin', arch: 'arm64' }), true);
  assert.equal(existsSync(join(home, 'qwen', 'venv.old')), false);
  assert.equal(existsSync(join(home, 'qwen', 'venv.new')), false);
});

test('the Qwen cache tag changes with the package lock, so a new runtime re-voices every step', () => {
  assert.ok(qwenTag().includes(QWEN.lock));
  assert.ok(qwenTag().includes(QWEN.revision));
});

test('the worker cannot open a network connection, not even to this machine', { skip: !onAppleSilicon && 'sandbox-exec is macOS-only' }, async () => {
  const server = createServer((s) => s.end()).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const p = install(home);
    writeFileSync(p.python, `#!/usr/bin/env node
const fs = require('fs'), path = require('path'), net = require('net');
const args = process.argv.slice(2), out = args[args.indexOf('--out-dir') + 1];
const jobs = JSON.parse(fs.readFileSync(0, 'utf8'));
const s = net.connect(${server.address().port}, '127.0.0.1');
const done = (result) => { fs.writeFileSync(path.join(process.env.WALKTHROUGH_HOME, 'net'), result); for (const j of jobs) fs.writeFileSync(path.join(out, j.file), 'a'); process.exit(0); };
s.on('connect', () => done('connected')); s.on('error', (e) => done('blocked: ' + e.code)); setTimeout(() => done('timeout'), 3000);
`);
    const { p: spec } = specCopy();
    await build([spec, '--voice', 'qwen'], quiet);
    assert.match(readFileSync(join(home, 'net'), 'utf8'), /^blocked/);
  } finally { server.close(); }
});

test('findPython: only Python 3.11 to 3.14, by WALKTHROUGH_PYTHON or the newest on PATH', () => {
  const at = (versions) => (py) => ({ status: versions[py] ? 0 : 1, stdout: versions[py] || '' });
  const run = (map) => (py) => at(map)(py);
  assert.throws(() => findPython({ WALKTHROUGH_PYTHON: '/x/py' }, run({ '/x/py': '3 9' })), /is Python 3\.9; the Qwen voice needs Python 3\.11 to 3\.14/);
  assert.throws(() => findPython({ WALKTHROUGH_PYTHON: '/x/py' }, run({ '/x/py': '3 15' })), /is Python 3\.15/);
  assert.throws(() => findPython({ WALKTHROUGH_PYTHON: '/x/py' }, run({})), /not a working Python/);
  assert.equal(findPython({ WALKTHROUGH_PYTHON: '/x/py' }, run({ '/x/py': '3 11' })), '/x/py');
  assert.equal(findPython({}, run({ 'python3.13': '3 13', python3: '3 15' })), 'python3.13');
  assert.equal(findPython({}, run({ python3: '3 12' })), 'python3');
  assert.throws(() => findPython({}, run({ python3: '3 9' })), /none was found/);
});
