import { describe, expect, test } from "bun:test"
import { chunkRecording, MAX_CHUNK_SECONDS, rms, SAMPLE_RATE, voiceActivity, withTailForTest } from "./chunk"

const seconds = (n: number) => new Float32Array(Math.round(n * SAMPLE_RATE)).fill(0.5)

describe("chunkRecording", () => {
  test("an empty recording produces no chunks", () => {
    expect(chunkRecording(new Float32Array(0))).toEqual([])
  })

  test("a short clip is one chunk", () => {
    const chunks = chunkRecording(seconds(3))
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.final).toBe(true)
    expect(chunks[0]!.startSeconds).toBe(0)
  })

  test("a long recording splits at the reference window, not the encoder limit", () => {
    // 90 s is far beyond what one inference window can carry.
    const chunks = chunkRecording(seconds(90))
    expect(chunks).toHaveLength(3)
    expect(chunks.map((c) => Math.round(c.startSeconds))).toEqual([0, MAX_CHUNK_SECONDS, MAX_CHUNK_SECONDS * 2])
    // Only the tail chunk is marked final; intermediate ones must not get padding.
    expect(chunks.map((c) => c.final)).toEqual([false, false, true])
  })

  test("chunks never exceed the window plus the final tail pad", () => {
    const limit = MAX_CHUNK_SECONDS * SAMPLE_RATE + Math.round(0.2 * SAMPLE_RATE)

    for (const chunk of chunkRecording(seconds(70))) {
      expect(chunk.samples.length).toBeLessThanOrEqual(limit)
    }
  })

  test("the final chunk gets trailing padding, earlier chunks do not", () => {
    const chunks = chunkRecording(seconds(70))
    const exact = MAX_CHUNK_SECONDS * SAMPLE_RATE
    expect(chunks[0]!.samples.length).toBe(exact)
    expect(chunks[1]!.samples.length).toBeGreaterThan(0)
  })

  test("order is preserved across chunks", () => {
    const input = new Float32Array(MAX_CHUNK_SECONDS * SAMPLE_RATE + 1000)
    input.fill(0.25, 0, MAX_CHUNK_SECONDS * SAMPLE_RATE)
    input.fill(0.75, MAX_CHUNK_SECONDS * SAMPLE_RATE)
    const chunks = chunkRecording(input)
    expect(chunks[0]!.samples[0]).toBeCloseTo(0.25, 5)
    expect(chunks[1]!.samples[0]).toBeCloseTo(0.75, 5)
  })

  test("chunks are copies, so the source buffer can be reused", () => {
    const input = seconds(2)
    const chunks = chunkRecording(input)
    input.fill(0)
    expect(chunks[0]!.samples[0]).toBeCloseTo(0.5, 5)
  })

  test("withTailForTest pads only the trailing edge", () => {
    const padded = withTailForTest(seconds(1))
    expect(padded[0]).toBeCloseTo(0.5, 5)
    expect(padded[padded.length - 1]).toBe(0)
  })
})

describe("levels", () => {
  test("rms of silence is zero and of a full-scale square is one", () => {
    expect(rms(new Float32Array(128))).toBe(0)
    expect(rms(new Float32Array(128).fill(1))).toBeCloseTo(1, 5)
  })

  test("voice activity separates silence from speech", () => {
    expect(voiceActivity(new Float32Array(256))).toBe(0)
    expect(voiceActivity(new Float32Array(256).fill(0.4))).toBe(1)
  })
})