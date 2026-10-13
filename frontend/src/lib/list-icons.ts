/** What the square of a spend row shows (2026-10-13): the picture of its category (the default) or how the spend came
 * in — a receipt, by hand, a bank statement. A choice of the device, like the theme: `localStorage`, every access
 * guarded. The colour of the square stays the tone of the category either way. */
import { useSyncExternalStore } from 'react'
import type { IconName } from '../components/Icon'
import { categoryIcon } from './category-icons'

export type ListIcons = 'category' | 'source'

export const listIconsStorageKey = 'checkist.listIcons'

export function parseListIcons(value: unknown): ListIcons {
  return value === 'source' ? 'source' : 'category'
}

export const listIconsNames: [ListIcons, string][] = [['category', 'Категория'], ['source', 'Как внесена']]

export function listIconsLabel(value: ListIcons): string {
  return value === 'source' ? 'Значки: как внесена' : 'Значки: категория'
}

let current: ListIcons | undefined
const listeners = new Set<() => void>()

function read(): ListIcons {
  try {
    return parseListIcons(window.localStorage.getItem(listIconsStorageKey))
  } catch {
    // Blocked storage (or no browser): the default.
    return 'category'
  }
}

function snapshot(): ListIcons {
  current ??= read()
  return current
}

export function setListIcons(value: ListIcons) {
  try {
    window.localStorage.setItem(listIconsStorageKey, value)
  } catch {
    // Without storage the choice lives until the page is closed.
  }
  current = value
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  // Another tab changed the choice: followed here too.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== listIconsStorageKey && event.key !== null) return
    current = read()
    listener()
  }
  listeners.add(listener)
  try {
    window.addEventListener('storage', onStorage)
  } catch {
    // No window: nothing to follow.
  }
  return () => {
    listeners.delete(listener)
    try {
      window.removeEventListener('storage', onStorage)
    } catch {
      // No window.
    }
  }
}

/** The choice of the device; a render without a browser (the markup tests) reads the same store. */
export function useListIcons(): ListIcons {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/** How a spend came in → its picture: a slip of a photo receipt, a pencil of a spend typed by hand, a card of a statement. */
const sourceIcons = { photo: 'receipt', manual: 'pencil', statement: 'card' } as const satisfies Record<string, IconName>

/** The picture of a spend row by the choice of the device: the icon of its category (inherited by the server) or its source. */
export function useSpendIcon(source: keyof typeof sourceIcons, icon: string | null | undefined): IconName {
  return useListIcons() === 'source' ? sourceIcons[source] : categoryIcon(icon)
}
