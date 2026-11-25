// Run with: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, existsSync, readdirSync, copyFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { validate, renderPage, build, GENERATED_AUDIO } from '../skills/walkthrough/scripts/build.mjs';
import { pickEngine, estimateSeconds } from '../skills/walkthrough/scripts/voice.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLE = join(ROOT, 'skills/walkthrough/examples/order-refunds.json');
const example = () => JSON.parse(readFileSync(EXAMPLE, 'utf8'));
const quiet = () => {};
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'wt-test-')); const p = join(d, 'order-refunds.json'); copyFileSync(EXAMPLE, p); return { d, p }; };

test('the example spec is clean: no errors, no warnings', () => {
  const { errors, warnings } = validate(example());
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('validate catches duplicate ids, dangling edges, bad highlights and bad kinds', () => {
  const s = example();
  s.board.nodes.push({ ...s.board.nodes[0] });
  s.board.edges.push({ id: 'e_bad', from: 'order', to: 'nowhere', via: [[0, 0], [1, 1]] });
  s.board.nodes[1].kind = 'shiny';
  s.steps[0].highlight = ['ghost'];
  const { errors } = validate(s);
  assert.ok(errors.some((e) => e.includes('duplicate id order')));
  assert.ok(errors.some((e) => e.includes('e_bad: to nowhere')));
  assert.ok(errors.some((e) => e.includes('kind shiny')));
  assert.ok(errors.some((e) => e.includes('highlight ghost')));
});

test('validate warns on long sub lines, word counts and symbols, without failing', () => {
  const s = example();
  s.board.nodes[0].sub = ['this sub line is far too long to fit'];
  s.steps[1].say = 'Too short.';
  s.steps[2].say += ' See `build.mjs`.';
  const { errors, warnings } = validate(s);
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.includes('over 24 characters')));
  assert.ok(warnings.some((w) => w.startsWith('step 2: 2 words')));
  assert.ok(warnings.some((w) => w.startsWith('step 3: has symbols')));
});

test('validate warns when a line runs through a box or an end misses its box', () => {
  const s = example();
  s.board.edges.push({ id: 'e_long', from: 'order', to: 'queue', via: [[265, 120], [265, 560], [1350, 560]] });
  s.board.edges.push({ id: 'e_loose', from: 'order', to: 'tracker', via: [[100, 100], [265, 203]] });
  const { errors, warnings } = validate(s);
  assert.deepEqual(errors, []);
  assert.ok(warnings.includes('edge e_long runs through box tracker'));
  assert.ok(warnings.includes('edge e_long runs through box failed'));
  assert.ok(warnings.includes('edge e_loose: first via point is not on the edge of box order'));
  assert.ok(!warnings.some((w) => w.includes('e_loose: last')));
});

test('renderPage keeps a </script> in the text from breaking out of the spec block', () => {
  const s = example(); s.title = 'A </script><b>title</b> $& $1';
  const html = renderPage(s);
  assert.ok(!html.includes('</script><b>'));
  assert.ok(html.includes('<title>A &lt;/script&gt;&lt;b&gt;title&lt;/b&gt; $&amp; $1</title>'));
  assert.equal(html.match(/<\/script>/g).length, 2);
});

test('pickEngine: auto prefers a key, then Qwen when set up, then the Mac voice, then the browser', () => {
  assert.equal(pickEngine('auto', { key: 'k', say: true, qwen: true }), 'elevenlabs');
  assert.equal(pickEngine('auto', { key: '', say: true, qwen: true }), 'qwen');
  assert.equal(pickEngine('auto', { key: '', say: true, qwen: false }), 'say');
  assert.equal(pickEngine('auto', { key: '', say: false, qwen: false }), 'browser');
  assert.equal(pickEngine('say', { key: 'k', say: true, qwen: true }), 'say');
  assert.throws(() => pickEngine('robot'));
});

test('estimateSeconds is about 155 words a minute', () => {
  assert.equal(estimateSeconds(Array(155).fill('word').join(' ')), 60);
});

