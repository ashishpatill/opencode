import { describe, expect, test } from "bun:test"
import { DictationController } from "./controller"
import { dictationView } from "./view-model"

/**
 * The repo's test runner has no JSX DOM renderer, so the presentational logic
 * lives in a plain view model the component reads. That keeps the meaning of
 * each state testable without a DOM, which is where the behaviour lives.
 */
describe("dictationView", () => {
  test("idle offers dictation", () => {
    expect(dictationView(new DictationController())).toMatchObject({
      icon: "mic",
      label: "Dictate",
      active: false,
      showLevel: false,
      showCancel: false,
      disabled: false,
    })
  })

  test("recording switches to the active mic, a level bar and cancel", () => {
    const c = new DictationController()
    c.start()
    expect(dictationView(c)).toMatchObject({
      icon: "mic-active",
      label: "Stop dictation",
      active: true,
      showLevel: true,
      showCancel: true,
      disabled: false,
    })
  })

  test("transcribing stops offering cancel but keeps the control enabled", () => {
    const c = new DictationController()
    c.start()
    c.finish(c.pendingInOrder()[0]!)
    const view = dictationView(c)
    expect(view.label).toBe("Transcribing")
    expect(view.showCancel).toBe(false)
    expect(view.icon).not.toBe("mic-active")
    expect(view.disabled).toBe(false)
  })

  test("inserting is announced distinctly", () => {
    const c = new DictationController()
    c.start()
    const id = c.pendingInOrder()[0]!
    c.finish(id)
    c.ready(id)
    expect(dictationView(c).label).toBe("Inserting")
  })

  test("a mic error disables the control and names the cause", () => {
    const c = new DictationController()
    const view = dictationView(c, { error: "Permission denied" })
    expect(view.disabled).toBe(true)
    expect(view.label).toBe("Microphone unavailable")
  })

  test("disabled wins over recording", () => {
    const c = new DictationController()
    c.start()
    expect(dictationView(c, { disabled: true }).disabled).toBe(true)
  })

  test("level maps RMS to a bar index, clamped at both ends", () => {
    const c = new DictationController()
    expect(dictationView(c, { level: undefined }).level).toBe(0)
    expect(dictationView(c, { level: 0 }).level).toBe(0)
    expect(dictationView(c, { level: 10 }).level).toBe(4)
    expect(dictationView(c, { level: -1 }).level).toBe(0)
  })

  test("back to idle after commit clears every affordance", () => {
    const c = new DictationController()
    c.start()
    const id = c.pendingInOrder()[0]!
    c.finish(id)
    c.commit(id)
    expect(dictationView(c)).toMatchObject({ icon: "mic", showLevel: false, showCancel: false })
  })
})
