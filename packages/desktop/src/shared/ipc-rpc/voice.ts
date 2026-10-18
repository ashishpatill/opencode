/**
 * Transcription RPC.
 *
 * Recognition runs in the main process, not the renderer: the renderer is Vite
 * and a native inference module does not belong in a web bundle. Audio crosses
 * this boundary as raw 16 kHz mono samples so the engine receives exactly what
 * it expects, with no decoding step that could silently change the rate.
 *
 * The cost is honest and measured: a sample is one JSON number, so a 5-second
 * utterance is roughly 1 MB on the wire and a full 35-second chunk about 7 MB.
 * That is fine for dictation, which is short by nature, and it is the reason
 * utterances are chunked rather than sent as one unbounded recording.
 */
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

/** 16 kHz mono, the rate every speech model expects. */
export const SAMPLE_RATE = 16_000

/** Why recognition could not produce text. */
export const TranscriptionError = Schema.Literals(["unavailable", "no-speech", "failed"])

/**
 * `needs-download` is distinct from `unavailable`: weights are fetched on first
 * use, so dictation works on a fresh install once they arrive. Reporting that
 * as unavailable would leave the composer control disabled with no way to
 * trigger the download at all.
 */
export const VoicePhase = Schema.Literals([
  "unavailable",
  "needs-download",
  "downloading",
  "ready",
  "error",
])

export const VoiceStatus = Schema.Struct({
  phase: VoicePhase,
  /** Present when the engine cannot run, so the UI can explain why. */
  error: Schema.optional(Schema.String),
  progress: Schema.optional(Schema.Struct({ bytes: Schema.Number, total: Schema.Number })),
})

export const Transcribe = Rpc.make("VoiceTranscribe", {
  payload: {
    /** Raw samples in -1..1, one channel at SAMPLE_RATE. */
    samples: Schema.Array(Schema.Number),
    sampleRate: Schema.Number,
    /** BCP-47 tag; the engine may map or narrow this. */
    language: Schema.optional(Schema.String),
  },
  success: Schema.Struct({ text: Schema.String }),
  error: TranscriptionError,
})

export const Status = Rpc.make("VoiceStatus", {
  success: VoiceStatus,
})

/**
 * Starts the first-run weight download without transcribing, so the composer
 * can show progress for 622 MB rather than appearing to hang.
 */
export const Prepare = Rpc.make("VoicePrepare", {
  success: VoiceStatus,
})

export const VoiceRpcs = RpcGroup.make(Transcribe, Status, Prepare)