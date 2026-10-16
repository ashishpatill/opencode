/**
 * Finds the shortest decodable input for this model, in throwaway processes.
 *
 * Input shorter than a threshold makes the native binding abort with a C++
 * exception that JavaScript cannot catch, so nothing here may share a process
 * with the test run. Each candidate length runs in its own child, and a crash
 * is reported as data rather than as a failure of the caller.
 *
 *   node parakeet.cliff.mjs <weights-dir>          # report the boundary
 *   node parakeet.cliff.mjs <weights-dir> <count>  # decode that many samples
 */
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const dir = process.argv[2]

const count = process.argv[3]

if (!dir) {
  process.stdout.write(JSON.stringify({ ok: false, error: "usage: cliff <weights-dir> [samples]" }))
  process.exit(2)
}

/**
 * Decodes `samples` in a fresh process; reports whether it survived.
 *
 * A failed spawn is retried once before being called a crash. Each child loads
 * 622 MB of weights, and spawning them back to back can fail for reasons that
 * have nothing to do with clip length — a false "unsafe" here would move the
 * reported boundary, which is worse than being slow.
 */
function survives(samples) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), dir, String(samples)], {
      encoding: "utf8",
    })

    if (result.stdout?.includes(`OK ${samples}`)) return true

    // A clean non-zero exit carrying the shape error is a genuine crash.
    if (/Invalid input shape|terminate called|libc\+\+abi/.test(result.stderr ?? "")) return false
  }

  return false
}

function decode(samples) {
  const require_ = createRequire(import.meta.url)
  const sherpa = require_("sherpa-onnx-node")

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

  const stream = recognizer.createStream()
  stream.acceptWaveform({ sampleRate: 16000, samples: new Float32Array(samples) })
  recognizer.decode(stream)

  return recognizer.getResult(stream).text
}

if (count !== undefined) {
  process.stdout.write(`OK ${count}\n${decode(Number(count))}`)
} else {
  // The cliff is a *lower* bound: short input fails, long input works. So the
  // search walks down from a known-safe length, then bisects the bracket it
  // lands in. The invariant throughout is `safe` decodes and `unsafe` does not.
  const BASELINE = 1024

  if (!survives(BASELINE)) {
    process.stdout.write(JSON.stringify({ ok: false, error: `baseline ${BASELINE} samples did not decode` }))
    process.exit(1)
  }

  let safe = BASELINE
  // Nothing below 1 sample can be meaningful, so 1 is the floor to search from.
  let unsafe = 1

  if (survives(1)) {
    process.stdout.write(JSON.stringify({ ok: true, minSamples: 1, unsafeAt: 0 }))
  } else {
    // Walk down from the baseline to find a failing length, keeping the last
    // safe one above it.
    let probe = Math.floor(BASELINE / 2)

    while (probe >= 1) {
      if (!survives(probe)) {
        unsafe = probe
        break
      }

      safe = probe
      probe = Math.floor(probe / 2)
    }

    // `unsafe` is the failing length and `safe` the smallest confirmed good one
    // above it. Bisect until they are adjacent.
    while (unsafe + 1 < safe) {
      const mid = Math.floor((unsafe + safe) / 2)

      if (survives(mid)) safe = mid
      else unsafe = mid
    }

    process.stdout.write(JSON.stringify({ ok: true, minSamples: safe, unsafeAt: unsafe }))
  }
}
