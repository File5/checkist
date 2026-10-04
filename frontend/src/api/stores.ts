import { getJson } from './http.ts'
import { isStoreEntry, page } from './schema.ts'
import type { ApiResult, Page, RequestOptions, StoreEntry, StoreParams } from './types.ts'

export function getStores(params: StoreParams = {}, options: RequestOptions = {}): Promise<ApiResult<Page<StoreEntry>>> {
  return getJson('stores/', params, page(isStoreEntry), options)
}
