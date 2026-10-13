/** The pictures of categories (2026-10-13): the keys of `catalog.CategoryIcon` of the server, each drawn by
 * components/Icon.tsx, in the order of the moderator's picker. A category without its own takes its ancestor's —
 * the server sends it already inherited. */
import type { IconName } from '../components/Icon'
import type { LocalApiFailure } from '../api/types'

export const categoryIcons = [
  ['cart', 'Тележка'], ['dining', 'Вилка и нож'], ['bus', 'Автобус'], ['car', 'Машина'], ['home', 'Дом'],
  ['phone', 'Телефон'], ['heart', 'Сердце'], ['shirt', 'Футболка'], ['ticket', 'Билет'], ['gift', 'Подарок'],
  ['baby', 'Мишка'], ['box', 'Коробка'], ['bank', 'Банк'], ['beauty', 'Ножницы'], ['plane', 'Самолёт'],
  ['book', 'Книга'], ['paw', 'Лапа'], ['tag', 'Ярлык'],
] as const satisfies readonly (readonly [IconName, string])[]

export type CategoryIconKey = typeof categoryIcons[number][0]

const keys = new Set<string>(categoryIcons.map(([key]) => key))

/** The picture of a category by its key; none (no category, nothing up the tree) or an unknown one — the tag. */
export function categoryIcon(key: string | null | undefined): CategoryIconKey {
  return key && keys.has(key) ? key as CategoryIconKey : 'tag'
}

/** A refused change of a moderator in words of the screen; the server's own text never reaches it. */
export function categoryIconFailure(failure: Pick<LocalApiFailure, 'reason'>): string {
  if (failure.reason === 'permission_denied') return 'Менять значок может только модератор каталога.'
  if (failure.reason === 'not_found') return 'Этой категории больше нет.'
  if (failure.reason === 'network' || failure.reason === 'timeout') return 'Не удалось связаться с сервером. Повторите.'
  return 'Не удалось сохранить значок. Повторите.'
}
