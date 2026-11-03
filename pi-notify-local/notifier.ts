/**
 * Desktop notifications ride on the terminal: Ghostty (1.1+) implements the
 * rxvt OSC 777 notify extension, so one escape sequence on stdout raises a real
 * Notification Center banner with no subprocess and no text to escape.
 *
 * Ghostty also owns the banner's lifetime — it clears it when the surface
 * regains focus and drops it after 3s when it was posted while focused — so
 * nothing accumulates. Only the terminal we are drawn into sees the sequence,
 * which makes this a no-op in print/RPC mode, over ssh, or in other terminals.
 */

/** True when stdout is a terminal that understands OSC 777. */
function supported(): boolean {
  return (
    process.stdout.isTTY === true && process.env.TERM_PROGRAM === 'ghostty'
  )
}

/**
 * The payload is BEL-terminated and ';' separated: a control character would
 * truncate the sequence (the terminal would execute the tail as text) and a
 * ';' in the title would shift the body into the title field.
 */
function sanitize(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
}

export function notify(title: string, body: string): void {
  if (!supported()) return
  const safeTitle = sanitize(title).replace(/;/g, ',')
  process.stdout.write(`\x1b]777;notify;${safeTitle};${sanitize(body)}\x07`)
}
