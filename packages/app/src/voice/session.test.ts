import { describe, expect, test } from "bun:test"

import type { PlatformVoiceStatus } from "@/runtime/platform/voice"
import { SAMPLE_RATE } from "./chunk"
import { SHORT_TAP_MS } from "./capture"
import { VoiceDictationSession } from "./session"

/**
 * The capture itself needs a live `navigator.mediaDevices`, which the test
 * runtime does not have. These therefore cover the part that is the session's
 * own responsibility — the rules about when text reaches the composer, when a
 * tap is discarded, and how status maps to a usable control — with capture and
 * transcription stubbed at the boundary.
 */

/**
 * Installs a fake media stack so `MicrophoneCapture` runs for real.
 *
 * `navigator` is a readonly getter in the test runtime, so it is redefined
 * rather than assigned. The fake processor keeps a handle on
 * `onaudioprocess`, which is how a test delivers audio: without real input the
 * capture would see silence and correctly discard the utterance.
 */
/** The one audio event `MicrophoneCapture` handles. */
type AudioProcessEvent = { inputBuffer: { getChannelData: (index: number) => Float32Array } }

function installMicrophone(options: { grant?: boolean } = {}) {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator")

  let stopped = false
  let processor: { onaudioprocess: ((event: AudioProcessEvent) => void) | null } | undefined

  const AudioContextStub = class {
    sampleRate = SAMPLE_RATE
    destination = {}
    close = async () => {}
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} }
    }
    createScriptProcessor() {
      processor = { onaudioprocess: null }

      return {
        set onaudioprocess(handler: ((event: AudioProcessEvent) => void) | null) {
          processor!.onaudioprocess = handler
        },
        get onaudioprocess() {
          return processor!.onaudioprocess
        },
        connect() {},
        disconnect() {},
      }
    }
    createGain() {
      return { gain: { value: 1 }, connect() {} }
    }
  }

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async () => {
          if (options.grant === false) throw new Error("Permission denied")

          return { getTracks: () => [{ stop: () => (stopped = true) }] }
        },
      },
    },
  })

  Object.defineProperty(globalThis, "AudioContext", { configurable: true, value: AudioContextStub })

  /** Feeds `samples` to the capture as one processor buffer. */
  const feed = (samples: Float32Array) => {
    processor?.onaudioprocess?.({
      inputBuffer: {
        getChannelData: () => samples,
      },
    })
  }

  return {
    feed,
    released: () => stopped,
    restore() {
      if (originalDescriptor) Object.defineProperty(globalThis, "navigator", originalDescriptor)

      // SAFETY: the stub was installed as a configurable own property by this
      // function, so deleting it restores the runtime's original global.
      delete (globalThis as { AudioContext?: unknown }).AudioContext
    },
  }
}

/**
 * Audio loud enough to clear the noise floor, so the capture treats it as
 * speech rather than discarding the utterance.
 */
function speech(samples = SAMPLE_RATE * 3): Float32Array {
  return new Float32Array(samples).fill(0.4)
}

/**
 * Feeds audio while advancing the session clock past the short-tap threshold,
 * so the capture sees a deliberate utterance rather than a misclick.
 */
function say(
  mic: { feed: (samples: Float32Array) => void },
  clock: { at: number },
  samples = SAMPLE_RATE * 3,
) {
  mic.feed(speech(samples))
  clock.at += 1000
}

/**
 * Feeds a click the clock never advances past, so the capture sees a press
 * shorter than `SHORT_TAP_MS`. Audio is still delivered, because the capture
 * measures elapsed time, not sample count.
 */
function tap(mic: { feed: (samples: Float32Array) => void }, clock: { at: number }) {
  mic.feed(speech(SAMPLE_RATE * 2))
  clock.at += SHORT_TAP_MS - 100
}

