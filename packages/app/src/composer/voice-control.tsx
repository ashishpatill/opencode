import { Show, createEffect, createSignal, onCleanup } from "solid-js"
import { usePlatform } from "@/runtime/platform/platform"
import { MicButton } from "@/voice/mic-button"
import type { SessionState } from "@/voice/session"
import { VoiceDictationSession } from "@/voice/session"

/**
 * Binds a dictation session to one composer.
 *
 * The session is plain and testable on its own; this is the Solid half —
 * signals, the platform lookup, and disposal. It renders nothing at all when the
 * platform has no local recognition, rather than a permanently disabled button
 * that invites the question "why is this here".
 */
const INITIAL: SessionState = {
  enabled: false,
  recording: false,
  busy: false,
  downloading: undefined,
  unavailable: "Dictation is not available on this platform",
}

/** How often status is re-read while a first-run download is in flight. */
const DOWNLOAD_POLL_MS = 1000

export function ComposerVoice(props: { insert: (text: string) => void }) {
  const platform = usePlatform()
  const [state, setState] = createSignal<SessionState>(INITIAL)
  const [level, setLevel] = createSignal<number | undefined>(undefined)

  const supported = platform.voiceStatus !== undefined && platform.transcribeVoice !== undefined

  const session = supported
    ? new VoiceDictationSession(
        {
          status: platform.voiceStatus ? () => platform.voiceStatus!() : undefined,
          prepare: platform.prepareVoice ? () => platform.prepareVoice!() : undefined,
          transcribe: (input) => platform.transcribeVoice!(input),
          insert: props.insert,
          // Fed from the capture's own audio callback, so the level meter costs
          // nothing while the microphone is closed.
          onLevel: (rms) => setLevel(rms),
        },
        setState,
      )
    : undefined

  void session?.refresh()

  // Status only changes on its own while a download runs, which is the one
  // thing the user cannot act on. Polling stops as soon as it finishes.
  let poll: ReturnType<typeof setInterval> | undefined
  createEffect(() => {
    const downloading = state().downloading !== undefined

    if (downloading && !poll) poll = setInterval(() => void session?.refresh(), DOWNLOAD_POLL_MS)
    else if (!downloading && poll) {
      clearInterval(poll)
      poll = undefined
    }
  })

  onCleanup(() => {
    if (poll) clearInterval(poll)
    void session?.dispose()
  })

  return (
    <Show when={session}>
      {(active) => (
        <MicButton
          state={state}
          level={level}
          onToggle={() => void active().toggle()}
          onCancel={() => {
            void active().cancel()
            setLevel(undefined)
          }}
        />
      )}
    </Show>
  )
}