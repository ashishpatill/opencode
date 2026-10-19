import { describe, expect, test } from "bun:test"
import { rendererMayUse } from "./permissions"

describe("renderer permissions", () => {
  test("dictation may open the microphone", () => {
    // The composer's mic is the only thing in the app that calls getUserMedia.
    expect(rendererMayUse("media", ["audio"])).toBe(true)
  })

  test("the camera stays denied", () => {
    // A blanket `media` grant would unlock the camera too, which nothing in this
    // renderer asks for, so any request that names video is refused whole.
    expect(rendererMayUse("media", ["audio", "video"])).toBe(false)
    expect(rendererMayUse("media", ["video"])).toBe(false)
  })

  test("permissions outside the allowlist stay denied", () => {
    expect(rendererMayUse("geolocation")).toBe(false)
    expect(rendererMayUse("midi")).toBe(false)
    expect(rendererMayUse("openExternal")).toBe(false)
  })

  test("the grants the app already relied on still work", () => {
    expect(rendererMayUse("clipboard-sanitized-write")).toBe(true)
    expect(rendererMayUse("notifications")).toBe(true)
  })
})
