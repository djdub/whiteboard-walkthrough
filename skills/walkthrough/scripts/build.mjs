#!/usr/bin/env node
// Whiteboard walkthrough builder. Reads a spec (board: lanes, columns, nodes, edges; steps: title, say, highlight),
// voices each step, and writes one page plus an audio folder.
//
//   node build.mjs walkthroughs/<slug>.json [--voice auto|elevenlabs|say|browser] [--ok-to-send] [--out <dir>] [--dry-run]
//
// Output: <spec folder>/<slug>/index.html and audio/<nn>-<hash>.<mp3|m4a>. A step keeps its audio while its text is
// unchanged, so an edit pays only for the steps it changed. ElevenLabs sends the text off the machine: it needs
// --ok-to-send. With --voice browser no audio is made and the page speaks each step with the reader's browser voice.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickEngine, extFor, saySynthesize, elBalance, elSynthesize, elCharge, elDelete, audioSeconds, estimateSeconds, EL, SAY } from './voice.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const KINDS = new Set(['new', 'exists', 'changed', 'fail']);
const EDGE_KINDS = new Set(['fail', 'catch', 'plain']);

const onBorder = ([x, y], n, t = 3) => x >= n.x - t && x <= n.x + n.w + t && y >= n.y - t && y <= n.y + n.h + t
  && !(x > n.x + t && x < n.x + n.w - t && y > n.y + t && y < n.y + n.h - t);
