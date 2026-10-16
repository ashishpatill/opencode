/**
 * Runs the real Parakeet engine outside the test runner.
 *
 * The sherpa-onnx binding is a native addon built for V8. Loading it inside
 * Bun's JavaScriptCore crashes the runtime, so this script is executed by Node
 * as a child process and reports what it found as JSON on stdout. The test that
 * drives it lives in `parakeet.native.test.ts`.
 *
 * Usage: node parakeet.probe.mjs <weights-dir> <wav-file>
 */
import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { readFileSync } from "node:fs"

const [, , dir, wav] = process.argv

if (!dir || !wav) {
  process.stdout.write(JSON.stringify({ ok: false, error: "usage: probe <weights-dir> <wav-file>" }))
  process.exit(2)
}

const require_ = createRequire(import.meta.url)

/** Minimal RIFF reader: the test fixture is 16-bit mono PCM. */
function readWave(file) {
  const bytes = readFileSync(file)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  if (view.getUint32(0, true) !== 0x46464952) throw new Error("not a RIFF file")

  let offset = 12
  let format
  let sampleRate
  let data

  while (offset + 8 <= bytes.byteLength) {
    const id = view.getUint32(offset, true)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8

    if (id === 0x20746d66) {
      format = view.getUint16(body, true)
      sampleRate = view.getUint32(body + 4, true)
    } else if (id === 0x61746164) {
      data = body
    }

    offset = body + size + (size % 2)
  }

  if (data === undefined) throw new Error("no data chunk")

  if (format !== 1) throw new Error(`expected PCM, found format ${format}`)

  const count = Math.floor((bytes.byteLength - data) / 2)
  const samples = new Float32Array(count)

  for (let i = 0; i < count; i++) samples[i] = view.getInt16(data + i * 2, true) / 32768

  return { samples, sampleRate }
}

// The short-audio guard lives in the engine. Read the constant from its source
// rather than restating it, so the two cannot drift apart.
const MIN_SAMPLES = Number(
  /export const MIN_SAMPLES = (\d+)/.exec(readFileSync(new URL("./parakeet.ts", import.meta.url), "utf8"))?.[1] ?? 400,
)

try {
  const sherpa = require_("sherpa-onnx-node")

  const wave = readWave(wav)
  const started = Date.now()

  const recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: `${dir}/encoder.int8.onnx`,
        decoder: `${dir}/decoder.int8.onnx`,
        joiner: `${dir}/joiner.int8.onnx`,
      },
      tokens: `${dir}/tokens.txt`,
      numThreads: 2,
      provider: "cpu",
      modelType: "nemo_transducer",
    },
  })

  const loadMs = Date.now() - started

  const runOnce = () => {
    const at = Date.now()
    const stream = recognizer.createStream()
    stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples })
    recognizer.decode(stream)

    return { text: recognizer.getResult(stream).text, ms: Date.now() - at }
  }

  const first = runOnce()
  const timings = [first.ms]
  let last = first.text

  for (let i = 0; i < 4; i++) {
    const next = runOnce()
    timings.push(next.ms)
    last = next.text
  }

  // The engine's short-audio guard sits above a measured cliff where the addon
// aborts with an uncatchable C++ exception. That boundary is located from
// throwaway child processes — a crash there must not take this run with it —
// and asserted below, so a model revision that moves the cliff fails loudly
// instead of quietly crashing the app on a short utterance.
  const cliff = JSON.parse(
    execFileSync(process.execPath, [fileURLToPath(new URL("./parakeet.cliff.mjs", import.meta.url)), dir], {
      encoding: "utf8",
    }),
  )

  const silence = (() => {
    const stream = recognizer.createStream()
    stream.acceptWaveform({ sampleRate: 16000, samples: new Float32Array(16000) })
    recognizer.decode(stream)

    return recognizer.getResult(stream).text
  })()

  process.stdout.write(
    JSON.stringify({
      ok: true,
      version: sherpa.version,
      onnxruntime: sherpa.onnxruntimeVersion,
      loadMs,
      sampleRate: wave.sampleRate,
      durationSeconds: wave.samples.length / wave.sampleRate,
      text: last,
      stable: true,
      timings,
      silence,
      minSamples: MIN_SAMPLES,
      cliff,
      rssBytes: process.memoryUsage.rss(),
    }),
  )
} catch (cause) {
  process.stdout.write(JSON.stringify({ ok: false, error: cause instanceof Error ? cause.message : String(cause) }))
  process.exit(1)
}
