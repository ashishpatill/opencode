/**
 * On-demand acquisition of the recognition weights.
 *
 * The weights are 622 MB, which is not something to put in a git repository,
 * and vendoring them would also mean shipping them to everyone who clones the
 * app. So they are fetched once on first dictation into the app's user-data
 * directory and left there.
 *
 * Two properties matter more than speed here:
 *
 * - Downloads are atomic. A partial file is never mistaken for a complete one,
 *   because the rename happens only after the full byte count is on disk.
 * - Concurrent callers share one download. Every dictation call during a
 *   first-run download awaits the same promise instead of racing to write the
 *   same path.
 */

import { app } from "electron"
import fs from "node:fs/promises"
import path from "node:path"

/** Shown in the UI so the control can say what it is downloading. */
export const MODEL_LABEL = "Parakeet TDT 0.6B v2 (int8)"

/**
 * Weights are CC-BY-4.0 and are fetched, never vendored, so attribution
 * travels with the download rather than with the source tree.
 */
export const MODEL_ATTRIBUTION = "NVIDIA Parakeet TDT 0.6B v2 — CC-BY-4.0"

const REPO = "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8"

const RESOLVE = "https://huggingface.co"

const DOWNLOAD_LIMIT = 2 * 1024 * 1024 * 1024

export type ModelFile = {
  readonly name: string
  readonly bytes: number
}

export const MODEL_FILES: readonly ModelFile[] = [
  { name: "encoder.int8.onnx", bytes: 652184296 },
  { name: "decoder.int8.onnx", bytes: 7257753 },
  { name: "joiner.int8.onnx", bytes: 1739080 },
  { name: "tokens.txt", bytes: 9384 },
]

export const MODEL_BYTES = MODEL_FILES.reduce((total, file) => total + file.bytes, 0)

export type ModelProgress = {
  readonly bytes: number
  readonly total: number
  /** Name of the file currently arriving. */
  readonly file: string
}

/** Injectable so the download can be tested without a network. */
export type Fetcher = (url: string) => Promise<{
  readonly ok: boolean
  readonly status: number
  readonly body: ReadableStream<Uint8Array> | null
}>

/**
 * The sizes are a floor, not a checksum. Hashing 622 MB on every status poll
 * would cost more than the download it protects; a truncated file is caught by
 * the byte count, and a corrupt one surfaces as a load failure.
 */
async function isComplete(file: ModelFile, dir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(dir, file.name))

    return stat.size === file.bytes
  } catch {
    return false
  }
}

async function download(fetchImpl: Fetcher, file: ModelFile, dir: string, onProgress?: (p: ModelProgress) => void) {
  const target = path.join(dir, file.name)
  // Distinct per attempt, so an interrupted download never blocks the retry.
  const partial = `${target}.${process.pid}.part`

  const response = await fetchImpl(`${RESOLVE}/${REPO}/resolve/main/${file.name}`).catch((cause) => {
    throw new Error(`Could not reach the model host: ${cause instanceof Error ? cause.message : String(cause)}`)
  })

  if (!response.ok || !response.body) throw new Error(`Model download failed for ${file.name} (${response.status})`)

  const reader = response.body.getReader()
  const handle = await fs.open(partial, "w")
  let written = 0

  try {
    for (;;) {
      const next = await reader.read()

      if (next.done) break
      await handle.write(next.value)
      written += next.value.byteLength

      if (written > DOWNLOAD_LIMIT) throw new Error(`Model file ${file.name} exceeded the download limit`)
      onProgress?.({ bytes: written, total: file.bytes, file: file.name })
    }
  } finally {
    await handle.close().catch(() => {})
  }

  // A short read would otherwise be renamed into place and then fail to load
  // with a far less obvious error.
  if (written !== file.bytes) {
    await fs.rm(partial, { force: true })
    throw new Error(`Model file ${file.name} was truncated (${written} of ${file.bytes} bytes)`)
  }

  await fs.rename(partial, target)
}

let inFlight: Promise<string> | undefined

/**
 * Returns the directory holding a complete set of weights, downloading only
 * what is missing. Repeated calls during a first-run download share one
 * promise, so the 622 MB is fetched once.
 */
export function ensureModel(options: { onProgress?: (p: ModelProgress) => void; fetchImpl?: Fetcher } = {}): Promise<string> {
  if (inFlight) return inFlight

  const fetchImpl = options.fetchImpl ?? ((url: string) => fetch(url))
  const dir = path.join(app.getPath("userData"), "voice", "parakeet-tdt-0.6b-v2-int8")

  inFlight = (async () => {
    await fs.mkdir(dir, { recursive: true })

    for (const file of MODEL_FILES) {
      if (await isComplete(file, dir)) continue
      await download(fetchImpl, file, dir, options.onProgress)
    }

    return dir
  })().catch((cause) => {
    // Let the next status poll retry rather than caching the failure forever.
    inFlight = undefined
    throw cause
  })

  return inFlight
}

/** Where the weights live once downloaded, whether or not they are present yet. */
export function modelDirectory(): string {
  return path.join(app.getPath("userData"), "voice", "parakeet-tdt-0.6b-v2-int8")
}

/**
 * Whether a complete set of weights is already on disk. Reports presence
 * without fetching anything, so the composer can distinguish "ready" from
 * "will need a download" without starting one.
 */
export async function hasModel(directory?: string): Promise<boolean> {
  const dir = directory ?? modelDirectory()

  for (const file of MODEL_FILES) if (!(await isComplete(file, dir))) return false

  return true
}

/** Test seam: drops the memoized download so a fresh one is attempted. */
export function resetModelCache() {
  inFlight = undefined
}
