import type { Platform } from "@opencode/app/desktop"
import type { ElectronAPI } from "../api-types"

/**
 * Exactly what dictation needs from the preload API.
 *
 * Narrowed from `ElectronAPI` deliberately: it documents the contract, and it
 * means the bridge can be tested by passing three functions rather than a fake
 * of the whole preload surface.
 */
export type VoiceBridge = Pick<ElectronAPI, "voiceStatus" | "prepareVoice" | "transcribeVoice">

/**
 * The renderer end of local dictation.
 *
 * Deliberately a pass-through: recognition runs in the main process, because the
 * renderer is a web bundle and a native inference module does not belong in one.
 * No state is kept here — the app package owns the session state machine and the
 * rules about when recognized text may reach the composer.
 *
 * These methods matter more than their size suggests. They are optional on
 * `Platform`, so omitting them does not fail typecheck: the app reads a platform
 * without them as one that cannot dictate and renders no mic control at all,
 * silently. That is how this shipped broken once.
 */
export function createDesktopVoice(
  api: VoiceBridge,
): Pick<Platform, "voiceStatus" | "prepareVoice" | "transcribeVoice"> {
  return {
    voiceStatus: () => api.voiceStatus(),
    prepareVoice: () => api.prepareVoice(),
    transcribeVoice: (input) => api.transcribeVoice(input),
  }
}
