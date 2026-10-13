/** «Магазины»: the words of the screen and its pure rules. No network, no React. */
import type { StoreItem, StoresState } from '../../api/store-merges'
import type { LocalApiFailure } from '../../api/types'
import { plural } from '../../lib/recognition-issues'
import { glue } from '../../lib/text'
import { errorMessage } from '../receipts/state'

export const storesTexts = {
  intro: 'Один получатель под разными названиями — склейте их: траты перейдут к главному названию, а остальные останутся его вариантами написания.',
  moderatorOnly: 'Склеивать магазины может модератор каталога.',
  empty: 'Магазинов с тратами семьи пока нет.',
  nothingFound: 'Ничего не нашлось.',
  conflict: 'Склеить нельзя: у одного человека в магазине оказались бы два одинаковых чека с фото.',
  changed: 'Список магазинов изменился. Обновите страницу и выберите снова.',
  denied: 'Склеивать магазины может только модератор каталога.',
  sheetNote: 'Траты всех выбранных магазинов перейдут к нему, остальные названия станут его вариантами написания: по ним новая трата найдёт этот магазин.',
} as const

export const spendsText = (count: number) => glue(count.toLocaleString('ru-RU'), plural(count, 'трата', 'траты', 'трат'))

/** «12 трат · также: Anthropic Claude». */
export function storeMeta(store: StoreItem): string {
  return store.aliases.length ? `${spendsText(store.receipts_count)} · также: ${store.aliases.join(', ')}` : spendsText(store.receipts_count)
}

const fold = (text: string) => text.toLocaleLowerCase('ru-RU').replaceAll('ё', 'е')

/** The stores whose name or one of its spellings has the search. */
export function filterStores(stores: StoreItem[], search: string): StoreItem[] {
  const wanted = fold(search.trim())
  return wanted ? stores.filter((store) => [store.name, ...store.aliases].some((name) => fold(name).includes(wanted))) : stores
}

/** The stores of `ids` in their order, those the state knows. */
export function pick(state: StoresState, ids: number[]): StoreItem[] {
  const byId = new Map(state.stores.map((store) => [store.id, store]))
  return ids.map((id) => byId.get(id)).filter((store): store is StoreItem => store !== undefined)
}

/** The store to keep by default: the one with more spends, then the first. */
export function defaultMain(stores: StoreItem[]): number | undefined {
  return [...stores].sort((a, b) => b.receipts_count - a.receipts_count)[0]?.id
}

/** «Склеено: MAGNUM*ALMATY → MAGNUM.» */
export function mergedNotice(main: StoreItem, merged: StoreItem[]): string {
  return `Склеено: ${merged.map((store) => store.name).join(', ')} → ${main.name}.`
}

/** A refused merge or «Не то» in words of the screen; the server's own text never reaches it. */
export function storesFailure(failure: LocalApiFailure): string {
  if (failure.reason === 'store_merge_conflict') return storesTexts.conflict
  if (failure.reason === 'invalid_parameter') return storesTexts.changed
  if (failure.reason === 'permission_denied') return storesTexts.denied
  return errorMessage(failure)
}
