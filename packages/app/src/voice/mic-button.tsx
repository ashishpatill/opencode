import { Match, Show, Switch, createEffect, createSignal, onCleanup } from "solid-js"
import { IconButton } from "@opencode/ui/icon-button"
import { Icon } from "@opencode/ui/icon"
import type { SessionState } from "./session"
import { dictationView, downloadPercent, LEVELS } from "./view-model"

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
  /** Session state as an accessor, so Solid tracks it as a dependency. */
  state: () => SessionState
  /** Latest mic RMS in 0..1, or undefined when unknown. */
  level?: () => number | undefined
  /** Single control: the session decides which of start/stop applies. */
  onToggle: () => void
  onCancel: () => void
}

export function MicButton(props: MicButtonProps) {
  const [spin, setSpin] = createSignal(0)
  let timer: ReturnType<typeof setInterval> | undefined

  const stopTimer = () => {
    if (timer) clearInterval(timer)
    timer = undefined
  }

  // One timer for the whole control, running only while something animates, so
  // an idle composer costs nothing. Driven by an effect rather than the click
  // handler so the timer is right when a dictation starts any other way. A
  // download counts: until its first byte count arrives the glyph is a spinner
  // rather than a percentage, and a still spinner would read as a frozen control.
  createEffect(() => {
    const animated = props.state().busy || props.state().downloading !== undefined

    if (animated && !timer) timer = setInterval(() => setSpin((value) => (value + 1) % FRAMES.length), 120)
    else if (!animated && timer) stopTimer()
  })

  onCleanup(stopTimer)

  const view = () => dictationView(props.state(), { level: props.level?.() })

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
        // Carries the reason a disabled control cannot run, so it is reachable
        // by keyboard and screen reader rather than only as transient text.
        title={view().title}
        onClick={() => props.onToggle()}
      >
        <Switch>
          <Match when={view().icon === "spinner"}>
            <span class="text-xs leading-none">{FRAMES[spin()]}</span>
          </Match>
          <Match when={view().icon === "download"}>
            <Switch fallback={<span class="text-xs leading-none">{FRAMES[spin()]}</span>}>
              {/* Before the first byte count the total is unknown, and a
                  percentage of nothing would read as a permanently stuck 0%. */}
              <Match when={downloadPercent(props.state().downloading) !== undefined}>
                <span class="text-[10px] tabular-nums leading-none">
                  {downloadPercent(props.state().downloading)}%
                </span>
              </Match>
            </Switch>
          </Match>
          <Match when={true}>
            <Icon name={view().icon} />
          </Match>
        </Switch>
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