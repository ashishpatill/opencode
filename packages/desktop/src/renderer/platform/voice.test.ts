import { describe, expect, test } from "bun:test"
import { createDesktopVoice } from "./voice"

/** The bridge's dependency, derived from the function so the two cannot drift. */
type VoiceApi = Parameters<typeof createDesktopVoice>[0]

/** A preload API that returns a ready engine; individual tests override one call. */
function bridge(overrides: Partial<VoiceApi> = {}): VoiceApi {
  return {
    voiceStatus: async () => ({ phase: "ready" }),
    prepareVoice: async () => ({ phase: "ready" }),
    transcribeVoice: async () => ({ text: "" }),
    ...overrides,
  }
}

describe("desktop voice bridge", () => {
  test("status reports the engine's phase through to the caller", async () => {
    const voice = createDesktopVoice(bridge({ voiceStatus: async () => ({ phase: "needs-download" }) }))

    expect(await voice.voiceStatus()).toEqual({ phase: "needs-download" })
  })

  test("prepare forwards to the main process and returns the new phase", async () => {
    const voice = createDesktopVoice(
      bridge({ prepareVoice: async () => ({ phase: "downloading", progress: { bytes: 1, total: 2 } }) }),
    )

    expect(await voice.prepareVoice()).toEqual({ phase: "downloading", progress: { bytes: 1, total: 2 } })
  })

  test("status does not swallow a failure into a fake phase", async () => {
    // A hung or broken main process must surface, not look like a working
    // engine: inventing a phase here would enable a mic that cannot transcribe.
    const voice = createDesktopVoice(
      bridge({
        voiceStatus: async () => {
          throw new Error("ipc down")
        },
      }),
    )

    await expect(voice.voiceStatus()).rejects.toThrow("ipc down")
  })

  test("transcribe passes the samples, rate and language through untouched", async () => {
    // The rate is not incidental: the renderer resamples to 16 kHz before this
    // call and the engine rejects anything else, so a bridge that dropped or
    // reshaped the field would turn every dictation into a failure.
    const seen: Parameters<VoiceApi["transcribeVoice"]>[0][] = []

    const voice = createDesktopVoice(
      bridge({
        transcribeVoice: async (input) => {
          seen.push(input)

          return { text: "hello" }
        },
      }),
    )

    const samples = new Float32Array([0.1, 0.2])
    const result = await voice.transcribeVoice({ samples, sampleRate: 16000, language: "en" })

    expect(result).toEqual({ text: "hello" })
    expect(seen).toEqual([{ samples, sampleRate: 16000, language: "en" }])
  })
})
