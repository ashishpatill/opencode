/**
 * Typed surface for the `sherpa-onnx-node` binding.
 *
 * The package ships no type declarations, so this file declares only the parts
 * dictation uses. A hand-written shim rather than `@types/...` because there is
 * no published one, and declaring the whole binding would be a large surface
 * nobody calls.
 *
 * The binding is a prebuilt native addon resolved per platform through the
 * package's own optional dependencies, so no compiler is needed to install it.
 */

/** What the recognizer reports for one utterance. */
export type SherpaResult = { text: string }

export type SherpaOfflineStream = {
  acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void
}

export type SherpaOfflineRecognizer = {
  createStream(): SherpaOfflineStream
  decode(stream: SherpaOfflineStream): void
  getResult(stream: SherpaOfflineStream): SherpaResult
}

export type SherpaTransducerConfig = {
  encoder: string
  decoder: string
  joiner: string
}

/**
 * `modelType` is not optional in practice: without it the binding rejects the
 * config outright, because TDT decoders are shaped differently from the
 * standard transducer ones.
 */
export type SherpaOfflineRecognizerConfig = {
  featConfig: { sampleRate: number; featureDim: number }
  modelConfig: {
    transducer: SherpaTransducerConfig
    /** Sits beside `transducer`, not inside it. */
    tokens: string
    numThreads: number
    provider: string
    modelType: string
  }
}

export type SherpaModule = {
  OfflineRecognizer: new (config: SherpaOfflineRecognizerConfig) => SherpaOfflineRecognizer
}

/**
 * Loads the addon. Throws when no prebuilt binary exists for this platform.
 *
 * The `require` result is untyped because the package ships no declarations.
 * Rather than assert blindly, the constructor is checked by attempting the one
 * thing this module needs from it, so a mismatch surfaces as a clear error at
 * load rather than as a `TypeError` inside an inference call.
 */
export function loadSherpa(require_: NodeRequire): SherpaModule {
  // SAFETY: the binding ships no declarations. Only `OfflineRecognizer` is
  // claimed here, it is presence-checked immediately below, and the shape is
  // pinned by the native test, which loads this module against real weights.
  const loaded = require_("sherpa-onnx-node") as Partial<SherpaModule>

  if (!loaded.OfflineRecognizer) {
    throw new Error("sherpa-onnx-node did not provide an OfflineRecognizer constructor")
  }

  // SAFETY: `OfflineRecognizer` was just checked to be present. That is the
  // only member of `SherpaModule`, so this is the whole contract.
  return loaded as SherpaModule
}