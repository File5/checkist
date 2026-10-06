import {
  isClassification, isClassificationConfirmMany, isClassificationRunRequest, isClassificationState,
} from '../../api/product-classifications-schema'
import { classificationFixture, errorFixtures } from '../../api/product-classifications-test-support'
import { page } from '../../api/schema'
import { generic } from '../../api/test-support'
import type { Classification, ClassificationConfirmMany, ClassificationRunRequest, ClassificationState } from '../../api/product-classifications'
import type { GenericProduct, LocalApiFailure, Page } from '../../api/types'
import type { RequestState } from '../recognition/polling'

/** Screen tests read the backend's own examples; a fixture the adapter would reject fails the test. */
function fixture<T>(name: string, guard: (value: unknown) => value is T): T {
  const value = classificationFixture(name)
  if (!guard(value)) throw new Error(`Invalid fixture ${name}`)
  return value
}
/** Four pending records: «Кефир» twice, «Колбаса» with a new category, «Молоко» that already existed. */
export const records = (): Page<Classification> => fixture('classifications.json', page(isClassification))
export const record = (name: string): Classification => fixture(name, isClassification)
export const stateOf = (name: string): ClassificationState => fixture(name, isClassificationState)
export const runRequest = (name: string): ClassificationRunRequest => fixture(name, isClassificationRunRequest)
export const confirmedMany = (): ClassificationConfirmMany => fixture('confirm-many.json', isClassificationConfirmMany)
export const pageOf = (results: Classification[]): Page<Classification> => ({ count: results.length, page: 1, page_size: 200, pages: results.length ? 1 : 0, results })
export const success = <T,>(data: T): RequestState<T> => ({ kind: 'ok', data, refreshing: false })
export const failed = (reason: LocalApiFailure['reason'], status?: number): RequestState<never> =>
  ({ kind: 'error', error: { kind: 'error', reason, ...(status && { status }) } })
export const refusal = (name: string): LocalApiFailure => {
  const { status, reason, fields } = errorFixtures[name]
  return { kind: 'error', reason: reason as LocalApiFailure['reason'], status, ...(fields && { fields }) }
}
/** Catalog answer for «выбрать другой»: the suggested «Кефир», the service product and two real options. */
export const generics = (): Page<GenericProduct> => {
  const category = generic.category
  const results: GenericProduct[] = [
    { id: 93, name: 'Кефир', base_unit: 'l', category, products_count: 2, countries: [] },
    { id: 92, name: 'Молоко', base_unit: 'l', category, products_count: 2, countries: ['DE'] },
    { id: 91, name: 'Не разобрано', base_unit: 'pcs', category: { id: 1, name: 'Не разобрано', path: [{ id: 1, name: 'Не разобрано' }] }, products_count: 3, countries: [] },
    { id: 95, name: 'Творог', base_unit: 'kg', category, products_count: 0, countries: [] },
  ]
  return { count: results.length, page: 1, page_size: 50, pages: 1, results }
}
