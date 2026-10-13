/** The amount field as a small calculator: «1200+350», «3*450», «1000/3», digits grouped by thousands while typing.
 * Its own tiny parser — never `eval`. No network, no React. */

/** `−`, `×`, `÷` of the keys and of a phone keyboard, `x`/`х` for «times». */
const OPERATOR = /[+\-−*×xх/÷:]/
const SPACES = /[\s\u00a0\u202f]/g

export const hasOperator = (text: string) => OPERATOR.test(text.replace(SPACES, ''))
/** The text of the field without the spaces of grouping: what the draft keeps. */
export const ungrouped = (text: string) => text.replace(SPACES, '')

const normalized = (text: string) => text.replace(SPACES, '').replace(/[−]/g, '-').replace(/[×xх]/gi, '*').replace(/[÷:]/g, '/')

/**
 * The value of `text` as an amount of the API: «1200+350» → "1550", «1000/3» → "333.33" (rounded half up to kopecks),
 * «1200+» → "1200" (an operator typed last is waiting for its number). `undefined` — not an expression of positive
 * numbers, division by zero, or a result not above zero or wider than 12 digits.
 */
export function evaluateAmount(text: string): string | undefined {
  const expression = normalized(text).replace(/[-+*/]$/, '')
  if (!/^[0-9]+(?:[.,][0-9]+)?(?:[-+*/][0-9]+(?:[.,][0-9]+)?)*$/.test(expression)) return undefined
  const tokens = expression.match(/[0-9]+(?:[.,][0-9]+)?|[-+*/]/g) ?? ['']
  let total = 0
  let term = Number(tokens[0].replace(',', '.'))
  for (let index = 1; index < tokens.length; index += 2) {
    const operator = tokens[index]
    const number = Number(tokens[index + 1].replace(',', '.'))
    if (operator === '*') term *= number
    else if (operator === '/') {
      if (number === 0) return undefined
      term /= number
    } else {
      total += term
      term = operator === '-' ? -number : number
    }
  }
  const cents = Math.round((total + term) * 100 + Number.EPSILON)
  if (!Number.isFinite(cents) || cents <= 0 || cents >= 1e14) return undefined
  const whole = Math.floor(cents / 100)
  const fraction = cents % 100
  return fraction ? `${whole}.${String(fraction).padStart(2, '0')}` : String(whole)
}

/** Digits of `text` grouped by thousands with a no-break space, the rest as typed: «12500+350» → «12 500+350». */
export function groupDigits(text: string): string {
  return text.replace(SPACES, '').replace(/[0-9]+(?:[.,][0-9]*)?/g, (number) => {
    const [whole, ...rest] = number.split(/(?=[.,])/)
    return whole.replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0') + rest.join('')
  })
}

/** How many characters other than spaces stand before `caret` in `text`. */
export function charsBefore(text: string, caret: number): number {
  return text.slice(0, caret).replace(SPACES, '').length
}

/** The caret in the grouped `text` after `chars` characters other than spaces. */
export function caretAfter(text: string, chars: number): number {
  let seen = 0
  for (let index = 0; index < text.length; index += 1) {
    if (seen === chars) return index
    if (!/[\s\u00a0\u202f]/.test(text[index])) seen += 1
  }
  return text.length
}
