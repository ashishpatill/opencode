import { describe, expect, mock, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// `model.ts` resolves weight paths through Electron's `app.getPath`. Stub the
// module before importing it, since no Electron runtime exists under the test
// runner. Doing this first means the engine logic itself can be exercised
// without a display or a packaged app.
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-voice-test-"))

mock.module("electron", () => ({ app: { getPath: () => dataDir } }))

const { registerVoiceEngine, voiceStatus, prepareVoiceEngine } = await import("./engine")

const { createParakeetEngine, MIN_SAMPLES } = await import("./parakeet")

const { MODEL_BYTES, MODEL_FILES, hasModel } = await import("./model")

import type { SherpaOfflineRecognizer, SherpaOfflineStream, SherpaResult } from "./sherpa"

/**
 * The recognizer is stubbed throughout: these cover the state machine and the
 * promise plumbing, which is where the real bugs live. Whether the native
 * binding transcribes accurately is a property of sherpa-onnx, not of this
 * code — that is verified separately against real weights and real audio.
 */
type StubCalls = { decode: number }

/** A recognizer that records decode counts and the peak concurrency seen. */
function stubSherpa(text = "hello world") {
  const calls: StubCalls = { decode: 0 }

  let active = 0
  let peak = 0

  const OfflineRecognizer = class implements SherpaOfflineRecognizer {
    createStream(): SherpaOfflineStream {
      return {
        acceptWaveform() {},
      }
    }
    decode() {
      calls.decode++
      active++
      peak = Math.max(peak, active)
    }
    getResult(): SherpaResult {
      active--

      return { text }
    }
  }

  return {
    calls,
    peak: () => peak,
    module: { OfflineRecognizer },
  }
}

/**
 * Wraps a plain decode function into a recognizer, for tests that need to fail
 * on demand. Kept typed rather than asserted so a signature drift in the
 * shim surfaces here.
 */
function recognizerThat(decode: () => SherpaResult): SherpaOfflineRecognizer {
  let result: SherpaResult = { text: "" }

  return {
    createStream: () => ({ acceptWaveform() {} }),
    decode: () => {
      result = decode()
    },
    getResult: () => result,
  }
}

async function scratchDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "parakeet-test-"))
}

/**
 * Creates the manifest's files at their recorded sizes using sparse files.
 * The encoder alone is 622 MB, and writing real bytes for it would make these
 * tests take longer than the feature they guard.
 */
async function seed(dir: string) {
  for (const file of MODEL_FILES) await truncateTo(dir, file.name, file.bytes)
}

async function truncateTo(dir: string, name: string, bytes: number) {
  await fs.writeFile(path.join(dir, name), "")
  await fs.truncate(path.join(dir, name), bytes)
}

