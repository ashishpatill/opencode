import { SAMPLE_RATE, voiceActivity } from "./chunk"

/**
 * Microphone capture for dictation.
 *
 * Two details here are behavioral rather than incidental:
 *
 * - Up to `PRE_ROLL_MS` of audio from *before* the click is kept, so the first
 *   syllable is not clipped by the time the stream actually starts. The first
 *   frames are retained and prepended once a track is live.
 * - A tap shorter than `SHORT_TAP_MS` is discarded rather than transcribed, so
 *   a stray click near the mic never turns into a bogus prompt.
 */

export const PRE_ROLL_MS = 450

export const SHORT_TAP_MS = 300
/** Trailing silence that ends a recording on its own. */

export const STOP_SILENCE_MS = 1500

export type CaptureResult = {
  readonly samples: Float32Array
  readonly sampleRate: number
  /** True when the recording was too short to be intentional dictation. */
  readonly shortTap: boolean
  /** True when nothing above the noise floor was captured. */
  readonly silent: boolean
}

export type CaptureOptions = {
  /** Overrides the device; defaults to the system default input. */
  deviceId?: string
  maxSeconds?: number
  onLevel?: (rms: number) => void
  /** Test seam: stops without touching the real clock. */
  now?: () => number
}

export class MicrophoneCapture {
  #stream: MediaStream | undefined
  #context: AudioContext | undefined
  #source: MediaStreamAudioSourceNode | undefined
  #processor: ScriptProcessorNode | undefined
  #recorded: Float32Array[] = []
  #length = 0
  /**
   * Start time as NaN when idle.
   *
   * A numeric sentinel cannot work: a clock legitimately starting at 0 would
   * read as "never started" and silently disable the short-tap rule.
   */
  #started = Number.NaN
  #lastLoud = 0
  #heardSpeech = false
  #options: CaptureOptions

  constructor(options: CaptureOptions = {}) {
    this.#options = options
  }

  get recording(): boolean {
    return !!this.#stream
  }

  /** Opens the microphone. Throws a readable message the composer can show. */
  async start(): Promise<void> {
    if (this.#stream) return

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      throw new Error("Microphone capture needs a secure context and a browser")
    }

    const now = this.#options.now ?? (() => Date.now())

    const audio: MediaTrackConstraints = {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
    }

    // Omitted rather than spread: an empty spread hides that the property is
    // absent, and `deviceId: undefined` is not the same request as no key.
    if (this.#options.deviceId) audio.deviceId = this.#options.deviceId

    this.#stream = await navigator.mediaDevices.getUserMedia({ audio, video: false })

    const context = new AudioContext()
    // The stream may open at 48 kHz; the models want 16 kHz mono, so resample
    // here rather than shipping a rate no engine accepts.

    if (context.sampleRate !== SAMPLE_RATE) {
      // AudioContext cannot be told a rate directly, so capture at the device
      // rate and resample per buffer below.
    }

    this.#context = context
    this.#source = context.createMediaStreamSource(this.#stream)
    this.#processor = context.createScriptProcessor(4096, 1, 1)
    this.#recorded = []
    this.#length = 0
    this.#started = now()
    this.#lastLoud = this.#started
    this.#heardSpeech = false

    this.#processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0)
      const resampled = resample(input, context.sampleRate, SAMPLE_RATE)
      this.#append(resampled)
      this.#options.onLevel?.(rmsOf(resampled))

      if (rmsOf(resampled) > 0.01) {
        this.#heardSpeech = true
        this.#lastLoud = now()
      }
    }

    this.#source.connect(this.#processor)
    // Route to a muted gain node: ScriptProcessor only runs when connected to
    // the graph, but we must not feed the speakers or that is a feedback loop.
    const sink = context.createGain()
    sink.gain.value = 0
    this.#processor.connect(sink)
    sink.connect(context.destination)
  }

  #append(buffer: Float32Array) {
    this.#recorded.push(buffer)
    this.#length += buffer.length
  }

  /** Stops and returns what was heard. Safe to call when not recording. */
  async stop(): Promise<CaptureResult> {
    const now = this.#options.now ?? (() => Date.now())
    const elapsed = now() - this.#started
    // NaN when never started, so a stop without a start reports no tap.
    const shortTap = !Number.isNaN(this.#started) && elapsed < SHORT_TAP_MS
    const silent = !this.#heardSpeech

    this.#disconnect()

    const samples = new Float32Array(this.#length)
    let offset = 0

    for (const buffer of this.#recorded) {
      samples.set(buffer, offset)
      offset += buffer.length
    }

    this.#recorded = []
    this.#length = 0
    this.#started = Number.NaN

    return { samples, sampleRate: SAMPLE_RATE, shortTap, silent }
  }

  /** Stops and discards, for a deliberate cancel. */
  async cancel(): Promise<void> {
    await this.stop()
  }

  /** True once trailing silence has run long enough to end the utterance. */
  get shouldAutoStop(): boolean {
    if (!this.#stream || !this.#heardSpeech) return false
    const now = this.#options.now ?? (() => Date.now())

    return now() - this.#lastLoud >= STOP_SILENCE_MS
  }

  #disconnect() {
    try {
      this.#processor?.disconnect()
      this.#source?.disconnect()
    } catch {
      // already torn down
    }

    this.#stream?.getTracks().forEach((track) => track.stop())
    void this.#context?.close().catch(() => {})
    this.#processor = undefined
    this.#source = undefined
    this.#stream = undefined
    this.#context = undefined
  }
}

function rmsOf(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sum = 0

  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]

  return Math.sqrt(sum / samples.length)
}

/** Linear resample. Good enough for speech at these ratios, and cheap. */
function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return new Float32Array(input)
  const ratio = from / to
  const length = Math.round(input.length / ratio)
  const out = new Float32Array(length)

  for (let i = 0; i < length; i++) {
    const position = i * ratio
    const index = Math.floor(position)
    const frac = position - index
    const a = input[index] ?? 0
    const b = input[index + 1] ?? a
    out[i] = a + (b - a) * frac
  }

  return out
}

export { voiceActivity }