test('--voice browser writes a page with no audio files and estimated times', async () => {
  const { d, p } = scratch();
  try {
    const r = await build([p, '--voice', 'browser'], quiet);
    assert.equal(r.engine, 'browser');
    const html = readFileSync(join(d, 'order-refunds', 'index.html'), 'utf8');
    assert.ok(html.startsWith('<!doctype html>'));
    const spec = JSON.parse(html.match(/<script type="application\/json" id="spec">([\s\S]*?)<\/script>/)[1]);
    assert.equal(spec.speech, 'browser');
    assert.ok(spec.steps.every((s) => !s.audio && s.estimated && s.audio_seconds > 0));
    assert.ok(!existsSync(join(d, 'order-refunds', 'audio')));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('ElevenLabs is never used without --ok-to-send', async () => {
  const { d, p } = scratch();
  const saved = process.env.ELEVENLABS_API_KEY;
  process.env.ELEVENLABS_API_KEY = 'not-a-real-key';
  try {
    await assert.rejects(build([p, '--voice', 'elevenlabs', '--dry-run'], quiet), /--ok-to-send/);
    const r = await build([p, '--dry-run'], quiet);   // auto with a key but no consent: falls back locally
    assert.notEqual(r.engine, 'elevenlabs');
  } finally {
    if (saved === undefined) delete process.env.ELEVENLABS_API_KEY; else process.env.ELEVENLABS_API_KEY = saved;
    rmSync(d, { recursive: true, force: true });
  }
});

test('spec errors stop the build', async () => {
  const { d, p } = scratch();
  try {
    const s = example(); s.steps = [];
    const bad = join(d, 'bad.json');
    (await import('node:fs')).writeFileSync(bad, JSON.stringify(s));
    await assert.rejects(build([bad], quiet), /no steps/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('the Mac voice makes one clip per step and reuses unchanged clips', { skip: process.platform !== 'darwin' }, async () => {
  const { d, p } = scratch();
  try {
    const first = await build([p, '--voice', 'say'], quiet);
    assert.equal(first.todo, 8);
    const audio = join(d, 'order-refunds', 'audio');
    assert.equal(readdirSync(audio).filter((f) => f.endsWith('.mp4')).length, 8);
    const again = await build([p, '--voice', 'say'], quiet);
    assert.equal(again.todo, 0);
    const html = readFileSync(join(d, 'order-refunds', 'index.html'), 'utf8');
    const spec = JSON.parse(html.match(/<script type="application\/json" id="spec">([\s\S]*?)<\/script>/)[1]);
    assert.ok(spec.steps.every((s) => s.audio.startsWith('audio/') && s.audio_seconds > 10));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('links: shown on the page when valid, an error when not http(s)', () => {
  const s = example();
  s.links = [{ label: 'Project', url: 'https://example.com/project' }];
  assert.deepEqual(validate(s).errors, []);
  assert.ok(renderPage(s).includes('https://example.com/project'));
  s.links = [{ label: 'Bad', url: 'javascript:alert(1)' }];
  assert.ok(validate(s).errors.some((e) => e.includes('http(s) url')));
});

test('a step cannot carry its own audio: the field is an error, and the page only keeps known step fields', async () => {
  const s = example();
  s.steps[0].audio = 'https://attacker.example/track.mp3';
  assert.ok(validate(s).errors.some((e) => e.includes('audio is written by the builder')));
  const { d, p } = scratch();
  const spec = JSON.parse(readFileSync(p, 'utf8')); spec.steps[0].extra = 'javascript:alert(1)';
  writeFileSync(p, JSON.stringify(spec));
  await build([p, '--voice', 'browser'], quiet);
  const page = readFileSync(join(d, 'order-refunds', 'index.html'), 'utf8');
  assert.ok(!page.includes('javascript:alert(1)'));
  rmSync(d, { recursive: true, force: true });
});

test('a build never deletes audio it did not write, and leaves a non-empty audio folder in place', async () => {
  const { d, p } = scratch();
  const out = join(d, 'site'); mkdirSync(join(out, 'audio'), { recursive: true });
  writeFileSync(join(out, 'audio', 'theme-song.mp3'), 'not ours');
  writeFileSync(join(out, 'audio', '01-0123456789.mp3'), 'an old take of ours');
  await build([p, '--voice', 'browser', '--out', out], quiet);
  assert.ok(existsSync(join(out, 'audio', 'theme-song.mp3')));
  assert.ok(!existsSync(join(out, 'audio', '01-0123456789.mp3')));
  assert.ok(GENERATED_AUDIO.test('12-abcdef0123.m4a') && !GENERATED_AUDIO.test('theme-song.mp3'));
  rmSync(d, { recursive: true, force: true });
});

test('home: a logo link when name, url and logo are given; an error otherwise', () => {
  const s = example();
  s.home = { name: 'Example', url: 'https://example.com/', logo: 'https://example.com/logo.png' };
  assert.deepEqual(validate(s).errors, []);
  assert.ok(renderPage(s).includes('https://example.com/logo.png'));
  s.home = { name: 'Example', url: 'javascript:alert(1)', logo: 'https://example.com/logo.png' };
  assert.ok(validate(s).errors.some((e) => e.includes('home needs')));
});

test('malformed shapes are spec errors, not crashes', () => {
  const s = example();
  s.board.edges[0].via = [[1, 2]];
  assert.ok(validate(s).errors.some((e) => e.includes('via must be')));
  const t = example(); t.board.nodes = 'oops';
  assert.ok(validate(t).errors.some((e) => e.includes('board.nodes must be a list')));
  const u = example(); u.steps = { not: 'a list' };
  assert.ok(validate(u).errors.some((e) => e.includes('steps must be a list')));
});
