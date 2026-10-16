import { Effect } from "effect"
import { VoiceRpcs } from "../../shared/ipc-rpc"
import { transcribeSamples, voiceStatus } from "../voice/engine"

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
    })
  }),
)
