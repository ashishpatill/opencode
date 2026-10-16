/**
 * Dictation session state machine.
 *
 * Every rule here is behavioral, not cosmetic, and each traces to a documented
 * failure mode in the reference implementation (anomalyco/hex/docs/features):
 *
 * - A capture that is cancelled must produce no text at all. Cancellation after
 *   output has been committed cannot be undone, so "committed" is a real
 *   boundary and not a state we try to unwind.
 * - Starting a new capture never cancels work that was already accepted; two
 *   utterances can be in flight and outputs keep their submission order.
 * - A late completion for a capture that was already cancelled or superseded is
 *   fenced off and dropped rather than inserted.
 */

/** Phases a single capture moves through. */
export type DictationPhase = "idle" | "recording" | "transcribing" | "inserting"

export type CaptureState = {
  readonly id: number
  readonly phase: DictationPhase
  /** Set once the transcript is committed to the composer. Terminal. */
  readonly committed: boolean
  readonly cancelled: boolean
}

export type StartResult = { readonly ok: true } | { readonly ok: false; readonly reason: string }

export class DictationController {
  #next = 1
  /** Every capture the session has seen, so late results can be fenced. */
  #captures = new Map<number, CaptureState>()
  /** Capture ids in the order they were accepted; output follows this order. */
  #order: number[] = []
  #onChange: (state: ReadonlyMap<number, CaptureState>) => void

  constructor(onChange?: (state: ReadonlyMap<number, CaptureState>) => void) {
    this.#onChange = onChange ?? (() => {})
  }

  get phase(): DictationPhase {
    // The newest capture drives the visible state.
    const last = this.#latest()

    return last?.phase ?? "idle"
  }

  get isRecording(): boolean {
    return this.#latest()?.phase === "recording"
  }

  /** True while any accepted capture still owes text to the composer. */
  get isBusy(): boolean {
    for (const state of this.#captures.values()) {
      if (state.cancelled || state.committed) continue

      if (state.phase !== "idle") return true
    }

    return false
  }

  /** True when a stop control should be offered. */
  get canStop(): boolean {
    return this.#latest()?.phase === "recording"
  }

  /**
   * Begins a capture. Always allowed: a new utterance never cancels an older
   * accepted one, so repeated presses queue rather than clobber.
   */
  start(): StartResult {
    const id = this.#next++
    const state: CaptureState = { id, phase: "recording", committed: false, cancelled: false }
    this.#captures.set(id, state)
    this.#order.push(id)
    this.#emit()

    return { ok: true }
  }

  /** Recording finished; audio is being recognized. */
  finish(id: number): boolean {
    return this.#transition(id, "transcribing")
  }

  /** Recognition finished; about to write into the composer. */
  ready(id: number): boolean {
    return this.#transition(id, "inserting")
  }

  /** Marks text as written. Terminal: nothing after this can undo it. */
  commit(id: number): boolean {
    const state = this.#captures.get(id)

    if (!state || state.cancelled || state.committed) return false
    this.#captures.set(id, { ...state, phase: "idle", committed: true })
    this.#emit()

    return true
  }

  /**
   * Cancels the newest capture, or the newest still-cancellable one when
   * recording has already stopped. Older accepted work is untouched.
   */
  cancel(): boolean {
    const target = [...this.#order].reverse().find((id) => {
      const state = this.#captures.get(id)

      return !!state && !state.cancelled && !state.committed
    })

    if (target === undefined) return false
    const state = this.#captures.get(target)!
    this.#captures.set(target, { ...state, phase: "idle", cancelled: true })
    this.#emit()

    return true
  }

  /**
   * Whether a result for `id` may still be written. False once the capture was
   * cancelled, committed elsewhere, or is not the newest accepted capture —
   * this is the fence that stops a late transcription landing in the composer.
   */
  canInsert(id: number): boolean {
    const state = this.#captures.get(id)

    if (!state || state.cancelled || state.committed) return false

    return this.#latest()?.id === id
  }

  /** Accepted captures awaiting text, oldest first. Output must follow this. */
  pendingInOrder(): number[] {
    return this.#order.filter((id) => {
      const state = this.#captures.get(id)

      return !!state && !state.cancelled && !state.committed && state.phase !== "idle"
    })
  }

  /** Drops settled captures so a long session does not grow without bound. */
  prune(): void {
    for (const [id, state] of this.#captures) {
      if (!state.committed && !state.cancelled) continue
      this.#captures.delete(id)
      this.#order = this.#order.filter((entry) => entry !== id)
    }
  }

  #latest(): CaptureState | undefined {
    for (let i = this.#order.length - 1; i >= 0; i--) {
      const state = this.#captures.get(this.#order[i]!)

      if (!state || state.cancelled || state.committed) continue

      return state
    }

    return undefined
  }

  #transition(id: number, phase: DictationPhase): boolean {
    const state = this.#captures.get(id)

    if (!state || state.cancelled || state.committed) return false
    this.#captures.set(id, { ...state, phase })
    this.#emit()

    return true
  }

  #emit() {
    this.#onChange(new Map(this.#captures))
  }
}