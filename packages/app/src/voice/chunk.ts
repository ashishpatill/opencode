/**
 * Audio buffering for dictation.
 *
 * Two behaviors here come from measured failures in the reference
 * implementation (anomalyco/hex), not from preference:
 *
 * 1. Inference is chunked at the *reference processor* window, not the
 *    encoder's advertised capacity. Treating a backend's 400-second encoder
 *    capacity as a usable inference window silently dropped entire passages
 *    from long recordings (hex issue #73).
 * 2. A minimum trailing pad is applied after the final chunk, because very
 *    short clips give transducer decoders too little context and accuracy
 *    collapses on the last words.
 */

/** 16 kHz mono, the rate every speech model here expects. */
export const SAMPLE_RATE = 16_000

/** Reference-processor inference window. Not the encoder capacity. */
export const MAX_CHUNK_SECONDS = 35

/** Trailing silence appended to a clip before inference. */
export const MIN_TAIL_SECONDS = 0.2

export type Chunk = {
  readonly samples: Float32Array
  readonly startSeconds: number
  /** Last chunk of an utterance carries the tail pad. */
  readonly final: boolean
}

const samplesPerChunk = SAMPLE_RATE * MAX_CHUNK_SECONDS

/**
 * Splits a continuous recording into inference-sized chunks, preserving order.
 *
 * Deliberately does not remove silence: chunk boundaries bound inference cost,
 * not what the speaker said. VAD-based trimming can clip word onsets between
 * windows and belongs in the recognition layer, not here.
 */
export function chunkRecording(input: Float32Array): Chunk[] {
  if (input.length === 0) return []

  const chunks: Chunk[] = []

  for (let offset = 0; offset < input.length; offset += samplesPerChunk) {
    const slice = input.subarray(offset, Math.min(offset + samplesPerChunk, input.length))
    const isLast = offset + samplesPerChunk >= input.length
    // Copy so the caller can reuse the buffer, and pad the final chunk.
    const padded = isLast ? withTailPad(slice) : new Float32Array(slice)
    chunks.push({
      samples: padded,
      startSeconds: offset / SAMPLE_RATE,
      final: isLast,
    })
  }

  return chunks
}

/** Exported for tests: the padding policy applied to the final chunk. */
export function withTailForTest(samples: Float32Array): Float32Array {
  return withTailPad(samples)
}

function withTailPad(samples: Float32Array): Float32Array {
  const pad = Math.round(MIN_TAIL_SECONDS * SAMPLE_RATE)

  if (pad <= 0) return new Float32Array(samples)
  const out = new Float32Array(samples.length + pad)
  out.set(samples, 0)

  return out
}

/** Root-mean-square level of a buffer, used to drive the mic's live meter. */
export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sum = 0

  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]

  return Math.sqrt(sum / samples.length)
}

/** Fraction of the input above the noise floor, for the speaking/not gate. */
export function voiceActivity(samples: Float32Array, threshold = 0.01): number {
  if (samples.length === 0) return 0
  let above = 0

  for (let i = 0; i < samples.length; i++) if (Math.abs(samples[i]) > threshold) above++

  return above / samples.length
}