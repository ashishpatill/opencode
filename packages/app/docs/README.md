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

The path from a click on the composer mic to text at the caret, split at the
renderer/main boundary:

- **Composer mic** — the control renders inside the composer's normal-mode
  actions row, so it is absent while the prompt is in shell mode.
- **Capture state** — an ordered, cancellable state machine. A new utterance
  never cancels work already accepted, output keeps submission order, and commit
  is terminal, so a late result for a cancelled or superseded capture cannot
  reach the composer.
- **Mic capture** — `getUserMedia` at 16 kHz mono, resampled from whatever rate
  the device opens at. A tap under 300 ms is reported as a short tap rather than
  transcribed, so a stray click near the mic cannot become a prompt.
- **Chunker** — splits at the 35 s *reference processor* window rather than the
  encoder's advertised capacity. Using the larger number silently dropped whole
  passages from long recordings in the reference implementation.
- **VoiceTranscribe IPC** — raw samples cross the boundary rather than an
  encoded file. Recognition runs in the main process because the renderer is a
  web bundle and a native inference module does not belong in one.
- **Engine port** — a seam with no engine registered yet. Status therefore
  reports unavailable and the mic stays disabled, which is the honest state
  until a model is chosen.
- **Composer.insert** — inserts at the caret, so a half-typed prompt is never
  overwritten. Dictated and typed text share one insert path.

## Provenance

Generated with [Archify](https://github.com/tt-a1i/archify) 3.0.1 (MIT), pinned to
this repository's revision `5206d99`.
`voice-dictation.source.json` is the typed input, so the diagram can be
regenerated instead of hand-edited.

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

Capture, chunking, the state machine, the composer control, the IPC boundary
and the insert path are implemented and covered by unit tests. Recognition
itself is not: `VoiceEngine` in `src/main/voice/engine.ts` has no registered
implementation, so the mic control reports unavailable and disables itself
until a model is chosen. Parakeet (0.6B, best measured accuracy per byte) and
Whisper (MIT) both fit behind the port.