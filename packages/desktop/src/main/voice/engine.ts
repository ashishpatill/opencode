/**
 * Local speech recognition for the desktop app.
 *
 * The engine is a port so the model choice stays open: Parakeet (0.6B, best
 * measured accuracy per byte) and Whisper (MIT) both fit behind it, and neither
 * is hard-wired here. Until an engine is registered, status reports
 * `unavailable` and the composer control stays disabled rather than pretending
 * to work.
 *
 * Memory follows the reference implementation's finding: keep model weights
 * resident and drop per-input inference scratch after each run, otherwise a
 * long session creeps upward and never returns.
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
  /** Drops per-input scratch while keeping weights warm. */
  releaseScratch?(): Promise<void>
}

/** Set by whoever owns the chosen engine; nothing registers one yet. */
let engine: VoiceEngine | undefined

export function registerVoiceEngine(next: VoiceEngine | undefined) {
  engine = next
}

export function currentVoiceEngine(): VoiceEngine | undefined {
  return engine
}

export async function voiceStatus(): Promise<{ ready: boolean; error?: string }> {
  if (!engine) return { ready: false, error: "No local speech engine is registered" }
  try {
    return await engine.ready()
  } catch (cause) {
    return { ready: false, error: cause instanceof Error ? cause.message : String(cause) }
  }
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