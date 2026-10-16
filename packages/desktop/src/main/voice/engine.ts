/**
 * Local speech recognition for the desktop app.
 *
 * The engine is a port so the model choice stays open: Parakeet is what ships,
 * and anything matching `VoiceEngine` can replace it without touching the IPC
 * surface or the composer.
 *
 * Status is a phase machine rather than a boolean because the weights are
 * fetched on first use. A fresh install has no weights yet but dictation will
 * still work once it has them, so the composer control should be *enabled*,
 * showing that a download is needed — not disabled, which would make the
 * feature unreachable with no way to start the download.
 */

export type Samples = {
  readonly samples: Float32Array
  readonly sampleRate: number
}

export type VoiceEngine = {
  readonly id: string
  /** Whether weights are loaded and inference can run now. */
  ready(): Promise<{ ready: boolean; error?: string }>
  /** Transcribes one window of audio. Returns empty text when nothing was said. */
  transcribe(input: Samples & { language?: string }): Promise<string>
  /**
   * Drops per-input scratch while keeping weights warm.
   *
   * Not every backend needs this; the shipped one relies on garbage collection
   * because the binding exposes no explicit stream teardown.
   */
  releaseScratch?(): Promise<void>
  /** Reports whether weights are already on disk, without loading them. */
  hasWeights?(): Promise<boolean>
  /** Downloads weights, reporting bytes as they arrive. */
  prepareWeights?(onProgress: (progress: { bytes: number; total: number }) => void): Promise<void>
}

export type VoicePhase = "unavailable" | "needs-download" | "downloading" | "ready" | "error"

export type VoiceStatus = {
  readonly phase: VoicePhase
  readonly error?: string
  readonly progress?: { readonly bytes: number; readonly total: number }
}

let engine: VoiceEngine | undefined

export function registerVoiceEngine(next: VoiceEngine | undefined) {
  engine = next
}

export function currentVoiceEngine(): VoiceEngine | undefined {
  return engine
}

/** Set while a first-run download is in flight, so status can report progress. */
let downloading: { bytes: number; total: number } | undefined
/** The in-flight download, so concurrent callers await it instead of polling. */

let download: Promise<void> | undefined

export async function voiceStatus(): Promise<VoiceStatus> {
  if (!engine) return { phase: "unavailable", error: "No local speech engine is registered" }

  if (downloading) return { phase: "downloading", progress: downloading }

  try {
    const warm = await engine.ready()

    if (warm.ready) return { phase: "ready" }
    // Weights absent but fetchable: enable the control and report the need.

    if (engine.hasWeights && !(await engine.hasWeights())) return { phase: "needs-download" }

    return { phase: "error", error: warm.error }
  } catch (cause) {
    return { phase: "error", error: cause instanceof Error ? cause.message : String(cause) }
  }
}

/**
 * Ensures weights exist and the engine is warm, reporting download progress.
 * Idempotent: concurrent callers share one download.
 */
export async function prepareVoiceEngine(): Promise<VoiceStatus> {
  const active = engine

  if (!active) return { phase: "unavailable", error: "No local speech engine is registered" }

  if (!active.prepareWeights) return voiceStatus()

  // One download for all callers: 622 MB fetched once even if the user clicks
  // the mic several times while it is arriving.
  download ??= active
    .prepareWeights((progress) => {
      downloading = progress
    })
    .then(() => {
      downloading = undefined
      download = undefined
    })
    .catch((cause) => {
      // Let the next attempt retry rather than caching the failure forever.
      downloading = undefined
      download = undefined
      throw cause
    })

  try {
    await download
  } catch (cause) {
    return { phase: "error", error: cause instanceof Error ? cause.message : String(cause) }
  }

  return voiceStatus()
}

export async function transcribeSamples(
  input: Samples & { language?: string },
): Promise<{ ok: true; text: string } | { ok: false; reason: "unavailable" | "failed"; message: string }> {
  const active = engine

  if (!active) return { ok: false, reason: "unavailable", message: "No local speech engine is registered" }

  try {
    const text = await active.transcribe(input)

    return { ok: true, text: text.trim() }
  } catch (cause) {
    // Always give scratch back, even when recognition failed: a failed run that
    // retains its buffers is how memory climbs over a long session.
    await active.releaseScratch?.().catch(() => {})

    return {
      ok: false,
      reason: "failed",
      message: cause instanceof Error ? cause.message : String(cause),
    }
  }
}
