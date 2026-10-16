import { Effect } from "effect"
import { VoiceRpcs } from "../../shared/ipc-rpc"
import { prepareVoiceEngine, registerVoiceEngine, transcribeSamples, voiceStatus } from "../voice/engine"
import { createParakeetEngine } from "../voice/parakeet"

// Constructing the engine is free; the weights and the native session are only
// touched when something asks, so registering at import costs nothing on launch.
registerVoiceEngine(createParakeetEngine())

export const voiceHandlers = VoiceRpcs.toLayer(
  Effect.gen(function* () {
    return VoiceRpcs.of({
      VoiceTranscribe: ({ samples, sampleRate, language }) =>
        Effect.promise(() => transcribeSamples({ samples: Float32Array.from(samples), sampleRate, language })).pipe(
          Effect.flatMap((result) =>
            result.ok
              ? Effect.succeed(result)
              : Effect.fail(result.reason === "unavailable" ? ("unavailable" as const) : ("failed" as const)),
          ),
        ),
      VoiceStatus: () => Effect.promise(() => voiceStatus()),
      VoicePrepare: () => Effect.promise(() => prepareVoiceEngine()),
    })
  }),
)