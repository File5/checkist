import { isMergeDetectResult, isMergeGroup, isMergeGroupBrief, isMergeLine } from '../../api/product-merges-schema'
import { mergeFixture } from '../../api/product-merges-test-support'
import { page } from '../../api/schema'
import type { MergeDetectResult, MergeGroup, MergeGroupBrief, MergeLine } from '../../api/product-merges'
import type { Page } from '../../api/types'
import type { RequestState } from '../recognition/polling'

/** Screen tests read the backend's own examples; a fixture the adapter would reject fails the test. */
function fixture<T>(name: string, guard: (value: unknown) => value is T): T {
  const value = mergeFixture(name)
  if (!guard(value)) throw new Error(`Invalid fixture ${name}`)
  return value
}
export const group = (name: string): MergeGroup => fixture(name, isMergeGroup)
export const groups = (): Page<MergeGroupBrief> => fixture('groups.json', page(isMergeGroupBrief))
export const lines = (): Page<MergeLine> => fixture('lines.json', page(isMergeLine))
export const detected = (): MergeDetectResult => fixture('detect.json', isMergeDetectResult)
export const success = <T,>(data: T): RequestState<T> => ({ kind: 'ok', data, refreshing: false })
export const failed = (reason: 'permission_denied' | 'network' | 'not_found' | 'page_out_of_range' | 'server', status?: number): RequestState<never> =>
  ({ kind: 'error', error: { kind: 'error', reason, ...(status && { status }) } })
/** Only the listed status, as `GET /api/product-merges/?status=` answers. */
export function groupsOf(status?: MergeGroupBrief['status']): Page<MergeGroupBrief> {
  const all = groups()
  const results = status ? all.results.filter((item) => item.status === status) : all.results
  return { ...all, count: results.length, pages: results.length ? 1 : 0, results }
}