/** Does the segment a-b pass through the inside of box n (2 px in from its border)? Liang-Barsky clipping. */
function crosses([x1, y1], [x2, y2], n) {
  const L = n.x + 2, R = n.x + n.w - 2, T = n.y + 2, B = n.y + n.h - 2, dx = x2 - x1, dy = y2 - y1;
  let t0 = 0, t1 = 1;
  for (const [p, q] of [[-dx, x1 - L], [dx, R - x1], [-dy, y1 - T], [dy, B - y1]]) {
    if (p === 0) { if (q < 0) return false; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  return t1 > t0;
}

/** Errors stop the build; warnings are printed and the build goes on. */
export function validate(spec) {
  const errors = [], warnings = [];
  const b = spec.board || {};
  if (typeof b.width !== 'number' || typeof b.height !== 'number') errors.push('board needs a numeric width and height');
  if (!Array.isArray(b.lanes) || !b.lanes.length) errors.push('board needs at least one lane');
  const ids = new Set();
  const nodes = b.nodes || [];
  for (const n of nodes) {
    if (!n.id) { errors.push('a node has no id'); continue; }
    if (ids.has(n.id)) errors.push('duplicate id ' + n.id); ids.add(n.id);
    for (const f of ['x', 'y', 'w', 'h']) if (typeof n[f] !== 'number') errors.push(`node ${n.id}: no ${f}`);
    if (n.kind && !KINDS.has(n.kind)) errors.push(`node ${n.id}: kind ${n.kind} is not one of new, exists, changed, fail`);
    for (const s of [].concat(n.sub || [])) if (s.length > 24) warnings.push(`node ${n.id}: sub line "${s}" is over 24 characters`);
    if (n.x + n.w > b.width || n.y + n.h > b.height || n.x < 0 || n.y < 0) warnings.push(`node ${n.id} runs off the board`);
  }
  for (const e of b.edges || []) {
    if (!e.id) { errors.push('an edge has no id'); continue; }
    if (ids.has(e.id)) errors.push('duplicate id ' + e.id); ids.add(e.id);
    for (const end of ['from', 'to']) if (!nodes.some((n) => n.id === e[end])) errors.push(`edge ${e.id}: ${end} ${e[end]} is not a node`);
    if (e.kind && !EDGE_KINDS.has(e.kind)) errors.push(`edge ${e.id}: kind ${e.kind} is not fail or catch`);
    if (!e.via) { warnings.push(`edge ${e.id} has no via points; it will curve and may cross boxes`); continue; }
    const from = nodes.find((n) => n.id === e.from), to = nodes.find((n) => n.id === e.to);
    if (from && !onBorder(e.via[0], from)) warnings.push(`edge ${e.id}: first via point is not on the edge of box ${e.from}`);
    if (to && !onBorder(e.via[e.via.length - 1], to)) warnings.push(`edge ${e.id}: last via point is not on the edge of box ${e.to}`);
    for (let k = 0; k < e.via.length - 1; k++) for (const n of nodes) {
      if (n.id !== e.from && n.id !== e.to && crosses(e.via[k], e.via[k + 1], n)) warnings.push(`edge ${e.id} runs through box ${n.id}`);
    }
  }
  for (const l of [].concat(spec.links || [])) if (!l || !/^https?:\/\//.test(l.url || '') || !l.label) errors.push('each link needs a label and an http(s) url');
  const steps = spec.steps || [];
  if (!steps.length) errors.push('no steps');
  else if (steps.length < 8 || steps.length > 12) warnings.push(`${steps.length} steps; 8 to 12 read best`);
  steps.forEach((s, i) => {
    if (!s.title || !s.say) { errors.push(`step ${i + 1}: needs title and say`); return; }
    for (const h of s.highlight || []) if (!ids.has(h)) errors.push(`step ${i + 1}: highlight ${h} is not a node or edge`);
    const words = s.say.trim().split(/\s+/).length;
    if (words < 60 || words > 110) warnings.push(`step ${i + 1}: ${words} words; 60 to 110 is the range`);
    if (/[`*#|<>\[\]{}]/.test(s.say)) warnings.push(`step ${i + 1}: has symbols a voice will read badly`);
  });
  return { errors, warnings };
}

export function renderPage(spec, template = readFileSync(join(HERE, 'player.html'), 'utf8')) {
  const json = JSON.stringify(spec).replace(/</g, '\\u003c');   // safe inside <script type="application/json">
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return template.replace('__TITLE__', () => esc(spec.page_title || spec.title)).replace('__SPEC__', () => json);
}

function parseArgs(argv) {
  const a = { spec: null, voice: 'auto', okToSend: false, out: null, dry: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--voice') a.voice = argv[++i];
    else if (v === '--out') a.out = argv[++i];
    else if (v === '--ok-to-send') a.okToSend = true;
    else if (v === '--dry-run') a.dry = true;
    else if (!v.startsWith('--') && !a.spec) a.spec = v;
    else throw new Error('unknown option ' + v);
  }
  return a;
}

export async function build(argv, log = console.log) {
  const a = parseArgs(argv);
  if (!a.spec) throw new Error('usage: build.mjs <spec.json> [--voice auto|elevenlabs|say|browser] [--ok-to-send] [--out <dir>] [--dry-run]');
  const spec = JSON.parse(readFileSync(a.spec, 'utf8'));
  const { errors, warnings } = validate(spec);
  for (const w of warnings) log('warning: ' + w);
  if (errors.length) throw new Error('spec errors:\n  ' + errors.join('\n  '));

  const key = process.env.ELEVENLABS_API_KEY || '';
  let engine = pickEngine(a.voice, { key });
  if (engine === 'elevenlabs' && !key) throw new Error('--voice elevenlabs needs ELEVENLABS_API_KEY in the environment');
  if (engine === 'elevenlabs' && !a.okToSend) {
    if (a.voice === 'elevenlabs') throw new Error('ElevenLabs sends the step text off this machine: add --ok-to-send if that is fine, or use --voice say');
    engine = pickEngine('auto', { key: '' });
    log(`ElevenLabs key found but --ok-to-send not given; using the ${engine === 'say' ? 'Mac' : 'browser'} voice instead`);
  }

  const slug = basename(a.spec, '.json');
  const out = resolve(a.out || join(dirname(a.spec), slug));
  const audioDir = join(out, 'audio');
  const tag = engine === 'elevenlabs' ? `el:${EL.voiceId}:${EL.model}` : `say:${SAY.voice}`;
  const need = spec.steps.map((s, i) => ({ i, s, file: engine === 'browser' ? null : `${String(i + 1).padStart(2, '0')}-${createHash('sha256').update(tag + '\n' + s.say).digest('hex').slice(0, 10)}.${extFor(engine)}` }));
  const todo = need.filter((x) => x.file && !existsSync(join(audioDir, x.file)));
  const chars = todo.reduce((n, x) => n + x.s.say.length, 0);
  log(`${spec.steps.length} steps; voice: ${engine}; ${todo.length} to voice (${chars} characters)`);
  if (a.dry) return { out, engine, todo: todo.length };

  if (engine === 'elevenlabs' && todo.length) {
    const bal = await elBalance(key);
    if (!bal || bal.remaining < chars * 1.2) {
      if (a.voice === 'elevenlabs') throw new Error('ElevenLabs balance too low or unreadable: ' + JSON.stringify(bal));
      log('ElevenLabs balance too low or unreadable; falling back');
      return build([...argv.filter((v) => v !== '--ok-to-send'), '--voice', pickEngine('auto', { key: '' })], log);
    }
  }

  mkdirSync(audioDir, { recursive: true });
  const charged = [];
  for (const x of todo) {
    const file = join(audioDir, x.file);
    if (engine === 'say') saySynthesize(x.s.say, file);
    else {
      const r = await elSynthesize(key, x.s.say, file);
      if (r.historyItemId) {
        const credits = await elCharge(key, r.historyItemId);
        if (credits != null) charged.push({ step: x.i + 1, chars: x.s.say.length, credits });
        await elDelete(key, r.historyItemId);
      }
    }
    log(`  voiced step ${x.i + 1}`);
  }
  const keep = new Set(need.map((x) => x.file).filter(Boolean));
  for (const f of readdirSync(audioDir)) if (!keep.has(f)) rmSync(join(audioDir, f));   // old takes of edited steps
  if (!keep.size) rmSync(audioDir, { recursive: true, force: true });

  const page = {
    ...spec,
    speech: engine === 'browser' ? 'browser' : 'audio',
    steps: need.map((x) => x.file
      ? { ...x.s, audio: 'audio/' + x.file, audio_seconds: audioSeconds(join(audioDir, x.file)) }
      : { ...x.s, audio_seconds: estimateSeconds(x.s.say), estimated: true }),
  };
  writeFileSync(join(out, 'index.html'), renderPage(page));
  if (charged.length) {
    const credits = charged.reduce((n, c) => n + c.credits, 0);
    appendFileSync(join(out, 'cost.jsonl'), JSON.stringify({ at: new Date().toISOString(), slug, voice: EL.voiceId, model: EL.model, credits, per_step: charged }) + '\n');
    log(`ElevenLabs: ${credits} credits for ${charged.length} step(s)`);
  }
  const total = page.steps.reduce((n, s) => n + s.audio_seconds, 0);
  log(`wrote ${join(out, 'index.html')}${keep.size ? ` and ${keep.size} audio files` : ' (browser voice, no audio files)'}, about ${Math.round(total / 6) / 10} min`);
  if (keep.size) log('audio files: ' + [...keep].map((f) => 'audio/' + f).join(' '));
  return { out, engine, todo: todo.length, files: [...keep].map((f) => 'audio/' + f) };
}

if (import.meta.url === `file://${process.argv[1]}`) build(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