/** Records what the composer was asked to insert. */
function harness(
  options: {
    status?: PlatformVoiceStatus
    transcribe?: (input: { samples: Float32Array }) => { text: string }
    onError?: (message: string) => void
    withInsert?: boolean
    prepare?: () => Promise<PlatformVoiceStatus | undefined>
    /** Advances the capture's clock instead of waiting in real time. */
    clock?: { at: number }
  } = {},
) {
  const inserted: string[] = []

  const errors: string[] = []

  let status = options.status ?? { phase: "ready" as const }

  const session = new VoiceDictationSession(
    {
      status: async () => status,
      prepare: options.prepare,
      transcribe: async (input) => (options.transcribe ?? (() => ({ text: "hello" })))(input),
      insert: options.withInsert === false ? undefined : (text: string) => void inserted.push(text),
      onError: options.onError ?? ((message) => void errors.push(message)),
      now: options.clock ? () => options.clock!.at : undefined,
    },
    () => {},
  )

  return {
    session,
    inserted,
    errors,
    /** Lets a test move the engine on, the way a poll would see it change. */
    setStatus: (next: PlatformVoiceStatus) => {
      status = next
    },
  }
}

describe("VoiceDictationSession availability", () => {
  test("a ready engine enables the control", async () => {
    const h = harness({ status: { phase: "ready" } })
    await h.session.refresh()
    expect(h.session.state.enabled).toBe(true)
    expect(h.session.state.unavailable).toBeUndefined()
  })

  test("missing weights still enable the control, because the first click fetches them", async () => {
    // Reporting this as unavailable would leave dictation unreachable: nothing
    // would ever start the download.
    const h = harness({ status: { phase: "needs-download" } })
    await h.session.refresh()
    expect(h.session.state.enabled).toBe(true)
  })

  test("clicking while the weights are missing fetches them instead of recording", async () => {
    // The download is what this click is for, and it is not something recording
    // can wait on: the control reports the fetch and the click after it dictates.
    // Without this the first click would capture audio nothing could transcribe,
    // and nothing would ever start the fetch.
    let prepared = 0

    const h = harness({
      status: { phase: "needs-download" },
      prepare: async () => {
        prepared++

        return { phase: "ready" as const }
      },
    })

    await h.session.refresh()

    expect(await h.session.start()).toBe(false)
    expect(prepared).toBe(1)
    expect(h.session.state.recording).toBe(false)
    expect(h.session.state.downloading).toBeUndefined()
    expect(h.session.state.enabled).toBe(true)
  })

  test("a first-run download shows progress and refuses to record until it lands", async () => {
    let release: (() => void) | undefined

    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const h = harness({
      status: { phase: "needs-download" },
      prepare: async () => {
        await gate

        return { phase: "ready" as const }
      },
    })

    await h.session.refresh()

    const starting = h.session.start()

    // The total is not known until the first byte count arrives, which is why the
    // placeholder reports an explicit zero rather than guessing at 622 MB.
    expect(h.session.state.downloading).toEqual({ bytes: 0, total: 0 })
    expect(h.session.state.recording).toBe(false)

    release?.()
    await starting

    expect(h.session.state.downloading).toBeUndefined()
    expect(h.session.state.enabled).toBe(true)
  })

  test("a status read that beats the first byte does not hide the download", async () => {
    // The poll runs a second after the click; the first byte arrives when the
    // host answers. A read that still says "needs-download" must not turn the
    // control back into a plain mic — that also stops the poll, which is what
    // left a 622 MB fetch invisible from start to finish.
    let release: (() => void) | undefined

    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const h = harness({
      status: { phase: "needs-download" },
      prepare: async () => {
        await gate

        return { phase: "ready" as const }
      },
    })

    await h.session.refresh()

    const starting = h.session.start()

    expect(h.session.state.downloading).toEqual({ bytes: 0, total: 0 })
    expect(h.session.state.enabled).toBe(false)

    // The race: main has not seen a byte yet, so status still reports the need.
    await h.session.refresh()

    expect(h.session.state.downloading).toEqual({ bytes: 0, total: 0 })
    expect(h.session.state.enabled).toBe(false)

    release?.()
    await starting

    expect(h.session.state.downloading).toBeUndefined()
    expect(h.session.state.enabled).toBe(true)
  })

  test("progress reported by the main process replaces the placeholder", async () => {
    let release: (() => void) | undefined

    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const h = harness({
      status: { phase: "needs-download" },
      prepare: async () => {
        await gate

        return { phase: "ready" as const }
      },
    })

    await h.session.refresh()

    const starting = h.session.start()

    h.setStatus({ phase: "downloading", progress: { bytes: 100, total: 200 } })
    await h.session.refresh()

    expect(h.session.state.downloading).toEqual({ bytes: 100, total: 200 })
    // Still no click target: the fetch is not something a click can change.
    expect(h.session.state.enabled).toBe(false)

    release?.()
    await starting
  })

  test("a downloading engine disables the control and shows progress", async () => {
    const h = harness({ status: { phase: "downloading", progress: { bytes: 100, total: 200 } } })
    await h.session.refresh()
    expect(h.session.state.enabled).toBe(false)
    expect(h.session.state.downloading).toEqual({ bytes: 100, total: 200 })
  })

  test("an error phase disables the control and reports the reason", async () => {
    const h = harness({ status: { phase: "error", error: "no native module" } })
    await h.session.refresh()
    expect(h.session.state.enabled).toBe(false)
    expect(h.session.state.unavailable).toBe("no native module")
  })

  test("an unavailable platform disables the control with a plain reason", async () => {
    const h = harness({ status: { phase: "unavailable" } })
    await h.session.refresh()
    expect(h.session.state.enabled).toBe(false)
    expect(h.session.state.unavailable).toMatch(/not available/)
  })

  test("a status call that throws leaves the control disabled rather than crashing", async () => {
    const session = new VoiceDictationSession(
      {
        status: async () => {
          throw new Error("ipc down")
        },
        transcribe: async () => ({ text: "" }),
        insert: () => {},
      },
      () => {},
    )

    await session.refresh()
    expect(session.state.enabled).toBe(false)
  })
})

