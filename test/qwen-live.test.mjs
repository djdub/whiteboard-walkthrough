// Opt-in: the real Qwen model on this Mac. Run after `node skills/walkthrough/scripts/build.mjs --setup-voice qwen`:
//   WALKTHROUGH_QWEN_LIVE=1 node --test test/qwen-live.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { qwenReady, qwenSynthesize } from '../skills/walkthrough/scripts/voice.mjs';

const live = process.env.WALKTHROUGH_QWEN_LIVE === '1';
test('the real model voices a sentence in the sandbox and writes playable AAC in .mp4', { skip: !live && 'set WALKTHROUGH_QWEN_LIVE=1 to run' }, async () => {
  assert.ok(qwenReady(), 'set up first: node skills/walkthrough/scripts/build.mjs --setup-voice qwen');
  const out = mkdtempSync(join(tmpdir(), 'wt-qlive-'));
  try {
    const clips = [];
    await qwenSynthesize([{ text: 'This sentence was voiced on this Mac with the network switched off.', file: '01-0123456789.mp4' }], out, { onClip: (c) => clips.push(c) });
    const f = join(out, '01-0123456789.mp4');
    assert.ok(existsSync(f));
    const info = spawnSync('afinfo', [f], { encoding: 'utf8' }).stdout;
    assert.match(info, /File type ID:\s+mp4f/);
    assert.match(info, /aac/);
    const secs = Number((info.match(/estimated duration:\s*([\d.]+)/) || [])[1]);
    assert.ok(secs > 2 && secs < 15, `duration ${secs}s`);
    assert.equal(clips.length, 1);
  } finally { rmSync(out, { recursive: true, force: true }); }
});
