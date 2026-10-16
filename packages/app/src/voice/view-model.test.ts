import { describe, expect, test } from "bun:test"

import type { SessionState } from "./session"
import { dictationView, downloadPercent } from "./view-model"

/**
 * The repo's test runner has no JSX DOM renderer, so the presentational logic
 * lives in a plain view model the component reads. That keeps the meaning of
 * each state testable without a DOM, which is where the behaviour lives.
 */
function state(patch: Partial<SessionState> = {}): SessionState {
  return {
    enabled: true,
    recording: false,
    busy: false,
    downloading: undefined,
    unavailable: undefined,
    ...patch,
  }
}

describe("dictationView", () => {
  test("idle offers dictation", () => {
    expect(dictationView(state())).toMatchObject({
      icon: "mic",
      label: "Dictate",
      active: false,
      showLevel: false,
      showCancel: false,
      disabled: false,
    })
  })

  test("recording switches to the active mic, a level bar and cancel", () => {
    expect(dictationView(state({ recording: true }))).toMatchObject({
      icon: "mic-active",
      label: "Stop dictation",
      active: true,
      showLevel: true,
      showCancel: true,
      disabled: false,
    })
  })

  test("transcribing spins and stops offering cancel", () => {
    const view = dictationView(state({ busy: true }))
    expect(view.label).toBe("Transcribing")
    expect(view.icon).toBe("spinner")
    expect(view.showCancel).toBe(false)
    // Still clickable: a second utterance may be started while this one lands.
    expect(view.disabled).toBe(false)
  })

  test("an unavailable engine disables the control and keeps the reason on its title", () => {
    // The reason belongs on the control so it reaches keyboard and screen
    // reader users, not only someone watching a toast.
    const view = dictationView(state({ enabled: false, unavailable: "no native module" }))
    expect(view.disabled).toBe(true)
    expect(view.label).toBe("Dictation unavailable")
    expect(view.title).toBe("no native module")
  })

  test("a first-run download disables the control and says so", () => {
    // Offering to cancel 622 MB would be a false affordance, so it is disabled
    // rather than presented as interruptible.
    const view = dictationView(state({ downloading: { bytes: 1, total: 4 } }))
    expect(view.icon).toBe("download")
    expect(view.label).toBe("Downloading speech model")
    expect(view.disabled).toBe(true)
  })

  test("an enabled title falls back to the label", () => {
    expect(dictationView(state()).title).toBe("Dictate")
    expect(dictationView(state({ recording: true })).title).toBe("Stop dictation")
  })

  test("disabled wins over recording", () => {
    expect(dictationView(state({ enabled: false, recording: true })).disabled).toBe(true)
  })

  test("level maps RMS to a bar index, clamped at both ends", () => {
    expect(dictationView(state(), { level: undefined }).level).toBe(0)
    expect(dictationView(state(), { level: 0 }).level).toBe(0)
    expect(dictationView(state(), { level: 10 }).level).toBe(4)
    expect(dictationView(state(), { level: -1 }).level).toBe(0)
  })

  test("settling back to idle clears every affordance", () => {
    expect(dictationView(state())).toMatchObject({ icon: "mic", showLevel: false, showCancel: false })
  })
})

describe("downloadPercent", () => {
  test("reports a rounded percentage", () => {
    expect(downloadPercent({ bytes: 1, total: 4 })).toBe(25)
    expect(downloadPercent({ bytes: 1, total: 3 })).toBe(33)
    expect(downloadPercent({ bytes: 4, total: 4 })).toBe(100)
  })

  test("returns nothing when there is no progress or no total", () => {
    expect(downloadPercent(undefined)).toBeUndefined()
    expect(downloadPercent({ bytes: 0, total: 0 })).toBeUndefined()
  })
})