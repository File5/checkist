/** Non-breaking space: the words on its two sides stay on one line. */
export const NBSP = '\u00a0'

/** The only dash of a period, the same on every screen. */
const dash = '—'

/**
 * Period of two already formatted dates: «01.09.2026 — 30.09.2026».
 * The space before the dash is non-breaking and the one after it is ordinary: the dash never starts a line, and the
 * second date moves to the next line as a whole. Each date stays whole on its own only inside `<time>` or another
 * `white-space: nowrap` element — this function glues the dash, not the digits of a date.
 */
export function dateRange(from: string, to: string): string {
  return `${from}${NBSP}${dash} ${to}`
}

/**
 * Parts of one value joined by non-breaking spaces: `glue(18, 'покупок')` → «18 покупок», a number with its word.
 * Empty parts are skipped. Spaces inside a part stay as they are.
 */
export function glue(...parts: (string | number)[]): string {
  return parts.map(String).filter((part) => part !== '').join(NBSP)
}

/** A numbered thing: `numbered('Чек', 12)` → «Чек №12», with the word glued to its number. */
export function numbered(word: string, number: string | number): string {
  return glue(word, `№${number}`)
}
