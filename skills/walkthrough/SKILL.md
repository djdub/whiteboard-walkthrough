---
name: walkthrough
description: >-
  Turn a design, proposal, decision or system flow into one narrated whiteboard page: a drawing (lanes for where things
  run, columns for when, new vs existing vs changed parts, the failure path) and 8 to 12 spoken steps that light up
  their part of the board as they play, ending with the decision and a recommendation. Use when the user says
  "/walkthrough", "whiteboard this", "walk me through it", "narrate this design", "make a walkthrough", or asks for a
  design or proposal to be explained as a picture.
---

# Narrated whiteboard walkthrough

People decide designs best the way engineers do at a whiteboard: looking at a drawing while someone talks them
through it. Prose alone makes the reader build the picture in their head. This skill turns a design or decision into
**one page**: the drawing, and the explanation split into spoken steps. Each step is voiced, lights up its boxes and
arrows with a yellow highlighter, and hands on to the next when it ends. The page has play, pause, back, next, a
chapter list and the spoken text on screen, and it closes with the decision the reader is being asked to make.

The scripts sit next to this file: `scripts/build.mjs` (the builder), `scripts/voice.mjs` (the voices),
`scripts/player.html` (the page), and `examples/order-refunds.json` (a worked example to copy). Claude Code gives this
skill's base directory when it loads it; call it `SKILL_DIR` below.

## Procedure

1. **Find the subject.** Use the argument if there is one (a design doc, a ticket, "the proposal above"); otherwise the
   design or proposal most recently discussed in this chat; otherwise ask once which one. Read the source itself, not
   a summary of it. Work out the pieces, which exist today and which are new or changed, the order things happen in,
   where each one runs, what happens when it fails, the catch-all that keeps a failure from going unnoticed, and the
   decision being asked for.

2. **Draw the board** as a spec file, `walkthroughs/<slug>.json` in the current project. Copy the shape of
   `SKILL_DIR/examples/order-refunds.json`.
   - `title` (the subject's name), `subtitle` (one sentence: what it is, its status, where the design lives). The page
     works out the total play time and shows it under the subtitle. Optional `links`: `[{"label", "url"}]`, shown
     under the subtitle (where the project or the design doc lives); http(s) URLs only. Optional `home`:
     `{"name", "url", "logo"}`, a small logo at the top left linking to the site that hosts the page (no visible text;
     `name` is its accessible label); http(s) URLs only. Never put `audio`, `audio_seconds` or `estimated` in a step:
     the builder writes those.
   - `board.width` and `board.height`: keep within about 1,560 × 640.
   - `board.lanes`: horizontal bands for **where things run** (a service, a repo, a database, a person's machine, where
     the reader looks), each with `label`, `y`, `h`.
   - `board.columns`: **when things happen**, left to right, each with `label` and `x`. `x` is where the column's label
     starts at the foot of the board, normally the left edge of that column's boxes; a faint divider is drawn just to
     its left.
   - `board.nodes`: each with `id`, `x`, `y`, `w`, `h`, `kind`, a one- or two-line `label` (array of strings) and short
     `sub` lines (24 characters at most). `kind` is `new`, `exists`, `changed` or `fail`. Labels are only shown, never
     spoken, so they may hold symbols and names as written.
   - `board.edges`: each with `id`, `from`, `to`, an optional `kind` (`fail` or `catch`; omit for plain), a `label` only
     when its meaning is not obvious (place it with `lx`, `ly`, and `anchor` of `start` or `end`), and `via`: the
     line's corner points from start to end, so lines go around boxes, never through them. The first point sits on the
     source box's border and the last on the target's; the builder draws the points exactly as given (no snapping)
     and puts the arrowhead on the last one. It warns when a line runs through a box or an end misses its box.
   - The key uses whiteboard-marker colours: **green** fill for new, **plain graphite outline** for what exists today,
     **amber dashed** for changed, **red dashed** for the failure path, **grey dotted** for the catch-all; the yellow
     highlighter marks what is being spoken about. The page draws this key under the board. Draw the failure path and the catch-all, not only the happy path.

3. **Write the steps as speech.** `steps`: 8 to 12 of them, 60 to 110 words each, each with a `title`, the `say` text,
   and the `highlight` ids (nodes and edges) it talks about. Use an empty list for the overview and the close.
   - Spoken only: no lists, symbols or backticks. Say a path the way a person would ("the walkthroughs folder"); spell
     out times and numbers the way they are spoken.
   - Step 1 is the whole picture: the bands, the time columns, the key. Then move the way an eye would, naming each
     element by its place and colour ("the first green box in the middle band"), and say what it does and why it
     exists.
   - Happy path first, then the failure path, then the catch-all.
   - The last step gives the cost (new parts, any new stored state, what it retires) and then **the decision**: the
     question, the options in a sentence each, and the recommendation with its reason. If nothing is being decided,
     say so and say when it next comes up.

4. **Build.** `node SKILL_DIR/scripts/build.mjs walkthroughs/<slug>.json`. The builder checks the spec, stops on errors
   (fix them and run again), prints warnings for crowded labels or steps outside the word range, voices each step and
   writes `walkthroughs/<slug>/index.html` with an `audio/` folder beside it. Re-runs only re-voice steps whose text
   changed.
   - **Voices.** `--voice auto` (the default) picks ElevenLabs if `ELEVENLABS_API_KEY` is set, otherwise the Mac's
     built-in voice, otherwise the reader's browser voice (no audio files; the page speaks each step itself).
     `--voice say`, `--voice elevenlabs` and `--voice browser` force one. With the browser voice the play time on the
     page is an estimate, and the voice sounds different in each browser; say so when you share it.
   - **ElevenLabs sends the text off the machine.** The builder refuses unless you also pass `--ok-to-send`. Pass it
     only when the text holds nothing confidential, and nothing the user has said must stay private; otherwise use
     `--voice say`. The builder deletes each ElevenLabs history item after reading its credit charge (it warns if a
     deletion fails), and logs the credits in `walkthroughs/<slug>.cost.jsonl`. A five-minute page costs roughly 900
     to 1,000 credits.
   - If ElevenLabs refuses (bad key, low credit), `auto` falls back to the Mac voice and says so.

5. **Look once, then share.** If Chrome is installed and you may run it, take one screenshot and look at it before sharing:
   `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --hide-scrollbars --window-size=1400,1500
   --screenshot=/tmp/walkthrough.png "file://$PWD/walkthroughs/<slug>/index.html"`. Fix what it shows (labels on
   lines, crowded boxes, lines through boxes) in one pass and rebuild. If you can't take the screenshot, say so in the
   reply. Then share it, unless the user said not to:
   - With an Artifact tool (claude.ai): publish `walkthroughs/<slug>/index.html` with its audio files as `files` and
     the output folder as `root`. Republishing the same path keeps the link.
   - Otherwise: `open walkthroughs/<slug>/index.html`, or copy the folder to any static host. The page and its
     `audio/` folder travel together.

6. **Reply** with the link or path, one line on what it covers and how long it plays, and the closing decision in two
   or three lines. The page carries the walkthrough; don't repeat it in the chat.

## Must not

- Never voice confidential or private content with ElevenLabs; use `--voice say` or `--voice browser`.
- Never draw only the happy path.
- The page is a picture of a proposal or a flow. Once the thing is built, the code and its own docs are the record;
  rebuild the page only when the subject is brought back for a decision.
