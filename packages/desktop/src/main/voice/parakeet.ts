/**
 * Parakeet TDT 0.6B v2 as a `VoiceEngine`.
 *
 * Chosen over Whisper for dictation because measured latency is roughly an
 * order of magnitude lower on short utterances (the common case) and it emits
 * punctuation and capitalization, which Whisper's large-v3-turbo does not —
 * that matters when the output is typed straight into a prompt.
 *
 * Two settings are measured rather than guessed:
 *
 * - `numThreads: 2` on an 8-core machine (4 performance, 4 efficiency). One
 *   thread ran ~575 ms on a 7.4 s clip, two ran ~340 ms, four ran ~1575 ms —
 *   oversubscribing the efficiency cores costs more than the extra parallelism
 *   returns.
 * - `provider: "cpu"`. A CoreML provider would need a separately converted
 *   encoder and was not measured here, so the CPU path is the one known to
 *   work.
 *
 * Concurrent decodes are serialized. At RTF ~0.05 there is ample headroom for
 * one utterance, but overlapping calls into a single ONNX session are not safe,
 * and rapid dictation is exactly when that happens.
 */

import { createRequire } from "node:module"

import type { VoiceEngine } from "./engine"
import type { ModelProgress } from "./model"
import { MODEL_BYTES, MODEL_LABEL, ensureModel, hasModel } from "./model"
import type { SherpaModule, SherpaOfflineRecognizer } from "./sherpa"
import { loadSherpa } from "./sherpa"

const nativeRequire = createRequire(import.meta.url)

/** Every model here is 16 kHz mono; the capture layer resamples before this. */
const SAMPLE_RATE = 16_000

const FEATURE_DIM = 80

/**
 * Shortest input that is safe to decode, in samples (25 ms at 16 kHz).
 *
 * This is a crash guard, not a tuning knob. Measured against this model, input
 * below 80 samples makes the Conformer pre-encode convolution receive an empty
 * feature frame (`Invalid input shape: {0,128}`), and the binding then throws a
 * C++ exception across the Node boundary — which aborts the process outright.
 * Nothing on the JavaScript side can catch it, so the only defence is to never
 * pass a buffer this short.
 *
 * The measured cliff is 80 samples (5 ms). This floor sits 5x above it because
 * the exact threshold is a property of the exported graph and could shift
 * between model revisions, and the cost of being generously high is only that a
 * few milliseconds of silence are dropped.
 */
export const MIN_SAMPLES = 400

export type ParakeetOptions = {
  /** Pre-seeded weight directory. Skips downloading; used by tests. */
  directory?: string
  onProgress?: (progress: ModelProgress) => void
  /** Injectable so the engine can be tested without the native addon. */
  load?: () => SherpaModule
  threads?: number
}

export function createParakeetEngine(options: ParakeetOptions = {}): VoiceEngine {
  let loading: Promise<SherpaOfflineRecognizer> | undefined
  let queue: Promise<unknown> = Promise.resolve()
  /** Live download subscribers; `prepareWeights` attaches for the duration. */
  const listeners = new Set<(progress: ModelProgress) => void>()

  const report = (progress: ModelProgress) => {
    options.onProgress?.(progress)

    for (const listener of listeners) listener(progress)
  }

  const recognizer = () => {
    // One load for all callers: two dictations during a first-run download must
    // not race to construct two sessions over the same weights.
    loading ??= (async () => {
      const dir =
        options.directory ??
        (await ensureModel({
          onProgress: (progress) => report({ ...progress, total: progress.total || MODEL_BYTES }),
        }))

      const sherpa = (options.load ?? (() => loadSherpa(nativeRequire)))()

      return new sherpa.OfflineRecognizer({
        featConfig: { sampleRate: SAMPLE_RATE, featureDim: FEATURE_DIM },
        modelConfig: {
          transducer: {
            encoder: `${dir}/encoder.int8.onnx`,
            decoder: `${dir}/decoder.int8.onnx`,
            joiner: `${dir}/joiner.int8.onnx`,
          },
          tokens: `${dir}/tokens.txt`,
          numThreads: options.threads ?? 2,
          provider: "cpu",
          modelType: "nemo_transducer",
        },
      })
    })().catch((cause) => {
      // Drop the failed promise so a retry can load again rather than
      // replaying the same rejection forever.
      loading = undefined
      throw cause
    })

    return loading
  }

  return {
    id: MODEL_LABEL,

    async ready() {
      try {
        await recognizer()

        return { ready: true }
      } catch (cause) {
        return { ready: false, error: cause instanceof Error ? cause.message : String(cause) }
      }
    },

    async hasWeights() {
      return hasModel(options.directory)
    },

    async prepareWeights(onProgress) {
      if (options.directory) return
      listeners.add(onProgress)

      try {
        await recognizer()
      } finally {
        listeners.delete(onProgress)
      }
    },

    async transcribe(input) {
      // Rejecting beats guessing: a wrong rate would still "succeed" and
      // return plausible nonsense, which is worse than a clear failure.
      if (input.sampleRate !== SAMPLE_RATE) {
        throw new Error(`Expected ${SAMPLE_RATE} Hz audio, received ${input.sampleRate} Hz`)
      }

      // Must precede any native call. See MIN_SAMPLES: too little audio aborts
      // the process, so it is refused here rather than defended against later.
      if (input.samples.length < MIN_SAMPLES) return ""

      const run = async () => {
        const engine = await recognizer()
        const stream = engine.createStream()
        stream.acceptWaveform({ sampleRate: input.sampleRate, samples: input.samples })
        engine.decode(stream)

        return engine.getResult(stream).text
      }

      const result = queue.then(run, run)
      // Keep the chain alive after a failure without making this caller's
      // rejection unhandled for the next one.
      queue = result.catch(() => {})

      return result
    },
  }
}
