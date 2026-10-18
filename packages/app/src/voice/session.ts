/**
 * Wires the capture, the state machine and the main-process recognizer into one
 * unit the composer can drive.
 *
 * The renderer owns two thirds of this: `MicrophoneCapture` takes the audio and
 * `DictationController` decides what is allowed to reach the composer. What
 * lives here is the part that has to know about both — the ordering of the
 * phases, and the fact that the first dictation on a fresh install may have to
 * fetch 622 MB of weights before any audio is recognized.
 *
 * Deliberately free of Solid: the composer binds to the state through signals,
 * and keeping this testable without a DOM matches how the rest of the voice
 * code is structured.
 */

import { SAMPLE_RATE, chunkRecording } from "./chunk"
import { MicrophoneCapture } from "./capture"
import { DictationController } from "./controller"
import type { PlatformVoiceStatus } from "@/runtime/platform/voice"
import { canDictate } from "@/runtime/platform/voice"

/** What the composer must be able to do, so the mic can be shown or hidden. */
export type VoiceDeps = {
  /** Absent on web and anywhere without local recognition. */
  readonly status?: () => Promise<PlatformVoiceStatus | undefined>
  readonly prepare?: () => Promise<PlatformVoiceStatus | undefined>
  readonly transcribe: (input: {
    samples: Float32Array
    sampleRate: number
    language?: string
  }) => Promise<{ text: string }>
  /** Inserts text at the caret. Omitted means dictation has nowhere to land. */
  readonly insert?: (text: string) => void
  readonly language?: string
  readonly onError?: (message: string) => void
  /**
   * Live microphone level in 0..1, for the meter's visual feedback.
   *
   * Pushed from the capture's audio callback rather than polled, so the meter
   * costs nothing at all while not recording.
   */
  readonly onLevel?: (rms: number) => void
  /**
   * Clock seam for the capture's duration rules.
   *
   * The short-tap threshold is wall-clock, so tests that record faster than
   * 300 ms of real time would otherwise have every utterance discarded as a
   * misclick.
   */
  readonly now?: () => number
}

export type SessionState = {
  /** Whether the control should accept a click. */
  readonly enabled: boolean
  readonly recording: boolean
  readonly busy: boolean
  /** True while the first-run weight download runs, with bytes so far. */
  readonly downloading: { bytes: number; total: number } | undefined
  /** Why dictation cannot run, for a tooltip or inline hint. */
  readonly unavailable: string | undefined
}

/**
 * Before the first status read nothing is claimed about the engine.
 *
 * "Not available" used to be spelled here as well as for a genuinely
 * unsupported platform, which meant the control said the same wrong thing while
 * it was still checking, and while a first-run download was under way.
 */
const INITIAL: SessionState = {
  enabled: false,
  recording: false,
  busy: false,
  downloading: undefined,
  unavailable: undefined,
}

/**
 * Drives one dictation session.
 *
 * Each public method returns the state synchronously and notifies `onChange`
 * when something actually moved, so the composer never re-renders on a poll
 * that found nothing new.
 */
export class VoiceDictationSession {
  #deps: VoiceDeps
  #controller = new DictationController()
  #capture: MicrophoneCapture
  #state: SessionState = INITIAL
  #onChange: (state: SessionState) => void
  /** Last status read, so a click can tell "not downloaded" from "not ready". */
  #status: PlatformVoiceStatus | undefined
  /** True while a `prepare` this session started is still in flight. */
  #pending = false
  /** Identity of the capture whose audio is currently in flight. */
  #active: number | undefined
  /** Serializes clicks so a double-tap cannot start two captures. */
  #toggling: Promise<void> = Promise.resolve()

  constructor(deps: VoiceDeps, onChange: (state: SessionState) => void) {
    this.#deps = deps
    this.#onChange = onChange
    this.#capture = new MicrophoneCapture({ now: deps.now, onLevel: deps.onLevel })
  }

  get state(): SessionState {
    return this.#state
  }

  /** Refreshes availability from the platform. Cheap enough to call on mount. */
  async refresh(): Promise<void> {
    this.#apply(this.#deps.status ? await this.#deps.status().catch(() => undefined) : undefined)
  }

  /**
   * Applies a status reading to the visible state.
   *
   * One place decides what a phase means for the control, so the mount-time read
   * and the end of a download cannot disagree about it.
   */
  #apply(status: PlatformVoiceStatus | undefined) {
    this.#status = status

    const reported = status?.phase === "downloading" ? status.progress : undefined

