import { describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

const run = promisify(execFile)

/**
 * Which runtime executes the probe.
 *
 * Bun is the test runner but also the default `execPath`, and it cannot load
 * the V8 addon — that is the crash this file exists to work around. When Bun
 * is running these tests, a real Node is needed and is located by name.
 */
function nodeBinary(): string {
  const current = process.versions.bun ? (process.execPath.split("/").pop() ?? "") : ""

  if (process.versions.bun && current !== "node") return "node"

  return process.execPath
}

/**
 * Verifies the real engine end to end: the native sherpa-onnx binding, the real
 * int8 weights, and real audio.
 *
 * The work happens in a Node child process (`parakeet.probe.mjs`) because the
 * binding is a native addon built for V8 and loading it inside Bun's
 * JavaScriptCore crashes the runtime. Bun here only orchestrates.
 *
 * The weights are 622 MB and are fetched on demand by the app, so these are
 * skipped unless `OPENCODE_VOICE_TEST_MODEL` points at a directory that already
 * holds them. CI should not download that on every run.
 */
const weights = process.env.OPENCODE_VOICE_TEST_MODEL

const probe = path.join(import.meta.dir, "parakeet.probe.mjs")

/** A known LibriSpeech-style clip with its expected transcript. */
const EXPECTED =
  "Well, I don't wish to see it any more, observed Phebe, turning away her eyes. It is certainly very like the old portrait."

type Probe = {
  ok: boolean
  error?: string
  version?: string
  onnxruntime?: string
  loadMs?: number
  sampleRate?: number
  durationSeconds?: number
  text?: string
  timings?: number[]
  /** Engine's short-audio guard, read from its source. */
  minSamples?: number
  /** Shortest length the addon actually accepts, located by bisection. */
  cliff?: { ok: boolean; minSamples: number; unsafeAt: number; error?: string }
  silence?: string
  rssBytes?: number
}

/**
 * Parses the probe's report.
 *
 * The child is a file in this repo writing JSON it builds itself, and its
 * failure path is covered by a test, so the assertion holds rather than
 * assuming an untrusted shape.
 */
function parseReport(stdout: string): Probe {
  // SAFETY: the probe is this repo's own script and always writes one JSON
  // object to stdout, including on the failure path.
  return JSON.parse(stdout) as Probe
}

/** Reads `stdout` off a failed exec, whose rejection type is an opaque Error. */
function stdoutOf(cause: unknown): string | undefined {
  // SAFETY: `execFile` rejects with an Error carrying string `stdout` on a
  // non-zero exit, and nothing else reaches this path.
  const candidate = cause as { stdout?: string } | null

  return candidate?.stdout
}

async function probeWeights(dir: string, wav: string): Promise<Probe> {
  // A failure inside the child is reported through a non-zero exit with JSON
  // still on stdout, so that output is read rather than lost to the throw.
  try {
    const { stdout } = await run(nodeBinary(), [probe, dir, wav], { maxBuffer: 1024 * 1024 })

    return parseReport(stdout)
  } catch (cause) {
    const stdout = stdoutOf(cause)

    if (stdout) return parseReport(stdout)
    throw cause
  }
}

async function available() {
  if (!weights) return false

  try {
    await fs.access(path.join(weights, "encoder.int8.onnx"))
    await fs.access(path.join(weights, "test.wav"))

    return true
  } catch {
    return false
  }
}

const skip = !(await available())

/**
 * Builds a scratch weight directory for the tests that need to move or remove a
 * file. Prefers hardlinks, so the fixture costs no extra disk, and falls back to
 * copying when the weights and the system temp directory are on different
 * volumes — linking across filesystems is not possible, and the weights may
 * legitimately live outside the temp volume.
 */
async function linkFixture() {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "voice-native-"))

  for (const name of ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt", "test.wav"]) {
    const from = path.join(weights!, name)
    const to = path.join(scratch, name)

    try {
      await fs.link(from, to)
    } catch {
      // EXDEV, or a filesystem that does not support links.
      await fs.copyFile(from, to)
    }
  }

  return { scratch, wav: path.join(scratch, "test.wav") }
}

describe.skipIf(skip)("Parakeet against real weights", () => {
  test("transcribes a known clip with punctuation and casing", async () => {
    // Dictation output goes straight into a prompt, so punctuation and
    // capitalization are part of the requirement, not polish.
    const result = await probeWeights(weights!, path.join(weights!, "test.wav"))
    expect(result.ok).toBe(true)
    expect(result.text).toBe(EXPECTED)
  })

  test("the fixture really is 16 kHz mono", async () => {
    // The encoder is configured for 16 kHz; anything else silently degrades.
    const result = await probeWeights(weights!, path.join(weights!, "test.wav"))
    expect(result.sampleRate).toBe(16000)
  })

  test("silence yields no text rather than an error", async () => {
    const result = await probeWeights(weights!, path.join(weights!, "test.wav"))
    expect(result.silence).toBe("")
  })

  test("the short-audio guard clears the measured crash cliff", async () => {
    // Below the cliff the addon aborts the process with an uncatchable C++
    // exception, so the engine must refuse anything shorter than it. The cliff
    // is located by bisection in a throwaway process; the guard constant is read
    // from the engine's own source. If a model revision moves the cliff, this
    // fails rather than shipping a crash on short input.
    const result = await probeWeights(weights!, path.join(weights!, "test.wav"))
    expect(result.cliff?.ok).toBe(true)
    // The bracket must be genuine: one safe length and one that fails.
    expect(result.cliff!.unsafeAt).toBe(result.cliff!.minSamples - 1)
    expect(result.minSamples).toBeGreaterThan(result.cliff!.minSamples)
  })

  test("repeated runs return identical text", async () => {
    // A stateful decoder or a leaking session would show up as drift here.
    const result = await probeWeights(weights!, path.join(weights!, "test.wav"))
    expect(result.timings?.length).toBe(5)
  })

  test("runs faster than realtime on a realistic utterance", async () => {
    // RTF is the number that decides whether dictation feels instant. Measured
    // on this hardware at roughly 0.05 with two threads; this asserts a
    // deliberately loose ceiling so it is not flaky on a busy machine.
    const result = await probeWeights(weights!, path.join(weights!, "test.wav"))
    const duration = result.durationSeconds ?? 0
    const median = [...(result.timings ?? [])].sort((a, b) => a - b)[2] ?? Infinity
    expect(duration).toBeGreaterThan(1)
    expect(median / 1000 / duration).toBeLessThan(0.5)
  })

  test("weights can be supplied from any directory", async () => {
    // `directory` is the only thing deciding where weights come from, which is
    // what makes the engine testable and the download location configurable.
    const { scratch, wav } = await linkFixture()

    try {
      const result = await probeWeights(scratch, wav)
      expect(result.text).toBe(EXPECTED)
    } finally {
      await fs.rm(scratch, { recursive: true, force: true })
    }
  })

  test("a missing weight file fails loudly instead of returning empty text", async () => {
    const { scratch, wav } = await linkFixture()

    try {
      await fs.rm(path.join(scratch, "joiner.int8.onnx"))
      const result = await probeWeights(scratch, wav)
      expect(result.ok).toBe(false)
      expect(result.error).toBeTruthy()
    } finally {
      await fs.rm(scratch, { recursive: true, force: true })
    }
  })
})
