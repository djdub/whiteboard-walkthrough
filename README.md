# Whiteboard Walkthrough

A Claude Code plugin that turns a design, proposal or decision into one narrated whiteboard page: a drawing of the
system (lanes for where things run, columns for when, new vs existing vs changed parts, the failure path) and 8 to 12
spoken steps that light up their part of the board as they play. It ends with the decision and a recommendation.

## See it explain itself

[![The plugin's own walkthrough: a whiteboard of how it works, with 11 narrated steps](docs/how-it-works.png)](https://aios.cx/walkthrough/)

**[Watch the walkthrough](https://aios.cx/walkthrough/)** (about 5 minutes, with sound). The page was made by this
plugin from [`docs/how-it-works.json`](docs/how-it-works.json), so it shows both how the plugin works and what it
makes.

## Install

In Claude Code:

```
/plugin marketplace add djdub/whiteboard-walkthrough
/plugin install whiteboard-walkthrough@whiteboard-walkthrough
```

Needs Node 18 or later.

## Use

Ask for it in any chat: "/walkthrough the design in docs/queue.md", "whiteboard this proposal", "walk me through it".
Claude writes a spec at `walkthroughs/<slug>.json`, builds `walkthroughs/<slug>/index.html` with its audio, and shares
it (a claude.ai Artifact if your Claude Code has one, otherwise a local file you can open or host anywhere).

## Voices

| Voice | Needs | Cost | Text leaves your machine |
|---|---|---|---|
| Mac built-in (`--voice say`) | macOS | free | no |
| Browser (`--voice browser`) | nothing; the page speaks with the reader's browser voice | free | no |
| ElevenLabs (`--voice elevenlabs`) | `ELEVENLABS_API_KEY`, and `--ok-to-send` on each build | about 900 credits per five-minute page | yes |

The default, `--voice auto`, uses ElevenLabs only when a key is set and `--ok-to-send` is passed; otherwise the Mac
voice, otherwise the browser. Optional: `ELEVENLABS_VOICE_ID` (default "George"), `ELEVENLABS_MODEL`,
`WALKTHROUGH_SAY_VOICE` (default "Daniel"). The builder deletes each ElevenLabs history item after reading its charge.

If an audio file fails to load, the page reads that step with the browser voice; with no voice at all, the text is on
screen to read along.

## Try it

```
node skills/walkthrough/scripts/build.mjs skills/walkthrough/examples/order-refunds.json --voice browser
open skills/walkthrough/examples/order-refunds/index.html
```

## Tests

```
node --test test/*.test.mjs
```

## Layout

- `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`: the plugin and its one-plugin marketplace
- `skills/walkthrough/SKILL.md`: the procedure Claude follows
- `skills/walkthrough/scripts/`: `build.mjs` (checks the spec, voices the steps, writes the page), `voice.mjs`,
  `player.html`
- `skills/walkthrough/examples/order-refunds.json`: a worked spec to copy
