import type { DictationController } from "./controller"

/**
 * The dictation control's presentational state, kept out of the component so
 * the meaning of each phase is testable without a DOM.
 *
 * State is expressed by shape, not only colour: the mic fills when recording,
 * and the level bar and cancel affordance appear only while there is something
 * to control. That survives a low-contrast theme and a colorblind reader.
 */

/** Level-bar widths in px, quietest first. */
export const LEVELS = [2, 4, 7, 11, 15] as const

export type DictationView = {
  readonly icon: "mic" | "mic-active" | "spinner"
  readonly label: string
  readonly active: boolean
  readonly showLevel: boolean
  readonly showCancel: boolean
  readonly disabled: boolean
  readonly level: number
}

export function dictationView(
  controller: DictationController,
  input: { level?: number | undefined; error?: string | undefined; disabled?: boolean } = {},
): DictationView {
  const phase = controller.phase
  const recording = phase === "recording"
  const transcribing = phase === "transcribing"

  const level = levelIndex(input.level)

  return {
    icon: recording ? "mic-active" : transcribing ? "spinner" : "mic",
    label: input.error
      ? "Microphone unavailable"
      : recording
        ? "Stop dictation"
        : transcribing
          ? "Transcribing"
          : phase === "inserting"
            ? "Inserting"
            : "Dictate",
    active: recording,
    showLevel: recording,
    showCancel: recording,
    disabled: input.disabled === true || input.error !== undefined,
    level,
  }
}

function levelIndex(rms: number | undefined): number {
  if (rms === undefined || Number.isNaN(rms)) return 0
  // Speech sits well below full scale; scale up so ordinary talking moves the bar.
  const scaled = Math.min(1, Math.max(0, rms * 3))

  return Math.min(LEVELS.length - 1, Math.floor(scaled * LEVELS.length))
}