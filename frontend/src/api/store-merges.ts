/** «Магазины»: places of the family with their spend counts and other spellings, the groups that look like one payee,
 * the merge and «Не то» (`/api/store-merges/`). Stores are shared by all families, so only a catalog moderator merges
 * (`can_merge`); a refusal is `403 permission_denied`. */
import { getLocalJson, mutate } from './local.ts'
import { array, choice, isId, nonNegativeInteger, object, text } from './schema.ts'
import type { Guard } from './schema.ts'
import type { LocalApiResult, RequestOptions } from './types.ts'

export type StoreItem = { id: number; name: string; receipts_count: number; aliases: string[] }
/** Ids of `stores`, the one with more spends first; `similar` — names alike, `model` — the model grouped them. */
export type StoreSuggestion = { source: 'similar' | 'model'; stores: number[] }
export type StoresState = { can_merge: boolean; suggestions: StoreSuggestion[]; stores: StoreItem[] }

const isStoreItem = object<StoreItem>({ id: isId, name: text, receipts_count: nonNegativeInteger, aliases: array(text) })
const isSuggestion = object<StoreSuggestion>({
  source: choice('similar', 'model'), stores: (value: unknown) => Array.isArray(value) && value.length >= 2 && value.every(isId),
})
export const isStoresState: Guard<StoresState> = object<StoresState>({
  can_merge: (value: unknown) => typeof value === 'boolean', suggestions: array(isSuggestion), stores: array(isStoreItem),
})

export function getStoresState(options: RequestOptions = {}): Promise<LocalApiResult<StoresState>> {
  return getLocalJson('store-merges/', {}, isStoresState, options)
}
/** `merged` become spellings of `store`: their spends move to it. Answers the new state; `409 store_merge_conflict`. */
export function mergeStores(store: number, merged: number[], options: RequestOptions = {}): Promise<LocalApiResult<StoresState>> {
  return mutate('store-merges/merge/', JSON.stringify({ store, merged }), isStoresState, options)
}
/** «Не то»: the group and the pairs inside it are not offered again. */
export function dismissStores(stores: number[], options: RequestOptions = {}): Promise<LocalApiResult<StoresState>> {
  return mutate('store-merges/dismiss/', JSON.stringify({ stores }), isStoresState, options)
}
