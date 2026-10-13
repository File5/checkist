/** The picture of a category in the spend rows (2026-10-13): `GET`/`POST /api/categories/{id}/icon/`. `icon` — inherited
 * (null — nobody up the tree has one: the tag), `own_icon` — the category's own (null — its parent's). Anyone who sees the
 * spends reads it; only a catalog moderator changes it (`403 permission_denied`): the categories are shared by every family. */
import { getLocalJson, mutate } from './local.ts'
import { isId, nullable, object, text } from './schema.ts'
import type { LocalApiResult, RequestOptions } from './types.ts'

export type CategoryIconState = { id: number; icon: string | null; own_icon: string | null }

const isCategoryIconState = object<CategoryIconState>({ id: isId, icon: nullable(text), own_icon: nullable(text) })

export function getCategoryIcon(id: number, options: RequestOptions = {}): Promise<LocalApiResult<CategoryIconState>> {
  return getLocalJson(`categories/${id}/icon/`, {}, isCategoryIconState, options)
}

/** `null` — as the parent. */
export function setCategoryIcon(id: number, icon: string | null, options: RequestOptions = {}): Promise<LocalApiResult<CategoryIconState>> {
  return mutate(`categories/${id}/icon/`, JSON.stringify({ icon }), isCategoryIconState, options)
}
