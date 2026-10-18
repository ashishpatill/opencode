import { describe, expect, mock, test } from "bun:test"
import type { ElectronAPI } from "../api-types"

/**
 * The three voice methods are optional on `Platform`, so leaving them out of the
 * desktop bridge does not fail typecheck — the app just reads the platform as
 * one that cannot dictate and renders no mic control, with no error anywhere.
 * That is exactly how this shipped broken once, so the wiring is asserted here.
 *
 * The bridge transitively pulls in the whole Solid module graph through the
 * app's desktop storage module, and `ipc-client` registers a message listener on
 * `window` as it loads. Neither is under test, so both are stood up minimally.
 */
mock.module("@opencode/app/desktop", () => ({
  createDraftStore: () => ({}),
  createNamespaceStorage: () => ({}),
  flushPersisted: () => {},
}))

// The extension bridge reads the renderer's singleton preload api rather than
// the injected one, which would drag the whole preload surface into this test
// for no reason. It is not part of what is being checked here.
mock.module("../extensions", () => ({ createExtensionBridge: () => ({}) }))

// `ipc-client` only attaches and detaches listeners at load, and `api` reads its
// seeded storage snapshot from the preload bridge. The port the client waits for
// never arrives in a test, which is fine because nothing here awaits it.
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    addEventListener: () => {},
    removeEventListener: () => {},
    electron: { storageSnapshot: Promise.resolve({}) },
  },
})

// The storage bridge subscribes to `visibilitychange` when it is constructed.
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: { addEventListener: () => {}, removeEventListener: () => {}, hasFocus: () => true },
})

const { createDesktopPlatform } = await import("./index")

const windowState = { id: "window-1", version: "0.0.0-test" }

/**
 * The bits of the preload surface `createDesktopPlatform` reads while building
 * the object, as opposed to when its methods are called.
 */
const constructionDefaults: Partial<ElectronAPI> = { getWindowBootstrap: () => ({ packaged: false }) }

/**
 * A preload API where only the overrides are real; everything else is a no-op.
 *
 * The surface has dozens of members and the bridge touches a handful during
 * construction. Naming every one to test three would be a fake longer than the
 * code under test.
 */
function platformApi(overrides: Partial<ElectronAPI> = {}): ElectronAPI {
  // SAFETY: only declared members are read, each with the shape the bridge
  // expects, and the no-op fallback is never reached in these tests.

  return new Proxy({ ...constructionDefaults, ...overrides }, {
    get: (source, property: string) => (property in source ? source[property] : () => undefined),
  }) as ElectronAPI
}

describe("desktop platform voice wiring", () => {
  test("the platform's voice methods reach the preload API", async () => {
    // If the bridge forgot to spread them, these calls would be `undefined` and
    // the assertions below would fail — which is the whole point: the app would
    // otherwise render no mic control and say nothing about why.

    const calls: string[] = []

    const platform = createDesktopPlatform(
      platformApi({
        voiceStatus: async () => {
          calls.push("status")

          return { phase: "ready" }
        },
        prepareVoice: async () => {
          calls.push("prepare")

          return { phase: "ready" }
        },
        transcribeVoice: async () => {
          calls.push("transcribe")

          return { text: "hello" }
        },
      }),
      windowState,
    )

    expect(await platform.voiceStatus?.()).toEqual({ phase: "ready" })
    expect(await platform.prepareVoice?.()).toEqual({ phase: "ready" })
    expect(await platform.transcribeVoice?.({ samples: new Float32Array(2), sampleRate: 16000 })).toEqual({
      text: "hello",
    })
    expect(calls).toEqual(["status", "prepare", "transcribe"])
  })
})
