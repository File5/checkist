import { getJson } from './http.ts'
import { array, country, currency, nonNegativeInteger, object, results, text } from './schema.ts'
import type { ApiResult, CountryCode, CurrencyCode, RequestOptions, Results } from './types.ts'

/** `currencies` are the currencies of saved receipts of the country, not the whole currency reference. */
export type CountryEntry = { code: CountryCode; name: string; currencies: CurrencyCode[]; stores_count: number; products_count: number }
export const isCountryEntry = object<CountryEntry>({
  code: country, name: text, currencies: array(currency), stores_count: nonNegativeInteger, products_count: nonNegativeInteger,
})

/** `all` adds reference countries that have no stores yet. */
export function getCountries(params: { all?: boolean } = {}, options: RequestOptions = {}): Promise<ApiResult<Results<CountryEntry>>> {
  return getJson('countries/', params, results(isCountryEntry), options)
}
