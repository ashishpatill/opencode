/**
 * Transcription RPC.
 *
 * Recognition runs in the main process, not the renderer: the renderer is Vite
 * and a native inference module does not belong in a web bundle. Audio crosses
 * this boundary as raw 16 kHz mono samples, which keeps the payload small enough
 * to avoid a base64 round trip of the whole utterance.
 */
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

/** 16 kHz mono, the rate every speech model expects. */
export const SAMPLE_RATE = 16_000

/** Why recognition could not produce text. */
export const TranscriptionError = Schema.Literals(["unavailable", "no-speech", "failed"])

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

/** Whether a local engine and its weights are ready, for UI enablement. */
export const VoiceStatus = Rpc.make("VoiceStatus", {
  success: Schema.Struct({
    /** False until weights finish loading; the button stays disabled meanwhile. */
    ready: Schema.Boolean,
    /** Present when no engine can run, so the UI can explain why. */
    error: Schema.optional(Schema.String),
  }),
})

export const VoiceRpcs = RpcGroup.make(Transcribe, VoiceStatus)