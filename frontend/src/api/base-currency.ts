import { amount, array, currency, nonNegativeInteger, object, record } from './schema.ts'
import type { Guard } from './schema.ts'
import type { CurrencyCode, Decimal, LocalApiResult } from './types.ts'

/** Spends in a currency whose rate of the National Bank on the day of purchase the server does not know: they are not
 * in the totals of the base currency and are shown apart. */
export type ExcludedSpends = { currency: CurrencyCode; receipts_count: number; total: Decimal }
/** What an answer in the family's base currency adds (2026-10-13): the base currency and the spends without a rate;
 * the block itself comes as `base` (`in_base` of the comparison, `base_limits` of the limits by month). */
export type InBase = { base_currency?: CurrencyCode; excluded?: ExcludedSpends[] }

const excludedList = array(object<ExcludedSpends>({ currency, receipts_count: nonNegativeInteger, total: amount }))

/** Where an answer keeps its blocks in the base currency: `from` — the field of the server, `to` — the blocks the
 * screen draws, `list` — `from` is already a list (the limits by month), otherwise one block or null. */
export type BaseField = { from: string; to: string; list?: boolean }
export const baseBlock: BaseField = { from: 'base', to: 'currencies' }

const moved = (value: Record<string, unknown>, field: BaseField) => {
  const found = value[field.from]
  return field.list ? found : found === null ? [] : [found]
}

/**
 * The server still sends the blocks one per currency — never added together — and, beside them, the same
 * calculation with every currency converted at the rate of its day (`base_currency`, the block, `excluded`). The
 * answer is checked twice by `guard`: as it is, and with the converted block in place of the old ones, so the same
 * rules hold for both. `required` — the fields must be there (statistics); otherwise an older server without them
 * passes (Главная).
 */
export function withBase<T>(guard: Guard<T>, field: BaseField = baseBlock, required = true): Guard<T> {
  return (value): value is T => {
    if (!guard(value) || !record(value)) return false
    if (!['base_currency', 'excluded', field.from].some((key) => Object.hasOwn(value, key))) return !required
    if (!currency(value.base_currency) || !excludedList(value.excluded) || !Object.hasOwn(value, field.from)) return false
    const found = value[field.from]
    if (field.list ? !Array.isArray(found) : found !== null && !record(found)) return false
    return guard({ ...value, [field.to]: moved(value, field) })
  }
}

/** The answer as a screen reads it: the converted block in place of the blocks per currency, so «Другие валюты» and
 * the second hero go away by themselves. An answer of an older server stays as it is. */
export function inBase<T>(data: T, field: BaseField = baseBlock): T {
  const value = data as Record<string, unknown>
  return Object.hasOwn(value, field.from) ? { ...data, [field.to]: moved(value, field) } : data
}

/** `inBase` of a successful answer; a failure passes as it is. */
export function resultInBase<T>(result: LocalApiResult<T>, field: BaseField = baseBlock): LocalApiResult<T> {
  return result.kind === 'ok' ? { kind: 'ok', data: inBase(result.data, field) } : result
}
