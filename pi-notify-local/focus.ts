import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

type Unsubscribe = () => void

/** The slice of `ctx.ui` this tracker needs. */
interface TerminalInputSource {
  onTerminalInput(
    handler: (data: string) => { data: string } | undefined,
  ): Unsubscribe
}

// xterm focus reporting (CSI ?1004): the terminal emits these on focus change.
const FOCUS_IN = '\x1b[I'
const FOCUS_OUT = '\x1b[O'
const ENABLE_FOCUS_REPORTING = '\x1b[?1004h'
const DISABLE_FOCUS_REPORTING = '\x1b[?1004l'

/**
 * Whether the terminal is focused, which is the gate for every notification.
 * Terminals that do not report focus fall back to input inactivity.
 */
export class FocusTracker {
  private focused?: boolean
  private lastActivityAt = Date.now()
  private unsubscribe: Unsubscribe | undefined

  register(mode: string, ui: TerminalInputSource): void {
    if (mode !== 'tui') return
    this.lastActivityAt = Date.now()
    process.stdout.write(ENABLE_FOCUS_REPORTING)
    this.unsubscribe = ui.onTerminalInput((data) => {
      this.lastActivityAt = Date.now()
      const result = this.consume(data)
      return result.data === data ? undefined : { data: result.data }
    })
  }

  stop(): void {
    if (!this.unsubscribe) return
    process.stdout.write(DISABLE_FOCUS_REPORTING)
    this.unsubscribe()
    this.unsubscribe = undefined
    this.focused = undefined
  }

  isUnfocused(inactivityThresholdMs: number): boolean {
    const recentlyActive = Date.now() - this.lastActivityAt <= inactivityThresholdMs
    return !(this.focused ?? recentlyActive)
  }

  private consume(data: string): { data: string } {
    let current = data
    if (current.includes(FOCUS_IN)) {
      this.focused = true
      current = current.split(FOCUS_IN).join('')
    }
    if (current.includes(FOCUS_OUT)) {
      this.focused = false
      current = current.split(FOCUS_OUT).join('')
    }
    return { data: current }
  }
}
