import { describe, expect, test } from "bun:test"
import { DictationController } from "./controller"

describe("DictationController", () => {
  test("starts idle and offers no stop control", () => {
    const c = new DictationController()
    expect(c.phase).toBe("idle")
    expect(c.canStop).toBe(false)
    expect(c.isBusy).toBe(false)
  })

  test("a started capture records and can be stopped", () => {
    const c = new DictationController()
    const started = c.start()
    expect(started.ok).toBe(true)
    expect(c.phase).toBe("recording")
    expect(c.isRecording).toBe(true)
    expect(c.canStop).toBe(true)
  })

  test("moving through phases ends in inserting", () => {
    const c = new DictationController()
    c.start()
    const id = c.pendingInOrder()[0]!
    expect(c.finish(id)).toBe(true)
    expect(c.phase).toBe("transcribing")
    expect(c.ready(id)).toBe(true)
    expect(c.phase).toBe("inserting")
  })

  test("commit is terminal and cannot be repeated", () => {
    const c = new DictationController()
    c.start()
    const id = c.pendingInOrder()[0]!
    c.finish(id)
    expect(c.commit(id)).toBe(true)
    expect(c.phase).toBe("idle")
    expect(c.isBusy).toBe(false)
    // Output was already written; a second commit is refused.
    expect(c.commit(id)).toBe(false)
  })

  test("cancel stops the active capture and yields no text", () => {
    const c = new DictationController()
    c.start()
    const id = c.pendingInOrder()[0]!
    expect(c.cancel()).toBe(true)
    expect(c.phase).toBe("idle")
    // The fence: a late result must not reach the composer.
    expect(c.canInsert(id)).toBe(false)
  })

  test("cancel is refused when nothing is cancellable", () => {
    const c = new DictationController()
    expect(c.cancel()).toBe(false)
  })

  test("a new capture does not cancel accepted older work", () => {
    const c = new DictationController()
    c.start()
    const first = c.pendingInOrder()[0]!
    c.finish(first)

    // The user speaks again before the first result lands.
    c.start()
    const second = c.pendingInOrder()[1]!

    expect(c.pendingInOrder()).toEqual([first, second])
    expect(c.canInsert(first)).toBe(false) // no longer the newest capture
    expect(c.canInsert(second)).toBe(true)
  })

  test("a late result for a superseded capture is fenced off", () => {
    const c = new DictationController()
    c.start()
    const stale = c.pendingInOrder()[0]!
    c.start()
    expect(c.canInsert(stale)).toBe(false)
  })

  test("commit then start leaves the composer idle between utterances", () => {
    const c = new DictationController()
    c.start()
    const id = c.pendingInOrder()[0]!
    c.finish(id)
    c.commit(id)
    expect(c.phase).toBe("idle")
    c.start()
    expect(c.phase).toBe("recording")
  })

  test("cancel targets the newest capture when one is recording", () => {
    const c = new DictationController()
    c.start()
    const first = c.pendingInOrder()[0]!
    c.finish(first)
    c.start()
    const second = c.pendingInOrder()[1]!
    c.cancel()
    expect(c.canInsert(second)).toBe(false)
    expect(c.pendingInOrder()).toEqual([first])
  })

  test("prune drops settled captures only", () => {
    const c = new DictationController()
    c.start()
    const done = c.pendingInOrder()[0]!
    c.finish(done)
    c.commit(done)
    c.start() // still live
    c.prune()
    expect(c.pendingInOrder()).toHaveLength(1)
    expect(c.phase).toBe("recording")
  })

  test("notifies subscribers on each transition", () => {
    let calls = 0
    const c = new DictationController(() => calls++)
    c.start()
    const id = c.pendingInOrder()[0]!
    c.finish(id)
    c.commit(id)
    expect(calls).toBe(3)
  })
})