    this.#publish({
      enabled: !this.#pending && canDictate(status) && !!this.#deps.insert,
      unavailable: describeUnavailable(status, this.#deps),
      // Held for as long as this session's own fetch is in flight, including
      // through a status read that raced ahead of the first byte. Dropping it
      // there would also stop the composer's poll, which is what left the control
      // reading "Dictate" for the whole of a 622 MB download.
      downloading: this.#pending ? (reported ?? this.#state.downloading ?? { bytes: 0, total: 0 }) : reported,
    })
  }

  /**
   * Fetches the weights, reporting progress, and leaves recording to the next click.
   *
   * A download is not something recording can wait on: 622 MB is minutes, and
   * holding the microphone open for it would be worse than doing nothing. So the
   * click that asks for dictation on a fresh install buys the model, the control
   * shows the fetch, and the click after that records.
   */
  async #download(): Promise<void> {
    if (!this.#deps.prepare) return

    this.#pending = true
    this.#publish({ downloading: { bytes: 0, total: 0 }, enabled: false })

    let status: PlatformVoiceStatus | undefined

    try {
      status = await this.#deps.prepare()
    } catch {
      // The main process reports a failed fetch as an error phase, so this is
      // only for a transport that broke outright.
      status = undefined
    } finally {
      this.#pending = false
    }

    this.#apply(status)
  }

  /**
   * Starts or stops, whichever the current state calls for.
   *
   * The two are one method because the control is one button; callers that want
   * a specific action use `start` or `stop`.
   */
  toggle(): Promise<void> {
    return this.#serialize(async () => {
      if (this.#state.recording) await this.stop()
      else await this.start()
    })
  }

  /** Click to begin. Returns false when dictation cannot run. */
  async start(): Promise<boolean> {
    if (!this.#state.enabled && this.#state.unavailable === undefined) {
      await this.refresh()
    }

    if (this.#deps.status === undefined || this.#deps.insert === undefined) {
      this.#publish({ unavailable: "Dictation is not available on this platform" })

      return false
    }

    // Weights are not on disk yet, so this click is the request to fetch them.
    // It returns without recording: the control shows the download, and the click
    // after it completes is the one that dictates.
    if (this.#status?.phase === "needs-download") {
      await this.#download()

      return false
    }

    const result = this.#controller.start()

    if (!result.ok) {
      this.#deps.onError?.(result.reason)

      return false
    }

    const id = this.#active = result.id

    try {
      await this.#capture.start()
    } catch (cause) {
      // Permission denied is the common case and worth saying plainly.
      this.#controller.cancel()
      this.#active = undefined
      this.#publish({ recording: false, unavailable: captureError(cause) })
      this.#deps.onError?.(captureError(cause))

      return false
    }

    this.#publish({ recording: true, unavailable: undefined })

    return id !== undefined
  }

  /**
   * Stops recording and transcribes. A tap too short to be intentional, or a
   * capture with no speech in it, produces no text and no error.
   */
  async stop(): Promise<void> {
    if (!this.#capture.recording) return

    const result = await this.#capture.stop()
    const id = this.#active
    this.#active = undefined
    this.#publish({ recording: false, busy: true })

    if (id === undefined) {
      this.#publish({ busy: false })

      return
    }

    // Below the recognizer's minimum a click was a misclick, not an utterance.
    // No error: the user did nothing wrong and there is nothing to report.
    if (result.shortTap || result.silent) {
      this.#controller.cancel()
      this.#publish({ busy: false })

      return
    }

    await this.#transcribeInto(id, result.samples)
  }

  /** Abandons the current capture without transcribing it. */
  async cancel(): Promise<void> {
    await this.#capture.cancel().catch(() => {})
    this.#active = undefined
    this.#controller.cancel()
    this.#publish({ recording: false, busy: false })
  }

  /**
   * Transcribes and inserts, chunk by chunk.
   *
   * Chunks are committed in order and only while the capture is still allowed
   * to insert, so a cancellation mid-way stops the remaining text landing.
   */
  async #transcribeInto(id: number, samples: Float32Array): Promise<void> {
    this.#controller.finish(id)

    const chunks = chunkRecording(samples)

    try {
      for (const chunk of chunks) {
        // Re-checked before every call: a cancel during a slow chunk must stop
        // the remaining text from landing.
        if (!this.#controller.canInsert(id)) return

        const { text } = await this.#deps.transcribe({
          samples: chunk.samples,
          sampleRate: SAMPLE_RATE,
          language: this.#deps.language,
        })

        if (!this.#controller.canInsert(id)) return

        if (text) {
          this.#controller.ready(id)
          this.#deps.insert?.(text)
        }
      }

      this.#controller.commit(id)
    } catch (cause) {
      this.#controller.cancel()
      this.#deps.onError?.(cause instanceof Error ? cause.message : String(cause))
    } finally {
      // Every exit clears busy, including the cancelled and failed ones —
      // otherwise the mic is stuck spinning with nothing running.
      this.#publish({ busy: false })
    }
  }

  async dispose(): Promise<void> {
    await this.cancel().catch(() => {})
  }

  #serialize<T>(action: () => Promise<T>): Promise<T> {
    const next = this.#toggling.then(action, action)

    this.#toggling = next.then(
      () => {},
      () => {},
    )

    return next
  }

  #publish(patch: Partial<SessionState>) {
    const next = { ...this.#state, ...patch }
    // Written out rather than derived from Object.keys: every field is a
    // primitive, so an explicit comparison is exact, and adding a field to
    // SessionState without adding it here fails typecheck instead of silently
    // never triggering a repaint.

    const changed =
      next.enabled !== this.#state.enabled ||
      next.recording !== this.#state.recording ||
      next.busy !== this.#state.busy ||
      next.downloading !== this.#state.downloading ||
      next.unavailable !== this.#state.unavailable

    this.#state = next

    if (changed) this.#onChange(next)
  }
}

/** Why dictation is unavailable, phrased for the user rather than the log. */
function describeUnavailable(status: PlatformVoiceStatus | undefined, deps: VoiceDeps): string | undefined {
  if (!deps.status || !deps.insert) return "Dictation is not available on this platform"

  if (!status) return "Checking dictation availability"

  if (status.phase === "unavailable") return "Dictation is not available on this platform"

  if (status.phase === "error") return status.error ?? "Dictation failed to start"

  // `downloading` is deliberately not listed: the fetch is progress, not a
  // refusal, and the control's own label already says so. Setting `unavailable`
  // here would also put a status message where the UI expects a reason.
  return undefined
}

function captureError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)

  if (/permission|denied|notallowed/i.test(message)) return "Microphone access was denied"

  return message || "Could not start recording"
}
