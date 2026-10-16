import { Show, createSignal, onCleanup } from "solid-js"
import { IconButton } from "@opencode/ui/icon-button"
import { Icon } from "@opencode/ui/icon"
import type { DictationController } from "./controller"
import { dictationView, LEVELS } from "./view-model"

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"] as const

/**
 * The composer's dictation control.
 *
 * The button is both the start and the stop affordance, so the control the user
 * is looking at is always the control that does the obvious next thing. During
 * recognition it shows a fixed-width spinner instead of an icon: a changing
 * glyph would resize the composer and cause a visible reflow.
 */
export type MicButtonProps = {
  controller: DictationController
  /** Latest mic RMS in 0..1, or undefined when unknown. */
  level?: () => number | undefined
  /** Microphone permission or device failure; shown instead of starting. */
  error?: () => string | undefined
  disabled?: boolean
  onStart: () => void
  onStop: () => void
  onCancel: () => void
}

export function MicButton(props: MicButtonProps) {
  const [spin, setSpin] = createSignal(0)
  let timer: ReturnType<typeof setInterval> | undefined

  // One timer for the whole control, running only while something animates, so
  // an idle composer costs nothing.
  const sync = () => {
    const animating = props.controller.phase === "transcribing"

    if (animating && !timer) {
      timer = setInterval(() => setSpin((value) => (value + 1) % FRAMES.length), 120)
    } else if (!animating && timer) {
      clearInterval(timer)
      timer = undefined
    }
  }

  onCleanup(() => {
    if (timer) clearInterval(timer)
  })

  const view = () =>
    dictationView(props.controller, {
      level: props.level?.(),
      error: props.error?.(),
      disabled: props.disabled,
    })

  return (
    <div class="flex items-center gap-1.5" data-slot="composer-mic">
      <Show when={view().showLevel}>
        <div class="flex h-3 items-end gap-px" aria-hidden="true" data-level={view().level}>
          {LEVELS.map((height, index) => (
            <span
              class="w-0.5 rounded-sm bg-current transition-[height] duration-100 ease-out"
              style={{
                height: `${index <= view().level ? height : 2}px`,
                opacity: index <= view().level ? 0.9 : 0.25,
              }}
            />
          ))}
        </div>
      </Show>
      <IconButton
        type="button"
        data-action="composer-mic"
        variant="ghost"
        size="normal"
        disabled={view().disabled}
        aria-label={view().label}
        title={view().label}
        onClick={() => {
          sync()

          if (view().active) props.onStop()
          else props.onStart()
        }}
      >
        <Show when={view().icon === "spinner"} fallback={<Icon name={view().icon} />}>
          <span class="text-xs leading-none">{FRAMES[spin()]}</span>
        </Show>
      </IconButton>
      <Show when={view().showCancel}>
        <IconButton
          type="button"
          data-action="composer-mic-cancel"
          variant="ghost"
          size="normal"
          aria-label="Cancel dictation"
          title="Cancel dictation"
          onClick={props.onCancel}
        >
          <Icon name="xmark" />
        </IconButton>
      </Show>
    </div>
  )
}