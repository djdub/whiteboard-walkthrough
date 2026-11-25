// Written by Codex from the feature's spec before it read the implementation (an independent check on the builder's own tests).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { build, GENERATED_AUDIO } from '../skills/walkthrough/scripts/build.mjs';
import { QWEN, extFor, pickEngine, qwenPaths, qwenReady } from '../skills/walkthrough/scripts/voice.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// The fake-worker tests run the worker through macOS's sandbox-exec, so they need an Apple Silicon Mac.
const macOnly = process.platform === 'darwin' && process.arch === 'arm64' ? {} : { skip: 'needs an Apple Silicon Mac (sandbox-exec)' };
const EXAMPLE = join(ROOT, 'skills/walkthrough/examples/order-refunds.json');
const quiet = () => {};
const example = () => JSON.parse(readFileSync(EXAMPLE, 'utf8'));
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'wt-qwen-test-'));
  const p = join(d, 'order-refunds.json');
  copyFileSync(EXAMPLE, p);
  return { d, p };
};

const withEnv = async (values, fn) => {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.entries(values).forEach(([key, value]) => {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  });
  try { return await fn(); }
  finally {
    Object.entries(saved).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    });
  }
};

const marker = () => ({ packages: QWEN.packages, model: QWEN.model, revision: QWEN.revision, lock: QWEN.lock });   // lock: added to the spec in review

