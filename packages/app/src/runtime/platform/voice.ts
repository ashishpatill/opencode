/**
 * Dictation status as the renderer sees it.
 *
 * Split out from `platform.tsx` so the desktop renderer can import the shape
 * without pulling the whole platform module — and so there is exactly one
 * definition of the phase union on both sides of the IPC boundary.
 */

/**
 * `needs-download` is distinct from `unavailable`: recognition weights are
 * fetched on first use, so dictation works on a fresh install once they
 * arrive. Reporting that as unavailable would leave the composer control
 * disabled with no way to trigger the download at all.
 */
export type PlatformVoicePhase = "unavailable" | "needs-download" | "downloading" | "ready" | "error"

export type PlatformVoiceStatus = {
  phase: PlatformVoicePhase
  /** Present when the engine cannot run, so the UI can explain why. */
  error?: string
  /** Present while the first-run weight download is in flight. */
  progress?: { bytes: number; total: number }
}

/** Coarse view for the mic control, which does not render byte counts. */
export function canDictate(status: PlatformVoiceStatus | undefined): boolean {
  if (!status) return false
  // `needs-download` counts: the first click fetches weights and then works.

  return status.phase === "ready" || status.phase === "needs-download"
}
