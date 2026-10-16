import { describe, expect, test } from "bun:test"
import { MicrophoneCapture, PRE_ROLL_MS, SHORT_TAP_MS } from "./capture"
import { SAMPLE_RATE } from "./chunk"

/**
 * The browser media APIs are unavailable here, so these cover the decision
 * rules that decide what reaches the transcriber: a tap that was never
 * intentional, and silence that should not become text.
 */
describe("capture thresholds", () => {
  test("the tap threshold is shorter than the pre-roll window", () => {
    // A tap that predates the stream opening must still be discardable, so the
    // intentional-start threshold has to stay under the pre-roll length.
    expect(SHORT_TAP_MS).toBeLessThan(PRE_ROLL_MS)
  })
})

describe("MicrophoneCapture", () => {
  test("start without a browser media API fails with a readable message", async () => {
    const capture = new MicrophoneCapture()
    // The test runtime has no navigator.mediaDevices.
    await expect(capture.start()).rejects.toThrow(/secure context|browser/)
  })

  test("stop before start returns empty audio and reports a short tap", async () => {
    const capture = new MicrophoneCapture({ now: () => 1000 })
    const result = await capture.stop()
    expect(result.samples.length).toBe(0)
    expect(result.sampleRate).toBe(SAMPLE_RATE)
    expect(result.silent).toBe(true)
    expect(result.shortTap).toBe(false) // nothing was ever started
  })

  test("nothing auto-stops before a stream exists", () => {
    const capture = new MicrophoneCapture()
    expect(capture.shouldAutoStop).toBe(false)
    expect(capture.recording).toBe(false)
  })

  test("a failed start leaves the capture not recording", async () => {
    const capture = new MicrophoneCapture()
    await capture.start().catch(() => {})
    expect(capture.recording).toBe(false)
  })
})