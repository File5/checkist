import type { Decimal } from '../api/types.ts'
import { NBSP, glue } from './text.ts'

/**
 * The one way the client shows a money amount: whole units, rounded up.
 *
 * Only the display is rounded. The server stores and sends exact values, every sum, total and statistic is counted
 * from them, and input fields keep the decimals a person typed. A positive amount is rounded toward +infinity
 * (9 821,47 → 9 822; 0,01 → 1), a negative one (a discount, a refund) away from zero in magnitude (−0,40 → −1):
 * the shown number is never smaller in size than the real one, whatever its sign. A whole value stays as it is
 * (10.00 → 10). Not money in this sense: unit prices (`formatPrice`), indices, percentages, quantities, tax rates
 * and chart axis ticks.
 *
 * String/BigInt only: a Decimal never becomes a Number.
 */

const missing = '—'
const groupDigits = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP)

/** Whole units of a wire Decimal, magnitude rounded up; `null` for an absent or malformed value. */
export function moneyWholeUnits(value: Decimal | null | undefined): bigint | null {
  const match = typeof value === 'string' ? /^(-?)(\d+)(?:\.(\d+))?$/.exec(value) : null
  if (!match) return null
  const whole = BigInt(match[2]) + (/[1-9]/.test(match[3] ?? '') ? 1n : 0n)
  return match[1] ? -whole : whole
}

/** Whole units of an exact amount in cents (counted with BigInt), magnitude rounded up. */
export function centsWholeUnits(cents: bigint): bigint {
  const negative = cents < 0n
  const absolute = negative ? -cents : cents
  const whole = absolute / 100n + (absolute % 100n ? 1n : 0n)
  return negative ? -whole : whole
}

function wholeText(units: bigint): string {
  return `${units < 0n ? '-' : ''}${groupDigits((units < 0n ? -units : units).toString())}`
}

/** «9 822» for "9821.47"; `—` for an absent or malformed value. */
export function formatMoneyNumber(value: Decimal | null | undefined): string {
  const units = moneyWholeUnits(value)
  return units === null ? missing : wholeText(units)
}

/** «1 501» for 150050n cents. */
export function formatCentsNumber(cents: bigint): string {
  return wholeText(centsWholeUnits(cents))
}

const SYMBOLS: Record<string, string> = { KZT: '₸', RUB: '₽', USD: '$', EUR: '€', GBP: '£', CNY: '¥', TRY: '₺' }

/** «₸» for KZT: the sign people write after an amount; a code without a common sign stays a code (UZS, KGS, AED). */
export function currencySymbol(currency: string | null | undefined): string {
  return currency ? SYMBOLS[currency] ?? currency : ''
}

/** «9 822 ₸»: the number and its currency sign never break apart; without a currency only the number. */
export function formatMoney(value: Decimal | null | undefined, currency: string | null | undefined): string {
  const number = formatMoneyNumber(value)
  return number === missing ? missing : glue(number, currencySymbol(currency))
}

/** «1 501 ₸» for 150050n cents. */
export function formatCents(cents: bigint, currency: string | null | undefined): string {
  return glue(formatCentsNumber(cents), currencySymbol(currency))
}