describe("VoiceDictationSession dictation", () => {
  test("start then stop inserts the transcript", async () => {
    const mic = installMicrophone()

    try {
      const clock = { at: 0 }
      const h = harness({ clock })
      await h.session.start()
      expect(h.session.state.recording).toBe(true)

      say(mic, clock)
      await h.session.stop()
      expect(h.inserted).toEqual(["hello"])
      expect(h.session.state.busy).toBe(false)
      expect(h.session.state.recording).toBe(false)
    } finally {
      mic.restore()
    }
  })

  test("the microphone is released after stopping", async () => {
    const mic = installMicrophone()

    try {
      const h = harness()
      await h.session.start()
      await h.session.stop()
      expect(mic.released()).toBe(true)
    } finally {
      mic.restore()
    }
  })

  test("a denied microphone reports plainly and starts nothing", async () => {
    const mic = installMicrophone({ grant: false })

    try {
      const h = harness()
      const started = await h.session.start()
      expect(started).toBe(false)
      expect(h.session.state.recording).toBe(false)
      expect(h.session.state.unavailable).toMatch(/denied/i)
      expect(h.errors.some((e) => /denied/i.test(e))).toBe(true)
    } finally {
      mic.restore()
    }
  })

  test("toggle alternates between recording and transcribing", async () => {
    const mic = installMicrophone()

    try {
      const clock = { at: 0 }
      const h = harness({ clock })
      await h.session.toggle()
      expect(h.session.state.recording).toBe(true)
      say(mic, clock)
      await h.session.toggle()
      expect(h.session.state.recording).toBe(false)
      expect(h.inserted).toEqual(["hello"])
    } finally {
      mic.restore()
    }
  })

  test("an empty transcript inserts nothing", async () => {
    const mic = installMicrophone()

    try {
      const clock = { at: 0 }
      const h = harness({ clock, transcribe: () => ({ text: "" }) })
      await h.session.start()
      say(mic, clock)
      await h.session.stop()
      expect(h.inserted).toEqual([])
      expect(h.session.state.busy).toBe(false)
    } finally {
      mic.restore()
    }
  })

  test("a transcription failure surfaces the message and stops working", async () => {
    const mic = installMicrophone()

    try {
      const clock = { at: 0 }

      const h = harness({
        clock,
        transcribe: () => {
          throw new Error("engine crashed")
        },
      })

      await h.session.start()
      say(mic, clock)
      await h.session.stop()
      expect(h.inserted).toEqual([])
      expect(h.errors).toContain("engine crashed")
      // busy must clear, or the mic spins forever with nothing running.
      expect(h.session.state.busy).toBe(false)
    } finally {
      mic.restore()
    }
  })

  test("cancel abandons the capture without transcribing", async () => {
    const mic = installMicrophone()

    try {
      let called = 0

      const h = harness({
        transcribe: () => {
          called++

          return { text: "should not appear" }
        },
      })

      await h.session.start()
      await h.session.cancel()
      expect(called).toBe(0)
      expect(h.inserted).toEqual([])
      expect(h.session.state.busy).toBe(false)
    } finally {
      mic.restore()
    }
  })

  test("stop with nothing recording does nothing", async () => {
    const h = harness()
    await h.session.stop()
    expect(h.inserted).toEqual([])
  })

  test("long audio is chunked and every chunk's text lands in order", async () => {
    // 80 s of audio exceeds the 35 s window, so the chunker must split it and
    // the session must insert each piece in sequence rather than only the last.
    const mic = installMicrophone()

    try {
      const seen: number[] = []
      const clock = { at: 0 }

      const h = harness({
        clock,
        transcribe: (input) => {
          seen.push(input.samples.length)

          return { text: `chunk-${seen.length} ` }
        },
      })

      await h.session.start()
      say(mic, clock, SAMPLE_RATE * 80)
      await h.session.stop()

      expect(seen.length).toBe(3)
      expect(h.inserted).toEqual(["chunk-1 ", "chunk-2 ", "chunk-3 "])
      expect(h.session.state.busy).toBe(false)
    } finally {
      mic.restore()
    }
  })

  test("a tap shorter than the threshold inserts nothing and reports no error", async () => {
    // A stray click near the mic must not become a prompt.
    const mic = installMicrophone()

    try {
      let called = 0
      const clock = { at: 0 }

      const h = harness({
        clock,
        transcribe: () => {
          called++

          return { text: "should not appear" }
        },
      })

      await h.session.start()
      tap(mic, clock)
      await h.session.stop()

      expect(called).toBe(0)
      expect(h.inserted).toEqual([])
      expect(h.errors).toEqual([])
      expect(h.session.state.busy).toBe(false)
    } finally {
      mic.restore()
    }
  })

  test("audio with no speech in it inserts nothing", async () => {
    const mic = installMicrophone()

    try {
      let called = 0
      const clock = { at: 0 }

      const h = harness({
        clock,
        transcribe: () => {
          called++

          return { text: "should not appear" }
        },
      })

      await h.session.start()
      mic.feed(new Float32Array(SAMPLE_RATE * 2))
      clock.at += 1000
      await h.session.stop()

      expect(called).toBe(0)
      expect(h.inserted).toEqual([])
    } finally {
      mic.restore()
    }
  })
})

describe("VoiceDictationSession without a composer hook", () => {
  test("dictation is refused when there is nowhere to insert", async () => {
    const mic = installMicrophone()

    try {
      const h = harness({ withInsert: false })
      await h.session.refresh()
      expect(h.session.state.enabled).toBe(false)
      expect(await h.session.start()).toBe(false)
    } finally {
      mic.restore()
    }
  })
})
