/**
 * Which permissions the sandboxed renderer may hold.
 *
 * Kept apart from `security.ts` on purpose: that module binds Electron's window
 * and session objects, which cannot be imported outside an Electron process, so
 * the decision itself lives here where it can be tested.
 */
const rendererPermissions = new Set(["clipboard-sanitized-write", "notifications", "media"])

/**
 * Whether this permission is one the renderer may hold at all.
 *
 * Dictation records, and nothing in this renderer shows a camera, so `media` is
 * narrowed to audio rather than granted as one permission that would also unlock
 * the camera.
 */
export function rendererMayUse(permission: string, mediaTypes?: readonly string[]): boolean {
  if (!rendererPermissions.has(permission)) return false

  return !(permission === "media" && (mediaTypes ?? []).includes("video"))
}