describe("createParakeetEngine", () => {
  test("transcribes through the stub recognizer", async () => {
    const stub = stubSherpa("transcribed text")
    const engine = createParakeetEngine({ directory: await scratchDir(), load: () => stub.module })

    const text = await engine.transcribe({ samples: new Float32Array(16000), sampleRate: 16000 })
    expect(text).toBe("transcribed text")
    expect(stub.calls.decode).toBe(1)
  })

  test("rejects audio at the wrong sample rate instead of guessing", async () => {
    // A wrong rate would still decode and return plausible nonsense, which is
    // worse for the user than an explicit failure.
    const stub = stubSherpa()
    const engine = createParakeetEngine({ directory: await scratchDir(), load: () => stub.module })

    await expect(engine.transcribe({ samples: new Float32Array(48000), sampleRate: 48000 })).rejects.toThrow(
      /16000 Hz/,
    )
    expect(stub.calls.decode).toBe(0)
  })

  test("concurrent decodes are serialized rather than overlapping", async () => {
    const stub = stubSherpa()
    const engine = createParakeetEngine({ directory: await scratchDir(), load: () => stub.module })

    await Promise.all([
      engine.transcribe({ samples: new Float32Array(16000), sampleRate: 16000 }),
      engine.transcribe({ samples: new Float32Array(16000), sampleRate: 16000 }),
      engine.transcribe({ samples: new Float32Array(16000), sampleRate: 16000 }),
    ])

    // Overlapping calls into one ONNX session are unsafe.
    expect(stub.calls.decode).toBe(3)
    expect(stub.peak()).toBe(1)
  })

  test("one failed decode does not poison the queue", async () => {
    const dir = await scratchDir()
    let shouldFail = true

    const engine = createParakeetEngine({
      directory: dir,
      load: () => ({
        OfflineRecognizer: class implements SherpaOfflineRecognizer {
          createStream(): SherpaOfflineStream {
            return { acceptWaveform() {} }
          }
          decode() {
            if (shouldFail) throw new Error("session blew up")
          }
          getResult(): SherpaResult {
            return { text: "recovered" }
          }
        },
      }),
    })

    await expect(engine.transcribe({ samples: new Float32Array(16000), sampleRate: 16000 })).rejects.toThrow(
      "session blew up",
    )
    shouldFail = false
    // The chain must still run afterwards, which is what dropping the rejected
    // promise buys.
    await expect(engine.transcribe({ samples: new Float32Array(16000), sampleRate: 16000 })).resolves.toBe("recovered")
  })

  test("the session is built once even under concurrent load", async () => {
    let built = 0

    const engine = createParakeetEngine({
      directory: await scratchDir(),
      load: () => ({
        OfflineRecognizer: class implements SherpaOfflineRecognizer {
          constructor() {
            built++
          }
          createStream(): SherpaOfflineStream {
            return { acceptWaveform() {} }
          }
          decode() {}
          getResult(): SherpaResult {
            return { text: "x" }
          }
        },
      }),
    })

    await Promise.all([
      engine.ready(),
      engine.ready(),
      engine.transcribe({ samples: new Float32Array(16000), sampleRate: 16000 }),
      engine.transcribe({ samples: new Float32Array(16000), sampleRate: 16000 }),
    ])
    expect(built).toBe(1)
  })

  test("a directory with no weights reports itself absent", async () => {
    const engine = createParakeetEngine({ directory: await scratchDir(), load: () => stubSherpa().module })
    expect(await engine.hasWeights?.()).toBe(false)
  })

  test("audio below the crash threshold never reaches the native binding", async () => {
    // The binding aborts the process on a too-short buffer with an uncatchable
    // C++ exception, so the guard has to fire before any native call. A stub
    // that records decodes is the only way to prove it here.
    const stub = stubSherpa("should never appear")
    const engine = createParakeetEngine({ directory: await scratchDir(), load: () => stub.module })

    for (const length of [0, 1, 160, MIN_SAMPLES - 1]) {
      expect(await engine.transcribe({ samples: new Float32Array(length), sampleRate: 16000 })).toBe("")
    }

    expect(stub.calls.decode).toBe(0)
  })

  test("audio at the crash threshold is decoded normally", async () => {
    // The guard must be a floor, not an off-by-one that refuses real speech.
    const stub = stubSherpa("long enough")
    const engine = createParakeetEngine({ directory: await scratchDir(), load: () => stub.module })

    expect(await engine.transcribe({ samples: new Float32Array(MIN_SAMPLES), sampleRate: 16000 })).toBe("long enough")
    expect(stub.calls.decode).toBe(1)
  })
})

