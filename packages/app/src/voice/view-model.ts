import type { SessionState } from "./session"

/**
 * The dictation control's presentational state, kept out of the component so
 * the meaning of each phase is testable without a DOM.
 *
 * State is expressed by shape, not only colour: the mic fills when recording,
 * and the level bar and cancel affordance appear only while there is something
 * to control. That survives a low-contrast theme and a colorblind reader.
 *
 * The input is the session's state rather than the controller's phase directly,
 * because that is what decides the three things the user actually sees:
 * whether the button accepts a click, what it says when it cannot, and whether
 * a download is under way.
 */

/** Level-bar widths in px, quietest first. */
export const LEVELS = [2, 4, 7, 11, 15] as const

export type DictationView = {
  readonly icon: "mic" | "mic-active" | "spinner" | "download"
  readonly label: string
  /** Accessible name, which carries the reason a disabled control cannot run. */
  readonly title: string
  readonly active: boolean
  readonly showLevel: boolean
  readonly showCancel: boolean
  readonly disabled: boolean
  readonly level: number
}

export function dictationView(state: SessionState, input: { level?: number | undefined } = {}): DictationView {
  const recording = state.recording
  const busy = state.busy
  const downloading = state.downloading !== undefined

  return {
    icon: downloading ? "download" : recording ? "mic-active" : busy ? "spinner" : "mic",
    label: label(state),
    // The reason belongs on the control, so it is reachable from the keyboard
    // and by a screen reader rather than only as transient toast text.
    title: state.unavailable ?? label(state),
    active: recording,
    showLevel: recording,
    showCancel: recording,
    // Downloading disables rather than spins: the fetch is not something a click
    // can change, and offering to cancel 622 MB would be a false affordance.
    disabled: !state.enabled || downloading,
    level: levelIndex(input.level),
  }
}

function label(state: SessionState): string {
  if (state.downloading) return "Downloading speech model"

  if (state.recording) return "Stop dictation"

  if (state.busy) return "Transcribing"

  if (state.unavailable) return "Dictation unavailable"

  return "Dictate"
}

function levelIndex(rms: number | undefined): number {
  if (rms === undefined || Number.isNaN(rms)) return 0

  // Speech sits well below full scale; scale up so ordinary talking moves the bar.
  const scaled = Math.min(1, Math.max(0, rms * 3))

  return Math.min(LEVELS.length - 1, Math.floor(scaled * LEVELS.length))
}

/** Compact download percentage, for the control's progress line. */
export function downloadPercent(progress: { bytes: number; total: number } | undefined): number | undefined {
  if (!progress || progress.total <= 0) return undefined

  return Math.round((progress.bytes / progress.total) * 100)
}
