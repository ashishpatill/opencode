# Voice dictation

`voice-dictation.html` is an architecture diagram for mic dictation in the
desktop app. It is a single self-contained file (inline SVG, inline CSS and JS,
fonts embedded as base64) that opens straight from disk in any browser.

Open it directly:

```sh
open packages/app/docs/voice-dictation.html
```

It is not yet linked from anywhere in the app UI.

## What it shows

The path from a click on the composer mic to text at the caret:

- **Capture** — `getUserMedia` at 16 kHz mono, the rate every speech model here
  expects. `packages/app/src/servers/connect/camera.ts` is the existing precedent
  for media permissions in the app.
- **Chunker** — splits audio at the 35 s *reference processor* window rather than
  the encoder's advertised capacity. Using the larger number silently dropped
  whole passages from long recordings in the reference implementation.
- **Local engine** — Parakeet or Whisper GGUF, weights resident, no provider key.
- **Session rotator** — drops per-input inference scratch while keeping model
  weights warm, so a long session does not creep upward in memory.
- **Composer.insert** — inserts at the caret, so a half-typed prompt is never
  overwritten. Dictated and typed text share one insert path.

## Provenance

Generated with [Archify](https://github.com/tt-a1i/archify) 3.0.1 (MIT), pinned to
this repository's revision `e3c5b61`. `voice-dictation.source.json` is the typed
input, so the diagram can be regenerated instead of hand-edited.

To regenerate, install Archify and run `finalize` against the source:

```sh
npx skills add tt-a1i/archify -g
node ~/.agents/skills/archify/bin/archify.mjs finalize architecture \
  packages/app/docs/voice-dictation.source.json \
  packages/app/docs/voice-dictation.html \
  --repo-root . --quality showcase --json
```

`finalize` validates layout, delivers the artifact, checks provenance and runs a
real-browser pass. A non-zero exit is a failure, not a warning.

## Status

The capture, chunker, state machine and composer control in `src/voice/` are
implemented and tested. Microphone capture and the transcription call are not yet
wired: the renderer is Vite, so a native inference module belongs in the main
process rather than here. Nodes in the diagram for the chunker, engine and mic
button describe the intended design; the insert path is existing code.