describe("voice status phases", () => {
  test("an unregistered engine is unavailable", async () => {
    registerVoiceEngine(undefined)
    expect((await voiceStatus()).phase).toBe("unavailable")
  })

  test("a missing model is needs-download, not unavailable", async () => {
    // The control must stay enabled: the first click fetches weights and then
    // dictation works, so a disabled mic would be unreachable.
    registerVoiceEngine({
      id: "stub",
      ready: async () => ({ ready: false, error: "weights absent" }),
      hasWeights: async () => false,
      transcribe: async () => "",
    })
    expect((await voiceStatus()).phase).toBe("needs-download")
  })

  test("a loaded engine is ready", async () => {
    registerVoiceEngine({ id: "stub", ready: async () => ({ ready: true }), transcribe: async () => "" })
    expect((await voiceStatus()).phase).toBe("ready")
  })

  test("present weights that still fail to load surface as an error", async () => {
    registerVoiceEngine({
      id: "stub",
      ready: async () => ({ ready: false, error: "bad graph" }),
      hasWeights: async () => true,
      transcribe: async () => "",
    })
    expect((await voiceStatus())).toEqual({ phase: "error", error: "bad graph" })
  })

  test("an engine without weight management reports only what it knows", async () => {
    registerVoiceEngine({ id: "stub", ready: async () => ({ ready: false }), transcribe: async () => "" })
    expect((await voiceStatus()).phase).toBe("error")
  })

  test("a thrown ready reports the message instead of propagating", async () => {
    registerVoiceEngine({
      id: "stub",
      ready: async () => {
        throw new Error("native module missing")
      },
      transcribe: async () => "",
    })
    const status = await voiceStatus()
    expect(status.phase).toBe("error")
    expect(status.error).toBe("native module missing")
  })

  test("concurrent prepare calls fetch once and then report ready", async () => {
    let calls = 0
    registerVoiceEngine({
      id: "stub",
      ready: async () => ({ ready: true }),
      transcribe: async () => "",
      prepareWeights: async (onProgress) => {
        calls++
        onProgress({ bytes: 10, total: 20 })
        onProgress({ bytes: 20, total: 20 })
      },
    })

    const results = await Promise.all([prepareVoiceEngine(), prepareVoiceEngine(), prepareVoiceEngine()])
    expect(calls).toBe(1)
    expect(results.every((r) => r.phase === "ready")).toBe(true)
  })

  test("a failed prepare retries on the next call rather than caching", async () => {
    let calls = 0
    registerVoiceEngine({
      id: "stub",
      ready: async () => ({ ready: true }),
      transcribe: async () => "",
      prepareWeights: async () => {
        calls++

        if (calls === 1) throw new Error("network down")
      },
    })

    expect((await prepareVoiceEngine()).phase).toBe("error")
    expect((await prepareVoiceEngine()).phase).toBe("ready")
    expect(calls).toBe(2)
  })

  test("status reports progress while a download is in flight", async () => {
    let release: (() => void) | undefined

    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    // Mirrors the real sequence: weights absent, then fetched, then loadable.

    let downloaded = false
    let loaded = false
    registerVoiceEngine({
      id: "stub",
      ready: async () => ({ ready: loaded }),
      hasWeights: async () => downloaded,
      transcribe: async () => "",
      prepareWeights: async (onProgress) => {
        onProgress({ bytes: 5, total: 10 })
        await gate
        downloaded = true
        loaded = true
        onProgress({ bytes: 10, total: 10 })
      },
    })

    const preparing = prepareVoiceEngine()
    await Promise.resolve()
    expect((await voiceStatus()).phase).toBe("downloading")
    release?.()
    expect((await preparing).phase).toBe("ready")
  })

  test("an engine that cannot prepare weights falls back to plain status", async () => {
    registerVoiceEngine({ id: "stub", ready: async () => ({ ready: true }), transcribe: async () => "" })
    expect((await prepareVoiceEngine()).phase).toBe("ready")
  })
})

describe("model manifest", () => {
  test("byte counts match the sum of the files", () => {
    const sum = MODEL_FILES.reduce((total, file) => total + file.bytes, 0)
    expect(MODEL_BYTES).toBe(sum)
  })

  test("the manifest names the four files the recognizer needs", () => {
    expect(MODEL_FILES.map((f) => f.name).sort()).toEqual([
      "decoder.int8.onnx",
      "encoder.int8.onnx",
      "joiner.int8.onnx",
      "tokens.txt",
    ])
  })

  test("an empty directory holds no model", async () => {
    expect(await hasModel(await scratchDir())).toBe(false)
  })

  test("a directory with every file at the right size counts as present", async () => {
    const dir = await scratchDir()
    await seed(dir)
    expect(await hasModel(dir)).toBe(true)
  })

  test("a truncated file does not count as a model", async () => {
    // Without this check a partial download would be renamed into place and
    // then fail to load with a far more obscure error.
    const dir = await scratchDir()
    await seed(dir)
    await truncateTo(dir, "encoder.int8.onnx", MODEL_BYTES)
    expect(await hasModel(dir)).toBe(false)
  })

  test("one missing file is enough to report no model", async () => {
    const dir = await scratchDir()
    await seed(dir)
    await fs.rm(path.join(dir, "tokens.txt"))
    expect(await hasModel(dir)).toBe(false)
  })
})
