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
- **Engine** — Parakeet TDT 0.6B v2 (int8) behind `sherpa-onnx`, registered
  through the engine port. Weights are 622 MB, CC-BY-4.0 and fetched on first
  use rather than vendored, so `needs-download` is a distinct phase from
  `unavailable`: the mic stays enabled and the first click starts the fetch.
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

Implemented and covered by tests: capture, chunking, the state machine, the
composer control, the IPC boundary, the insert path, and recognition itself —
Parakeet TDT 0.6B v2 (int8) behind `sherpa-onnx`, registered in
`src/main/voice/`.

Measured against real weights, not asserted: a 7.4 s clip transcribes at
RTF ~0.047 with correct punctuation and casing, silence returns empty text, RSS
plateaus around 1.1 GB and returns to baseline, and `numThreads: 2` is the
fastest setting on an 8-core machine (1 thread 575 ms, 2 threads 340 ms,
4 threads 1575 ms).

Two constraints are worth knowing before changing this code:

- The native binding **aborts the process** on input shorter than 80 samples,
  with a C++ exception JavaScript cannot catch. The engine refuses anything
  under 400 at `MIN_SAMPLES`, and `parakeet.cliff.mjs` re-locates the real cliff
  by bisection in throwaway processes so a model revision that moves it fails
  loudly.
- Overlapping decodes into one ONNX session are unsafe, so the engine
  serializes them behind a single queue.
- A status read never fetches. `prepareWeights` owns the download and
  `voiceStatus` answers from disk, because a composer mounting is not the user
  asking for 622 MB — and `needs-download` is only reachable if the status check
  runs before the engine is asked to warm up.

Weights are CC-BY-4.0 and fetched, never vendored, so attribution travels with
the download (`MODEL_ATTRIBUTION`) rather than the source tree.

Observed in a running dev app, not only in tests: a fresh install renders the
mic enabled with nothing downloaded; one click starts the fetch, showing
"Downloading speech model" with a spinner that becomes a rising percentage; the
control is disabled throughout; and when the download lands the mic returns to
an enabled "Dictate".

Not verified: real speech through the capture path. That needs a human at a
microphone, and no automation here can grant microphone access.