// This is an executable Node program placed at qwen/venv/bin/python.  It acts
// like voice_qwen.py from the build's point of view, without importing Python
// or a model.
const fakePython = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  const out = args[args.indexOf('--out-dir') + 1];
  const jobs = JSON.parse(input);
  const record = { argv: args, stdin: input, env: { HF_HUB_OFFLINE: process.env.HF_HUB_OFFLINE, TRANSFORMERS_OFFLINE: process.env.TRANSFORMERS_OFFLINE }, jobs };
  if (process.env.WT_QWEN_LOG) fs.appendFileSync(process.env.WT_QWEN_LOG, JSON.stringify(record) + '\\n');
  const mode = process.env.WT_QWEN_MODE || 'ok';
  jobs.forEach((job, index) => {
    if (mode === 'missing' && index === jobs.length - 1) {
      if (process.env.WT_QWEN_LOG) fs.appendFileSync(process.env.WT_QWEN_LOG, JSON.stringify({ missing: job.file }) + '\\n');
      return;
    }
    if (mode === 'fail' && index > 0) return;
    fs.writeFileSync(path.join(out, job.file), 'fake audio: ' + job.text);
    console.log(JSON.stringify({ file: job.file, audio_s: 1 }));
  });
  if (mode === 'fail') {
    for (let i = 1; i <= 25; i++) console.error('fake worker stderr line ' + i);
    process.exitCode = 7;
  }
});
`;

const installFakeQwen = (home) => {
  const paths = qwenPaths(home);
  mkdirSync(dirname(paths.python), { recursive: true });
  writeFileSync(paths.python, fakePython);
  chmodSync(paths.python, 0o755);
  writeFileSync(paths.marker, JSON.stringify(marker()));
  return paths;
};

const records = (log) => existsSync(log)
  ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter((r) => r.argv)
  : [];

test('pickEngine has the specified auto order and returns each named engine unchanged', () => {
  assert.equal(pickEngine('auto', { key: 'key', qwen: true, say: true }), 'elevenlabs');
  assert.equal(pickEngine('auto', { key: '', qwen: true, say: true }), 'qwen');
  assert.equal(pickEngine('auto', { key: '', qwen: false, say: true }), 'say');
  assert.equal(pickEngine('auto', { key: '', qwen: false, say: false }), 'browser');
  for (const engine of ['elevenlabs', 'qwen', 'say', 'browser']) {
    assert.equal(pickEngine(engine, { key: 'key', qwen: true, say: true }), engine);
  }
  assert.throws(() => pickEngine('robot'), /auto.*elevenlabs.*qwen.*say.*browser/i);
});

test('extFor uses browser-compatible audio extensions', () => {
  assert.equal(extFor('elevenlabs'), 'mp3');
  assert.equal(extFor('qwen'), 'mp4');
  assert.equal(extFor('say'), 'mp4');
});

test('QWEN pins are the frozen Qwen release selected by the spec', () => {
  assert.equal(QWEN.model, 'mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16');
  assert.equal(QWEN.revision, 'a6eb4f68e4b056f1215157bb696209bc82a6db48');
  assert.deepEqual(QWEN.packages, ['mlx-audio==0.6.8', 'mlx==0.32.5', 'transformers==5.24.1']);
  assert.equal(QWEN.downloadGB, 4.5);
  assert.deepEqual(QWEN.minPython, [3, 11]);
});

test('qwenPaths uses WALKTHROUGH_HOME and has the prescribed layout', async () => {
  const home = join(tmpdir(), 'wt-qwen-paths-home');
  await withEnv({ WALKTHROUGH_HOME: home }, async () => {
    assert.deepEqual(qwenPaths(), {
      dir: join(home, 'qwen'),
      python: join(home, 'qwen', 'venv', 'bin', 'python'),
      marker: join(home, 'qwen', 'ready.json'),
    });
  });
});

test('qwenReady requires Apple Silicon, the venv python, and an exact current marker', () => {
  const home = mkdtempSync(join(tmpdir(), 'wt-qwen-ready-'));
  const paths = qwenPaths(home);
  const ready = () => qwenReady({ home, platform: 'darwin', arch: 'arm64' });
  try {
    assert.equal(ready(), false, 'no python or marker');
    mkdirSync(dirname(paths.python), { recursive: true });
    writeFileSync(paths.python, '#!/not/a/real/python');
    assert.equal(ready(), false, 'marker is required');
    writeFileSync(paths.marker, '{not json');
    assert.equal(ready(), false, 'marker must parse');
    writeFileSync(paths.marker, JSON.stringify({ ...marker(), revision: 'old-pin' }));
    assert.equal(ready(), false, 'stale pins are not ready');
    writeFileSync(paths.marker, JSON.stringify(marker()));
    assert.equal(ready(), true);
    assert.equal(qwenReady({ home, platform: 'linux', arch: 'arm64' }), false);
    assert.equal(qwenReady({ home, platform: 'darwin', arch: 'x64' }), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('GENERATED_AUDIO recognizes only generated mp3, m4a, and mp4 clip names', () => {
  for (const file of ['01-0123456789.mp3', '99-abcdef0123.m4a', '12-0123abcdef.mp4', '001-0123456789.mp4']) {   // two or three digits: walkthroughs past 99 steps
    assert.equal(GENERATED_AUDIO.test(file), true, file);
  }
  for (const file of ['1-0123456789.mp4', '0001-0123456789.mp4', '01-012345678.mp4', '01-0123456789.wav', 'theme-song.mp3', '01-0123456789.mp4.bak']) {
    assert.equal(GENERATED_AUDIO.test(file), false, file);
  }
});

test('--voice qwen explains how to install it when no ready install exists', async () => {
  const { d, p } = scratch();
  const home = join(d, 'empty-home');
  try {
    await withEnv({ WALKTHROUGH_HOME: home }, async () => {
      await assert.rejects(build([p, '--voice', 'qwen', '--dry-run'], quiet), macOnly.skip ? /Apple Silicon/ : /--setup-voice qwen/);
    });
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a ready fake Qwen worker receives all jobs on stdin and reuses cached clips', macOnly, async () => {
  const { d, p } = scratch();
  const home = join(d, 'home');
  const log = join(d, 'worker-log.jsonl');
  const out = join(d, 'site');
  installFakeQwen(home);
  try {
    await withEnv({ WALKTHROUGH_HOME: home, WT_QWEN_LOG: log, WT_QWEN_MODE: undefined, ELEVENLABS_API_KEY: undefined }, async () => {
      const first = await build([p, '--voice', 'qwen', '--out', out], quiet);
      assert.equal(first.engine, 'qwen');
      assert.equal(first.todo, example().steps.length);
      const firstRecords = records(log);
      assert.equal(firstRecords.length, 1, 'one model process serves all first-run steps');
      const run = firstRecords[0];
      assert.equal(run.jobs.length, example().steps.length);
      assert.ok(run.argv.includes('--out-dir'));
      assert.ok(run.argv.includes('--ref-audio'));
      assert.ok(run.argv.includes('--ref-text-file'));
      assert.ok(run.argv.some((a) => a.endsWith('narrator.wav')));
      assert.ok(run.argv.some((a) => a.endsWith('narrator.json')));
      assert.ok(!run.argv.some((a) => a.includes('"text"')), 'jobs are never command-line arguments');
      assert.deepEqual(JSON.parse(run.stdin), run.jobs);
      assert.equal(run.env.HF_HUB_OFFLINE, '1');
      assert.equal(run.env.TRANSFORMERS_OFFLINE, '1');
      assert.equal(readdirSync(join(out, 'audio')).filter((f) => f.endsWith('.mp4')).length, example().steps.length);

      const again = await build([p, '--voice', 'qwen', '--out', out], quiet);
      assert.equal(again.todo, 0);
      assert.equal(records(log).length, 1, 'no worker is started for unchanged steps');

      const edited = example();
      edited.steps[0].say += ' This edit needs a new clip.';
      writeFileSync(p, JSON.stringify(edited));
      const changed = await build([p, '--voice', 'qwen', '--out', out], quiet);
      assert.equal(changed.todo, 1);
      const afterEdit = records(log);
      assert.equal(afterEdit.length, 2);
      assert.equal(afterEdit[1].jobs.length, 1, 'only the edited step is sent again');
    });
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a failed Qwen worker reports its stderr tail and preserves completed clips for retry', macOnly, async () => {
  const { d, p } = scratch();
  const home = join(d, 'home');
  const out = join(d, 'site');
  const log = join(d, 'worker-log.jsonl');
  installFakeQwen(home);
  try {
    await withEnv({ WALKTHROUGH_HOME: home, WT_QWEN_LOG: log, WT_QWEN_MODE: 'fail' }, async () => {
      await assert.rejects(build([p, '--voice', 'qwen', '--out', out], quiet), /fake worker stderr line 25/);
      assert.equal(readdirSync(join(out, 'audio')).filter((f) => f.endsWith('.mp4')).length, 1, 'finished clip remains');
      process.env.WT_QWEN_MODE = 'ok';
      const retry = await build([p, '--voice', 'qwen', '--out', out], quiet);
      assert.equal(retry.todo, example().steps.length - 1, 'retry sends only unfinished clips');
    });
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a zero-exit Qwen worker that omits a requested clip fails naming that clip', macOnly, async () => {
  const { d, p } = scratch();
  const home = join(d, 'home');
  const out = join(d, 'site');
  const log = join(d, 'worker-log.jsonl');
  installFakeQwen(home);
  try {
    await withEnv({ WALKTHROUGH_HOME: home, WT_QWEN_LOG: log, WT_QWEN_MODE: 'missing' }, async () => {
      await assert.rejects(build([p, '--voice', 'qwen', '--out', out], quiet), /\d\d-[0-9a-f]{10}\.mp4/);
      const missing = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).find((r) => r.missing).missing;
      assert.ok(!existsSync(join(out, 'audio', missing)));
    });
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('auto selects ready Qwen without an ElevenLabs key, and without consent it falls back to Qwen', macOnly, async () => {
  const { d, p } = scratch();
  const home = join(d, 'home');
  installFakeQwen(home);
  try {
    await withEnv({ WALKTHROUGH_HOME: home, WT_QWEN_LOG: join(d, 'worker-log.jsonl'), WT_QWEN_MODE: undefined, ELEVENLABS_API_KEY: undefined }, async () => {
      const local = await build([p, '--dry-run'], quiet);
      assert.equal(local.engine, 'qwen');
      process.env.ELEVENLABS_API_KEY = 'key-that-must-not-be-used';
      const noConsent = await build([p, '--dry-run'], quiet);
      assert.equal(noConsent.engine, 'qwen');
    });
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('--setup-voice rejects values other than qwen without needing a spec', async () => {
  await assert.rejects(build(['--setup-voice', 'other'], quiet), /qwen/i);
});

test('setup refuses non-Apple-Silicon hosts', { skip: 'build() has no platform/arch injection; do not mutate process.platform in an acceptance test' }, () => {});
