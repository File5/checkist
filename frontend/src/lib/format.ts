import { isISODate, isISODateTime } from '../api/schema.ts'
import type { CurrencyCode, Decimal, ISODate, ISODateTime, Unit } from '../api/types.ts'

const missing = '—'
const space = '\u00a0'
const units: Record<Unit, string> = { pcs: 'шт', g: 'г', kg: 'кг', ml: 'мл', l: 'л', m: 'м' }

/** String/BigInt formatting only; never convert a Decimal to Number. */
function decimal(value: Decimal | null, maximum: number, minimum = 0): string {
  if (value === null) return missing
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value)
  if (!match) return missing
  const fraction = match[3] ?? ''
  let digits = BigInt(match[2] + fraction.slice(0, maximum).padEnd(maximum, '0'))
  // ROUND_HALF_UP for display precision, including negative values.
  if (fraction.length > maximum && fraction[maximum] >= '5') digits += 1n
  const padded = digits.toString().padStart(maximum + 1, '0')
  const whole = padded.slice(0, -maximum).replace(/\B(?=(\d{3})+(?!\d))/g, space)
  const tail = padded.slice(-maximum).replace(/0+$/, '').padEnd(minimum, '0')
  return `${match[1] && digits !== 0n ? '-' : ''}${whole}${tail ? `,${tail}` : ''}`
}

export function formatUnit(unit: Unit | null): string {
  return unit === null ? missing : units[unit] ?? missing
}
export function formatAmount(value: Decimal | null, currency: CurrencyCode): string {
  const number = decimal(value, 2, 2)
  return number === missing ? missing : `${number}${space}${currency}`
}
/** Two places like a price tag; a non-zero price that would read 0,00 keeps up to four. */
export function formatPrice(value: Decimal | null, currency: CurrencyCode, unit?: Unit | null): string {
  let number = decimal(value, 2, 2)
  if (number === '0,00' && value !== null && /[1-9]/.test(value)) {
    const precise = decimal(value, 4)
    if (precise !== '0') number = precise
  }
  return number === missing ? missing : `${number}${space}${currency}${unit == null ? '' : `/${formatUnit(unit)}`}`
}
export function formatQuantity(value: Decimal | null, unit?: Unit | null): string {
  const number = decimal(value, 3)
  return number === missing ? missing : `${number}${unit == null ? '' : `${space}${formatUnit(unit)}`}`
}
export function formatPercent(value: Decimal | null): string {
  const number = decimal(value, 2, 2)
  return number === missing ? missing : `${number}${space}%`
}
/** Price indices keep all four places, so that 1,0000 and 1,2404 line up. */
export function formatIndex(value: Decimal | null): string {
  return decimal(value, 4, 4)
}
/** A calendar date is rearranged directly, with no timezone conversion. */
export function formatPurchasedOn(value: ISODate | null): string {
  return isISODate(value) ? `${value.slice(8, 10)}.${value.slice(5, 7)}.${value.slice(0, 4)}` : missing
}
export function formatObservedAt(value: ISODateTime | null, timezone?: string | null): string {
  if (!isISODateTime(value)) return missing
  const moment = new Date(value)
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }
  // The date, the time and the UTC label stay on one line: Intl puts a plain space after the comma.
  const format = (timeZone: string) =>
    new Intl.DateTimeFormat('ru-RU', { ...options, timeZone }).format(moment).replace(', ', `,${space}`)
  if (timezone) {
    try {
      return format(timezone)
    } catch { /* Unknown or invalid store timezone: use an explicitly labelled UTC moment. */ }
  }
  return `${format('UTC')}${space}UTC`
}
