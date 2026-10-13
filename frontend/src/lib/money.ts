import type { Decimal } from '../api/types.ts'
import { moneyDigits } from './money-digits.ts'
import type { MoneyDigits } from './money-digits.ts'
import { NBSP, glue } from './text.ts'

/**
 * The one way the client shows a money amount. How — a choice of the device (`./money-digits.ts`, «Суммы» on
 * `/account`): whole units, rounded up (the default), or exactly, with two places.
 *
 * `whole`. A positive amount is rounded toward +infinity (9 821,47 → 9 822; 0,01 → 1), a negative one (a discount, a
 * refund) away from zero in magnitude (−0,40 → −1): the shown number is never smaller in size than the real one,
 * whatever its sign. A whole value stays as it is (10.00 → 10).
 *
 * `cents`. Always two places: 9821.47 → 9 821,47; 10 → 10,00; 12.5 → 12,50. A value with more places is rounded to a
 * cent, half away from zero (999.995 → 1 000,00; −12.255 → −12,26); there is no signed zero (−0.004 → 0,00).
 *
 * Either way only the display changes. The server stores and sends exact values, every sum, total and statistic is
 * counted from them, and input fields keep the decimals a person typed. Not money in this sense, and not touched by
 * the choice: unit prices (`formatPrice`), indices, percentages, quantities, tax rates and chart axis ticks.
 *
 * Every formatter takes the mode as its last, optional argument; screens leave it out and get the choice of the
 * device, tests name it. String/BigInt only: a Decimal never becomes a Number.
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

/** A wire Decimal in cents, rounded to a cent half away from zero; `null` for an absent or malformed value. */
export function moneyCents(value: Decimal | null | undefined): bigint | null {
  const match = typeof value === 'string' ? /^(-?)(\d+)(?:\.(\d+))?$/.exec(value) : null
  if (!match) return null
  const fraction = match[3] ?? ''
  const cents = BigInt(match[2] + fraction.slice(0, 2).padEnd(2, '0')) + (fraction.length > 2 && fraction[2] >= '5' ? 1n : 0n)
  return match[1] ? -cents : cents
}

/** «1 500,50» for 150050n: exactly two places; a BigInt has no signed zero, so neither has the text. */
function centsText(cents: bigint): string {
  const absolute = cents < 0n ? -cents : cents
  return `${cents < 0n ? '-' : ''}${groupDigits((absolute / 100n).toString())},${(absolute % 100n).toString().padStart(2, '0')}`
}

/** «9 822» for "9821.47", «9 821,47» with cents; `—` for an absent or malformed value. */
export function formatMoneyNumber(value: Decimal | null | undefined, digits: MoneyDigits = moneyDigits()): string {
  if (digits === 'cents') {
    const cents = moneyCents(value)
    return cents === null ? missing : centsText(cents)
  }
  const units = moneyWholeUnits(value)
  return units === null ? missing : wholeText(units)
}

/** «1 501» for 150050n cents, «1 500,50» with cents. */
export function formatCentsNumber(cents: bigint, digits: MoneyDigits = moneyDigits()): string {
  return digits === 'cents' ? centsText(cents) : wholeText(centsWholeUnits(cents))
}

const SYMBOLS: Record<string, string> = { KZT: '₸', RUB: '₽', USD: '$', EUR: '€', GBP: '£', CNY: '¥', TRY: '₺' }

/** «₸» for KZT: the sign people write after an amount; a code without a common sign stays a code (UZS, KGS, AED). */
export function currencySymbol(currency: string | null | undefined): string {
  return currency ? SYMBOLS[currency] ?? currency : ''
}

/** «9 822 ₸» («9 821,47 ₸» with cents): the number and its currency sign never break apart; without a currency only
 * the number. */
export function formatMoney(value: Decimal | null | undefined, currency: string | null | undefined, digits: MoneyDigits = moneyDigits()): string {
  const number = formatMoneyNumber(value, digits)
  return number === missing ? missing : glue(number, currencySymbol(currency))
}

/** «1 501 ₸» for 150050n cents, «1 500,50 ₸» with cents. */
export function formatCents(cents: bigint, currency: string | null | undefined, digits: MoneyDigits = moneyDigits()): string {
  return glue(formatCentsNumber(cents, digits), currencySymbol(currency))
}

/** «≈ 8 979 ₸»: an amount converted into the family's base currency at the rate of the National Bank on its day. */
export function formatApproxMoney(value: Decimal | null | undefined, currency: string | null | undefined, digits: MoneyDigits = moneyDigits()): string {
  return glue('≈', formatMoney(value, currency, digits))
}

/** The converted twin of an amount in another currency — «≈ 8 979 ₸» beside «20 $»; `null` for an amount in the base
 * currency itself, without a rate, or from an older server that sends no base currency. */
export function baseTwin(currency: string, baseTotal: Decimal | null | undefined, baseCurrency: string | null | undefined,
  digits: MoneyDigits = moneyDigits()): string | null {
  if (!baseCurrency || currency === baseCurrency || baseTotal === null || baseTotal === undefined) return null
  return formatApproxMoney(baseTotal, baseCurrency, digits)
}

/** «20 $ · ≈ 8 979 ₸» in one line; just «20 $» when there is no twin. */
export function formatMoneyWithBase(value: Decimal, currency: string, baseTotal: Decimal | null | undefined, baseCurrency: string | null | undefined,
  digits: MoneyDigits = moneyDigits()): string {
  const twin = baseTwin(currency, baseTotal, baseCurrency, digits)
  const amount = formatMoney(value, currency, digits)
  return twin ? `${amount} · ${twin}` : amount
}
